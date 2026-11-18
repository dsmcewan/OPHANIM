// Fetch-based request shaping for the three reviewer vendors. No SDK: each conversation object
// builds the next request body from what it holds, and reads a response into tool calls or a
// final text. The served model is read only from the response; it is never filled in.
//
// Kept consistent with pantheon/src/sdk/adapter.mjs where it applies: OpenAI on the Responses API
// with previous_response_id continuity, the served model from Responses `model` and Gemini
// `modelVersion`, the key names OPENAI_API_KEY / XAI_API_KEY / GEMINI_API_KEY. No reasoning effort
// is sent (each model's own default applies). xAI here uses Chat Completions, as the runner's brief
// specifies, not the Responses surface the adapter uses for xAI.

export const VENDORS = {
  openai: { key_env: "OPENAI_API_KEY", endpoint: "https://api.openai.com/v1/responses", auth: "Authorization: Bearer" },
  xai: { key_env: "XAI_API_KEY", endpoint: "https://api.x.ai/v1/chat/completions", auth: "Authorization: Bearer" },
  gemini: { key_env: "GEMINI_API_KEY", endpoint: "https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent", auth: "x-goog-api-key" },
};

export function authHeaders(vendor, key) {
  if (vendor === "gemini") return { "x-goog-api-key": key };
  return { authorization: `Bearer ${key}` };
}

const parseArgs = raw => {
  if (raw && typeof raw === "object") return { args: raw };
  try { const a = JSON.parse(raw ?? "{}"); return { args: a }; }
  catch { return { args: null, args_error: "arguments are not valid JSON" }; }
};

function openaiConversation({ model, system, brief, tools, maxOutputTokens }) {
  let previous = null, pending = [{ role: "user", content: brief }];
  const toolDefs = tools.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
  return {
    request() {
      return {
        url: VENDORS.openai.endpoint,
        body: { model, instructions: system, input: pending, tools: toolDefs, max_output_tokens: maxOutputTokens,
                ...(previous ? { previous_response_id: previous } : {}) },
      };
    },
    accept(json) {
      previous = json?.id ?? null;
      const out = Array.isArray(json?.output) ? json.output : [];
      const calls = out.filter(i => i?.type === "function_call").map(i => ({ id: i.call_id, name: i.name, ...parseArgs(i.arguments) }));
      const text = out.filter(i => i?.type === "message").flatMap(i => i.content ?? [])
        .filter(c => c?.type === "output_text").map(c => c.text).join("");
      const incomplete = json?.status && json.status !== "completed" ? `${json.status}${json.incomplete_details?.reason ? `:${json.incomplete_details.reason}` : ""}` : null;
      if (calls.length && !previous) return { calls: [], text, served_model: json?.model ?? null, usage: json?.usage ?? null, incomplete: "no response id to continue from" };
      return { calls, text, served_model: json?.model ?? null, usage: json?.usage ?? null, incomplete };
    },
    addToolResults(results) {
      pending = results.map(r => ({ type: "function_call_output", call_id: r.id, output: r.output }));
    },
  };
}

function xaiConversation({ model, system, brief, tools, maxOutputTokens }) {
  const messages = [{ role: "system", content: system }, { role: "user", content: brief }];
  const toolDefs = tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return {
    request() {
      return { url: VENDORS.xai.endpoint, body: { model, messages, tools: toolDefs, max_completion_tokens: maxOutputTokens } };
    },
    accept(json) {
      const choice = json?.choices?.[0];
      const msg = choice?.message ?? {};
      const tc = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const calls = tc.map(c => ({ id: c.id, name: c.function?.name, ...parseArgs(c.function?.arguments) }));
      const text = typeof msg.content === "string" ? msg.content : "";
      if (calls.length) messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: tc });
      const fr = choice?.finish_reason ?? null;
      const incomplete = fr && !["stop", "tool_calls"].includes(fr) ? `finish_reason:${fr}` : (!choice ? "no choices in response" : null);
      return { calls, text, served_model: json?.model ?? null, usage: json?.usage ?? null, incomplete };
    },
    addToolResults(results) {
      for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
    },
  };
}

function geminiConversation({ model, system, brief, tools, maxOutputTokens }) {
  const contents = [{ role: "user", parts: [{ text: brief }] }];
  let lastCalls = [];
  const decls = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
  return {
    request() {
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        body: { systemInstruction: { parts: [{ text: system }] }, contents, tools: [{ functionDeclarations: decls }],
                generationConfig: { maxOutputTokens } },
      };
    },
    accept(json) {
      const cand = json?.candidates?.[0];
      const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
      const fcs = parts.filter(p => p?.functionCall);
      const calls = fcs.map((p, i) => ({ id: p.functionCall.id ?? `call-${contents.length}-${i}`, gemini_id: p.functionCall.id ?? null, name: p.functionCall.name, ...parseArgs(p.functionCall.args ?? {}) }));
      // The model's own parts are replayed unchanged (thought signatures included).
      if (calls.length) contents.push({ role: "model", parts });
      const text = parts.filter(p => typeof p?.text === "string" && !p.thought).map(p => p.text).join("");
      const fr = cand?.finishReason ?? null;
      const incomplete = !cand ? `no candidates${json?.promptFeedback?.blockReason ? ` (blocked: ${json.promptFeedback.blockReason})` : ""}`
        : fr && fr !== "STOP" ? `finishReason:${fr}` : null;
      lastCalls = calls;
      return { calls, text, served_model: json?.modelVersion ?? null, usage: json?.usageMetadata ?? null, incomplete };
    },
    addToolResults(results) {
      const byId = new Map(lastCalls.map(c => [c.id, c]));
      contents.push({ role: "user", parts: results.map(r => ({ functionResponse: {
        ...(byId.get(r.id)?.gemini_id ? { id: byId.get(r.id).gemini_id } : {}), name: r.name, response: { output: r.output } } })) });
    },
  };
}

export function createConversation(vendor, opts) {
  const f = { openai: openaiConversation, xai: xaiConversation, gemini: geminiConversation }[vendor];
  if (!f) throw new Error(`unknown vendor ${vendor}`);
  return f(opts);
}

// Sum every numeric leaf of the usage objects across calls (field names kept as the vendor's).
export function addUsage(total, usage) {
  if (!usage || typeof usage !== "object") return total;
  for (const [k, v] of Object.entries(usage)) {
    if (typeof v === "number") total[k] = (total[k] ?? 0) + v;
    else if (v && typeof v === "object" && !Array.isArray(v)) total[k] = addUsage(total[k] ?? {}, v);
  }
  return total;
}

const KEY_SHAPES = [/sk-[A-Za-z0-9_-]{8,}/g, /xai-[A-Za-z0-9_-]{8,}/g, /AIza[0-9A-Za-z_-]{20,}/g, /Bearer\s+[A-Za-z0-9._-]{8,}/gi];
export function redact(text, secrets = []) {
  let s = String(text ?? "");
  for (const k of secrets) if (k) s = s.split(k).join("[REDACTED]");
  for (const re of KEY_SHAPES) s = s.replace(re, "[REDACTED]");
  return s;
}
