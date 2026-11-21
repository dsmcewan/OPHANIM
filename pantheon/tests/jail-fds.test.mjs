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
// without the closer, holds fd 20 and reads the secret. THE CLOSER is a single-threaded python3 program (FD_EXEC_PY); its
// refusals are shown on real cases: no /proc, its closing sabotaged, a second thread in its process (FD_EXEC_PY run after
// a prelude, the program text itself unchanged). The mutation runner (agy-sdk-jail.mutate.mjs, F1-F11) removes the closer
// at each spawn point, replaces its refusal with an unprotected run, drops a gate's check of it, its single-thread check,
// its environment or its signal restoration; these tests fail each time.
// Real bwrap; the jailed cells skip only where bwrap does not work (the test gate then reports UNVERIFIED, never PASS).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sandboxAvailable, sdkSeatJailGate } from "../src/agy/sandbox.mjs";
import { fdExecArgv, fdExecAvailable, fdExecPrefix, fdExecPython, resolveCommand, FD_EXEC_PY, FD_EXEC_PY_FLAGS, FDS_REFUSED, FDS_PASSED } from "../src/agy/fd-exec.mjs";
import { prepareWorkerJail } from "../src/board/agy-cli.mjs";
import { startFakeGemini } from "./fixtures/l150-fake-gemini.mjs";
import { PROBE, hexRev, leaking, seatStub } from "./fixtures/jail-fds-helpers.mjs";

const HERE = import.meta.dirname, REPO = join(HERE, ".."), CONTROLLER = join(HERE, "fixtures", "jail-fds-controller.mjs"), LAUNCHER = join(REPO, "bin", "agy-seat.mjs");
const have = await sandboxAvailable("bwrap");
const jailed = { skip: have.ok ? false : `bwrap unavailable: ${have.why}`, timeout: 300_000 };
const MODEL_CLI = "gemini-4-hydrogen-medium", MODEL_SDK = "gemini-3.6-flash", KEY = "AIza-kg11-synthetic-controller-key-000000000";
/** The shell that lists its own open descriptors (the glob's own directory descriptor is closed by the time it tests). */
const LIST_FDS = ["/bin/sh", "-c", 'for f in /proc/$$/fd/*; do n=${f##*/}; [ -L "/proc/$$/fd/$n" ] && echo "$n"; done; true'];

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
/** spawnSync of `argv` with the secret open, without close-on-exec, at each descriptor of `at` (default 9 and 20). */
function withFds(w, argv, at = [9, 20], opts = {}) {
  const fd = openSync(w.secret, "r");
  try {
    const stdio = ["ignore", "pipe", "pipe"];
    for (const n of at) stdio[n] = fd;
    for (let i = 0; i < stdio.length; i++) stdio[i] ??= "ignore";
    return spawnSync(argv[0], argv.slice(1), { encoding: "utf8", env: w.env, ...opts, stdio });
  } finally { closeSync(fd); }
}
/** The descriptors above stdio this test process hands to ANY child by inheritance, measured with nothing handed over.
 *  None on a clean host; but a supervisor can leak its own: the GitHub Actions runner hands its jobs fds 142 and 145
 *  (seen in CI at d9d626f, which made exact-list cells fail there and pass here). The cells expect what they hand PLUS
 *  these, and the closer must still leave stdio only: KG-11's threat, live in CI. */
function ambientFds(w) {
  const r = withFds(w, LIST_FDS, []);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n").filter(Boolean).map(Number).filter(n => n > 2);
}
const fdSet = (...lists) => [...new Set(lists.flat())].sort((a, b) => a - b);
/** The closer's program run after `prelude` (the program text itself unchanged): how its refusals are shown on real cases. */
const closerAfter = prelude => [fdExecPython(), ...FD_EXEC_PY_FLAGS, "-c", `${prelude}\n${FD_EXEC_PY}`];
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
test("closer: python3 -I -S -c FD_EXEC_PY in front of the command; on a real table it closes EVERY descriptor above 2 it was handed (3, 9, 20, 255) and keeps stdio, where node's spawn alone hands all four over; no python3 is no closer", t => {
  const py = fdExecPython();
  assert.ok(py, "python3 is on this host's PATH (the closer needs it; without it every gate refuses)");
  assert.equal(py, resolveCommand("python3", process.env.PATH));
  assert.deepEqual(fdExecPrefix(), [py, "-I", "-S", "-c", FD_EXEC_PY]);
  assert.deepEqual(fdExecArgv(["bwrap", "--ro-bind", "/", "/", "--", "x"]), [py, "-I", "-S", "-c", FD_EXEC_PY, "bwrap", "--ro-bind", "/", "/", "--", "x"]);
  assert.deepEqual(fdExecArgv(["bwrap"], { closerPython: "/opt/p/bin/python3" }), ["/opt/p/bin/python3", "-I", "-S", "-c", FD_EXEC_PY, "bwrap"]);
  assert.throws(() => fdExecArgv(["bwrap"], { closerPython: null }), e => e.code === "FDS_NO_PYTHON");
  assert.throws(() => fdExecArgv([]), /pass the argv to start/);
  assert.deepEqual(FDS_PASSED, [0, 1, 2]);
  assert.equal(FDS_REFUSED, 125);
  assert.equal(resolveCommand("sh", "/nonexistent-dir:/bin"), "/bin/sh");
  assert.equal(resolveCommand("no-such-command-kg11", "/bin:/usr/bin"), null);
  assert.equal(resolveCommand("/bin/sh"), "/bin/sh");
  const w = world(t), at = [3, 9, 20, 255], ambient = ambientFds(w);
  const direct = withFds(w, LIST_FDS, at);
  assert.equal(direct.status, 0, direct.stderr);
  assert.deepEqual(direct.stdout.trim().split("\n").map(Number).sort((a, b) => a - b), fdSet([0, 1, 2], at, ambient), `node's spawn alone hands every one over (the positive control), with any this host's supervisor leaked (${ambient.join(", ") || "none"})`);
  const via = withFds(w, fdExecArgv(LIST_FDS), at);
  assert.equal(via.status, 0, via.stderr);
  assert.deepEqual(via.stdout.trim().split("\n").map(Number).sort((a, b) => a - b), [0, 1, 2], "through the closer: stdio only");
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

test("closer fidelity: the command it execs gets exactly the environment, the signal dispositions and the open-file soft limit the closer was given, as a direct spawn does -- python's startup (LC_CTYPE coerced under the C locale, SIGPIPE and SIGXFSZ ignored) leaks into none of them", t => {
  const w = world(t);
  // LANG=C: python coerces LC_CTYPE at startup (PEP 538). A value holding "=" and a non-ASCII value travel as given.
  const env = { PATH: process.env.PATH, LANG: "C", KG11_SYNTHETIC: "a=b c", KG11_BYTES: "café" };
  // Each command reports on ITSELF, exec'd directly (by the closer, or by the shell below): a shell reading its own
  // /proc/$$/status through a child would show the mask it blocks while it waits for that child (dash's sigblockall).
  const shows = { env: ["/usr/bin/env"], signals: ["grep", "-E", "^Sig(Ign|Blk):", "/proc/self/status"], limit: ["/bin/sh", "-c", "ulimit -Sn"] };
  // A shell lowers the soft open-file limit and execs what follows: the same for the direct spawn and the closer.
  const lowered = argv => ["/bin/sh", "-c", 'ulimit -Sn 1024 && exec "$@"', "sh", ...argv];
  const lines = r => r.stdout.split("\n").filter(Boolean).sort();
  const got = {};
  for (const [k, show] of Object.entries(shows)) {
    const direct = withFds(w, lowered(show), [9, 20], { env }), via = withFds(w, lowered(fdExecArgv(show)), [9, 20], { env });
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(via.status, 0, via.stderr);
    assert.deepEqual(lines(via), lines(direct), `${k}: the closer hands over what a direct spawn does`);
    got[k] = via.stdout;
  }
  assert.doesNotMatch(got.env, /^LC_CTYPE=/m, "no locale coerced into the command's environment");
  assert.match(got.env, /^KG11_SYNTHETIC=a=b c$/m);
  assert.match(got.env, /^KG11_BYTES=café$/m);
  assert.match(got.signals, /^SigIgn:\s+0+$/m, "no signal left ignored (python ignores SIGPIPE and SIGXFSZ at its startup)");
  assert.match(got.signals, /^SigBlk:\s+0+$/m, "no signal left blocked");
  assert.equal(got.limit.trim(), "1024", "the soft open-file limit it was started with");
});

test("closer fails closed: without /proc, with its closing sabotaged, or with a second thread in its process, it exits 125 and the command never runs; a missing command exits 127, one the kernel will not execute 126", jailed, async t => {
  const w = world(t), mark = join(w.root, "the-command-ran"), touch = ["/bin/sh", "-c", `touch '${mark}'`];
  const run = argv => spawnSync(argv[0], argv.slice(1), { encoding: "utf8", env: w.env });
  const noProc = run(["bwrap", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--tmpfs", "/proc", "--bind", w.root, w.root, "--", ...fdExecArgv(touch)]);
  assert.equal(noProc.status, FDS_REFUSED, noProc.stderr);
  assert.match(noProc.stderr, /^pantheon-fds: refused: the thread list cannot be listed \(ENOENT\); the jail was not started$/m);
  assert.equal(existsSync(mark), false, "without /proc, the command never ran");
  // Its closing sabotaged (os.closerange a no-op): the check after it finds fd 9 and fd 20 still open (and any
  // descriptor this host's supervisor leaked into the test process, which the closer must name too).
  const sabotaged = withFds(w, [...closerAfter("import os\nos.closerange = lambda low, high: None"), ...touch]);
  assert.equal(sabotaged.status, FDS_REFUSED, sabotaged.stderr);
  const left = fdSet([9, 20], ambientFds(w)).join(", ");
  assert.match(sabotaged.stderr, new RegExp(`^pantheon-fds: refused: descriptor\\(s\\) ${left} still open after closing; the jail was not started$`, "m"));
  assert.equal(existsSync(mark), false, "a descriptor still open: the command never ran");
  // A second thread (what a node closer always has): it could open a descriptor between the check and the exec.
  const threaded = withFds(w, [...closerAfter("import _thread, time\n_thread.start_new_thread(time.sleep, (30,))"), ...touch]);
  assert.equal(threaded.status, FDS_REFUSED, threaded.stderr);
  assert.match(threaded.stderr, /^pantheon-fds: refused: the closer is not single-threaded \(2 threads\): a descriptor could be opened between its check and its exec; the jail was not started$/m);
  assert.equal(existsSync(mark), false, "another thread: the command never ran");
  const none = run(fdExecPrefix());
  assert.deepEqual([none.status, /^pantheon-fds: refused: no command was given/m.test(none.stderr)], [FDS_REFUSED, true], none.stderr);
  const missing = run(fdExecArgv([join(w.root, "no-such-program")]));
  assert.deepEqual([missing.status, /^pantheon-fds: .*no-such-program: not an executable file$/m.test(missing.stderr)], [127, true], missing.stderr);
  const garbage = join(w.root, "not-a-program");
  writeFileSync(garbage, Buffer.from([0x7f, 0x00, 0x01, 0x02])); chmodSync(garbage, 0o755);
  const noexec = run(fdExecArgv([garbage]));
  assert.deepEqual([noexec.status, /^pantheon-fds: .*not-a-program: cannot be executed \(ENOEXEC\)$/m.test(noexec.stderr)], [126, true], noexec.stderr);
});

test("gates fail closed: a descriptor closer that does not work here (no python3, or a python3 that runs the command without closing) is the sandbox being unavailable -- the CLI worker's jail and the SDK seat's jail (the gate of the board's and the launcher's spawn) refuse (SANDBOX_UNAVAILABLE) before anything is built, admitted, charged or spawned", jailed, async t => {
  const w = world(t), leaky = join(w.root, "python3-that-leaks");
  // A "python3" that skips -I -S -c FD_EXEC_PY and execs the command as it is: the probe's fd 20 reaches it.
  writeFileSync(leaky, "#!/bin/sh\nshift 4\nexec \"$@\"\n", { mode: 0o755 });
  const probe = await fdExecAvailable({ closerPython: leaky });
  assert.equal(probe.ok, false);
  assert.match(probe.why, /exited 0 with "LEAKED 20"/);
  assert.deepEqual(await fdExecAvailable({ closerPython: null }), { ok: false, why: "no python3 was found on PATH to run the descriptor closer" });
  // THE CLI WORKER'S JAIL (prepareWorkerJail: every agy CLI lane, the preflight and the quota probe build it).
  const ctl = join(w.root, "ctl"), wt = join(w.root, "wt");
  mkdirSync(ctl); mkdirSync(wt);
  const spec = { cli: "/bin/true", control_dir: ctl, worktree: wt, env: w.env };
  for (const closerPython of [leaky, null]) {
    await assert.rejects(prepareWorkerJail({ ...spec, sandbox: { closerPython } }), e => e.code === "SANDBOX_UNAVAILABLE" && /no descriptor beyond 0, 1 and 2 can be guaranteed/.test(e.message), String(closerPython));
  }
  const un = await prepareWorkerJail({ ...spec, sandbox: { closerPython: leaky, allowUnsandboxed: true } });
  assert.deepEqual([un.prefix, un.sandboxRec.enabled, un.sandboxRec.allowUnsandboxed], [[], false, true], "only the explicit override runs without the jail, and it is recorded");
  assert.match(un.sandboxRec.reason, /no descriptor beyond 0, 1 and 2 can be guaranteed/);
  const ok = await prepareWorkerJail({ ...spec, sandbox: {} });
  // test-lint: allow truncated-sequence -- the closer's WHOLE argv and the command it starts; what follows "bwrap" is bwrapArgs' argv, asserted item by item in agy-sandbox.test.mjs
  assert.deepEqual(ok.prefix.slice(0, fdExecPrefix().length + 1), fdExecArgv(["bwrap"]), "with a working closer, bwrap starts through it");
  // THE SDK SEAT'S JAIL: the one gate both spawn points call (run-item.mjs, bin/agy-seat.mjs); no override.
  for (const closerPython of [leaky, null]) {
    await assert.rejects(sdkSeatJailGate({ closerPython }), e => e.code === "SANDBOX_UNAVAILABLE" && e.provider_requests === 0 && /no descriptor beyond 0, 1 and 2 can be guaranteed/.test(e.message) && /there is no override/.test(e.message), String(closerPython));
  }
  const gate = await sdkSeatJailGate();
  assert.equal(gate.closerPython, fdExecPython(), "with a working closer the gate opens, with this host's python3");
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
  // THE AGY WORKER (the CLI jail's spawn point): the CLI inherits nothing -- the property first, how it holds after.
  assert.equal(c.worker.error, null, c.said + JSON.stringify(c.worker));
  clean(c.worker.agy, w, "the agy worker's child (what the CLI inherited)");
  // AGY'S SIDE: its shell did hold fd 20 on the secret (positive control), and ran the verify launcher holding it.
  leaked(c.worker.agy_held, w, "agy's shell holding fd 20");
  assert.equal(c.worker.approved, true, "the verify launcher ran through run_command, approved by the hook");
  clean(c.worker.verify, w, "the verify_cmd agy's run_command launched");
  // How: bwrap started through the closer, stdio the only descriptors passed.
  assert.deepEqual([c.worker.launch.cmd, ...c.worker.launch.args0], fdExecArgv(["bwrap"]));
  assert.deepEqual(c.worker.descriptors?.passed, [0, 1, 2]);
  // THE CONTROLLER'S runVerify, this controller still holding fd 20.
  assert.deepEqual([c.runverify.exit_code, c.runverify.passed, c.runverify.jail], [0, true, { kind: "verify-jail", refused: false }], c.runverify.output);
  clean(c.runverify.probe, w, "the verify_cmd runVerify launched");
});

// ---- the python SDK seat: the board and the direct launcher ---------------------------------------------------------------
test("SDK board: started from a controller holding fd 20 on a secret, the python SDK seat's whole process holds no descriptor beyond 0-2, and the seat still answers through the gateway", jailed, async t => {
  const w = world(t);
  const b = await controller(w, "board", { model: MODEL_SDK }, { GEMINI_API_KEY: KEY });
  assert.equal(b.board.shipped, true, b.said + JSON.stringify(b.board));
  assert.deepEqual(b.board.critique.map(a => [a.transport, a.outcome]), [["agy-sdk", "ok"]], JSON.stringify(b.board.critique));
  assert.ok(b.board.requests >= 1, "the seat's requests reached the provider through the gateway");
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
  { env: { ...w.env, GEMINI_API_KEY: KEY, PANTHEON_AGY_GATEWAY_UPSTREAM: fake.url } });
  assert.equal(r.code, 0, `${r.stdout.slice(-1500)}\n${r.stderr.slice(-2500)}`);
  assert.ok(fake.requests.length >= 1, "the seat's requests reached the provider through the gateway");
  clean(readJson(join(out, "jail-fds-seat.json")), w, "the SDK seat at the direct launcher");
});
