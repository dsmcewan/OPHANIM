// THE FOUNDRY: one request carried from observation to an operated, measured product, and what was learned kept.
//
// Purpose   OPHANIM "is an autonomous systems foundry. Its purpose is to investigate requirements, discover
//           dependencies, construct capabilities, verify outcomes, operate systems, and improve its own processes"
//           (owner directive 2026-11-20). The stages existed apart. This module runs them as one path for one request,
//           and lets the knowledge graph decide who builds: the setups come from the capability graph, they are tried
//           against each other on the same request, and what each measured is stated back on the graph, so the next
//           run starts from the best setup measured so far and tries one not yet measured beside it (owner direction
//           2026-11-20: use the knowledge graph; A/B test and keep metrics of the best and fastest setup).
// Stages    observe      the request, its digest, and every earlier trial in the state directory
//           investigate  the graph (graph.mjs): which capabilities may hold each role and why (eligibility decisions),
//                        which this environment reaches, and what is already measured for this class of task
//           plan         the setups to try (arms) and the order of the trials, with the basis of each choice
//           construct    each trial through Pantheon's pipeline (trial.mjs): plan, build, acceptance in the jail, review
//           verify       per trial: the acceptance result, and the dependency gate on what the product needs
//           operate      per accepted product: the request's operate command in the jail, its report and score
//           (rework)     when asked for (`rework` rounds): an accepted product whose reviewer requested changes is
//                        built again by the same setup with the previous revision and the review in hand; rework
//                        trials are recorded and never ranked with first builds
//           learn        the ranking over every trial of the class (setups.mjs CRITERION), the measurements stated on
//                        the graph and read back, and the winner's product written out with what stands behind it
// Inputs    a request file; a state directory (created if absent, appended to otherwise); makeClients({setup}) -> the
//           model clients for one trial; reachable(capability); how many arms and repetitions; optional narrowing.
// Outputs   runFoundry() -> the run record `ophanim.foundry.run/v1`, also written to <state>/runs/<n>.json. Trials are
//           <state>/trials/<n>/trial.json. The product is <state>/products/<key>/ with PRODUCT.json.
// Invariants  The state directory's trial records are the authority; the graph is re-derived from them. Trials run one
//           after another, so one trial's wall time is not another's load. A trial whose served model was not the one
//           asked for is recorded and left out of the ranking. A product is written out only from an ACCEPTED trial,
//           and PRODUCT.json says whether Pantheon shipped it and whether its review was independent.
// Must never  Present a product as shipped or independently reviewed when the gate refused it; rank on fewer samples
//           than MIN_SAMPLES without saying the order is not established; overwrite an earlier trial or run record.
// Limits    One lab is reachable where only the Claude command line is signed in: every review there is by another
//           model of the maker's lab, Pantheon's REVIEW gate refuses to ship, and the product is `accepted`, never
//           `shipped`. Acceptance here is the request's own command in the jail plus the dependency gate; it is not a
//           TELOS authorization (ophanim/governance accepts four closed kinds of obligation only).
import fs from 'node:fs';
import path from 'node:path';
import {readRequest} from './request.mjs';
import {candidateSetups, rankSetups, CRITERION, MIN_SAMPLES} from './setups.mjs';
import {runTrial, TRIAL_SCHEMA} from './trial.mjs';
import {foundryGraph, measuredSetups} from './graph.mjs';

export const RUN_SCHEMA = 'ophanim.foundry.run/v1';
export const STAGES = Object.freeze(['observe', 'investigate', 'plan', 'construct', 'verify', 'operate', 'learn']);
const pad = n => String(n).padStart(4, '0');
const writeOnce = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, JSON.stringify(value, null, 1) + '\n', {flag: 'wx'}); };
const numbered = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}(\.json)?$/.test(f)).sort() : []);

/** Every trial record of a state directory, in order. A record that does not read as a trial is an error, never skipped. */
export function readTrials(state) {
  return numbered(path.join(state, 'trials')).map(d => {
    const file = path.join(state, 'trials', d, 'trial.json');
    if (!fs.existsSync(file)) return null;   // a trial directory with no record: the trial did not finish, and counts for nothing
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (t.schema !== TRIAL_SCHEMA) throw new Error(`${file} is not a ${TRIAL_SCHEMA} record`);
    return t;
  }).filter(Boolean);
}

const best = (a, b) => (b.accepted_rate - a.accepted_rate) || ((b.operation_score ?? -Infinity) - (a.operation_score ?? -Infinity)) || ((a.median_ms ?? Infinity) - (b.median_ms ?? Infinity))
  || ((a.median_cost_usd ?? Infinity) - (b.median_cost_usd ?? Infinity)) || (a.setup < b.setup ? -1 : 1);

/** Which setups to try: the best one the graph holds measured for this class, then setups not yet measured, then the other measured ones. */
export function chooseArms(setups, measured, arms) {
  const known = new Map(measured.map(m => [m.setup, m])), ranked = setups.filter(s => known.has(s.id)).sort((a, b) => best(known.get(a.id), known.get(b.id)));
  const fresh = setups.filter(s => !known.has(s.id)), lead = ranked.filter(s => known.get(s.id).accepted > 0).slice(0, 1), rest = ranked.filter(s => !lead.includes(s));
  return [...lead.map(s => ({setup: s, basis: 'the best setup measured so far for this class of task'})), ...fresh.map(s => ({setup: s, basis: 'not yet measured for this class of task'})),
    ...rest.map(s => ({setup: s, basis: 'measured before, tried again'}))].slice(0, arms);
}

export async function runFoundry({requestFile, state, makeClients, reachable, arms = 2, repetitions = 1, rework = 0, implementers = null, planner = null, reviewer = null, efforts = [null], revisions = 2,
  registries, observed_at = new Date().toISOString(), onStage = () => {}} = {}) {
  if (!Number.isInteger(arms) || arms < 1 || arms > 8 || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('runFoundry: 1 to 8 arms and 1 to 10 repetitions');
  if (!Number.isInteger(rework) || rework < 0 || rework > 3) throw new Error('runFoundry: 0 to 3 rework rounds');
  if (typeof makeClients !== 'function') throw new Error('runFoundry: pass makeClients({setup}) -> makeClientFor');
  const stages = [], stage = (name, record) => { const row = {stage: name, ...record}; stages.push(row); onStage(row); return row; };
  // observe
  const {request, seed, sha256} = readRequest(requestFile);
  fs.mkdirSync(path.join(state, 'trials'), {recursive: true});
  const prior = readTrials(state), priorOfClass = prior.filter(t => t.request.class === request.class);
  stage('observe', {request: {key: request.key, class: request.class, sha256}, earlier_trials: prior.length, earlier_trials_of_class: priorOfClass.length});
  // investigate
  let g = foundryGraph({trials: prior, registries, observed_at});
  let candidates, measured, snapshotDigest;
  try {
    candidates = candidateSetups({snapshot: g.snapshot, reachable, implementers, planner, reviewer, efforts});
    measured = measuredSetups(g.view(), request.class);
    snapshotDigest = g.snapshot.digest;
  } finally { g.close(); }
  stage('investigate', {capability_snapshot: snapshotDigest, eligibility: candidates.decisions, reachable_setups: candidates.setups.map(s => s.id), unreachable_capabilities: candidates.unreachable.length,
    measured: measured.map(m => ({setup: m.setup, trials: m.trials, accepted: m.accepted, median_ms: m.median_ms, median_cost_usd: m.median_cost_usd, operation_score: m.operation_score}))});
  if (!candidates.setups.length) throw Object.assign(new Error('the foundry has no setup to build with: no eligible capability is reachable in this environment'), {code: 'FOUNDRY_NO_SETUP', stages});
  // plan
  const chosen = chooseArms(candidates.setups, measured, arms), order = [];
  for (let r = 0; r < repetitions; r++) order.push(...(r % 2 ? [...chosen].reverse() : chosen));
  stage('plan', {arms: chosen.map(c => ({setup: c.setup.id, basis: c.basis, review_independent: c.setup.review_independent})), repetitions,
    order: order.map(c => c.setup.id), order_rule: 'one trial at a time; the arms\' order is reversed on every other repetition'});
  // construct, verify, operate: one trial at a time
  const fresh = [];
  let n = numbered(path.join(state, 'trials')).length;
  const trial = async (setup, reworkOf = null) => {
    const dir = path.join(state, 'trials', pad(++n));
    fs.mkdirSync(dir);
    const t = await runTrial({request, seed, requestSha: sha256, setup, dir: path.join(dir, 'work'), makeClientFor: makeClients({setup}), n, revisions, reworkOf});
    writeOnce(path.join(dir, 'trial.json'), t);
    fresh.push(t);
    stage('construct', {trial: n, ...(reworkOf ? {rework_of: reworkOf.trial} : {}), setup: t.setup.id, built: t.built, ms: t.ms, provider_calls: t.provider_calls, cost_usd: t.cost_usd, identity_ok: t.identity_ok, error: t.error});
    stage('verify', {trial: n, verified: t.verified, isolation: t.isolation, review: t.review, shipped: t.shipped, ship_why: t.ship_why,
      dependencies: t.dependencies ? {ok: t.dependencies.ok, needs: t.dependencies.needs, refused: t.dependencies.refused} : null});
    stage('operate', {trial: n, operated: t.operation !== null, ok: t.operation?.ok ?? null, score: t.operation?.score ?? null, why: t.operation?.why ?? (t.operation ? null : 'not operated: the product was not verified with its dependencies allowed, or the request has no operate command')});
    return t;
  };
  for (const c of order) await trial(c.setup);
  // An accepted product whose reviewer requested changes is built again by the same setup with the review in hand, up
  // to `rework` times; the first build's own measurements stand as they are.
  const firstRanking = rankSetups(fresh.filter(t => t.identity_ok));
  let lead = firstRanking.winner ? fresh.filter(t => t.accepted && t.identity_ok && t.setup.id === firstRanking.winner).sort((a, b) => a.ms - b.ms)[0] ?? null : null;
  for (let round = 0; lead && round < rework && lead.review === 'request_changes' && lead.review_file; round++) {
    const from = path.join(path.dirname(lead.run_json), 'artifact-latest');
    lead = await trial(lead.setup, {trial: lead.n, files: lead.product.map(f => ({path: f.path, text: fs.readFileSync(path.join(from, f.path), 'utf8')})), review: fs.readFileSync(lead.review_file, 'utf8')});
    if (!lead.accepted || !lead.identity_ok) break;
  }
  // learn
  const all = [...priorOfClass, ...fresh], counted = all.filter(t => t.identity_ok), ranking = rankSetups(counted);
  g = foundryGraph({trials: [...prior, ...fresh], registries, observed_at});
  let stated;
  try { stated = measuredSetups(g.view(), request.class); } finally { g.close(); }
  // The product: of the winning setup's accepted trials in this run, one its reviewer approved before one it did not,
  // then the better operation score, then the later trial.
  const approved = t => (t.review === 'approve' ? 1 : 0), scoreOf = t => t.operation?.score ?? -Infinity;
  const winnerTrial = ranking.winner ? [...fresh].filter(t => t.accepted && t.identity_ok && t.setup.id === ranking.winner).sort((a, b) => approved(b) - approved(a) || scoreOf(b) - scoreOf(a) || b.n - a.n)[0] ?? null : null;
  let product = null;
  if (winnerTrial) {
    const out = path.join(state, 'products', request.key, pad(winnerTrial.n)), from = path.join(path.dirname(winnerTrial.run_json), 'artifact-latest');
    for (const f of winnerTrial.product) { fs.mkdirSync(path.dirname(path.join(out, f.path)), {recursive: true}); fs.copyFileSync(path.join(from, f.path), path.join(out, f.path)); }
    product = {schema: 'ophanim.foundry.product/v1', request: winnerTrial.request, trial: winnerTrial.n, setup: winnerTrial.setup.id, files: winnerTrial.product, accepted: true,
      verified_by: `${request.acceptance_cmd} exited 0 in ${winnerTrial.isolation}`, dependencies: winnerTrial.dependencies.needs, operation: winnerTrial.operation,
      review: winnerTrial.review, rework_of: winnerTrial.rework_of, review_independent: winnerTrial.setup.review_independent === true, review_note: winnerTrial.setup.review_note ?? null,
      shipped: winnerTrial.shipped, ship_why: winnerTrial.ship_why, live: winnerTrial.live, transport: winnerTrial.transport, dir: out};
    writeOnce(path.join(out, 'PRODUCT.json'), product);
  }
  stage('learn', {criterion: CRITERION, min_samples: MIN_SAMPLES, ranking: ranking.ranked, winner: ranking.winner, sufficient: ranking.sufficient, why: ranking.why,
    left_out: all.filter(t => !t.identity_ok).map(t => ({trial: t.n, why: 'the served model was not the one asked for'})),
    rework: fresh.filter(t => t.rework_of).map(t => { const p = fresh.find(x => x.n === t.rework_of) ?? all.find(x => x.n === t.rework_of);
      return {trial: t.n, of: t.rework_of, accepted: t.accepted, review: t.review, score: t.operation?.score ?? null, before: {review: p?.review ?? null, score: p?.operation?.score ?? null}}; }),
    stated_on_graph: stated.map(m => ({setup: m.setup, observation: m.observation, measures: m.measures, trials: m.trials, accepted: m.accepted, median_ms: m.median_ms, uncertainty: m.uncertainty})),
    next: ranking.winner ? `the next request of class ${request.class} starts from ${ranking.winner}` : 'no setup has an accepted product for this class yet'});
  const runs = path.join(state, 'runs'), record = {schema: RUN_SCHEMA, n: numbered(runs).length + 1, at: observed_at, request: {key: request.key, class: request.class, sha256},
    trials: fresh.map(t => t.n), winner: ranking.winner, sufficient: ranking.sufficient, product, spent_usd: fresh.every(t => typeof t.cost_usd === 'number') ? Number(fresh.reduce((a, t) => a + t.cost_usd, 0).toFixed(6)) : null, stages};
  writeOnce(path.join(runs, `${pad(record.n)}.json`), record);
  return record;
}
