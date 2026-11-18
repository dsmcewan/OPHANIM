// Path confinement, the scrubbed child environment and the bounded process runner for the
// independent-review runner. Everything a reviewer's tool call touches goes through here.
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";

export class ToolRefusal extends Error {
  constructor(message) { super(message); this.name = "ToolRefusal"; }
}

// Paths the runner hides from the reviewer inside the worktree (another reviewer's findings).
export const WITHHELD = [/^docs\/reviews\/[^/]+\/findings-[^/]*$/];

const within = (root, p) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

// Resolve a reviewer-supplied relative path inside `root`. Refuses absolute paths, `..`, any `.git`
// component, NUL bytes, withheld paths and symlinks whose target leaves the root. `mustExist`
// false allows a not-yet-existing leaf (its nearest existing ancestor is then checked).
export async function resolveInRoot(root, p, { mustExist = true } = {}) {
  if (typeof p !== "string") throw new ToolRefusal("path must be a string");
  if (p.includes("\0")) throw new ToolRefusal("path contains a NUL byte");
  if (p === "" || p === ".") p = ".";
  if (isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("~")) throw new ToolRefusal("absolute paths are refused; give a path relative to the worktree root");
  const parts = p.split(/[\\/]+/).filter(s => s !== "" && s !== ".");
  if (parts.includes("..")) throw new ToolRefusal("'..' is refused");
  if (parts.some(s => s.toLowerCase() === ".git")) throw new ToolRefusal(".git internals are refused");
  const rel = parts.join("/");
  if (WITHHELD.some(re => re.test(rel))) throw new ToolRefusal("this path is withheld by the runner");
  const realRoot = await realpath(root);
  const full = parts.length ? join(realRoot, ...parts) : realRoot;
  // Walk the components so an intermediate symlink cannot lead out of the root.
  let cur = realRoot;
  for (let i = 0; i < parts.length; i++) {
    const next = join(cur, parts[i]);
    let st;
    try { st = await lstat(next); } catch {
      if (mustExist) throw new ToolRefusal(`no such path: ${rel}`);
      return { full: normalize(join(cur, ...parts.slice(i))), rel };
    }
    if (st.isSymbolicLink()) {
      let target;
      try { target = await realpath(next); } catch { throw new ToolRefusal(`dangling symlink: ${parts.slice(0, i + 1).join("/")}`); }
      if (!within(realRoot, target)) throw new ToolRefusal(`symlink leaves the worktree: ${parts.slice(0, i + 1).join("/")}`);
      const relTarget = target.slice(realRoot.length + 1).split(sep);
      if (relTarget.some(s => s.toLowerCase() === ".git")) throw new ToolRefusal(".git internals are refused");
      cur = target;
    } else cur = next;
  }
  return { full: cur, rel, lexical: full };
}

// ---- environment ------------------------------------------------------------------------------

const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION/i;
const PROXY_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"];

// The complete environment of every child process the reviewer causes. Built from nothing: only
// the names below are ever copied, then anything secret-looking is dropped as a second guard.
export function buildChildEnv({ parentEnv = process.env, home, tmpdir, telosRoot = null, secrets = [] }) {
  if (!home || !tmpdir) throw new Error("buildChildEnv: home and tmpdir are required");
  const env = {
    PATH: parentEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: tmpdir,
    LANG: parentEnv.LANG ?? "C.UTF-8",
  };
  if (telosRoot) env.OPHANIM_TELOS_ROOT = telosRoot;
  for (const n of PROXY_NAMES) {
    const v = parentEnv[n];
    // A proxy URL carrying user:pass@ is a credential; it is not passed on.
    if (typeof v === "string" && v && !/:\/\/[^/]*@/.test(v)) env[n] = v;
  }
  for (const k of Object.keys(env)) {
    if (SECRETISH.test(k) || /_API_KEY$/i.test(k)) delete env[k];
    else if (secrets.some(s => s && String(env[k]).includes(s))) delete env[k];
  }
  return env;
}

// ---- processes --------------------------------------------------------------------------------

// Run one process with a timeout and an output cap. Output (stdout and stderr interleaved) keeps
// the TAIL: a failing test's summary is at the end. The process group is killed on timeout, so
// children a test started do not outlive the run.
export function runProcess({ cmd, args = [], cwd, env, timeoutMs, capBytes = 64 * 1024 }) {
  return new Promise(resolve => {
    const started = Date.now();
    let chunks = [], kept = 0, total = 0, timedOut = false, settled = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      resolve({ exit_code: null, signal: null, timed_out: false, output: `spawn failed: ${e.message}`, bytes_total: 0, truncated: false, duration_ms: 0 });
      return;
    }
    const take = buf => {
      total += buf.length; chunks.push(buf); kept += buf.length;
      while (kept > capBytes && chunks.length > 1) kept -= chunks.shift().length;
      if (kept > capBytes) { chunks[0] = chunks[0].subarray(kept - capBytes); kept = capBytes; }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    const done = (code, signal, extra = "") => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      killGroup(); // reap anything the process left behind in its group
      resolve({
        exit_code: code, signal, timed_out: timedOut,
        output: Buffer.concat(chunks).toString("utf8") + extra,
        bytes_total: total, truncated: total > capBytes, duration_ms: Date.now() - started,
      });
    };
    child.on("error", e => done(null, null, `\nspawn error: ${e.message}`));
    child.on("close", (code, signal) => done(code, signal));
  });
}

// ---- globs ------------------------------------------------------------------------------------

export function expandBraces(pattern) {
  const m = pattern.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!m) return [pattern];
  return m[2].split(",").flatMap(alt => expandBraces(m[1] + alt + m[3]));
}

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { i++; if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*"; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(glob, files) {
  const res = expandBraces(glob).map(globToRegExp);
  return files.filter(f => res.some(r => r.test(f)));
}
