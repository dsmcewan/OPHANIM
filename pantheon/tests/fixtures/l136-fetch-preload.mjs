// THE PROVIDER EDGE OF A CHILD PROCESS (register L-136 tests): preloaded with `node --import` into an entry point the test
// spawns, it replaces globalThis.fetch with a RECORDER, so every HTTP request the real SDK clients would send is seen here
// and none leaves the machine. Configured by environment (test-only names):
//   L136_FETCH_LOG     a JSONL file: one line per request {n, url, billed (a Gemini API request), usage_rows, work_billings}
//   L136_USAGE_FILE    the Gemini usage record the request must already be recorded in (counted at send time)
//   L136_WORK_CHAIN    a work ledger's chain.jsonl: its work.billing entries are counted at send time
//   L136_GEMINI_TEXT   the text a Gemini request is answered with (default: an approving review)
//   L136_GEMINI_MODE   "continue": the first Gemini request of the process answers CONTINUATION (a further billed hop)
// A Gemini request (generativelanguage.googleapis.com, not countTokens) is answered as the Gemini API would; anything
// else gets HTTP 500 (the test asserts on the Gemini path only).
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const count = (file, pred = () => true) => (file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).filter(pred).length : 0);
const isBilling = line => { try { return JSON.parse(line).kind === "work.billing"; } catch { return false; } };
const TEXT = process.env.L136_GEMINI_TEXT ?? '```json\n{"verdict": "approve", "findings": []}\n```';
let n = 0, gemini = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url?.url ?? url);
  if (/countTokens/.test(u)) return Response.json({ totalTokens: 10 });
  const billed = /generativelanguage\.googleapis\.com/.test(u);
  appendFileSync(process.env.L136_FETCH_LOG, JSON.stringify({ n: ++n, url: u, billed, usage_rows: count(process.env.L136_USAGE_FILE),
    work_billings: count(process.env.L136_WORK_CHAIN, isBilling), at: new Date().toISOString() }) + "\n");
  if (!billed) return new Response(JSON.stringify({ error: { code: 500, message: "fake provider edge: not scripted" } }), { status: 500, headers: { "content-type": "application/json" } });
  const k = ++gemini, continuing = process.env.L136_GEMINI_MODE === "continue";
  const hop = continuing && k === 1;
  const text = hop ? TEXT.slice(0, 8) : continuing && k === 2 ? TEXT.slice(8) : TEXT;
  const model = /models\/([^:/]+)/.exec(u)?.[1] ?? "gemini";
  return Response.json({ modelVersion: model, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    candidates: [{ index: 0, finishReason: hop ? "CONTINUATION" : "STOP", ...(hop ? { continuationToken: "l136-hop" } : {}),
      content: { role: "model", parts: [{ text }] } }] });
};
