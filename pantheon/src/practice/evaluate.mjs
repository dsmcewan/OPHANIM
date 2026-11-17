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
// PAIRED RUNS (owner decision 2026-11-17). A sampled ticket (assign.mjs pairFor) is also run under the other
// profile as a dry counterpart (board/operate.mjs), and the evidence store holds a `pantheon.pair/v1` record
// for it (pairs/<pair_id>/pair.json beside primary.run.json and counterpart.run.json, digest-checked). Over the
// COMPLETED pairs of a stratum (a pair refused before its counterpart ran is listed, and is no outcome):
//   - a side is accepted iff its run was accepted (metrics.mjs); a side that failed, was refused by its bound,
//     or never produced a run is NOT accepted. Failures are outcomes, never dropped.
//   - the 2x2 table e (both accepted), f (fit only), g (argo only), h (neither), for accepted and first_pass;
//     the paired difference (f - g)/n with Newcombe's paired score interval (method 10; pairedNewcombe).
//   - cost: on pairs BOTH sides accepted (the cost of the same accepted outcome on the same ticket), the
//     per-pair differences fit - argo of calls, tokens and elapsed, only over pairs where both sides have the
//     value, with a Wilcoxon signed-rank test (exact up to WILCOXON_EXACT_MAX non-zero differences). A measure
//     is `lower` only if significantly lower at PAIRED_COST_ALPHA AND no pair lacks fit's value where argo's is
//     known (unknown never counts as cheaper); `worse` if significantly higher; `unknown` with no known pair.
//   - halted (stop rule) after PAIR_STOP_MIN_N pairs if the upper STOP_CONFIDENCE bound of the accepted
//     difference is <= -STOP_MARGIN: `retain`, interleaving of the stratum stops, and fit is flagged.
//   - insufficient_evidence until MIN_PAIRS pairs.
//   - propose_policy only if the lower PROMOTION_CONFIDENCE bounds of accepted AND first_pass are >=
//     -NONINFERIORITY_MARGIN and fit is significantly lower on at least one cost and significantly worse on none.
//   - retain otherwise. Each stratum also carries a power note (pairsNeeded): the pairs at which the interval
//     on the expected table (the observed cell proportions) would clear the margin, and a Wald approximation
//     for 80% power, at the observed discordance.
// When a stratum has completed pairs, the paired decision is the stratum's (`basis: paired`); the unpaired one
// is still reported under `unpaired`. A halt from either one halts the stratum (the conservative direction).
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
import { runMetrics, unobservedRun, aggregate, wilson, MIN_N_PER_STRATUM } from "./metrics.mjs";
import { BASELINE_ARM, CANDIDATE_ARM, PAIR_SCHEMA } from "./assign.mjs";
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

// ---------------------------------------------------------------- paired statistics

/** PROVISIONAL: the completed pairs per stratum below which nothing is claimed from pairs. */
export const MIN_PAIRS = 15;
/** PROVISIONAL: the completed pairs per stratum after which the paired stop rule may halt it. */
export const PAIR_STOP_MIN_N = 10;
/** Two-sided level of the Wilcoxon signed-rank test for a paired cost difference (1 - PROMOTION_CONFIDENCE). */
export const PAIRED_COST_ALPHA = 0.01;
/** Up to this many non-zero differences the signed-rank p-value is exact; above it, the normal approximation. */
export const WILCOXON_EXACT_MAX = 50;
/** Power used by the Wald approximation of the pairs needed (pairsNeeded). */
export const PAIRS_NEEDED_POWER = 0.8;
const Z_POWER_80 = 0.8416212335729143;

/**
 * Newcombe's score interval for the difference of two paired proportions, method 10: RG Newcombe, "Improved
 * confidence intervals for the difference between binomial proportions based on paired data", Statistics in
 * Medicine 1998;17:2635-2650 (Wilson intervals for each margin, combined with the phi coefficient, whose
 * numerator is continuity-corrected to max(eh - fg - n/2, 0) when eh > fg; phi = 0 when a margin is empty).
 * Cells: e both, f first only, g second only, h neither; the difference is (f - g)/n, first minus second.
 * Checked against the paper's Table III and StatsDirect's worked example (tests/practice-paired.test.mjs).
 * Counts may be non-integer (pairsNeeded projects expected tables). Null when n is 0.
 */
export function pairedNewcombe({ e = 0, f = 0, g = 0, h = 0 }, z = Z[0.95]) {
  const n = e + f + g + h;
  if (!(n > 0)) return null;
  const p1 = (e + f) / n, p2 = (e + g) / n;
  const [l1, u1] = wilson(e + f, n, z), [l2, u2] = wilson(e + g, n, z);
  let num = e * h - f * g;
  if (num > 0) num = Math.max(num - n / 2, 0);
  const den = Math.sqrt((e + f) * (g + h) * (e + g) * (f + h));
  const phi = den > 0 ? num / den : 0;
  const d = p1 - p2, dl1 = p1 - l1, du1 = u1 - p1, dl2 = p2 - l2, du2 = u2 - p2;
  const lo = d - Math.sqrt(Math.max(0, dl1 ** 2 - 2 * phi * dl1 * du2 + du2 ** 2));
  const hi = d + Math.sqrt(Math.max(0, du1 ** 2 - 2 * phi * du1 * dl2 + dl2 ** 2));
  return [Math.max(-1, lo), Math.min(1, hi)];
}

// The standard normal CDF, from erfc (W. J. Cody's rational Chebyshev form as in Numerical Recipes' erfcc;
// fractional error below 1.2e-7, ample for a p-value compared with 0.01).
function erfc(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398
    + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
const normalCdf = x => 0.5 * erfc(-x / Math.SQRT2);

/**
 * The Wilcoxon signed-rank test of paired differences (Wilcoxon 1945): zeros dropped (Wilcoxon's method),
 * |d| ranked with mid-ranks for ties, W+ the sum of the positive ranks. Exact (the permutation distribution of
 * the signs over the observed ranks, so ties are exact too) up to WILCOXON_EXACT_MAX non-zero differences, else
 * the normal approximation with the tie correction and a continuity correction. p_less is P(W+ <= observed)
 * (the differences tend negative), p_greater P(W+ >= observed), p_two_sided twice the smaller, at most 1.
 */
export function wilcoxonSignedRank(diffs) {
  const nz = diffs.filter(d => d !== 0), zeros = diffs.length - nz.length, n = nz.length;
  if (n === 0) return { n, zeros, w_plus: null, exact: true, p_less: null, p_greater: null, p_two_sided: null };
  const order = nz.map((d, i) => ({ a: Math.abs(d), pos: d > 0, i })).sort((x, y) => x.a - y.a);
  const rank2 = new Array(n); // doubled mid-ranks: integers
  const ties = [];
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && order[j + 1].a === order[i].a) j++;
    for (let k = i; k <= j; k++) rank2[k] = i + j + 2; // 2 * mid-rank of positions i..j (1-based)
    if (j > i) ties.push(j - i + 1);
    i = j + 1;
  }
  const w2 = order.reduce((s, o, k) => s + (o.pos ? rank2[k] : 0), 0);
  const w_plus = w2 / 2;
  let p_less, p_greater, exact = n <= WILCOXON_EXACT_MAX;
  if (exact) {
    const total = rank2.reduce((s, r) => s + r, 0);
    let dist = new Float64Array(total + 1); dist[0] = 1;
    for (const r of rank2) {
      const next = new Float64Array(total + 1);
      for (let s = 0; s <= total; s++) if (dist[s]) { next[s] += dist[s] / 2; next[s + r] += dist[s] / 2; }
      dist = next;
    }
    p_less = 0; p_greater = 0;
    for (let s = 0; s <= total; s++) { if (s <= w2) p_less += dist[s]; if (s >= w2) p_greater += dist[s]; }
  } else {
    const mean = n * (n + 1) / 4, sd = Math.sqrt(n * (n + 1) * (2 * n + 1) / 24 - ties.reduce((s, t) => s + (t ** 3 - t), 0) / 48);
    p_less = normalCdf((w_plus - mean + 0.5) / sd);
    p_greater = 1 - normalCdf((w_plus - mean - 0.5) / sd);
  }
  p_less = Math.min(1, p_less); p_greater = Math.min(1, p_greater);
  return { n, zeros, w_plus, exact, p_less, p_greater, p_two_sided: Math.min(1, 2 * Math.min(p_less, p_greater)) };
}

/**
 * A power note for a paired difference: at the observed cell proportions (and so the observed discordance and
 * difference), the smallest number of pairs at which the interval on the EXPECTED table clears the margin
 * (lower PROMOTION_CONFIDENCE bound >= -margin; about an even chance), and the Wald approximation for
 * PAIRS_NEEDED_POWER: n = (z_a + z_b)^2 (p_disc - d^2) / (d + margin)^2, with z_a the one-sided z of the lower
 * bound. Null when no number of pairs would clear it at the observed difference (d <= -margin), and the Wald
 * figure null when no discordance was observed (it is degenerate there).
 */
export function pairsNeeded({ e = 0, f = 0, g = 0, h = 0 }, { margin = NONINFERIORITY_MARGIN, confidence = PROMOTION_CONFIDENCE, limit = 1e6 } = {}) {
  const n0 = e + f + g + h;
  if (!n0) return { discordance: null, observed_diff: null, pairs_needed_at_observed: null, pairs_needed_80: null };
  const z = zOf(confidence), pe = e / n0, pf = f / n0, pg = g / n0, ph = h / n0, d = pf - pg, pdisc = pf + pg;
  const clears = n => { const ci = pairedNewcombe({ e: pe * n, f: pf * n, g: pg * n, h: ph * n }, z); return ci && ci[0] >= -margin; };
  let at = null;
  if (d > -margin) {
    let hi = 1;
    while (hi <= limit && !clears(hi)) hi *= 2;
    if (hi <= limit) { let lo = Math.floor(hi / 2); while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (clears(mid)) hi = mid; else lo = mid; } at = hi; }
  }
  const v = pdisc - d * d;
  const wald = d + margin > 0 && v > 0 ? Math.ceil((z + Z_POWER_80) ** 2 * v / (d + margin) ** 2) : null;
  return { discordance: pdisc, observed_diff: d, pairs_needed_at_observed: at, pairs_needed_80: wald };
}

/** The evidence store a board run deposits into: a configured path, else `<the ledger's directory>/../runs`. */
export function defaultEvidenceStore({ ledgerRoot = process.env.OPHANIM_LEDGER ?? null, configured = process.env.PANTHEON_EVIDENCE_STORE ?? null } = {}) {
  if (configured) return resolve(configured);
  if (ledgerRoot) return join(dirname(resolve(ledgerRoot)), "runs");
  return null;
}

const SKIP = new Set(["node_modules", ".git", "worktree", "seats", "evaluations", "ledger", "outputs"]);
// A pair directory holds primary.run.json and counterpart.run.json, which are not `run.json`: the walk reads a
// pair's runs only through its pair.json, and the primary is read (once) from its own board's deposit as well.
function runFiles(dir, depth = 0, out = [], pairs = []) {
  if (depth > 6) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (!SKIP.has(name)) runFiles(p, depth + 1, out, pairs); }
    else if (name === "run.json") out.push(p);
    else if (name === "pair.json") pairs.push(p);
  }
  return out;
}
const fileSha = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
/** A pair record read from disk, its two runs attached and digest-checked; or {why}. */
function readPair(file) {
  let rec;
  try { rec = JSON.parse(readFileSync(file, "utf8")); } catch (e) { return { why: e.message }; }
  if (rec?.schema !== PAIR_SCHEMA) return { why: `not a ${PAIR_SCHEMA} record` };
  const side = (s, name) => {
    if (!s?.run_digest) return { ok: true, run: null };
    const f = join(dirname(file), name);
    if (!existsSync(f)) return { why: `${name} is missing` };
    const bytes = readFileSync(f);
    if (fileSha(bytes) !== s.run_digest) return { why: `${name} is not the run the pair record names (digest)` };
    return { ok: true, run: JSON.parse(bytes.toString("utf8")) };
  };
  const p = side(rec.primary, "primary.run.json"), c = side(rec.counterpart, "counterpart.run.json");
  if (!p.ok || !c.ok) return { why: p.why ?? c.why };
  return { pair: { ...rec, primary: rec.primary && { ...rec.primary, run: p.run }, counterpart: rec.counterpart && { ...rec.counterpart, run: c.run } } };
}
/**
 * Every run record and pair record a source names: {runs: [{run, source}], pairs: [{pair, source}], unreadable}
 * (unreadable files are reported, not dropped silently). A pair's primary run is also a run of its own.
 */
export function loadRuns(source) {
  const out = [], pairs = [], unreadable = [];
  const add = s => {
    if (s === null || s === undefined) return;
    if (Array.isArray(s)) { s.forEach(add); return; }
    if (typeof s === "object") {
      if (s.schema === PAIR_SCHEMA) { pairs.push({ pair: s, source: null }); if (s.primary?.run) out.push({ run: s.primary.run, source: null, pairCopy: true }); return; }
      out.push({ run: s.run ?? s, source: s.source ?? null }); return;
    }
    const p = resolve(String(s));
    if (!existsSync(p)) { unreadable.push({ source: p, why: "does not exist" }); return; }
    const pairFiles = [];
    const files = statSync(p).isDirectory() ? runFiles(p, 0, [], pairFiles) : [p];
    for (const f of files) {
      try { out.push({ run: JSON.parse(readFileSync(f, "utf8")), source: f }); } catch (e) { unreadable.push({ source: f, why: e.message }); }
    }
    for (const f of pairFiles) {
      const r = readPair(f);
      if (r.why) { unreadable.push({ source: f, why: r.why }); continue; }
      pairs.push({ pair: r.pair, source: f });
      if (r.pair.primary?.run) out.push({ run: r.pair.primary.run, source: join(dirname(f), "primary.run.json"), pairCopy: true });
    }
  };
  add(source);
  return { runs: out, pairs, unreadable };
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

// ---------------------------------------------------------------- paired evaluation

const PAIR_COSTS = Object.freeze({ calls: r => r.provider_calls?.value, tokens: r => r.tokens_per_accept, elapsed_ms: r => r.elapsed_ms?.value });

/** The completed pairs as outcome rows, and the refused and invalid ones (listed, never outcomes). */
function pairRows(loaded, { baseline, candidate }) {
  const rows = [], refused = [], invalid = [], seen = new Set();
  for (const { pair, source } of loaded) {
    const id = pair.pair_id ?? null;
    if (id && seen.has(id)) { invalid.push({ pair_id: id, source, why: "duplicate of a pair already read" }); continue; }
    if (id) seen.add(id);
    if (pair.status === "refused") { refused.push({ pair_id: id, ticket: pair.ticket?.key ?? null, code: pair.refusal?.code ?? null, why: pair.refusal?.why ?? null }); continue; }
    const pp = pair.primary?.profile, cp = pair.counterpart?.profile;
    if (!pair.primary?.run) { invalid.push({ pair_id: id, source, why: "no primary run" }); continue; }
    if (![pp, cp].includes(baseline) || ![pp, cp].includes(candidate) || pp === cp) { invalid.push({ pair_id: id, source, why: `profiles ${pp} / ${cp} are not ${candidate} and ${baseline}` }); continue; }
    const prow = runMetrics(pair.primary.run, { profile: pp });
    // A counterpart that never produced a run is an outcome: not accepted, every value unknown.
    const crow = pair.counterpart.run ? runMetrics(pair.counterpart.run, { profile: cp })
      : unobservedRun({ profile: cp, why: pair.counterpart.error?.message ?? "the counterpart produced no run" });
    const fit = pp === candidate ? prow : crow, argo = pp === candidate ? crow : prow;
    const synth = (run, declared) => run ? syntheticRun(run) : declared?.kind !== "live";
    rows.push({ pair_id: id, ticket: pair.ticket?.key ?? null, stakes: pair.stakes ?? prow.stakes?.value ?? "unknown", primary: pp, fit, argo,
      synthetic: synth(pair.primary.run, null) || synth(pair.counterpart.run, pair.counterpart.providers),
      providers: [pair.primary.run?.providers?.kind ?? "undeclared", pair.counterpart.run?.providers?.kind ?? pair.counterpart.providers?.kind ?? "undeclared"] });
  }
  return { rows, refused, invalid };
}

const table = (rows, k) => {
  const t = { e: 0, f: 0, g: 0, h: 0 };
  for (const r of rows) { const a = r.fit[k] === true, b = r.argo[k] === true; t[a && b ? "e" : a ? "f" : b ? "g" : "h"]++; }
  return t;
};

function pairedCost(rows) {
  const both = rows.filter(r => r.fit.accepted === true && r.argo.accepted === true);
  const out = {};
  for (const [k, get] of Object.entries(PAIR_COSTS)) {
    const vals = both.map(r => ({ f: num(get(r.fit)), a: num(get(r.argo)) }));
    const known = vals.filter(v => v.f !== null && v.a !== null);
    const missing = { fit: vals.filter(v => v.f === null && v.a !== null).length, argo: vals.filter(v => v.a === null && v.f !== null).length, both: vals.filter(v => v.f === null && v.a === null).length };
    const diffs = known.map(v => v.f - v.a);
    const test = wilcoxonSignedRank(diffs);
    const median = diffs.length ? [...diffs].sort((x, y) => x - y)[Math.floor((diffs.length - 1) / 2)] : null;
    const sig = test.p_two_sided !== null && test.p_two_sided < PAIRED_COST_ALPHA;
    const down = sig && test.p_less < test.p_greater, up = sig && test.p_greater < test.p_less;
    // A gap on fit's side where argo's value is known could hide fit's expensive runs: never cheaper then.
    const status = !known.length ? "unknown" : up ? "worse" : down ? (missing.fit > 0 ? "unknown" : "lower") : "not_lower";
    out[k] = { n: known.length, pairs_both_accepted: both.length, missing, median_diff: median, test, status,
      ...(down && missing.fit > 0 ? { why: `significantly lower on the ${known.length} pairs with both values, but ${missing.fit} pair(s) lack fit's value` } : {}) };
  }
  return out;
}

function decidePaired(rows) {
  const n = rows.length, zs = zOf(STOP_CONFIDENCE), zp = zOf(PROMOTION_CONFIDENCE);
  const side = k => {
    const t = table(rows, k);
    return { table: t, discordant: { fit_only: t.f, argo_only: t.g }, fit: (t.e + t.f) / n, argo: (t.e + t.g) / n, diff: (t.f - t.g) / n,
      diff_ci: pairedNewcombe(t, zp), ...(k === "accepted" ? { stop_ci: pairedNewcombe(t, zs) } : {}) };
  };
  const accepted = side("accepted"), first_pass = side("first_pass"), cost = pairedCost(rows);
  const power = { accepted: pairsNeeded(accepted.table), first_pass: pairsNeeded(first_pass.table) };
  const base = { n, accepted, first_pass, cost, power, synthetic: rows.some(r => r.synthetic) };
  if (n >= PAIR_STOP_MIN_N && accepted.stop_ci[1] <= -STOP_MARGIN) {
    return { ...base, outcome: "retain", halted: true, sufficient: n >= MIN_PAIRS,
      why: `paired stop rule: the upper ${STOP_CONFIDENCE * 100}% bound of fit - argo accepted is ${accepted.stop_ci[1].toFixed(3)} <= -${STOP_MARGIN} after ${n} pairs (fit only ${accepted.table.f}, argo only ${accepted.table.g}); interleaving stops for this stratum and fit is flagged` };
  }
  if (n < MIN_PAIRS) return { ...base, outcome: "insufficient_evidence", halted: false, sufficient: false, why: `${n} completed pairs; ${MIN_PAIRS} pairs are needed (${MIN_PAIRS - n} more)` };
  const acc = accepted.diff_ci, fp = first_pass.diff_ci;
  const nonInferior = acc[0] >= -NONINFERIORITY_MARGIN && fp[0] >= -NONINFERIORITY_MARGIN;
  const lower = Object.entries(cost).filter(([, c]) => c.status === "lower").map(([k]) => k);
  const worse = Object.entries(cost).filter(([, c]) => c.status === "worse").map(([k]) => k);
  if (nonInferior && lower.length && !worse.length) {
    return { ...base, outcome: "propose_policy", halted: false, sufficient: true,
      why: `paired: fit is non-inferior (lower ${PROMOTION_CONFIDENCE * 100}% bounds: accepted ${acc[0].toFixed(3)}, first_pass ${fp[0].toFixed(3)} >= -${NONINFERIORITY_MARGIN}) over ${n} pairs and significantly lower on ${lower.join(", ")} (Wilcoxon, p < ${PAIRED_COST_ALPHA}), worse on none` };
  }
  const reasons = [];
  if (acc[0] < -NONINFERIORITY_MARGIN) reasons.push(`accepted lower bound ${acc[0].toFixed(3)} < -${NONINFERIORITY_MARGIN}`);
  if (fp[0] < -NONINFERIORITY_MARGIN) reasons.push(`first_pass lower bound ${fp[0].toFixed(3)} < -${NONINFERIORITY_MARGIN}`);
  if (!lower.length) reasons.push("significantly lower on no known cost (calls, tokens, elapsed on pairs both accepted)");
  if (worse.length) reasons.push(`significantly worse on ${worse.join(", ")}`);
  return { ...base, outcome: "retain", halted: false, sufficient: true, why: `paired, ${n} pairs: argo retained: ${reasons.join("; ")}` };
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
    if (seen.has(k)) { if (!r.pairCopy) excluded.push({ ...id, why: "duplicate of a run already read" }); continue; }
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
  const P = pairRows(loaded.pairs, { baseline, candidate });
  const pairedStrata = {};
  for (const s of [...new Set(P.rows.map(r => r.stakes))].sort()) pairedStrata[s] = decidePaired(P.rows.filter(r => r.stakes === s));
  const strataNames = [...new Set([...included.map(x => x.row.stakes?.value ?? "unknown"), ...Object.keys(pairedStrata)])].sort();
  const strata = {};
  for (const s of strataNames) {
    const F = g[candidate]?.strata[s], A = g[baseline]?.strata[s];
    const unpaired = !F || !A
      ? { outcome: "insufficient_evidence", halted: false, sufficient: false, n: { fit: F?.accepted.n ?? 0, argo: A?.accepted.n ?? 0 },
        why: `no ${!F ? candidate : baseline} runs in this stratum` }
      : decide(F, A);
    const paired = pairedStrata[s];
    if (!paired) { strata[s] = { ...unpaired, basis: "unpaired" }; continue; }
    // Paired evidence takes precedence; a halt from either comparison halts the stratum.
    const unpairedHalt = unpaired.halted && !paired.halted;
    strata[s] = { basis: "paired", outcome: unpairedHalt ? "retain" : paired.outcome, halted: paired.halted || unpaired.halted,
      sufficient: paired.sufficient, n: { fit: paired.n, argo: paired.n, pairs: paired.n },
      why: unpairedHalt ? `${unpaired.why} (paired, ${paired.n} pairs: ${paired.outcome})` : paired.why,
      rates: { accepted: { fit: paired.accepted.fit, argo: paired.accepted.argo, diff_ci: paired.accepted.diff_ci, stop_ci: paired.accepted.stop_ci },
        first_pass: { fit: paired.first_pass.fit, argo: paired.first_pass.argo, diff_ci: paired.first_pass.diff_ci } },
      paired, unpaired };
  }
  const halted = strataNames.filter(s => strata[s].halted);
  const flags = halted.map(s => ({ profile: candidate, stratum: s, basis: strata[s].basis, why: strata[s].basis === "paired" && strata[s].paired.halted ? strata[s].paired.why : strata[s].why }));
  const any = o => strataNames.filter(s => strata[s].outcome === o);
  const outcome = any("propose_policy").length ? "propose_policy" : any("retain").length ? "retain" : "insufficient_evidence";
  const deciding = outcome === "insufficient_evidence" ? [] : any(outcome);
  const synthetic = (included.length === 0 && P.rows.length === 0) || included.some(x => x.synthetic) || P.rows.some(r => r.synthetic);
  const record = {
    schema: EVALUATION_SCHEMA, synthetic,
    providers: [...new Set([...included.map(x => x.run?.providers?.kind ?? "undeclared"), ...P.rows.flatMap(r => r.providers)])].sort(),
    baseline: { profile: baseline, policy: currentPolicy(baseline, { pools }) },
    candidate: { profile: candidate, policy: currentPolicy(candidate, { pools }) },
    thresholds: { MIN_N, NONINFERIORITY_MARGIN, STOP_MARGIN, STOP_MIN_N, PROMOTION_CONFIDENCE, STOP_CONFIDENCE, COST_WORSE_MARGIN, interval: "Newcombe hybrid score (Wilson bounds)",
      MIN_PAIRS, PAIR_STOP_MIN_N, PAIRED_COST_ALPHA, WILCOXON_EXACT_MAX, paired_interval: "Newcombe paired score interval, method 10 (Stat Med 1998;17:2635)", paired_cost_test: "Wilcoxon signed-rank" },
    runs: included.map(x => ({ ...identity(x.run), arm: x.run.assignment.arm, stakes: x.row.stakes.value, accepted: x.row.accepted, first_pass: x.row.first_pass, synthetic: x.synthetic })),
    excluded, unreadable: loaded.unreadable.length,
    aggregate: g,
    strata, halted, flags, outcome, deciding_strata: deciding,
    paired: {
      pairs: P.rows.map(r => ({ pair_id: r.pair_id, ticket: r.ticket, stakes: r.stakes, primary: r.primary,
        fit: { accepted: r.fit.accepted === true, first_pass: r.fit.first_pass === true, status: r.fit.status },
        argo: { accepted: r.argo.accepted === true, first_pass: r.argo.first_pass === true, status: r.argo.status }, synthetic: r.synthetic })),
      refused: P.refused, invalid: P.invalid, strata: pairedStrata,
    },
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
  // A stratum decided on paired runs says so, with its pairs and discordant counts (the paired evaluation).
  const strata = Object.entries(record.strata).map(([s, x]) => x.basis === "paired"
    ? `${s}: ${x.outcome}${x.halted ? " (halted)" : ""} (paired, ${x.paired.n} pairs, accepted fit only ${x.paired.accepted.discordant.fit_only} / argo only ${x.paired.accepted.discordant.argo_only}; unpaired ${x.unpaired.outcome}, n fit ${x.unpaired.n.fit}, argo ${x.unpaired.n.argo})`
    : `${s}: ${x.outcome}${x.halted ? " (halted)" : ""} (n fit ${x.n.fit}, argo ${x.n.argo})`).join("; ") || "no interleaved runs yet";
  const paired = record.paired?.pairs?.length
    ? `; paired evaluation over ${record.paired.pairs.length} completed pair(s)${record.paired.refused.length ? `, ${record.paired.refused.length} refused` : ""}` : "";
  const flagged = record.flags?.length ? `; flagged: ${record.flags.map(f => `${f.profile} in ${f.stratum}`).join(", ")}` : "";
  const onBaseline = policy?.profile === record.baseline.profile;
  let outcome = record.outcome;
  if (!onBaseline && outcome !== "insufficient_evidence") outcome = "propose_measurement";
  const measured = outcome !== "propose_measurement" && record.measured;
  const question = `continuous evaluation: does ${record.candidate.profile} match ${record.baseline.profile} on accepted and first-pass results, at lower calls, tokens or elapsed per accept, by stakes stratum? ` +
    `Evaluation ${record.digest.slice(0, 19)} says ${record.outcome}${record.halted.length ? `; halted: ${record.halted.join(", ")}` : ""}${flagged}${paired} [${strata}]` +
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
