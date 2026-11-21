// Fixture: a SCRIPTED stand-in for the Gemini Developer API on loopback, for the Antigravity SDK transport's tests.
// It serves what the SDK's runtime was observed to call (google-antigravity 0.1.24):
//   POST /v1beta/models/<model>:streamGenerateContent?alt=sse   one SSE event carrying the whole scripted answer
//   POST /v1beta/models/<model>:generateContent                 the same answer as one JSON object
//   GET  /v1beta/models/<model>                                 the model resource (or 404 for a model `models` lacks)
// decide({model, body, seq, path, verb, headers, session, system}) -> {parts, finishReason?, usage?, modelVersion?,
//   delayMs?} | {status, error, delayMs?}. Every request is recorded in `requests` (headers included, so a test can
//   assert which credential reached the provider). No network, no real model.
import { createServer } from "node:http";

export const fc = (name, args = {}) => ({ functionCall: { name, args: { toolSummary: "Scripted step", toolAction: "Running step", ...args } } });
export const text = t => ({ text: t });
/** How many function responses the conversation in `body` already holds (the scripted model's step counter). */
export const responsesIn = body => (body?.contents ?? []).reduce((n, c) => n + (c.parts ?? []).filter(p => p.functionResponse).length, 0);
export const systemOf = body => JSON.stringify(body?.systemInstruction ?? "");
export const lastContentOf = body => JSON.stringify((body?.contents ?? []).at(-1) ?? "");
const quota = { status: 429, error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } };
export const QUOTA = Object.freeze(quota);
export const notFound = model => ({ status: 404, error: { code: 404, message: `models/${model} is not found for API version v1beta, or is not supported for generateContent.`, status: "NOT_FOUND" } });

export async function startFakeGemini({ decide, models = null, port = 0 } = {}) {
  const requests = [], open = new Set();
  const server = createServer(async (req, res) => {
    open.add(res); res.on("close", () => open.delete(res));
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = /^\/v1beta\/models\/([^:/]+)(?::(\w+))?$/.exec(url.pathname);
    const rec = { seq: requests.length + 1, at: Date.now(), method: req.method, path: req.url, model: m?.[1] ?? null, verb: m?.[2] ?? null, headers: { ...req.headers }, body,
      session: body?.sessionId ?? null, system: systemOf(body), aborted: false };
    requests.push(rec);
    req.on("aborted", () => { rec.aborted = true; }); res.on("close", () => { if (!res.writableEnded) rec.aborted = true; });
    const json = (status, value) => { const s = JSON.stringify(value); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) }); res.end(s); };
    if (!m) return json(404, { error: { code: 404, message: "no such path on the scripted endpoint", status: "NOT_FOUND" } });
    if (req.method === "GET" && !m[2]) {
      const known = models ?? null, spec = known ? known[m[1]] : {};
      if (known && !spec) return json(404, notFound(m[1]));
      return json(200, { name: `models/${m[1]}`, displayName: m[1], inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent", "countTokens"], ...(spec ?? {}) });
    }
    let out;
    try { out = await decide({ model: rec.model, body, seq: rec.seq, path: req.url, verb: rec.verb, headers: req.headers, session: rec.session, system: rec.system }); }
    catch (e) { out = { status: 500, error: { code: 500, message: String(e?.message ?? e), status: "INTERNAL" } }; }
    if (out?.delayMs) await new Promise(r => { const t = setTimeout(r, out.delayMs); res.on("close", () => { clearTimeout(t); r(); }); });
    if (res.destroyed) return;
    if (out?.status && out.status !== 200) return json(out.status, { error: out.error ?? { code: out.status, message: "scripted refusal", status: "FAILED_PRECONDITION" } });
    const usage = out.usage ?? { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 115 };
    const payload = { candidates: [{ content: { role: "model", parts: out.parts }, finishReason: out.finishReason ?? "STOP", index: 0 }], usageMetadata: usage,
      ...(out.modelVersion === null ? {} : { modelVersion: out.modelVersion ?? rec.model }), responseId: `resp-${rec.seq}` };
    if (rec.verb === "streamGenerateContent") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return res.end();
    }
    return json(200, payload);
  });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests,
    close: () => new Promise(r => { for (const s of open) s.destroy(); server.close(() => r()); server.closeAllConnections?.(); }) };
}
