// THE METERING RELAY OF THE PYTHON ANTIGRAVITY SDK SEAT (register L-150, L-151; owner decisions 2026-11-20; the billing
// policy is docs/billing-policy.md, enforced by route/gemini-billing.mjs). It is NOT a second billing implementation: every
// billed request it admits is admitted, charged and persisted by spendGemini, the one point-of-spend sequence.
//
// WHY A RELAY. The python seat (scripts/agy-seat.py) runs a google-antigravity Agent, and the Agent's Gemini requests are
// sent by the SDK's bundled Go harness (google/antigravity/bin/localharness, the Go google-genai client), not by python: a
// turn is many requests (each model call, each retry, each subagent's calls, a context summarization, a web search), and
// the controller saw none of them -- it charged ONE request per launch. The harness sends every request to the endpoint's
// base URL (types.GeminiAPIEndpoint(base_url, api_key), a public SDK field), as plain HTTP: POST
// /v1beta/models/{model}:streamGenerateContent?alt=sse (server-sent events) and :generateContent, the api_key in the
// x-goog-api-key header. So the controller runs THIS loopback endpoint, gives the python process its URL and a random
// per-session capability as that api_key, and keeps the real GEMINI_API_KEY to itself. For each request:
//   1. the capability names an open session (refused otherwise: no session, nothing charged, nothing forwarded);
//   2. the method is on the ALLOWLIST (RELAY_METHODS): the billed generation methods, and countTokens, free, passed and not
//      charged. Anything else -- another method, another path, a websocket upgrade (the Live API) -- is refused and recorded:
//      fail closed (owner item 9);
//   3. a billed method is admitted by the session's own maximum request count (owner item 3), then by spendGemini (the
//      policy, then the caller's `admit` -- the board's per-request provider-call admission -- then the usage row persisted
//      and fsynced), all synchronously, with no await between the count and the append: two requests of one controller
//      cannot both take the last unit (owner item 5; across processes the record's own lock decides, register L-148);
//   4. only then is it forwarded upstream with the real credential, its response streamed through as it arrives;
//   5. its outcome (status, the response id, the usage the provider reported) is recorded SEPARATELY, on the outcome file:
//      it never changes the count. A request admitted and never answered (the session killed, the controller crashed) keeps
//      its usage row: it is counted, its outcome unknown (owner item 7).
// THE CHANNEL IS BOUNDED (owner item 4): loopback only, a request body of at most maxBodyBytes, at most maxConcurrent
// requests in flight per session, an idle bound and a total lifetime per session, and a capability valid for its own
// session only, revoked when the session closes.
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { spendGemini, isGeminiBillingRefusal, GEMINI_BILLING_SCHEMA } from "./gemini-billing.mjs";

export const RELAY_SCHEMA = "ophanim.gemini-relay/v1";
export const RELAY_OUTCOME_SCHEMA = "ophanim.gemini-relay-outcome/v1";
/** The scoped capability the python process gets: the relay's URL and the session's random token, nothing else. */
export const RELAY_URL_ENV = "PANTHEON_AGY_RELAY_URL";
export const RELAY_CAPABILITY_ENV = "PANTHEON_AGY_RELAY_CAPABILITY";
/** The upstream the relay forwards to. Only a Google API host or a loopback fake (a test's provider edge) is accepted. */
export const RELAY_UPSTREAM_ENV = "PANTHEON_AGY_RELAY_UPSTREAM";
export const GEMINI_API_UPSTREAM = "https://generativelanguage.googleapis.com";
/** Every refusal's message starts with this mark, so the SDK side recognises a refusal of the relay in any error text. */
export const RELAY_MARK = "GEMINI_RELAY_REFUSED";
export const RELAY_CAPABILITY_REFUSED = "GEMINI_RELAY_CAPABILITY_REFUSED";
export const RELAY_SESSION_CLOSED = "GEMINI_RELAY_SESSION_CLOSED";
export const RELAY_METHOD_REFUSED = "GEMINI_RELAY_METHOD_REFUSED";
export const RELAY_SESSION_CAP = "GEMINI_RELAY_SESSION_CAP";
export const RELAY_BOUND = "GEMINI_RELAY_BOUND";
export const RELAY_MALFORMED = "GEMINI_RELAY_MALFORMED";
export const RELAY_UPSTREAM_FAILED = "GEMINI_RELAY_UPSTREAM_FAILED";
/** Vertex through the SDK seat: the relay holds no Vertex credential it could forward with, so it is refused (D8). */
export const RELAY_VERTEX_UNSUPPORTED = "GEMINI_RELAY_VERTEX_UNSUPPORTED";

/**
 * THE ALLOWLIST: the methods the SDK's harness was observed to send (google-antigravity 0.1.24; the real-SDK proof of
 * register L-150), and countTokens, which Google does not bill. A method not here is refused before anything is charged
 * or forwarded.
 */
export const RELAY_METHODS = Object.freeze({
  streamGenerateContent: Object.freeze({ billed: true, stream: true }),
  generateContent: Object.freeze({ billed: true, stream: false }),
  countTokens: Object.freeze({ billed: false, stream: false }),
});
const PATH = /^\/(v1|v1beta|v1alpha)\/models\/([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([A-Za-z]+)$/;
export const RELAY_DEFAULTS = Object.freeze({ maxBodyBytes: 32 * 1024 * 1024, maxConcurrent: 8, idleMs: 15 * 60_000, lifetimeMs: 60 * 60_000, maxRequests: 40 });
const STATUS = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 429: "RESOURCE_EXHAUSTED", 502: "UNAVAILABLE" };
/** What makes each refusal recoverable, as the refusal states it. */
const RECOVERY = {
  METERED_GEMINI_BUDGET_EXHAUSTED: "the gemini_api_primary budget is spent and its recorded usage stays counted: declare a larger budget (--gemini-api-primary N) and resume",
  GEMINI_PRIMARY_DISABLED: "primary Gemini execution is off: declare --gemini-api-primary N (a budget of billed requests) and resume",
  PROVIDER_CALL_LIMIT: "the run's provider-call bound is reached: raise it and resume",
  ABORTED: "the run was stopped: resume it",
  GEMINI_USAGE_LOCKED: "the usage record is locked by a live process: retry when it is released",
  [RELAY_CAPABILITY_REFUSED]: "launch the seat through the controller (pantheon-board, or bin/agy-seat.mjs), which issues a capability for its session",
  [RELAY_SESSION_CLOSED]: "the session's capability expired or was revoked: a new launch opens a new session",
  [RELAY_METHOD_REFUSED]: "this method is not metered by the relay, so it is never sent (fail closed); only the generation methods and countTokens are carried",
  [RELAY_SESSION_CAP]: "the session's maximum request count is reached: a new launch opens a new session",
  [RELAY_BOUND]: "the request exceeds the channel's bounds (size or concurrency): send a smaller or a later request",
  [RELAY_MALFORMED]: "the request body is not a JSON object: it is not sent",
};
const recoveryOf = code => RECOVERY[code] ?? "the request is refused before it is sent; nothing was charged for it";

/** The upstream base URL: `PANTHEON_AGY_RELAY_UPSTREAM` when set (a Google API host, or a loopback fake), else the Gemini API. */
export function relayUpstreamOf(env = process.env) {
  const raw = env?.[RELAY_UPSTREAM_ENV];
  return checkUpstream(raw === undefined || raw === "" ? GEMINI_API_UPSTREAM : raw);
}
function checkUpstream(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw Object.assign(new Error(`${RELAY_UPSTREAM_ENV}: ${raw} is not a URL`), { code: "GEMINI_RELAY_UPSTREAM_INVALID" }); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && (u.protocol === "http:" || u.protocol === "https:");
  const google = u.protocol === "https:" && /(^|\.)googleapis\.com$/.test(u.hostname);
  if (!(loopback || google) || u.username || u.password || u.search || u.hash || !["", "/"].includes(u.pathname)) {
    throw Object.assign(new Error(`${RELAY_UPSTREAM_ENV}: the relay forwards the real credential only to a Google API host (https://*.googleapis.com) or to a loopback fake; ${raw} is neither`), { code: "GEMINI_RELAY_UPSTREAM_INVALID" });
  }
  return `${u.protocol}//${u.host}`;
}

/** The method a request names, or null when it is not on the allowlist (or not a POST). */
export function relayMethodOf(method, url) {
  if (method !== "POST") return null;
  let u;
  try { u = new URL(url, "http://relay.invalid"); } catch { return null; }
  const m = PATH.exec(u.pathname);
  if (!m || !Object.hasOwn(RELAY_METHODS, m[3])) return null;
  const spec = RELAY_METHODS[m[3]];
  const alt = u.searchParams.get("alt");
  if (spec.stream ? !(alt === null || alt === "sse") : alt !== null) return null;
  return { version: m[1], model: m[2], name: m[3], ...spec, sse: spec.stream && alt === "sse" };
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/** An append-only JSONL file, one fsynced line per row (the outcome record; never read by any count). */
function appendRow(file, row) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a");
  try { writeSync(fd, JSON.stringify(row) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
const readRows = file => (file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { unreadable: l }; } }) : []);

/**
 * THE ACCOUNTING OF A USAGE RECORD AND ITS OUTCOME RECORD (owner item 7): every admitted request is a usage row and is
 * counted; its outcome is joined by request id when one was recorded, and UNKNOWN when none was (a killed session, a
 * crashed controller). The count is the usage rows, never the outcomes.
 */
export function relayAccounting({ usage = [], outcomes = [] } = {}) {
  const byId = new Map(outcomes.filter(o => o?.request_id).map(o => [o.request_id, o]));
  const admitted = usage.filter(r => r?.schema === GEMINI_BILLING_SCHEMA && r?.identity?.request_id);
  const rows = admitted.map(r => ({ request_id: r.identity.request_id, model: r.model, outcome: byId.get(r.identity.request_id)?.status ?? "unknown" }));
  return { admitted: rows.length, completed: rows.filter(r => r.outcome !== "unknown").length, unknown: rows.filter(r => r.outcome === "unknown").length, rows,
    refused: outcomes.filter(o => o?.refused).length };
}
export const readRelayOutcomes = readRows;

/** The parts of a streamed or whole Gemini response the outcome records: the response id, the model version, the usage. */
function responseTap(limit = 4 * 1024 * 1024) {
  let buf = "", seen = 0, kept = { response_id: null, model_version: null, usage: null, error: null };
  const take = obj => {
    if (!obj || typeof obj !== "object") return;
    for (const o of Array.isArray(obj) ? obj : [obj]) {
      if (typeof o?.responseId === "string") kept.response_id ??= o.responseId;
      if (typeof o?.modelVersion === "string") kept.model_version ??= o.modelVersion;
      if (o?.usageMetadata && typeof o.usageMetadata === "object") kept.usage = o.usageMetadata;
      if (o?.error) kept.error = { code: o.error.code ?? null, status: o.error.status ?? null, message: String(o.error.message ?? "").slice(0, 300) };
    }
  };
  const flushEvents = final => {
    const parts = buf.split(/\r?\n\r?\n/);
    buf = final ? "" : parts.pop();
    for (const p of parts) {
      const data = p.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
      if (data) { try { take(JSON.parse(data)); } catch { /* not a JSON event */ } }
    }
  };
  return {
    push(chunk, sse) {
      if (seen > limit) return;
      seen += chunk.length;
      buf += Buffer.from(chunk).toString("utf8");
      if (sse) flushEvents(false);
    },
    done(sse) {
      if (sse) flushEvents(true);
      else if (buf) { try { take(JSON.parse(buf)); } catch { /* not JSON */ } }
      return kept;
    },
  };
}

/**
 * START A RELAY: a loopback HTTP server (127.0.0.1, an ephemeral port) holding the real credential. Returns
 * {url, port, openSession, close, refusals}. `apiKey` is the real GEMINI_API_KEY (never written anywhere by the relay);
 * `upstream` the base URL it forwards to (relayUpstreamOf); `fetch` the client it forwards with (the process's fetch);
 * `outcomes` the outcome record (a JSONL path, or null: kept in memory only).
 */
export async function startGeminiRelay({ apiKey, upstream = GEMINI_API_UPSTREAM, fetch: fetchImpl = globalThis.fetch, outcomes = null, maxBodyBytes = RELAY_DEFAULTS.maxBodyBytes } = {}) {
  if (typeof apiKey !== "string" || !apiKey) throw Object.assign(new Error("the metering relay holds the real Gemini credential, and none was given (GEMINI_API_KEY)"), { code: "GEMINI_RELAY_NO_CREDENTIAL" });
  const base = checkUpstream(upstream);
  const sessions = new Map(), refusals = [], inflight = new Set();
  let closed = false;
  const outcome = (row, session = null) => {
    const full = { schema: RELAY_OUTCOME_SCHEMA, at: new Date().toISOString(), relay_session: session?.id ?? null, ...row };
    session?.outcomes.push(full);
    try { appendRow(outcomes, full); } catch { /* the outcome never decides anything; the usage row already counted it */ }
    return full;
  };
  const sessionOf = token => {
    for (const s of sessions.values()) if (sameToken(s.token, token)) return s;
    return null;
  };
  function refuse(res, status, code, why, { session = null, request = {}, error = null } = {}) {
    const recovery = recoveryOf(code);
    why = String(why).startsWith(`${code}: `) ? String(why).slice(code.length + 2) : String(why);
    const message = `${RELAY_MARK} ${code}: ${why} (recovery: ${recovery})`;
    const row = outcome({ ...request, refused: { code, status, why: String(why).slice(0, 500), recovery }, provider_requests: 0 }, session);
    if (session) { session.refusals.push({ code, why: String(why).slice(0, 500), recovery, error, at: row.at, request_id: request.request_id ?? null }); session.onRefused?.(session.refusals.at(-1)); }
    else refusals.push(row);
    if (!res.headersSent) {
      res.writeHead(status, { "content-type": "application/json; charset=UTF-8" });
      res.end(JSON.stringify({ error: { code: status, status: STATUS[status] ?? "FAILED_PRECONDITION", message,
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: code, domain: "ophanim.gemini-relay", metadata: { recovery } }] } }));
    } else res.destroy();
  }
  const readBody = (req, limit) => new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) { reject(Object.assign(new Error(`a request body of ${declared} bytes exceeds the channel's bound of ${limit}`), { code: RELAY_BOUND })); return; }
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > limit) { reject(Object.assign(new Error(`a request body over the channel's bound of ${limit} bytes`), { code: RELAY_BOUND })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

  async function handle(req, res) {
    const token = req.headers["x-goog-api-key"];
    const session = sessionOf(token);
    const where = { method: req.method, path: String(req.url ?? "").split("?")[0].slice(0, 300) };
    if (!session) return refuse(res, 401, RELAY_CAPABILITY_REFUSED, `no capability of an open session was presented (${where.method} ${where.path}): nothing is charged or forwarded`, { request: where });
    const now = Date.now();
    if (session.closed || now > session.expires || now - session.last > session.idleMs) {
      session.close();
      return refuse(res, 401, RELAY_SESSION_CLOSED, `the session ${session.id} is closed (revoked, idle over ${session.idleMs} ms or past its lifetime): nothing is charged or forwarded`, { session, request: where });
    }
    session.last = now;
    // The status endpoint: the session's own accounting, for the seat to report (never a provider request, never counted).
    if (req.method === "GET" && where.path === "/_relay/session") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(session.summary()));
    }
    const n = ++session.received, request_id = `${session.id}#${n}`;
    const m = relayMethodOf(req.method, req.url);
    if (!m) return refuse(res, 403, RELAY_METHOD_REFUSED, `${where.method} ${where.path} is not a method the relay meters: it is refused, never forwarded`, { session, request: { ...where, request_id, seq: n } });
    if (session.active >= session.maxConcurrent) return refuse(res, 429, RELAY_BOUND, `the session has ${session.active} request(s) in flight, its bound is ${session.maxConcurrent}`, { session, request: { ...where, request_id, seq: n, model: m.model } });
    session.active++;
    const t0 = Date.now();
    const ctl = new AbortController();
    inflight.add(ctl);
    try {
      let body;
      try { body = await readBody(req, session.maxBodyBytes); }
      catch (e) { return refuse(res, 400, RELAY_BOUND, e.message, { session, request: { ...where, request_id, seq: n, model: m.model } }); }
      let parsed = null;
      try { parsed = JSON.parse(body.toString("utf8") || "null"); } catch { parsed = null; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return refuse(res, 400, RELAY_MALFORMED, "the request body is not a JSON object", { session, request: { ...where, request_id, seq: n, model: m.model } });
      if (session.closed) return refuse(res, 401, RELAY_SESSION_CLOSED, `the session ${session.id} closed while the request was read`, { session, request: { ...where, request_id, seq: n } });
      // THE LINEAGE: the SDK names its conversation in the body (`sessionId`); the first one a session sees is its root
      // agent's (a subagent exists only after the root's tool call), another one is a subagent's conversation. A request
      // that names none (the harness's web search) is attributed to the launch only.
      const sdk_session = parsed.sessionId === undefined || parsed.sessionId === null ? null : String(parsed.sessionId).slice(0, 64);
      if (sdk_session !== null && session.root === null) session.root = sdk_session;
      const conversation = sdk_session === null ? "unattributed" : sdk_session === session.root ? "root" : "subagent";
      const identity = { relay_session: session.id, request_id, seq: n, method: m.name, sdk_session };
      const lineage = { ...session.lineage, parent_session: session.root, conversation, subagent_session: conversation === "subagent" ? sdk_session : null, attributed_by: "sdk sessionId" };
      let row = null;
      // ATOMIC ADMISSION, from the session's cap to the persisted row, with no await in between (owner items 3, 4, 5):
      // false when it is refused (the refusal already sent).
      const charge = () => {
        if (session.admitted >= session.maxRequests) {
          refuse(res, 403, RELAY_SESSION_CAP, `the session has made ${session.admitted} of its ${session.maxRequests} permitted request(s): ${m.name} for ${m.model} is not sent`, { session, request: { ...where, request_id, seq: n, model: m.model } });
          return false;
        }
        try {
          row = spendGemini(session.billing, { kind: "primary", vendor: session.spend.vendor, model: m.model, purpose: session.spend.purpose, role: session.spend.role,
            transport: "sdk", request: session.admitted + 1, identity, lineage }, r => session.admit(r));
        } catch (e) {
          const code = isGeminiBillingRefusal(e) ? (e.billing?.code ?? e.code) : (e?.code ?? "GEMINI_USAGE_UNRECORDED");
          refuse(res, 403, code, String(e?.message ?? e).slice(0, 600), { session, request: { ...where, request_id, seq: n, model: m.model }, error: e });
          return false;
        }
        session.admitted++;
        try { session.onAdmitted?.(row); } catch { /* a record hook never refuses an admitted request */ }
        return true;
      };
      if (m.billed && !charge()) return;
      // FORWARDED ONLY NOW, with the real credential (never the capability), the response streamed through.
      const url = `${base}/${m.version}/models/${m.model}:${m.name}${m.sse ? "?alt=sse" : ""}`;
      const headers = { "content-type": "application/json", "x-goog-api-key": apiKey };
      for (const h of ["user-agent", "x-goog-api-client"]) if (typeof req.headers[h] === "string") headers[h] = req.headers[h];
      const remaining = Math.max(1000, session.expires - Date.now());
      const abort = () => ctl.abort(Object.assign(new Error("the SDK's connection closed"), { code: "CLIENT_CLOSED" }));
      res.on("close", () => { if (!res.writableFinished) abort(); });
      let up;
      try { up = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(remaining)]) }); }
      catch (e) {
        outcome({ ...where, request_id, seq: n, method: m.name, model: m.model, billed: m.billed, status: "upstream_error", error: String(e?.message ?? e).slice(0, 300), ms: Date.now() - t0 }, session);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: 502, status: STATUS[502], message: `${RELAY_UPSTREAM_FAILED}: the admitted request could not reach the provider (${String(e?.message ?? e).slice(0, 200)}); it stays counted` } }));
        }
        return;
      }
      const tap = responseTap();
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
      let interrupted = false;
      try {
        if (up.body) for await (const chunk of up.body) { tap.push(chunk, m.sse); if (!res.write(chunk)) await new Promise(r => res.once("drain", r).once("close", r)); if (res.destroyed) { interrupted = true; break; } }
      } catch { interrupted = true; }
      res.end();
      const got = tap.done(m.sse && up.status < 300);
      outcome({ ...where, request_id, seq: n, method: m.name, model: m.model, billed: m.billed, status: up.status, interrupted, ...got, ms: Date.now() - t0 }, session);
    } finally {
      session.active--;
      inflight.delete(ctl);
    }
  }

  const server = createServer((req, res) => {
    if (closed) { res.writeHead(503); res.end(); return; }
    handle(req, res).catch(e => { try { refuse(res, 400, RELAY_MALFORMED, String(e?.message ?? e).slice(0, 300)); } catch { res.destroy(); } });
  });
  // A websocket upgrade (the Live API's bidirectional stream) is a transport the relay does not carry: refused, recorded.
  server.on("upgrade", (req, socket) => {
    const session = sessionOf(req.headers["x-goog-api-key"]);
    const row = outcome({ method: req.method, path: String(req.url ?? "").split("?")[0].slice(0, 300), refused: { code: RELAY_METHOD_REFUSED, status: 403, why: "a websocket upgrade (the Live API) is not a transport the relay meters: refused, never forwarded", recovery: recoveryOf(RELAY_METHOD_REFUSED) }, provider_requests: 0 }, session);
    if (session) session.refusals.push({ code: RELAY_METHOD_REFUSED, why: row.refused.why, recovery: row.refused.recovery, at: row.at }); else refusals.push(row);
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n");
  });
  // Receiving a request (headers and a body of at most maxBodyBytes, over loopback) is bounded; a response streams as long as it lasts.
  server.requestTimeout = 120_000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port, url = `http://127.0.0.1:${port}`;

  /**
   * OPEN A SESSION: one SDK launch. `billing` is the run's geminiBilling context (the SAME one its other points of spend
   * use); `admit` the caller's per-request admission (spendGemini's `admit`: the board's provider-call bound and charge);
   * `spend` {vendor, purpose, role} of its rows; `maxRequests` the session's own maximum request count; `lineage` what the
   * rows carry about the launch (the board run and seat). Returns the session, its capability in `env`.
   */
  function openSession({ billing, admit = () => {}, spend = {}, maxRequests = RELAY_DEFAULTS.maxRequests, maxConcurrent = RELAY_DEFAULTS.maxConcurrent,
    idleMs = RELAY_DEFAULTS.idleMs, lifetimeMs = RELAY_DEFAULTS.lifetimeMs, lineage = {}, onAdmitted = null, onRefused = null } = {}) {
    if (closed) throw new Error("the metering relay is closed");
    if (!billing?.policy || !Array.isArray(billing?.refusals)) throw new Error("openSession: billing is a geminiBilling() context (route/gemini-billing.mjs)");
    if (!(Number.isSafeInteger(maxRequests) && maxRequests > 0)) throw new Error("openSession: maxRequests is a positive integer (the session's maximum request count)");
    const id = `relay-${randomUUID()}`, token = `ophanim-relay-${randomBytes(32).toString("hex")}`, opened = Date.now();
    const session = {
      id, token, billing, admit, onAdmitted, onRefused, maxRequests, maxConcurrent, idleMs, maxBodyBytes,
      spend: { vendor: spend.vendor ?? "agy_google", purpose: spend.purpose ?? null, role: spend.role ?? null },
      lineage: { ...structuredClone(lineage), relay_session: id }, root: null,
      opened, last: opened, expires: opened + lifetimeMs, received: 0, admitted: 0, active: 0, closed: false, outcomes: [], refusals: [],
      env: Object.freeze({ [RELAY_URL_ENV]: url, [RELAY_CAPABILITY_ENV]: token }),
      close() { session.closed = true; sessions.delete(id); },
      /** The first refusal of the billing policy or of the run's own admission, as the Error spendGemini threw. */
      get billingRefusal() { return session.refusals.find(r => r.error && (isGeminiBillingRefusal(r.error) || ["PROVIDER_CALL_LIMIT", "ABORTED"].includes(r.error.code) || r.error.name === "AbortError"))?.error ?? null; },
      summary() {
        return { schema: RELAY_SCHEMA, relay_session: id, max_requests: maxRequests, received: session.received, admitted: session.admitted,
          refused: session.refusals.map(({ code, why, recovery, at, request_id }) => ({ code, why, recovery, at, request_id: request_id ?? null })),
          outcomes: session.outcomes.filter(o => !o.refused).length, root_session: session.root, closed: session.closed };
      },
    };
    sessions.set(id, session);
    const timer = setTimeout(() => session.close(), lifetimeMs); timer.unref?.();
    return session;
  }
  async function close() {
    closed = true;
    for (const s of [...sessions.values()]) s.close();
    for (const c of inflight) c.abort(Object.assign(new Error("the metering relay closed"), { code: "RELAY_CLOSED" }));
    server.closeAllConnections?.();
    await new Promise(r => server.close(() => r()));
  }
  return { url, port, upstream: base, openSession, close, refusals, outcomes };
}
