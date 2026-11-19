// Assignment 1 in subscription mode: the Antigravity CLI (`agy`), on lane gemini-4-carbon-high, inside the SAME jail
// the unit worker uses (src/agy/sandbox.mjs via prepareWorkerJail: bwrap, ~/.gemini read-only with a per-run scratch
// copy of antigravity-cli/, the worktree and <control>/run writable) and the same PreToolUse jail hook
// (src/agy/jail-hook.mjs), with a REVIEW policy instead of a unit's:
//   writes      only under <worktree>/.review-tests/ (owned_paths [".review-tests/**"]) for assignments 1-3; none for 4
//               (owned_paths [], and the card lists no write tool)
//   reads       anywhere in the worktree (and the control dir), as for the worker
//   run_command only the exact commands the CLI harness lists: `run_command_policy` {kind: "node-test", launcher, ...}: the
//               review's VERIFY LAUNCHERS in the control dir (<ctl>/pantheon-test <files>, <ctl>/pantheon-suite-<name>),
//               which run the code under review in a verify jail (credential isolation, src/agy/verify-jail.mjs)
//   MCP         none (no subagents in a review): mcp_config.json has no server and the hook denies every MCP call
// The card is pantheon-reviewer-agent (pantheon/.agents/agents/); the argv is the worker's (workerArgv: --mode=
// accept-edits, --add-dir <worktree>, --disable-slash-commands, --output-format stream-json, --print-timeout,
// --log-file; --sandbox and --dangerously-skip-permissions refused by assertWorkerArgv). The served model is the lane id,
// `served_model_source: "input"` (Antigravity names no served model).
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_WRAPPER, JAIL_HOOK, hookWrapper, hooksConfig, cardTools, validateCardTools } from "../agy/workspace.mjs";
import { HARD_DENY, MCP_NAMES, MCP_SERVER, MCP_TOOL, MCP_WRAPPER, READ_TOOLS, REVIEW_SUITE_LAUNCHER, REVIEW_TEST_LAUNCHER, WRITE_PATH_KEYS, WRITE_TOOLS } from "../agy/jail-hook.mjs";
import { writeVerifyLauncher } from "../agy/verify-jail.mjs";
import { REVIEW_TESTS_DIR } from "./cli-common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REVIEW_AGENT = "pantheon-reviewer-agent";
export const REVIEW_CARD = join(HERE, "..", "..", ".agents", "agents", REVIEW_AGENT, "agent.md");
export const REVIEW_CARD_TOOLS = Object.freeze(["view_file", "write_file", "replace_file_content", "run_command"]);
export const REVIEW_CARD_TOOLS_READ_ONLY = Object.freeze(["view_file", "run_command"]);
const SAFE_COMMAND = /^\/[A-Za-z0-9_./@%+=:,-]+$/;
const inside = (root, p) => p === root || p.startsWith(root + sep);
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };

/** The lane for `model` from lanes.json's agy_cli: `<model>-high`, declared, not retired, with base === model. */
export function reviewLane(lanes, model) {
  const id = `${model}-high`, l = lanes?.agy_cli?.[id];
  if (!l || l.retired || l.base !== model) return { ok: false, id, why: `${id} is not a declared Antigravity lane with base ${model} (src/config/lanes.json)` };
  return { ok: true, id, lane: l };
}

/** The card text, with the tools line rewritten for an assignment that forbids writing. */
export function reviewCardText(template, write_allowed) {
  const tools = write_allowed ? REVIEW_CARD_TOOLS : REVIEW_CARD_TOOLS_READ_ONLY;
  const out = template.replace(/^tools:\s*\[.*\]\s*$/m, `tools: [${tools.join(", ")}]`);
  const v = validateCardTools(cardTools(out));
  if (!v.ok) throw Object.assign(new Error(`the review card's tools are not usable: ${v.why}`), { code: "BAD_CARD" });
  return out;
}

/**
 * Write the review's agy workspace into `control_dir` (the worker layout: .agents/agents/<card>/agent.md,
 * .agents/mcp_config.json, .agents/hooks.json, the hook wrapper, jail.json, run/). Returns the paths and the policy.
 */
export async function prepareReviewWorkspace({ control_dir, worktree, n, write_allowed, run_command_policy, card = REVIEW_CARD, hook = JAIL_HOOK, node = process.execPath }) {
  await mkdir(control_dir, { recursive: true });
  const ctl = real(control_dir), wt = real(worktree);
  if (inside(wt, ctl) || inside(ctl, wt)) throw Object.assign(new Error(`the control dir ${ctl} and the worktree ${wt} must be disjoint`), { code: "CONTROL_IN_WORKTREE" });
  const agents = join(ctl, ".agents"), cardDir = join(agents, "agents", REVIEW_AGENT), run = join(ctl, "run");
  const paths = { control_dir: ctl, worktree: wt, card: join(cardDir, "agent.md"), mcp_config: join(agents, "mcp_config.json"), hooks: join(agents, "hooks.json"),
    hook_command: join(ctl, HOOK_WRAPPER), jail: join(ctl, "jail.json"), run, jail_log: join(run, "jail.log"), agy_log: join(run, "agy.log") };
  if (!SAFE_COMMAND.test(paths.hook_command)) throw Object.assign(new Error(`the hook command path ${paths.hook_command} needs quoting; put the run's temp dir on a plain path`), { code: "HOOK_PATH_UNSAFE" });
  await mkdir(cardDir, { recursive: true });
  await mkdir(run, { recursive: true });
  await writeFile(paths.card, reviewCardText(await readFile(card, "utf8"), write_allowed));
  await writeFile(paths.mcp_config, JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
  const policy = { schema: "pantheon.agy-review-jail/v1", unit_id: `review-${n}`, worktree: wt, worktree_given: resolve(worktree), control_dir: ctl, log: paths.jail_log,
    owned_paths: write_allowed ? [`${REVIEW_TESTS_DIR}/**`] : [], verify_cmd: null, worker_verify_cmd: null, write_path_keys: [...WRITE_PATH_KEYS],
    roles: [], mcp: { server: MCP_SERVER, tool: MCP_TOOL, wrapper: MCP_WRAPPER, accepted_names: [...MCP_NAMES], enabled: false, eager: false },
    hard_deny: [...HARD_DENY], write_tools: [...WRITE_TOOLS], read_tools: [...READ_TOOLS], run_command_policy };
  await writeFile(paths.jail, JSON.stringify(policy, null, 2) + "\n");
  await writeFile(paths.hook_command, hookWrapper({ node, hook, policy: paths.jail }));
  await chmod(paths.hook_command, 0o755);
  await writeFile(paths.hooks, JSON.stringify(hooksConfig({ command: paths.hook_command }), null, 2) + "\n");
  await writeFile(paths.jail_log, "", { flag: "a" });
  // THE VERIFY LAUNCHERS (credential isolation, src/agy/verify-jail.mjs): the code under review runs only through them,
  // in a verify jail, never as agy's own child. pantheon-test takes the test files (checked again by the launcher);
  // each pantheon-suite-<name> runs its suite script. The hook approves exactly these paths (decideReviewCommand).
  paths.launchers = {};
  const rcp = run_command_policy;
  if (rcp?.launcher) {
    if (rcp.launcher !== join(ctl, REVIEW_TEST_LAUNCHER)) throw Object.assign(new Error(`the review's test launcher ${rcp.launcher} is not ${join(ctl, REVIEW_TEST_LAUNCHER)}`), { code: "BAD_POLICY" });
    const extra_ro = (rcp.extra_ro ?? []).filter(p => typeof p === "string" && isAbsolute(p));
    paths.launchers.test = writeVerifyLauncher({ control_dir: ctl, worktree: wt, script: "node --test", test_files: true, name: REVIEW_TEST_LAUNCHER, policyName: "verify-test.json", extra_ro, node }).command;
    for (const [name, script] of Object.entries(rcp.suite_scripts ?? {})) {
      if (!/^[a-z][a-z0-9-]*$/.test(name) || rcp.suites?.[name] !== join(ctl, REVIEW_SUITE_LAUNCHER(name))) throw Object.assign(new Error(`the review suite ${name} has no launcher in ${ctl}`), { code: "BAD_POLICY" });
      paths.launchers[name] = writeVerifyLauncher({ control_dir: ctl, worktree: wt, script, name: REVIEW_SUITE_LAUNCHER(name), policyName: `verify-suite-${name}.json`, extra_ro, node }).command;
    }
  }
  return { paths, policy };
}
