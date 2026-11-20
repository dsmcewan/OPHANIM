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
// HIDDEN: the OTHER units' control dirs (an empty tmpfs over the dedicated parent of the control dirs, or over each
// existing sibling control dir; siblingsHidden), so one unit's jail cannot read another's MCP config (its A2A bearer
// token) or reach its socket. The jail has its own PID namespace (--unshare-pid: /proc shows only the jail's processes)
// and session (--new-session). The network is shared (below).
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
//
// THE PYTHON SDK SEAT'S JAIL (sdkSeatJail, below the CLI's) is a second builder with the same conventions, around the WHOLE
// process of the SDK seat (scripts/agy-seat.py, its interpreter, and every tool it runs); see its header.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, lstatSync, realpathSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPromise } from "../board/spawn.mjs";
import { RELAY_URL_ENV, RELAY_CAPABILITY_ENV } from "../route/gemini-relay.mjs";
import { fdExecArgv, fdExecAvailable, fdExecPrefix, fdExecPython, FDS_PASSED } from "./fd-exec.mjs";

// The source tree the jail hook runs from (src/): it must stay visible inside every jail.
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
export function bwrapArgs({ worktree, control_dir, agy_state_dirs = [], extra_ro = [], gemini_state = null, bwrap = "bwrap", keep_visible = [process.execPath, HERE] }) {
  if (!worktree || !control_dir) throw new Error("bwrapArgs: pass the worktree and the control dir");
  const wt = real(worktree), ctl = real(control_dir), run = join(ctl, "run");
  if (inside(wt, ctl)) throw Object.assign(new Error(`the control dir ${ctl} is inside the worktree ${wt}`), { code: "CONTROL_IN_WORKTREE" });
  const binds = [];
  // OTHER UNITS' CONTROL DIRS ARE HIDDEN (independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6),
  // question 8): under the read-only bind of / they were readable, with their MCP config (the A2A bearer token) and
  // their A2A socket. See siblingsHidden.
  const needed = [wt, ...extra_ro, ...agy_state_dirs, ...(gemini_state?.enabled ? [gemini_state.gemini_dir, ...(gemini_state.mounts ?? []).flatMap(m => [m.src, m.dest])] : []), ...keep_visible].filter(Boolean).map(real);
  const hide = siblingsHidden(ctl, needed);
  for (const p of hide.paths) binds.push({ mode: "tmpfs", path: p });
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
  // --unshare-pid: a PID namespace of its own, so the fresh /proc lists only the jail's processes, not the host's (and
  // no host process's /proc/<pid>/root, cwd or fd links); --new-session: setsid, so the jailed CLI cannot push input
  // into the controller's terminal (TIOCSTI); --die-with-parent: the jail dies with the controller. Independent review
  // round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6), question 5. THE NETWORK IS NOT UNSHARED, by design (question
  // 8): the CLI must reach Google, so --unshare-net would cut the CLI itself, and bwrap has no egress filter; host
  // loopback services, the LAN and a cloud metadata endpoint stay reachable to the jailed CLI and to the code its verify
  // command runs. The A2A sockets are per unit and token-protected, and other units' control dirs are hidden (above).
  const argv = [bwrap, "--die-with-parent", "--unshare-pid", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const b of binds) {
    if (b.mode === "tmpfs") argv.push("--tmpfs", b.path);
    else argv.push(b.mode === "rw" ? "--bind" : "--ro-bind", b.src ?? b.path, b.path);
  }
  argv.push("--chdir", ctl, "--");
  return { argv, binds, git, hidden: { mode: hide.mode, paths: hide.paths, why: hide.why } };
}

const CONTROL_MARKS = ["jail.json", "pantheon-jail-hook", "a2a.sock", "a2a.token", "pantheon-verify", "verify.json", join(".agents", "mcp_config.json"), join(".agents", "hooks.json")];
const looksLikeControlDir = d => CONTROL_MARKS.some(m => { try { lstatSync(join(d, m)); return true; } catch { return false; } });
/**
 * Which host paths to cover with an empty tmpfs so this unit's jail cannot see the OTHER units' control dirs.
 * {mode: "parent", paths: [<parent of control_dir>]} when that parent is DEDICATED to control dirs (the pipeline's
 * <run>/control/<unit_id>: every entry a directory, and no path the jail needs -- the worktree, the state dirs, the CLI,
 * node, this source tree -- inside it): the whole parent is hidden, so a sibling created later is hidden too, and only
 * this unit's control dir is bound back. Otherwise {mode: "siblings", paths: [...]}: each EXISTING sibling directory
 * that looks like a control dir (CONTROL_MARKS) and holds nothing the jail needs (a sibling created after the launch
 * stays visible: the limit of this mode, recorded). {mode: "none"} when the parent is "/" or unreadable.
 */
export function siblingsHidden(ctl, needed = []) {
  const parent = dirname(ctl);
  if (parent === ctl || depth(parent) < 1) return { mode: "none", paths: [], why: "the control dir has no parent to hide" };
  if (inside("/tmp", parent)) return { mode: "none", paths: [], why: "under /tmp, which is a fresh tmpfs inside the jail: only the binds are visible there" };
  let entries;
  try { entries = readdirSync(parent, { withFileTypes: true }); } catch { return { mode: "none", paths: [], why: `${parent} cannot be listed` }; }
  const neededIn = p => needed.some(n => inside(p, n) && !inside(ctl, n));
  const dedicated = !neededIn(parent) && entries.every(e => e.isDirectory());
  if (dedicated) return { mode: "parent", paths: [parent], why: `${parent} holds only control dirs: hidden whole, ${ctl} bound back` };
  const paths = entries.filter(e => e.isDirectory()).map(e => join(parent, e.name)).filter(p => p !== ctl && !neededIn(p) && looksLikeControlDir(p)).sort();
  return { mode: "siblings", paths, why: `${parent} holds more than control dirs: only the existing sibling control dirs are hidden (one created later would stay visible)` };
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
    const err = await rm(scratch_root, { recursive: true, force: true }).then(() => null, x => x);
    if (err || existsSync(scratch_root)) e.scratch_removal_error = { code: err?.code ?? "STILL_PRESENT", message: String(err?.message ?? "the partial scratch still exists").slice(0, 300), path: scratch_root };
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
export async function dropGeminiState(state, { keep = false, remove = p => rm(p, { recursive: true, force: true }) } = {}) {
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
  // A removal that fails is SURFACED, not swallowed (independent review round 2, assignment 4 (OpenAI gpt-6-astra,
  // 77480d6), question 7): the scratch holds a copy of the OAuth token. `removed` says whether it is gone.
  if (!keep) {
    const err = await Promise.resolve().then(() => remove(state.scratch_root)).then(() => null, e => e);
    const left = existsSync(state.scratch_root);
    listing.removed = !err && !left;
    if (err || left) listing.removal_error = { code: err?.code ?? "STILL_PRESENT", message: String(err?.message ?? `${state.scratch_root} still exists after removal`).slice(0, 300), path: state.scratch_root, contains_credentials: true };
  } else listing.removed = false;
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
  const out = !e ? (inside("/tmp", host) ? { reach: "outside_jail_reach", jail_view: "hidden", why: "/tmp is a fresh tmpfs inside the jail" }
    : { reach: "outside_jail_reach", jail_view: "read-only", why: "visible only through the read-only bind of /" })
    : e.mode === "tmpfs" ? { reach: "outside_jail_reach", jail_view: "hidden", why: `an empty tmpfs covers ${e.path} inside the jail`, via: via(e) }
    : (e.src ?? e.path) !== e.path ? { reach: "outside_jail_reach", jail_view: "hidden", why: `the jail sees ${e.src} at ${e.path}, not the host's`, via: via(e) }
    : { reach: "outside_jail_reach", jail_view: "read-only", why: `bound read-only at ${e.path}`, via: via(e) };
  // A HARD LINK defeats path-based reach (independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6),
  // question 10): realpath cannot name its aliases, and one of them may sit under a read-write bind. A regular file with
  // more than one link is therefore UNRESOLVED, never "outside the jail's reach".
  let st = null;
  try { st = lstatSync(host); } catch { /* gone: path-based reach is all there is */ }
  if (st?.isFile() && st.nlink > 1) return { ...out, reach: "unresolved", why: `${out.why}; but it has ${st.nlink} hard links (dev ${st.dev}, inode ${st.ino}): an alias under a read-write bind could have written it`, nlink: st.nlink, dev: st.dev, ino: st.ino };
  return out;
}

/** The directory to bind read-only so the CLI binary itself is visible inside the sandbox (/tmp is a fresh tmpfs). */
export const cliDirOf = cli => (cli.includes("/") ? dirname(real(cli)) : null);

// ---- THE PYTHON SDK SEAT'S JAIL ----------------------------------------------------------------------------------------
// THE PYTHON SDK SEAT'S JAIL (register L-155; owner decision 2026-11-20, "Yes, bubble per seat"; knowledge graphs, Slice C2,
// docs/knowledge-graph/slice-c2.md). Before it, the SDK seat was a plain child process of the controller: its agent's
// run_command ran as the controller's user, outside any sandbox, and could read the controller's environment through
// /proc/<pid>/environ -- which holds GEMINI_API_KEY, the metering relay's real credential -- and spend outside the relay.
// Now the seat's WHOLE PROCESS (the python interpreter running scripts/agy-seat.py, and so the SDK's harness and every tool
// it runs, run_command included) runs inside bwrap, at BOTH spawn points (board/run-item.mjs, the board's SDK seat;
// bin/agy-seat.mjs, the governed direct launch of L-151), built by this one builder after bwrapArgs's conventions:
//   - the host READ-ONLY (--ro-bind / /), a fresh /dev, and a fresh tmpfs on /tmp: the seat's scratch, which exists only in
//     the jail's mount namespace and is gone when its last process exits;
//   - --unshare-pid with a fresh /proc: no process of the controller is visible in the jail, so no /proc/<pid>/environ of
//     the controller can be read; --new-session (setsid: no TIOCSTI into the controller's terminal); --die-with-parent;
//   - HIDDEN, as an empty tmpfs remounted read-only over each directory and /dev/null over each file (sdkSeatHidden): every
//     HOME the controller has ($HOME, os.homedir(), the passwd entry's), and with it every credential location under it --
//     the ADC file and the gcloud config under ~/.config/gcloud, the Antigravity CLI's state and OAuth login under ~/.gemini;
//     the user's runtime dir (XDG_RUNTIME_DIR, /run/user/<uid>: agent sockets); the ssh agent's socket; and the file and
//     directory the controller's own environment names as Google credentials (GOOGLE_APPLICATION_CREDENTIALS, CLOUDSDK_CONFIG);
//   - VISIBLE, read-only, bound back where a hidden location covers them: the python interpreter and its venv (and the
//     venv's base interpreter), the repository, the seat script, and the files the seat reads (its brief, its schema);
//   - WRITABLE: the workspace and the seat's out dir (the seat's own HOME is a directory inside it), and nothing else but the
//     jail's /tmp;
//   - THE ENVIRONMENT IS AN ALLOWLIST (sdkSeatEnv, SDK_JAIL_ENV_ALLOW): the relay capability, HOME, PATH, the locale, the
//     terminal and user names, the proxy and certificate settings, TMPDIR=/tmp. Nothing is inherited by default: the spawn is
//     given exactly this environment. It is built from agySdkEnvOf's (board/agy-cli.mjs), whose withholding stays, and is
//     RE-CHECKED here: a credential-named variable (SDK_JAIL_ENV_REFUSED: GEMINI_API_KEY, GOOGLE_*, Vertex, ADC, any
//     KEY/TOKEN/SECRET name) refuses the seat (SDK_JAIL_ENV) instead of being dropped, so a regression upstream fails loudly;
//   - THE NETWORK IS SHARED, and recorded as RETAINED (runtimes.json limitation sdk-jail-egress, as L-004 is for the CLI
//     lanes): the relay listens on loopback and the scout's web tools need egress, so there is no --unshare-net and bwrap
//     has no egress filter. Host loopback services, the LAN and a cloud metadata endpoint stay reachable from the jail, and
//     so do host Unix sockets outside the hidden locations (a read-only mount does not stop connect()). It is never claimed
//     isolated.
//   - NO DESCRIPTOR BEYOND 0, 1 AND 2 (register KG-11; src/agy/fd-exec.mjs): bwrap is started through the descriptor
//     closer (`prefix` is [python3, -I, -S, -c, FD_EXEC_PY, bwrap, ...]), a single-threaded process that closes every
//     descriptor above 2, checks that none is left, and execs bwrap in its place with the environment and the signal
//     dispositions it was given. The seat is given stdin, stdout and stderr only, on purpose, and nothing else;
//   - FAIL CLOSED: no bwrap, a failing probe of the jail's own flags, or a descriptor closer that does not work here
//     (sdkJailAvailable) refuses the seat before the spawn and before anything is admitted or charged (SANDBOX_UNAVAILABLE).
//     There is NO override: the CLI's allowUnsandboxed is not extended to the SDK seat. A closer that cannot establish the
//     property at the spawn itself exits 125 and starts nothing.
//   - SINGLE-ASSIGNMENT LIFETIME: the spawn point removes the seat's HOME after the assignment on every path (success,
//     refusal, timeout, kill: dropSdkSeatScratch), its /tmp dies with the jail, and the relay session is closed and its
//     capability revoked.
// Must never: run the SDK seat without this jail; give it an environment it was not explicitly allowed; make anything but
// the workspace and the out dir writable on the host; claim the network isolated.
export const SDK_JAIL_ENV_ALLOW = Object.freeze(["PATH", "HOME", "LANG", "LANGUAGE", "TZ", "TERM", "USER", "LOGNAME", "SHELL",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", RELAY_URL_ENV, RELAY_CAPABILITY_ENV]);
export const SDK_JAIL_ENV_PREFIXES = Object.freeze(["LC_"]);
/** A variable whose name says credential: never in the SDK seat's jail; its presence refuses the seat (the jail's re-check). */
export const SDK_JAIL_ENV_REFUSED = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|^GOOGLE_|^GEMINI_|^CLOUDSDK_|VERTEX/i;
const jailError = (code, message, more = {}) => Object.assign(new Error(message), { code, ...more });
const layoutRefusal = message => jailError("SDK_JAIL_LAYOUT", `the python SDK seat's jail cannot be built: ${message}; refusing to run the python SDK seat unjailed`);

/**
 * The SDK seat's environment inside its jail: {env, dropped: [names]} -- only the names of SDK_JAIL_ENV_ALLOW, the LC_
 * locale and what `pass` (the controller's PANTHEON_AGY_ENV_PASS, an explicit operator list) names, plus TMPDIR=/tmp.
 * Throws SDK_JAIL_ENV (names only, never a value) when `env` carries a credential-named variable.
 */
export function sdkSeatEnv(env = {}, { pass = "" } = {}) {
  const passed = String(pass ?? "").split(/[:,]/).map(s => s.trim()).filter(Boolean);
  const allowed = k => SDK_JAIL_ENV_ALLOW.includes(k) || SDK_JAIL_ENV_PREFIXES.some(p => k.startsWith(p))
    || passed.some(p => (p.endsWith("*") ? k.startsWith(p.slice(0, -1)) : k === p));
  const out = {}, dropped = [], refused = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === undefined || v === null) continue;
    if (SDK_JAIL_ENV_REFUSED.test(k)) refused.push(k);
    else if (allowed(k)) out[k] = String(v);
    else dropped.push(k);
  }
  if (refused.length) throw jailError("SDK_JAIL_ENV", `the python SDK seat's environment carries credential-named variable(s) ${refused.sort().join(", ")}: refusing to run the seat (agySdkEnvOf withholds them; this is the jail's re-check)`, { refused: refused.sort() });
  out.TMPDIR = "/tmp";
  return { env: out, dropped: dropped.sort() };
}

/** Every HOME the controller has: $HOME, os.homedir() and the passwd entry's (real paths, de-duplicated). */
export function controllerHomes(base = process.env) {
  let passwd = null;
  try { passwd = userInfo().homedir; } catch { /* no passwd entry */ }
  return [...new Set([base?.HOME, homedir(), passwd].filter(h => typeof h === "string" && h).map(real))];
}
/**
 * The host locations the SDK seat's jail hides: [{path, kind: "dir" | "file", why}] for each that exists -- the
 * controller's HOMEs, the user's runtime dir, the ssh agent's socket, and the Google credential file and gcloud config the
 * controller's environment `base` names. A HOME of "/" cannot be hidden without hiding the host: refused (SDK_JAIL_LAYOUT).
 */
export function sdkSeatHidden(base = process.env, { homes = controllerHomes(base), uid = process.getuid?.() } = {}) {
  const out = [];
  const add = (p, why) => {
    if (typeof p !== "string" || !p) return;
    const r = real(p);
    let st;
    try { st = statSync(r); } catch { return; }
    if (r === "/") throw layoutRefusal(`${why} is "/", which cannot be hidden without hiding the host`);
    if (!out.some(h => h.path === r)) out.push({ path: r, kind: st.isDirectory() ? "dir" : "file", why });
  };
  for (const h of homes) add(h, "the controller's HOME, and every credential location under it (~/.config/gcloud: the ADC file and the gcloud config; ~/.gemini: the Antigravity CLI's state and login)");
  add(base?.XDG_RUNTIME_DIR, "the user's runtime dir (agent sockets)");
  if (Number.isInteger(uid)) add(`/run/user/${uid}`, "the user's runtime dir (agent sockets)");
  add(base?.SSH_AUTH_SOCK, "the ssh agent's socket");
  add(base?.GOOGLE_APPLICATION_CREDENTIALS, "the Google credential file the controller's environment names");
  add(base?.CLOUDSDK_CONFIG, "the gcloud config the controller's environment names");
  return out;
}

/**
 * What of the interpreter `python` must be visible: the path given; its venv (when <python>/../../pyvenv.cfg exists) and the
 * venv's base interpreter's prefix (pyvenv.cfg `home`); its real path; and, for a binary (not a #! script), the prefix
 * of its real path (its standard library lives under it).
 */
export function interpreterPaths(python) {
  const p = resolve(python), out = [p];
  const venv = dirname(dirname(p)), cfg = join(venv, "pyvenv.cfg");
  if (existsSync(cfg)) {
    out.push(venv);
    const m = /^\s*home\s*=\s*(.+?)\s*$/m.exec(readFileSync(cfg, "utf8"));
    if (m && isAbsolute(m[1])) out.push(dirname(real(m[1])));
  }
  const rp = real(p);
  if (rp !== p) out.push(rp);
  let head = "";
  try { const fd = openSync(rp, "r"); try { const b = Buffer.alloc(2); readSync(fd, b, 0, 2, 0); head = b.toString("latin1"); } finally { closeSync(fd); } } catch { /* unreadable: the spawn says so */ }
  if (head && head !== "#!") out.push(dirname(dirname(rp)));
  return [...new Set(out)];
}

/**
 * THE SDK SEAT'S JAIL (see the header): {prefix: [python3, -I, -S, -c, FD_EXEC_PY, "bwrap", ..., "--"], fds: {argv, passed}, env, home,
 * binds: [{mode: "tmpfs" | "ro" | "rw" | "null", path}], hidden, visible, writable, dropped, record}. The spawn is
 * `[...prefix, python, script, ...args]` with `env` and nothing else: the descriptor closer (fds.argv, src/agy/fd-exec.mjs)
 * first, then bwrap. `env` is agySdkEnvOf's (its HOME must be a directory inside `out_dir`); `read` are files the seat
 * reads (made visible when hidden); `base` is the controller's environment (the hidden locations, the operator's pass list);
 * `closerPython` the python3 that runs the closer (on the host, before bwrap).
 * Throws SDK_JAIL_LAYOUT (a path that would expose a hidden location, a missing workspace or out dir, a HOME outside the out
 * dir) or SDK_JAIL_ENV (see sdkSeatEnv). Never spawns anything.
 */
export function sdkSeatJail({ python, script, repo, workspace, out_dir, env, read = [], bwrap = "bwrap", closerPython = fdExecPython(), base = process.env, hidden = sdkSeatHidden(base) }) {
  if (!python || !script || !repo || !workspace || !out_dir || !env) throw new Error("sdkSeatJail: pass the python, the script, the repository, the workspace, the out dir and the env");
  const hiddenDirs = [...hidden.filter(h => h.kind === "dir").map(h => h.path), "/tmp"];
  const exposes = p => p === "/" || hiddenDirs.includes(p) || hidden.some(h => h.path === p);
  const writable = [];
  for (const [name, p0] of [["workspace", workspace], ["out dir", out_dir]]) {
    const p = real(p0);
    let st = null;
    try { st = statSync(p); } catch { /* missing */ }
    if (!st?.isDirectory()) throw layoutRefusal(`the ${name} ${p} is not a directory`);
    if (exposes(p)) throw layoutRefusal(`the ${name} ${p} is a location the jail hides (or the whole host): binding it writable would expose it`);
    if (!writable.includes(p)) writable.push(p);
  }
  const out = real(out_dir);
  const { env: jailEnv, dropped } = sdkSeatEnv(env, { pass: base?.PANTHEON_AGY_ENV_PASS ?? "" });
  const home = typeof jailEnv.HOME === "string" && jailEnv.HOME ? real(jailEnv.HOME) : null;
  if (!home || home === out || !inside(out, home)) throw layoutRefusal(`the seat's HOME (${jailEnv.HOME ?? "unset"}) is not a directory of its own inside its out dir ${out}`);
  // Read-only binds: only what a hidden location (or the fresh /tmp) covers; the rest is visible through the read-only host.
  const covered = p => hiddenDirs.some(h => inside(h, p)) || hidden.some(h => h.path === p);
  const visible = [];
  for (const p0 of [repo, script, ...interpreterPaths(python), ...read].filter(Boolean)) {
    const p = real(p0);
    if (!existsSync(p) || !covered(p)) continue;
    if (exposes(p)) throw layoutRefusal(`${p} is a location the jail hides (or the whole host): binding it back would expose it`);
    if (!visible.includes(p)) visible.push(p);
  }
  // A read-only bind inside another one is redundant unless a hidden location lies between them.
  const ro = visible.filter(c => !visible.some(p => p !== c && inside(p, c) && !hiddenDirs.some(h => h !== p && inside(p, h) && inside(h, c))));
  const binds = [...hidden.map(h => ({ mode: h.kind === "dir" ? "tmpfs" : "null", path: h.path })),
    ...ro.map(p => ({ mode: "ro", path: p })), ...writable.map(p => ({ mode: "rw", path: p }))];
  // Parent-first by depth (a stable sort: at equal depth, what hides before what is bound), so a deeper bind overrides a
  // shallower one whatever their kinds.
  binds.sort((a, b) => depth(a.path) - depth(b.path));
  const prefix = [bwrap, "--die-with-parent", "--unshare-pid", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const b of binds) {
    if (b.mode === "tmpfs") prefix.push("--tmpfs", b.path);
    else if (b.mode === "null") prefix.push("--ro-bind", "/dev/null", b.path);
    else prefix.push(b.mode === "rw" ? "--bind" : "--ro-bind", b.path, b.path);
  }
  // Each hidden directory read-only too, after the binds that need mount points in it: a write there fails inside the jail
  // instead of landing, unseen, in a tmpfs.
  for (const h of hidden) if (h.kind === "dir") prefix.push("--remount-ro", h.path);
  prefix.push("--chdir", real(workspace), "--");
  // NO DESCRIPTOR BEYOND 0, 1 AND 2 (KG-11): bwrap starts through the descriptor closer, in front of it.
  const fds = { argv: fdExecPrefix({ closerPython }), passed: [...FDS_PASSED] };
  return { prefix: fdExecArgv(prefix, { closerPython }), fds, env: jailEnv, home, binds, hidden, visible: ro, writable, dropped,
    record: { kind: "bwrap", hidden: hidden.map(h => ({ path: h.path, kind: h.kind, why: h.why })), visible: ro, writable, home,
      env: Object.keys(jailEnv).sort(), dropped, network: "shared (retained: sdk-jail-egress)",
      descriptors: { passed: [...FDS_PASSED], closer: "src/agy/fd-exec.mjs: a single-threaded python3 closes every descriptor above 2 before bwrap" } } };
}

const jailProbes = new Map();
/**
 * Can the SDK seat's jail be made here? sandboxAvailable, then the jail's own flags (a PID namespace with a fresh /proc, a new
 * session, a tmpfs remounted read-only), then the descriptor closer with `closerPython` (fdExecAvailable), once per pair
 * (cached). {ok, why?}; never throws.
 */
export function sdkJailAvailable(bwrap = "bwrap", { closerPython = fdExecPython() } = {}) {
  const key = `${bwrap}\0${closerPython}`;
  if (!jailProbes.has(key)) {
    jailProbes.set(key, (async () => {
      const base = await sandboxAvailable(bwrap);
      if (!base.ok) return base;
      try {
        const r = await spawnPromise(bwrap, ["--die-with-parent", "--unshare-pid", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--remount-ro", "/tmp", "true"], { timeout: 10000 });
        if (r.status !== 0) return { ok: false, why: `the jail probe (a PID namespace, a fresh /proc) exited ${r.status ?? r.killedFor}: ${String(r.stderr ?? "").trim().slice(0, 200)}` };
      } catch (e) {
        return { ok: false, why: `bwrap could not be started: ${e?.code ?? e?.message ?? e}` };
      }
      // KG-11: the seat starts with no descriptor beyond 0, 1 and 2, or it does not start.
      const fds = await fdExecAvailable({ closerPython });
      if (!fds.ok) return { ok: false, why: `no descriptor beyond 0, 1 and 2 can be guaranteed: ${fds.why}` };
      return { ok: true };
    })());
  }
  return jailProbes.get(key);
}
/**
 * THE GATE of both spawn points, called before anything is admitted, charged or spawned: {bwrap, closerPython, build(spec)}
 * where build is sdkSeatJail with this bwrap and this python3 (the descriptor closer's). Throws SANDBOX_UNAVAILABLE when the
 * jail cannot be made, its descriptor closer included (no python3 included). There is no override.
 */
export async function sdkSeatJailGate({ bwrap = "bwrap", closerPython = fdExecPython() } = {}) {
  const probe = await sdkJailAvailable(bwrap, { closerPython });
  if (!probe.ok) throw jailError("SANDBOX_UNAVAILABLE", `the python SDK seat's bwrap jail is unavailable (${probe.why}); refusing to run the python SDK seat unjailed (there is no override)`, { why: probe.why, provider_requests: 0 });
  return { bwrap, closerPython, build: spec => sdkSeatJail({ ...spec, bwrap, closerPython }) };
}
/**
 * The seat's single-assignment teardown: its HOME (`jail.home`, a directory of its out dir) removed. The jail's /tmp needs
 * nothing: it was a tmpfs of the jail's mount namespace. Returns null without a HOME, else {home, removed, removal_error?}:
 * a removal that fails is surfaced, never swallowed.
 */
export async function dropSdkSeatScratch(jail) {
  const home = jail?.home;
  if (!home) return null;
  const err = await rm(home, { recursive: true, force: true }).then(() => null, e => e);
  const left = existsSync(home);
  return { home, removed: !err && !left, ...(err || left ? { removal_error: { code: err?.code ?? "STILL_PRESENT", message: String(err?.message ?? `${home} still exists after removal`).slice(0, 300) } } : {}) };
}
