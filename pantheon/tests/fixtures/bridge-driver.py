# Drives scripts/antigravity-bridge.py WITHOUT a session: no runtime, no provider, no model, no jail
# (tests/antigravity-bridge.test.mjs).
#   decide   what the bridge answers the SDK's pre-tool hook when the controller refuses, allows, does not answer in
#            time, is gone, or cancels. The SDK's result type is stood in for here, so this needs only a python3.
#   config   the configuration object the bridge hands to the SDK for a given start message, built from the INSTALLED
#            SDK's own types (it needs the SDK's python, and nothing else).
# usage: python bridge-driver.py <bridge script> decide|config     prints one line: RESULT <json>
import asyncio
import importlib.util
import json
import sys
from types import SimpleNamespace

sys.dont_write_bytecode = True   # the bridge is imported from the repository: no __pycache__ is left beside it
spec = importlib.util.spec_from_file_location("antigravity_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class StandInHookResult:
  def __init__(self, allow, message="", modified_args=None):
    self.allow, self.message, self.modified_args = allow, message, modified_args


if sys.argv[2] == "decide":
  bridge.types = SimpleNamespace(HookResult=StandInHookResult)


class Call:
  name = "create_file"
  args = {"TargetFile": "/w/src/u1/impl.mjs", "CodeContent": "x"}
  id = "call-1"
  step_id = "trajectory-1:0"
  server_name = None


def shown(result):
  return {"allow": bool(result.allow), "message": getattr(result, "message", None)}


async def answered(answer):
  """The controller answers the one pending hook with `answer`."""
  b = bridge.Bridge({"hook_timeout_s": 10})
  task = asyncio.ensure_future(b.decide(Call()))
  await asyncio.sleep(0.05)
  b.pending[1].set_result(answer)
  return shown(await task)


async def decide():
  out = {}
  out["allowed"] = await answered({"allow": True})
  out["refused"] = await answered({"allow": False, "message": "WRITE_REFUSED: not one of the unit's owned paths"})
  out["allow_not_exactly_true"] = await answered({"allow": "yes"})
  out["no_allow_field"] = await answered({})
  out["no_decision_in_time"] = shown(await bridge.Bridge({"hook_timeout_s": 0.2}).decide(Call()))
  stopping = bridge.Bridge({"hook_timeout_s": 10})
  stopping.cancelled = "the stage was stopped"
  out["session_stopping"] = shown(await stopping.decide(Call()))
  gone = bridge.Bridge({"hook_timeout_s": 10})
  gone.controller_gone = True
  out["controller_gone"] = shown(await gone.decide(Call()))
  # A call that is waiting for its decision when the session is cancelled.
  waiting = bridge.Bridge({"hook_timeout_s": 10})
  task = asyncio.ensure_future(waiting.decide(Call()))
  await asyncio.sleep(0.05)
  await waiting.cancel("the stage was stopped")
  out["cancelled_while_waiting"] = shown(await task)
  return out


START = {"model": "gemini-4-carbon", "thinking": "high", "gateway": {"url": "http://127.0.0.1:1", "token": "session-token"}, "workspace": "/w", "save_dir": "/s",
         "app_data_dir": "/a", "system": "the implementer's instructions", "prompt": "p", "enabled_tools": ["view_file", "create_file", "run_command", "finish", "invoke_subagent"],
         "subagents": [{"name": "code-explorer", "description": "d", "system": "s1", "model": "gemini-4-hydrogen", "tools": ["view_file"]},
                       {"name": "test-constructor", "description": "d", "system": "s2", "model": "gemini-4-hydrogen", "tools": ["view_file", "create_file"]}],
         "max_subagent_depth": 1, "budget": {"max_model_calls": 5, "max_tool_calls": 7}, "command_timeout_s": 30}


def described(cfg):
  c = bridge.Bridge(cfg).build_config()
  caps = c.capabilities
  value = lambda e: getattr(e, "value", e)
  return {
      "models": [{"name": m.name, "types": [value(t) for t in m.types], "base_url": m.endpoint.base_url, "api_key": m.endpoint.api_key} for m in c.models],
      "thinking": value(c.models[0].endpoint.options.thinking_level),
      "enable_subagents": caps.enable_subagents, "max_subagent_depth": caps.max_subagent_depth, "allowed_subagents": caps.allowed_subagents,
      "enabled_tools": [value(t) for t in caps.enabled_tools],
      "run_command": {"enable_daemons": caps.run_command_config.enable_daemons, "enable_sandbox": caps.run_command_config.enable_sandbox, "timeout_seconds": caps.run_command_config.timeout_seconds},
      "policies": [[p.tool, value(p.decision), p.name] for p in c.policies],
      "api_retries": c.retry_config.api_retry.max_retries,
      "budget": {"max_model_calls": c.budget_config.max_model_calls, "max_tool_calls": c.budget_config.max_tool_calls},
      "subagents": [{"name": s.name, "model": s.model, "system": s.system_instructions, "enabled_tools": [value(t) for t in s.capabilities.enabled_tools]} for s in c.subagents],
      "workspaces": list(c.workspaces), "save_dir": c.save_dir, "app_data_dir": c.app_data_dir, "system_instructions": c.system_instructions, "hooks": len(c.hooks),
  }


def config():
  return {"with_subagents": described(START),
          "without_subagents": described({**START, "subagents": [], "enabled_tools": ["view_file", "create_file", "run_command", "finish"]})}


out = asyncio.run(decide()) if sys.argv[2] == "decide" else config()
print("RESULT " + json.dumps(out, default=str))
