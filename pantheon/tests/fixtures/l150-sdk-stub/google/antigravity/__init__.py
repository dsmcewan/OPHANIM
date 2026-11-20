# A STUB of the google-antigravity SDK for register L-150's CI tests (the CI runner has no SDK; the real one was run
# once, against a local fake, in the real-SDK proof). On PYTHONPATH it stands in for `google.antigravity`, and it sends
# THE SAME HTTP REQUESTS the real SDK's harness (google/antigravity/bin/localharness, the Go google-genai client) was
# observed to send, to the same place -- the endpoint's base_url, the endpoint's api_key in x-goog-api-key:
#   POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse   every model call of the root agent and of a
#        subagent (its own sessionId, its tools without invoke_subagent), each retry of a 429/500/503, each continuation
#        after a tool call, the turn after a subagent's answer arrives
#   POST {base}/v1beta/models/{model}:generateContent                  the web search tool (googleSearch, no sessionId)
# An HTTP 400/401/403 ends the turn with AntigravityConnectionError carrying the response's message, as the real SDK
# does; BudgetConfig.max_model_calls stops the session (StopReason.MAX_MODEL_CALLS_EXCEEDED). No real provider is ever
# reachable from it in a test: its base URL is the metering relay, whose upstream is a local fake.
import asyncio
import json
import os
import random
import time
import urllib.error
import urllib.request
from pathlib import Path

from google.antigravity import types  # noqa: F401
from google.antigravity.types import AntigravityConnectionError, StopReason

__version__ = "0.0.0-l150-stub"
API_RETRIES = 3
_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # loopback: never through a proxy (as Go's net/http)


class LocalAgentConfig:
  def __init__(self, **kw):
    if "vertex" in kw:
      raise ValueError("the L-150 stub models the Gemini API endpoint only")
    self.__dict__.update(kw)


class _Usage:
  def __init__(self):
    self.prompt_token_count = 0
    self.candidates_token_count = 0
    self.total_token_count = 0


class _Response:
  def __init__(self, agent, brief):
    self._agent, self._brief, self._tokens, self._done = agent, brief, asyncio.Queue(), asyncio.Event()
    self._text, self._error = "", None
    self.usage_metadata = _Usage()
    self.stop_reason = StopReason.UNSPECIFIED
    self._loop = asyncio.get_running_loop()
    self._task = self._loop.create_task(self._run())

  def emit(self, tok):
    """A text part as it arrives (called from the harness thread): the stream the seat narrates and keeps."""
    self._loop.call_soon_threadsafe(self._tokens.put_nowait, tok)

  async def _run(self):
    try:
      self._text = await asyncio.to_thread(self._agent._turn, self._brief, self)
    except Exception as e:  # surfaced from text() and the stream, as the real SDK surfaces a step error
      self._error = e
    finally:
      await self._tokens.put(None)
      self._done.set()

  def __aiter__(self):
    return self._iter()

  async def _iter(self):
    while True:
      tok = await self._tokens.get()
      if tok is None:
        if self._error is not None:
          raise self._error
        return
      if tok:
        yield tok

  @property
  def thoughts(self):
    async def none():
      if False:
        yield ""
    return none()

  async def text(self):
    await self._done.wait()
    if self._error is not None:
      raise self._error
    return self._text

  async def structured_output(self):
    return json.loads(await self.text())

  async def cancel(self):
    self._agent._cancelled = True


class Agent:
  def __init__(self, config):
    self.config = config
    self.conversation_id = "l150-stub-" + "%016x" % random.getrandbits(64)
    self._calls, self._cancelled = 0, False
    self._hooks = {getattr(h, "_l150_hook", None): h for h in (getattr(config, "hooks", None) or [])}
    text_models = [m for m in config.models if "text" in [str(getattr(t, "value", t)) for t in m.types]]
    self._model = text_models[0]
    budget = getattr(config, "budget_config", None)
    self._max_calls = getattr(budget, "max_model_calls", None) or 10**9
    subs = getattr(config, "subagents", None) or []
    self._sub_names = [s.name for s in subs]
    self._sub_body = {s.name: s.system_instructions for s in subs}

  async def __aenter__(self):
    return self

  async def __aexit__(self, *exc):
    return False

  async def chat(self, brief):
    return _Response(self, brief)

  # ---- the harness's HTTP behaviour, as observed ------------------------------------------------------------------
  def _post(self, method, body, model):
    ep = self._model.endpoint
    url = f"{ep.base_url.rstrip('/')}/v1beta/models/{model}:{method}" + ("?alt=sse" if method == "streamGenerateContent" else "")
    data = json.dumps(body).encode("utf-8")
    for attempt in range(API_RETRIES + 1):
      req = urllib.request.Request(url, data=data, method="POST", headers={
          "content-type": "application/json", "x-goog-api-key": ep.api_key or "",
          "user-agent": "google-antigravity-sdk/0.0.0-l150-stub", "x-goog-api-client": "l150-stub"})
      try:
        with _NO_PROXY.open(req, timeout=120) as r:
          raw = r.read().decode("utf-8")
        break
      except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
          err = json.loads(detail).get("error", {})
        except Exception:
          err = {}
        if e.code in (429, 500, 502, 503) and attempt < API_RETRIES:
          time.sleep(0.05 * (2 ** attempt))
          continue
        raise AntigravityConnectionError(
            f"Agent execution terminated due to error. (\"agent executor error: Error {e.code}, Message: {err.get('message', detail)[:1500]}, "
            f"Status: {err.get('status', '')}\")")
    if method == "streamGenerateContent":
      events = [json.loads(l[5:].strip()) for l in raw.splitlines() if l.startswith("data:")]
    else:
      events = [json.loads(raw)]
    parts = [p for ev in events for c in ev.get("candidates", []) for p in (c.get("content") or {}).get("parts", [])]
    for ev in events:
      um = ev.get("usageMetadata") or {}
      self._usage.prompt_token_count += um.get("promptTokenCount", 0)
      self._usage.candidates_token_count += um.get("candidatesTokenCount", 0)
      self._usage.total_token_count += um.get("totalTokenCount", 0)
    return parts

  def _decls(self, subagent):
    tools = [t.value if hasattr(t, "value") else str(t) for t in (self.config.capabilities.enabled_tools or [])]
    names = sorted(set(t for t in tools if t != "invoke_subagent"))
    if not subagent and self._sub_names:
      names.append("invoke_subagent")
    return [{"functionDeclarations": [{"name": n, "parametersJsonSchema": {"type": "object"}} for n in names]}]

  def _hook(self, kind, data):
    h = self._hooks.get(kind)
    if h is not None:
      asyncio.run(h(data))

  def _conversation(self, prompt, system, subagent):
    """One agent conversation (the root or a subagent), its own sessionId, until a final text answer."""
    session = str(random.randint(-(2 ** 63), 2 ** 63 - 1))
    contents = [{"role": "user", "parts": [{"text": prompt}]}]
    pending, text = [], ""
    while True:
      if self._cancelled:
        return text
      if self._calls >= self._max_calls:
        self._resp.stop_reason = StopReason.MAX_MODEL_CALLS_EXCEEDED
        return text
      self._calls += 1
      parts = self._post("streamGenerateContent", {
          "contents": contents, "generationConfig": {"maxOutputTokens": 65535}, "sessionId": session,
          "systemInstruction": {"parts": [{"text": system}]}, "toolConfig": {"functionCallingConfig": {"mode": "AUTO"}},
          "tools": self._decls(subagent)}, self._model.name)
      contents.append({"role": "model", "parts": parts})
      if not subagent:
        for p in parts:
          if p.get("text"):
            self._resp.emit(p["text"])
      calls = [p["functionCall"] for p in parts if "functionCall" in p]
      if not calls:
        text = "".join(p.get("text", "") for p in parts)
        if pending:  # a subagent's answer arrives: the root takes one more turn on it
          for name, sub_prompt in pending:
            answer = self._conversation(sub_prompt, self._sub_body.get(name, ""), True)
            contents.append({"role": "user", "parts": [{"text": f"[subagent {name}] {answer}"}]})
            self._hook("post_tool", types.ToolCall(name="invoke_subagent", args={"result": answer}))
          pending = []
          continue
        return text
      responses = []
      for c in calls:
        name, args = c.get("name"), c.get("args") or {}
        self._hook("pre_tool", types.ToolCall(name=name, args=args))
        if name == "view_file":
          p = Path(str(args.get("AbsolutePath", "")))
          out = p.read_text(encoding="utf-8")[:4000] if p.is_file() else "no such file"
        elif name == "search_web":
          found = self._post("generateContent", {"contents": [{"role": "user", "parts": [{"text": args.get("query", "")}]}],
                                                 "generationConfig": {}, "systemInstruction": {"parts": [{"text": "You are a search engine bot."}]},
                                                 "tools": [{"googleSearch": {}}]}, self._model.name)
          out = "".join(p.get("text", "") for p in found)
        elif name == "invoke_subagent":
          for s in args.get("Subagents") or []:
            pending.append((s.get("TypeName"), s.get("Prompt", "")))
          out = "subagent started"
        else:
          out = f"{name}: not available in the stub"
        if name != "invoke_subagent":
          self._hook("post_tool", types.ToolCall(name=name, args={"result": out}))
        responses.append({"functionResponse": {"name": name, "response": {"output": out}}})
      contents.append({"role": "user", "parts": responses})

  def _turn(self, brief, response):
    self._resp, self._usage = response, response.usage_metadata
    system = self.config.system_instructions if isinstance(self.config.system_instructions, str) else ""
    return self._conversation(brief, system, False)
