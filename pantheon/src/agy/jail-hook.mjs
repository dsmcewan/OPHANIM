#!/usr/bin/env node
// THE PRE-MUTATION WRITE JAIL: an Antigravity PreToolUse hook (registered in <control_dir>/.agents/hooks.json).
//
//   node jail-hook.mjs <jail.json> [pre|post]
//
// Reads the hook input JSON on stdin (documented fields: toolCall.name, toolCall.args — e.g. TargetFile, CommandLine,
// Cwd — stepIdx, conversationId, workspacePaths, transcriptPath, modelName) and prints ONE JSON decision on stdout
// (documented PreToolUse values: "allow", "auto_approve", "deny" — "Hard blocks execution immediately." — "ask",
// "force_ask", "deny_unless_prior_grant"; plus `reason`). It always exits 0: hook exit-code semantics are NOT
// documented, the decision JSON is the documented channel.
//
// The policy (jail.json, written by workspace.mjs, read-only inside the sandbox):
//   write tools (write_to_file, replace_file_content, multi_replace_file_content)
//       auto_approve ONLY when args.TargetFile is an absolute path that, resolved WITHOUT following a final symlink and
//       with every intermediate symlink resolved, stays inside the worktree, is not inside .git or .agents, and is
//       matched by the unit's owned_paths (pipeline/paths.mjs matchesOwned) both as written and as resolved;
//       otherwise deny. (TargetFile is the only documented argument key; an absent one is denied.)
//   run_command
//       auto_approve ONLY when args.CommandLine (trimmed) equals the unit's verify_cmd exactly and args.Cwd, if
//       given, resolves to the worktree; otherwise deny.
//   MCP tools
//       the tool ask_subagent of the server pantheon-subagents -> auto_approve; any other MCP tool -> deny. HOW an MCP
//       tool is named in the hook input is NOT documented: the accepted spellings are listed in MCP_NAMES below.
//   read tools (view_file, grep_search, list_dir)
//       allow only when every path argument found (keys in READ_KEYS; which key each tool uses is NOT documented)
//       resolves inside the worktree or the control dir; deny otherwise, and deny when no path argument is found.
//   anything else, and malformed input -> deny.
// Every decision is appended as one JSON line to the policy's `log` (<control_dir>/run/jail.log): the ONLY file this
// hook writes. In `post` mode (PostToolUse, audit only) it logs the call and prints {}.
import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesOwned } from "../pipeline/paths.mjs";

export const WRITE_TOOLS = Object.freeze(["write_to_file", "replace_file_content", "multi_replace_file_content"]);
export const READ_TOOLS = Object.freeze(["view_file", "grep_search", "list_dir"]);
export const MCP_SERVER = "pantheon-subagents", MCP_TOOL = "ask_subagent";
// Undocumented: the spelling of an MCP tool's name in toolCall.name. Every plausible spelling of THIS tool is
// accepted; anything else that looks like an MCP tool is denied as "another MCP tool".
export const MCP_NAMES = Object.freeze([MCP_TOOL, `${MCP_SERVER}/${MCP_TOOL}`, `${MCP_SERVER}__${MCP_TOOL}`, `mcp__${MCP_SERVER}__${MCP_TOOL}`,
  `${MCP_SERVER}.${MCP_TOOL}`, `${MCP_SERVER}:${MCP_TOOL}`, `mcp_${MCP_SERVER}_${MCP_TOOL}`, `mcp:${MCP_SERVER}:${MCP_TOOL}`]);
const READ_KEYS = ["AbsolutePath", "TargetFile", "File", "FilePath", "Path", "SearchPath", "SearchDirectory", "DirectoryPath", "Directory"];
const FORBIDDEN_SEGMENTS = [".git", ".agents"];

const inside = (root, p) => p === root || p.startsWith(root + sep);
const realOr = p => { try { return realpathSync(p); } catch { return null; } };
const deny = reason => ({ decision: "deny", reason });

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

export function decideWrite(policy, args) {
  const target = args?.TargetFile;
  if (typeof target !== "string" || !target.trim()) return deny("the write names no TargetFile");
  if (!isAbsolute(target)) return deny(`TargetFile "${target}" is not absolute; the jail resolves absolute paths only`);
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
  return { decision: "auto_approve", reason: `${rel} is owned by unit ${policy.unit_id}` };
}

export function decideCommand(policy, args) {
  const cmd = typeof args?.CommandLine === "string" ? args.CommandLine.trim() : null;
  if (!cmd) return deny("run_command names no CommandLine");
  if (typeof policy.verify_cmd !== "string" || !policy.verify_cmd.trim()) return deny("this unit allows no command (no verify_cmd)");
  if (cmd !== policy.verify_cmd.trim()) return deny(`only the unit's verify_cmd may run (${JSON.stringify(policy.verify_cmd.trim())}), not ${JSON.stringify(cmd)}`);
  if (args.Cwd !== undefined && args.Cwd !== null && args.Cwd !== "") {
    if (typeof args.Cwd !== "string" || !isAbsolute(args.Cwd)) return deny(`Cwd ${JSON.stringify(args.Cwd)} is not an absolute path`);
    const r = realOr(args.Cwd);
    if (r !== policy.worktree) return deny(`verify_cmd runs in the worktree ${policy.worktree}, not in ${args.Cwd}`);
  }
  return { decision: "auto_approve", reason: "the unit's verify_cmd" };
}

export function decideRead(policy, args) {
  const paths = READ_KEYS.map(k => args?.[k]).filter(v => typeof v === "string" && v.trim());
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
  return { decision: "allow", reason: "a read inside the worktree or the control dir" };
}

/** The MCP identity of a tool call: {server, tool} when it looks like an MCP tool, else null. */
function mcpOf(call) {
  const name = call.name;
  const server = call.server ?? call.serverName ?? call.mcpServer ?? call.mcp_server ?? call.args?.server ?? null;
  if (typeof server === "string") return { server, tool: call.tool ?? call.toolName ?? name };
  if (MCP_NAMES.includes(name)) return { server: MCP_SERVER, tool: MCP_TOOL };
  const m = /^(?:mcp(?:__|_|:))?([A-Za-z0-9_.-]+?)(?:__|\/|:|\.)([A-Za-z0-9_-]+)$/.exec(name);
  return m && (name.startsWith("mcp") || /__|\/|:/.test(name)) ? { server: m[1], tool: m[2] } : null;
}

/** The decision for one PreToolUse input under `policy`. Pure apart from reading the file system. */
export function decide(policy, input) {
  const call = input?.toolCall;
  if (!call || typeof call !== "object" || typeof call.name !== "string" || !call.name) return deny("malformed hook input: no toolCall.name");
  const args = call.args && typeof call.args === "object" ? call.args : {};
  if (WRITE_TOOLS.includes(call.name)) return decideWrite(policy, args);
  if (call.name === "run_command") return decideCommand(policy, args);
  if (READ_TOOLS.includes(call.name)) return decideRead(policy, args);
  const mcp = mcpOf(call);
  if (mcp) return mcp.server === MCP_SERVER && mcp.tool === MCP_TOOL
    ? { decision: "auto_approve", reason: `${MCP_SERVER}/${MCP_TOOL}` }
    : deny(`MCP tool ${call.name} is not allowed (only ${MCP_SERVER}/${MCP_TOOL})`);
  return deny(`tool ${call.name} is not allowed for a unit worker`);
}

function loadPolicy(file) {
  const p = JSON.parse(readFileSync(file, "utf8"));
  if (typeof p.worktree !== "string" || !Array.isArray(p.owned_paths)) throw new Error("jail.json lacks worktree/owned_paths");
  return { ...p, worktree_given: p.worktree_given ?? p.worktree, worktree: realOr(p.worktree) ?? p.worktree, control_dir: p.control_dir ? (realOr(p.control_dir) ?? p.control_dir) : null };
}

const summary = call => {
  const a = call?.args ?? {};
  const pick = Object.fromEntries(["TargetFile", "CommandLine", "Cwd", ...READ_KEYS].filter(k => typeof a[k] === "string").map(k => [k, a[k].slice(0, 500)]));
  return { tool: typeof call?.name === "string" ? call.name : null, args: pick };
};

async function main() {
  const [file, mode = "pre"] = process.argv.slice(2);
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let policy = null, out, input = null;
  try { policy = loadPolicy(file); } catch (e) { out = deny(`the jail policy could not be read: ${e.message}`); }
  if (!out) {
    try { input = JSON.parse(raw); } catch { out = deny("malformed hook input: not JSON"); }
  }
  if (mode === "post") out = {};
  else if (!out) { try { out = decide(policy, input); } catch (e) { out = deny(`the jail failed closed: ${e.message}`); } }
  if (policy?.log) {
    const row = { at: new Date().toISOString(), event: mode === "post" ? "PostToolUse" : "PreToolUse", unit_id: policy.unit_id ?? null,
      ...summary(input?.toolCall), step: input?.stepIdx ?? null, ...(mode === "post" ? {} : { decision: out.decision, reason: out.reason ?? null }) };
    try { appendFileSync(policy.log, JSON.stringify(row) + "\n"); } catch { /* the log is evidence, not the decision */ }
  }
  process.stdout.write(JSON.stringify(out) + "\n");
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && (realOr(process.argv[1]) ?? process.argv[1]) === (realOr(self) ?? self)) {
  main().catch(e => { process.stdout.write(JSON.stringify(deny(`the jail failed closed: ${e?.message ?? e}`)) + "\n"); }).finally(() => { process.exitCode = 0; });
}
