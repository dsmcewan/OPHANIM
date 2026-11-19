// Independent review round 2, assignment 2 (xAI grok-4.7, 77480d6): regression tests for questions 3, 5, 6 and 9 at
// the Pantheon boundary. Scripted answers and synthetic names only; no provider is called.
//   Q3  the board in-run review's re-ask is admitted on its OWN serving model, and the review cites the turn whose
//       reply supplied the verdict;
//   Q5  a raw recorder cannot open a NEW cycle below the three-lab floor; cycles recorded without the field verify;
//   Q6  a board critique contributor row keeps the serving model beside the asked one; an answered subagent call that
//       names no serving model is recorded as unnamed;
//   Q9  the board Antigravity guard refuses an undeclared name before any lane is started; a pipeline single-turn seat
//       labels a served name "provider" only when the transport said so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenItem } from "../src/board/run-item.mjs";
import { openPantheonLedger } from "../src/ledger/system.mjs";
import { CYCLE_CONTRACT_V1, cycleRecorder } from "../src/ledger/cycle-kinds.mjs";
import { contributorKeys, reviewerRefusal } from "../src/review/identity.mjs";
import { reviewScope } from "../src/review/scope.mjs";
import { pipelineTurns } from "../src/pipeline/turns.mjs";
import { startA2AShim } from "../src/pipeline/a2a-shim.mjs";
import { contributionsOf } from "../src/pipeline/record.mjs";

const REASK = /previous reply ended without the required verdict/;

/**
 * A scripted board: the planner, the implementer and the reviewer answer through makeClientFor, and every response
 * names the model that "served" it (`served(vendor, model, prompt)`), the way the adapter reads it off a response.
 */
async function withBoard(fn, { review, served = (_v, m) => m }) {
  const repo = mkdtempSync(join(tmpdir(), "pantheon-r2a2-"));
  const before = { cooldown: process.env.PANTHEON_COOLDOWN_DIR, cli: process.env.PANTHEON_AGY_CLI, ledger: process.env.OPHANIM_LEDGER };
  process.env.PANTHEON_COOLDOWN_DIR = join(repo, "cooldowns");
  process.env.PANTHEON_AGY_CLI = "/nonexistent/offline-fixture";
  delete process.env.OPHANIM_LEDGER;
  let n = 0, reviews = 0;
  const answer = (vendor, req) => {
    const prompt = typeof req.input === "string" ? req.input : req.input?.at(-1)?.content ?? req.messages?.at(-1)?.content ?? "";
    if (REASK.test(prompt) || /Attack this change/.test(prompt)) return review(prompt, REASK.test(prompt) ? reviews : ++reviews);
    if (/VERDICT/i.test(prompt)) return "VERDICT: approve";
    if (/TITLE:/i.test(prompt)) return "TITLE: fixture change";
    if (/RAN: nothing/i.test(prompt)) return "RAN: nothing";
    return "export const ok = true;\n";
  };
  const promptOf = req => (typeof req.input === "string" ? req.input : req.input?.at(-1)?.content ?? req.messages?.at(-1)?.content ?? "");
  const makeClientFor = vendor => ({
    responses: { inputTokens: { count: async () => ({ input_tokens: 1000 }) }, create: async req => {
      const text = answer(vendor, req), id = `r2a2_${++n}`, model = served(vendor, req.model, promptOf(req));
      return { async *[Symbol.asyncIterator]() {
        yield { type: "response.created", response: { id, ...(model ? { model } : {}) } };
        yield { type: "response.output_text.delta", delta: text };
        yield { type: "response.completed", response: { id, status: "completed", output_text: text, output: [{ type: "message", content: [{ type: "output_text", text }] }] } };
      } };
    } },
    messages: { create: async req => {
      const text = answer(vendor, req), model = served(vendor, req.model, promptOf(req));
      return { async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { ...(model ? { model } : {}) } };
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
        yield { type: "message_stop" };
      } };
    } },
  });
  const seat = (vendor, model, extra = {}) => ({ vendor, model, pool: vendor, rank: 0, basis: "OPERATOR", why: "offline fixture", ...extra });
  writeFileSync(join(repo, "ok.mjs"), "export const ok = false;\n");
  writeFileSync(join(repo, "verify.mjs"), 'import assert from "node:assert/strict"; import {ok} from "./ok.mjs"; assert.equal(ok, true);');
  const spec = { key: "r2a2Key", repo_root: repo, title: "one file", goal: "it passes", question: "fixture", copy: ["ok.mjs", "verify.mjs"], acceptance_cmd: "node verify.mjs", slot: "ok", path: "ok.mjs" };
  const sys = openPantheonLedger({ root: join(repo, "ledger") });
  const opts = { dir: join(repo, "board"), makeClientFor, scouts: ["xai"], revisions: 2, independence: "model", escalation: "pantheon.escalation/v2", ledger: sys.recorder(),
    seatOverrides: { planner: seat("anthropic", "claude-fable-5-2"), implementer: seat("openai", "gpt-6-astra"), reviewer: seat("xai", "grok-4.6") } };
  try { return await fn({ repo, spec, opts, sys, seat }); }
  finally {
    for (const [k, v] of [["PANTHEON_COOLDOWN_DIR", before.cooldown], ["PANTHEON_AGY_CLI", before.cli], ["OPHANIM_LEDGER", before.ledger]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(repo, { recursive: true, force: true });
  }
}
const runJson = result => JSON.parse(readFileSync(join(result.board, "run.json"), "utf8"));
const reviewsOn = sys => sys.ledger.read().filter(e => e.kind === "review").map(e => sys.ledger.payloadOf(e));
const turnsOn = sys => sys.ledger.read().filter(e => e.kind === "turn").map(e => sys.ledger.payloadOf(e));

// Question 3. The re-ask's answer supplied `VERDICT: approve` and was served by a CONTRIBUTOR (the implementer's
// model). Before the fix it was never admitted: the slot approved and shipped, the review citing the first turn.
test("Q3 (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 3): a re-ask served by a contributor is not admitted; the slot fails closed", async () => {
  await withBoard(async ({ spec, opts, sys }) => {
    const r = await runOpenItem(spec, { ...opts, revisions: 1 });
    assert.equal(r.shipped, false, "an unadmitted re-ask cannot approve the slot");
    const run = runJson(r);
    const rejected = (run.review_rejections ?? []).filter(x => x.reask);
    assert.ok(rejected.length >= 1, JSON.stringify(run.review_rejections));
    assert.equal(rejected[0].served_model, "gpt-6-astra");
    assert.match(rejected[0].why, /gpt-6-astra/);
    assert.equal(reviewsOn(sys).some(p => p.verdict === "approve"), false, "no approval is recorded from the re-ask");
    assert.equal(sys.ledger.verify().ok, true);
  }, { review: prompt => (REASK.test(prompt) ? "VERDICT: approve" : "the file looks fine"), served: (v, m, prompt) => (REASK.test(prompt) ? "gpt-6-astra" : m) });
});

test("Q3 (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 3): a re-ask that names no serving model is not admitted", async () => {
  await withBoard(async ({ spec, opts, sys }) => {
    const r = await runOpenItem(spec, { ...opts, revisions: 1 });
    assert.equal(r.shipped, false);
    const rejected = (runJson(r).review_rejections ?? []).filter(x => x.reask);
    assert.ok(rejected.length >= 1);
    assert.equal(rejected[0].served_model, null);
    assert.match(rejected[0].why, /names no serving model/);
    assert.equal(reviewsOn(sys).some(p => p.verdict === "approve"), false);
  }, { review: prompt => (REASK.test(prompt) ? "VERDICT: approve" : "the file looks fine"), served: (v, m, prompt) => (REASK.test(prompt) ? null : m) });
});

test("Q3 (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 3): an admitted re-ask is recorded citing the re-ask turn and its serving model", async () => {
  await withBoard(async ({ spec, opts, sys }) => {
    const r = await runOpenItem(spec, { ...opts, revisions: 1 });
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const reask = turnsOn(sys).find(t => t.purpose === "critique" && t.reply === "VERDICT: approve");
    assert.ok(reask, "the re-ask turn is on the ledger");
    assert.equal(reask.served_model, "grok-4.6-20261118");
    const review = reviewsOn(sys).find(p => p.verdict === "approve");
    assert.equal(review.response_id, reask.response_id, "the review cites the turn whose reply supplied the verdict");
    assert.equal(review.served_model, "grok-4.6-20261118");
    assert.equal(sys.ledger.verify().ok, true);
  }, { review: prompt => (REASK.test(prompt) ? "VERDICT: approve" : "the file looks fine"), served: (v, m, prompt) => (REASK.test(prompt) ? "grok-4.6-20261118" : m) });
});

// Question 6. The reviewer was asked grok-4.6 and served as grok-4.7 (one lab, admitted). Its finding reached the
// revision prompt; before the fix the contributor row kept grok-4.6 only, so grok-4.7 stayed eligible.
test("Q6 (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 6): a board critique contributor keeps the served model beside the asked one", async () => {
  await withBoard(async ({ spec, opts }) => {
    const first = await runOpenItem(spec, opts);
    // The pending revision names the reviewer with the model that served it.
    assert.deepEqual(runJson(first).files[0].escalation.pending.reviewers, [{ vendor: "xai", model: "grok-4.6", served_models: ["grok-4.7"] }]);
    // The revision (a resume) puts the finding in the implementer's prompt: the reviewer becomes a contributor.
    const r = await runOpenItem(spec, { ...opts, resume: first.board });
    const run = runJson(r);
    const rows = run.files.flatMap(f => f.contributors ?? []).filter(c => c.purpose === "critique");
    assert.ok(rows.length >= 1, JSON.stringify(run.files.map(f => f.contributors)));
    assert.ok(rows.some(c => c.model === "grok-4.6" && c.served_model === "grok-4.7"), JSON.stringify(rows));
    const keys = contributorKeys(reviewScope({ kind: "change", turns: rows }).contributions);
    assert.ok(keys.models.includes("xai/grok-4.7") && keys.models.includes("xai/grok-4.6"), JSON.stringify(keys.models));
    assert.match(reviewerRefusal({ vendor: "xai", model: "grok-4.7", served_model: "grok-4.7" }, keys), /contributed/);
  }, { review: (_p, k) => (k === 1 ? "The export is wrong.\nVERDICT: request_changes" : "VERDICT: approve"), served: (v, m) => (v === "xai" && m === "grok-4.6" ? "grok-4.7" : m) });
});

test("Q6 (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 6): an answered subagent call that names no serving model is recorded as unnamed", async () => {
  const shim = await startA2AShim({ unit_id: "u1", allowed_subagents: ["helper"], seatFor: () => ({ vendor: "xai", model: "grok-4.6" }), subagentTurn: async () => ({ text: "an answer", served_model: null }), tcp: true });
  try {
    const res = await fetch(shim.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${shim.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "what?" }], metadata: { subagent_role: "helper", unit_id: "u1" } } } }) });
    assert.equal(res.status, 200, await res.clone().text());
    const call = shim.calls.at(-1);
    assert.equal(call.status, "answered");
    assert.equal(call.served_model, null);
    assert.equal(call.served_model_source, "unnamed");
    const rows = contributionsOf({ planner: null, units: { u1: { unit_id: "u1", attempts: [], reviews: [], a2a: { calls: shim.calls } } } }).filter(c => c.kind === "subtask");
    assert.equal(rows[0].served_model_source, "unnamed");
    assert.deepEqual(contributorKeys(rows).models, ["xai/grok-4.6"], "the asked identity is the contributor");
  } finally { await shim.close(); }
});

// Question 9.
test("Q9 (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 9): the board Antigravity guard refuses an undeclared name before the lane", async () => {
  await withBoard(async ({ spec, opts, seat }) => {
    const r = await runOpenItem(spec, { ...opts, independence: undefined, seatOverrides: { ...opts.seatOverrides, planner: seat("agy_google", "not-a-declared-model", { transport: "agy-cli" }) } });
    assert.equal(r.shipped, false);
    assert.match(String(r.error?.message), /serves Gemini models only: not-a-declared-model is not a declared model/);
  }, { review: () => "VERDICT: approve" });
});

test("Q9 (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 9): a served name without the transport's source is not labelled a provider statement", async () => {
  const unsourced = await pipelineTurns({ turn: async () => ({ text: "a", served_model: "gpt-6-astra" }) }).dispatcher({ vendor: "openai", model: "gpt-6-astra", prompt: "p" });
  assert.equal(unsourced.served_model_source, "unknown");
  const provider = await pipelineTurns({ turn: async () => ({ text: "a", served_model: "gpt-6-astra", served_model_source: "provider" }) }).reviewer({ vendor: "openai", model: "gpt-6-astra", prompt: "p" });
  assert.equal(provider.served_model_source, "provider");
  const input = await pipelineTurns({ turn: async () => ({ text: "a", served_model: "gemini-4-carbon-high", served_model_source: "input" }) }).reviewer({ vendor: "agy_google", model: "gemini-4-carbon-high", prompt: "p" });
  assert.equal(input.served_model_source, "input");
  const none = await pipelineTurns({ turn: async () => ({ text: "a", served_model: null }) }).subagent({ vendor: "xai", model: "grok-4.6", prompt: "p" });
  assert.equal(none.served_model_source, null);
});

// Question 5.
test("Q5 (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 5): the recorder refuses a NEW cycle below three labs; a recorded one still verifies", () => {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-r2a2-q5-"));
  try {
    const sys = openPantheonLedger({ root: join(dir, "ledger") }), rec = sys.recorder();
    const C = c => String(c).repeat(40).slice(0, 40), DIFF = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n";
    const args = scope => ({ scope, base: C("a"), head: C("b"), diff: DIFF, files: ["x"], prompt: "review the change", reviewers: 1, author_labs: ["anthropic"] });
    assert.throws(() => rec.openCycle(args("fresh-v2")), /requires 3 independent reviewers and names 1/);
    assert.throws(() => rec.openCycle({ ...args("fresh-v1"), contract: CYCLE_CONTRACT_V1 }), e => e.code === "REVIEW_LABS_BELOW_REQUIRED");
    assert.equal(sys.ledger.read().filter(e => e.kind === "cycle").length, 0);
    // A fresh three-reviewer cycle records the floor.
    const three = rec.openCycle({ ...args("fresh-three"), reviewers: 3 });
    assert.equal(sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === three)).required_reviewers, 3);
    // A cycle in the shape recorded before the floor (written by a recorder made for that) still verifies.
    const hist = cycleRecorder({ ledger: sys.ledger, controller: sys.controller, order: sys.controller, historical: true }).openCycle(args("historical"));
    assert.equal(sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === hist)).required_reviewers, undefined);
    assert.equal(sys.ledger.verify().ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
