#!/usr/bin/env node
// Fixture: a SCRIPTED stand-in for scripts/antigravity-bridge.py, speaking its JSON-lines protocol, so the
// controller's side of an Antigravity SDK session (src/antigravity/turn.mjs) is tested without the SDK, a model or a
// network. It is launched exactly as the real bridge is (`<python> <bridge>` -> `node <this file>`), inside the same
// jail when the test asks for one.
//
// THE SCRIPT is the start message's prompt: "FAKE:" + JSON [{step}, ...], run in order:
//   {hook: {tool, args, from?}}            ask the controller to decide a tool call; `from` is "root" (default) or a
//                                          child's trajectory id. The decision is kept in the result's `decisions`.
//   {write: {path, content}, if?: N}       write a file (when decision N allowed, or always): what the SDK's tool does
//   {event: {...}}                         an event line (trajectory_state, usage, child_started, child_output)
//   {request: {model, as: "root" | "<type>", session?}}  one generation request to the gateway, as the runtime makes it
//   {probe: true}                          record what this process can see: env names, pid 1, /tmp entries, key hunt
//   {sleep: ms} | {hang: true} | {crash: code} | {stderr: text}
//   {identity: {version}}                  (must be first) report another SDK version
//   {result: {text?, stop_reason?, structured_output?}}  the final result (default: ok with text "done")
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

const out = o => process.stdout.write(JSON.stringify(o) + "\n");
const sha = s => "sha256:" + createHash("sha256").update(s).digest("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const waiting = new Map();
let start = null, cancelled = null, onStart = null;
const started = new Promise(r => { onStart = r; });
rl.on("line", line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === "start") { start = m; onStart(); }
  else if (m.type === "decision") { waiting.get(m.id)?.(m); waiting.delete(m.id); }
  else if (m.type === "cancel") { cancelled = m.reason ?? "cancelled"; for (const f of waiting.values()) f({ allow: false, message: "cancelled" }); }
});
rl.on("close", () => { cancelled ??= "the controller closed the channel"; if (!start) process.exit(2); });

await started;
const steps = JSON.parse(start.prompt.slice(start.prompt.indexOf("FAKE:") + 5));
const version = steps[0]?.identity?.version ?? "0.1.24";
out({ type: "identity", runtime: { python: "fake", executable: process.execPath, sdk: { module: "google.antigravity", status: "installed", distribution: "google-antigravity", version, path: "/fake" }, harness: null } });
out({ type: "ready", conversation_id: "conv-fake", capabilities: { trajectory_events: true, define_subagent_disabled: true } });
const ROOT = "root-traj";
out({ type: "event", event: "trajectory_state", trajectory_id: ROOT, parent_trajectory_id: "", depth: 0, state: "RUNNING", error: "", error_code: "", stop_reason: "UNSPECIFIED" });
const markerOf = as => (as === "root" ? /\[pantheon-agent:[0-9a-f]+:implementer\]/.exec(start.system)?.[0] : /\[pantheon-agent:[0-9a-f]+:subagent:[a-z-]+\]/.exec((start.subagents ?? []).find(s => s.name === as)?.system ?? "")?.[0]) ?? `[unmarked:${as}]`;
const decisions = [], requests = [], probes = [];
let id = 0, result = { text: "done" };
for (const s of steps) {
  if (cancelled) break;
  if (s.identity) continue;
  if (s.hook) {
    const n = ++id, from = s.hook.from && s.hook.from !== "root" ? s.hook.from : ROOT;
    const p = new Promise(r => waiting.set(n, r));
    out({ type: "hook", id: n, tool: s.hook.tool, args: s.hook.args ?? {}, call_id: `call-${n}`, step_id: `${from}:${n}`, trajectory_id: from, server_name: s.hook.server_name ?? null });
    const d = await p;
    decisions.push({ n, tool: s.hook.tool, allow: d.allow === true, message: d.message ?? null });
  } else if (s.write) {
    if (s.if === undefined || decisions.find(d => d.n === s.if)?.allow) { mkdirSync(dirname(s.write.path), { recursive: true }); writeFileSync(s.write.path, s.write.content); }
  } else if (s.event) {
    const e = { ...s.event };
    if (e.event === "child_started" && typeof e.prompt === "string") { e.prompt_key = sha(e.prompt.trim()); delete e.prompt; }
    out({ type: "event", ...e });
  } else if (s.request) {
    const sys = { parts: [{ text: `agent ${markerOf(s.request.as)}` }] };
    try {
      const r = await fetch(`${start.gateway.url}/v1beta/models/${s.request.model}:streamGenerateContent?alt=sse`, { method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": start.gateway.token }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "go" }] }], sessionId: s.request.session ?? `sess-${s.request.as}`, systemInstruction: sys }) });
      const body = await r.text();
      requests.push({ model: s.request.model, as: s.request.as, status: r.status, body: body.slice(0, 300) });
    } catch (e) { requests.push({ model: s.request.model, as: s.request.as, status: null, error: String(e?.message ?? e).slice(0, 200) }); }
  } else if (s.probe) {
    const env = { ...process.env };
    const hunt = (s.probe.needles ?? []).filter(n => JSON.stringify(env).includes(n) || process.argv.join(" ").includes(n));
    let pid1 = null, tmp = null, start_keys = Object.keys(start).sort();
    try { pid1 = readFileSync("/proc/1/comm", "utf8").trim(); } catch { pid1 = null; }
    try { tmp = readdirSync("/tmp").sort(); } catch { tmp = null; }
    const canRead = (s.probe.read ?? []).map(p => { try { readFileSync(p); return [p, true]; } catch { return [p, false]; } });
    const canWrite = (s.probe.write ?? []).map(p => { try { writeFileSync(p, "x"); return [p, true]; } catch { return [p, false]; } });
    probes.push({ env_names: Object.keys(env).sort(), needles_found: hunt, pid1, tmp, start_keys, can_read: Object.fromEntries(canRead), can_write: Object.fromEntries(canWrite), cwd: process.cwd(),
      gateway_token_is_key: (s.probe.needles ?? []).includes(start.gateway.token), enabled_tools: start.enabled_tools, subagents: (start.subagents ?? []).map(x => ({ name: x.name, model: x.model, tools: x.tools })),
      model: start.model, thinking: start.thinking ?? null, start_has_needle: (s.probe.needles ?? []).some(n => JSON.stringify({ ...start, prompt: null }).includes(n)), budget: start.budget });   // the prompt IS this script, needles included
  } else if (s.sleep) await sleep(s.sleep);
  else if (s.hang) { await new Promise(r => { const t = setInterval(() => { if (cancelled) { clearInterval(t); r(); } }, 50); }); }
  else if (s.crash !== undefined) process.exit(s.crash);
  else if (s.stderr) process.stderr.write(s.stderr);
  else if (s.result) result = { ...result, ...s.result };
}
if (cancelled) { out({ type: "result", ok: false, error: { kind: "cancelled", type: null, message: "", reason: cancelled, decisions, requests } }); process.exit(5); }
out({ type: "event", event: "trajectory_state", trajectory_id: ROOT, parent_trajectory_id: "", depth: 0, state: "FULLY_IDLE", error: "", error_code: "", stop_reason: result.stop_reason ?? "UNSPECIFIED" });
if (result.ok === false) { out({ type: "result", ok: false, error: { kind: result.kind ?? "harness", type: "AntigravityExecutionError", message: result.message ?? "scripted failure", decisions, requests } }); process.exit(3); }
out({ type: "result", ok: true, text: JSON.stringify({ note: result.text, decisions, requests, probes }), structured_output: result.structured_output ?? null, stop_reason: result.stop_reason ?? "UNSPECIFIED",
  usage: { total_token_count: 1 }, trajectory_usages: {}, root_trajectory_id: ROOT, conversation_id: "conv-fake", tool_calls: id, duration_s: 0.1, capabilities: { trajectory_events: true, define_subagent_disabled: true } });
process.exit(0);
