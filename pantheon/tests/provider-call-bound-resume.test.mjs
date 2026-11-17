// Audit M5, the gaps left open: a provider-call bound that a RESUME silently reset, and a seat-layer refusal
// (provider_requests: 0, nothing sent) counted as a provider call. Through the real dispatcher (runOpenItem)
// on the scripted providers of fixtures/dispatch.mjs; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runOpenItem, providerCallsOf } from "../src/board/run-item.mjs";
import { sdkTurn } from "../src/sdk/seat-sdk.mjs";
import { withDispatch } from "./fixtures/dispatch.mjs";

const runJson = r => JSON.parse(readFileSync(join(r.board, "run.json"), "utf8"));
const quota = () => Object.assign(new Error("You exceeded your current quota"), { status: 429, code: "insufficient_quota" });

test("M5: a resume inherits the run's provider-call bound and counts the calls run.json already records", async () => {
  await withDispatch(async ({ spec, opts, calls, fault }) => {
    // Every reviewer request fails, so the first run spends its whole bound and stops at the check stage.
    let failReview = true;
    fault(c => failReview && /VERDICT/.test(c.prompt) ? { error: quota() } : null);
    const o = opts();
    const first = await runOpenItem(spec("boundResume"), { ...o, maxProviderCalls: 4 });
    assert.equal(first.shipped, false);
    assert.match(first.error?.message ?? "", /PROVIDER_CALL_LIMIT/);
    assert.equal(calls.length, 4, "scout, plan, work and one failed review: the bound");
    failReview = false;

    // Resumed with no bound named: the recorded limit applies and its four calls count against it.
    const inherited = await runOpenItem(spec("boundResume"), { ...o, resume: first.board });
    assert.equal(inherited.shipped, false);
    assert.match(inherited.error?.message ?? "", /PROVIDER_CALL_LIMIT/);
    assert.equal(calls.length, 4, "a resume does not get a fresh limit: no provider request was sent");
    const r1 = runJson(inherited);
    assert.deepEqual([r1.provider_calls.limit, r1.provider_calls.made, r1.provider_calls.basis, r1.provider_calls.prior, r1.provider_calls.counted_from], [4, 4, "inherited", 4, 0]);
    assert.equal(r1.provider_calls.refused?.code, "PROVIDER_CALL_LIMIT");

    // The operator's explicit new bound for this invocation: recorded as such, and the review runs.
    const raised = await runOpenItem(spec("boundResume"), { ...o, resume: first.board, maxProviderCalls: 2 });
    assert.equal(raised.shipped, true, JSON.stringify(raised.error));
    const r2 = runJson(raised);
    assert.deepEqual([r2.provider_calls.limit, r2.provider_calls.basis, r2.provider_calls.prior, r2.provider_calls.previous_limit, r2.provider_calls.counted_from], [2, "operator", 4, 4, r1.attempts.length]);
    assert.equal(r2.provider_calls.made, calls.length - 4, "the operator's bound counts this invocation's calls");
    assert.ok(r2.provider_calls.made <= 2);
  });
});

test("M5: a seat-layer refusal that sent no request (provider_requests: 0) is not a provider call", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    let refused = 0;
    // The seat layer refuses the first scout turn before any request (a held conversation); the rest run.
    const runSeatTurn = async args => {
      if (!refused && args.purpose.startsWith("scout")) { refused++; return { ok: false, code: "SEAT_HELD", why: "fixture: the seat's conversation is held", result: null }; }
      return sdkTurn(args);
    };
    const r = await runOpenItem(spec("seatRefusal"), opts({ runSeatTurn, maxProviderCalls: 50 }));
    const run = runJson(r);
    const seatRefused = run.attempts.filter(a => a.outcome === "refused_seat");
    assert.equal(seatRefused.length, 1, "the refusal is on the record as an attempt");
    assert.equal(seatRefused[0].provider_requests, 0);
    assert.equal(run.provider_calls.made, calls.length, "the bound counts only requests a provider received");
    assert.equal(run.resources.provider_calls, calls.length);
    assert.equal(providerCallsOf(run.attempts), run.attempts.length - 1);
  });
});
