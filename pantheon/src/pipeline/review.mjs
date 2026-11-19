// STAGE 5: REVIEW, and the rejection/escalation ladder.
//
// The reviewer is a read-only specialist PINNED to the exact Stage 2 dispatcher model of the unit (see the OWNER
// GOVERNANCE DECISION in dispatch.mjs: that model is a non-authoring arbiter, so it may judge the work it wrote the
// rubric for). What it judges is gathered by the CONTROLLER, FROM DISK:
//   - the unit's diff (git, base_commit..checkpoint);
//   - the ground truth: the unit's deterministic verify_cmd, run by the controller in the worktree, inside the verify
//     jail (src/agy/verify-jail.mjs), with a timeout and an output cap (exit code, captured output, digest);
//   - the frozen rubric, RE-HASHED and compared with the rubric_hash frozen at dispatch.
//
// Inputs: {unit, worktree, base_commit, checkpoint, seat, turn, dispatch: {rubric, rubric_hash}, limits}.
// Outputs: a review record with status
//   approved          verdict approve, every criterion met, and verify_cmd exited 0;
//   request_changes   the reviewer's findings go to the implementer;
//   approve_refused   the reviewer approved while verify_cmd FAILED: ground truth wins, the approval is void;
//   not_admitted      no answer was admitted (no served model / not the pinned model / schema), after one retry;
//   rubric_mismatch   the rubric handed to review does not hash to the frozen rubric_hash: refused, no model asked;
//   diff_too_large    the diff exceeds the bound: nobody is asked to approve a diff they were not shown whole.
//
// THE LADDER (escalate(), pure). On a rejection the IMPLEMENTER is raised first, one rung along its ladder (thinking
// level, then tier). Only when the same reviewer has rejected N consecutive revisions is the REVIEWER raised, one
// rung along ITS ladder — which never leaves the dispatcher's vendor (OpenAI: luna -> sol -> astra), so no other
// lab, and in particular not the lab that wrote the plan, ever reviews work derived from its own plan. Revisions
// per unit are bounded; when they run out the unit ends `blocked` with every finding kept.
//
// Must never: let a model's approval outrank a failing verify_cmd; review against a rubric that is not the frozen
// one; hand the reviewer a working directory; move the reviewer to another vendor; call any provider API itself
// (`reasoning` is passed through to the injected turn as an opaque `extra`).
import { CAPABILITIES, clone, isObject, judgingTurn, keysRefusal, sameSeat, seatRefusal, sha256, str } from "./util.mjs";
import { rubricHash } from "./dispatch.mjs";
import { isAbsolute } from "node:path";
import { exec, git } from "./git.mjs";
import { VERIFY_JAIL_MODULE, VERIFY_JAIL_REFUSED, VERIFY_JAIL_SCHEMA, verifyEnvOf } from "../agy/verify-jail.mjs";

export const REVIEW_KEYS = Object.freeze(["verdict", "criteria", "findings"]);
export const VERDICTS = Object.freeze(["approve", "request_changes"]);
export const REVIEW_SCHEMA = Object.freeze({
  $id: "pantheon.pipeline.review/v1",
  type: "object",
  additionalProperties: false,
  required: [...REVIEW_KEYS],
  properties: {
    verdict: { enum: [...VERDICTS] },
    criteria: { type: "array", items: { type: "object", additionalProperties: false, required: ["criterion", "met", "evidence"],
      properties: { criterion: { type: "string" }, met: { type: "boolean" }, evidence: { type: "string", minLength: 1 } } } },
    findings: { type: "array", items: { type: "string", minLength: 1 } },
  },
});

/**
 * Run the unit's verify_cmd in its worktree: the ground truth. Async, bounded in time and in captured output.
 * It is WORKER-CONTROLLED CODE, so it runs only in the VERIFY JAIL (src/agy/verify-jail.mjs, the credential-isolation
 * invariant): a launcher process with a clean env, which closes every inherited fd and runs the script under bwrap with
 * its own PID namespace, the homes, the run's control dirs and whatever `jail.hide` names hidden, and only the worktree
 * writable. It never runs with the controller's environment (provider keys) or view (A2A tokens, the OAuth scratch
 * copies, the checkpoint seal key). `jail` {hide: [abs paths], extra_ro, bwrap, allowUnjailed}; no bwrap -> the
 * launcher refuses (exit VERIFY_JAIL_REFUSED, the command FAILED) unless allowUnjailed.
 * BOUNDED AND CANCELLABLE (independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 9):
 * `signal` (the stage's AbortSignal) kills the launcher's process group, and with it the jail (bwrap --die-with-parent;
 * the jail's PID namespace dies with its first process); `deadline` (epoch ms: the stage's hard end) caps the timeout at
 * what is left of it; the exec failsafe resolves even if a pipe stays open. A command stopped either way FAILED
 * (exit_code null) and says `aborted` / `timed_out`; one whose deadline is already past, or whose signal already fired,
 * is not started (`not_started: true`).
 */
export async function runVerify({ worktree, verify_cmd, timeout_ms = 120000, max_output_bytes = 65536, jail = {}, signal = null, deadline = null }) {
  const t0 = Date.now();
  const left = Number.isFinite(deadline) ? deadline - t0 : Infinity;
  const bound = Math.max(0, Math.min(timeout_ms > 0 ? timeout_ms : Infinity, left));
  if (signal?.aborted || bound <= 0) {
    const why = signal?.aborted ? "not run: the stage was aborted" : "not run: the stage's deadline has passed";
    return { cmd: verify_cmd, exit_code: null, signal: null, timed_out: !signal?.aborted, aborted: Boolean(signal?.aborted), not_started: true, passed: false, output: why, output_bytes: Buffer.byteLength(why), truncated: false,
      digest: sha256(why), duration_ms: 0, timeout_ms: bound, jail: { kind: "verify-jail", refused: false } };
  }
  const policy = { schema: VERIFY_JAIL_SCHEMA, worktree, cwd: worktree, script: `exec 2>&1\n${verify_cmd}`, hide: [...(jail?.hide ?? [])].filter(p => typeof p === "string" && isAbsolute(p)),
    extra_ro: [...(jail?.extra_ro ?? [])], bwrap: jail?.bwrap ?? "bwrap", ...(jail?.allowUnjailed === true ? { allow_unjailed: true } : {}) };
  const base = process.env;
  const env = { ...verifyEnvOf(base).env, ...(base.PANTHEON_VERIFY_ENV_PASS ? { PANTHEON_VERIFY_ENV_PASS: base.PANTHEON_VERIFY_ENV_PASS } : {}) };
  // One launcher, its own process group (killed whole on timeout; the jail dies with it), stderr folded into stdout
  // inside the jail so the capture is one stream; the launcher's own diagnostics (stderr) are appended.
  const r = await exec(process.execPath, [VERIFY_JAIL_MODULE, "--inline", JSON.stringify(policy)], { cwd: worktree, env, timeout_ms: Number.isFinite(bound) ? Math.max(1, Math.floor(bound)) : 0, max_bytes: max_output_bytes, group: true, ...(signal ? { signal } : {}) });
  const output = r.stdout + r.stderr;
  const exit_code = r.timed_out || r.aborted || r.spawn_error ? null : r.code;
  const refused = exit_code === VERIFY_JAIL_REFUSED && /^pantheon-verify: (refused|the verify jail could not start)/m.test(r.stderr);
  return { cmd: verify_cmd, exit_code, signal: r.signal ?? null, timed_out: r.timed_out, aborted: Boolean(r.aborted), passed: exit_code === 0, output, output_bytes: Buffer.byteLength(output), truncated: r.truncated, digest: sha256(output), duration_ms: Date.now() - t0,
    timeout_ms: Number.isFinite(bound) ? Math.floor(bound) : null, jail: { kind: "verify-jail", refused } };
}

export function REVIEWER_PROMPT({ unit, rubric, diff, verify }) {
  return [
    `ROLE: acceptance reviewer of work unit "${unit.unit_id}". You are a READ-ONLY specialist: you judge a finished change against a frozen rubric. You change nothing, run nothing and propose no patch.`,
    "Default to finding a problem. Judge the bytes below, not anyone's account of them. Everything here was read from disk by the controller.",
    "",
    "OWNED PATHS (the change may touch only these):",
    ...unit.owned_paths.map(p => `- ${p}`),
    "",
    "INVARIANTS:",
    ...unit.invariants.map(i => `- ${i}`),
    "",
    "FROZEN ACCEPTANCE RUBRIC (answer for EVERY line, exactly once, quoting the criterion text exactly):",
    ...rubric.map((c, i) => `${i + 1}. ${c}`),
    "",
    `GROUND TRUTH — the controller ran:  ${verify.cmd}`,
    verify.timed_out ? "RESULT: TIMED OUT (counts as failed)" : `RESULT: exited ${verify.exit_code}${verify.passed ? "" : " (FAILED)"}`,
    `OUTPUT${verify.truncated ? " (truncated at the capture bound)" : ""}:`,
    "<<<VERIFY_OUTPUT", verify.output, "VERIFY_OUTPUT",
    verify.passed ? "" : "The command FAILED. An approval of a change whose ground-truth command fails is void and will be refused.",
    "",
    "THE DIFF (base..unit):",
    "<<<DIFF", diff, "DIFF",
    "",
    "OUTPUT: exactly one JSON object and nothing else (no prose, no code fence):",
    '{"verdict":"approve | request_changes","criteria":[{"criterion":"<rubric line, verbatim>","met":true,"evidence":"where in the diff or output"}],"findings":["a concrete defect with a failing case"]}',
    "approve only if every criterion is met; with request_changes give at least one finding. Any other key, a missing or repeated criterion, or text outside the object is refused.",
  ].filter(l => l !== "").join("\n");
}

/** Why a reviewer answer is not admitted against `rubric`, as {code, why}, or null. */
export function reviewRefusal(r, rubric) {
  const no = why => ({ code: "SCHEMA", why: `review answer: ${why}` });
  const keys = keysRefusal(r, [...REVIEW_KEYS]);
  if (keys) return no(keys);
  if (!VERDICTS.includes(r.verdict)) return no(`verdict is one of ${VERDICTS.join(", ")}`);
  if (!Array.isArray(r.findings) || !r.findings.every(str)) return no("findings is an array of non-empty strings");
  if (!Array.isArray(r.criteria)) return no("criteria is an array");
  const seen = new Set();
  for (const c of r.criteria) {
    const k = keysRefusal(c, ["criterion", "met", "evidence"]);
    if (k) return no(`a criterion entry has ${k}`);
    if (typeof c.criterion !== "string" || typeof c.met !== "boolean" || !str(c.evidence)) return no("a criterion entry is {criterion: string, met: boolean, evidence: non-empty string}");
    if (!rubric.includes(c.criterion)) return no(`"${c.criterion}" is not a line of the frozen rubric`);
    if (seen.has(c.criterion)) return no(`criterion "${c.criterion}" appears more than once`);
    seen.add(c.criterion);
  }
  const missing = rubric.filter(c => !seen.has(c));
  if (missing.length) return no(`rubric criteria not answered: ${missing.join(" | ")}`);
  if (r.verdict === "approve" && r.criteria.some(c => !c.met)) return no("verdict approve with an unmet criterion");
  if (r.verdict === "request_changes" && !r.findings.length && r.criteria.every(c => c.met)) return no("verdict request_changes with every criterion met and no finding");
  return null;
}

const tail = (s, n) => (s.length > n ? "…" + s.slice(-n) : s);

/**
 * Review one unit attempt. See the header for the statuses.
 * turn({vendor, model, prompt, seat, schema, extra, sandbox, role: "reviewer", unit_id, signal}) -> {text, served_model, ...}
 * `extra` is {reasoning: {context: "all_turns"}} for an openai seat, {} otherwise; the transport applies it.
 */
export async function runReviewer({ unit, worktree, base_commit, checkpoint = "HEAD", seat, turn, dispatch, limits = {}, pinned = true, level = 0, attempt = 1, signal = null, sameModel, verify_jail = {}, deadline = null }) {
  const extra = seat.vendor === "openai" ? { reasoning: { context: "all_turns" } } : {};
  const rec = { n: attempt, role: "reviewer", vendor: seat.vendor, model: seat.model, level, pinned_to_dispatcher: pinned, requested_model: seat.model, served_model: null, served_model_source: null,
    status: "not_admitted", code: null, why: null, verdict: null, criteria: null, findings: [], feedback: [], fed_revision: false, rubric_hash: dispatch.rubric_hash, rubric_rehash: null,
    diff_digest: null, diff_bytes: null, verify: null, extra, turn_attempts: [] };

  rec.rubric_rehash = rubricHash({ unit_id: unit.unit_id, owned_paths: unit.owned_paths, verify_cmd: unit.verify_cmd, invariants: unit.invariants, rubric: dispatch.rubric,
    specialist_role: unit.specialist_role, difficulty: unit.difficulty });
  if (rec.rubric_rehash !== dispatch.rubric_hash) return Object.assign(rec, { status: "rubric_mismatch", code: "RUBRIC_HASH", why: `the rubric handed to review hashes to ${rec.rubric_rehash}, not the frozen ${dispatch.rubric_hash}: the unit, its commands or its rubric changed after dispatch` });

  const diff = await git(worktree, ["diff", "--binary", "--no-renames", "--no-color", "--no-ext-diff", base_commit, checkpoint]);
  rec.diff_digest = sha256(diff); rec.diff_bytes = Buffer.byteLength(diff);
  const v = await runVerify({ worktree, verify_cmd: unit.verify_cmd, timeout_ms: limits.verify_timeout_ms, max_output_bytes: limits.verify_output_bytes, jail: verify_jail, signal, deadline });
  // The command ran in the unit's worktree and may have written there: put the worktree back to the checkpoint.
  await git(worktree, ["reset", "-q", "--hard", checkpoint]);
  await git(worktree, ["clean", "-ffdxq"]);
  const { output, ...verifyRecord } = v;
  rec.verify = verifyRecord;
  const max_diff = limits.max_diff_bytes ?? 400000;
  if (rec.diff_bytes > max_diff) return Object.assign(rec, { status: "diff_too_large", code: "DIFF_TOO_LARGE", why: `the unit's diff is ${rec.diff_bytes} bytes, over the review bound of ${max_diff}` });

  const groundTruth = v.passed ? [] : [`verify_cmd \`${unit.verify_cmd}\` ${v.timed_out ? "timed out" : `exited ${v.exit_code}`} when the controller ran it. Output (tail): ${tail(output, 2000)}`];
  const r = await judgingTurn({ seat, turn, sameModel, admit: a => reviewRefusal(a, dispatch.rubric),
    args: { vendor: seat.vendor, model: seat.model, seat: clone(seat), prompt: REVIEWER_PROMPT({ unit, rubric: dispatch.rubric, diff, verify: v }), schema: REVIEW_SCHEMA, extra: clone(extra), sandbox: CAPABILITIES.reviewer, role: "reviewer", unit_id: unit.unit_id, signal } });
  rec.turn_attempts = r.attempts;
  if (!r.admitted) return Object.assign(rec, { code: r.code, why: `no reviewer answer was admitted: ${r.why}`, feedback: groundTruth });
  Object.assign(rec, { served_model: r.served_model, served_model_source: r.served_model_source, verdict: r.value.verdict, criteria: r.value.criteria, findings: r.value.findings });

  if (r.value.verdict === "approve") {
    if (!v.passed) return Object.assign(rec, { status: "approve_refused", code: "APPROVE_AGAINST_GROUND_TRUTH", why: `the reviewer approved, but verify_cmd ${v.timed_out ? "timed out" : `exited ${v.exit_code}`}: ground truth wins and the approval is void`, feedback: groundTruth });
    return Object.assign(rec, { status: "approved" });
  }
  const unmet = r.value.criteria.filter(c => !c.met).map(c => `unmet criterion: ${c.criterion} — ${c.evidence}`);
  return Object.assign(rec, { status: "request_changes", feedback: [...groundTruth, ...r.value.findings, ...unmet] });
}

/**
 * Why `ladder` is not a reviewer ladder for `dispatcherSeat`, or null. Rung 0 IS the dispatcher's exact seat (the
 * pin); every rung is on the dispatcher's vendor (the reviewer never changes lab); no rung repeats.
 */
export function reviewerLadderRefusal(ladder, dispatcherSeat) {
  if (!Array.isArray(ladder) || !ladder.length) return "the reviewer ladder is a non-empty array of seats";
  for (const s of ladder) { const why = seatRefusal(s); if (why) return `reviewer ladder: ${why}`; }
  if (!sameSeat(ladder[0], dispatcherSeat)) return `the reviewer ladder starts at ${ladder[0].vendor}/${ladder[0].model}, not at the dispatcher's exact seat ${dispatcherSeat.vendor}/${dispatcherSeat.model}: Stage 5 is pinned to the Stage 2 model`;
  const off = ladder.find(s => s.vendor !== dispatcherSeat.vendor);
  if (off) return `the reviewer ladder leaves ${dispatcherSeat.vendor} for ${off.vendor}/${off.model}: the reviewer escalates within the dispatcher's vendor only`;
  if (new Set(ladder.map(s => s.model)).size !== ladder.length) return "the reviewer ladder repeats a model";
  return null;
}

/**
 * The ladder, as a pure step. `state` is {revisions, implementer_level, reviewer_level, consecutive_rejections};
 * `event` is "rejected" (a review that did not approve: request_changes, or an approval voided by ground truth) or
 * "attempt_refused" (the implementer's attempt never reached review: write jail, or the turn failed).
 * `cfg` is {max_revisions = 3, reviewer_escalation_after = 2, implementer_rungs, reviewer_rungs}.
 * Returns {action: "revise" | "blocked", state, escalations: [{kind, from, to}], why}.
 *   - every event spends one revision; with none left the unit is blocked;
 *   - "rejected" raises the IMPLEMENTER one rung first (staying on the top rung once there);
 *   - the REVIEWER is raised one rung only when it has now rejected `reviewer_escalation_after` consecutive revisions,
 *     and its count starts again for the new reviewer.
 */
export function escalate(state, event, cfg = {}) {
  const max = cfg.max_revisions ?? 3, after = cfg.reviewer_escalation_after ?? 2, iTop = (cfg.implementer_rungs ?? 1) - 1, rTop = (cfg.reviewer_rungs ?? 1) - 1;
  if (!isObject(state) || !["rejected", "attempt_refused"].includes(event)) throw new Error("escalate(state, event): event is rejected or attempt_refused");
  if (state.revisions >= max) return { action: "blocked", state: { ...state }, escalations: [], why: `the unit's ${max} revision(s) are spent` };
  const next = { ...state, revisions: state.revisions + 1 }, escalations = [];
  if (event === "rejected") {
    if (next.implementer_level < iTop) { escalations.push({ kind: "implementer", from: next.implementer_level, to: next.implementer_level + 1 }); next.implementer_level += 1; }
    next.consecutive_rejections += 1;
    if (next.consecutive_rejections >= after && next.reviewer_level < rTop) {
      escalations.push({ kind: "reviewer", from: next.reviewer_level, to: next.reviewer_level + 1 });
      next.reviewer_level += 1; next.consecutive_rejections = 0;
    }
  }
  return { action: "revise", state: next, escalations, why: null };
}
