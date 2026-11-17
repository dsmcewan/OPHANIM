// A loaded practice decision that does not apply (audit C3 follow-up): the ledger admits a promote whose policy is
// not the one this dispatcher implements. The dispatch keeps recording it `applies: false` on every selection and
// continues under pantheon.selection/v1 (unchanged), and now also SURFACES it: run.json carries
// `practice_warning` at top level, and `pantheon-board.mjs run` prints a warning line naming the loaded
// disposition hash and why it does not apply. Fakes only (fixtures/dispatch.mjs, fixtures/board-repo.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openPantheonLedger } from "../src/ledger/system.mjs";
import { reviewCycle } from "../src/ledger/review-cycle.mjs";
import { SELECTION_POLICY } from "../src/route/frontier.mjs";
import { runOpenItem } from "../src/board/run-item.mjs";
import { withDispatch } from "./fixtures/dispatch.mjs";
import { boardFixture } from "./fixtures/board-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD_CLI = resolve(HERE, "..", "bin", "pantheon-board.mjs");
const C = n => String(n).repeat(40).slice(0, 40);
const DIFF = "diff --git a/x.mjs b/x.mjs\n--- a/x.mjs\n+++ b/x.mjs\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 2;\n";
const APPROVE = "```json\n{\"verdict\":\"approve\",\"findings\":[]}\n```";
const approve = async ({ vendor, model }) => ({ text: APPROVE, response_id: `resp_${vendor}_${Math.random()}`, served_model: model });
const CANDIDATE = { id: "review-on-cheaper-band", policy: { version: "pantheon.selection/v1-candidate", hash: "sha256:" + "c".repeat(64), profile: "argo" },
  change: "seat the easy-band reviewer one tier lower" };
const QUESTION = "Does seating reviewers by difficulty band change accepted-result quality or cost?";

/** A ledger that admits a promote of a policy this dispatcher does not implement; returns the disposition hash. */
async function admitForeignPromote(root) {
  const rec = openPantheonLedger({ root }).recorder();
  const change = head => ({ scope: "pantheon", base: C("a"), head, diff: DIFF, files: ["x.mjs"], author_labs: ["anthropic"] });
  const assess = (cycle, over = {}) => rec.recordDisposition({ cycle, outcome: "insufficient_evidence", question: QUESTION,
    provenance: { by: { role: "lead@orch" }, method: "fixture" }, ...over });
  const first = (await reviewCycle({ ledger: rec, change: change(C("b")), turn: approve })).cycle;
  const proposal = assess(first, { outcome: "propose_policy", candidate: CANDIDATE, proposer: { vendor: "openai", model: "gpt-6-sol", lab: "openai" } });
  rec.closeCycle(first);
  const second = (await reviewCycle({ ledger: rec, change: { ...change(C("d")), base: undefined }, turn: approve })).cycle;
  const evidence = rec.recordTurn({ seat: { seat_id: "xai-compare@grok-4.7", vendor: "xai", mode: "compare", occupancy_gen: 1 },
    requested_model: "grok-4.7", served_model: "grok-4.7", response_id: "resp_compare", reply: "synthetic comparison" });
  const promoted = rec.recordDisposition({ cycle: second, stage: "candidate", proposal, outcome: "promote", question: QUESTION, measured: true,
    evidence: [{ kind: "ledger", hash: evidence }], by: { vendor: "xai", model: "grok-4.7", lab: "xai" },
    conditions: { applicability: "argo, fixture", rollback: "retain pantheon.selection/v1", reevaluate: "after 20 tickets" },
    provenance: { by: { role: "check@review" }, method: "fixture" } });
  assess(second);
  rec.closeCycle(second);
  return promoted;
}

test("C3: a loaded practice decision that does not apply is recorded, dispatch continues, and run.json says so at top level", async () => {
  await withDispatch(async ({ dir, spec, opts }) => {
    process.env.OPHANIM_LEDGER = join(dir, "shared-ledger");
    const promoted = await admitForeignPromote(process.env.OPHANIM_LEDGER);
    const r = await runOpenItem(spec("practiceForeign"), opts());
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const run = JSON.parse(readFileSync(join(r.board, "run.json"), "utf8"));
    for (const t of run.turns) {
      assert.equal(t.selection.practice.disposition, promoted);
      assert.equal(t.selection.practice.applies, false, "still recorded applies:false on each selection");
      assert.equal(t.selection.policy, SELECTION_POLICY, "dispatch continued under the policy this dispatcher implements");
    }
    const w = run.practice_warning;
    assert.ok(w, "run.json carries the warning at top level");
    assert.equal(w.code, "PRACTICE_NOT_APPLIED");
    assert.equal(w.disposition, promoted);
    assert.equal(w.loaded_policy.hash, CANDIDATE.policy.hash);
    assert.equal(w.ran_policy.version, SELECTION_POLICY);
    assert.match(w.reason, /not the one this dispatcher implements/);
  });
});

test("C3: pantheon-board run prints a warning naming the loaded disposition hash and why it does not apply", async () => {
  await withDispatch(async ({ dir: repo }) => {
    const { statusRoot, keys } = boardFixture(repo, { item: "practice-item" });
    const ledger = join(repo, "..", `${repo.split("/").pop()}-ledger`);
    try {
      const promoted = await admitForeignPromote(ledger);
      const out = spawnSync(process.execPath, [BOARD_CLI, "run", "practice-item", "--repo", repo, "--status-ledger", statusRoot,
        "--clients", join(repo, "clients.fixture.mjs"), "--turn", join(repo, "turn.fixture.mjs"),
        "--dir", join(repo, "board"), "--out", join(repo, "bundle"), "--checked", "2026-11-18", "--evidence-store", join(repo, "store")],
        { encoding: "utf8", env: { ...process.env, OPHANIM_LEDGER: ledger }, timeout: 120_000 });
      const result = JSON.parse(out.stdout);
      assert.equal(result.shipped, true, `${out.stdout}\n${out.stderr.slice(-2000)}`);
      const line = out.stderr.split("\n").find(l => l.startsWith("warning: PRACTICE_NOT_APPLIED"));
      assert.ok(line, out.stderr.slice(-2000));
      assert.ok(line.includes(promoted), "the warning names the loaded disposition hash");
      assert.match(line, /not the one this dispatcher implements/);
      assert.equal(result.practice_warning.disposition, promoted);
      assert.equal(JSON.parse(readFileSync(join(repo, "board", "run.json"), "utf8")).practice_warning.disposition, promoted);
    } finally { rmSync(keys, { recursive: true, force: true }); rmSync(ledger, { recursive: true, force: true }); }
  });
});
