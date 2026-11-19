// STAGE 4: the controller's A2A LEAF SHIM — the only way a unit's implementer reaches a subagent.
//
// A local HTTP endpoint on a UNIX DOMAIN SOCKET whose path the CONTROLLER chooses (index.mjs:
// <dir>/control/<unit_id>/a2a.sock, a controller-owned directory outside the unit's checkout, or a short fallback under
// os.tmpdir() when that path is over the socket-path bound). A socket, not TCP: the sandboxes the implementer runs
// in (bwrap/nsjail, agy's own) cut host TCP loopback, and a bind-mounted socket file still reaches the controller.
// The shim creates no directory and removes no file itself; node unlinks the socket on close, and the controller
// removes it again in case it did not. Started for one active unit and closed when that unit ends.
// (A loopback-TCP listener remains for tests only: `tcp: true`. The pipeline path is always the socket.)
// The implementer's agent reaches it through the stdio MCP relay a2a-mcp-server.mjs (tool `ask_subagent`).
// It speaks the A2A JSON-RPC binding for exactly one method:
//   POST /                        {"jsonrpc":"2.0","id":..,"method":"message/send","params":{"message":{"role":"user",
//                                  "parts":[{"kind":"text","text":"..."}],"metadata":{"subagent_role":"..","unit_id":".."}}}}
//   GET  /.well-known/agent.json  the agent card (also at /.well-known/agent-card.json)
// and answers with an A2A message whose data part is {role, answer, model, served_model}.
//
// Inputs: the unit id, its allowed subagent roles, an INJECTED seatFor(role) and subagentTurn({vendor, model,
// prompt}), the per-unit bounds and the socket path. Outputs: {socket, url, token, calls, close()} and one record per call.
//
// A LEAF: each call is ONE stateless single turn — no history, no tools, no task, no stream. The subagent answers
// a question; it cannot act.
//
// Must never: hold or learn the unit's worktree path; touch the filesystem, git, a child process or the board (this
// module imports only the HTTP server and the hash/random primitives, and a test reads this source to keep it so);
// serve a caller without the unit's bearer token; serve a role outside the unit's allow-list; exceed the unit's
// call or byte bound; expose any method other than message/send.
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const sha = s => "sha256:" + createHash("sha256").update(s).digest("hex");
const str = v => typeof v === "string" && v.trim() !== "";
export const A2A_METHOD = "message/send";
// JSON-RPC 2.0 codes; the -320xx ones are this shim's own, in the implementation-defined server range.
export const A2A_ERRORS = Object.freeze({ PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, UNAUTHORIZED: -32001, FORBIDDEN_ROLE: -32002, EXHAUSTED: -32003 });

/** The specialist prompt of one subagent role: a single stateless answer, nothing else. */
export function SUBAGENT_PROMPT({ role, unit_id, question }) {
  return [
    `ROLE: ${role} — a consulted specialist subagent. An implementer working on work unit "${unit_id}" asks you ONE question in your speciality.`,
    "You have no tools, no files, no memory of earlier questions and no way to act: you answer in text, once. Do not ask a question back; state any assumption you make.",
    "Answer as the specialist named above would: precise, checkable, and limited to what was asked.",
    "",
    "QUESTION",
    question,
  ].join("\n");
}

/**
 * Start the shim for one unit.
 *   seatFor(role) -> {vendor, model}        the subagent seat of a role (injected)
 *   subagentTurn({vendor, model, prompt, seat, role, unit_id, sandbox, signal}) -> {text, served_model, served_model_source?}
 *   limits {max_calls, max_bytes}           per unit: admitted calls, and question + answer bytes in total
 *   onCall(record)                          called after every request that named a role (admitted or refused)
 *   socket                                  the Unix socket path to listen on (chosen and its directory created by
 *                                           the controller); required unless `tcp: true` (tests only: 127.0.0.1)
 * Returns {socket, url, token, roles, calls, usage(), close()}. `url` is null on a socket ("http://localhost/" is
 * the base of a request sent over it); `roles` the sorted allow-list.
 */
export async function startA2AShim({ unit_id, allowed_subagents = [], seatFor, subagentTurn, limits = {}, onCall = () => {}, sandbox = null, signal = null, socket = null, tcp = false }) {
  if (!str(socket) && tcp !== true) throw Object.assign(new Error("startA2AShim: pass the Unix socket path the controller chose (socket)"), { code: "NO_SOCKET" });
  const max_calls = limits.max_calls ?? 8, max_bytes = limits.max_bytes ?? 262144;
  const allowed = [...allowed_subagents].sort();
  const token = randomBytes(24).toString("hex");
  const want = Buffer.from(`Bearer ${token}`);
  const calls = [];
  let used_calls = 0, used_bytes = 0, url = null;

  const card = () => ({
    protocolVersion: "0.3.0",
    name: `pantheon-subagent-leaf/${unit_id}`,
    description: "Controller leaf shim: one stateless single-turn answer from an allowed specialist subagent. No tools, no files, no tasks.",
    url: url ?? "http://localhost/", preferredTransport: "JSONRPC", version: "1",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain"], defaultOutputModes: ["application/json"],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, security: [{ bearer: [] }],
    skills: allowed.map(role => ({ id: role, name: role, description: `One stateless answer from the ${role} subagent.`, tags: ["subagent", "single-turn"] })),
  });

  const send = (res, status, body) => { const s = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) }); res.end(s); };
  const fail = (res, status, id, code, message) => send(res, status, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  const record = rec => { calls.push(rec); try { onCall(rec); } catch { /* a recorder's failure is not the caller's */ } };

  async function handle(req, res) {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && (path === "/.well-known/agent.json" || path === "/.well-known/agent-card.json")) return send(res, 200, card());
    if (req.method !== "POST" || path !== "/") return fail(res, 404, null, A2A_ERRORS.INVALID_REQUEST, "this endpoint serves POST / (message/send) and GET /.well-known/agent.json only");
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    if (got.length !== want.length || !timingSafeEqual(got, want)) { req.resume(); return fail(res, 401, null, A2A_ERRORS.UNAUTHORIZED, "a bearer token for this unit is required"); }

    // The request body is bounded by what is left of the unit's byte budget (plus the JSON envelope).
    const chunks = []; let size = 0, over = false;
    for await (const c of req) { size += c.length; if (size > max_bytes + 4096) { over = true; break; } chunks.push(c); }
    if (over) { req.destroy(); return fail(res, 429, null, A2A_ERRORS.EXHAUSTED, `the request exceeds this unit's subagent byte bound (${max_bytes})`); }
    let rpc;
    try { rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return fail(res, 400, null, A2A_ERRORS.PARSE, "the body is not JSON"); }
    if (rpc === null || typeof rpc !== "object" || Array.isArray(rpc) || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return fail(res, 400, rpc?.id, A2A_ERRORS.INVALID_REQUEST, "not a JSON-RPC 2.0 request");
    const id = rpc.id ?? null;
    if (rpc.method !== A2A_METHOD) return fail(res, 200, id, A2A_ERRORS.METHOD_NOT_FOUND, `method "${rpc.method}" is not served: this leaf answers ${A2A_METHOD} only (no tasks, no files, no streams)`);

    const msg = rpc.params?.message, meta = msg?.metadata;
    const parts = Array.isArray(msg?.parts) ? msg.parts : null;
    const part = parts?.length === 1 ? parts[0] : null;
    if (!part || (part.kind ?? part.type) !== "text" || !str(part.text)) return fail(res, 400, id, A2A_ERRORS.INVALID_PARAMS, "params.message carries exactly one text part");
    if (!meta || !str(meta.subagent_role) || !str(meta.unit_id)) return fail(res, 400, id, A2A_ERRORS.INVALID_PARAMS, "params.message.metadata is {subagent_role, unit_id}");
    const role = meta.subagent_role, question = part.text, request_bytes = Buffer.byteLength(question);
    const rec = { n: calls.length + 1, role, status: "refused", code: null, request_bytes, answer_bytes: 0, request_digest: sha(question), answer_digest: null, vendor: null, model: null, served_model: null, served_model_source: null };
    const refuse = (status, code, name, message) => { rec.code = name; record(rec); return fail(res, status, id, code, message); };
    if (meta.unit_id !== unit_id) return refuse(403, A2A_ERRORS.FORBIDDEN_ROLE, "WRONG_UNIT", `this endpoint serves unit "${unit_id}" only`);
    if (!allowed.includes(role)) return refuse(403, A2A_ERRORS.FORBIDDEN_ROLE, "ROLE_NOT_ALLOWED", `subagent role "${role}" is not in this unit's allowed_subagents (${allowed.join(", ") || "none"})`);
    if (used_calls >= max_calls) return refuse(429, A2A_ERRORS.EXHAUSTED, "CALLS_EXHAUSTED", `this unit's subagent call bound (${max_calls}) is exhausted`);
    if (used_bytes + request_bytes > max_bytes) return refuse(429, A2A_ERRORS.EXHAUSTED, "BYTES_EXHAUSTED", `this unit's subagent byte bound (${max_bytes}) is exhausted`);
    used_calls += 1; used_bytes += request_bytes;   // reserved before the turn: concurrent callers cannot overdraw

    let seat, out;
    try {
      seat = seatFor(role);
      if (!seat || !str(seat.vendor) || !str(seat.model)) throw new Error(`no subagent seat for role "${role}"`);
      rec.vendor = seat.vendor; rec.model = seat.model;
      // ONE stateless single turn: a fresh prompt built from this question alone. Nothing of an earlier call is passed.
      out = await subagentTurn({ vendor: seat.vendor, model: seat.model, seat: { ...seat }, prompt: SUBAGENT_PROMPT({ role, unit_id, question }), role, unit_id, sandbox, signal });
      if (!out || typeof out.text !== "string") throw new Error("the subagent returned no text");
    } catch (e) {
      rec.status = "failed"; rec.code = e?.code === "PROVIDER_LIMIT" ? "PROVIDER_LIMIT" : "TURN_FAILED";
      record(rec);
      return e?.code === "PROVIDER_LIMIT" ? fail(res, 429, id, A2A_ERRORS.EXHAUSTED, "the run's provider-call bound is exhausted") : fail(res, 502, id, A2A_ERRORS.INTERNAL, "the subagent turn failed");
    }
    const room = max_bytes - used_bytes;
    const answer = Buffer.byteLength(out.text) > room ? Buffer.from(out.text).subarray(0, Math.max(room, 0)).toString("utf8") : out.text;
    const truncated = answer !== out.text;
    used_bytes += Buffer.byteLength(answer);
    // An answer whose turn named no serving model is recorded as exactly that (`served_model_source: "unnamed"`), not as
    // a null that reads like "not recorded". The ASKED model is the contributor that identity rules then exclude
    // (review/identity.mjs contributorKeys counts the requested name); nothing is inferred about who answered
    // (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 6).
    const servedName = str(out.served_model) ? out.served_model : null;
    Object.assign(rec, { status: "answered", answer_bytes: Buffer.byteLength(answer), answer_digest: sha(answer), truncated, served_model: servedName,
      served_model_source: servedName ? out.served_model_source ?? null : "unnamed" });
    record(rec);
    const data = { role, answer, model: seat.model, served_model: rec.served_model };
    return send(res, 200, { jsonrpc: "2.0", id, result: { kind: "message", role: "agent", messageId: randomBytes(8).toString("hex"), parts: [{ kind: "data", data }], metadata: { unit_id, subagent_role: role, truncated } } });
  }

  const server = createServer((req, res) => { handle(req, res).catch(() => { try { fail(res, 500, null, A2A_ERRORS.INTERNAL, "internal error"); } catch { /* socket gone */ } }); });
  await new Promise((resolve, reject) => { server.once("error", reject); if (str(socket)) server.listen(socket, resolve); else server.listen(0, "127.0.0.1", resolve); });
  if (!str(socket)) url = `http://127.0.0.1:${server.address().port}/`;
  let closed = false;
  return {
    socket: str(socket) ? socket : null, url, token, roles: [...allowed], calls,
    usage: () => ({ calls: used_calls, bytes: used_bytes, max_calls, max_bytes }),
    close: () => closed ? Promise.resolve() : new Promise(resolve => { closed = true; server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
