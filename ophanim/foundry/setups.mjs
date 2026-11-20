// WHICH SETUPS MAY BUILD A REQUEST, AND WHICH MEASURED BEST: read from the capability graph, never from a table here.
//
// Purpose   A SETUP is the team one trial runs with: a planner, an implementer and a reviewer, each an executable
//           capability of the capability graph (pantheon/src/capability/graph.mjs), and an optional effort level.
//           candidateSetups() asks the graph's eligibility decision (eligibility.mjs decide) which capabilities may
//           hold each role, keeps the ones this environment can reach, and forms one setup per implementer.
//           rankSetups() orders setups by what their recorded trials measured.
// Inputs    the capability snapshot; `reachable(capability)` -> true when this environment can serve it (the caller
//           knows its transports; nothing here probes); optional `implementers` (model names) to narrow the arms,
//           `efforts`, and a fixed `planner` / `reviewer` model. Trials are `ophanim.foundry.trial/v1` records.
// Outputs   candidateSetups() -> {setups, decisions (role -> the eligibility decision's digest and counts), unreachable};
//           rankSetups(trials) -> {criterion, ranked, winner, sufficient, why}.
// Criterion  CRITERION, in order: the share of trials ACCEPTED (acceptance passed in the jail and the dependency gate
//           passed), then the operation score where the request defines one (higher is better), then the median wall
//           time of the accepted trials (lower is better), then the median reported cost. It orders; it qualifies
//           nothing: no `qualified-for` is emitted anywhere on its strength (pantheon/src/capability/metrics.mjs).
// Invariants  A reviewer of the implementer's own lab is chosen only when no reachable capability of another lab
//           exists, and the setup then says `review_independent: false` with the reason. A setup never seats one
//           model as both implementer and reviewer. An unreachable capability is listed, never silently dropped.
// Must never  Read an owner-directed placement as a measurement; call a ranking of fewer than MIN_SAMPLES accepted
//           trials per setup anything but insufficient.
import {digest} from '../../packages/ledger/canonical.mjs';
import {decide} from '../../pantheon/src/capability/eligibility.mjs';

export const SETUP_SCHEMA = 'ophanim.foundry.setup/v1';
export const MIN_SAMPLES = 3;
export const CRITERION = Object.freeze(['accepted_rate desc', 'operation_score desc (when the request defines one)', 'median_ms of accepted trials asc', 'median_cost_usd asc']);
const seatOf = cap => { const [profile, vendor, ...model] = cap.capability.split('/'); return {capability: cap.capability, profile, vendor, model: model.join('/'), lab: cap.lab}; };
const median = xs => { const s = xs.filter(x => typeof x === 'number').sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
export const setupId = s => [s.planner.model, s.implementer.model, s.reviewer.model].join('>') + (s.effort ? `@${s.effort}` : '');

/** The setups the capability graph admits and this environment reaches: one per implementer (and per effort, when given). */
export function candidateSetups({snapshot, reachable, implementers = null, planner = null, reviewer = null, efforts = [null]} = {}) {
  if (typeof reachable !== 'function') throw new Error('candidateSetups: say which capabilities this environment reaches (reachable)');
  const decisions = {}, unreachable = [];
  const eligible = (role, req = {}) => {
    const d = decide(snapshot, {role, ...req});
    decisions[role] = {digest: d.digest, snapshot: d.snapshot?.digest ?? snapshot.digest, eligible: d.eligible.length, excluded: d.excluded.length, mode: d.mode};
    const all = d.eligible.map(seatOf), kept = all.filter(s => reachable(s));
    for (const s of all) if (!reachable(s) && !unreachable.includes(s.capability)) unreachable.push(s.capability);
    return kept;
  };
  const named = (seats, model, role) => { const s = seats.find(x => x.model === model); if (!s) throw new Error(`candidateSetups: ${model} is not an eligible, reachable ${role} in the capability graph`); return s; };
  const builders = eligible('implementer'), planners = eligible('planner'), reviewers = eligible('reviewer');
  const arms = implementers ? implementers.map(m => named(builders, m, 'implementer')) : builders;
  const setups = [];
  for (const impl of arms) {
    const others = reviewers.filter(r => r.model !== impl.model), outside = others.filter(r => r.lab !== impl.lab);
    const rev = reviewer ? named(others, reviewer, 'reviewer') : outside[0] ?? others[0] ?? null;
    if (!rev) { unreachable.push(`no reachable reviewer other than ${impl.capability} itself`); continue; }
    const independent = rev.lab !== impl.lab;
    for (const effort of efforts) {
      const s = {schema: SETUP_SCHEMA, planner: planner ? named(planners, planner, 'planner') : planners.find(p => p.model === impl.model) ?? planners[0], implementer: impl, reviewer: rev, effort: effort ?? null,
        review_independent: independent, review_note: independent ? null : `no capability of a lab other than ${impl.lab} is reachable here: the reviewer is another model of the same lab, which is not an independent review`};
      setups.push({...s, id: setupId(s)});
    }
  }
  return {setups, decisions, unreachable: unreachable.sort()};
}

/** Order setups by CRITERION over their trials. `sufficient` is false while any ranked setup has fewer than MIN_SAMPLES accepted trials. */
export function rankSetups(trials, {minSamples = MIN_SAMPLES} = {}) {
  const by = new Map();
  for (const t of trials) (by.get(t.setup.id) ?? by.set(t.setup.id, []).get(t.setup.id)).push(t);
  const rows = [...by].map(([id, ts]) => {
    const ok = ts.filter(t => t.accepted), scores = ok.map(t => t.operation?.score).filter(x => typeof x === 'number');
    return {setup: id, trials: ts.length, accepted: ok.length, accepted_rate: ok.length / ts.length, operation_score: scores.length ? median(scores) : null,
      median_ms: median(ok.map(t => t.ms)), median_cost_usd: median(ok.map(t => t.cost_usd)), tokens: median(ok.map(t => (t.tokens?.input ?? 0) + (t.tokens?.output ?? 0)))};
  });
  const hi = (a, b) => (b ?? -Infinity) - (a ?? -Infinity), lo = (a, b) => (a ?? Infinity) - (b ?? Infinity);
  rows.sort((a, b) => hi(a.accepted_rate, b.accepted_rate) || hi(a.operation_score, b.operation_score) || lo(a.median_ms, b.median_ms) || lo(a.median_cost_usd, b.median_cost_usd) || (a.setup < b.setup ? -1 : 1));
  const winner = rows[0]?.accepted ? rows[0].setup : null, sufficient = rows.length > 0 && rows.every(r => r.accepted >= minSamples);
  const why = !rows.length ? 'no trial is recorded' : !winner ? 'no setup produced an accepted product' : sufficient ? `each setup has at least ${minSamples} accepted trials`
    : `fewer than ${minSamples} accepted trials for at least one setup: the order is what was measured so far, not an established difference`;
  return {criterion: CRITERION, ranked: rows, winner, sufficient, why, digest: 'sha256:' + digest({rows, minSamples})};
}
