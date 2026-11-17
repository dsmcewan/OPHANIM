// Per-run practice metrics and their aggregate: ONE definition, shared by the matched comparison
// (compare.mjs) and by any continuous evaluation over real runs. Pure: reads a run.json object (and an
// optional independent cycle-review summary), writes nothing, calls nothing.
//
// Rules every value follows:
//   - not observable is null, never 0. A count that was observed to be zero is 0.
//   - every measured value carries what it rests on: {value, n} (n = the observations it is computed
//     from), with `missing` where some observations lacked it. Booleans are null when undecided.
//   - agreement is not correctness: `accepted` is the controller's ship decision through its gates (the
//     in-run cross-lab REVIEW gate included); a review verdict is reported as a verdict.
//
// runMetrics(runJson, {review, ticket}) -> one row
//   accepted              shipped AND the REVIEW ship gate passed (null when the run did not decide:
//                         no run, or the declared provider-call bound refused a call before shipping)
//   first_pass            accepted with exactly one revision (no rework)
//   revisions_to_accept   revisions when accepted, else null
//   review_rejections     non-approve verdicts: the in-run critiques (from the escalation records, and
//                         the final verdict) plus the cycle review's, when `review` is given
//   provider_calls, by_outcome   from run.attempts (every provider call, failed ones included)
//   tokens_in/out         sums only when every attempt reported usage; else null, with `missing`
//   usd                   null unless every attempt states its cost
//   elapsed_ms            run.started_at -> run.finished_at
//   escalations           by decision action (raise_effort, raise_output, step_rung, stop, ...)
//   fallbacks             turns answered by a candidate of rank > 0 (selection.rank)
//   retries               failed attempts followed by an attempt of the same purpose on the same seat
//   coordination_overhead non-work provider calls (plan, critique, scout) / all calls
//   profile, policy_hash, practice    from the turns' selection records
//   operating_points      per turn: purpose, vendor, model, effort (as sent), class (fit), rank
//   stakes                the selection's task profile stakes; for a profile that records none (argo,
//                         legacy), derived with taskProfile on the ticket (or the run's files)
//   calls_per_accept, tokens_per_accept   per accepted run (tokens only when usage is complete)
//
// aggregate(rows) -> per profile, per stakes stratum (and `all`): counts, accepted and first_pass rates
// with Wilson 95% intervals, medians of calls/tokens/elapsed per accept, and `insufficient` with the
// minimum n not yet met (MIN_N_PER_STRATUM per arm per stratum).
import { taskProfile } from "../route/task-profile.mjs";

export const METRICS_SCHEMA = "pantheon.practice-metrics/v1";
/** The minimum number of runs per arm per stakes stratum before a rate is treated as more than anecdote. */
export const MIN_N_PER_STRATUM = 20;
export const ESCALATION_ACTIONS = Object.freeze(["raise_effort", "raise_output", "step_rung", "stop"]);
const WORK_PURPOSES = new Set(["work"]);
const COORDINATION_PURPOSES = new Set(["plan", "critique", "scout"]);
const Z95 = 1.959963984540054;

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const v = (value, n, extra = {}) => ({ value, n, ...extra });
const costOf = a => num(a?.usd) ?? num(a?.cost_usd) ?? num(a?.cost?.usd);

/** The stakes stratum of a run: the selection's recorded task profile, else derived from the ticket. */
export function stakesOf(run, ticket = null) {
  const rec = (run?.turns ?? []).map(t => t.selection?.task?.stakes).find(s => s?.value);
  if (rec) return { value: rec.value, basis: rec.basis ?? "selection" };
  const paths = ticket ? [ticket.path, ...(ticket.slots ?? []).map(s => s.path)].filter(Boolean) : (run?.files ?? []).map(f => f.path).filter(Boolean);
  try {
    const p = taskProfile(ticket ?? {}, { paths });
    return { value: p.stakes.value, basis: `taskProfile:${p.stakes.basis}` };
  } catch { return { value: null, basis: "unobservable" }; }
}

/** A row for a run that produced no record (the runner failed): everything unobserved. */
export function unobservedRun({ profile = null, why = "no run record", review = null, stakes = { value: null, basis: "unobservable" } } = {}) {
  return { schema: METRICS_SCHEMA, profile, status: "inconclusive", why: String(why).slice(0, 300), policy_hash: null, practice: null, stakes,
    accepted: null, shipped: null, gates: null, first_pass: null, revisions: v(null, 0), revisions_to_accept: null,
    review_rejections: v(null, 0), provider_calls: v(null, 0), provider_call_limit: null, bound_hit: null, by_outcome: {}, failed_attempts: v(null, 0),
    retries: v(null, 0), fallbacks: v(null, 0), escalations: v(null, 0, { by_action: {} }),
    tokens_in: v(null, 0, { missing: null }), tokens_out: v(null, 0, { missing: null }), usage_complete: false,
    usd: v(null, 0, { missing: null, basis: "unknown: no run record" }), elapsed_ms: v(null, 0), coordination_overhead: v(null, 0, { calls: null }),
    coordination: { scout_turns: null, review_turns: null, cycle_review: review }, operating_points: [], calls_per_accept: null, tokens_per_accept: null };
}

function recoveries(attempts) {
  let retries = 0;
  attempts.forEach((a, i) => {
    if (a.outcome === "ok") return;
    const next = attempts.slice(i + 1).find(b => b.purpose === a.purpose);
    if (next && next.vendor === a.vendor && next.model === a.model && (next.pool ?? next.vendor) === (a.pool ?? a.vendor)) retries++;
  });
  return retries;
}

/** One run's metrics. `review`: an independent cycle review's summary ({verdicts: [...]} or {reviews, approvals}). */
export function runMetrics(run, { review = null, ticket = null, result = null, profile = null } = {}) {
  if (!run || typeof run !== "object") return unobservedRun({ profile, review, why: result?.error?.message ?? "no run record", stakes: stakesOf(null, ticket) });
  const attempts = run.attempts ?? [], turns = run.turns ?? [];
  const sel = turns.map(t => t.selection).find(s => s?.profile) ?? null;
  const by_outcome = {};
  for (const a of attempts) by_outcome[a.outcome] = (by_outcome[a.outcome] ?? 0) + 1;
  const missingUsage = attempts.filter(a => num(a.usage?.input_tokens) === null || num(a.usage?.output_tokens) === null).length;
  const usage_complete = attempts.length > 0 && missingUsage === 0;
  const sum = k => attempts.reduce((n, a) => n + num(a.usage[k]), 0);
  const missingCost = attempts.filter(a => costOf(a) === null).length;
  const usd = attempts.length > 0 && missingCost === 0 ? attempts.reduce((n, a) => n + costOf(a), 0) : null;
  const gates = Array.isArray(run.gates) ? Object.fromEntries(run.gates.map(g => [g.gate, g.ok === true])) : null;
  const bound_hit = Boolean(run.provider_calls?.refused);
  const shipped = run.shipped === true && result?.shipped !== false;
  const decided = shipped || !bound_hit;
  const accepted = decided ? shipped && gates?.REVIEW === true : null;
  const revisions = Array.isArray(run.revisions) ? run.revisions.length : num(run.acceptance?.revisions);
  const status = accepted === true ? "accepted" : accepted === null ? "inconclusive"
    : result?.error && result.error.stage !== "ship" ? "failed" : "not_accepted";
  const why = accepted === true ? null : bound_hit ? `the declared provider-call bound refused a call (${run.provider_calls.refused.code ?? "PROVIDER_CALL_LIMIT"})`
    : result?.error ? `${result.error.stage}: ${String(result.error.message ?? "").slice(0, 300)}` : run.ship_why ?? (run.shipped ? null : "not shipped");
  // In-run critique rejections: each non-approve critique the protocol recorded, and the final verdict when none was.
  const critiques = (run.escalations ?? []).filter(e => e.outcome?.kind === "critique");
  const inRun = critiques.filter(e => e.outcome.verdict !== "approve").length
    || (run.review?.verdict && run.review.verdict !== "approve" ? 1 : 0);
  const reviewSeen = critiques.length + (run.review?.verdict ? 1 : 0) > 0;
  const cycleVerdicts = review ? (review.verdicts ?? (review.reviews != null && review.approvals != null ? null : [])) : null;
  const cycleRejections = !review ? 0 : cycleVerdicts ? cycleVerdicts.filter(x => x !== "approve").length : (review.reviews - review.approvals);
  const by_action = {};
  for (const e of run.escalations ?? []) { const a = e.decision?.action; if (a) by_action[a] = (by_action[a] ?? 0) + 1; }
  for (const a of ESCALATION_ACTIONS) by_action[a] ??= 0;
  const answered = turns.filter(t => Number.isInteger(t.selection?.rank));
  const coordinationCalls = attempts.filter(a => COORDINATION_PURPOSES.has(a.purpose)).length;
  const started = Date.parse(run.started_at ?? ""), finished = Date.parse(run.finished_at ?? "");
  const elapsed = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null;
  const tokens = usage_complete ? sum("input_tokens") + sum("output_tokens") : null;
  return {
    schema: METRICS_SCHEMA, profile: profile ?? sel?.profile ?? null, recorded_profile: sel?.profile ?? null, status, why, policy_hash: sel?.policy_hash ?? null,
    practice: sel?.practice ? { disposition: sel.practice.disposition ?? null, outcome: sel.practice.outcome ?? null, policy_hash: sel.practice.policy?.hash ?? null,
      provisional: sel.practice.provisional ?? null, applies: sel.practice.applies ?? null } : null,
    stakes: stakesOf(run, ticket),
    accepted, shipped, gates, first_pass: accepted === null ? null : accepted && revisions === 1,
    revisions: v(revisions, revisions === null ? 0 : 1), revisions_to_accept: accepted ? revisions : null,
    review_rejections: v(reviewSeen || review ? inRun + cycleRejections : null, critiques.length + (review ? (cycleVerdicts?.length ?? review.reviews ?? 0) : 0),
      { in_run: reviewSeen ? inRun : null, cycle: review ? cycleRejections : null }),
    provider_calls: v(attempts.length, attempts.length), provider_call_limit: run.provider_calls?.limit ?? null, bound_hit, by_outcome,
    failed_attempts: v(attempts.filter(a => a.outcome !== "ok").length, attempts.length),
    retries: v(recoveries(attempts), attempts.length),
    fallbacks: v(answered.length ? answered.filter(t => t.selection.rank > 0).length : null, answered.length),
    escalations: v((run.escalations ?? []).length, (run.escalations ?? []).length, { by_action }),
    tokens_in: v(usage_complete ? sum("input_tokens") : null, attempts.length - missingUsage, { missing: missingUsage }),
    tokens_out: v(usage_complete ? sum("output_tokens") : null, attempts.length - missingUsage, { missing: missingUsage }),
    usage_complete,
    usd: v(usd, attempts.length - missingCost, { missing: missingCost,
      basis: usd === null ? (run.resources?.usd_basis ?? "unknown: not every attempt states its cost") : "every attempt states its cost" }),
    elapsed_ms: v(elapsed, elapsed === null ? 0 : 1),
    coordination_overhead: v(attempts.length ? coordinationCalls / attempts.length : null, attempts.length, { calls: coordinationCalls }),
    coordination: { scout_turns: turns.filter(t => t.purpose === "scout").length, review_turns: turns.filter(t => t.purpose === "critique").length, cycle_review: review },
    operating_points: turns.map(t => ({ purpose: t.purpose ?? null, vendor: t.vendor ?? null, model: t.settings?.model ?? t.model ?? null,
      effort: t.settings ? t.settings.effort ?? null : t.selection?.effort?.value ?? null, effort_basis: t.settings?.basis ?? (t.selection?.effort ? "selected" : null),
      class: t.selection?.class?.value ?? null, rank: Number.isInteger(t.selection?.rank) ? t.selection.rank : null })),
    calls_per_accept: accepted ? attempts.length : null,
    tokens_per_accept: accepted ? tokens : null,
  };
}

/** Wilson score interval (95%) for k successes in n trials; null when n is 0. */
export function wilson(k, n, z = Z95) {
  if (!n) return null;
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
export function median(xs) {
  const s = xs.filter(x => num(x) !== null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const rate = (rows, key) => {
  const decided = rows.filter(r => r[key] !== null && r[key] !== undefined);
  const k = decided.filter(r => r[key] === true).length;
  return { count: k, n: decided.length, rate: decided.length ? k / decided.length : null, wilson95: wilson(k, decided.length) };
};
const med = xs => { const vals = xs.filter(x => num(x) !== null); return { value: median(vals), n: vals.length }; };

function stratum(rows, minN) {
  const accepted = rows.filter(r => r.accepted === true);
  const sumKnown = k => rows.reduce((n, r) => n + (num(r[k]?.value) ?? 0), 0);
  const by_outcome = {}, by_action = {};
  for (const r of rows) {
    for (const [k, n] of Object.entries(r.by_outcome ?? {})) by_outcome[k] = (by_outcome[k] ?? 0) + n;
    for (const [k, n] of Object.entries(r.escalations?.by_action ?? {})) by_action[k] = (by_action[k] ?? 0) + n;
  }
  const n = rows.length;
  return {
    n,
    status: Object.fromEntries(["accepted", "not_accepted", "failed", "inconclusive"].map(s => [s, rows.filter(r => r.status === s).length])),
    accepted: rate(rows, "accepted"),
    first_pass: rate(rows, "first_pass"),
    provider_calls: { value: sumKnown("provider_calls"), n: rows.filter(r => r.provider_calls?.value !== null).length },
    by_outcome, escalations: by_action,
    fallbacks: { value: sumKnown("fallbacks"), n: rows.filter(r => r.fallbacks?.value !== null).length },
    retries: { value: sumKnown("retries"), n: rows.filter(r => r.retries?.value !== null).length },
    review_rejections: { value: sumKnown("review_rejections"), n: rows.filter(r => r.review_rejections?.value !== null).length },
    usage_complete: rows.every(r => r.usage_complete === true),
    tokens_in: rows.every(r => r.tokens_in?.value !== null) ? { value: sumKnown("tokens_in"), n } : { value: null, n: rows.filter(r => r.tokens_in?.value !== null).length, missing: rows.filter(r => r.tokens_in?.value === null).length },
    tokens_out: rows.every(r => r.tokens_out?.value !== null) ? { value: sumKnown("tokens_out"), n } : { value: null, n: rows.filter(r => r.tokens_out?.value !== null).length, missing: rows.filter(r => r.tokens_out?.value === null).length },
    usd: rows.length && rows.every(r => r.usd?.value !== null) ? { value: sumKnown("usd"), n } : { value: null, n: rows.filter(r => r.usd?.value !== null).length, missing: rows.filter(r => r.usd?.value === null).length },
    median_calls_per_accept: med(accepted.map(r => r.calls_per_accept)),
    median_tokens_per_accept: med(accepted.map(r => r.tokens_per_accept)),
    median_elapsed_ms_per_accept: med(accepted.map(r => r.elapsed_ms?.value)),
    median_coordination_overhead: med(rows.map(r => r.coordination_overhead?.value)),
    insufficient: n < minN, min_n: minN, needed: Math.max(0, minN - n),
  };
}

/** Per profile, per stakes stratum and `all`. */
export function aggregate(rows, { minN = MIN_N_PER_STRATUM } = {}) {
  const out = {};
  for (const profile of [...new Set(rows.map(r => r.profile ?? "unknown"))]) {
    const mine = rows.filter(r => (r.profile ?? "unknown") === profile);
    const strata = {};
    for (const s of [...new Set(mine.map(r => r.stakes?.value ?? "unknown"))]) strata[s] = stratum(mine.filter(r => (r.stakes?.value ?? "unknown") === s), minN);
    out[profile] = { all: stratum(mine, minN), strata };
  }
  return out;
}
