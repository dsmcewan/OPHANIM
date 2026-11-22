// The mechanics of a matched practice comparison (docs/reviews/2026-11-16-routing-coordination/CYCLE_CONTRACT.md
// step 6; docs/routing-task-profile.md, "Adoption path"): the same tickets run under a baseline routing
// profile and a candidate profile, with the same declared resource bounds, and everything each run
// actually recorded (run.json `attempts`, `resources`, turn `usage` and `settings`; audit M5) reduced to
// one comparison record.
//
//   compareProfiles({tickets, baseline: 'argo', candidate: 'fit', bounds, runner, providers, question})
//     -> {schema: pantheon.compare/v1, synthetic, providers, question, profiles, bounds, tickets, results,
//         aggregate, interpretation, at, digest}
//
// Per ticket and per profile, one runMetrics row (metrics.mjs, the definitions shared with continuous
// evaluation): accepted (shipped through the controller's gates, the REVIEW gate included), first pass,
// revisions, review rejections, provider calls by outcome, tokens (null unless usage is complete), USD
// (null unless every attempt states a cost, never 0), elapsed time, escalations, retries and fallbacks,
// coordination overhead and per-turn operating points; the aggregate is metrics.aggregate (per stakes
// stratum, Wilson intervals, `insufficient` below MIN_N_PER_STRATUM). A
// failed or inconclusive ticket is a row like any other; nothing is dropped. Reviewer agreement is
// reported as agreement: nothing here is called correct.
//
// The record is evidence a practice disposition cites ({kind: digest, schema, sha, synthetic};
// comparisonEvidence). `synthetic` is true unless the providers were declared `kind: live`, so a run on
// fake providers can never be read as a live measurement, and the ledger refuses a promote resting on
// synthetic evidence alone (practice-kinds.mjs evidenceBasis). This module draws no conclusion
// (`interpretation.verdict` is null): an independent reviewer interprets the record (step 7).
//
// It runs nothing on its own: `runner` does (dispatchRunner wraps runOpenItem), with the providers the
// caller supplies. It never reads a key and never spends beyond the runner's declared bounds.
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "../../../packages/ledger/canonical.mjs";
import { COMPARE_SCHEMA, currentPolicy } from "../ledger/practice-kinds.mjs";
import { runOpenItem } from "../board/run-item.mjs";
import { certifiedArtifacts } from "../board/artifacts.mjs";
import { cycleReviewers } from "../board/operate.mjs";
import { openPantheonLedger } from "../ledger/system.mjs";
import { reviewCycle } from "../ledger/review-cycle.mjs";
import { labOf } from "../config/models.mjs";
import { runMetrics, unobservedRun, aggregate, stakesOf, median, MIN_N_PER_STRATUM } from "./metrics.mjs";
import { pairedNewcombe, wilcoxonSignedRank, pairsNeeded, Z, PROMOTION_CONFIDENCE } from "./evaluate.mjs";

export { COMPARE_SCHEMA };
export const PROFILES = Object.freeze(["argo", "legacy", "fit"]);

const sha = v => "sha256:" + createHash("sha256").update(v).digest("hex");
const AGREEMENT = "reviewer agreement, not correctness";

const INTERPRETATION = synthetic => ({
  accepted: "accepted = shipped by the controller through every ship gate, the executed acceptance (TESTS) and the in-run cross-lab review (REVIEW) included. " +
    `A review verdict, and a cycle review's approvals, are ${AGREEMENT}.`,
  first_pass: "first_pass = accepted on the first revision (no rework); revisions_to_accept is reported only for accepted runs.",
  usage: "tokens are summed only when every attempt reported usage; otherwise they are null and `missing` counts the attempts without it.",
  usd: "usd is null unless every attempt states its cost: no versioned price source is attached. Unknown is never 0, and a provider-call allowance is not a bill.",
  elapsed: "elapsed_ms is the run's own started_at -> finished_at, on this machine and these providers.",
  fallbacks: "a fallback is a turn answered by a candidate of rank > 0; a retry is a failed attempt followed by the same seat.",
  coordination: "coordination_overhead is the share of provider calls that are not implementation (plan, critique, scout); cycle-review turns are reported beside it.",
  strata: `rates carry Wilson 95% intervals and are stratified by stakes; a stratum with fewer than ${MIN_N_PER_STRATUM} runs per arm is marked insufficient.`,
  synthetic: synthetic
    ? "SYNTHETIC: the providers are fakes. This record verifies the comparison mechanics only; it measures no provider cost or quality, and a promote may not rest on it."
    : "LIVE: declared live providers. A scoped measurement for the tickets and bounds named here only; an independent reviewer interprets it before any disposition.",
  verdict: null,
});

function normalizeBounds(bounds) {
  const b = bounds ?? {};
  if (!(Number.isSafeInteger(b.maxProviderCalls) && b.maxProviderCalls > 0)) throw new Error("compareProfiles: bounds.maxProviderCalls is a declared positive integer, the same for both profiles");
  const revisions = b.revisions ?? 3;
  if (!(Number.isSafeInteger(revisions) && revisions > 0)) throw new Error("compareProfiles: bounds.revisions is a positive integer");
  const out = { maxProviderCalls: b.maxProviderCalls, revisions };
  if (b.cycle_review) out.cycle_review = { n: b.cycle_review.n, max_attempts: b.cycle_review.max_attempts };
  return out;
}

/** The record's digest: sha256 over its canonical form without the `digest` field. */
export const comparisonDigest = record => { const { digest: _, ...rest } = record; return sha(canonical(rest)); };
/** Does the record's digest re-derive, and is it a comparison record? */
export function verifyComparison(record) {
  if (record?.schema !== COMPARE_SCHEMA) return { ok: false, why: `not a ${COMPARE_SCHEMA} record` };
  if (typeof record.synthetic !== "boolean") return { ok: false, why: "the record does not say whether it is synthetic" };
  if (record.synthetic !== (record.providers?.kind !== "live")) return { ok: false, why: "synthetic is true unless the providers are declared live" };
  const d = comparisonDigest(record);
  return d === record.digest ? { ok: true, digest: d } : { ok: false, why: `the digest does not re-derive (${d.slice(0, 19)} vs ${String(record.digest).slice(0, 19)})` };
}
/** The citation a practice disposition carries for this record. */
export const comparisonEvidence = record => ({ kind: "digest", schema: COMPARE_SCHEMA, sha: record.digest, synthetic: record.synthetic });

/**
 * Run every ticket under `baseline` then `candidate` (interleaved, per ticket), with the same `bounds`,
 * through `runner({spec, profile, bounds, arm})` -> {run, result, cycle_review?}. `providers` declares
 * what answered: {kind: 'fake'|'live'|..., ...identity}; only `kind: 'live'` makes the record non-synthetic.
 */
export async function compareProfiles({ tickets, baseline = "argo", candidate = "fit", bounds, runner, providers, question = null,
  clock = () => Date.now(), at = new Date().toISOString(), pools = [] } = {}) {
  if (!Array.isArray(tickets) || tickets.length === 0) throw new Error("compareProfiles: pass the tickets to compare");
  if (typeof runner !== "function") throw new Error("compareProfiles: pass runner({spec, profile, bounds}) -> {run, result}");
  if (!providers || typeof providers.kind !== "string") throw new Error("compareProfiles: declare the providers ({kind: 'fake'|'live', ...identity}); a record names what answered");
  for (const p of [baseline, candidate]) if (!PROFILES.includes(p)) throw new Error(`compareProfiles: profile is one of ${PROFILES.join(", ")}`);
  if (baseline === candidate) throw new Error("compareProfiles: the baseline and candidate profiles must differ");
  const B = normalizeBounds(bounds);
  const synthetic = providers.kind !== "live";
  const specs = tickets.map(t => {
    const spec = t.spec ?? t;
    if (!spec || typeof spec.key !== "string") throw new Error("compareProfiles: every ticket has a key");
    return { spec, digest: t.digest ?? sha(canonical(spec)) };
  });
  if (new Set(specs.map(s => s.spec.key)).size !== specs.length) throw new Error("compareProfiles: ticket keys are distinct");
  const results = [];
  for (const { spec } of specs) {
    const row = { ticket: spec.key };
    for (const [arm, profile] of [["baseline", baseline], ["candidate", candidate]]) {
      const t0 = clock();
      let out = null, error = null;
      try { out = await runner({ spec, profile, bounds: structuredClone(B), arm }); } catch (e) { error = e; }
      const wall_ms = Math.max(0, clock() - t0);
      row[arm] = error || !out?.run
        ? { ...unobservedRun({ profile, why: error?.message ?? out?.result?.error?.message ?? "the runner returned no run record", review: out?.cycle_review ?? null,
          stakes: stakesOf(null, spec) }), wall_ms }
        : { ...runMetrics(out.run, { review: out.cycle_review ?? null, ticket: spec, result: out.result ?? null, profile }), wall_ms };
    }
    results.push(row);
  }
  const record = {
    schema: COMPARE_SCHEMA, synthetic, providers, question,
    profiles: { baseline: { profile: baseline, policy: currentPolicy(baseline, { pools }) }, candidate: { profile: candidate, policy: currentPolicy(candidate, { pools }) } },
    bounds: B, order: "per ticket, baseline then candidate",
    tickets: specs.map(s => ({ key: s.spec.key, digest: s.digest })),
    results,
    aggregate: (g => ({ baseline: g[baseline], candidate: g[candidate] }))(aggregate(results.flatMap(r => [r.baseline, r.candidate]))),
    interpretation: INTERPRETATION(synthetic),
    at,
  };
  return { ...record, digest: comparisonDigest(record) };
}

// ---------------------------------------------------------------- arms: a run setting, paired per ticket
//
// compareArms compares two ARMS that differ in a run setting (for example planTitle model vs ticket under one
// profile), not only in the routing profile. Owner condition 3 (2026-11-17): a TOTAL provider-call boundary is
// required (a ticket count or sampling rate is not a cap); a run that could overrun it is not started and is
// recorded as not run; the arm that runs first alternates per ticket; failed, refused and inconclusive runs are
// kept. The record carries the declared measurement plan by hash and a paired summary (Newcombe method 10 for
// accepted and first pass; Wilcoxon signed-rank for paired costs), and still draws no conclusion of its own.
const armKey = a => canonical({ profile: a.profile, runOpts: a.runOpts ?? {} });

/**
 * What one run is charged against the total (#126). The RAW attempt list is the record of calls made; the summary
 * (resources.provider_calls) is a claim about it and never outranks it.
 *
 *   raw      attempts recorded, summary absent or equal: charged the raw count (a recorded empty list is a real zero)
 *   reserve  no attempt list: charged at least the per-run bound, and the run decides nothing (a shipped summary
 *            without its calls is not a decided success)
 *   invalid  the summary is not a non-negative integer, or disagrees with the raw count: charged max(bound, raw),
 *            so a bad receipt never releases capacity, and the run decides nothing
 *   invalid_raw  the attempt list is present but malformed (not a list, or an entry that is not an attempt object):
 *            charged max(bound, entries); the run is recorded unread (its metrics would consume the bad list)
 *
 * `overrun`: the raw count exceeds the per-run bound the admission reserved, whatever the summary says.
 */
export function chargeOf(run, bound) {
  const list = run?.attempts;
  if (list !== undefined && list !== null && (!Array.isArray(list) || list.some(a => !a || typeof a !== "object" || Array.isArray(a)))) {
    // Present but malformed: not a record of calls. Charged at least the bound; the run is recorded without being read.
    const n = Array.isArray(list) ? list.length : 0;
    return { raw: null, counted: Math.max(bound, n), basis: "invalid_raw", overrun: false,
      why: `the run's attempt list is malformed (${Array.isArray(list) ? "an entry is not an attempt object" : `a ${typeof list}, not a list`}); ${Math.max(bound, n)} calls are charged and it decides nothing` };
  }
  const raw = Array.isArray(list) ? list.length : null;
  const summary = run?.resources?.provider_calls;
  const hasSummary = summary !== undefined && summary !== null;
  const overrun = raw !== null && raw > bound;
  if (hasSummary && !(Number.isSafeInteger(summary) && summary >= 0)) {
    return { raw, counted: Math.max(bound, raw ?? 0), basis: "invalid", overrun, why: `the run's summary of provider calls (${JSON.stringify(summary)}) is not a non-negative integer` };
  }
  if (raw === null) {
    return { raw, counted: Math.max(bound, hasSummary ? summary : 0), basis: "reserve", overrun: false,
      why: `the run records no attempt list; ${Math.max(bound, hasSummary ? summary : 0)} calls are reserved and it decides nothing` };
  }
  if (hasSummary && summary !== raw) {
    return { raw, counted: Math.max(bound, raw), basis: "invalid", overrun, why: `the run's summary of ${summary} provider calls disagrees with its ${raw} recorded attempts` };
  }
  return { raw, counted: raw, basis: "raw", overrun, why: null };
}
// An arm whose accounting cannot be trusted is kept, inconclusive: it decides nothing and cannot qualify a decision.
const undecided = (row, why) => ({ ...row, status: "inconclusive", accepted: null, first_pass: null, why });

export async function compareArms({ tickets, arms, bounds, totalProviderCalls, runner, providers, question = null, plan = null,
  counterbalance = true, clock = () => Date.now(), at = new Date().toISOString(), pools = [] } = {}) {
  if (!Array.isArray(tickets) || tickets.length === 0) throw new Error("compareArms: pass the tickets to compare");
  if (typeof runner !== "function") throw new Error("compareArms: pass runner({spec, profile, runOpts, label, bounds}) -> {run, result}");
  if (!providers || typeof providers.kind !== "string") throw new Error("compareArms: declare the providers ({kind: 'fake'|'live', ...identity})");
  if (!Array.isArray(arms) || arms.length !== 2) throw new Error("compareArms: pass exactly two arms, baseline first");
  for (const a of arms) {
    if (!a?.label || !PROFILES.includes(a.profile)) throw new Error(`compareArms: an arm is {label, profile (${PROFILES.join(", ")}), runOpts?}`);
  }
  if (arms[0].label === arms[1].label || armKey(arms[0]) === armKey(arms[1])) throw new Error("compareArms: the two arms must differ, in label and in setting");
  if (!(Number.isSafeInteger(totalProviderCalls) && totalProviderCalls > 0)) {
    throw new Error("compareArms: a total provider-call boundary (totalProviderCalls) is required: a ticket count or sampling rate is not a spending cap");
  }
  const B = normalizeBounds(bounds);
  const synthetic = providers.kind !== "live";
  const specs = tickets.map(t => ({ spec: t.spec ?? t, digest: t.digest ?? sha(canonical(t.spec ?? t)) }));
  if (specs.some(s => typeof s.spec?.key !== "string")) throw new Error("compareArms: every ticket has a key");
  if (new Set(specs.map(s => s.spec.key)).size !== specs.length) throw new Error("compareArms: ticket keys are distinct");
  const names = ["baseline", "candidate"];
  let spent = 0;
  const results = [], overruns = [];
  for (const [i, { spec }] of specs.entries()) {
    const order = counterbalance && i % 2 === 1 ? [1, 0] : [0, 1];
    const row = { ticket: spec.key, order: order.map(k => names[k]) };
    for (const k of order) {
      const arm = arms[k], name = names[k];
      if (overruns.length) {
        // A run already spent past its reservation. What was admitted cannot be undone; nothing more is admitted.
        row[name] = { ...unobservedRun({ profile: arm.label, why: `not run: an earlier run overran its per-run bound (${overruns[0].ticket}/${overruns[0].arm}: ${overruns[0].raw} > ${B.maxProviderCalls}); the comparison is invalid and admits nothing more`,
          stakes: stakesOf(null, spec) }), status: "not_run", arm_profile: arm.profile, wall_ms: 0, provider_calls_counted: 0 };
        continue;
      }
      if (spent + B.maxProviderCalls > totalProviderCalls) {
        row[name] = { ...unobservedRun({ profile: arm.label, why: `not run: ${spent} calls spent + this run's bound ${B.maxProviderCalls} would exceed the total ${totalProviderCalls}`,
          stakes: stakesOf(null, spec) }), status: "not_run", arm_profile: arm.profile, wall_ms: 0, provider_calls_counted: 0 };
        continue;
      }
      const t0 = clock();
      let out = null, error = null;
      try { out = await runner({ spec, profile: arm.profile, runOpts: arm.runOpts ?? {}, label: arm.label, bounds: structuredClone(B), arm: name }); }
      catch (e) { error = e; }
      const wall_ms = Math.max(0, clock() - t0);
      // What this run is charged: its RAW attempts; no list reserves at least its bound; a bad summary never lowers it.
      const before = spent;
      const c = chargeOf(error ? null : out?.run, B.maxProviderCalls);
      spent += c.counted;
      const acct = { provider_calls_raw: c.raw, provider_calls_counted: c.counted, provider_calls_basis: c.basis, provider_calls_before: before, provider_calls_overrun: c.overrun };
      if (c.overrun) overruns.push({ ticket: spec.key, arm: name, raw: c.raw, bound: B.maxProviderCalls });
      if (error || !out?.run || c.basis === "invalid_raw") {
        row[name] = { ...unobservedRun({ profile: arm.label, why: c.basis === "invalid_raw" ? c.why : error?.message ?? out?.result?.error?.message ?? "the runner returned no run record", stakes: stakesOf(null, spec) }),
          arm_profile: arm.profile, wall_ms, ...acct };
        continue;
      }
      const m = { ...runMetrics(out.run, { ticket: spec, result: out.result ?? null, profile: arm.label }), arm_profile: arm.profile, wall_ms, ...acct };
      row[name] = c.overrun ? undecided(m, `overran its per-run bound: ${c.raw} recorded attempts > ${B.maxProviderCalls}`)
        : c.basis === "raw" ? m : undecided(m, c.why);
    }
    results.push(row);
  }
  const record = {
    schema: COMPARE_SCHEMA, kind: "arms", synthetic, providers, question, plan,
    arms: Object.fromEntries(arms.map((a, k) => [names[k], { label: a.label, profile: a.profile, runOpts: a.runOpts ?? {}, policy: currentPolicy(a.profile, { pools }) }])),
    bounds: B, total_provider_calls: totalProviderCalls, spent_provider_calls: spent,
    // An overrun cannot be undone; it invalidates the comparison, which is kept with its actual spend and reason.
    budget: overruns.length ? { valid: false, overruns, why: "a run spent more provider calls than its admission reserved" } : { valid: true, overruns: [] },
    order: counterbalance ? "alternating per ticket: baseline first on even tickets, candidate first on odd" : "baseline then candidate",
    tickets: specs.map(s => ({ key: s.spec.key, digest: s.digest })),
    results,
    aggregate: (g => ({ baseline: g[arms[0].label] ?? null, candidate: g[arms[1].label] ?? null }))(
      aggregate(results.flatMap(r => [r.baseline, r.candidate]).filter(x => x && x.status !== "not_run"))),
    paired: pairedSummary(results),
    interpretation: INTERPRETATION(synthetic),
    at,
  };
  return { ...record, digest: comparisonDigest(record) };
}

/**
 * The paired view of an arms record: per stratum and `all`, over pairs whose two runs were both decided. Cells are
 * candidate-first (e both accepted, f candidate only, g baseline only, h neither); intervals are of
 * (candidate - baseline) at PROMOTION_CONFIDENCE. Costs: per-pair differences (candidate - baseline) where both
 * sides have the value, with a Wilcoxon signed-rank test; unknown never counts as cheaper.
 */
export function pairedSummary(results) {
  const decided = x => x && x.status !== "not_run" && x.accepted !== null && x.accepted !== undefined;
  const pairs = results.filter(r => decided(r.baseline) && decided(r.candidate));
  const z = Z[PROMOTION_CONFIDENCE];
  const cells = (rows, key) => rows.reduce((c, r) => {
    const a = r.candidate[key] === true, b = r.baseline[key] === true;
    c[a && b ? "e" : a ? "f" : b ? "g" : "h"]++; return c;
  }, { e: 0, f: 0, g: 0, h: 0 });
  const diffOf = (rows, get) => rows.map(r => [get(r.candidate), get(r.baseline)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)).map(([a, b]) => a - b);
  const summarize = rows => {
    if (!rows.length) return { n: 0 };
    const out = { n: rows.length };
    for (const key of ["accepted", "first_pass"]) {
      const t = cells(rows, key);
      out[key] = { cells: t, candidate_rate: (t.e + t.f) / rows.length, baseline_rate: (t.e + t.g) / rows.length,
        diff_ci: pairedNewcombe(t, z), pairs_needed: pairsNeeded({ e: t.e, f: t.f, g: t.g, h: t.h }) };
    }
    const both = rows.filter(r => r.candidate.accepted && r.baseline.accepted);
    out.cost = Object.fromEntries([
      ["provider_calls", r => r.provider_calls?.value],
      ["tokens", r => (r.tokens_in?.value ?? NaN) + (r.tokens_out?.value ?? NaN)],
      ["elapsed_ms", r => r.elapsed_ms?.value],
    ].map(([k, get]) => {
      const d = diffOf(both, get);
      return [k, { pairs: d.length, missing: both.length - d.length, median_diff: d.length ? median(d) : null, wilcoxon: wilcoxonSignedRank(d) }];
    }));
    return out;
  };
  const strata = {};
  for (const r of pairs) (strata[r.candidate.stakes?.value ?? "unknown"] ??= []).push(r);
  return { pairs: pairs.length, unpaired: results.length - pairs.length, confidence: PROMOTION_CONFIDENCE,
    note: "intervals are of (candidate - baseline); a declared plan applies the rule, this summary does not",
    all: summarize(pairs), strata: Object.fromEntries(Object.entries(strata).map(([s, rows]) => [s, summarize(rows)])) };
}

// ---------------------------------------------------------------- the dispatcher runner

const labsOf = turns => [...new Set(turns.map(t => labOf(t.vendor, t.served_model ?? t.model)).filter(Boolean))];
const hex40 = s => createHash("sha256").update(String(s)).digest("hex").slice(0, 40);

/** An independent review cycle over a shipped run's certified artifacts, on a ledger of its own. */
async function cycleReviewOf({ run, result, spec, profile, turn, n, root }) {
  let files;
  try { files = certifiedArtifacts(run, { repoRoot: spec.repo_root, outDir: result.outDir }); }
  catch (e) { return { ran: false, why: `no certified artifacts to review: ${e.message}`, turns: 0, note: AGREEMENT }; }
  const diff = files.map(f => {
    const text = f.exported === null || f.exported === undefined ? "" : String(f.exported);
    return `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ shipped contents @@\n` + text.split("\n").map(l => `+${l}`).join("\n") + "\n";
  }).join("");
  const turns = run.turns ?? [];
  const chosen = cycleReviewers({ planLabs: labsOf(turns.filter(t => t.purpose === "plan")), workLabs: labsOf(turns.filter(t => t.purpose === "work")), n });
  // The independence requirement is never narrowed: a run whose contributors leave the pool short is recorded as a
  // pending review (no review turns), not reviewed by fewer or by a contributing lab.
  if (chosen.pending) return { ran: false, pending: chosen.pending, why: `${chosen.pending.code}: ${chosen.pending.why}`, turns: 0, note: AGREEMENT };
  mkdirSync(root, { recursive: true });
  const rec = openPantheonLedger({ root }).recorder();
  const r = await reviewCycle({ ledger: rec, change: { scope: `compare/${spec.key}/${profile}`, base: hex40(canonical(run.files?.map(f => f.baseline) ?? [])),
    head: hex40(run.certificate?.commit ?? ""), diff, files: files.map(f => f.path), author_labs: chosen.author_labs },
  seats: chosen.seats, turn, n, max_attempts: 1, policy: currentPolicy(profile) });
  return { ran: true, cycle: r.cycle, ledger: root, labs: r.reviews.map(x => x.lab), verdicts: r.reviews.map(x => x.verdict), reviews: r.reviews.length, failed: r.failed.length,
    approvals: r.reviews.filter(x => x.verdict === "approve").length, findings: r.reviews.reduce((k, x) => k + x.findings.length, 0),
    turns: r.reviews.length + r.failed.length, note: AGREEMENT };
}

/**
 * A runner over the real dispatcher: runOpenItem(spec, {profile, maxProviderCalls, revisions, makeClientFor})
 * on a board of its own under `dir`, then run.json read back. With `cycleTurn`, a shipped run also gets an
 * independent review cycle (n labs, none of the authors', one attempt each) whose turns count as
 * coordination overhead; its approvals are agreement, not correctness. The run key is suffixed with the
 * profile so the two runs of one ticket never share an output directory; the ticket is otherwise the same.
 */
export function dispatchRunner({ makeClientFor, dir, runOpts = {}, cycleTurn = null, n = 3 }) {
  if (typeof makeClientFor !== "function") throw new Error("dispatchRunner: pass makeClientFor(vendor)");
  if (!dir) throw new Error("dispatchRunner: pass a working directory");
  return async ({ spec, profile, bounds, runOpts: armOpts = {}, label = null }) => {
    const key = `${spec.key}.${label ?? profile}`;
    const board = join(dir, key);
    // Board conditions: the work item's title is the ticket's own unless the caller (or the arm) says otherwise.
    const result = await runOpenItem({ ...spec, key }, { planTitle: "ticket", ...runOpts, ...armOpts, dir: board, makeClientFor, profile,
      maxProviderCalls: bounds.maxProviderCalls, revisions: bounds.revisions });
    const file = join(board, "run.json");
    const run = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    const cycle_review = cycleTurn && run && result.shipped
      ? await cycleReviewOf({ run, result, spec: { ...spec, key }, profile, turn: cycleTurn, n, root: join(board, "compare-cycle-ledger") })
      : cycleTurn ? { ran: false, why: "not shipped: nothing to review", turns: 0, note: AGREEMENT } : null;
    return { run, result, cycle_review };
  };
}
