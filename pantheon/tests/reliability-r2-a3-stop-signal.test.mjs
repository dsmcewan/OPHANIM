// Regression tests for independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 9:
// a streamed turn on a non-frontier model (sdk/adapter.mjs -> sdk/stream.mjs streamTurn) took no abort signal, so a
// stopped stage could neither cancel the in-flight request nor stop waiting for it. Each test failed on e880a07.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTurn } from "../src/sdk/adapter.mjs";
import { isFrontier } from "../../packages/model-client/index.mjs";

const HOLD_MS = 3000;
// A provider whose stream starts, then holds until the request's own signal aborts (a cancelled fetch) or HOLD_MS.
const held = signal => new Promise(res => {
  const t = setTimeout(res, HOLD_MS);
  signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
});
function holdingClient(seen) {
  return {
    responses: { create: async (req, opts) => { seen.signal = opts?.signal ?? null; return (async function* () {
      yield { type: "response.created", response: { id: "resp_1" } };
      await held(seen.signal);
      if (seen.signal?.aborted) throw seen.signal.reason;
      yield { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } };
    })(); } },
    messages: { countTokens: async () => ({ input_tokens: 10 }), create: async (req, opts) => { seen.signal = opts?.signal ?? null; return (async function* () {
      yield { type: "message_start", message: { usage: { input_tokens: 1 } } };
      await held(seen.signal);
      if (seen.signal?.aborted) throw seen.signal.reason;
      yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
      yield { type: "message_stop" };
    })(); } },
    models: { countTokens: async () => ({ totalTokens: 10 }), generateContentStream: async req => { seen.signal = req.config?.abortSignal ?? null; return (async function* () {
      await held(seen.signal);
      if (seen.signal?.aborted) throw seen.signal.reason;
      yield { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "late" }] } }] };
    })(); } },
  };
}

// A non-frontier model on each streaming surface: Responses, Messages, Google GenAI.
for (const [vendor, model] of [["xai", "grok-4.6"], ["anthropic", "claude-haiku-4-5-20251001"], ["agy_google", "gemini-3.6-flash"]]) {
  test(`finding 9: an aborted non-frontier streamed turn (${vendor}) cancels its request and rejects promptly with the abort`, async () => {
    // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 9: streamTurn had no
    // signal; the stage's stop never reached the request, and the turn ran to the provider's own end.
    assert.equal(isFrontier(model), false, `${model} takes the direct (non-frontier) path`);
    const seen = {}, ac = new AbortController();
    const stop = Object.assign(new Error("STAGE_ELAPSED: the stage was stopped"), { code: "STAGE_ELAPSED" });
    setTimeout(() => ac.abort(stop), 50);
    const t0 = Date.now();
    await assert.rejects(sendTurn({ client: holdingClient(seen), vendor, model, prompt: "hello", history: [], continuity: "replay",
      onEvent: () => {}, signal: ac.signal }), e => e === stop || e?.code === "STAGE_ELAPSED");
    const ms = Date.now() - t0;
    assert.ok(ms < HOLD_MS / 2, `the turn rejected ${ms} ms after it started, not promptly after the abort`);
    assert.equal(seen.signal?.aborted, true, "the in-flight request carried the stage's signal and was cancelled");
  });
}

test("finding 9: an already-aborted signal sends no request", async () => {
  const seen = {}, ac = new AbortController();
  ac.abort(new Error("stopped"));
  let sent = 0;
  const client = holdingClient(seen);
  const create = client.responses.create;
  client.responses.create = (...a) => { sent++; return create(...a); };
  await assert.rejects(sendTurn({ client, vendor: "xai", model: "grok-4.6", prompt: "hello", history: [], continuity: "replay", onEvent: () => {}, signal: ac.signal }), /stopped/);
  assert.equal(sent, 0);
});
