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
import { runMetrics, unobservedRun, aggregate, stakesOf, MIN_N_PER_STRATUM } from "./metrics.mjs";

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
  return async ({ spec, profile, bounds }) => {
    const key = `${spec.key}.${profile}`;
    const board = join(dir, key);
    // Board conditions: the work item's title is the ticket's own unless the caller says otherwise (operate.mjs).
    const result = await runOpenItem({ ...spec, key }, { planTitle: "ticket", ...runOpts, dir: board, makeClientFor, profile,
      maxProviderCalls: bounds.maxProviderCalls, revisions: bounds.revisions });
    const file = join(board, "run.json");
    const run = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    const cycle_review = cycleTurn && run && result.shipped
      ? await cycleReviewOf({ run, result, spec: { ...spec, key }, profile, turn: cycleTurn, n, root: join(board, "compare-cycle-ledger") })
      : cycleTurn ? { ran: false, why: "not shipped: nothing to review", turns: 0, note: AGREEMENT } : null;
    return { run, result, cycle_review };
  };
}
