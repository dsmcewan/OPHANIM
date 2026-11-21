// CREDENTIAL ISOLATION (owner direction 2026-11-19; the invariant is in src/agy/verify-jail.mjs and
// docs/routing-task-profile.md "Credential isolation"): code run from worker-controlled content -- the unit's verify_cmd
// and anything it runs -- cannot obtain or disclose a credential, whether the worker runs it (agy's run_command, through
// the unit's verify launcher) or the controller does (review.mjs runVerify).
//
// Every credential here is SYNTHETIC (random dummies made per run): the unit's A2A token (the shim's own), a dummy
// Antigravity OAuth token in a fake ~/.gemini, a dummy OPENAI_API_KEY in the controller's env, a dummy SSH key and gh
// token under the fake home, a sibling unit's token, a dummy checkpoint seal key. The fixture lives under /var/tmp, NOT
// /tmp: under /tmp every jail's own fresh tmpfs would hide it and the test would prove nothing about the hiding.
//
// The PROBE (probe.mjs, written into the worktree: worker-controlled content) looks for the credential bytes in its env,
// across every readable path under the homes, /tmp, /var/tmp (the whole fixture), /run, /dev/shm, /mnt and /srv, in its
// inherited fds, in /proc/<pid>/{environ,cmdline,fd} of every process it can see, and by connecting to the A2A sockets.
// A POSITIVE CONTROL runs the same probe without the jail and must find every one of them: the probe can see a leak.
// INHERITED DESCRIPTORS (register KG-11) are leaked ON PURPOSE, at fd 20 (above the low range node marks close-on-exec at
// startup; a POSIX sh cannot name it, so bash opens it), at every entry of the verify launcher: agy's shell when it runs the
// launcher, a shell exec'ing it, the controller calling runVerify. So the descriptor assertion does not depend on what the
// environment leaks: it passes whatever that is (the jails close it), and fails when the launcher's closer is removed.
// Real bwrap; nothing is skipped when bwrap works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgyWorkerTurn, workerEnv } from "../src/board/agy-cli.mjs";
import { prepareWorkerWorkspace } from "../src/agy/workspace.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { checkPolicy, sanitizedGitConfig, verifyEnvOf, verifyJailPlan, VERIFY_JAIL_SCHEMA } from "../src/agy/verify-jail.mjs";
import { createServer } from "node:net";
import { startA2AShim } from "../src/pipeline/a2a-shim.mjs";
import { MCP_SERVER_PATH } from "../src/pipeline/index.mjs";
import { withFakeAgy } from "./fixtures/dispatch.mjs";
import { sh } from "./fixtures/pipeline-stages.mjs";

const have = await sandboxAvailable("bwrap");
const varTmp = (() => { try { rmSync(mkdtempSync("/var/tmp/pantheon-cred-probe-"), { recursive: true }); return true; } catch { return false; } })();
// The two credential-isolation tests drive real bwrap jails end to end: about 17 s each locally, but 75 s in CI's plain
// run and over 120 s (the gate's per-test default, L-505) in its per-file run, so they declare their own bound, below the
// gate's 360 s per-file watchdog.
const gate = { skip: !have.ok ? `bwrap unavailable: ${have.why}` : !varTmp ? "/var/tmp is not writable" : false };
const REVIEW = new URL("../src/pipeline/review.mjs", import.meta.url).href;
const dummy = tag => `${tag}-${randomBytes(16).toString("hex")}`;

// The probe. Needles arrive hex-encoded and reversed INSIDE its own source (never through its env), and the probe skips
// its own worktree (its own source) and its own pid.
const PROBE = needles => `import { readdirSync, readFileSync, readlinkSync, lstatSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
const N = ${JSON.stringify(Object.fromEntries(Object.entries(needles).filter(([k]) => !k.startsWith("__")).map(([k, v]) => [k, Buffer.from(v).toString("hex").split("").reverse().join("")])))};
const needles = Object.fromEntries(Object.entries(N).map(([k, v]) => [k, Buffer.from(v.split("").reverse().join(""), "hex").toString()]));
const own = process.cwd(), me = String(process.pid);
const isFile = p => { try { return statSync(p).isFile(); } catch { return false; } };   // never read a pipe or a socket (it would block)
const hit = (where, text) => { const out = []; for (const [k, v] of Object.entries(needles)) if (String(text).includes(v)) out.push(k); return out.length ? { where, found: out } : null; };
const report = { env: [], env_names: [], fs: [], fds: [], proc: [], pids: [], sockets: [], net: [], files_scanned: 0, known: {} };
// ENV
for (const [k, v] of Object.entries(process.env)) { const h = hit("env:" + k, v); if (h) report.env.push(h); }
report.env_names = Object.keys(process.env).filter(k => /KEY|TOKEN|SECRET|A2A|AGY|ANTIGRAVITY|PANTHEON|OPENAI/i.test(k));
// FILESYSTEM
const roots = [process.env.HOME, "/var/tmp", "/tmp", "/run", "/dev/shm", "/home", "/root", "/mnt", "/srv", "/etc", "/opt", "/var"].filter(Boolean);
const sockets = new Set(${JSON.stringify(needles.__sockets ?? [])});
const seen = new Set();
let budget = 0;
const walk = (d, depth) => {
  if (depth > 12 || budget > 6000 || seen.has(d)) return; seen.add(d);
  if (d === own || d.startsWith(own + "/")) return;
  let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".git") walk(p, depth + 1); }
    else if (e.isSocket()) sockets.add(p);
    else if (e.isFile()) { report.files_scanned++; budget++; try { const st = lstatSync(p); if (st.size > 4 << 20) continue; const h = hit(p, readFileSync(p)); if (h) report.fs.push(h); } catch {} }
  }
};
for (const r of roots) { budget = 0; walk(r, 0); }
const KNOWN = ${JSON.stringify(needles.__known ?? [])};
for (const p of KNOWN) { let r; try { const t = readFileSync(p); r = hit(p, t) ? "READABLE-WITH-SECRET" : "readable"; } catch (e) { r = e.code; } report.known[p] = r; }
// INHERITED FDS
for (const fd of readdirSync("/proc/self/fd")) {
  if (["0", "1", "2"].includes(fd)) continue;
  let target = null; try { target = readlinkSync("/proc/self/fd/" + fd); } catch { continue; }
  if (target === "/proc/" + me + "/fd" || target.startsWith("/proc/self")) continue;   // the readdir's own descriptor
  let h = null; try { if (isFile("/proc/self/fd/" + fd)) h = hit("fd:" + fd, readFileSync("/proc/self/fd/" + fd)); } catch {}
  // A descriptor this process did not make: anything but node's own event-loop inodes and pipes (observed on node 24:
  // node marks every inherited fd close-on-exec at startup, but it stays open in THIS process), or one that holds a secret.
  if (!/^(anon_inode:|pipe:)/.test(target) || h) report.fds.push({ fd, target, ...(h ? { found: h.found } : {}) });
}
// /proc OF EVERY OTHER PROCESS
for (const pid of readdirSync("/proc").filter(x => /^[0-9]+$/.test(x))) {
  if (pid === me) continue;
  let cmd = ""; try { cmd = readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").join(" ").trim(); } catch {}
  report.pids.push({ pid, cmd: cmd.slice(0, 120) });
  for (const f of ["environ", "cmdline"]) { try { const h = hit("/proc/" + pid + "/" + f, readFileSync("/proc/" + pid + "/" + f)); if (h) report.proc.push(h); } catch {} }
  let fds = []; try { fds = readdirSync("/proc/" + pid + "/fd"); } catch {}
  for (const fd of fds) { const q = "/proc/" + pid + "/fd/" + fd; try { if (!isFile(q) || statSync(q).size > 4 << 20) continue; const h = hit(q, readFileSync(q)); if (h) report.proc.push(h); } catch {} }
  // Another process's root: the known secret paths seen through it (a process in another mount namespace would show them).
  for (const k of KNOWN) { try { const h = hit("/proc/" + pid + "/root" + k, readFileSync("/proc/" + pid + "/root" + k)); if (h) report.proc.push(h); } catch {} }
}
// SOCKETS: connect to every A2A socket (named, or found) and ask without a token
const tryOne = p => new Promise(res => { const s = connect(p); const t = setTimeout(() => { s.destroy(); res({ path: p, result: "timeout" }); }, 2000);
  s.on("connect", () => { s.write("POST / HTTP/1.1\\r\\nhost: x\\r\\ncontent-length: 2\\r\\n\\r\\n{}"); });
  s.on("data", d => { clearTimeout(t); s.destroy(); res({ path: p, result: "CONNECTED", reply: String(d).split("\\r\\n")[0] }); });
  s.on("error", e => { clearTimeout(t); res({ path: p, result: e.code }); }); });
for (const p of sockets) report.sockets.push(await tryOne(p));
// NETWORK: TCP endpoints of the host (its loopback listener, the metadata address) and its abstract Unix sockets.
const reach = target => new Promise(res => { const s = connect(target); const t = setTimeout(() => { s.destroy(); res("timeout"); }, 2500);
  s.on("connect", () => { clearTimeout(t); s.destroy(); res("CONNECTED"); }); s.on("error", e => { clearTimeout(t); res(e.code); }); });
for (const n of ${JSON.stringify(needles.__net ?? [])}) report.net.push({ ...n, result: await reach(n.abstract ? { path: "\0" + n.abstract } : { host: n.host, port: n.port }) });
writeFileSync(join(own, "report.json"), JSON.stringify(report, null, 1));
process.stdout.write("probe scanned " + report.files_scanned + " files, sees " + report.pids.length + " other pids\\n");
`;

/** The fixture: a repo with a worktree and two units' control dirs, a fake home full of dummy credentials, all under /var/tmp. */
async function fixture(t) {
  const root = realpathSync(mkdtempSync("/var/tmp/pantheon-cred-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), fx = join(root, "fx"), home = join(root, "home"), wt = join(root, "run", "worktrees", "u1");
  const ctl = join(root, "run", "control", "u1"), ctl2 = join(root, "run", "control", "u2"), ck = join(root, "checkpoints");
  for (const d of [repo, fx, ctl, ctl2, ck, join(home, ".ssh"), join(home, ".config", "gh"), join(home, ".gemini", "antigravity-cli", "bin")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  await sh("printf 'base\\n' > README.md && git init -q -b main . && git -c user.name=t -c user.email=t@t.invalid add -A && git -c user.name=t -c user.email=t@t.invalid commit -q -m base", repo);
  await sh(`git worktree add -q -b unit-u1 ${wt}`, repo);
  const s = { oauth: dummy("OAUTH"), openai: dummy("sk-openai"), ssh: dummy("SSHKEY"), gh: dummy("ghtok"), sibling: dummy("SIBLING"), seal: dummy("SEAL"), gitremote: dummy("GITREMOTE"), hostfile: dummy("HOSTFILE") };
  // A token in the repository's remote URL (its .git/config) and in FETCH_HEAD, as a clone with an embedded token leaves it.
  await sh(`git remote add origin https://x-access-token:${s.gitremote}@example.invalid/r.git`, repo);
  writeFileSync(join(repo, ".git", "FETCH_HEAD"), `0000000000000000000000000000000000000000\t\tbranch 'main' of https://x-access-token:${s.gitremote}@example.invalid/r\n`);
  writeFileSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), JSON.stringify({ refresh_token: s.oauth }), { mode: 0o600 });
  writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "{}");
  writeFileSync(join(home, ".ssh", "id_dummy"), s.ssh, { mode: 0o600 });
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), `oauth_token: ${s.gh}\n`, { mode: 0o600 });
  writeFileSync(join(ctl2, "a2a.token"), s.sibling + "\n", { mode: 0o600 });
  writeFileSync(`${ck}.seal-key`, s.seal + "\n", { mode: 0o600 });
  const planted = hostFiles(t, s.hostfile);
  return { root, repo, fx, home, wt, ctl, ctl2, ck, s, planted, gitKnown: [join(repo, ".git", "config"), join(repo, ".git", "FETCH_HEAD")] };
}
const run = (cmd, args, opts = {}) => new Promise(res => {
  const c = spawn(cmd, args, { stdio: opts.stdio ?? ["ignore", "pipe", "pipe"], ...opts });
  let out = "", err = ""; c.stdout?.on("data", d => { out += d; }); c.stderr?.on("data", d => { err += d; });
  c.on("close", code => res({ code, out, err }));
});
/** A long-lived CREDENTIAL-BEARING process (as the MCP relay is): the token in its env and argv, its token file open. */
function bearer(t, token, tokenFile) {
  const fd = openSync(tokenFile, "r");
  const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", token], { env: { PATH: process.env.PATH, PANTHEON_A2A_TOKEN: token }, stdio: ["ignore", "ignore", "ignore", fd] });
  closeSync(fd);
  t.after(() => c.kill("SIGKILL"));
  return c;
}
const nothingFound = (rep, what) => {
  assert.deepEqual(rep.env, [], `${what}: no credential in the env`);
  assert.deepEqual(rep.env_names, [], `${what}: no key/token/A2A/AGY variable name in the env`);
  assert.deepEqual(rep.fs, [], `${what}: no credential in any readable file`);
  assert.deepEqual(rep.fds, [], `${what}: no inherited descriptor beyond stdio`);
  assert.deepEqual(rep.proc, [], `${what}: no credential through /proc of another process`);
  assert.ok(rep.files_scanned > 0, `${what}: the probe scanned something`);
  for (const [p, r] of Object.entries(rep.known)) assert.notEqual(r, "READABLE-WITH-SECRET", `${what}: ${p} is readable`);
  // Every path socket the probe found (none should be visible: homes, /run and /tmp are hidden) or was told of.
  for (const so of rep.sockets) assert.notEqual(so.result, "CONNECTED", `${what}: the socket ${so.path} is reachable`);
  // No network: neither the host's loopback listener, nor the metadata address, nor the host's abstract socket.
  for (const n of rep.net) assert.notEqual(n.result, "CONNECTED", `${what}: ${JSON.stringify(n)} is reachable`);
  assert.ok(rep.net.length >= 3, `${what}: the network was probed`);
};
/**
 * The host-side NETWORK targets: a TCP listener on the host's loopback, an ABSTRACT Unix socket bound on the host, and
 * the cloud metadata address. Returns the probe's __net list.
 */
async function hostNet(t) {
  const serve = c => { c.on("error", () => {}); c.end("hello"); }, tcp = createServer(serve), abs = createServer(serve), name = `pantheon-cred-abs-${randomBytes(6).toString("hex")}`;
  await new Promise(r => tcp.listen(0, "127.0.0.1", r)); await new Promise(r => abs.listen("\0" + name, r));
  t.after(() => { tcp.close(); abs.close(); });
  return [{ kind: "host-loopback", host: "127.0.0.1", port: tcp.address().port }, { kind: "abstract", abstract: name }, { kind: "metadata", host: "169.254.169.254", port: 80 }];
}
/** Plant a dummy secret in a host file under /etc, /opt and /srv (when this user may write there; root in CI containers). */
function hostFiles(t, secret) {
  const planted = [];
  for (const d of ["/etc", "/opt", "/srv"]) {
    const f = join(d, `pantheon-cred-${randomBytes(6).toString("hex")}`);
    try { writeFileSync(f, secret + "\n", { mode: 0o644 }); planted.push(f); t.after(() => rmSync(f, { force: true })); } catch { /* not writable here */ }
  }
  return planted;
}

test("credential isolation, WORKER path: the verify_cmd run by agy's run_command (the unit's verify launcher) cannot reach the A2A token, the OAuth token, the provider keys or the home's secrets -- by env, file, inherited fd, /proc or the A2A socket -- while ask_subagent keeps working through the relay, authorised and call-limited", { ...gate, timeout: 300_000 }, async t => {
  const f = await fixture(t);
  const calls = [];
  const shim = await startA2AShim({ unit_id: "u1", allowed_subagents: ["math"], socket: join(f.ctl, "a2a.sock"), seatFor: () => ({ vendor: "xai", model: "grok-x" }),
    subagentTurn: async () => ({ text: "42", served_model: "grok-x" }), limits: { max_calls: 2 }, onCall: r => calls.push(r) });
  t.after(() => shim.close());
  const needles = { ...f.s, a2a: shim.token, __net: await hostNet(t),
    __sockets: [shim.socket], __known: [join(f.ctl, "a2a.token"), join(f.ctl, ".agents", "mcp_config.json"), join(f.home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), join(f.ctl2, "a2a.token"), `${f.ck}.seal-key`, ...f.gitKnown, ...f.planted] };
  writeFileSync(join(f.wt, "probe.mjs"), PROBE(needles));
  // verify_hide: the checkpoints and their seal key, as the pipeline adds them (index.mjs verifyJail; it also adds its
  // run dir, left out here so that the control dir's OWN hiding -- it and its siblings -- is what this test exercises).
  const ws = await prepareWorkerWorkspace({ control_dir: f.ctl, worktree: f.wt, unit_id: "u1", owned_paths: ["src/**"], verify_cmd: "node probe.mjs", roles: ["math"], mcp_server: MCP_SERVER_PATH,
    a2a_env: { PANTHEON_A2A_SOCKET: shim.socket, PANTHEON_A2A_TOKEN: shim.token, PANTHEON_A2A_ROLES: "math", PANTHEON_UNIT_ID: "u1" }, verify_hide: [f.ck, `${f.ck}.seal-key`] });
  // The token is in a 0600 file the relay reads, and in no config.
  assert.equal(readFileSync(ws.a2a_token, "utf8").trim(), shim.token);
  assert.ok(!readFileSync(ws.mcp_config, "utf8").includes(shim.token), "the MCP config names the token FILE, not the token");
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = f.s.openai;
  t.after(() => { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; });
  await withFakeAgy(f.fx, async agy => {
    process.env.HOME = f.home;
    // The fake CLI (credential-bearing, in agy's jail): it CAN read the OAuth scratch copy and the token file (written down
    // as the positive control of the layer below), holds fd 9 on the token file and runs a long-lived process with the
    // token in its env and argv (as the relay does); asks two legitimate questions, a third (over the bound), a forbidden
    // role; then runs the ONE verify command, from a shell that holds fd 20 on the token file (KG-11: what reaches the
    // verify_cmd is then decided by the launcher's descriptor closer alone).
    agy.agyWorker(`cat "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" > "${f.fx}/agy-saw-oauth" 2>/dev/null
cat "${ws.a2a_token}" > "${f.fx}/agy-saw-token" 2>/dev/null
exec 9< "${ws.a2a_token}"
PANTHEON_A2A_TOKEN=$(cat "${ws.a2a_token}") node -e 'setTimeout(() => {}, 60000)' "$(cat "${ws.a2a_token}")" & bp=$!
agy_ask math "q1" > "${f.fx}/ask1" || exit 11
agy_ask math "q2" > "${f.fx}/ask2" || exit 12
agy_ask math "q3" > "${f.fx}/ask3" 2>&1 && exit 13
agy_ask release-manager "q4" > /dev/null 2>&1 && exit 14
bash -c 'exec 20<"$0"; exec node "$1" run "$2" "$3"' "${ws.a2a_token}" "$tools" "$dir" "$wverify" > "${f.fx}/verify.out" 2>&1 || { kill $bp; exit 15; }
kill $bp
reply=''
`);
    const r = await runAgyWorkerTurn({ cli: process.env.PANTHEON_AGY_CLI, control_dir: f.ctl, worktree: f.wt, model: "gemini-4-hydrogen-medium",
      prompt: ["PATHS YOU OWN", "- src/**", "Do not commit", "", "VERIFY COMMAND", `  ${ws.worker_verify_cmd}`].join("\n"), timeoutS: 60,
      env: { HOME: f.home, PANTHEON_A2A_SOCKET: shim.socket, PANTHEON_A2A_TOKEN: shim.token }, sandbox: { agy_state_dirs: [f.fx], home: f.home } });
    assert.equal(r.sandbox.kind, "bwrap");
    // The token never entered agy's environment, though the caller passed it.
    assert.ok(r.launch.env_stripped.includes("PANTHEON_A2A_TOKEN"));
    assert.ok(!JSON.stringify(r.launch).includes(shim.token));
    // POSITIVE CONTROL, one layer up: agy itself (credential-bearing) does see the OAuth scratch copy and the token file.
    assert.match(readFileSync(join(f.fx, "agy-saw-oauth"), "utf8"), new RegExp(f.s.oauth), "agy's jail holds the OAuth copy (the verify jail must hide it)");
    assert.equal(readFileSync(join(f.fx, "agy-saw-token"), "utf8").trim(), shim.token, "agy's jail can read the token file (the verify jail must hide it)");
    // LEGITIMATE A2A: two answers through the relay; the third is over the unit's bound; a forbidden role never reaches it.
    assert.match(readFileSync(join(f.fx, "ask1"), "utf8"), /"answer":"42"/);
    assert.match(readFileSync(join(f.fx, "ask2"), "utf8"), /"answer":"42"/);
    assert.match(readFileSync(join(f.fx, "ask3"), "utf8"), /429|exhausted/i);
    assert.deepEqual(calls.map(c => [c.role, c.status, c.code]), [["math", "answered", null], ["math", "answered", null], ["math", "refused", "CALLS_EXHAUSTED"]]);
    // The verify command ran through the launcher, approved by the hook, inside the verify jail.
    assert.ok(r.jail_log.some(l => l.tool === "run_command" && l.decision === "auto_approve" && l.args.CommandLine === ws.worker_verify_cmd));
    assert.match(readFileSync(join(f.fx, "verify.out"), "utf8"), /probe scanned \d+ files/);
    const rep = JSON.parse(readFileSync(join(f.wt, "report.json"), "utf8"));
    nothingFound(rep, "worker run_command");
    assert.ok(rep.pids.length <= 2, `only the verify jail's own processes are visible: ${JSON.stringify(rep.pids)}`);
    assert.ok(!rep.pids.some(p => /fake-agy|a2a-mcp-server|setTimeout/.test(p.cmd)), "neither agy, the relay nor the credential-bearing process is visible");
    for (const p of needles.__known.filter(x => !f.gitKnown.includes(x))) assert.match(String(rep.known[p]), /^E/, `${p}: not even readable (${rep.known[p]})`);
    for (const p of f.gitKnown) assert.notEqual(rep.known[p], "READABLE-WITH-SECRET", `${p}: the git config is the sanitized one`);
    assert.equal(rep.sockets.find(x => x.path === shim.socket)?.result, "ENOENT", "the A2A socket does not exist in the verify jail");
  });
  // INHERITED DESCRIPTORS AT THE LAUNCHER (KG-11). Neither a shell nor node's spawn closes a descriptor it was handed: here a
  // shell holding fd 9 and fd 20 on the token file execs the unit's verify launcher, as agy's shell runs it. POSITIVE
  // CONTROL: the same shell exec'ing the probe itself hands it both (and so the token).
  const report = join(f.wt, "report.json"), env = { PATH: process.env.PATH, HOME: f.home, OPENAI_API_KEY: f.s.openai, PANTHEON_A2A_TOKEN: shim.token };
  rmSync(report);
  const viaLauncher = await run("/bin/bash", ["-c", `exec 9< '${ws.a2a_token}'; exec 20< '${ws.a2a_token}'; exec '${ws.worker_verify_cmd}'`], { env, cwd: f.ctl });
  assert.equal(viaLauncher.code, 0, viaLauncher.err);
  nothingFound(JSON.parse(readFileSync(report, "utf8")), "the launcher started from a shell holding fd 9 and fd 20 and the keys in its env");
  rmSync(report);
  const direct = await run("/bin/bash", ["-c", `exec 9< '${ws.a2a_token}'; exec 20< '${ws.a2a_token}'; cd '${f.wt}' && exec node probe.mjs`], { env });
  assert.equal(direct.code, 0, direct.err);
  const leak = JSON.parse(readFileSync(report, "utf8"));
  assert.ok(leak.fds.some(x => x.fd === "9" && (x.found ?? []).includes("a2a")), "unjailed, fd 9 hands over the token");
  assert.ok(leak.fds.some(x => x.fd === "20" && (x.found ?? []).includes("a2a")), "unjailed, fd 20 hands over the token");
  assert.ok(leak.env.some(h => h.found.includes("openai")), "unjailed, the env hands over the provider key");
});

test("credential isolation, CONTROLLER path: runVerify runs the verify_cmd with none of the controller's credentials (env, inherited fd, the run's control dirs with the A2A token and the OAuth scratch, the seal key, the home's secrets, /proc of the relay, the A2A socket); the same probe UNJAILED finds every one (positive control)", { ...gate, timeout: 300_000 }, async t => {
  const f = await fixture(t);
  const shim = await startA2AShim({ unit_id: "u1", allowed_subagents: ["math"], socket: join(f.ctl, "a2a.sock"), seatFor: () => ({ vendor: "xai", model: "grok-x" }), subagentTurn: async () => ({ text: "42" }) });
  t.after(() => shim.close());
  await prepareWorkerWorkspace({ control_dir: f.ctl, worktree: f.wt, unit_id: "u1", owned_paths: ["src/**"], verify_cmd: "node probe.mjs", roles: ["math"], mcp_server: MCP_SERVER_PATH,
    a2a_env: { PANTHEON_A2A_SOCKET: shim.socket, PANTHEON_A2A_TOKEN: shim.token, PANTHEON_A2A_ROLES: "math", PANTHEON_UNIT_ID: "u1" } });
  // An OAuth scratch copy, as a running worker turn leaves one under the control dir's run/.
  mkdirSync(join(f.ctl, "run", "agy-state", "x", "antigravity-cli"), { recursive: true });
  writeFileSync(join(f.ctl, "run", "agy-state", "x", "antigravity-cli", "antigravity-oauth-token"), JSON.stringify({ refresh_token: f.s.oauth }), { mode: 0o600 });
  bearer(t, shim.token, join(f.ctl, "a2a.token"));
  const needles = { ...f.s, a2a: shim.token, __net: await hostNet(t),
    __sockets: [shim.socket], __known: [join(f.ctl, "a2a.token"), join(f.home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), join(f.ctl2, "a2a.token"), `${f.ck}.seal-key`, ...f.gitKnown, ...f.planted] };
  writeFileSync(join(f.wt, "probe.mjs"), PROBE(needles));
  // The CONTROLLER: a process with the provider key in its env, HOME at the fake home, and fd 3 and fd 20 open on the token
  // file without close-on-exec (descriptors a parent handed down; node marks the low one close-on-exec at startup, not fd 20,
  // KG-11). It calls runVerify as the pipeline does (index.mjs hides the run dir and the checkpoints with their key).
  const controller = join(f.root, "controller.mjs");
  writeFileSync(controller, `import { runVerify } from ${JSON.stringify(REVIEW)};
const v = await runVerify({ worktree: ${JSON.stringify(f.wt)}, verify_cmd: "node probe.mjs", jail: { hide: ${JSON.stringify([join(f.root, "run"), f.ck, `${f.ck}.seal-key`])} } });
process.stdout.write(JSON.stringify(v));
`);
  const env = { PATH: process.env.PATH, HOME: f.home, OPENAI_API_KEY: f.s.openai, PANTHEON_A2A_TOKEN: shim.token, LANG: "C.UTF-8" };
  const fd = openSync(join(f.ctl, "a2a.token"), "r");
  let c;
  try { c = await run(process.execPath, [controller], { env, cwd: f.root, stdio: ["ignore", "pipe", "pipe", fd, ...Array(16).fill("ignore"), fd] }); } finally { closeSync(fd); }
  assert.equal(c.code, 0, c.err);
  const v = JSON.parse(c.out);
  assert.deepEqual([v.exit_code, v.passed, v.jail], [0, true, { kind: "verify-jail", refused: false }], v.output);
  const rep = JSON.parse(readFileSync(join(f.wt, "report.json"), "utf8"));
  nothingFound(rep, "controller runVerify");
  assert.ok(rep.pids.length <= 2, `only the verify jail's own processes are visible: ${JSON.stringify(rep.pids)}`);
  for (const p of needles.__known.filter(x => !f.gitKnown.includes(x))) assert.match(String(rep.known[p]), /^E/, `${p}: not even readable (${rep.known[p]})`);
  for (const p of f.gitKnown) assert.notEqual(rep.known[p], "READABLE-WITH-SECRET", `${p}: the git config is the sanitized one`);
  assert.equal(rep.sockets.find(x => x.path === shim.socket)?.result, "ENOENT", "the A2A socket does not exist in the verify jail");

  // POSITIVE CONTROL: the same probe, the same controller-shaped env and fd 3 and fd 20, WITHOUT the jail. It must find them all.
  rmSync(join(f.wt, "report.json"));
  const fd2 = openSync(join(f.ctl, "a2a.token"), "r");
  let u;
  try { u = await run(process.execPath, ["probe.mjs"], { env, cwd: f.wt, stdio: ["ignore", "pipe", "pipe", fd2, ...Array(16).fill("ignore"), fd2] }); } finally { closeSync(fd2); }
  assert.equal(u.code, 0, u.err);
  const leak = JSON.parse(readFileSync(join(f.wt, "report.json"), "utf8"));
  const kinds = new Set([...leak.env, ...leak.fs, ...leak.proc].flatMap(h => h.found));
  for (const k of ["a2a", "oauth", "openai", "ssh", "gh", "sibling", "seal", ...(f.planted.length ? ["hostfile"] : [])]) assert.ok(kinds.has(k), `the unjailed probe finds ${k}: ${JSON.stringify([...kinds])}`);
  assert.ok(Object.entries(leak.known).some(([p, r]) => f.gitKnown.includes(p) && r === "READABLE-WITH-SECRET"), "unjailed, the repo's .git/config hands over the remote's token");
  assert.deepEqual(leak.net.filter(n => n.kind !== "metadata").map(n => [n.kind, n.result]), [["host-loopback", "CONNECTED"], ["abstract", "CONNECTED"]], "unjailed, the host's loopback and abstract sockets are reachable");
  assert.ok(leak.env.some(h => h.found.includes("openai")) && leak.env.some(h => h.found.includes("a2a")), "through the env");
  assert.ok(leak.fds.some(x => x.fd === "3" && (x.found ?? []).includes("a2a")), "through the inherited fd 3");
  assert.ok(leak.fds.some(x => x.fd === "20" && (x.found ?? []).includes("a2a")), "through the inherited fd 20");
  assert.ok(leak.proc.some(h => h.found.includes("a2a") && /environ|cmdline/.test(h.where)), "through /proc of the credential-bearing process");
  assert.ok(leak.sockets.some(x => x.path === shim.socket && x.result === "CONNECTED" && /401/.test(x.reply)), "the socket is reachable unjailed (and still demands the token)");
});

test("the verify jail fails CLOSED: no bwrap -> the launcher refuses (exit 125) and the script never runs; runVerify records the refusal", gate, async t => {
  const f = await fixture(t);
  const v = await (await import(REVIEW)).runVerify({ worktree: f.wt, verify_cmd: "touch ran", jail: { bwrap: join(f.root, "no-such-bwrap") } });
  assert.deepEqual([v.exit_code, v.passed, v.jail.refused], [125, false, true], v.output);
  assert.match(v.output, /refusing to run worker-controlled code unjailed/);
  assert.equal(existsSync(join(f.wt, "ran")), false, "the script never ran");
});

test("the verify env is an allowlist: provider keys, tokens, A2A/AGY/PANTHEON variables and every proxy variable (there is no network) never pass; TMPDIR is the jail's /tmp", () => {
  const { env, dropped } = verifyEnvOf({ PATH: "/usr/bin", HOME: "/home/fixture", LANG: "C.UTF-8", LC_ALL: "C", TERM: "xterm", OPENAI_API_KEY: "sk-x", GITHUB_TOKEN: "g", PANTHEON_A2A_TOKEN: "t",
    PANTHEON_A2A_SOCKET: "/s", AGY_X: "1", ANTIGRAVITY_AGY_CLEANUP: "all", FAKE_AGY_LOG: "/l", HTTPS_PROXY: "http://u:pw@proxy:3128", HTTP_PROXY: "http://proxy:3128", AWS_SESSION: "s",
    PANTHEON_VERIFY_ENV_PASS: "CI,MY_TOKEN", CI: "1", MY_TOKEN: "never" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/fixture", LANG: "C.UTF-8", LC_ALL: "C", TERM: "xterm", CI: "1", TMPDIR: "/tmp" });
  for (const k of ["OPENAI_API_KEY", "GITHUB_TOKEN", "PANTHEON_A2A_TOKEN", "PANTHEON_A2A_SOCKET", "AGY_X", "ANTIGRAVITY_AGY_CLEANUP", "FAKE_AGY_LOG", "HTTPS_PROXY", "HTTP_PROXY", "AWS_SESSION", "MY_TOKEN"]) assert.ok(dropped.includes(k), k);
});

test("the verify jail plan is an ALLOWLIST: an empty root with /usr, the /bin and /lib links, a few /etc entries and generated passwd/group/hosts, the node prefix, the worktree (rw) and its git dirs (ro) with a sanitized config; no network; a bind inside a hidden path is refused", gate, async t => {
  const f = await fixture(t);
  mkdirSync(join(f.home, ".ssh", "bin"), { recursive: true }); mkdirSync(join(f.ctl, "run"), { recursive: true });
  const p = verifyJailPlan({ worktree: f.wt, script: "true", control_dir: f.ctl, hide: [`${f.ck}.seal-key`], env: { HOME: f.home }, extra_ro: [join(f.home, ".ssh", "bin"), join(f.ctl, "run")], scratch: "/s" });
  for (const flag of ["--unshare-net", "--unshare-pid", "--unshare-ipc", "--new-session", "--die-with-parent", "--cap-drop"]) assert.ok(p.argv.includes(flag), flag);
  assert.ok(!p.argv.includes("/") || p.argv.indexOf("/") < 0 || !p.argv.join(" ").includes("--ro-bind / /"), "no bind of the host root");
  assert.ok(!p.argv.join(" ").includes("--ro-bind / /"));
  const binds = p.bound.map(b => `${b.mode}:${b.path}`);
  assert.ok(binds.includes(`rw:${f.wt}`) && binds.includes("ro:/usr"));
  assert.deepEqual(p.bound.filter(b => b.mode === "rw").map(b => b.path), [f.wt], "only the worktree is writable");
  for (const x of binds) assert.ok(!/^ro:\/(etc\/ssl\/private|home|root|opt$|var$|srv|run|mnt)/.test(x), x);
  assert.ok(p.refused_binds.some(b => b.path === join(f.home, ".ssh", "bin")), "a bind inside ~/.ssh is refused");
  assert.ok(p.refused_binds.some(b => b.path === join(f.ctl, "run")), "a bind inside the control dir is refused");
  assert.deepEqual(p.files.filter(x => ["passwd", "group", "hosts"].includes(x.name)).map(x => x.name), ["passwd", "group", "hosts"]);
  const cfg = p.files.find(x => x.name.endsWith("-config"));
  assert.ok(cfg && !cfg.content.includes(f.s.gitremote) && !/remote|url|credential|include/i.test(cfg.content), cfg?.content);
  assert.ok(p.argv.join(" ").includes(`--ro-bind /s/${cfg.name} ${join(f.repo, ".git", "config")}`), "the sanitized config is bound over the repo's");
  assert.ok(p.files.some(x => x.name.endsWith("FETCH_HEAD") && x.content === ""), "FETCH_HEAD is emptied");
  assert.ok(p.argv.join(" ").includes(`--tmpfs ${join(f.repo, ".git", "logs")}`), "the reflogs (a clone URL) are hidden");
  assert.equal(VERIFY_JAIL_SCHEMA, "pantheon.verify-jail/v1");
  // A policy asking for the network is refused, not granted.
  assert.throws(() => checkPolicy({ schema: VERIFY_JAIL_SCHEMA, worktree: f.wt, script: "true", network: true }), e => e.code === "BAD_POLICY" && /no network/.test(e.message));
  const v = await (await import(REVIEW)).runVerify({ worktree: f.wt, verify_cmd: "touch ran", jail: { network: true } });
  assert.equal(v.passed, true, "runVerify passes no network field: the jail option is ignored, the jail has none");
  // The sanitized config keeps what git needs and drops everything else.
  assert.equal(sanitizedGitConfig('[core]\n\trepositoryformatversion = 1\n\tfsmonitor = /bin/evil\n\thooksPath = /x\n\tbare = false\n[extensions]\n\tobjectformat = sha256\n[remote "origin"]\n\turl = https://t:SECRET@h/r\n[include]\n\tpath = /etc/x\n[credential]\n\thelper = store\n'),
    "[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectformat = sha256\n");
  // The worker env the CLI gets still never carries a key: the verify env is built from it, never wider.
  assert.equal(workerEnv({ OPENAI_API_KEY: "sk-x", PANTHEON_A2A_TOKEN: "t" }).PANTHEON_A2A_TOKEN, undefined);
});

test("git still works on the worktree inside the verify jail (status, log, diff), with no remote and none of the repo's config beyond core/extensions", gate, async t => {
  const f = await fixture(t);
  const v = await (await import(REVIEW)).runVerify({ worktree: f.wt, verify_cmd: "git status --short && git log --oneline -1 && git diff --stat HEAD && test -z \"$(git remote)\" && git config --list --show-origin && echo GIT-OK" });
  assert.equal(v.passed, true, v.output);
  assert.match(v.output, /GIT-OK/);
  assert.doesNotMatch(v.output, new RegExp(f.s.gitremote));
  assert.doesNotMatch(v.output, /remote\.origin|example\.invalid/);
});

test("the relay authenticates with its token FILE: the right token answers, a wrong or missing file is refused and no subagent turn runs", gate, async t => {
  const f = await fixture(t);
  let turns = 0;
  const shim = await startA2AShim({ unit_id: "u1", allowed_subagents: ["math"], socket: join(f.ctl, "a2a.sock"), seatFor: () => ({ vendor: "xai", model: "grok-x" }), subagentTurn: async () => { turns++; return { text: "42" }; } });
  t.after(() => shim.close());
  const good = join(f.ctl, "good.token"), bad = join(f.ctl, "bad.token");
  writeFileSync(good, shim.token + "\n"); writeFileSync(bad, "0".repeat(48) + "\n");
  const relay = file => new Promise(res => {
    const c = spawn(process.execPath, [MCP_SERVER_PATH], { env: { PATH: process.env.PATH, PANTHEON_A2A_SOCKET: shim.socket, PANTHEON_A2A_TOKEN_FILE: file, PANTHEON_A2A_ROLES: "math", PANTHEON_UNIT_ID: "u1" }, stdio: ["pipe", "pipe", "ignore"] });
    let out = ""; c.stdout.on("data", d => { out += d; if (out.split("\n").filter(Boolean).length >= 2) c.stdin.end(); });
    c.on("close", () => res(out.split("\n").filter(Boolean).map(l => JSON.parse(l)).find(m => m.id === 2)?.result));
    c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_subagent", arguments: { role: "math", question: "q" } } }) + "\n");
  });
  const ok = await relay(good);
  assert.equal(ok.isError, false); assert.equal(ok.structuredContent.answer, "42");
  const wrong = await relay(bad);
  assert.equal(wrong.isError, true); assert.match(wrong.content[0].text, /401/);
  const missing = await relay(join(f.ctl, "absent.token"));
  assert.equal(missing.isError, true); assert.match(missing.content[0].text, /not configured/);
  assert.equal(turns, 1, "only the authorised call reached a subagent turn");
});
