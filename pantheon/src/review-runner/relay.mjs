// THE TEST RELAY: tests for a reviewer whose own sandbox cannot start the verify jail (the codex transport: L-404,
// self-audit round 3, assignment 4 (sealed fe2a612)). The owner's direction (2026-11-21): "Keep the review
// subscription-only. Let Codex select an authorized test, have the coordinator execute it in the existing verification
// jail at #84's pinned commit, and return the result to Codex for judgment. Record who requested the test, which runner
// executed it, and what Codex concluded."
//
// THE LOOP (subscription.mjs runs it around the reviewer's turns):
//   1. The harness lists the review's own verify launchers (cli-common.mjs launcherCommands: `<control>/pantheon-test
//      <files>`, `<control>/pantheon-suite-<name>`) as commands the reviewer may REQUEST, not run. A reply that wants
//      tests ends with `## Test requests`, one `- R<n>: \`<command>\`` per line (parseTestRequests).
//   2. The runner -- outside the reviewer's sandbox, never as its child -- checks each request with the same decision
//      the agy jail hook applies to its own run_command (jail-hook.mjs decideReviewCommand: a listed launcher, allowed
//      test files that exist in the review copy, inside it, regular files), and runs each allowed one through that
//      launcher: the verify jail (src/agy/verify-jail.mjs: no network, no credentials, its own PID namespace) on the
//      review copy of the commit, which holds the commit's files and the reviewer's own .review-tests/.
//   3. Each result -- exit code, the end of its output and its sha256 -- goes back to the reviewer in its own thread
//      (resultsMessage), and the reviewer judges it: requests more, or gives its findings, with
//      `## Relayed test conclusions`, one `- R<n>: <conclusion>` per relayed test that ran (parseConclusions).
//   4. Bounded: at most MAX_RELAY_ROUNDS rounds of requests and MAX_RELAY_TESTS relayed tests per run, within the run's
//      wall clock (each test gets what remains of it).
// THE RECORD (relayRecord; the transcript's `test_relay`): per request, who requested it (the transport, lab, the
// model asked for -- no CLI names the one that served -- its thread and turn), the decision and its reason, which
// runner executed it (run-review.mjs, the launcher, the verify jail, the commit), its result, and what the reviewer
// concluded from it, verbatim. A request refused, or not run for a limit, is recorded with why.
// COVERAGE (coverage.mjs coverageOfCodex): a relayed test that ran in the verify jail is a test run; one the jail
// refused to start (VERIFY_JAIL_REFUSED), or killed at the wall clock, is not. A relayed test that ran and that the
// reviewer did not conclude on makes the run incomplete (coverageGate).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { decideReviewCommand } from "../agy/jail-hook.mjs";
import { VERIFY_JAIL_REFUSED } from "../agy/verify-jail.mjs";

export const RELAY_SCHEMA = "ophanim.review-test-relay/v1";
export const MAX_RELAY_ROUNDS = 3;
export const MAX_RELAY_TESTS = 12;
/** How much of a relayed test's output (its end) goes back to the reviewer and into the transcript. */
export const RELAY_OUTPUT_TAIL = 6000;
export const REQUESTS_HEADING = "Test requests";
export const CONCLUSIONS_HEADING = "Relayed test conclusions";
export const EXECUTED_BY = "pantheon/scripts/run-review.mjs (the runner process, outside the reviewer's sandbox)";
export const JAIL = "the verify jail (pantheon/src/agy/verify-jail.mjs): no network, no credentials, its own PID namespace, the review copy";

const sha256 = s => createHash("sha256").update(s).digest("hex");
const tailOf = (s, n) => (s.length > n ? s.slice(-n) : s);

/** The harness lines (its {{ALLOWED_COMMANDS}}) for a relayed review: the rule, then the launcher lines it may request. */
export function relayLines({ lines, commit, maxRounds = MAX_RELAY_ROUNDS, maxTests = MAX_RELAY_TESTS }) {
  return [
    "- none that you run yourself: the code under review runs only in the runner's verify jail, and your own sandbox cannot start it. The RUNNER runs a test for you instead: a relayed test.",
    `- To request tests, end a reply with a section headed exactly \`## ${REQUESTS_HEADING}\`, one request per line as \`- R1: \\\`<command>\\\`\`, numbering your requests R1, R2, ... across the whole review. Each \`<command>\` is exactly one of the authorized commands below. Do not run them yourself: they are outside your sandbox.`,
    `- The runner checks each request against this review's test policy and runs each allowed one in the verify jail (no network, no credentials, its own process namespace) on this copy of commit \`${commit}\`, including any test you wrote under \`.review-tests/\`. It then replies with each request's exit code and the end of its output, or why it refused the request. Judge the results: request more, or give your findings document.`,
    `- At most ${maxRounds} rounds of requests and ${maxTests} relayed tests in all, within the wall clock below.`,
    `- Your findings document must include a section headed exactly \`## ${CONCLUSIONS_HEADING}\`, one line per relayed test that ran, as \`- R1: <what its result establishes for your findings>\`. In your "Tests run" section, name relayed tests by their R number.`,
    "- Authorized commands to request:",
    ...lines.map(l => `  ${l}`),
  ];
}

/** The section's lines under `## <heading>` (any level 2-3), up to the next heading of that level or higher. */
function sectionLines(text, heading) {
  const lines = String(text ?? "").split("\n");
  const re = new RegExp(`^(#{2,3})\\s+${heading.replace(/ /g, "\\s+")}\\s*:?\\s*$`, "i");
  const at = lines.findIndex(l => re.test(l.trim()));
  if (at < 0) return null;
  const level = re.exec(lines[at].trim())[1].length;
  const end = lines.findIndex((l, k) => k > at && /^#{1,6}\s/.test(l.trim()) && /^(#+)/.exec(l.trim())[1].length <= level);
  return lines.slice(at + 1, end < 0 ? undefined : end);
}

/** `## Test requests`: [{id, command}] in order (a repeated id keeps its first), and the lines that are not requests. */
export function parseTestRequests(text) {
  const lines = sectionLines(text, REQUESTS_HEADING);
  if (!lines) return { requests: [], malformed: [] };
  const requests = [], malformed = [], seen = new Set();
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = /^\s*[-*]\s*(R\d{1,3})\s*[:.)]\s*`([^`\n]+)`\s*$/.exec(l);
    if (!m) { malformed.push(l.trim().slice(0, 300)); continue; }
    if (seen.has(m[1])) { malformed.push(`${l.trim().slice(0, 300)} (repeats ${m[1]})`); continue; }
    seen.add(m[1]);
    requests.push({ id: m[1], command: m[2].trim() });
  }
  return { requests, malformed };
}

/**
 * `## Relayed test conclusions`: Map id -> the reviewer's conclusion, verbatim. An entry continues onto INDENTED lines
 * only (a markdown list item's continuation); a blank line or unindented text ends it, so a line after the list (the
 * model's name, say) is never read as part of a conclusion.
 */
export function parseConclusions(text) {
  const lines = sectionLines(text, CONCLUSIONS_HEADING), out = new Map();
  if (!lines) return out;
  let cur = null;
  for (const l of lines) {
    const m = /^\s*[-*]\s*(R\d{1,3})\s*[:.)]\s*(.*)$/.exec(l);
    if (m) { cur = m[1]; if (!out.has(cur)) out.set(cur, m[2].trim()); else cur = null; continue; }
    if (cur && l.trim() && /^\s/.test(l)) out.set(cur, `${out.get(cur)}\n${l.trim()}`.trim());
    else cur = null;
  }
  for (const [k, v] of out) if (!v) out.delete(k);
  return out;
}

/** Run one launcher in its own process group; kill the group at `timeoutMs`. */
export function runLauncher({ argv, env, timeoutMs, cwd }) {
  return new Promise(res => {
    const started = Date.now();
    let c;
    try { c = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { res({ exit_code: null, signal: null, killed_for: null, spawn_error: e.message, duration_ms: 0, output: "" }); return; }
    const chunks = [];
    let killed_for = null, settled = false;
    const kill = sig => { try { process.kill(-c.pid, sig); } catch { try { c.kill(sig); } catch { /* gone */ } } };
    const t = setTimeout(() => { killed_for = "timeout"; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 5000).unref(); }, Math.max(1, timeoutMs));
    c.stdout.on("data", d => chunks.push(d)); c.stderr.on("data", d => chunks.push(d));
    const done = (code, signal, spawn_error = null) => {
      if (settled) return;
      settled = true; clearTimeout(t);
      res({ exit_code: code, signal: signal ?? null, killed_for, spawn_error, duration_ms: Date.now() - started, output: Buffer.concat(chunks).toString("utf8") });
    };
    c.on("error", e => done(null, null, e.message));
    c.on("close", (code, signal) => done(code, signal));
  });
}

/** The argv a decided request runs: a suite launcher alone, or the test launcher and its files. */
export function launcherArgv(rcp, command) {
  const suite = Object.values(rcp.suites ?? {}).find(c => c === command);
  if (suite) return [suite];
  return [rcp.launcher, ...command.slice(rcp.launcher.length + 1).split(" ")];
}

/** Did a relayed test run in the verify jail? (Started, not refused by the jail, not killed at the wall clock.) */
export const ranInJail = r => r.decision === "run" && Number.isInteger(r.result?.exit_code) && r.result.exit_code !== VERIFY_JAIL_REFUSED && !r.result.killed_for;

/**
 * One round: decide and run each request, within the budget and the deadline. `policy` is {worktree, control_dir}
 * (real paths), `rcp` the review's run_command_policy. Returns the round's records.
 */
export async function relayRound({ requests, policy, rcp, commit, budget, deadline, now = () => Date.now(), env, run = runLauncher, requestedBy, turn }) {
  const out = [];
  for (const q of requests) {
    const rec = { id: q.id, command: q.command, requested_by: { ...requestedBy, turn }, commit };
    if (budget.used.has(q.id)) { out.push({ ...rec, decision: "not run", why: `${q.id} was already requested; number each request anew` }); continue; }
    budget.used.add(q.id);
    if (budget.tests <= 0) { out.push({ ...rec, decision: "not run", why: `this review's limit of ${MAX_RELAY_TESTS} relayed tests is reached` }); continue; }
    const left = deadline - now();
    if (left <= 1000) { out.push({ ...rec, decision: "not run", why: "the run's wall clock is reached" }); continue; }
    const d = decideReviewCommand(policy, rcp, { CommandLine: q.command });
    if (d.decision !== "auto_approve") { out.push({ ...rec, decision: "refused", why: d.reason }); continue; }
    budget.tests--;
    const argv = launcherArgv(rcp, q.command);
    const r = await run({ argv, env, timeoutMs: left, cwd: policy.worktree });
    const output = String(r.output ?? "");
    out.push({ ...rec, decision: "run", why: d.reason,
      executed_by: { runner: EXECUTED_BY, launcher: argv[0].split("/").pop(), jail: JAIL, commit },
      result: { exit_code: r.exit_code, signal: r.signal, killed_for: r.killed_for, spawn_error: r.spawn_error ?? null, duration_ms: r.duration_ms,
        jail_refused: r.exit_code === VERIFY_JAIL_REFUSED, output_tail: tailOf(output, RELAY_OUTPUT_TAIL), output_bytes: Buffer.byteLength(output), output_sha256: sha256(output) } });
  }
  return out;
}

/** The message that returns a round's results to the reviewer, in its own thread. */
export function resultsMessage({ records, malformed = [], commit, roundsLeft, testsLeft }) {
  const parts = [`# Results of your test requests\n\nThe runner ran these in the verify jail on the review copy of commit \`${commit}\` (no network, no credentials, its own process namespace).`];
  for (const r of records) {
    if (r.decision === "run") {
      const x = r.result;
      const how = x.killed_for ? `killed at the wall clock after ${x.duration_ms} ms` : x.jail_refused ? `the verify jail refused to start (exit ${x.exit_code}): no test ran` : x.spawn_error ? `the launcher did not start: ${x.spawn_error}` : `exit ${x.exit_code} after ${x.duration_ms} ms`;
      parts.push(`## ${r.id}: \`${r.command}\`\n\n${how}. The last ${Buffer.byteLength(x.output_tail)} of ${x.output_bytes} bytes of its output (sha256 ${x.output_sha256}):\n\n\`\`\`\n${x.output_tail.replace(/```/g, "'''")}\n\`\`\``);
    } else parts.push(`## ${r.id}: \`${r.command}\`\n\n${r.decision === "refused" ? "Refused" : "Not run"}: ${r.why}`);
  }
  if (malformed.length) parts.push(`## Lines under "${REQUESTS_HEADING}" that are not requests\n\n${malformed.map(l => `- ${l}`).join("\n")}\n\nA request is \`- R<n>: \\\`<command>\\\`\`, with the command exactly as listed.`);
  parts.push(roundsLeft > 0 && testsLeft > 0
    ? `Judge these results. You may request more tests the same way (at most ${roundsLeft} more round(s) and ${testsLeft} more test(s)), or give your findings document now, with its \`## ${CONCLUSIONS_HEADING}\` section.`
    : `No more relayed tests will run. Give your findings document now, with its \`## ${CONCLUSIONS_HEADING}\` section and no \`## ${REQUESTS_HEADING}\`.`);
  return parts.join("\n\n") + "\n";
}

/**
 * The loop around a reviewer's turns. `first` is the first turn's result ({status, final_text, record, usage});
 * `nextTurn(prompt, {wallS})` runs the next turn in the same thread and returns the same shape. Returns {final, turns,
 * relay}: the last turn's result, every turn after the first, and the relay record.
 */
export async function relayLoop({ first, nextTurn, policy, rcp, commit, deadline, now = () => Date.now(), env, run = runLauncher, requestedBy,
  maxRounds = MAX_RELAY_ROUNDS }) {
  const budget = { tests: MAX_RELAY_TESTS, used: new Set() };
  const records = [], rounds = [], turns = [];
  let cur = first, turn = 1;
  for (let round = 1; round <= maxRounds && cur.status === "complete"; round++) {
    const { requests, malformed } = parseTestRequests(cur.final_text);
    if (!requests.length && !malformed.length) break;
    const recs = await relayRound({ requests, policy, rcp, commit, budget, deadline, now, env, run, requestedBy, turn });
    records.push(...recs);
    const roundsLeft = maxRounds - round, testsLeft = budget.tests;
    const msg = resultsMessage({ records: recs, malformed, commit, roundsLeft, testsLeft });
    rounds.push({ round, turn, requested: requests.length, malformed: malformed.length, ran: recs.filter(r => r.decision === "run").length, results_message_sha256: sha256(msg) });
    const wallS = Math.floor((deadline - now()) / 1000);
    if (wallS < 5) { rounds.at(-1).results_not_returned = "the run's wall clock is reached"; break; }
    cur = await nextTurn(msg, { wallS });
    turns.push(cur);
    turn++;
  }
  const conclusions = parseConclusions(cur.status === "complete" ? cur.final_text : "");
  for (const r of records) if (r.decision === "run") r.reviewer_conclusion = conclusions.get(r.id) ?? null;
  const ran = records.filter(ranInJail);
  const leftOver = cur.status === "complete" ? parseTestRequests(cur.final_text).requests : [];
  return { final: cur, turns, relay: {
    schema: RELAY_SCHEMA, max_rounds: maxRounds, max_tests: MAX_RELAY_TESTS, rounds, requests: records,
    counts: { requested: records.length, run: records.filter(r => r.decision === "run").length, ran_in_jail: ran.length, refused: records.filter(r => r.decision === "refused").length,
      not_run: records.filter(r => r.decision === "not run").length, concluded: ran.filter(r => r.reviewer_conclusion).length, unconcluded: ran.filter(r => !r.reviewer_conclusion).map(r => r.id) },
    ...(leftOver.length ? { requests_in_final_message_not_run: leftOver.map(q => q.id) } : {}),
  } };
}
