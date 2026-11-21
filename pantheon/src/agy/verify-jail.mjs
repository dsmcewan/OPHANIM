#!/usr/bin/env node
// THE VERIFY JAIL: the ONE launcher through which worker-controlled code runs, for the worker (agy's run_command) and
// for the controller (pipeline/review.mjs runVerify). It enforces the CREDENTIAL-ISOLATION INVARIANT below; the doc
// is docs/routing-task-profile.md, "Credential isolation".
//
// THE INVARIANT. No process spawned from worker-controlled content can obtain, or disclose, a credential.
//   CREDENTIAL-BEARING processes (trusted): the controller (it holds the provider keys, the checkpoint seal key and every
//   unit's A2A token); the A2A shim (inside the controller); the agy CLI (it holds the Antigravity OAuth state: the
//   per-run scratch copy of ~/.gemini/antigravity-cli, the token included, and reads the unit's MCP config); the stdio
//   MCP relay a2a-mcp-server.mjs (agy's child; it reads the unit's A2A token from its token file).
//   UNTRUSTED processes: every process spawned from worker-controlled content -- the unit's verify_cmd and anything it
//   runs (its scripts, tests, package hooks, children, daemons), whether started by the worker's run_command or by the
//   controller's ground-truth runVerify. They run ONLY through this launcher, in a fresh bwrap jail, and in that jail:
//   ENV        a clean allowlist (verifyEnvOf): no provider key, no A2A or AGY/ANTIGRAVITY/PANTHEON variable, no
//              secret-named variable, no proxy variable, no value carrying a user:password; PATH is the jail's own,
//              HOME=/tmp/home, TMPDIR=/tmp, GIT_CONFIG_NOSYSTEM=1.
//   FILESYSTEM an ALLOWLIST, not the host: an empty root with /usr and the /bin, /sbin, /lib* dirs or links; from /etc
//              only ETC_ALLOW (certificate stores, never /etc/ssl/private; the loader cache; alternatives; tz; nsswitch;
//              shells; protocols; services; os-release) and a GENERATED passwd, group and hosts; the node toolchain's
//              prefix; /proc, /dev and /tmp of its own; the unit's worktree (read-write); its git dirs (read-only) with
//              every git config REPLACED by a sanitized one (sanitizedGitConfig: core and extensions keys only -- no
//              remote, credential, include, url rewrite, hooksPath, fsmonitor, sshCommand) and FETCH_HEAD, logs/,
//              remotes/, branches/, modules/ hidden (a remote URL with a token can sit in any of them); `extra_ro`
//              read-only. So no home (~/.gemini with the OAuth token, ~/.ssh, ...), no /opt, /var, /srv, /mnt, /run, no
//              other /etc file exists in the jail. The unit's control dir (role card, hooks, jail.json, mcp_config.json,
//              the A2A token file, the A2A socket, run/ with the OAuth scratch copy), its siblings, the A2A socket's
//              directory, the agy state dirs, the Gemini layout (prepareWorkerJail adds them) and the caller's list (the
//              controller: the run dir, the checkpoints and their seal key) are hidden again should a bound path
//              contain them, and a bind inside one of them (or a home's secret dir) is refused.
//   FDS        no inherited descriptor but 0, 1 and 2 reaches the script (register KG-11). bwrap itself passes inherited
//              fds through (observed with bubblewrap 0.9.0: an `exec 7<file` shell's fd 7 was open in the jailed command),
//              and node marks only a LOW range of inherited fds close-on-exec at startup (observed on node 24.22: 0..16;
//              an inherited fd 20 above a gap stays inheritable). So the launcher starts bwrap THROUGH THE DESCRIPTOR
//              CLOSER (src/agy/fd-exec.mjs): a single-threaded python3 program that closes every descriptor above 2,
//              checks that none is left, and execs bwrap in its place; when it cannot (no python3 included), it exits
//              VERIFY_JAIL_REFUSED and nothing runs. The script is given stdin, stdout and stderr on purpose, and nothing
//              else.
//   /proc      its own PID namespace (--unshare-pid) and a fresh /proc: no credential-bearing process is visible, so
//              no /proc/<pid>/{environ,cmdline,fd,mem,root} of one can be opened, and none can be signalled or traced.
//              Also --unshare-ipc, --unshare-uts, --cap-drop ALL and --new-session (no TIOCSTI into a terminal).
//   NETWORK    NONE: --unshare-net (a loopback of its own only). The host's loopback services, the LAN, a cloud
//              metadata address (169.254.169.254) and the host's ABSTRACT Unix sockets (they belong to a network
//              namespace) are unreachable; no path socket exists in the jail but under the worktree. A policy asking for
//              network (`network`) is REFUSED, never granted: a verify that needs it fails, explicitly.
// The launcher refuses (exit VERIFY_JAIL_REFUSED) when bwrap cannot start the jail or the descriptor closer cannot close
// the inherited descriptors; it never falls back to running unjailed unless the policy says `allow_unjailed: true` (then
// still a clean env and, through the same closer, no descriptor beyond 0, 1 and 2, recorded as such).
//
// Used as:
//   node verify-jail.mjs <policy.json>          the worker's command, through the per-unit wrapper <control_dir>/pantheon-verify
//   node verify-jail.mjs --inline '<json>'      the controller's runVerify
//   node verify-jail.mjs <policy.json> -- <test files>   a review suite launcher with `test_files: true` (the files
//                                               are checked and appended, quoted, to `script`: `node --test`)
// Policy {schema: VERIFY_JAIL_SCHEMA, worktree, cwd?, script, control_dir?, hide?: [abs], extra_ro?: [abs],
// bwrap?, allow_unjailed?, test_files?}. `script` runs as `/bin/sh -c <script>` with cwd = `cwd` (default the worktree).
//
// Must never: run the script with an inherited descriptor beyond stdio, with an env variable outside the allowlist,
// with a host path outside the allowlist visible, or with network; write anything but its private scratch dir (the
// generated passwd/group/hosts and git configs, removed when the script ends).
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repoGitDirs, siblingsHidden } from "./sandbox.mjs";
import { VERIFY_LAUNCHER_NAME } from "./jail-hook.mjs";
import { fdExecArgv, resolveCommand } from "./fd-exec.mjs";

export const VERIFY_JAIL_SCHEMA = "pantheon.verify-jail/v1";
export const VERIFY_JAIL_MODULE = fileURLToPath(import.meta.url);
/** The per-unit wrapper (the worker's ONE command; jail-hook.mjs VERIFY_LAUNCHER_NAME) and its policy, both in the control dir (read-only to the worker). */
export { VERIFY_LAUNCHER_NAME };
export const VERIFY_POLICY_NAME = "verify.json";
/** The launcher's own refusal (no jail could be built, a bad policy): distinct from any exit of the script. */
export const VERIFY_JAIL_REFUSED = 125;
/** Never bound into a verify jail, under any home (and re-hidden inside any bound path that contains one). */
export const HOME_SECRET_DIRS = Object.freeze([".gemini", ".ssh", ".gnupg", ".aws", ".azure", ".config", ".codex", ".claude", ".docker", ".kube",
  ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".password-store", ".local/share", ".pantheon", ".ophanim", ".cache"]);

const inside = (root, p) => p === root || p.startsWith(root === "/" ? "/" : root + sep);
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
const depth = p => p.split(sep).filter(Boolean).length;
const kindOf = p => { try { const s = lstatSync(p); return s.isDirectory() ? "dir" : "file"; } catch { return null; } };

// ---- ENV ------------------------------------------------------------------------------------------------------------
export const VERIFY_ENV_ALLOW = Object.freeze(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TZ"]);
export const VERIFY_ENV_PREFIXES = Object.freeze(["LC_"]);
/** Never passed: the jail has no network, so a proxy (or a CA file outside the jail) means nothing there. */
export const VERIFY_ENV_PROXIES = Object.freeze(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "ALL_PROXY", "all_proxy"]);
/** A variable name whose value never enters a verify jail, whatever list names it. */
export const VERIFY_ENV_SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|SESSION|BEARER/i;
/** Prefixes that never enter a verify jail: the controller's, agy's and the relay's own variables. */
export const VERIFY_ENV_NEVER = Object.freeze(["PANTHEON_", "AGY_", "ANTIGRAVITY_", "GEMINI_", "GOOGLE_", "OPENAI_", "ANTHROPIC_", "XAI_", "FAKE_AGY_"]);
const USERINFO = /:\/\/[^/@\s]*@/;
/**
 * The verify jail's environment from `base` (default process.env): VERIFY_ENV_ALLOW, LC_*, and the names (or PREFIX*
 * patterns) the operator lists in PANTHEON_VERIFY_ENV_PASS; never a VERIFY_ENV_SECRETISH name, a VERIFY_ENV_NEVER prefix,
 * a proxy variable or a value carrying a user:password, whatever the lists say. TMPDIR is /tmp (the jail's own tmpfs);
 * the launcher then sets PATH (the jail's own), HOME=/tmp/home and GIT_CONFIG_NOSYSTEM=1. Returns {env, dropped: [names]}.
 */
export function verifyEnvOf(base = process.env) {
  const pass = String(base?.PANTHEON_VERIFY_ENV_PASS ?? "").split(/[:,]/).map(s => s.trim()).filter(Boolean);
  const env = {}, dropped = [];
  for (const [k, v] of Object.entries(base ?? {})) {
    if (typeof v !== "string") continue;
    const never = VERIFY_ENV_SECRETISH.test(k) || VERIFY_ENV_NEVER.some(p => k.startsWith(p));
    const listed = VERIFY_ENV_ALLOW.includes(k) || VERIFY_ENV_PREFIXES.some(p => k.startsWith(p))
      || pass.some(p => (p.endsWith("*") ? k.startsWith(p.slice(0, -1)) : k === p));
    const proxy = VERIFY_ENV_PROXIES.includes(k) || USERINFO.test(v);
    if (!never && !proxy && listed) env[k] = v; else dropped.push(k);
  }
  env.TMPDIR = "/tmp";
  return { env, dropped: dropped.sort() };
}

/**
 * The environment to START the launcher with from a trusted caller (runVerify, the validate stage): the clean verify env
 * plus PANTHEON_VERIFY_ENV_PASS itself (not secret), so the launcher's own verifyEnvOf passes the same operator-listed
 * names on into the jail.
 */
export function launcherEnv(base = process.env) {
  return { ...verifyEnvOf(base).env, ...(base?.PANTHEON_VERIFY_ENV_PASS ? { PANTHEON_VERIFY_ENV_PASS: String(base.PANTHEON_VERIFY_ENV_PASS) } : {}) };
}

// ---- FILESYSTEM -----------------------------------------------------------------------------------------------------
// THE BASE IS AN ALLOWLIST (as board/acceptance.mjs): an empty root, then only what a verify command needs to run node,
// git and sh. Nothing else of the host exists in the jail: no home, no /opt, /var, /srv, /mnt, /media, /run, no /etc
// beyond the list below, no /sys.
/** The host's top-level system dirs: bound read-only when they are directories, recreated when they are symlinks (/bin -> usr/bin). */
export const SYSTEM_DIRS = Object.freeze(["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"]);
/**
 * The /etc entries bound read-only (when present; a symlink is recreated). The certificate stores only (never
 * /etc/ssl/private); the loader's cache and config; the alternatives links (Debian's /usr/bin/awk etc. point there);
 * timezone, nsswitch, shells, protocols, services, os-release. /etc/passwd, /etc/group and /etc/hosts are GENERATED
 * (one line each for root and the caller); there is no resolv.conf (there is no network) and no /etc/gitconfig.
 */
export const ETC_ALLOW = Object.freeze(["ssl/certs", "ssl/cert.pem", "ca-certificates", "ca-certificates.conf", "pki/ca-trust", "pki/tls/certs", "ld.so.cache", "ld.so.conf", "ld.so.conf.d",
  "alternatives", "localtime", "timezone", "nsswitch.conf", "shells", "protocols", "services", "os-release"]);
/** The git config keys a verify jail keeps (everything else -- remotes, credentials, includes, url rewrites, hooksPath, fsmonitor, sshCommand -- is dropped). */
export const GIT_CONFIG_KEEP = Object.freeze({ core: ["repositoryformatversion", "filemode", "bare", "symlinks", "ignorecase", "precomposeunicode", "logallrefupdates"],
  extensions: ["objectformat", "compatobjectformat", "worktreeconfig", "refstorage"] });
/**
 * A sanitized git config from `text`: only GIT_CONFIG_KEEP keys of the plain [core] and [extensions] sections, with
 * plain values; never a remote, a credential helper, an include, a url rewrite or anything that runs a program.
 */
export function sanitizedGitConfig(text = "") {
  let sec = null;
  const out = {};
  for (const raw of String(text).split("\n")) {
    const l = raw.trim();
    if (!l || l[0] === "#" || l[0] === ";") continue;
    const h = /^\[([A-Za-z0-9.-]+)(\s+"[^"]*")?\]$/.exec(l);
    if (h) { sec = h[2] ? null : h[1].toLowerCase(); continue; }
    if (l.startsWith("[")) { sec = null; continue; }
    if (!sec || !GIT_CONFIG_KEEP[sec]) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(l);
    if (!kv) continue;
    const k = kv[1].toLowerCase(), v = (kv[2] ?? "true").trim();
    if (!GIT_CONFIG_KEEP[sec].includes(k) || !/^[A-Za-z0-9_.-]+$/.test(v)) continue;
    (out[sec] ??= {})[k] = v;
  }
  if (out.core?.repositoryformatversion === undefined) (out.core ??= {}).repositoryformatversion = "0";
  return Object.entries(out).map(([sec, kv]) => `[${sec}]\n${Object.entries(kv).map(([k, v]) => `\t${k} = ${v}`).join("\n")}\n`).join("");
}
/** Git files a verify jail never sees (they may carry a remote URL with a token: FETCH_HEAD, the clone's reflog). */
const GIT_HIDE_FILES = Object.freeze(["FETCH_HEAD"]);
const GIT_HIDE_DIRS = Object.freeze(["logs", "remotes", "branches", "modules"]);

/**
 * The bwrap argv of one verify jail. Returns {argv, files: [{name, content}] (written by the launcher into `scratch`
 * and bound read-only), hidden: [{path, why}], bound: [{mode, path}], refused_binds: [{path, why}], env_path}.
 *   worktree   the unit's worktree (bound read-write; required)
 *   cwd        where the script starts (default the worktree; must be inside it)
 *   script     the shell text, run as /bin/sh -c <script>
 *   control_dir, hide  paths that must never be visible (re-hidden should a bound path contain them; outside the
 *              allowlist they do not exist in the jail anyway): the control dir and its siblings, the caller's list
 *   extra_ro   more paths to bind read-only (refused when inside a hidden path or a home's secret dir)
 *   scratch    the launcher's private dir for the generated files (passwd, group, hosts, the git configs)
 *   node       the node binary whose prefix is bound (default process.execPath)
 */
export function verifyJailPlan({ worktree, cwd = null, script, control_dir = null, hide = [], extra_ro = [], env = process.env, bwrap = "bwrap", scratch = "/nonexistent-scratch", node = process.execPath, uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0 }) {
  if (typeof worktree !== "string" || !isAbsolute(worktree)) throw Object.assign(new Error(`verify jail: the worktree must be an absolute path, not ${JSON.stringify(worktree)}`), { code: "BAD_POLICY" });
  if (typeof script !== "string" || !script.trim()) throw Object.assign(new Error("verify jail: no script"), { code: "BAD_POLICY" });
  const wt = real(worktree), at = real(cwd ?? worktree);
  if (!inside(wt, at)) throw Object.assign(new Error(`verify jail: cwd ${at} is outside the worktree ${wt}`), { code: "BAD_POLICY" });
  const git = repoGitDirs(wt);
  const homes = [...new Set([env?.HOME, homedir()].filter(h => typeof h === "string" && isAbsolute(h)).map(real))];
  // WHAT MUST NEVER BE VISIBLE (re-hidden inside any bound path).
  const want = [];
  for (const h of homes) want.push({ path: join(h, ".gemini"), why: "the Antigravity state and OAuth token" });
  if (control_dir) {
    const ctl = real(control_dir);
    want.push({ path: ctl, why: "the unit's control dir (MCP config, A2A token file and socket, OAuth scratch)" });
    for (const p of siblingsHidden(ctl, [wt, ...(git ? [git.common_dir, git.git_dir] : [])]).paths) want.push({ path: p, why: "other units' control dirs" });
  }
  for (const p of hide) if (typeof p === "string" && isAbsolute(p)) want.push({ path: real(p), why: "named by the caller" });
  const homeOf = p => homes.find(h => inside(h, p)) ?? (inside("/root", p) ? "/root" : inside("/home", p) && depth(p) >= 2 ? join("/home", p.split(sep)[2]) : null);
  const secretsOf = h => (h ? HOME_SECRET_DIRS.map(s => join(h, s)) : []);
  const homeSecrets = p => [...new Set([...secretsOf(homeOf(p)), ...homes.filter(h => inside(p, h)).flatMap(secretsOf)])];
  const seen = new Set(), hidden = [];
  const addHide = w => { if (seen.has(w.path) || w.path === "/") return; seen.add(w.path); const kind = kindOf(w.path); if (kind) hidden.push({ ...w, kind }); };
  want.forEach(addHide);
  // THE MOUNTS. `ops` [{op: "ro" | "rw" | "symlink" | "dir" | "file" | "tmpfs" | "hide", path, src?}], emitted by depth.
  const ops = [], bound = [], refused_binds = [], files = [];
  for (const d of SYSTEM_DIRS) {
    let st; try { st = lstatSync(d); } catch { continue; }
    if (st.isSymbolicLink()) ops.push({ op: "symlink", path: d, src: readlinkSync(d) });
    else if (st.isDirectory()) { ops.push({ op: "ro", path: d }); bound.push({ mode: "ro", path: d }); }
  }
  ops.push({ op: "dir", path: "/etc" });
  for (const e of ETC_ALLOW) {
    const d = join("/etc", e);
    let st; try { st = lstatSync(d); } catch { continue; }
    if (st.isSymbolicLink()) ops.push({ op: "symlink", path: d, src: readlinkSync(d) });
    else { ops.push({ op: "ro", path: d }); bound.push({ mode: "ro", path: d }); }
  }
  const user = String(env?.USER ?? env?.LOGNAME ?? "pantheon").replace(/[^A-Za-z0-9_.-]/g, "") || "pantheon";
  const gen = (name, dest, content) => { files.push({ name, content }); ops.push({ op: "file", path: dest, src: join(scratch, name) }); };
  gen("passwd", "/etc/passwd", `root:x:0:0:root:/root:/bin/sh\n${uid !== 0 ? `${user}:x:${uid}:${gid}::/tmp/home:/bin/sh\n` : ""}nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n`);
  gen("group", "/etc/group", `root:x:0:\n${gid !== 0 ? `${user}:x:${gid}:\n` : ""}nogroup:x:65534:\n`);
  gen("hosts", "/etc/hosts", "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n");
  const insideSecret = p => [...hidden.map(h => h.path), ...homeSecrets(p)].find(s => inside(s, p));
  const visible = p => bound.some(b => inside(b.path, p));
  const bindRo = (p, why) => {
    if (typeof p !== "string" || !isAbsolute(p)) return;
    const r = real(p);
    if (!kindOf(r) || visible(r)) return;
    const s = insideSecret(r) ?? (homes.includes(r) || homeOf(r) === r || r === "/" ? r : null);
    if (s) { refused_binds.push({ path: r, why: `${why}: ${s === r ? "a home or the root itself" : `inside the hidden ${s}`}` }); return; }
    for (const x of homeSecrets(r)) if (inside(r, x)) addHide({ path: x, why: "a home secret dir inside a bound path" });
    ops.push({ op: "ro", path: r }); bound.push({ mode: "ro", path: r });
  };
  // The node toolchain: the prefix of the node binary (bin/ and lib/: npm), else its directory.
  const nodeBin = dirname(real(node)), nodePrefix = basename(nodeBin) === "bin" ? dirname(nodeBin) : nodeBin;
  bindRo(nodePrefix, "the node toolchain");
  for (const p of extra_ro) bindRo(p, "extra_ro");
  // The worktree, read-write; its git dirs read-only with their config REPLACED by a sanitized one.
  for (const x of homeSecrets(wt)) if (inside(wt, x)) addHide({ path: x, why: "a home secret dir inside the worktree" });
  ops.push({ op: "rw", path: wt }); bound.push({ mode: "rw", path: wt });
  if (git) {
    const dirs = [git.common_dir, ...(inside(git.common_dir, git.git_dir) ? [] : [git.git_dir])];
    for (const d of dirs) bindRo(d, "the git dir");
    for (const d of [...new Set([git.common_dir, git.git_dir])]) {
      for (const f of ["config", "config.worktree"]) {
        const src = join(d, f);
        if (kindOf(src) !== "file") continue;
        let text = ""; try { text = readFileSync(src, "utf8"); } catch { /* unreadable: an empty sanitized config */ }
        gen(`git-${files.length}-${f}`, src, sanitizedGitConfig(text));
      }
      for (const f of GIT_HIDE_FILES) if (kindOf(join(d, f)) === "file") gen(`git-${files.length}-${f}`, join(d, f), "");
      for (const f of GIT_HIDE_DIRS) if (kindOf(join(d, f)) === "dir") ops.push({ op: "tmpfs", path: join(d, f) });
    }
  }
  // The hidden paths that lie inside a bound path (elsewhere they do not exist in the jail).
  for (const h of hidden) if (bound.some(b => inside(b.path, h.path) && b.path !== h.path || b.path === h.path && b.mode !== "rw")) ops.push({ op: "hide", path: h.path, kind: h.kind });
  for (const h of hidden) if (bound.some(b => b.mode === "rw" && b.path === h.path)) refused_binds.push({ path: h.path, why: "a hidden path is the worktree itself" });
  const rank = { symlink: 0, dir: 0, ro: 1, rw: 1, tmpfs: 2, file: 2, hide: 3 };
  ops.sort((a, b) => depth(a.path) - depth(b.path) || rank[a.op] - rank[b.op]);
  // NO NETWORK (--unshare-net: only a loopback of its own), its own PID, IPC and UTS namespaces, no capabilities.
  const argv = [bwrap, "--die-with-parent", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--new-session", "--cap-drop", "ALL",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/home"];
  for (const o of ops) {
    if (o.op === "symlink") argv.push("--symlink", o.src, o.path);
    else if (o.op === "dir") argv.push("--dir", o.path);
    else if (o.op === "ro") argv.push("--ro-bind", o.path, o.path);
    else if (o.op === "rw") argv.push("--bind", o.path, o.path);
    else if (o.op === "file") argv.push("--ro-bind", o.src, o.path);
    else if (o.op === "tmpfs") argv.push("--tmpfs", o.path);
    else if (o.op === "hide") { if (o.kind === "dir") argv.push("--tmpfs", o.path); else argv.push("--ro-bind", "/dev/null", o.path); }
  }
  argv.push("--chdir", at, "--", "/bin/sh", "-c", script);
  const env_path = [nodeBin, "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].filter((x, i, a) => a.indexOf(x) === i).join(":");
  return { argv, files, hidden, bound, refused_binds, env_path };
}

/** Read and check a policy object. Throws BAD_POLICY. */
export function checkPolicy(p) {
  if (!p || typeof p !== "object" || Array.isArray(p) || p.schema !== VERIFY_JAIL_SCHEMA) throw Object.assign(new Error(`verify jail: the policy is not ${VERIFY_JAIL_SCHEMA}`), { code: "BAD_POLICY" });
  for (const k of ["hide", "extra_ro"]) if (p[k] !== undefined && (!Array.isArray(p[k]) || p[k].some(x => typeof x !== "string" || !isAbsolute(x)))) throw Object.assign(new Error(`verify jail: ${k} is a list of absolute paths`), { code: "BAD_POLICY" });
  // A verify command that asks for the network is REFUSED, never granted: the verify jail has none (only its own loopback).
  if (p.network !== undefined && p.network !== false) throw Object.assign(new Error("verify jail: a verify command gets no network (its own loopback only); a policy asking for network is refused"), { code: "BAD_POLICY" });
  if (p.test_files !== undefined && p.test_files !== true) throw Object.assign(new Error("verify jail: test_files is true or absent"), { code: "BAD_POLICY" });
  return p;
}

// ---- THE WORKER'S WRAPPER -------------------------------------------------------------------------------------------
const SAFE = /^\/[A-Za-z0-9_./@%+=:,-]+$/;
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
/**
 * Write a verify launcher into a control dir: the policy <control_dir>/<policyName> and the wrapper <control_dir>/<name>
 * (mode 0755). Returns {command, policy_file}.
 *   default (name pantheon-verify, policy verify.json): the unit worker's ONE command; it ignores its arguments and runs
 *     `script` (the worker's `cd '<worktree>' && <verify_cmd>`).
 *   test_files: true (the review runner's pantheon-test): its arguments are test files, checked by the launcher
 *     (scriptWithFiles) and appended, quoted, to `script` (`node --test`).
 */
export function writeVerifyLauncher({ control_dir, worktree, script, hide = [], extra_ro = [], node = process.execPath, bwrap = "bwrap", name = VERIFY_LAUNCHER_NAME, policyName = VERIFY_POLICY_NAME, test_files = false }) {
  const ctl = real(control_dir), command = join(ctl, name), policy_file = join(ctl, policyName);
  if (!SAFE.test(command) || !/^verify(-[a-z0-9-]+)?\.json$/.test(policyName)) throw Object.assign(new Error(`the verify launcher path ${command} needs quoting; put the control dir on a plain path`), { code: "HOOK_PATH_UNSAFE" });
  const policy = { schema: VERIFY_JAIL_SCHEMA, worktree: real(worktree), cwd: real(worktree), script, control_dir: ctl, hide: [...hide], extra_ro: [...extra_ro], bwrap, ...(test_files ? { test_files: true } : {}) };
  writeFileSync(policy_file, JSON.stringify(checkPolicy(policy), null, 2) + "\n");
  writeFileSync(command, ["#!/bin/sh", "# A Pantheon verify launcher (pantheon/src/agy/verify-jail.mjs): it runs worker- or review-controlled code in a fresh",
    "# verify jail (no credential, no host file outside its allowlist, no network is reachable there).",
    test_files ? `exec ${q(node)} ${q(VERIFY_JAIL_MODULE)} ${q(policy_file)} -- "$@"` : `exec ${q(node)} ${q(VERIFY_JAIL_MODULE)} ${q(policy_file)}`, ""].join("\n"), { mode: 0o755 });
  return { command, policy_file };
}
/**
 * Add hidden paths to EVERY verify policy of a control dir (verify.json, verify-*.json) (prepareWorkerJail: the Gemini
 * state layout's mount points and the agy state dirs, known only once the jail is built). The policy files are in the
 * control dir, which the jailed CLI cannot write. Returns the policies updated ([] when there is none).
 */
export function extendVerifyPolicy(control_dir, { hide = [] } = {}) {
  let names = [];
  try { names = readdirSync(control_dir).filter(n => /^verify(-[a-z0-9-]+)?\.json$/.test(n)).sort(); } catch { return []; }
  return names.map(n => {
    const f = join(control_dir, n), p = checkPolicy(JSON.parse(readFileSync(f, "utf8")));
    p.hide = [...new Set([...(p.hide ?? []), ...hide.filter(x => typeof x === "string" && isAbsolute(x))])];
    writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
    return p;
  });
}

// ---- THE LAUNCHER ---------------------------------------------------------------------------------------------------
/**
 * Run `policy` in a verify jail: build the clean env and the bwrap argv, start bwrap through the descriptor closer with
 * stdio inherited, resolve with the exit code (128 + n for a signal; VERIFY_JAIL_REFUSED when no jail could start, the
 * closer's refusal included).
 */
/** A review test-file argument: a plain worktree-relative path (jail-hook.mjs decideReviewCommand checks it too). */
const TEST_FILE = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;
/** The script with the test files appended (policy.test_files), each checked and quoted; throws BAD_POLICY. */
export function scriptWithFiles(policy, args = []) {
  if (policy.test_files !== true) { if (args.length) throw Object.assign(new Error("verify jail: this launcher takes no arguments"), { code: "BAD_POLICY" }); return policy.script; }
  if (!args.length || args.length > 50) throw Object.assign(new Error("verify jail: one to 50 test files"), { code: "BAD_POLICY" });
  for (const f of args) if (!TEST_FILE.test(f) || f.split("/").some(x => x === "" || x === "." || x === "..")) throw Object.assign(new Error(`verify jail: ${JSON.stringify(f)} is not a plain worktree-relative test file`), { code: "BAD_POLICY" });
  return `${policy.script} ${args.map(q).join(" ")}`;
}
export function launch(policy, { log = m => process.stderr.write(`pantheon-verify: ${m}\n`), args = [] } = {}) {
  return new Promise(resolveExit => {
    let plan, env, scratch = null;
    const cleanup = () => { if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort: it holds no secret */ } scratch = null; } };
    const done = code => { cleanup(); resolveExit(code); };
    try {
      checkPolicy(policy);
      const script = scriptWithFiles(policy, args);
      env = verifyEnvOf(process.env).env;
      scratch = mkdtempSync(join(tmpdir(), "pantheon-verify-"));
      plan = verifyJailPlan({ worktree: policy.worktree, cwd: policy.cwd ?? null, script, control_dir: policy.control_dir ?? null, hide: policy.hide ?? [], extra_ro: policy.extra_ro ?? [], env, bwrap: policy.bwrap ?? "bwrap", scratch });
      for (const f of plan.files) writeFileSync(join(scratch, f.name), f.content, { mode: 0o444 });
      Object.assign(env, { PATH: plan.env_path, HOME: "/tmp/home", GIT_CONFIG_NOSYSTEM: "1" });
      policy = { ...policy, script };
    } catch (e) { log(`refused: ${e?.message ?? e}`); done(VERIFY_JAIL_REFUSED); return; }
    const unjailed = () => {
      if (policy.allow_unjailed !== true) return false;
      log("bwrap is unavailable and the policy allows an UNJAILED run: clean env and no descriptor beyond 0, 1 and 2 only; the filesystem and the network are NOT isolated");
      run("/bin/sh", ["-c", policy.script], policy.cwd ?? policy.worktree, false);
      return true;
    };
    const run = (cmd, args, cwd, jailed) => {
      // NO DESCRIPTOR BEYOND 0, 1 AND 2 (KG-11): the command starts through the descriptor closer (src/agy/fd-exec.mjs),
      // which closes what this launcher inherited and execs it in its place. A command that is not there is bwrap missing;
      // no python3 for the closer is a refusal, never an unjailed run (the unjailed run needs the closer too).
      const file = resolveCommand(cmd, env.PATH);
      if (!file) { if (jailed && unjailed()) return; log(`the verify jail could not start (ENOENT: ${cmd}); refusing to run worker-controlled code unjailed`); done(VERIFY_JAIL_REFUSED); return; }
      let child;
      try { const [closer, ...argv] = fdExecArgv([file, ...args]); child = spawn(closer, argv, { cwd, env, stdio: "inherit" }); }
      catch (e) { if (jailed && e?.code !== "FDS_NO_PYTHON" && unjailed()) return; log(`the verify jail could not start (${e?.code ?? e?.message ?? e}); refusing to run worker-controlled code unjailed`); done(VERIFY_JAIL_REFUSED); return; }
      const fwd = sig => { try { child.kill(sig); } catch { /* gone */ } };
      for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => fwd(s));
      child.on("error", e => { if (jailed && e?.code === "ENOENT" && unjailed()) return; log(`the verify jail could not start (${e?.code ?? e?.message ?? e}); refusing to run worker-controlled code unjailed`); done(VERIFY_JAIL_REFUSED); });
      child.on("close", (code, signal) => done(code ?? (signal ? 128 + (({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 })[signal] ?? 0) : 1)));
    };
    run(plan.argv[0], plan.argv.slice(1), "/", true);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(real(process.argv[1])).href) {
  // `node verify-jail.mjs <policy.json> [-- <test files>]` | `node verify-jail.mjs --inline '<json>'`.
  const [a, b, ...rest] = process.argv.slice(2);
  let policy, args = [];
  try {
    if (a === "--inline") policy = JSON.parse(b);
    else { policy = JSON.parse(readFileSync(a, "utf8")); args = b === "--" ? rest : b === undefined ? [] : [b, ...rest]; }
  } catch (e) { process.stderr.write(`pantheon-verify: refused: the policy cannot be read (${e?.code ?? e?.message ?? e})\n`); process.exit(VERIFY_JAIL_REFUSED); }
  launch(policy, { args }).then(code => process.exit(code));
}
