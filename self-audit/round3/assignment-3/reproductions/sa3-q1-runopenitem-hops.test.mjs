// SELF-AUDIT A3 Q1 (af0dc30). PASSING = DEFECT PRESENT.
// runOpenItem (the argo/legacy implement stage's dispatcher) charges ONE provider call per turn: a Google long-decode
// turn that makes 3 billed generateContent requests (2 continuation hops) is charged once on the caller's meter
// (onCharge -> ctx.charge -> work.spend) and counted once in run.provider_calls. Finding 1.1 (e880a07) wired
// onRequest -> charge("continuation") into pipeline/turns.mjs and sdk/live.mjs only; seat-sdk.mjs sdkTurn has no
// onRequest parameter and run-item.mjs turn() passes none.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runOpenItem } from "../pantheon/src/board/run-item.mjs";
import { withDispatch, seat } from "../pantheon/tests/fixtures/dispatch.mjs";

test("Q1: a 3-request Google turn inside runOpenItem is charged as 1 provider call", async () => {
  await withDispatch(async ({ spec, opts, makeClientFor }) => {
    let googleRequests = 0;
    // The implementer's reply arrives in 3 hops (CONTINUATION, CONTINUATION, STOP): 3 billed requests.
    const hopping = {
      models: { countTokens: async () => ({ totalTokens: 100 }), generateContentStream: async req => {
        googleRequests++;
        const tok = req.config?.continuationToken ?? null, hop = tok === null ? 1 : tok === "c1" ? 2 : 3;
        const text = hop === 1 ? "export const " : hop === 2 ? "ok = " : "true;\n";
        return (async function* () {
          yield { modelVersion: req.model, candidates: [{ finishReason: hop < 3 ? "CONTINUATION" : "STOP", continuationToken: hop === 1 ? "c1" : hop === 2 ? "c2" : undefined, content: { parts: [{ text }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
        })();
      } } };
    const mk = (vendor, o) => vendor === "agy_google" ? hopping : makeClientFor(vendor, o);
    mk.providers = makeClientFor.providers;
    let charged = 0;
    const r = await runOpenItem(spec("hops"), { ...opts(), makeClientFor: mk, maxProviderCalls: 50, onCharge: () => { charged++; },
      seatOverrides: { implementer: seat("agy_google", "gemini-4-hydrogen", { transport: "api" }) } });
    const run = JSON.parse(readFileSync(join(r.board, "run.json"), "utf8"));
    const work = run.attempts.filter(a => a.purpose === "work");
    assert.ok(work.length >= 1, JSON.stringify(run.attempts.map(a => [a.purpose, a.vendor, a.outcome, a.why])));
    assert.equal(googleRequests, 3, "the provider received 3 billed requests for the one implementer turn");
    assert.equal(work[0].provider_requests, 3, "run.json itself records 3 requests on the attempt");
    // THE DEFECT: everything that bounds spend counts that turn as 1.
    const nonGoogleCalls = run.attempts.filter(a => a.purpose !== "work" && a.provider_requests !== 0).length;
    assert.equal(charged, nonGoogleCalls + 1, "onCharge (the work ledger's charge) was called once for the 3-request turn");
    assert.equal(run.provider_calls.made, nonGoogleCalls + 1, "the run's own bound counted it once");
  });
});
