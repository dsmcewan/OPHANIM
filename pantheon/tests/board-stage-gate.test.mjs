// Q3 + Q4: a stage starts only when the chair contract and the controller both agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { publish } from "../src/board/dag.mjs";
import { stageCheck, assertStage, assertLaw, StageRefused } from "../src/board/stage-gate.mjs";
import { runOpenItem } from "../src/board/run-item.mjs";
import { withBoard, seeded, HUMAN, TICKET } from "./board-helper.mjs";
import { withPipeline } from "./fixtures/pipeline.mjs";

test("a planning board admits the plan stage and refuses work and critique", () => withBoard(async board => {
  const ref = "refs/board/gate";
  const t = await publish({ ...board, ref, author: HUMAN, msg: "ticket", entries: [{ kind: "ticket", payload: TICKET }] });
  assert.equal(t.ok, true, t.why);
  const plan = stageCheck({ ...board, ref, stage: "plan" });
  assert.equal(plan.ok, true, plan.why);
  assert.equal(plan.pattern, "delegate");
  const work = stageCheck({ ...board, ref, stage: "work" });
  assert.equal(work.ok, false);
  assert.match(work.why, /delegate pattern through lead@orch, not impl@build/);
  assert.match(work.why, /does not schedule work/);
  assert.throws(() => assertStage({ ...board, ref, stage: "critique" }), StageRefused);
}));

test("an executing board admits work for its ready item only, and refuses a second plan", () => withBoard(async board => {
  const { ref, itemKey } = await seeded(board);
  const work = stageCheck({ ...board, ref, stage: "work", match: r => r.item === itemKey });
  assert.equal(work.ok, true, work.why);
  assert.equal(work.pattern, "conveyor");
  const other = stageCheck({ ...board, ref, stage: "work", match: r => r.item === "not-on-the-board" });
  assert.match(other.why, /does not schedule work: .*no matching candidate|does not schedule work/);
  const plan = stageCheck({ ...board, ref, stage: "plan" });
  assert.equal(plan.ok, false);
  assert.match(plan.why, /does not schedule plan/);
  const ship = stageCheck({ ...board, ref, stage: "ship" });
  assert.equal(ship.ok, false, "nothing is offered, so nothing can be integrated");
}));

test("laws refuse a same-lab review, and an unknown action is never a pass", () => {
  assert.throws(() => assertLaw({ kind: "review", producer: { vendor: "openai" }, checker: { vendor: "openai" } }), /law 3/);
  assert.throws(() => assertLaw({ kind: "review", producer: { vendor: "openai" }, checker: { vendor: "xai" }, assigner: { vendor: "xai" } }), /law 3/);
  assert.equal(assertLaw({ kind: "review", producer: { vendor: "openai" }, checker: { vendor: "xai" }, assigner: { vendor: "anthropic" } }).ok, true);
  assert.throws(() => assertLaw({ kind: "elect_judge" }), /not a law-checked action/);
});

test("a run whose acceptance never passes is refused at integrate with the controller's reason", async () => {
  await withPipeline(async ({ repo, opts, implement }) => {
    writeFileSync(join(repo, "alpha.mjs"), "export const ok = false;\n");
    writeFileSync(join(repo, "verify.mjs"), 'import assert from "node:assert/strict"; import {ok} from "./alpha.mjs"; assert.equal(ok, true);');
    implement(() => "export const ok = false;\n");
    const spec = { key: "gateKey", repo_root: repo, title: "one file", goal: "make ok true", question: "fixture",
      copy: ["alpha.mjs", "verify.mjs"], acceptance_cmd: "node verify.mjs", slots: [{ slot: "alpha", path: "alpha.mjs" }] };
    const result = await runOpenItem(spec, opts);
    assert.equal(result.shipped, false);
    const run = JSON.parse(readFileSync(join(result.outDir, "run.json"), "utf8"));
    assert.match(run.ship_why, /the controller did not schedule integrate for gateKey/);
    assert.match(run.ship_why, /ship gates: .*TESTS/, "the refusal carries the gate that failed");
    assert.ok(run.gates.some(g => g.gate === "TESTS" && !g.ok), "the ship gates are still recorded beside the refusal");
    assert.equal(existsSync(join(result.outDir, "artifact", "alpha.mjs")), false, "refused work is never exported as certified");
  });
});
