// THE PROVIDER EDGE OF A CHILD PROCESS for register L-146 (the operator scripts and bin/cross-lab-review.mjs): preloaded
// with `node --import`, it loads the L-136 recorder (fixtures/l136-fetch-preload.mjs, unchanged: one JSONL line per
// request with the usage rows persisted at send time, so "charged, then sent" is observable) and adds what these paths
// need on top of it. Every request still goes through that recorder first, so none leaves the machine and the log's
// numbering is the recorder's own:
//   - loopback (view-check's own view server) goes to the real fetch, unrecorded: it is not a provider;
//   - a streamed Gemini request (:streamGenerateContent) is answered as server-sent events, the recorder's reply split in
//     two chunks (the finish reason and any continuation token on the last);
//   - the Gemini API's OpenAI-compatible endpoint (bin/cycle-review-http-turn.mjs) gets a chat completion;
//   - another lab's host answers as L146_EDGE says ({"api.openai.com": "ok" | "429" | "500", ...}; default: the
//     recorder's 500). "ok" is a completed Responses or Messages reply with L136_GEMINI_TEXT's text;
//   - L146_GEMINI_FAIL_FIRST=<status>: the process's first Gemini generation request (recorded, so it was sent) is
//     answered with that HTTP status, so a caller's retry is a further request.
const real = globalThis.fetch;
await import("./l136-fetch-preload.mjs");
const recorded = globalThis.fetch;
const TEXT = process.env.L136_GEMINI_TEXT ?? '```json\n{"verdict": "approve", "findings": []}\n```';
const EDGE = JSON.parse(process.env.L146_EDGE ?? "{}");
let geminiRequests = 0;
const bodyOf = init => { try { return JSON.parse(typeof init?.body === "string" ? init.body : ""); } catch { return {}; } };

function sse(json) {
  const c = json?.candidates?.[0] ?? {}, parts = c.content?.parts ?? [], text = parts.map(p => p.text ?? "").join("");
  const half = Math.max(1, Math.floor(text.length / 2));
  const { finishReason, continuationToken, ...first } = c;
  const chunks = [
    { candidates: [{ ...first, content: { role: "model", parts: [{ text: text.slice(0, half) }] } }], modelVersion: json.modelVersion },
    { ...json, candidates: [{ ...c, content: { role: "model", parts: [{ text: text.slice(half) }] } }] },
  ];
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctl) {
      for (const [i, ch] of chunks.entries()) {
        if (i) await new Promise(r => setTimeout(r, 15));
        ctl.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\r\n\r\n`));
      }
      ctl.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url?.url ?? url);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return real(url, init);
  const res = await recorded(url, init);
  const host = /^https?:\/\/([^/]+)/.exec(u)?.[1] ?? "";
  if (/generativelanguage\.googleapis\.com/.test(host)) {
    if (/countTokens/.test(u)) return res;
    if (++geminiRequests === 1 && process.env.L146_GEMINI_FAIL_FIRST) {
      const status = Number(process.env.L146_GEMINI_FAIL_FIRST);
      return Response.json({ error: { code: status, message: "fake provider edge: unavailable", status: "UNAVAILABLE" } }, { status });
    }
    const json = await res.json();
    if (/:streamGenerateContent/.test(u)) return sse(json);
    if (/\/openai\/chat\/completions/.test(u)) {
      const text = (json.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("");
      return Response.json({ id: "chatcmpl-l146", object: "chat.completion", model: bodyOf(init).model ?? "gemini",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }] });
    }
    return Response.json(json);
  }
  const mode = EDGE[host];
  if (mode === "429") return Response.json({ type: "error", error: { type: "rate_limit_error", message: "fake provider edge: rate limited" } }, { status: 429 });
  if (mode !== "ok") return res;
  const model = bodyOf(init).model ?? "model";
  if (/\/messages/.test(u)) {
    return Response.json({ id: "msg_l146", type: "message", role: "assistant", model, stop_reason: "end_turn",
      content: [{ type: "text", text: TEXT }], usage: { input_tokens: 10, output_tokens: 5 } });
  }
  return Response.json({ id: `resp_l146_${host}`, object: "response", status: "completed", model, output_text: TEXT,
    output: [{ type: "message", id: "msg_l146", role: "assistant", status: "completed", content: [{ type: "output_text", text: TEXT, annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
};
