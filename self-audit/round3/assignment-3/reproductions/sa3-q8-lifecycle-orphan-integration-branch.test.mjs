// SELF-AUDIT A3 Q8 (af0dc30). PASSING = DEFECT PRESENT.
// Finding 8.1 (c64773c) deletes a dead run's integration branch only when runPipeline restarts INTO THE SAME DIRECTORY
// WITH THE SAME run_id (pipeline/index.mjs:248-259). The lifecycle never does that: every implement attempt gets a fresh
// directory (stages.mjs:1025 `pipeline-<attempt>-<now>`) and a fresh random run_id, and its recovery of a killed
// attempt's directory (stages.mjs:1041) is recoverOrphanWorktrees, which removes worktrees, not branches. So a SIGKILLed
// attempt's refs/heads/pantheon/pipeline/<run_id> (with the worker-written units merged on it) is left in the
// repository for good. This test builds exactly the on-disk state a SIGKILL mid-wave leaves (owner.json of a dead pid,
// pipeline.json "running", the integration worktree and branch registered) and runs the lifecycle's recovery on it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverOrphanWorktrees } from "../pantheon/src/pipeline/index.mjs";

const g = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });

test("Q8: a killed lifecycle attempt's integration branch survives the next attempt's recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "sa3-orphan-")), repo = join(root, "repo");
  try {
    g(root, "init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "a.mjs"), "export const ok = false;\n");
    g(repo, "add", "a.mjs"); g(repo, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "base");
    // The killed attempt (attempt 1): its directory under the item's state dir.
    const dead = join(root, "operate", "item", "pipeline-1-1700000000000"), runId = "deadbeef0001";
    mkdirSync(join(dead, "worktrees"), { recursive: true });
    g(repo, "worktree", "add", "-q", "-b", `pantheon/pipeline/${runId}`, join(dead, "worktrees", "_integration"), "HEAD");
    writeFileSync(join(dead, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345, host: "dead", run_id: runId, at: "2026-11-19T00:00:00Z" }) + "\n");
    writeFileSync(join(dead, "pipeline.json"), JSON.stringify({ run_id: runId, status: "running", integration: { branch: `pantheon/pipeline/${runId}` } }) + "\n");
    // Attempt 2 (a fresh directory, a fresh run_id) recovers the dead directory exactly as stages.mjs:1041 does.
    const removed = await recoverOrphanWorktrees({ repo, root: join(dead, "worktrees") });
    assert.ok(removed.length >= 1, "the dead attempt's worktree is removed");
    assert.doesNotMatch(g(repo, "worktree", "list"), /_integration/);
    // THE DEFECT: the branch is still there, and nothing in the lifecycle ever deletes it.
    assert.match(g(repo, "branch", "--list", "pantheon/pipeline/*"), new RegExp(`pantheon/pipeline/${runId}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
