// THE JAILS HOLD NO DESCRIPTOR BEYOND 0, 1 AND 2 (register KG-11; docs/knowledge-graph/slice-c2.md "Descriptors (KG-11)";
// src/agy/fd-exec.mjs). Every jailed command starts with stdin, stdout and stderr only, whatever the process that starts
// its jail inherited and whatever the number: at each spawn point of both jails -- the agy worker (CLI) and the verify_cmd
// its run_command launches through the unit's verify launcher, the controller's own runVerify, the python SDK seat at the
// board and at the direct launcher.
//
// DETERMINISTIC: nothing here depends on what the environment leaks. Each controller is started with fd 9 and fd 20 open on
// a SYNTHETIC secret file without close-on-exec (fixtures/jail-fds-helpers.mjs `leaking`: node's spawn dup2s them into
// place); fd 20 lies above the range node marks close-on-exec at startup, and the controller records that it is still
// inheritable (the precondition). Agy's side leaks fd 20 again (bash: a POSIX sh cannot name it) when it runs the verify
// launcher. The PROBE (fixtures/jail-fds-probe.py) lists its /proc/self/fd and its parent's, resolves each target and reads
// each regular file through its descriptor for the needle. POSITIVE CONTROLS: the probe spawned by node, and under bwrap
// without the closer, holds fd 20 and reads the secret. The mutation runner (agy-sdk-jail.mutate.mjs, F1-F8) removes the
// closer at each spawn point and replaces its refusal with an unprotected run; these tests fail each time.
// Real bwrap; the jailed cells skip only where bwrap does not work (the test gate then reports UNVERIFIED, never PASS).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sandboxAvailable, sdkSeatJailGate } from "../src/agy/sandbox.mjs";
import { establishNoInheritedFds, inheritableFds, fdExecArgv, fdExecAvailable, resolveCommand, FD_EXEC_MODULE, FDS_REFUSED, FDS_PASSED } from "../src/agy/fd-exec.mjs";
import { prepareWorkerJail } from "../src/board/agy-cli.mjs";
import { startFakeGemini } from "./fixtures/l150-fake-gemini.mjs";
import { PROBE, hexRev, leaking, seatStub } from "./fixtures/jail-fds-helpers.mjs";

const HERE = import.meta.dirname, REPO = join(HERE, ".."), CONTROLLER = join(HERE, "fixtures", "jail-fds-controller.mjs"), LAUNCHER = join(REPO, "bin", "agy-seat.mjs");
const have = await sandboxAvailable("bwrap");
const jailed = { skip: have.ok ? false : `bwrap unavailable: ${have.why}`, timeout: 300_000 };
const MODEL_CLI = "gemini-4-hydrogen-medium", MODEL_SDK = "gemini-3.6-flash", KEY = "AIza-kg11-synthetic-controller-key-000000000";
const CLOEXEC = 0o2000000;

/** A root of its own under /var/tmp (outside /tmp, which every jail replaces) holding a SYNTHETIC secret file. */
function world(t) {
  accessSync("/var/tmp", constants.W_OK);   // never skipped: a host without a writable /var/tmp fails here, and says so
  const root = realpathSync(mkdtempSync("/var/tmp/jail-fds-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const needle = `KG11-SYNTHETIC-SECRET-${randomBytes(12).toString("hex")}`, secret = join(root, "synthetic-secret.txt");
  writeFileSync(secret, `${needle}\n`, { mode: 0o600 });
  mkdirSync(join(root, "home"));
  return { root, secret, needle_hex: hexRev(needle), env: { PATH: process.env.PATH, HOME: join(root, "home"), LANG: "C.UTF-8" } };
}
/** Run `cmd` with fd 9 and fd 20 on the secret handed to it without close-on-exec; {code, stdout, stderr}. */
async function withLeak(w, cmd, args, opts = {}) {
  const fd = openSync(w.secret, "r");
  try {
    const c = spawn(cmd, args, { ...opts, stdio: leaking(fd) });
    let stdout = "", stderr = "";
    c.stdout.on("data", d => { stdout += d; }); c.stderr.on("data", d => { stderr += d; });
    const code = await new Promise(r => c.on("close", (n, s) => r(n ?? s)));
    return { code, stdout, stderr };
  } finally { closeSync(fd); }
}
const readJson = f => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
/** One controller run (fixtures/jail-fds-controller.mjs), with the leak: its report. */
async function controller(w, mode, more = {}, env = {}) {
  const config = join(w.root, `${mode}-config.json`), result = join(w.root, `${mode}-result.json`);
  writeFileSync(config, JSON.stringify({ mode, result, root: w.root, secret: w.secret, needle_hex: w.needle_hex, probe: PROBE, ...more }));
  const r = await withLeak(w, process.execPath, [CONTROLLER, config], { env: { ...w.env, ...env } });
  const rep = readJson(result);
  assert.ok(rep, `the ${mode} controller exited ${r.code} without a report: ${r.stderr.slice(-3000)}`);
  // THE PRECONDITION: the controller holds fd 20 on the secret, still inheritable (node's startup did not mark it).
  assert.deepEqual(rep.precondition.fd20, { target: w.secret, cloexec: false }, "the controller was started holding fd 20 on the secret without close-on-exec");
  return { ...rep, said: `exit ${r.code}\n${r.stdout.slice(-1500)}\n${r.stderr.slice(-3000)}` };
}
/**
 * The probe's report: the process holds no descriptor beyond 0, 1 and 2, and none of its descriptors reads the secret.
 * `jailedParent` (default): its parent is inside the same jail (the jailed command, or bwrap's init when the probe is the command
 * itself) and is held to the same; false where the parent is this test's own process (the closer on the host).
 */
function clean(rep, w, what, { jailedParent = true } = {}) {
  assert.ok(rep?.self?.fds && rep?.parent?.fds, `${what}: the probe ran and reported: ${JSON.stringify(rep)}`);
  assert.deepEqual(rep.self.fds.filter(r => r.fd > 2), [], `${what}: no descriptor beyond 0, 1 and 2`);
  assert.ok(rep.self.fds.length >= 1, `${what}: the probe listed its descriptors`);
  // Its parent (the jailed command itself when the probe is its direct child): a descriptor above 2 is one the command
  // opened itself (a shell's own script, close-on-exec), never an inherited one.
  if (jailedParent) assert.deepEqual(rep.parent.fds.filter(r => r.fd > 2 && r.cloexec !== true), [], `${what}: the jailed command (${JSON.stringify(rep.parent_cmd)}) inherited no descriptor beyond 0, 1 and 2`);
  for (const r of [...rep.self.fds, ...(jailedParent ? rep.parent.fds : [])]) {
    assert.equal(r.has_secret, false, `${what}: descriptor ${r.fd} (${r.target}) reads the secret`);
    assert.notEqual(r.target, w.secret, `${what}: descriptor ${r.fd} is open on the secret`);
  }
}
/** The probe's report of a LEAK (a positive control): fd 20 is open on the secret and reads it. */
function leaked(rep, w, what) {
  assert.ok(rep?.self?.fds, `${what}: the probe ran and reported: ${JSON.stringify(rep)}`);
  assert.deepEqual(rep.self.fds.filter(r => r.fd === 20).map(r => [r.target, r.has_secret, r.cloexec]), [[w.secret, true, false]], `${what}: fd 20 hands over the secret`);
}

// ---- the closer itself -------------------------------------------------------------------------------------------------
test("closer: closes every descriptor above 2 that lacks close-on-exec and checks none is left; refuses when the table cannot be read or one stays open; never touches stdio or a close-on-exec descriptor", () => {
  const io = (table, { failClose = [], listThrows = false, flagsThrow = null } = {}) => {
    const t = new Map(Object.entries(table).map(([k, v]) => [Number(k), v])), closed = [];
    return { closed, list: () => { if (listThrows) throw Object.assign(new Error("no /proc here"), { code: "ENOENT" }); return [...t.keys()]; },
      flags: fd => { if (fd === flagsThrow) throw Object.assign(new Error(`the flags of descriptor ${fd} cannot be read`), { code: "FDS_UNREADABLE" }); return t.get(fd) ?? null; },
      close: fd => { if (failClose.includes(fd)) throw new Error("EIO"); closed.push(fd); t.delete(fd); } };
  };
  const a = io({ 0: 0o100000, 1: 1, 2: 1, 3: CLOEXEC | 2, 9: CLOEXEC | 0o100000, 10: CLOEXEC, 20: 0o100000, 255: 0 });
  assert.deepEqual(establishNoInheritedFds(a), { closed: [20, 255] });
  assert.deepEqual(a.closed, [20, 255], "only the inheritable ones above 2 are closed: never stdio, never a close-on-exec one (node's own)");
  assert.throws(() => establishNoInheritedFds(io({ 0: 0, 20: 0, 21: 0 }, { failClose: [21] })), e => e.code === "FDS_INHERITED" && JSON.stringify(e.left) === "[21]" && JSON.stringify(e.closed) === "[20]");
  assert.throws(() => establishNoInheritedFds(io({}, { listThrows: true })), e => e.code === "FDS_UNREADABLE" && /cannot be listed \(ENOENT\)/.test(e.message));
  assert.throws(() => establishNoInheritedFds(io({ 0: 0, 7: 0 }, { flagsThrow: 7 })), e => e.code === "FDS_UNREADABLE");
  assert.deepEqual(inheritableFds(io({ 0: 0, 3: null, 4: 0, 30: 0, 31: CLOEXEC })), [4, 30], "one gone between the listing and its flags is not open");
  assert.deepEqual(fdExecArgv(["bwrap", "--ro-bind", "/", "/", "--", "x"]), [process.execPath, FD_EXEC_MODULE, "bwrap", "--ro-bind", "/", "/", "--", "x"]);
  assert.deepEqual(fdExecArgv(["bwrap"], { node: "/opt/n/bin/node" }), ["/opt/n/bin/node", FD_EXEC_MODULE, "bwrap"]);
  assert.deepEqual(FDS_PASSED, [0, 1, 2]);
  assert.equal(FDS_REFUSED, 125);
  assert.equal(resolveCommand("sh", "/nonexistent-dir:/bin"), "/bin/sh");
  assert.equal(resolveCommand("no-such-command-kg11", "/bin:/usr/bin"), null);
  assert.equal(resolveCommand("/bin/sh"), "/bin/sh");
});

test("closer on the host: the command it execs holds neither fd 9 nor fd 20 of the process that started it, where node's spawn alone hands both over (the positive control)", async t => {
  const w = world(t);
  const direct = await withLeak(w, "python3", [PROBE, join(w.root, "direct.json"), w.needle_hex, "direct"]);
  assert.equal(direct.code, 0, direct.stderr);
  leaked(readJson(join(w.root, "direct.json")), w, "node's spawn, no closer");
  assert.ok(readJson(join(w.root, "direct.json")).self.fds.some(r => r.fd === 9 && r.has_secret), "node's spawn, no closer: fd 9 hands over the secret too");
  const [cmd, ...args] = fdExecArgv(["python3", PROBE, join(w.root, "via.json"), w.needle_hex, "via"]);
  const via = await withLeak(w, cmd, args);
  assert.equal(via.code, 0, via.stderr);
  clean(readJson(join(w.root, "via.json")), w, "through the closer", { jailedParent: false });
  assert.deepEqual(await fdExecAvailable(), { ok: true }, "the gates' probe of the closer passes here");
});

test("closer fails closed: without /proc, or on a node without process.execve, it exits 125 and the command never runs; a missing command exits 127", jailed, async t => {
  const w = world(t), mark = join(w.root, "the-command-ran");
  const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", env: w.env });
  const noProc = run("bwrap", ["--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--tmpfs", "/proc", "--bind", w.root, w.root, "--",
    process.execPath, FD_EXEC_MODULE, "/bin/sh", "-c", `touch '${mark}'`]);
  assert.equal(noProc.status, FDS_REFUSED, noProc.stderr);
  assert.match(noProc.stderr, /^pantheon-fds: refused: the descriptor table cannot be listed \(ENOENT\); the jail was not started$/m);
  assert.equal(existsSync(mark), false, "without /proc, the command never ran");
  const shim = join(w.root, "no-execve.cjs");
  writeFileSync(shim, "delete process.execve;\n");
  const noExec = run(process.execPath, ["--require", shim, FD_EXEC_MODULE, "/bin/sh", "-c", `touch '${mark}'`]);
  assert.equal(noExec.status, FDS_REFUSED, noExec.stderr);
  assert.match(noExec.stderr, /^pantheon-fds: refused: this node \(v[0-9.]+\) has no process\.execve/m);
  assert.equal(existsSync(mark), false, "without process.execve, the command never ran");
  const missing = run(process.execPath, [FD_EXEC_MODULE, join(w.root, "no-such-program")]);
  assert.deepEqual([missing.status, /not an executable file/.test(missing.stderr)], [127, true], missing.stderr);
});

test("gates fail closed: a descriptor closer that does not work here is the sandbox being unavailable -- the CLI worker's jail and the SDK seat's jail (the gate of the board's and the launcher's spawn) refuse (SANDBOX_UNAVAILABLE) before anything is built, admitted, charged or spawned", jailed, async t => {
  const w = world(t), shim = join(w.root, "no-execve.cjs"), broken = join(w.root, "node-without-execve");
  writeFileSync(shim, "delete process.execve;\n");
  writeFileSync(broken, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --require ${JSON.stringify(shim)} "$@"\n`, { mode: 0o755 });
  const probe = await fdExecAvailable({ node: broken });
  assert.equal(probe.ok, false);
  assert.match(probe.why, /exited 125 .*has no process\.execve/);
  // THE CLI WORKER'S JAIL (prepareWorkerJail: every agy CLI lane, the preflight and the quota probe build it).
  const ctl = join(w.root, "ctl"), wt = join(w.root, "wt");
  mkdirSync(ctl); mkdirSync(wt);
  const spec = { cli: "/bin/true", control_dir: ctl, worktree: wt, env: w.env };
  await assert.rejects(prepareWorkerJail({ ...spec, sandbox: { node: broken } }), e => e.code === "SANDBOX_UNAVAILABLE" && /no descriptor beyond 0, 1 and 2 can be guaranteed/.test(e.message));
  const un = await prepareWorkerJail({ ...spec, sandbox: { node: broken, allowUnsandboxed: true } });
  assert.deepEqual([un.prefix, un.sandboxRec.enabled, un.sandboxRec.allowUnsandboxed], [[], false, true], "only the explicit override runs without the jail, and it is recorded");
  assert.match(un.sandboxRec.reason, /no descriptor beyond 0, 1 and 2 can be guaranteed/);
  const ok = await prepareWorkerJail({ ...spec, sandbox: {} });
  assert.deepEqual([ok.prefix[0], ok.prefix[1], ok.prefix[2]], [process.execPath, FD_EXEC_MODULE, "bwrap"], "with a working closer, bwrap starts through it");
  // THE SDK SEAT'S JAIL: the one gate both spawn points call (run-item.mjs, bin/agy-seat.mjs); no override.
  await assert.rejects(sdkSeatJailGate({ node: broken }), e => e.code === "SANDBOX_UNAVAILABLE" && e.provider_requests === 0 && /no descriptor beyond 0, 1 and 2 can be guaranteed/.test(e.message) && /there is no override/.test(e.message));
  const gate = await sdkSeatJailGate();
  assert.equal(gate.node, process.execPath, "with a working closer the gate opens, with this node");
});

// ---- the CLI lane: the agy worker, the verify_cmd its run_command launches, and runVerify --------------------------------
test("CLI worker: started from a controller holding fd 20 on a secret, the agy worker holds no descriptor beyond 0-2; the verify_cmd its run_command launches holds none though agy's shell held fd 20 on it; nor does runVerify's -- where node's spawn and a bare bwrap hand fd 20 over", jailed, async t => {
  const w = world(t);
  const c = await controller(w, "worker", { model: MODEL_CLI });
  // POSITIVE CONTROLS: node's spawn and bwrap close nothing; the same bwrap through the closer holds nothing.
  leaked(c.controls.spawn, w, "the probe spawned by the controller (node's spawn)");
  leaked(c.controls.bwrap, w, "the probe under bwrap without the closer");
  assert.equal(c.controls.closer_status, 0, c.controls.closer_stderr);
  clean(c.controls.bwrap_closer, w, "the probe under bwrap through the closer");
  // THE AGY WORKER (the CLI jail's spawn point): bwrap started through the closer, the CLI inheriting nothing.
  assert.equal(c.worker.error, null, c.said + JSON.stringify(c.worker));
  assert.deepEqual([c.worker.launch.cmd, ...c.worker.launch.args0], [process.execPath, FD_EXEC_MODULE, "bwrap"]);
  assert.deepEqual(c.worker.descriptors?.passed, [0, 1, 2]);
  clean(c.worker.agy, w, "the agy worker's child (what the CLI inherited)");
  // AGY'S SIDE: its shell did hold fd 20 on the secret (positive control), and ran the verify launcher holding it.
  leaked(c.worker.agy_held, w, "agy's shell holding fd 20");
  assert.equal(c.worker.approved, true, "the verify launcher ran through run_command, approved by the hook");
  clean(c.worker.verify, w, "the verify_cmd agy's run_command launched");
  // THE CONTROLLER'S runVerify, this controller still holding fd 20.
  assert.deepEqual([c.runverify.exit_code, c.runverify.passed, c.runverify.jail], [0, true, { kind: "verify-jail", refused: false }], c.runverify.output);
  clean(c.runverify.probe, w, "the verify_cmd runVerify launched");
});

// ---- the python SDK seat: the board and the direct launcher ---------------------------------------------------------------
test("SDK board: started from a controller holding fd 20 on a secret, the python SDK seat's whole process holds no descriptor beyond 0-2, and the seat still answers through the relay", jailed, async t => {
  const w = world(t);
  const b = await controller(w, "board", { model: MODEL_SDK }, { GEMINI_API_KEY: KEY });
  assert.equal(b.board.shipped, true, b.said + JSON.stringify(b.board));
  assert.deepEqual(b.board.critique.map(a => [a.transport, a.outcome]), [["agy-sdk", "ok"]], JSON.stringify(b.board.critique));
  assert.ok(b.board.requests >= 1, "the seat's requests reached the provider through the relay");
  clean(b.board.probe, w, "the SDK seat at the board");
});

test("SDK launcher: the governed direct launch (bin/agy-seat.mjs), itself holding fd 20 on a secret, runs the seat with no descriptor beyond 0-2", jailed, async t => {
  const w = world(t), ws = join(w.root, "ws"), out = join(w.root, "out"), bin = join(w.root, "bin"), usage = join(w.root, "usage.jsonl");
  for (const d of [ws, bin]) mkdirSync(d);
  writeFileSync(join(ws, "README.md"), "# a workspace under review\n");
  writeFileSync(join(w.root, "brief.txt"), "Review the README.");
  const fake = await startFakeGemini({ mode: "review", usage, workspace: ws }); t.after(() => fake.close());
  const python = seatStub(bin, { needle_hex: w.needle_hex });
  const r = await withLeak(w, process.execPath, [LAUNCHER, "--gemini-api-primary", "10", "--gemini-usage", usage, "--python", python, "--",
    "--role", "reviewer", "--workspace", ws, "--model", MODEL_SDK, "--brief", join(w.root, "brief.txt"), "--out", out, "--timeout", "60"],
  { env: { ...w.env, GEMINI_API_KEY: KEY, PANTHEON_AGY_RELAY_UPSTREAM: fake.url } });
  assert.equal(r.code, 0, `${r.stdout.slice(-1500)}\n${r.stderr.slice(-2500)}`);
  assert.ok(fake.requests.length >= 1, "the seat's requests reached the provider through the relay");
  clean(readJson(join(out, "jail-fds-seat.json")), w, "the SDK seat at the direct launcher");
});
