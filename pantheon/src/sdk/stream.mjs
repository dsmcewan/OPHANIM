// Streaming: the four vendors' event vocabularies, reduced to one.
//
// This is the piece the whole live view rests on, and the reason the CLI-era eval harness was
// blind for eight minutes a trial: it used a blocking call and a single JSON blob, so there was
// nothing to show until the turn was over. Every vendor here emits incrementally; what differs
// is only the shape, and normalizing that is this file's entire job.
//
// The normalized event is deliberately tiny:
//   { seat, type: "start"|"delta"|"thinking"|"tool"|"done"|"error", text?, bytes?, name?, id?, at }
// A view can render it without knowing which vendor produced it, and nothing else is promised.
// Thinking events carry only the byte length of reasoning, never the reasoning text under any
// key: reasoning is evidence that the seat is alive, not content.
// In particular `delta.text` is a FRAGMENT, never a whole message -- a consumer that treats one
// delta as a complete reply will look correct on short answers and truncate on long ones.

import { terminalState } from "../../../packages/model-client/index.mjs";

const now = () => Date.now();
const ev = (seat, type, rest = {}) => ({ seat, type, at: now(), ...rest });

// Each vendor's stream, as an async generator of normalized events. The generators own only
// translation: no accumulation, no persistence, no policy. `streamTurn` below does the
// accumulating, so a caller that wants raw events and a caller that wants a final result share
// one code path instead of drifting apart.
const STREAMERS = {
  // OpenAI + xAI: Responses streaming emits typed server events. The text deltas are
  // `response.output_text.delta`; the terminal event carries the completed response, which is
  // where the response id we must persist lives.
  async *responses({ client, req, seat }) {
    const stream = await client.responses.create({ ...req, stream: true });
    for await (const e of stream) {
      if (typeof e?.type === "string" && /reasoning|thought|thinking/i.test(e.type)) {
        const reasoning = typeof e.delta === "string" ? e.delta : e.text;
        if (typeof reasoning === "string") {
          yield ev(seat, "thinking", { bytes: Buffer.byteLength(reasoning) });
        }
      }
      if (e?.type === "response.created") yield ev(seat, "start", { id: e.response?.id ?? null });
      else if (e?.type === "response.output_text.delta" && e.delta) yield ev(seat, "delta", { text: e.delta });
      else if (e?.type === "response.output_item.added" && e.item?.name) {
        yield ev(seat, "tool", { name: e.item.name });
      } else if (e?.type === "response.completed") {
        const terminal = terminalState("responses", { status: e.response?.status ?? "completed" });
        yield ev(seat, "done", { id: e.response?.id ?? null, final: e.response ?? null, terminal });
      } else if (e?.type === "error" || e?.type === "response.failed" || e?.type === "response.incomplete") {
        yield ev(seat, "error", { text: e.error?.message ?? e.response?.incomplete_details?.reason ?? "stream failed" });
      }
    }
  },

  // Google: generateContentStream yields chunks, each with the text so far for that chunk.
  // There is no response id at all -- this is a replay vendor, so `done` carries none and the
  // seat layer mints its own handle rather than inventing one here.
  async *genai({ client, req, seat }) {
    yield ev(seat, "start", { id: null });
    const stream = await client.models.generateContentStream(req);
    let full = "", finishReason = null, blocked = false;
    const modelParts = [];
    for await (const chunk of stream) {
      finishReason = chunk?.candidates?.[0]?.finishReason ?? finishReason;
      blocked = blocked || Boolean(chunk?.promptFeedback?.blockReason);
      for (const part of chunk?.candidates?.[0]?.content?.parts ?? []) modelParts.push(structuredClone(part));
      for (const candidate of chunk?.candidates ?? []) {
        for (const part of candidate?.content?.parts ?? []) {
          if (part?.thought === true && typeof part.text === "string") {
            yield ev(seat, "thinking", { bytes: Buffer.byteLength(part.text) });
          }
        }
      }
      const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
      const hasThought = parts.some(p => p?.thought === true);
      const t = !hasThought && typeof chunk?.text === "string"
        ? chunk.text
        : parts.filter(p => p?.thought !== true).map(p => p?.text ?? "").join("");
      if (t) { full += t; yield ev(seat, "delta", { text: t }); }
    }
    // Every model part, thought signatures included, is what a replay must carry forward.
    yield ev(seat, "done", { id: null, text: full, parts: modelParts, terminal: terminalState("genai", { finishReason, blocked }) });
  },

  // Anthropic: a typed event stream. content_block_delta carries text_delta; tool_use arrives
  // as a content_block_start whose block names the tool.
  async *messages({ client, req, seat }) {
    yield ev(seat, "start", { id: null });
    const stream = await client.messages.create({ ...req, stream: true });
    let full = "", stopReason = null;
    const blocks = [], json = new Map();
    for await (const e of stream) {
      if (e?.type === "content_block_start" && e.content_block) blocks[e.index ?? blocks.length] = structuredClone(e.content_block);
      const block = blocks[e?.index];
      if (e?.type === "content_block_delta" && block) {
        if (e.delta?.type === "text_delta") block.text = (block.text ?? "") + e.delta.text;
        else if (e.delta?.type === "thinking_delta") block.thinking = (block.thinking ?? "") + e.delta.thinking;
        else if (e.delta?.type === "signature_delta") block.signature = (block.signature ?? "") + e.delta.signature;
        else if (e.delta?.type === "input_json_delta") json.set(e.index, (json.get(e.index) ?? "") + e.delta.partial_json);
      }
      if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
        yield ev(seat, "tool", { name: e.content_block.name });
      } else if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
        full += e.delta.text; yield ev(seat, "delta", { text: e.delta.text });
      } else if (e?.type === "content_block_delta" && e.delta?.type === "thinking_delta"
        && typeof e.delta.thinking === "string") {
        yield ev(seat, "thinking", { bytes: Buffer.byteLength(e.delta.thinking) });
      } else if (e?.type === "message_delta") {
        stopReason = e.delta?.stop_reason ?? stopReason;
      } else if (e?.type === "message_stop") {
        for (const [index, value] of json) if (blocks[index]) blocks[index].input = JSON.parse(value);
        yield ev(seat, "done", { id: null, text: full, blocks: blocks.filter(Boolean), terminal: terminalState("messages", { stopReason }) });
      }
    }
  },
};

export const canStream = surface => Boolean(STREAMERS[surface]);

// Stream one turn, calling onEvent for each normalized event, and return the accumulated result
// in the SAME shape sendTurn returns -- so streaming is an observation channel, not a second
// result format the seat layer would have to special-case.
//
// onEvent is called inside the loop and its throw is NOT swallowed: a view that breaks should
// surface loudly rather than silently stop updating while the turn appears to continue.
export async function streamTurn({ client, surface, req, seat, onEvent }) {
  const gen = STREAMERS[surface];
  if (!gen) throw new Error(`streamTurn: no streamer for surface "${surface}"`);
  let text = "";
  let thinking_bytes = 0;
  const tools = [];
  let id = null;
  let sawDone = false;
  let final = null;
  let terminal = null, parts = null, blocks = null;
  for await (const e of gen({ client, req, seat })) {
    if (e.type === "delta" && e.text) text += e.text;
    if (e.type === "thinking") thinking_bytes += e.bytes;
    if (e.type === "tool" && e.name) tools.push(e.name);
    if (e.type === "start" && e.id) id = e.id;
    if (e.type === "done") {
      sawDone = true;
      if (e.id) id = e.id;
      // A vendor whose terminal event carries the whole text (genai, messages) is authoritative
      // over our accumulation; trust it when present, keep ours when not.
      if (typeof e.text === "string" && e.text.length >= text.length) text = e.text;
      if (e.terminal) terminal = e.terminal;
      if (Array.isArray(e.parts)) parts = e.parts;
      if (Array.isArray(e.blocks)) blocks = e.blocks;
      if (e.final) {
        final = e.final;                       // the completed response, with EVERY output item
        const t = collectToolNamesFromFinal(e.final);
        for (const n of t) tools.push(n);
      }
    }
    if (onEvent) onEvent(e);
  }
  // A stream that ended without a terminal event is a truncated turn. Reporting it as complete
  // would hand the seat layer a partial reply to hash as though it were the whole exchange.
  // The completed response is the vendor's own statement of what it said; the deltas are how it got
  // there. When both exist and disagree, the seat layer must hash the same text the replay history carries,
  // so the final's message text is the text of record (in-session probe, 2026-09-27).
  const finalText = (final?.output ?? []).filter(i => i?.type === "message").flatMap(i => i.content ?? [])
    .filter(c => c?.type === "output_text" && typeof c.text === "string").map(c => c.text).join("");
  if (finalText) text = finalText;
  // A terminal event is necessary, not sufficient: the provider's own terminal
  // state (status, stop reason, finish reason) must also be a success.
  const complete = sawDone && terminal?.complete !== false;
  return {
    text, tools: [...new Set(tools)].sort(), response_id: id, streamed: true, final, parts, blocks,
    thinking_bytes,
    terminal_state: terminal?.state ?? null,
    complete,
    why_incomplete: !sawDone ? "stream ended without a terminal event; the reply may be truncated"
      : complete ? null : terminal.why,
  };
}

function collectToolNamesFromFinal(final) {
  const out = [];
  for (const item of final?.output ?? []) {
    if ((item?.type === "function_call" || item?.type === "custom_tool_call") && item.name) out.push(item.name);
  }
  return out;
}
