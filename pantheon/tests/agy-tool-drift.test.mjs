// L-502: TOOL DRIFT between what the Antigravity CLI advertises and what the PreToolUse jail hook classifies (self-audit
// round 3, assignment 4 (sealed fe2a612); owner plan step 3). The hook denies an unknown tool by default -- safe, but
// silent: a renamed read tool blinds a reviewer one denial at a time, and a new exec-like tool the CLI routed past the
// hook would not be seen at all. The zero-spend preflight now fails on any advertised read/write/exec/network-like tool
// the hook does not classify, naming it and how it was discovered; a turn records the same check on its stream, and
// any tool step that finished more often than the hook approved it (`unhooked`). At 08ee51a there was no such check:
// the preflight below passed with run_terminal_command on the card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Namespace imports: at 08ee51a the new names are absent, and the preflight test below fails on its ASSERTIONS (the
// preflight passed with an unclassified exec-like tool on the card), not on a missing export.
import * as cli from "../src/board/agy-cli.mjs";
import * as hook from "../src/agy/jail-hook.mjs";
const { advertisedTools, PREFLIGHT_BLOCKING, runAgyPreflight, toolDriftCheck, unhookedSteps } = cli;
const { classifyTool, decide, DENIED_TOOLS, READ_TOOLS, toolDrift, toolLooksLike, WRITE_TOOLS } = hook;
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { prepareWorkerWorkspace } from "../src/agy/workspace.mjs";
import { fakeAgy } from "./fixtures/dispatch.mjs";

test("L-502: the hook classifies every tool it decides on; network/browser/messaging tools are DENIED by name; unknown tools stay unclassified", () => {
  for (const t of WRITE_TOOLS) assert.equal(classifyTool(t), "write");
  for (const t of READ_TOOLS) assert.equal(classifyTool(t), "read");
  assert.deepEqual(["run_command", "invoke_subagent", "call_mcp_tool", "search_web", "send_message"].map(classifyTool), ["exec", "hard_deny", "mcp", "deny", "deny"]);
  for (const t of DENIED_TOOLS) {
    const d = decide({ worktree: "/w", owned_paths: ["**"], roles: [] }, { toolCall: { name: t, args: { Url: "https://example.invalid" } } });
    assert.deepEqual([d.decision, /network, browser or messaging tool/.test(d.reason)], ["deny", true], t);
  }
  assert.deepEqual(["run_terminal_command", "write_notebook", "fetch_url", "read_resource", "todo_note"].map(toolLooksLike), ["exec", "write", "network", "read", null]);
  assert.equal(classifyTool("run_terminal_command"), null);
});

test("L-502: toolDrift / advertisedTools name each unclassified read/write/exec/network-like tool and the discovery method; benign unknowns are recorded, not failed", () => {
  const a = advertisedTools({ cardTools: ["view_file", "run_command"], agentsOut: "pantheon-unit-worker\tworkspace\ttools: [view_file, run_terminal_command, todo_note]\n",
    logText: 'E1118 x] failed to resolve components: unknown component: tool "browser_exec" not found in registry\nW1118 y] Tool "grep_search" is deprecated and has no effect\n',
    initTools: ["view_file", { name: "edit_notebook" }], stepNames: ["read_resource"] });
  assert.deepEqual(a.methods, ["agy_agents_output", "card_frontmatter", "cli_log_registry", "stream_init", "stream_step"]);
  const c = toolDriftCheck(a);
  assert.equal(c.ok, false);
  assert.deepEqual(c.unclassified.map(u => [u.name, u.looks_like, u.sources]), [["run_terminal_command", "exec", ["agy_agents_output"]], ["browser_exec", "exec", ["cli_log_registry"]],
    ["edit_notebook", "write", ["stream_init"]], ["read_resource", "read", ["stream_step"]]]);
  assert.deepEqual(c.unknown.map(u => u.name), ["todo_note"]);
  assert.match(c.why, /run_terminal_command \(exec-like; seen by agy_agents_output\)/);
  assert.deepEqual(toolDrift({ view_file: ["card_frontmatter"], run_command: ["card_frontmatter"] }), { ok: true, unclassified: [], unknown: [] });
});

test("L-502: a tool step that finished more often than the hook approved it is UNHOOKED (a call the CLI did not route through the hook)", () => {
  const steps = [{ tool_name: "view_file", state: "DONE" }, { tool_name: "run_command", state: "DONE" }, { tool_name: "run_command", state: "DONE" }, { tool_name: "write_file", state: "ERROR" },
    { tool_name: "mcp_pantheon-subagents_ask_subagent", state: "DONE" }];
  const log = [{ tool: "view_file", decision: "auto_approve" }, { tool: "run_command", decision: "auto_approve" }, { tool: "run_command", decision: "deny" }, { tool: "call_mcp_tool", decision: "auto_approve" }];
  assert.deepEqual(unhookedSteps(steps, log), [{ tool: "run_command", done: 2, approved: 1 }]);
  assert.deepEqual(unhookedSteps(steps.slice(0, 2), log), []);
});

const have = await sandboxAvailable("bwrap");
const usage = JSON.stringify({ conversation_id: "", status: "SUCCESS", response: "", num_turns: 0, usage: { total_tokens: 0 }, command: { name: "usage", data: { groups: [
  { name: "Gemini Models", description: "Models within this group: Gemini 3.8 Flash", buckets: [{ id: "w", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.8 }] }] } } });

test("L-502: the zero-spend preflight FAILS (blocking `tool_drift`) when the card advertises a tool the hook does not classify, naming it and the method; the worker's own card passes", { skip: have.ok ? false : `bwrap unavailable: ${have.why}` }, async t => {
  assert.ok(PREFLIGHT_BLOCKING.includes("tool_drift"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-drift-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fx = join(root, "fx"), home = join(root, "home"), ctl = join(root, "control"), wt = join(root, "wt");
  mkdirSync(fx); mkdirSync(wt);
  const g = join(home, ".gemini"), c = join(g, "antigravity-cli");
  mkdirSync(join(c, "log"), { recursive: true }); mkdirSync(join(g, "config", "projects"), { recursive: true });
  writeFileSync(join(c, "antigravity-oauth-token"), "fake-token");
  const cli = fakeAgy(fx);
  writeFileSync(join(fx, "quota-report.txt"), usage); writeFileSync(join(fx, "quota-exit"), "0");
  const ws = await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: "drift", owned_paths: ["allowed/**"], verify_cmd: 'node -e "process.exit(0)"' });
  const run = () => runAgyPreflight({ cli, control_dir: realpathSync(ctl), worktree: realpathSync(wt), model: "gemini-3.8-flash-low",
    env: { HOME: home, FAKE_AGY_LOG: join(fx, "agy.log") }, sandbox: { home, agy_state_dirs: [fx] } });
  let p = await run();
  assert.deepEqual([p.ok, p.checks.tool_drift.ok, p.checks.tool_drift.methods], [true, true, ["card_frontmatter"]], JSON.stringify(p.failed));
  // The card advertises an exec-like tool the hook does not know: the preflight refuses before any model turn.
  const card = readFileSync(ws.card, "utf8").replace(/^tools: \[(.*)\]$/m, "tools: [$1, run_terminal_command]");
  writeFileSync(ws.card, card);
  p = await run();
  assert.equal(p.ok, false);
  assert.deepEqual(p.failed, ["tool_drift"]);
  assert.match(p.checks.tool_drift.why, /run_terminal_command \(exec-like; seen by card_frontmatter\).*does not classify/);
  assert.deepEqual(p.checks.tool_drift.unclassified, [{ name: "run_terminal_command", looks_like: "exec", sources: ["card_frontmatter"] }]);
});
