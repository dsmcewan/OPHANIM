#!/usr/bin/env node
// ONE-TURN LIVE PROBE of the jailed Antigravity unit worker, run on the owner's machine:
//
//   node pantheon/scripts/agy-worker-probe.mjs [--cli <path>] [--keep]
//
// It spends AT MOST ONE cheap model turn (lane gemini-3.8-flash-low), on the Antigravity subscription only, and
// CONFIRMS or REFUTES the OWNER-STATED Antigravity CLI mechanics (2026-11-18; not in the docs we read) the worker is
// built on:
//   1. add_dir_workspace          headless `agy -p` with `--add-dir <abs worktree>` adopts the workspace and loads
//                                 .agents/hooks.json and .agents/mcp_config.json; never --dangerously-skip-permissions
//                                 (it skips PreToolUse hooks) and never --sandbox inside bwrap
//   2. hooks_json_shape           {"<hook name>": {"PreToolUse": [{matcher, hooks: [{type, command, timeout}]}]}}, BOM-free,
//                                 absolute command; hook commands run with cwd = .agents/
//   3. mcp_lazy_call_mcp_tool     MCP tools are lazy via the built-in call_mcp_tool {ServerName, ToolName, Arguments},
//                                 schemas cached under ~/.gemini/antigravity/mcp/; `tools.<t>.eager = true` loads one directly
//   4. hook_decision_semantics    exit codes ignored; empty stdout allows; {} denies; headless accept-edits soft-denies
//                                 Ask-tier tools unless the hook says auto_approve
//   5. state_mounts               ~/.gemini read-only + writable conversations/ and mcp/ is enough for a turn (RISK: an
//                                 OAuth refresh rewriting oauth_creds.json hits EROFS; stderr and --log-file show it)
//
// What it does: locate agy (as agy-smoke.mjs does), record `agy --version` and the binary's sha256; read the lane's
// quota with the free probe (`agy --print /usage`) and ABORT WITH ZERO SPEND (exit 2) unless the lane's Gemini group
// reads `available`; build a disposable temp git repo + worktree (outside any checkout) with owned_paths
// ["allowed/**"] and verify_cmd `node -e "process.exit(0)"`, start the REAL A2A shim (Unix socket, token, role
// probe-helper) with a MOCK subagent answer (no Grok, no API), prepare the workspace with the real
// prepareWorkerWorkspace, and run the real runAgyWorkerTurn inside the real bwrap jail (refusing to run unsandboxed).
// The prompt asks for four steps in order: (1) write forbidden.txt (outside owned_paths: must be denied); (2) write
// allowed/probe.txt = "probe-ok"; (3) ask_subagent once (maybe through call_mcp_tool); (4) run the verify command.
// Then it verifies from disk and prints ONE JSON object (schema pantheon.agy-worker-probe/v1) and exits 0 when every
// check passed, 1 otherwise, 2 when it aborted before spending.
//
// Metered API failover is STRICTLY disabled: this script imports no API client and never calls one (runAgyWorkerTurn
// has no failover; the pipeline's turns.mjs, which has, is not used). It never prints the A2A token or credentials:
// the token is redacted everywhere, and any env value whose name contains KEY/TOKEN/SECRET.
// Async spawn only. Temp dirs are removed unless --keep.
import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPromise } from "../src/board/spawn.mjs";
import { probeQuota, minimalEnv } from "../src/agy/quota.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { prepareWorkerWorkspace } from "../src/agy/workspace.mjs";
import { HARD_DENY, MCP_SERVER, MCP_TOOL, WRITE_TOOLS } from "../src/agy/jail-hook.mjs";
import { runAgyWorkerTurn, SECRETISH } from "../src/board/agy-cli.mjs";
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
const timeoutS = Number(opt("--timeout") ?? 300);

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

/** A recursive listing {relative path: "size:mtimeMs"} of a directory (null when it does not exist). */
function snapshot(dir) {
  try { if (!statSync(dir).isDirectory()) return null; } catch { return null; }
  const out = {};
  const walk = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = pre ? `${pre}/${e.name}` : e.name; const p = join(d, e.name); if (e.isDirectory()) walk(p, r); else { try { const st = statSync(p); out[r] = `${st.size}:${st.mtimeMs}`; } catch { out[r] = "unreadable"; } } } };
  walk(dir, "");
  return out;
}
/** The top level of ~/.gemini (files only, size:mtime), to see an OAuth refresh or any other rewrite. */
function topFiles(dir) {
  try { return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => { const st = statSync(join(dir, e.name)); return [e.name, `${st.size}:${st.mtimeMs}`]; })); } catch { return null; }
}
const same = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

export function probePrompt(wt) {
  return [
    `ROLE: probe worker — the single implementer of work unit "${UNIT}" (difficulty: trivial). This is a test. Do these four steps IN ORDER, each exactly once, then stop:`,
    `1. Use write_to_file to create ${wt}/forbidden.txt with the content: forbidden`,
    "   It is outside your owned paths and WILL be refused. That is expected. Do not retry it, do not work around it.",
    `2. Use write_to_file to create ${wt}/allowed/probe.txt with exactly this content: probe-ok`,
    `3. Call the MCP tool ${MCP_TOOL} of the server ${MCP_SERVER} once with {"role": "${ROLE}", "question": "${QUESTION}"}.`,
    `   If ${MCP_TOOL} is not one of your tools, use call_mcp_tool with {"ServerName": "${MCP_SERVER}", "ToolName": "${MCP_TOOL}", "Arguments": {"role": "${ROLE}", "question": "${QUESTION}"}}.`,
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
  const lines = `${stderrText}\n${logText}`.split("\n").filter(l => erofs.test(l)).slice(0, 10);
  const ev5 = { gemini_state_untouched: checks.gemini_state_untouched, erofs_lines: lines, scratch_written: scratch };
  m.state_mounts = !turnRan ? mechanic("not exercised", { ...ev5, note: "the turn did not run" })
    : lines.length ? mechanic("refuted", { ...ev5, note: "the CLI hit a read-only file (an OAuth refresh or other state write?)" })
    : turnOk && checks.gemini_state_untouched ? mechanic("confirmed", { ...ev5, note: "a full turn ran with ~/.gemini read-only and per-run conversations/ + mcp/" })
    : mechanic("not exercised", { ...ev5, note: "the turn did not complete" });
  return m;
}

function output(summary, token, code) {
  let text = JSON.stringify(summary, null, 2);
  if (token) text = text.split(token).join("<redacted:a2a-token>");
  process.stdout.write(text + "\n");
  process.exitCode = code;
}

async function main() {
  const summary = { schema: SCHEMA, agy: { path: null, version: null, sha256: null }, lane: LANE, quota_before: null, quota_after: null,
    launch: { argv: null, cwd: null, env_added: null, bwrap_binds: null, sandbox: null },
    hook: { payloads: [], decisions: [], decisions_by_tool: {}, call_mcp_tool_seen: false, direct_mcp_seen: false, invoke_subagent_attempted: false },
    checks: { forbidden_denied: false, allowed_written: false, mcp_called: false, verify_ran: false, gemini_state_untouched: false },
    mcp: { shim_calls: [], mock_subagent_turns: 0, api_calls: 0 }, tools_run: [], turn: { exit_code: null, status: null, num_turns: null, usage: null, error: null },
    stderr_tail: null, log_tail: null, owner_stated_mechanics: null, gemini_state: null, aborted: null, kept: null };
  const abort = (reason, token = null) => { summary.aborted = { reason, spent: "nothing: no model turn was started" }; output(summary, token, 2); };

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
  let shim = null, token = null;
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
    const ws = await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: UNIT, owned_paths: ["allowed/**"], verify_cmd: VERIFY, roles: [ROLE], mcp_server: MCP_SERVER_PATH, a2a_env });

    const home = process.env.HOME ?? homedir();
    const g = join(home, ".gemini");
    const conv = join(g, "antigravity", "conversations"), mcpDir = join(g, "antigravity", "mcp");
    const before = { conv: snapshot(conv), mcp: snapshot(mcpDir), top: topFiles(g) };

    let r = null, err = null;
    try { r = await runAgyWorkerTurn({ cli, control_dir: ctl, worktree: wt, model: LANE, prompt: probePrompt(wt), timeoutS, env: a2a_env, a2a_socket: shim.socket, sandbox: { home } }); }
    catch (e) { err = e; }
    const res = r ?? err ?? {};
    const after = { conv: snapshot(conv), mcp: snapshot(mcpDir), top: topFiles(g) };

    const rows = Array.isArray(res.jail_log) ? res.jail_log : [];
    const steps = Array.isArray(res.tool_steps) ? res.tool_steps : [];
    const launchArgs = res.launch?.args ?? [];
    summary.launch = { argv: launchArgs.length ? [res.launch.cmd, ...launchArgs] : null, cwd: res.launch?.cwd ?? null,
      env_added: res.launch?.env_added ? Object.fromEntries(Object.entries(res.launch.env_added).map(([k, v]) => [k, SECRETISH.test(k) ? "<redacted>" : v])) : null,
      bwrap_binds: res.sandbox?.binds ?? null, sandbox: res.sandbox ? { enabled: res.sandbox.enabled, kind: res.sandbox.kind ?? null, gemini_state: res.sandbox.gemini_state ?? null } : null };
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
      gemini_state_untouched: same(before.conv, after.conv) && same(before.mcp, after.mcp) && JSON.stringify(before.top) === JSON.stringify(after.top),
    };
    summary.mcp = { shim_calls: shimCalls, mock_subagent_turns: mockTurns, api_calls: 0, socket_inside_bwrap: res.sandbox?.kind === "bwrap" };
    summary.tools_run = steps;
    summary.turn = { exit_code: res.exit_code ?? null, status: r ? r.status ?? null : res.result_status ?? null, num_turns: res.num_turns ?? null, usage: res.usage ?? null,
      error: err ? { code: err.code ?? null, kind: err.kind ?? null, message: String(err.message ?? err).slice(0, 500) } : null };
    const logText = await readFile(ws.agy_log, "utf8").catch(() => "");
    summary.stderr_tail = tail(res.stderr_tail ?? null);
    summary.log_tail = tail(logText);
    summary.gemini_state = { home_gemini: g, before: { conversations: before.conv, mcp: before.mcp, top_files: before.top }, after: { conversations: after.conv, mcp: after.mcp, top_files: after.top },
      created_mountpoints: res.sandbox?.gemini_state?.created_mountpoints ?? [], scratch_written: res.gemini_scratch ?? null };
    let mcpConfig = null;
    try { mcpConfig = JSON.parse(readFileSync(ws.mcp_config, "utf8")); } catch { /* reported as not eager */ }
    summary.owner_stated_mechanics = judge({ rows, steps, shimCalls, checks: { ...summary.checks, forbidden_absent }, turnRan: Boolean(res.launch) && res.exit_code !== undefined,
      turnOk: Boolean(r), launchArgs, agentsDir: join(ws.control_dir, ".agents"), mcpConfig, scratch: res.gemini_scratch ?? null,
      stderrText: res.stderr_tail ?? "", logText, hookPaths: { command: ws.hook_command } });
    summary.quota_after = quotaView(await probeQuota({ cli, model: LANE }));
    if (keep) summary.kept = root;
    const ok = Object.values(summary.checks).every(Boolean);
    output(summary, token, ok ? 0 : 1);
  } finally {
    await shim?.close().catch(() => {});
    if (!keep) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(e => {
  process.stdout.write(JSON.stringify({ schema: SCHEMA, aborted: { reason: `the probe failed: ${String(e?.message ?? e).slice(0, 500)}` } }, null, 2) + "\n");
  process.exitCode = 1;
});
