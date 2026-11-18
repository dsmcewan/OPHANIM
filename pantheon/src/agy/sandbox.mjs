// THE WORKER'S CONTAINMENT: a bubblewrap (bwrap) mount namespace around the agy CLI process.
//
// The whole host is visible READ-ONLY; only these are writable:
//   - the unit's worktree                      (where the worker edits; the pre-mutation hook narrows it to owned paths)
//   - <control_dir>/run                        (jail.log, the CLI's --log-file agy.log, the per-run agy scratch; the
//                                               rest of control_dir — the role card, hooks.json, mcp_config.json,
//                                               jail.json, the hook wrapper — is read-only to the worker)
//   - the agy state layout (below)
//   - each EXPLICIT agy state dir              (an override: `agy_state_dirs`, or $PANTHEON_AGY_STATE_DIRS)
//   - a fresh tmpfs on /tmp
// and the main repository's .git (the worktree's `.git` file points into <repo>/.git/worktrees/<name>) is bound
// READ-ONLY last, so the worker can neither commit nor move a ref even when a writable bind contains it.
//
// THE agy STATE LAYOUT (OWNER-STATED 2026-11-18, not in the docs we read; scripts/agy-worker-probe.mjs checks it):
//   ~/.gemini                                  READ-ONLY (oauth_creds.json, google_accounts.json, config/,
//                                               antigravity-cli/ stay readable: the CLI logs in with them)
//   ~/.gemini/antigravity/conversations        a per-run WRITABLE scratch dir bound over it
//   ~/.gemini/antigravity/mcp                  a per-run WRITABLE scratch dir bound over it (the MCP schema cache)
// The scratch dirs live under <control_dir>/run/agy-state/<run id>/ and are removed after the run (geminiState /
// dropGeminiState); what the CLI wrote there is listed first, as evidence. CHOICE: per-run scratch binds, not tmpfs, so
// what agy wrote is inspectable. A bind needs its mount point to exist, and bwrap cannot create one inside the
// read-only ~/.gemini bind: when either host dir is missing it is created EMPTY on the host first (mkdir -p) and the
// creation is recorded (`created_mountpoints`). Nothing else under ~/.gemini is ever written by Pantheon.
// RISK: an OAuth token refresh that rewrites ~/.gemini/oauth_creds.json hits EROFS inside the jail; the turn then fails
// (or the CLI keeps the refreshed token in memory only). The probe captures stderr and the --log-file to show it.
// Override: `gemini_state: "rw"` binds ~/.gemini read-write (the earlier default); "off" adds no layout at all.
//
// THE NETWORK IS NOT UNSHARED: the CLI must reach Google. Loopback TCP is therefore NOT the A2A path (it is not
// isolated per unit and a sandbox may cut it); the A2A path is the controller's Unix socket, a file the worker reaches
// through the read-only bind of the directory that holds it.
//
// Binds are emitted parent-first (by destination depth), so a deeper bind overrides a shallower one whatever their
// kinds; the main .git read-only bind is always last.
//
// Must never: run the worker unjailed silently (sandboxAvailable is probed and the caller refuses with
// SANDBOX_UNAVAILABLE unless the caller explicitly allows an unsandboxed run); block the event loop (async spawn).
import { existsSync, readFileSync, statSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
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
 *   gemini_state    the agy state layout from geminiState() (null: none)
 *   bwrap           the bwrap binary (default "bwrap" on PATH)
 * Returns {argv, binds, git} — binds as [{mode: "ro" | "rw", path, src?}] in the order emitted (`src` only when the
 * source differs from the destination `path`).
 */
export function bwrapArgs({ worktree, control_dir, agy_state_dirs = [], extra_ro = [], gemini_state = null, bwrap = "bwrap" }) {
  if (!worktree || !control_dir) throw new Error("bwrapArgs: pass the worktree and the control dir");
  const wt = real(worktree), ctl = real(control_dir), run = join(ctl, "run");
  if (inside(wt, ctl)) throw Object.assign(new Error(`the control dir ${ctl} is inside the worktree ${wt}`), { code: "CONTROL_IN_WORKTREE" });
  const binds = [];
  // One bind per path. Before the sort a writable bind of a path wins over a read-only one of the same path (a state
  // dir that is also the CLI's own directory); after it (the .git binds) the read-only bind wins.
  const add = (mode, p, ro_wins = false, src = null) => {
    const r = real(p), at = binds.findIndex(b => b.path === r);
    const b = src && real(src) !== r ? { mode, path: r, src: real(src) } : { mode, path: r };
    if (at < 0) { binds.push(b); return; }
    if (src || (ro_wins ? mode === "ro" : mode === "rw")) { binds.splice(at, 1); binds.push(b); }
  };
  for (const p of extra_ro) add("ro", p);
  for (const p of agy_state_dirs) add("rw", p);
  if (gemini_state?.enabled) {
    add(gemini_state.mode === "rw" ? "rw" : "ro", gemini_state.gemini_dir);
    for (const m of gemini_state.mounts ?? []) add("rw", m.dest, false, m.src);
  }
  add("rw", wt);
  add("ro", ctl);
  add("rw", run);
  // Stable sort by depth: a parent bind first, then what overrides inside it.
  binds.sort((a, b) => depth(a.path) - depth(b.path));
  const git = repoGitDirs(wt);
  if (git) { add("ro", git.common_dir, true); if (!inside(git.common_dir, git.git_dir)) add("ro", git.git_dir, true); }
  // The .git read-only binds go last (add() appended them after the sort).
  const argv = [bwrap, "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const b of binds) argv.push(b.mode === "rw" ? "--bind" : "--ro-bind", b.src ?? b.path, b.path);
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
 * EXPLICIT writable agy state dirs, used only when the caller injects none: PANTHEON_AGY_STATE_DIRS (":"-separated)
 * when set, else NONE. (The earlier default bound ~/.gemini read-write; ~/.gemini is now covered by the state layout,
 * see geminiState: read-only, with per-run writable scratch over conversations/ and mcp/.) Only existing directories
 * are returned (bwrap cannot bind a missing source).
 */
export function defaultAgyStateDirs(env = process.env) {
  const listed = env.PANTHEON_AGY_STATE_DIRS != null ? String(env.PANTHEON_AGY_STATE_DIRS).split(":") : [];
  return listed.filter(Boolean).filter(p => { try { return statSync(p).isDirectory(); } catch { return false; } });
}

/** The two ~/.gemini subdirectories the CLI must write (owner-stated), relative to ~/.gemini. */
export const GEMINI_SCRATCH = Object.freeze(["antigravity/conversations", "antigravity/mcp"]);

/**
 * Prepare the agy state layout for one run (see the header). `mode` "scratch" (default) | "rw" | "off".
 * Returns {enabled, mode, home, gemini_dir, mounts: [{dest, src}], scratch_root, created_mountpoints, why?}. Disabled
 * (enabled: false, with why) when mode is "off" or <home>/.gemini is not a directory (nothing to protect or to read).
 */
export async function geminiState({ home = homedir(), run_dir, mode = "scratch" } = {}) {
  const gemini_dir = join(real(home), ".gemini");
  const off = why => ({ enabled: false, mode, home, gemini_dir, mounts: [], scratch_root: null, created_mountpoints: [], why });
  if (mode === "off") return off("gemini_state is off");
  let isDir = false;
  try { isDir = statSync(gemini_dir).isDirectory(); } catch { /* absent */ }
  if (!isDir) return off(`${gemini_dir} is not a directory`);
  if (mode === "rw") return { enabled: true, mode, home, gemini_dir, mounts: [], scratch_root: null, created_mountpoints: [] };
  if (!run_dir) throw new Error("geminiState: pass run_dir (the control dir's run/) for the per-run scratch dirs");
  const scratch_root = join(real(run_dir), "agy-state", `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`);
  const mounts = [], created_mountpoints = [];
  for (const rel of GEMINI_SCRATCH) {
    const dest = join(gemini_dir, rel), src = join(scratch_root, rel.split("/").at(-1));
    if (!existsSync(dest)) { await mkdir(dest, { recursive: true }); created_mountpoints.push(dest); }
    await mkdir(src, { recursive: true });
    mounts.push({ dest, src });
  }
  return { enabled: true, mode, home, gemini_dir, mounts, scratch_root, created_mountpoints };
}
/** What the CLI wrote into the per-run scratch dirs ({<dest>: [relative file paths]}), then remove them unless `keep`. */
export async function dropGeminiState(state, { keep = false } = {}) {
  if (!state?.enabled || !state.scratch_root) return null;
  const listing = {};
  for (const m of state.mounts) {
    const files = [];
    const walk = async (d, pre) => { for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) { const r = pre ? `${pre}/${e.name}` : e.name; if (e.isDirectory()) await walk(join(d, e.name), r); else files.push(r); } };
    await walk(m.src, "");
    listing[m.dest] = files.sort();
  }
  if (!keep) await rm(state.scratch_root, { recursive: true, force: true }).catch(() => {});
  return listing;
}
/** The directory to bind read-only so the CLI binary itself is visible inside the sandbox (/tmp is a fresh tmpfs). */
export const cliDirOf = cli => (cli.includes("/") ? dirname(real(cli)) : null);
