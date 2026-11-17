// Audit 2026-11-16 M4 and M7, at the adapter and seat API: what the provider is actually sent.
// Fakes only: every client below records the request and answers locally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendTurn } from "../src/sdk/adapter.mjs";
import { sdkTurn } from "../src/sdk/seat-sdk.mjs";
import { routeFor } from "../src/route/protocol.mjs";

const iter = items => ({ async *[Symbol.asyncIterator]() { for (const i of items) yield i; } });

// One fake that speaks Responses, Messages and Gemini, unary and streamed, with optional counters.
function fakeClient({ count = 10 } = {}) {
  const sent = [];
  const done = { id: "r1", status: "completed", output_text: "ok", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] };
  const gem = { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "ok" }] } }] };
  const client = {
    responses: {
      inputTokens: { count: async () => ({ input_tokens: count }) },
      create: async req => { sent.push(req); return req.stream
        ? iter([{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: done }]) : done; },
    },
    messages: {
      countTokens: async () => ({ input_tokens: count }),
      create: async req => { sent.push(req); return req.stream ? iter([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }])
        : { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }; },
    },
    models: {
      countTokens: async () => ({ totalTokens: count }),
      generateContent: async req => { sent.push(req); return gem; },
      generateContentStream: async req => { sent.push(req); return iter([gem]); },
    },
  };
  return { client, sent };
}

// The caller's cap in each vendor's own request shape (as run-item's capFor builds it).
const capFor = (vendor, tokens) => vendor === "agy_google" ? { config: { maxOutputTokens: tokens } }
  : vendor === "anthropic" ? { max_tokens: tokens } : { max_output_tokens: tokens };
const sentCap = req => req.max_tokens ?? req.max_output_tokens ?? req.config?.maxOutputTokens;

// Every eligible provider path: the frontier client (Responses, Messages, Gemini) and the direct path.
const PATHS = [
  ["frontier", "anthropic", "claude-fable-5-2"],
  ["frontier", "anthropic", "claude-opus-5-5"],
  ["frontier", "openai", "gpt-6-astra"],
  ["frontier", "openai", "gpt-6-sol"],
  ["frontier", "xai", "grok-4.7"],
  ["frontier", "agy_google", "gemini-4-carbon"],
  ["frontier", "agy_google", "gemini-4-argon"],
  ["direct", "anthropic", "claude-haiku-4-5-20251001"],
  ["direct", "xai", "grok-4.6"],
  ["direct", "agy_google", "gemini-3.6-flash"],
];

test("M4: an explicit output cap (reviewer 4,000; scout 700) is sent exactly on every provider path, unary and streamed", async () => {
  for (const [path, vendor, model] of PATHS) for (const cap of [4000, 700]) for (const streamed of [false, true]) {
    const { client, sent } = fakeClient();
    const r = await sendTurn({ client, vendor, model, prompt: "review this", extra: capFor(vendor, cap),
      ...(streamed ? { onEvent: () => {} } : {}) });
    assert.equal(sent.length, 1, `${path} ${model}`);
    assert.equal(sentCap(sent[0]), cap, `${path} ${model} ${streamed ? "streamed" : "unary"}: the cap sent is the cap named`);
    assert.equal(r.complete, true, `${path} ${model}`);
    if (path === "frontier") assert.equal(r.output_budget_policy, "explicit");
  }
});

test("M4: the seat API carries the cap and the policy; long decode applies only when it is asked for by name", async () => {
  const home = mkdtempSync(join(tmpdir(), "pantheon-m4-"));
  try {
    const base = { vendor: "agy_google", model: "gemini-4-carbon", cwd: home, home, prompt: "scout this" };
    const a = fakeClient();
    const scout = await sdkTurn({ ...base, purpose: "scout", client: a.client, extra: capFor("agy_google", 700) });
    assert.equal(scout.ok, true);
    assert.equal(a.sent[0].config.maxOutputTokens, 700, "the scout's 700 reaches the Gemini request");
    const b = fakeClient();
    const long = await sdkTurn({ ...base, purpose: "long", client: b.client, extra: capFor("agy_google", 4000), outputBudgetPolicy: "long_decode" });
    assert.equal(long.ok, true);
    assert.equal(b.sent[0].config.maxOutputTokens, 65536, "a deliberate long-decode request keeps its allowance");
    const c = fakeClient();
    await sdkTurn({ ...base, purpose: "uncapped", client: c.client });
    assert.equal(c.sent[0].config.maxOutputTokens, 65536, "no cap named: the long-decode default is the effective policy");
    await assert.rejects(sendTurn({ client: fakeClient().client, vendor: "agy_google", model: "gemini-4-carbon", prompt: "x", outputBudgetPolicy: "explicit" }),
      /explicit output token cap/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("M7: an over-window request is refused before any generation call on every provider path", async () => {
  // Every path with a supported provider count is refused on a 2M count.
  for (const [path, vendor, model] of PATHS.filter(([, v]) => v !== "xai")) for (const streamed of [false, true]) {
    const { client, sent } = fakeClient({ count: 2_000_000 });
    await assert.rejects(sendTurn({ client, vendor, model, prompt: "x", extra: capFor(vendor, 4000), ...(streamed ? { onEvent: () => {} } : {}) }),
      /window|fewer than/i, `${path} ${model}`);
    assert.equal(sent.length, 0, `${path} ${model}: no generation call`);
  }
  // xAI has no supported count here, so the qualified byte upper bound decides; it still refuses.
  for (const model of ["grok-4.7", "grok-4.6"]) for (const streamed of [false, true]) {
    const { client, sent } = fakeClient();
    await assert.rejects(sendTurn({ client, vendor: "xai", model, prompt: "x".repeat(600_000), extra: capFor("xai", 4000), ...(streamed ? { onEvent: () => {} } : {}) }),
      e => e.code === "CONTEXT_WINDOW_EXCEEDED" && e.admission.basis === "byte_upper_bound");
    assert.equal(sent.length, 0);
  }
});

test("M7: within-window requests pass, and a direct-path model with no recorded window is refused by name", async () => {
  for (const [path, vendor, model] of PATHS) {
    const { client, sent } = fakeClient({ count: 100_000 });
    const r = await sendTurn({ client, vendor, model, prompt: "x", extra: capFor(vendor, 4000) });
    assert.equal(r.complete, true, `${path} ${model}`);
    assert.equal(sent.length, 1);
  }
  const { client, sent } = fakeClient();
  await assert.rejects(sendTurn({ client, vendor: "xai", model: "grok-unrecorded-9", prompt: "x", extra: capFor("xai", 4000) }),
    e => e.code === "CONTEXT_WINDOW_UNKNOWN");
  assert.equal(sent.length, 0);
});

test("M7: routeFor does not admit an unknown-window lane for a large stated need, and records why", () => {
  const facts = { models: {
    "small-model": { vendor: "openai", api_id: true, window: { value: 1_000_000, source: "x", quote: "x" } },
    "blank-model": { vendor: "openai", api_id: true, window: "UNRECORDED" },
  } };
  const seating = { implementer: [
    { vendor: "openai", model: "small-model", band: "medium", basis: "TASTE", why: "x" },
    { vendor: "openai", model: "blank-model", band: "medium", basis: "TASTE", why: "x" },
    { vendor: "agy_google", model: "claude-sonnet-4-6", band: "medium", basis: "TASTE", why: "x" },
  ] };
  const big = routeFor("implementer", { difficulty: "medium", needsContext: 2_000_000, facts, seating });
  assert.equal(big.ok, false, "no candidate has a documented window that holds 2M");
  assert.deepEqual(big.skipped.map(s => s.model), ["small-model", "blank-model", "claude-sonnet-4-6"]);
  assert.match(big.skipped[1].why, /window unrecorded; cannot admit a stated need of 2000000/);
  assert.match(big.skipped[2].why, /window unrecorded/, "a declared lane with no cited window is not admitted either");
  const fits = routeFor("implementer", { difficulty: "medium", needsContext: 500_000, facts, seating });
  assert.equal(fits.ok, true);
  assert.equal(fits.model, "small-model");
  assert.equal(routeFor("implementer", { difficulty: "medium", facts, seating }).ok, true, "no stated need: unchanged");
});
