// Coordinated (cycle) review capacity under the existing independence requirement (owner direction 2026-11-17):
// n = 3 labs outside every contributing lab; never narrowed; produced work kept as pending; capacity checked before
// launching new work; worker selection and escalation untouched. And the alternatives compared in
// docs/reviews/2026-11-17-review-capacity/ANALYSIS.md, each tested here against the requirement.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runBoardItem, cycleReviewers } from "../src/board/operate.mjs";
import { reviewScope } from "../src/review/scope.mjs";
import { SEATING } from "../src/role/seating.mjs";
import { SEAT_FACTS } from "../src/route/router.mjs";
import { withDispatch, WORK } from "./fixtures/dispatch.mjs";
import { boardFixture } from "./fixtures/board-repo.mjs";

const approve = async ({ vendor, model }) => ({ text: '```json\n{"verdict": "approve", "findings": []}\n```', response_id: `r_${vendor}`, served_model: model });
const PLAN = /TITLE:/;

test("strict: two contributing labs leave the configured cycle pool short -- pending, with no seats and nothing narrowed", () => {
  const c = cycleReviewers({ planLabs: ["anthropic"], workLabs: ["openai"] });
  assert.equal(c.seats, null);
  assert.equal(c.pending.code, "REVIEW_CAPACITY_PENDING");
  assert.deepEqual(c.author_labs, ["anthropic", "openai"], "the planner's contribution is kept in the scope");
  assert.equal(c.scope.narrowed, undefined);
});

test("alternative A (current default, a model writes the title): the board run is refused before any provider call", async () => {
  await withDispatch(async ({ dir: repo, makeClientFor, calls }) => {
    const { statusRoot, keys } = boardFixture(repo);
    try {
      const r = await runBoardItem({ repo, item: "bound-item", statusRoot, makeClientFor, turn: approve, dir: join(repo, "board"), out: join(repo, "bundle"),
        runOpts: { scouts: ["xai"], planTitle: "model" } });
      assert.equal(r.bundle, null);
      assert.equal(r.pending.code, "REVIEW_CAPACITY_PENDING");
      assert.equal(r.pending.stage, "before-work");
      assert.deepEqual(r.pending.predicted_contributors.map(c => [c.purpose, c.lab]), [["plan", "anthropic"], ["work", "openai"]]);
      assert.equal(calls.length, 0, "no work was launched");
      assert.equal(existsSync(join(repo, "board", "run.json")), false);
    } finally { rmSync(keys, { recursive: true, force: true }); }
  });
});

test("alternative B (the ticket's own title, no planner model): it ships and the cycle closes with three labs outside the worker's", async () => {
  await withDispatch(async ({ dir: repo, makeClientFor, calls }) => {
    const { statusRoot, keys } = boardFixture(repo);
    try {
      const r = await runBoardItem({ repo, item: "bound-item", statusRoot, makeClientFor, turn: approve, dir: join(repo, "board"), out: join(repo, "bundle"),
        runOpts: { scouts: ["xai"], planTitle: "ticket" }, practice: { outcome: "insufficient_evidence", question: "review capacity fixture" } });
      assert.equal(r.bundle.run.shipped, true, JSON.stringify(r.bundle.run.error));
      assert.equal(calls.filter(c => PLAN.test(c.prompt)).length, 0, "no planner model was asked");
      const labs = r.bundle.review.reviews.map(x => x.lab);
      assert.equal(new Set(labs).size, 3);
      assert.ok(!labs.some(l => r.bundle.review.author_labs.includes(l)));
      assert.deepEqual(r.bundle.review.review_scope.contributions.map(c => c.purpose), ["work"]);
      assert.equal(r.bundle.review.review_scope.narrowed, undefined);
      assert.equal(r.bundle.review.outcome, "verified");
    } finally { rmSync(keys, { recursive: true, force: true }); }
  });
});

test("worker escalation is never prevented: when a fallback in a second lab writes the bytes, the work is kept and the review is pending", async () => {
  await withDispatch(async ({ dir: repo, makeClientFor, calls, fault, implement }) => {
    const { statusRoot, keys } = boardFixture(repo);
    try {
      // The first implementer revision fails acceptance; its revision is then answered by a fallback in another lab.
      let wrote = 0;
      implement(() => (++wrote === 1 ? "export const ok = false;\n" : "export const ok = true;\n"));
      // Under legacy, a worker's fallbacks cross labs: the revision after the first is refused by quota on the lab that
      // wrote the first, so a fallback in another lab writes it. (This ran under fit until the fit matrix, owner
      // direction 2026-11-17: fit's implementer ladder is Antigravity Gemini lanes only, one lab; argo's implementer
      // stops instead of revising when acceptance fails.)
      let first = null;
      fault((req) => {
        if (!WORK.test(req.prompt ?? "")) return null;
        if (first === null) { first = req.vendor; return null; }
        return req.vendor === first ? { error: Object.assign(new Error("You exceeded your current quota"), { status: 429, code: "insufficient_quota" }) } : null;
      });
      const r = await runBoardItem({ repo, item: "bound-item", statusRoot, makeClientFor, turn: approve, dir: join(repo, "board"), out: join(repo, "bundle"),
        runOpts: { scouts: ["xai"], planTitle: "ticket", revisions: 3, profile: "legacy" } });
      const run = JSON.parse(readFileSync(join(repo, "board", "run.json"), "utf8"));
      const workLabs = [...new Set(run.turns.filter(t => t.purpose === "work").map(t => t.vendor))];
      assert.ok(workLabs.length >= 2, `a fallback in a second lab wrote a revision (work vendors: ${workLabs})`);
      assert.equal(r.bundle.run.shipped, true, "the worker escalated freely and its work shipped in-run");
      assert.equal(r.bundle.review.status, "pending");
      assert.equal(r.bundle.review.pending.code, "REVIEW_CAPACITY_PENDING");
      assert.ok(r.bundle.commit, "the produced change is committed and kept");
      assert.equal(r.proposal, null);
    } finally { rmSync(keys, { recursive: true, force: true }); }
  });
});

test("alternative C (separate title and implementation panels) gains no capacity: the implementation's bytes include the title", () => {
  const turns = [{ purpose: "plan", vendor: "anthropic", model: "claude-fable-5-2" }, { purpose: "work", vendor: "openai", model: "gpt-6-astra", slot: "a" }];
  const implementation = reviewScope({ kind: "artifact", slot: "a", turns });
  assert.deepEqual(implementation.author_labs, ["anthropic", "openai"], "the planner's title reached the worker, so the implementation panel must exclude both labs");
});

test("alternative D (a fifth qualified reviewer lab) restores capacity for a model-written title -- mechanics only, no lab is qualified", () => {
  const fifth = { ...SEATING, reviewer: [...SEATING.reviewer, { vendor: "fifthlab", model: "fixture-reviewer", band: null, basis: "TASTE", why: "test-only fifth lab" }] };
  const facts = { ...SEAT_FACTS, fifthlab: { ...SEAT_FACTS.xai, quota_pool: "fifthlab" } };
  const c = cycleReviewers({ planLabs: ["anthropic"], workLabs: ["openai"], seating: fifth, facts });
  assert.ok(c.seats, JSON.stringify(c.pending));
  assert.equal(new Set(c.seats.map(s => s.lab)).size, 3);
  assert.ok(c.seats.some(s => s.vendor === "fifthlab"));
});
