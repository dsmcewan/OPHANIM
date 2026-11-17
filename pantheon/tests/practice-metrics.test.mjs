// The shared practice-metric definitions (src/practice/metrics.mjs), used by the matched comparison and by
// continuous evaluation over real runs. Each definition is pinned on a hand-built run.json, so a change to
// a definition is a visible test change: not observable is null (never 0), every value carries its n.
import test from "node:test";
import assert from "node:assert/strict";
import { runMetrics, aggregate, wilson, median, stakesOf, unobservedRun, MIN_N_PER_STRATUM, ESCALATION_ACTIONS } from "../src/practice/metrics.mjs";

const ok = (purpose, over = {}) => ({ purpose, vendor: "openai", model: "gpt-x", pool: "openai", outcome: "ok", usage: { input_tokens: 100, output_tokens: 10 }, ...over });
const sel = (over = {}) => ({ profile: "fit", policy_hash: "sha256:" + "a".repeat(64), rank: 0, task: { stakes: { value: "high", basis: "ticket" } },
  class: { value: "frontier" }, effort: { value: "high" }, practice: { disposition: null, outcome: null, policy: { hash: "sha256:" + "a".repeat(64) }, provisional: true, applies: true }, ...over });
const turn = (purpose, over = {}) => ({ purpose, vendor: "openai", model: "gpt-x", settings: { model: "gpt-x", effort: "high", basis: "sent" }, selection: sel(), ...over });
const base = (over = {}) => ({
  started_at: "2026-11-17T00:00:00.000Z", finished_at: "2026-11-17T00:01:00.000Z", shipped: true,
  gates: [{ gate: "REVIEW", ok: true }, { gate: "TESTS", ok: true }], revisions: [{ rev: 1 }, { rev: 2 }],
  turns: [turn("scout"), turn("plan"), turn("work"), turn("work", { selection: sel({ rank: 1 }) }), turn("critique"), turn("critique")],
  attempts: [ok("scout"), ok("plan"), ok("work", { outcome: "quota", usage: null }), ok("work", { vendor: "xai", pool: "xai" }), ok("work"), ok("critique"), ok("critique")],
  escalations: [{ outcome: { kind: "acceptance", exit: 1 }, decision: { action: "raise_effort" } },
    { outcome: { kind: "critique", verdict: "request_changes" }, decision: { action: "step_rung" } }],
  review: { verdict: "approve" }, provider_calls: { limit: 10, made: 7, refused: null }, ...over });

test("runMetrics: each definition, on a hand-built run", () => {
  const m = runMetrics(base());
  assert.equal(m.accepted, true, "shipped and the REVIEW gate passed");
  assert.equal(m.first_pass, false, "accepted after a second revision is not first-pass");
  assert.equal(m.revisions_to_accept, 2);
  assert.deepEqual([m.review_rejections.value, m.review_rejections.in_run, m.review_rejections.cycle], [1, 1, null]);
  assert.deepEqual([m.provider_calls.value, m.provider_calls.n], [7, 7]);
  assert.deepEqual(m.by_outcome, { ok: 6, quota: 1 });
  assert.equal(m.usage_complete, false);
  assert.deepEqual([m.tokens_in.value, m.tokens_in.n, m.tokens_in.missing], [null, 6, 1], "a partial sum is not reported as the total");
  assert.equal(m.usd.value, null, "no attempt states a cost");
  assert.equal(m.elapsed_ms.value, 60_000);
  assert.deepEqual(m.escalations.by_action, { raise_effort: 1, step_rung: 1, raise_output: 0, stop: 0 });
  for (const a of ESCALATION_ACTIONS) assert.ok(a in m.escalations.by_action);
  assert.deepEqual([m.fallbacks.value, m.fallbacks.n], [1, 6], "one turn answered by a rank-1 candidate");
  assert.equal(m.retries.value, 0, "the quota failure moved to another seat: a fallback, not a retry");
  assert.deepEqual([m.coordination_overhead.value, m.coordination_overhead.calls], [4 / 7, 4], "plan, critique and scout calls over all calls");
  assert.equal(m.profile, "fit");
  assert.equal(m.policy_hash, "sha256:" + "a".repeat(64));
  assert.equal(m.practice.provisional, true);
  assert.deepEqual(m.stakes, { value: "high", basis: "ticket" });
  assert.deepEqual(m.operating_points[2], { purpose: "work", vendor: "openai", model: "gpt-x", effort: "high", effort_basis: "sent", class: "frontier", rank: 0 });
  assert.equal(m.calls_per_accept, 7);
  assert.equal(m.tokens_per_accept, null, "only over usage-complete runs");

  // Complete usage and stated costs: sums.
  const priced = runMetrics(base({ attempts: [ok("plan", { usd: 0.01 }), ok("work", { usd: 0.02 })] }));
  assert.equal(priced.tokens_in.value, 200);
  assert.equal(priced.tokens_per_accept, 220);
  assert.ok(Math.abs(priced.usd.value - 0.03) < 1e-12);
  const half = runMetrics(base({ attempts: [ok("plan", { usd: 0.01 }), ok("work")] }));
  assert.deepEqual([half.usd.value, half.usd.missing], [null, 1], "null unless every attempt states its cost");

  // A cycle review's verdicts add to the rejections; not shipped is not accepted; a refused bound is undecided.
  assert.equal(runMetrics(base(), { review: { verdicts: ["approve", "request_changes", "approve"] } }).review_rejections.value, 2);
  const rejected = runMetrics(base({ shipped: false, gates: [{ gate: "REVIEW", ok: false }], review: { verdict: "request_changes" }, escalations: [] }));
  assert.deepEqual([rejected.accepted, rejected.first_pass, rejected.revisions_to_accept, rejected.review_rejections.value], [false, false, null, 1]);
  const bounded = runMetrics(base({ shipped: false, gates: null, provider_calls: { limit: 7, made: 7, refused: { code: "PROVIDER_CALL_LIMIT" } } }));
  assert.deepEqual([bounded.status, bounded.accepted, bounded.first_pass], ["inconclusive", null, null]);
  // Unobservable is null, not 0.
  const none = runMetrics(base({ started_at: undefined, attempts: [], turns: [], escalations: undefined, review: undefined }));
  assert.equal(none.elapsed_ms.value, null);
  assert.equal(none.review_rejections.value, null, "no review was observed");
  assert.equal(none.coordination_overhead.value, null);
  assert.equal(none.fallbacks.value, null);
  assert.equal(none.usage_complete, false, "no attempts: completeness is not claimed");
  assert.equal(unobservedRun({ profile: "argo" }).provider_calls.value, null);
});

test("stakes: the selection's task profile; for argo (none recorded), taskProfile on the ticket", () => {
  const argo = { turns: [{ purpose: "work", selection: { profile: "argo", rank: 0 } }], files: [{ path: "src/ledger/x.mjs" }] };
  assert.equal(stakesOf(argo, { key: "t", path: "pantheon/src/ledger/keys.mjs" }).value, "critical", "a ledger path is critical");
  assert.match(stakesOf(argo, { key: "t", path: "pantheon/src/ledger/keys.mjs" }).basis, /^taskProfile:/);
  assert.equal(stakesOf(argo, { key: "t", path: "docs/x.md" }).value, "low");
  assert.equal(stakesOf(argo, { key: "t", path: "src/a.mjs", stakes: "high" }).value, "high", "a ticket field wins");
  assert.equal(stakesOf(argo).value, "critical", "without a ticket, the run's files");
});

test("aggregate: per profile and stakes stratum, Wilson intervals, medians per accept, insufficient below the named minimum", () => {
  assert.equal(MIN_N_PER_STRATUM, 20);
  assert.deepEqual(wilson(0, 0), null);
  const [lo, hi] = wilson(8, 10);
  assert.ok(Math.abs(lo - 0.4902) < 1e-3 && Math.abs(hi - 0.9433) < 1e-3, `${lo} ${hi}`);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  const complete = { attempts: [ok("plan"), ok("work")] };
  const rows = [
    ...Array.from({ length: 21 }, (_, i) => runMetrics(base({ ...complete, revisions: i < 7 ? [{ rev: 1 }] : [{ rev: 1 }, { rev: 2 }] }))),
    runMetrics(base({ shipped: false, gates: [{ gate: "REVIEW", ok: false }] })),
    runMetrics(base({ ...complete, turns: [turn("work", { selection: sel({ profile: "argo", task: undefined, class: undefined }) })] }), { ticket: { key: "d", path: "docs/a.md" } }),
    unobservedRun({ profile: "argo" }),
  ];
  const g = aggregate(rows);
  assert.deepEqual(Object.keys(g).sort(), ["argo", "fit"]);
  const high = g.fit.strata.high;
  assert.equal(high.n, 22);
  assert.deepEqual([high.accepted.count, high.accepted.n], [21, 22]);
  assert.deepEqual([high.first_pass.count, high.first_pass.n], [7, 22]);
  assert.ok(high.first_pass.wilson95[0] < 7 / 22 && high.first_pass.wilson95[1] > 7 / 22);
  assert.equal(high.insufficient, false, "22 runs meet the minimum");
  assert.deepEqual(high.median_calls_per_accept, { value: 2, n: 21 });
  assert.deepEqual(high.median_tokens_per_accept, { value: 220, n: 21 });
  assert.deepEqual(high.median_elapsed_ms_per_accept, { value: 60_000, n: 21 });
  const argo = g.argo;
  assert.deepEqual(Object.keys(argo.strata).sort(), ["low", "unknown"]);
  assert.equal(argo.strata.low.insufficient, true);
  assert.equal(argo.strata.low.needed, 19);
  assert.equal(argo.all.status.inconclusive, 1);
  assert.equal(argo.all.accepted.n, 1, "an undecided run is not in the rate's n");
  assert.equal(argo.all.usd.value, null);
  assert.equal(aggregate(rows, { minN: 1 }).argo.strata.low.insufficient, false, "the threshold is a parameter, defaulting to the constant");
});
