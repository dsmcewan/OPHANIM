// THE MODEL GATEWAY: the controller's own loopback door between the Antigravity SDK's runtime and the Gemini API.
//
// The SDK's runtime (the localharness binary google-antigravity bundles) makes the model calls itself. It is given
// this gateway's address as its base URL and a per-session TOKEN as its "API key" (both are options the SDK documents:
// GeminiAPIEndpoint base_url and api_key). The controller keeps the real GEMINI_API_KEY and puts it on the forwarded
// request. So:
//   CREDENTIAL   the key never enters the SDK process, its environment, its argv, its state directory, a worktree, a
//                subagent or a log. What the runtime holds is a token that is worth nothing once this gateway closes.
//   ACCOUNTING   every billed request -- the implementer's and each subagent's -- is admitted by `admit` BEFORE it is
//                forwarded (the per-request charge contract of sdk/live.mjs: charged on the work ledger first, and a
//                refused charge means the request is not made).
//   IDENTITY     only two models are served: the implementer's and the pinned subagent model. A subagent (recognised
//                by the marker the controller put in its system instructions) asking for any other model is REFUSED
//                on the wire, so a child can never run as a clone of its parent, whatever the SDK or the model did.
//                The model the PROVIDER says answered (`modelVersion`) is recorded for every request.
//   CEILING      a subagent session past the implementer's ceiling is refused on the wire: the second line behind the
//                governor's admission at invoke_subagent (subagents.mjs).
//   STOP         abort() cuts every request in flight and forwards nothing afterwards.
//
// Observed on google-antigravity 0.1.24 (pantheon/tests/antigravity-sdk-contract.test.mjs repeats it): the runtime
// calls POST /v1beta/models/<model>:streamGenerateContent?alt=sse over HTTP/1.1 with the key in x-goog-api-key and a
// `sessionId` in the body that is stable per agent (the implementer's and each subagent's differ).
//
// Inputs: {upstream, apiKey, root: {model, marker}, subagents: {model, ceiling, markers: {type: marker}}, admit,
// signal?, fetchImpl?, requestTimeoutMs?}. Outputs: {url, token, record(), availability(model), abort(why), close()}.
// Must never: forward a request it did not admit; forward the runtime's token; write the key or the token anywhere;
// serve a model, path or verb outside the two models' generation calls; answer a caller that does not hold the token.
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { SDK_CONFIG } from "./config.mjs";

export const GATEWAY_REFUSALS = Object.freeze({
  UNAUTHORIZED: "PANTHEON_GATEWAY_UNAUTHORIZED", PATH: "PANTHEON_PATH_NOT_SERVED", MODEL: "PANTHEON_MODEL_NOT_ALLOWED", NOT_PINNED: "PANTHEON_SUBAGENT_NOT_PINNED",
  CEILING: "PANTHEON_SUBAGENT_CEILING", BUDGET: "PANTHEON_PROVIDER_LIMIT", ABORTED: "PANTHEON_GATEWAY_ABORTED", TOO_LARGE: "PANTHEON_REQUEST_TOO_LARGE" });
const MAX_BODY = 64 * 1024 * 1024;
const str = v => typeof v === "string" && v.trim() !== "";
const FORWARD_HEADERS = Object.freeze(["content-type", "accept", "user-agent", "x-goog-api-client"]);

/** What a provider status means for the turn: quota | model_unavailable | auth | provider_error | bad_request. */
export function stopKindOf(status) {
  if (status === 429) return "quota";
  if (status === 404) return "model_unavailable";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "provider_error";
  return "bad_request";
}
const usageOf = u => (u && typeof u === "object" ? Object.fromEntries(Object.entries({ prompt_token_count: u.promptTokenCount, cached_content_token_count: u.cachedContentTokenCount,
  candidates_token_count: u.candidatesTokenCount, thoughts_token_count: u.thoughtsTokenCount, total_token_count: u.totalTokenCount }).filter(([, v]) => Number.isFinite(v))) : null);
const addUsage = (a, b) => { const out = { ...(a ?? {}) }; for (const [k, v] of Object.entries(b ?? {})) out[k] = (out[k] ?? 0) + v; return out; };

export async function startModelGateway({ upstream = SDK_CONFIG.api.base_url, apiKey, keyHeader = SDK_CONFIG.api.key_header, root, subagents = { model: null, ceiling: 0, markers: {} }, admit = () => {},
  signal = null, fetchImpl = fetch, requestTimeoutMs = 10 * 60_000, port = 0 } = {}) {
  if (!str(apiKey)) throw Object.assign(new Error(`the model gateway needs the Gemini API key (${SDK_CONFIG.api.key_env}); it is held by the controller only`), { code: "NO_API_KEY" });
  if (!str(root?.model) || !str(root?.marker)) throw new Error("startModelGateway: pass root {model, marker}");
  const base = String(upstream).replace(/\/+$/, "");
  const sub = { model: subagents?.model ?? null, ceiling: Number.isInteger(subagents?.ceiling) ? subagents.ceiling : 0, markers: { ...(subagents?.markers ?? {}) } };
  const token = `pantheon-gw-${randomBytes(24).toString("hex")}`;
  const want = Buffer.from(token);
  const verbs = new Set(SDK_CONFIG.api.generation_verbs);
  const requests = [], sessions = new Map(), availabilityLog = [], inflight = new Set(), counts = { root: 0, subagent: 0, aux: 0 };
  let stop = null, aborted = null, budgetRefusals = 0, closed = false;

  const allowedModel = m => m === root.model || (sub.ceiling > 0 && str(sub.model) && m === sub.model);
  const send = (res, status, body) => { if (res.destroyed || res.headersSent) return; const s = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) }); res.end(s); };
  const refuse = (res, rec, status, code, why, providerStatus = "FAILED_PRECONDITION") => {
    Object.assign(rec, { forwarded: false, status, refusal: code });
    send(res, status, { error: { code: status, message: `${code}: ${why}`, status: providerStatus } });
  };

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = /^\/v1beta\/models\/([^:/]+):(\w+)$/.exec(url.pathname);
    const rec = { seq: requests.length + 1, at: new Date().toISOString(), class: null, type: null, session: null, model: m?.[1] ?? null, verb: m?.[2] ?? null, forwarded: false, status: null,
      refusal: null, provider_status: null, served_model: null, usage: null, ms: null };
    requests.push(rec);
    const t0 = Date.now();
    const done = () => { rec.ms = Date.now() - t0; };
    // The caller holds this session's token, or it is not served.
    const got = Buffer.from(String(req.headers[keyHeader] ?? ""));
    if (got.length !== want.length || !timingSafeEqual(got, want)) { req.resume(); refuse(res, rec, 401, GATEWAY_REFUSALS.UNAUTHORIZED, "this gateway serves the one SDK session it was started for", "UNAUTHENTICATED"); return done(); }
    if (aborted) { req.resume(); refuse(res, rec, 503, GATEWAY_REFUSALS.ABORTED, `the session was stopped: ${aborted}`, "UNAVAILABLE"); return done(); }
    if (req.method !== "POST" || !m || !verbs.has(m[2])) { req.resume(); refuse(res, rec, 404, GATEWAY_REFUSALS.PATH, `only POST /v1beta/models/<model>:${[...verbs].join("|")} is served`, "NOT_FOUND"); return done(); }
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) { req.destroy(); refuse(res, rec, 413, GATEWAY_REFUSALS.TOO_LARGE, `the request is over ${MAX_BODY} bytes`); return done(); } chunks.push(c); }
    const raw = Buffer.concat(chunks);
    let body = null; try { body = JSON.parse(raw.toString("utf8")); } catch { body = null; }
    const model = m[1], system = JSON.stringify(body?.systemInstruction ?? "");
    const type = Object.entries(sub.markers).find(([, mark]) => str(mark) && system.includes(mark))?.[0] ?? null;
    rec.session = body?.sessionId !== undefined && body?.sessionId !== null ? String(body.sessionId) : null;
    rec.type = type;
    rec.class = type ? "subagent" : system.includes(root.marker) ? "root" : "aux";
    if (!allowedModel(model)) { refuse(res, rec, 403, GATEWAY_REFUSALS.MODEL, `${model} is not served: this session's models are ${root.model}${sub.ceiling > 0 && sub.model ? ` and ${sub.model} (subagents)` : ""}`, "PERMISSION_DENIED"); return done(); }
    // A subagent runs on the pinned subagent model, and only a subagent does (unless the two models are the same one).
    if (type && model !== sub.model) { refuse(res, rec, 403, GATEWAY_REFUSALS.NOT_PINNED, `a ${type} subagent asked for ${model}: subagents run on ${sub.model} only, never as a copy of the implementer`, "PERMISSION_DENIED"); return done(); }
    if (!type && model !== root.model) { refuse(res, rec, 403, GATEWAY_REFUSALS.MODEL, `${model} is served to this session's subagents only`, "PERMISSION_DENIED"); return done(); }
    const key = rec.session ?? `nosession:${rec.class}:${type ?? ""}`;
    if (rec.class === "subagent" && !sessions.has(key)) {
      const liveSubs = [...sessions.values()].filter(s => s.class === "subagent").length;
      if (liveSubs >= sub.ceiling) { refuse(res, rec, 429, GATEWAY_REFUSALS.CEILING, `${liveSubs} subagent session(s) are live and the ceiling is ${sub.ceiling}`, "RESOURCE_EXHAUSTED"); return done(); }
    }
    // ADMITTED BEFORE IT IS FORWARDED: the caller's charge. A refused charge is a refused request.
    try { await admit({ class: rec.class, type, model, session: rec.session, n: counts[rec.class] + 1, seq: rec.seq }); }
    catch (e) {
      budgetRefusals += 1;
      stop = { kind: "budget", status: 429, provider_status: null, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 300), class: rec.class };
      refuse(res, rec, 429, GATEWAY_REFUSALS.BUDGET, String(e?.message ?? e).slice(0, 300), "RESOURCE_EXHAUSTED");
      return done();
    }
    counts[rec.class] += 1;
    const s = sessions.get(key) ?? sessions.set(key, { session: rec.session, class: rec.class, type, model, requests: 0, usage: null, served_models: [], errors: [] }).get(key);
    s.requests += 1;
    const ac = new AbortController();
    const entry = { ac, res };
    inflight.add(entry);
    const timer = setTimeout(() => ac.abort(new Error(`no answer from the provider within ${requestTimeoutMs} ms`)), requestTimeoutMs);
    res.on("close", () => { if (!res.writableEnded) ac.abort(new Error("the runtime closed the connection")); });
    try {
      const headers = Object.fromEntries(FORWARD_HEADERS.filter(h => req.headers[h] !== undefined).map(h => [h, req.headers[h]]));
      headers[keyHeader] = apiKey;
      const up = await fetchImpl(`${base}${url.pathname}${url.search}`, { method: "POST", headers, body: raw, signal: ac.signal });
      rec.forwarded = true; rec.status = up.status;
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json", "cache-control": "no-cache" });
      const dec = new TextDecoder();
      let buf = "", all = "";
      const scan = line => {
        const t = line.startsWith("data:") ? line.slice(5).trim() : null;
        if (!t || t === "[DONE]") return;
        try { const j = JSON.parse(t); if (str(j.modelVersion)) rec.served_model = j.modelVersion; const u = usageOf(j.usageMetadata); if (u) rec.usage = u; } catch { /* a partial or non-JSON event carries no identity */ }
      };
      for await (const chunk of up.body ?? []) {
        if (!res.destroyed) res.write(chunk);
        const txt = dec.decode(chunk, { stream: true });
        if (up.status === 200 && rec.verb === "streamGenerateContent") { buf += txt; let i; while ((i = buf.indexOf("\n")) >= 0) { scan(buf.slice(0, i).trimEnd()); buf = buf.slice(i + 1); } }
        else if (all.length < 1024 * 1024) all += txt;
      }
      if (buf) scan(buf.trimEnd());
      if (!res.destroyed) res.end();
      if (up.status === 200) {
        if (rec.verb !== "streamGenerateContent") { try { const j = JSON.parse(all); if (str(j.modelVersion)) rec.served_model = j.modelVersion; rec.usage = usageOf(j.usageMetadata); } catch { /* not JSON: nothing is recorded */ } }
        if (rec.usage) s.usage = addUsage(s.usage, rec.usage);
        if (rec.served_model && !s.served_models.includes(rec.served_model)) s.served_models.push(rec.served_model);
        if (rec.class !== "subagent") stop = null;
      } else {
        let err = null; try { err = JSON.parse(all)?.error ?? null; } catch { err = null; }
        rec.provider_status = str(err?.status) ? err.status : null;
        const failure = { kind: stopKindOf(up.status), status: up.status, provider_status: rec.provider_status, message: String(err?.message ?? all).slice(0, 300), class: rec.class };
        s.errors.push(failure);
        if (rec.class !== "subagent") stop = failure;
      }
    } catch (e) {
      rec.refusal = aborted ? GATEWAY_REFUSALS.ABORTED : "PANTHEON_UPSTREAM_FAILED";
      const failure = { kind: aborted ? "aborted" : "provider_error", status: null, provider_status: null, message: String(e?.message ?? e).slice(0, 300), class: rec.class };
      s.errors.push(failure);
      if (rec.class !== "subagent" && !aborted) stop = failure;
      if (!res.headersSent) send(res, 502, { error: { code: 502, message: `${rec.refusal}: ${failure.message}`, status: "UNAVAILABLE" } });
      else res.destroy();
    } finally { clearTimeout(timer); inflight.delete(entry); done(); }
  }

  const server = createServer((req, res) => { handle(req, res).catch(() => { try { res.destroy(); } catch { /* gone */ } }); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const abort = why => {
    if (aborted) return;
    aborted = String(why ?? "aborted").slice(0, 300);
    for (const e of inflight) { e.ac.abort(new Error(aborted)); try { e.res.destroy(); } catch { /* gone */ } }
  };
  const onSignal = () => abort(signal?.reason?.message ?? "the caller's signal aborted");
  if (signal?.aborted) onSignal(); else signal?.addEventListener("abort", onSignal, { once: true });

  /** Ask the provider whether it serves `model` (GET /v1beta/models/<model>), with the controller's key. Not a billed call. */
  async function availability(model) {
    const out = { model, at: new Date().toISOString(), available: false, status: null, kind: null, limits: null, name: null, why: null };
    try {
      const r = await fetchImpl(`${base}/v1beta/models/${encodeURIComponent(model)}`, { headers: { [keyHeader]: apiKey }, signal: AbortSignal.timeout(30_000) });
      out.status = r.status;
      const j = await r.json().catch(() => null);
      if (r.status === 200) {
        Object.assign(out, { available: true, name: j?.name ?? null, limits: { input_token_limit: j?.inputTokenLimit ?? null, output_token_limit: j?.outputTokenLimit ?? null, thinking: j?.thinking ?? null,
          supported_generation_methods: Array.isArray(j?.supportedGenerationMethods) ? j.supportedGenerationMethods : null } });
      } else Object.assign(out, { kind: stopKindOf(r.status), why: String(j?.error?.message ?? `HTTP ${r.status}`).slice(0, 300), provider_status: j?.error?.status ?? null });
    } catch (e) { Object.assign(out, { kind: "provider_error", why: String(e?.message ?? e).slice(0, 300) }); }
    availabilityLog.push(out);
    return out;
  }

  return {
    url: `http://127.0.0.1:${server.address().port}`, token, availability, abort,
    record: () => {
      const served = {};
      for (const r of requests) if (r.forwarded && r.served_model) (served[r.model] ??= []).includes(r.served_model) || served[r.model].push(r.served_model);
      return { root: { model: root.model }, subagents: { model: sub.model, ceiling: sub.ceiling }, requests: requests.map(r => ({ ...r })),
        sessions: [...sessions.values()].map(s => ({ ...s, usage: s.usage ? { ...s.usage } : null, served_models: [...s.served_models], errors: s.errors.map(e => ({ ...e })) })),
        subagent_sessions: [...sessions.values()].filter(s => s.class === "subagent").length, served_models: served,
        totals: { received: requests.length, forwarded: requests.filter(r => r.forwarded).length, refused: requests.filter(r => r.refusal).length, by_class: { ...counts } },
        budget_refusals: budgetRefusals, stop: stop ? { ...stop } : null, aborted, availability: availabilityLog.map(a => ({ ...a })) };
    },
    close: () => (closed ? Promise.resolve() : new Promise(resolve => { closed = true; signal?.removeEventListener("abort", onSignal); for (const e of inflight) { e.ac.abort(new Error("the gateway closed")); try { e.res.destroy(); } catch { /* gone */ } } server.close(() => resolve()); server.closeAllConnections?.(); })),
  };
}
