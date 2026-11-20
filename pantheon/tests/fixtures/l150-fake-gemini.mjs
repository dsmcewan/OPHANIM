// THE PROVIDER EDGE OF REGISTER L-150: a LOCAL fake Gemini API (never a real provider), the upstream of the metering relay
// (src/route/gemini-relay.mjs) in every test and in the real-SDK proof. It records every request it receives -- method,
// path, the key it was sent with, the SDK's sessionId, whether it is a subagent's (its tools hold no invoke_subagent), and
// the number of usage rows ALREADY PERSISTED when it arrived ("charged before it was sent", asserted at the edge itself) --
// and answers as a model would, so the SDK (the real google-antigravity harness, or the stub of fixtures/l150-sdk-stub)
// exercises its call paths: tool-call continuations, a subagent, a web search, retries, an endless session.
//
//   mode review  root: view_file, then invoke_subagent, then the final text; a subagent: one text answer
//   mode scout   root: search_web (the SDK's :generateContent web search), then the final text
//   mode loop    root: view_file forever (a session that would make as many requests as it is allowed)
//   mode text    one final text answer
//   mode hang    accept the request and never answer (a crash or a cancellation in flight)
//   failFirst N  answer the first N requests with HTTP 503 (the SDK retries them)
//   promptTokens the prompt tokens each answer reports (a large count makes the real SDK summarize its context)
//
// In-process: startFakeGemini({mode, failFirst, usage, final}) -> {url, requests, close}. As a process (a test whose
// event loop is blocked by spawnSync): `node l150-fake-gemini.mjs --mode M [--fail-first N] [--usage FILE] [--log FILE]`
// prints one JSON line {url} and serves until killed, appending each request to --log.
import http from "node:http";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const rowsIn = f => (f && existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0);
const fnResponses = contents => (contents ?? []).flatMap(c => c.parts ?? []).filter(p => p.functionResponse).map(p => p.functionResponse.name);
const toolsOf = j => (j.tools ?? []).flatMap(t => (t.functionDeclarations ?? []).map(d => d.name));
const call = (name, args) => [{ functionCall: { name, args: { ...args, toolAction: "Working", toolSummary: "Work" } } }];

function answer({ mode, final, workspace }, j) {
  const tools = toolsOf(j), done = fnResponses(j.contents), sub = !tools.includes("invoke_subagent");
  if (mode === "text") return [{ text: final }];
  if (mode === "loop") return call("view_file", { AbsolutePath: `${workspace}/README.md` });
  if (Array.isArray(j.tools) && j.tools.some(t => t.googleSearch)) return [{ text: "1. https://example.invalid/result -- a search result" }];
  if (mode === "scout") return done.includes("search_web") ? [{ text: final }] : call("search_web", { query: "metering relay" });
  if (sub) return [{ text: "subagent: ran the check, exit 0" }];
  if (done.length === 0) return call("view_file", { AbsolutePath: `${workspace}/README.md` });
  if (!done.includes("invoke_subagent")) return call("invoke_subagent", { Subagents: [{ TypeName: "pantheon-fact-checker", Role: "Fact checker", Prompt: "Run: echo ok" }] });
  return [{ text: final }];
}

export function startFakeGemini({ mode = "review", failFirst = 0, usage = null, final = "VERDICT: approve", workspace = "/nonexistent", log = null, promptTokens = 100 } = {}) {
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8"), i = n++;
      let j = {};
      try { j = JSON.parse(body || "{}"); } catch { j = {}; }
      const tools = toolsOf(j);
      const rec = { i, method: req.method, path: String(req.url).split("?")[0], query: String(req.url).split("?")[1] ?? null, key: req.headers["x-goog-api-key"] ?? null,
        authorization: req.headers.authorization ?? null, session: j.sessionId ?? null, subagent: tools.length > 0 && !tools.includes("invoke_subagent"),
        fn_responses: fnResponses(j.contents), search: Array.isArray(j.tools) && j.tools.some(t => t.googleSearch), usage_rows: rowsIn(usage), at: Date.now() };
      requests.push(rec);
      if (log) appendFileSync(log, JSON.stringify(rec) + "\n");
      if (mode === "hang") return; // never answered: the request is in flight until the client or the server dies
      if (i < failFirst) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 503, message: "the fake provider is overloaded", status: "UNAVAILABLE" } }));
        return;
      }
      const model = (/models\/([^:]+)/.exec(req.url) ?? [])[1] ?? "unknown";
      const payload = { candidates: [{ content: { role: "model", parts: answer({ mode, final, workspace }, j) }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: 7, totalTokenCount: promptTokens + 7 }, modelVersion: model, responseId: `fake-resp-${i}` };
      if (/:countTokens$/.test(rec.path)) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ totalTokens: 10 })); return; }
      if (rec.query === "alt=sse") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify(payload)}\r\n\r\n`); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(payload));
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, requests,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2), at = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const fake = await startFakeGemini({ mode: at("--mode") ?? "review", failFirst: Number(at("--fail-first") ?? 0), usage: at("--usage") ?? null,
    final: at("--final") ?? "VERDICT: approve", workspace: at("--workspace") ?? "/nonexistent", log: at("--log") ?? null, promptTokens: Number(at("--prompt-tokens") ?? 100) });
  process.stdout.write(JSON.stringify({ url: fake.url }) + "\n");
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => fake.close().then(() => process.exit(0)));
}
