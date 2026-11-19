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
//                                       <control_dir>/run/agy-state/<run id>/antigravity-cli/   (scratch root mode 0700)
//     top-level regular files         ONLY the allowlist GEMINI_CLI_COPY is COPIED (mode kept): settings.json, the
//                                     OAuth token, installation_id, jetski_state.pbtxt, last_check.timestamp. Every
//                                     other top-level file is WITHHELD (not copied; recorded by name and size only).
//                                     (Observed, owner's probe of 5893432, 2026-11-18: copying every top-level file
//                                     put history.jsonl (37 KB), conversation_summaries.db (7 MB) and
//                                     jetbox_summaries_proto.pb, i.e. the owner's history, into the scratch.)
//                                     Symlinks and other non-regular entries are skipped and recorded.
//     the known state subdirs         EMPTY (GEMINI_STATE_SUBDIRS): host history and caches stay hidden and untouched
//     the writable helper subdirs     a per-run WRITABLE COPY (GEMINI_WRITABLE_SUBDIR_COPIES = ["bin"]): its regular
//                                     files copied (mode kept), its symlinks recreated (same target), its subdirs
//                                     ro-bound from the host; the host bin/ stays untouched. (Observed on agy 1.5.10,
//                                     owner's machine, first real worker turn, 2026-11-18: with bin/ ro-bound,
//                                     run_command failed "failed to build agentapi shell injection: failed to write
//                                     agentapi script: open ~/.gemini/antigravity-cli/bin/agentapi: read-only file system".)
//     the writable plugin tree        a per-run WRITABLE DEEP COPY (GEMINI_WRITABLE_TREE_COPIES = ["builtin"]): the
//                                     whole tree copied (files with their mode, subdirs, symlinks recreated), nothing
//                                     bound from the host; the host builtin/ stays untouched. (INFERRED from the owner's
//                                     report of 09d490f, 2026-11-19: the preflight refused "a write to a builtin plugin
//                                     asset under a read-only mount"; the exact line was not kept. See the constant.)
//     every other host subdir         an empty mount point in the scratch with the HOST subdir --ro-bind over it
//                                     (readable, never writable: plugins/config the CLI may only read; observed host
//                                     subdirs: annotations, builtin, knowledge, persistent_terminals, plugin_data,
//                                     scratch, updater)
//   ~/.gemini/config/projects         (GEMINI_WRITABLE_COPIES) when it is a plain directory on the host: a per-run
//                                     scratch copy (files copied, mode kept; subdirs ro-bound like above) bound
//                                     read-write over it; the rest of ~/.gemini/config stays read-only. When absent
//                                     it is NOT created (recorded as absent). (Observed, `agy agents` in the jail,
//                                     2026-11-18: it failed "read-only file system" writing
//                                     ~/.gemini/config/projects/default-cli-project.json.<rand>.tmp.)
// THE SCRATCH HOLDS A COPY OF THE OAuth TOKEN: its root is mode 0700 and dropGeminiState removes it after every run
// unless the caller explicitly keeps it (the probe's --keep, which then says kept_contains_credentials: true).
// Bind order: --ro-bind ~/.gemini, then --bind <scratch>/antigravity-cli ~/.gemini/antigravity-cli and
// --bind <scratch>/config/projects ~/.gemini/config/projects, then the ro-binds of the unknown subdirs (parent-first, by
// depth). NOTHING is ever created under the real home: every mount point is
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
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
 * each one failed "read-only file system"; `log` observed in the probe of 5893432: `agy agents` failed writing
 * ~/.gemini/antigravity-cli/log/...). They start EMPTY in the scratch; the host's copies stay hidden.
 */
export const GEMINI_STATE_SUBDIRS = Object.freeze(["conversations", "brain", "presence", "cache", "implicit", "crashes", "mcp", "log"]);
/**
 * The ONLY top-level files of ~/.gemini/antigravity-cli copied into the scratch (mode kept). Every other top-level file
 * (observed on the owner's host 2026-11-18: history.jsonl, conversation_summaries.db, jetbox_summaries_proto.pb) is
 * withheld: history, summaries and databases never leave the host directory.
 */
export const GEMINI_CLI_COPY = Object.freeze(["settings.json", "antigravity-oauth-token", "installation_id", "jetski_state.pbtxt", "last_check.timestamp"]);
/**
 * Directories under ~/.gemini (relative) that get a per-run writable scratch copy when they are plain directories on
 * the host (observed, owner's probe of 5893432, 2026-11-18: `agy agents` in the jail failed "read-only file system"
 * writing ~/.gemini/config/projects/default-cli-project.json.<rand>.tmp). Absent ones are not created.
 */
export const GEMINI_WRITABLE_COPIES = Object.freeze(["config/projects"]);
/**
 * Subdirectories of ~/.gemini/antigravity-cli that get a per-run WRITABLE COPY inside the scratch (regular files copied
 * with their mode, symlinks recreated, subdirs ro-bound). Observed on agy 1.5.10 (owner's machine, first real worker
 * turn, 2026-11-18): run_command writes its helper script bin/agentapi before running anything, and failed
 * "open ~/.gemini/antigravity-cli/bin/agentapi: read-only file system" while bin/ was ro-bound from the host.
 */
export const GEMINI_WRITABLE_SUBDIR_COPIES = Object.freeze(["bin"]);
/**
 * Subdirectories of ~/.gemini/antigravity-cli that get a per-run WRITABLE DEEP COPY inside the scratch: the whole tree
 * (regular files with their mode, subdirectories, symlinks recreated with the same target; other entries skipped and
 * recorded), so the CLI may rewrite any file in it, at any depth. The host tree stays untouched (never bound).
 * INFERRED, not observed: the owner's run of assignment 1 at 09d490f (2026-11-19) reported that the zero-model-turn
 * preflight "refused a write to a builtin plugin asset under a read-only mount"; the exact line was not kept. The
 * observed host subdirs are annotations, builtin, knowledge, persistent_terminals, plugin_data, scratch and updater,
 * and builtin/ was ro-bound; so the CLI is taken to (re)write its builtin plugin assets under builtin/ at startup, as it
 * writes bin/agentapi. Only builtin/ is copied: plugin_data/ may hold a plugin's own data and stays read-only until a
 * run shows a write there (the preflight's log_scan now names the refused path).
 */
export const GEMINI_WRITABLE_TREE_COPIES = Object.freeze(["builtin"]);
const layoutError = (message, more = {}) => Object.assign(new Error(message), { code: "AGY_STATE_LAYOUT", ...more });
const byName = (a, b) => a.name.localeCompare(b.name);

/**
 * Copy the regular files of host dir `from` into the (existing) scratch dir `to` (mode kept) when `want(name)`; for each
 * host subdir not in `emptySubdirs` or `copySubdirs`, create a mount point in the scratch and ro-bind the host subdir
 * over it; each subdir in `copySubdirs` becomes a writable copy (recursively: files, symlinks recreated, subdirs
 * ro-bound). `symlinks` "skip" (default: recorded in skipped) | "recreate". Returns {copied: [names], withheld: [{name,
 * size}], skipped: [{name, kind}], readonly: [names], mounts, symlinks: [{name, target}], writable_subdirs: [{name, src,
 * dest, copied, symlinks, skipped, readonly_subdirs}]}.
 */
export async function copyLevel(from, to, { want = () => true, emptySubdirs = [], copySubdirs = [], treeSubdirs = [], symlinks = "skip" } = {}) {
  const out = { copied: [], withheld: [], skipped: [], readonly: [], mounts: [], symlinks: [], writable_subdirs: [] };
  for (const e of (await readdir(from, { withFileTypes: true })).sort(byName)) {
    const host = join(from, e.name), dst = join(to, e.name);
    if (e.isDirectory() && treeSubdirs.includes(e.name)) {
      // A per-run writable DEEP copy of this subdir (GEMINI_WRITABLE_TREE_COPIES): nothing in it is bound from the host.
      const tree = await copyTree(host, dst);
      out.writable_subdirs.push({ name: e.name, src: host, dest: dst, deep: true, ...tree, readonly_subdirs: [] });
      continue;
    }
    if (e.isSymbolicLink()) {
      if (symlinks !== "recreate") { out.skipped.push({ name: e.name, kind: "symlink" }); continue; }
      const target = await readlink(host);
      await symlink(target, dst);   // the same target: a relative one resolves inside the copy, an absolute one to the (read-only) host
      out.symlinks.push({ name: e.name, target });
      continue;
    }
    if (e.isDirectory() && copySubdirs.includes(e.name)) {
      // A per-run writable copy of this subdir (GEMINI_WRITABLE_SUBDIR_COPIES): files and symlinks copied, subdirs ro-bound.
      await mkdir(dst, { mode: 0o700 });
      const lvl = await copyLevel(host, dst, { symlinks: "recreate" });
      await chmod(dst, (await stat(host)).mode & 0o7777);   // the host dir's mode, set after the copy filled it
      out.mounts.push(...lvl.mounts);
      out.writable_subdirs.push({ name: e.name, src: host, dest: dst, copied: lvl.copied, symlinks: lvl.symlinks, skipped: lvl.skipped, readonly_subdirs: lvl.readonly });
      continue;
    }
    if (e.isFile()) {
      const st = await stat(host);
      if (!want(e.name)) { out.withheld.push({ name: e.name, size: st.size }); continue; }
      await copyFile(host, dst);
      await chmod(dst, st.mode & 0o7777);
      out.copied.push(e.name);
    } else if (e.isDirectory()) {
      if (emptySubdirs.includes(e.name)) continue;   // created empty by the caller
      await mkdir(dst);                                 // the mount point, inside the scratch
      out.mounts.push({ dest: host, src: host, mode: "ro" });
      out.readonly.push(e.name);
    } else out.skipped.push({ name: e.name, kind: "other" });
  }
  return out;
}

/**
 * Copy the host tree `from` into `to` (created; each directory gets the host's mode after it is filled): regular files
 * (mode kept), subdirectories recursively, symlinks recreated with the same target; anything else skipped. Returns
 * {copied: [relative paths], symlinks: [{name: relative path, target}], skipped: [{name, kind}], bytes}.
 */
async function copyTree(from, to) {
  const out = { copied: [], symlinks: [], skipped: [], bytes: 0 };
  const walk = async (src, dst, pre) => {
    await mkdir(dst, { mode: 0o700 });
    for (const e of (await readdir(src, { withFileTypes: true })).sort(byName)) {
      const s = join(src, e.name), d = join(dst, e.name), rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { const target = await readlink(s); await symlink(target, d); out.symlinks.push({ name: rel, target }); }
      else if (e.isDirectory()) await walk(s, d, rel);
      else if (e.isFile()) { const st = await stat(s); await copyFile(s, d); await chmod(d, st.mode & 0o7777); out.copied.push(rel); out.bytes += st.size; }
      else out.skipped.push({ name: rel, kind: "other" });
    }
    await chmod(dst, (await stat(src)).mode & 0o7777);
  };
  await walk(from, to, "");
  return out;
}

/**
 * Prepare the agy state layout for one run (see the header). `mode` "scratch" (default) | "rw" | "off".
 * Returns {enabled, mode, home, gemini_dir, cli_dir, mounts: [{dest, src, mode}], scratch_root, scratch_cli, copied,
 * withheld: [{name, size}], skipped, hidden_state, readonly_subdirs, writable_subdirs (GEMINI_WRITABLE_SUBDIR_COPIES
 * present on the host: [{name, src, dest, copied, symlinks, skipped, readonly_subdirs}]), writable_copies: [{path, dest, status: "copied" |
 * "absent" | "skipped", src?, copied?, skipped?, readonly_subdirs?, why?}], why?}. Disabled (enabled: false, with why)
 * when mode is "off" or <home>/.gemini is not a directory (nothing to protect or to read). Throws AGY_STATE_LAYOUT when
 * <home>/.gemini exists but <home>/.gemini/antigravity-cli does not (see the header) or is not a plain directory.
 * Never writes under `home`; on any failure the partial scratch is removed.
 */
export async function geminiState({ home = homedir(), run_dir, mode = "scratch" } = {}) {
  const gemini_dir = join(real(home), ".gemini"), cli_dir = join(gemini_dir, GEMINI_CLI_DIR);
  const base = { mode, home, gemini_dir, cli_dir, mounts: [], scratch_root: null, scratch_cli: null, copied: [], withheld: [], skipped: [], hidden_state: [], readonly_subdirs: [], writable_subdirs: [], writable_copies: [] };
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
  try {
    await mkdir(scratch_cli, { recursive: true, mode: 0o700 });
    await chmod(scratch_root, 0o700);   // it holds a copy of the OAuth token (whatever the umask)
    const out = { enabled: true, ...base, scratch_root, scratch_cli, mounts: [{ dest: cli_dir, src: scratch_cli, mode: "rw" }] };
    const top = await copyLevel(cli_dir, scratch_cli, { want: n => GEMINI_CLI_COPY.includes(n), emptySubdirs: GEMINI_STATE_SUBDIRS, copySubdirs: GEMINI_WRITABLE_SUBDIR_COPIES, treeSubdirs: GEMINI_WRITABLE_TREE_COPIES });
    Object.assign(out, { copied: top.copied, withheld: top.withheld, skipped: top.skipped, readonly_subdirs: top.readonly, writable_subdirs: top.writable_subdirs });
    out.mounts.push(...top.mounts);
    for (const d of GEMINI_STATE_SUBDIRS) {
      if (existsSync(join(cli_dir, d))) out.hidden_state.push(d);
      await mkdir(join(scratch_cli, d), { recursive: true, mode: 0o700 });
    }
    for (const rel of GEMINI_WRITABLE_COPIES) {
      const dest = join(gemini_dir, ...rel.split("/"));
      let s = null;
      try { s = lstatSync(dest); } catch { /* absent */ }
      if (!s) { out.writable_copies.push({ path: rel, dest, status: "absent", why: "not on the host: not created (it stays absent, under the read-only ~/.gemini)" }); continue; }
      if (!s.isDirectory()) { out.writable_copies.push({ path: rel, dest, status: "skipped", why: `not a plain directory (${s.isSymbolicLink() ? "a symlink" : "another file type"}): left read-only` }); continue; }
      const src = join(scratch_root, "writable", ...rel.split("/"));
      await mkdir(src, { recursive: true, mode: 0o700 });
      const lvl = await copyLevel(dest, src);
      out.mounts.push({ dest, src, mode: "rw" }, ...lvl.mounts);
      out.writable_copies.push({ path: rel, dest, status: "copied", src, copied: lvl.copied, skipped: lvl.skipped, readonly_subdirs: lvl.readonly });
    }
    return out;
  } catch (e) {
    await rm(scratch_root, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

const listFiles = async (d, skipTop = new Set()) => {
  const files = [];
  const walk = async (dir, pre) => {
    for (const e of (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort(byName)) {
      const r = pre ? `${pre}/${e.name}` : e.name, p = join(dir, e.name);
      if (e.isDirectory()) { if (!pre && skipTop.has(e.name)) continue; await walk(p, r); }
      else files.push({ path: r, size: (await lstat(p).catch(() => null))?.size ?? null });
    }
  };
  await walk(d, "");
  return files;
};
const sameBytes = async (a, b) => {
  // A symlink is the same when its target is (a recreated link whose target file changed is not itself a write).
  const [la, lb] = await Promise.all([lstat(a).catch(() => null), lstat(b).catch(() => null)]);
  if (la?.isSymbolicLink() || lb?.isSymbolicLink()) {
    if (!la?.isSymbolicLink() || !lb?.isSymbolicLink()) return false;
    const [ta, tb] = await Promise.all([readlink(a).catch(() => null), readlink(b).catch(() => null)]);
    return ta !== null && ta === tb;
  }
  const [x, y] = await Promise.all([readFile(a).catch(() => null), readFile(b).catch(() => null)]); return Boolean(x && y && x.equals(y));
};

/**
 * What the CLI wrote into the per-run scratch copy, then remove it unless `keep`. Returns null when there was none, else
 * {dir, top_level: [{name, size, copied, changed}], subdirs: {<name>: [{path, size}]}, writable_subdirs: {<name>: [{path,
 * size, copied, changed}]}, writable_copies: {<rel>: [{path, size, copied, changed}]}} — `top_level` the files directly in antigravity-cli/ (copied: it came from the host;
 * changed: its bytes differ from the host's now), `subdirs` every directory of the scratch except the read-only mount
 * points (whose content is the host's, not a write), `writable_copies` the files of each GEMINI_WRITABLE_COPIES copy.
 */
export async function dropGeminiState(state, { keep = false } = {}) {
  if (!state?.enabled || !state.scratch_root) return null;
  const root = state.scratch_cli, listing = { dir: state.cli_dir, top_level: [], subdirs: {}, writable_subdirs: {}, writable_copies: {} };
  const ro = new Set(state.readonly_subdirs ?? []);
  const wsub = new Map((state.writable_subdirs ?? []).map(w => [w.name, w]));
  for (const e of (await readdir(root, { withFileTypes: true }).catch(() => [])).sort(byName)) {
    const p = join(root, e.name);
    if (e.isDirectory() && wsub.has(e.name)) {
      // A writable copy: a file it was given and left byte-identical is not a write.
      const w = wsub.get(e.name), given = new Set([...(w.copied ?? []), ...(w.symlinks ?? []).map(x => x.name)]);
      listing.writable_subdirs[e.name] = [];
      for (const f of await listFiles(p, new Set(w.readonly_subdirs ?? []))) {
        const copied = (w.deep || !f.path.includes("/")) && given.has(f.path);
        listing.writable_subdirs[e.name].push({ ...f, copied, changed: copied ? !(await sameBytes(join(p, f.path), join(w.src, f.path))) : true });
      }
      continue;
    }
    if (e.isDirectory()) {
      if (ro.has(e.name)) continue;
      listing.subdirs[e.name] = await listFiles(p);
    } else {
      const size = (await lstat(p).catch(() => null))?.size ?? null;
      const copied = (state.copied ?? []).includes(e.name);
      listing.top_level.push({ name: e.name, size, copied, changed: copied ? !(await sameBytes(p, join(state.cli_dir, e.name))) : true });
    }
  }
  for (const w of (state.writable_copies ?? []).filter(x => x.status === "copied")) {
    const files = await listFiles(w.src, new Set(w.readonly_subdirs ?? []));
    listing.writable_copies[w.path] = [];
    for (const f of files) {
      const copied = !f.path.includes("/") && (w.copied ?? []).includes(f.path);
      listing.writable_copies[w.path].push({ ...f, copied, changed: copied ? !(await sameBytes(join(w.src, f.path), join(w.dest, f.path))) : true });
    }
  }
  if (!keep) await rm(state.scratch_root, { recursive: true, force: true }).catch(() => {});
  return listing;
}
/** The real path of `p`, resolving the deepest existing ancestor when `p` itself is gone (a removed file). */
const realish = p => { const a = resolve(p); try { return realpathSync(a); } catch { const d = dirname(a); return d === a ? a : join(realish(d), basename(a)); } };
/**
 * HOW THE JAIL REACHES A HOST PATH. `binds` is bwrapArgs' bind list ([{mode, path, src?}] in emission order, over
 * `--ro-bind / /` and a fresh tmpfs on /tmp); mount semantics: at a jail path the LAST bind (in emission order) whose
 * destination contains it is what the jail sees. The host path `p` is `reachable_by_jail` when some read-write bind's
 * SOURCE contains it AND that bind is still what the jail sees at the corresponding jail path (no later bind hides it);
 * otherwise `outside_jail_reach`, with jail_view "hidden" (the jail sees another source there, or the /tmp tmpfs),
 * "read-only" (visible only through a read-only bind) or "no jail ran" (binds null). Returns {reach, jail_view, why,
 * via?: {mode, path, src?}, jail_path?}.
 */
export function jailReach(binds, p) {
  if (!Array.isArray(binds)) return { reach: "outside_jail_reach", jail_view: "no jail ran", why: "no jailed process ran while this was observed" };
  const host = realish(p);
  const seenAt = jp => { let e = null; for (const b of binds) if (inside(b.path, jp)) e = b; return e; };
  const via = b => (b ? { mode: b.mode, path: b.path, ...(b.src ? { src: b.src } : {}) } : null);
  for (const b of binds) {
    if (b.mode !== "rw") continue;
    const src = b.src ?? b.path;
    if (!inside(src, host)) continue;
    const jail_path = host === src ? b.path : join(b.path, relative(src, host));
    if (seenAt(jail_path) === b) return { reach: "reachable_by_jail", jail_view: "read-write", why: `mounted read-write in the jail at ${jail_path}`, via: via(b), jail_path };
  }
  const e = seenAt(host);
  if (!e) return inside("/tmp", host) ? { reach: "outside_jail_reach", jail_view: "hidden", why: "/tmp is a fresh tmpfs inside the jail" }
    : { reach: "outside_jail_reach", jail_view: "read-only", why: "visible only through the read-only bind of /" };
  if ((e.src ?? e.path) !== e.path) return { reach: "outside_jail_reach", jail_view: "hidden", why: `the jail sees ${e.src} at ${e.path}, not the host's`, via: via(e) };
  return { reach: "outside_jail_reach", jail_view: "read-only", why: `bound read-only at ${e.path}`, via: via(e) };
}

/** The directory to bind read-only so the CLI binary itself is visible inside the sandbox (/tmp is a fresh tmpfs). */
export const cliDirOf = cli => (cli.includes("/") ? dirname(real(cli)) : null);
