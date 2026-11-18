// Stage 5: ground truth outranks the reviewer, the rubric is re-hashed, and the rejection/escalation ladder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runPipeline, contributionsOf } from "../src/pipeline/index.mjs";
import { escalate, runReviewer, runVerify, reviewRefusal, reviewerLadderRefusal, REVIEWER_PROMPT } from "../src/pipeline/review.mjs";
import { rubricHash } from "../src/pipeline/dispatch.mjs";
import { tempRepo, seats, unit, scripted, write, sh, approve, reject, RUBRIC, LUNA, SOL, ASTRA, HYDROGEN, PLANNER } from "./fixtures/pipeline-stages.mjs";

const run = async (t, plan, script, limits, seatOver) => {
  const env = await tempRepo(); t.after(env.cleanup);
  const s = scripted({ plan, ...script });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(seatOver), turns: s.turns, limits, dir: env.dir, planner: PLANNER });
  return { ...env, out, calls: s.calls };
};
const of = (calls, role) => calls.filter(c => c.role === role);

test("an `approve` while verify_cmd FAILED is refused by the controller: ground truth wins, nothing merges", async t => {
  const r = await run(t, [unit("a", { verify_cmd: "echo boom-from-verify; exit 3" })], { review: () => approve(RUBRIC) }, { max_revisions: 1 });
  const u = r.out.units.a;
  assert.deepEqual(u.reviews.map(x => [x.verdict, x.status, x.code, x.verify.exit_code, x.verify.passed]), [["approve", "approve_refused", "APPROVE_AGAINST_GROUND_TRUTH", 3, false], ["approve", "approve_refused", "APPROVE_AGAINST_GROUND_TRUTH", 3, false]]);
  assert.equal(u.status, "blocked"); assert.equal(u.merged, false); assert.equal(r.out.integration.head, r.out.base.commit);
  // The revision is told the ground truth by the controller; a voided approval is not a reviewer finding.
  assert.match(of(r.calls, "implementer")[1].prompt, /exited 3 when the controller ran it[\s\S]*boom-from-verify/);
  assert.equal(u.reviewer_fed_revision, false); assert.equal(u.findings[0].source, "controller");
  assert.equal(contributionsOf(r.out).some(c => c.kind === "critique"), false);
});

test("a verify_cmd that times out is a failure, its process group is killed, and its output is capped", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const t0 = Date.now();
  const slow = await runVerify({ worktree: env.repo, verify_cmd: "echo started; (sleep 30 &) ; sleep 30", timeout_ms: 300 });
  assert.ok(Date.now() - t0 < 5000); assert.deepEqual([slow.timed_out, slow.passed, slow.exit_code], [true, false, null]); assert.match(slow.output, /started/);
  const loud = await runVerify({ worktree: env.repo, verify_cmd: "head -c 200000 /dev/zero | tr '\\0' x; echo err >&2", max_output_bytes: 1000 });
  assert.equal(loud.output_bytes, 1000); assert.equal(loud.truncated, true); assert.equal(loud.passed, true);
  const both = await runVerify({ worktree: env.repo, verify_cmd: "echo out; echo err >&2; exit 2" });
  assert.equal(both.exit_code, 2); assert.equal(both.output, "out\nerr\n"); assert.match(both.digest, /^sha256:[0-9a-f]{64}$/);
});

test("rubric hash tamper: a rubric, command or path that no longer hashes to the frozen rubric_hash is refused before any model is asked", async t => {
  const u = unit("a"), frozen = rubricHash({ unit_id: "a", owned_paths: u.owned_paths, verify_cmd: u.verify_cmd, invariants: u.invariants, rubric: RUBRIC });
  let asked = 0;
  const turn = async a => { asked++; return { text: JSON.stringify(approve(RUBRIC)), served_model: a.model }; };
  const tampered = [
    { unit: u, dispatch: { rubric: [RUBRIC[0]], rubric_hash: frozen } },                                  // a criterion dropped
    { unit: u, dispatch: { rubric: [...RUBRIC].reverse(), rubric_hash: frozen } },                        // reordered
    { unit: { ...u, verify_cmd: "true" }, dispatch: { rubric: RUBRIC, rubric_hash: frozen } },            // an easier ground truth
    { unit: { ...u, owned_paths: ["**"] }, dispatch: { rubric: RUBRIC, rubric_hash: frozen } },
    { unit: { ...u, invariants: ["anything"] }, dispatch: { rubric: RUBRIC, rubric_hash: frozen } },
  ];
  for (const x of tampered) {
    const rec = await runReviewer({ ...x, worktree: "/nonexistent-never-read", base_commit: "HEAD", seat: LUNA, turn });
    assert.equal(rec.status, "rubric_mismatch"); assert.equal(rec.code, "RUBRIC_HASH"); assert.notEqual(rec.rubric_rehash, frozen); assert.equal(rec.verify, null);
  }
  assert.equal(asked, 0);
  // In a run, the frozen unit cannot be changed by an injected function: the implementer's copy is a copy.
  const r = await run(t, [u], { implement: async args => { await write(args.cwd, "src/a/impl.mjs", "x\n"); args.sandbox.owned_paths.push("**"); return "ok"; } });
  assert.equal(r.out.units.a.status, "approved"); assert.equal(r.out.units.a.reviews[0].rubric_rehash, r.out.units.a.dispatch.rubric_hash);
});

test("review answers are strict: every rubric criterion exactly once, no unknown key, no approval with an unmet criterion", () => {
  const ok = approve(RUBRIC);
  assert.equal(reviewRefusal(ok, RUBRIC), null);
  assert.equal(reviewRefusal(reject(RUBRIC), RUBRIC), null);
  const bad = [
    { ...ok, criteria: ok.criteria.slice(1) }, { ...ok, criteria: [...ok.criteria, ok.criteria[0]] }, { ...ok, criteria: [ok.criteria[0], { criterion: "invented", met: true, evidence: "e" }] },
    { ...ok, score: 9 }, { ...ok, verdict: "lgtm" }, { ...ok, criteria: ok.criteria.map(c => ({ ...c, met: false })) }, { ...ok, criteria: ok.criteria.map(c => ({ ...c, evidence: "" })) },
    { ...ok, criteria: ok.criteria.map(c => ({ ...c, severity: "low" })) }, { ...ok, verdict: "request_changes" }, { ...ok, findings: [3] }, { verdict: "approve", criteria: ok.criteria },
  ];
  for (const b of bad) assert.equal(reviewRefusal(b, RUBRIC)?.code, "SCHEMA", JSON.stringify(b));
});

test("a reviewer answer that breaks the schema, or names no served model, is not admitted: asked once more, then the unit is blocked", async t => {
  const schema = await run(t, [unit("a")], { review: () => ({ verdict: "approve", criteria: [], findings: [] }) });
  assert.equal(schema.out.units.a.status, "blocked"); assert.equal(of(schema.calls, "reviewer").length, 2);
  assert.deepEqual(schema.out.units.a.reviews[0].turn_attempts.map(a => [a.status, a.code]), [["not_admitted", "SCHEMA"], ["not_admitted", "SCHEMA"]]);
  let n = 0;
  const unnamed = await run(t, [unit("a")], { review: () => (++n === 1 ? { text: JSON.stringify(approve(RUBRIC)), served_model: null } : approve(RUBRIC)) });
  assert.equal(unnamed.out.units.a.status, "approved");
  assert.deepEqual(unnamed.out.units.a.reviews[0].turn_attempts.map(a => [a.status, a.code, a.requested_model, a.served_model]), [["not_admitted", "NO_SERVED_MODEL", "gpt-6-luna", null], ["admitted", null, "gpt-6-luna", "gpt-6-luna"]]);
  const never = await run(t, [unit("a")], { review: () => ({ text: JSON.stringify(approve(RUBRIC)) }) });
  assert.equal(never.out.units.a.status, "blocked"); assert.equal(never.out.units.a.reviews[0].code, "NO_SERVED_MODEL"); assert.equal(never.out.units.a.merged, false);
  // The implementer is an authoring seat: its unnamed served model is recorded as unnamed, and the work proceeds.
  const impl = await run(t, [unit("a")], { implement: async args => { await write(args.cwd, "src/a/impl.mjs", "x\n"); return { text: "done" }; } });
  assert.deepEqual([impl.out.units.a.status, impl.out.units.a.attempts[0].requested_model, impl.out.units.a.attempts[0].served_model], ["approved", "gemini-4-hydrogen-medium", null]);
});

test("escalate() is pure: the implementer is raised first; the reviewer only after N consecutive rejections; revisions are bounded", () => {
  const cfg = { max_revisions: 5, reviewer_escalation_after: 2, implementer_rungs: 3, reviewer_rungs: 3 };
  let s = { revisions: 0, implementer_level: 0, reviewer_level: 0, consecutive_rejections: 0 };
  const trace = [];
  for (let i = 0; i < 6; i++) { const step = escalate(s, "rejected", cfg); trace.push([step.action, step.state.implementer_level, step.state.reviewer_level, step.escalations.map(e => e.kind).join("+")]); s = step.state; }
  assert.deepEqual(trace, [["revise", 1, 0, "implementer"], ["revise", 2, 1, "implementer+reviewer"], ["revise", 2, 1, ""], ["revise", 2, 2, "reviewer"], ["revise", 2, 2, ""], ["blocked", 2, 2, ""]]);
  // A refused attempt spends a revision and raises nobody; the input state is not mutated.
  const before = { revisions: 0, implementer_level: 0, reviewer_level: 0, consecutive_rejections: 1 };
  assert.deepEqual(escalate(before, "attempt_refused", cfg).state, { ...before, revisions: 1 });
  assert.equal(before.revisions, 0);
  assert.equal(escalate({ ...before, revisions: 3 }, "rejected", {}).action, "blocked");   // defaults: 3 revisions, after 2
  assert.throws(() => escalate(before, "approved", cfg));
});

test("the reviewer ladder starts at the dispatcher's exact seat and never leaves its vendor", () => {
  assert.equal(reviewerLadderRefusal([LUNA, SOL, ASTRA], LUNA), null);
  assert.match(reviewerLadderRefusal([SOL, ASTRA], LUNA), /pinned to the Stage 2 model/);
  assert.match(reviewerLadderRefusal([LUNA, { vendor: "anthropic", model: "claude-opus-5" }], LUNA), /within the dispatcher's vendor only/);
  assert.match(reviewerLadderRefusal([LUNA, { vendor: "agy_google", model: "gemini-4-argon" }], LUNA), /within the dispatcher's vendor only/);
  assert.match(reviewerLadderRefusal([LUNA, LUNA], LUNA), /repeats/);
  assert.match(reviewerLadderRefusal([], LUNA), /non-empty/);
});

test("in a run: rejection raises the implementer's thinking level first; repeated rejections escalate the reviewer luna -> sol -> astra, only within OpenAI; exhaustion ends `blocked` with every finding kept", async t => {
  const r = await run(t, [unit("a")], { review: (args, n) => reject(RUBRIC, [`finding ${n} by ${args.model}`]) }, { max_revisions: 5, reviewer_escalation_after: 2 });
  const u = r.out.units.a;
  assert.deepEqual(of(r.calls, "implementer").map(c => c.model), ["gemini-4-hydrogen-medium", "gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh", "gemini-4-hydrogen-xhigh", "gemini-4-hydrogen-xhigh", "gemini-4-hydrogen-xhigh"]);
  assert.deepEqual(of(r.calls, "reviewer").map(c => c.model), ["gpt-6-luna", "gpt-6-luna", "gpt-6-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-astra"]);
  assert.ok(of(r.calls, "reviewer").every(c => c.vendor === "openai"));
  // After the FIRST rejection only the implementer moved.
  assert.deepEqual(u.escalations.filter(e => e.after_attempt === 1).map(e => [e.kind, e.from.model, e.to.model]), [["implementer", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-high"]]);
  assert.deepEqual(u.escalations.filter(e => e.kind === "reviewer").map(e => [e.after_attempt, e.from.model, e.to.model]), [[2, "gpt-6-luna", "gpt-6-sol"], [4, "gpt-6-sol", "gpt-6-astra"]]);
  assert.deepEqual(u.reviews.map(x => x.pinned_to_dispatcher), [true, true, false, false, false, false]);
  assert.equal(u.status, "blocked"); assert.match(u.reason, /5 revision\(s\) are spent; 12 finding\(s\) retained/);
  assert.equal(u.findings.length, 6);
  assert.deepEqual(u.findings.map(f => f.findings[0]), [1, 2, 3, 4, 5, 6].map(n => `finding ${n} by ${["gpt-6-luna", "gpt-6-luna", "gpt-6-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-astra"][n - 1]}`));
  assert.equal(u.merged, false); assert.equal(r.out.integration.head, r.out.base.commit);
  // Each revision saw the findings of the review before it; only the last review fed no revision.
  assert.match(of(r.calls, "implementer")[3].prompt, /THIS IS ATTEMPT 4[\s\S]*finding 3 by gpt-6-sol/);
  assert.deepEqual(u.reviews.map(x => x.fed_revision), [true, true, true, true, true, false]);
  assert.deepEqual(contributionsOf(r.out).filter(c => c.kind === "critique").map(c => c.model), ["gpt-6-astra", "gpt-6-luna", "gpt-6-sol"]);
});

test("with the defaults (3 revisions, escalation after 2) a unit that is fixed on its second revision is approved by the escalated reviewer", async t => {
  const r = await run(t, [unit("a", { verify_cmd: "grep -q v3 src/a/impl.mjs" })], {
    implement: async (args, n) => { await write(args.cwd, "src/a/impl.mjs", `// v${n}\n`); return "ok"; } });
  const u = r.out.units.a;
  assert.equal(u.status, "approved");
  assert.deepEqual(u.reviews.map(x => [x.model, x.status, x.verify.exit_code]), [["gpt-6-luna", "request_changes", 1], ["gpt-6-luna", "request_changes", 1], ["gpt-6-sol", "approved", 0]]);
  assert.equal((await sh(`git show ${r.out.integration.branch}:src/a/impl.mjs`, r.repo)).trim(), "// v3");
  assert.equal(u.attempts.at(-1).model, "gemini-4-hydrogen-xhigh");
});

test("an openai reviewer turn carries reasoning.context = all_turns as an opaque option; another vendor's does not", async t => {
  const r = await run(t, [unit("a")]);
  assert.deepEqual(of(r.calls, "reviewer")[0].extra, { reasoning: { context: "all_turns" } });
  assert.deepEqual(r.out.units.a.reviews[0].extra, { reasoning: { context: "all_turns" } });
  assert.equal(of(r.calls, "dispatcher")[0].extra, undefined);
  const env = await tempRepo(); t.after(env.cleanup);
  await write(env.repo, "f.txt", "x\n");
  const u = unit("a", { verify_cmd: "true" }), d = { rubric: RUBRIC, rubric_hash: rubricHash({ unit_id: "a", owned_paths: u.owned_paths, verify_cmd: "true", invariants: u.invariants, rubric: RUBRIC }) };
  let got;
  const rec = await runReviewer({ unit: u, worktree: env.repo, base_commit: "HEAD", seat: { vendor: "xai", model: "grok-4.5" }, dispatch: d, turn: async a => { got = a; return { text: JSON.stringify(approve(RUBRIC)), served_model: a.model }; } });
  assert.equal(rec.status, "approved"); assert.deepEqual(got.extra, {});
});

test("the reviewer prompt is a read-only specialist's and says an approval over a failing command is void", () => {
  const p = REVIEWER_PROMPT({ unit: unit("a"), rubric: RUBRIC, diff: "DIFFBYTES", verify: { cmd: "x", exit_code: 1, passed: false, timed_out: false, truncated: false, output: "OUT" } });
  for (const want of [/READ-ONLY specialist/, /RESULT: exited 1 \(FAILED\)/, /approval of a change whose ground-truth command fails is void/, /1\. the verify command passes/, /DIFFBYTES/, /OUT/]) assert.match(p, want);
});
