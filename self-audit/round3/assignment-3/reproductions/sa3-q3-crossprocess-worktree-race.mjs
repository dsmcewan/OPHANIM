// SELF-AUDIT A3 Q3 probe (af0dc30): repoMutex (pipeline/index.mjs:632) is an IN-PROCESS lock. Two scheduler
// processes running pipelines on one repository do worktree add/remove/prune and branch create/delete with no
// cross-process lock. This probe runs N concurrent processes doing the same git operations runPipeline does
// (worktree add -b, worktree remove --force, worktree prune, branch -D) and counts git failures.
// Usage: node .review-tests/sa3-q3-crossprocess-worktree-race.mjs   (prints {failures, samples})
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.argv[2] === "child") {
  const [repo, id, n] = process.argv.slice(3);
  const g = (...a) => { try { execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "ignore", "pipe"] }); return null; } catch (e) { return String(e.stderr).trim().split("\n")[0]; } };
  const fails = [];
  for (let i = 0; i < Number(n); i++) {
    const wt = join(repo, "..", `wt-${id}-${i}`), br = `pantheon/pipeline/${id}-${i}`;
    for (const r of [g("worktree", "add", "-q", "-b", br, wt, "HEAD"), g("worktree", "prune"), g("worktree", "remove", "--force", wt), g("worktree", "prune"), g("branch", "-D", br)]) if (r) fails.push(r);
  }
  process.stdout.write(JSON.stringify(fails));
} else {
  const root = mkdtempSync(join(tmpdir(), "sa3-wt-")), repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a"), "a\n");
  execFileSync("git", ["-C", repo, "add", "a"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "a"]);
  const kids = Array.from({ length: 4 }, (_, k) => new Promise(r => { let out = ""; const c = spawn(process.execPath, [process.argv[1], "child", repo, `p${k}`, "25"]); c.stdout.on("data", d => out += d); c.on("close", () => r(JSON.parse(out || "[]"))); }));
  const all = (await Promise.all(kids)).flat();
  console.log(JSON.stringify({ failures: all.length, samples: [...new Set(all)].slice(0, 5) }));
  rmSync(root, { recursive: true, force: true });
}
