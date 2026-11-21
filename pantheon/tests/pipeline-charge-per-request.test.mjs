// L-301 (self-audit round 3, assignment 3 (sealed bb1287a)): the pipeline's admission charged a turn's first provider
// call BEFORE the turn, so an implementer lane that failed before its spawn (no CLI, no jail) was counted against
// max_provider_calls and charged to the caller's ledger (onCharge). Now nothing is charged up front: the turn admits each
// call at its point of spend (admitRequest, the second charge contract of sdk/live.mjs); the refusals are still checked
// up front, and the up-front check reserves the turn's first call so concurrent turns cannot overrun the bound.
//
// Production entry: runPipeline with the production pipelineTurns (its implementer is runAgyWorkerTurn's caller), the
// single-turn seats scripted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { runPipeline } from "../src/pipeline/index.mjs";
import { pipelineTurns } from "../src/pipeline/turns.mjs";
import { tempRepo, seats, unit, scripted, PLANNER, RUBRIC } from "./fixtures/pipeline-stages.mjs";

test("L-301 (self-audit round 3, assignment 3 (sealed bb1287a)): an implementer lane that fails before its spawn is not a provider call: not counted, not charged", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const plan = [unit("a")];
  // The single-turn seats (pipelineTurns' `turn`): a scripted dispatcher for unit "a" (it takes no contract: charged on return).
  const single = async args => ({ text: JSON.stringify({ unit_id: "a", cohesive: true, specialist_role: "node-esm-library-engineer", difficulty: "medium", rubric: RUBRIC, notes: "" }), served_model: args.model });
  const charged = [];
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), dir: env.dir, planner: PLANNER,
    turns: pipelineTurns({ turn: single, agy: { cli: join(env.root, "no-such-agy") } }), onCharge: ({ role }) => charged.push(role) });
  const u = out.units.a;
  assert.equal(u.status, "blocked"); assert.equal(u.code, "LANE_LADDER_EXHAUSTED");
  const failures = u.attempts.flatMap(a => a.lane_failures);
  assert.equal(failures.length, 6, "two tries on each of the three rungs");
  assert.ok(failures.every(f => f.kind === "spawn" && /CLI absent/.test(f.why)), JSON.stringify(failures));
  assert.equal(out.provider_calls.by_role.implementer, 0, "nothing was spawned: no implementer call");
  assert.deepEqual(charged, ["dispatcher"], "the caller's ledger was charged the dispatcher's call only");
  assert.equal(out.provider_calls.total, 1);
});

test("L-301: a turn that takes the contract is charged at each admission, in order, before it proceeds; one refused at its admission sends nothing", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const plan = [unit("a")];
  const s = scripted({ plan });
  const order = [];
  const conforming = Object.fromEntries(Object.entries(s.turns).map(([k, f]) => [k, async a => {
    order.push(`${k}:asked`); a.admitRequest({ kind: "request" }); order.push(`${k}:sent`);
    // the implementer's API answer needs a continuation hop: a further billed request, admitted the same way
    if (k === "implementer") { a.admitRequest({ kind: "continuation" }); order.push(`${k}:hop`); }
    return f(a);
  }]));
  const charged = [];
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: conforming, dir: env.dir, planner: PLANNER,
    onCharge: ({ role }) => { charged.push(role); order.push(`charge:${role}`); } });
  assert.equal(out.status, "completed");
  assert.deepEqual(charged, ["dispatcher", "implementer", "continuation", "reviewer"]);
  assert.deepEqual(order, ["dispatcher:asked", "charge:dispatcher", "dispatcher:sent", "implementer:asked", "charge:implementer", "implementer:sent", "charge:continuation", "implementer:hop",
    "reviewer:asked", "charge:reviewer", "reviewer:sent"]);
  assert.deepEqual([out.provider_calls.total, out.provider_calls.by_role.continuation], [4, 1]);
  // A bound of 2: the implementer's continuation hop is refused at its admission, and is not sent.
  const capped = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: conforming, dir: join(env.root, "capped"), planner: PLANNER, limits: { max_provider_calls: 2 } });
  assert.equal(capped.provider_calls.total, 2);
  assert.ok(capped.provider_calls.refused_at_limit >= 1);
  assert.notEqual(capped.units.a.status, "approved");
});

test("L-301: turns in flight hold the bound: three concurrent units under a bound of 2 open two dispatcher seats and refuse the third up front, even when the seats charge only on return", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const plan = [unit("a"), unit("b"), unit("c")];
  let release; const gate = new Promise(r => { release = r; });
  // A bound that let fewer than two seats open must not hang the test: the gate opens after 5 s regardless (the asserts then fail).
  const fallback = setTimeout(() => release(), 5000); t.after(() => clearTimeout(fallback));
  let opened = 0;
  // Scripted seats that do not take the contract (they never admit): each is charged its one call on return.
  const s = scripted({ plan, dispatch: async args => { opened++; if (opened === 2) setTimeout(release, 50); await gate; return { unit_id: args.unit_id, cohesive: false, specialist_role: "node-esm-library-engineer", difficulty: "medium", rubric: ["x"], notes: "" }; } });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: s.turns, dir: env.dir, planner: PLANNER,
    limits: { max_provider_calls: 2, max_concurrent_units: 3 } });
  assert.equal(opened, 2, "the third seat was never opened");
  assert.equal(out.provider_calls.total, 2, "never past the bound");
  assert.equal(out.provider_calls.refused_at_limit, 1);
});
