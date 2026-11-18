#!/usr/bin/env node
// STAGE 4 RELAY: a stdio MCP server that gives the implementer's agent ONE tool, `ask_subagent`, and relays each
// call as ONE A2A `message/send` to the unit's leaf shim (a2a-shim.mjs) over the shim's Unix domain socket.
//
// Why a relay: the Antigravity CLI agent reaches tools through MCP servers it launches itself (workspace
// `.agents/mcp_config.json`), and its sandbox cuts host TCP loopback. This process runs inside that sandbox as the
// agent's child, speaks MCP on stdin/stdout, and reaches the controller only through the socket file it is told of.
//
// Launched as `node a2a-mcp-server.mjs`, configured as
//   {"mcpServers":{"pantheon-subagents":{"command":"node","args":["<abs path>/a2a-mcp-server.mjs"],
//     "env":{"PANTHEON_A2A_SOCKET":"...","PANTHEON_A2A_TOKEN":"...","PANTHEON_A2A_ROLES":"a,b","PANTHEON_UNIT_ID":"..."}}}}
// Environment (all required but ROLES, which may be empty: then every call is refused):
//   PANTHEON_A2A_SOCKET   the shim's Unix socket path
//   PANTHEON_A2A_TOKEN    the unit's bearer token
//   PANTHEON_A2A_ROLES    comma-separated allowed subagent roles (the tool's `role` enum)
//   PANTHEON_UNIT_ID      the unit id the shim serves
//   PANTHEON_A2A_TIMEOUT_MS  optional, per call (default 600000)
//
// Protocol: MCP 2025-06-18 over newline-delimited JSON-RPC 2.0. Served: initialize, notifications/initialized,
// ping, tools/list, tools/call. Anything else with an id is -32601; other notifications are ignored.
//
// Must never: write anything but protocol messages to stdout (diagnostics go to stderr); touch the filesystem or
// start a process (this module imports no file-system or child-process module, and a test reads it to keep it so);
// forward anything but one message/send per tools/call; reveal the token in a reply.
import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_INFO = Object.freeze({ name: "pantheon-subagents", version: "1" });
export const TOOL_NAME = "ask_subagent";
const RPC = Object.freeze({ PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 });
const str = v => typeof v === "string" && v.trim() !== "";

/** The `ask_subagent` tool definition for `roles`. */
export function toolDefinition(roles) {
  return {
    name: TOOL_NAME,
    title: "Ask a specialist subagent",
    description: "Ask ONE stateless question of an allowed specialist subagent. It has no tools, files or memory; it answers once, in text. Calls and bytes are bounded per unit. The answer is advice: what you write is yours.",
    inputSchema: { type: "object", properties: { role: { type: "string", enum: [...roles] }, question: { type: "string" } }, required: ["role", "question"], additionalProperties: false },
  };
}

/** One HTTP request over a Unix socket: resolves {status, body} (body parsed as JSON, or null). */
export function socketRequest({ socket, token, payload, timeout_ms = 600000 }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = httpRequest({ socketPath: socket, path: "/", method: "POST", timeout: timeout_ms,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: `Bearer ${token}` } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON: reported as such */ }
        resolve({ status: res.statusCode, body: parsed });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`no answer from the subagent shim within ${timeout_ms} ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * The MCP handler, pure of stdio: (message) -> Promise<response | null> (null for a notification).
 *   socket, token, roles ([string] or comma-separated), unitId   as from the environment
 *   request({socket, token, payload}) -> {status, body}           injected for tests; default socketRequest
 */
export function mcpHandler({ socket, token, roles = [], unitId, request = socketRequest, timeout_ms = 600000 }) {
  const allowed = [...new Set((Array.isArray(roles) ? roles : String(roles ?? "").split(",")).map(r => String(r).trim()).filter(Boolean))].sort();
  let calls = 0;
  const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
  const err = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  const toolError = text => ({ content: [{ type: "text", text }], isError: true });

  async function call(params) {
    const args = params?.arguments ?? {};
    if (args === null || typeof args !== "object" || Array.isArray(args)) return toolError("arguments is an object {role, question}");
    const extra = Object.keys(args).filter(k => k !== "role" && k !== "question");
    if (extra.length) return toolError(`unknown argument(s): ${extra.sort().join(", ")}; the tool takes {role, question}`);
    if (!str(args.role) || !str(args.question)) return toolError("role and question are non-empty strings");
    if (!allowed.includes(args.role)) return toolError(`subagent role "${args.role}" is not allowed for this unit (${allowed.join(", ") || "none"})`);
    if (!str(socket) || !str(token) || !str(unitId)) return toolError("the relay is not configured (PANTHEON_A2A_SOCKET, PANTHEON_A2A_TOKEN, PANTHEON_UNIT_ID)");
    calls += 1;
    const payload = { jsonrpc: "2.0", id: calls, method: "message/send",
      params: { message: { role: "user", messageId: `mcp-${calls}`, parts: [{ kind: "text", text: args.question }], metadata: { subagent_role: args.role, unit_id: unitId } } } };
    let r;
    try { r = await request({ socket, token, payload, timeout_ms }); } catch (e) { return toolError(`the subagent shim could not be reached: ${String(e?.message ?? e)}`); }
    const b = r?.body;
    if (b?.error) return toolError(`refused by the subagent shim (HTTP ${r.status}, ${b.error.code}): ${b.error.message}`);
    const data = b?.result?.parts?.[0]?.data;
    if (r?.status !== 200 || !data || typeof data !== "object") return toolError(`the subagent shim answered HTTP ${r?.status} without an answer`);
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false };
  }

  return async function handle(msg) {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return err(msg?.id, RPC.INVALID_REQUEST, "not a JSON-RPC 2.0 request");
    }
    const isNote = !("id" in msg) || msg.id === null;
    if (isNote) return null;   // notifications/initialized, notifications/cancelled, ...: nothing to answer
    const { id, method, params } = msg;
    switch (method) {
      case "initialize": return ok(id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { ...MCP_SERVER_INFO } });
      case "ping": return ok(id, {});
      case "tools/list": return ok(id, { tools: [toolDefinition(allowed)] });
      case "tools/call":
        if (params?.name !== TOOL_NAME) return err(id, RPC.INVALID_PARAMS, `unknown tool "${params?.name}"; this server has ${TOOL_NAME} only`);
        return ok(id, await call(params));
      default: return err(id, RPC.METHOD_NOT_FOUND, `method "${method}" is not served`);
    }
  };
}

/** Run the stdio server: one JSON-RPC message per line in, one per line out. */
export function serveStdio({ input = process.stdin, output = process.stdout, env = process.env, log = m => process.stderr.write(`pantheon-subagents: ${m}\n`) } = {}) {
  const handle = mcpHandler({ socket: env.PANTHEON_A2A_SOCKET, token: env.PANTHEON_A2A_TOKEN, roles: env.PANTHEON_A2A_ROLES ?? "", unitId: env.PANTHEON_UNIT_ID,
    timeout_ms: Number(env.PANTHEON_A2A_TIMEOUT_MS) > 0 ? Number(env.PANTHEON_A2A_TIMEOUT_MS) : 600000 });
  if (!str(env.PANTHEON_A2A_SOCKET) || !str(env.PANTHEON_A2A_TOKEN) || !str(env.PANTHEON_UNIT_ID)) log("PANTHEON_A2A_SOCKET, PANTHEON_A2A_TOKEN or PANTHEON_UNIT_ID is not set: every tool call will be refused");
  const send = m => { if (m) output.write(JSON.stringify(m) + "\n"); };
  const pending = new Set();
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: RPC.PARSE, message: "the line is not JSON" } }); return; }
    const p = handle(msg).then(send, e => { log(`internal error: ${String(e?.message ?? e)}`); send({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: RPC.INTERNAL, message: "internal error" } }); });
    pending.add(p); p.finally(() => pending.delete(p));
  });
  return new Promise(resolve => rl.on("close", () => Promise.allSettled([...pending]).then(() => resolve())));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveStdio().then(() => process.stdout.write("", () => process.exit(0)));
}
