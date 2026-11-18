// Assignment 3 in subscription mode: xAI's Grok Build CLI.
//
// DOCUMENTED (docs.x.ai/build/overview, read 2026-11-18): install with `curl -fsSL https://x.ai/cli/install.sh | bash`;
// "On first launch, Grok opens a browser for authentication. In non-browser environments, use an API key"
// (XAI_API_KEY); headless `grok -p "<prompt>" --output-format streaming-json`, `-m <model>`; Grok Build is powered by
// grok-4.7.
// NOT DOCUMENTED: whether a SuperGrok / X Premium subscription covers CLI usage (the findings header says
// `subscription_coverage: undocumented`), the CLI's sandbox and permission flags, its event schema, where it keeps its
// login, and any zero-spend login-status or model-list command. So:
//   - XAI_API_KEY is SCRUBBED (it would make the run metered); a CLI that then asks for a key or a login is a refusal.
//   - the login is taken to live in --grok-state-dir (default ~/.grok; an ASSUMPTION, nothing was discovered): the
//     preflight requires it to exist and be non-empty, and the run sees a per-run SCRATCH COPY of it (mode 0700,
//     removed afterwards), never the real one.
//   - the CLI runs INSIDE our bubblewrap jail, because its own tool permissions are unknown: the host read-only, a
//     fresh /tmp, the worktree read-only with `.review-tests/` bound read-write for assignments 1-3 (nothing writable
//     in the worktree for 4), the main repository's git dirs read-only, the CLI's own directory read-only (it may sit
//     under /tmp), the state scratch read-write at the state dir's path; the network is NOT cut (the CLI must reach xAI).
//   - the stream is parsed tolerantly: the final text is the last result / assistant message event's text; lines that
//     are not JSON are counted.
import { cp, chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { redactStrong } from "../board/agy-cli.mjs";
import { repoGitDirs } from "../agy/sandbox.mjs";
import { REVIEW_TESTS_DIR, runCli } from "./cli-common.mjs";

export const grokArgv = ({ model, prompt }) => ["-p", prompt, "--output-format", "streaming-json", "-m", model];

/** Does the state dir hold something (the browser login is assumed to live there)? {ok, why, entries}. */
export async function grokStateDir(dir) {
  let st;
  try { st = await stat(dir); } catch { return { ok: false, entries: 0, why: `${dir} does not exist` }; }
  if (!st.isDirectory()) return { ok: false, entries: 0, why: `${dir} is not a directory` };
  const entries = (await readdir(dir).catch(() => [])).length;
  return entries ? { ok: true, entries, why: null } : { ok: false, entries, why: `${dir} is empty` };
}

export const NEEDS_KEY = /XAI_API_KEY|api[ _-]?key|not\s+(logged|signed)\s+in|log\s?in\s+required|please\s+(log|sign)\s?in|unauthori[sz]ed|authenticat/i;

/** Zero-spend preflight: the binary, its version, a non-empty state dir (assumed login), bwrap. */
export async function grokPreflight({ cli, env, stateDir, bwrapOk, parentEnv, timeoutMs = 60_000 }) {
  const checks = {}, failed = [];
  const v = await runCli({ cmd: cli, args: ["--version"], env, timeoutMs });
  checks.version = { argv: [cli, "--version"], exit_code: v.exit_code, text: redactStrong(`${v.stdout}${v.stderr}`, env).trim().slice(0, 200) || null };
  if (v.exit_code !== 0) failed.push(`\`grok --version\` failed (exit ${v.exit_code ?? v.killed_for ?? v.spawn_error})`);
  const s = await grokStateDir(stateDir);
  checks.login_state = { state_dir: stateDir, ok: s.ok, entries: s.entries, why: s.why,
    note: "ASSUMED: the browser login lives in this directory; no documented command reports the Grok CLI's login without a model turn" };
  if (!s.ok) failed.push(`no Grok browser login found (${s.why}): run \`grok\` once interactively and sign in in the browser, or pass --grok-state-dir; subscription mode never uses XAI_API_KEY`);
  checks.api_key_in_parent_env = { present: typeof parentEnv?.XAI_API_KEY === "string" && parentEnv.XAI_API_KEY.length > 0, scrubbed: true };
  checks.model_list = { status: "not checked", why: "the Grok CLI documents no model-list command" };
  checks.bwrap = { ok: bwrapOk.ok, why: bwrapOk.why ?? null };
  if (!bwrapOk.ok) failed.push(`bwrap is unavailable (${bwrapOk.why}): the Grok CLI never runs unjailed`);
  return { ok: failed.length === 0, failed, checks, cli_version: checks.version.text, auth_method_observed: s.ok ? "state-dir-present (browser login assumed, not verified)" : "none found", model_check: "not checked" };
}

const real = p => { try { return realpathSync(p); } catch { return p; } };

/**
 * The bwrap argv prefix for the Grok CLI. Returns {argv, binds, writable}.
 *   worktree      read-only; with write_allowed, <worktree>/.review-tests (must exist) read-write
 *   state         {dir, scratch}: the scratch bound read-write at the state dir's path
 *   cliDir        the CLI's directory, read-only (visible even under /tmp)
 */
export function grokBwrapArgs({ worktree, write_allowed, state, cliDir, bwrap = "bwrap" }) {
  const wt = real(worktree);
  const binds = [];
  if (cliDir) binds.push({ mode: "ro", path: real(cliDir) });
  binds.push({ mode: "ro", path: wt });
  const git = repoGitDirs(wt);
  if (git) { binds.push({ mode: "ro", path: git.common_dir }); if (git.git_dir !== git.common_dir && !git.git_dir.startsWith(git.common_dir + "/")) binds.push({ mode: "ro", path: git.git_dir }); }
  if (write_allowed) binds.push({ mode: "rw", path: join(wt, REVIEW_TESTS_DIR) });
  if (state) binds.push({ mode: "rw", path: state.dir, src: state.scratch });
  // Parent-first (stable by depth), so a deeper bind (the writable .review-tests) overrides the read-only worktree.
  const depth = p => p.split("/").filter(Boolean).length;
  binds.sort((a, b) => depth(a.path) - depth(b.path));
  const argv = [bwrap, "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const b of binds) argv.push(b.mode === "rw" ? "--bind" : "--ro-bind", b.src ?? b.path, b.path);
  argv.push("--chdir", wt, "--");
  return { argv, binds, writable: binds.filter(b => b.mode === "rw").map(b => b.path).concat(["/tmp (a fresh tmpfs)"]) };
}

/** A per-run scratch copy of the state dir (mode 0700). Returns {dir, scratch}. */
export async function grokStateScratch(stateDir, runDir) {
  const scratch = join(runDir, "grok-state");
  await mkdir(dirname(scratch), { recursive: true });
  await cp(stateDir, scratch, { recursive: true, verbatimSymlinks: true });
  await chmod(scratch, 0o700);
  return { dir: real(stateDir), scratch };
}
export const dropGrokScratch = s => (s ? rm(s.scratch, { recursive: true, force: true }).catch(() => {}) : Promise.resolve());

const textOf = v => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) { const t = v.map(x => (typeof x === "string" ? x : typeof x?.text === "string" ? x.text : "")).join(""); return t || null; }
  if (v && typeof v === "object") return typeof v.text === "string" ? v.text : typeof v.content === "string" ? v.content : Array.isArray(v.content) ? textOf(v.content) : null;
  return null;
};
/**
 * Read the streaming-json lines tolerantly. The final text: walking back from the last event, the first whose type
 * names a result / final answer with a text field (result, text, content, response, output), or an assistant message
 * (role "assistant", or a type naming a message) with text content. Usage: the last `usage` object seen.
 */
export function parseGrokStream(lines) {
  const events = [];
  let unparsed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === "object" && !Array.isArray(e)) events.push(e); else unparsed++; } catch { unparsed++; }
  }
  let final = null, usage = null, error = null;
  // own: every event the CLI printed except a bare start (its own messages and tool activity), each capped.
  const own = events.filter(e => !/^(start|init)$/i.test(String(e.type ?? e.event ?? ""))).map(e => {
    const t = JSON.stringify(e);
    return { kind: String(e.type ?? e.event ?? "event"), text: t.length > 16384 ? `${t.slice(0, 16384)}… (truncated)` : t };
  });
  for (const e of events) {
    if (e.usage && typeof e.usage === "object") usage = e.usage;
    else if (e.result?.usage && typeof e.result.usage === "object") usage = e.result.usage;
    const t = String(e.type ?? e.event ?? "");
    if (/error/i.test(t) || (e.error && !e.result)) error = String(e.error?.message ?? e.error ?? e.message ?? "error").slice(0, 1000);
  }
  for (let i = events.length - 1; i >= 0 && final === null; i--) {
    const e = events[i], t = String(e.type ?? e.event ?? "");
    if (/result|final|done|complete/i.test(t)) {
      for (const k of ["result", "text", "content", "response", "output"]) { const x = textOf(e[k]); if (x && x.trim()) { final = x; break; } }
    } else if (e.role === "assistant" || /message|assistant/i.test(t)) {
      const x = textOf(e.content ?? e.message ?? e.text);
      if (x && x.trim()) final = x;
    }
  }
  return { final_text: final, usage, error, events: events.length, unparsed, own };
}
