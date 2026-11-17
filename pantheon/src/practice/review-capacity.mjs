// Is four labs enough for coordinated review? (owner, 2026-11-17: no fifth lab; evaluate whether 4 is enough.)
//
// Evidence is the board runs that happen anyway; nothing here makes a provider call. Each run is classified by what
// happened to its coordinated (cycle) review, and the report applies a rule fixed in advance:
// docs/reviews/2026-11-17-review-capacity/FOUR_LABS.md.
//
// Inputs: evidence bundles (<board>/operating/evidence.json, as runBoardItem writes them) and the refusals recorded
// before work (<evidence store>/review-pending/*.json). Outputs: per-run classes, counts by cause, and the verdict.
// Invariants: a run that did not ship needed no review and is not counted against capacity; a review that
// completed after a bounded resume counts as completed; unknown is reported, never counted as a completion.
// Must never: treat a pending review as a pass, or count the same run twice.
//
// OBSERVATIONS, NOT FILES (86ce18a review, defect 4: twenty copies of one completed bundle counted as twenty runs).
// The rule is applied to unique, verified, live observations:
//   unique     a bundle's identity is its run.json digest, review cycle and commit; a copy of a bundle already seen
//              is a duplicate, listed and counted, never an observation. A before-work refusal's identity is its content.
//   verified   the run.json a bundle names exists and its sha256 is the digest the bundle cites; a bundle that names
//              none, or one whose run.json differs, is unverified: counted, listed, and outside the rate.
//   live       run.json `providers.kind` is "live" (a before-work refusal record carries the same field); fake,
//              undeclared or anything else is synthetic. The rule is reported over live observations only; synthetic
//              ones are reported beside it, with the same classes, never in it.
//   kept       failed (the run errored before shipping), unknown and inconclusive outcomes are counted categories.
//              unknown and inconclusive are non-completions under the rule; a failed or unshipped run needed no review.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { digest } from "../../../packages/ledger/canonical.mjs";

export const REPORT_SCHEMA = "pantheon.review-capacity/v2";
// PROVISIONAL rule constants (FOUR_LABS.md): enough when at least ENOUGH_RATE of shipped board runs complete their
// coordinated review (after bounded resume) over at least MIN_RUNS shipped runs.
export const MIN_RUNS = 20;
export const ENOUGH_RATE = 0.95;

export const CLASSES = Object.freeze({
  completed: "the cycle closed (verified or unverified) with three labs outside every contributing lab",
  open_findings: "the cycle is open on findings, not on capacity",
  reviewer_unavailable: "reviewer seats failed (provider refusal or outage); the review is pending a bounded resume",
  pending_mixed_labs: "the change's work was written by more than one lab (a worker fallback or escalation), leaving fewer than three reviewer labs",
  pending_plan_contribution: "a model-written plan contributed from another lab, leaving fewer than three reviewer labs",
  pending_pool_short: "the configured pool was short for another reason",
  refused_before_work: "the predicted contributors left the pool short, so no work was launched",
  inconclusive: "the cycle is open with no failed seat and no recorded finding: the record does not say why",
  unknown: "a shipped run with no review record, or a record that could not be read",
  failed: "the run failed before shipping; no coordinated review was needed",
  not_shipped: "the run did not ship; no coordinated review was needed",
});
// Classes that needed no coordinated review: neither a completion nor a failure of capacity.
const NO_REVIEW_NEEDED = ["not_shipped", "failed"];
const CAPACITY = c => c.startsWith("pending_") || c === "refused_before_work" || c === "reviewer_unavailable";

/** The class of one evidence bundle. */
export function classify(bundle) {
  if (!bundle?.run?.shipped) {
    return bundle?.run?.error ? { class: "failed", why: String(bundle.run.error?.message ?? bundle.run.error).slice(0, 300) } : { class: "not_shipped" };
  }
  const review = bundle.review ?? null;
  if (!review) return { class: "unknown", why: "a shipped run with no review record" };
  if (review.status === "pending") {
    const contributions = review.review_scope?.contributions ?? [];
    const workLabs = new Set(contributions.filter(c => c.purpose === "work").map(c => c.lab));
    if (workLabs.size > 1) return { class: "pending_mixed_labs", labs: [...workLabs].sort() };
    if (contributions.some(c => c.purpose === "plan")) return { class: "pending_plan_contribution", labs: review.author_labs ?? [] };
    return { class: "pending_pool_short", labs: review.author_labs ?? [] };
  }
  if (review.close) return { class: "completed", outcome: review.outcome ?? null, resumed: (review.resumes ?? []).length > 0 };
  if ((review.failed ?? []).length) return { class: "reviewer_unavailable", failed: review.failed.length };
  // Open with its reviews recorded, none failed and none reporting a finding: nothing says why it is open.
  if (Array.isArray(review.reviews) && review.reviews.length && !review.reviews.some(r => (r.findings ?? []).length)) return { class: "inconclusive" };
  return { class: "open_findings" };
}

const walk = (dir, name, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, name, out); else if (e === name) out.push(p);
  }
  return out;
};
const sha256 = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const provenanceOf = providers => (providers?.kind === "live" ? "live" : "synthetic");

/** A bundle's identity, whether its run.json verifies, and what answered (from that run.json). */
export function observeBundle(b) {
  const cited = b?.run?.run_json_digest ?? null, file = b?.run?.run_json ?? null;
  const identity = cited ? `run:${cited}|cycle:${b.review?.cycle ?? "none"}|commit:${b.commit ?? "none"}` : `bundle:sha256:${digest(b)}`;
  const unverified = why => ({ identity, verified: false, why, provenance: "synthetic", providers: "unknown" });
  if (!file || !cited) return unverified("the bundle names no run.json and digest to check");
  if (!existsSync(file)) return unverified(`the run.json it names is not at ${file}`);
  const bytes = readFileSync(file);
  if (sha256(bytes) !== cited) return unverified("the run.json it names is not the one its digest cites");
  let run = null;
  try { run = JSON.parse(bytes.toString("utf8")); } catch { run = null; }
  return { identity, verified: true, provenance: provenanceOf(run?.providers), providers: run?.providers?.kind ?? "undeclared" };
}

function tally(rows) {
  const counts = Object.fromEntries(Object.keys(CLASSES).map(k => [k, 0]));
  for (const r of rows) counts[r.class] = (counts[r.class] ?? 0) + 1;
  // Capacity-relevant observations: those that needed a coordinated review, or were refused for its lack. unknown and
  // inconclusive stay in, as non-completions.
  const needed = rows.filter(r => !NO_REVIEW_NEEDED.includes(r.class));
  const completed = needed.filter(r => r.class === "completed").length;
  return { observations: rows.length, needed: needed.length, completed, capacity_failures: needed.filter(r => CAPACITY(r.class)).length,
    rate: needed.length ? completed / needed.length : null, counts };
}

/** The report over bundles under `bundles` and before-work refusals under `store`. */
export function capacityReport({ bundles = null, store = null, minRuns = MIN_RUNS, enoughRate = ENOUGH_RATE } = {}) {
  const details = [], seen = new Map();
  const add = (row, identity) => {
    if (seen.has(identity)) { details.push({ ...row, identity, duplicate_of: seen.get(identity) }); return; }
    seen.set(identity, row.file);
    details.push({ ...row, identity });
  };
  for (const f of bundles ? walk(bundles, "evidence.json") : []) {
    let b;
    try { b = JSON.parse(readFileSync(f, "utf8")); } catch {
      add({ file: f, class: "unknown", why: "unreadable bundle", verified: false, provenance: "synthetic", unverified: "unreadable bundle" }, `file:${f}`);
      continue;
    }
    const o = observeBundle(b);
    add({ file: f, item: b.item ?? null, ...classify(b), verified: o.verified, provenance: o.provenance, providers: o.providers,
      ...(o.why ? { unverified: o.why } : {}) }, o.identity);
  }
  if (store && existsSync(join(store, "review-pending"))) {
    for (const e of readdirSync(join(store, "review-pending")).filter(x => x.endsWith(".json")).sort()) {
      const f = join(store, "review-pending", e);
      let p;
      try { p = JSON.parse(readFileSync(f, "utf8")); } catch {
        add({ file: f, class: "unknown", why: "unreadable refusal", verified: false, provenance: "synthetic", unverified: "unreadable refusal" }, `file:${f}`);
        continue;
      }
      // A refusal before work has no run.json: it is verified as the record runBoardItem writes (an item and its code).
      const ok = typeof p?.item === "string" && typeof p?.code === "string";
      add({ file: f, item: p?.item ?? null, class: "refused_before_work", labs: (p?.predicted_contributors ?? []).map(c => c.lab), verified: ok,
        provenance: provenanceOf(p?.providers), providers: p?.providers?.kind ?? "undeclared", ...(ok ? {} : { unverified: "not a before-work refusal record" }) },
      `refusal:sha256:${digest(p)}`);
    }
  }
  const unique = details.filter(r => !r.duplicate_of);
  const verified = unique.filter(r => r.verified);
  const live = tally(verified.filter(r => r.provenance === "live"));
  const verdict = live.needed < minRuns
    ? { outcome: "insufficient_evidence", why: `${live.needed} unique, verified, live board run(s) needed a coordinated review; the rule needs ${minRuns}` }
    : live.rate >= enoughRate
      ? { outcome: "enough", why: `${live.completed} of ${live.needed} coordinated reviews completed (${(live.rate * 100).toFixed(1)}% >= ${enoughRate * 100}%)` }
      : { outcome: "not_enough", why: `${live.completed} of ${live.needed} coordinated reviews completed (${(live.rate * 100).toFixed(1)}% < ${enoughRate * 100}%); see the causes` };
  return { schema: REPORT_SCHEMA, rule: { min_runs: minRuns, enough_rate: enoughRate, over: "unique, verified, live observations" },
    files: details.length, unique: unique.length, duplicates: details.length - unique.length,
    unverified: { count: unique.length - verified.length, counts: tally(unique.filter(r => !r.verified)).counts },
    // The rule's figures are the live observations'. Synthetic ones are reported beside them, never in them.
    runs: live.observations, needed: live.needed, completed: live.completed, capacity_failures: live.capacity_failures, rate: live.rate,
    counts: live.counts, verdict, synthetic: tally(verified.filter(r => r.provenance !== "live")), classes: CLASSES, details };
}
