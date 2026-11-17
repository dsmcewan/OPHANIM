// Resource evidence through the REAL dispatcher (runOpenItem), observed against what the scripted
// providers were actually sent and actually reported. Owner audit 2026-11-16
// (docs/reviews/2026-11-16-routing-coordination, M5): every fake API result supplied 1,234 input and 56
// output tokens and no saved turn kept them; effective effort/output limits were absent; a quota fallback
// made five provider calls, saved four turns and left no structured attempt record; publication spend rows
// carried no USD and the derived budget reported $0 spent. Contract case: "A failed/retried request
// contributes to attempt counts and resource evidence; missing usage/cost is unknown rather than zero."
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runOpenItem } from "../src/board/run-item.mjs";
import { openBoard } from "../src/board/index.mjs";
import { publish } from "../src/board/dag.mjs";
import { sendTurn } from "../src/sdk/adapter.mjs";
import { withDispatch, WORK, USAGE } from "./fixtures/dispatch.mjs";
import { openRuntime } from "../src/board/runtime.mjs";
import { withBoard, seeded, HUMAN, TICKET } from "./board-helper.mjs";

const runJson = result => JSON.parse(readFileSync(join(result.board, "run.json"), "utf8"));
const quota = () => Object.assign(new Error("You exceeded your current quota"), { status: 429, code: "insufficient_quota" });
// Fail the first implementer request only.
const failFirstWork = make => { let done = false; return c => !done && WORK.test(c.prompt) ? (done = true, make()) : null; };

test("M5: every successful API turn keeps the usage its provider reported and the settings actually sent", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    const r = await runOpenItem(spec("usageKept"), opts());
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const run = runJson(r);
    const api = run.turns.filter(t => t.transport === "api");
    assert.equal(api.length, 4, "scout, plan, work, critique");
    assert.equal(api.length, calls.length, "one provider request per turn in a run with no failures");
    for (const [i, t] of api.entries()) {
      assert.equal(t.usage?.input_tokens, USAGE.input_tokens, `${t.purpose}: the provider's input count is kept`);
      assert.equal(t.usage?.output_tokens, USAGE.output_tokens, `${t.purpose}: the provider's output count is kept`);
      assert.ok(t.usage.reported && typeof t.usage.reported === "object", `${t.purpose}: the provider's own usage object is kept verbatim`);
      // The settings recorded are the ones the provider was sent, request by request.
      const sent = calls[i];
      assert.equal(t.settings?.model, sent.model, `${t.purpose}: model`);
      assert.equal(t.settings.pool, sent.pool, `${t.purpose}: pool`);
      assert.equal(t.settings.transport, "api");
      assert.equal(t.settings.max_output_tokens, sent.max_output_tokens, `${t.purpose}: the output cap actually sent`);
      assert.equal(t.settings.effort, sent.effort, `${t.purpose}: the effort actually sent`);
      assert.equal(t.attempts, 1);
    }
    const critique = api.find(t => t.purpose === "critique");
    assert.equal(critique.settings.max_output_tokens, 4000, "the reviewer's explicit cap is what was recorded and sent");
    assert.equal(critique.settings.output_budget_policy, "explicit");
    // The run's resource summary: provider calls, reported tokens, and cost left unknown.
    assert.equal(run.resources.provider_calls, 4);
    assert.equal(run.resources.reported_input_tokens, 4 * USAGE.input_tokens);
    assert.equal(run.resources.reported_output_tokens, 4 * USAGE.output_tokens);
    assert.equal(run.resources.attempts_without_usage, 0);
    assert.equal(run.resources.usd, null, "no versioned price source is attached, so cost is not estimated");
    assert.match(run.resources.usd_basis, /unknown/);
  });
});

test("M5: a quota fallback retains the refused attempt as structured evidence; provider calls are counted, not turns", async () => {
  await withDispatch(async ({ spec, opts, calls, fault }) => {
    fault(failFirstWork(() => ({ error: quota() })));
    const r = await runOpenItem(spec("quotaFallback"), opts());
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const run = runJson(r);
    assert.equal(calls.length, 5, "five provider invocations");
    assert.equal(run.turns.length, 4, "four successful turns");
    assert.equal(run.attempts.length, 5, "every provider invocation is an attempt record, the refused one included");
    assert.deepEqual(run.attempts.map(a => `${a.vendor}/${a.model}@${a.pool}`), calls.map(c => `${c.vendor}/${c.model}@${c.pool}`),
      "attempts in the order the providers saw them");
    const refused = run.attempts.filter(a => a.outcome !== "ok");
    assert.equal(refused.length, 1);
    const [a] = refused;
    assert.equal(a.purpose, "work");
    assert.equal(a.outcome, "quota");
    assert.equal(a.status, 429);
    assert.equal(a.usage, null, "the provider reported no usage for a refused request: unknown, not zero");
    assert.match(a.why, /quota/);
    assert.equal(a.settings.transport, "api");
    // The fallback turn names the attempts its routing took.
    const work = run.turns.find(t => t.purpose === "work");
    assert.notEqual(work.model, a.model, "the work turn is the fallback seat");
    assert.equal(run.resources.provider_calls, 5);
    assert.equal(run.resources.attempts_without_usage, 1);
    assert.deepEqual(run.resources.by_outcome, { ok: 4, quota: 1 });
    assert.equal(run.resources.reported_input_tokens, 4 * USAGE.input_tokens, "only what was reported is summed");
    assert.equal(run.resources.usage_complete, false, "a total missing one attempt's usage says so");
  });
});

test("M5: a truncated attempt is retained with its usage, and the re-ask is a second provider call", async () => {
  await withDispatch(async ({ spec, opts, calls, fault }) => {
    fault(failFirstWork(() => ({ incomplete: true })));
    const r = await runOpenItem(spec("truncatedKept"), opts());
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const run = runJson(r);
    const work = run.attempts.filter(a => a.purpose === "work");
    assert.deepEqual(work.map(a => a.outcome), ["incomplete", "ok"]);
    assert.equal(work[0].usage?.input_tokens, USAGE.input_tokens, "the truncated attempt's usage is evidence too");
    assert.ok(work[1].settings.max_output_tokens > work[0].settings.max_output_tokens, "the re-ask carried the raised output cap");
    const sentWork = calls.filter(c => WORK.test(c.prompt)).map(c => c.max_output_tokens);
    assert.deepEqual(work.map(a => a.settings.max_output_tokens), sentWork, "each attempt records the cap that request carried");
    assert.equal(run.turns.find(t => t.purpose === "work").attempts, 2);
    assert.equal(run.resources.provider_calls, calls.length);
  });
});

test("M5: a per-run provider-call bound is enforced before each provider call, counting fallbacks, with a named refusal", async () => {
  await withDispatch(async ({ spec, opts, calls, fault }) => {
    fault(failFirstWork(() => ({ error: quota() })));
    // scout, plan and the refused work request use the three calls; the fallback would be a fourth.
    const r = await runOpenItem(spec("callBound"), opts({ maxProviderCalls: 3 }));
    assert.equal(r.shipped, false);
    assert.equal(calls.length, 3, "no provider request beyond the bound");
    assert.match(r.error?.message ?? "", /PROVIDER_CALL_LIMIT/);
    const run = runJson(r);
    assert.equal(run.provider_calls.limit, 3);
    assert.equal(run.provider_calls.made, 3);
    assert.equal(run.provider_calls.refused?.code, "PROVIDER_CALL_LIMIT");
    assert.equal(run.provider_calls.refused.purpose, "work");
    assert.equal(run.attempts.length, 3, "the refused-before-calling request is not an attempt: nothing was sent");
  });
  await withDispatch(async ({ spec, opts }) => {
    for (const bad of [0, -1, 1.5, "3"]) {
      await assert.rejects(runOpenItem(spec(`badBound${String(bad)}`), opts({ maxProviderCalls: bad })), /maxProviderCalls/);
    }
  });
});

test("M5: the board's derived budget reports unknown USD, never $0, after a real run's publications", async () => {
  await withDispatch(async ({ spec, opts }) => {
    const r = await runOpenItem(spec("usdUnknown"), opts());
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const board = openBoard(r.board);
    const rows = readFileSync(join(r.board, "runtime", "spend.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
    const pubs = rows.filter(x => x.publications === 1);
    assert.ok(pubs.length >= 1, "publication rows are counted as publications");
    for (const row of pubs) {
      assert.equal(row.usd, null, "a publication row states its cost is unknown");
      assert.equal(row.turns, undefined, "a publication is not recorded as a provider turn");
    }
    board.runtime.setBudget({ max_turns: 1000, max_usd: 0.01 });
    const b = board.runtime.budget();
    assert.equal(b.spent_usd, null, "unmeasured cost is unknown, not $0");
    assert.equal(b.usd_status, "unknown");
    assert.equal(b.spent_publications, b.spent_turns);
    assert.equal(b.spend_basis, "publication_commits");
    assert.equal(b.exhausted, false, "an unknown cost does not invent an exhausted budget either");
  });
});

test("M5: USD is summed only when every counted row states it; one unstated row keeps the total unknown", () => withBoard(async (_, root) => {
  const runtime = openRuntime(join(root, "usd-only"));
  runtime.setBudget({ max_turns: 100, max_usd: 0.01 });
  runtime.recordSpend({ commit: "commit:" + "1".repeat(64), seat: "x", vendor: "openai", publications: 1, usd: 0.004, price_source: "fixture-prices/v1" });
  runtime.recordSpend({ commit: "commit:" + "2".repeat(64), seat: "x", vendor: "openai", publications: 1, usd: 0.007, price_source: "fixture-prices/v1" });
  const stated = runtime.budget();
  assert.ok(Math.abs(stated.spent_usd - 0.011) < 1e-12, "stated costs are summed");
  assert.equal(stated.usd_status, "known");
  assert.equal(stated.exhausted, true, "a known cost over the declared USD limit exhausts the budget");
  runtime.recordSpend({ commit: "commit:" + "3".repeat(64), seat: "x", vendor: "openai", publications: 1 });
  const partial = runtime.budget();
  assert.equal(partial.spent_usd, null, "one row with no stated cost makes the total unknown");
  assert.equal(partial.usd_status, "unknown");
  assert.equal(partial.usd_unknown_rows, 1);
  assert.ok(Math.abs(partial.stated_usd - 0.011) < 1e-12, "what was stated is still reported, labelled as a partial figure");
  assert.equal(partial.exhausted, true, "the stated part alone already exceeds the limit");
}));

test("M5: a publish under a declared USD limit with no stated cost is not refused as if it were $0 -- or as if it were exhausted", () => withBoard(async board => {
  await seeded(board);
  board.runtime.setBudget({ max_turns: 100, max_usd: 0.01 });
  const b = board.runtime.budget();
  assert.equal(b.spent_usd, null);
  assert.equal(b.exhausted, false);
  assert.match(b.usd_note, /unknown/);
  const p = await publish({ ...board, ref: "refs/board/another", author: HUMAN, msg: "ticket", entries: [{ kind: "ticket", payload: TICKET }] });
  assert.equal(p.ok, true, p.why);
}));

test("M5: the direct streamed adapter returns the usage its provider's final event carried", async () => {
  // xAI grok-4.6 is served by the direct path (not the frontier client); its Responses final carries usage.
  const responses = { responses: { inputTokens: { count: async () => ({ input_tokens: 10 }) }, create: async () => (async function* () {
    yield { type: "response.created", response: { id: "r1" } };
    yield { type: "response.output_text.delta", delta: "hi" };
    yield { type: "response.completed", response: { id: "r1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }], usage: { ...USAGE } } };
  })() } };
  for (const continuity of [undefined, "replay"]) {
    const r = await sendTurn({ client: responses, vendor: "xai", model: "grok-4.6", prompt: "q", history: [], ...(continuity ? { continuity } : {}), onEvent: () => {} });
    assert.equal(r.complete, true);
    assert.deepEqual(r.usage, USAGE, `streamed (${continuity ?? "server"}) keeps the final's usage`);
  }
  // Google gemini-3.6-flash: direct, streamed and unary; usageMetadata rides on the chunks.
  const meta = { promptTokenCount: 1234, candidatesTokenCount: 56 };
  const google = { models: { countTokens: async () => ({ totalTokens: 10 }),
    generateContentStream: async () => (async function* () { yield { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hi" }] } }], usageMetadata: meta }; })(),
    generateContent: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hi" }] } }], usageMetadata: meta }) } };
  const streamed = await sendTurn({ client: google, vendor: "agy_google", model: "gemini-3.6-flash", prompt: "q", history: [], onEvent: () => {} });
  assert.deepEqual(streamed.usage, meta);
  const unary = await sendTurn({ client: google, vendor: "agy_google", model: "gemini-3.6-flash", prompt: "q", history: [] });
  assert.deepEqual(unary.usage, meta);
});
