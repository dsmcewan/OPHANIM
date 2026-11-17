// `pantheon-board next` previews the team a ticket's run will seat. It listed the ARGO order for every chair,
// whatever the profile and whatever the ticket; it now calls the dispatch's own selector (selectSeat) on the
// ticket, under the profile (the ticket's task profile under fit). The preview's seats must be the seats the
// run's turns record for the same ticket: checked through the CLI (next --json, then run) on fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { withDispatch } from "./fixtures/dispatch.mjs";
import { boardFixture } from "./fixtures/board-repo.mjs";
import { seatTeam } from "../src/board/operate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD_CLI = resolve(HERE, "..", "bin", "pantheon-board.mjs");
const ROLE = { scout: "scout", plan: "planner", work: "implementer", critique: "reviewer" };
const key = s => `${s.vendor}/${s.model}`;

for (const [profile, extra] of [["argo", []], ["fit", []], ["fit", ["--seat", "implementer=openai/gpt-6-sol"]]]) {
  test(`next's preview is the dispatch's seating: ${profile}${extra.length ? " with an operator seat" : ""}`, async () => {
    await withDispatch(async ({ dir: repo }) => {
      const item = "preview-item";
      const { statusRoot, keys } = boardFixture(repo, { item });
      try {
        const common = ["--repo", repo, "--status-ledger", statusRoot, "--profile", profile, ...extra];
        const next = spawnSync(process.execPath, [BOARD_CLI, "next", "--json", ...common], { encoding: "utf8", env: process.env, timeout: 60_000 });
        assert.equal(next.status, 0, next.stderr);
        const team = JSON.parse(next.stdout).items.find(i => i.item === item).team;
        assert.equal(team.profile, profile);
        const shown = spawnSync(process.execPath, [BOARD_CLI, "next", ...common], { encoding: "utf8", env: process.env, timeout: 60_000 });
        assert.equal(shown.status, 0, shown.stderr);
        assert.match(shown.stdout, new RegExp(`team \\(${profile}: the dispatch's selector on this ticket`));
        assert.ok(shown.stdout.includes(`${team.planner[0].vendor}/${team.planner[0].model}`));
        const preview = [...team.scouts.map(s => ["scout", key(s)]), ["planner", key(team.planner[0])],
          ...team.implementers.map(l => ["implementer", key(l[0])]), ...team.review_panels.flat().map(s => ["reviewer", key(s)])];

        const out = spawnSync(process.execPath, [BOARD_CLI, "run", item, ...common, "--clients", join(repo, "clients.fixture.mjs"),
          "--turn", join(repo, "turn.fixture.mjs"), "--dir", join(repo, "board"), "--out", join(repo, "bundle"), "--checked", "2026-11-18"],
          { encoding: "utf8", env: process.env, timeout: 120_000 });
        assert.equal(JSON.parse(out.stdout).shipped, true, `${out.stdout}\n${out.stderr.slice(-2000)}`);
        const run = JSON.parse(readFileSync(join(repo, "board", "run.json"), "utf8"));
        const dispatched = run.turns.map(t => [ROLE[t.purpose], key(t)]);
        assert.deepEqual(preview, dispatched, "the preview seats exactly what the run's turns record");
        if (profile === "fit") {
          // Under fit the preview carries the class and effort the dispatch's selection recorded.
          const plan = run.turns.find(t => t.purpose === "plan");
          assert.deepEqual([team.planner[0].class, team.planner[0].effort], [plan.selection.class.value, plan.selection.effort.value]);
        }
        if (extra.length) assert.equal(team.implementer[0].operator, true);
      } finally { rmSync(keys, { recursive: true, force: true }); }
    });
  });
}

test("seatTeam differs by profile for the same ticket: the preview is not the ARGO order under fit", () => {
  const spec = { key: "p", repo_root: "/tmp", title: "t", goal: "g", question: "q", copy: [], acceptance_cmd: "true", slot: "a", path: "a.mjs", difficulty: "easy" };
  const argo = seatTeam({ spec, profile: "argo" }), fit = seatTeam({ spec, profile: "fit" });
  assert.notDeepEqual([argo.planner[0], argo.implementer[0]].map(key), [fit.planner[0], fit.implementer[0]].map(key));
  assert.ok(fit.planner[0].class, "a fit preview names the class");
});
