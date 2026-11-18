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
//   agy --agent pantheon-unit-worker --model <lane> --mode=accept-edits --add-dir <worktree>
//       --output-format stream-json --print-timeout <n>s --print <prompt>
//
// cwd = the unit's control dir (src/agy/workspace.mjs wrote the role card, hooks.json, mcp_config.json and jail.json
// there); the worktree is added to the workspace with --add-dir. `--mode=accept-edits` (documented: "Automatically
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
import { dirname as dirOf, relative as relOf, resolve as resolveOf } from "node:path";
import { bwrapArgs, sandboxAvailable, defaultAgyStateDirs, cliDirOf } from "../agy/sandbox.mjs";

export const WORKER_AGENT = "pantheon-unit-worker";
export const AGY_CLEANUP = Object.freeze({ name: "ANTIGRAVITY_AGY_CLEANUP", value: "all", documented: false,
  note: "owner-specified (2026-11-18); not documented in Antigravity's CLI docs" });

export function workerArgv({ model, worktree, prompt, timeoutS }) {
  // --disable-slash-commands ("Disable slash command and skill expansion in print mode", agy 1.5.10 --help): the prompt
  // carries plan and repository text, which must never expand into a slash command or a skill.
  return ["--agent", WORKER_AGENT, "--model", model, "--mode=accept-edits", "--add-dir", worktree,
    "--disable-slash-commands", "--output-format", "stream-json", "--print-timeout", `${timeoutS}s`, "--print", prompt];
}
export function workerEnv(extra = {}) {
  // AGY_CLI_DISABLE_AUTO_UPDATE (documented: troubleshooting page): no self-update in the middle of a unit.
  const env = { ...process.env, ...(extra ?? {}), [AGY_CLEANUP.name]: AGY_CLEANUP.value, AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  return env;
}
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

/**
 * One headless worker turn. `sandbox` {enabled = true, agy_state_dirs, allowUnsandboxed = false, bwrap = "bwrap",
 * extra_ro = []}; `a2a_socket` (optional) the unit's A2A socket path, whose directory is bound read-only when it is
 * not under the control dir; the process is killed after timeoutS + graceS seconds. Returns {text, structured_output, summary, response_id, usage, tool_calls, subagent_calls,
 * tools, served_model, served_model_source: "input", jail_log, launch, cleanup_env, sandbox}.
 */
export async function runAgyWorkerTurn({ cli, control_dir, worktree, model, prompt, timeoutS = 1800, graceS = 15, env: extraEnv = {}, signal = undefined,
  sandbox = {}, onEvent = () => {}, a2a_socket = null }) {
  if (!cli || !control_dir || !worktree || !model || typeof prompt !== "string") throw Object.assign(new Error("runAgyWorkerTurn: pass cli, control_dir, worktree, model and prompt"), { code: "BAD_INPUT" });
  const cardPath = join(control_dir, ".agents", "agents", WORKER_AGENT, "agent.md");
  if (!existsSync(cardPath)) throw Object.assign(new Error(`agy worker: role card ${cardPath} missing (prepareWorkerWorkspace first)`), { code: "NO_WORKSPACE" });
  if (cli.includes("/") && !existsSync(cli)) throw laneFailure("spawn", `agy CLI absent at ${cli}`);

  // THE JAIL: bwrap, or a refusal. Never a silent unjailed run.
  const wantSandbox = sandbox.enabled !== false;
  let prefix = [], sandboxRec;
  if (wantSandbox) {
    const probe = await sandboxAvailable(sandbox.bwrap ?? "bwrap");
    if (probe.ok) {
      const extra_ro = [...(sandbox.extra_ro ?? [])];
      const cliDir = cliDirOf(cli); if (cliDir) extra_ro.push(cliDir);
      // The A2A socket: a socket under the control dir is already visible (its read-only bind; connect() needs no
      // write access to the mount); one elsewhere (e.g. a short fallback under /tmp, which is a fresh tmpfs inside)
      // gets its directory bound read-only.
      if (a2a_socket) { const d = dirOf(resolveOf(a2a_socket)); const r = relOf(resolveOf(control_dir), d); if (r.startsWith("..") || resolveOf(r) === r) extra_ro.push(d); }
      const b = bwrapArgs({ worktree, control_dir, agy_state_dirs: sandbox.agy_state_dirs ?? defaultAgyStateDirs(), extra_ro: extra_ro.filter(p => existsSync(p)), bwrap: sandbox.bwrap ?? "bwrap" });
      prefix = b.argv;
      sandboxRec = { enabled: true, kind: "bwrap", binds: b.binds, git: b.git };
    } else if (sandbox.allowUnsandboxed === true) {
      sandboxRec = { enabled: false, reason: probe.why, allowUnsandboxed: true };
    } else {
      throw Object.assign(new Error(`agy worker: the bwrap sandbox is unavailable (${probe.why}); refusing to run the worker unjailed (pass sandbox.allowUnsandboxed: true to override)`), { code: "SANDBOX_UNAVAILABLE" });
    }
  } else if (sandbox.allowUnsandboxed === true) {
    sandboxRec = { enabled: false, reason: "sandbox.enabled is false", allowUnsandboxed: true };
  } else {
    throw Object.assign(new Error("agy worker: sandbox.enabled is false and allowUnsandboxed is not true; refusing to run the worker unjailed"), { code: "SANDBOX_UNAVAILABLE" });
  }

  const args = workerArgv({ model, worktree, prompt, timeoutS });
  const cmd = prefix.length ? prefix[0] : cli;
  const argv = prefix.length ? [...prefix.slice(1), cli, ...args] : args;
  const env = workerEnv(extraEnv);
  const launch = { cmd, args: argv.map(a => (a === prompt ? "<prompt>" : a)), cwd: control_dir, env_added: { [AGY_CLEANUP.name]: AGY_CLEANUP.value },
    env_stripped: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] };

  let init = null, result = null, sawResult = false, unparseable = 0, toolCalls = 0, subagentCalls = 0, answerChars = 0;
  const tools = [];
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
      if (step?.step_type === "tool" && step.state === "DONE") {
        toolCalls++;
        tools.push(step.tool_name ?? "unknown");
        if (step.tool_name === "invoke_subagent" || /ask_subagent$/.test(step.tool_name ?? "")) subagentCalls++;
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
    if (e?.name === "AbortError" || signal?.aborted) throw Object.assign(new Error("agy worker turn was cancelled"), { code: "ABORTED" });
    throw laneFailure("spawn", `agy worker could not be started (${e?.code ?? e?.message ?? e})`, { launch, sandbox: sandboxRec });
  }
  const jail_log = await readJailLog(control_dir);
  const more = { launch, sandbox: sandboxRec, jail_log, cleanup_env: AGY_CLEANUP };
  const stderr = String(run.stderr ?? "");
  if (run.killedFor === "cancelled") throw Object.assign(new Error("agy worker turn was cancelled"), { code: "ABORTED", ...more });
  if (run.killedFor === "timeout") throw laneFailure("timeout", `agy CLI timed out after ${timeoutS}s (process killed)`, more);
  if (run.killedFor) throw laneFailure("stream", `agy CLI stopped: ${run.killedFor}`, more);
  if (prefix.length && run.status !== 0 && /^bwrap: /m.test(stderr) && !init) throw laneFailure("spawn", `the sandbox could not start the agy CLI: ${stderr.trim().slice(0, 300)}`, more);
  const failed = run.status !== 0 || (sawResult && result?.status !== "SUCCESS");
  if (failed) {
    const q = quotaEvidence({ result, stderr });
    if (q) throw Object.assign(new Error(`agy CLI exited ${run.status}; status ${result?.status ?? "missing"}: Antigravity refused for quota ("${q.matched}")`),
      { status: 429, code: "quota_exhausted", quota: q, transport: "agy-cli", stderr_tail: stderr.slice(-500), result_error: typeof result?.error === "string" ? result.error.slice(0, 500) : result?.error?.message ?? null, ...more });
    const errText = `${stderr}\n${typeof result?.error === "string" ? result.error : result?.error?.message ?? ""}\n${result?.status ?? ""}`;
    if (TIMEOUT_TEXT.test(errText)) throw laneFailure("timeout", `agy CLI exited ${run.status}; status ${result?.status ?? "missing"}: print timeout`, more);
    if (run.status !== 0) throw laneFailure("exit", `agy CLI exited ${run.status}; status ${result?.status ?? "missing"} (inspect local CLI diagnostics)`, { exit_code: run.status, ...more });
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
  return { text, structured_output: structured ?? null, summary: summaryOf(text), response_id: result.conversation_id ?? null, usage: result.usage ?? null,
    tool_calls: toolCalls, subagent_calls: subagentCalls, tools, served_model: model, served_model_source: "input", ...more };
}
