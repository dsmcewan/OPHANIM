// THE PER-UNIT agy WORKSPACE, written in the CONTROLLER's control dir (never in the worktree).
//
// The agy process runs with cwd = control_dir (its "project root") and the unit's worktree added with --add-dir, so
// the workspace files the CLI reads from the project root are the controller's, read-only to the worker under bwrap:
//   <control_dir>/.agents/agents/pantheon-unit-worker/agent.md   the role card (copied from the template)
//   <control_dir>/.agents/mcp_config.json                        the stdio MCP relay to the unit's A2A socket
//   <control_dir>/.agents/hooks.json                             the PreToolUse jail hook + PostToolUse audit
//   <control_dir>/jail.json                                      the unit's policy, read by the hook
//   <control_dir>/run/                                           the ONLY writable part (jail.log)
//
// hooks.json (documented shape: event -> [{matcher, hooks: [{type: "command", command, timeout}]}]). The documented
// matcher is a tool name; one entry per write tool, run_command and the read tools. A BROAD matcher "*" is added for
// everything else (MCP tools, unknown tools) — whether the CLI treats "*" as match-all is NOT documented. If it does
// not, an MCP call gets no hook decision and is soft-denied in headless mode (the worker loses its subagents; nothing
// is loosened). A tool matched by two entries runs the hook twice; the decisions are the same.
//
// Must never: write inside the worktree; put a secret anywhere but the MCP server's env (the A2A token is there,
// as the relay needs it).
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_NAMES, MCP_SERVER, MCP_TOOL, READ_TOOLS, WRITE_TOOLS } from "./jail-hook.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKER_AGENT = "pantheon-unit-worker";
export const CARD_TEMPLATE = join(HERE, "..", "..", ".agents", "agents", WORKER_AGENT, "agent.md");
export const JAIL_HOOK = join(HERE, "jail-hook.mjs");
const inside = (root, p) => p === root || p.startsWith(root + sep);
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
/** Quote a word for a shell only when it needs it (the hook command's tokenisation is undocumented). */
export const shWord = s => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/** The hooks.json object for a policy file. */
export function hooksConfig({ policy, hook = JAIL_HOOK, node = process.execPath, timeout = 10 }) {
  const cmd = mode => [node, hook, policy, mode].map(shWord).join(" ");
  const entry = (matcher, mode) => ({ matcher, hooks: [{ type: "command", command: cmd(mode), timeout }] });
  return {
    PreToolUse: [...WRITE_TOOLS, "run_command", ...READ_TOOLS].map(t => entry(t, "pre")).concat([entry("*", "pre")]),
    PostToolUse: WRITE_TOOLS.map(t => entry(t, "post")),
  };
}

/**
 * Write the unit's agy workspace into `control_dir`. Returns the paths written.
 *   a2a_env  {PANTHEON_A2A_SOCKET, PANTHEON_A2A_TOKEN, PANTHEON_A2A_ROLES, PANTHEON_UNIT_ID} for the MCP relay
 *   mcp_server  the absolute path of the stdio MCP relay (pipeline/a2a-mcp-server.mjs); null -> no MCP server
 */
export async function prepareWorkerWorkspace({ control_dir, worktree, unit_id, owned_paths, verify_cmd = null, roles = [], mcp_server = null, a2a_env = {},
  card = CARD_TEMPLATE, hook = JAIL_HOOK }) {
  if (!control_dir || !worktree) throw Object.assign(new Error("prepareWorkerWorkspace: pass control_dir and worktree"), { code: "NO_WORKSPACE" });
  if (!Array.isArray(owned_paths) || !owned_paths.length) throw Object.assign(new Error("prepareWorkerWorkspace: the unit owns no paths"), { code: "NO_OWNED_PATHS" });
  await mkdir(control_dir, { recursive: true });
  const ctl = real(control_dir), wt = real(worktree);
  if (inside(wt, ctl) || inside(ctl, wt)) throw Object.assign(new Error(`the control dir ${ctl} and the worktree ${wt} must be disjoint`), { code: "CONTROL_IN_WORKTREE" });
  const agents = join(ctl, ".agents"), cardDir = join(agents, "agents", WORKER_AGENT), run = join(ctl, "run");
  await mkdir(cardDir, { recursive: true });
  await mkdir(run, { recursive: true });
  const paths = { control_dir: ctl, worktree: wt, card: join(cardDir, "agent.md"), mcp_config: join(agents, "mcp_config.json"), hooks: join(agents, "hooks.json"),
    jail: join(ctl, "jail.json"), run, jail_log: join(run, "jail.log") };
  await copyFile(card, paths.card);
  const servers = mcp_server ? { [MCP_SERVER]: { command: process.execPath, args: [mcp_server], env: { ...a2a_env } } } : {};
  await writeFile(paths.mcp_config, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
  const policy = { schema: "pantheon.agy-jail/v1", unit_id, worktree: wt, worktree_given: resolve(worktree), control_dir: ctl, log: paths.jail_log,
    owned_paths: [...owned_paths], verify_cmd: typeof verify_cmd === "string" && verify_cmd.trim() ? verify_cmd.trim() : null,
    roles: [...roles], mcp: { server: MCP_SERVER, tool: MCP_TOOL, accepted_names: [...MCP_NAMES], enabled: Boolean(mcp_server) } };
  await writeFile(paths.jail, JSON.stringify(policy, null, 2) + "\n");
  await writeFile(paths.hooks, JSON.stringify(hooksConfig({ policy: paths.jail, hook }), null, 2) + "\n");
  await writeFile(paths.jail_log, "", { flag: "a" });
  return paths;
}
