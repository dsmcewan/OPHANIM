// THE PER-UNIT agy WORKSPACE, written in the CONTROLLER's control dir (never in the worktree).
//
// The agy process runs with cwd = control_dir (its "project root") and the unit's worktree added with --add-dir, so
// the workspace files the CLI reads from the project root are the controller's, read-only to the worker under bwrap:
//   <control_dir>/.agents/agents/pantheon-unit-worker/agent.md   the role card (copied from the template)
//   <control_dir>/.agents/mcp_config.json                        the stdio MCP relay to the unit's A2A socket (it names the
//                                                                token FILE, never the token)
//   <control_dir>/a2a.token                                      the unit's A2A bearer token (mode 0600), read by the relay
//   <control_dir>/pantheon-verify, verify.json                   the VERIFY LAUNCHER (the worker's one command) and its policy
//                                                                (src/agy/verify-jail.mjs: the credential-isolation boundary)
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
// Must never: write inside the worktree; put a secret anywhere but the token file (not the MCP config, whose content
// agy's `mcp list` was observed to print, and not any environment: CREDENTIAL ISOLATION, src/agy/verify-jail.mjs).
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HARD_DENY, MCP_NAMES, MCP_SERVER, MCP_TOOL, MCP_WRAPPER, READ_TOOLS, WRAPPER_TIMEOUT_S, WRITE_PATH_KEYS, WRITE_TOOLS, workerVerifyCommand } from "./jail-hook.mjs";
import { VERIFY_LAUNCHER_NAME, VERIFY_POLICY_NAME, writeVerifyLauncher } from "./verify-jail.mjs";

export { workerVerifyCommand } from "./jail-hook.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKER_AGENT = "pantheon-unit-worker";
export const CARD_TEMPLATE = join(HERE, "..", "..", ".agents", "agents", WORKER_AGENT, "agent.md");
export const JAIL_HOOK = join(HERE, "jail-hook.mjs");
export const HOOK_NAME = "pantheon-jail";
export const HOOK_WRAPPER = "pantheon-jail-hook";
export const HOOK_TIMEOUT_S = 30;
/** The unit's A2A bearer token, in the control dir (mode 0600): the relay reads it; it is in no config and no env. */
export const A2A_TOKEN_FILE = "a2a.token";
export const JAIL_POLICY_SCHEMA = "pantheon.agy-jail/v4";
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
 * The prompt lines that give the worker its ONE command (the unit's verify launcher, <control_dir>/pantheon-verify), the
 * exact string jail.json approves. Used by the pipeline's implementer prompt and the probe's. [] when there is none.
 */
export function workerVerifyPromptLines(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return [];
  return [`${VERIFY_COMMAND_HEADING} (run it with run_command EXACTLY as written, character for character: it runs the unit's verify_cmd in your worktree inside an isolated verify jail, because run_command takes no working directory; any other command is refused):`,
    `  ${cmd.trim()}`];
}

/** The hooks.json object (owner-stated shape) for the absolute hook command `command`. */
export function hooksConfig({ command, timeout = HOOK_TIMEOUT_S }) {
  if (typeof command !== "string" || !isAbsolute(command)) throw Object.assign(new Error(`hooksConfig: the hook command must be an absolute path, not ${JSON.stringify(command)}`), { code: "HOOK_PATH_UNSAFE" });
  return { [HOOK_NAME]: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command, timeout }] }] } };
}

/** The marker the wrapper's watchdog writes into the pipe after it killed a node that gave no decision in time. */
export const WRAPPER_TIMEOUT_MARK = "__pantheon_jail_hook_timeout__";
/**
 * The wrapper script: runs node on the hook with the policy and prints EXACTLY ONE decision line, whatever node does.
 * Independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6), question 1: the earlier wrapper buffered
 * node's whole output in $(...) until node exited, so a node stuck past the CLI's 30 s hook timeout was killed with the
 * wrapper and left an EMPTY stdout, which ALLOWS (owner-stated). Now:
 *   - node's stdout is a pipe the wrapper reads line by line; the FIRST complete line that is a decision
 *     ({"decision":"auto_approve",...} or {"decision":"deny",...}) is forwarded at once;
 *   - a watchdog kills node after `timeout_s` (WRAPPER_TIMEOUT_S, well under the CLI's HOOK_TIMEOUT_S) and the wrapper
 *     prints a deny that says so;
 *   - nothing, a partial line or anything that is not a decision (a node that crashed, could not write, or is not
 *     there) is answered with a deny;
 *   - the wrapper's own write failure exits non-zero (there is nothing else it can do).
 * POSIX sh only (no coreutils timeout): node runs in the background with the hook's stdin (fd 3) and the watchdog's
 * stdout is the same pipe, so its marker line arrives only after node is dead.
 */
export function hookWrapper({ node = process.execPath, hook = JAIL_HOOK, policy, timeout_s = WRAPPER_TIMEOUT_S }) {
  if (!Number.isInteger(timeout_s) || timeout_s < 1 || timeout_s >= HOOK_TIMEOUT_S) throw Object.assign(new Error(`hookWrapper: timeout_s must be a whole number of seconds under the CLI's ${HOOK_TIMEOUT_S} s hook timeout`), { code: "BAD_INPUT" });
  const deny = why => `'${JSON.stringify({ decision: "deny", reason: `hook exception: ${why}` })}'`;
  return [
    "#!/bin/sh",
    "# Pantheon's PreToolUse jail hook for one unit (written by pantheon/src/agy/workspace.mjs). It takes no arguments and",
    "# does not depend on its cwd (owner-stated: agy runs hook commands in .agents/). It ALWAYS prints one decision:",
    "# owner-stated, an empty hook stdout ALLOWS the tool, so anything but a complete decision from node is a deny here,",
    `# and a node that has not answered within ${timeout_s} s is killed and answered with a deny.`,
    "exec 3<&0",
    "{",
    `  ${shWord(node)} ${shWord(hook)} ${shWord(policy)} <&3 3<&- &`,
    "  pid=$!",
    "  exec 3<&-",
    `  ( trap 'kill "$s" 2>/dev/null; exit 0' TERM; sleep ${timeout_s} </dev/null >/dev/null 2>&1 & s=$!; wait "$s"; kill -9 "$pid" 2>/dev/null; printf '%s\\n' '${WRAPPER_TIMEOUT_MARK}' ) &`,
    "  w=$!",
    '  wait "$pid"',
    '  kill "$w" 2>/dev/null',
    '  wait "$w" 2>/dev/null',
    "} | {",
    "  answered=",
    "  while IFS= read -r line; do",
    '    case "$line" in',
    `      '{"decision":"auto_approve",'*'}'|'{"decision":"deny",'*'}') printf '%s\\n' "$line" || exit 3; answered=1; break ;;`,
    `      *${WRAPPER_TIMEOUT_MARK}) printf '%s\\n' ${deny(`the jail hook gave no decision within ${timeout_s} s (the wrapper killed it)`)} || exit 3; answered=1; break ;;`,
    "      *) ;;",
    "    esac",
    "  done",
    `  [ -n "$answered" ] || printf '%s\\n' ${deny("the jail hook printed nothing")} || exit 3`,
    "  cat >/dev/null",
    "}",
    "exit $?",
    "",
  ].join("\n");
}

/**
 * Write the unit's agy workspace into `control_dir`. Returns the paths written (and `worker_verify_cmd`: the exact
 * command the worker may run -- the verify launcher -- or null without a verify_cmd; `a2a_token`: the token file).
 *   a2a_env  {PANTHEON_A2A_SOCKET, PANTHEON_A2A_TOKEN, PANTHEON_A2A_ROLES, PANTHEON_UNIT_ID} for the MCP relay (the
 *            token is written to the token file; the relay's env gets PANTHEON_A2A_TOKEN_FILE instead)
 *   verify_hide  more absolute paths the unit's verify jail hides (the pipeline: its run dir, the checkpoints and their
 *            seal key; src/agy/verify-jail.mjs)
 *   mcp_server  the absolute path of the stdio MCP relay (pipeline/a2a-mcp-server.mjs); null -> no MCP server
 */
export async function prepareWorkerWorkspace({ control_dir, worktree, unit_id, owned_paths, verify_cmd = null, roles = [], mcp_server = null, a2a_env = {},
  card = CARD_TEMPLATE, hook = JAIL_HOOK, node = process.execPath, verify_hide = [] }) {
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
  // THE A2A TOKEN goes into a file only the relay reads (mode 0600, in the control dir: read-only to agy's jail, hidden in
  // the verify jail); the MCP config names the FILE. Neither agy's environment nor its MCP config carries the token
  // (CREDENTIAL ISOLATION: src/agy/verify-jail.mjs; observed on agy 1.5.10: `agy mcp list` printed a server's
  // configured credential).
  const { PANTHEON_A2A_TOKEN: token, ...relayEnv } = a2a_env ?? {};
  paths.a2a_token = join(ctl, A2A_TOKEN_FILE);
  await rm(paths.a2a_token, { force: true });
  if (typeof token === "string" && token) { await writeFile(paths.a2a_token, token + "\n", { mode: 0o600 }); await chmod(paths.a2a_token, 0o600); relayEnv.PANTHEON_A2A_TOKEN_FILE = paths.a2a_token; }
  const servers = mcp_server ? { [MCP_SERVER]: { command: node, args: [mcp_server], env: relayEnv, tools: { [MCP_TOOL]: { eager: true } } } } : {};
  await writeFile(paths.mcp_config, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
  const verify = typeof verify_cmd === "string" && verify_cmd.trim() ? verify_cmd.trim() : null;
  // The ONE command the worker may run: the unit's VERIFY LAUNCHER (<control_dir>/pantheon-verify, no arguments), which
  // runs `cd '<real worktree>' && <verify_cmd>` (workerVerifyCommand; run_command has no Cwd: observed on agy 1.5.10) in
  // the verify jail. The prompt carries the same string (pipeline/implement.mjs, scripts/agy-worker-probe.mjs).
  paths.verify_launcher = join(ctl, VERIFY_LAUNCHER_NAME); paths.verify_policy = join(ctl, VERIFY_POLICY_NAME);
  paths.worker_verify_script = verify ? workerVerifyCommand(wt, verify) : null;
  await rm(paths.verify_launcher, { force: true }); await rm(paths.verify_policy, { force: true });
  const sockDir = typeof relayEnv.PANTHEON_A2A_SOCKET === "string" && isAbsolute(relayEnv.PANTHEON_A2A_SOCKET) ? dirname(resolve(relayEnv.PANTHEON_A2A_SOCKET)) : null;
  paths.worker_verify_cmd = verify ? writeVerifyLauncher({ control_dir: ctl, worktree: wt, script: paths.worker_verify_script, node,
    hide: [...(sockDir && !inside(ctl, real(sockDir)) ? [real(sockDir)] : []), ...verify_hide.filter(p => typeof p === "string" && isAbsolute(p))] }).command : null;
  const policy = { schema: JAIL_POLICY_SCHEMA, unit_id, worktree: wt, worktree_given: resolve(worktree), control_dir: ctl, log: paths.jail_log,
    owned_paths: [...owned_paths], verify_cmd: verify, worker_verify_cmd: paths.worker_verify_cmd, worker_verify_script: paths.worker_verify_script, write_path_keys: [...WRITE_PATH_KEYS],
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

// ---- THE SINGLE-TURN WORKSPACE (self-audit round 3, assignment 4 (sealed fe2a612), L-401) ----------------------------
// The planner / plan and change reviewers / validator / A2A subagent seats over Antigravity (sdk/agy-turn.mjs) and the
// board's agy seat (board/run-item.mjs) ran the real CLI UNJAILED with the controller's whole environment (every
// provider key but the two Google ones) and `--sandbox`, on text that is partly worker-controlled (an A2A subagent's
// question, a change reviewer's diff). They now run in the WORKER's jail profile (board/agy-cli.mjs runAgyCliTurn:
// prepareWorkerJail's bwrap, workerEnvOf's allowlist, workerArgv + assertWorkerArgv: no --sandbox, no
// --dangerously-skip-permissions) with this workspace, in a fresh control dir, as the CLI's cwd:
//   <control_dir>/.agents/agents/pantheon-<role>/agent.md   the role card (copied from pantheon/.agents/agents/), and the
//                                                           cards it lists under `agents:` (copied; never reachable:
//                                                           invoke_subagent / define_subagent are hard-denied)
//   <control_dir>/.agents/mcp_config.json                   no server
//   <control_dir>/.agents/hooks.json, pantheon-jail-hook     the SAME PreToolUse jail hook as the worker
//   <control_dir>/jail.json                                  a READ-ONLY policy: reads inside the worktree only, no write
//                                                           (owned_paths []), no command (no verify launcher), no MCP
//                                                           (roles [], mcp disabled), native subagents hard-denied
//   <control_dir>/run/                                       jail.log, agy.log (the only writable part of the dir)
// A seat that used to run commands in the CLI's own --sandbox (the board reviewer and scout cards list run_command) now
// has every command denied: worker-controlled code runs only in a verify jail, and a single-turn seat has none.
export const SINGLE_TURN_POLICY_SCHEMA = "pantheon.agy-single-turn-jail/v1";
const LISTED_AGENT = /^\s*-\s*\.agents\/agents\/(pantheon-[a-z][a-z-]*)\s*$/gm;
export async function prepareSingleTurnWorkspace({ control_dir, worktree, agent, card, agents_dir = null, hook = JAIL_HOOK, node = process.execPath }) {
  if (!control_dir || !worktree || !card) throw Object.assign(new Error("prepareSingleTurnWorkspace: pass control_dir, worktree and card"), { code: "NO_WORKSPACE" });
  if (typeof agent !== "string" || !/^pantheon-[a-z][a-z-]*$/.test(agent)) throw Object.assign(new Error(`prepareSingleTurnWorkspace: the agent must be a pantheon-<role> card name, not ${JSON.stringify(agent)}`), { code: "BAD_INPUT" });
  await mkdir(control_dir, { recursive: true });
  const ctl = real(control_dir), wt = real(worktree);
  if (inside(wt, ctl) || inside(ctl, wt)) throw Object.assign(new Error(`the control dir ${ctl} and the worktree ${wt} must be disjoint`), { code: "CONTROL_IN_WORKTREE" });
  const agents = join(ctl, ".agents"), run = join(ctl, "run");
  const paths = { control_dir: ctl, worktree: wt, card: join(agents, "agents", agent, "agent.md"), mcp_config: join(agents, "mcp_config.json"), hooks: join(agents, "hooks.json"),
    hook_command: join(ctl, HOOK_WRAPPER), jail: join(ctl, "jail.json"), run, jail_log: join(run, "jail.log"), agy_log: join(run, "agy.log") };
  if (!SAFE_COMMAND.test(paths.hook_command)) throw Object.assign(new Error(`the hook command path ${paths.hook_command} needs quoting; put the control dir on a plain path`), { code: "HOOK_PATH_UNSAFE" });
  await mkdir(dirname(paths.card), { recursive: true });
  await mkdir(run, { recursive: true });
  await copyFile(card, paths.card);
  for (const m of String(await readFile(card, "utf8")).matchAll(LISTED_AGENT)) {
    if (!agents_dir) continue;
    await mkdir(join(agents, "agents", m[1]), { recursive: true });
    await copyFile(join(agents_dir, m[1], "agent.md"), join(agents, "agents", m[1], "agent.md")).catch(() => {});
  }
  await writeFile(paths.mcp_config, JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
  const policy = { schema: SINGLE_TURN_POLICY_SCHEMA, unit_id: `single-turn-${agent}`, worktree: wt, worktree_given: resolve(worktree), control_dir: ctl, log: paths.jail_log,
    owned_paths: [], verify_cmd: null, worker_verify_cmd: null, worker_verify_script: null, write_path_keys: [...WRITE_PATH_KEYS],
    roles: [], mcp: { server: MCP_SERVER, tool: MCP_TOOL, wrapper: MCP_WRAPPER, accepted_names: [...MCP_NAMES], enabled: false, eager: false },
    hard_deny: [...HARD_DENY], write_tools: [...WRITE_TOOLS], read_tools: [...READ_TOOLS] };
  await writeFile(paths.jail, JSON.stringify(policy, null, 2) + "\n");
  await writeFile(paths.hook_command, hookWrapper({ node, hook, policy: paths.jail }));
  await chmod(paths.hook_command, 0o755);
  await writeFile(paths.hooks, JSON.stringify(hooksConfig({ command: paths.hook_command }), null, 2) + "\n");
  await writeFile(paths.jail_log, "", { flag: "a" });
  return { paths, policy };
}
