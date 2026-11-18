// REGRESSION against the first PASSING real worker turn (agy 1.5.10, owner's machine, commit 7ca325c, 2026-11-18;
// tests/fixtures/agy-1.5.10-observed-pass-7ca325c.json). The hook must make exactly the decisions it made there, and the
// probe's step reader must reach the same five-check verdict from the real tool steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, loadPolicy, workerVerifyCommand } from "../src/agy/jail-hook.mjs";
import { prepareWorkerWorkspace } from "../src/agy/workspace.mjs";
import { MCP_SERVER_PATH } from "../src/pipeline/index.mjs";
import { turnChecks } from "../scripts/agy-worker-probe.mjs";

const OBS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "agy-1.5.10-observed-pass-7ca325c.json"), "utf8"));
const fill = (v, map) => JSON.parse(Object.entries(map).reduce((s, [k, x]) => s.split(k).join(x), JSON.stringify(v)));

async function unit(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pantheon-observed-pass-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wt = join(root, "worktrees", "probe"), ctl = join(root, "control", "probe");
  mkdirSync(wt, { recursive: true });
  const ws = await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: "probe", owned_paths: OBS.owned_paths, verify_cmd: OBS.verify_cmd, roles: OBS.roles,
    mcp_server: MCP_SERVER_PATH, a2a_env: { PANTHEON_A2A_SOCKET: join(ctl, "a2a.sock"), PANTHEON_A2A_TOKEN: "t", PANTHEON_A2A_ROLES: OBS.roles.join(","), PANTHEON_UNIT_ID: "probe" } });
  const map = { "<wt>": wt, "<ctl>": ws.control_dir };
  return { wt, policy: loadPolicy(ws.jail), payloads: fill(OBS.hook_payloads, map), steps: fill(OBS.tool_steps, map), decisions: fill(OBS.hook_decisions, map) };
}

test("the hook reproduces the four decisions it made on the real passing turn", async t => {
  const u = await unit(t);
  const got = u.payloads.map(p => { const d = decide(u.policy, p); return [p.toolCall.name, d.decision, d.reason]; });
  assert.deepEqual(got, u.decisions.map(d => [d.tool, d.decision, d.reason]));
  // The worker ran exactly the controller's directory-setting verify command.
  assert.equal(u.payloads[3].toolCall.args.CommandLine, workerVerifyCommand(u.wt, OBS.verify_cmd));
});

test("the probe's step reader reaches the observed verdict from the real tool steps: all four action checks pass, exit 0 read from the output", async t => {
  const u = await unit(t);
  const rows = u.payloads.map((p, i) => ({ tool: p.toolCall.name, args: p.toolCall.args, payload: p, decision: u.decisions[i].decision, reason: u.decisions[i].reason }));
  const c = turnChecks({ rows, steps: u.steps, worktree: u.wt, workerVerify: workerVerifyCommand(u.wt, OBS.verify_cmd), forbiddenAbsent: true, allowedContent: "probe-ok",
    shimCalls: [{ role: "probe-helper", status: "answered" }] });
  assert.deepEqual([c.forbidden_denied, c.allowed_written, c.mcp_called, c.verify_ran, c.evidence.verify.exit_status], [true, true, true, true, 0]);
  assert.deepEqual(c.evidence.unpaired_rows, []);
  // The same steps with the file not written, or the subagent not answered, do not pass.
  assert.equal(turnChecks({ rows, steps: u.steps, worktree: u.wt, workerVerify: workerVerifyCommand(u.wt, OBS.verify_cmd), forbiddenAbsent: true, allowedContent: null, shimCalls: [] }).allowed_written, false);
  assert.equal(turnChecks({ rows, steps: u.steps, worktree: u.wt, workerVerify: workerVerifyCommand(u.wt, OBS.verify_cmd), forbiddenAbsent: true, allowedContent: "probe-ok", shimCalls: [] }).mcp_called, false);
});

test("the two host SQLite sidecars that appeared during the run are recorded as outside the jail's reach", () => {
  assert.deepEqual(OBS.host_changes.map(h => [h.path.replace(/^<home>/, "~"), h.change, h.reach, h.jail_view]), [
    ["~/.gemini/antigravity-cli/conversation_summaries.db-shm", "added", "outside_jail_reach", "hidden"],
    ["~/.gemini/antigravity-cli/conversation_summaries.db-wal", "added", "outside_jail_reach", "hidden"]]);
  assert.deepEqual(OBS.hooks_loaded_turn, { named: 1, files: 1, sources: ["log_file"] });
});
