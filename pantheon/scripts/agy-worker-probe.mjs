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
// which both reject (observed, agy 1.5.10, 2026-11-18) -- the login and the lane's quota by an in-jail /usage, and a
// scan of their output and of the new files of the CLI's log dir); if a BLOCKING check fails it ABORTS (exit 2, spent nothing) with the redacted outputs under `preflight` (never
// the raw `agy mcp list` output, which was observed to print a credential: only its server names). Discovery (are the
// worker and the MCP server listed?) is ADVISORY: those subcommands were observed to list global configuration only.
// Every check the run did not exercise is null, not false. Then it runs
// the real runAgyWorkerTurn inside the same jail (refusing to run unsandboxed), --print-timeout 180s by default.
// The prompt asks for four steps in order: (1) write_file forbidden.txt (outside owned_paths: must be denied); (2)
// write_file allowed/probe.txt = "probe-ok"; (3) ask_subagent once (maybe through call_mcp_tool); (4) run_command the
// EXACT worker command `cd '<worktree>' && node -e "process.exit(0)"` (run_command has no Cwd: observed on agy 1.5.10).
// Then it verifies from the hook log, the tool steps AND the disk (turnChecks: a tool RAN only when the LAST step of
// its call is a terminal success -- ACTIVE never counts, a later ERROR undoes a DONE, a reported non-zero exit fails
// run_command), classifies every host ~/.gemini change against the jail's bind list (hostChanges: a change the jail
// could write fails gemini_state_untouched; any other change leaves it null = UNRESOLVED, reported with possible_writer
// "another host process" and in gemini_state.unresolved_host_changes, next to the host's agy processes before and after
// the turn, args redacted; only NO change at all is "untouched"), and prints ONE JSON object (schema
// pantheon.agy-worker-probe/v1) and exits 0 when every check passed, 1 otherwise, 2 when it aborted before spending. Diagnostics: `startup_errors` (E-level and read-only
// file system lines of the CLI log and stderr up to the first tool step, de-duplicated, at most 60), `deprecations`,
// `stderr_tail`, `log_tail`, `gemini_state.scratch_written` (what the CLI wrote into the scratch copy),
// `gemini_state.copied` / `withheld` / `writable_copies` (what the scratch was given and what was kept from it), and
// `diagnostics`: `hooks_loaded` {preflight, turn} ({named, files, sources} parsed from the CLI's "loaded N named hooks
// from M hooks.json file(s)" line in stdout/stderr, the --log-file AND the CLI's log/ files: whether the --print
// session loaded <ctl>/.agents/hooks.json), `workspace_dirs` {preflight, turn} (the last `workspaceDirs=[...]` line:
// which directories the CLI took as workspace), `cli_log` {preflight, turn} (runAgyPreflight / runAgyWorkerTurn: the
// new log files read before cleanup, line counts per source, EROFS paths, unknown/registry/deprecated lines, ...),
// `gemini_dir_lines`, and `negative_login_lines` {advisory: true, note, lines}: the "not logged in" / "Auth mode is
// unspecified" lines, ADVISORY (observed on agy 1.5.10 in every layout whenever the CLI could not write its log file,
// while /usage succeeded; the preflight's auth is the in-jail /usage).
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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPromise } from "../src/board/spawn.mjs";
import { probeQuota, minimalEnv } from "../src/agy/quota.mjs";
import { dropGeminiState, GEMINI_CLI_DIR, jailReach, sandboxAvailable } from "../src/agy/sandbox.mjs";
import { prepareWorkerWorkspace, workerVerifyPromptLines } from "../src/agy/workspace.mjs";
import { HARD_DENY, MCP_SERVER, MCP_TOOL, WRITE_TOOLS, mcpCallOf, toolCallOf, workerVerifyCommand, writeTargetOf } from "../src/agy/jail-hook.mjs";
import { AGY_NOT_LOGGED_IN, NEGATIVE_LOGIN_NOTE, parseHooksLoaded, prepareWorkerJail, redactStrong, runAgyPreflight, runAgyWorkerTurn, SECRETISH, workerEnv } from "../src/board/agy-cli.mjs";
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

/**
 * A file's identity in a snapshot: size, mtime, ctime, mode, dev, inode and link count. ctime catches a chmod or a
 * restored write; dev/inode a replaced file; nlink a hard link made to it (independent review round 2, assignment 4
 * (OpenAI gpt-6-astra, 77480d6), question 10: size:mtime alone missed all of these).
 */
const statKey = st => `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}:${st.dev}:${st.ino}:${st.nlink}`;
/** A recursive listing {relative path: statKey} of a directory (null when it does not exist). Never follows a symlink. */
function snapshot(dir) {
  try { if (!statSync(dir).isDirectory()) return null; } catch { return null; }
  const out = {};
  const walk = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = pre ? `${pre}/${e.name}` : e.name; const p = join(d, e.name); if (e.isDirectory()) walk(p, r); else { try { const st = lstatSync(p); out[r] = statKey(st); } catch { out[r] = "unreadable"; } } } };
  walk(dir, "");
  return out;
}
/** The top level of ~/.gemini (every entry: files as size:mtime, others by kind), to see an OAuth refresh, any other rewrite, or a created entry. */
function topFiles(dir) {
  try { return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).map(e => { const st = lstatSync(join(dir, e.name)); return [e.name, e.isFile() ? statKey(st) : e.isDirectory() ? "dir" : "other"]; })); } catch { return null; }
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
// ---- HOST-STATE ATTRIBUTION ------------------------------------------------------------------------------------------
// OBSERVED (owner's machine, first real worker turn of 5efbba5, 2026-11-18): gemini_state_untouched read false only
// because the HOST file ~/.gemini/antigravity-cli/log/cli-20261114_185251.log grew by 306 bytes during the probe; inside
// the jail ~/.gemini/antigravity-cli is the scratch copy (and log/ an empty scratch subdir), so the jailed process had
// no path to that file. Every host change is therefore CLASSIFIED against the jail's actual bind list (jailReach):
// reachable_by_jail (mounted read-write inside the jail: it must never change -> the check fails) or
// outside_jail_reach (hidden or read-only inside the jail: reported, not a failure, possible_writer "another host
// process"). gemini_state_untouched = no reachable change.
/**
 * The host changes between two snapshots ({cli_state, config_projects, top} as `take()` makes them, rooted at
 * `roots` {cli_state, config_projects, top}: absolute dirs), each classified by jailReach(binds). Returns
 * [{path, change: "added" | "removed" | "changed", before, after, reach, jail_view, why, possible_writer?}] sorted by path.
 */
export function hostChanges(before, after, roots, binds) {
  const out = [];
  for (const k of ["cli_state", "config_projects", "top"]) {
    const a = before?.[k] ?? {}, b = after?.[k] ?? {};
    for (const rel of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
      if (a[rel] === b[rel]) continue;
      const path = join(roots[k], ...rel.split("/"));
      const r = jailReach(binds, path);
      out.push({ path, change: !(rel in a) ? "added" : !(rel in b) ? "removed" : "changed", before: a[rel] ?? null, after: b[rel] ?? null,
        reach: r.reach, jail_view: r.jail_view, why: r.why, ...(r.nlink ? { nlink: r.nlink, dev: r.dev, ino: r.ino } : {}),
        // A change the jail could not reach by path is NOT attributed: it stays UNRESOLVED evidence (see untouchedBy).
        // (With no jail run at all -- binds null -- the jail cannot be the writer: attributed, not unresolved.)
        ...(r.reach !== "reachable_by_jail" ? { possible_writer: "another host process", unresolved: r.jail_view !== "no jail ran" } : {}) });
    }
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}
/**
 * gemini_state_untouched: true ONLY when no host change was seen at all; false when one was reachable by the jail; null
 * (UNRESOLVED) when every change was outside the jail's reach by path, or hard-linked. Independent review round 2,
 * assignment 4 (OpenAI gpt-6-astra, 77480d6), question 10: jailReach describes where the jail's binds point, not who
 * wrote a file; a change it cannot attribute (another host process, a hard-link alias, an actual escape) must not read
 * as "untouched". null when nothing was snapshotted.
 */
export const untouchedBy = (changes, snapped = true) => (!snapped ? null : changes.some(c => c.reach === "reachable_by_jail") ? false : changes.some(c => c.unresolved) ? null : true);
/** The host changes no one could attribute (untouchedBy null): [{path, change, reach, jail_view, why}]. */
export const unresolvedOf = changes => changes.filter(c => c.unresolved).map(c => ({ path: c.path, change: c.change, reach: c.reach, jail_view: c.jail_view, why: c.why }));

/**
 * The agy processes of a `ps -eo pid,lstart,args` listing: those whose binary (the first word of args) is named agy /
 * antigravity or language_server*. Everything after the binary path is REDACTED (args may carry tokens or prompts).
 * Returns [{pid, started, binary, args_redacted}].
 */
export function parseAgyProcesses(text) {
  const out = [];
  for (const l of String(text ?? "").split("\n").slice(1)) {
    const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)(.*)$/.exec(l);
    if (!m) continue;
    const name = basename(m[3]);
    if (!/^(agy|antigravity)$|^language_server/.test(name)) continue;
    out.push({ pid: Number(m[1]), started: m[2], binary: m[3], args_redacted: m[4].trim().length > 0 });
  }
  return out;
}
/** The agy processes running on the host now (async spawn of ps); {processes} or {error}. */
export async function hostAgyProcesses() {
  try {
    const r = await spawnPromise("ps", ["-eo", "pid,lstart,args"], { env: { ...process.env, LC_ALL: "C" }, timeout: 10000 });
    if (r.status !== 0) return { at: new Date().toISOString(), error: `ps exited ${r.status ?? r.killedFor}` };
    return { at: new Date().toISOString(), processes: parseAgyProcesses(r.stdout) };
  } catch (e) { return { at: new Date().toISOString(), error: `ps could not be started: ${e?.code ?? e?.message ?? e}` }; }
}

// ---- THE TOOL STEPS: what RAN, from the stream -----------------------------------------------------------------------
// OBSERVED (agy 1.5.10, first real worker turn, 2026-11-18): every call is a step ACTIVE, then a terminal step (DONE or
// ERROR, with tool_info.error {type, message} or tool_info.output); a hook deny is "ERROR: tool call denied by
// pre-tool hook: <reason>"; the steps carry NO call id. The earlier check counted a run_command whose steps were
// ACTIVE -> ERROR (EROFS writing bin/agentapi) as run, because ACTIVE is not a "bad" state. Now a tool RAN only when the
// LAST step of its call is a terminal success, and ACTIVE never counts.
export const STEP_SUCCESS = Object.freeze(["DONE", "COMPLETED", "SUCCEEDED", "SUCCESS"]);
const STEP_PENDING = /^(ACTIVE|RUNNING|PENDING|IN_PROGRESS|WAITING|QUEUED|STARTED)$/i;
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const errorOf = info => { const e = info?.error; return typeof e === "string" ? e : isObj(e) ? String(e.message ?? JSON.stringify(e)) : null; };
/** The exit status a run_command step reports (tool_info.exit_code / exitCode / exit_status, or "exit code N" in its output); null when none. */
export function exitStatusOf(info) {
  if (!isObj(info)) return null;
  for (const k of ["exit_code", "exitCode", "exit_status", "exitStatus"]) if (Number.isInteger(info[k])) return info[k];
  const text = typeof info.output === "string" ? info.output : null;
  const m = text && /\bexit(?:ed)?(?:\s+with)?[ _]?(?:code|status)\s*[:=]?\s*(-?\d+)/i.exec(text);
  return m ? Number(m[1]) : null;
}
/**
 * Group the stream's tool steps into calls, in order. A PENDING step (ACTIVE, ...) of a tool opens a new call; a later
 * step of the same tool joins the open call; a terminal step with no open call of its tool opens one, except an ERROR-ish
 * one right after a closed call of that tool, which is attached to it (a later ERROR: never read as a success). Returns
 * [{tool_name, states, ran, last_state, error, exit_status}]; `ran` = the LAST state is a terminal success.
 */
export function toolCallsOf(steps) {
  const calls = [], open = new Map(), last = new Map();
  for (const s of Array.isArray(steps) ? steps : []) {
    const name = s?.tool_name ?? null, st = String(s?.state ?? "");
    let c = STEP_PENDING.test(st) ? null : open.get(name);
    if (!c && !STEP_PENDING.test(st) && !STEP_SUCCESS.includes(st) && last.get(name) && !open.has(name)) c = last.get(name);
    if (!c) { c = { tool_name: name, steps: [] }; calls.push(c); last.set(name, c); }
    c.steps.push(s);
    if (STEP_PENDING.test(st)) open.set(name, c); else open.delete(name);
  }
  return calls.map(c => {
    const states = c.steps.map(x => x?.state ?? null), lastState = states.at(-1);
    const errors = c.steps.map(x => errorOf(x?.tool_info)).filter(Boolean);
    const exits = c.steps.map(x => exitStatusOf(x?.tool_info)).filter(x => x !== null);
    return { tool_name: c.tool_name, states, ran: STEP_SUCCESS.includes(lastState), last_state: lastState ?? null, error: errors.at(-1) ?? null, exit_status: exits.at(-1) ?? null };
  });
}
/** The hook rows (jail.log) paired with their calls: the i-th row of a tool <-> the i-th call of that tool. [{row, call | null}]. */
export function pairRowsWithCalls(rows, calls) {
  const by = new Map();
  for (const c of calls) { if (!by.has(c.tool_name)) by.set(c.tool_name, []); by.get(c.tool_name).push(c); }
  const used = new Map();
  return (Array.isArray(rows) ? rows : []).map(row => {
    const name = row?.tool ?? toolCallOf(row?.payload)?.name ?? null, i = used.get(name) ?? 0;
    used.set(name, i + 1);
    return { row, call: by.get(name)?.[i] ?? null };
  });
}
const argsOfRow = row => toolCallOf(row?.payload)?.args ?? row?.args ?? {};
const writePathOf = row => { const t = writeTargetOf(argsOfRow(row)); return typeof t?.value === "string" ? resolve(t.value) : null; };
export const HOOK_DENIED_STEP = /denied by pre-tool hook/;
/** A deny by the owned-path policy (jail-hook.mjs decideWrite), not by an unknown tool or a malformed call. */
export const OWNED_PATH_DENY = /is not one of the unit's owned paths/;
/**
 * The four turn checks, from the hook rows, the tool steps and the disk (passed in): {forbidden_denied, allowed_written,
 * mcp_called, verify_ran, evidence}.
 *   forbidden_denied  a hook DENY of a write to <wt>/forbidden.txt BY THE OWNED-PATH POLICY (OWNED_PATH_DENY) whose call
 *                     ended in an ERROR step saying "denied by pre-tool hook", and the file absent
 *   allowed_written   an AUTO_APPROVE of a write to <wt>/allowed/probe.txt whose call RAN (last step DONE), and the file
 *                     content "probe-ok" (a trailing newline tolerated)
 *   mcp_called        an AUTO_APPROVE of the ask_subagent call whose call RAN, and a shim call answered for the role
 *   verify_ran        an AUTO_APPROVE of run_command with CommandLine (trimmed) == the worker verify command whose call
 *                     RAN, with exit status 0 when one is reported (exit_status null: none was reported; DONE decides)
 */
export function turnChecks({ rows, steps, worktree, workerVerify, forbiddenAbsent, allowedContent, shimCalls = [], role = ROLE }) {
  const pairs = pairRowsWithCalls(rows, toolCallsOf(steps));
  const forbidden = resolve(worktree, "forbidden.txt"), allowed = resolve(worktree, "allowed", "probe.txt");
  const writes = p => pairs.filter(({ row }) => WRITE_TOOLS.includes(row?.tool) && writePathOf(row) === p);
  const view = x => x && { tool: x.row?.tool ?? null, decision: x.row?.decision ?? null, reason: x.row?.reason ?? null, states: x.call?.states ?? null, error: x.call?.error ?? null, exit_status: x.call?.exit_status ?? null };
  // The deny must be the OWNED-PATH policy's: observed 2026-11-18, the hook denied write_file as an unknown tool, a deny
  // that proved nothing about owned_paths.
  const fDeny = writes(forbidden).filter(x => x.row.decision === "deny" && OWNED_PATH_DENY.test(x.row.reason ?? ""));
  const fHit = fDeny.find(x => x.call && x.call.last_state === "ERROR" && HOOK_DENIED_STEP.test(x.call.error ?? ""));
  const aOk = writes(allowed).find(x => x.row.decision === "auto_approve" && x.call?.ran);
  const contentOk = typeof allowedContent === "string" && /^probe-ok(\r?\n)?$/.test(allowedContent);
  const mcp = pairs.filter(({ row }) => { const m = mcpCallOf(toolCallOf(row?.payload) ?? (row?.tool ? { name: row.tool, args: row.args ?? {}, call: { name: row.tool } } : null)); return m && m.server === MCP_SERVER && m.tool === MCP_TOOL; });
  const mOk = mcp.find(x => x.row.decision === "auto_approve" && x.call?.ran);
  const answered = shimCalls.some(c => c.role === role && c.status === "answered");
  const runs = pairs.filter(({ row }) => row?.tool === "run_command");
  const exact = runs.filter(x => typeof argsOfRow(x.row).CommandLine === "string" && argsOfRow(x.row).CommandLine.trim() === workerVerify);
  const vOk = exact.find(x => x.row.decision === "auto_approve" && x.call?.ran && (x.call.exit_status === null || x.call.exit_status === 0));
  return {
    forbidden_denied: Boolean(fHit) && forbiddenAbsent === true,
    allowed_written: Boolean(aOk) && contentOk,
    mcp_called: Boolean(mOk) && answered,
    verify_ran: Boolean(vOk),
    evidence: {
      forbidden: { attempts: writes(forbidden).map(view), absent: forbiddenAbsent },
      allowed: { attempts: writes(allowed).map(view), content_ok: contentOk },
      mcp: { attempts: mcp.map(view), shim_answered: answered },
      verify: { worker_command: workerVerify, attempts: runs.map(x => ({ ...view(x), exact: exact.includes(x) })), exit_status: vOk ? vOk.call.exit_status : null },
      unpaired_rows: pairs.filter(x => !x.call).map(x => x.row?.tool ?? null),
    },
  };
}
/** The redacted lines of `text` naming GeminiDir / saying "not logged in" (de-duplicated). */
export function diagnosticLines(text, env = {}) {
  const ls = String(text ?? "").split("\n").map(l => l.trimEnd()).filter(Boolean);
  const pick = re => [...new Set(ls.filter(l => re.test(l)).map(l => redactStrong(l, env).slice(0, 500)))].slice(0, 20);
  return { gemini_dir_lines: pick(/GeminiDir/i), negative_login_lines: pick(AGY_NOT_LOGGED_IN) };
}
const emptyDiag = () => ({ hooks_loaded: { preflight: null, turn: null }, workspace_dirs: { preflight: null, turn: null }, cli_log: { preflight: null, turn: null },
  gemini_dir_lines: [], negative_login_lines: { advisory: true, note: NEGATIVE_LOGIN_NOTE, lines: [] } });
const negLines = x => (Array.isArray(x) ? x : x?.lines ?? []);
const mergeDiag = (a, b) => ({ ...a, gemini_dir_lines: [...new Set([...(a?.gemini_dir_lines ?? []), ...(b?.gemini_dir_lines ?? [])])].slice(0, 40),
  negative_login_lines: { advisory: true, note: NEGATIVE_LOGIN_NOTE, lines: [...new Set([...negLines(a?.negative_login_lines), ...negLines(b?.negative_login_lines)])].slice(0, 40) } });
/** A cli_log record as the summary keeps it (no text tail: that goes to log_tail). */
const cliLogView = c => { if (!c) return null; const { tail: _t, ...rest } = c; return rest; };
/** What the summary says about the state layout given to the CLI: copied, withheld (name + size only), writable copies. */
const layoutView = gs => (gs ? { copied: gs.copied ?? [], withheld: gs.withheld ?? [], writable_copies: (gs.writable_copies ?? []).map(w => ({ path: w.path, dest: w.dest, status: w.status, ...(w.copied ? { copied: w.copied } : {}), ...(w.why ? { why: w.why } : {}) })) } : { copied: [], withheld: [], writable_copies: [] });

export function probePrompt(wt) {
  const wv = workerVerifyCommand(wt, VERIFY);
  return [
    `ROLE: probe worker — the single implementer of work unit "${UNIT}" (difficulty: trivial). This is a test. Do these four steps IN ORDER, each exactly once, then stop:`,
    `1. Use write_file to create ${wt}/forbidden.txt (Path ${wt}/forbidden.txt) with the content: forbidden`,
    "   It is outside your owned paths and WILL be refused. That is expected. Do not retry it, do not work around it.",
    `2. Use write_file to create ${wt}/allowed/probe.txt (Path ${wt}/allowed/probe.txt) with exactly this content: probe-ok`,
    `3. Call the tool ${MCP_TOOL} (provided by the MCP server ${MCP_SERVER}) once with {"role": "${ROLE}", "question": "${QUESTION}"}.`,
    `4. Use run_command to run exactly the VERIFY COMMAND below, character for character: ${wv}`,
    "Then finish with the JSON summary your instructions describe.",
    "",
    "PATHS YOU OWN (the only paths you may create, change or delete):",
    "- allowed/**",
    "Do not commit, do not move HEAD.",
    "",
    ...workerVerifyPromptLines(wv),
    "",
    "GROUND TRUTH: the controller will run this command in your worktree after you finish; its exit code decides, not your report:",
    `  ${VERIFY}`,
    "Run the VERIFY COMMAND yourself before you stop.",
  ].join("\n");
}

const mechanic = (status, evidence) => ({ status, evidence });

function judge({ rows, steps, shimCalls, checks, turnRan, turnOk, launchArgs, agentsDir, mcpConfig, scratch, stderrText, logText, hookPaths, worktree }) {
  const calls = toolCallsOf(steps), pairs = pairRowsWithCalls(rows, calls);
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

  const forbiddenDeny = rows.find(r => WRITE_TOOLS.includes(r.tool) && writePathOf(r) === resolve(worktree, "forbidden.txt") && r.decision === "deny");
  const approvedRuns = pairs.filter(x => x.row?.tool === "run_command" && x.row.decision === "auto_approve");
  const verifyApproved = approvedRuns.length > 0;
  const verifyStep = steps.filter(s => s.tool_name === "run_command");
  const verifyErrors = approvedRuns.map(x => x.call?.error).filter(Boolean);
  const ev4 = { forbidden_hook_denied: Boolean(forbiddenDeny), forbidden_absent: checks.forbidden_absent, verify_auto_approved: verifyApproved, verify_steps: verifyStep.map(s => s.state), verify_errors: verifyErrors,
    mcp_auto_approved: rows.some(r => r.mcp && r.decision === "auto_approve"), shim_calls: shimCalls.length,
    not_exercised_by_design: "this hook always prints an explicit decision and exits 0: empty-stdout-allows, {}-denies and ignored exit codes are not exercised" };
  const ignoredDeny = forbiddenDeny && !checks.forbidden_absent;
  // An approved run_command that did not run is evidence against auto_approve only when nothing else explains it (an
  // EROFS or another tool error is the environment, not the hook semantics: observed 2026-11-18, bin/agentapi EROFS).
  const failedApproved = approvedRuns.filter(x => x.call && !x.call.ran);
  const softDenied = failedApproved.length > 0 && failedApproved.length === approvedRuns.length && failedApproved.every(x => !x.call.error || /approv|permission|soft[- ]?den/i.test(x.call.error));
  const envFailed = failedApproved.length > 0 && !softDenied;
  m.hook_decision_semantics = ignoredDeny ? mechanic("refuted", { ...ev4, note: "a hook deny was ignored: forbidden.txt exists" })
    : softDenied ? mechanic("refuted", { ...ev4, note: "run_command was auto_approved by the hook and still not run" })
    : envFailed && !checks.verify_ran ? mechanic("not exercised", { ...ev4, note: "run_command was auto_approved and then failed with a tool error (see verify_errors): the environment, not the hook decision" })
    : forbiddenDeny && checks.verify_ran && (ev4.mcp_auto_approved ? checks.mcp_called : true) ? mechanic("confirmed", { ...ev4, note: "deny blocked the write; auto_approve let run_command (an Ask-tier tool) run headless" })
    : mechanic("not exercised", { ...ev4, note: "the worker did not attempt every step" });

  const erofs = /EROFS|read-only file system/i;
  // EROFS in the CLI's log/stderr AND in a tool step's error (observed: run_command's bin/agentapi write).
  const stepErrors = calls.map(c => c.error).filter(e => e && erofs.test(e)).map(e => `tool step: ${e}`);
  const lines = [...new Set([...`${stderrText}\n${logText}`.split("\n").filter(l => erofs.test(l)), ...stepErrors])].slice(0, 20);
  // The protected paths the CLI tried to write: every absolute path an EROFS line names.
  const erofsPaths = [...new Set(lines.flatMap(l => [...l.matchAll(/(\/[^\s:"'()]+)/g)].map(x => x[1])))].sort();
  const written = scratch ? [...scratch.top_level.filter(f => f.changed).map(f => f.name), ...Object.entries(scratch.subdirs).flatMap(([d, fs]) => fs.map(f => `${d}/${f.path}`)),
    ...Object.entries(scratch.writable_subdirs ?? {}).flatMap(([d, fs]) => fs.filter(f => f.changed).map(f => `${d}/${f.path}`))] : [];
  const ev5 = { gemini_state_untouched: checks.gemini_state_untouched, erofs_lines: lines, erofs_paths: erofsPaths, writes_in_scratch: written, scratch_written: scratch };
  m.state_mounts = !turnRan ? mechanic("not exercised", { ...ev5, note: "the turn did not run" })
    : lines.length ? mechanic("refuted", { ...ev5, note: `EROFS under a protected path: ${erofsPaths.join(", ") || "(no path in the lines)"}` })
    : checks.gemini_state_untouched === false ? mechanic("refuted", { ...ev5, note: "a host ~/.gemini path the jail can write changed during the run" })
    : checks.gemini_state_untouched === null ? mechanic("unresolved", { ...ev5, note: "host ~/.gemini changed during the run where the jail could not write by path (or through a hard-linked file): not attributed, so not confirmed untouched" })
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
    checks: { forbidden_denied: null, allowed_written: null, mcp_called: null, verify_ran: null, gemini_state_untouched: null }, check_evidence: null,
    mcp: { shim_calls: [], mock_subagent_turns: 0, api_calls: 0 }, tools_run: [], turn: { exit_code: null, status: null, num_turns: null, usage: null, error: null },
    startup_errors: [], deprecations: [], diagnostics: emptyDiag(), stderr_tail: null, log_tail: null, owner_stated_mechanics: null, gemini_state: null,
    aborted: null, kept: null, kept_contains_credentials: null };
  // The host snapshots (taken once the fake/real HOME is known): an abort still reports whether ~/.gemini was touched.
  let hostSnap = null;
  const abort = (reason, token = null, spent = "nothing: no model turn was started") => {
    if (hostSnap) {
      const changes = hostChanges(hostSnap.before, hostSnap.take(), hostSnap.roots, hostSnap.binds());
      summary.checks.gemini_state_untouched = untouchedBy(changes);
      if (summary.gemini_state) summary.gemini_state.host_changes = changes;
      else summary.gemini_state = { host_changes: changes };
    }
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
    const roots = { cli_state: cliState, config_projects: join(g, "config", "projects"), top: g };
    const before = take();
    let jailBinds = null;   // the bind list of the jail, once built: what a host change is classified against
    hostSnap = { before, take, roots, binds: () => jailBinds };
    const sandbox = { home };
    const env = workerEnv(a2a_env);

    // ONE jail for the preflight and the turn (the same control dir, workspace and state scratch).
    try { jail = await prepareWorkerJail({ cli, control_dir: ctl, worktree: wt, env, sandbox, a2a_socket: shim.socket }); }
    catch (e) { summary.gemini_state = { home_gemini: g, ...layoutView(null), error: { code: e.code ?? null, message: String(e.message ?? e).slice(0, 500) } }; return abort(`the jail could not be built (${e.code ?? "error"}): ${String(e.message ?? e).slice(0, 300)}`, token); }
    summary.launch.bwrap_binds = jail.sandboxRec.binds ?? null;
    jailBinds = jail.sandboxRec.binds ?? null;
    summary.launch.sandbox = { enabled: jail.sandboxRec.enabled, kind: jail.sandboxRec.kind ?? null, gemini_state: jail.sandboxRec.gemini_state ?? null };

    const pf = await runAgyPreflight({ cli, control_dir: ctl, worktree: wt, env: a2a_env, jail, model: LANE });
    summary.preflight = pf;
    summary.diagnostics = mergeDiag(summary.diagnostics, pf.diagnostics);
    summary.diagnostics.hooks_loaded.preflight = pf.diagnostics?.cli_log?.hooks_loaded ?? null;
    summary.diagnostics.workspace_dirs.preflight = pf.diagnostics?.workspace_dirs ?? null;
    summary.diagnostics.cli_log.preflight = pf.diagnostics?.cli_log ?? null;
    if (!pf.ok) {
      const scratch = await dropGeminiState(jail.gstate, { keep }).catch(() => null);
      const after = take();
      summary.gemini_state = { home_gemini: g, ...layoutView(jail.gstate), before: { cli_state: before.cli_state, config_projects: before.config_projects, top_files: before.top },
        after: { cli_state: after.cli_state, config_projects: after.config_projects, top_files: after.top }, scratch_written: scratch, host_changes: [], host_agy_processes: null };
      if (keep) { summary.kept = root; summary.kept_contains_credentials = Boolean(jail.gstate?.scratch_root); }
      jail = null;
      return abort(`preflight failed: ${pf.failed.map(k => `${k} (${pf.checks[k].why})`).join("; ")}`, token, "nothing: preflight failed before any model turn");
    }

    // The agy processes on the HOST around the turn: a concurrent agy outside the jail is a possible writer of host state.
    const procsBefore = await hostAgyProcesses();
    let r = null, err = null;
    try { r = await runAgyWorkerTurn({ cli, control_dir: ctl, worktree: wt, model: LANE, prompt: probePrompt(wt), timeoutS, env: a2a_env, a2a_socket: shim.socket, sandbox, jail }); }
    catch (e) { err = e; }
    const res = r ?? err ?? {};
    const procsAfter = await hostAgyProcesses();
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
    const tc = turnChecks({ rows, steps, worktree: wt, workerVerify: ws.worker_verify_cmd, forbiddenAbsent: forbidden_absent, allowedContent: allowed, shimCalls });
    const changes = hostChanges(before, after, roots, res.sandbox?.binds ?? jailBinds);
    summary.checks = {
      forbidden_denied: tc.forbidden_denied,
      allowed_written: tc.allowed_written,
      mcp_called: tc.mcp_called,
      verify_ran: tc.verify_ran,
      gemini_state_untouched: untouchedBy(changes),
    };
    summary.check_evidence = tc.evidence;
    summary.mcp = { shim_calls: shimCalls, mock_subagent_turns: mockTurns, api_calls: 0, socket_inside_bwrap: res.sandbox?.kind === "bwrap" };
    summary.tools_run = steps;
    summary.turn = { exit_code: res.exit_code ?? null, status: r ? r.status ?? null : res.result_status ?? null, num_turns: res.num_turns ?? null, usage: res.usage ?? null,
      error: err ? { code: err.code ?? null, kind: err.kind ?? null, message: String(err.message ?? err).slice(0, 500) } : null };
    // The --log-file, then what the CLI wrote to its log/ dir during the turn (read by runAgyWorkerTurn before cleanup).
    const logText = `${await readFile(ws.agy_log, "utf8").catch(() => "")}${res.cli_log?.tail ? `\n${res.cli_log.tail}` : ""}`;
    const stderrText = res.stderr_tail ?? "";
    summary.startup_errors = startupErrors({ logText, stderrText, toolSteps: steps.length });
    summary.deprecations = deprecationsOf({ logText, stderrText });
    summary.diagnostics = mergeDiag(summary.diagnostics, diagnosticLines(`${stderrText}\n${logText}`, env));
    const turnHooks = res.cli_log?.hooks_loaded ?? (h => (h ? { named: h.named, files: h.files, sources: null } : null))(parseHooksLoaded(`${stderrText}\n${logText}`));
    summary.diagnostics.hooks_loaded.turn = turnHooks ?? null;
    summary.diagnostics.workspace_dirs.turn = res.cli_log?.workspace_dirs ?? null;
    summary.diagnostics.cli_log.turn = cliLogView(res.cli_log);
    summary.stderr_tail = tail(res.stderr_tail ?? null);
    summary.log_tail = tail(logText);
    summary.gemini_state = { home_gemini: g, ...layout, before: { cli_state: before.cli_state, config_projects: before.config_projects, top_files: before.top },
      after: { cli_state: after.cli_state, config_projects: after.config_projects, top_files: after.top }, scratch_written: scratch,
      host_changes: changes, unresolved_host_changes: unresolvedOf(changes), host_agy_processes: { before: procsBefore, after: procsAfter } };
    let mcpConfig = null;
    try { mcpConfig = JSON.parse(readFileSync(ws.mcp_config, "utf8")); } catch { /* reported as not eager */ }
    summary.owner_stated_mechanics = judge({ rows, steps, shimCalls, checks: { ...summary.checks, forbidden_absent }, turnRan: Boolean(res.launch) && res.exit_code !== undefined,
      turnOk: Boolean(r), launchArgs, agentsDir: join(ws.control_dir, ".agents"), mcpConfig, scratch,
      stderrText, logText, hookPaths: { command: ws.hook_command }, worktree: wt });
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

// Run only as a script: the tests import the pure readers above (toolCallsOf, turnChecks, hostChanges, parseAgyProcesses).
const self = fileURLToPath(import.meta.url);
const realOr = p => { try { return realpathSync(p); } catch { return p; } };
if (process.argv[1] && realOr(process.argv[1]) === realOr(self)) {
  main().catch(e => {
    process.stdout.write(JSON.stringify({ schema: SCHEMA, aborted: { reason: `the probe failed: ${String(e?.message ?? e).slice(0, 500)}` } }, null, 2) + "\n");
    process.exitCode = 1;
  });
}
