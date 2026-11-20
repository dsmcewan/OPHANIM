// THE PYTHON SDK SEAT'S BUBBLE (knowledge graphs, Slice C2; register L-155 and KG-6; owner decision 2026-11-20, "Yes, bubble
// per seat"; docs/knowledge-graph/slice-c2.md). The seat's WHOLE process runs in a bwrap jail (src/agy/sandbox.mjs
// sdkSeatJail) at BOTH spawn points: the board's SDK seat (runOpenItem, PANTHEON_AGY_TRANSPORT=sdk) and the governed direct
// launch (bin/agy-seat.mjs). Each attempt of an agy seat records the transport it ran on, agy-cli or agy-sdk.
//
// THE STUB SEAT. The google-antigravity SDK is not installed here: the seat's python is the stub interpreter of
// fixtures/agy-sdk-jail-helpers.mjs, which runs fixtures/agy-sdk-jail-probe.py INSIDE the real jail, launched through the
// real spawn path, and then the real scripts/agy-seat.py over the L-150 stub SDK, whose requests reach the controller's real
// metering relay (its upstream a local fake). The controller is a process of its own (fixtures/agy-sdk-jail-board.mjs, or
// the launcher), started with a SYNTHETIC GEMINI_API_KEY in its environment, so /proc/<pid>/environ holds it. Its HOME is a
// directory of its own OUTSIDE /tmp (under /var/tmp, the FHS temp directory that persists; removed after each test):
// the jail replaces /tmp with a fresh tmpfs, so a HOME under /tmp would prove nothing about hiding HOME.
//
// WHAT THE STUB CANNOT PROVE: the real SDK's own tool runner (its harness's run_command and file tools) is not exercised; the
// probe stands where those tools stand, as a child process of the jailed seat, and every process the seat starts is inside
// the same jail. Real bwrap is required: the cells that run the jail skip (and the test gate reports UNVERIFIED, never PASS)
// where `bwrap` does not work; the refusal without bwrap and the builder's argv run everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sandboxAvailable, sdkSeatJail, sdkSeatEnv, sdkSeatHidden, interpreterPaths, SDK_JAIL_ENV_ALLOW } from "../src/agy/sandbox.mjs";
import { fdExecPrefix } from "../src/agy/fd-exec.mjs";
import { runOpenItem } from "../src/board/run-item.mjs";
import { capabilitySnapshot } from "../src/capability/graph.mjs";
import { extractMetrics } from "../src/capability/metrics.mjs";
import { withDispatch, seat } from "./fixtures/dispatch.mjs";
import { startFakeGemini } from "./fixtures/l150-fake-gemini.mjs";
import { stubInterpreter, processesNaming, pgrep, readJson, SEAT_PY } from "./fixtures/agy-sdk-jail-helpers.mjs";
import { registries } from "./fixtures/capability-helpers.mjs";

const HERE = import.meta.dirname, REPO = join(HERE, ".."), BOARD = join(HERE, "fixtures", "agy-sdk-jail-board.mjs"), LAUNCHER = join(REPO, "bin", "agy-seat.mjs");
const have = await sandboxAvailable("bwrap");
const jailed = { skip: have.ok ? false : `bwrap unavailable: ${have.why}`, timeout: 240_000 };
const KEY = "AIza-c2-synthetic-controller-key-00000000000", GKEY = "AIza-c2-synthetic-google-key-11111111111", CANARY = "c2-canary-inherited-not-allowlisted";
const MODEL = "gemini-3.6-flash", CAPABILITY = `agy-sdk/agy_google/${MODEL}`;
const VAR_TMP = "/var/tmp";
const jsonl = f => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms = 60_000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting"); await sleep(50); } };
// What the jail's environment may hold: its allowlist, the locale, the operator's pass list of the test fixtures (FAKE_*),
// and what the stub interpreter and python set inside the jail themselves.
const INSIDE = new Set(["PWD", "SHLVL", "_", "PYTHONDONTWRITEBYTECODE", "LC_CTYPE", "TMPDIR"]);
const envAllowed = k => SDK_JAIL_ENV_ALLOW.includes(k) || k.startsWith("LC_") || k.startsWith("FAKE_") || INSIDE.has(k);

/**
 * The controller's world for one test: a HOME of its own outside /tmp with synthetic credentials where the real ones live
 * (the ADC file, the Antigravity CLI's OAuth login, a plain secret), a Google credential file outside HOME named by
 * GOOGLE_APPLICATION_CREDENTIALS, and host paths outside the workspace and the out dir the seat must not write.
 */
function world(t) {
  accessSync(VAR_TMP, constants.W_OK);   // never skipped: a host without a writable /var/tmp fails here, and says so
  const root = realpathSync(mkdtempSync(join(VAR_TMP, "agy-sdk-jail-")));
  const tag = randomBytes(6).toString("hex");
  const repoWrite = join(REPO, "tests", `.agy-sdk-jail-write-${tag}`);
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(repoWrite, { force: true }); rmSync(join("/tmp", `.agy-sdk-jail-probe-${tag}`), { force: true }); });
  const home = join(root, "home");
  const put = (f, text) => { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, text); return f; };
  const secrets = [put(join(home, ".config", "gcloud", "application_default_credentials.json"), JSON.stringify({ type: "authorized_user", refresh_token: KEY })),
    put(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), `oauth ${KEY}\n`), put(join(home, "secret.txt"), `${KEY}\n`)];
  const gac = put(join(root, "service-account.json"), JSON.stringify({ private_key: KEY }));
  // The hidden HOME's root exists inside the jail (an empty tmpfs): only --remount-ro stops a write there (J11), where a write
  // under a missing subdirectory fails either way (coordinator fix at integration).
  const writes = [join(root, "outside-the-jail.txt"), join(home, ".config", "gcloud", "planted.json"), join(home, "planted-at-home-root.txt"), repoWrite];
  return { root, home, tag, gac, writes, plan: { secrets: [...secrets, gac], writes, tag },
    env: { PATH: process.env.PATH, HOME: home, GEMINI_API_KEY: KEY, GOOGLE_API_KEY: GKEY, AGY_C2_JAIL_CANARY: CANARY, GOOGLE_APPLICATION_CREDENTIALS: gac } };
}

/** Everything the jailed probe reported, asserted: the controller's environment, HOME and credentials out of reach. */
function assertJailed(p, w, { workspace, out }) {
  assert.ok(p, "the probe ran inside the jail and reported");
  assert.equal(p.env_has_key, false, "the controller's GEMINI_API_KEY is not in the seat's environment");
  assert.equal(p.env_has_canary, false, "a variable the controller holds and the allowlist does not name is not inherited");
  assert.deepEqual(p.env_names.filter(k => !envAllowed(k)), [], "the seat's environment is the jail's allowlist");
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "AGY_C2_JAIL_CANARY"]) assert.ok(!p.env_names.includes(k), k);
  assert.deepEqual(p.proc.environ_with_key, [], "no /proc/<pid>/environ the jail can read holds the key");
  assert.ok(p.proc.pids.every(n => n < 1000), `only the jail's own processes are visible: ${p.proc.pids.join(", ")}`);
  assert.deepEqual([p.controller.exists, p.controller.readable, p.controller.has_key ?? false], [false, false, false], `the controller (pid ${p.controller.pid}) is not visible: ${JSON.stringify(p.controller)}`);
  for (const s of p.secrets) assert.equal(s.readable, false, `${s.path} is not readable in the jail (${s.error ?? "read"})`);
  for (const x of p.writes) assert.equal(x.written, false, `${x.path} is not writable from the jail`);
  for (const f of w.writes) assert.equal(existsSync(f), false, `${f} was not created on the host`);
  const control = Object.fromEntries(p.control_writes.map(c => [c.dir, c.written]));
  assert.deepEqual([control[workspace], control[out], control[p.home], control["/tmp"]], [true, true, true, true], "the workspace, the out dir, the seat's HOME and its /tmp are writable");
  assert.equal(existsSync(join("/tmp", `.agy-sdk-jail-probe-${w.tag}`)), false, "what the seat wrote to its /tmp is not on the host: the jail's own tmpfs");
  assert.ok(p.home.startsWith(out + "/"), `the seat's HOME ${p.home} is a directory of its out dir`);
  assert.equal(p.tmpdir, "/tmp");
  assert.equal(p.cwd, workspace, "the jail starts in the workspace");
  assert.deepEqual([p.relay?.session_with_capability, p.relay?.request_without_capability], [200, 401], "the relay is reachable with the capability, and refuses a request without it");
}
/** Each request the provider saw was charged (its usage row persisted) before it arrived. */
const chargedBefore = edge => edge.forEach((r, i) => assert.ok(r.usage_rows >= i + 1, `request ${i + 1} reached the provider with ${r.usage_rows} usage row(s) persisted`));

/** One board run in a controller process of its own (fixtures/agy-sdk-jail-board.mjs): its report. */
async function board(t, w, { mode = "review", ...cfg } = {}) {
  const usage = join(w.root, "usage.jsonl");
  const fake = await startFakeGemini({ mode, usage }); t.after(() => fake.close());
  const config = { result: join(w.root, "board-result.json"), key: `c2-${w.tag}`, upstream: fake.url, usage, budget: 100, model: MODEL, plan: w.plan, ...cfg };
  writeFileSync(join(w.root, "board-config.json"), JSON.stringify(config));
  const child = spawn(process.execPath, [BOARD, join(w.root, "board-config.json")], { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  child.stdout.on("data", d => { said += d; }); child.stderr.on("data", d => { said += d; });
  const code = await new Promise(r => child.on("close", r));
  const rep = readJson(config.result);
  assert.ok(rep, `the board controller exited ${code} without a report: ${said.slice(-3000)}`);
  return { ...rep, controller: child.pid, fake, usage: jsonl(usage), said };
}
const critique = run => (run?.attempts ?? []).filter(a => a.vendor === "agy_google" && a.purpose === "critique");

/** One governed direct launch (bin/agy-seat.mjs), its pid written into the workspace before it starts (the probe reads it). */
function launch(t, w, { budget = 10, hang = 0, onSpawn = null, env = {} } = {}) {
  const ws = join(w.root, "ws"), out = join(w.root, "out"), py = join(w.root, "bin");
  mkdirSync(ws, { recursive: true }); mkdirSync(py, { recursive: true });
  writeFileSync(join(ws, "README.md"), "# a workspace under review\n");
  writeFileSync(join(w.root, "brief.txt"), "Review the README.");
  const pidFile = join(ws, ".controller-pid");
  const python = stubInterpreter(py, { ...w.plan, pid_file: pidFile, key_hex_rev: Buffer.from(KEY).reverse().toString("hex"), canary_hex_rev: Buffer.from(CANARY).reverse().toString("hex"), ...(hang ? { hang } : {}) });
  return async fake => {
    const args = ["--gemini-api-primary", String(budget), "--gemini-usage", join(w.root, "usage.jsonl"), "--python", python, "--",
      "--role", "reviewer", "--workspace", ws, "--model", MODEL, "--brief", join(w.root, "brief.txt"), "--out", out, "--timeout", "60"];
    // sh writes its own pid, then becomes the launcher (exec keeps the pid): the controller's pid is known before it starts.
    const child = spawn("/bin/sh", ["-c", 'printf %s "$$" > "$0"; exec "$@"', pidFile, process.execPath, LAUNCHER, ...args],
      { env: { ...w.env, PANTHEON_AGY_RELAY_UPSTREAM: fake.url, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; }); child.stderr.on("data", d => { stderr += d; });
    onSpawn?.(child, { out });
    const code = await new Promise(r => child.on("close", (c, s) => r(c ?? s)));
    const last = (text, ok = () => true) => text.trim().split("\n").filter(l => l.startsWith("{")).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(o => o && ok(o)).at(-1) ?? null;
    return { code, ws: realpathSync(ws), out: existsSync(out) ? realpathSync(out) : out, python, probe: readJson(join(out, "jail-probe.json")), result: last(stdout),
      report: last(stderr, o => o.launcher === "agy-seat.mjs"), usage: jsonl(join(w.root, "usage.jsonl")), said: `exit ${code}\n${stdout.slice(-1500)}\n${stderr.slice(-2500)}` };
  };
}

// ---- the builder (no bwrap needed: the argv and the refusals) ----------------------------------------------------------
test("the builder: the host read-only, a PID namespace with a fresh /proc, the controller's HOME and credential locations hidden and read-only, the interpreter and the repository bound back, only the workspace and the out dir writable, an allowlisted environment", t => {
  const w = world(t), ws = join(w.root, "ws"), out = join(w.root, "out"), rt = join(w.root, "run-user"), gcfg = join(w.root, "gcloud-config"), sock = join(w.root, "agent.sock");
  for (const d of [ws, join(out, "home"), rt, gcfg]) mkdirSync(d, { recursive: true });
  writeFileSync(sock, "");
  // A venv under the hidden HOME: its root and its interpreter bound back read-only.
  const venv = join(w.home, "venvs", "antigravity");
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeFileSync(join(venv, "pyvenv.cfg"), "home = /usr/bin\ninclude-system-site-packages = false\n");
  symlinkSync("/usr/bin/python3", join(venv, "bin", "python"));
  const python = join(venv, "bin", "python");
  const ip = interpreterPaths(python);
  assert.ok(ip.includes(python) && ip.includes(venv) && ip.every(p => p.startsWith("/")), `a venv's interpreter and its root: ${ip.join(", ")}`);
  const base = { HOME: w.home, XDG_RUNTIME_DIR: rt, SSH_AUTH_SOCK: sock, GOOGLE_APPLICATION_CREDENTIALS: w.gac, CLOUDSDK_CONFIG: gcfg, PANTHEON_AGY_ENV_PASS: "" };
  const env = { PATH: "/usr/bin:/bin", HOME: join(out, "home"), LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PANTHEON_AGY_RELAY_URL: "http://127.0.0.1:9", PANTHEON_AGY_RELAY_CAPABILITY: "ophanim-relay-x",
    AGY_C2_JAIL_CANARY: CANARY, XDG_CONFIG_HOME: join(w.home, ".config") };
  const j = sdkSeatJail({ python, script: SEAT_PY, repo: REPO, workspace: ws, out_dir: out, env, read: [join(w.root, "absent-brief.txt")], base });
  // What is hidden: the controller's HOME (and this process's own, and the passwd entry's), the runtime dir, the gcloud
  // config as directories; the Google credential file and the agent socket as files.
  const hidden = Object.fromEntries(j.hidden.map(h => [h.path, h.kind]));
  for (const d of [w.home, rt, gcfg]) assert.equal(hidden[d], "dir", `${d} hidden`);
  for (const f of [w.gac, sock]) assert.equal(hidden[f], "file", `${f} hidden`);
  // THE WHOLE ARGV: the descriptor closer (KG-11: bwrap starts through it, so no descriptor the controller inherited reaches
  // the seat), the jail's flags, the workspace and the end of options last, and every operation between them.
  const a = j.prefix;
  assert.deepEqual([j.fds.argv, j.fds.passed, j.record.descriptors.passed], [fdExecPrefix(), [0, 1, 2], [0, 1, 2]], "the closer runs with this host's python3; only stdio is passed");
  const HEAD = [...fdExecPrefix(), "bwrap", "--die-with-parent", "--unshare-pid", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  const TAIL = ["--chdir", realpathSync(ws), "--"];
  const middle = a.filter((_, i) => i >= HEAD.length && i < a.length - TAIL.length);
  assert.deepEqual(a, [...HEAD, ...middle, ...TAIL]);
  const pairs = [];
  for (let i = 0; i < middle.length;) { const n = middle[i] === "--tmpfs" || middle[i] === "--remount-ro" ? 2 : 3; pairs.push(middle.filter((_, k) => k >= i && k < i + n)); i += n; }
  // Read-only bind-backs: the venv under the hidden HOME, and the repository only where a hidden location covers it.
  const repo = realpathSync(REPO), repoCovered = ["/tmp", ...j.hidden.filter(h => h.kind === "dir").map(h => h.path)].some(h => repo === h || repo.startsWith(h + "/"));
  const expected = [...j.hidden.flatMap(h => (h.kind === "dir" ? [["--tmpfs", h.path], ["--remount-ro", h.path]] : [["--ro-bind", "/dev/null", h.path]])),
    ["--ro-bind", venv, venv], ...(repoCovered ? [["--ro-bind", repo, repo]] : []),
    ["--bind", realpathSync(ws), realpathSync(ws)], ["--bind", realpathSync(out), realpathSync(out)]];
  const key = q => JSON.stringify(q);
  assert.deepEqual(pairs.map(key).sort(), expected.map(key).sort(), "nothing is hidden, visible or writable but these: only the workspace and the out dir writable");
  const has = (...p) => pairs.some(q => key(q) === key(p));
  assert.ok(pairs.findIndex(q => q[0] === "--ro-bind" && q[1] === venv) > pairs.findIndex(q => q[0] === "--tmpfs" && q[1] === w.home), "the bind-back follows the hide");
  assert.ok(pairs.findIndex(q => q[0] === "--remount-ro") > pairs.findLastIndex(q => q[0] === "--bind" || (q[0] === "--ro-bind" && q[1] !== "/dev/null")), "the hidden dirs are made read-only after every bind");
  assert.ok(!a.includes("--unshare-net"), "the network is shared (retained, never claimed isolated)");
  assert.deepEqual(Object.keys(j.env).sort(), ["HOME", "LANG", "LC_ALL", "PANTHEON_AGY_RELAY_CAPABILITY", "PANTHEON_AGY_RELAY_URL", "PATH", "TMPDIR"]);
  assert.deepEqual(j.dropped, ["AGY_C2_JAIL_CANARY", "XDG_CONFIG_HOME"], "anything not allowlisted is dropped");
  assert.equal(j.home, realpathSync(join(out, "home")));
  // The jail's re-check of agySdkEnvOf's withholding: a credential-named variable refuses the seat, it is not dropped.
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "PANTHEON_AGY_VERTEX_PROJECT", "CLOUDSDK_CONFIG", "OPENAI_API_KEY", "A_SECRET_TOKEN"]) {
    assert.throws(() => sdkSeatEnv({ ...env, [k]: "synthetic" }), e => e.code === "SDK_JAIL_ENV" && e.refused.includes(k) && !e.message.includes("synthetic"), k);
  }
  // Layouts that would expose what the jail hides, or leave the seat's HOME outside its out dir, are refused.
  const refuses = (spec, re) => assert.throws(() => sdkSeatJail({ python, script: SEAT_PY, repo: REPO, workspace: ws, out_dir: out, env, base, ...spec }), e => e.code === "SDK_JAIL_LAYOUT" && re.test(e.message));
  refuses({ env: { ...env, HOME: w.home } }, /HOME .* is not a directory of its own inside its out dir/);
  refuses({ workspace: w.home }, /the workspace .* is a location the jail hides/);
  refuses({ workspace: "/tmp" }, /the workspace \/tmp is a location the jail hides/);
  refuses({ read: [w.gac] }, /is a location the jail hides/);
  assert.throws(() => sdkSeatHidden({ HOME: "/" }, { homes: ["/"] }), e => e.code === "SDK_JAIL_LAYOUT" && /cannot be hidden without hiding the host/.test(e.message));
});

// ---- the board's spawn point (runOpenItem) -----------------------------------------------------------------------------
test("board: the SDK seat's whole process runs in the jail -- the controller's environment, HOME and credentials out of its reach, nothing outside the workspace and its out dir writable -- each request still charged at the relay; its HOME is gone afterwards; its attempt records transport agy-sdk and maps onto the SDK capability", jailed, async t => {
  const w = world(t);
  const b = await board(t, w);
  assert.equal(b.result.shipped, true, b.said.slice(-2000) + JSON.stringify(b.result));
  assertJailed(b.probe, w, { workspace: b.worktree, out: b.seat_dirs[0].dir });
  assert.ok(b.progress.some(e => e.event === "seat.jail" && /jailed \(bwrap\)/.test(e.detail)), "the jail is on the progress trail");
  // The relay: each request charged before it was sent, exactly as before the jail (L-150).
  assert.ok(b.fake.requests.length >= 3, `the seat's requests reached the provider through the relay: ${b.fake.requests.length}`);
  chargedBefore(b.fake.requests);
  assert.ok(b.fake.requests.every(q => q.key === KEY), "forwarded with the controller's key, which the seat never held");
  assert.equal(b.usage.length, b.fake.requests.length, "one usage row per request");
  // KG-6: the attempt says which transport served it, and the metrics map it onto its executable capability.
  assert.deepEqual(critique(b.run).map(a => [a.transport, a.outcome, a.provider_requests]), [["agy-sdk", "ok", b.fake.requests.length]], JSON.stringify(critique(b.run)));
  assert.equal(critique(b.run)[0].settings.transport, "agy", "the seat's transport as selected is kept in its settings");
  assert.deepEqual(b.run.turns.filter(x => x.vendor === "agy_google").map(x => [x.purpose, x.transport, x.settings.transport]), [["critique", "agy-sdk", "agy"]], "the turn records the transport it ran on too (KG-6)");
  const M = extractMetrics({ runs: [{ run: b.run, source: "board", practice: false }], stages: [], transcripts: [], gemini: [], relay: [], unreadable: [], read: {} }, { snapshot: capabilitySnapshot(registries()) });
  assert.equal(M.capabilities[CAPABILITY]?.attempts, 1, JSON.stringify(Object.keys(M.capabilities)));
  assert.deepEqual(M.unmapped.filter(u => u.seat.vendor === "agy_google"), [], "the SDK attempt is not listed unmapped");
  // The single-assignment lifetime: the seat's HOME removed, its processes gone, the relay closed.
  assert.equal(b.seat_dirs[0].home, false, "the seat's HOME is removed after the assignment");
  assert.ok(b.progress.some(e => e.event === "seat.teardown" && /removed/.test(e.detail)));
  assert.equal(b.pgrep_after, "", "no process of the seat is left");
  assert.ok(b.seat_dirs[0].files.includes("response.md") && b.seat_dirs[0].files.includes("result.json"), "the assignment's records stay");
});

test("board timeout path: the controller's bound kills the hanging seat; its HOME is removed and no process is left", jailed, async t => {
  const w = world(t);
  // The controller's bound is the seat's timeout plus 60 s of grace (run-item.mjs agyTurn): -58 makes it 2 s.
  const t0 = Date.now();
  const b = await board(t, { ...w, plan: { ...w.plan, hang: 120 } }, { timeout: -58 });
  assert.ok(Date.now() - t0 < 100_000, "the bound, not the probe's sleep, ended the turn");
  assertJailed(b.probe, w, { workspace: b.worktree, out: b.seat_dirs[0].dir });
  assert.deepEqual(critique(b.run).map(a => [a.transport, a.outcome]), [["agy-sdk", "error"]], JSON.stringify(critique(b.run)));
  assert.equal(b.seat_dirs[0].home, false, "the seat's HOME is removed on the timeout path");
  assert.ok(b.progress.some(e => e.event === "seat.teardown" && /removed/.test(e.detail)), JSON.stringify(b.progress));
  assert.equal(b.pgrep_after, "", "no process of the seat is left");
});

test("board kill path: the run's stop kills the jailed seat; its HOME is removed, no process is left, nothing more is charged", jailed, async t => {
  const w = world(t);
  const b = await board(t, { ...w, plan: { ...w.plan, hang: 120 } }, { abort: true });
  assertJailed(b.probe, w, { workspace: b.worktree, out: b.seat_dirs[0].dir });
  assert.equal(b.run?.error?.code, "STAGE_ELAPSED", JSON.stringify(b.run?.error));
  assert.ok(b.progress.some(e => e.event === "seat.teardown" && /removed/.test(e.detail)), JSON.stringify(b.progress));
  assert.equal(b.seat_dirs[0].home, false, "the seat's HOME is removed on the kill path");
  assert.equal(b.pgrep_after, "", "no process of the seat is left");
  assert.deepEqual([b.fake.requests.length, b.usage.length], [0, 0]);
});

test("board without bwrap: the SDK seat is refused before the relay, the spawn or any charge (SANDBOX_UNAVAILABLE; no override)", { timeout: 240_000 }, async t => {
  const w = world(t);
  const b = await board(t, w, { bwrap: "/nonexistent/bwrap" });
  assert.deepEqual(critique(b.run).map(a => [a.transport, a.code, a.provider_requests]), [["agy-sdk", "SANDBOX_UNAVAILABLE", 0]], JSON.stringify(critique(b.run)) + b.said.slice(-1500));
  assert.equal(b.probe, null, "nothing was spawned");
  assert.deepEqual([b.fake.requests.length, b.usage.length], [0, 0], "nothing was sent or charged");
  assert.deepEqual(b.seat_dirs.map(d => d.home), [false], "no HOME was made");
  assert.ok(b.progress.some(e => e.event === "turn.refused" && /SDK seat's bwrap jail is unavailable.*no override/.test(e.detail)), JSON.stringify(b.progress));
  assert.ok(!b.progress.some(e => e.event === "seat.env"), "the relay's capability was never issued");
});

// ---- the direct launcher's spawn point (bin/agy-seat.mjs, L-151) --------------------------------------------------------
test("launcher: the governed direct launch runs the seat in the same jail; each request charged at the relay; the seat's HOME is removed afterwards", jailed, async t => {
  const w = world(t);
  const fake = await startFakeGemini({ mode: "review", usage: join(w.root, "usage.jsonl"), workspace: join(w.root, "ws") }); t.after(() => fake.close());
  const r = await launch(t, w)(fake);
  assert.equal(r.code, 0, r.said);
  assert.equal(r.result?.ok, true, r.said);
  assertJailed(r.probe, w, { workspace: r.ws, out: r.out });
  assert.ok(fake.requests.length >= 3, r.said);
  chargedBefore(fake.requests);
  assert.deepEqual([r.usage.length, r.report?.relay?.admitted], [fake.requests.length, fake.requests.length]);
  assert.equal(r.report?.jail?.kind, "bwrap", "the launcher's report names the jail");
  assert.deepEqual(r.report?.jail?.writable?.sort(), [r.out, r.ws].sort());
  assert.deepEqual([r.report?.teardown?.removed, existsSync(join(r.out, "home"))], [true, false], "the seat's HOME is removed after the assignment");
  assert.deepEqual(processesNaming(r.python), [], "no process of the seat is left");
});

test("launcher kill path: SIGTERM to the launcher stops the jailed seat; its HOME is removed and no process is left", jailed, async t => {
  const w = world(t);
  const fake = await startFakeGemini({ mode: "review", usage: join(w.root, "usage.jsonl") }); t.after(() => fake.close());
  let probeSeen = false;
  const r = await launch(t, w, { hang: 120, onSpawn: (child, { out }) => { until(() => existsSync(join(out, "jail-probe.json"))).then(() => { probeSeen = true; child.kill("SIGTERM"); }, () => child.kill("SIGKILL")); } })(fake);
  assert.equal(probeSeen, true, r.said);
  assertJailed(r.probe, w, { workspace: r.ws, out: r.out });
  assert.equal(r.report?.stopped, true, r.said);
  assert.deepEqual([r.report?.teardown?.removed, existsSync(join(r.out, "home"))], [true, false], "the seat's HOME is removed on the kill path");
  await sleep(500);
  assert.deepEqual(processesNaming(r.python), [], "no process of the seat is left");
  assert.equal(pgrep(r.python), "");
});

test("launcher without bwrap: refused before the relay, the spawn or any charge (exit 2, SANDBOX_UNAVAILABLE; no override)", { timeout: 240_000 }, async t => {
  const w = world(t);
  const fake = await startFakeGemini({ mode: "review", usage: join(w.root, "usage.jsonl") }); t.after(() => fake.close());
  // No bwrap on PATH: the launcher's jail is the binary PATH names, so a PATH without it is a host without it.
  const r = await launch(t, w, { env: { PATH: join(w.root, "no-bwrap-here") } })(fake);
  assert.equal(r.code, 2, r.said);
  assert.equal(r.report?.refused?.code, "SANDBOX_UNAVAILABLE", r.said);
  assert.match(r.report.refused.why, /refusing to run the python SDK seat unjailed \(there is no override\)/);
  assert.deepEqual([r.probe, fake.requests.length, r.usage.length, existsSync(join(r.out, "home"))], [null, 0, 0, false], "nothing spawned, sent, charged or made");
});

// ---- KG-6: the CLI lane's attempt -------------------------------------------------------------------------------------
test("KG-6: an agy seat on the CLI lane records transport agy-cli on its attempt, which maps onto the CLI capability; a record saying agy stays listed unmapped", jailed, async () => {
  await withDispatch(async ({ spec, opts }) => {
    const r = await runOpenItem(spec("c2-cli"), { ...opts(), seatOverrides: { reviewer: seat("agy_google", MODEL, { transport: "agy" }) } });
    const run = JSON.parse(readFileSync(join(r.board, "run.json"), "utf8"));
    assert.deepEqual(critique(run).map(a => [a.transport, a.outcome, a.settings.transport]), [["agy-cli", "ok", "agy"]], JSON.stringify(critique(run)));
    assert.deepEqual(run.turns.filter(x => x.vendor === "agy_google").map(x => [x.purpose, x.transport, x.settings.transport]), [["critique", "agy-cli", "agy"]], "the turn records the transport it ran on too, the seat's own in its settings");
    const old = { ...run, attempts: critique(run).map(a => ({ ...a, transport: "agy" })) };
    const M = extractMetrics({ runs: [{ run, source: "new" }, { run: old, source: "old" }], stages: [], transcripts: [], gemini: [], relay: [], unreadable: [], read: {} }, { snapshot: capabilitySnapshot(registries()) });
    assert.equal(M.capabilities[`agy-cli/agy_google/${MODEL}`]?.attempts, 1);
    assert.deepEqual(M.unmapped.filter(u => u.seat.vendor === "agy_google").map(u => [u.source, u.seat.transport, u.why]),
      [["old", "agy", "the attempt records transport agy, which does not say whether the CLI or the SDK seat served it"]]);
  });
});
