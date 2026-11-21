// THE TEST RELAY (pantheon/src/review-runner/relay.mjs; owner direction 2026-11-21): codex requests an authorized test,
// the runner runs it in its verify jail on the review copy of the pinned commit, and the result goes back to codex to
// judge; the transcript records who requested it, which runner executed it, and what codex concluded. The unit tests
// use a stand-in launcher; the run-review tests run a relayed test in the REAL verify jail (bwrap), with the scripted
// codex SDK (no model, no provider, no network).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, EXIT } from "../src/review-runner/index.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { VERIFY_JAIL_REFUSED } from "../src/agy/verify-jail.mjs";
import { CONCLUSIONS_HEADING, EXECUTED_BY, MAX_RELAY_ROUNDS, MAX_RELAY_TESTS, REQUESTS_HEADING, launcherArgv, parseConclusions, parseTestRequests, ranInJail, relayLoop,
  relayRound, resultsMessage } from "../src/review-runner/relay.mjs";
import { coverageGate, coverageOfCodex } from "../src/review-runner/coverage.mjs";
import { fixtureRepo, fakeFetch, capture, deps, mkdtemp, cleanup } from "./review-runner-helper.mjs";
import { fakeCodexSdk, fakeReviewClis } from "./fixtures/review-clis.mjs";

after(cleanup);
const have = await sandboxAvailable("bwrap");
const needBwrap = { skip: have.ok ? false : `bwrap unavailable: ${have.why}` };

// ---- the pieces ------------------------------------------------------------------------------------------------------

test("RELAY: requests are read from `## Test requests` by id, in order; a repeated id and a line that is not a request are kept apart", () => {
  const text = `# Draft\n\n## ${REQUESTS_HEADING}\n\n- R1: \`/c/pantheon-test a.test.mjs\`\n* R2. \`/c/pantheon-suite-proof\`\n- R1: \`/c/pantheon-test b.test.mjs\`\nplease run everything\n\n## Next\n- R9: \`/c/x\`\n`;
  assert.deepEqual(parseTestRequests(text), {
    requests: [{ id: "R1", command: "/c/pantheon-test a.test.mjs" }, { id: "R2", command: "/c/pantheon-suite-proof" }],
    malformed: ["- R1: `/c/pantheon-test b.test.mjs` (repeats R1)", "please run everything"] });
  assert.deepEqual(parseTestRequests("no section here\n- R1: `/c/pantheon-test a.test.mjs`\n"), { requests: [], malformed: [] }, "outside the section nothing is a request");
});

test("RELAY: conclusions are read from `## Relayed test conclusions`, verbatim, continuation lines kept", () => {
  const text = `## ${CONCLUSIONS_HEADING}\n- R1: it passes,\n  so question 1 holds\n- R2:\n- R3: fails at line 4\n\nModel: gpt-6-astra\n## Model\nx\n`;
  assert.deepEqual([...parseConclusions(text)], [["R1", "it passes,\nso question 1 holds"], ["R3", "fails at line 4"]],
    "an empty conclusion is no conclusion, and the unindented line after the list is not part of R3's");
  // The model's name written straight after the last conclusion, with no blank line between: not part of it.
  assert.deepEqual([...parseConclusions(`## ${CONCLUSIONS_HEADING}\n- R1: it passes\nModel: gpt-6-astra\n`)], [["R1", "it passes"]]);
});

test("RELAY: a suite launcher runs alone, the test launcher with its files", () => {
  const rcp = { launcher: "/c/pantheon-test", suites: { proof: "/c/pantheon-suite-proof" } };
  assert.deepEqual(launcherArgv(rcp, "/c/pantheon-suite-proof"), ["/c/pantheon-suite-proof"]);
  assert.deepEqual(launcherArgv(rcp, "/c/pantheon-test a.test.mjs .review-tests/b.test.mjs"), ["/c/pantheon-test", "a.test.mjs", ".review-tests/b.test.mjs"]);
});

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-")));
  const wt = join(root, "worktree"), control = join(root, "control");
  await mkdir(join(wt, "pantheon/tests"), { recursive: true }); await mkdir(join(wt, ".review-tests")); await mkdir(control);
  await writeFile(join(wt, "pantheon/tests/a.test.mjs"), "x\n"); await writeFile(join(wt, ".review-tests/mine.test.mjs"), "x\n"); await writeFile(join(wt, "notes.md"), "x\n");
  const rcp = { kind: "node-test", launcher: join(control, "pantheon-test"), files: null, allowed_files_glob: ["ophanim/**/*.test.mjs", "pantheon/tests/**/*.test.mjs", ".review-tests/**/*.test.mjs"],
    max_files: 50, suites: { proof: join(control, "pantheon-suite-proof") } };
  return { wt, control, rcp, policy: { worktree: wt, control_dir: control } };
}
const WHO = { transport: "codex-sdk", lab: "OpenAI", model: "gpt-6-astra", thread_id: "thread-1" };
const fakeRun = (results = {}) => { const runs = []; const run = async ({ argv, timeoutMs }) => { runs.push({ argv, timeoutMs }); return { exit_code: 0, signal: null, killed_for: null, duration_ms: 5, output: `ran ${argv.join(" ")}\n`, ...(results[argv.slice(1).join(" ") || argv[0]] ?? {}) }; }; run.runs = runs; return run; };

test("RELAY: each request is decided as the agy hook decides run_command; only an allowed one runs, through the review's launcher", async () => {
  const w = await workspace();
  const run = fakeRun();
  const reqs = [
    { id: "R1", command: `${w.rcp.launcher} pantheon/tests/a.test.mjs .review-tests/mine.test.mjs` },
    { id: "R2", command: `${w.rcp.launcher} notes.md` },
    { id: "R3", command: `${w.rcp.launcher} ../escape.test.mjs` },
    { id: "R4", command: "node --test pantheon/tests/a.test.mjs" },
    { id: "R5", command: `${w.rcp.launcher} pantheon/tests/missing.test.mjs` },
    { id: "R6", command: w.rcp.suites.proof },
  ];
  const recs = await relayRound({ requests: reqs, policy: w.policy, rcp: w.rcp, commit: "c".repeat(40), budget: { tests: MAX_RELAY_TESTS, used: new Set() }, deadline: Date.now() + 60_000, run, requestedBy: WHO, turn: 1 });
  assert.deepEqual(recs.map(r => [r.id, r.decision]), [["R1", "run"], ["R2", "refused"], ["R3", "refused"], ["R4", "refused"], ["R5", "refused"], ["R6", "run"]]);
  assert.match(recs[1].why, /notes\.md is not matched by the review's allowed test files/);
  assert.match(recs[2].why, /'\.\.' segments are refused/);
  assert.match(recs[3].why, /only the review's listed commands may run/);
  assert.match(recs[4].why, /does not exist/);
  assert.deepEqual(run.runs.map(r => r.argv), [[w.rcp.launcher, "pantheon/tests/a.test.mjs", ".review-tests/mine.test.mjs"], [w.rcp.suites.proof]], "only the two allowed requests ran, each through its launcher");
  assert.deepEqual(recs[0].requested_by, { ...WHO, turn: 1 });
  assert.deepEqual(recs[0].executed_by, { runner: EXECUTED_BY, launcher: "pantheon-test", jail: recs[0].executed_by.jail, commit: "c".repeat(40) });
  assert.match(recs[0].executed_by.jail, /verify jail .*no network, no credentials/);
  assert.equal(recs[0].result.exit_code, 0); assert.match(recs[0].result.output_sha256, /^[0-9a-f]{64}$/);
  assert.equal(recs[1].executed_by, undefined, "a refused request names no runner: nothing ran");
});

test("RELAY: the limits -- a repeated id, the test budget and the wall clock -- each stop a request from running, with why", async () => {
  const w = await workspace();
  const run = fakeRun();
  const cmd = `${w.rcp.launcher} pantheon/tests/a.test.mjs`;
  const budget = { tests: 1, used: new Set(["R0"]) };
  const recs = await relayRound({ requests: [{ id: "R0", command: cmd }, { id: "R1", command: cmd }, { id: "R2", command: cmd }], policy: w.policy, rcp: w.rcp, commit: "c", budget, deadline: Date.now() + 60_000, run, requestedBy: WHO, turn: 2 });
  assert.deepEqual(recs.map(r => [r.id, r.decision]), [["R0", "not run"], ["R1", "run"], ["R2", "not run"]]);
  assert.match(recs[0].why, /R0 was already requested/); assert.match(recs[2].why, new RegExp(`limit of ${MAX_RELAY_TESTS} relayed tests is reached`));
  const late = await relayRound({ requests: [{ id: "R3", command: cmd }], policy: w.policy, rcp: w.rcp, commit: "c", budget: { tests: 5, used: new Set() }, deadline: Date.now() + 500, run, requestedBy: WHO, turn: 2 });
  assert.deepEqual([late[0].decision, late[0].why], ["not run", "the run's wall clock is reached"]);
  assert.equal(run.runs.length, 1);
});

test("RELAY: the results go back verbatim -- exit code, the end of the output and its sha256 -- and a jail refusal is not a test run", async () => {
  const w = await workspace();
  const cmd = `${w.rcp.launcher} pantheon/tests/a.test.mjs`;
  const run = fakeRun({ "pantheon/tests/a.test.mjs": { exit_code: 1, output: "not ok 1 - FAKE-FAILURE-MARKER\n" } });
  const [r] = await relayRound({ requests: [{ id: "R1", command: cmd }], policy: w.policy, rcp: w.rcp, commit: "abc", budget: { tests: 3, used: new Set() }, deadline: Date.now() + 60_000, run, requestedBy: WHO, turn: 1 });
  const msg = resultsMessage({ records: [r], malformed: ["run all"], commit: "abc", roundsLeft: 1, testsLeft: 2 });
  assert.match(msg, /## R1: `.*pantheon-test pantheon\/tests\/a\.test\.mjs`\n\nexit 1 after 5 ms\. The last 31 of 31 bytes of its output \(sha256 [0-9a-f]{64}\):\n\n```\nnot ok 1 - FAKE-FAILURE-MARKER\n\n```/);
  assert.match(msg, /- run all\n/); assert.match(msg, /at most 1 more round\(s\) and 2 more test\(s\)/);
  assert.match(resultsMessage({ records: [r], commit: "abc", roundsLeft: 0, testsLeft: 2 }), /No more relayed tests will run\. Give your findings document now/);
  assert.ok(ranInJail(r), "a failing test RAN: its result is evidence");
  assert.ok(!ranInJail({ ...r, result: { ...r.result, exit_code: VERIFY_JAIL_REFUSED } }), "the jail refusing to start is no test run");
  assert.ok(!ranInJail({ ...r, result: { ...r.result, killed_for: "timeout" } }), "a test killed at the wall clock did not finish");
});

test("RELAY: the loop returns results in the reviewer's own thread, records its conclusion per test, and a test it did not judge fails the gate", async () => {
  const w = await workspace();
  const cmd = `${w.rcp.launcher} pantheon/tests/a.test.mjs`;
  const prompts = [];
  const turns = [
    { status: "complete", final_text: `## ${REQUESTS_HEADING}\n- R1: \`${cmd}\`\n- R2: \`${w.rcp.suites.proof}\`\n`, record: {} },
    { status: "complete", final_text: `# Findings\n## ${CONCLUSIONS_HEADING}\n- R1: a passes, so question 1 holds\n`, record: {} },
  ];
  const out = await relayLoop({ first: turns[0], nextTurn: async m => { prompts.push(m); return turns[1]; }, policy: w.policy, rcp: w.rcp, commit: "abc", deadline: Date.now() + 60_000, run: fakeRun(), requestedBy: WHO });
  assert.equal(prompts.length, 1); assert.match(prompts[0], /^# Results of your test requests/);
  assert.equal(out.final, turns[1]);
  assert.deepEqual(out.relay.requests.map(r => [r.id, r.decision, r.reviewer_conclusion]), [["R1", "run", "a passes, so question 1 holds"], ["R2", "run", null]]);
  assert.deepEqual(out.relay.counts, { requested: 2, run: 2, ran_in_jail: 2, refused: 0, not_run: 0, concluded: 1, unconcluded: ["R2"] });
  const cov = coverageOfCodex({ commands: [{ command: "cat a", exit_code: 0 }] }, { worktree: w.wt, tests_allowed: true, relay: out.relay });
  assert.deepEqual([cov.tests_run, cov.relay.unconcluded], [2, ["R2"]]);
  assert.deepEqual(coverageGate(cov).reasons, ["relayed test(s) R2 ran and the reviewer gave no conclusion on them (no line under \"Relayed test conclusions\")"]);
  const none = coverageOfCodex({ commands: [{ command: "cat a", exit_code: 0 }] }, { worktree: w.wt, tests_allowed: true, relay: { requests: [], counts: { requested: 0, refused: 0 } } });
  assert.deepEqual(coverageGate(none).reasons, ["no test command ran although the testing limit allows tests"], "no request: no test ran, as for any reviewer");
});

test("RELAY: at most MAX_RELAY_ROUNDS rounds; requests in the final reply after them are recorded as not run", async () => {
  const w = await workspace();
  const cmd = id => `- ${id}: \`${w.rcp.launcher} pantheon/tests/a.test.mjs\``;
  let k = 0;
  const reply = () => ({ status: "complete", final_text: `## ${REQUESTS_HEADING}\n${cmd(`R${++k}`)}\n`, record: {} });
  const prompts = [];
  const out = await relayLoop({ first: reply(), nextTurn: async m => { prompts.push(m); return reply(); }, policy: w.policy, rcp: w.rcp, commit: "abc", deadline: Date.now() + 60_000, run: fakeRun(), requestedBy: WHO });
  assert.equal(out.relay.rounds.length, MAX_RELAY_ROUNDS);
  assert.equal(prompts.length, MAX_RELAY_ROUNDS);
  assert.match(prompts.at(-1), /No more relayed tests will run/);
  assert.deepEqual(out.relay.requests_in_final_message_not_run, [`R${MAX_RELAY_ROUNDS + 1}`]);
  const failed = await relayLoop({ first: { status: "incomplete", final_text: null, record: {} }, nextTurn: async () => assert.fail("no turn after an incomplete one"), policy: w.policy, rcp: w.rcp, commit: "abc", deadline: Date.now() + 60_000, run: fakeRun(), requestedBy: WHO });
  assert.deepEqual([failed.relay.rounds, failed.relay.requests], [[], []]);
});

// ---- through run-review, with the real verify jail ----------------------------------------------------------------

async function setup() {
  const repo = await fixtureRepo();
  const base = await mkdtemp(join(tmpdir(), "rr-relay-"));
  const bin = join(base, "bin"), home = join(base, "home"), outDir = join(base, "out");
  await mkdir(bin); await mkdir(home); await mkdir(outDir);
  return { repo, base, bin, home, outDir, log: join(base, "cli.log"), clis: fakeReviewClis(bin) };
}
const launcherOf = input => { const m = /`(\/\S+\/control\/pantheon-test) <files>`/.exec(input); assert.ok(m, "the harness lists the review's test launcher to request"); return m[1]; };

async function runRelayed(f, replies, env = {}) {
  const out = capture();
  const d = await deps({ root: f.repo.root, out, fetch: fakeFetch([]), env: { PATH: `${f.bin}:${process.env.PATH}`, HOME: f.home, FAKE_CLI_LOG: f.log, ...env } });
  d.CodexSDK = fakeCodexSdk({ replies });
  const code = await main(["--via", "subscription", "--assignment", "2", "--commit", f.repo.commit, "--out", f.outDir, "--codex-cli", f.clis.codex, "--max-wall-s", "120"], d);
  const read = name => readFile(join(f.outDir, name), "utf8");
  return { code, out, d, read, sdk: d.CodexSDK.calls, files: await readdir(f.outDir) };
}

test("RELAY through run-review: codex requests a test, the runner runs it in the REAL verify jail at the commit, codex judges it, and every step is recorded", needBwrap, async () => {
  const f = await setup();
  const inputs = [];
  const r = await runRelayed(f, [
    input => { inputs.push(input); const L = launcherOf(input); return `# Draft\n\n## ${REQUESTS_HEADING}\n- R1: \`${L} pantheon/tests/other.test.mjs\`\n- R2: \`${L} hello.txt\`\n- R3: \`node --test pantheon/tests/other.test.mjs\`\n`; },
    input => { inputs.push(input); return `# Findings\n\n1. holds (pantheon/tests/other.test.mjs:1)\n\n## Tests run\n- R1: exit 0\n\n## Unresolved questions\nnone\n\n## ${CONCLUSIONS_HEADING}\n- R1: other.test.mjs passes in the verify jail, so question 1 holds\n\nModel: gpt-6-astra\n`; },
  ]);
  assert.equal(r.code, EXIT.complete, r.out.err);
  const runs = r.sdk.filter(c => c.kind === "run");
  assert.equal(runs.length, 2, "two turns");
  assert.equal(runs[1].resume_id, runs[0].resume_id ?? JSON.parse(await r.read("findings-2-openai.transcript.json")).cli.thread_id, "the second turn resumes codex's own thread");
  // Codex is told how to request a test and how to report on it (relay.mjs relayLines), not only shown a launcher.
  assert.match(inputs[0], /- none that you run yourself: .*The RUNNER runs a test for you instead: a relayed test\./);
  assert.match(inputs[0], new RegExp(`end a reply with a section headed exactly \`## ${REQUESTS_HEADING}\``));
  assert.match(inputs[0], new RegExp(`a section headed exactly \`## ${CONCLUSIONS_HEADING}\``));
  assert.match(inputs[1], /^# Results of your test requests/);
  assert.match(inputs[1], new RegExp(`review copy of commit \`${f.repo.commit}\``));
  assert.match(inputs[1], /## R1: `.*pantheon-test pantheon\/tests\/other\.test\.mjs`\n\nexit 0 after \d+ ms\./, "R1 ran, and its exit code went back to codex");
  assert.match(inputs[1], /## R2: `.*pantheon-test hello\.txt`\n\nRefused: hello\.txt is not matched by the review's allowed test files/);
  assert.match(inputs[1], /## R3: `node --test pantheon\/tests\/other\.test\.mjs`\n\nRefused: only the review's listed commands may run/);
  const t = JSON.parse(await r.read("findings-2-openai.transcript.json"));
  const [r1, r2, r3] = t.test_relay.requests;
  assert.deepEqual([r1.id, r1.decision, r1.requested_by.transport, r1.requested_by.lab, r1.requested_by.model, r1.requested_by.turn, r1.requested_by.thread_id],
    ["R1", "run", "codex-sdk", "OpenAI", "gpt-6-astra", 1, t.cli.thread_id], "who requested it: codex, its thread and turn");
  assert.deepEqual([r1.executed_by.runner, r1.executed_by.launcher, r1.executed_by.commit], [EXECUTED_BY, "pantheon-test", f.repo.commit], "which runner executed it, through which launcher, at which commit");
  assert.equal(r1.result.exit_code, 0); assert.equal(r1.result.jail_refused, false);
  assert.match(r1.result.output_tail, /pass 1/, "the jail ran node --test on the copy's file");
  assert.equal(r1.reviewer_conclusion, "other.test.mjs passes in the verify jail, so question 1 holds", "what codex concluded, verbatim");
  assert.deepEqual([r2.decision, r3.decision, r2.executed_by, r3.executed_by], ["refused", "refused", undefined, undefined]);
  assert.deepEqual([t.coverage.tests_run, t.coverage.tests_refused, t.coverage_gate.ok, t.status], [1, null, true, "complete"]);
  assert.deepEqual(t.cli.turns.map(x => [x.turn, x.status]), [[1, "complete"], [2, "complete"]]);
  const md = await r.read("findings-2-openai.md");
  assert.match(md, /- test_relay: 3 requested by the reviewer, 1 ran in the runner's verify jail, 2 refused, 0 not run; conclusions on 1 of 1; per request in the transcript's test_relay\n/);
  assert.match(md.split("<!-- reviewer's final message, verbatim, follows -->")[1], /## Relayed test conclusions\n- R1: other\.test\.mjs passes/, "the findings are codex's final message");
});

test("RELAY through run-review: a failing relayed test goes back as a failure, and a test codex did not conclude on leaves the review incomplete", needBwrap, async () => {
  const f = await setup();
  const inputs = [];
  const r = await runRelayed(f, [
    input => { const L = launcherOf(input); return `## ${REQUESTS_HEADING}\n- R1: \`${L} .review-tests/mine.test.mjs\`\n`; },
    input => { inputs.push(input); return "# Findings\n\n## Tests run\n- R1\n\n## Unresolved questions\nnone\n\nModel: gpt-6-astra\n"; },
  ], { FAKE_CLI_WRITE: ".review-tests/mine.test.mjs" });
  assert.equal(r.code, EXIT.incomplete, r.out.err);
  assert.match(inputs[0], /## R1: `.*pantheon-test \.review-tests\/mine\.test\.mjs`\n\nexit 1 after \d+ ms\./, "the reviewer's own test, run in the jail, failed, and codex was told so");
  const t = JSON.parse(await r.read("findings-2-openai.transcript.json"));
  assert.equal(t.test_relay.requests[0].result.exit_code, 1);
  assert.equal(t.test_relay.requests[0].reviewer_conclusion, null);
  assert.deepEqual([t.coverage.tests_run, t.coverage_gate.ok], [1, false]);
  assert.match(t.stop_reason, /coverage gate: relayed test\(s\) R1 ran and the reviewer gave no conclusion on them/);
});
