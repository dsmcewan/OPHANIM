// THE PER-UNIT agy WORKSPACE, written in the CONTROLLER's control dir (never in the worktree).
//
// The agy process runs with cwd = control_dir (its "project root") and the unit's worktree added with --add-dir, so
// the workspace files the CLI reads from the project root are the controller's, read-only to the worker under bwrap:
//   <control_dir>/.agents/agents/pantheon-unit-worker/agent.md   the role card (copied from the template)
//   <control_dir>/.agents/mcp_config.json                        the stdio MCP relay to the unit's A2A socket
//   <control_dir>/.agents/hooks.json                             the PreToolUse jail hook (no PostToolUse hook)
//   <control_dir>/pantheon-jail-hook                             the hook's executable wrapper (the hook command)
//   <control_dir>/jail.json                                      the unit's policy, read by the hook
//   <control_dir>/run/                                           the ONLY writable part (jail.log, agy.log, scratch)
//
// hooks.json, OWNER-STATED shape (2026-11-18; not in the docs we read — scripts/agy-worker-probe.mjs confirms or
// refutes it): a TOP-LEVEL HOOK NAME mapping to event groups, written WITHOUT a UTF-8 BOM:
//   {"pantheon-jail": {"PreToolUse": [{"matcher": ".*", "hooks": [{"type": "command", "command": "/abs/hook", "timeout": 30}]}]}}
// One PreToolUse group with matcher ".*" covers every tool (writes, commands, reads, MCP, native
// subagents, unknown tools): the hook itself decides, and denies what it does not know. OWNER-STATED: agy runs hook
// commands with cwd = the `.agents/` directory, not the worktree; so the command is an ABSOLUTE path to a per-unit
// wrapper script with no arguments (it works whether or not agy tokenises the command with a shell, and depends on
// no cwd). The wrapper never prints nothing: when node fails to produce a decision it prints a deny itself
// (owner-stated: an EMPTY hook stdout ALLOWS the tool).
//
// mcp_config.json: our stdio server with `tools.ask_subagent.eager = true` (OWNER-STATED: MCP tools are lazy-loaded
// through `call_mcp_tool` by default; eager asks for the tool to be loaded directly). The hook handles both forms.
//
// Must never: write inside the worktree; put a secret anywhere but the MCP server's env (the A2A token is there,
// as the relay needs it).
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HARD_DENY, MCP_NAMES, MCP_SERVER, MCP_TOOL, MCP_WRAPPER, READ_TOOLS, WRITE_PATH_KEYS, WRITE_TOOLS, workerVerifyCommand } from "./jail-hook.mjs";

export { workerVerifyCommand } from "./jail-hook.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKER_AGENT = "pantheon-unit-worker";
export const CARD_TEMPLATE = join(HERE, "..", "..", ".agents", "agents", WORKER_AGENT, "agent.md");
export const JAIL_HOOK = join(HERE, "jail-hook.mjs");
export const HOOK_NAME = "pantheon-jail";
export const HOOK_WRAPPER = "pantheon-jail-hook";
export const HOOK_TIMEOUT_S = 30;
const inside = (root, p) => p === root || p.startsWith(root + sep);
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
/** Quote a word for a POSIX shell only when it needs it. */
export const shWord = s => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
// A hook command path that needs no quoting under any tokenisation (agy's is undocumented).
const SAFE_COMMAND = /^\/[A-Za-z0-9_./@%+=:,-]+$/;

// THE ROLE CARD'S `tools:` LIST. Observed on agy 1.5.10, owner's probe 2026-11-18: the CLI log said
//   failed to resolve components: unknown component: tool "call_mcp_tool" not found in registry
//   Tool "grep_search" is deprecated and has no effect        (and the same for list_dir, multi_replace_file_content)
// and Antigravity's docs warn that an unmapped tool name in an agent card's `tools` "may cause the subagent process to
// hang" (that probe's turn hung until its print timeout, with zero tool steps). The jail hook still accepts every
// spelling (harmless: it decides per call); the CARD lists only names that agy resolved.
// write_file, not write_to_file (observed on agy 1.5.10, owner's machine, first real worker turn of 5efbba5,
// 2026-11-18): the card listed write_to_file and the CLI emitted `write_file {Path, Content}` regardless, so the card
// list is not an allowlist of what the model may call, and the card now names the tool the CLI actually uses. Should
// write_file not resolve as a card name, the CLI says "unknown component" and the zero-spend preflight's log_scan
// blocks before any model turn. The jail hook accepts both names.
export const AGY_1_5_10_UNKNOWN_OR_DEPRECATED = Object.freeze(["call_mcp_tool", "grep_search", "list_dir", "multi_replace_file_content"]);
export const WORKER_CARD_TOOLS = Object.freeze(["view_file", "write_file", "replace_file_content", "run_command"]);

/** The `tools: [a, b]` list of a card's frontmatter (single line, unquoted or quoted names), or null when absent. */
export function cardTools(text) {
  const s = String(text ?? "");
  const end = s.indexOf("\n---", 4);
  if (!s.startsWith("---\n") || end < 0) return null;
  const line = s.slice(4, end).split("\n").find(l => /^tools:/.test(l));
  if (!line) return null;
  const m = /^tools:\s*\[(.*)\]\s*$/.exec(line);
  if (!m) return null;
  return m[1].split(",").map(t => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}
/**
 * Is `tools` a card tool list agy 1.5.10 will resolve? {ok, bad: [names in AGY_1_5_10_UNKNOWN_OR_DEPRECATED],
 * why: null | string}. Not a list, empty, a non-string, a duplicate, or a known-bad name -> ok: false.
 */
export function validateCardTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return { ok: false, bad: [], why: "the card lists no tools (a missing or unparseable tools: line)" };
  if (tools.some(t => typeof t !== "string" || !/^[A-Za-z0-9_./:-]+$/.test(t))) return { ok: false, bad: [], why: "a tool name is not a plain identifier" };
  if (new Set(tools).size !== tools.length) return { ok: false, bad: [], why: "a tool is listed twice" };
  const bad = tools.filter(t => AGY_1_5_10_UNKNOWN_OR_DEPRECATED.includes(t));
  return bad.length ? { ok: false, bad, why: `unknown or deprecated on agy 1.5.10 (owner's probe 2026-11-18): ${bad.join(", ")}` } : { ok: true, bad: [], why: null };
}

/** The heading of the prompt's VERIFY COMMAND section (the fixture's fake agy reads the next line as the command). */
export const VERIFY_COMMAND_HEADING = "VERIFY COMMAND";
/**
 * The prompt lines that give the worker its ONE command (workerVerifyCommand: `cd '<worktree>' && <verify_cmd>`), the
 * exact string jail.json approves. Used by the pipeline's implementer prompt and the probe's. [] when there is none.
 */
export function workerVerifyPromptLines(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return [];
  return [`${VERIFY_COMMAND_HEADING} (run it with run_command EXACTLY as written, character for character: it changes into your worktree itself, because run_command takes no working directory; any other command is refused):`,
    `  ${cmd.trim()}`];
}

/** The hooks.json object (owner-stated shape) for the absolute hook command `command`. */
export function hooksConfig({ command, timeout = HOOK_TIMEOUT_S }) {
  if (typeof command !== "string" || !isAbsolute(command)) throw Object.assign(new Error(`hooksConfig: the hook command must be an absolute path, not ${JSON.stringify(command)}`), { code: "HOOK_PATH_UNSAFE" });
  return { [HOOK_NAME]: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command, timeout }] }] } };
}

/** The wrapper script: runs node on the hook with the policy; prints a deny itself if node prints nothing. */
export function hookWrapper({ node = process.execPath, hook = JAIL_HOOK, policy }) {
  return [
    "#!/bin/sh",
    "# Pantheon's PreToolUse jail hook for one unit (written by pantheon/src/agy/workspace.mjs). It takes no arguments and",
    "# does not depend on its cwd (owner-stated: agy runs hook commands in .agents/). It ALWAYS prints one decision:",
    "# owner-stated, an empty hook stdout ALLOWS the tool, so a node that prints nothing is answered with a deny here.",
    `out=$(${shWord(node)} ${shWord(hook)} ${shWord(policy)})`,
    'if [ -n "$out" ]; then printf \'%s\\n\' "$out"; else printf \'%s\\n\' \'{"decision":"deny","reason":"hook exception: the jail hook printed nothing"}\'; fi',
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Write the unit's agy workspace into `control_dir`. Returns the paths written (and `worker_verify_cmd`: the exact
 * command the worker may run, or null without a verify_cmd).
 *   a2a_env  {PANTHEON_A2A_SOCKET, PANTHEON_A2A_TOKEN, PANTHEON_A2A_ROLES, PANTHEON_UNIT_ID} for the MCP relay
 *   mcp_server  the absolute path of the stdio MCP relay (pipeline/a2a-mcp-server.mjs); null -> no MCP server
 */
export async function prepareWorkerWorkspace({ control_dir, worktree, unit_id, owned_paths, verify_cmd = null, roles = [], mcp_server = null, a2a_env = {},
  card = CARD_TEMPLATE, hook = JAIL_HOOK, node = process.execPath }) {
  if (!control_dir || !worktree) throw Object.assign(new Error("prepareWorkerWorkspace: pass control_dir and worktree"), { code: "NO_WORKSPACE" });
  if (!Array.isArray(owned_paths) || !owned_paths.length) throw Object.assign(new Error("prepareWorkerWorkspace: the unit owns no paths"), { code: "NO_OWNED_PATHS" });
  await mkdir(control_dir, { recursive: true });
  const ctl = real(control_dir), wt = real(worktree);
  if (inside(wt, ctl) || inside(ctl, wt)) throw Object.assign(new Error(`the control dir ${ctl} and the worktree ${wt} must be disjoint`), { code: "CONTROL_IN_WORKTREE" });
  const agents = join(ctl, ".agents"), cardDir = join(agents, "agents", WORKER_AGENT), run = join(ctl, "run");
  const paths = { control_dir: ctl, worktree: wt, card: join(cardDir, "agent.md"), mcp_config: join(agents, "mcp_config.json"), hooks: join(agents, "hooks.json"),
    hook_command: join(ctl, HOOK_WRAPPER), jail: join(ctl, "jail.json"), run, jail_log: join(run, "jail.log"), agy_log: join(run, "agy.log") };
  if (!SAFE_COMMAND.test(paths.hook_command)) throw Object.assign(new Error(`the hook command path ${paths.hook_command} needs quoting; put the control dir on a plain path`), { code: "HOOK_PATH_UNSAFE" });
  await mkdir(cardDir, { recursive: true });
  await mkdir(run, { recursive: true });
  await copyFile(card, paths.card);
  const servers = mcp_server ? { [MCP_SERVER]: { command: node, args: [mcp_server], env: { ...a2a_env }, tools: { [MCP_TOOL]: { eager: true } } } } : {};
  await writeFile(paths.mcp_config, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
  const verify = typeof verify_cmd === "string" && verify_cmd.trim() ? verify_cmd.trim() : null;
  // The ONE command the worker may run (run_command has no Cwd: observed on agy 1.5.10): it cds into the REAL worktree.
  // The prompt carries the same string (pipeline/implement.mjs, scripts/agy-worker-probe.mjs: workerVerifyCommand).
  paths.worker_verify_cmd = verify ? workerVerifyCommand(wt, verify) : null;
  const policy = { schema: "pantheon.agy-jail/v3", unit_id, worktree: wt, worktree_given: resolve(worktree), control_dir: ctl, log: paths.jail_log,
    owned_paths: [...owned_paths], verify_cmd: verify, worker_verify_cmd: paths.worker_verify_cmd, write_path_keys: [...WRITE_PATH_KEYS],
    roles: [...roles], mcp: { server: MCP_SERVER, tool: MCP_TOOL, wrapper: MCP_WRAPPER, accepted_names: [...MCP_NAMES], enabled: Boolean(mcp_server), eager: Boolean(mcp_server) },
    hard_deny: [...HARD_DENY], write_tools: [...WRITE_TOOLS], read_tools: [...READ_TOOLS] };
  await writeFile(paths.jail, JSON.stringify(policy, null, 2) + "\n");
  await writeFile(paths.hook_command, hookWrapper({ node, hook, policy: paths.jail }));
  await chmod(paths.hook_command, 0o755);
  // JSON.stringify never emits a BOM; the file is written as plain UTF-8 bytes.
  await writeFile(paths.hooks, JSON.stringify(hooksConfig({ command: paths.hook_command }), null, 2) + "\n");
  await writeFile(paths.jail_log, "", { flag: "a" });
  return paths;
}
