// The seating report of a run is what the selector chose per role, not the legacy SEATING table: under `fit`
// each row carries the class and the effort the profile mapped, read from the selection the turn ran under.
// Through the real dispatcher and the board CLI on fakes (fixtures/dispatch.mjs, fixtures/board-repo.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runOpenItem, seatingOf } from "../src/board/run-item.mjs";
import { seatingPlan } from "../src/role/seating.mjs";
import { withDispatch } from "./fixtures/dispatch.mjs";
import { boardFixture } from "./fixtures/board-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD_CLI = resolve(HERE, "..", "bin", "pantheon-board.mjs");
const ROLE = { scout: "scout", plan: "planner", work: "implementer", critique: "reviewer" };

test("fit: run.json's seating report is the selector's choice per role, with class and effort", async () => {
  await withDispatch(async ({ spec, opts }) => {
    const r = await runOpenItem(spec("seatingFit"), opts({ profile: "fit" }));
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const run = JSON.parse(readFileSync(join(r.board, "run.json"), "utf8"));
    assert.ok(Array.isArray(run.seating) && run.seating.length, "the run carries its seating report");
    const expected = [...new Map(run.turns.map(t => [`${ROLE[t.purpose]}|${t.vendor}|${t.model}`, t])).values()];
    assert.deepEqual(run.seating.map(x => [x.role, x.vendor, x.model]), expected.map(t => [ROLE[t.purpose], t.vendor, t.model]));
    for (const [i, row] of run.seating.entries()) {
      const sel = expected[i].selection;
      assert.equal(row.profile, "fit");
      assert.equal(row.source, sel.source);
      assert.equal(row.class, sel.class.value, `${row.role}: the class the selector chose`);
      assert.equal(row.effort, sel.effort.value, `${row.role}: the effort the profile mapped`);
      assert.match(row.line, new RegExp(`class=${row.class} effort=${row.effort ?? "-"}`));
    }
    // Not the legacy table: under fit the planner it reports is the fit selector's, whatever SEATING's first rung is.
    const legacy = seatingPlan({ roles: ["planner", "implementer", "reviewer"] }).assigned;
    const reported = Object.fromEntries(run.seating.map(x => [x.role, x]));
    for (const role of ["planner", "implementer", "reviewer"]) assert.ok(reported[role], `${role} is reported`);
    assert.ok(["planner", "implementer", "reviewer"].some(role => `${reported[role].vendor}/${reported[role].model}` !== `${legacy[role].vendor}/${legacy[role].model}`),
      "on this ticket fit seats differently from the legacy table, and the report shows fit's seats");
    assert.deepEqual(seatingOf(run), run.seating);
  });
});

test("pantheon-board run --profile fit prints the selector's seating with class and effort", async () => {
  await withDispatch(async ({ dir: repo }) => {
    const { statusRoot, keys } = boardFixture(repo, { item: "seating-item" });
    try {
      const out = spawnSync(process.execPath, [BOARD_CLI, "run", "seating-item", "--repo", repo, "--status-ledger", statusRoot, "--profile", "fit",
        "--clients", join(repo, "clients.fixture.mjs"), "--turn", join(repo, "turn.fixture.mjs"),
        "--dir", join(repo, "board"), "--out", join(repo, "bundle"), "--checked", "2026-11-18"], { encoding: "utf8", env: process.env, timeout: 120_000 });
      const result = JSON.parse(out.stdout);
      assert.equal(result.shipped, true, `${out.stdout}\n${out.stderr.slice(-2000)}`);
      const run = JSON.parse(readFileSync(join(repo, "board", "run.json"), "utf8"));
      assert.match(out.stderr, /Seating \(fit; what the selector chose\):/);
      for (const row of run.seating) assert.ok(out.stderr.includes(row.line), `printed: ${row.line}`);
      assert.deepEqual(result.seating.map(x => [x.role, x.vendor, x.model, x.class, x.effort]), run.seating.map(x => [x.role, x.vendor, x.model, x.class, x.effort]));
    } finally { rmSync(keys, { recursive: true, force: true }); }
  });
});
