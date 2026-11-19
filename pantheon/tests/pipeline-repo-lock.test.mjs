// L-303 (self-audit round 3, assignment 3 (sealed bb1287a)): there was no cross-process repository lock. repoMutex
// serialised worktree add/remove/prune within ONE process, so two processes on one checkout (the service and an
// `operate tick`, or two ticks) mutated <repo>/.git/worktrees at once and collided ("could not open
// .git/worktrees/<wt>/gitdir"). Every worktree mutation now runs under <git common dir>/pantheon-worktrees.lock.
//
// REAL OS PROCESSES. The race the self-audit reproduced is probabilistic, so the core test is made deterministic with a
// BARRIER: the `git` the children run is a logging wrapper around the real git (it changes nothing git does), and one
// process is held INSIDE its `git worktree add` until the parent lets it go. A second process's worktree mutation must
// not start before the first one ends. The interleaving is then repeated, and two whole pipeline runs race on one
// repository with every worktree operation widened, to show the class (add, remove, prune; unit and integration
// worktrees; orphan recovery) is covered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { repoMutex, withFileLock, staleHolder, processStart, gitCommonDir, breakStale } from "../src/pipeline/git.mjs";
import { tempRepo, sh } from "./fixtures/pipeline-stages.mjs";

const SRC = join(import.meta.dirname, "..", "src", "pipeline");
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms, what) => { for (const end = Date.now() + ms; !cond();) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(10); } };

/**
 * A `git` that logs "start|end <tag> <seq> <subcommand>" for every worktree operation to $GITLOG and runs the real git.
 * With $GIT_PAUSE set, a `worktree add` touches $GIT_PAUSE.in and waits for $GIT_PAUSE.go first (the barrier); with
 * $GIT_WIDEN set, every worktree operation sleeps that long inside (to widen a race window, never to decide it).
 */
function gitWrapper(root) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), `#!/bin/sh
wt=""
for a in "$@"; do if [ "$a" = worktree ]; then wt=1; fi; done
if [ -z "$wt" ]; then exec ${JSON.stringify(REAL_GIT)} "$@"; fi
op=""; seen=""
for a in "$@"; do if [ -n "$seen" ] && [ -z "$op" ]; then op="$a"; fi; if [ "$a" = worktree ]; then seen=1; fi; done
id="$$"
echo "start $RACE_TAG $id $op" >> "$GITLOG"
if [ -n "$GIT_PAUSE" ] && [ "$op" = add ]; then : > "$GIT_PAUSE.in"; while [ ! -e "$GIT_PAUSE.go" ]; do sleep 0.01; done; fi
if [ -n "$GIT_WIDEN" ]; then sleep "$GIT_WIDEN"; fi
${JSON.stringify(REAL_GIT)} "$@"; rc=$?
echo "end $RACE_TAG $id $op" >> "$GITLOG"
exit $rc
`);
  chmodSync(join(bin, "git"), 0o755);
  return bin;
}

/** Spawn a node child running `code` (an ES module) with the wrapper first on PATH. Resolves {code, out, err}. */
function child(code, env) {
  const c = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { err += d; });
  return { proc: c, done: new Promise(r => c.on("close", code => r({ code, out, err }))) };
}
const imp = f => JSON.stringify(pathToFileURL(join(SRC, f)).href);

/** The worktree operations of the log, as intervals per (tag, id). */
function intervals(log) {
  const open = new Map(), out = [];
  readFileSync(log, "utf8").split("\n").filter(Boolean).forEach((line, i) => {
    const [kind, tag, id, op] = line.split(" ");
    if (kind === "start") open.set(`${tag}:${id}`, { tag, op, start: i });
    else { const o = open.get(`${tag}:${id}`); out.push({ ...o, end: i }); open.delete(`${tag}:${id}`); }
  });
  return { done: out, unfinished: [...open.values()] };
}
/** Pairs of worktree operations of DIFFERENT processes that overlap in the log's order. */
const crossOverlaps = ops => ops.flatMap((a, i) => ops.filter((b, j) => j > i && a.tag !== b.tag && a.start < b.end && b.start < a.end).map(b => `${a.tag}:${a.op} overlaps ${b.tag}:${b.op}`));

// ---- the deterministic barrier ---------------------------------------------------------------------------------------

/**
 * One interleaving: process A binds a worktree and is held inside its `git worktree add`; process B then, on the same
 * repository, either recovers an orphan root (`op` "recover": `git worktree prune`, `list`, `remove`) or releases a
 * unit worktree (`op` "release": `git worktree remove`). Both use the functions' DEFAULT lock, as any caller that
 * passes none does. Returns what was observed.
 */
async function barrierRound(env, k, op = "recover") {
  const log = join(env.root, `git-${k}.log`), pause = join(env.root, `pause-${k}`), bin = gitWrapper(env.root);
  writeFileSync(log, "");
  const orphans = join(env.root, `orphans-${k}`);
  mkdirSync(join(orphans, "left"), { recursive: true });
  const base = { PATH: `${bin}:${process.env.PATH}`, GITLOG: log };
  const released = join(env.root, `wt-b-${k}`);
  if (op === "release") await sh(`git worktree add -q --detach ${JSON.stringify(released)} HEAD`, env.repo);
  const a = child(`
    import { bindWorktree } from ${imp("dispatch.mjs")};
    const repo = ${JSON.stringify(env.repo)};
    await bindWorktree({ repo, base: "HEAD", path: ${JSON.stringify(join(env.root, `wt-a-${k}`))} });`,
  { ...base, RACE_TAG: "A", GIT_PAUSE: pause });
  // A failed wait never leaves a child held at the barrier: it is released and killed.
  const abandon = (...cs) => e => { writeFileSync(`${pause}.go`, ""); for (const c of cs) c.proc.kill("SIGKILL"); throw e; };
  await until(() => existsSync(`${pause}.in`), 30_000, "process A inside its git worktree add").catch(abandon(a));
  const called = join(env.root, `b-called-${k}`);
  const b = child(`
    import fs from "node:fs";
    import { recoverOrphanWorktrees } from ${imp("index.mjs")};
    import { releaseWorktree } from ${imp("dispatch.mjs")};
    const repo = ${JSON.stringify(env.repo)};
    fs.writeFileSync(${JSON.stringify(called)}, "");
    if (${JSON.stringify(op)} === "release") await releaseWorktree({ repo, path: ${JSON.stringify(released)} });
    else await recoverOrphanWorktrees({ repo, root: ${JSON.stringify(orphans)} });`,
  { ...base, RACE_TAG: "B" });
  await until(() => existsSync(called), 30_000, "process B calling the recovery").catch(abandon(a, b));
  // B has called it. Give it ample time to START a worktree operation while A is held inside its add: without a lock
  // that spans processes it starts within milliseconds; with one it cannot start at all until A's add ends.
  for (const end = Date.now() + 2000; Date.now() < end && !intervals(log).unfinished.concat(intervals(log).done).some(o => o.tag === "B");) await sleep(20);
  const bStartedWhileAHeld = readFileSync(log, "utf8").split("\n").some(l => l.startsWith("start B "));
  writeFileSync(`${pause}.go`, "");
  const [ra, rb] = await Promise.all([a.done, b.done]);
  return { ra, rb, bStartedWhileAHeld, ops: intervals(log), listed: await sh("git worktree list --porcelain", env.repo) };
}

test("L-303 (self-audit round 3, assignment 3 (sealed bb1287a)): a second PROCESS cannot mutate the worktree list while the first is inside its git worktree add (barrier)", { timeout: 120_000 }, async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const r = await barrierRound(env, 0);
  assert.equal(r.ra.code, 0, r.ra.err); assert.equal(r.rb.code, 0, r.rb.err);
  assert.equal(r.bStartedWhileAHeld, false, "process B started a worktree operation while process A was held inside its git worktree add");
  assert.deepEqual(r.ops.unfinished, []);
  assert.deepEqual(crossOverlaps(r.ops.done), [], "no worktree operation of one process overlaps one of the other");
  assert.deepEqual([...new Set(r.ops.done.map(o => `${o.tag}:${o.op}`))].sort(), ["A:add", "B:list", "B:prune"], "both processes did run their worktree operations");
  assert.match(r.listed, new RegExp(`worktree ${join(env.root, "wt-a-0").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`), "A's worktree is registered whole (B's prune did not remove its half-made entry)");
});

test("L-303: the barrier interleaving, repeated 6 times on one repository (B releasing a unit worktree, then recovering orphans, in turn), never lets the two processes overlap", { timeout: 300_000 }, async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const seen = [];
  for (let k = 1; k <= 6; k++) {
    const op = k % 2 ? "release" : "recover";
    const r = await barrierRound(env, k, op);
    seen.push([k, op, r.ra.code, r.rb.code, r.bStartedWhileAHeld, crossOverlaps(r.ops.done).length, r.ops.unfinished.length, r.ops.done.some(o => o.tag === "B" && o.op === (op === "release" ? "remove" : "prune"))]);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6].map(k => [k, k % 2 ? "release" : "recover", 0, 0, false, 0, 0, true]));
});

// ---- whole pipeline runs, racing --------------------------------------------------------------------------------------

test("L-303: two runPipeline PROCESSES on one repository (4 units each, all at once, every worktree operation widened) never interleave a worktree mutation, 3 rounds", { timeout: 300_000 }, async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const bin = gitWrapper(env.root);
  const fixtures = JSON.stringify(pathToFileURL(join(import.meta.dirname, "fixtures", "pipeline-stages.mjs")).href);
  const rounds = [];
  for (let k = 0; k < 3; k++) {
    const log = join(env.root, `run-${k}.log`), go = join(env.root, `go-${k}`);
    writeFileSync(log, "");
    const run = tag => child(`
      import fs from "node:fs";
      import { runPipeline } from ${imp("index.mjs")};
      import { seats, unit, scripted, PLANNER } from ${fixtures};
      const plan = ["a", "b", "c", "d"].map(id => unit(${JSON.stringify(tag)}.toLowerCase() + id));
      while (!fs.existsSync(${JSON.stringify(go)})) await new Promise(r => setTimeout(r, 2));
      const out = await runPipeline({ repo: ${JSON.stringify(env.repo)}, base: "main", plan: { work_units: plan }, seats: seats(), turns: scripted({ plan }).turns,
        dir: ${JSON.stringify(join(env.root, `run-${k}`))} + "-" + ${JSON.stringify(tag)}, planner: PLANNER, limits: { max_concurrent_units: 4 } });
      process.stdout.write(JSON.stringify({ status: out.status, reason: out.reason, units: Object.values(out.units).map(u => [u.unit_id, u.status, u.reason]) }));`,
    { PATH: `${bin}:${process.env.PATH}`, GITLOG: log, RACE_TAG: tag, GIT_WIDEN: "0.03" });
    const a = run("P"), b = run("Q");
    await sleep(300);
    writeFileSync(go, "");
    const [ra, rb] = await Promise.all([a.done, b.done]);
    const ops = intervals(log);
    rounds.push({ k, codes: [ra.code, rb.code], status: [ra.out, rb.out].map(o => { try { return JSON.parse(o).status; } catch { return o; } }), overlaps: crossOverlaps(ops.done), ops: ops.done.length, errs: [ra.err, rb.err].join("").slice(0, 500) });
  }
  for (const r of rounds) {
    assert.deepEqual(r.codes, [0, 0], r.errs);
    assert.deepEqual(r.status, ["completed", "completed"], JSON.stringify(r));
    assert.deepEqual(r.overlaps, [], `round ${r.k}: worktree mutations of the two processes overlapped`);
    assert.ok(r.ops >= 2 * (1 + 4 * 2), `round ${r.k}: each run added and removed its integration and unit worktrees (${r.ops} operations logged)`);
  }
  assert.doesNotMatch(await sh("git worktree list --porcelain", env.repo), /run-\d-[PQ]/, "every run's worktrees are gone");
});

// ---- the lock itself ----------------------------------------------------------------------------------------------------

test("L-303: the lock lives in the git common directory, so a linked worktree of the repository takes the SAME lock", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const linked = join(env.root, "linked");
  await sh(`git worktree add -q --detach ${JSON.stringify(linked)} HEAD`, env.repo);
  assert.equal(await gitCommonDir(linked), await gitCommonDir(env.repo));
  assert.equal(await repoMutex(linked).file(), join(await gitCommonDir(env.repo), "pantheon-worktrees.lock"));
  assert.equal(await repoMutex(linked).file(), await repoMutex(env.repo).file());
});

test("L-303: a lock left by a SIGKILLed holder process is recovered; a live holder in another process is waited for, then named by REPO_LOCK_TIMEOUT", { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "repo-lock-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "x.lock"), held = join(root, "held");
  const holder = child(`
    import fs from "node:fs";
    import { withFileLock } from ${imp("git.mjs")};
    setInterval(() => {}, 1000);   // alive until killed
    await withFileLock(${JSON.stringify(file)}, async () => { fs.writeFileSync(${JSON.stringify(held)}, String(process.pid)); await new Promise(() => {}); });`, {});
  t.after(() => { if (holder.proc.exitCode === null && holder.proc.signalCode === null) holder.proc.kill("SIGKILL"); });   // never left running by a failed assertion
  await until(() => existsSync(held), 30_000, "the holder taking the lock");
  const pid = Number(readFileSync(held, "utf8"));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, pid);
  // Live: waited for, then refused with the holder named.
  await assert.rejects(() => withFileLock(file, async () => "never", { timeout_ms: 300 }), e => e.code === "REPO_LOCK_TIMEOUT" && e.holder.pid === pid && new RegExp(`pid ${pid}`).test(e.message));
  holder.proc.kill("SIGKILL"); await holder.done;
  assert.ok(existsSync(file), "a SIGKILLed holder leaves its lock file");
  assert.match(staleHolder(JSON.parse(readFileSync(file, "utf8"))), /is not running/);
  assert.equal(await withFileLock(file, async () => "recovered", { timeout_ms: 5_000 }), "recovered");
  assert.equal(existsSync(file), false, "released after use");
});

test("L-303: staleness is judged by pid AND process start time on this host; another host's holder is never judged from here", () => {
  const me = { pid: process.pid, host: hostname(), start: processStart(process.pid), token: "t" };
  assert.ok(me.start, "this host reports process start times");
  assert.equal(staleHolder(me), null, "a live holder");
  assert.match(staleHolder({ ...me, start: String(Number(me.start) + 1) }), /now belongs to another process/, "a reused pid");
  assert.equal(staleHolder({ ...me, host: `${hostname()}-elsewhere`, pid: 999999 }), null, "another host's holder: not stale from here");
  assert.match(staleHolder({ host: hostname() }), /names no holder/);
});

test("L-303: a damaged (unreadable) lock is waited for briefly, not broken at once; two in-process waiters still take turns", { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "repo-lock-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "x.lock");
  writeFileSync(file, "{not json");
  await assert.rejects(() => withFileLock(file, async () => 1, { timeout_ms: 200 }), e => e.code === "REPO_LOCK_TIMEOUT");
  rmSync(file);
  const order = [];
  let release;
  const first = withFileLock(file, () => new Promise(r => { order.push("first in"); release = () => { order.push("first out"); r(); }; }));
  await until(() => order.length === 1, 5_000, "the first holder");
  const second = withFileLock(file, async () => { order.push("second in"); });
  await sleep(100);
  assert.deepEqual(order, ["first in"], "the second waits");
  release(); await first; await second;
  assert.deepEqual(order, ["first in", "first out", "second in"]);
});

test("L-303: breaking a stale lock re-reads it first: a lock another process took after it was seen stale is NOT removed", async t => {
  const root = mkdtempSync(join(tmpdir(), "repo-lock-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "x.lock");
  const stale = { pid: 999999, host: hostname(), start: "1", token: "stale-token" };
  const taken = { pid: process.pid, host: hostname(), start: processStart(process.pid), token: "taken-meanwhile" };
  writeFileSync(file, JSON.stringify(taken));   // what is there by the time the breaker looks again
  breakStale(file, stale);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).token, "taken-meanwhile", "the live lock is kept");
  assert.equal(existsSync(`${file}.break`), false, "the breaker is released");
  writeFileSync(file, JSON.stringify(stale));
  breakStale(file, stale);
  assert.equal(existsSync(file), false, "the lock still the stale one is removed");
});

test("L-303: a holder releases only its OWN lock: one that was broken and retaken by another holder while it ran is left in place", async t => {
  const root = mkdtempSync(join(tmpdir(), "repo-lock-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "x.lock");
  const other = JSON.stringify({ pid: process.pid, host: hostname(), start: processStart(process.pid), token: "the-next-holder" });
  await withFileLock(file, async () => { writeFileSync(file, other); });
  assert.equal(readFileSync(file, "utf8"), other);
});
