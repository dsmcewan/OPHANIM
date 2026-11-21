// Bounded, explained traversal (KD9, docs/knowledge-graph/architecture.md "Traversal").
//
// Every traversal is a breadth-first walk over a view (projection.mjs `at(cursor)`), deterministic at that cursor:
// seeds sorted, each node's steps sorted by relationship subject. Every walk is bounded -- depth, nodes and edges, with
// hard ceilings no caller can lift -- and every result says what it covered: whether it was cut, by which bound, and a
// continuation cursor that resumes the same walk exactly where it stopped (or, for a depth cut, deeper). Each result
// node carries its EXPLAINED PATH: the relationships from a seed to it, each with the assertions that support it, and
// the node's own supporting assertions.
//
//   neighborhood   k-hop, any registered type (or those asked), out, in or both
//   closure        typed transitive closure along the IMPACT-following types only: 'reverse' is what a change to the
//                  seeds reaches (their dependents), 'forward' what the seeds rest on
//   contradictions the contradiction set: every node joined by `contradicts`, both sides kept, each with its support
import {RELATIONSHIPS, IMPACT_TYPES} from './schema.mjs';

/** The coordinator's defaults (KD9); the owner may change them. */
export const DEFAULTS = Object.freeze({depth: 4, maxNodes: 500, maxEdges: 2000});
/** What no caller can exceed. */
export const CEILINGS = Object.freeze({depth: 16, maxNodes: 10_000, maxEdges: 50_000});
const MODES = ['established', 'possible', 'recorded'];
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function boundsOf(o = {}) {
  const b = {depth: o.depth ?? DEFAULTS.depth, maxNodes: o.maxNodes ?? DEFAULTS.maxNodes, maxEdges: o.maxEdges ?? DEFAULTS.maxEdges};
  for (const k of Object.keys(b)) {
    if (!Number.isInteger(b[k]) || b[k] < (k === 'depth' ? 0 : 1)) throw new RangeError(`${k} is a positive integer`);
    if (b[k] > CEILINGS[k]) throw new RangeError(`${k} ${b[k]} is above its ceiling ${CEILINGS[k]}`);
  }
  return b;
}

const encode = t => Buffer.from(JSON.stringify(t)).toString('base64url');
function decode(token, op) {
  let t;
  try { t = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch { throw new RangeError('a continuation is a token a traversal returned'); }
  if (t?.v !== 1 || t.op !== op) throw new RangeError(`the continuation is for ${t?.op}, not ${op}`);
  return t;
}

/**
 * The walk. `step(u)` lists u's steps [{next, edge, toward}] in a fixed order. A page is the window of steps from
 * `skip` (steps examined by earlier pages) holding at most maxEdges steps and maxNodes new nodes.
 */
function walk(view, {op, seeds, step, b, skip = 0, params, mode}) {
  const visited = new Map(), queue = [], nodes = [], edges = new Map();
  const start = [...new Set(seeds)].sort(byString);
  for (const s of start) { visited.set(s, {depth: 0, parent: null}); queue.push(s); }
  let steps = 0, pageSteps = 0, pageNodes = 0, limit = null, frontier = 0;
  if (skip === 0) for (const s of start) { nodes.push(s); pageNodes++; }
  let qi = 0;
  outer: while (qi < queue.length) {
    const u = queue[qi++], du = visited.get(u).depth, st = step(u);
    if (du >= b.depth) { if (st.some(s => !visited.has(s.next))) frontier++; continue; }
    for (const s of st) {
      const i = steps, inPage = i >= skip;
      if (inPage) {
        if (pageSteps >= b.maxEdges) { limit = 'edges'; break outer; }
        if (!visited.has(s.next) && pageNodes >= b.maxNodes) { limit = 'nodes'; break outer; }
        pageSteps++;
        edges.set(s.edge.subject, s.edge);
      }
      steps++;
      if (!visited.has(s.next)) {
        visited.set(s.next, {depth: du + 1, parent: {node: u, edge: s.edge, toward: s.toward}});
        queue.push(s.next);
        if (inPage) { nodes.push(s.next); pageNodes++; }
      }
    }
  }
  if (!limit && frontier) limit = 'depth';
  let continuation = null, ceiling = false;
  if (limit === 'nodes' || limit === 'edges') continuation = encode({v: 1, op, seeds: start, params, seq: view.seq, skip: steps});
  else if (limit === 'depth') {
    if (b.depth >= CEILINGS.depth) ceiling = true;
    else continuation = encode({v: 1, op, seeds: start, params: {...params, depth: Math.min(b.depth * 2 || 1, CEILINGS.depth)}, seq: view.seq, skip: steps});
  }
  const pathOf = n => {
    const out = [];
    for (let cur = visited.get(n); cur.parent; cur = visited.get(cur.parent.node)) {
      const e = cur.parent.edge;
      out.push({subject: e.subject, type: e.type, from: e.from, to: e.to, toward: cur.parent.toward, assertions: e.assertions});
    }
    return out.reverse();
  };
  const sourcesOf = new Set();
  const result = nodes.map(n => {
    const node = view.node(n);
    for (const a of node.assertions) sourcesOf.add(a.source.id);
    return {id: n, depth: visited.get(n).depth, path: pathOf(n), established: node.established,
      assertions: node.assertions.map(a => ({id: a.id, classification: a.classification, origin: a.origin, source: a.source}))};
  });
  for (const e of edges.values()) for (const id of e.assertions) sourcesOf.add(view.assertion(id).source.id);
  const notCurrent = view.sources().filter(s => s.state !== 'current' || s.replay !== 'applied').map(s => s.id);
  return {
    op, seeds: start, cursor: view.seq, mode,
    nodes: result,
    edges: [...edges.values()].sort((x, y) => byString(x.subject, y.subject)),
    coverage: {truncated: limit !== null, limit, depth: b.depth, maxNodes: b.maxNodes, maxEdges: b.maxEdges, ceiling,
      returned: {nodes: result.length, edges: edges.size}, examined: steps,
      stale_sources: notCurrent.filter(s => sourcesOf.has(s)).sort(byString)},
    continuation,
  };
}

const modeOf = m => { if (!MODES.includes(m)) throw new RangeError(`mode is one of ${MODES.join(', ')}`); return m; };
const typesOf = (types, allowed = null) => {
  if (types === null || types === undefined) return allowed;
  if (!Array.isArray(types) || types.some(t => !Object.hasOwn(RELATIONSHIPS, t))) throw new RangeError('types are registered relationship types');
  return allowed ? types.filter(t => allowed.includes(t)) : types;
};

/**
 * The bounded k-hop neighbourhood of `start` (an id or a list of ids). Options: depth, maxNodes, maxEdges, types,
 * direction ('out' | 'in' | 'both'), mode ('established' default | 'possible' | 'recorded'), continuation.
 */
export function neighborhood(view, start, opts = {}) {
  const t = opts.continuation ? decode(opts.continuation, 'neighborhood') : null;
  const params = t ? t.params : {depth: opts.depth, maxNodes: opts.maxNodes, maxEdges: opts.maxEdges, types: opts.types ?? null,
    direction: opts.direction ?? 'both', mode: opts.mode ?? 'established'};
  if (t && t.seq !== view.seq) throw new RangeError(`the continuation is for cursor ${t.seq}; open that view`);
  const b = boundsOf(params), mode = modeOf(params.mode), types = typesOf(params.types);
  if (!['out', 'in', 'both'].includes(params.direction)) throw new RangeError('direction is out, in or both');
  const step = u => view.edgesOf(u, {mode, types}).flatMap(e => {
    const out = e.from === u, toward = out ? 'out' : 'in';
    if (params.direction !== 'both' && params.direction !== toward) return [];
    const next = out ? e.to : e.from;
    return view.nodeIn(next, mode) ? [{next, edge: e, toward}] : [];
  });
  return walk(view, {op: 'neighborhood', seeds: t ? t.seeds : [start].flat(), step, b, skip: t ? t.skip : 0, params, mode});
}

/**
 * Typed transitive closure from `start` along the impact-following relationship types ONLY (RELATIONSHIPS[t].impact).
 * direction 'reverse': what a change to the seeds reaches (a change to B reaches A when A depends-on B); 'forward':
 * what the seeds rest on. Options as neighborhood, without `direction` ('reverse' | 'forward' instead).
 */
export function closure(view, start, opts = {}) {
  const t = opts.continuation ? decode(opts.continuation, 'closure') : null;
  const params = t ? t.params : {depth: opts.depth, maxNodes: opts.maxNodes, maxEdges: opts.maxEdges, types: opts.types ?? null,
    direction: opts.direction ?? 'reverse', mode: opts.mode ?? 'established'};
  if (t && t.seq !== view.seq) throw new RangeError(`the continuation is for cursor ${t.seq}; open that view`);
  const b = boundsOf(params), mode = modeOf(params.mode), types = typesOf(params.types, IMPACT_TYPES);
  if (!['reverse', 'forward'].includes(params.direction)) throw new RangeError('direction is reverse or forward');
  const reverse = params.direction === 'reverse';
  const step = u => view.edgesOf(u, {mode, types}).flatMap(e => {
    const impact = RELATIONSHIPS[e.type].impact;
    if (!impact) return [];
    // a change at the cause end reaches the dependent end
    const [cause, dependent] = impact === 'to->from' ? [e.to, e.from] : [e.from, e.to];
    const next = reverse ? (u === cause ? dependent : null) : (u === dependent ? cause : null);
    return next && view.nodeIn(next, mode) ? [{next, edge: e, toward: e.from === u ? 'out' : 'in'}] : [];
  });
  return walk(view, {op: 'closure', seeds: t ? t.seeds : [start].flat(), step, b, skip: t ? t.skip : 0, params, mode});
}

/**
 * The contradiction set of `start`: every node joined to it by `contradicts`, transitively and within the bounds,
 * hypothetical sides included (mode 'possible' by default), each member with the assertions that support it. Neither
 * side of a contradiction is dropped or resolved here.
 */
export function contradictions(view, start, opts = {}) {
  const t = opts.continuation ? decode(opts.continuation, 'contradictions') : null;
  const params = t ? t.params : {depth: opts.depth, maxNodes: opts.maxNodes, maxEdges: opts.maxEdges, mode: opts.mode ?? 'possible'};
  if (t && t.seq !== view.seq) throw new RangeError(`the continuation is for cursor ${t.seq}; open that view`);
  const b = boundsOf(params), mode = modeOf(params.mode);
  const step = u => view.edgesOf(u, {mode, types: ['contradicts']}).map(e => ({next: e.from === u ? e.to : e.from, edge: e, toward: e.from === u ? 'out' : 'in'}));
  const r = walk(view, {op: 'contradictions', seeds: t ? t.seeds : [start].flat(), step, b, skip: t ? t.skip : 0, params, mode});
  return {...r, members: r.nodes};
}

/** Resume any traversal from its continuation token. */
export function resume(view, token) {
  const op = (() => { try { return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')).op; } catch { return null; } })();
  if (op === 'neighborhood') return neighborhood(view, null, {continuation: token});
  if (op === 'closure') return closure(view, null, {continuation: token});
  if (op === 'contradictions') return contradictions(view, null, {continuation: token});
  throw new RangeError('a continuation is a token a traversal returned');
}
