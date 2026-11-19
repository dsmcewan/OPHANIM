// The board's Antigravity turn uses the operator's CLI OAuth session. The SDK lane is a separate
// API-key transport and cannot consume an OAuth refresh token renamed to GEMINI_API_KEY.
import { spawnPromise } from "./spawn.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseUsageEnvelope, quotaEvidence, scopeQuota } from "../agy/quota.mjs";

// A QUOTA REFUSAL by Antigravity, read from what the CLI itself reported (its result event and its stderr): an HTTP
// 429, RESOURCE_EXHAUSTED, or a quota/rate-limit/spend-cap/prepaid-balance message. The CLI has no status code of its
// own, so the refusal is raised as status 429 with code `quota_exhausted` -- the shape packages/model-client
// classifyFailure classifies as quota -- and the dispatcher's quota failover acts on that classification, never on this
// text (owner direction 2026-11-17). The wording Antigravity prints for a spent quota is not documented: the detection
// lives in src/agy/quota.mjs (isQuotaFailure / quotaEvidence), with `explicit` set for 429 / RESOURCE_EXHAUSTED and
// unset for the softer words; anything it does not match stays an ordinary failure, which never reaches the metered API.
export function agyQuotaRefusal({ result = null, stderr = "" } = {}) {
  const hit = quotaEvidence({ result, stderr });
  return hit ? { status: 429, code: "quota_exhausted", matched: hit.matched, explicit: hit.explicit } : null;
}
const refused = (message, run, result) => {
  const quota = agyQuotaRefusal({ result, stderr: run.stderr ?? "" });
  return quota ? Object.assign(new Error(`${message}: Antigravity refused for quota ("${quota.matched}")`), { status: quota.status, code: quota.code, transport: "agy-cli" })
    : new Error(`${message} (inspect local CLI diagnostics)`);
};

// `env` (optional) ADDS variables to the child's environment (the pipeline's implementer is given its unit's A2A
// endpoint this way); `signal` (optional) cancels the child. Neither can restore a Google API key: those are
// stripped after `env` is merged.
export async function runAgyCliTurn({ cli, repo, worktree, role, model, prompt, timeoutS,
  schemaPath = null, onEvent = () => {}, env: extraEnv = null, signal = undefined }) {
  if (!/^[a-z][a-z-]*$/.test(role)) throw new Error(`agy CLI invalid role ${role}`);
  const agent = `pantheon-${role}`;
  const cardPath = join(repo, ".agents", "agents", agent, "agent.md");
  if (!existsSync(cardPath)) throw new Error(`agy CLI role card ${cardPath} missing`);
  const card = readFileSync(cardPath, "utf8");
  const frontmatterEnd = card.indexOf("\n---\n", 4);
  const frontmatter = card.startsWith("---\n") && frontmatterEnd >= 0 ? card.slice(4, frontmatterEnd) : "";
  if (!frontmatter.split("\n").some(line => line === `name: ${agent}`)) {
    throw new Error(`agy CLI role card ${cardPath} does not declare name: ${agent}`);
  }
  const args = ["--agent", agent, "--model", model, "--add-dir", worktree, "--sandbox",
    "--output-format", "stream-json", "--print-timeout", `${timeoutS}s`];
  if (schemaPath) args.push("--json-schema", schemaPath);
  args.push("--print", prompt);

  // A child inheriting GEMINI_API_KEY could silently use the API-key route while appearing to
  // validate OAuth. Strip both Google API-key spellings at the subprocess boundary.
  const env = { ...process.env, ...(extraEnv ?? {}) };
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;

  let init = null, result = null, toolCalls = 0, subagentCalls = 0, answerChars = 0;
  const report = ev => { try { onEvent(ev); } catch { /* telemetry is not the turn's authority */ } };
  const onStdoutLine = line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.event === "init") {
      init = event.init;
      report({ event: "seat.start", detail: `OAuth CLI agent ${init?.agent ?? "unknown"}, model ${init?.model ?? "unknown"}` });
    } else if (event.event === "step_update") {
      const step = event.step_update;
      if (step?.step_type === "tool" && step.state === "DONE") {
        toolCalls++;
        if (step.tool_name === "invoke_subagent") subagentCalls++;
        report({ event: "seat.tool", detail: step.tool_name ?? "unknown" });
      }
      if (step?.text_delta) {
        answerChars += step.text_delta.length;
        if (answerChars % 1000 < step.text_delta.length) report({ event: "seat.progress", detail: `${answerChars} response chars` });
      }
    } else if (event.event === "result") {
      result = event.result;
    }
  };

  const run = await spawnPromise(cli, args, { cwd: repo, env,
    timeout: (timeoutS + 15) * 1000, onStdoutLine, ...(signal ? { signal } : {}) });
  if (run.killedFor === "cancelled") throw Object.assign(new Error("agy CLI turn was cancelled"), { code: "ABORTED" });
  if (run.signal === "SIGTERM") throw new Error(`agy CLI timed out after ${timeoutS}s`);
  if (run.status !== 0) throw refused(`agy CLI exited ${run.status}; status ${result?.status ?? "missing"}`, run, result);
  // init echoes launch selection; it does not prove the CLI actually applied the role card.
  // The local frontmatter preflight above catches missing cards, while a live answered turn is
  // still needed before this transport can replace the SDK as the board default.
  if (init?.agent !== agent || init?.model !== model) {
    throw new Error(`agy CLI identity mismatch: expected ${agent}/${model}, got ${init?.agent ?? "none"}/${init?.model ?? "none"}`);
  }
  if (result?.status !== "SUCCESS") throw refused(`agy CLI status ${result?.status ?? "missing"}`, run, result);
  const text = typeof result.response === "string" ? result.response.trim() : "";
  const structured = result.structured_output;
  if (!Number.isInteger(result.num_turns) || result.num_turns < 1 || (!text && !structured)) {
    throw new Error("agy CLI returned no completed model turn (empty response or print timeout)");
  }
  return { text, structured_output: structured ?? null,
    response_id: result.conversation_id ?? null, usage: result.usage ?? null,
    tool_calls: toolCalls, subagent_calls: subagentCalls };
}

// ---- THE PIPELINE'S UNIT WORKER: a headless, multi-turn, tool-enabled agy run inside the bwrap jail ----------------
//
//   agy --agent pantheon-unit-worker --model <lane> --mode=accept-edits --add-dir <abs worktree>
//       --disable-slash-commands --output-format stream-json --print-timeout <n>s
//       --log-file <control_dir>/run/agy.log --print <prompt>
//
// cwd = the unit's control dir (src/agy/workspace.mjs wrote the role card, hooks.json, mcp_config.json and jail.json
// there); the worktree is added to the workspace with --add-dir. OWNER-STATED (2026-11-18; scripts/agy-worker-probe.mjs
// confirms or refutes): a headless `agy -p` run must always pass `--add-dir <absolute worktree>` alongside the process
// cwd so every version adopts the workspace and loads `.agents/hooks.json` and `.agents/mcp_config.json`;
// `--dangerously-skip-permissions` skips PreToolUse hooks entirely; `--sandbox` must not be passed inside bwrap.
// workerArgv asserts the --add-dir is absolute and assertWorkerArgv throws if either forbidden flag ever appears.
// `--log-file` (owner-stated) puts the CLI's own log in the writable run dir. `--mode=accept-edits` (documented: "Automatically
// approves file creations and edits inside your workspace, but still asks before running terminal commands"); in
// headless -p an approval the CLI cannot obtain is soft-denied, so a command runs only when the PreToolUse jail hook
// auto-approves it (the unit's verify_cmd). NEVER --dangerously-skip-permissions. NOT --sandbox: the outer bwrap jail
// is the containment, and the CLI's own sandbox nested inside it is undocumented (see the role card).
//
// ENV: an ALLOWLIST of process.env (workerEnv: PATH, HOME, locale, TERM, TMPDIR, proxy and CA variables, AGY_* and
// ANTIGRAVITY_*, and what PANTHEON_AGY_ENV_PASS lists; never a secret-named variable, never the Google keys), plus the
// non-secret part of `env`, plus ANTIGRAVITY_AGY_CLEANUP=all.
// ANTIGRAVITY_AGY_CLEANUP is OWNER-SPECIFIED and UNDOCUMENTED (it appears nowhere in Antigravity's CLI docs as read
// 2026-11-18); it is set because the owner asked for it, and every turn record says so (`cleanup_env`).
//
// FAILURES are thrown with `code`:
//   quota_exhausted  status 429, `quota: {matched, explicit}` (src/agy/quota.mjs): the caller probes and decides
//   lane_failure     `kind`: timeout (print-timeout or the process timeout) | exit (non-zero exit, or result status
//                    ERROR/INVALID/CANCELED/INTERRUPTED/other, or no completed turn) | stream (no result event, an
//                    unparseable stream, an init identity mismatch) | spawn (the CLI or bwrap could not start it)
//   SANDBOX_UNAVAILABLE  bwrap is missing or fails its probe and `sandbox.allowUnsandboxed` is not true
//   ABORTED          the signal fired
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { homedir as homeOf } from "node:os";
import { dirname as dirOf, isAbsolute, relative as relOf, resolve as resolveOf } from "node:path";
import { bwrapArgs, sandboxAvailable, defaultAgyStateDirs, cliDirOf, geminiState, dropGeminiState } from "../agy/sandbox.mjs";
import { cardTools, validateCardTools } from "../agy/workspace.mjs";
import { MCP_SERVER as MCP_SERVER_NAME } from "../agy/jail-hook.mjs";
import { SECRETISH, controlDirSecrets, redactDeep, redactExact, redactStrong, secretValues } from "../agy/redact.mjs";

export const WORKER_AGENT = "pantheon-unit-worker";
export const AGY_CLEANUP = Object.freeze({ name: "ANTIGRAVITY_AGY_CLEANUP", value: "all", documented: false,
  note: "owner-specified (2026-11-18); not documented in Antigravity's CLI docs" });

// Never in a worker's argv: --dangerously-skip-permissions skips the PreToolUse jail hook (owner-stated); --sandbox
// would nest the CLI's own sandbox inside bwrap (owner-stated: never inside bwrap).
export const FORBIDDEN_WORKER_FLAGS = Object.freeze(["--dangerously-skip-permissions", "--sandbox"]);
/** Throw if a forbidden flag appears in `argv` (exactly, or as --flag=value). */
export function assertWorkerArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--print" || a === "-p") { i++; continue; }   // the prompt is text, not a flag
    const flag = typeof a === "string" ? a.split("=")[0] : "";
    if (FORBIDDEN_WORKER_FLAGS.includes(flag)) throw Object.assign(new Error(`agy worker argv carries ${flag}: refused (it would bypass the jail)`), { code: "FORBIDDEN_FLAG" });
  }
  return argv;
}
export function workerArgv({ model, worktree, prompt, timeoutS, log_file = null, control_dir = null, agent = WORKER_AGENT, conversation = null }) {
  if (typeof worktree !== "string" || !isAbsolute(worktree)) throw Object.assign(new Error(`agy worker: --add-dir must be an absolute worktree path, not ${JSON.stringify(worktree)}`), { code: "BAD_INPUT" });
  const log = log_file ?? (control_dir ? join(control_dir, "run", "agy.log") : null);
  if (log !== null && !isAbsolute(log)) throw Object.assign(new Error(`agy worker: --log-file must be absolute, not ${JSON.stringify(log)}`), { code: "BAD_INPUT" });
  // --disable-slash-commands ("Disable slash command and skill expansion in print mode", agy 1.5.10 --help): the prompt
  // carries plan and repository text, which must never expand into a slash command or a skill.
  if (typeof agent !== "string" || !/^pantheon-[a-z][a-z-]*$/.test(agent)) throw Object.assign(new Error(`agy worker: --agent must be a pantheon-<role> card name, not ${JSON.stringify(agent)}`), { code: "BAD_INPUT" });
  // --conversation <id> (agy 1.5.10 --help: "Resume a previous conversation by ID"): only the review runner's --continue.
  if (conversation !== null && (typeof conversation !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(conversation))) throw Object.assign(new Error(`agy worker: --conversation must be a plain id, not ${JSON.stringify(conversation)}`), { code: "BAD_INPUT" });
  return assertWorkerArgv(["--agent", agent, ...(conversation ? ["--conversation", conversation] : []), "--model", model, "--mode=accept-edits", "--add-dir", worktree,
    "--disable-slash-commands", "--output-format", "stream-json", "--print-timeout", `${timeoutS}s`, ...(log ? ["--log-file", log] : []), "--print", prompt]);
}
// THE WORKER'S ENVIRONMENT IS AN ALLOWLIST (independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6),
// question 7: workerEnv removed only GEMINI_API_KEY / GOOGLE_API_KEY, so OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY
// and every other credential of the controller's environment reached the CLI and every command it ran). From `base`
// (default process.env) ONLY these pass: the WORKER_ENV_ALLOW names, names starting with a WORKER_ENV_PREFIXES prefix,
// and the names or `PREFIX*` patterns the operator lists in PANTHEON_AGY_ENV_PASS (":"- or ","-separated; the test
// fixtures pass their fake CLI's FAKE_* this way); a secret-named variable (ENV_SECRETISH) never passes from `base`,
// whatever the lists say. `extra` is the caller's EXPLICIT choice and passes, EXCEPT a provider API key (`*_API_KEY`;
// the Google keys as before). CHOICE, recorded: the unit's own A2A token stays an explicit extra (the pipeline passes
// it, and ophanim/operate's lifecycle test, owned elsewhere, asserts it reaches the CLI); it is per unit, good only for
// this unit's bounded shim, and the code the verify command runs can read it from the control dir's MCP config anyway
// (same uid); what IS closed is the model's read tools (the hook denies the control dir) and other units' tokens (their
// control dirs are hidden in this jail: src/agy/sandbox.mjs siblingsHidden).
export const WORKER_ENV_ALLOW = Object.freeze(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TZ", "TMPDIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]);
export const WORKER_ENV_PREFIXES = Object.freeze(["LC_", "XDG_", "AGY_", "ANTIGRAVITY_"]);
export const ENV_SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE/i;
/** A provider API key: never in a worker env, not even as an explicit extra. */
export const PROVIDER_KEY = /(^|_)API_?KEY$|^GEMINI_API_KEY$|^GOOGLE_API_KEY$/i;
/** Is env variable `k` allowed into a worker's environment from `base` (see WORKER_ENV_ALLOW)? */
export function workerEnvAllows(k, pass = "") {
  if (ENV_SECRETISH.test(k) || k === "GEMINI_API_KEY" || k === "GOOGLE_API_KEY") return false;
  if (WORKER_ENV_ALLOW.includes(k) || WORKER_ENV_PREFIXES.some(p => k.startsWith(p))) return true;
  return String(pass ?? "").split(/[:,]/).map(s => s.trim()).filter(Boolean).some(p => (p.endsWith("*") ? k.startsWith(p.slice(0, -1)) : k === p));
}
/** {env, dropped: [names]}: the worker env and the names of `base` / `extra` it left out (never their values). */
export function workerEnvOf(extra = {}, base = null) {
  const src = base ?? process.env, pass = src.PANTHEON_AGY_ENV_PASS ?? process.env.PANTHEON_AGY_ENV_PASS ?? "";
  const env = {}, dropped = [];
  for (const [k, v] of Object.entries(src)) { if (v === undefined) continue; if (workerEnvAllows(k, pass)) env[k] = v; else dropped.push(k); }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === undefined || v === null) continue;
    if (PROVIDER_KEY.test(k)) { dropped.push(k); delete env[k]; continue; }
    env[k] = String(v);
  }
  // AGY_CLI_DISABLE_AUTO_UPDATE (documented: troubleshooting page): no self-update in the middle of a unit.
  Object.assign(env, { [AGY_CLEANUP.name]: AGY_CLEANUP.value, AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
  return { env, dropped: [...new Set(dropped)].sort() };
}
// `base` (optional): the environment to start from instead of process.env (the review runner passes an already
// scrubbed one); it is filtered through the allowlist either way.
export function workerEnv(extra = {}, base = null) {
  return workerEnvOf(extra, base).env;
}
// An env variable whose value a record never carries (the A2A token, any key or secret): src/agy/redact.mjs.
export { SECRETISH, redactSecrets, redactStrong } from "../agy/redact.mjs";
const laneFailure = (kind, message, more = {}) => Object.assign(new Error(message), { code: "lane_failure", kind, transport: "agy-cli", ...more });
const TIMEOUT_TEXT = /print[ _-]?timeout|timed out|DEADLINE_EXCEEDED/i;
const BAD_STATUS = new Set(["ERROR", "CANCELED", "CANCELLED", "INTERRUPTED", "INVALID"]);

/** The jail hook's decisions so far (one JSON object per line; an unparseable line is kept as {raw}). */
export async function readJailLog(control_dir) {
  const text = await readFile(join(control_dir, "run", "jail.log"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
}
/** The worker's final JSON summary, when its whole final message is one JSON object; else null. */
function summaryOf(text) {
  try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** A stream-json tool step as recorded: {tool_name, state, tool_info} (tool_info: whatever the CLI attached, if any). */
const toolStepOf = step => ({ tool_name: step.tool_name ?? null, state: step.state ?? null, tool_info: step.tool_info ?? step.toolInfo ?? null });
const isSubagentStep = s => s.tool_name === "invoke_subagent" || /ask_subagent$/.test(s.tool_name ?? "")
  || (s.tool_name === "call_mcp_tool" && /ask_subagent/.test(JSON.stringify(s.tool_info ?? "")));

/**
 * Build the worker's jail once (bwrap argv prefix + the agy state layout), so a preflight and the turn run in the SAME
 * one. Returns {prefix, sandboxRec, gstate}; throws SANDBOX_UNAVAILABLE (never a silent unjailed run) or
 * AGY_STATE_LAYOUT (src/agy/sandbox.mjs geminiState). `env` is the child env (workerEnv); its HOME is the default home.
 */
export async function prepareWorkerJail({ cli, control_dir, worktree, env = workerEnv(), sandbox = {}, a2a_socket = null }) {
  const wantSandbox = sandbox.enabled !== false;
  if (wantSandbox) {
    const probe = await sandboxAvailable(sandbox.bwrap ?? "bwrap");
    if (probe.ok) {
      const extra_ro = [...(sandbox.extra_ro ?? [])];
      const cliDir = cliDirOf(cli); if (cliDir) extra_ro.push(cliDir);
      // The A2A socket: a socket under the control dir is already visible (its read-only bind; connect() needs no
      // write access to the mount); one elsewhere (e.g. a short fallback under /tmp, which is a fresh tmpfs inside)
      // gets its directory bound read-only.
      if (a2a_socket) { const d = dirOf(resolveOf(a2a_socket)); const r = relOf(resolveOf(control_dir), d); if (r.startsWith("..") || resolveOf(r) === r) extra_ro.push(d); }
      const gstate = await geminiState({ home: sandbox.home ?? env.HOME ?? homeOf(), run_dir: join(control_dir, "run"), mode: sandbox.gemini_state ?? "scratch" });
      let b;
      try { b = bwrapArgs({ worktree, control_dir, agy_state_dirs: sandbox.agy_state_dirs ?? defaultAgyStateDirs(), extra_ro: extra_ro.filter(p => existsSync(p)), gemini_state: gstate, bwrap: sandbox.bwrap ?? "bwrap" }); }
      catch (e) { await dropGeminiState(gstate).catch(() => null); throw e; }   // the scratch holds the OAuth token: never leave it behind
      return { prefix: b.argv, gstate, sandboxRec: { enabled: true, kind: "bwrap", binds: b.binds, git: b.git,
        gemini_state: { enabled: gstate.enabled, mode: gstate.mode, gemini_dir: gstate.gemini_dir, cli_dir: gstate.cli_dir, mounts: gstate.mounts, copied: gstate.copied,
          withheld: gstate.withheld, skipped: gstate.skipped, hidden_state: gstate.hidden_state, readonly_subdirs: gstate.readonly_subdirs,
          writable_copies: (gstate.writable_copies ?? []).map(w => ({ path: w.path, dest: w.dest, status: w.status, ...(w.copied ? { copied: w.copied } : {}), ...(w.readonly_subdirs?.length ? { readonly_subdirs: w.readonly_subdirs } : {}), ...(w.why ? { why: w.why } : {}) })),
          ...(gstate.why ? { why: gstate.why } : {}) } } };
    }
    if (sandbox.allowUnsandboxed === true) return { prefix: [], gstate: null, sandboxRec: { enabled: false, reason: probe.why, allowUnsandboxed: true } };
    throw Object.assign(new Error(`agy worker: the bwrap sandbox is unavailable (${probe.why}); refusing to run the worker unjailed (pass sandbox.allowUnsandboxed: true to override)`), { code: "SANDBOX_UNAVAILABLE" });
  }
  if (sandbox.allowUnsandboxed === true) return { prefix: [], gstate: null, sandboxRec: { enabled: false, reason: "sandbox.enabled is false", allowUnsandboxed: true } };
  throw Object.assign(new Error("agy worker: sandbox.enabled is false and allowUnsandboxed is not true; refusing to run the worker unjailed"), { code: "SANDBOX_UNAVAILABLE" });
}

// ---- THE CLI'S OWN LOG FILES: read before the scratch is dropped ---------------------------------------------------
// OBSERVED (agy 1.5.10, owner's machine, bisect of 6e0d1d1 run twice, 2026-11-18): when ~/.gemini/antigravity-cli/log/
// is writable the CLI writes its diagnostics (the hooks_manager line, the not-logged-in lines, ...) to
// log/cli-<ts>.log INSTEAD of stderr; when it is not, they go to stderr. Every run below therefore snapshots the log dir
// before each command and reads the NEW (or grown: only the appended bytes) files afterwards, capped at
// CLI_LOG_CAP_BYTES in all and redacted with redactStrong, and every parser reads stdout + stderr + those files.
export const CLI_LOG_CAP_BYTES = 2 * 1024 * 1024;
/** The CLI's log dir as the jailed CLI sees it, on the host: the scratch's log/, else <home>/.gemini/antigravity-cli/log. */
export function cliLogDirOf(gstate, home = null) {
  if (gstate?.scratch_cli) return join(gstate.scratch_cli, "log");
  if (gstate?.cli_dir) return join(gstate.cli_dir, "log");
  return home ? join(home, ".gemini", "antigravity-cli", "log") : null;
}
/** {relative path: {size, mtimeMs}} of every regular file under `dir` (empty when it does not exist). Never follows a symlink. */
export async function snapshotCliLog(dir) {
  const out = {};
  if (!dir) return out;
  for (const rel of (await readdir(dir, { recursive: true }).catch(() => [])).sort()) {
    const st = await lstat(join(dir, rel)).catch(() => null);
    if (st?.isFile()) out[rel] = { size: st.size, mtimeMs: st.mtimeMs };
  }
  return out;
}
/**
 * The files under `dir` that are new or grew since `before` (snapshotCliLog): {dir, files: [{name, bytes, read_bytes,
 * truncated, grown}], text (redacted, each file's new bytes in name order), bytes_read, truncated}. `budget` (an object
 * {left}) is shared across calls so a whole run stays within CLI_LOG_CAP_BYTES.
 */
export async function readNewCliLogs(dir, before = {}, { env = {}, budget = { left: CLI_LOG_CAP_BYTES } } = {}) {
  const now = await snapshotCliLog(dir);
  const files = [];
  let text = "", bytes_read = 0, truncated = false;
  for (const [name, st] of Object.entries(now)) {
    const prev = before[name];
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
    const from = prev && st.size >= prev.size ? prev.size : 0;
    const want = st.size - from, n = Math.max(0, Math.min(want, budget.left));
    let chunk = "";
    if (n > 0) {
      const fh = await open(join(dir, name), "r").catch(() => null);
      if (fh) { try { const buf = Buffer.alloc(n); const { bytesRead } = await fh.read(buf, 0, n, from); chunk = buf.subarray(0, bytesRead).toString("utf8"); } finally { await fh.close().catch(() => {}); } }
    }
    budget.left -= Buffer.byteLength(chunk);
    bytes_read += Buffer.byteLength(chunk);
    const cut = n < want;
    truncated ||= cut;
    files.push({ name, bytes: st.size, read_bytes: Buffer.byteLength(chunk), truncated: cut, grown: Boolean(prev) });
    if (chunk) text += redactStrong(chunk, env) + (chunk.endsWith("\n") ? "" : "\n");
  }
  return { dir, files, text, bytes_read, truncated };
}
/**
 * The CLI saying it has no session. Observed on agy 1.5.10: "error getting token source: You are not logged into
 * Antigravity.", "doRefreshQuota: skipped (not logged in)", "Auth mode is unspecified, skipping fetchAvailableModels and
 * returning empty response". NOT EVIDENCE OF A LOGOUT by itself: see NEGATIVE_LOGIN_NOTE.
 */
export const AGY_NOT_LOGGED_IN = /not logged in(to)?\b|You are not logged into Antigravity|Auth mode is unspecified/i;
export const NEGATIVE_LOGIN_NOTE = "observed on agy 1.5.10 in every layout, including the real read-only directory, whenever the CLI could not write its log file; /usage succeeded in the same layouts";
/** A `workspaceDirs=[...]` line (what the CLI took as its workspace): the LAST one's entries, or null. */
export function parseWorkspaceDirs(text) {
  const found = String(text ?? "").split("\n").filter(l => WORKSPACE_DIRS.test(l));
  if (!found.length) return null;
  const inner = WORKSPACE_DIRS.exec(found.at(-1))[1];
  return { dirs: inner.split(/[\s,]+/).map(x => x.replace(/^["']|["']$/g, "")).filter(Boolean), lines: [...new Set(found.map(l => l.trim().slice(0, 500)))].slice(-10) };
}
const WORKSPACE_DIRS = /workspaceDirs=\[([^\]]*)\]/;
/**
 * Everything the parsers read from one or more commands: `sources` is {stdout, stderr, log_file, log_dir} text (any may
 * be missing; all are redacted here, log_dir is already redacted by readNewCliLogs). Returns {lines_scanned,
 * log_sources: {stdout_lines, stderr_lines, file_lines, log_file_lines}, hooks_loaded: {named, files, sources} | null,
 * workspace_dirs: [dirs] | null, workspace_dirs_lines, erofs_paths, erofs_lines, unknown_component, not_in_registry,
 * deprecated, negative_login_lines, gemini_dir_lines, project_resolve_errors} -- lines de-duplicated, redacted, capped.
 */
export function cliLogEvidence({ stdout = "", stderr = "", log_file = "", log_dir = "" } = {}, env = {}) {
  const src = { stdout: redactStrong(stdout, env), stderr: redactStrong(stderr, env), log_file: redactStrong(log_file, env), log_dir: String(log_dir ?? "") };
  const all = `${src.stdout}\n${src.stderr}\n${src.log_file}\n${src.log_dir}`;
  const ls = lines(all);
  const pick = (re, n = 30) => [...new Set(ls.filter(l => re.test(l)).map(l => l.slice(0, 500)))].slice(0, n);
  const hooks = parseHooksLoaded(all), ws = parseWorkspaceDirs(all);
  const erofs_lines = pick(PREFLIGHT_LOG_PATTERNS.read_only, 40);
  return {
    lines_scanned: ls.length,
    log_sources: { stdout_lines: lines(src.stdout).length, stderr_lines: lines(src.stderr).length, file_lines: lines(src.log_dir).length, log_file_lines: lines(src.log_file).length },
    hooks_loaded: hooks ? { named: hooks.named, files: hooks.files, sources: Object.entries(src).filter(([, t]) => HOOKS_LOADED.test(t)).map(([k]) => k) } : null,
    workspace_dirs: ws ? ws.dirs : null, workspace_dirs_lines: ws ? ws.lines : [],
    workspace_dirs_sources: ws ? Object.entries(src).filter(([, t]) => WORKSPACE_DIRS.test(t)).map(([k]) => k) : [],
    erofs_paths: [...new Set(erofs_lines.flatMap(l => [...l.matchAll(/(\/[^\s:"'()]+)/g)].map(x => x[1])))].sort().slice(0, 40), erofs_lines,
    unknown_component: pick(PREFLIGHT_LOG_PATTERNS.unknown_component), not_in_registry: pick(PREFLIGHT_LOG_PATTERNS.not_in_registry), deprecated: pick(PREFLIGHT_LOG_PATTERNS.deprecated),
    negative_login_lines: pick(AGY_NOT_LOGGED_IN, 20), gemini_dir_lines: pick(GEMINI_DIR_LINE, 20), project_resolve_errors: pick(/failed to resolve project/i, 10),
  };
}

// ---- THE ZERO-SPEND PREFLIGHT: what the CLI itself says about the workspace, before any model turn ------------------
// `agy --print /usage --output-format json`, `agy agents` and `agy mcp list` start no model turn. They run in the SAME
// jail, control dir and workspace as the turn, with AGY_CLI_DISABLE_AUTO_UPDATE=true (workerEnv).
// What was observed (agy 1.5.10, owner's machine; 2026-11-18; zero model turns):
//   - both subcommands REJECT `--log-file` and `--add-dir` (exit 1, "Error: flags provided but not defined: ..."), so
//     the preflight passes them neither; AGY_BAD_FLAG recognises a flag refusal, as a blocking `agents` failure.
//   - `/usage` returned quota groups with buckets in EVERY bisect layout, the current one (L4) included: the login
//     survives the jail. It is the AUTH check.
//   - the subcommands' "Auth mode is unspecified, ..." / "You are not logged into Antigravity." lines appeared in
//     exactly the layouts whose antigravity-cli/log/ was NOT writable (the real read-only dir included), and in the log
//     FILE otherwise: routine output, NOT a logout. They are ADVISORY diagnostics (diagnostics.negative_login_lines).
//   - `agy mcp list` listed only the GLOBAL server and printed its configured credential: DISCOVERY IS ADVISORY and the
//     mcp list output is NEVER stored (only server names, `credential_redacted: true`).
// BLOCKING checks (in `failed` when not ok; the turn must not start):
//   card_tools  the control dir's card lists a name in AGY_1_5_10_UNKNOWN_OR_DEPRECATED (validateCardTools)
//   auth        in-jail `/usage` did not parse as the observed envelope with at least one group with buckets
//   lane_quota  the group serving `model` (the lane) reads exhausted in that envelope
//   agents      `agy agents` exited non-zero, was killed, or refused a flag
//   log_scan    a `read-only file system` / EROFS, `unknown component`, `not found in registry` or `deprecated` line in
//               any command's stdout/stderr or in the NEW files of the CLI's log dir (the scratch's antigravity-cli/log/)
// ADVISORY checks (recorded, in `warnings` when not ok, never blocking):
//   mcp_list    `agy mcp list` exited non-zero, refused a flag, or a line naming the server says it failed
//   discovery   {agent_listed, server_listed, note}: whether the listings name pantheon-unit-worker / pantheon-subagents
//   hooks_discovery  {seen, named, files, lines}: the CLI's "loaded N named hooks from M hooks.json file(s)" line (from
//               stdout, stderr or the log files); M == 0 is a warning (observed for these subcommands; whether a --print
//               session loads the workspace's hooks is what the turn's cli_log shows)
// Every stored output is redacted with redactStrong.
export const PREFLIGHT_LOG_PATTERNS = Object.freeze({ read_only: /read-only file system|EROFS/i, unknown_component: /unknown component/i,
  not_in_registry: /not found in registry/i, deprecated: /deprecated/i });
/** A CLI refusing a flag (observed on agy 1.5.10: "Error: flags provided but not defined: -log-file"). */
export const AGY_BAD_FLAG = /unknown (shorthand )?flag|flags? provided but not defined|unrecognized (option|argument)|unexpected argument/i;
/**
 * The CLI's hook discovery line, observed on agy 1.5.10 (2026-11-18): "hooks_manager.go:54] loaded 0 named hooks from 0
 * hooks.json file(s)". Returns {named, files, lines} for the LAST such line of `text` (lines: every such line, up to
 * 10), or null when none is seen.
 */
export function parseHooksLoaded(text) {
  const found = String(text ?? "").split("\n").filter(l => HOOKS_LOADED.test(l));
  if (!found.length) return null;
  const m = HOOKS_LOADED.exec(found.at(-1));
  return { named: Number(m[1]), files: Number(m[2]), lines: found.slice(-10).map(l => l.trim().slice(0, 300)) };
}
const HOOKS_LOADED = /loaded (\d+) named hooks? from (\d+) hooks\.json file/i;
const GEMINI_DIR_LINE = /GeminiDir/i;
export const PREFLIGHT_BLOCKING = Object.freeze(["card_tools", "auth", "lane_quota", "agents", "log_scan"]);
export const PREFLIGHT_ADVISORY = Object.freeze(["mcp_list", "discovery", "hooks_discovery"]);
export const USAGE_ARGS = Object.freeze(["--print", "/usage", "--output-format", "json"]);
const lines = t => String(t ?? "").split("\n").map(l => l.trimEnd()).filter(Boolean);
const ENTRY = /^(?:[-*•✓✗✔✘]\s+)?([A-Za-z][A-Za-z0-9_.@-]{0,63})(?=[\s:,]|$)/;
const NOT_A_SERVER = /^(no|none|name|names|server|servers|configured|mcp|usage|error|warning|warn|info|flags|list|available|total|global|workspace|authorization|headers?|env|command|args|url|bearer)$/i;
const CREDENTIAL_SHAPED = /^(sk-|ctx7sk|ya29\.|ghp_|gho_|AIza|xox[abp]-)/i;
/**
 * The server names of an `agy mcp list` stdout, parsed conservatively: the first token of each non-indented,
 * non-empty line that looks like an entry (a name followed by whitespace, ":" or the end), headers and key words
 * skipped, anything credential-shaped dropped. Returns {servers: [names] | null (nothing parsed), line_count}.
 * Never returns the rest of a line.
 */
export function mcpServerNames(stdout) {
  const ls = String(stdout ?? "").split("\n").filter(l => l.trim());
  const names = [];
  for (const l of ls) {
    if (/^\s/.test(l) && !/^\s*[-*•]\s/.test(l)) continue;   // an indented continuation (config, headers, env)
    const m = ENTRY.exec(l.trimStart());
    if (!m || NOT_A_SERVER.test(m[1]) || CREDENTIAL_SHAPED.test(m[1]) || redactStrong(m[1]) !== m[1]) continue;
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return { servers: names.length ? names : null, line_count: ls.length };
}
/** The `/usage --output-format json` envelope of `stdout` (the whole text, else its last JSON line), parsed; or null. */
export function usageEnvelopeOf(stdout) {
  const tryParse = t => { try { return parseUsageEnvelope(JSON.parse(t)); } catch { return null; } };
  const whole = tryParse(String(stdout ?? "").trim());
  if (whole) return whole;
  for (const l of lines(stdout).reverse()) { const e = tryParse(l); if (e) return e; }
  return null;
}
/** True when the envelope is the observed JSON form with at least one group carrying buckets (the login is usable). */
export const usageHasBuckets = env => Boolean(env && env.format === "json" && (env.buckets ?? []).length > 0);
/**
 * Run the zero-spend preflight (above). Returns {ok, failed: [blocking check names not ok], warnings: [advisory check
 * names not ok], blocking: PREFLIGHT_BLOCKING, advisory: PREFLIGHT_ADVISORY, checks: {card_tools, auth, lane_quota,
 * agents, mcp_list, log_scan, discovery, hooks_discovery}, diagnostics: {hooks_loaded, workspace_dirs, gemini_dir_lines,
 * negative_login_lines: {advisory: true, count, lines, note}, cli_log}}. `auth` keeps {argv, exit_code, killed_for,
 * envelope, groups, num_turns, total_tokens, stderr} (redacted; never stdout); `lane_quota` {model, quota_scope: {model,
 * groups, state, buckets}}; `agents` {argv, exit_code, killed_for, bad_flag, stdout, stderr} (strongly redacted);
 * `mcp_list` {argv, exit_code, killed_for, bad_flag, servers, line_count, stderr_line_count, credential_redacted: true}
 * and never its output. `model` (optional): the lane whose group is scoped (without one: the Gemini group, recorded
 * only). `jail` (optional) a prepareWorkerJail() result; without one a jail is built and its state dropped afterwards.
 */
/**
 * The log_scan reason for read-only-file-system lines, naming the refused paths (the first five, then how many more), or
 * the first such line when it names no path. E.g. `read_only (a write was refused under a read-only mount: <path>)`.
 */
export function readOnlyWhy(ev) {
  const paths = ev.erofs_paths ?? [];
  if (!paths.length) return `read_only (a write was refused under a read-only mount: ${JSON.stringify(String(ev.erofs_lines?.[0] ?? "").slice(0, 300))})`;
  return `read_only (a write was refused under a read-only mount: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` and ${paths.length - 5} more` : ""})`;
}

export async function runAgyPreflight({ cli, control_dir, worktree, env: extraEnv = {}, base_env = null, sandbox = {}, a2a_socket = null, jail = null, timeoutS = 60, agent = WORKER_AGENT, server = MCP_SERVER_NAME, model = null }) {
  const env = workerEnv(extraEnv, base_env);
  const own = !jail;
  const j = jail ?? await prepareWorkerJail({ cli, control_dir, worktree, env, sandbox, a2a_socket });
  const red = t => redactStrong(t, env);
  const checks = {};
  let diagnostics = { hooks_loaded: null, workspace_dirs: null, gemini_dir_lines: [], negative_login_lines: { advisory: true, count: 0, lines: [], note: NEGATIVE_LOGIN_NOTE }, cli_log: null };
  try {
    const cardText = await readFile(join(control_dir, ".agents", "agents", agent, "agent.md"), "utf8").catch(() => null);
    const tools = cardText == null ? null : cardTools(cardText);
    const v = validateCardTools(tools);
    checks.card_tools = { ok: v.ok, why: v.why, tools, bad: v.bad };
    const logDir = cliLogDirOf(j.gstate, env.HOME);
    const budget = { left: CLI_LOG_CAP_BYTES };
    const logFiles = [];
    let logDirText = "", logTruncated = false;
    // NO --log-file and NO --add-dir: both subcommands reject them (observed, agy 1.5.10, 2026-11-18).
    const runSub = async args => {
      const before = await snapshotCliLog(logDir);
      const argv = j.prefix.length ? [...j.prefix.slice(1), cli, ...args] : args;
      const r = await spawnPromise(j.prefix.length ? j.prefix[0] : cli, argv, { cwd: control_dir, env, timeout: timeoutS * 1000 })
        .catch(e => ({ status: null, stdout: "", stderr: `spawn failed: ${e?.code ?? e?.message ?? e}`, killedFor: null }));
      const log = await readNewCliLogs(logDir, before, { env, budget });
      logFiles.push(...log.files.map(f => ({ ...f, command: args.join(" ") })));
      logDirText += log.text; logTruncated ||= log.truncated;
      const stdout = String(r.stdout ?? ""), stderr = String(r.stderr ?? "");
      return { argv: [cli, ...args], exit_code: r.status, killed_for: r.killedFor ?? null, bad_flag: AGY_BAD_FLAG.test(`${stdout}\n${stderr}`), raw: { stdout, stderr }, log };
    };
    const word = name => new RegExp(`(^|[^A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`, "m");
    // AUTH: in-jail /usage (no model; observed to spend zero tokens and to return quota groups only when logged in).
    const u = await runSub([...USAGE_ARGS]);
    const envelope = usageEnvelopeOf(u.raw.stdout);
    const logged_in = !u.killed_for && usageHasBuckets(envelope);
    checks.auth = { ok: logged_in, source: "agy --print /usage --output-format json, in the jail",
      why: logged_in ? null : u.killed_for ? `/usage was stopped (${u.killed_for})` : !envelope ? `/usage did not print the JSON envelope (exit ${u.exit_code})` : "/usage returned no quota group with buckets: the CLI has no usable session in the jail",
      argv: u.argv, exit_code: u.exit_code, killed_for: u.killed_for, envelope: envelope ? envelope.format : null,
      groups: envelope ? [...new Set((envelope.buckets ?? []).map(b => b.group))] : null,
      num_turns: envelope?.spent?.num_turns ?? null, total_tokens: envelope?.spent?.total_tokens ?? null, stderr: red(u.raw.stderr).slice(-4000) };
    const base = model ? String(model).replace(/-(low|medium|high|xhigh|max)$/, "") : null;
    const scoped = envelope ? (base ? scopeQuota(envelope, base) : { state: (envelope.buckets ?? []).filter(b => /gemini/i.test(b.group ?? "")).some(b => b.exhausted) ? "exhausted" : "unscoped", buckets: (envelope.buckets ?? []).filter(b => /gemini/i.test(b.group ?? "")) }) : null;
    const quota_scope = scoped ? { model: base, groups: [...new Set((scoped.buckets ?? []).map(b => b.group))], state: scoped.state,
      buckets: (scoped.buckets ?? []).map(b => ({ group: b.group ?? null, name: b.name ?? null, window: b.window ?? null, remaining_fraction: b.remaining_fraction ?? null, exhausted: Boolean(b.exhausted) })) } : null;
    const exhausted = quota_scope?.state === "exhausted";
    checks.lane_quota = { ok: !exhausted, model, quota_scope,
      why: exhausted ? `the quota of ${base ? `${model}'s group` : "the Gemini group"} (${quota_scope.groups.join(", ") || "?"}) is exhausted` : null,
      note: !quota_scope ? "no envelope: see auth" : quota_scope.state === "unknown" ? "no group of the envelope serves this lane: not blocking" : null };
    const a = await runSub(["agents"]);
    checks.agents = { ok: a.exit_code === 0 && !a.bad_flag && !a.killed_for,
      why: a.exit_code !== 0 || a.killed_for ? `agy agents exited ${a.exit_code ?? a.killed_for}${a.bad_flag ? " (it refused a flag)" : ""}` : a.bad_flag ? "agy agents refused a flag" : null,
      argv: a.argv, exit_code: a.exit_code, killed_for: a.killed_for, bad_flag: a.bad_flag, stdout: red(a.raw.stdout), stderr: red(a.raw.stderr) };
    const m = await runSub(["mcp", "list"]);
    const parsed = mcpServerNames(m.raw.stdout);
    const mBad = lines(`${m.raw.stdout}\n${m.raw.stderr}\n${m.log.text}`).filter(l => l.includes(server) && /\b(fail(ed|ure)?|error|unavailable|disconnected)\b/i.test(l));
    checks.mcp_list = { ok: m.exit_code === 0 && !m.bad_flag && !m.killed_for && !mBad.length,
      why: m.exit_code !== 0 || m.killed_for ? `agy mcp list exited ${m.exit_code ?? m.killed_for}` : m.bad_flag ? "agy mcp list refused a flag" : mBad.length ? `a line naming ${server} reports a failure` : null,
      argv: m.argv, exit_code: m.exit_code, killed_for: m.killed_for, bad_flag: m.bad_flag, servers: parsed.servers, line_count: parsed.line_count,
      stderr_line_count: lines(m.raw.stderr).length, credential_redacted: true };
    const runs = [u, a, m];
    const ev = cliLogEvidence({ stdout: runs.map(x => x.raw.stdout).join("\n"), stderr: runs.map(x => x.raw.stderr).join("\n"), log_dir: logDirText }, env);
    const found = { read_only: ev.erofs_lines.slice(0, 30), unknown_component: ev.unknown_component, not_in_registry: ev.not_in_registry, deprecated: ev.deprecated };
    const hits = Object.entries(found).filter(([, x]) => x.length).map(([k]) => k);
    checks.log_scan = { ok: !hits.length, why: hits.length ? `found: ${hits.map(k => (k === "read_only" ? readOnlyWhy(ev) : k)).join(", ")}` : null, lines: found, ...(found.read_only.length ? { read_only_paths: ev.erofs_paths } : {}), log_text: logDirText.slice(-8000) };
    const agent_listed = word(agent).test(a.raw.stdout), server_listed = (parsed.servers ?? []).includes(server);
    checks.discovery = { ok: agent_listed && server_listed, agent_listed, server_listed,
      note: "advisory: `agy agents` and `agy mcp list` take no --add-dir and were observed (agy 1.5.10, 2026-11-18) to list the global configuration only; the turn's --add-dir workspace is what counts" };
    const hooks = parseHooksLoaded(`${red(runs.map(x => `${x.raw.stdout}\n${x.raw.stderr}`).join("\n"))}\n${logDirText}`);
    checks.hooks_discovery = hooks ? { ok: hooks.files > 0, seen: true, named: hooks.named, files: hooks.files, lines: hooks.lines, sources: ev.hooks_loaded?.sources ?? [],
      why: hooks.files > 0 ? null : "the CLI loaded hooks from 0 hooks.json files: the workspace's .agents/hooks.json was not discovered by these subcommands" }
      : { ok: true, seen: false, named: null, files: null, lines: [], sources: [], why: null };
    const { negative_login_lines, gemini_dir_lines, ...cliRest } = ev;
    diagnostics = { hooks_loaded: hooks ? { named: hooks.named, files: hooks.files } : null, workspace_dirs: ev.workspace_dirs, gemini_dir_lines,
      negative_login_lines: { advisory: true, count: lines(`${red(runs.map(x => `${x.raw.stdout}\n${x.raw.stderr}`).join("\n"))}\n${logDirText}`).filter(l => AGY_NOT_LOGGED_IN.test(l)).length, lines: negative_login_lines, note: NEGATIVE_LOGIN_NOTE },
      cli_log: { dir: logDir, files: logFiles, truncated: logTruncated, ...cliRest } };
  } finally {
    if (own) await dropGeminiState(j.gstate).catch(() => null);
  }
  const failed = PREFLIGHT_BLOCKING.filter(k => checks[k] && !checks[k].ok);
  const warnings = PREFLIGHT_ADVISORY.filter(k => checks[k] && !checks[k].ok);
  return { ok: !failed.length, failed, warnings, blocking: [...PREFLIGHT_BLOCKING], advisory: [...PREFLIGHT_ADVISORY], checks, diagnostics };
}

/**
 * A worker turn's CLI log evidence: the NEW files of the CLI's log dir (readNewCliLogs) and the --log-file, with stderr,
 * through cliLogEvidence. Returns {dir, files, truncated, log_file, received_by: {log_dir, log_file, stderr} (line
 * counts), tail (the redacted log-dir text, last 4000 chars), ...cliLogEvidence}.
 */
async function turnCliLog({ logDir, before, log_file, stderr, env }) {
  const log = await readNewCliLogs(logDir, before, { env });
  const fileText = await readFile(log_file, "utf8").catch(() => "");
  const ev = cliLogEvidence({ stderr, log_file: fileText.slice(-CLI_LOG_CAP_BYTES), log_dir: log.text }, env);
  return { dir: logDir, files: log.files, truncated: log.truncated, log_file,
    received_by: { log_dir: ev.log_sources.file_lines, log_file: ev.log_sources.log_file_lines, stderr: ev.log_sources.stderr_lines },
    ...ev, tail: log.text.slice(-4000) };
}

/**
 * One headless worker turn. `sandbox` {enabled = true, agy_state_dirs, allowUnsandboxed = false, bwrap = "bwrap",
 * extra_ro = [], gemini_state = "scratch" | "rw" | "off", home (default: the child env's HOME), keep_gemini_scratch};
 * `a2a_socket` (optional) the unit's A2A socket path, whose directory is bound read-only when it is not under the
 * control dir; the process is killed after timeoutS + graceS seconds. Returns {text, structured_output, summary,
 * response_id, usage, num_turns, status, tool_calls, subagent_calls, tools, tool_steps, served_model,
 * served_model_source: "input", jail_log, launch, cleanup_env, sandbox, gemini_scratch, cli_log, exit_code, stderr_tail}.
 * `cli_log` (turnCliLog): what the CLI wrote to its log dir during the turn and to the --log-file, parsed (hooks loaded,
 * workspaceDirs, EROFS paths, unknown/registry/deprecated lines, negative-login lines, GeminiDir lines).
 * `tool_steps` is EVERY stream-json step_update with step_type "tool" ({tool_name, state, tool_info}), whatever its
 * state; a thrown failure carries the same evidence fields. `jail` (optional): a prepareWorkerJail() result to run in
 * (then `gemini_scratch` is null: the caller owns and drops the state).
 */
export async function runAgyWorkerTurn({ cli, control_dir, worktree, model, prompt, timeoutS = 1800, graceS = 15, env: extraEnv = {}, base_env = null, signal = undefined,
  sandbox = {}, onEvent = () => {}, a2a_socket = null, jail = null, agent = WORKER_AGENT, conversation = null }) {
  if (!cli || !control_dir || !worktree || !model || typeof prompt !== "string") throw Object.assign(new Error("runAgyWorkerTurn: pass cli, control_dir, worktree, model and prompt"), { code: "BAD_INPUT" });
  const cardPath = join(control_dir, ".agents", "agents", agent, "agent.md");
  if (!existsSync(cardPath)) throw Object.assign(new Error(`agy worker: role card ${cardPath} missing (prepareWorkerWorkspace first)`), { code: "NO_WORKSPACE" });
  if (cli.includes("/") && !existsSync(cli)) throw laneFailure("spawn", `agy CLI absent at ${cli}`);

  // THE JAIL: bwrap, or a refusal. Never a silent unjailed run. A caller that already built one (the probe's preflight
  // ran in it) passes it as `jail` and drops its state itself.
  // THE ARGUMENTS FIRST, THE JAIL AFTER (independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6),
  // question 7): the scratch copy of the OAuth token used to be made before workerArgv could refuse an argument, outside
  // any cleanup. Now a refused argument creates nothing, and every later failure drops the scratch (the finally below).
  const log_file = join(control_dir, "run", "agy.log");
  const args = workerArgv({ model, worktree, prompt, timeoutS, log_file, agent, conversation });
  const { env, dropped: envDropped } = workerEnvOf(extraEnv, base_env);
  // Every value a record must never carry: the secret-named env of the caller and the control dir's MCP env (the A2A token).
  const secrets = secretValues({ ...process.env, ...(base_env ?? {}), ...(extraEnv ?? {}) }, controlDirSecrets(control_dir));
  const ownJail = !jail;
  const { prefix, sandboxRec, gstate } = jail ?? await prepareWorkerJail({ cli, control_dir, worktree, env, sandbox, a2a_socket });
  let stateDropped = false, droppedState = null;
  const dropState = async () => {
    if (!ownJail || stateDropped) return droppedState;
    stateDropped = true;
    droppedState = await dropGeminiState(gstate, { keep: sandbox.keep_gemini_scratch === true })
      .catch(e => ({ removed: false, removal_error: { code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 300) } }));
    return droppedState;
  };
  try {
    return await workerTurnIn({ cli, control_dir, model, prompt, timeoutS, graceS, extraEnv, signal, onEvent, agent, log_file, args, env, envDropped, secrets, prefix, sandboxRec, gstate, dropState });
  } finally {
    await dropState();
  }
}

/** The rest of runAgyWorkerTurn, inside its jail (the caller drops the state on every path). */
async function workerTurnIn({ cli, control_dir, model, prompt, timeoutS, graceS, extraEnv, signal, onEvent, agent, log_file, args, env, envDropped, secrets, prefix, sandboxRec, gstate, dropState }) {
  const cmd = prefix.length ? prefix[0] : cli;
  const argv = assertWorkerArgv(prefix.length ? [...prefix.slice(1), cli, ...args] : args);
  const launch = { cmd, args: argv.map(a => (a === prompt ? "<prompt>" : a)), cwd: control_dir, log_file,
    env_added: { ...(extraEnv ?? {}), [AGY_CLEANUP.name]: AGY_CLEANUP.value, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    // The names (never the values) of what the allowlist left out of the CLI's env: secret-named extras, the Google
    // keys, and every variable of the base env that is not on the allowlist (env_dropped_count).
    env_stripped: [...new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY", ...envDropped.filter(k => Object.prototype.hasOwnProperty.call(extraEnv ?? {}, k) || ENV_SECRETISH.test(k))])].sort(),
    env_dropped_count: envDropped.length, env_policy: "allowlist" };
  for (const k of launch.env_stripped) delete launch.env_added[k];
  for (const k of Object.keys(launch.env_added)) if (SECRETISH.test(k)) launch.env_added[k] = "<redacted>";

  let init = null, conversationId = null, result = null, sawResult = false, unparseable = 0, toolCalls = 0, subagentCalls = 0, answerChars = 0;
  const tools = [], tool_steps = [];
  const report = ev => { try { onEvent(ev); } catch { /* telemetry is not the turn's authority */ } };
  const onStdoutLine = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { unparseable++; return; }
    if (typeof event.conversation_id === "string" && event.conversation_id) conversationId = event.conversation_id;
    if (event.event === "init") {
      init = event.init;
      report({ event: "seat.start", detail: `OAuth CLI worker ${init?.agent ?? "unknown"}, model ${init?.model ?? "unknown"}` });
    } else if (event.event === "step_update") {
      const step = event.step_update;
      if (step?.step_type === "tool") tool_steps.push(toolStepOf(step));
      if (step?.step_type === "tool" && step.state === "DONE") {
        toolCalls++;
        tools.push(step.tool_name ?? "unknown");
        if (isSubagentStep(toolStepOf(step))) subagentCalls++;
        report({ event: "seat.tool", detail: step.tool_name ?? "unknown" });
      }
      if (step?.text_delta) {
        answerChars += step.text_delta.length;
        if (answerChars % 1000 < step.text_delta.length) report({ event: "seat.progress", detail: `${answerChars} response chars` });
      }
    } else if (event.event === "result") {
      result = event.result; sawResult = true;
    }
  };

  // The CLI's own log dir (the scratch's antigravity-cli/log/): snapshot now, read what this turn added before the
  // scratch is dropped (see readNewCliLogs). The --log-file is read too; cli_log says which of them got the lines.
  const logDir = cliLogDirOf(gstate, env.HOME);
  const logBefore = await snapshotCliLog(logDir);
  let run;
  try {
    run = await spawnPromise(cmd, argv, { cwd: control_dir, env, timeout: (timeoutS + graceS) * 1000, onStdoutLine, ...(signal ? { signal } : {}) });
  } catch (e) {
    await dropState();
    if (e?.name === "AbortError" || signal?.aborted) throw Object.assign(new Error("agy worker turn was cancelled"), { code: "ABORTED" });
    throw laneFailure("spawn", `agy worker could not be started (${e?.code ?? e?.message ?? e})`, { launch, sandbox: sandboxRec, tool_steps: redactDeep(tool_steps, secrets) });
  }
  // REDACTED before any record keeps them (independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6),
  // question 7): the hook log, the tool steps' tool_info, the stderr tail, the CLI's error, the answer and its summary.
  const jail_log = redactDeep(await readJailLog(control_dir), secrets);
  const stderr = String(run.stderr ?? "");
  const cli_log = await turnCliLog({ logDir, before: logBefore, log_file, stderr: redactExact(stderr, secrets), env });
  const gemini_scratch = await dropState();
  const more = { launch, sandbox: sandboxRec, jail_log, cleanup_env: AGY_CLEANUP, tool_steps: redactDeep(tool_steps, secrets), gemini_scratch, cli_log, exit_code: run.status,
    stderr_tail: redactStrong(redactExact(stderr.slice(-4000), secrets)),
    result_status: result?.status ?? null, num_turns: result?.num_turns ?? null, usage: result?.usage ?? null,
    conversation_id: (typeof result?.conversation_id === "string" && result.conversation_id) || conversationId };
  if (run.killedFor === "cancelled") throw Object.assign(new Error("agy worker turn was cancelled"), { code: "ABORTED", ...more });
  if (run.killedFor === "timeout") throw laneFailure("timeout", `agy CLI timed out after ${timeoutS}s (process killed)`, more);
  if (run.killedFor) throw laneFailure("stream", `agy CLI stopped: ${run.killedFor}`, more);
  if (prefix.length && run.status !== 0 && /^bwrap: /m.test(stderr) && !init) throw laneFailure("spawn", `the sandbox could not start the agy CLI: ${stderr.trim().slice(0, 300)}`, more);
  const failed = run.status !== 0 || (sawResult && result?.status !== "SUCCESS");
  if (failed) {
    const q = quotaEvidence({ result, stderr });
    if (q) throw Object.assign(new Error(`agy CLI exited ${run.status}; status ${result?.status ?? "missing"}: Antigravity refused for quota ("${q.matched}")`),
      { status: 429, code: "quota_exhausted", quota: q, transport: "agy-cli", result_error: redactExact(typeof result?.error === "string" ? result.error.slice(0, 500) : result?.error?.message ?? "", secrets) || null, ...more });
    const errText = `${stderr}\n${typeof result?.error === "string" ? result.error : result?.error?.message ?? ""}\n${result?.status ?? ""}`;
    if (TIMEOUT_TEXT.test(errText)) throw laneFailure("timeout", `agy CLI exited ${run.status}; status ${result?.status ?? "missing"}: print timeout`, more);
    if (run.status !== 0) throw laneFailure("exit", `agy CLI exited ${run.status}; status ${result?.status ?? "missing"} (inspect local CLI diagnostics)`, { ...more, result_error: redactExact(typeof result?.error === "string" ? result.error.slice(0, 500) : result?.error?.message ?? "", secrets) || null });
  }
  if (!sawResult) throw laneFailure("stream", `agy CLI stream ended without a result event${unparseable ? ` (${unparseable} unparseable line(s))` : ""}`, more);
  if (init?.agent !== agent || init?.model !== model) {
    throw laneFailure("stream", `agy CLI identity mismatch: expected ${agent}/${model}, got ${init?.agent ?? "none"}/${init?.model ?? "none"}`, { detail: "identity", ...more });
  }
  if (result?.status !== "SUCCESS") throw laneFailure("exit", `agy CLI status ${result?.status ?? "missing"}${BAD_STATUS.has(result?.status) ? "" : " (unrecognised)"}`, more);
  // The answer and its JSON summary: only the exact known secrets are replaced (a model's prose is not pattern-guessed).
  const text = typeof result.response === "string" ? redactExact(result.response.trim(), secrets) : "";
  const structured = result.structured_output === undefined ? undefined : redactDeep(result.structured_output, secrets, { exact: true });
  if (!Number.isInteger(result.num_turns) || result.num_turns < 1 || (!text && !structured)) {
    throw laneFailure("exit", "agy CLI returned no completed model turn (empty response)", more);
  }
  return { text, structured_output: structured ?? null, summary: redactDeep(summaryOf(text), secrets, { exact: true }), response_id: result.conversation_id ?? null, status: result.status,
    tool_calls: toolCalls, subagent_calls: subagentCalls, tools, served_model: model, served_model_source: "input", ...more };
}
