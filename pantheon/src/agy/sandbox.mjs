// THE WORKER'S CONTAINMENT: a bubblewrap (bwrap) mount namespace around the agy CLI process.
//
// The whole host is visible READ-ONLY; only these are writable:
//   - the unit's worktree                      (where the worker edits; the pre-mutation hook narrows it to owned paths)
//   - <control_dir>/run                        (the jail hook's jail.log; the rest of control_dir — the role card,
//                                               hooks.json, mcp_config.json, jail.json — is read-only to the worker)
//   - each injected agy state dir              (the CLI writes its own state, e.g. its login/session files; the list
//                                               is explicit and injected, never guessed by this module)
//   - a fresh tmpfs on /tmp
// and the main repository's .git (the worktree's `.git` file points into <repo>/.git/worktrees/<name>) is bound
// READ-ONLY last, so the worker can neither commit nor move a ref even when a writable bind contains it.
//
// THE NETWORK IS NOT UNSHARED: the CLI must reach Google. Loopback TCP is therefore NOT the A2A path (it is not
// isolated per unit and a sandbox may cut it); the A2A path is the controller's Unix socket, a file the worker reaches
// through the read-only bind of the directory that holds it.
//
// Binds are emitted parent-first (by path depth), so a deeper bind overrides a shallower one whatever their kinds;
// the main .git read-only bind is always last.
//
// Must never: run the worker unjailed silently (sandboxAvailable is probed and the caller refuses with
// SANDBOX_UNAVAILABLE unless the caller explicitly allows an unsandboxed run); block the event loop (async spawn).
import { existsSync, readFileSync, statSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { spawnPromise } from "../board/spawn.mjs";

const inside = (root, p) => p === root || p.startsWith(root + sep);
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
const depth = p => p.split(sep).filter(Boolean).length;

/**
 * The main repository's git directory for `worktree`, resolved from its `.git` file (a linked worktree) or the
 * `.git` directory itself. Returns {git_dir, common_dir} (absolute, real) or null when the worktree has no .git.
 */
export function repoGitDirs(worktree) {
  const dotgit = join(worktree, ".git");
  let st;
  try { st = lstatSync(dotgit); } catch { return null; }
  if (st.isDirectory()) { const d = real(dotgit); return { git_dir: d, common_dir: d }; }
  const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotgit, "utf8"));
  if (!m) return null;
  const git_dir = real(isAbsolute(m[1].trim()) ? m[1].trim() : resolve(worktree, m[1].trim()));
  let common_dir = git_dir;
  const cd = join(git_dir, "commondir");
  if (existsSync(cd)) { const c = readFileSync(cd, "utf8").trim(); common_dir = real(isAbsolute(c) ? c : resolve(git_dir, c)); }
  return { git_dir, common_dir };
}

/**
 * The bwrap argv prefix (["bwrap", ..., "--"]) for one worker turn. All paths are made absolute and real.
 *   worktree        the unit's worktree (read-write)
 *   control_dir     the controller's per-unit dir (read-only) with its writable `run/` subdir
 *   agy_state_dirs  directories the CLI must write (read-write), explicit and injected
 *   extra_ro        more read-only binds (e.g. the directory holding the A2A socket when it is not under control_dir)
 *   bwrap           the bwrap binary (default "bwrap" on PATH)
 * Returns {argv, binds, git} — binds as [{mode: "ro" | "rw", path}] in the order emitted.
 */
export function bwrapArgs({ worktree, control_dir, agy_state_dirs = [], extra_ro = [], bwrap = "bwrap" }) {
  if (!worktree || !control_dir) throw new Error("bwrapArgs: pass the worktree and the control dir");
  const wt = real(worktree), ctl = real(control_dir), run = join(ctl, "run");
  if (inside(wt, ctl)) throw Object.assign(new Error(`the control dir ${ctl} is inside the worktree ${wt}`), { code: "CONTROL_IN_WORKTREE" });
  const binds = [];
  // One bind per path. Before the sort a writable bind of a path wins over a read-only one of the same path (a state
  // dir that is also the CLI's own directory); after it (the .git binds) the read-only bind wins.
  const add = (mode, p, ro_wins = false) => {
    const r = real(p), at = binds.findIndex(b => b.path === r);
    if (at < 0) { binds.push({ mode, path: r }); return; }
    if (ro_wins ? mode === "ro" : mode === "rw") { binds.splice(at, 1); binds.push({ mode, path: r }); }
  };
  for (const p of extra_ro) add("ro", p);
  for (const p of agy_state_dirs) add("rw", p);
  add("rw", wt);
  add("ro", ctl);
  add("rw", run);
  // Stable sort by depth: a parent bind first, then what overrides inside it.
  binds.sort((a, b) => depth(a.path) - depth(b.path));
  const git = repoGitDirs(wt);
  if (git) { add("ro", git.common_dir, true); if (!inside(git.common_dir, git.git_dir)) add("ro", git.git_dir, true); }
  // The .git read-only binds go last (add() appended them after the sort).
  const argv = [bwrap, "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const b of binds) argv.push(b.mode === "rw" ? "--bind" : "--ro-bind", b.path, b.path);
  argv.push("--chdir", ctl, "--");
  return { argv, binds, git };
}

const probes = new Map();
/**
 * Is bwrap usable here? Runs `bwrap --ro-bind / / true` once per binary (cached). Returns {ok, why?}.
 * Async; never throws.
 */
export function sandboxAvailable(bwrap = "bwrap") {
  if (!probes.has(bwrap)) {
    probes.set(bwrap, (async () => {
      try {
        if (bwrap.includes("/") && !existsSync(bwrap)) return { ok: false, why: `${bwrap} does not exist` };
        const r = await spawnPromise(bwrap, ["--ro-bind", "/", "/", "true"], { timeout: 10000 });
        return r.status === 0 ? { ok: true } : { ok: false, why: `the bwrap probe exited ${r.status ?? r.killedFor}: ${String(r.stderr ?? "").trim().slice(0, 200)}` };
      } catch (e) {
        return { ok: false, why: `bwrap could not be started: ${e?.code ?? e?.message ?? e}` };
      }
    })());
  }
  return probes.get(bwrap);
}

/**
 * Default agy state dirs, used only when the caller injects none: PANTHEON_AGY_STATE_DIRS (":"-separated) when set,
 * else ~/.gemini. Where the CLI writes its own state is UNDOCUMENTED (~/.gemini is a guess from the Gemini CLI
 * lineage); a missing writable location shows up as a failed run (read-only file system), never as a silent escape.
 * Only existing directories are returned (bwrap cannot bind a missing source).
 */
export function defaultAgyStateDirs(env = process.env) {
  const listed = env.PANTHEON_AGY_STATE_DIRS != null ? String(env.PANTHEON_AGY_STATE_DIRS).split(":") : [env.HOME ? join(env.HOME, ".gemini") : null];
  return listed.filter(Boolean).filter(p => { try { return statSync(p).isDirectory(); } catch { return false; } });
}
/** The directory to bind read-only so the CLI binary itself is visible inside the sandbox (/tmp is a fresh tmpfs). */
export const cliDirOf = cli => (cli.includes("/") ? dirname(real(cli)) : null);
