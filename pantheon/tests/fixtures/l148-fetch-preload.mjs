// THE PROVIDER EDGE OF THE VIEW SERVER for register L-148 (bin/pantheon-view.mjs, and the launchers that drive it):
// preloaded with `node --import`, it loads the L-146 edge (fixtures/l146-fetch-preload.mjs, over the L-136 recorder;
// both unchanged), so every provider request is still recorded with the usage rows persisted when it was sent and none
// leaves the machine. What the view's seats need on top of it, because the view STREAMS every turn:
//   - a streamed Responses request (OpenAI, xAI: `stream: true`) whose host L146_EDGE answers "ok" is turned from the
//     recorder's completed response into server-sent events (response.created, a text delta, response.completed);
//   - a streamed Messages request (Anthropic) the same way (message_start ... message_stop);
//   - a token count (OpenAI /responses/input_tokens, Anthropic /messages/count_tokens) is recorded like any request and
//     answered with a count, so the seat's context admission passes;
//   - a GOOGLE token count (:countTokens), which the L-136 recorder answers without recording, is recorded here
//     (`google_count: true`), so a test sees every request that reaches a Google host, billed or not.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

await import("./l146-fetch-preload.mjs");
const edge = globalThis.fetch;
const bodyOf = init => { try { return JSON.parse(typeof init?.body === "string" ? init.body : ""); } catch { return {}; } };
const rows = f => (f && existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0);
const enc = new TextEncoder();
const stream = events => new Response(new ReadableStream({
  start(ctl) { for (const e of events) ctl.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)); ctl.close(); },
}), { status: 200, headers: { "content-type": "text/event-stream" } });

globalThis.fetch = async (url, init = {}) => {
  const u = String(url?.url ?? url);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return edge(url, init);
  if (/googleapis\.com/.test(u) && /:countTokens/.test(u)) {
    appendFileSync(process.env.L136_FETCH_LOG, JSON.stringify({ n: null, url: u, billed: false, google_count: true,
      usage_rows: rows(process.env.L136_USAGE_FILE), at: new Date().toISOString() }) + "\n");
    return Response.json({ totalTokens: 10 });
  }
  const res = await edge(url, init);
  if (/\/responses\/input_tokens|\/messages\/count_tokens/.test(u)) return Response.json({ object: "response.input_tokens", input_tokens: 10 });
  if (bodyOf(init).stream !== true || !res.ok) return res;
  const json = await res.json();
  if (/\/messages/.test(u)) {
    const text = (json.content ?? []).map(c => c.text ?? "").join("");
    return stream([
      { type: "message_start", message: { ...json, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: json.stop_reason ?? "end_turn" }, usage: json.usage ?? {} },
      { type: "message_stop" },
    ]);
  }
  return stream([
    { type: "response.created", response: { ...json, status: "in_progress", output: [] } },
    { type: "response.output_text.delta", delta: json.output_text ?? "" },
    { type: "response.completed", response: json },
  ]);
};
