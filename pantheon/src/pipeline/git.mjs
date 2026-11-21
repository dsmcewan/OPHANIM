// ASYNC PROCESS EXECUTION for the pipeline controller: git, and the deterministic verify command.
//
// Inputs: a command, arguments, a working directory. Outputs: {code, stdout, stderr, timed_out, truncated}.
// Everything here is asynchronous `spawn`: the controller runs several units at once on one event loop, and one
// blocking child would stall every other unit's worker, shim and timer.
//
// Must never: block the event loop on a child process; run a repository's git hooks or signing as the controller;
// leave a timed-out or aborted command's process group running; wait forever on a pipe a stray process still holds.
import { spawn } from "node:child_process";
import { closeSync, linkSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Run a child to completion. `max_bytes` caps EACH of stdout and stderr (the rest is dropped, `truncated: true`).
 * `signal` (an AbortSignal) kills the child (its process group with `group`) like the timeout does, and the result says
 * `aborted: true`; a signal already aborted runs nothing. THE FAILSAFE (independent review round 2, assignment 3 (Google
 * gemini-4-carbon, manual, 77480d6), finding 9): after a kill, the result is resolved within `kill_grace_ms` even when
 * a process outside the group (a setsid'd grandchild) still holds the output pipes open; the streams are destroyed.
 */
export function exec(cmd, args, { cwd, input = null, env = process.env, timeout_ms = 0, max_bytes = 64 * 1024 * 1024, group = false, signal = null, kill_grace_ms = 2000 } = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve({ code: null, signal: null, stdout: "", stderr: "", timed_out: false, aborted: true, truncated: false, spawn_error: false }); return; }
    let child;
    try { child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: group }); }
    catch (e) { resolve({ code: null, signal: null, stdout: "", stderr: String(e.message), timed_out: false, truncated: false, spawn_error: true }); return; }
    const out = [], err = [];
    let nOut = 0, nErr = 0, truncated = false, timed_out = false, aborted = false, done = false, failsafe = null;
    const take = (list, n, chunk) => {
      const room = max_bytes - n;
      if (room <= 0) { truncated = true; return 0; }
      if (chunk.length > room) { truncated = true; chunk = chunk.subarray(0, room); }
      list.push(chunk);
      return chunk.length;
    };
    child.stdout.on("data", c => { nOut += take(out, nOut, c); });
    child.stderr.on("data", c => { nErr += take(err, nErr, c); });
    child.stdin.on("error", () => {});
    const kill = () => {
      try { group ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGKILL"); } catch { /* already gone */ }
      failsafe ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null, "SIGKILL", false, "\n[killed; a process outside the group still held the output open]"); }, kill_grace_ms);
    };
    const timer = timeout_ms > 0 ? setTimeout(() => { timed_out = true; kill(); }, timeout_ms) : null;
    const onAbort = () => { aborted = true; kill(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code, sig, spawn_error = false, msg = "") => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (failsafe) clearTimeout(failsafe);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal: sig, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") + msg, timed_out, aborted, truncated, spawn_error });
    };
    child.on("error", e => finish(null, null, true, String(e.message)));
    child.on("close", (code, signal) => finish(code, signal));
    child.stdin.end(input ?? "");
  });
}

// The controller's own identity and a hook-free, unsigned, prompt-free git: what it commits must not depend on the
// repository's or the user's configuration.
const GIT_ENV = (() => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "pantheon-controller", GIT_AUTHOR_EMAIL: "controller@pantheon.invalid", GIT_COMMITTER_NAME: "pantheon-controller", GIT_COMMITTER_EMAIL: "controller@pantheon.invalid" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[k];
  return env;
})();
const GIT_FLAGS = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotepath=false", "-c", "advice.detachedHead=false"];

/** `git <args>` in `cwd`. Returns stdout; throws (code GIT_FAILED) on a non-zero exit unless `allowFail`, which returns the result object. */
export async function git(cwd, args, { input = null, allowFail = false } = {}) {
  const r = await exec("git", [...GIT_FLAGS, ...args], { cwd, input, env: GIT_ENV });
  if (allowFail) return r;
  if (r.code !== 0) throw Object.assign(new Error(`git ${args.join(" ")} exited ${r.code}: ${r.stderr.trim().slice(0, 2000)}`), { code: "GIT_FAILED", result: r });
  return r.stdout;
}

/** A promise mutex: operations that touch the SHARED repository metadata (worktree add/remove) run one at a time. */
export function mutex() {
  let tail = Promise.resolve();
  return fn => { const run = tail.then(fn, fn); tail = run.then(() => {}, () => {}); return run; };
}

// ---- THE CROSS-PROCESS REPOSITORY LOCK (register L-303, self-audit round 3, assignment 3 (sealed bb1287a)) ------------
//
// `git worktree add` creates <common>/worktrees/<name>/ and then writes its `gitdir` file; a `git worktree prune` (or a
// `remove`) run by ANOTHER process in between deletes that half-made entry, and the add fails with "could not open
// .git/worktrees/<name>/gitdir". repoMutex serialised these within one process only, so a service and an `operate tick`
// (or two ticks) on one checkout collided. Every worktree mutation now runs under ONE lock per repository that spans
// processes: the file <git common dir>/pantheon-worktrees.lock, created atomically (written whole to a private temp
// file, then link(2)ed into place: an existing lock refuses the link, and a reader never sees it half written). It
// names its holder {pid, host, start (the process's start time from /proc, where there is one), boot, token}. A waiter
// polls (backing off to 200 ms) until the lock is gone or STALE, and gives up after `timeout_ms` with REPO_LOCK_TIMEOUT
// naming the holder. Stale means: a holder on THIS host whose pid is not running, or whose pid now belongs to a process
// with another start time (a reused pid), or a lock from an earlier boot. A holder on another host is never judged from
// here (it is waited for, then the timeout names it). A stale lock is removed under a second, short-lived "breaker"
// file (same creation rule), re-read under it and removed only if it is still the stale one (same token), so two
// waiters that both saw it stale cannot remove a lock a third process took in between. The breaker is held only for a
// synchronous read-and-unlink; one left by a holder that died inside that window is itself stale by the same rule and
// is removed (the residual race needs that death AND two concurrent recoverers; docs/operate-service.md).
const LOCK_NAME = "pantheon-worktrees.lock";
const BOOT_ID = (() => { try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return null; } })();
const HOST = hostname();
/** The start time of `pid` (clock ticks since boot, /proc/<pid>/stat field 22), or null where it cannot be read. */
export function processStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const v = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[22 - 3];   // after "pid (comm) " comes field 3
    return /^\d+$/.test(v ?? "") ? v : null;
  } catch { return null; }
}
const SELF_START = processStart(process.pid);
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };

/** Why the lock holder `h` (parsed lock content) is stale, or null when it is (or may be) live. */
export function staleHolder(h) {
  if (!h || !Number.isInteger(h.pid) || h.pid <= 0) return "the lock names no holder";
  if (h.host !== HOST) return null;                                   // another host's: never judged from here
  if (h.boot && BOOT_ID && h.boot !== BOOT_ID) return `its holder (pid ${h.pid}) ran before this host's last boot`;
  if (!pidAlive(h.pid)) return `its holder (pid ${h.pid}) is not running`;
  const now = h.start ? processStart(h.pid) : null;
  if (now !== null && now !== h.start) return `pid ${h.pid} now belongs to another process (start ${now}, not ${h.start})`;
  return null;
}

// undefined: no lock; null: a lock that cannot be read as JSON; else its holder.
const readLock = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { return e?.code === "ENOENT" ? undefined : null; } };
const ageMs = file => { try { return Date.now() - statSync(file).mtimeMs; } catch { return Infinity; } };
/** Create `file` holding `content`, atomically and only if it does not exist. Returns true, or false when it exists. */
function createExclusive(file, content) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o644);
  try { writeSync(fd, content); } finally { closeSync(fd); }
  try { linkSync(tmp, file); return true; }
  catch (e) { if (e?.code === "EEXIST") return false; throw e; }
  finally { try { unlinkSync(tmp); } catch { /* gone */ } }
}
const holderOf = () => ({ pid: process.pid, host: HOST, start: SELF_START, boot: BOOT_ID, token: randomBytes(12).toString("hex"), at: new Date().toISOString() });

/** Remove `file` if it is still the stale lock `seen` (same token; or still unreadable), under the breaker. */
export function breakStale(file, seen) {
  const breaker = `${file}.break`, me = holderOf();
  if (!createExclusive(breaker, JSON.stringify(me))) {
    const b = readLock(breaker);
    if (b === undefined) return;
    if (b === null ? ageMs(breaker) > 10_000 : staleHolder(b)) { try { if (b === null || readLock(breaker)?.token === b.token) unlinkSync(breaker); } catch { /* gone */ } }
    return;
  }
  try {
    const now = readLock(file);
    if (now !== undefined && (now === null ? seen === null : now.token === seen?.token)) unlinkSync(file);
  } finally {
    try { if (readLock(breaker)?.token === me.token) unlinkSync(breaker); } catch { /* gone */ }
  }
}

/**
 * Hold the cross-process lock `file` while `fn` runs, and release it after (only if it is still this holder's).
 * `timeout_ms` bounds the wait (REPO_LOCK_TIMEOUT). `onWait(holder)` (optional) is told once when the lock was found held.
 */
export async function withFileLock(file, fn, { timeout_ms = 300_000, onWait = null } = {}) {
  const me = holderOf(), content = JSON.stringify(me) + "\n";
  const until = Date.now() + timeout_ms;
  let delay = 5, told = false;
  for (;;) {
    if (createExclusive(file, content)) break;
    const h = readLock(file);
    if (h === undefined) continue;                                    // released between our link and our read
    // A lock is linked whole, so an unreadable one is damaged: stale once it is 10 s old.
    if (h === null ? ageMs(file) > 10_000 : staleHolder(h)) { breakStale(file, h); continue; }
    if (!told && typeof onWait === "function") { told = true; try { onWait(h); } catch { /* advisory */ } }
    if (Date.now() >= until) {
      throw Object.assign(new Error(`the repository lock ${file} is held by pid ${h?.pid ?? "?"} on ${h?.host ?? "?"} since ${h?.at ?? "?"}; waited ${timeout_ms} ms`), { code: "REPO_LOCK_TIMEOUT", holder: h });
    }
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(200, delay * 2);
  }
  try { return await fn(); }
  finally { try { if (readLock(file)?.token === me.token) unlinkSync(file); } catch { /* gone */ } }
}

/** The git common directory of `repo` (absolute): where its worktree list lives, shared by all its worktrees. */
export async function gitCommonDir(repo) {
  const out = (await git(repo, ["rev-parse", "--git-common-dir"])).trim();
  return isAbsolute(out) ? out : resolve(repo, out);
}

/**
 * ONE LOCK PER REPOSITORY, ACROSS PROCESSES, for every operation on its shared worktree list and branches (worktree
 * add/remove/prune, the integration branch's creation and deletion). Within a process its callers queue on a promise
 * mutex; across processes they hold <git common dir>/pantheon-worktrees.lock (above). Keyed by the repository's real
 * path. Each run had its own in-process mutex once, and a lifecycle's orphan recovery none (independent review round
 * 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 3.3); then one per process (L-303). `lock.file()`
 * resolves the lock file's path.
 */
const REPO_LOCKS = new Map();
export function repoMutex(repo, { timeout_ms = 300_000 } = {}) {
  let key;
  try { key = realpathSync(repo); } catch { key = resolve(repo); }
  if (!REPO_LOCKS.has(key)) {
    const local = mutex();
    let file = null;
    const where = async () => (file ??= join(await gitCommonDir(key), LOCK_NAME));
    // A path that is not (yet) a git repository has no shared worktree list to protect: within this process only.
    const lock = fn => local(async () => {
      let f;
      try { f = await where(); } catch (e) { if (e?.code === "GIT_FAILED") return fn(); throw e; }
      return withFileLock(f, fn, { timeout_ms });
    });
    lock.file = where;
    REPO_LOCKS.set(key, lock);
  }
  return REPO_LOCKS.get(key);
}
