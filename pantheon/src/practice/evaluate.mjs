// Continuous evaluation of routing profiles over the runs that happen anyway (docs/reviews/2026-11-17-
// routing-evaluation/DESIGN.md steps 3-5; docs/routing-task-profile.md, "Continuous evaluation"). Pure over
// the run records it is given; it calls no provider and spends nothing.
//
//   evaluate({runs}) -> {schema: pantheon.evaluation/v1, synthetic, strata, halted, outcome, measured, shadow, ..., digest}
//
// `runs` is a directory (an evidence store: boards or copies, every run.json under it), one run.json path,
// a run object, or a list of any of these. Each run with a RANDOMIZED interleaved assignment (assign.mjs) is
// one runMetrics row (metrics.mjs, the definitions the matched comparison uses), stratified by the stakes its
// assignment recorded, and aggregate()d per arm. Every other run (an explicit --profile, an ineligible or
// halted stratum, no assignment at all) is listed as excluded with the reason: an arm somebody chose is not
// evidence about the arm. The shadow selections of EVERY run (run-item.mjs: what the other profile would have
// seated) are summarised as a disagreement map; agreement there says nothing about quality.
//
// Per stakes stratum (fit - argo, p = proportion):
//   halted               after STOP_MIN_N decided runs per arm, if the upper STOP_CONFIDENCE bound of the
//                        accepted difference is <= -STOP_MARGIN. The stratum's outcome is `retain` and the
//                        assignment stops interleaving it (assignArm returns argo, `stratum halted by the stop rule`).
//   insufficient_evidence  until MIN_N decided runs per arm.
//   propose_policy       only if fit is non-inferior on accepted AND first_pass (the lower PROMOTION_CONFIDENCE
//                        bound of the difference >= -NONINFERIORITY_MARGIN) AND its median calls, tokens or
//                        elapsed per accept is lower on at least one, with none worse by more than its
//                        COST_WORSE_MARGIN. A median that is not known for EVERY accepted run of both arms
//                        (tokens without complete usage) is `unknown`: never cheaper, never worse.
//   retain               otherwise.
// Intervals: Newcombe's hybrid score interval for a difference of proportions (method 10), from Wilson bounds.
//
// REPEATED LOOKS. This rule is applied at every cycle close to a growing sample, so a 95% interval looked at
// again and again would declare a difference by chance far more often than 5% of the time. Both decisions
// that change something (the stop rule and a policy proposal) therefore use 99% intervals (z = 2.576): a
// simple conservative alpha per look, not a formal alpha-spending boundary. It is a named constant; the
// owner may tighten it. The consequence is stated plainly: at 99%, even when both arms accept every ticket,
// non-inferiority within 5 points needs about 126 decided runs per arm, so `propose_policy` is unreachable at
// MIN_N alone. MIN_N is a floor below which nothing is claimed, not a sample size that decides.
//
// The overall outcome (what an automatic cycle assessment records): propose_policy if any stratum proposes,
// else retain if any stratum retains (halted included), else insufficient_evidence. It is never `promote`: a
// promote is a candidate disposition by an independent seat of another lab than the proposer's (C3), and the
// ledger refuses one resting on synthetic evidence. A record is synthetic iff any included run's providers
// were not declared live (run.json `providers.kind`; a run that declares none counts as synthetic).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { canonical } from "../../../packages/ledger/canonical.mjs";
import { runMetrics, aggregate, wilson, MIN_N_PER_STRATUM } from "./metrics.mjs";
import { BASELINE_ARM, CANDIDATE_ARM } from "./assign.mjs";
import { EVALUATION_SCHEMA, currentPolicy } from "../ledger/practice-kinds.mjs";

export { EVALUATION_SCHEMA };
// Every threshold is PROVISIONAL and named; DESIGN.md gives 20, 5 and 10.
export const MIN_N = MIN_N_PER_STRATUM;
export const NONINFERIORITY_MARGIN = 0.05;
export const STOP_MARGIN = 0.10;
export const STOP_MIN_N = 10;
/** Confidence per look (see REPEATED LOOKS above). */
export const PROMOTION_CONFIDENCE = 0.99;
export const STOP_CONFIDENCE = 0.99;
/** How much higher than argo's a fit median may be before it counts as worse (relative). */
export const COST_WORSE_MARGIN = Object.freeze({ calls: 0.10, tokens: 0.10, elapsed_ms: 0.25 });
/** The seat that authored the `fit` candidate (commits 6c0c12f, 26cbdcb), named as a proposal's proposer. */
export const FIT_PROPOSER = Object.freeze({ vendor: "anthropic", model: "claude-opus-5-5", lab: "anthropic" });
export const Z = Object.freeze({ 0.9: 1.6448536269514722, 0.95: 1.959963984540054, 0.99: 2.5758293035489004, 0.995: 2.807033768343811, 0.999: 3.2905267314919255 });
const zOf = c => { if (!Z[c]) throw new Error(`evaluate: no z for confidence ${c} (known: ${Object.keys(Z).join(", ")})`); return Z[c]; };

const sha = v => "sha256:" + createHash("sha256").update(v).digest("hex");
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Newcombe's hybrid score interval for p1 - p2, from Wilson bounds at `z`; null when either n is 0. */
export function newcombe(k1, n1, k2, n2, z = Z[0.95]) {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1, p2 = k2 / n2, [l1, u1] = wilson(k1, n1, z), [l2, u2] = wilson(k2, n2, z), d = p1 - p2;
  return [d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2), d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)];
}

/** The evidence store a board run deposits into: a configured path, else `<the ledger's directory>/../runs`. */
export function defaultEvidenceStore({ ledgerRoot = process.env.OPHANIM_LEDGER ?? null, configured = process.env.PANTHEON_EVIDENCE_STORE ?? null } = {}) {
  if (configured) return resolve(configured);
  if (ledgerRoot) return join(dirname(resolve(ledgerRoot)), "runs");
  return null;
}

const SKIP = new Set(["node_modules", ".git", "worktree", "seats", "evaluations", "ledger", "outputs"]);
function runFiles(dir, depth = 0, out = []) {
  if (depth > 6) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (!SKIP.has(name)) runFiles(p, depth + 1, out); }
    else if (name === "run.json") out.push(p);
  }
  return out;
}
/** Every run record a source names: [{run, source}] (unreadable files are reported, not dropped silently). */
export function loadRuns(source) {
  const out = [], unreadable = [];
  const add = s => {
    if (s === null || s === undefined) return;
    if (Array.isArray(s)) { s.forEach(add); return; }
    if (typeof s === "object") { out.push({ run: s.run ?? s, source: s.source ?? null }); return; }
    const p = resolve(String(s));
    if (!existsSync(p)) { unreadable.push({ source: p, why: "does not exist" }); return; }
    const files = statSync(p).isDirectory() ? runFiles(p) : [p];
    for (const f of files) {
      try { out.push({ run: JSON.parse(readFileSync(f, "utf8")), source: f }); } catch (e) { unreadable.push({ source: f, why: e.message }); }
    }
  };
  add(source);
  return { runs: out, unreadable };
}

const identity = run => ({ key: run?.key ?? null, started_at: run?.started_at ?? null, ticket_cid: run?.ticket_cid ?? null });
const syntheticRun = run => run?.providers?.kind !== "live";

function costComparison(F, A) {
  const out = {};
  const spec = { calls: "median_calls_per_accept", tokens: "median_tokens_per_accept", elapsed_ms: "median_elapsed_ms_per_accept" };
  for (const [k, field] of Object.entries(spec)) {
    const f = F[field], a = A[field];
    // Known only when every accepted run of both arms has the value: a median over a usage-complete subset is
    // not a median of the arm, so unknown usage can never make an arm look cheaper.
    const known = num(f?.value) !== null && num(a?.value) !== null && f.n === F.accepted.count && a.n === A.accepted.count && f.n > 0 && a.n > 0;
    const status = !known ? "unknown" : f.value < a.value ? "lower" : f.value > a.value * (1 + COST_WORSE_MARGIN[k]) ? "worse" : "not_lower";
    out[k] = { fit: f?.value ?? null, argo: a?.value ?? null, n_fit: f?.n ?? 0, n_argo: a?.n ?? 0, margin: COST_WORSE_MARGIN[k], status };
  }
  return out;
}

function decide(F, A) {
  const nF = F.accepted.n, nA = A.accepted.n, n = Math.min(nF, nA);
  const zs = zOf(STOP_CONFIDENCE), zp = zOf(PROMOTION_CONFIDENCE);
  const stop = newcombe(F.accepted.count, nF, A.accepted.count, nA, zs);
  const acc = newcombe(F.accepted.count, nF, A.accepted.count, nA, zp);
  const fp = newcombe(F.first_pass.count, F.first_pass.n, A.first_pass.count, A.first_pass.n, zp);
  const cost = costComparison(F, A);
  const rates = { accepted: { fit: F.accepted.rate, argo: A.accepted.rate, diff_ci: acc, stop_ci: stop },
    first_pass: { fit: F.first_pass.rate, argo: A.first_pass.rate, diff_ci: fp } };
  const base = { n: { fit: nF, argo: nA }, rates, cost };
  if (n >= STOP_MIN_N && stop && stop[1] <= -STOP_MARGIN) {
    return { ...base, outcome: "retain", halted: true, sufficient: n >= MIN_N,
      why: `stop rule: the upper ${STOP_CONFIDENCE * 100}% bound of fit - argo accepted is ${stop[1].toFixed(3)} <= -${STOP_MARGIN} after ${n} decided runs per arm; interleaving stops for this stratum` };
  }
  if (n < MIN_N) return { ...base, outcome: "insufficient_evidence", halted: false, sufficient: false, why: `${n} decided runs in the smaller arm; ${MIN_N} per arm are needed (${MIN_N - n} more)` };
  const nonInferior = acc[0] >= -NONINFERIORITY_MARGIN && fp && fp[0] >= -NONINFERIORITY_MARGIN;
  const lower = Object.entries(cost).filter(([, c]) => c.status === "lower").map(([k]) => k);
  const worse = Object.entries(cost).filter(([, c]) => c.status === "worse").map(([k]) => k);
  if (nonInferior && lower.length && !worse.length) {
    return { ...base, outcome: "propose_policy", halted: false, sufficient: true,
      why: `fit is non-inferior (lower ${PROMOTION_CONFIDENCE * 100}% bounds: accepted ${acc[0].toFixed(3)}, first_pass ${fp[0].toFixed(3)} >= -${NONINFERIORITY_MARGIN}) and lower on ${lower.join(", ")}, worse on none` };
  }
  const reasons = [];
  if (acc[0] < -NONINFERIORITY_MARGIN) reasons.push(`accepted lower bound ${acc[0].toFixed(3)} < -${NONINFERIORITY_MARGIN}`);
  if (!fp || fp[0] < -NONINFERIORITY_MARGIN) reasons.push(`first_pass lower bound ${fp ? fp[0].toFixed(3) : "unknown"} < -${NONINFERIORITY_MARGIN}`);
  if (!lower.length) reasons.push("lower on no known cost (calls, tokens, elapsed per accept)");
  if (worse.length) reasons.push(`worse on ${worse.join(", ")} beyond the margin`);
  return { ...base, outcome: "retain", halted: false, sufficient: true, why: `argo retained: ${reasons.join("; ")}` };
}

function shadowMap(runs) {
  const by_role = {};
  let turns = 0, agree = 0, disagree = 0, unavailable = 0;
  for (const { run } of runs) for (const t of run?.turns ?? []) {
    const s = t.selection;
    if (!s?.shadow) continue;
    const role = s.role ?? t.purpose ?? "unknown", r = (by_role[role] ??= { turns: 0, agree: 0, disagree: 0, unavailable: 0, pairs: {} });
    turns++; r.turns++;
    if (s.agrees === true) { agree++; r.agree++; }
    else if (s.agrees === false) {
      disagree++; r.disagree++;
      const pair = `${s.profile}:${t.vendor}/${t.model} vs ${s.shadow.profile}:${s.shadow.vendor}/${s.shadow.model}`;
      r.pairs[pair] = (r.pairs[pair] ?? 0) + 1;
    } else { unavailable++; r.unavailable++; }
  }
  return { turns, agree, disagree, unavailable, by_role, note: "the seat the other profile would have chosen: a disagreement map, not a quality measure" };
}

/** The evaluation over `runs` (see the header). `at` is recorded when given; the digest covers it. */
export function evaluate({ runs, baseline = BASELINE_ARM, candidate = CANDIDATE_ARM, at = null, pools = [] } = {}) {
  const loaded = loadRuns(runs);
  const seen = new Set(), included = [], excluded = [];
  for (const r of loaded.runs) {
    const id = identity(r.run), k = canonical(id);
    if (seen.has(k)) { excluded.push({ ...id, why: "duplicate of a run already read" }); continue; }
    seen.add(k);
    const a = r.run?.assignment;
    if (!a?.randomized) { excluded.push({ ...id, why: a ? `not randomized (${a.basis})` : "no interleaved assignment recorded" }); continue; }
    if (![baseline, candidate].includes(a.arm)) { excluded.push({ ...id, why: `arm ${a.arm} is neither ${baseline} nor ${candidate}` }); continue; }
    const row = runMetrics(r.run, { profile: a.arm });
    if (row.recorded_profile !== null && row.recorded_profile !== a.arm) { excluded.push({ ...id, why: `assigned ${a.arm} but dispatched ${row.recorded_profile}` }); continue; }
    if (a.stakes) row.stakes = { value: a.stakes, basis: "assignment" };
    included.push({ ...r, row, synthetic: syntheticRun(r.run) });
  }
  const g = aggregate(included.map(x => x.row));
  const strataNames = [...new Set(included.map(x => x.row.stakes?.value ?? "unknown"))].sort();
  const strata = {};
  for (const s of strataNames) {
    const F = g[candidate]?.strata[s], A = g[baseline]?.strata[s];
    if (!F || !A) {
      strata[s] = { outcome: "insufficient_evidence", halted: false, sufficient: false, n: { fit: F?.accepted.n ?? 0, argo: A?.accepted.n ?? 0 },
        why: `no ${!F ? candidate : baseline} runs in this stratum` };
      continue;
    }
    strata[s] = decide(F, A);
  }
  const halted = strataNames.filter(s => strata[s].halted);
  const any = o => strataNames.filter(s => strata[s].outcome === o);
  const outcome = any("propose_policy").length ? "propose_policy" : any("retain").length ? "retain" : "insufficient_evidence";
  const deciding = outcome === "insufficient_evidence" ? [] : any(outcome);
  const synthetic = included.length === 0 || included.some(x => x.synthetic);
  const record = {
    schema: EVALUATION_SCHEMA, synthetic,
    providers: [...new Set(included.map(x => x.run?.providers?.kind ?? "undeclared"))].sort(),
    baseline: { profile: baseline, policy: currentPolicy(baseline, { pools }) },
    candidate: { profile: candidate, policy: currentPolicy(candidate, { pools }) },
    thresholds: { MIN_N, NONINFERIORITY_MARGIN, STOP_MARGIN, STOP_MIN_N, PROMOTION_CONFIDENCE, STOP_CONFIDENCE, COST_WORSE_MARGIN, interval: "Newcombe hybrid score (Wilson bounds)" },
    runs: included.map(x => ({ ...identity(x.run), arm: x.run.assignment.arm, stakes: x.row.stakes.value, accepted: x.row.accepted, first_pass: x.row.first_pass, synthetic: x.synthetic })),
    excluded, unreadable: loaded.unreadable.length,
    aggregate: g,
    strata, halted, outcome, deciding_strata: deciding,
    measured: deciding.length > 0 && deciding.every(s => strata[s].sufficient),
    shadow: shadowMap(loaded.runs),
    interpretation: synthetic
      ? "SYNTHETIC: at least one included run did not declare live providers. This verifies the evaluation mechanics only; a promote may not rest on it."
      : "LIVE: every included run declared live providers. A proposal still needs an independent other-lab reviewer before any promote.",
    at,
  };
  return { ...record, digest: evaluationDigest(record) };
}

export const evaluationDigest = record => { const { digest: _, ...rest } = record; return sha(canonical(rest)); };
/** The citation a practice disposition carries for an evaluation record. */
export const evaluationEvidence = record => ({ kind: "digest", schema: EVALUATION_SCHEMA, sha: record.digest, synthetic: record.synthetic });

/**
 * The practice assessment a cycle close records from an evaluation when none was stated (audit C3). `policy`
 * is the cycle's policy in effect. Never a promote: the strongest automatic outcome is `propose_policy`, which
 * names `fit` as the candidate and FIT_PROPOSER (configurable) as its proposer, so that a promote of it must
 * come from a seat of another lab. On a cycle whose policy in effect is the candidate's own (a fit-arm run),
 * neither propose_policy (the candidate would be the policy in effect) nor retain (it would admit fit for fit)
 * says what the evaluation found, so it is recorded as propose_measurement: interleaving continues, and the
 * evaluation's own outcome is in the question and in the cited record.
 */
export function automaticAssessment(record, { policy, proposer = FIT_PROPOSER, pools = [] } = {}) {
  const strata = Object.entries(record.strata).map(([s, x]) => `${s}: ${x.outcome}${x.halted ? " (halted)" : ""} (n fit ${x.n.fit}, argo ${x.n.argo})`).join("; ") || "no interleaved runs yet";
  const onBaseline = policy?.profile === record.baseline.profile;
  let outcome = record.outcome;
  if (!onBaseline && outcome !== "insufficient_evidence") outcome = "propose_measurement";
  const measured = outcome !== "propose_measurement" && record.measured;
  const question = `continuous evaluation: does ${record.candidate.profile} match ${record.baseline.profile} on accepted and first-pass results, at lower calls, tokens or elapsed per accept, by stakes stratum? ` +
    `Evaluation ${record.digest.slice(0, 19)} says ${record.outcome}${record.halted.length ? `; halted: ${record.halted.join(", ")}` : ""} [${strata}]` +
    (outcome !== record.outcome ? `; recorded as ${outcome} because this cycle's policy in effect is ${policy?.profile}, not the baseline` : "") +
    (record.synthetic ? "; SYNTHETIC evidence" : "");
  const out = { outcome, question: question.slice(0, 2000), measured, provisional: !measured, evidence: [evaluationEvidence(record)],
    provenance: { by: { role: "controller" }, method: "automatic continuous evaluation (pantheon/src/practice/evaluate.mjs) over the evidence store" } };
  if (outcome === "propose_policy") {
    out.candidate = { id: `${record.candidate.profile}-strata-${record.deciding_strata.join("-")}`, policy: currentPolicy(record.candidate.profile, { pools }),
      change: `route ${record.deciding_strata.join(", ")} stakes tickets with ${record.candidate.profile} instead of ${record.baseline.profile} (evaluation ${record.digest.slice(0, 19)})` };
    out.proposer = { ...proposer };
  }
  return out;
}
