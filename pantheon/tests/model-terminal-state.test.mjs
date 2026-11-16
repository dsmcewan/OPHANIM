// Every model in the registry is judged by the same rule: a turn is usable only when the
// provider's own terminal state is a success. This walks all registered models through both
// transports (the frontier client and the direct adapter path), unary and streaming.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sendTurn, ADAPTERS } from "../src/sdk/adapter.mjs";
import { sdkTurn } from "../src/sdk/seat-sdk.mjs";
import { models, isFrontier } from "../../packages/model-client/index.mjs";

const adapterVendor = v => (v === "google" ? "agy_google" : v);
const ALL = Object.entries(models).flatMap(([vendor, names]) =>
  Object.entries(names).map(([name, model]) => ({ vendor: adapterVendor(vendor), name, model })));

async function* iter(items) { for (const item of items) yield item; }

// One fake per surface. `ok` selects the provider's successful terminal state; otherwise the
// provider reports a truncation (incomplete / max_tokens / MAX_TOKENS).
function fakeClient(surface, ok) {
  const output = [{ type: "message", content: [{ type: "output_text", text: "answer" }] }];
  if (surface === "responses") return {
    responses: {
      inputTokens: { count: async () => ({ input_tokens: 10 }) },
      create: async req => req.stream
        ? iter([{ type: "response.output_text.delta", delta: "answer" },
            ok ? { type: "response.completed", response: { id: "r1", status: "completed", output } }
               : { type: "response.incomplete", response: { id: "r1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output } }])
        : { id: "r1", status: ok ? "completed" : "incomplete", output_text: "answer", output },
    },
  };
  if (surface === "messages") {
    const stop = ok ? "end_turn" : "max_tokens";
    return { messages: { create: async req => req.stream
      ? iter([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
          { type: "message_delta", delta: { stop_reason: stop } }, { type: "message_stop" }])
      : { stop_reason: stop, content: [{ type: "text", text: "answer" }] } } };
  }
  const finishReason = ok ? "STOP" : "MAX_TOKENS";
  const parts = [{ text: "answer", thoughtSignature: "SIG" }];
  return { models: {
    countTokens: async () => ({ totalTokens: 10 }),
    generateContent: async () => ({ candidates: [{ finishReason, content: { role: "model", parts } }] }),
    generateContentStream: async () => iter([{ candidates: [{ finishReason, content: { role: "model", parts } }] }]),
  } };
}

test("the registry walk covers every model and routes each one deliberately", () => {
  assert.equal(ALL.length, 18);
  for (const { vendor, model } of ALL) assert.ok(ADAPTERS[vendor], `${model} has an adapter`);
  const frontier = ALL.filter(m => isFrontier(m.model)).map(m => m.model).sort();
  assert.deepEqual(frontier, ["claude-fable-5-2", "gemini-4-argon", "gemini-4-carbon", "gpt-6-astra", "grok-4.3", "grok-4.7"]);
});

for (const { vendor, name, model } of ALL) {
  const surface = ADAPTERS[vendor].surface;
  const path = isFrontier(model) ? "frontier client" : "direct adapter";
  for (const streamed of [false, true]) {
    const mode = streamed ? "streamed" : "unary";
    test(`${vendor}/${name} (${path}, ${mode}): success accepted, truncation refused`, async () => {
      const onEvent = streamed ? () => {} : undefined;
      const good = await sendTurn({ client: fakeClient(surface, true), vendor, model, prompt: "q", history: [], onEvent });
      assert.equal(good.usable_for_resume, true, `${model} ${mode} success: ${good.why_unusable}`);
      const bad = await sendTurn({ client: fakeClient(surface, false), vendor, model, prompt: "q", history: [], onEvent });
      assert.equal(bad.usable_for_resume, false, `${model} ${mode} truncation must be refused`);
      assert.ok(bad.why_unusable, "a refusal names its reason");
    });
  }
}

test("direct Gemini replay keeps the model's parts, thought signatures included", async () => {
  for (const onEvent of [undefined, () => {}]) {
    const r = await sendTurn({ client: fakeClient("genai", true), vendor: "agy_google", model: "gemini-3.5-flash", prompt: "q", history: [], onEvent });
    assert.equal(r.history.at(-1).role, "model");
    assert.deepEqual(r.history.at(-1).parts, [{ text: "answer", thoughtSignature: "SIG" }]);
    assert.equal(r.terminal_state, "STOP");
  }
});

test("direct Anthropic streaming replay keeps the content blocks, not just text", async () => {
  const r = await sendTurn({ client: fakeClient("messages", true), vendor: "anthropic", model: "claude-sonnet-5", prompt: "q", history: [], onEvent: () => {} });
  assert.deepEqual(r.history.at(-1), { role: "assistant", content: [{ type: "text", text: "answer" }] });
  assert.equal(r.terminal_state, "end_turn");
});

test("a seat whose stored chain no longer matches its exchanges is not continued", async () => {
  const home = mkdtempSync(join(tmpdir(), "pantheon-chain-"));
  try {
    const client = { responses: { create: async () => ({ id: "r1", status: "completed", output_text: "a",
      output: [{ type: "message", content: [{ type: "output_text", text: "a" }] }] }) } };
    const seat = { vendor: "openai", purpose: "p", cwd: "/repo/a", client, home };
    assert.equal((await sdkTurn({ ...seat, prompt: "one" })).ok, true);
    const file = join(home, "seats", readdirSync(join(home, "seats"))[0]);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored.exchanges[0].sha = "0".repeat(64);
    writeFileSync(file, JSON.stringify(stored));
    const refused = await sdkTurn({ ...seat, prompt: "two" });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "CHAIN_MISMATCH");
    assert.equal(refused.persisted, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
