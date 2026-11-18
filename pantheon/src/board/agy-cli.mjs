// The board's Antigravity turn uses the operator's CLI OAuth session. The SDK lane is a separate
// API-key transport and cannot consume an OAuth refresh token renamed to GEMINI_API_KEY.
import { spawnPromise } from "./spawn.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { quotaEvidence } from "../agy/quota.mjs";

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
// ENV: process.env minus GEMINI_API_KEY / GOOGLE_API_KEY, plus `env`, plus ANTIGRAVITY_AGY_CLEANUP=all.
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
import { readdir, readFile } from "node:fs/promises";
import { homedir as homeOf } from "node:os";
import { dirname as dirOf, isAbsolute, relative as relOf, resolve as resolveOf } from "node:path";
import { bwrapArgs, sandboxAvailable, defaultAgyStateDirs, cliDirOf, geminiState, dropGeminiState } from "../agy/sandbox.mjs";
import { cardTools, validateCardTools } from "../agy/workspace.mjs";
import { MCP_SERVER as MCP_SERVER_NAME } from "../agy/jail-hook.mjs";

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
export function workerArgv({ model, worktree, prompt, timeoutS, log_file = null, control_dir = null }) {
  if (typeof worktree !== "string" || !isAbsolute(worktree)) throw Object.assign(new Error(`agy worker: --add-dir must be an absolute worktree path, not ${JSON.stringify(worktree)}`), { code: "BAD_INPUT" });
  const log = log_file ?? (control_dir ? join(control_dir, "run", "agy.log") : null);
  if (log !== null && !isAbsolute(log)) throw Object.assign(new Error(`agy worker: --log-file must be absolute, not ${JSON.stringify(log)}`), { code: "BAD_INPUT" });
  // --disable-slash-commands ("Disable slash command and skill expansion in print mode", agy 1.5.10 --help): the prompt
  // carries plan and repository text, which must never expand into a slash command or a skill.
  return assertWorkerArgv(["--agent", WORKER_AGENT, "--model", model, "--mode=accept-edits", "--add-dir", worktree,
    "--disable-slash-commands", "--output-format", "stream-json", "--print-timeout", `${timeoutS}s`, ...(log ? ["--log-file", log] : []), "--print", prompt]);
}
export function workerEnv(extra = {}) {
  // AGY_CLI_DISABLE_AUTO_UPDATE (documented: troubleshooting page): no self-update in the middle of a unit.
  const env = { ...process.env, ...(extra ?? {}), [AGY_CLEANUP.name]: AGY_CLEANUP.value, AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  return env;
}
// An env variable whose value a record never carries (the A2A token, any key or secret).
export const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
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

// ---- THE ZERO-SPEND PREFLIGHT: what the CLI itself says about the workspace, before any model turn ------------------
// `agy agents` and `agy mcp list` start no model turn. They run in the SAME jail, control dir and workspace as the turn.
// What was observed (agy 1.5.10, owner's machine; probe of 5893432, 2026-11-18; zero model turns):
//   - observed: both subcommands REJECT `--log-file` (exit 1, stderr ending exactly
//     "Error: flags provided but not defined: -log-file" after their usage text). So the preflight passes NO
//     --log-file to them (the earlier preflight did, and its BAD_FLAG matcher only knew the singular "flag provided",
//     so the no-flag retry never ran). AGY_BAD_FLAG still recognises a flag refusal, as a blocking `agents` failure.
//   - observed: without --log-file, `agy agents` exited 0 with EMPTY stdout and "You are not logged into Antigravity."
//     on stderr, plus read-only-file-system failures writing ~/.gemini/antigravity-cli/log/... and
//     ~/.gemini/config/projects/default-cli-project.json.<rand>.tmp (src/agy/sandbox.mjs now makes both writable), and
//     a message about a relative GeminiDir setting (exact text not yet available: captured as diagnostics). Exit 0 is
//     therefore NOT evidence of a usable session.
//   - observed: `agy mcp list` exited 0 and listed only a GLOBAL server, not the workspace's pantheon-subagents, and
//     printed that server's configured credential. These subcommands take no --add-dir, so their listings show the
//     global configuration only: DISCOVERY IS ADVISORY. The mcp list output is NEVER stored: only the server names
//     (first token of each entry line) and `credential_redacted: true`.
// BLOCKING checks (in `failed` when not ok; the turn must not start):
//   card_tools  the control dir's card lists a name in AGY_1_5_10_UNKNOWN_OR_DEPRECATED (validateCardTools)
//   agents      `agy agents` exited non-zero, was killed, or refused a flag
//   auth        either command's stdout/stderr says the CLI is not logged in (whatever the exit code)
//   log_scan    a `read-only file system` / EROFS, `unknown component`, `not found in registry` or `deprecated` line in
//               either command's output or in what the CLI wrote to its log dir (the scratch's antigravity-cli/log/)
// ADVISORY checks (recorded, in `warnings` when not ok, never blocking):
//   mcp_list    `agy mcp list` exited non-zero, refused a flag, or a line naming the server says it failed
//   discovery   {agent_listed, server_listed, note}: whether the listings name pantheon-unit-worker / pantheon-subagents
//   hooks_discovery  {seen, named, files, lines}: the CLI's "loaded N named hooks from M hooks.json file(s)" line;
//               M == 0 is a warning (observed 2026-11-18: 0 files with <ctl>/.agents/hooks.json present; whether a
//               --print run with --add-dir behaves differently is not known), surfaced in `warnings`
// The "Failed to resolve GeminiDir ".gemini": ... falling back to default" line (observed, benign: the CLI then uses
// ~/.gemini/antigravity-cli) is recorded under `diagnostics.gemini_dir_lines`, never blocking.
// Every stored output is redacted with redactStrong.
export const PREFLIGHT_LOG_PATTERNS = Object.freeze({ read_only: /read-only file system|EROFS/i, unknown_component: /unknown component/i,
  not_in_registry: /not found in registry/i, deprecated: /deprecated/i });
/** A CLI refusing a flag (observed on agy 1.5.10: "Error: flags provided but not defined: -log-file"). */
export const AGY_BAD_FLAG = /unknown (shorthand )?flag|flags? provided but not defined|unrecognized (option|argument)|unexpected argument/i;
/**
 * The CLI saying it has no session. Observed on agy 1.5.10 (2026-11-18, `agy agents` in the jail): "error getting token
 * source: You are not logged into Antigravity.", "doRefreshQuota: skipped (not logged in)", and "Auth mode is
 * unspecified, skipping fetchAvailableModels and returning empty response".
 */
export const AGY_NOT_LOGGED_IN = /not logged in(to)?\b|You are not logged into Antigravity|Auth mode is unspecified/i;
/**
 * The CLI's hook discovery line, observed on agy 1.5.10 (2026-11-18): "hooks_manager.go:54] loaded 0 named hooks from 0
 * hooks.json file(s)" (with <ctl>/.agents/hooks.json present). Returns {named, files, lines} for the LAST such line of
 * `text` (lines: every such line, up to 10), or null when none is seen.
 */
export function parseHooksLoaded(text) {
  const found = String(text ?? "").split("\n").filter(l => HOOKS_LOADED.test(l));
  if (!found.length) return null;
  const m = HOOKS_LOADED.exec(found.at(-1));
  return { named: Number(m[1]), files: Number(m[2]), lines: found.slice(-10).map(l => l.trim().slice(0, 300)) };
}
const HOOKS_LOADED = /loaded (\d+) named hooks? from (\d+) hooks\.json file/i;
const GEMINI_DIR_LINE = /GeminiDir/i;
export const PREFLIGHT_BLOCKING = Object.freeze(["card_tools", "agents", "auth", "log_scan"]);
export const PREFLIGHT_ADVISORY = Object.freeze(["mcp_list", "discovery", "hooks_discovery"]);
const lines = t => String(t ?? "").split("\n").map(l => l.trimEnd()).filter(Boolean);
/** Redact every value of a secret-looking env variable (8+ chars) from `text`. */
export function redactSecrets(text, env = {}) {
  let out = String(text ?? "");
  for (const [k, v] of Object.entries(env ?? {})) if (SECRETISH.test(k) && typeof v === "string" && v.length >= 8) out = out.split(v).join(`<redacted:${k}>`);
  return out;
}
const LONG_RUN = /[A-Za-z0-9_\-.=+/]{24,}/g;
/**
 * STRONG redaction for any CLI output a record keeps: the env-derived secrets (redactSecrets), `Bearer <x>`,
 * `authorization|api_key|token|secret|password <: or => <x>`, `--header <x>`, and every run of 24+ characters of
 * [A-Za-z0-9_-.=+/]. ONE NARROWING (a choice, so the EROFS and GeminiDir diagnostics keep their paths): a run that
 * starts with "/" is an absolute path; in it only 24+ runs of [A-Za-z0-9+=] (no separator: a token, not a file name)
 * are redacted.
 */
export function redactStrong(text, env = {}) {
  let out = redactSecrets(text, env);
  out = out.replace(/\bBearer\s+\S+/gi, "Bearer <redacted>");
  out = out.replace(/(?<![A-Za-z0-9_-])(authorization|api[_-]?key|token|secret|password)(\s*[:=]\s*)(?!<redacted)\S+/gi, "$1$2<redacted>");
  out = out.replace(/--header(\s+|=)\S+/g, "--header$1<redacted>");
  out = out.replace(LONG_RUN, run => (run.startsWith("/") ? run.replace(/[A-Za-z0-9+=]{24,}/g, "<redacted>") : "<redacted>"));
  return out;
}
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
/**
 * Run the zero-spend preflight (above). Returns {ok, failed: [blocking check names not ok], warnings: [advisory check
 * names not ok], blocking: PREFLIGHT_BLOCKING, advisory: PREFLIGHT_ADVISORY, checks: {card_tools, agents, mcp_list,
 * auth, log_scan, discovery, hooks_discovery}, diagnostics: {hooks_loaded: {named, files} | null, gemini_dir_lines, auth_lines}}. `agents` keeps {argv, exit_code, killed_for,
 * bad_flag, stdout, stderr} (strongly redacted); `mcp_list` keeps {argv, exit_code, killed_for, bad_flag, servers,
 * line_count, stderr_line_count, credential_redacted: true} and never its output.
 * `jail` (optional) a prepareWorkerJail() result; without one a jail is built and its state dropped afterwards.
 */
export async function runAgyPreflight({ cli, control_dir, worktree, env: extraEnv = {}, sandbox = {}, a2a_socket = null, jail = null, timeoutS = 60, agent = WORKER_AGENT, server = MCP_SERVER_NAME }) {
  const env = workerEnv(extraEnv);
  const own = !jail;
  const j = jail ?? await prepareWorkerJail({ cli, control_dir, worktree, env, sandbox, a2a_socket });
  const red = t => redactStrong(t, env);
  const checks = {};
  let diagnostics = { hooks_loaded: null, gemini_dir_lines: [], auth_lines: [] };
  try {
    const cardText = await readFile(join(control_dir, ".agents", "agents", agent, "agent.md"), "utf8").catch(() => null);
    const tools = cardText == null ? null : cardTools(cardText);
    const v = validateCardTools(tools);
    checks.card_tools = { ok: v.ok, why: v.why, tools, bad: v.bad };
    // NO --log-file: both subcommands reject it (observed, agy 1.5.10, 2026-11-18).
    const runSub = async args => {
      const argv = j.prefix.length ? [...j.prefix.slice(1), cli, ...args] : args;
      const r = await spawnPromise(j.prefix.length ? j.prefix[0] : cli, argv, { cwd: control_dir, env, timeout: timeoutS * 1000 })
        .catch(e => ({ status: null, stdout: "", stderr: `spawn failed: ${e?.code ?? e?.message ?? e}`, killedFor: null }));
      const stdout = String(r.stdout ?? ""), stderr = String(r.stderr ?? "");
      return { argv: [cli, ...args], exit_code: r.status, killed_for: r.killedFor ?? null, bad_flag: AGY_BAD_FLAG.test(`${stdout}\n${stderr}`), raw: { stdout, stderr } };
    };
    const word = name => new RegExp(`(^|[^A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`, "m");
    const a = await runSub(["agents"]);
    checks.agents = { ok: a.exit_code === 0 && !a.bad_flag && !a.killed_for,
      why: a.exit_code !== 0 || a.killed_for ? `agy agents exited ${a.exit_code ?? a.killed_for}${a.bad_flag ? " (it refused a flag)" : ""}` : a.bad_flag ? "agy agents refused a flag" : null,
      argv: a.argv, exit_code: a.exit_code, killed_for: a.killed_for, bad_flag: a.bad_flag, stdout: red(a.raw.stdout), stderr: red(a.raw.stderr) };
    const m = await runSub(["mcp", "list"]);
    const parsed = mcpServerNames(m.raw.stdout);
    const mBad = lines(`${m.raw.stdout}\n${m.raw.stderr}`).filter(l => l.includes(server) && /\b(fail(ed|ure)?|error|unavailable|disconnected)\b/i.test(l));
    checks.mcp_list = { ok: m.exit_code === 0 && !m.bad_flag && !m.killed_for && !mBad.length,
      why: m.exit_code !== 0 || m.killed_for ? `agy mcp list exited ${m.exit_code ?? m.killed_for}` : m.bad_flag ? "agy mcp list refused a flag" : mBad.length ? `a line naming ${server} reports a failure` : null,
      argv: m.argv, exit_code: m.exit_code, killed_for: m.killed_for, bad_flag: m.bad_flag, servers: parsed.servers, line_count: parsed.line_count,
      stderr_line_count: lines(m.raw.stderr).length, credential_redacted: true };
    const allText = `${a.raw.stdout}\n${a.raw.stderr}\n${m.raw.stdout}\n${m.raw.stderr}`;
    const authLines = [...new Set(lines(allText).filter(l => AGY_NOT_LOGGED_IN.test(l)).map(red))].slice(0, 10);
    checks.auth = { ok: !authLines.length, why: authLines.length ? "the CLI says it is not logged in (exit 0 is not evidence of a usable session)" : null, lines: authLines };
    // What the CLI wrote to its own log dir (in the per-run scratch: antigravity-cli/log/ is a state subdir).
    let logText = "";
    const logDir = j.gstate?.scratch_cli ? join(j.gstate.scratch_cli, "log") : null;
    if (logDir) for (const f of (await readdir(logDir, { recursive: true }).catch(() => [])).sort()) logText += await readFile(join(logDir, f), "utf8").catch(() => "");
    const scanned = `${allText}\n${logText}`;
    const found = {};
    for (const [k, re] of Object.entries(PREFLIGHT_LOG_PATTERNS)) found[k] = [...new Set(lines(scanned).filter(l => re.test(l)).map(red))].slice(0, 30);
    const hits = Object.entries(found).filter(([, x]) => x.length).map(([k]) => k);
    checks.log_scan = { ok: !hits.length, why: hits.length ? `found: ${hits.join(", ")}` : null, lines: found, log_text: red(logText.slice(-8000)) };
    const agent_listed = word(agent).test(a.raw.stdout), server_listed = (parsed.servers ?? []).includes(server);
    checks.discovery = { ok: agent_listed && server_listed, agent_listed, server_listed,
      note: "advisory: `agy agents` and `agy mcp list` take no --add-dir and were observed (agy 1.5.10, 2026-11-18) to list the global configuration only; the turn's --add-dir workspace is what counts" };
    const hooks = parseHooksLoaded(scanned);
    checks.hooks_discovery = hooks ? { ok: hooks.files > 0, seen: true, named: hooks.named, files: hooks.files, lines: hooks.lines.map(red),
      why: hooks.files > 0 ? null : "the CLI loaded hooks from 0 hooks.json files: the workspace's .agents/hooks.json was not discovered by these subcommands" }
      : { ok: true, seen: false, named: null, files: null, lines: [], why: null };
    diagnostics = { hooks_loaded: hooks ? { named: hooks.named, files: hooks.files } : null, gemini_dir_lines: [...new Set(lines(scanned).filter(l => GEMINI_DIR_LINE.test(l)).map(red))].slice(0, 20), auth_lines: authLines };
  } finally {
    if (own) await dropGeminiState(j.gstate).catch(() => null);
  }
  const failed = PREFLIGHT_BLOCKING.filter(k => checks[k] && !checks[k].ok);
  const warnings = PREFLIGHT_ADVISORY.filter(k => checks[k] && !checks[k].ok);
  return { ok: !failed.length, failed, warnings, blocking: [...PREFLIGHT_BLOCKING], advisory: [...PREFLIGHT_ADVISORY], checks, diagnostics };
}

/**
 * One headless worker turn. `sandbox` {enabled = true, agy_state_dirs, allowUnsandboxed = false, bwrap = "bwrap",
 * extra_ro = [], gemini_state = "scratch" | "rw" | "off", home (default: the child env's HOME), keep_gemini_scratch};
 * `a2a_socket` (optional) the unit's A2A socket path, whose directory is bound read-only when it is not under the
 * control dir; the process is killed after timeoutS + graceS seconds. Returns {text, structured_output, summary,
 * response_id, usage, num_turns, status, tool_calls, subagent_calls, tools, tool_steps, served_model,
 * served_model_source: "input", jail_log, launch, cleanup_env, sandbox, gemini_scratch, exit_code, stderr_tail}.
 * `tool_steps` is EVERY stream-json step_update with step_type "tool" ({tool_name, state, tool_info}), whatever its
 * state; a thrown failure carries the same evidence fields. `jail` (optional): a prepareWorkerJail() result to run in
 * (then `gemini_scratch` is null: the caller owns and drops the state).
 */
export async function runAgyWorkerTurn({ cli, control_dir, worktree, model, prompt, timeoutS = 1800, graceS = 15, env: extraEnv = {}, signal = undefined,
  sandbox = {}, onEvent = () => {}, a2a_socket = null, jail = null }) {
  if (!cli || !control_dir || !worktree || !model || typeof prompt !== "string") throw Object.assign(new Error("runAgyWorkerTurn: pass cli, control_dir, worktree, model and prompt"), { code: "BAD_INPUT" });
  const cardPath = join(control_dir, ".agents", "agents", WORKER_AGENT, "agent.md");
  if (!existsSync(cardPath)) throw Object.assign(new Error(`agy worker: role card ${cardPath} missing (prepareWorkerWorkspace first)`), { code: "NO_WORKSPACE" });
  if (cli.includes("/") && !existsSync(cli)) throw laneFailure("spawn", `agy CLI absent at ${cli}`);

  // THE JAIL: bwrap, or a refusal. Never a silent unjailed run. A caller that already built one (the probe's preflight
  // ran in it) passes it as `jail` and drops its state itself.
  const env = workerEnv(extraEnv);
  const ownJail = !jail;
  const { prefix, sandboxRec, gstate } = jail ?? await prepareWorkerJail({ cli, control_dir, worktree, env, sandbox, a2a_socket });
  const dropState = () => (ownJail ? dropGeminiState(gstate, { keep: sandbox.keep_gemini_scratch === true }).catch(() => null) : Promise.resolve(null));

  const log_file = join(control_dir, "run", "agy.log");
  const args = workerArgv({ model, worktree, prompt, timeoutS, log_file });
  const cmd = prefix.length ? prefix[0] : cli;
  const argv = assertWorkerArgv(prefix.length ? [...prefix.slice(1), cli, ...args] : args);
  const launch = { cmd, args: argv.map(a => (a === prompt ? "<prompt>" : a)), cwd: control_dir, log_file,
    env_added: { ...(extraEnv ?? {}), [AGY_CLEANUP.name]: AGY_CLEANUP.value, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    env_stripped: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] };
  for (const k of launch.env_stripped) delete launch.env_added[k];
  for (const k of Object.keys(launch.env_added)) if (SECRETISH.test(k)) launch.env_added[k] = "<redacted>";

  let init = null, result = null, sawResult = false, unparseable = 0, toolCalls = 0, subagentCalls = 0, answerChars = 0;
  const tools = [], tool_steps = [];
  const report = ev => { try { onEvent(ev); } catch { /* telemetry is not the turn's authority */ } };
  const onStdoutLine = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { unparseable++; return; }
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

  let run;
  try {
    run = await spawnPromise(cmd, argv, { cwd: control_dir, env, timeout: (timeoutS + graceS) * 1000, onStdoutLine, ...(signal ? { signal } : {}) });
  } catch (e) {
    await dropState();
    if (e?.name === "AbortError" || signal?.aborted) throw Object.assign(new Error("agy worker turn was cancelled"), { code: "ABORTED" });
    throw laneFailure("spawn", `agy worker could not be started (${e?.code ?? e?.message ?? e})`, { launch, sandbox: sandboxRec, tool_steps });
  }
  const jail_log = await readJailLog(control_dir);
  const gemini_scratch = await dropState();
  const stderr = String(run.stderr ?? "");
  const more = { launch, sandbox: sandboxRec, jail_log, cleanup_env: AGY_CLEANUP, tool_steps, gemini_scratch, exit_code: run.status, stderr_tail: stderr.slice(-4000),
    result_status: result?.status ?? null, num_turns: result?.num_turns ?? null, usage: result?.usage ?? null };
  if (run.killedFor === "cancelled") throw Object.assign(new Error("agy worker turn was cancelled"), { code: "ABORTED", ...more });
  if (run.killedFor === "timeout") throw laneFailure("timeout", `agy CLI timed out after ${timeoutS}s (process killed)`, more);
  if (run.killedFor) throw laneFailure("stream", `agy CLI stopped: ${run.killedFor}`, more);
  if (prefix.length && run.status !== 0 && /^bwrap: /m.test(stderr) && !init) throw laneFailure("spawn", `the sandbox could not start the agy CLI: ${stderr.trim().slice(0, 300)}`, more);
  const failed = run.status !== 0 || (sawResult && result?.status !== "SUCCESS");
  if (failed) {
    const q = quotaEvidence({ result, stderr });
    if (q) throw Object.assign(new Error(`agy CLI exited ${run.status}; status ${result?.status ?? "missing"}: Antigravity refused for quota ("${q.matched}")`),
      { status: 429, code: "quota_exhausted", quota: q, transport: "agy-cli", result_error: typeof result?.error === "string" ? result.error.slice(0, 500) : result?.error?.message ?? null, ...more });
    const errText = `${stderr}\n${typeof result?.error === "string" ? result.error : result?.error?.message ?? ""}\n${result?.status ?? ""}`;
    if (TIMEOUT_TEXT.test(errText)) throw laneFailure("timeout", `agy CLI exited ${run.status}; status ${result?.status ?? "missing"}: print timeout`, more);
    if (run.status !== 0) throw laneFailure("exit", `agy CLI exited ${run.status}; status ${result?.status ?? "missing"} (inspect local CLI diagnostics)`, { ...more, result_error: typeof result?.error === "string" ? result.error.slice(0, 500) : result?.error?.message ?? null });
  }
  if (!sawResult) throw laneFailure("stream", `agy CLI stream ended without a result event${unparseable ? ` (${unparseable} unparseable line(s))` : ""}`, more);
  if (init?.agent !== WORKER_AGENT || init?.model !== model) {
    throw laneFailure("stream", `agy CLI identity mismatch: expected ${WORKER_AGENT}/${model}, got ${init?.agent ?? "none"}/${init?.model ?? "none"}`, { detail: "identity", ...more });
  }
  if (result?.status !== "SUCCESS") throw laneFailure("exit", `agy CLI status ${result?.status ?? "missing"}${BAD_STATUS.has(result?.status) ? "" : " (unrecognised)"}`, more);
  const text = typeof result.response === "string" ? result.response.trim() : "";
  const structured = result.structured_output;
  if (!Number.isInteger(result.num_turns) || result.num_turns < 1 || (!text && !structured)) {
    throw laneFailure("exit", "agy CLI returned no completed model turn (empty response)", more);
  }
  return { text, structured_output: structured ?? null, summary: summaryOf(text), response_id: result.conversation_id ?? null, status: result.status,
    tool_calls: toolCalls, subagent_calls: subagentCalls, tools, served_model: model, served_model_source: "input", ...more };
}
