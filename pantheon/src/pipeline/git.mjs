// ASYNC PROCESS EXECUTION for the pipeline controller: git, and the deterministic verify command.
//
// Inputs: a command, arguments, a working directory. Outputs: {code, stdout, stderr, timed_out, truncated}.
// Everything here is asynchronous `spawn`: the controller runs several units at once on one event loop, and one
// blocking child would stall every other unit's worker, shim and timer.
//
// Must never: block the event loop on a child process; run a repository's git hooks or signing as the controller;
// leave a timed-out command's process group running.
import { spawn } from "node:child_process";

/** Run a child to completion. `max_bytes` caps EACH of stdout and stderr (the rest is dropped, `truncated: true`). */
export function exec(cmd, args, { cwd, input = null, env = process.env, timeout_ms = 0, max_bytes = 64 * 1024 * 1024, group = false } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: group }); }
    catch (e) { resolve({ code: null, signal: null, stdout: "", stderr: String(e.message), timed_out: false, truncated: false, spawn_error: true }); return; }
    const out = [], err = [];
    let nOut = 0, nErr = 0, truncated = false, timed_out = false, done = false;
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
    const kill = () => { try { group ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGKILL"); } catch { /* already gone */ } };
    const timer = timeout_ms > 0 ? setTimeout(() => { timed_out = true; kill(); }, timeout_ms) : null;
    const finish = (code, signal, spawn_error = false, msg = "") => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") + msg, timed_out, truncated, spawn_error });
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
