// Q7 (measurement): chair contributions are derived from a real board and checkable by recomputing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openBoard } from "../src/board/index.mjs";
import { runOpenItem } from "../src/board/run-item.mjs";
import { chairContributions, verifyChairContributions } from "../src/board/contributions.mjs";
import { withPipeline } from "./fixtures/pipeline.mjs";

test("a refused-then-revised ticket yields the contributions its board records", async () => {
  await withPipeline(async ({ repo, opts, implement }) => {
    writeFileSync(join(repo, "alpha.mjs"), "export const ok = false;\n");
    writeFileSync(join(repo, "beta.mjs"), "export const ok = false;\n");
    writeFileSync(join(repo, "verify.mjs"), 'import assert from "node:assert/strict"; import {ok as a} from "./alpha.mjs"; import {ok as b} from "./beta.mjs"; assert.equal(a && b, true);');
    implement(prompt => /Your revision/.test(prompt) ? "export const ok = true;\n" : "export const ok = false;\n");
    const spec = { key: "contribKey", repo_root: repo, title: "two files", goal: "both pass", question: "fixture",
      copy: ["alpha.mjs", "beta.mjs", "verify.mjs"], acceptance_cmd: "node verify.mjs",
      slots: [{ slot: "alpha", path: "alpha.mjs" }, { slot: "beta", path: "beta.mjs" }] };
    const first = await runOpenItem(spec, opts);
    assert.equal(first.shipped, false);
    // The first run's review recorded `stop` for the Astra seat (no documented effort dial, no higher rung).
    // A stop is terminal (audit M2); retrying the same seat is its own explicit, recorded action.
    const second = await runOpenItem(spec, { ...opts, resume: first.board, retryStopped: "fixture: retry the same seat once" });
    assert.equal(second.shipped, true, JSON.stringify(second.error));

    const board = openBoard(second.board);
    const p = chairContributions(board);
    const chair = name => p.chairs.find(c => c.chair === name);
    assert.deepEqual(chair("impl@build").metrics.slots,
      [{ slot: "alpha", revisions: 2, firstGreenRevision: 2 }, { slot: "beta", revisions: 2, firstGreenRevision: 2 }]);
    assert.equal(chair("impl@build").metrics.rework, 2, "one extra revision per slot");
    assert.deepEqual(chair("check@review").metrics.verdicts, { approve: 2, request_changes: 2 });
    assert.equal(chair("check@review").metrics.rework, 0, "no approval of bytes whose acceptance failed");
    assert.equal(chair("lead@orch").metrics.plans, 1);
    assert.ok(p.chairs.every(c => c.metrics.reseats === 0 && c.metrics.occupancy.inconsistent.length === 0));
    assert.deepEqual(chair("impl@build").occupants.map(o => `${o.vendor}/${o.model}`), ["openai/gpt-6-astra"]);
    assert.equal(p.limits.authorizesSeatChange, false);

    // Checkable by recomputation, and only against the board it describes.
    assert.equal(verifyChairContributions(p, board).ok, true);
    const forged = structuredClone(p); forged.chairs[1].metrics.rework = 0;
    assert.throws(() => verifyChairContributions(forged, board), /differ from the board/);
    // OPHANIM's ranking of this projection is checked on OPHANIM's side (Pantheon does not import it):
    // ophanim/efficiency/investigation/chairs-board.test.mjs.
  });
});
