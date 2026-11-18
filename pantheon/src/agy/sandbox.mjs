// THE WORKER'S CONTAINMENT: a bubblewrap (bwrap) mount namespace around the agy CLI process.
//
// The whole host is visible READ-ONLY; only these are writable:
//   - the unit's worktree                      (where the worker edits; the pre-mutation hook narrows it to owned paths)
//   - <control_dir>/run                        (jail.log, the CLI's --log-file agy.log, the per-run agy scratch; the
//                                               rest of control_dir — the role card, hooks.json, mcp_config.json,
//                                               jail.json, the hook wrapper — is read-only to the worker)
//   - the agy state layout (below: a per-run scratch copy of ~/.gemini/antigravity-cli)
//   - each EXPLICIT agy state dir              (an override: `agy_state_dirs`, or $PANTHEON_AGY_STATE_DIRS)
//   - a fresh tmpfs on /tmp
// and the main repository's .git (the worktree's `.git` file points into <repo>/.git/worktrees/<name>) is bound
// READ-ONLY last, so the worker can neither commit nor move a ref even when a writable bind contains it.
//
// THE agy STATE LAYOUT (observed on agy 1.5.10, owner's probe 2026-11-18). The CLI keeps its state under
// ~/.gemini/antigravity-cli/, NOT ~/.gemini/antigravity/: that probe bound scratch dirs over antigravity/conversations and
// antigravity/mcp, both stayed empty, and every write failed "read-only file system" under antigravity-cli/:
// conversations/<id>.db (+ .tmp), brain/<id>/, presence/<id>.lock, cache/last_conversations.json.*.tmp,
// implicit/*.tmp, crashes/crash_*.log, mcp/pantheon-subagents/, and a top-level jetbox_summaries_proto.pb.*.tmp. The
// turn never started (0 turns, print timeout). The top-level ~/.gemini files (GEMINI.md, gemini-credentials.json,
// google_accounts.json, installation_id, jetski-standalone-oauth-token, projects.json, settings.json, state.json,
// trustedFolders.json) were untouched and no OAuth refresh failure was seen. So:
//   ~/.gemini                         READ-ONLY (the login and the top-level files stay readable)
//   ~/.gemini/antigravity-cli         a per-run SCRATCH COPY bound read-write over it:
//                                       <control_dir>/run/agy-state/<run id>/antigravity-cli/
//     top-level regular files         COPIED from the host (mode kept), so e.g. its settings.json is read; symlinks
//                                     and other non-regular entries are skipped and recorded
//     the known state subdirs         EMPTY (GEMINI_STATE_SUBDIRS): host history and caches stay hidden and untouched
//     every other host subdir         an empty mount point in the scratch with the HOST subdir --ro-bind over it
//                                     (readable, never writable: plugins/config the CLI may only read)
// Bind order: --ro-bind ~/.gemini, then --bind <scratch>/antigravity-cli ~/.gemini/antigravity-cli, then the ro-binds
// of the unknown subdirs (parent-first, by depth). NOTHING is ever created under the real home: every mount point is
// either an existing host directory or a directory inside the scratch (the earlier layout mkdir'ed an empty
// ~/.gemini/antigravity/mcp on the host as a mount point; that never happens again).
// WHEN ~/.gemini/antigravity-cli IS ABSENT: refused with code AGY_STATE_LAYOUT (CHOICE: the simplest correct
// behaviour). The scratch needs a mount point there; bwrap cannot create one inside the read-only ~/.gemini bind, and
// creating it on the host is exactly what must never happen. A tmpfs ~/.gemini with per-entry ro-binds would work but
// changes what the CLI sees in ways nobody has observed. The remedy is in the error: run agy once outside the jail
// (it creates the directory), or pass gemini_state "rw" / "off" explicitly.
// After the run, dropGeminiState lists what the CLI wrote into the scratch (top level and each state subdir, names and
// sizes) as evidence, then removes it unless kept.
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
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
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
    for (const m of gemini_state.mounts ?? []) add(m.mode === "ro" ? "ro" : "rw", m.dest, false, m.src);
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
 * see geminiState: read-only, with a per-run writable scratch copy over antigravity-cli/.) Only existing directories
 * are returned (bwrap cannot bind a missing source).
 */
export function defaultAgyStateDirs(env = process.env) {
  const listed = env.PANTHEON_AGY_STATE_DIRS != null ? String(env.PANTHEON_AGY_STATE_DIRS).split(":") : [];
  return listed.filter(Boolean).filter(p => { try { return statSync(p).isDirectory(); } catch { return false; } });
}

/** The CLI's state directory, relative to ~/.gemini (observed on agy 1.5.10, owner's probe 2026-11-18). */
export const GEMINI_CLI_DIR = "antigravity-cli";
/**
 * The subdirectories of ~/.gemini/antigravity-cli the CLI WRITES (observed on agy 1.5.10, owner's probe 2026-11-18:
 * each one failed "read-only file system"). They start EMPTY in the scratch; the host's copies stay hidden.
 */
export const GEMINI_STATE_SUBDIRS = Object.freeze(["conversations", "brain", "presence", "cache", "implicit", "crashes", "mcp"]);
const layoutError = (message, more = {}) => Object.assign(new Error(message), { code: "AGY_STATE_LAYOUT", ...more });

/**
 * Prepare the agy state layout for one run (see the header). `mode` "scratch" (default) | "rw" | "off".
 * Returns {enabled, mode, home, gemini_dir, cli_dir, mounts: [{dest, src, mode}], scratch_root, scratch_cli, copied,
 * skipped, hidden_state, readonly_subdirs, why?}. Disabled (enabled: false, with why) when mode is "off" or
 * <home>/.gemini is not a directory (nothing to protect or to read). Throws AGY_STATE_LAYOUT when <home>/.gemini exists
 * but <home>/.gemini/antigravity-cli does not (see the header) or is not a plain directory. Never writes under `home`.
 */
export async function geminiState({ home = homedir(), run_dir, mode = "scratch" } = {}) {
  const gemini_dir = join(real(home), ".gemini"), cli_dir = join(gemini_dir, GEMINI_CLI_DIR);
  const base = { mode, home, gemini_dir, cli_dir, mounts: [], scratch_root: null, scratch_cli: null, copied: [], skipped: [], hidden_state: [], readonly_subdirs: [] };
  if (mode === "off") return { enabled: false, ...base, why: "gemini_state is off" };
  if (mode !== "scratch" && mode !== "rw") throw layoutError(`geminiState: unknown mode ${JSON.stringify(mode)} (scratch | rw | off)`);
  let isDir = false;
  try { isDir = statSync(gemini_dir).isDirectory(); } catch { /* absent */ }
  if (!isDir) return { enabled: false, ...base, why: `${gemini_dir} is not a directory` };
  if (mode === "rw") return { enabled: true, ...base };
  if (!run_dir) throw new Error("geminiState: pass run_dir (the control dir's run/) for the per-run scratch copy");
  let st = null;
  try { st = lstatSync(cli_dir); } catch { /* absent */ }
  if (!st) throw layoutError(`${cli_dir} does not exist: the per-run scratch copy needs it as a mount point, and Pantheon never creates anything under the real home. Run agy once outside the jail (it creates the directory), or pass gemini_state "rw" or "off" explicitly`, { cli_dir });
  if (!st.isDirectory()) throw layoutError(`${cli_dir} is not a plain directory (${st.isSymbolicLink() ? "a symlink" : "another file type"}): refusing to guess what to bind over it`, { cli_dir });
  const scratch_root = join(real(run_dir), "agy-state", `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`);
  // The scratch lives in the controller's control dir; inside ~/.gemini it would be hidden by (and write through) the
  // very binds it backs.
  if (inside(gemini_dir, scratch_root)) throw layoutError(`the scratch ${scratch_root} would be inside ${gemini_dir}; put the control dir elsewhere`);
  const scratch_cli = join(scratch_root, GEMINI_CLI_DIR);
  await mkdir(scratch_cli, { recursive: true, mode: 0o700 });
  const out = { enabled: true, ...base, scratch_root, scratch_cli, mounts: [{ dest: cli_dir, src: scratch_cli, mode: "rw" }] };
  for (const e of (await readdir(cli_dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const host = join(cli_dir, e.name), dst = join(scratch_cli, e.name);
    if (e.isSymbolicLink()) { out.skipped.push({ name: e.name, kind: "symlink" }); continue; }
    if (e.isFile()) {
      const m = (await stat(host)).mode & 0o7777;
      await copyFile(host, dst);
      await chmod(dst, m);
      out.copied.push(e.name);
    } else if (e.isDirectory()) {
      if (GEMINI_STATE_SUBDIRS.includes(e.name)) continue;   // created empty below
      await mkdir(dst);                                         // the mount point, inside the scratch
      out.mounts.push({ dest: host, src: host, mode: "ro" });
      out.readonly_subdirs.push(e.name);
    } else out.skipped.push({ name: e.name, kind: "other" });
  }
  for (const d of GEMINI_STATE_SUBDIRS) {
    if (existsSync(join(cli_dir, d))) out.hidden_state.push(d);
    await mkdir(join(scratch_cli, d), { recursive: true, mode: 0o700 });
  }
  return out;
}

/**
 * What the CLI wrote into the per-run scratch copy, then remove it unless `keep`. Returns null when there was none, else
 * {dir, top_level: [{name, size, copied, changed}], subdirs: {<name>: [{path, size}]}} — `top_level` the files directly
 * in antigravity-cli/ (copied: it came from the host; changed: its bytes differ from the host's now), `subdirs` every
 * directory of the scratch except the read-only mount points (whose content is the host's, not a write).
 */
export async function dropGeminiState(state, { keep = false } = {}) {
  if (!state?.enabled || !state.scratch_root) return null;
  const root = state.scratch_cli, listing = { dir: state.cli_dir, top_level: [], subdirs: {} };
  const ro = new Set(state.readonly_subdirs ?? []);
  const walk = async (d, pre, files) => {
    for (const e of (await readdir(d, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = pre ? `${pre}/${e.name}` : e.name, p = join(d, e.name);
      if (e.isDirectory()) await walk(p, r, files);
      else files.push({ path: r, size: (await lstat(p).catch(() => null))?.size ?? null });
    }
  };
  for (const e of (await readdir(root, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (ro.has(e.name)) continue;
      const files = [];
      await walk(p, "", files);
      listing.subdirs[e.name] = files;
    } else {
      const size = (await lstat(p).catch(() => null))?.size ?? null;
      const copied = (state.copied ?? []).includes(e.name);
      let changed = !copied;
      if (copied) { const [a, b] = await Promise.all([readFile(p).catch(() => null), readFile(join(state.cli_dir, e.name)).catch(() => null)]); changed = !(a && b && a.equals(b)); }
      listing.top_level.push({ name: e.name, size, copied, changed });
    }
  }
  if (!keep) await rm(state.scratch_root, { recursive: true, force: true }).catch(() => {});
  return listing;
}
/** The directory to bind read-only so the CLI binary itself is visible inside the sandbox (/tmp is a fresh tmpfs). */
export const cliDirOf = cli => (cli.includes("/") ? dirname(real(cli)) : null);
