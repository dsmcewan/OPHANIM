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
import { readFile } from "node:fs/promises";
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
      const b = bwrapArgs({ worktree, control_dir, agy_state_dirs: sandbox.agy_state_dirs ?? defaultAgyStateDirs(), extra_ro: extra_ro.filter(p => existsSync(p)), gemini_state: gstate, bwrap: sandbox.bwrap ?? "bwrap" });
      return { prefix: b.argv, gstate, sandboxRec: { enabled: true, kind: "bwrap", binds: b.binds, git: b.git,
        gemini_state: { enabled: gstate.enabled, mode: gstate.mode, gemini_dir: gstate.gemini_dir, cli_dir: gstate.cli_dir, mounts: gstate.mounts, copied: gstate.copied,
          skipped: gstate.skipped, hidden_state: gstate.hidden_state, readonly_subdirs: gstate.readonly_subdirs, ...(gstate.why ? { why: gstate.why } : {}) } } };
    }
    if (sandbox.allowUnsandboxed === true) return { prefix: [], gstate: null, sandboxRec: { enabled: false, reason: probe.why, allowUnsandboxed: true } };
    throw Object.assign(new Error(`agy worker: the bwrap sandbox is unavailable (${probe.why}); refusing to run the worker unjailed (pass sandbox.allowUnsandboxed: true to override)`), { code: "SANDBOX_UNAVAILABLE" });
  }
  if (sandbox.allowUnsandboxed === true) return { prefix: [], gstate: null, sandboxRec: { enabled: false, reason: "sandbox.enabled is false", allowUnsandboxed: true } };
  throw Object.assign(new Error("agy worker: sandbox.enabled is false and allowUnsandboxed is not true; refusing to run the worker unjailed"), { code: "SANDBOX_UNAVAILABLE" });
}

// ---- THE ZERO-SPEND PREFLIGHT: what the CLI itself says about the workspace, before any model turn ------------------
// `agy agents` and `agy mcp list` start no model turn. Observed on agy 1.5.10 (owner's probe 2026-11-18): a card tool
// the CLI does not know ("unknown component: tool \"call_mcp_tool\" not found in registry") and state writes that hit a
// read-only file system were visible only in the --log-file, after a 5-minute hung turn. The preflight runs both
// commands in the SAME jail, control dir and workspace as the turn, with a --log-file (a global flag in agy's top-level
// help; if a subcommand refuses it the command is re-run without, and the record says so), and fails on:
//   card_tools  the control dir's card lists a name in AGY_1_5_10_UNKNOWN_OR_DEPRECATED (validateCardTools)
//   agents      exit != 0, `pantheon-unit-worker` not present as a word, or an unknown-component / not-in-registry /
//               error line in its output
//   mcp_list    exit != 0, `pantheon-subagents` not present, or a line naming it that says it failed
//   log_scan    a `read-only file system`, `unknown component`, `not found in registry` or `deprecated` line in the
//               preflight's --log-file or in either command's output
// The output formats are NOT known: matching is conservative and the raw text (secret-redacted) is recorded so the
// owner can paste it back as a fixture.
export const PREFLIGHT_LOG_PATTERNS = Object.freeze({ read_only: /read-only file system|EROFS/i, unknown_component: /unknown component/i,
  not_in_registry: /not found in registry/i, deprecated: /deprecated/i });
const ERROR_LINE = /\b(error|fatal|panic)\b|^E\d{4}\s/i;
const BAD_FLAG = /unknown (flag|shorthand flag)|flag provided but not defined|unrecognized (option|argument)|unexpected argument/i;
const lines = t => String(t ?? "").split("\n").map(l => l.trimEnd()).filter(Boolean);
/** Redact every value of a secret-looking env variable (8+ chars) from `text`. */
export function redactSecrets(text, env = {}) {
  let out = String(text ?? "");
  for (const [k, v] of Object.entries(env ?? {})) if (SECRETISH.test(k) && typeof v === "string" && v.length >= 8) out = out.split(v).join(`<redacted:${k}>`);
  return out;
}
/**
 * Run the zero-spend preflight (above). Returns {ok, failed: [check names], checks: {card_tools, agents, mcp_list,
 * log_scan}, log_file}. Each command check: {ok, why, argv, log_file_accepted, exit_code, stdout, stderr} (redacted).
 * `jail` (optional) a prepareWorkerJail() result; without one a jail is built and its state dropped afterwards.
 */
export async function runAgyPreflight({ cli, control_dir, worktree, env: extraEnv = {}, sandbox = {}, a2a_socket = null, jail = null, timeoutS = 60, agent = WORKER_AGENT, server = MCP_SERVER_NAME }) {
  const env = workerEnv(extraEnv);
  const own = !jail;
  const j = jail ?? await prepareWorkerJail({ cli, control_dir, worktree, env, sandbox, a2a_socket });
  const log_file = join(control_dir, "run", "agy-preflight.log");
  const red = t => redactSecrets(t, env);
  const checks = {};
  try {
    const cardText = await readFile(join(control_dir, ".agents", "agents", agent, "agent.md"), "utf8").catch(() => null);
    const tools = cardText == null ? null : cardTools(cardText);
    const v = validateCardTools(tools);
    checks.card_tools = { ok: v.ok, why: v.why, tools, bad: v.bad };
    const runSub = async sub => {
      const withLog = [...sub, "--log-file", log_file];
      const go = async args => {
        const argv = j.prefix.length ? [...j.prefix.slice(1), cli, ...args] : args;
        const r = await spawnPromise(j.prefix.length ? j.prefix[0] : cli, argv, { cwd: control_dir, env, timeout: timeoutS * 1000 }).catch(e => ({ status: null, stdout: "", stderr: `spawn failed: ${e?.code ?? e?.message ?? e}`, killedFor: null }));
        return { args, r };
      };
      let { args, r } = await go(withLog);
      let accepted = true;
      if (r.status !== 0 && BAD_FLAG.test(`${r.stdout}\n${r.stderr}`)) { accepted = false; ({ args, r } = await go(sub)); }
      return { argv: [cli, ...args], log_file_accepted: accepted, exit_code: r.status, killed_for: r.killedFor ?? null, stdout: red(r.stdout), stderr: red(r.stderr) };
    };
    const word = name => new RegExp(`(^|[^A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`, "m");
    const a = await runSub(["agents"]);
    const aText = `${a.stdout}\n${a.stderr}`;
    const aBad = lines(aText).filter(l => PREFLIGHT_LOG_PATTERNS.unknown_component.test(l) || PREFLIGHT_LOG_PATTERNS.not_in_registry.test(l) || ERROR_LINE.test(l));
    checks.agents = { ok: a.exit_code === 0 && word(agent).test(a.stdout) && !aBad.length,
      why: a.exit_code !== 0 ? `agy agents exited ${a.exit_code ?? a.killed_for}` : !word(agent).test(a.stdout) ? `${agent} is not listed` : aBad.length ? `error lines: ${aBad.slice(0, 3).join(" | ")}` : null, ...a };
    const m = await runSub(["mcp", "list"]);
    const mText = `${m.stdout}\n${m.stderr}`;
    const mBad = lines(mText).filter(l => l.includes(server) && /\b(fail(ed|ure)?|error|unavailable|disconnected)\b/i.test(l));
    checks.mcp_list = { ok: m.exit_code === 0 && word(server).test(m.stdout) && !mBad.length,
      why: m.exit_code !== 0 ? `agy mcp list exited ${m.exit_code ?? m.killed_for}` : !word(server).test(m.stdout) ? `${server} is not listed` : mBad.length ? `the server reports: ${mBad.slice(0, 3).join(" | ")}` : null, ...m };
    const logText = red(await readFile(log_file, "utf8").catch(() => ""));
    const found = {};
    for (const [k, re] of Object.entries(PREFLIGHT_LOG_PATTERNS)) found[k] = [...new Set(lines(`${logText}\n${aText}\n${mText}`).filter(l => re.test(l)))].slice(0, 30);
    const hits = Object.entries(found).filter(([, v]) => v.length).map(([k]) => k);
    checks.log_scan = { ok: !hits.length, why: hits.length ? `found: ${hits.join(", ")}` : null, lines: found, log_text: logText.slice(-8000) };
  } finally {
    if (own) await dropGeminiState(j.gstate).catch(() => null);
  }
  const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k);
  return { ok: !failed.length, failed, checks, log_file };
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
