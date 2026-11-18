#!/usr/bin/env node
// ONE-TURN LIVE PROBE of the jailed Antigravity unit worker, run on the owner's machine:
//
//   node pantheon/scripts/agy-worker-probe.mjs [--cli <path>] [--timeout <seconds, default 180>] [--card <agent.md>] [--keep]
//
// It spends AT MOST ONE cheap model turn (lane gemini-3.8-flash-low), on the Antigravity subscription only, and
// CONFIRMS or REFUTES the OWNER-STATED Antigravity CLI mechanics (2026-11-18; not in the docs we read) the worker is
// built on:
//   1. add_dir_workspace          headless `agy -p` with `--add-dir <abs worktree>` adopts the workspace and loads
//                                 .agents/hooks.json and .agents/mcp_config.json; never --dangerously-skip-permissions
//                                 (it skips PreToolUse hooks) and never --sandbox inside bwrap
//   2. hooks_json_shape           {"<hook name>": {"PreToolUse": [{matcher, hooks: [{type, command, timeout}]}]}}, BOM-free,
//                                 absolute command; hook commands run with cwd = .agents/
//   3. mcp_lazy_call_mcp_tool     MCP tools are lazy via the built-in call_mcp_tool {ServerName, ToolName, Arguments};
//                                 `tools.<t>.eager = true` loads one directly. (Observed on agy 1.5.10, owner's probe
//                                 2026-11-18: "unknown component: tool \"call_mcp_tool\" not found in registry" when the
//                                 card listed it; the card no longer does, so only the eager form is expected.)
//   4. hook_decision_semantics    exit codes ignored; empty stdout allows; {} denies; headless accept-edits soft-denies
//                                 Ask-tier tools unless the hook says auto_approve
//   5. state_mounts               ~/.gemini read-only + a per-run scratch copy of ~/.gemini/antigravity-cli is enough
//                                 for a turn. (Observed on agy 1.5.10, owner's probe 2026-11-18: the CLI writes under
//                                 antigravity-cli/, not antigravity/; the old conversations/ + mcp/ binds left every
//                                 write EROFS and the turn hung to its print timeout.) "confirmed" = the writes landed
//                                 in the scratch; "refuted" = EROFS under a protected path (the paths are listed).
//
// What it does: locate agy (as agy-smoke.mjs does), record `agy --version` and the binary's sha256; read the lane's
// quota with the free probe (`agy --print /usage`) and ABORT WITH ZERO SPEND (exit 2) unless the lane's Gemini group
// reads `available`; build a disposable temp git repo + worktree (outside any checkout) with owned_paths
// ["allowed/**"] and verify_cmd `node -e "process.exit(0)"`, start the REAL A2A shim (Unix socket, token, role
// probe-helper) with a MOCK subagent answer (no Grok, no API), prepare the workspace with the real
// prepareWorkerWorkspace, build the real jail once (prepareWorkerJail) and run in it, BEFORE any model turn, the
// zero-spend PREFLIGHT (runAgyPreflight: the card's tool list, `agy agents`, `agy mcp list` -- WITHOUT --log-file,
// which both reject (observed, agy 1.5.10, 2026-11-18) -- the login, and a scan of their output and of the CLI's log
// dir); if a BLOCKING check fails it ABORTS (exit 2, spent nothing) with the redacted outputs under `preflight` (never
// the raw `agy mcp list` output, which was observed to print a credential: only its server names). Discovery (are the
// worker and the MCP server listed?) is ADVISORY: those subcommands were observed to list global configuration only.
// Every check the run did not exercise is null, not false. Then it runs
// the real runAgyWorkerTurn inside the same jail (refusing to run unsandboxed), --print-timeout 180s by default.
// The prompt asks for four steps in order: (1) write forbidden.txt (outside owned_paths: must be denied); (2) write
// allowed/probe.txt = "probe-ok"; (3) ask_subagent once (maybe through call_mcp_tool); (4) run the verify command.
// Then it verifies from disk and prints ONE JSON object (schema pantheon.agy-worker-probe/v1) and exits 0 when every
// check passed, 1 otherwise, 2 when it aborted before spending. Diagnostics: `startup_errors` (E-level and read-only
// file system lines of the CLI log and stderr up to the first tool step, de-duplicated, at most 60), `deprecations`,
// `stderr_tail`, `log_tail`, `gemini_state.scratch_written` (what the CLI wrote into the scratch copy),
// `gemini_state.copied` / `withheld` / `writable_copies` (what the scratch was given and what was kept from it), and
// `diagnostics` {gemini_dir_lines, auth_lines}: every redacted line naming GeminiDir or saying "not logged in", from
// the preflight and the turn (to diagnose the auth failure observed on 2026-11-18), and `hooks_loaded` {preflight,
// turn}: {named, files} parsed from the CLI's "loaded N named hooks from M hooks.json file(s)" line (null: not seen;
// observed 2026-11-18: 0 files from `agy agents` with <ctl>/.agents/hooks.json present).
// THE SCRATCH HOLDS A COPY OF THE OAuth TOKEN: it is always removed unless --keep, and then the summary says
// `kept_contains_credentials: true`.
//
// Metered API failover is STRICTLY disabled: this script imports no API client and never calls one (runAgyWorkerTurn
// has no failover; the pipeline's turns.mjs, which has, is not used). It never prints the A2A token or credentials:
// the token is redacted everywhere, and any env value whose name contains KEY/TOKEN/SECRET.
// Async spawn only. Temp dirs are removed unless --keep.
import { createReadStream, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPromise } from "../src/board/spawn.mjs";
import { probeQuota, minimalEnv } from "../src/agy/quota.mjs";
import { dropGeminiState, GEMINI_CLI_DIR, sandboxAvailable } from "../src/agy/sandbox.mjs";
import { prepareWorkerWorkspace } from "../src/agy/workspace.mjs";
import { HARD_DENY, MCP_SERVER, MCP_TOOL, WRITE_TOOLS } from "../src/agy/jail-hook.mjs";
import { AGY_NOT_LOGGED_IN, parseHooksLoaded, prepareWorkerJail, redactStrong, runAgyPreflight, runAgyWorkerTurn, SECRETISH, workerEnv } from "../src/board/agy-cli.mjs";
import { startA2AShim } from "../src/pipeline/a2a-shim.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = join(HERE, "..", "src", "pipeline", "a2a-mcp-server.mjs");
const LANES = join(HERE, "..", "src", "config", "lanes.json");
export const SCHEMA = "pantheon.agy-worker-probe/v1";
export const LANE = "gemini-3.8-flash-low";
export const ROLE = "probe-helper";
export const VERIFY = 'node -e "process.exit(0)"';
export const QUESTION = "Reply with the word PROBE-ANSWER.";
export const MOCK_ANSWER = "PROBE-ANSWER (mock subagent: no model was called)";
const UNIT = "probe";
const BAD_STATE = /ERROR|FAIL|DENIED|CANCEL|REJECT/i;

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? null : null; };
const keep = argv.includes("--keep");
export const DEFAULT_TIMEOUT_S = 180;
const timeoutS = Number(opt("--timeout") ?? DEFAULT_TIMEOUT_S);
const cardOpt = opt("--card");

async function onPath(name) {
  for (const d of String(process.env.PATH ?? "").split(":").filter(Boolean)) if (existsSync(join(d, name))) return join(d, name);
  return null;
}
const sha256File = p => new Promise((resolve) => {
  const h = createHash("sha256");
  createReadStream(p).on("data", c => h.update(c)).on("end", () => resolve("sha256:" + h.digest("hex"))).on("error", () => resolve(null));
});
const tail = (s, n = 2000) => (typeof s === "string" ? s.slice(-n) : null);
const quotaView = q => q && { state: q.state, scope: q.scope ? { model: q.scope.model, groups: q.scope.groups, all_state: q.scope.all_state } : null,
  buckets: (q.buckets ?? []).map(b => ({ group: b.group ?? null, name: b.name ?? null, window: b.window ?? null, remaining_fraction: b.remaining_fraction ?? null, exhausted: b.exhausted })),
  exit_code: q.exit_code ?? null, format: q.format ?? null, spent: q.spent ?? null, error: q.error ?? null };

/** A recursive listing {relative path: "size:mtimeMs"} of a directory (null when it does not exist). Never follows a symlink. */
function snapshot(dir) {
  try { if (!statSync(dir).isDirectory()) return null; } catch { return null; }
  const out = {};
  const walk = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = pre ? `${pre}/${e.name}` : e.name; const p = join(d, e.name); if (e.isDirectory()) walk(p, r); else { try { const st = lstatSync(p); out[r] = `${st.size}:${st.mtimeMs}`; } catch { out[r] = "unreadable"; } } } };
  walk(dir, "");
  return out;
}
/** The top level of ~/.gemini (every entry: files as size:mtime, others by kind), to see an OAuth refresh, any other rewrite, or a created entry. */
function topFiles(dir) {
  try { return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).map(e => { const st = lstatSync(join(dir, e.name)); return [e.name, e.isFile() ? `${st.size}:${st.mtimeMs}` : e.isDirectory() ? "dir" : "other"]; })); } catch { return null; }
}
// A CLI log line's identity for de-duplication: without the glog prefix, uuids and long hex/numeric ids.
const lineKey = l => l.replace(/^[IWEF]\d{4} [\d:.]+\s+\d+ [^\]]*\]\s*/, "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>").replace(/\b[0-9a-f]{12,}\b|\b\d{3,}\b/gi, "<n>").trim();
const dedupe = (ls, max) => { const seen = new Set(), out = []; for (const l of ls) { const k = lineKey(l); if (!k || seen.has(k)) continue; seen.add(k); out.push(l.slice(0, 500)); if (out.length >= max) break; } return out; };
const ERROR_LEVEL = /^E\d{4}\s|\blevel=error\b|^\s*(error|fatal|panic)\b|read-only file system|EROFS/i;
const TOOL_MARK = /\b(PreToolUse|toolCall|tool_call|step_update)\b/;
/**
 * The CLI's start-up errors: E-level and read-only file system lines of the log (then stderr) up to the first tool step
 * (a log line marking a tool call) or the end; de-duplicated, at most 60.
 */
export function startupErrors({ logText = "", stderrText = "", toolSteps = 0 }) {
  const pick = text => { const out = []; for (const l of String(text).split("\n")) { if (toolSteps > 0 && TOOL_MARK.test(l)) break; if (ERROR_LEVEL.test(l)) out.push(l.trimEnd()); } return out; };
  return dedupe([...pick(logText), ...pick(stderrText)], 60);
}
export const deprecationsOf = ({ logText = "", stderrText = "" }) => dedupe(`${logText}\n${stderrText}`.split("\n").filter(l => /deprecated/i.test(l)).map(l => l.trimEnd()), 30);
const same = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
const untouched = (before, after) => (before && after ? same(before.cli_state, after.cli_state) && same(before.config_projects, after.config_projects) && JSON.stringify(before.top) === JSON.stringify(after.top) : null);
/** The redacted lines of `text` naming GeminiDir / saying "not logged in" (de-duplicated). */
export function diagnosticLines(text, env = {}) {
  const ls = String(text ?? "").split("\n").map(l => l.trimEnd()).filter(Boolean);
  const pick = re => [...new Set(ls.filter(l => re.test(l)).map(l => redactStrong(l, env).slice(0, 500)))].slice(0, 20);
  return { gemini_dir_lines: pick(/GeminiDir/i), auth_lines: pick(AGY_NOT_LOGGED_IN) };
}
const mergeDiag = (a, b) => ({ hooks_loaded: a?.hooks_loaded ?? { preflight: null, turn: null }, gemini_dir_lines: [...new Set([...(a?.gemini_dir_lines ?? []), ...(b?.gemini_dir_lines ?? [])])], auth_lines: [...new Set([...(a?.auth_lines ?? []), ...(b?.auth_lines ?? [])])] });
/** What the summary says about the state layout given to the CLI: copied, withheld (name + size only), writable copies. */
const layoutView = gs => (gs ? { copied: gs.copied ?? [], withheld: gs.withheld ?? [], writable_copies: (gs.writable_copies ?? []).map(w => ({ path: w.path, dest: w.dest, status: w.status, ...(w.copied ? { copied: w.copied } : {}), ...(w.why ? { why: w.why } : {}) })) } : { copied: [], withheld: [], writable_copies: [] });

export function probePrompt(wt) {
  return [
    `ROLE: probe worker — the single implementer of work unit "${UNIT}" (difficulty: trivial). This is a test. Do these four steps IN ORDER, each exactly once, then stop:`,
    `1. Use write_to_file to create ${wt}/forbidden.txt with the content: forbidden`,
    "   It is outside your owned paths and WILL be refused. That is expected. Do not retry it, do not work around it.",
    `2. Use write_to_file to create ${wt}/allowed/probe.txt with exactly this content: probe-ok`,
    `3. Call the tool ${MCP_TOOL} (provided by the MCP server ${MCP_SERVER}) once with {"role": "${ROLE}", "question": "${QUESTION}"}.`,
    `4. Use run_command to run exactly this command with Cwd ${wt}: ${VERIFY}`,
    "Then finish with the JSON summary your instructions describe.",
    "",
    "PATHS YOU OWN (the only paths you may create, change or delete):",
    "- allowed/**",
    "Do not commit, do not move HEAD.",
    "",
    "GROUND TRUTH: the controller will run this command in your worktree after you finish; its exit code decides, not your report:",
    `  ${VERIFY}`,
    "Run it yourself before you stop.",
  ].join("\n");
}

const mechanic = (status, evidence) => ({ status, evidence });

function judge({ rows, steps, shimCalls, checks, turnRan, turnOk, launchArgs, agentsDir, mcpConfig, scratch, stderrText, logText, hookPaths }) {
  const m = {};
  const hooksLoaded = rows.length > 0;
  const mcpSteps = steps.filter(s => s.tool_name === "call_mcp_tool" || /ask_subagent/.test(s.tool_name ?? ""));
  const mcpLoaded = shimCalls.length > 0 || mcpSteps.length > 0;
  const i = launchArgs.indexOf("--add-dir");
  const addDir = i >= 0 ? launchArgs[i + 1] : null;
  const ev1 = { add_dir: addDir, add_dir_absolute: typeof addDir === "string" && addDir.startsWith("/"), forbidden_flags_absent: !launchArgs.some(a => /^--(sandbox|dangerously-skip-permissions)(=|$)/.test(a)),
    hook_invocations: rows.length, mcp_reached: mcpLoaded, tool_steps: steps.length };
  m.add_dir_workspace = !turnRan ? mechanic("not exercised", { ...ev1, note: "the turn did not run" })
    : hooksLoaded && mcpLoaded ? mechanic("confirmed", { ...ev1, note: "the hooks of .agents/hooks.json ran and the MCP server of .agents/mcp_config.json was reached, with --add-dir passed (whether it is REQUIRED was not tested: the probe never runs without it)" })
    : steps.length > 0 && !hooksLoaded ? mechanic("refuted", { ...ev1, note: "tools ran but the PreToolUse hook never did: the workspace's hooks.json was not loaded" })
    : mechanic("not exercised", { ...ev1, note: hooksLoaded ? "hooks loaded; the MCP server was never reached" : "no tool ran" });

  const cwds = [...new Set(rows.map(r => r.cwd))];
  const ev2 = { hook_command: hookPaths.command, hook_invocations: rows.length, hook_cwds: cwds, expected_cwd: agentsDir };
  m.hooks_json_shape = !hooksLoaded ? (steps.length > 0 ? mechanic("refuted", { ...ev2, note: "tools ran without the hook: this hooks.json shape was not read" }) : mechanic("not exercised", { ...ev2, note: "no tool call reached a hook" }))
    : cwds.every(c => c === agentsDir) ? mechanic("confirmed", { ...ev2, note: "the hook ran from this shape, with cwd = .agents/" })
    : mechanic("refuted", { ...ev2, note: "the shape was read (the hook ran), but the hook's cwd is not .agents/" });

  const wrapped = rows.filter(r => r.tool === "call_mcp_tool");
  const wrappedKeys = wrapped.map(r => Object.keys(r.payload?.toolCall?.args ?? r.payload?.tool_input ?? {}).sort());
  const direct = rows.filter(r => r.mcp?.form === "direct");
  const cache = scratch ? Object.entries(scratch).filter(([k]) => /\/mcp$/.test(k)).flatMap(([, v]) => v) : [];
  const ev3 = { eager_configured: mcpConfig?.mcpServers?.[MCP_SERVER]?.tools?.[MCP_TOOL]?.eager === true, call_mcp_tool_calls: wrapped.length, call_mcp_tool_arg_keys: wrappedKeys,
    direct_calls: direct.map(r => r.tool), mcp_schema_cache_files: cache, shim_calls: shimCalls.length };
  m.mcp_lazy_call_mcp_tool = wrapped.length && wrappedKeys.every(k => ["Arguments", "ServerName", "ToolName"].every(x => k.includes(x))) ? mechanic("confirmed", { ...ev3, note: "call_mcp_tool carried {ServerName, ToolName, Arguments}" })
    : wrapped.length ? mechanic("refuted", { ...ev3, note: "call_mcp_tool was called with other argument keys" })
    : direct.length ? mechanic("not exercised", { ...ev3, note: "the eager (direct) tool was used; the lazy call_mcp_tool form was not seen" })
    : mechanic("not exercised", { ...ev3, note: "no MCP call reached the hook" });

  const forbiddenDeny = rows.find(r => WRITE_TOOLS.includes(r.tool) && /\/forbidden\.txt$/.test(r.args?.TargetFile ?? "") && r.decision === "deny");
  const verifyApproved = rows.find(r => r.tool === "run_command" && r.decision === "auto_approve");
  const verifyStep = steps.filter(s => s.tool_name === "run_command");
  const ev4 = { forbidden_hook_denied: Boolean(forbiddenDeny), forbidden_absent: checks.forbidden_absent, verify_auto_approved: Boolean(verifyApproved), verify_steps: verifyStep.map(s => s.state),
    mcp_auto_approved: rows.some(r => r.mcp && r.decision === "auto_approve"), shim_calls: shimCalls.length,
    not_exercised_by_design: "this hook always prints an explicit decision and exits 0: empty-stdout-allows, {}-denies and ignored exit codes are not exercised" };
  const ignoredDeny = forbiddenDeny && !checks.forbidden_absent;
  const softDenied = verifyApproved && verifyStep.length > 0 && verifyStep.every(s => BAD_STATE.test(s.state ?? ""));
  m.hook_decision_semantics = ignoredDeny ? mechanic("refuted", { ...ev4, note: "a hook deny was ignored: forbidden.txt exists" })
    : softDenied ? mechanic("refuted", { ...ev4, note: "run_command was auto_approved by the hook and still not run" })
    : forbiddenDeny && checks.verify_ran && (ev4.mcp_auto_approved ? checks.mcp_called : true) ? mechanic("confirmed", { ...ev4, note: "deny blocked the write; auto_approve let run_command (an Ask-tier tool) run headless" })
    : mechanic("not exercised", { ...ev4, note: "the worker did not attempt every step" });

  const erofs = /EROFS|read-only file system/i;
  const lines = [...new Set(`${stderrText}\n${logText}`.split("\n").filter(l => erofs.test(l)))].slice(0, 20);
  // The protected paths the CLI tried to write: every absolute path an EROFS line names.
  const erofsPaths = [...new Set(lines.flatMap(l => [...l.matchAll(/(\/[^\s:"'()]+)/g)].map(x => x[1])))].sort();
  const written = scratch ? [...scratch.top_level.filter(f => f.changed).map(f => f.name), ...Object.entries(scratch.subdirs).flatMap(([d, fs]) => fs.map(f => `${d}/${f.path}`))] : [];
  const ev5 = { gemini_state_untouched: checks.gemini_state_untouched, erofs_lines: lines, erofs_paths: erofsPaths, writes_in_scratch: written, scratch_written: scratch };
  m.state_mounts = !turnRan ? mechanic("not exercised", { ...ev5, note: "the turn did not run" })
    : lines.length ? mechanic("refuted", { ...ev5, note: `EROFS under a protected path: ${erofsPaths.join(", ") || "(no path in the lines)"}` })
    : !checks.gemini_state_untouched ? mechanic("refuted", { ...ev5, note: "the host ~/.gemini changed during the run" })
    : turnOk && written.length ? mechanic("confirmed", { ...ev5, note: "writes landed in the scratch copy of ~/.gemini/antigravity-cli (confirmed); ~/.gemini stayed read-only and unchanged" })
    : turnOk ? mechanic("confirmed", { ...ev5, note: "a full turn ran with ~/.gemini read-only and no EROFS; the CLI wrote nothing into the scratch" })
    : mechanic("not exercised", { ...ev5, note: "the turn did not complete (and no EROFS line was seen)" });
  return m;
}

function output(summary, token, code) {
  let text = JSON.stringify(summary, null, 2);
  if (token) text = text.split(token).join("<redacted:a2a-token>");
  process.stdout.write(text + "\n");
  process.exitCode = code;
}

async function main() {
  const summary = { schema: SCHEMA, agy: { path: null, version: null, sha256: null }, lane: LANE, timeout_s: timeoutS, quota_before: null, quota_after: null,
    launch: { argv: null, cwd: null, env_added: null, bwrap_binds: null, sandbox: null }, preflight: null,
    hook: { payloads: [], decisions: [], decisions_by_tool: {}, call_mcp_tool_seen: false, direct_mcp_seen: false, invoke_subagent_attempted: false },
    // null = not exercised (an early abort); false = exercised and failed.
    checks: { forbidden_denied: null, allowed_written: null, mcp_called: null, verify_ran: null, gemini_state_untouched: null },
    mcp: { shim_calls: [], mock_subagent_turns: 0, api_calls: 0 }, tools_run: [], turn: { exit_code: null, status: null, num_turns: null, usage: null, error: null },
    startup_errors: [], deprecations: [], diagnostics: { hooks_loaded: { preflight: null, turn: null }, gemini_dir_lines: [], auth_lines: [] }, stderr_tail: null, log_tail: null, owner_stated_mechanics: null, gemini_state: null,
    aborted: null, kept: null, kept_contains_credentials: null };
  // The host snapshots (taken once the fake/real HOME is known): an abort still reports whether ~/.gemini was touched.
  let hostSnap = null;
  const abort = (reason, token = null, spent = "nothing: no model turn was started") => {
    if (hostSnap) summary.checks.gemini_state_untouched = untouched(hostSnap.before, hostSnap.take());
    summary.aborted = { reason, spent }; output(summary, token, 2);
  };

  if (!Number.isFinite(timeoutS) || timeoutS <= 0) return abort(`--timeout must be a positive number of seconds, not ${JSON.stringify(opt("--timeout"))}`);
  if (cardOpt && !existsSync(cardOpt)) return abort(`--card ${cardOpt} does not exist`);
  const cli = opt("--cli") ?? process.env.PANTHEON_AGY_CLI ?? (await onPath("agy")) ?? (existsSync(join(homedir(), ".local", "bin", "agy")) ? join(homedir(), ".local", "bin", "agy") : null);
  if (!cli || !existsSync(cli)) return abort(`agy not found (searched --cli, $PANTHEON_AGY_CLI, $PATH, ~/.local/bin/agy)`);
  const cliReal = realpathSync(cli);
  summary.agy.path = cliReal;
  summary.agy.sha256 = await sha256File(cliReal);
  try { const v = await spawnPromise(cli, ["--version"], { env: minimalEnv({ AGY_CLI_DISABLE_AUTO_UPDATE: "true" }), timeout: 30000 }); summary.agy.version = `${v.stdout || v.stderr}`.trim().slice(0, 200) || null; }
  catch (e) { summary.agy.version = `unavailable: ${e?.code ?? e?.message ?? e}`; }

  let lanes = null;
  try { lanes = JSON.parse(readFileSync(LANES, "utf8")); } catch { /* reported below */ }
  if (!lanes?.agy_cli?.[LANE] || lanes.agy_cli[LANE].retired) return abort(`${LANE} is not a declared Antigravity lane (src/config/lanes.json)`);

  const qb = await probeQuota({ cli, model: LANE });
  summary.quota_before = quotaView(qb);
  if (qb.state !== "available") return abort(`the quota of ${LANE}'s Gemini group reads "${qb.state}", not "available": no turn is spent`);
  const box = await sandboxAvailable("bwrap");
  if (!box.ok) return abort(`the bwrap sandbox is unavailable (${box.why}); the probe never runs the worker unjailed`);

  const root = realpathSync(await mkdtemp(join(tmpdir(), "pantheon-agy-probe-")));
  const repo = join(root, "repo"), wt = join(root, "worktrees", UNIT), ctl = join(root, "control", UNIT);
  let shim = null, token = null, jail = null;
  try {
    const git = async (args, cwd) => {
      const r = await spawnPromise("git", ["-c", "user.name=pantheon-probe", "-c", "user.email=probe@invalid", "-c", "commit.gpgsign=false", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 60000 });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} exited ${r.status}: ${String(r.stderr).trim().slice(0, 300)}`);
      return r.stdout;
    };
    await mkdir(repo, { recursive: true }); await mkdir(dirname(wt), { recursive: true }); await mkdir(ctl, { recursive: true, mode: 0o700 });
    await git(["init", "-q", "-b", "main", "."], repo);
    await writeFile(join(repo, "README.md"), "agy worker probe\n");
    await git(["add", "-A"], repo);
    await git(["commit", "-q", "-m", "probe base"], repo);
    await git(["worktree", "add", "-q", "-b", "unit-probe", wt], repo);

    let mockTurns = 0;
    shim = await startA2AShim({ unit_id: UNIT, allowed_subagents: [ROLE], socket: join(ctl, "a2a.sock"), seatFor: () => ({ vendor: "mock", model: "mock-subagent" }),
      subagentTurn: async () => { mockTurns++; return { text: MOCK_ANSWER, served_model: "mock-subagent", served_model_source: "mock" }; } });
    token = shim.token;
    const a2a_env = { PANTHEON_A2A_SOCKET: shim.socket, PANTHEON_A2A_TOKEN: shim.token, PANTHEON_A2A_ROLES: ROLE, PANTHEON_UNIT_ID: UNIT };
    const ws = await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: UNIT, owned_paths: ["allowed/**"], verify_cmd: VERIFY, roles: [ROLE], mcp_server: MCP_SERVER_PATH, a2a_env,
      ...(cardOpt ? { card: cardOpt } : {}) });

    const home = process.env.HOME ?? homedir();
    const g = join(home, ".gemini"), cliState = join(g, GEMINI_CLI_DIR);
    const take = () => ({ cli_state: snapshot(cliState), config_projects: snapshot(join(g, "config", "projects")), top: topFiles(g) });
    const before = take();
    hostSnap = { before, take };
    const sandbox = { home };
    const env = workerEnv(a2a_env);

    // ONE jail for the preflight and the turn (the same control dir, workspace and state scratch).
    try { jail = await prepareWorkerJail({ cli, control_dir: ctl, worktree: wt, env, sandbox, a2a_socket: shim.socket }); }
    catch (e) { summary.gemini_state = { home_gemini: g, ...layoutView(null), error: { code: e.code ?? null, message: String(e.message ?? e).slice(0, 500) } }; return abort(`the jail could not be built (${e.code ?? "error"}): ${String(e.message ?? e).slice(0, 300)}`, token); }
    summary.launch.bwrap_binds = jail.sandboxRec.binds ?? null;
    summary.launch.sandbox = { enabled: jail.sandboxRec.enabled, kind: jail.sandboxRec.kind ?? null, gemini_state: jail.sandboxRec.gemini_state ?? null };

    const pf = await runAgyPreflight({ cli, control_dir: ctl, worktree: wt, env: a2a_env, jail });
    summary.preflight = pf;
    summary.diagnostics = mergeDiag(summary.diagnostics, pf.diagnostics);
    summary.diagnostics.hooks_loaded.preflight = pf.diagnostics?.hooks_loaded ?? null;
    if (!pf.ok) {
      const scratch = await dropGeminiState(jail.gstate, { keep }).catch(() => null);
      const after = take();
      summary.gemini_state = { home_gemini: g, ...layoutView(jail.gstate), before: { cli_state: before.cli_state, config_projects: before.config_projects, top_files: before.top },
        after: { cli_state: after.cli_state, config_projects: after.config_projects, top_files: after.top }, scratch_written: scratch };
      if (keep) { summary.kept = root; summary.kept_contains_credentials = Boolean(jail.gstate?.scratch_root); }
      jail = null;
      return abort(`preflight failed: ${pf.failed.map(k => `${k} (${pf.checks[k].why})`).join("; ")}`, token, "nothing: preflight failed before any model turn");
    }

    let r = null, err = null;
    try { r = await runAgyWorkerTurn({ cli, control_dir: ctl, worktree: wt, model: LANE, prompt: probePrompt(wt), timeoutS, env: a2a_env, a2a_socket: shim.socket, sandbox, jail }); }
    catch (e) { err = e; }
    const res = r ?? err ?? {};
    const scratch = await dropGeminiState(jail.gstate, { keep }).catch(() => null);
    const layout = layoutView(jail.gstate), hadScratch = Boolean(jail.gstate?.scratch_root);
    jail = null;
    const after = take();

    const rows = Array.isArray(res.jail_log) ? res.jail_log : [];
    const steps = Array.isArray(res.tool_steps) ? res.tool_steps : [];
    const launchArgs = res.launch?.args ?? [];
    summary.launch = { argv: launchArgs.length ? [res.launch.cmd, ...launchArgs] : null, cwd: res.launch?.cwd ?? null,
      env_added: res.launch?.env_added ? Object.fromEntries(Object.entries(res.launch.env_added).map(([k, v]) => [k, SECRETISH.test(k) ? "<redacted>" : v])) : null,
      bwrap_binds: res.sandbox?.binds ?? summary.launch.bwrap_binds, sandbox: res.sandbox ? { enabled: res.sandbox.enabled, kind: res.sandbox.kind ?? null, gemini_state: res.sandbox.gemini_state ?? null } : summary.launch.sandbox };
    const by = {};
    for (const row of rows) { const t = row.tool ?? "(none)"; by[t] ??= {}; by[t][row.decision] = (by[t][row.decision] ?? 0) + 1; }
    summary.hook = { payloads: rows.map(row => row.payload ?? row.raw ?? null), decisions: rows.map(row => ({ tool: row.tool ?? null, decision: row.decision, reason: row.reason ?? null, mcp: row.mcp ?? null, cwd: row.cwd ?? null })),
      decisions_by_tool: by, call_mcp_tool_seen: rows.some(row => row.tool === "call_mcp_tool"), direct_mcp_seen: rows.some(row => row.mcp?.form === "direct"),
      invoke_subagent_attempted: rows.some(row => HARD_DENY.includes(row.tool)) || steps.some(s => HARD_DENY.includes(s.tool_name)) };

    const forbidden_absent = !existsSync(join(wt, "forbidden.txt"));
    const allowed = existsSync(join(wt, "allowed", "probe.txt")) ? readFileSync(join(wt, "allowed", "probe.txt"), "utf8") : null;
    const shimCalls = shim.calls.map(c => ({ n: c.n, role: c.role, status: c.status, code: c.code, vendor: c.vendor, model: c.model, request_bytes: c.request_bytes, answer_bytes: c.answer_bytes }));
    const verifyApproved = rows.some(row => row.tool === "run_command" && row.decision === "auto_approve" && (row.args?.CommandLine ?? "").trim() === VERIFY);
    const runSteps = steps.filter(s => s.tool_name === "run_command");
    summary.checks = {
      forbidden_denied: forbidden_absent && rows.some(row => WRITE_TOOLS.includes(row.tool) && /\/forbidden\.txt$/.test(row.args?.TargetFile ?? "") && row.decision === "deny"),
      allowed_written: typeof allowed === "string" && allowed.trim() === "probe-ok",
      mcp_called: shim.calls.some(c => c.role === ROLE && c.status === "answered"),
      verify_ran: verifyApproved && runSteps.some(s => !BAD_STATE.test(s.state ?? "")),
      gemini_state_untouched: untouched(before, after),
    };
    summary.mcp = { shim_calls: shimCalls, mock_subagent_turns: mockTurns, api_calls: 0, socket_inside_bwrap: res.sandbox?.kind === "bwrap" };
    summary.tools_run = steps;
    summary.turn = { exit_code: res.exit_code ?? null, status: r ? r.status ?? null : res.result_status ?? null, num_turns: res.num_turns ?? null, usage: res.usage ?? null,
      error: err ? { code: err.code ?? null, kind: err.kind ?? null, message: String(err.message ?? err).slice(0, 500) } : null };
    const logText = await readFile(ws.agy_log, "utf8").catch(() => "");
    const stderrText = res.stderr_tail ?? "";
    summary.startup_errors = startupErrors({ logText, stderrText, toolSteps: steps.length });
    summary.deprecations = deprecationsOf({ logText, stderrText });
    summary.diagnostics = mergeDiag(summary.diagnostics, diagnosticLines(`${stderrText}\n${logText}`, env));
    const turnHooks = parseHooksLoaded(`${stderrText}\n${logText}`);
    summary.diagnostics.hooks_loaded.turn = turnHooks ? { named: turnHooks.named, files: turnHooks.files } : null;
    summary.stderr_tail = tail(res.stderr_tail ?? null);
    summary.log_tail = tail(logText);
    summary.gemini_state = { home_gemini: g, ...layout, before: { cli_state: before.cli_state, config_projects: before.config_projects, top_files: before.top },
      after: { cli_state: after.cli_state, config_projects: after.config_projects, top_files: after.top }, scratch_written: scratch };
    let mcpConfig = null;
    try { mcpConfig = JSON.parse(readFileSync(ws.mcp_config, "utf8")); } catch { /* reported as not eager */ }
    summary.owner_stated_mechanics = judge({ rows, steps, shimCalls, checks: { ...summary.checks, forbidden_absent }, turnRan: Boolean(res.launch) && res.exit_code !== undefined,
      turnOk: Boolean(r), launchArgs, agentsDir: join(ws.control_dir, ".agents"), mcpConfig, scratch,
      stderrText, logText, hookPaths: { command: ws.hook_command } });
    summary.quota_after = quotaView(await probeQuota({ cli, model: LANE }));
    if (keep) { summary.kept = root; summary.kept_contains_credentials = hadScratch; }
    const ok = Object.values(summary.checks).every(Boolean);
    output(summary, token, ok ? 0 : 1);
  } finally {
    if (jail) await dropGeminiState(jail.gstate, { keep }).catch(() => {});
    await shim?.close().catch(() => {});
    if (!keep) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(e => {
  process.stdout.write(JSON.stringify({ schema: SCHEMA, aborted: { reason: `the probe failed: ${String(e?.message ?? e).slice(0, 500)}` } }, null, 2) + "\n");
  process.exitCode = 1;
});
