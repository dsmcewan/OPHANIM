// L-304 (self-audit round 3, assignment 3 (sealed bb1287a)): a killed lifecycle attempt's integration branch
// (refs/heads/pantheon/pipeline/<run_id>) was never deleted. recoverDeadRunBranch (pipeline/index.mjs), which the
// implement stage's recovery calls for every earlier attempt's run directory, deletes it ONLY for a run that died before
// it ended -- never a live run's, never a finished run's, never a ref the record merely names. The lifecycle path is in
// ophanim/operate/reliability-wave2b.test.mjs; these are the guards, on real runs (a SIGKILLed process, a live one).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { hostname } from "node:os";
import { runPipeline, recoverDeadRunBranch, recoverOrphanWorktrees } from "../src/pipeline/index.mjs";
import { tempRepo, seats, unit, scripted, sh, PLANNER } from "./fixtures/pipeline-stages.mjs";

const url = f => JSON.stringify(pathToFileURL(join(import.meta.dirname, f)).href);
const has = async (repo, b) => (await sh(`git branch --list ${JSON.stringify(b)}`, repo)).trim() !== "";
const until = async (cond, ms, what) => { for (const end = Date.now() + ms; !(await cond());) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 25)); } };

/** A run in a real child process, its implementer in flight (it never answers). Returns {child, dir, closed}. */
async function inFlight(env, name) {
  const dir = join(env.root, name);
  const code = `import { runPipeline } from ${url("../src/pipeline/index.mjs")};
    import { seats, unit, scripted, PLANNER } from ${url("./fixtures/pipeline-stages.mjs")};
    setInterval(() => {}, 1000);
    const plan = [unit("a")];
    await runPipeline({ repo: ${JSON.stringify(env.repo)}, base: "main", plan: { work_units: plan }, seats: seats(), turns: scripted({ plan, implement: () => new Promise(() => {}) }).turns, dir: ${JSON.stringify(dir)}, planner: PLANNER });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" });
  const closed = new Promise(r => child.on("close", r));
  await until(async () => existsSync(join(dir, "pipeline.json")) && JSON.parse(readFileSync(join(dir, "pipeline.json"), "utf8")).integration?.branch, 30_000, `${name}'s integration branch`).catch(e => { child.kill("SIGKILL"); throw e; });
  return { child, dir, closed, branch: JSON.parse(readFileSync(join(dir, "pipeline.json"), "utf8")).integration.branch };
}

test("L-304 (self-audit round 3, assignment 3 (sealed bb1287a)): a SIGKILLed run's branch is deleted; a LIVE run's is not; a FINISHED run's is not", { timeout: 120_000 }, async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const dead = await inFlight(env, "dead");
  dead.child.kill("SIGKILL"); await dead.closed;
  const live = await inFlight(env, "live");
  t.after(() => live.child.kill("SIGKILL"));
  const failing = [unit("z", { verify_cmd: "false" })];
  const done = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: failing }, seats: seats(), turns: scripted({ plan: failing }).turns, dir: join(env.root, "done"), planner: PLANNER, limits: { max_revisions: 0 } });
  assert.equal(done.status, "incomplete");
  for (const b of [dead.branch, live.branch, done.integration.branch]) assert.ok(await has(env.repo, b), b);
  // While the dead run's integration worktree is still registered, git refuses to delete the branch checked out there.
  const early = await recoverDeadRunBranch({ repo: env.repo, dir: dead.dir });
  assert.equal(early.deleted, false);
  assert.match(early.why, /checked out|used by worktree/);
  // The stage's recovery removes the dead run's worktrees first (recoverOrphanWorktrees), then its branch.
  await recoverOrphanWorktrees({ repo: env.repo, root: join(dead.dir, "worktrees") });
  const r = await Promise.all([dead.dir, live.dir, join(env.root, "done")].map(dir => recoverDeadRunBranch({ repo: env.repo, dir })));
  assert.deepEqual(r.map(x => x.deleted), [true, false, false]);
  assert.match(r[1].why, new RegExp(`held by a live run \\(pid ${live.child.pid} on `));
  assert.match(r[2].why, /the run ended incomplete: its branch is kept/);
  assert.deepEqual(await Promise.all([dead.branch, live.branch, done.integration.branch].map(b => has(env.repo, b))), [false, true, true]);
});

test("L-304: a dead run's record cannot name another ref: a run_id that is not plain characters deletes nothing", { timeout: 60_000 }, async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  await sh("git branch pantheon/pipeline/other/keep", env.repo);
  const gone = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
  const { mkdirSync } = await import("node:fs");
  const dir = join(env.root, "forged"); mkdirSync(dir);
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: gone, host: hostname(), run_id: "other/keep" }));
  writeFileSync(join(dir, "pipeline.json"), JSON.stringify({ run_id: "other/keep", status: "running", integration: { branch: "pantheon/pipeline/other/keep" } }));
  const r = await recoverDeadRunBranch({ repo: env.repo, dir });
  assert.deepEqual([r.deleted, r.why], [false, "no run id is recorded"]);
  assert.ok(await has(env.repo, "pantheon/pipeline/other/keep"));
});
