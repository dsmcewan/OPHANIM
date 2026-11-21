#!/usr/bin/env python
# THE ANTIGRAVITY SDK BRIDGE: one implementer session run with the official google-antigravity Python SDK, driven by
# the controller (pantheon/src/antigravity/turn.mjs) over JSON lines on stdin/stdout.
#
# This file is deliberately THIN. It decides nothing: every tool call the SDK is about to run is sent to the
# controller and waits for its decision (no decision in time, or no controller: DENIED). It holds no credential: the
# "API key" it gives the SDK is a per-session token for the controller's loopback model gateway
# (pantheon/src/antigravity/gateway.mjs), which holds the real GEMINI_API_KEY and admits every billed request.
# It never invokes the agy CLI.
#
# PROTOCOL (one JSON object per line).
#   controller -> bridge   {"type":"start", ...config}            first line
#                          {"type":"decision","id":N,"allow":bool,"message":str?,"modified_args":{}?}
#                          {"type":"cancel","reason":str}          (EOF on stdin is a cancel too)
#   bridge -> controller   {"type":"identity","runtime":{...},"capabilities":{...}}
#                          {"type":"ready","conversation_id":str|null}
#                          {"type":"hook","id":N,"tool":str,"args":{},"call_id":str|null,"step_id":str|null,
#                           "trajectory_id":str|null,"server_name":str|null}      waits for the decision with that id
#                          {"type":"event","event":"trajectory_state"|"usage"|"child_started"|"child_output"|
#                           "post_tool"|"tool_error"|"heartbeat", ...}
#                          {"type":"result","ok":true,"text":str,"structured_output":any,"stop_reason":str,...}
#                          {"type":"result","ok":false,"error":{"kind":str,"type":str,"message":str,...}}
# Exit: 0 a completed turn, 2 usage, 3 a harness or provider error, 4 timeout, 5 cancelled.
#
# `--identity` prints the runtime identity (python, the SDK distribution and version, the harness binary) and exits 0
# without starting anything; `--identity --hash` adds the harness binary's sha256.
#
# TWO ADAPTER SEAMS reach below the SDK's public surface. Each is guarded, and what could not be applied is reported
# in `capabilities` so the controller records it instead of assuming it:
#   trajectory_events        the SDK's event processor ignores subagent trajectory events ("Subagent execution is
#                            coordinated by the harness"); the bridge taps process_event to forward every trajectory's
#                            state and usage. Without it, subagent lifecycle is unobserved (admission still holds).
#   define_subagent_disabled the runtime offers the model a define_subagent tool that no SDK hook or policy sees. The
#                            harness config has a field that removes the tool; the SDK does not expose it. The bridge
#                            sets it. Without it the tool is offered, and a type it defines is still refused at
#                            invoke_subagent by the controller.
import asyncio
import hashlib
import importlib
import importlib.metadata
import json
import os
import re
import signal
import sys
import time
from pathlib import Path
from typing import Any

_SDK_IMPORT_ERROR = None
try:
  from google.antigravity import Agent, LocalAgentConfig, types
  from google.antigravity.hooks import hooks, policy
except Exception as e:  # ImportError, or a broken install
  Agent = LocalAgentConfig = types = hooks = policy = None
  _SDK_IMPORT_ERROR = f"{type(e).__name__}: {e}"

T0 = time.time()
_OUT_LOCK = None


def runtime_identity(with_hash: bool = False) -> dict:
  sdk = {"module": "google.antigravity", "status": "absent", "distribution": None, "version": None, "path": None}
  ident = {"python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}", "executable": sys.executable, "sdk": sdk, "harness": None}
  if _SDK_IMPORT_ERROR is not None:
    sdk["error"] = _SDK_IMPORT_ERROR
    return ident
  module = importlib.import_module("google.antigravity")
  sdk["status"] = "installed"
  module_file = getattr(module, "__file__", None)
  if module_file is not None:
    module_path = Path(module_file).resolve()
    sdk["path"] = str(module_path.parent)
    for dist in importlib.metadata.distributions():
      try:
        if any(Path(dist.locate_file(f)).resolve() == module_path for f in (dist.files or ())):
          sdk["distribution"] = dist.metadata["Name"]
          sdk["version"] = dist.version
          break
      except Exception:
        continue
    harness = module_path.parent / "bin" / "localharness"
    if harness.exists():
      st = harness.stat()
      ident["harness"] = {"path": str(harness), "bytes": st.st_size}
      if with_hash:
        h = hashlib.sha256()
        with harness.open("rb") as f:
          for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
        ident["harness"]["sha256"] = "sha256:" + h.hexdigest()
  return ident


def emit(obj: dict) -> None:
  sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
  sys.stdout.flush()


def sha(text: str) -> str:
  return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def usage_dict(u: Any) -> dict | None:
  if u is None:
    return None
  out = {}
  for k in ("prompt_token_count", "cached_content_token_count", "candidates_token_count", "thoughts_token_count", "total_token_count"):
    v = getattr(u, k, None)
    if v is not None:
      out[k] = int(v)
  return out


_STATE = re.compile(r"^STATE_")
_CHILD_MESSAGE = re.compile(r"content=(.*)\Z", re.S)


class Bridge:
  def __init__(self, cfg: dict):
    self.cfg = cfg
    self.pending: dict[int, asyncio.Future] = {}
    self.next_id = 0
    self.cancelled: str | None = None
    self.controller_gone = False
    self.conversation = None
    self.root: str | None = None
    self.root_text = ""
    self.root_error_code: str | None = None
    self.root_stop_reason: str | None = None
    self.tool_calls = 0
    self.capabilities = {"trajectory_events": False, "define_subagent_disabled": False}
    self.seen_children: set[str] = set()

  # ---- the controller's decision for one tool call -----------------------------------------------------------------
  async def decide(self, call: Any) -> Any:
    self.tool_calls += 1
    self.next_id += 1
    n = self.next_id
    step_id = getattr(call, "step_id", None)
    traj = step_id.rsplit(":", 1)[0] if isinstance(step_id, str) and ":" in step_id else None
    fut = asyncio.get_running_loop().create_future()
    self.pending[n] = fut
    emit({"type": "hook", "id": n, "tool": str(call.name), "args": getattr(call, "args", None) or {}, "call_id": getattr(call, "id", None),
          "step_id": step_id, "trajectory_id": traj, "server_name": getattr(call, "server_name", None)})
    try:
      if self.controller_gone or self.cancelled:
        return types.HookResult(allow=False, message="PANTHEON_NO_CONTROLLER: the session is stopping; nothing more is run")
      d = await asyncio.wait_for(fut, timeout=float(self.cfg.get("hook_timeout_s") or 30))
    except asyncio.TimeoutError:
      return types.HookResult(allow=False, message="PANTHEON_NO_DECISION: the controller did not decide in time; denied")
    finally:
      self.pending.pop(n, None)
    if d.get("allow") is True:
      mod = d.get("modified_args")
      return types.HookResult(allow=True, modified_args=mod) if isinstance(mod, dict) else types.HookResult(allow=True)
    return types.HookResult(allow=False, message=str(d.get("message") or "denied by the controller")[:2000])

  # ---- the raw event tap (adapter seam: trajectory_events) ---------------------------------------------------------
  def install_tap(self) -> None:
    try:
      from google.antigravity.connections.local import event_processor as ep
      proc = ep.LocalHarnessEventProcessor
      original = proc.process_event
      bridge = self

      async def tapped(self_, event):
        try:
          bridge.on_raw(event)
        except Exception as e:  # the tap never breaks the session
          emit({"type": "event", "event": "tap_error", "error": repr(e)[:300]})
        return await original(self_, event)

      proc.process_event = tapped
      self.capabilities["trajectory_events"] = True
    except Exception as e:
      self.capabilities["trajectory_events_error"] = repr(e)[:300]

  def on_raw(self, event: Any) -> None:
    which = event.WhichOneof("event")
    if which == "trajectory_state_update":
      t = event.trajectory_state_update
      state = _STATE.sub("", type(t).State.Name(t.state))
      stop = type(t).StopReason.Name(t.stop_reason).replace("STOP_REASON_", "")
      if not t.parent_trajectory_id and t.depth == 0:
        if self.root is None:
          self.root = t.trajectory_id
        if t.trajectory_id == self.root:
          if t.error_code:
            self.root_error_code = t.error_code
          if stop != "UNSPECIFIED":
            self.root_stop_reason = stop
      emit({"type": "event", "event": "trajectory_state", "trajectory_id": t.trajectory_id, "parent_trajectory_id": t.parent_trajectory_id, "depth": t.depth,
            "state": state, "error": t.error[:500] if t.error else "", "error_code": t.error_code, "stop_reason": stop})
    elif which == "usage_update":
      u = event.usage_update
      emit({"type": "event", "event": "usage", "agents": {a.trajectory_id: {"prompt_token_count": a.usage.prompt_token_count, "cached_content_token_count": a.usage.cached_content_token_count,
            "candidates_token_count": a.usage.candidates_token_count, "thoughts_token_count": a.usage.thoughts_token_count, "total_token_count": a.usage.total_token_count} for a in u.agents},
            "total": {"total_token_count": u.total.total_token_count}})
    elif which == "step_update":
      s = event.step_update
      if not s.parent_trajectory_id:
        return
      source = type(s).Source.Name(s.source)
      state = type(s).State.Name(s.state)
      # A child's first step is the message it was started with: the assignment the controller admitted.
      if s.trajectory_id not in self.seen_children and s.step_index == 0 and source == "SOURCE_SYSTEM":
        m = _CHILD_MESSAGE.search(s.text or "")
        if m:
          self.seen_children.add(s.trajectory_id)
          emit({"type": "event", "event": "child_started", "trajectory_id": s.trajectory_id, "parent_trajectory_id": s.parent_trajectory_id, "prompt_key": sha(m.group(1).strip())})
      elif source == "SOURCE_MODEL" and state == "STATE_DONE" and s.text:
        emit({"type": "event", "event": "child_output", "trajectory_id": s.trajectory_id, "digest": sha(s.text), "bytes": len(s.text.encode("utf-8"))})

  # ---- the SDK configuration ---------------------------------------------------------------------------------------
  def build_config(self) -> Any:
    c = self.cfg
    gw = c["gateway"]
    options = types.GeminiModelOptions(
        thinking_level=types.ThinkingLevel(c["thinking"]) if c.get("thinking") else None,
        max_output_tokens=int(c["max_output_tokens"]) if c.get("max_output_tokens") else None)
    endpoint = types.GeminiAPIEndpoint(api_key=gw["token"], base_url=gw["url"], options=options)
    # Both model types go to the gateway: nothing the runtime calls may reach the provider around it.
    models = [types.ModelTarget(name=c["model"], types=[types.ModelType.TEXT], endpoint=endpoint),
              types.ModelTarget(name=c["model"], types=[types.ModelType.IMAGE], endpoint=types.GeminiAPIEndpoint(api_key=gw["token"], base_url=gw["url"]))]
    tool = lambda name: types.BuiltinTools(name)
    subs = []
    for s in c.get("subagents") or []:
      subs.append(types.SubagentConfig(
          name=s["name"], description=s["description"], system_instructions=s["system"], model=s["model"],
          capabilities=types.SubagentCapabilities(enabled_tools=[tool(t) for t in s["tools"]])))
    enabled = [tool(t) for t in c["enabled_tools"]]
    caps = types.CapabilitiesConfig(
        enable_subagents=bool(subs), enabled_tools=enabled,
        max_subagent_depth=int(c.get("max_subagent_depth") or 1) if subs else None,
        allowed_subagents=[s.name for s in subs] if subs else None,
        run_command_config=types.RunCommandConfig(enable_daemons=False, enable_sandbox=False, timeout_seconds=float(c.get("command_timeout_s") or 600)))
    b = c.get("budget") or {}
    budget = types.BudgetConfig(**{k: int(v) for k, v in b.items() if v})
    bridge = self

    @hooks.pre_tool_call_decide
    async def pre_tool(data: types.ToolCall) -> types.HookResult:
      return await bridge.decide(data)

    @hooks.post_tool_call
    async def post_tool(data: Any) -> None:
      res = getattr(data, "result", None)
      body = json.dumps(res, ensure_ascii=False, default=str) if res is not None else ""
      step_id = getattr(data, "step_id", None)
      emit({"type": "event", "event": "post_tool", "tool": str(getattr(data, "name", "?")), "step_id": step_id,
            "trajectory_id": step_id.rsplit(":", 1)[0] if isinstance(step_id, str) and ":" in step_id else None,
            "error": (getattr(data, "error", None) or "")[:500], "result_bytes": len(body.encode("utf-8")), "result_digest": sha(body) if body else None})

    @hooks.on_tool_error
    async def on_error(data: Exception) -> None:
      emit({"type": "event", "event": "tool_error", "tool": str(getattr(data, "tool_name", "?")), "error": str(data)[:500]})

    return LocalAgentConfig(
        models=models,
        system_instructions=c.get("system") or None,
        workspaces=[c["workspace"]],
        save_dir=c["save_dir"], app_data_dir=c["app_data_dir"],
        capabilities=caps, subagents=subs,
        # Everything is allowed AT THE POLICY LAYER inside the workspace: the controller's decision at the pre-tool hook
        # is what admits or refuses a call. workspace_only keeps the runtime's own file containment on beside it.
        policies=[policy.allow_all(), *policy.workspace_only([c["workspace"]])],
        hooks=[pre_tool, post_tool, on_error],
        # No retry inside the runtime: a refused or failed request is the controller's to judge, once.
        retry_config=types.RetryConfig(api_retry=types.ModelAPIRetryConfig(max_retries=0)),
        budget_config=budget,
        response_schema=c.get("schema") or None)

  def disable_define_subagent(self) -> None:
    """Adapter seam: remove the model-facing define_subagent tool (see the header)."""
    if not self.cfg.get("disable_define_subagent", True):
      return
    try:
      from google.antigravity.connections.local import local_connection as lc
      strategy = lc.LocalConnectionStrategy
      original = strategy._build_harness_config
      bridge = self

      def patched(self_):
        cfg = original(self_)
        cfg.harness_side_tools.subagents.disable_define_subagent_tool = True
        for ca in cfg.custom_subagents:
          ca.harness_side_tools.subagents.disable_define_subagent_tool = True
        bridge.capabilities["define_subagent_disabled"] = True
        return cfg

      strategy._build_harness_config = patched
    except Exception as e:
      self.capabilities["define_subagent_error"] = repr(e)[:300]

  # ---- the controller's lines --------------------------------------------------------------------------------------
  async def read_controller(self, reader: asyncio.StreamReader) -> None:
    while True:
      line = await reader.readline()
      if not line:
        self.controller_gone = True
        await self.cancel("the controller closed the channel")
        return
      try:
        msg = json.loads(line)
      except Exception:
        continue
      if msg.get("type") == "decision":
        fut = self.pending.get(msg.get("id"))
        if fut is not None and not fut.done():
          fut.set_result(msg)
      elif msg.get("type") == "cancel":
        await self.cancel(str(msg.get("reason") or "cancelled by the controller"))

  async def cancel(self, why: str) -> None:
    if self.cancelled:
      return
    self.cancelled = why[:300]
    for fut in list(self.pending.values()):
      if not fut.done():
        fut.set_result({"allow": False, "message": f"PANTHEON_CANCELLED: {self.cancelled}"})
    if self.conversation is not None:
      try:
        await asyncio.wait_for(self.conversation.cancel(), timeout=10)
      except Exception:
        pass

  # ---- one turn ------------------------------------------------------------------------------------------------------
  async def turn(self) -> dict:
    self.install_tap()
    self.disable_define_subagent()
    config = self.build_config()
    started = time.time()
    async with Agent(config) as agent:
      self.conversation = agent.conversation
      emit({"type": "ready", "conversation_id": getattr(self.conversation, "conversation_id", None), "capabilities": self.capabilities})
      if self.cancelled:
        raise asyncio.CancelledError()
      await self.conversation.send(self.cfg["prompt"])
      last_beat = time.time()
      async for step in self.conversation.receive_steps():
        tid = getattr(step, "trajectory_id", "") or ""
        if self.root is None and tid and not getattr(step, "parent_trajectory_id", ""):
          self.root = tid
        is_root = (not getattr(step, "parent_trajectory_id", "")) and (self.root is None or tid == self.root)
        if is_root and step.source == types.StepSource.MODEL and step.is_complete_response and step.content:
          self.root_text = step.content
        if time.time() - last_beat > 15:
          last_beat = time.time()
          emit({"type": "event", "event": "heartbeat", "elapsed_s": round(time.time() - started, 1), "tool_calls": self.tool_calls})
      structured = None
      if self.cfg.get("schema"):
        try:
          structured = self.conversation.get_last_structured_output()
        except Exception:
          structured = None
      stop = self.root_stop_reason
      if stop is None:
        try:
          stop = str(getattr(self.conversation, "_last_turn_stop_reason").value)
        except Exception:
          stop = "UNSPECIFIED"
      usages = {}
      try:
        usages = {k: usage_dict(v) for k, v in self.conversation.trajectory_usages.items()}
      except Exception:
        usages = {}
      return {"type": "result", "ok": True, "text": self.root_text, "structured_output": structured, "stop_reason": stop,
              "usage": usage_dict(getattr(self.conversation, "total_usage", None)), "trajectory_usages": usages, "root_trajectory_id": self.root,
              "conversation_id": getattr(self.conversation, "conversation_id", None), "tool_calls": self.tool_calls,
              "duration_s": round(time.time() - started, 2), "capabilities": self.capabilities}


def failure(bridge: Bridge | None, kind: str, exc: BaseException | None, **more: Any) -> dict:
  err = {"kind": kind, "type": type(exc).__name__ if exc is not None else None, "message": (str(exc) if exc is not None else "")[:1500], **more}
  if bridge is not None:
    err["root_error_code"] = bridge.root_error_code
    err["root_stop_reason"] = bridge.root_stop_reason
    err["tool_calls"] = bridge.tool_calls
    err["capabilities"] = bridge.capabilities
    err["root_trajectory_id"] = bridge.root
  return {"type": "result", "ok": False, "error": err}


async def main() -> int:
  if "--identity" in sys.argv[1:]:
    emit(runtime_identity(with_hash="--hash" in sys.argv[1:]))
    return 0
  ident = runtime_identity()
  if ident["sdk"]["status"] != "installed":
    emit({"type": "result", "ok": False, "error": {"kind": "sdk_absent", "type": None, "message": ident["sdk"].get("error") or "google-antigravity is not installed", "runtime": ident}})
    return 3
  loop = asyncio.get_running_loop()
  reader = asyncio.StreamReader(limit=64 * 1024 * 1024)
  await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
  first = await reader.readline()
  try:
    cfg = json.loads(first)
    assert cfg.get("type") == "start"
    for k in ("model", "gateway", "workspace", "save_dir", "app_data_dir", "prompt", "enabled_tools"):
      assert k in cfg, k
  except Exception as e:
    emit({"type": "result", "ok": False, "error": {"kind": "usage", "type": type(e).__name__, "message": f"the first line is the start message: {e}"[:300]}})
    return 2
  emit({"type": "identity", "runtime": ident})
  bridge = Bridge(cfg)
  ctl = asyncio.create_task(bridge.read_controller(reader))
  for sig in (signal.SIGTERM, signal.SIGINT):
    try:
      loop.add_signal_handler(sig, lambda s=sig: asyncio.ensure_future(bridge.cancel(f"signal {s.name}")))
    except Exception:
      pass
  code, out = 0, None
  try:
    out = await asyncio.wait_for(bridge.turn(), timeout=float(cfg.get("turn_timeout_s") or 1800))
    if bridge.cancelled:
      code, out = 5, failure(bridge, "cancelled", None, reason=bridge.cancelled)
  except asyncio.TimeoutError as e:
    await bridge.cancel("the turn's timeout")
    code, out = 4, failure(bridge, "timeout", e, timeout_s=cfg.get("turn_timeout_s") or 1800)
  except asyncio.CancelledError as e:
    code, out = 5, failure(bridge, "cancelled", e, reason=bridge.cancelled)
  except Exception as e:
    if bridge.cancelled or type(e).__name__ == "AntigravityCancelledError":
      code, out = 5, failure(bridge, "cancelled", e, reason=bridge.cancelled)
    else:
      code, out = 3, failure(bridge, "harness", e)
  finally:
    ctl.cancel()
  emit(out)
  return code


if __name__ == "__main__":
  try:
    sys.exit(asyncio.run(main()))
  except KeyboardInterrupt:
    sys.exit(5)
