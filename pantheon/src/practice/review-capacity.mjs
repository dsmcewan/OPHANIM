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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const REPORT_SCHEMA = "pantheon.review-capacity/v1";
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
  not_shipped: "the run did not ship; no coordinated review was needed",
});

/** The class of one evidence bundle. */
export function classify(bundle) {
  if (!bundle?.run?.shipped) return { class: "not_shipped" };
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
  return { class: "open_findings" };
}

const walk = (dir, name, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, name, out); else if (e === name) out.push(p);
  }
  return out;
};

/** The report over bundles under `bundles` and before-work refusals under `store`. */
export function capacityReport({ bundles = null, store = null, minRuns = MIN_RUNS, enoughRate = ENOUGH_RATE } = {}) {
  const runs = [];
  for (const f of bundles ? walk(bundles, "evidence.json") : []) {
    let b; try { b = JSON.parse(readFileSync(f, "utf8")); } catch { runs.push({ file: f, class: "unknown", why: "unreadable bundle" }); continue; }
    runs.push({ file: f, item: b.item ?? null, ...classify(b) });
  }
  if (store && existsSync(join(store, "review-pending"))) {
    for (const e of readdirSync(join(store, "review-pending")).filter(x => x.endsWith(".json")).sort()) {
      const f = join(store, "review-pending", e);
      try { const p = JSON.parse(readFileSync(f, "utf8")); runs.push({ file: f, item: p.item ?? null, class: "refused_before_work", labs: (p.predicted_contributors ?? []).map(c => c.lab) }); }
      catch { runs.push({ file: f, class: "unknown", why: "unreadable refusal" }); }
    }
  }
  const counts = Object.fromEntries(Object.keys(CLASSES).map(k => [k, 0]));
  counts.unknown = 0;
  for (const r of runs) counts[r.class] = (counts[r.class] ?? 0) + 1;
  // Capacity-relevant runs: those that needed a coordinated review, or were refused for its lack.
  const needed = runs.filter(r => !["not_shipped", "unknown"].includes(r.class));
  const completed = needed.filter(r => r.class === "completed").length;
  const capacityFailures = needed.filter(r => r.class.startsWith("pending_") || r.class === "refused_before_work" || r.class === "reviewer_unavailable").length;
  const rate = needed.length ? completed / needed.length : null;
  const verdict = needed.length < minRuns
    ? { outcome: "insufficient_evidence", why: `${needed.length} board run(s) needed a coordinated review; the rule needs ${minRuns}` }
    : rate >= enoughRate
      ? { outcome: "enough", why: `${completed} of ${needed.length} coordinated reviews completed (${(rate * 100).toFixed(1)}% >= ${enoughRate * 100}%)` }
      : { outcome: "not_enough", why: `${completed} of ${needed.length} coordinated reviews completed (${(rate * 100).toFixed(1)}% < ${enoughRate * 100}%); see the causes` };
  return { schema: REPORT_SCHEMA, rule: { min_runs: minRuns, enough_rate: enoughRate }, runs: runs.length, needed: needed.length, completed,
    capacity_failures: capacityFailures, rate, counts, verdict, classes: CLASSES, details: runs };
}
