// THE COVERAGE GATE of a review run (self-audit round 3, assignment 4 (sealed fe2a612), L-501; owner plan step 3).
//
// A review that read no source, whose reads were refused, or that ran no test where its testing limit allows tests, is
// not a finished review, whatever the reviewer's final message says. Before this gate a run was `complete` as soon as
// the transport produced a final text (index.mjs: `state.final !== null`; subscription.mjs: the transport's own
// "final answer") -- the 09d490f run of assignment 4 read no source at all and was `complete`.
//
// coverage {source_reads, denied_reads, tests_run, files_read_sample, tests_allowed, tests_refused, method, ...} is
// derived per transport from what the runner itself observed, never from the reviewer's account:
//   api        the runner's own tool events (transcript.events tool_call): read_file ok -> a source read; a read_file /
//              list_files / grep refused for a path rule (not "no such path") -> a denied read; run_tests / run_suite
//              whose process ran in the verify jail (an exit code other than VERIFY_JAIL_REFUSED) -> a test run
//   agy-cli    the PreToolUse hook's decisions (jail.log) and the stream's tool steps: an approved file-read tool on a
//              worktree file -> a source read; a read tool the hook denied -> a denied read; an approved run_command
//              (a verify launcher) that finished (step DONE) -> a test run; a tool step the hook never approved
//              (`unhooked`) or an advertised tool the hook does not classify (`tool_drift`) -> incomplete
//   codex-sdk  the SDK's command_execution items: a read command (cat, sed -n, head, ...) that exited 0 -> a source read;
//              a command whose output says the sandbox refused it -> a denied read; no test (the transport runs none, L-404)
//   grok-cli   the stream's tool calls: read_file completed, or a read-only shell command completed -> a source read; a
//              read tool or read command that failed for a permission / cancellation -> a denied read; a verify launcher
//              command completed -> a test run
// coverageGate(coverage) -> {ok, reasons}: not ok when source_reads is 0, when denied_reads > 0, when tests_allowed and
// tests_run is 0 (tests_refused says why when the transport refused them), when unhooked steps or tool drift were seen.
// A run whose transport said "complete" and whose gate is not ok is `incomplete` (stop_reason: "coverage gate: ...").
import { READ_TOOLS, REVIEW_SUITE_LAUNCHER, REVIEW_TEST_LAUNCHER } from "../agy/jail-hook.mjs";
import { VERIFY_JAIL_REFUSED } from "../agy/verify-jail.mjs";
import { READ_ONLY_SHELL, REVIEW_TESTS_DIR } from "./cli-common.mjs";

export const COVERAGE_SCHEMA = "ophanim.review-coverage/v1";
const SAMPLE = 20;
/** The file-reading tools of agy (a listing or a search is not a read of a source file). */
export const AGY_FILE_READ_TOOLS = Object.freeze(["view_file", "read_file", "view_file_outline", "view_code_item"]);
const AGY_PATH_KEYS = ["AbsolutePath", "TargetFile", "File", "FilePath", "Path"];
const isSource = rel => typeof rel === "string" && rel !== "" && !rel.startsWith(`${REVIEW_TESTS_DIR}/`) && !rel.split("/").includes("..");
const relTo = (root, p) => (typeof p === "string" && root && (p === root || p.startsWith(root + "/")) ? p.slice(root.length + 1) : null);
const sample = set => [...set].sort().slice(0, SAMPLE);

/** Does the assignment's testing limit allow tests? (Every limit the runner knows lists run_tests.) */
export const testsAllowedBy = permissions => Boolean(permissions?.run_tests) && (permissions.tools ?? ["run_tests"]).includes("run_tests");

function result({ method, reads, denied, tests, tests_allowed, tests_refused = null, extra = {} }) {
  return { schema: COVERAGE_SCHEMA, method, source_reads: reads.size, denied_reads: denied.length, tests_run: tests, files_read_sample: sample(reads),
    denied_sample: denied.slice(0, SAMPLE), tests_allowed: Boolean(tests_allowed), tests_refused, ...extra };
}

/** The API runner (index.mjs): the transcript's tool_call events. */
export function coverageOfApi(events = [], { tests_allowed }) {
  const reads = new Set(), denied = [];
  let tests = 0;
  for (const e of events) {
    if (e?.type !== "tool_call") continue;
    const path = typeof e.args?.path === "string" ? e.args.path.replace(/^\.\//, "") : null;
    if (e.name === "read_file" && e.outcome === "ok" && isSource(path)) reads.add(path);
    if (["read_file", "list_files", "grep"].includes(e.name) && e.outcome === "refused" && !/no such path|not a file|not a directory|must be|arguments must|max_tool_calls/i.test(String(e.result_text ?? "")))
      denied.push({ tool: e.name, path, why: String(e.result_text ?? "").slice(0, 200) });
    if ((e.name === "run_tests" || e.name === "run_suite") && e.outcome === "ok" && Number.isInteger(e.exit_code) && e.exit_code !== VERIFY_JAIL_REFUSED) tests++;
  }
  return result({ method: "api: the runner's own tool events (read_file, run_tests, run_suite in the verify jail)", reads, denied, tests, tests_allowed });
}

/** The agy transport: the hook's decisions and the stream's tool steps (subscription.mjs runAgy's record). */
export function coverageOfAgy({ jail_decisions = [], tool_steps = [], tool_drift = null } = {}, { worktree, tests_allowed }) {
  const reads = new Set(), denied = [];
  let approvedRuns = 0;
  for (const d of jail_decisions) {
    const tool = d?.tool;
    if (READ_TOOLS.includes(tool) && d.decision === "deny") denied.push({ tool, path: AGY_PATH_KEYS.map(k => d.args?.[k]).find(Boolean) ?? null, why: String(d.reason ?? "").slice(0, 200) });
    if (AGY_FILE_READ_TOOLS.includes(tool) && d.decision === "auto_approve") {
      const rel = relTo(worktree, AGY_PATH_KEYS.map(k => d.args?.[k]).find(v => typeof v === "string"));
      if (isSource(rel)) reads.add(rel);
    }
    if (tool === "run_command" && d.decision === "auto_approve") approvedRuns++;
  }
  const doneRuns = tool_steps.filter(s => s?.tool_name === "run_command" && s.state === "DONE").length;
  const unhooked = tool_drift?.unhooked ?? [];
  return result({ method: "agy-cli: the PreToolUse hook's decisions (jail.log) and the stream's tool steps", reads, denied, tests: Math.min(approvedRuns, doneRuns), tests_allowed,
    extra: { unhooked, tool_drift: tool_drift ? { ok: tool_drift.ok, unclassified: tool_drift.unclassified ?? [], methods: tool_drift.methods ?? [] } : null } });
}

const READ_CMD = new RegExp(`(^|[\\s;&|('"])(${READ_ONLY_SHELL.filter(c => !/^git |^(ls|find|stat|file|wc|diff|cmp)$/.test(c)).map(c => c.replace(/ /g, "\\s+")).join("|")})\\s+`);
const FILE_ARG = /(?:^|\s|['"])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})(?=$|[\s'":])/g;
const filesOf = (cmd, worktree) => [...String(cmd).matchAll(FILE_ARG)].map(m => (m[1].startsWith("/") ? relTo(worktree, m[1]) : m[1])).filter(isSource);

/** The codex transport: the SDK's command_execution items (codex.mjs applyCodexEvent: {command, exit_code, status, denied}). */
export function coverageOfCodex({ commands = [] } = {}, { worktree, tests_allowed, tests_refused }) {
  const reads = new Set(), denied = [];
  for (const c of commands) {
    const cmd = String(c?.command ?? "");
    if (c?.denied) { denied.push({ tool: "command_execution", path: null, why: cmd.slice(0, 200) }); continue; }
    if (c?.exit_code === 0 && READ_CMD.test(cmd)) { const f = filesOf(cmd, worktree); for (const x of f) reads.add(x); if (!f.length) reads.add(`(a read command) ${cmd.slice(0, 80)}`); }
  }
  return result({ method: "codex-sdk: the SDK's command_execution items", reads, denied, tests: 0, tests_allowed, tests_refused });
}

/** The grok transport: the stream's tool calls (grok.mjs parseGrokStream tool_calls). */
export function coverageOfGrok({ tool_calls = [], advertised_tools = null } = {}, { worktree, control_dir, tests_allowed }) {
  const reads = new Set(), denied = [];
  let tests = 0;
  const launcher = control_dir ? [`${control_dir}/${REVIEW_TEST_LAUNCHER}`, `${control_dir}/${REVIEW_SUITE_LAUNCHER("")}`] : [];
  for (const t of tool_calls) {
    const ok = t?.status === "completed", failed = /fail|cancel/i.test(String(t?.status ?? "")) || Boolean(t?.message);
    const isRead = t?.kind === "read" || /read_file|view|list_dir|grep|search/i.test(String(t?.name ?? ""));
    const cmd = String(t?.command ?? "");
    if (isRead && failed && /cancel|denied|not allowed|permission/i.test(String(t?.message ?? ""))) denied.push({ tool: t.name, path: t.path ?? null, why: String(t.message ?? "").slice(0, 200) });
    else if (cmd && failed && READ_CMD.test(cmd) && /cancel|denied|not allowed|permission/i.test(String(t?.message ?? ""))) denied.push({ tool: t.name, path: null, why: String(t.message ?? "").slice(0, 200) });
    if (ok && /read_file|view/i.test(String(t?.name ?? ""))) { const rel = String(t.path ?? "").startsWith("/") ? relTo(worktree, t.path) : t.path; if (isSource(rel)) reads.add(rel); }
    if (ok && cmd && READ_CMD.test(cmd)) for (const f of filesOf(cmd, worktree)) reads.add(f);
    if (ok && cmd && launcher.some(l => cmd.trim().startsWith(l))) tests++;
  }
  return result({ method: "grok-cli: the stream's tool calls (tool_call / tool_call_update)", reads, denied, tests, tests_allowed, extra: { advertised_tools } });
}

/**
 * A continued review's coverage: the earlier runs' record (`prior`, from the continued transcript) added to this run's.
 * Counts add up; the file sample is the union; a denial or an unhooked step of an earlier run still counts.
 */
export function mergeCoverage(prior, cur) {
  if (!prior || prior.schema !== COVERAGE_SCHEMA) return cur;
  return { ...cur, source_reads: (prior.source_reads ?? 0) + cur.source_reads, denied_reads: (prior.denied_reads ?? 0) + cur.denied_reads, tests_run: (prior.tests_run ?? 0) + cur.tests_run,
    files_read_sample: [...new Set([...(prior.files_read_sample ?? []), ...cur.files_read_sample])].sort().slice(0, SAMPLE),
    denied_sample: [...(prior.denied_sample ?? []), ...cur.denied_sample].slice(0, SAMPLE),
    ...(cur.unhooked || prior.unhooked ? { unhooked: [...(prior.unhooked ?? []), ...(cur.unhooked ?? [])] } : {}), cumulative_runs: (prior.cumulative_runs ?? 1) + 1 };
}

/** {ok, reasons: [...]} for a coverage record (see the header). */
export function coverageGate(cov) {
  const reasons = [];
  if (!cov) return { ok: false, reasons: ["no coverage record"] };
  if (!cov.source_reads) reasons.push("no source file was read");
  if (cov.denied_reads) reasons.push(`${cov.denied_reads} read(s) were denied by the hook or the sandbox`);
  if (cov.tests_allowed && !cov.tests_run) reasons.push(cov.tests_refused ? `no test ran although the testing limit allows tests: ${cov.tests_refused}` : "no test command ran although the testing limit allows tests");
  if (cov.unhooked?.length) reasons.push(`tool steps the hook never approved: ${cov.unhooked.map(u => `${u.tool} (${u.done} done, ${u.approved} approved)`).join(", ")}`);
  if (cov.tool_drift && cov.tool_drift.ok === false) reasons.push(`tools the hook does not classify: ${cov.tool_drift.unclassified.map(u => u.name).join(", ")}`);
  return { ok: reasons.length === 0, reasons };
}

/** The findings header's coverage line. */
export function coverageHeaderLine(cov, gate) {
  if (!cov) return "not recorded";
  const f = cov.files_read_sample.length ? `; files read (sample): ${cov.files_read_sample.map(x => `\`${String(x).replace(/`/g, "'")}\``).join(", ")}` : "";
  return `\`${JSON.stringify({ source_reads: cov.source_reads, denied_reads: cov.denied_reads, tests_run: cov.tests_run, tests_allowed: cov.tests_allowed })}\`, gate ${gate.ok ? "passed" : `FAILED (${gate.reasons.join("; ")})`}${f}`;
}

/** Apply the gate to a transport's status: a `complete` run whose gate fails is `incomplete`. */
export function gatedStatus(status, stop_reason, gate) {
  if (status !== "complete" || gate.ok) return { status, stop_reason };
  return { status: "incomplete", stop_reason: `coverage gate: ${gate.reasons.join("; ")} (the transport ended with: ${stop_reason})` };
}
