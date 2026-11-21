// Decision 6 (owner, 2026-11-19), inside the pipeline: "The Stage 5 exception does not extend to another unit." A unit's
// Stage 5 reviewer -- the pinned rung or any escalation rung -- may not be ANOTHER unit's dispatcher (asked or served),
// nor an authoring contributor of the unit; only the unit's own dispatcher holds the exception. Checked at selection
// and at answer admission, by canonical identity. Follow-up to independent review round 2, assignment 2 (xAI
// grok-4.7, 77480d6), question 7. Scripted turns on temporary git repositories; no provider is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipeline } from "../src/pipeline/index.mjs";
import { tempRepo, seats, unit, scripted, approve, reject, RUBRIC, LUNA, SOL, ASTRA, PLANNER } from "./fixtures/pipeline-stages.mjs";

// Unit a is dispatched to gpt-6-sol, unit b to gpt-6-luna. Each ladder starts at its own dispatcher (the pin).
const LADDER = [LUNA, SOL, ASTRA];
const twoUnits = (ladderFor = d => LADDER.slice(LADDER.findIndex(s => s.model === d.model))) => seats({
  dispatcher: u => ({ ...(u.unit_id === "a" ? SOL : LUNA) }),
  reviewerLadder: d => ladderFor(d).map(s => ({ ...s })),
});
const run = async (t, { review, ladderFor, limits = { max_revisions: 3, reviewer_escalation_after: 2 }, sameModel } = {}) => {
  const env = await tempRepo();
  t.after(env.cleanup);
  const plan = [unit("a"), unit("b")];
  const s = scripted({ plan, review });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: twoUnits(ladderFor), turns: s.turns, limits, dir: env.dir, planner: PLANNER,
    ...(sameModel ? { sameModel } : {}) });
  return { out, calls: s.calls };
};
const reviewersOf = (r, id) => r.calls.filter(c => c.role === "reviewer" && c.unit_id === id).map(c => c.model);

test("Decision 6 (follow-up to independent review round 2, assignment 2, question 7): each unit's own dispatcher is pinned and approves it", async t => {
  const r = await run(t, {});
  assert.equal(r.out.status, "completed");
  assert.deepEqual(reviewersOf(r, "a"), ["gpt-6-sol"]);
  assert.deepEqual(reviewersOf(r, "b"), ["gpt-6-luna"]);
  for (const id of ["a", "b"]) {
    const u = r.out.units[id];
    assert.deepEqual(u.reviews.map(x => [x.status, x.pinned_to_dispatcher]), [["approved", true]]);
    assert.equal(u.reviewer_exclusions, undefined);
  }
});

test("Decision 6 (follow-up to independent review round 2, assignment 2, question 7): unit b's ladder skips unit a's dispatcher model", async t => {
  // b's pinned gpt-6-luna rejects twice, so b's reviewer is raised; the next rung, gpt-6-sol, dispatched unit a.
  const r = await run(t, { review: (args, n) => (args.unit_id === "b" && args.model === "gpt-6-luna" ? reject(RUBRIC, [`finding ${n}`]) : approve(RUBRIC)) });
  const b = r.out.units.b;
  assert.equal(b.status, "approved", b.reason);
  assert.deepEqual(reviewersOf(r, "b"), ["gpt-6-luna", "gpt-6-luna", "gpt-6-astra"], "gpt-6-sol, a's dispatcher, never judged b");
  assert.deepEqual(b.reviewer_exclusions.map(x => [x.model, x.level]), [["gpt-6-sol", 1]]);
  assert.match(b.reviewer_exclusions[0].why, /openai\/gpt-6-sol contributed/);
  assert.deepEqual(b.escalations.filter(e => e.kind.startsWith("reviewer")).map(e => [e.kind, e.from.model, e.to.model]), [["reviewer", "gpt-6-luna", "gpt-6-sol"], ["reviewer_excluded", "gpt-6-sol", "gpt-6-astra"]]);
  // a's own dispatcher still judged a.
  assert.deepEqual(reviewersOf(r, "a"), ["gpt-6-sol"]);
  assert.equal(r.out.units.a.status, "approved");
});

test("Decision 6 (follow-up to independent review round 2, assignment 2, question 7): a ladder exhausted by exclusions blocks the unit on capacity; nothing falls back", async t => {
  const r = await run(t, { ladderFor: d => (d.model === "gpt-6-luna" ? [LUNA, SOL] : [SOL]),
    review: (args, n) => (args.unit_id === "b" ? reject(RUBRIC, [`finding ${n}`]) : approve(RUBRIC)) });
  const b = r.out.units.b;
  assert.equal(b.status, "blocked");
  assert.equal(b.code, "STAGE5_CAPACITY");
  assert.match(b.reason, /^STAGE5_CAPACITY: no rung of the reviewer ladder may judge unit b \(openai\/gpt-6-sol:/);
  assert.equal(reviewersOf(r, "b").includes("gpt-6-sol"), false);
  assert.equal(b.merged, false);
  assert.ok(b.findings.length >= 2, "the findings are kept");
});

test("Decision 6 (follow-up to independent review round 2, assignment 2, question 7): an answer served by another unit's dispatcher is not admitted", async t => {
  // A transport whose own check would let a sibling stand in (sameModel: always): the pipeline's admission refuses it.
  const r = await run(t, { sameModel: () => true,
    review: args => (args.unit_id === "b" ? { text: JSON.stringify(approve(RUBRIC)), served_model: "gpt-6-sol" } : approve(RUBRIC)) });
  const b = r.out.units.b;
  assert.equal(b.status, "blocked");
  assert.equal(b.code, "STAGE5_EXCLUDED");
  assert.deepEqual(b.reviews.map(x => [x.status, x.code, x.served_model]), [["not_admitted", "STAGE5_EXCLUDED", "gpt-6-sol"]]);
  assert.match(b.reason, /not admitted: .*openai\/gpt-6-sol contributed/);
});
