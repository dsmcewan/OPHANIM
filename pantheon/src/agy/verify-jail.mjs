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
//              secret-named variable, no proxy URL that carries a user:password; TMPDIR=/tmp.
//   FILESYSTEM the outer view read-only, then HIDDEN (an empty tmpfs, or /dev/null over a file): /home, /root, /run,
//              $HOME and os.homedir() (so ~/.gemini with the OAuth token, ~/.ssh, ~/.config, every other host secret
//              under a home), $HOME/.gemini again, the unit's control dir (role card, hooks, jail.json, mcp_config.json,
//              the A2A token file, the A2A socket, run/ with the OAuth scratch copy) with its sibling control dirs (or
//              their dedicated parent), the A2A socket's directory, the agy state dirs and the Gemini state layout's
//              mount points (prepareWorkerJail adds them), and whatever the caller lists (the controller: the run's
//              control root, the checkpoint dir and its seal key); /tmp is a fresh tmpfs. Bound back: ONLY the unit's
//              worktree (read-write), its git dirs (read-only), the CA files the env names and the toolchain dirs on
//              PATH (read-only), and /etc/resolv.conf's target when it lies under /run -- never a path inside a hidden
//              one or a home's secret dirs (a home secret dir inside a bound-back path is hidden again).
//   FDS        no inherited descriptor but 0, 1 and 2 reaches the script. bwrap itself passes inherited fds through
//              (observed with bubblewrap 0.9.0: an `exec 7<file` shell's fd 7 was open in the jailed command), so the
//              launcher is a node process: node marks every inherited fd above 2 close-on-exec at startup (observed on
//              node 24.22: a shell's `exec 9<file` arrives as flags 02100000), so they close at the exec of bwrap; and
//              closeInheritedFds closes any one still without close-on-exec before that (defense in depth).
//   /proc      its own PID namespace (--unshare-pid) and a fresh /proc: no credential-bearing process is visible, so
//              no /proc/<pid>/{environ,cmdline,fd,mem,root} of one can be opened, and none can be signalled or traced.
//              Also --unshare-ipc (no SysV IPC of the host) and --new-session (no TIOCSTI into a terminal).
//   SOCKETS    no A2A socket is reachable: its file and directory are hidden (and a socket elsewhere would still
//              demand the unit's bearer token, which is in no readable file); nor any path socket under the homes,
//              /run or /tmp. The network namespace is SHARED by design (docs: remaining exposure), so abstract Unix
//              sockets, a path socket elsewhere on the host, and the host's TCP services stay reachable.
// The launcher refuses (exit VERIFY_JAIL_REFUSED) when bwrap cannot start the jail; it never falls back to running
// unjailed unless the policy says `allow_unjailed: true` (then still a clean env and closed fds, recorded as such).
//
// Used as:
//   node verify-jail.mjs <policy.json>          the worker's command, through the per-unit wrapper <control_dir>/pantheon-verify
//   node verify-jail.mjs --inline '<json>'      the controller's runVerify
// Policy {schema: VERIFY_JAIL_SCHEMA, worktree, cwd?, script, control_dir?, hide?: [abs], extra_ro?: [abs],
// bwrap?, allow_unjailed?}. `script` runs as `/bin/sh -c <script>` with cwd = `cwd` (default the worktree).
//
// Must never: run the script with an inherited descriptor beyond stdio, with an env variable outside the allowlist,
// or with a hidden path visible; write anything (the launcher only reads its policy).
import { closeSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repoGitDirs, siblingsHidden } from "./sandbox.mjs";
import { VERIFY_LAUNCHER_NAME } from "./jail-hook.mjs";

export const VERIFY_JAIL_SCHEMA = "pantheon.verify-jail/v1";
export const VERIFY_JAIL_MODULE = fileURLToPath(import.meta.url);
/** The per-unit wrapper (the worker's ONE command; jail-hook.mjs VERIFY_LAUNCHER_NAME) and its policy, both in the control dir (read-only to the worker). */
export { VERIFY_LAUNCHER_NAME };
export const VERIFY_POLICY_NAME = "verify.json";
/** The launcher's own refusal (no jail could be built, a bad policy): distinct from any exit of the script. */
export const VERIFY_JAIL_REFUSED = 125;
/**
 * Hidden in every verify jail: where host secrets live -- the homes, and /run (per-user runtime dirs, the system's Unix
 * sockets: dbus, docker, a sandbox's own agents; observed in this container: /run/sandbox-telemetry/ingest.sock was
 * reachable before /run was hidden). The resolver file is bound back when /etc/resolv.conf points into /run.
 */
export const DEFAULT_HIDDEN_ROOTS = Object.freeze(["/home", "/root", "/run"]);
/** Never bound back into a verify jail, under any home (and nothing that contains one of them). */
export const HOME_SECRET_DIRS = Object.freeze([".gemini", ".ssh", ".gnupg", ".aws", ".azure", ".config", ".codex", ".claude", ".docker", ".kube",
  ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".password-store", ".local/share", ".pantheon", ".ophanim", ".cache"]);

const inside = (root, p) => p === root || p.startsWith(root === "/" ? "/" : root + sep);
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
const depth = p => p.split(sep).filter(Boolean).length;
const kindOf = p => { try { const s = lstatSync(p); return s.isDirectory() ? "dir" : "file"; } catch { return null; } };

// ---- ENV ------------------------------------------------------------------------------------------------------------
export const VERIFY_ENV_ALLOW = Object.freeze(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]);
export const VERIFY_ENV_PREFIXES = Object.freeze(["LC_"]);
export const VERIFY_ENV_PROXIES = Object.freeze(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]);
/** A variable name whose value never enters a verify jail, whatever list names it. */
export const VERIFY_ENV_SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|SESSION|BEARER/i;
/** Prefixes that never enter a verify jail: the controller's, agy's and the relay's own variables. */
export const VERIFY_ENV_NEVER = Object.freeze(["PANTHEON_", "AGY_", "ANTIGRAVITY_", "GEMINI_", "GOOGLE_", "OPENAI_", "ANTHROPIC_", "XAI_", "FAKE_AGY_"]);
const USERINFO = /:\/\/[^/@\s]*@/;
/**
 * The verify jail's environment from `base` (default process.env): VERIFY_ENV_ALLOW, LC_*, the proxy variables whose
 * value carries no user:password, and the names (or PREFIX* patterns) the operator lists in PANTHEON_VERIFY_ENV_PASS;
 * never a VERIFY_ENV_SECRETISH name or a VERIFY_ENV_NEVER prefix, whatever the lists say. TMPDIR is /tmp (the jail's
 * own tmpfs). Returns {env, dropped: [names]} (never values).
 */
export function verifyEnvOf(base = process.env) {
  const pass = String(base?.PANTHEON_VERIFY_ENV_PASS ?? "").split(/[:,]/).map(s => s.trim()).filter(Boolean);
  const env = {}, dropped = [];
  for (const [k, v] of Object.entries(base ?? {})) {
    if (typeof v !== "string") continue;
    const never = VERIFY_ENV_SECRETISH.test(k) || VERIFY_ENV_NEVER.some(p => k.startsWith(p));
    const listed = VERIFY_ENV_ALLOW.includes(k) || VERIFY_ENV_PREFIXES.some(p => k.startsWith(p))
      || pass.some(p => (p.endsWith("*") ? k.startsWith(p.slice(0, -1)) : k === p));
    const proxy = VERIFY_ENV_PROXIES.includes(k);
    if (!never && (listed || (proxy && !USERINFO.test(v)))) env[k] = v; else dropped.push(k);
  }
  env.TMPDIR = "/tmp";
  return { env, dropped: dropped.sort() };
}

// ---- FDS ------------------------------------------------------------------------------------------------------------
const O_CLOEXEC = 0o2000000;
/**
 * Close every descriptor of this process above 2 that would survive an exec (no O_CLOEXEC in /proc/self/fdinfo):
 * those are the ones a parent left open for us (agy's, the controller's). Node's own descriptors are all O_CLOEXEC,
 * so they are left alone and close at exec anyway. Returns the closed fd numbers. Linux only (/proc); elsewhere [].
 */
export function closeInheritedFds() {
  const closed = [];
  let fds = [];
  try { fds = readdirSync("/proc/self/fd").map(Number).filter(n => Number.isInteger(n) && n > 2); } catch { return closed; }
  for (const fd of fds) {
    let flags = null;
    try { flags = parseInt(/^flags:\s*([0-7]+)/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1] ?? "", 8); } catch { continue; }   // gone (the readdir's own fd)
    if (Number.isNaN(flags) || (flags & O_CLOEXEC)) continue;
    try { closeSync(fd); closed.push(fd); } catch { /* already closed */ }
  }
  return closed;
}

// ---- FILESYSTEM -----------------------------------------------------------------------------------------------------
/**
 * The bwrap argv of one verify jail (pure but for lstat/realpath of the paths it is given). Returns {argv, hidden:
 * [{path, kind, why}], bound: [{mode, path}], refused_binds: [{path, why}]}.
 *   worktree   the unit's worktree (bound read-write; required)
 *   cwd        where the script starts (default the worktree; must be inside it)
 *   script     the shell text, run as /bin/sh -c <script>
 *   control_dir  the unit's control dir: hidden, with its siblings (siblingsHidden: the dedicated parent, or each sibling)
 *   hide       more absolute paths to hide (directories get an empty tmpfs, files /dev/null)
 *   extra_ro   more paths to bind back read-only (refused when inside or containing a hidden path or a home secret)
 *   env        the environment whose HOME and PATH (and CA variables) shape the jail (the clean one, verifyEnvOf)
 */
export function verifyJailPlan({ worktree, cwd = null, script, control_dir = null, hide = [], extra_ro = [], env = process.env, bwrap = "bwrap" }) {
  if (typeof worktree !== "string" || !isAbsolute(worktree)) throw Object.assign(new Error(`verify jail: the worktree must be an absolute path, not ${JSON.stringify(worktree)}`), { code: "BAD_POLICY" });
  if (typeof script !== "string" || !script.trim()) throw Object.assign(new Error("verify jail: no script"), { code: "BAD_POLICY" });
  const wt = real(worktree), at = real(cwd ?? worktree);
  if (!inside(wt, at)) throw Object.assign(new Error(`verify jail: cwd ${at} is outside the worktree ${wt}`), { code: "BAD_POLICY" });
  const git = repoGitDirs(wt);
  const homes = [...new Set([env?.HOME, homedir()].filter(h => typeof h === "string" && isAbsolute(h)).map(real))];
  // WHAT IS HIDDEN, and why (the record keeps the reasons).
  const want = [];
  for (const r of DEFAULT_HIDDEN_ROOTS) want.push({ path: r, why: "a home or per-user runtime root" });
  for (const h of homes) want.push({ path: h, why: "a home ($HOME / os.homedir())" }, { path: join(h, ".gemini"), why: "the Antigravity state and OAuth token" });
  if (control_dir) {
    const ctl = real(control_dir);
    want.push({ path: ctl, why: "the unit's control dir (MCP config, A2A token file and socket, OAuth scratch)" });
    for (const p of siblingsHidden(ctl, [wt, ...(git ? [git.common_dir, git.git_dir] : [])]).paths) want.push({ path: p, why: "other units' control dirs" });
  }
  for (const p of hide) if (typeof p === "string" && isAbsolute(p)) want.push({ path: real(p), why: "named by the caller" });
  const seen = new Set(), hidden = [];
  for (const w of want) { if (seen.has(w.path) || w.path === "/") continue; seen.add(w.path); const kind = kindOf(w.path); if (kind) hidden.push({ ...w, kind }); }
  // No bind-back may lie INSIDE an explicit hide (not the broad roots, which bind-backs exist to pierce) or a home's
  // secret dir, nor BE a home or a hidden root; one that CONTAINS a home secret dir gets that dir hidden again (and an
  // explicit hide inside a bind-back is re-applied after it: emission is by depth).
  const explicit = () => hidden.filter(h => !DEFAULT_HIDDEN_ROOTS.includes(h.path) && !homes.includes(h.path)).map(h => h.path);
  // A home is $HOME / os.homedir(), and also /root and every /home/<user> (a PATH dir may live in any of them).
  const homeOf = p => homes.find(h => inside(h, p)) ?? (inside("/root", p) ? "/root" : inside("/home", p) && depth(p) >= 2 ? join("/home", p.split(sep)[2]) : null);
  const secretsOf = h => (h ? HOME_SECRET_DIRS.map(s => join(h, s)) : []);
  const homeSecrets = p => [...new Set([...secretsOf(homeOf(p)), ...homes.filter(h => inside(p, h)).flatMap(secretsOf)])];
  const insideSecret = p => [...explicit(), ...homeSecrets(p)].find(s => inside(s, p));
  const underHidden = p => hidden.some(h => inside(h.path, p)) || inside("/tmp", p);
  // WHAT IS BOUND BACK.
  const bound = [{ mode: "rw", path: wt }], refused_binds = [];
  const rehide = p => { for (const s of homeSecrets(p)) if (inside(p, s) && !seen.has(s)) { const kind = kindOf(s); seen.add(s); if (kind) hidden.push({ path: s, why: "a home secret dir inside a bound-back path", kind }); } };
  rehide(wt);
  const bindRo = (p, why) => {
    if (typeof p !== "string" || !isAbsolute(p)) return;
    const r = real(p);
    if (!kindOf(r) || !underHidden(r) || bound.some(b => inside(b.path, r))) return;   // visible already, or absent
    const s = insideSecret(r) ?? (homes.includes(r) || homeOf(r) === r || DEFAULT_HIDDEN_ROOTS.includes(r) || r === "/" ? r : null);
    if (s) { refused_binds.push({ path: r, why: `${why}: ${s === r ? "a home or hidden root itself" : `inside the hidden ${s}`}` }); return; }
    rehide(r);
    bound.push({ mode: "ro", path: r });
  };
  if (git) { bindRo(git.common_dir, "the git dir"); bindRo(git.git_dir, "the git dir"); }
  for (const d of String(env?.PATH ?? "").split(":").filter(d => isAbsolute(d))) {
    // A toolchain's bin dir under a hidden root: its prefix (lib/ beside bin/: npm, nvm) when that prefix is not a home
    // or a hidden root itself, else the bin dir alone.
    const r = real(d), parent = dirname(r);
    const prefixOk = basename(r) === "bin" && !homes.includes(parent) && homeOf(parent) !== parent && !hidden.some(h => h.path === parent) && !insideSecret(parent) && depth(parent) > 1;
    bindRo(prefixOk ? parent : r, "a PATH dir");
  }
  for (const k of ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) if (env?.[k]) bindRo(env[k], `the ${k} CA path`);
  // DNS: the resolver file only (never its directory: systemd-resolved keeps a varlink socket beside it).
  const resolv = real("/etc/resolv.conf");
  if (resolv !== "/etc/resolv.conf" && kindOf(resolv) === "file") bindRo(resolv, "the resolver file");
  for (const p of extra_ro) bindRo(p, "extra_ro");
  // EMISSION: parent first by depth; at the same depth a hide before a bind (the bind wins); a hide that lies under an
  // earlier hide and under no bind is already invisible and is skipped (bwrap would only make its mount point).
  const ops = [...hidden.map(h => ({ op: "hide", ...h })), ...bound.map(b => ({ op: b.mode, path: b.path }))]
    .filter(o => o.op !== "hide" || !hidden.some(h => h.path !== o.path && inside(h.path, o.path)) || bound.some(b => inside(b.path, o.path)) || DEFAULT_HIDDEN_ROOTS.includes(o.path))
    .sort((a, b) => depth(a.path) - depth(b.path) || (a.op === "hide" ? 0 : 1) - (b.op === "hide" ? 0 : 1));
  const argv = [bwrap, "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const o of ops) {
    if (o.op === "hide") { if (o.kind === "dir") argv.push("--tmpfs", o.path); else argv.push("--ro-bind", "/dev/null", o.path); }
    else argv.push(o.op === "rw" ? "--bind" : "--ro-bind", o.path, o.path);
  }
  argv.push("--chdir", at, "--", "/bin/sh", "-c", script);
  return { argv, hidden, bound, refused_binds };
}

/** Read and check a policy object. Throws BAD_POLICY. */
export function checkPolicy(p) {
  if (!p || typeof p !== "object" || Array.isArray(p) || p.schema !== VERIFY_JAIL_SCHEMA) throw Object.assign(new Error(`verify jail: the policy is not ${VERIFY_JAIL_SCHEMA}`), { code: "BAD_POLICY" });
  for (const k of ["hide", "extra_ro"]) if (p[k] !== undefined && (!Array.isArray(p[k]) || p[k].some(x => typeof x !== "string" || !isAbsolute(x)))) throw Object.assign(new Error(`verify jail: ${k} is a list of absolute paths`), { code: "BAD_POLICY" });
  return p;
}

// ---- THE WORKER'S WRAPPER -------------------------------------------------------------------------------------------
const SAFE = /^\/[A-Za-z0-9_./@%+=:,-]+$/;
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
/**
 * Write the unit's verify launcher into its control dir: <control_dir>/verify.json (the policy) and the wrapper
 * <control_dir>/pantheon-verify (mode 0755, no arguments, the worker's ONE command). Returns {command, policy_file}.
 * `script` is the shell text the jail runs (the worker's `cd '<worktree>' && <verify_cmd>`).
 */
export function writeVerifyLauncher({ control_dir, worktree, script, hide = [], extra_ro = [], node = process.execPath, bwrap = "bwrap" }) {
  const ctl = real(control_dir), command = join(ctl, VERIFY_LAUNCHER_NAME), policy_file = join(ctl, VERIFY_POLICY_NAME);
  if (!SAFE.test(command)) throw Object.assign(new Error(`the verify launcher path ${command} needs quoting; put the control dir on a plain path`), { code: "HOOK_PATH_UNSAFE" });
  const policy = { schema: VERIFY_JAIL_SCHEMA, worktree: real(worktree), cwd: real(worktree), script, control_dir: ctl, hide: [...hide], extra_ro: [...extra_ro], bwrap };
  writeFileSync(policy_file, JSON.stringify(checkPolicy(policy), null, 2) + "\n");
  writeFileSync(command, ["#!/bin/sh", "# Pantheon's verify launcher for one unit (pantheon/src/agy/verify-jail.mjs): the ONLY command the worker may run.",
    "# It ignores its arguments and runs the unit's verify command in a fresh verify jail (no credential is reachable there).",
    `exec ${q(node)} ${q(VERIFY_JAIL_MODULE)} ${q(policy_file)}`, ""].join("\n"), { mode: 0o755 });
  return { command, policy_file };
}
/**
 * Add hidden paths to a unit's verify policy (prepareWorkerJail: the Gemini state layout's mount points and the agy state
 * dirs, known only once the jail is built). The policy file is in the control dir, which the worker cannot write.
 */
export function extendVerifyPolicy(control_dir, { hide = [] } = {}) {
  const f = join(control_dir, VERIFY_POLICY_NAME);
  if (!existsSync(f)) return null;
  const p = checkPolicy(JSON.parse(readFileSync(f, "utf8")));
  p.hide = [...new Set([...(p.hide ?? []), ...hide.filter(x => typeof x === "string" && isAbsolute(x))])];
  writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
  return p;
}

// ---- THE LAUNCHER ---------------------------------------------------------------------------------------------------
/**
 * Run `policy` in a verify jail: close inherited fds, build the clean env and the bwrap argv, run it with stdio
 * inherited, resolve with the exit code (128 + n for a signal; VERIFY_JAIL_REFUSED when no jail could start).
 */
export function launch(policy, { log = m => process.stderr.write(`pantheon-verify: ${m}\n`) } = {}) {
  return new Promise(resolveExit => {
    let plan, env;
    try {
      checkPolicy(policy);
      closeInheritedFds();
      env = verifyEnvOf(process.env).env;
      plan = verifyJailPlan({ worktree: policy.worktree, cwd: policy.cwd ?? null, script: policy.script, control_dir: policy.control_dir ?? null, hide: policy.hide ?? [], extra_ro: policy.extra_ro ?? [], env, bwrap: policy.bwrap ?? "bwrap" });
    } catch (e) { log(`refused: ${e?.message ?? e}`); resolveExit(VERIFY_JAIL_REFUSED); return; }
    const unjailed = () => {
      if (policy.allow_unjailed !== true) return false;
      log("bwrap is unavailable and the policy allows an UNJAILED run: clean env and closed fds only, the filesystem is NOT hidden");
      run("/bin/sh", ["-c", policy.script], policy.cwd ?? policy.worktree, false);
      return true;
    };
    const run = (cmd, args, cwd, jailed) => {
      let child;
      try { child = spawn(cmd, args, { cwd, env, stdio: "inherit" }); }
      catch (e) { if (jailed && unjailed()) return; log(`the verify jail could not start (${e?.code ?? e?.message ?? e}); refusing to run worker-controlled code unjailed`); resolveExit(VERIFY_JAIL_REFUSED); return; }
      const fwd = sig => { try { child.kill(sig); } catch { /* gone */ } };
      for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => fwd(s));
      child.on("error", e => { if (jailed && e?.code === "ENOENT" && unjailed()) return; log(`the verify jail could not start (${e?.code ?? e?.message ?? e}); refusing to run worker-controlled code unjailed`); resolveExit(VERIFY_JAIL_REFUSED); });
      child.on("close", (code, signal) => resolveExit(code ?? (signal ? 128 + (({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 })[signal] ?? 0) : 1)));
    };
    run(plan.argv[0], plan.argv.slice(1), "/", true);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(real(process.argv[1])).href) {
  const [a, b] = process.argv.slice(2);
  let policy;
  try { policy = a === "--inline" ? JSON.parse(b) : JSON.parse(readFileSync(a, "utf8")); }
  catch (e) { process.stderr.write(`pantheon-verify: refused: the policy cannot be read (${e?.code ?? e?.message ?? e})\n`); process.exit(VERIFY_JAIL_REFUSED); }
  launch(policy).then(code => process.exit(code));
}
