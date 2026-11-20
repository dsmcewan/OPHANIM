// MEASURES OVER THE DEPENDENCY GRAPH, ported from TELOS's Lachesis (lachesis/measure.mjs at TELOS 0c9b539).
//
// Purpose   Lachesis measures a woven dependency graph: what a node needs, what needs it, how central it is, and an
//           ADVISORY risk class. These are the same definitions over OPHANIM's graph view, so the two systems mean the
//           same thing by "blast radius". A measure reads established relationships only; it authorizes nothing.
// Inputs    A view of a graph at a cursor (packages/graph projection view) and a node id.
// Outputs   dependencies(), blastRadius(), relevance(), riskClass(), assess(), coverageOf(); RISK (the thresholds).
// Ported as written
//           dependencies(id)        the transitive forward closure of dependency edges, without id; a cycle ends.
//           blastRadius(id, depth)  the dependents by reverse dependency edges to `depth` hops, without id.
//           riskClass               blast radius >= 10 high, >= 3 medium, else low; then the coverage floor: low is
//                                   raised to medium unless coverage is 'attested-complete'. Relevance does not feed it.
// Differs from Lachesis, and why
//           A dependency edge here is `depends-on` or `consumes` (a file read by path, an environment variable): both
//           carry a change from their target to their source in the relationship registry. Pass {types: ['depends-on']}
//           for Lachesis's exact edge set.
//           relevance = (3 x direct dependents + 2 x checks that verify the node) / the largest such value. Lachesis's
//           third term (one point for an introducing commit) is left out: here every tracked file has one, so it would
//           add the same constant to every file and nothing to the ordering.
// Must never  Follow a mention, a hypothetical or an unestablished relationship; present the risk class as a
//           qualification or a gate; report a measure of a node the graph does not hold.
import {grammarRefusal} from '../../../packages/graph/index.mjs';

export const DEPENDENCY_TYPES = Object.freeze(['depends-on', 'consumes']);
/** Lachesis's thresholds on the number of dependents. */
export const RISK = Object.freeze({high: 10, medium: 3});
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const refuse = why => Object.assign(new Error(why), {code: 'MEASURE_REFUSED'});
const known = (view, id) => { if (!view.nodeIn(id, 'established')) throw refuse(`${id} is not established in the graph at cursor ${view.seq}`); };
/** The nodes one hop from `id`: what it needs ('forward': the `to` of its edges) or what needs it ('reverse'). */
const step = (view, id, types, direction) => view.edgesOf(id, {mode: 'established', types})
  .filter(e => (direction === 'forward' ? e.from === id : e.to === id)).map(e => (direction === 'forward' ? e.to : e.from));

function reach(view, id, types, direction, depth) {
  const seen = new Set();
  let frontier = new Set(depth > 0 ? step(view, id, types, direction) : []);
  for (let hops = 1; frontier.size && hops <= depth; hops++) {
    const next = new Set();
    for (const n of frontier) { if (seen.has(n)) continue; seen.add(n); for (const m of step(view, n, types, direction)) if (!seen.has(m)) next.add(m); }
    frontier = next;
  }
  seen.delete(id);
  return {count: seen.size, nodes: [...seen].sort(byString)};
}

/** Everything `id` needs, through every hop, without `id`. */
export function dependencies(view, id, {types = DEPENDENCY_TYPES} = {}) { known(view, id); return reach(view, id, [...types], 'forward', Infinity); }

/** Everything that needs `id`, to `depth` hops (Infinity: the whole reverse closure), without `id`. */
export function blastRadius(view, id, {depth = Infinity, types = DEPENDENCY_TYPES} = {}) {
  known(view, id);
  if (!(depth === Infinity || (Number.isInteger(depth) && depth >= 0))) throw refuse(`depth is a non-negative integer or Infinity (got ${depth})`);
  return reach(view, id, [...types], 'reverse', depth);
}

const salience = new WeakMap();
/** Direct salience of every node of the view: 3 per direct dependent, 2 per check that verifies it. */
function rawSalience(view, types) {
  const key = types.join(','), cached = salience.get(view)?.get(key);
  if (cached) return cached;
  const raw = new Map();
  for (const n of view.subjects()) {
    if (grammarRefusal(n) !== null || !view.nodeIn(n, 'established')) continue;
    let score = 0;
    for (const e of view.edgesOf(n, {mode: 'established', types: [...types, 'verifies', 'verified-by']})) {
      if (types.includes(e.type)) { if (e.to === n) score += 3; }
      else if ((e.type === 'verifies' && e.to === n) || (e.type === 'verified-by' && e.from === n)) score += 2;
    }
    if (score) raw.set(n, score);
  }
  (salience.get(view) ?? salience.set(view, new Map()).get(view)).set(key, raw);
  return raw;
}
/** How central `id` is among the nodes of the view, 0 to 1. Reported; it does not feed the risk class. */
export function relevance(view, id, {types = DEPENDENCY_TYPES} = {}) {
  known(view, id);
  const raw = rawSalience(view, [...types]);
  let max = 0;
  for (const v of raw.values()) if (v > max) max = v;
  return max === 0 ? 0 : (raw.get(id) ?? 0) / max;
}

/** The advisory class of `id`: blast-driven, with the coverage floor. */
export function riskClass(view, id, {coverage = 'unverified', types = DEPENDENCY_TYPES} = {}) {
  const blast = blastRadius(view, id, {types}).count;
  let cls = blast >= RISK.high ? 'high' : blast >= RISK.medium ? 'medium' : 'low';
  if (cls === 'low' && coverage !== 'attested-complete') cls = 'medium';
  return {class: cls, blast_radius: blast, coverage, advisory: true};
}

/** One node's measures, bound to the cursor and the projection digest they were taken on. */
export function assess(view, id, {coverage = 'unverified', types = DEPENDENCY_TYPES} = {}) {
  known(view, id);
  return {node: id, cursor: view.seq, digest: view.digest(), dependencies: dependencies(view, id, {types}).count,
    ...riskClass(view, id, {coverage, types}), relevance: relevance(view, id, {types})};
}

/**
 * Whether the view may be called complete: every observed source is current and the caller reports no gap of a
 * reading (the `missing_evidence` of a repository node, for example). Anything else is 'unverified', with why.
 */
export function coverageOf(view, {gaps = []} = {}) {
  const why = [...view.sources().filter(s => s.state !== 'current').map(s => `source ${s.id} is ${s.state}`), ...gaps];
  return {coverage: why.length ? 'unverified' : 'attested-complete', why};
}
