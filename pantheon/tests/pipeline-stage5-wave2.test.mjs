// Stage 5 confinement, the cases the earlier suite did not reach. Scripted turns on temporary git repositories.
//   M5 (self-audit round 3, assignment 2 (sealed 449ca42), section 7: "all tests dispatch unit a before b's escalation"):
//      another unit's dispatcher is excluded from a unit's ladder by the seat it WILL be dispatched to, before it answers,
//      so the rule does not depend on which unit ran first (docs/review-independence.md, Decision 6).
//   Owner decision L-001 follow-up (2026-11-19): a dispatcher whose advisory return reached the plan a run carries out
//      keeps Decision 6's pinned Stage 5 review of its OWN unit only; every other unit's Stage 5 excludes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipeline } from "../src/pipeline/index.mjs";
import { tempRepo, seats, unit, scripted, approve, reject, RUBRIC, LUNA, SOL, ASTRA, PLANNER } from "./fixtures/pipeline-stages.mjs";

const reviewersOf = (r, id) => r.calls.filter(c => c.role === "reviewer" && c.unit_id === id).map(c => c.model);
const run = async (t, { plan, dispatcher, ladderFor, review, stage5_excluded }) => {
  const env = await tempRepo();
  t.after(env.cleanup);
  const s = scripted({ plan, review });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, turns: s.turns, dir: env.dir, planner: PLANNER,
    seats: seats({ dispatcher: u => ({ ...dispatcher(u) }), reviewerLadder: d => ladderFor(d).map(x => ({ ...x })) }),
    limits: { max_revisions: 3, reviewer_escalation_after: 2 }, ...(stage5_excluded ? { stage5_excluded } : {}) });
  return { out, calls: s.calls };
};

test("self-audit round 3, assignment 2 (sealed 449ca42), M5: unit b's ladder skips unit a's dispatcher seat although a is dispatched only after b ends", async t => {
  // a depends on b: b runs (and escalates) in wave 1, a is dispatched to gpt-6-sol in wave 2.
  const r = await run(t, { plan: [unit("a", { depends_on: ["b"] }), unit("b")], dispatcher: u => (u.unit_id === "a" ? SOL : LUNA),
    ladderFor: d => [LUNA, SOL, ASTRA].slice([LUNA, SOL, ASTRA].findIndex(x => x.model === d.model)), review: (args, n) => (args.unit_id === "b" && args.model === "gpt-6-luna" ? reject(RUBRIC, [`finding ${n}`]) : approve(RUBRIC)) });
  assert.deepEqual(r.out.waves, [["b"], ["a"]]);
  const order = r.calls.filter(c => c.role === "dispatcher" || c.role === "reviewer").map(c => `${c.role}:${c.unit_id}:${c.model}`);
  assert.deepEqual(order, ["dispatcher:b:gpt-6-luna", "reviewer:b:gpt-6-luna", "reviewer:b:gpt-6-luna", "reviewer:b:gpt-6-astra", "dispatcher:a:gpt-6-sol", "reviewer:a:gpt-6-sol"]);
  const b = r.out.units.b;
  assert.equal(b.status, "approved", b.reason);
  assert.deepEqual(b.reviewer_exclusions.map(x => [x.model, x.level]), [["gpt-6-sol", 1]]);
  assert.match(b.reviewer_exclusions[0].why, /openai\/gpt-6-sol contributed/);
});

test("owner decision L-001 (2026-11-19), follow-up: a returning dispatcher keeps the pinned Stage 5 review of its own unit only", async t => {
  // gpt-6-astra returned a unit of the earlier plan. In this run it dispatches no unit: unit b's ladder skips it.
  const other = await run(t, { plan: [unit("a"), unit("b")], dispatcher: u => (u.unit_id === "a" ? SOL : LUNA), ladderFor: d => (d.model === "gpt-6-luna" ? [LUNA, ASTRA] : [SOL]),
    review: (args, n) => (args.unit_id === "b" && args.model === "gpt-6-luna" ? reject(RUBRIC, [`finding ${n}`]) : approve(RUBRIC)), stage5_excluded: [ASTRA] });
  const b = other.out.units.b;
  assert.equal(b.status, "blocked");
  assert.equal(b.code, "STAGE5_CAPACITY");
  assert.equal(reviewersOf(other, "b").includes("gpt-6-astra"), false);
  assert.deepEqual(other.out.stage5_excluded, [{ vendor: "openai", model: "gpt-6-astra" }]);
  // In a run where it dispatches the revised unit itself, its pinned review of THAT unit stands.
  const own = await run(t, { plan: [unit("a"), unit("b")], dispatcher: u => (u.unit_id === "a" ? ASTRA : LUNA), ladderFor: d => [d], stage5_excluded: [ASTRA] });
  assert.equal(own.out.status, "completed");
  assert.deepEqual(reviewersOf(own, "a"), ["gpt-6-astra"]);
  assert.deepEqual(own.out.units.a.reviews.map(x => [x.status, x.pinned_to_dispatcher]), [["approved", true]]);
});
