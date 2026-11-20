// THE PYTHON ANTIGRAVITY SDK SEAT, SERVED BY THE MODEL GATEWAY (register L-150, L-151, L-724; owner decision 2026-11-20).
//
// The board's python seat (scripts/agy-seat.py) runs a google-antigravity Agent whose Gemini requests are sent by the
// SDK's bundled harness: many per launch (each model call, each retry, a subagent's calls, a web search). L-150 had each
// of them charged before it is sent. That was first built as a relay of its own (route/gemini-relay.mjs). The owner made
// the model gateway (gateway.mjs) the one mechanism and had the relay retired; this module is how that seat uses the
// gateway. It holds NO billing logic and opens NO second path: every request is admitted by the gateway, whose `admit`
// here is spendGemini, the one point-of-spend sequence (the policy, then the caller's own admission, then the usage row
// persisted, all before the gateway forwards the request with the real key).
//
//   openSeatSession({apiKey, upstream, model, billing, admit, spend, maxRequests, ..., lineage, outcomes})
//     -> {id, env, admitted, refusals, billingRefusal, summary(), record(), close()}
//
//   env             what the seat's process is given INSTEAD of a credential: the gateway's loopback URL and the session's
//                   token (worth nothing once the session is closed). Never GEMINI_API_KEY.
//   maxRequests     the session's own maximum request count: the gateway refuses the request past it before it is charged.
//   identity        each usage row says which request it is: the session, its sequence, the verb, the SDK's own session id.
//   lineage         and where it came from: the caller's launch, and whether the SDK's conversation was the root agent's
//                   (the first one the session saw), a subagent's (another one) or none (a request that names no session).
//   summary()       the session's account, also served to the seat at the gateway's status path: admitted, and each
//                   refusal with its code and what makes it recoverable.
//
// Stricter than the relay it replaces, by the gateway's own rules: only the seat's model is served (a request for any
// other model is refused on the wire), and countTokens is not served at all (the relay passed it through uncharged).
//
// Must never: forward a request spendGemini did not admit; hand the seat the real key; count an outcome as a charge.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { startModelGateway, upstreamRefusal, GATEWAY_REFUSALS, GATEWAY_STATUS_PATH } from "./gateway.mjs";
import { SDK_CONFIG } from "./config.mjs";
import { spendGemini, isGeminiBillingRefusal, GEMINI_BILLING_SCHEMA } from "../route/gemini-billing.mjs";

export const SEAT_SESSION_SCHEMA = "pantheon.seat-session/v1";
/** What the seat's process is given: the gateway's URL and the session's token. */
export const SEAT_URL_ENV = "PANTHEON_AGY_GATEWAY_URL";
export const SEAT_TOKEN_ENV = "PANTHEON_AGY_GATEWAY_TOKEN";
/** The upstream the gateway forwards to, when not the Gemini API: a Google API host, or a loopback fake (a test's edge). */
export const SEAT_UPSTREAM_ENV = "PANTHEON_AGY_GATEWAY_UPSTREAM";
/** A refusal of the caller's charge carries this mark, so the seat recognises it in whatever error text the SDK raises. */
export const SEAT_REFUSED_MARK = "PANTHEON_GATEWAY_REFUSED";
/** Vertex through the SDK seat: the gateway forwards to the Gemini API with GEMINI_API_KEY and holds no Vertex credential. */
export const SEAT_VERTEX_UNSUPPORTED = "PANTHEON_GATEWAY_VERTEX_UNSUPPORTED";
export const SEAT_NO_CREDENTIAL = "PANTHEON_GATEWAY_NO_CREDENTIAL";
export const SEAT_STATUS_PATH = GATEWAY_STATUS_PATH;
export const SEAT_DEFAULTS = Object.freeze({ maxRequests: 40, maxConcurrent: 8, idleMs: 15 * 60_000, lifetimeMs: 60 * 60_000, maxBodyBytes: 32 * 1024 * 1024 });

/** What makes each refusal recoverable, as the session's account states it. */
const RECOVERY = {
  METERED_GEMINI_BUDGET_EXHAUSTED: "the gemini_api_primary budget is spent and its recorded usage stays counted: declare a larger budget (--gemini-api-primary N) and resume",
  GEMINI_PRIMARY_DISABLED: "primary Gemini execution is off: declare --gemini-api-primary N (a budget of billed requests) and resume",
  PROVIDER_CALL_LIMIT: "the run's provider-call bound is reached: raise it and resume",
  ABORTED: "the run was stopped: resume it",
  GEMINI_USAGE_LOCKED: "the usage record is locked by a live process: retry when it is released",
  [GATEWAY_REFUSALS.UNAUTHORIZED]: "launch the seat through the controller (pantheon-board, or bin/agy-seat.mjs), which issues a token for its session",
  [GATEWAY_REFUSALS.EXPIRED]: "the session is over (idle too long, or past its lifetime): a new launch opens a new session",
  [GATEWAY_REFUSALS.PATH]: "this call is not one the gateway serves, so it is never sent (fail closed): only the generation calls of the seat's model are carried",
  [GATEWAY_REFUSALS.MODEL]: "the gateway serves the seat's own model only: a request for another model is never sent",
  [GATEWAY_REFUSALS.SESSION_CAP]: "the session's maximum request count is reached: a new launch opens a new session",
  [GATEWAY_REFUSALS.BUSY]: "the session has its bound of requests in flight: send it again when one has ended",
  [GATEWAY_REFUSALS.TOO_LARGE]: "the request is over the channel's size bound: send a smaller one",
  [GATEWAY_REFUSALS.MALFORMED]: "the request body is not a JSON object: it is not sent",
};
export const seatRecoveryOf = code => RECOVERY[code] ?? "the request is refused before it is sent; nothing was charged for it";

/** The upstream base URL of the seat's gateway: SEAT_UPSTREAM_ENV when set, else the Gemini API. Throws when the key may not go there. */
export function seatUpstreamOf(env = process.env) {
  const raw = env?.[SEAT_UPSTREAM_ENV];
  const upstream = raw === undefined || raw === "" ? SDK_CONFIG.api.base_url : raw;
  const bad = upstreamRefusal(upstream);
  if (bad) throw Object.assign(new Error(`${SEAT_UPSTREAM_ENV}: ${bad} (${raw})`), { code: GATEWAY_REFUSALS.UPSTREAM });
  return upstream;
}

/** The rows of an outcome record (the gateway's JSONL), or [] when there is none. An unreadable line is kept as {unreadable}. */
export const readSeatOutcomes = file => (file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { unreadable: l }; } }) : []);
/**
 * THE ACCOUNTING OF A USAGE RECORD AND ITS OUTCOME RECORD (owner item 7 of the L-150 decision): every admitted request is
 * a usage row and is counted; its outcome is joined by the session and its sequence when one was recorded, and UNKNOWN
 * when none was (a killed session, a crashed controller). The count is the usage rows, never the outcomes.
 */
export function seatAccounting({ usage = [], outcomes = [] } = {}) {
  const byId = new Map(outcomes.filter(o => o?.gateway_session && Number.isInteger(o?.seq)).map(o => [`${o.gateway_session}#${o.seq}`, o]));
  const admitted = usage.filter(r => r?.schema === GEMINI_BILLING_SCHEMA && r?.identity?.request_id);
  const rows = admitted.map(r => { const o = byId.get(r.identity.request_id); return { request_id: r.identity.request_id, model: r.model, outcome: o ? (o.status ?? o.refusal ?? "unknown") : "unknown" }; });
  return { admitted: rows.length, completed: rows.filter(r => r.outcome !== "unknown").length, unknown: rows.filter(r => r.outcome === "unknown").length, rows,
    refused: outcomes.filter(o => o?.refusal).length };
}

/** Open the gateway session of one launch of the python SDK seat. See the header. */
export async function openSeatSession({ apiKey, upstream = SDK_CONFIG.api.base_url, model, billing, admit = () => {}, spend = {}, maxRequests = SEAT_DEFAULTS.maxRequests,
  maxConcurrent = SEAT_DEFAULTS.maxConcurrent, idleMs = SEAT_DEFAULTS.idleMs, lifetimeMs = SEAT_DEFAULTS.lifetimeMs, maxBodyBytes = SEAT_DEFAULTS.maxBodyBytes,
  lineage = {}, outcomes = null, onAdmitted = null, onRefused = null, fetchImpl = fetch, signal = null } = {}) {
  if (typeof apiKey !== "string" || !apiKey) throw Object.assign(new Error(`the gateway holds the real Gemini credential, and none was given (${SDK_CONFIG.api.key_env})`), { code: SEAT_NO_CREDENTIAL });
  if (typeof model !== "string" || !model) throw new Error("openSeatSession: pass the seat's model");
  if (!billing?.policy || !Array.isArray(billing?.refusals)) throw new Error("openSeatSession: billing is a geminiBilling() context (route/gemini-billing.mjs)");
  if (!(Number.isSafeInteger(maxRequests) && maxRequests > 0)) throw new Error("openSeatSession: maxRequests is a positive integer (the session's maximum request count)");
  const id = `seat-${randomUUID()}`;
  const seat = { vendor: spend.vendor ?? "agy_google", purpose: spend.purpose ?? null, role: spend.role ?? null };
  const refusals = [];
  let admitted = 0, root = null, closed = false;
  const refused = (code, why, error = null, request_id = null) => {
    const r = { code, why: String(why).slice(0, 500), recovery: seatRecoveryOf(code), error, at: new Date().toISOString(), request_id };
    refusals.push(r);
    try { onRefused?.(r); } catch { /* a record hook never changes a refusal */ }
    return r;
  };
  // THE GATEWAY'S ADMISSION IS THE ONE POINT OF SPEND: the policy, then the caller's own admission, then the usage row
  // persisted and fsynced -- synchronously, so two requests of this controller cannot both take the last unit.
  const charge = info => {
    const sdk_session = info.session === null || info.session === undefined ? null : String(info.session).slice(0, 64);
    if (sdk_session !== null && root === null) root = sdk_session;
    const conversation = sdk_session === null ? "unattributed" : sdk_session === root ? "root" : "subagent";
    const request_id = `${id}#${info.seq}`;
    const identity = { gateway_session: id, request_id, seq: info.seq, method: info.verb ?? null, sdk_session };
    const line = { ...structuredClone(lineage), gateway_session: id, parent_session: root, conversation, subagent_session: conversation === "subagent" ? sdk_session : null, attributed_by: "sdk sessionId" };
    let row;
    try {
      row = spendGemini(billing, { kind: "primary", vendor: seat.vendor, model: info.model, purpose: seat.purpose, role: seat.role, transport: "sdk", request: admitted + 1, identity, lineage: line }, r => admit(r));
    } catch (e) {
      const code = isGeminiBillingRefusal(e) ? (e.billing?.code ?? e.code) : (e?.code ?? "GEMINI_USAGE_UNRECORDED");
      const said = String(e?.message ?? e), why = said.startsWith(`${code}: `) ? said.slice(code.length + 2) : said;
      const r = refused(code, why, e, request_id);
      throw Object.assign(new Error(`${SEAT_REFUSED_MARK} ${code}: ${r.why} (recovery: ${r.recovery})`), { code });
    }
    admitted += 1;
    try { onAdmitted?.(row); } catch { /* a record hook never refuses an admitted request */ }
  };
  let gateway = null;
  const summary = () => {
    const rec = gateway?.record() ?? null;
    // The gateway's own refusals (the session's cap, its bounds, a call it does not serve), beside the caller's charge.
    const wire = (rec?.requests ?? []).filter(r => r.refusal && r.refusal !== GATEWAY_REFUSALS.BUDGET).map(r => ({ code: r.refusal, why: `${r.verb ?? "request"} for ${r.model ?? "no model"} was refused on the wire`, recovery: seatRecoveryOf(r.refusal), at: r.at, request_id: `${id}#${r.seq}` }));
    return { schema: SEAT_SESSION_SCHEMA, gateway_session: id, model, max_requests: maxRequests, received: rec?.totals.received ?? 0, admitted,
      refused: [...refusals.map(({ code, why, recovery, at, request_id }) => ({ code, why, recovery, at, request_id })), ...wire],
      outcomes: (rec?.requests ?? []).filter(r => r.forwarded).length, root_session: root, closed };
  };
  gateway = await startModelGateway({ upstream, apiKey, root: { model, marker: `[pantheon-seat:${id}]` }, subagents: { model: null, ceiling: 0, markers: {} }, admit: charge,
    maxRequests, maxConcurrent, idleMs, lifetimeMs, maxBodyBytes, outcomes, outcomeTag: { gateway_session: id }, status: summary, fetchImpl, signal });
  return {
    id, env: Object.freeze({ [SEAT_URL_ENV]: gateway.url, [SEAT_TOKEN_ENV]: gateway.token }), refusals, summary,
    get admitted() { return admitted; },
    /** The first refusal of the billing policy or of the run's own admission, as the Error spendGemini threw. */
    get billingRefusal() { return refusals.find(r => r.error && (isGeminiBillingRefusal(r.error) || ["PROVIDER_CALL_LIMIT", "ABORTED"].includes(r.error.code) || r.error.name === "AbortError"))?.error ?? null; },
    record: () => gateway.record(),
    abort: why => gateway.abort(why),
    async close() { if (closed) return; closed = true; await gateway.close(); },
  };
}
