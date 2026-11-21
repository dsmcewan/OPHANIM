// Regression tests for independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 9:
// a streamed turn on a non-frontier model (sdk/adapter.mjs -> sdk/stream.mjs streamTurn) took no abort signal, so a
// stopped stage could neither cancel the in-flight request nor stop waiting for it. Each test failed on e880a07.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTurn } from "../src/sdk/adapter.mjs";
import { isFrontier } from "../../packages/model-client/index.mjs";
import { runOpenItem } from "../src/board/run-item.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ---- the direct path's unary (non-streamed) requests: failed on 5f26e17

// A provider whose unary answer is held until the request's own signal aborts or HOLD_MS.
function holdingUnaryClient(seen) {
  const hold = async signal => { seen.sent = (seen.sent ?? 0) + 1; seen.signal = signal ?? null; await held(seen.signal); if (seen.signal?.aborted) throw seen.signal.reason; };
  return {
    responses: { create: async (req, opts) => { await hold(opts?.signal); return { id: "resp_1", status: "completed", output_text: "late", output: [] }; } },
    messages: { countTokens: async () => ({ input_tokens: 10 }), create: async (req, opts) => { await hold(opts?.signal); return { content: [{ type: "text", text: "late" }], stop_reason: "end_turn" }; } },
    models: { countTokens: async () => ({ totalTokens: 10 }), generateContent: async req => { await hold(req.config?.abortSignal); return { text: "late", candidates: [{ finishReason: "STOP", content: { parts: [{ text: "late" }] } }] }; } },
  };
}
// Responses replay, Responses with server-side continuity, Messages replay, Google GenAI replay.
for (const [vendor, model, continuity] of [["xai", "grok-4.6", "replay"], ["xai", "grok-4.6", "server"], ["anthropic", "claude-haiku-4-5-20251001", "replay"], ["agy_google", "gemini-3.6-flash", "replay"]]) {
  test(`finding 9: an aborted non-frontier unary turn (${vendor}, ${continuity}) cancels its request and rejects promptly with the abort`, async () => {
    // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 9: the direct path's
    // non-streamed requests were sent without the signal and awaited to the provider's own end.
    assert.equal(isFrontier(model), false);
    const seen = {}, ac = new AbortController();
    const stop = Object.assign(new Error("STAGE_ELAPSED: the stage was stopped"), { code: "STAGE_ELAPSED" });
    setTimeout(() => ac.abort(stop), 50);
    const t0 = Date.now();
    await assert.rejects(sendTurn({ client: holdingUnaryClient(seen), vendor, model, prompt: "hello", history: [], continuity, signal: ac.signal }),
      e => e === stop || e?.code === "STAGE_ELAPSED");
    const ms = Date.now() - t0;
    assert.ok(ms < HOLD_MS / 2, `the turn rejected ${ms} ms after it started, not promptly after the abort`);
    assert.equal(seen.signal?.aborted, true, "the in-flight request carried the stage's signal and was cancelled");
  });
  test(`finding 9: an already-aborted signal sends no unary request (${vendor}, ${continuity})`, async () => {
    const seen = {}, ac = new AbortController();
    ac.abort(new Error("stopped"));
    await assert.rejects(sendTurn({ client: holdingUnaryClient(seen), vendor, model, prompt: "hello", history: [], continuity, signal: ac.signal }), /stopped/);
    assert.equal(seen.sent ?? 0, 0);
  });
}

// ---- runOpenItem's own admission refusal

test("finding 9: once runOpenItem's signal has fired, a call outside routeCall (the verdict re-ask) is refused at admission and not charged", async () => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 9: runOpenItem kept
  // admitting (and charging) provider calls after its caller's stop. The verdict re-ask is a turn made directly, not
  // through routeSeats/routeCall, so only runOpenItem's own admission can refuse it.
  const repo = mkdtempSync(join(tmpdir(), "pantheon-r2a3-f9-"));
  const before = { cooldown: process.env.PANTHEON_COOLDOWN_DIR, cli: process.env.PANTHEON_AGY_CLI, ledger: process.env.OPHANIM_LEDGER };
  process.env.PANTHEON_COOLDOWN_DIR = join(repo, "cooldowns");
  process.env.PANTHEON_AGY_CLI = "/nonexistent/offline-fixture";
  delete process.env.OPHANIM_LEDGER;
  try {
    const REASK = /previous reply ended without the required verdict/;
    const sent = [];
    const promptOf = req => (typeof req.input === "string" ? req.input : req.input?.at(-1)?.content ?? req.messages?.at(-1)?.content ?? "");
    const answer = prompt => /Attack this change/.test(prompt) || REASK.test(prompt) ? "the file looks fine"
      : /VERDICT/i.test(prompt) ? "VERDICT: approve" : /TITLE:/i.test(prompt) ? "TITLE: fixture change" : /RAN: nothing/i.test(prompt) ? "RAN: nothing" : "export const ok = true;\n";
    let n = 0;
    const makeClientFor = () => ({
      responses: { inputTokens: { count: async () => ({ input_tokens: 1000 }) }, create: async req => {
        const prompt = promptOf(req); sent.push(prompt);
        const text = answer(prompt), id = `f9_${++n}`;
        return { async *[Symbol.asyncIterator]() {
          yield { type: "response.created", response: { id, model: req.model } };
          yield { type: "response.output_text.delta", delta: text };
          yield { type: "response.completed", response: { id, status: "completed", output_text: text, output: [{ type: "message", content: [{ type: "output_text", text }] }] } };
        } };
      } },
      messages: { create: async req => {
        const prompt = promptOf(req); sent.push(prompt);
        const text = answer(prompt);
        return { async *[Symbol.asyncIterator]() {
          yield { type: "message_start", message: { model: req.model } };
          yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
          yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
          yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
          yield { type: "message_stop" };
        } };
      } },
    });
    const seat = (vendor, model) => ({ vendor, model, pool: vendor, rank: 0, basis: "OPERATOR", why: "offline fixture" });
    writeFileSync(join(repo, "ok.mjs"), "export const ok = false;\n");
    writeFileSync(join(repo, "verify.mjs"), 'import assert from "node:assert/strict"; import {ok} from "./ok.mjs"; assert.equal(ok, true);');
    const spec = { key: "f9Key", repo_root: repo, title: "one file", goal: "it passes", question: "fixture", copy: ["ok.mjs", "verify.mjs"], acceptance_cmd: "node verify.mjs", slot: "ok", path: "ok.mjs" };
    const ac = new AbortController();
    let charged = 0, chargedAfter = 0, refused = null;
    // The caller stops the run the moment the reviewer's reply is found to carry no verdict, just before the re-ask.
    const progress = ev => {
      if (ev.event === "reask" && !ac.signal.aborted) ac.abort(Object.assign(new Error("STAGE_ELAPSED: the caller stopped the run"), { code: "STAGE_ELAPSED" }));
      if (ev.event === "turn.refused") refused = ev.detail;
    };
    const onCharge = () => { charged++; if (ac.signal.aborted) chargedAfter++; };
    await runOpenItem(spec, { dir: join(repo, "board"), makeClientFor, scouts: ["xai"], revisions: 1, independence: "model", escalation: "pantheon.escalation/v2",
      seatOverrides: { planner: seat("anthropic", "claude-fable-5-2"), implementer: seat("openai", "gpt-6-astra"), reviewer: seat("xai", "grok-4.6") },
      signal: ac.signal, onCharge, progress }).catch(() => null);
    assert.equal(ac.signal.aborted, true, "the re-ask was reached");
    assert.ok(charged > 0);
    assert.equal(chargedAfter, 0, "no call is admitted or charged after the stop");
    assert.match(refused ?? "", /^ABORTED: STAGE_ELAPSED/);
    assert.equal(sent.filter(p => REASK.test(p)).length, 0, "the re-ask was not sent");
  } finally {
    for (const [k, v] of [["PANTHEON_COOLDOWN_DIR", before.cooldown], ["PANTHEON_AGY_CLI", before.cli], ["OPHANIM_LEDGER", before.ledger]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(repo, { recursive: true, force: true });
  }
});
