// THE REVIEW RUNNER'S COVERAGE GATE (L-501) and THE CODE UNDER REVIEW ONLY IN A VERIFY JAIL (L-404), self-audit round 3,
// assignment 4 (sealed fe2a612); owner plan step 3.
//   L-501: a run was `complete` as soon as the transport produced a final text (the 09d490f run of assignment 4 read no
//          source at all). coverage.mjs derives {source_reads, denied_reads, tests_run} per transport from what the runner
//          itself observed, and a `complete` run whose gate fails is `incomplete`.
//   L-404: the API runner's run_tests ran `node --test` as the RUNNER's own child (it holds the provider key in its
//          environment; a same-uid child reads /proc/<runner>/environ, the owner's home and the network). The probe below
//          is a test under review, run through the real tools.mjs by a real runner process that holds a SYNTHETIC key in
//          its initial environment, under REAL bwrap. At 08ee51a it finds the key, the home file and the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPromise } from "../src/board/spawn.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
// coverage.mjs is new (L-501): loaded lazily, so at 08ee51a the L-404 process-boundary test below still runs and fails
// on its own assertions.
const cov = await import("../src/review-runner/coverage.mjs").catch(() => ({}));
const { coverageGate, coverageOfAgy, coverageOfApi, coverageOfCodex, coverageOfGrok, gatedStatus, mergeCoverage, testsAllowedBy } = cov;
import { permissionsFor } from "../src/review-runner/tools.mjs";

const TOOLS = fileURLToPath(new URL("../src/review-runner/tools.mjs", import.meta.url));

test("L-501: the gate -- no source read, a denied read, or no test where the testing limit allows tests make a `complete` run `incomplete`; refused tests say why", () => {
  const full = { source_reads: 2, denied_reads: 0, tests_run: 1, tests_allowed: true };
  assert.deepEqual(coverageGate(full), { ok: true, reasons: [] });
  assert.deepEqual(coverageGate({ ...full, source_reads: 0 }).reasons, ["no source file was read"]);
  assert.deepEqual(coverageGate({ ...full, denied_reads: 3 }).reasons, ["3 read(s) were denied by the hook or the sandbox"]);
  assert.deepEqual(coverageGate({ ...full, tests_run: 0 }).reasons, ["no test command ran although the testing limit allows tests"]);
  assert.deepEqual(coverageGate({ ...full, tests_run: 0, tests_refused: "codex runs none" }).reasons, ["no test ran although the testing limit allows tests: codex runs none"]);
  assert.deepEqual(coverageGate({ ...full, tests_run: 0, tests_allowed: false }), { ok: true, reasons: [] });
  assert.match(coverageGate({ ...full, unhooked: [{ tool: "run_command", done: 2, approved: 1 }] }).reasons[0], /tool steps the hook never approved: run_command \(2 done, 1 approved\)/);
  assert.match(coverageGate({ ...full, tool_drift: { ok: false, unclassified: [{ name: "x_exec" }] } }).reasons[0], /tools the hook does not classify: x_exec/);
  assert.deepEqual(gatedStatus("complete", "final answer", coverageGate({ ...full, source_reads: 0 })), { status: "incomplete", stop_reason: "coverage gate: no source file was read (the transport ended with: final answer)" });
  for (const s of ["failed", "refused", "incomplete"]) assert.equal(gatedStatus(s, "x", { ok: false, reasons: ["r"] }).status, s, "only a complete run is gated");
  for (const t of ["Local deterministic fixtures", "Source inspection and existing authorized tests only"]) assert.equal(testsAllowedBy(permissionsFor(t, ["a.test.mjs"])), true, t);
});

test("L-501, per transport: the API runner's tool events, agy's hook decisions + stream, codex's commands, grok's tool calls", () => {
  const api = coverageOfApi([
    { type: "tool_call", name: "read_file", args: { path: "pantheon/src/x.mjs" }, outcome: "ok" },
    { type: "tool_call", name: "read_file", args: { path: ".review-tests/mine.test.mjs" }, outcome: "ok" },
    { type: "tool_call", name: "read_file", args: { path: "missing.mjs" }, outcome: "refused", result_text: "refused: no such path: missing.mjs" },
    { type: "tool_call", name: "read_file", args: { path: "docs/reviews/r/findings-4-openai.md" }, outcome: "refused", result_text: "refused: this path is withheld by the runner" },
    { type: "tool_call", name: "run_tests", args: { files: ["a.test.mjs"] }, outcome: "ok", exit_code: 1 },
    { type: "tool_call", name: "run_suite", args: { suite: "all" }, outcome: "ok", exit_code: 125 }], { tests_allowed: true });
  assert.deepEqual([api.source_reads, api.denied_reads, api.tests_run, api.files_read_sample], [1, 1, 1, ["pantheon/src/x.mjs"]], "a failing test RAN; a jail refusal (125) did not; a missing path is not a denial");
  const wt = "/w";
  const agy = coverageOfAgy({ jail_decisions: [
    { tool: "view_file", args: { AbsolutePath: "/w/pantheon/src/a.mjs" }, decision: "auto_approve" }, { tool: "list_dir", args: { DirectoryPath: "/w" }, decision: "auto_approve" },
    { tool: "view_file", args: { AbsolutePath: "/etc/passwd" }, decision: "deny", reason: "outside the worktree" },
    { tool: "run_command", args: { CommandLine: "/c/pantheon-test a.test.mjs" }, decision: "auto_approve" }, { tool: "run_command", args: { CommandLine: "rm -rf /" }, decision: "deny" }],
    tool_steps: [{ tool_name: "run_command", state: "DONE" }, { tool_name: "run_command", state: "ERROR" }], tool_drift: { ok: true, unhooked: [] } }, { worktree: wt, tests_allowed: true });
  assert.deepEqual([agy.source_reads, agy.denied_reads, agy.tests_run, agy.files_read_sample], [1, 1, 1, ["pantheon/src/a.mjs"]]);
  const codex = coverageOfCodex({ commands: [{ command: "/bin/bash -lc \"sed -n '1,40p' pantheon/src/a.mjs\"", exit_code: 0 }, { command: "cat /root/.codex/auth.json", exit_code: 1, denied: true },
    { command: "node --test a.test.mjs", exit_code: 0 }] }, { worktree: wt, tests_allowed: true, tests_refused: "codex runs none" });
  assert.deepEqual([codex.source_reads, codex.denied_reads, codex.tests_run, codex.tests_refused], [1, 1, 0, "codex runs none"], "a node command codex tried is not a test run: codex runs none");
  const grok = coverageOfGrok({ tool_calls: [{ name: "read_file", kind: "read", path: "/w/hello.txt", status: "completed" }, { name: "read_file", kind: "read", path: "/w/x", status: "failed", message: "User cancelled the execution for tool `read_file`" },
    { name: "run_terminal_command", command: "/c/pantheon-test a.test.mjs", status: "completed" }, { name: "run_terminal_command", command: "node --test a.test.mjs", status: "completed" }] },
  { worktree: wt, control_dir: "/c", tests_allowed: true });
  assert.deepEqual([grok.source_reads, grok.denied_reads, grok.tests_run], [1, 1, 1], "only a launcher command is a test run");
  const merged = mergeCoverage({ ...api }, { ...agy });
  assert.deepEqual([merged.source_reads, merged.denied_reads, merged.tests_run, merged.cumulative_runs], [2, 2, 2, 2]);
});

const box = await sandboxAvailable("bwrap");
test("L-404 (API runner): run_tests runs the code under review in the verify jail -- no provider key (env or the runner's /proc environ), no home file, no network (real bwrap, synthetic key)", { skip: box.ok ? false : `bwrap unavailable: ${box.why}` }, async t => {
  const SYN = "sk-l404-synthetic-runner-key-0000000000";
  const root = mkdtempSync(join(tmpdir(), "rr-l404-")), home = mkdtempSync(join(process.env.HOME ?? tmpdir(), ".rr-l404-home-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ token: SYN }));
  const srv = createServer(s => s.end("REACHED")); await new Promise(r => srv.listen(0, "127.0.0.1", r)); t.after(() => srv.close());
  const port = srv.address().port, hash = createHash("sha256").update(SYN).digest("hex");
  mkdirSync(join(root, "pantheon", "tests"), { recursive: true });
  // The code under review: it looks for the runner's key everywhere it could be, and reports.
  writeFileSync(join(root, "pantheon", "tests", "probe.test.mjs"), `import test from "node:test";
import fs from "node:fs"; import net from "node:net"; import { createHash } from "node:crypto";
const h = v => createHash("sha256").update(v).digest("hex"), HASH = ${JSON.stringify(hash)};
test("probe", async () => {
  const found = [];
  for (const v of Object.values(process.env)) if (h(String(v)) === HASH) found.push("env");
  for (const p of fs.readdirSync("/proc").filter(x => /^\\d+$/.test(x))) { try { for (const kv of fs.readFileSync("/proc/" + p + "/environ", "utf8").split("\\0")) if (h(kv.slice(kv.indexOf("=") + 1)) === HASH) found.push("proc:" + p); } catch {} }
  let home = "unreadable"; try { home = fs.readFileSync(${JSON.stringify(join(home, ".codex", "auth.json"))}, "utf8").includes("sk-l404") ? "read" : "other"; } catch (e) { home = e.code; }
  const network = await new Promise(r => { const s = net.connect(${port}, "127.0.0.1"); s.on("data", d => { r(String(d)); s.destroy(); }); s.on("error", e => r(e.code)); setTimeout(() => { s.destroy(); r("timeout"); }, 3000); });
  console.log("PROBE " + JSON.stringify({ found, home, network, pid: process.pid }));
});
`);
  // The RUNNER: a separate node process whose INITIAL environment holds the synthetic key (as the real runner's does),
  // driving the real tools.mjs run_tests.
  const runner = `import { createToolbox, permissionsFor } from ${JSON.stringify(TOOLS)};
const box = createToolbox({ root: ${JSON.stringify(root)}, permissions: permissionsFor("Local deterministic fixtures"), env: { PATH: process.env.PATH, HOME: ${JSON.stringify(home)}, TMPDIR: ${JSON.stringify(root)}, LANG: "C.UTF-8" }, timeoutMs: 60000 });
const r = await box.call("run_tests", { files: ["pantheon/tests/probe.test.mjs"] });
process.stdout.write(JSON.stringify(r));`;
  const run = await spawnPromise(process.execPath, ["--input-type=module", "-e", runner], { env: { PATH: process.env.PATH, HOME: home, OPENAI_API_KEY: SYN }, timeout: 90_000 });
  assert.equal(run.status, 0, run.stderr);
  const r = JSON.parse(run.stdout);
  const probe = JSON.parse(/PROBE (\{.*\})/.exec(r.text)?.[1] ?? "null");
  assert.ok(probe, r.text);
  // At 08ee51a: {"found":["proc:<runner pid>"],"home":"read","network":"REACHED"}.
  assert.deepEqual(probe.found, [], "the runner's key is reachable from the code under review");
  assert.equal(probe.home, "ENOENT", "the owner's home (a CLI's login) is visible to the code under review");
  assert.notEqual(probe.network, "REACHED", "the code under review reached the host's loopback");
  assert.equal(r.ran, true, r.text);
  assert.ok(!r.text.includes(SYN));
});
