// Is four labs enough for coordinated review? The classifier and report (src/practice/review-capacity.mjs) over the
// evidence real board runs leave behind, and the rule fixed in docs/reviews/2026-11-17-review-capacity/FOUR_LABS.md.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { classify, capacityReport, MIN_RUNS, ENOUGH_RATE } from "../src/practice/review-capacity.mjs";
import { runBoardItem } from "../src/board/operate.mjs";
import { withDispatch, WORK } from "./fixtures/dispatch.mjs";
import { boardFixture } from "./fixtures/board-repo.mjs";

const work = lab => ({ purpose: "work", lab }), plan = lab => ({ purpose: "plan", lab });
const shipped = review => ({ item: "i", run: { shipped: true }, review });

test("classify: each outcome of a coordinated review, and a run that needed none", () => {
  assert.equal(classify({ run: { shipped: false } }).class, "not_shipped");
  assert.equal(classify(shipped({ close: "sha256:c", outcome: "verified" })).class, "completed");
  assert.equal(classify(shipped({ close: null, failed: [{ seat: "x" }] })).class, "reviewer_unavailable");
  assert.equal(classify(shipped({ close: null, failed: [] })).class, "open_findings");
  const pending = contributions => shipped({ status: "pending", review_scope: { contributions }, author_labs: [...new Set(contributions.map(c => c.lab))] });
  assert.equal(classify(pending([work("openai"), work("google")])).class, "pending_mixed_labs");
  assert.equal(classify(pending([plan("anthropic"), work("openai")])).class, "pending_plan_contribution");
  assert.equal(classify(pending([work("openai")])).class, "pending_pool_short");
});

test(`the rule: insufficient below ${MIN_RUNS} runs; enough at ${ENOUGH_RATE * 100}% completed; not enough below`, () => {
  const dir = join(process.env.TMPDIR ?? "/tmp", `cap-${process.pid}-${Date.now()}`);
  // 86ce18a review, defect 4: the rule counts unique, verified, live observations. These bundles used to name no
  // run.json, so each would now be unverified; each is given its own live run.json, cited by digest, as a live board
  // run leaves it. The rule under test is unchanged.
  const write = (n, b) => {
    mkdirSync(join(dir, `b${n}`), { recursive: true });
    const runJson = JSON.stringify({ key: `b${n}`, providers: { kind: "live" } });
    writeFileSync(join(dir, `b${n}`, "run.json"), runJson);
    const run = { ...b.run, run_json: join(dir, `b${n}`, "run.json"), run_json_digest: "sha256:" + createHash("sha256").update(runJson).digest("hex") };
    writeFileSync(join(dir, `b${n}`, "evidence.json"), JSON.stringify({ ...b, run }));
  };
  try {
    for (let i = 0; i < 19; i++) write(i, shipped({ close: "sha256:c", outcome: "verified" }));
    assert.equal(capacityReport({ bundles: dir }).verdict.outcome, "insufficient_evidence");
    write(19, shipped({ status: "pending", review_scope: { contributions: [work("openai"), work("google")] } }));
    assert.equal(capacityReport({ bundles: dir }).verdict.outcome, "enough", "19 of 20 is 95%");
    write(20, shipped({ close: null, failed: [{}] }));
    const r = capacityReport({ bundles: dir });
    assert.equal(r.verdict.outcome, "not_enough", "19 of 21 is under 95%");
    assert.deepEqual([r.counts.pending_mixed_labs, r.counts.reviewer_unavailable, r.capacity_failures], [1, 1, 2]);
    write(21, { run: { shipped: false } });
    assert.equal(capacityReport({ bundles: dir }).needed, 21, "a run that did not ship needed no review and is not counted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const approve = async ({ vendor, model }) => ({ text: '```json\n{"verdict": "approve", "findings": []}\n```', response_id: `r_${vendor}`, served_model: model });

test("through real board runs: a completed review, a refusal before work, and a mixed-lab pending are each classified from the evidence they leave", async () => {
  await withDispatch(async ({ dir: repo, makeClientFor, fault, implement }) => {
    const { statusRoot, keys } = boardFixture(repo);
    const store = join(repo, "store");
    const go = (name, runOpts) => runBoardItem({ repo, item: "bound-item", statusRoot, makeClientFor, turn: approve, dir: join(repo, "boards", name), branch: `pantheon/bound-item-${name}`,
      out: join(repo, "boards", name, "operating"), evidenceStore: store, runOpts: { scouts: ["xai"], ...runOpts },
      practice: { outcome: "insufficient_evidence", question: "capacity fixture" } });
    try {
      await go("done", { planTitle: "ticket" });
      const refused = await go("refused", { planTitle: "model" });
      assert.equal(refused.pending.stage, "before-work");
      let wrote = 0, first = null;
      implement(() => (++wrote === 1 ? "export const ok = false;\n" : "export const ok = true;\n"));
      fault(req => {
        if (!WORK.test(req.prompt ?? "")) return null;
        if (first === null) { first = req.vendor; return null; }
        return req.vendor === first ? { error: Object.assign(new Error("You exceeded your current quota"), { status: 429, code: "insufficient_quota" }) } : null;
      });
      // legacy: its implementer fallbacks cross labs. (fit until the fit matrix, whose implementer ladder is one lab.)
      await go("mixed", { planTitle: "ticket", profile: "legacy", revisions: 3 });
      const r = capacityReport({ bundles: join(repo, "boards"), store });
      // 86ce18a review, defect 4: fixture runs answer from fake providers, so they are synthetic observations, reported
      // beside the live rule and never in it (they used to be counted under it).
      const byClass = Object.fromEntries(Object.entries(r.synthetic.counts).filter(([, n]) => n));
      assert.deepEqual(byClass, { completed: 1, pending_mixed_labs: 1, refused_before_work: 1 });
      assert.equal(r.unverified.count, 0, "every bundle's run.json verifies");
      assert.equal(r.needed, 0, "no live observation");
      assert.equal(r.verdict.outcome, "insufficient_evidence");
    } finally { rmSync(keys, { recursive: true, force: true }); }
  });
});
