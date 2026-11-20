// BOUNDED QUESTIONS OVER A PROJECTION (store.mjs fold). Pure: a projection in, plain data out.
//
// Purpose   Answer the questions no single ledger scan can: what is near this, what does a change of this reach, why
//           does this exist, and what should a seat be shown about it.
// Invariants
//   - Every traversal is bounded by depth and by count, says when it stopped short, and names where to continue.
//   - An answer is an INDEX to sources: every node and edge carries the source, reference and version it was read
//     from. Nothing here summarises a source or stands in for it.
//   - An edge that is only a hypothesis is followed only when asked for, and an answer that rests on one says so.
// Must never  Decide anything. The scheduler, the gates and the selector decide; these functions inform them.
import {RELATIONS, CLASSES} from './contract.mjs';

export const CONTEXT_SCHEMA = 'ophanim.graph.context/v1';
export const BOUNDS = Object.freeze({depth: 8, limit: 2000});
const clamp = (n, lo, hi, dflt) => (Number.isInteger(n) ? Math.min(Math.max(n, lo), hi) : dflt);
const rank = c => CLASSES.indexOf(c);
const edgeOf = r => ({rel: r.a.rel, from: r.a.from, to: r.a.to, class: r.a.class, status: r.a.status, source: r.a.source, origin: r.a.origin, ...(r.a.attrs ? {attrs: r.a.attrs} : {}), aid: r.aid});

/**
 * What is within `depth` edges of `start` (one id or several): {nodes, edges, truncated}. `direction` is out, in or
 * both; `rels` limits the relationship types; `minClass` leaves out weaker assertions (default: hypotheses are left out).
 */
export function neighborhood(P, start, {depth = 2, limit = 200, rels = null, direction = 'both', minClass = 'derived'} = {}) {
  const maxDepth = clamp(depth, 0, BOUNDS.depth, 2), max = clamp(limit, 1, BOUNDS.limit, 200), floor = rank(minClass);
  const seen = new Map([].concat(start).map(id => [id, 0])), queue = [...seen.keys()], edges = new Map();
  let truncated = null;
  const beyond = new Set();
  while (queue.length) {
    const id = queue.shift(), d = seen.get(id);
    const step = [...(direction !== 'in' ? P.out(id).map(r => [r, r.a.to]) : []), ...(direction !== 'out' ? P.in(id).map(r => [r, r.a.from]) : [])]
      .filter(([r]) => (!rels || rels.includes(r.a.rel)) && rank(r.a.class) >= floor).sort(([x], [y]) => (x.aid < y.aid ? -1 : 1));
    for (const [r, other] of step) {
      if (d >= maxDepth) { if (!seen.has(other)) beyond.add(id); continue; }
      if (!seen.has(other)) {
        if (seen.size >= max) { truncated = {reason: 'limit', limit: max}; beyond.add(id); continue; }
        seen.set(other, d + 1); queue.push(other);
      }
      edges.set(r.aid, edgeOf(r));
    }
  }
  if (!truncated && beyond.size) truncated = {reason: 'depth', depth: maxDepth};
  const nodes = [...seen.entries()].map(([id, distance]) => { const e = P.entity(id); return {id, distance, type: e?.type ?? null, domain: e?.domain ?? null, exists: !!e?.exists, attrs: e?.attrs ?? {}, class: e?.class ?? null, status: e?.status ?? null}; });
  return {nodes, edges: [...edges.values()], truncated: truncated ? {...truncated, continue_from: [...beyond].sort()} : null};
}

/**
 * What a change of `changed` (ids) reaches, by the meaning of each relationship (contract.mjs RELATIONS[rel].impact):
 * {affected: [{id, distance, via, rests_on_hypothesis}], truncated}. `via` is the edge that carried the change to it.
 * Unrelated things are simply absent. An edge that is only a hypothesis carries nothing unless `hypotheses` is set, and
 * what is reached through one is marked.
 */
export function impact(P, changed, {depth = 6, limit = 500, hypotheses = false} = {}) {
  const maxDepth = clamp(depth, 1, BOUNDS.depth, 6), max = clamp(limit, 1, BOUNDS.limit, 500);
  const start = [].concat(changed), reached = new Map(start.map(id => [id, {distance: 0, via: null, weak: false}])), queue = [...start];
  let truncated = null;
  while (queue.length) {
    const id = queue.shift(), at = reached.get(id);
    const next = [
      ...P.out(id).filter(r => ['forward', 'both'].includes(RELATIONS[r.a.rel].impact)).map(r => [r, r.a.to]),
      ...P.in(id).filter(r => ['backward', 'both'].includes(RELATIONS[r.a.rel].impact)).map(r => [r, r.a.from]),
    ].filter(([r]) => hypotheses || r.a.class !== 'hypothetical').sort(([x], [y]) => (x.aid < y.aid ? -1 : 1));
    for (const [r, other] of next) {
      if (reached.has(other)) continue;
      if (at.distance >= maxDepth) { truncated = {reason: 'depth', depth: maxDepth}; continue; }
      if (reached.size - start.length >= max) { truncated = {reason: 'limit', limit: max}; continue; }
      reached.set(other, {distance: at.distance + 1, via: edgeOf(r), weak: at.weak || r.a.class === 'hypothetical'});
      queue.push(other);
    }
  }
  const affected = [...reached.entries()].filter(([, v]) => v.distance > 0).map(([id, v]) => { const e = P.entity(id); return {id, type: e?.type ?? null, domain: e?.domain ?? null, distance: v.distance, via: v.via, rests_on_hypothesis: v.weak}; })
    .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1));
  return {changed: start, affected, truncated};
}

// WHY SOMETHING EXISTS AND WHAT HAS BEEN ESTABLISHED ABOUT IT: the edges that carry history, and the way to read each.
const WHY = [
  ['introduced-because-of', 'out', 'reason'], ['derived-from', 'out', 'origin'], ['implements', 'out', 'purpose'], ['requires-capability', 'in', 'needed-by'],
  ['governs', 'in', 'contract'], ['authorizes', 'in', 'authorization'], ['verifies', 'in', 'verification'], ['detects', 'out', 'detects'], ['modifies', 'in', 'changed-by'],
  ['produces', 'in', 'made-by'], ['contributed-to', 'in', 'contributor'], ['supports', 'in', 'evidence-for'], ['contradicts', 'in', 'evidence-against'], ['cited-by', 'in', 'cites'],
  ['applies-to', 'in', 'lesson'], ['corrects', 'in', 'correction'], ['instance-of', 'in', 'occurrence'], ['instance-of', 'out', 'class'], ['supersedes', 'out', 'replaces'], ['supersedes', 'in', 'replaced-by'],
  ['documented-in', 'out', 'written-in'], ['part-of', 'out', 'within'],
];
/** The history of `id`, backwards: [{id, role, distance, via}], bounded. Roles name how each step relates to the last. */
export function trace(P, id, {depth = 5, limit = 200} = {}) {
  const maxDepth = clamp(depth, 1, BOUNDS.depth, 5), max = clamp(limit, 1, BOUNDS.limit, 200);
  const seen = new Map([[id, {distance: 0, role: 'subject', via: null}]]), queue = [id];
  let truncated = null;
  while (queue.length) {
    const cur = queue.shift(), at = seen.get(cur);
    for (const [rel, dir, role] of WHY) {
      for (const r of (dir === 'out' ? P.out(cur, rel) : P.in(cur, rel)).sort((x, y) => (x.aid < y.aid ? -1 : 1))) {
        const other = dir === 'out' ? r.a.to : r.a.from;
        if (seen.has(other)) continue;
        if (at.distance >= maxDepth) { truncated = {reason: 'depth', depth: maxDepth}; continue; }
        if (seen.size > max) { truncated = {reason: 'limit', limit: max}; continue; }
        seen.set(other, {distance: at.distance + 1, role, via: edgeOf(r)});
        queue.push(other);
      }
    }
  }
  const steps = [...seen.entries()].map(([x, v]) => { const e = P.entity(x); return {id: x, type: e?.type ?? null, domain: e?.domain ?? null, exists: !!e?.exists, ...v}; });
  return {id, steps, truncated};
}

/**
 * A bounded package about `focus` for a seat: the neighbourhood, each node and edge with its sources, what is unresolved
 * or disputed, what was left out and where to continue. It is an index: `retrieve` lists the sources to read.
 */
export function contextPackage(P, {focus, depth = 2, limit = 60, rels = null, hypotheses = false} = {}) {
  const ids = [].concat(focus);
  const n = neighborhood(P, ids, {depth, limit, rels, minClass: hypotheses ? 'hypothetical' : 'derived'});
  const nodes = n.nodes.map(x => {
    const e = P.entity(x.id);
    return {...x, sources: (e?.assertions ?? []).map(r => ({authority: r.a.source.authority, ref: r.a.source.ref, version: r.a.source.version, class: r.a.class, status: r.a.status})),
      ...(e?.conflicts?.length ? {conflicts: e.conflicts.map(c => ({attr: c.attr, values: c.values.map(v => ({value: v.value, class: v.class, source: v.source}))}))} : {}),
      ...(e && !e.exists ? {unresolved: 'no source describes this; an edge names it'} : {})};
  });
  const inScope = new Set(n.nodes.map(x => x.id));
  const retrieve = new Map();
  for (const x of [...nodes.flatMap(y => y.sources), ...n.edges.map(e => e.source)]) retrieve.set(`${x.authority}\u0000${x.ref}\u0000${x.version}`, {authority: x.authority, ref: x.ref, version: x.version});
  return {schema: CONTEXT_SCHEMA, graph: {instance: P.instance, seq: P.seq, digest: P.digest()}, focus: ids, nodes, edges: n.edges,
    unresolved: P.unresolved().filter(u => inScope.has(u.from) || inScope.has(u.to)),
    coverage: {nodes: nodes.length, edges: n.edges.length, complete: n.truncated === null, ...(n.truncated ? {stopped: n.truncated.reason, continue_from: n.truncated.continue_from} : {}), hypotheses_included: hypotheses},
    retrieve: [...retrieve.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
    note: 'This is an index of recorded relationships, not the evidence itself. Read a source by its ref and version before relying on it; what is absent here is not thereby absent from the sources.'};
}

/** A context package as text for a dossier view: one line per node and per edge, each with its source. */
export function renderContext(pkg, {maxChars = 12000} = {}) {
  const short = v => String(v).replace(/^sha256:([0-9a-f]{12})[0-9a-f]+$/, 'sha256:$1');
  const lines = [`GRAPH CONTEXT (${pkg.graph.instance}, batch ${pkg.graph.seq}). ${pkg.note}`, `Focus: ${pkg.focus.join(', ')}`, 'Nodes:'];
  for (const x of pkg.nodes) {
    const attrs = Object.entries(x.attrs ?? {}).slice(0, 6).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 80)}`).join(' ');
    lines.push(`- ${x.id}${x.exists ? '' : ' (UNRESOLVED)'} [${x.class ?? '-'}/${x.status ?? '-'}] ${attrs}${x.sources[0] ? ` <${x.sources[0].authority}:${x.sources[0].ref}@${short(x.sources[0].version)}>` : ''}${x.conflicts ? ` DISPUTED: ${x.conflicts.map(c => c.attr).join(', ')}` : ''}`);
  }
  lines.push('Edges:');
  for (const e of pkg.edges) lines.push(`- ${e.from} --${e.rel}--> ${e.to} [${e.class}/${e.status}] <${e.source.authority}:${e.source.ref}@${short(e.source.version)}>`);
  if (!pkg.coverage.complete) lines.push(`Cut at the ${pkg.coverage.stopped} bound; continue from: ${pkg.coverage.continue_from.slice(0, 12).join(', ')}`);
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + `\n[cut at ${maxChars} characters of ${text.length}; ask for a narrower focus]`;
  return text;
}
