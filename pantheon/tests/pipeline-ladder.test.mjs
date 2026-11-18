// Stage 3 lane failover: a lane failure is retried ONCE on the same lane, then the unit steps down its Antigravity
// failover ladder; a quota refusal steps down at once. Lane failures spend no revision; every call is charged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runPipeline } from "../src/pipeline/index.mjs";
import { tempRepo, seats, unit, scripted, write, reject, RUBRIC, PLANNER } from "./fixtures/pipeline-stages.mjs";

const LADDER = [["gemini-4-carbon-high", "high"], ["gemini-4-hydrogen-xhigh", "xhigh"], ["gemini-4-argon-high", "high"]].map(([model, thinking]) => ({ vendor: "agy_google", model, thinking }));
const laneError = (kind = "timeout") => Object.assign(new Error(`lane ${kind}`), { code: "lane_failure", kind });
const quotaError = () => Object.assign(new Error("RESOURCE_EXHAUSTED: quota"), { code: "quota_exhausted", status: 429 });
const writeImpl = async args => { await write(args.cwd, `src/${args.unit_id}/impl.mjs`, "export {};\n"); return "done"; };

const run = async (t, implement, { limits = {}, review } = {}) => {
  const env = await tempRepo(); t.after(env.cleanup);
  const plan = [unit("a", { difficulty: "hard" })];
  const s = scripted({ plan, implement, ...(review ? { review } : {}) });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, dir: env.dir, planner: PLANNER, turns: s.turns, limits,
    seats: seats({ implementer: () => ({ seat: { ...LADDER[0] }, ladder: LADDER.map(x => ({ ...x })) }) }) });
  const impl = s.calls.filter(c => c.role === "implementer");
  return { out, u: out.units.a, models: impl.map(c => c.model), attempts: impl.map(c => c.attempt), calls: s.calls, disk: () => JSON.parse(readFileSync(join(env.dir, "pipeline.json"), "utf8")) };
};

test("one transient lane failure, then success on THE SAME lane: no step down, and no revision spent", async t => {
  const r = await run(t, async (args, n) => { if (n === 1) throw laneError("timeout"); return writeImpl(args); }, { limits: { max_revisions: 0 } });
  assert.equal(r.u.status, "approved");
  assert.deepEqual(r.models, ["gemini-4-carbon-high", "gemini-4-carbon-high"]);
  assert.deepEqual(r.attempts, [1, 1], "a lane retry is the same attempt");
  assert.equal(r.u.attempts.length, 1);
  assert.deepEqual(r.u.attempts[0].lane_failures.map(f => [f.model, f.kind, f.cause, f.retry, f.next]), [["gemini-4-carbon-high", "timeout", "lane", false, "same_lane"]]);
  assert.equal(r.u.escalations.length, 0);
  assert.equal(r.out.provider_calls.by_role.implementer, 2);
});

test("two failures on a lane step down to rung 2, which succeeds; the failover is a lane_failover escalation", async t => {
  const r = await run(t, async (args, n) => { if (n === 1) throw laneError("exit"); if (n === 2) throw laneError("stream"); return writeImpl(args); }, { limits: { max_revisions: 0 } });
  assert.equal(r.u.status, "approved");
  assert.deepEqual(r.models, ["gemini-4-carbon-high", "gemini-4-carbon-high", "gemini-4-hydrogen-xhigh"]);
  assert.deepEqual(r.u.attempts[0].lane_failures.map(f => [f.model, f.kind, f.retry, f.next]), [["gemini-4-carbon-high", "exit", false, "same_lane"], ["gemini-4-carbon-high", "stream", true, "next_rung"]]);
  assert.deepEqual(r.u.escalations.map(e => [e.kind, e.cause, e.from.model, e.to.model, e.after_attempt]), [["lane_failover", "lane", "gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", 1]]);
  assert.deepEqual([r.u.attempts[0].model, r.u.attempts[0].status], ["gemini-4-hydrogen-xhigh", "written"]);
  assert.deepEqual(r.disk().units.a.escalations, r.u.escalations);
});

test("every rung failing ends the unit blocked LANE_LADDER_EXHAUSTED, with every failure recorded and every call charged", async t => {
  const kinds = ["timeout", "exit", "stream", "spawn", "timeout", "exit"];
  const r = await run(t, async (args, n) => { throw laneError(kinds[n - 1]); });
  assert.equal(r.u.status, "blocked"); assert.equal(r.u.code, "LANE_LADDER_EXHAUSTED"); assert.match(r.u.reason, /^LANE_LADDER_EXHAUSTED/);
  assert.deepEqual(r.models, [0, 0, 1, 1, 2, 2].map(i => LADDER[i].model));
  assert.deepEqual(r.u.attempts.length, 1);
  assert.deepEqual(r.u.attempts[0].lane_failures.map(f => [f.model, f.kind, f.retry, f.next]), [
    [LADDER[0].model, "timeout", false, "same_lane"], [LADDER[0].model, "exit", true, "next_rung"],
    [LADDER[1].model, "stream", false, "same_lane"], [LADDER[1].model, "spawn", true, "next_rung"],
    [LADDER[2].model, "timeout", false, "same_lane"], [LADDER[2].model, "exit", true, "exhausted"]]);
  assert.deepEqual(r.u.escalations.map(e => [e.kind, e.to.model]), [["lane_failover", LADDER[1].model], ["lane_failover", LADDER[2].model]]);
  assert.equal(r.calls.filter(c => c.role === "reviewer").length, 0);
  assert.equal(r.out.provider_calls.by_role.implementer, 6);
  assert.equal(r.out.status, "incomplete");
});

test("lane failures do not consume revisions; a later rejection escalates the thinking level from the CURRENT rung", async t => {
  // carbon fails twice -> hydrogen writes -> rejected (the one revision) -> raised from hydrogen to argon -> approved.
  const r = await run(t, async (args, n) => { if (n <= 2) throw laneError("timeout"); return writeImpl(args); },
    { limits: { max_revisions: 1 }, review: (args, n) => n === 1 ? reject(RUBRIC, ["not yet"]) : { verdict: "approve", criteria: RUBRIC.map(criterion => ({ criterion, met: true, evidence: "ok" })), findings: [] } });
  assert.equal(r.u.status, "approved");
  assert.deepEqual(r.models, ["gemini-4-carbon-high", "gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", "gemini-4-argon-high"]);
  assert.deepEqual(r.attempts, [1, 1, 1, 2]);
  assert.deepEqual(r.u.escalations.map(e => [e.kind, e.from.model, e.to.model, e.after_attempt]), [
    ["lane_failover", "gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", 1], ["implementer", "gemini-4-hydrogen-xhigh", "gemini-4-argon-high", 1]]);
  assert.deepEqual(r.u.attempts.map(a => [a.model, a.status, a.lane_failures.length]), [["gemini-4-hydrogen-xhigh", "written", 2], ["gemini-4-argon-high", "written", 0]]);
});

test("a quota refusal steps down AT ONCE (no same-lane retry), recorded with cause quota", async t => {
  const r = await run(t, async (args, n) => { if (n === 1) throw quotaError(); return writeImpl(args); }, { limits: { max_revisions: 0 } });
  assert.equal(r.u.status, "approved");
  assert.deepEqual(r.models, ["gemini-4-carbon-high", "gemini-4-hydrogen-xhigh"]);
  assert.deepEqual(r.u.attempts[0].lane_failures.map(f => [f.model, f.kind, f.cause, f.retry, f.next]), [["gemini-4-carbon-high", "quota", "quota", false, "next_rung"]]);
  assert.deepEqual(r.u.escalations.map(e => [e.kind, e.cause]), [["lane_failover", "quota"]]);
});

test("lane retries are charged to max_provider_calls: the bound stops the ladder truthfully; a plain error still spends a revision", async t => {
  const capped = await run(t, async () => { throw laneError("timeout"); }, { limits: { max_provider_calls: 3 } });   // 1 dispatcher + 2 implementer
  assert.equal(capped.u.status, "blocked"); assert.match(capped.u.reason, /provider-call bound \(3\) is exhausted/);
  assert.equal(capped.out.provider_calls.total, 3); assert.equal(capped.out.provider_calls.refused_at_limit, 1);
  const plain = await run(t, async () => { throw new Error("unclassified"); }, { limits: { max_revisions: 1 } });
  assert.deepEqual(plain.models, ["gemini-4-carbon-high", "gemini-4-carbon-high"]);
  assert.deepEqual(plain.attempts, [1, 2], "an unclassified failure is a new attempt, not a lane retry");
  assert.equal(plain.u.status, "blocked"); assert.match(plain.u.reason, /revision\(s\) are spent/);
});
