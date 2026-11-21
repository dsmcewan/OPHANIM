// THE FOUNDRY'S GRAPH: the capability graph, with what the foundry's trials measured stated on it.
//
// Purpose   The foundry decides which setup builds a request by asking a graph, and what it learns goes back as
//           measured assertions. This module composes that graph for one run: Pantheon's capability sources (models,
//           runtimes, executable capabilities, roles: pantheon/src/capability/graph.mjs), the capability metrics
//           Pantheon's own extractor reads from each trial's run record (latency, tokens, outcomes per executable
//           capability: metrics.mjs), and one observation per setup and task class with what that setup's trials
//           measured end to end. measuredSetups() reads the setup observations back from the graph view.
// Authority  The trial records in the foundry's state directory are the authority. This graph is re-derived from them
//           each run, with SYNTHETIC keys made for the run (ophanim/graph/extract/index.mjs openSystemsGraph); nothing
//           is kept in it that the records do not hold.
// Inputs    the trial records (`ophanim.foundry.trial/v1`), the registries (default: this checkout's).
// Outputs   foundryGraph() -> {graph, view(), snapshot, observed, metrics, close}; measuredSetups(view, taskClass).
// Facts     evidence/observation  foundry-setup/<class>/<digest of the setup id>   what the setup's trials measured:
//                                 trials, accepted, accepted rate, median wall time and cost of the accepted ones,
//                                 the operation score, how many trials were live, the trial numbers read
//           measures              that observation -> the executable capability of the setup's implementer
//           plus Pantheon's own evidence/observation and measures per executable capability (metrics.mjs).
// Must never  Emit `qualified-for` (that needs an owner-defined criterion; none exists); state a measurement for a
//           trial whose served model was not the one asked for; present a synthetic trial as live evidence.
import {digest} from '../../packages/ledger/canonical.mjs';
import {entityId, parseId, decodeKey} from '../../packages/graph/identity.mjs';
import {assertion} from '../../packages/graph/schema.mjs';
import {capabilitySources, capabilitySnapshot, currentRegistries, SOURCE_ORDER, DECLARED, STRUCTURAL, METRICS_TOOL, S, extractorOf, E} from '../../pantheon/src/capability/graph.mjs';
import {extractMetrics, loadRecords, observedAssertions} from '../../pantheon/src/capability/metrics.mjs';
import {openSystemsGraph} from '../graph/extract/index.mjs';
import {rankSetups} from './setups.mjs';

export const FOUNDRY_TOOL = 'ophanim.foundry.metrics';
export const SETUP_METRICS_SCHEMA = 'ophanim.foundry.setup-metrics/v1';
const KEYS = Object.freeze({declared: 'capability-declared', structural: 'capability-structural', metrics: 'capability-metrics', foundry: 'foundry-metrics'});
const ORIGINS = Object.freeze({
  [DECLARED]: {kind: 'extractor', basis: 'declared', keys: [KEYS.declared], sources: SOURCE_ORDER.filter(s => extractorOf(s) === DECLARED)},
  [STRUCTURAL]: {kind: 'extractor', basis: 'structural', keys: [KEYS.structural], sources: [S.executable]},
  [METRICS_TOOL]: {kind: 'tool', basis: 'measured', keys: [KEYS.metrics]},
  [FOUNDRY_TOOL]: {kind: 'tool', basis: 'measured', keys: [KEYS.foundry]},
});
const observationId = (taskClass, setup) => entityId({domain: 'evidence', type: 'observation', key: `foundry-setup/${taskClass}/${digest(setup).slice(0, 16)}`});

/** The setup observations of `trials`, as assertions a registered tool with a measured basis may write. */
export function setupAssertions(trials, {observed_at}) {
  const out = [], counted = trials.filter(t => t.identity_ok), classes = [...new Set(counted.map(t => t.request.class))].sort();
  const source = {id: 'ophanim.foundry.trials', authority: 'the trial records of the foundry\'s state directory', ref: 'ophanim/foundry/trial.mjs', version: 'sha256:' + digest(counted.map(t => [t.n, t.setup.id, t.accepted, t.ms]))};
  for (const cls of classes) {
    const of = counted.filter(t => t.request.class === cls);
    for (const row of rankSetups(of).ranked) {
      const ts = of.filter(t => t.setup.id === row.setup), setup = ts[0].setup, obs = observationId(cls, row.setup), live = ts.filter(t => t.live).length;
      out.push(assertion({entity: obs, origin: FOUNDRY_TOOL, classification: 'observed', source, run: {id: source.version}, observed_at,
        uncertainty: live === ts.length ? null : `SYNTHETIC: ${ts.length - live} of ${ts.length} trial(s) were not served by a live model`,
        attributes: {metrics_schema: SETUP_METRICS_SCHEMA, evidence_type: 'measured', task_class: cls, setup: row.setup, planner: setup.planner.capability, implementer: setup.implementer.capability,
          reviewer: setup.reviewer.capability, effort: setup.effort ?? null, review_independent: setup.review_independent === true, trials: row.trials, accepted: row.accepted, accepted_rate: row.accepted_rate,
          median_ms: row.median_ms, median_cost_usd: row.median_cost_usd, operation_score: row.operation_score, live_trials: live, trial_numbers: ts.map(t => t.n).sort((a, b) => a - b)}}));
      out.push(assertion({type: 'measures', from: obs, to: E('capability', setup.implementer.capability), origin: FOUNDRY_TOOL, classification: 'observed', source, run: {id: source.version}, observed_at,
        attributes: {metrics_schema: SETUP_METRICS_SCHEMA}}));
    }
  }
  return out;
}

/** The capability graph with the trials' measurements on it. Close it with `close()`. */
export function foundryGraph({trials = [], registries = currentRegistries(), observed_at = new Date().toISOString()} = {}) {
  const snapshot = capabilitySnapshot(registries);
  const g = openSystemsGraph({sources: capabilitySources(registries), extraOrigins: ORIGINS, extraKeys: Object.fromEntries(Object.values(KEYS).map(k => [k, true]))});
  try {
    const observed = {};
    for (const id of SOURCE_ORDER) { const r = g.graph.observe(id, {...g.signers[extractorOf(id) === STRUCTURAL ? KEYS.structural : KEYS.declared], observed_at}); observed[id] = {recorded: r.recorded, why: r.why ?? null}; }
    const runs = trials.filter(t => t.run_json && t.identity_ok).map(t => t.run_json);
    let metrics = null;
    if (runs.length) {
      metrics = extractMetrics(loadRecords({runs}), {snapshot});
      const records = observedAssertions(metrics, {observed_at, synthetic: trials.some(t => !t.live)});
      if (records.length) g.graph.assert(records, g.signers[KEYS.metrics]);
    }
    const setups = setupAssertions(trials, {observed_at});
    if (setups.length) g.graph.assert(setups, g.signers[KEYS.foundry]);
    return {...g, snapshot, observed, metrics, view: () => g.graph.view()};
  } catch (e) { g.close(); throw e; }
}

/** What the graph holds measured for `taskClass`, one row per setup, read from the view (never from the trial files). */
export function measuredSetups(view, taskClass) {
  const rows = [];
  for (const id of view.subjects()) {
    let p; try { p = parseId(id); } catch { continue; }
    if (p.domain !== 'evidence' || p.type !== 'observation' || !decodeKey(p.key).startsWith(`foundry-setup/${taskClass}/`)) continue;
    const node = view.node(id);
    if (!node?.established) continue;
    const to = view.edgesOf(id, {types: ['measures']}).filter(e => e.from === id).map(e => e.to);
    const stated = node.assertions.map(x => view.assertion(x.id ?? x)).find(x => x?.origin === FOUNDRY_TOOL);
    rows.push({...node.attributes, observation: id, measures: to, uncertainty: stated?.record?.uncertainty ?? stated?.uncertainty ?? null});
  }
  return rows.sort((a, b) => (a.setup < b.setup ? -1 : 1));
}
