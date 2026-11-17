// The reviewed contribution scope (owner audit RS2): review independence follows the contributions that reached
// what is judged, recorded explicitly, not a role label. src/review/scope.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reviewScope, contributionPaths } from "../src/review/scope.mjs";
import { PROJECTIONS } from "../src/board/project.mjs";
import { cycleReviewers } from "../src/board/operate.mjs";
import { assertLawful } from "../src/team/law.mjs";
import { assertReviewCutsAcross } from "../src/role/seating.mjs";
import { runOpenItem } from "../src/board/run-item.mjs";
import { withDispatch } from "./fixtures/dispatch.mjs";

const turns = [
  { purpose: "scout", vendor: "xai", model: "grok-4.3" },
  { purpose: "plan", vendor: "anthropic", model: "claude-fable-5-2" },
  { purpose: "work", vendor: "openai", model: "gpt-6-astra", slot: "a" },
  { purpose: "work", vendor: "openai", model: "gpt-6-sol", slot: "a" },
  { purpose: "work", vendor: "xai", model: "grok-4.7", slot: "b" },
];

test("change scope: the plan and every work turn contributed, each with the path it took; a scout did not, with the reason", () => {
  const s = reviewScope({ kind: "change", turns });
  assert.deepEqual(s.contributions.map(c => `${c.purpose}:${c.model}`), ["plan:claude-fable-5-2", "work:gpt-6-astra", "work:gpt-6-sol", "work:grok-4.7"]);
  assert.match(s.contributions[0].via, /title becomes the work_item the worker reads/);
  assert.deepEqual(s.excluded.map(e => e.purpose), ["scout"]);
  assert.match(s.excluded[0].why, /reaches neither the planner prompt .* nor the worker/);
  assert.deepEqual(s.author_labs, ["anthropic", "openai", "xai"]);
});

test("artifact scope: one slot's bytes -- the plan and every model that wrote that slot; another slot's work is outside it", () => {
  const s = reviewScope({ kind: "artifact", slot: "a", turns });
  assert.deepEqual(s.contributions.map(c => c.model), ["claude-fable-5-2", "gpt-6-astra", "gpt-6-sol"]);
  assert.ok(s.excluded.some(e => e.model === "grok-4.7" && /another slot/.test(e.why)));
  assert.deepEqual(s.author_labs, ["anthropic", "openai"]);
});

test("the plan's inclusion is derived from what the worker reads, not from the label 'planner'", () => {
  assert.equal(contributionPaths(PROJECTIONS).plan.contributes, true);
  const blind = { ...PROJECTIONS, worker: { ...PROJECTIONS.worker, kinds: PROJECTIONS.worker.kinds.filter(k => k !== "work_item") } };
  assert.equal(contributionPaths(blind).plan.contributes, false, "were the title withheld from the worker, the planner would not be a contribution");
  assert.ok(!reviewScope({ kind: "change", turns, projections: blind }).author_labs.includes("anthropic"));
  assert.throws(() => reviewScope({ kind: "everything", turns }), /unknown review scope/);
});

test("law 3 and the seating check name the contribution a reviewer shares a lab with", () => {
  const contributors = reviewScope({ kind: "artifact", slot: "a", turns }).contributions;
  assert.throws(() => assertLawful({ kind: "review", producer: { vendor: "openai" }, checker: { vendor: "anthropic" }, contributors }), /plan in the reviewed scope/);
  assert.throws(() => assertReviewCutsAcross({ contributors, producer: { vendor: "openai" }, reviewer: { vendor: "anthropic" } }), /plan in the reviewed scope/);
  assert.doesNotThrow(() => assertReviewCutsAcross({ contributors, producer: { vendor: "openai" }, reviewer: { vendor: "xai" } }));
});

test("cycle reviewers carry the scope they applied; a short pool is pending with the planner's contribution kept", () => {
  const whole = cycleReviewers({ planLabs: ["anthropic"], workLabs: ["anthropic"] });
  assert.deepEqual(whole.scope.contributions.map(c => c.purpose), ["plan", "work"]);
  const split = cycleReviewers({ planLabs: ["anthropic"], workLabs: ["openai"] });
  assert.equal(split.seats, null);
  assert.deepEqual(split.scope.contributions.map(c => [c.purpose, c.lab]), [["plan", "anthropic"], ["work", "openai"]]);
  assert.equal(split.scope.narrowed, undefined, "nothing is dropped from the scope");
});

test("through the dispatcher: run.json records each slot's reviewed scope, the reviewer is outside every contributing lab", async () => {
  await withDispatch(async ({ spec, opts }) => {
    const r = await runOpenItem(spec("scoped"), opts());
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const run = JSON.parse(readFileSync(join(r.board, "run.json"), "utf8"));
    const scope = run.review_scopes.code;
    assert.equal(scope.kind, "artifact");
    assert.deepEqual(scope.contributions.map(c => c.purpose), ["plan", "work"]);
    const critique = run.turns.find(t => t.purpose === "critique");
    const { labOf } = await import("../src/config/models.mjs");
    assert.ok(!scope.author_labs.includes(labOf(critique.vendor, critique.model)));
  });
});

test("through the dispatcher: an operator reviewer on the planner's lab is refused, and the refusal names the plan contribution", async () => {
  const { seat } = await import("./fixtures/dispatch.mjs");
  await withDispatch(async ({ spec, opts, calls }) => {
    const r = await runOpenItem(spec("plannerLabReviewer"), opts({ seatOverrides: { reviewer: seat("anthropic", "claude-opus-5-5") } }));
    assert.equal(r.shipped, false);
    assert.match(r.error.message, /plan in the reviewed scope/);
    assert.equal(calls.filter(c => /VERDICT/.test(c.prompt)).length, 0, "no review was asked of a contributing lab");
  });
});
