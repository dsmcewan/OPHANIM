// L-126: the review runner (src/review-runner/index.mjs, --via api) added, removed and pruned its disposable worktree
// of the owner's repository WITHOUT the repository lock the pipeline holds (git.mjs repoMutex, L-303). `git worktree
// add` creates <common>/worktrees/<name>/ and only then writes its `gitdir`; a `git worktree prune` by another process
// in between deletes that half-made entry. So a review run and a pipeline run (or its orphan recovery) on one checkout
// could each break the other's worktree.
//
// REAL OS PROCESSES AND REAL GIT, as pipeline-repo-lock.test.mjs: the `git` both children run is a logging wrapper
// around the real git (it changes nothing git does) that can HOLD a named worktree operation (add, remove, prune) at a
// barrier until the parent lets it go. One process is held inside a worktree operation; the other's worktree operation
// must not START until it is let go. The review runner runs its real main() (API mode, a fake fetch, no key); the
// pipeline side runs the real bindWorktree / recoverOrphanWorktrees with their default lock.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { fixtureRepo, sh, mkdtemp, cleanup, LIMITS, FAKE_KEY } from "./review-runner-helper.mjs";

after(cleanup);

const SRC = join(import.meta.dirname, "..", "src");
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms, what) => { for (const end = Date.now() + ms; !cond();) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(10); } };
const imp = f => JSON.stringify(pathToFileURL(join(SRC, f)).href);

/**
 * A `git` (in its own bin dir, one per process tag) that logs "start|end <tag> <pid> <op>" for every worktree operation
 * to `log` and runs the real git. An operation named in `pauseOps` touches <pause>.<op>.in and waits for <pause>.<op>.go
 * before running (the barrier). Its settings are written INTO the script, not read from the environment: the review
 * runner gives its git only PATH, HOME and LANG.
 */
function gitWrapper(root, { tag, log, pause = "", pauseOps = "" }) {
  const bin = join(root, `bin-${tag}`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), `#!/bin/sh
RACE_TAG=${JSON.stringify(tag)}; GITLOG=${JSON.stringify(log)}; GIT_PAUSE=${JSON.stringify(pause)}; GIT_PAUSE_OPS=${JSON.stringify(pauseOps)}
wt=""
for a in "$@"; do if [ "$a" = worktree ]; then wt=1; fi; done
if [ -z "$wt" ]; then exec ${JSON.stringify(REAL_GIT)} "$@"; fi
op=""; seen=""
for a in "$@"; do if [ -n "$seen" ] && [ -z "$op" ]; then op="$a"; fi; if [ "$a" = worktree ]; then seen=1; fi; done
echo "start $RACE_TAG $$ $op" >> "$GITLOG"
case " $GIT_PAUSE_OPS " in *" $op "*) if [ -n "$GIT_PAUSE" ]; then : > "$GIT_PAUSE.$op.in"; while [ ! -e "$GIT_PAUSE.$op.go" ]; do sleep 0.01; done; fi;; esac
${JSON.stringify(REAL_GIT)} "$@"; rc=$?
echo "end $RACE_TAG $$ $op" >> "$GITLOG"
exit $rc
`);
  chmodSync(join(bin, "git"), 0o755);
  return bin;
}

function child(code, env) {
  const c = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { err += d; });
  return { proc: c, done: new Promise(r => c.on("close", code => r({ code, out, err }))) };
}

/** The worktree operations of the log, as intervals; `lines` is the log itself. */
function readLog(log) {
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
  const open = new Map(), done = [];
  lines.forEach((line, i) => {
    const [kind, tag, id, op] = line.split(" ");
    if (kind === "start") open.set(`${tag}:${id}`, { tag, op, start: i });
    else { const o = open.get(`${tag}:${id}`); if (o) done.push({ ...o, end: i }); open.delete(`${tag}:${id}`); }
  });
  return { lines, done, unfinished: [...open.values()] };
}
const crossOverlaps = ops => ops.flatMap((a, i) => ops.filter((b, j) => j > i && a.tag !== b.tag && a.start < b.end && b.start < a.end).map(b => `${a.tag}:${a.op} overlaps ${b.tag}:${b.op}`));
const startedBy = (log, tag) => readLog(log).lines.filter(l => l.startsWith(`start ${tag} `)).map(l => l.split(" ")[3]);

/**
 * The review runner as its own process (tag R): main() in API mode on `repo`, the wrapper first on the PATH the runner
 * gives its git. The fake fetch waits for `fetchGo` (when given) and then fails, so the run ends incomplete and the
 * runner removes and prunes its worktree. Prints {code, stop_reason, cleanup_error} from the transcript.
 */
function runner({ env, repo, log, pause = "", pauseOps = "", fetchGo = null, fetchIn = null }) {
  const out = join(env, "out-R"), tmpBase = join(env, "rr-tmp-R");
  const wrapped = { PATH: `${gitWrapper(env, { tag: "R", log, pause, pauseOps })}:${process.env.PATH}` };
  return child(`
    import fs from "node:fs";
    import { main } from ${imp("review-runner/index.mjs")};
    const fetchGo = ${JSON.stringify(fetchGo)}, fetchIn = ${JSON.stringify(fetchIn)};
    const fetch = async () => {
      if (fetchIn) fs.writeFileSync(fetchIn, "");
      if (fetchGo) while (!fs.existsSync(fetchGo)) await new Promise(r => setTimeout(r, 10));
      throw new Error("offline (test)");
    };
    const env = { ...${JSON.stringify(wrapped)}, OPENAI_API_KEY: ${JSON.stringify(FAKE_KEY)} };
    const code = await main(["--assignment", "2", "--commit", ${JSON.stringify(repo.commit)}, ...${JSON.stringify(LIMITS)}, "--out", ${JSON.stringify(out)}],
      { repoRoot: ${JSON.stringify(repo.root)}, env, fetch, stdout: () => {}, stderr: s => process.stderr.write(s), sleep: async () => {}, tmpBase: ${JSON.stringify(tmpBase)}, cwd: ${JSON.stringify(repo.root)}, copyDependencies: false });
    const t = JSON.parse(fs.readFileSync(${JSON.stringify(join(out, "findings-2-openai.transcript.json"))}, "utf8"));
    process.stdout.write(JSON.stringify({ code, stop_reason: t.stop_reason, cleanup_error: t.worktree_cleanup_error ?? null }));`,
  { ...wrapped });
}

/** The pipeline side as its own process (tag P): bindWorktree (add) or recoverOrphanWorktrees (prune, list, remove). */
function pipeline({ repo, log, op, path, pause = "", pauseOps = "", called }) {
  return child(`
    import fs from "node:fs";
    import { bindWorktree } from ${imp("pipeline/dispatch.mjs")};
    import { recoverOrphanWorktrees } from ${imp("pipeline/index.mjs")};
    const repo = ${JSON.stringify(repo.root)};
    fs.writeFileSync(${JSON.stringify(called)}, "");
    if (${JSON.stringify(op)} === "bind") await bindWorktree({ repo, base: "HEAD", path: ${JSON.stringify(path)} });
    else await recoverOrphanWorktrees({ repo, root: ${JSON.stringify(path)} });`,
  { PATH: `${gitWrapper(join(log, ".."), { tag: "P", log, pause, pauseOps })}:${process.env.PATH}` });
}

async function setup() {
  const repo = await fixtureRepo();
  const env = await mkdtemp(join(tmpdir(), "rr-lock-"));
  const log = join(env, "git.log");
  writeFileSync(log, "");
  return { repo, env, log };
}
/** Wait `ms` for process `tag` to start any worktree operation; returns the operations it started. */
async function watch(log, tag, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end && !startedBy(log, tag).length;) await sleep(20);
  return startedBy(log, tag);
}
const release = (pause, op) => writeFileSync(`${pause}.${op}.go`, "");
const killer = (...cs) => () => { for (const c of cs) if (c && c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill("SIGKILL"); };
const parse = r => { try { return JSON.parse(r.out); } catch { return { raw: r.out, err: r.err.slice(0, 1500) }; } };

test("L-126: while the review runner is held inside its `git worktree add`, a pipeline process's orphan recovery (prune, list, remove) does not start; both finish and the runner's worktree was registered whole", { timeout: 120_000 }, async t => {
  const s = await setup();
  const pause = join(s.env, "pause-r"), fetchIn = join(s.env, "fetch-in"), fetchGo = join(s.env, "fetch-go"), called = join(s.env, "p-called");
  const orphans = join(s.env, "orphans"); mkdirSync(join(orphans, "left"), { recursive: true });
  const r = runner({ env: s.env, repo: s.repo, log: s.log, pause, pauseOps: "add", fetchIn, fetchGo });
  let p = null;
  t.after(() => { for (const op of ["add"]) release(pause, op); writeFileSync(fetchGo, ""); killer(r, p)(); });
  await until(() => existsSync(`${pause}.add.in`), 60_000, "the runner inside its git worktree add");
  p = pipeline({ repo: s.repo, log: s.log, op: "recover", path: orphans, called });
  await until(() => existsSync(called), 30_000, "the pipeline process calling its recovery");
  const pWhileHeld = await watch(s.log, "P");
  release(pause, "add");
  // The runner's worktree exists now; it is still registered while the runner waits in its provider call.
  await until(() => existsSync(fetchIn), 60_000, "the runner reaching its provider call");
  const listed = await sh("git", ["-C", s.repo.root, "worktree", "list", "--porcelain"]);
  writeFileSync(fetchGo, "");
  const [rr, rp] = await Promise.all([r.done, p.done]);
  assert.deepEqual(pWhileHeld, [], "the pipeline process started a worktree operation while the review runner was held inside its git worktree add");
  assert.equal(rp.code, 0, rp.err);
  const out = parse(rr);
  assert.equal(rr.code, 0, rr.err);
  assert.equal(out.code, 3, JSON.stringify(out));
  assert.match(out.stop_reason, /network error: offline/, "the run ended at its provider call, not at a runner error (a broken worktree add)");
  assert.equal(out.cleanup_error, null);
  assert.match(listed, /\/worktree\n/, "the runner's worktree was registered whole (no prune removed its half-made entry)");
  const ops = readLog(s.log);
  assert.deepEqual(ops.unfinished, []);
  assert.deepEqual(crossOverlaps(ops.done), [], "no worktree operation of one process overlaps one of the other");
  assert.deepEqual([...new Set(ops.done.map(o => `${o.tag}:${o.op}`))].sort(), ["P:list", "P:prune", "R:add", "R:prune", "R:remove"]);
  assert.equal((await sh("git", ["-C", s.repo.root, "worktree", "list"])).trim().split("\n").length, 1, "the runner removed its worktree");
});

test("L-126: while a pipeline process is held inside its `git worktree add` (bindWorktree), the review runner's worktree add does not start", { timeout: 120_000 }, async t => {
  const s = await setup();
  const pause = join(s.env, "pause-p"), called = join(s.env, "p-called");
  const p = pipeline({ repo: s.repo, log: s.log, op: "bind", path: join(s.env, "unit-wt"), pause, pauseOps: "add", called });
  let r = null;
  t.after(() => { release(pause, "add"); killer(p, r)(); });
  await until(() => existsSync(`${pause}.add.in`), 30_000, "the pipeline process inside its git worktree add");
  r = runner({ env: s.env, repo: s.repo, log: s.log });
  // The runner builds its plan first (read-only git); give it ample time to reach and START its worktree add.
  const rWhileHeld = await watch(s.log, "R", 8000);
  release(pause, "add");
  const [rp, rr] = await Promise.all([p.done, r.done]);
  assert.deepEqual(rWhileHeld, [], "the review runner started a worktree operation while a pipeline process was held inside its git worktree add");
  assert.equal(rp.code, 0, rp.err);
  const out = parse(rr);
  assert.equal(rr.code, 0, rr.err);
  assert.deepEqual([out.code, out.cleanup_error], [3, null], JSON.stringify(out));
  assert.match(out.stop_reason, /network error: offline/);
  const ops = readLog(s.log);
  assert.deepEqual(ops.unfinished, []);
  assert.deepEqual(crossOverlaps(ops.done), []);
  assert.deepEqual(ops.done.map(o => `${o.tag}:${o.op}`), ["P:add", "R:add", "R:remove", "R:prune"]);
});

test("L-126: the review runner holds the lock through its `worktree remove` AND its `worktree prune`: a pipeline process's worktree add starts during neither", { timeout: 120_000 }, async t => {
  const s = await setup();
  const pr = join(s.env, "pause-r"), pp = join(s.env, "pause-p"), called = join(s.env, "p-called");
  const r = runner({ env: s.env, repo: s.repo, log: s.log, pause: pr, pauseOps: "remove prune" });
  let p = null;
  t.after(() => { for (const op of ["remove", "prune"]) release(pr, op); release(pp, "add"); killer(r, p)(); });
  await until(() => existsSync(`${pr}.remove.in`), 60_000, "the runner inside its git worktree remove");
  p = pipeline({ repo: s.repo, log: s.log, op: "bind", path: join(s.env, "unit-wt"), pause: pp, pauseOps: "add", called });
  await until(() => existsSync(called), 30_000, "the pipeline process calling bindWorktree");
  const duringRemove = await watch(s.log, "P");
  release(pr, "remove");
  await until(() => existsSync(`${pr}.prune.in`), 30_000, "the runner inside its git worktree prune");
  const duringPrune = await watch(s.log, "P");
  release(pr, "prune");
  await until(() => existsSync(`${pp}.add.in`), 30_000, "the pipeline process reaching its worktree add once the runner let go");
  release(pp, "add");
  const [rr, rp] = await Promise.all([r.done, p.done]);
  assert.deepEqual(duringRemove, [], "a pipeline worktree add started while the review runner was inside its git worktree remove");
  assert.deepEqual(duringPrune, [], "a pipeline worktree add started while the review runner was inside its git worktree prune");
  assert.equal(rp.code, 0, rp.err);
  const out = parse(rr);
  assert.equal(rr.code, 0, rr.err);
  assert.deepEqual([out.code, out.cleanup_error], [3, null], JSON.stringify(out));
  const ops = readLog(s.log);
  assert.deepEqual(ops.unfinished, []);
  assert.deepEqual(crossOverlaps(ops.done), []);
  assert.deepEqual(ops.done.map(o => `${o.tag}:${o.op}`), ["R:add", "R:remove", "R:prune", "P:add"]);
  assert.match(await sh("git", ["-C", s.repo.root, "worktree", "list", "--porcelain"]), /unit-wt\n/, "the pipeline's worktree is registered whole");
});
