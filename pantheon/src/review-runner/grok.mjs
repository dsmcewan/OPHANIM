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
//   - the stream is parsed tolerantly (parseGrokStream): the observed {"type":"text","data"} chunks after the last tool
//     event, complete assistant / result messages, or other incremental text chunks
//     joined in order; tool and reasoning events never count; lines that
//     are not JSON are counted.
import { cp, chmod, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
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
  // The permission profile the run will see (its scratch copy of the state dir carries config.toml). Recorded, never
  // blocking: the jail confines writes whatever the profile says; a missing allow rule shows up as stopReason cancelled.
  const perm = await grokPermissionConfig(stateDir);
  checks.permissions = { ...perm, rules: perm.rules.map(l => redactStrong(l, env)),
    note: "the [ui] permission_mode and the [permission] rules of the state dir's config.toml (docs.x.ai/build/features/permissions); the runner records them and writes none" };
  const warnings = [];
  if (!perm.allow_rules) warnings.push(`permissions: ${perm.present ? `${perm.path} has no [permission] allow rule` : `no ${perm.path}`}: under the default "ask" profile a headless run cancels the tool calls no rule allows (observed 2026-11-19: an authorized .review-tests edit, stopReason cancelled); see the review README, "Grok permissions"`);
  return { ok: failed.length === 0, failed, warnings, checks, cli_version: checks.version.text, auth_method_observed: s.ok ? "state-dir-present (browser login assumed, not verified)" : "none found", model_check: "not checked" };
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

// ---- the Grok CLI's permission profile (docs.x.ai/build/features/permissions, read 2026-11-19) -----------------------
// DOCUMENTED: the default permission mode is "ask" (it prompts for any tool call no rule allows); the default mode is set
// under [ui] `permission_mode` ("ask" | "auto" | "always-approve"; legacy `approval_mode`, `yolo = true`) in the USER
// config only, ~/.grok/config.toml; allow/deny rules are `[permission] rules = [{ action = "allow" | "deny", tool =
// "Bash" | "Edit" | "Read" | ..., pattern = "..." }]`, `deny` always wins, and `--allow` / `--deny` take the same
// patterns per invocation.
// NOT DOCUMENTED: what headless `-p` does with a call that would prompt, the pattern syntax beyond the page's examples
// ("git *", "rm -rf *"), and path patterns for Edit. OBSERVED (owner, 09d490f, 2026-11-19): under the default profile an
// authorized `.review-tests/` edit was cancelled ("User cancelled the execution for tool `search_replace`") and the CLI
// exited 0 with `stopReason: "cancelled"`.
// So the runner does NOT write rules itself (the pattern semantics are not documented exactly enough to narrow them to
// `.review-tests/` and the listed commands); the owner adds them to the state dir's config.toml (the run sees a per-run
// copy of it), and the runner RECORDS what that file says: the permission mode and the [permission] section's lines.
/** The Grok state dir's config.toml, as far as permissions go. {path, present, permission_mode, rules: [lines], allow_rules}. Never throws. */
export async function grokPermissionConfig(stateDir) {
  const path = join(stateDir, "config.toml");
  let text;
  try { text = await readFile(path, "utf8"); } catch { return { path, present: false, permission_mode: null, rules: [], allow_rules: 0 }; }
  let section = null, mode = null;
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const h = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (h) { section = h[1]; continue; }
    if (section === "ui") {
      const m = /^(permission_mode|approval_mode|yolo)\s*=\s*(.+)$/.exec(line);
      if (m && (m[1] === "permission_mode" || mode === null)) mode = `${m[1]}=${m[2].replace(/^"|"$/g, "")}`;
    } else if (section === "permission") rules.push(line.slice(0, 300));
  }
  return { path, present: true, permission_mode: mode, rules: rules.slice(0, 40), allow_rules: rules.filter(l => /action\s*=\s*"allow"/.test(l)).length };
}

// ---- the stream ------------------------------------------------------------------------------------------------------
// The Grok CLI's streaming-json schema is UNDOCUMENTED: docs.x.ai/build/cli/headless-scripting (read 2026-11-19) says
// only "`streaming-json`: newline-delimited JSON events". OBSERVED (grok 1.0.44, owner's runs of assignment 3 at
// 09d490f, 2026-11-19; trimmed in tests/fixtures/grok-1.0.44-observed-stream.json): one JSON object per line,
//   {"type":"text","data":"<chunk>"}                   the assistant's public text, in small chunks
//   {"type":"thought","data":"<chunk>"}                reasoning: never the answer
//   {"type":"tool_call",...} / {"type":"tool_call_update","toolCallId",...,"status":"completed"|"failed"|null,...}
//   {"type":"available_commands",...} {"type":"usage",...} {"type":"plan","entries":[...]}   housekeeping
//   {"type":"end","stopReason":"end_turn"|"cancelled",...,"usage":{...},"num_turns":N}       the last line
// The final answer is the run of `text` chunks after the LAST tool event, joined without separators (the owner's
// recovery of the 09d490f run used exactly that rule, and the parser reproduces its bytes). A turn that ends with any
// stopReason other than end_turn did not finish (see runGrok). Other shapes (complete assistant / result messages,
// *_delta chunks) are still read, as before.
const textOf = (v, depth = 0) => {
  if (depth > 6 || v == null) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const t = v.map(x => (typeof x === "string" ? x : x && typeof x === "object" && !(TOOL.test(String(x.type ?? "")) || QUIET.test(String(x.type ?? ""))) ? textOf(x, depth + 1) ?? "" : "")).join("");
    return t || null;
  }
  if (typeof v === "object") {
    for (const k of ["text", "content", "message", "output", "output_text", "result", "response", "delta", "value", "data"]) {
      if (!(k in v)) continue;
      const x = textOf(v[k], depth + 1);
      if (x) return x;
    }
  }
  return null;
};
// Reasoning and housekeeping: never the answer, and they do not interrupt a run of text chunks.
const QUIET = /thought|thinking|reason|^usage$|^available_commands$|^plan$|^status$|^start$|^init$|^end$|session_(created|started)|permission|error/i;
// Tool activity: never the answer, and it ends the current run of text (what came before a tool call was narration).
const TOOL = /tool|function|command|exec|shell|patch|diff|file|search/i;
const CHUNKISH = /chunk|delta|partial|stream/i;
const RESULTISH = /^(result|final|done|complete)/i;
const FINALISH = /result|final|done|complete|message|assistant|response|answer|text/i;
/** The event's own name: type / event / kind, or an ACP-style update's sessionUpdate. */
const eventName = e => String(e.type ?? e.event ?? e.kind ?? e.sessionUpdate ?? e.params?.update?.sessionUpdate ?? e.update?.sessionUpdate ?? e.method ?? "");
const bodyOf = e => e.params?.update ?? e.update ?? e;
/**
 * Read the streaming-json lines tolerantly. In order:
 *   - a text chunk (Grok's {"type":"text","data"}, or a chunk / delta event) appends to the current run of text, which
 *     stands as the final text;
 *   - a tool event ends the run: the text before it was narration, so a chunk-built (or message) final text is dropped;
 *   - a complete result event (result / final / done / complete) or assistant message with text sets the final text;
 *   - reasoning and housekeeping events are skipped (they neither add nor interrupt);
 *   - the `end` event's stopReason (or any event's stopReason / stop_reason) is kept as `stop_reason`.
 * Also: `usage` (the last usage object), `num_turns`, `cancelled_tools` (tool calls whose update failed with a
 * "cancelled" message: [{tool, message}]). On no final text, `diagnosis` names the last event types, the type counts and
 * the last event's keys (never its values).
 */
export function parseGrokStream(lines) {
  const events = [];
  let unparsed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === "object" && !Array.isArray(e)) events.push(e); else unparsed++; } catch { unparsed++; }
  }
  let final = null, final_source = null, usage = null, error = null, buffer = "", chunks = 0, messages = 0, stop_reason = null, num_turns = null;
  const cancelled_tools = [], toolNames = new Map();
  // own: every event the CLI printed except a bare start (its own messages and tool activity), each capped.
  const own = events.filter(e => !/^(start|init)$/i.test(eventName(e))).map(e => {
    const t = JSON.stringify(e);
    return { kind: eventName(e) || "event", text: t.length > 16384 ? `${t.slice(0, 16384)}… (truncated)` : t };
  });
  const counts = {};
  for (const e of events) {
    const name = eventName(e), body = bodyOf(e);
    counts[name || "(no type)"] = (counts[name || "(no type)"] ?? 0) + 1;
    if (e.usage && typeof e.usage === "object") usage = e.usage;
    else if (e.result?.usage && typeof e.result.usage === "object") usage = e.result.usage;
    const sr = e.stopReason ?? e.stop_reason ?? body.stopReason ?? body.stop_reason;
    if (typeof sr === "string" && sr) stop_reason = sr;
    if (Number.isInteger(e.num_turns)) num_turns = e.num_turns;
    if (/error/i.test(name) || (e.error && !e.result)) error = String(e.error?.message ?? e.error ?? e.message ?? "error").slice(0, 1000);
    const role = body.role ?? body.message?.role ?? null;
    if (role && role !== "assistant") continue;                            // the user's / a tool's message
    // Grok's native text chunk.
    if (name === "text" && typeof body.data === "string") { buffer += body.data; chunks++; final = buffer; final_source = "chunks"; continue; }
    if (QUIET.test(name) && !RESULTISH.test(name) && role !== "assistant") continue;
    if (TOOL.test(name) && !RESULTISH.test(name) && role !== "assistant") {
      if (e.toolCallId && (e.toolName || e.title)) toolNames.set(e.toolCallId, e.toolName ?? e.title);
      if (/failed|error|cancel/i.test(String(e.status ?? ""))) {
        const msg = textOf(e.content);
        if (msg && /cancel/i.test(msg)) cancelled_tools.push({ tool: toolNames.get(e.toolCallId) ?? e.toolName ?? null, message: msg.slice(0, 300) });
      }
      buffer = "";
      if (final !== null && !RESULTISH.test(final_source ?? "")) { final = null; final_source = null; }
      continue;
    }
    if (CHUNKISH.test(name) || ("delta" in body && !FINALISH.test(name.replace(CHUNKISH, "")))) {
      const x = textOf(body.delta ?? body.content ?? body.text ?? body.message ?? body.data);
      if (x) { buffer += x; chunks++; final = buffer; final_source = "chunks"; }
      continue;
    }
    if (FINALISH.test(name) || name === "text" || role === "assistant") {
      const x = RESULTISH.test(name)
        ? textOf(["result", "text", "content", "response", "output", "message"].map(k => body[k]).find(v => textOf(v)?.trim()))
        : textOf(body.content ?? body.message ?? body.text);
      if (x && x.trim()) { final = x; final_source = name || "assistant"; messages++; buffer = ""; }
    }
  }
  if (final !== null && !final.trim()) final = null;
  const last = events.slice(-8).map(e => eventName(e) || "(no type)");
  const diagnosis = final === null ? {
    last_event_types: last,
    type_counts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20)),
    last_event_keys: events.length ? Object.keys(events.at(-1)).slice(0, 20) : [],
  } : null;
  return { final_text: final, final_source, usage, error, events: events.length, unparsed, chunks, messages, own, diagnosis, stop_reason, num_turns, cancelled_tools };
}

/**
 * Why a turn that ended with stopReason `stop` (not end_turn) is not a finished review: the reason line for the findings
 * header. `cancelled` names the cancelled tool calls and points at the permission profile.
 */
export function grokStopFailure(stop, cancelled = [], exit_code = 0) {
  const tools = [...new Set(cancelled.map(c => c.tool).filter(Boolean))];
  const head = `grok ended its turn with stopReason "${stop}", not "end_turn" (exit ${exit_code ?? "?"}): the review did not finish`;
  if (/cancel/i.test(stop)) {
    return `${head}; ${cancelled.length ? `${cancelled.length} tool call(s) were cancelled (${tools.join(", ") || "unnamed"}: "${cancelled[0].message}")` : "the CLI cancelled the turn"}. ` +
      "This is most likely the Grok CLI's permission profile: headless runs under the default \"ask\" mode cancel any tool call no allow rule covers. " +
      "Add narrow [permission] allow rules to the Grok state dir's config.toml (see the review README, \"Grok permissions\"), then --continue";
  }
  return `${head}. Check the Grok CLI's permission profile and the transcript (cli.own) for the last tool calls`;
}
