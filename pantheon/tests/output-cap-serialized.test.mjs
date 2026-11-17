// The output cap as SERIALIZED at the provider request, through the real dispatcher (owner audit CS3,
// docs/reviews/2026-11-16-workflow-handoffs/CURRENT_STATE.md). Under fit, the declared output size must reach
// the planning and implementation requests, not only the selection record. Under argo, frontier seats keep the
// client's long-decode default whatever the difficulty, and the selection reason must say so rather than claim
// that difficulty sets the tier. The reviewer's explicit 4,000 is the positive control on every path.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runOpenItem } from "../src/board/run-item.mjs";
import { outputBudgetFor, FRONTIER_DEFAULT_OUTPUT } from "../src/config/tiers.mjs";
import { withDispatch, WORK } from "./fixtures/dispatch.mjs";

const REVIEW = /VERDICT/;
const PLAN = /TITLE:/;
const capsOf = (calls, re) => calls.filter(c => re.test(c.prompt)).map(c => [c.model, c.max_output_tokens]);

for (const output of ["xs", "xl"]) {
  test(`fit output ${output}: the plan and work requests carry the declared cap; the review keeps its 4,000`, async () => {
    await withDispatch(async ({ spec, opts, calls }) => {
      const r = await runOpenItem(spec(`fitCap_${output}`, { output }), opts({ profile: "fit" }));
      assert.equal(r.shipped, true, JSON.stringify(r.error));
      const sent = [...capsOf(calls, PLAN), ...capsOf(calls, WORK)];
      assert.ok(sent.length >= 2, JSON.stringify(sent));
      for (const [model, cap] of sent) assert.equal(cap, outputBudgetFor(model, output).tokens, `${model} received ${cap}`);
      for (const [, cap] of capsOf(calls, REVIEW)) assert.equal(cap, 4000);
    });
  });
}

test("argo: frontier seats keep the long-decode default at every difficulty, and the reason says so", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    for (const difficulty of ["easy", "hard"]) {
      const before = calls.length;
      const r = await runOpenItem(spec(`argoCap_${difficulty}`, { difficulty }), opts());
      assert.equal(r.shipped, true, JSON.stringify(r.error));
      const mine = calls.slice(before);
      for (const [model, cap] of capsOf(mine, WORK)) assert.equal(cap, FRONTIER_DEFAULT_OUTPUT, `${difficulty}: ${model} received ${cap}`);
      for (const [, cap] of capsOf(mine, REVIEW)) assert.equal(cap, 4000);
      const run = JSON.parse(readFileSync(join(r.board, "run.json"), "utf8"));
      for (const t of run.turns.filter(t => t.purpose === "work" || t.purpose === "plan")) {
        assert.doesNotMatch(t.selection.reason, /sets the output tier only/);
        assert.match(t.selection.reason, /long-decode default/);
      }
    }
  });
});
