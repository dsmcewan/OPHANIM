// Stage 4 relay: the stdio MCP server the Antigravity agent launches. A real child process, speaking newline-delimited
// JSON-RPC on stdio, relaying ONE A2A message/send per tools/call to a REAL shim on a REAL Unix socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { startA2AShim } from "../src/pipeline/a2a-shim.mjs";
import { mcpHandler, MCP_PROTOCOL_VERSION } from "../src/pipeline/a2a-mcp-server.mjs";
import { MCP_SERVER_PATH } from "../src/pipeline/index.mjs";
import { GROK } from "./fixtures/pipeline-stages.mjs";

const shimFor = async (t, over = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "pmcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const turns = [];
  const shim = await startA2AShim({ unit_id: "u1", allowed_subagents: ["math"], socket: join(dir, "a2a.sock"), seatFor: () => ({ ...GROK }),
    subagentTurn: async args => { turns.push(args); return { text: `42 (asked: ${args.prompt.split("\n").at(-1)})`, served_model: "grok-4.5" }; }, ...over });
  t.after(() => shim.close());
  return { shim, turns };
};

/** Spawn the relay; returns {rpc(method, params), notify(method, params), stderr(), close()}. */
const relay = (t, env) => {
  const child = spawn(process.execPath, [MCP_SERVER_PATH], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let err = "", id = 0;
  child.stderr.on("data", d => { err += d; });
  const waiting = new Map(), stray = [];
  createInterface({ input: child.stdout }).on("line", line => {
    const m = JSON.parse(line);   // every stdout line must be a protocol message
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else stray.push(m);
  });
  const exited = new Promise(resolve => child.on("close", code => resolve(code)));
  t.after(() => { child.kill(); });
  return {
    rpc: (method, params) => new Promise(resolve => { const n = ++id; waiting.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, ...(params ? { params } : {}) }) + "\n"); }),
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n"),
    line: text => child.stdin.write(text + "\n"),
    stray, stderr: () => err,
    close: async () => { child.stdin.end(); return exited; },
  };
};

test("initialize -> tools/list -> tools/call over stdio: the answer round-trips through the shim's Unix socket", async t => {
  const { shim, turns } = await shimFor(t);
  const r = relay(t, { PANTHEON_A2A_SOCKET: shim.socket, PANTHEON_A2A_TOKEN: shim.token, PANTHEON_A2A_ROLES: "math", PANTHEON_UNIT_ID: "u1" });
  const init = await r.rpc("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.deepEqual(init.result, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pantheon-subagents", version: "1" } });
  r.notify("notifications/initialized");
  assert.deepEqual((await r.rpc("ping")).result, {});
  const list = await r.rpc("tools/list", {});
  assert.equal(list.result.tools.length, 1);
  assert.deepEqual(list.result.tools[0].name, "ask_subagent");
  assert.deepEqual(list.result.tools[0].inputSchema, { type: "object", properties: { role: { type: "string", enum: ["math"] }, question: { type: "string" } }, required: ["role", "question"], additionalProperties: false });
  const call = await r.rpc("tools/call", { name: "ask_subagent", arguments: { role: "math", question: "six times seven?" } });
  assert.equal(call.result.isError, false);
  assert.deepEqual(call.result.structuredContent, { role: "math", answer: "42 (asked: six times seven?)", model: "grok-4.5", served_model: "grok-4.5" });
  assert.deepEqual(JSON.parse(call.result.content[0].text), call.result.structuredContent);
  assert.equal(call.result.content[0].type, "text");
  assert.equal(turns.length, 1);
  assert.deepEqual(shim.calls.map(c => [c.role, c.status]), [["math", "answered"]]);
  assert.equal(JSON.stringify([init, list, call]).includes(shim.token), false, "the token was echoed");
  // Unknown methods are -32601; a non-JSON line is -32700; nothing else ever reached stdout.
  assert.equal((await r.rpc("resources/list", {})).error.code, -32601);
  assert.equal((await r.rpc("tools/call", { name: "write_file", arguments: {} })).error.code, -32602);
  r.line("{not json");
  assert.equal(await r.close(), 0);
  assert.deepEqual(r.stray.map(m => m.error?.code), [-32700]);
});

test("a disallowed role is refused (isError) — by the relay, and by the shim when the relay is told more roles than the unit has", async t => {
  const { shim, turns } = await shimFor(t);
  const r = relay(t, { PANTHEON_A2A_SOCKET: shim.socket, PANTHEON_A2A_TOKEN: shim.token, PANTHEON_A2A_ROLES: "math,release-manager", PANTHEON_UNIT_ID: "u1" });
  await r.rpc("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t", version: "0" } });
  const local = await r.rpc("tools/call", { name: "ask_subagent", arguments: { role: "historian", question: "q" } });
  assert.equal(local.result.isError, true); assert.match(local.result.content[0].text, /not allowed for this unit/);
  const remote = await r.rpc("tools/call", { name: "ask_subagent", arguments: { role: "release-manager", question: "q" } });
  assert.equal(remote.result.isError, true); assert.match(remote.result.content[0].text, /HTTP 403.*not in this unit's allowed_subagents/);
  const extra = await r.rpc("tools/call", { name: "ask_subagent", arguments: { role: "math", question: "q", cwd: "/" } });
  assert.equal(extra.result.isError, true);
  assert.equal(turns.length, 0);
  await r.close();
});

test("a wrong token is refused (isError, 401) and no subagent turn runs; an exhausted bound is refused (429)", async t => {
  const { shim, turns } = await shimFor(t, { limits: { max_calls: 1 } });
  const bad = relay(t, { PANTHEON_A2A_SOCKET: shim.socket, PANTHEON_A2A_TOKEN: "nope", PANTHEON_A2A_ROLES: "math", PANTHEON_UNIT_ID: "u1" });
  const r = await bad.rpc("tools/call", { name: "ask_subagent", arguments: { role: "math", question: "q" } });
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /HTTP 401/);
  assert.equal(turns.length, 0);
  await bad.close();
  const good = relay(t, { PANTHEON_A2A_SOCKET: shim.socket, PANTHEON_A2A_TOKEN: shim.token, PANTHEON_A2A_ROLES: "math", PANTHEON_UNIT_ID: "u1" });
  assert.equal((await good.rpc("tools/call", { name: "ask_subagent", arguments: { role: "math", question: "q" } })).result.isError, false);
  const over = await good.rpc("tools/call", { name: "ask_subagent", arguments: { role: "math", question: "q" } });
  assert.equal(over.result.isError, true); assert.match(over.result.content[0].text, /HTTP 429/);
  await good.close();
});

test("the pure handler: notifications get no answer; a socket that is gone is a tool error, not a crash", async () => {
  const h = mcpHandler({ socket: "/nonexistent/a2a.sock", token: "t", roles: "math", unitId: "u1" });
  assert.equal(await h({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const r = await h({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_subagent", arguments: { role: "math", question: "q" } } });
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /could not be reached/);
  assert.equal((await h({ jsonrpc: "2.0", id: 2, method: "nope" })).error.code, -32601);
  const seen = [];
  const inj = mcpHandler({ socket: "/s", token: "t", roles: ["math"], unitId: "u9", request: async a => { seen.push(a); return { status: 200, body: { result: { parts: [{ kind: "data", data: { role: "math", answer: "a" } }] } } }; } });
  assert.equal((await inj({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_subagent", arguments: { role: "math", question: "why?" } } })).result.structuredContent.answer, "a");
  assert.deepEqual(seen[0].payload.params.message.metadata, { subagent_role: "math", unit_id: "u9" });
  assert.equal(seen[0].payload.method, "message/send");
});

test("the relay script imports only readFileSync from node:fs (its token file) and no child-process module, and writes nothing but protocol to stdout", () => {
  const src = readFileSync(MCP_SERVER_PATH, "utf8");
  assert.ok(src.startsWith("#!/usr/bin/env node\n"));
  const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm)].map(m => m[1]).sort();
  assert.deepEqual(imports, ["node:fs", "node:http", "node:readline", "node:url"]);
  assert.match(src, /^import \{ readFileSync \} from "node:fs";$/m, "only readFileSync");
  assert.doesNotMatch(src, /\bimport\s*\(|\brequire\s*\(|node:fs\/|node:child_process|\bspawn\b|console\.log|writeFile|appendFile|unlink|mkdir|createWriteStream/);
});
