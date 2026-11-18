#!/usr/bin/env node
// THE PRE-MUTATION JAIL: an Antigravity PreToolUse hook (registered in <control_dir>/.agents/hooks.json through the
// per-unit wrapper <control_dir>/pantheon-jail-hook, which runs `node jail-hook.mjs <jail.json>`).
//
// Reads the hook input JSON on stdin (documented fields: toolCall.name, toolCall.args — e.g. TargetFile, CommandLine,
// Cwd — stepIdx, conversationId, workspacePaths, transcriptPath, modelName; a few other plausible spellings of the
// name/args are read too, see toolCallOf) and prints EXACTLY ONE decision line on stdout, then exits 0.
//
// HOOK SEMANTICS (OWNER-STATED 2026-11-18, not in the docs we read; scripts/agy-worker-probe.mjs confirms or refutes):
//   - agy IGNORES hook exit codes; an EMPTY stdout ALLOWS the tool; `{}` DENIES it.
//   - headless `--mode=accept-edits` soft-denies Ask-tier tools (run_command, MCP) when a hook answers only "allow".
//   Therefore this hook always prints one explicit decision: "auto_approve" or "deny" (never "allow", never nothing),
//   and every code path — an unreadable or non-JSON jail.json, stdin that is not JSON, a policy missing fields, a
//   thrown error, an unhandled rejection, a stdout write error, stdin that never closes — ends in a printed deny with
//   exit code 0. Printing nothing would FAIL OPEN.
//
// THE DECISION TABLE (decide(policy, payload)):
//   write tools (WRITE_TOOLS: write_file, write_to_file, replace_file_content, multi_replace_file_content)
//       the target is the FIRST PRESENT of args.Path, args.TargetFile, args.AbsolutePath, args.File (WRITE_PATH_KEYS;
//       OBSERVED on agy 1.5.10, owner's machine, 2026-11-18: the real write tool is `write_file` with args {Path,
//       Content}, emitted although the card listed write_to_file; the hook denied it as an unknown tool, so the owned
//       write was blocked too and the forbidden-write deny proved nothing about the owned-path policy). auto_approve
//       ONLY when that target is an absolute path that, resolved WITHOUT following a final symlink and with every
//       intermediate symlink resolved, stays inside the worktree, is not inside .git or .agents, and is matched by the
//       unit's owned_paths (pipeline/paths.mjs matchesOwned) both as written and as resolved; else deny.
//   run_command
//       auto_approve ONLY when args.CommandLine (trimmed) equals the unit's WORKER verify command exactly -- the policy's
//       worker_verify_cmd, i.e. workerVerifyCommand(worktree, verify_cmd) = `cd '<worktree>' && <verify_cmd>` -- and
//       args.Cwd, if given, resolves to the worktree; else deny. (OBSERVED on agy 1.5.10, 2026-11-18: the run_command
//       payload carries only {CommandLine, WaitMsBeforeAsync, toolSummary}: there is no Cwd to request, so the one
//       command the worker may run sets its own directory. The plain verify_cmd is DENIED: it would run wherever the
//       CLI happens to run commands.)
//   run_command under a REVIEW policy (jail.json carries `run_command_policy`; absent -> the worker rule above, unchanged)
//       {kind: "node-test", allowed_files_glob: [...], files: [...] | null, max_files, suites: {<name>: <exact command>}}:
//       auto_approve ONLY a CommandLine (trimmed) that equals one of `suites`' commands exactly, or that is exactly
//       `cd '<worktree>' && node --test <f1> [<f2> ...]` (decideReviewCommand: one space between files, each a plain
//       worktree-relative path of [A-Za-z0-9_./-] not starting with '-', no '.', '..', .git or .agents segment, an
//       existing regular file whose real path stays inside the worktree, listed in `files` when given, else matched by
//       `allowed_files_glob`, both as written and as resolved); Cwd as for the worker; else deny. Used by the review
//       runner (src/review-runner/agy.mjs): no shell metacharacter can reach the command, so it runs nothing else.
//   read tools (READ_TOOLS)
//       auto_approve (not "allow": owner-stated, "allow" may be soft-denied) when every path argument resolves inside
//       the worktree or the control dir; deny otherwise, and deny when no path argument is found.
//   MCP, OWNER-STATED: tools are lazy-loaded by default and called through the built-in `call_mcp_tool` with args
//   {ServerName, ToolName, Arguments}; with `tools.ask_subagent.eager = true` in mcp_config.json the tool may instead be
//   called directly (its name spelled as one of MCP_NAMES, args {role, question}). BOTH forms are auto_approved ONLY
//   for server pantheon-subagents, tool ask_subagent, and a `role` (Arguments.role / args.role) in the unit's roles;
//   any other server, tool or role -> deny.
//   invoke_subagent, define_subagent (native subagents would escape the jail) -> hard deny.
//   anything else (unknown tools, malformed input) -> deny.
//
// Every invocation is appended as ONE JSON line to <control_dir>/run/jail.log (the policy's `log`, or run/jail.log
// next to jail.json when the policy cannot be read): the raw stdin verbatim, the parsed payload when it parses, the
// hook's cwd (owner-stated: agy runs hooks with cwd = .agents/), the decision and its reason. That file is the ONLY one
// this hook writes; a logging failure never changes or delays the decision (the decision is printed first).
// There is no PostToolUse audit hook any more: under these semantics a post-tool hook's output is meaningless and
// risky; the audit is the PreToolUse log.
import { appendFileSync, lstatSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesOwned } from "../pipeline/paths.mjs";
import { matchGlob } from "../review-runner/sandbox.mjs";

export const WRITE_TOOLS = Object.freeze(["write_file", "write_to_file", "replace_file_content", "multi_replace_file_content"]);
/** The argument naming a write's target: the FIRST PRESENT of these wins (observed on agy 1.5.10: write_file {Path, Content}). */
export const WRITE_PATH_KEYS = Object.freeze(["Path", "TargetFile", "AbsolutePath", "File"]);
/** Single-quote a word for a POSIX shell (always quoted: the result is compared byte for byte). */
export const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
/**
 * THE ONE COMMAND A WORKER MAY RUN: `cd '<worktree>' && <verify_cmd>` (verify_cmd trimmed). run_command has no Cwd
 * (observed on agy 1.5.10), so the command sets its own directory. The same string goes into the prompt and jail.json.
 */
export function workerVerifyCommand(worktree, verify_cmd) {
  if (typeof worktree !== "string" || !isAbsolute(worktree)) throw Object.assign(new Error(`workerVerifyCommand: the worktree must be an absolute path, not ${JSON.stringify(worktree)}`), { code: "BAD_INPUT" });
  if (typeof verify_cmd !== "string" || !verify_cmd.trim()) return null;
  return `cd ${shQuote(worktree)} && ${verify_cmd.trim()}`;
}
// Read-only tools of the Antigravity/Cascade tool family whose path arguments the jail can check.
export const READ_TOOLS = Object.freeze(["view_file", "grep_search", "list_dir", "find_by_name", "view_file_outline", "view_code_item", "codebase_search"]);
export const MCP_SERVER = "pantheon-subagents", MCP_TOOL = "ask_subagent";
export const MCP_WRAPPER = "call_mcp_tool";   // owner-stated: the built-in lazy MCP caller
export const HARD_DENY = Object.freeze(["invoke_subagent", "define_subagent"]);
// Undocumented: the spelling of an eagerly loaded MCP tool's name in toolCall.name. Every plausible spelling of THIS
// tool is accepted; anything else that looks like an MCP tool is denied as "another MCP tool".
export const MCP_NAMES = Object.freeze([MCP_TOOL, `${MCP_SERVER}/${MCP_TOOL}`, `${MCP_SERVER}__${MCP_TOOL}`, `mcp__${MCP_SERVER}__${MCP_TOOL}`,
  `${MCP_SERVER}.${MCP_TOOL}`, `${MCP_SERVER}:${MCP_TOOL}`, `mcp_${MCP_SERVER}_${MCP_TOOL}`, `mcp:${MCP_SERVER}:${MCP_TOOL}`]);
const READ_KEYS = ["AbsolutePath", "TargetFile", "File", "FilePath", "Path", "SearchPath", "SearchDirectory", "DirectoryPath", "Directory", "TargetDirectories", "Paths"];
const FORBIDDEN_SEGMENTS = [".git", ".agents"];
export const STDIN_TIMEOUT_MS = 20000;   // under the 30 s hook timeout in hooks.json: a stuck stdin is a deny, not a kill
const RAW_LOG_CAP = 1024 * 1024;

const inside = (root, p) => p === root || p.startsWith(root + sep);
const realOr = p => { try { return realpathSync(p); } catch { return null; } };
const deny = reason => ({ decision: "deny", reason });
const approve = reason => ({ decision: "auto_approve", reason });
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const msg = e => String(e?.message ?? e).slice(0, 300);

/** The real path a write to `abs` lands on, resolving intermediate symlinks; a final symlink is refused. */
function landing(root, abs) {
  const rel = relative(root, abs);
  const segs = rel === "" ? [] : rel.split(sep);
  let cur = root;
  for (let i = 0; i < segs.length; i++) {
    const next = join(cur, segs[i]);
    let st;
    try { st = lstatSync(next); } catch { return { real: join(next, ...segs.slice(i + 1)) }; }
    if (st.isSymbolicLink()) {
      if (i === segs.length - 1) return { why: `${abs} is a symlink: the jail does not write through a final symlink` };
      const r = realOr(next);
      if (!r || !inside(root, r)) return { why: `${join(...segs.slice(0, i + 1))} is a symlink that leaves the worktree (to ${r ?? "a missing target"})` };
      cur = r;
    } else {
      if (i === segs.length - 1 && st.isDirectory()) return { why: `${abs} is a directory` };
      cur = next;
    }
  }
  return { real: cur };
}
const forbidden = rel => rel.split(/[\\/]/).map(s => s.toLowerCase()).find(s => FORBIDDEN_SEGMENTS.includes(s));

/** Map a path written against the worktree as given (not real) onto the real worktree root. */
function onRoot(policy, p) {
  const n = resolve(p);
  for (const base of [policy.worktree, policy.worktree_given].filter(Boolean)) if (inside(base, n)) return join(policy.worktree, relative(base, n));
  return n;
}

/** {key, value} of the first present WRITE_PATH_KEYS argument, or null. */
export function writeTargetOf(args) {
  if (!isObj(args)) return null;
  const key = WRITE_PATH_KEYS.find(k => args[k] !== undefined && args[k] !== null);
  return key ? { key, value: args[key] } : null;
}

export function decideWrite(policy, args) {
  const t = writeTargetOf(args);
  if (!t) return deny(`the write names no target (${WRITE_PATH_KEYS.join(", ")})`);
  const target = t.value;
  if (typeof target !== "string" || !target.trim()) return deny(`the write's ${t.key} is not a path`);
  if (!isAbsolute(target)) return deny(`${t.key} "${target}" is not absolute; the jail resolves absolute paths only`);
  const root = policy.worktree, abs = onRoot(policy, target);
  if (!inside(root, abs) || abs === root) return deny(`${target} is outside the unit's worktree ${root}`);
  const rel = relative(root, abs).split(sep).join("/");
  const seg = forbidden(rel);
  if (seg) return deny(`${rel} is inside ${seg}: never written by a worker`);
  const land = landing(root, abs);
  if (land.why) return deny(land.why);
  if (!inside(root, land.real)) return deny(`${target} resolves to ${land.real}, outside the worktree`);
  const realRel = relative(root, land.real).split(sep).join("/");
  const seg2 = forbidden(realRel);
  if (seg2) return deny(`${rel} resolves into ${seg2}`);
  if (!matchesOwned(rel, policy.owned_paths) || !matchesOwned(realRel, policy.owned_paths)) return deny(`${rel}${realRel !== rel ? ` (resolved ${realRel})` : ""} is not one of the unit's owned paths (${policy.owned_paths.join(", ")})`);
  return approve(`${rel} is owned by unit ${policy.unit_id}`);
}

export function decideCommand(policy, args) {
  const cmd = typeof args?.CommandLine === "string" ? args.CommandLine.trim() : null;
  if (!cmd) return deny("run_command names no CommandLine");
  if (typeof policy.verify_cmd !== "string" || !policy.verify_cmd.trim()) return deny("this unit allows no command (no verify_cmd)");
  // The worker command as written into jail.json (a policy without one: derived from the real worktree, the same way).
  const want = typeof policy.worker_verify_cmd === "string" && policy.worker_verify_cmd.trim() ? policy.worker_verify_cmd.trim() : workerVerifyCommand(policy.worktree, policy.verify_cmd);
  if (cmd !== want) return deny(`only the unit's verify_cmd may run, exactly as the worker command ${JSON.stringify(want)}, not ${JSON.stringify(cmd)}`);
  if (args.Cwd !== undefined && args.Cwd !== null && args.Cwd !== "") {
    if (typeof args.Cwd !== "string" || !isAbsolute(args.Cwd)) return deny(`Cwd ${JSON.stringify(args.Cwd)} is not an absolute path`);
    const r = realOr(args.Cwd);
    if (r !== policy.worktree) return deny(`verify_cmd runs in the worktree ${policy.worktree}, not in ${args.Cwd}`);
  }
  return approve("the unit's worker verify command");
}

/** The exact prefix of a review's node --test command: `cd '<worktree>' && node --test ` (the real worktree). */
export const reviewTestPrefix = worktree => `cd ${shQuote(worktree)} && node --test `;
const REVIEW_TEST_FILE = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;

/** run_command under a review's run_command_policy (see the decision table). */
export function decideReviewCommand(policy, rcp, args) {
  const cmd = typeof args?.CommandLine === "string" ? args.CommandLine.trim() : null;
  if (!cmd) return deny("run_command names no CommandLine");
  if (!isObj(rcp) || rcp.kind !== "node-test") return deny(`unknown run_command_policy ${JSON.stringify(rcp?.kind ?? null)}: no command is allowed`);
  if (args.Cwd !== undefined && args.Cwd !== null && args.Cwd !== "") {
    if (typeof args.Cwd !== "string" || !isAbsolute(args.Cwd)) return deny(`Cwd ${JSON.stringify(args.Cwd)} is not an absolute path`);
    if (realOr(args.Cwd) !== policy.worktree) return deny(`review commands run in the worktree ${policy.worktree}, not in ${args.Cwd}`);
  }
  const suites = isObj(rcp.suites) ? Object.entries(rcp.suites).filter(([, c]) => typeof c === "string" && c.trim()) : [];
  const suite = suites.find(([, c]) => c.trim() === cmd);
  if (suite) return approve(`the review suite command "${suite[0]}"`);
  const prefix = reviewTestPrefix(policy.worktree);
  if (!cmd.startsWith(prefix)) return deny(`only the review's listed commands may run (${prefix}<test files>${suites.length ? ` or a listed suite command` : ""}), not ${JSON.stringify(cmd)}`);
  const files = cmd.slice(prefix.length).split(" ");
  const max = Number.isSafeInteger(rcp.max_files) && rcp.max_files > 0 ? rcp.max_files : 50;
  if (files.length > max) return deny(`at most ${max} test files per command`);
  const listed = Array.isArray(rcp.files) ? rcp.files : null;
  const globs = Array.isArray(rcp.allowed_files_glob) ? rcp.allowed_files_glob.filter(g => typeof g === "string") : [];
  const allowed = rel => (listed ? listed.includes(rel) : globs.some(g => matchGlob(g, [rel]).length > 0));
  for (const f of files) {
    if (!REVIEW_TEST_FILE.test(f)) return deny(`test file ${JSON.stringify(f)} is not a plain worktree-relative path (letters, digits, _ . / - only, one space between files)`);
    const segs = f.split("/");
    if (segs.some(s => s === "" || s === "." || s === "..")) return deny(`test file ${f}: empty, '.' or '..' segments are refused`);
    const seg = forbidden(f);
    if (seg) return deny(`test file ${f} is inside ${seg}`);
    if (!allowed(f)) return deny(`${f} is not ${listed ? "one of the test files this review lists" : `matched by the review's allowed test files (${globs.join(", ")})`}`);
    const abs = join(policy.worktree, ...segs);
    const r = realOr(abs);
    if (!r) return deny(`test file ${f} does not exist`);
    if (!inside(policy.worktree, r) || r === policy.worktree) return deny(`test file ${f} resolves to ${r}, outside the worktree`);
    let st; try { st = lstatSync(r); } catch { return deny(`test file ${f} cannot be read`); }
    if (!st.isFile()) return deny(`test file ${f} is not a regular file`);
    const realRel = relative(policy.worktree, r).split(sep).join("/");
    if (forbidden(realRel) || !allowed(realRel)) return deny(`test file ${f} resolves to ${realRel}, which is not allowed`);
  }
  return approve(`node --test on ${files.length} allowed test file(s)`);
}

export function decideRead(policy, args) {
  const paths = READ_KEYS.flatMap(k => (Array.isArray(args?.[k]) ? args[k] : [args?.[k]])).filter(v => typeof v === "string" && v.trim());
  if (!paths.length) return deny("a read names no path argument the jail can check");
  const roots = [policy.worktree, policy.control_dir].filter(Boolean);
  for (const p of paths) {
    if (!isAbsolute(p)) return deny(`read path "${p}" is not absolute`);
    const abs = onRoot(policy, p);
    // The deepest existing ancestor's real path decides (a symlink inside a root that points out is caught here).
    let at = abs, r = null;
    while (!(r = realOr(at)) && at !== resolve(at, "..")) at = resolve(at, "..");
    const landed = r ? join(r, relative(at, abs)) : abs;
    if (!roots.some(root => inside(root, landed))) return deny(`${p} is outside the worktree and the control dir`);
  }
  return approve("a read inside the worktree or the control dir");
}

/** The MCP identity of a DIRECT (eager) tool call: {server, tool} when it looks like an MCP tool, else null. */
function mcpOf(call) {
  const name = call.name;
  const server = call.server ?? call.serverName ?? call.mcpServer ?? call.mcp_server ?? null;
  if (typeof server === "string") return { server, tool: call.tool ?? call.toolName ?? name };
  if (MCP_NAMES.includes(name)) return { server: MCP_SERVER, tool: MCP_TOOL };
  const m = /^(?:mcp(?:__|_|:))?([A-Za-z0-9_.-]+?)(?:__|\/|:|\.)([A-Za-z0-9_-]+)$/.exec(name);
  return m && (name.startsWith("mcp") || /__|\/|:/.test(name)) ? { server: m[1], tool: m[2] } : null;
}
const parsedArgs = v => {
  if (typeof v === "string") { try { const p = JSON.parse(v); return isObj(p) ? p : null; } catch { return null; } }
  return isObj(v) ? v : v == null ? {} : null;
};

/** One MCP call {form, server, tool, args} -> the decision. */
export function decideMcp(policy, { form, server, tool, args }) {
  const where = `${server}/${tool} (${form})`;
  if (server !== MCP_SERVER || tool !== MCP_TOOL) return deny(`MCP tool ${where} is not allowed (only ${MCP_SERVER}/${MCP_TOOL})`);
  if (policy.mcp && policy.mcp.enabled === false) return deny(`this unit has no ${MCP_SERVER} MCP server configured`);
  if (!isObj(args)) return deny(`${where}: its arguments are not a JSON object`);
  const role = args.role;
  if (typeof role !== "string" || !role) return deny(`${where}: names no role`);
  if (!policy.roles.includes(role)) return deny(`${where}: role "${role}" is not one of the unit's subagent roles (${policy.roles.join(", ") || "none"})`);
  return approve(`${MCP_SERVER}/${MCP_TOOL} role ${role} (${form})`);
}

/**
 * The tool call of a payload: {name, args, call} or null. Reads the documented toolCall.{name,args} first, then the
 * spellings other hook protocols use (tool_call, tool_name/tool_input, toolName/toolArgs); a string `args` is parsed.
 */
export function toolCallOf(payload) {
  if (!isObj(payload)) return null;
  const c = isObj(payload.toolCall) ? payload.toolCall : isObj(payload.tool_call) ? payload.tool_call : null;
  const name = c ? (c.name ?? c.toolName ?? c.tool_name) : (payload.tool_name ?? payload.toolName);
  if (typeof name !== "string" || !name) return null;
  const rawArgs = c ? (c.args ?? c.arguments ?? c.input) : (payload.tool_input ?? payload.toolArgs ?? payload.args);
  return { name, args: parsedArgs(rawArgs), call: c ?? { name } };
}

/** The MCP view of a call: {form: "call_mcp_tool" | "direct", server, tool, args} or null when it is not an MCP call. */
export function mcpCallOf(tc) {
  if (!tc) return null;
  if (tc.name === MCP_WRAPPER) {
    const a = tc.args ?? {};
    return { form: MCP_WRAPPER, server: typeof a.ServerName === "string" ? a.ServerName : null, tool: typeof a.ToolName === "string" ? a.ToolName : null, args: parsedArgs(a.Arguments) };
  }
  const m = mcpOf({ ...tc.call, name: tc.name });
  return m ? { form: "direct", server: m.server, tool: m.tool, args: tc.args } : null;
}

function checkPolicy(policy) {
  if (!isObj(policy)) throw new Error("the policy is not an object");
  for (const k of ["worktree"]) if (typeof policy[k] !== "string" || !policy[k]) throw new Error(`the policy lacks ${k}`);
  for (const k of ["owned_paths", "roles"]) if (!Array.isArray(policy[k])) throw new Error(`the policy lacks ${k}`);
}

function decideUnsafe(policy, payload) {
  checkPolicy(policy);
  const tc = toolCallOf(payload);
  if (!tc) return deny("malformed hook input: no toolCall.name");
  if (HARD_DENY.includes(tc.name)) return deny(`${tc.name} is not available to a unit worker: native subagents would escape the jail`);
  if (tc.args === null) return deny(`malformed hook input: the arguments of ${tc.name} are not a JSON object`);
  if (WRITE_TOOLS.includes(tc.name)) return decideWrite(policy, tc.args);
  if (tc.name === "run_command") return policy.run_command_policy !== undefined && policy.run_command_policy !== null ? decideReviewCommand(policy, policy.run_command_policy, tc.args) : decideCommand(policy, tc.args);
  if (READ_TOOLS.includes(tc.name)) return decideRead(policy, tc.args);
  const mcp = mcpCallOf(tc);
  if (mcp) return decideMcp(policy, mcp);
  return deny(`tool ${tc.name} is not allowed for a unit worker`);
}
/** The decision for one PreToolUse payload under `policy`. Never throws: an exception is a deny. */
export function decide(policy, payload) {
  try {
    const d = decideUnsafe(policy, payload);
    return d && (d.decision === "auto_approve" || d.decision === "deny") ? d : deny("hook exception: no decision");
  } catch (e) { return deny(`hook exception: ${msg(e)}`); }
}

export function loadPolicy(file) {
  const p = JSON.parse(readFileSync(file, "utf8"));
  checkPolicy(p);
  return { ...p, worktree_given: p.worktree_given ?? p.worktree, worktree: realOr(p.worktree) ?? p.worktree, control_dir: p.control_dir ? (realOr(p.control_dir) ?? p.control_dir) : null };
}

const summary = tc => {
  const a = isObj(tc?.args) ? tc.args : {};
  const pick = Object.fromEntries([...new Set(["TargetFile", "CommandLine", "Cwd", ...WRITE_PATH_KEYS, ...READ_KEYS, "ServerName", "ToolName"])].filter(k => typeof a[k] === "string").map(k => [k, a[k].slice(0, 500)]));
  return { tool: typeof tc?.name === "string" ? tc.name : null, args: pick };
};

// ---- the process ----------------------------------------------------------------------------------------------------

function main() {
  let printed = false;
  const emit = d => {
    if (printed) return;
    printed = true;
    const line = JSON.stringify(d) + "\n";
    try { writeSync(1, line); } catch { try { process.stdout.write(line); } catch { /* nothing more can be done */ } }
  };
  const failClosed = e => { emit(deny(`hook exception: ${msg(e)}`)); process.exitCode = 0; };
  try { process.stdout.on("error", () => {}); } catch { /* ignore */ }
  process.on("uncaughtException", failClosed);
  process.on("unhandledRejection", failClosed);
  process.on("exit", () => { if (!printed) emit(deny("hook exception: the hook ended without a decision")); process.exitCode = 0; });

  const file = process.argv[2];
  const fallbackLog = typeof file === "string" && file ? join(dirname(resolve(file)), "run", "jail.log") : null;
  const chunks = [];
  let done = false;
  const finish = (raw, stdinWhy = null) => {
    if (done) return;
    done = true;
    let policy = null, payload, parsed = false, out;
    try { payload = JSON.parse(raw); parsed = true; } catch { /* decided below */ }
    try {
      try { policy = loadPolicy(file); } catch (e) { throw new Error(`the jail policy ${file} could not be read: ${msg(e)}`); }
      if (stdinWhy) out = deny(`hook exception: ${stdinWhy}`);
      else if (!parsed) out = deny("malformed hook input: not JSON");
      else out = decide(policy, payload);
    } catch (e) { out = deny(`hook exception: ${msg(e)}`); }
    emit(out);                         // the decision first: the log can never delay or change it
    try {
      const tc = parsed ? toolCallOf(payload) : null;
      const mcp = tc ? mcpCallOf(tc) : null;
      const row = { at: new Date().toISOString(), event: "PreToolUse", unit_id: policy?.unit_id ?? null, cwd: process.cwd(),
        raw: raw.length > RAW_LOG_CAP ? raw.slice(0, RAW_LOG_CAP) : raw, ...(raw.length > RAW_LOG_CAP ? { raw_truncated: raw.length } : {}),
        payload: parsed ? payload : null, ...summary(tc), ...(mcp ? { mcp: { form: mcp.form, server: mcp.server, tool: mcp.tool, role: isObj(mcp.args) ? mcp.args.role ?? null : null } } : {}),
        step: isObj(payload) ? payload.stepIdx ?? null : null, decision: out.decision, reason: out.reason ?? null };
      const log = typeof policy?.log === "string" && policy.log ? policy.log : fallbackLog;
      if (log) appendFileSync(log, JSON.stringify(row) + "\n");
    } catch { /* the log is evidence, not the decision */ }
  };
  const timer = setTimeout(() => finish(Buffer.concat(chunks).toString("utf8"), `stdin did not close within ${STDIN_TIMEOUT_MS} ms`), STDIN_TIMEOUT_MS);
  process.stdin.on("data", c => { chunks.push(c); });
  process.stdin.on("end", () => { clearTimeout(timer); finish(Buffer.concat(chunks).toString("utf8")); });
  process.stdin.on("error", e => { clearTimeout(timer); finish(Buffer.concat(chunks).toString("utf8"), `stdin failed: ${msg(e)}`); });
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && (realOr(process.argv[1]) ?? process.argv[1]) === (realOr(self) ?? self)) {
  try { main(); } catch (e) {
    try { writeSync(1, JSON.stringify(deny(`hook exception: ${msg(e)}`)) + "\n"); } catch { /* ignore */ }
    process.exitCode = 0;
  }
}
