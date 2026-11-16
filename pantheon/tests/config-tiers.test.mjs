// Provisional output-token tiers: by difficulty, capped at the documented ceiling, evidence-driven.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOKEN_TIERS, outputBudgetFor, defaultOutputFor, truncationEvidence, FRONTIER_DEFAULT_OUTPUT } from "../src/config/tiers.mjs";
import { sendTurn } from "../src/sdk/adapter.mjs";
import { escalationRecord } from "../src/route/protocol.mjs";

test("tiers rise with difficulty and never exceed a documented ceiling", () => {
  assert.ok(TOKEN_TIERS.easy < TOKEN_TIERS.medium && TOKEN_TIERS.medium < TOKEN_TIERS.hard);
  assert.deepEqual(outputBudgetFor("claude-sonnet-5", "hard"), { tokens: 32768, tier: "hard", ceiling: 128000, capped: false, status: outputBudgetFor("claude-sonnet-5").status });
  assert.equal(outputBudgetFor("claude-haiku-4-5-20251001", "hard").tokens, 32768, "64K ceiling, not reached");
  assert.equal(outputBudgetFor("gemini-3.6-flash", "hard").tokens, 32768);
  assert.throws(() => outputBudgetFor("claude-sonnet-5", "extreme"), /unknown token tier/);
  for (const inherited of ["toString", "constructor", "__proto__"])
    assert.throws(() => outputBudgetFor("claude-sonnet-5", inherited), /unknown token tier/, `${inherited} is not a tier`);
});

test("only paths that impose a default get one; the frontier client keeps its own", () => {
  assert.equal(defaultOutputFor("anthropic", "claude-opus-5-5", "easy"), 4096);
  assert.equal(defaultOutputFor("anthropic", "claude-fable-5-2"), FRONTIER_DEFAULT_OUTPUT);
  assert.equal(defaultOutputFor("openai", "gpt-6-sol"), null, "the provider's default applies");
});

test("the direct Messages path no longer defaults to 1,024 tokens", async () => {
  let sent;
  const client = { messages: { create: async req => { sent = req; return { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }; } } };
  await sendTurn({ client, vendor: "anthropic", model: "claude-sonnet-5", prompt: "q", history: [] });
  assert.equal(sent.max_tokens, 16384, "the medium tier");
  await sendTurn({ client, vendor: "anthropic", model: "claude-sonnet-5", prompt: "q", history: [], extra: { max_tokens: 500 } });
  assert.equal(sent.max_tokens, 500, "an explicit budget still wins");
});

test("recorded truncations summarize into evidence per model and tier", () => {
  const cut = output => ({ tier: "medium", ...escalationRecord({ role: "planner", steps: 0, outcome: { kind: "turn", complete: false, terminal_state: "max_tokens" },
    seat: { vendor: "anthropic", model: "claude-sonnet-5", effort: null, output } }) });
  const evidence = truncationEvidence([cut(16384), cut(128000), { decision: { cause: "ok" } }]);
  assert.deepEqual(evidence, [{ model: "claude-sonnet-5", tier: "medium", truncations: 2, raisedTo: [32768], stopped: 1 }]);
});
