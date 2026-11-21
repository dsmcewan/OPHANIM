// THE BRIDGE BY ITSELF (scripts/antigravity-bridge.py), without a session: no runtime, no provider, no model, no jail.
// Deterministic and quick, so that a change to the bridge's own decisions is caught here and not only by a whole session.
//   decide   the bridge's answer to the SDK's pre-tool hook. The SDK's result type is stood in for
//            (fixtures/bridge-driver.py), so this needs only a python3.
//   config   the configuration object the bridge builds, from the INSTALLED SDK's own types: it needs the SDK's python
//            (PANTHEON_ANTIGRAVITY_PYTHON, else the default venv) and is SKIPPED as UNVERIFIED without it, never passed.
// What the runtime DOES with that configuration (the pin, the ceiling, the stop, the budget) is observed with a real
// session in antigravity-sdk-contract.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sdkPython, BRIDGE_SCRIPT } from "../src/antigravity/turn.mjs";

const DRIVER = fileURLToPath(new URL("./fixtures/bridge-driver.py", import.meta.url));
const SDK_PY = sdkPython();
const drive = (python, mode) => JSON.parse(execFileSync(python, [DRIVER, BRIDGE_SCRIPT, mode], { encoding: "utf8", timeout: 60000 }).split("\n").find(l => l.startsWith("RESULT ")).replace(/^RESULT /, ""));
const usable = python => { try { execFileSync(python, ["--version"], { encoding: "utf8", timeout: 20000 }); return true; } catch { return false; } };
const sdkInstalled = () => {
  if (SDK_PY.includes("/") && !existsSync(SDK_PY)) return `no python at ${SDK_PY} (set PANTHEON_ANTIGRAVITY_PYTHON)`;
  try { const id = JSON.parse(execFileSync(SDK_PY, [BRIDGE_SCRIPT, "--identity"], { encoding: "utf8", timeout: 60000 })); return id.sdk?.status === "installed" ? null : `google-antigravity is not installed for ${SDK_PY}`; }
  catch (e) { return `the bridge's --identity failed: ${String(e?.message ?? e).slice(0, 200)}`; }
};

test("the bridge is closed without the controller: a call it did not decide in time, one made while the session is stopping, and one still waiting when it is cancelled are all DENIED; only an explicit allow: true admits a call", t => {
  const python = existsSync(SDK_PY) ? SDK_PY : "python3";
  if (!usable(python)) { t.skip(`UNVERIFIED: no ${python} here`); return; }
  const d = drive(python, "decide");
  assert.deepEqual(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.allow])),
    { allowed: true, refused: false, allow_not_exactly_true: false, no_allow_field: false, no_decision_in_time: false, session_stopping: false, controller_gone: false, cancelled_while_waiting: false });
  assert.equal(d.refused.message, "WRITE_REFUSED: not one of the unit's owned paths", "the controller's reason is what the model is told");
  assert.match(d.no_decision_in_time.message, /^PANTHEON_NO_DECISION/);
  assert.match(d.session_stopping.message, /^PANTHEON_NO_CONTROLLER/);
  assert.match(d.controller_gone.message, /^PANTHEON_NO_CONTROLLER/);
  assert.equal(d.cancelled_while_waiting.message, "PANTHEON_CANCELLED: the stage was stopped");
});

test("the configuration the bridge hands to the SDK is the controller's: both model types go to the gateway with the session token, the pre-tool hook is installed, subagents are the pinned types at depth 1, nothing is retried, no daemon, and the runtime's own workspace containment stays on", t => {
  const why = sdkInstalled();
  if (why) { t.skip(`UNVERIFIED: ${why}`); return; }
  const { with_subagents: w, without_subagents: n } = drive(SDK_PY, "config");
  const viaGateway = [{ name: "gemini-4-carbon", types: ["text"], base_url: "http://127.0.0.1:1", api_key: "session-token" },
    { name: "gemini-4-carbon", types: ["image"], base_url: "http://127.0.0.1:1", api_key: "session-token" }];
  assert.deepEqual(w.models, viaGateway, "nothing the runtime calls may reach the provider around the gateway, and what it holds is the session token");
  assert.deepEqual(n.models, viaGateway);
  assert.deepEqual([w.enable_subagents, w.max_subagent_depth, w.allowed_subagents], [true, 1, ["code-explorer", "test-constructor"]]);
  assert.deepEqual(w.subagents.map(x => [x.name, x.model, x.enabled_tools]), [["code-explorer", "gemini-4-hydrogen", ["view_file"]], ["test-constructor", "gemini-4-hydrogen", ["view_file", "create_file"]]]);
  assert.deepEqual([n.enable_subagents, n.max_subagent_depth, n.allowed_subagents, n.subagents], [false, null, null, []], "with no admitted type the runtime is given no subagents at all");
  // As policy.workspace_only writes them on SDK 0.1.24: it covers these three file tools, and the controller's decisions cover the rest.
  const POLICIES = [["*", "APPROVE", "allow_all"], ["view_file", "DENY", "workspace_only"], ["create_file", "DENY", "workspace_only"], ["edit_file", "DENY", "workspace_only"]];
  assert.deepEqual(w.policies, POLICIES);
  assert.deepEqual(n.policies, POLICIES);
  assert.deepEqual([w.hooks, w.api_retries, w.run_command.enable_daemons, w.run_command.timeout_seconds, w.budget], [3, 0, false, 30, { max_model_calls: 5, max_tool_calls: 7 }]);
  assert.deepEqual([w.thinking, w.enabled_tools, w.workspaces, w.system_instructions], ["high", ["view_file", "create_file", "run_command", "finish", "invoke_subagent"], ["/w"], "the implementer's instructions"]);
  assert.deepEqual(n.enabled_tools, ["view_file", "create_file", "run_command", "finish"]);
});
