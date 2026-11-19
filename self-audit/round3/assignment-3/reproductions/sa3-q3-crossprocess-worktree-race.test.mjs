// SELF-AUDIT A3 Q3 (af0dc30). PASSING = DEFECT PRESENT (probabilistic: up to 10 rounds; observed ~1 in 3 rounds here).
// repoMutex (pantheon/src/pipeline/index.mjs:632-638) is an IN-PROCESS lock (a Map in module scope). Two scheduler
// processes on one repository (the service and `ophanim operate tick`, the service and live-run.mjs on the same
// checkout, two services on two work ledgers) run worktree add/remove/prune and integration-branch create/delete with
// no cross-process lock. A `git worktree prune` from one process (recoverOrphanWorktrees, releaseWorktree's fallback)
// races another's `worktree add`: observed "fatal: could not open '.git/worktrees/<wt>/gitdir' for writing". The
// pipeline turns that into GIT_FAILED: a failed unit or run, and a spent stage attempt.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const probe = join(dirname(fileURLToPath(import.meta.url)), "sa3-q3-crossprocess-worktree-race.mjs");

test("Q3: concurrent processes doing the pipeline's worktree operations on one repository collide", { timeout: 600_000 }, () => {
  const seen = [];
  for (let round = 0; round < 10; round++) {
    const out = JSON.parse(execFileSync(process.execPath, [probe], { encoding: "utf8" }).trim());
    seen.push(out);
    if (out.failures > 0) break;
  }
  const hit = seen.find(s => s.failures > 0);
  assert.ok(hit, `no collision in ${seen.length} rounds`);
  console.log(JSON.stringify({ rounds: seen.length, collision: hit }));
});
