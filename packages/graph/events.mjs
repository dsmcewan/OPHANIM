// Source observation and change events (KD10, docs/knowledge-graph/architecture.md "Change events").
//
// A source changes the graph only by being OBSERVED: its registered extractor reads its current version, the
// projection re-derives the facts there and diffs them against what the graph holds, and one observation record
// -- {source, from_version, to_version, nodes, relationships} with the digest of the facts -- is appended to the graph
// ledger. That record IS the change event: ordered by ledger sequence, keyed by source plus version, read by a consumer
// through a cursor. A repeated observation of the same version is a no-op; an older reading arriving after a newer one
// is refused by the cursor rule (projection.mjs) and read again.
//
// Nothing here runs by itself. A source is current only as of its last observation, and `freshness` says so: a source
// that moved since is STALE, one that cannot be read is UNAVAILABLE, one never read is NEVER-OBSERVED. A source that
// cannot be read, or whose new version cannot be projected, is recorded visibly as such and its last facts stay,
// marked; nothing is claimed to be continuously synchronized.
import {entityId} from './identity.mjs';
import {assertion, RELATIONSHIPS, CHANGE_LIST_MAX} from './schema.mjs';
import {closure} from './traverse.mjs';

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const clip = s => String(s).slice(0, 2000);

/**
 * The observation record that observing `sourceId` now would append, or {none: why} when the graph already holds
 * this state of the source (the idempotency key: source plus version, and its state).
 */
export function observationOf(projection, sourceId, {observed_at, effective_at = null}) {
  const a = projection.adapters.get(sourceId);
  if (!a) throw Object.assign(new Error(`source "${sourceId}" is not registered with this graph`), {code: 'GRAPH_REFUSED'});
  const prev = projection.sourceNode(sourceId);
  const was = prev ? {version: prev.source.version, state: prev.attributes.state, live: prev.attributes.live_version} : null;
  const record = (state, version, attrs, eff = effective_at) => assertion({
    entity: entityId({instance: projection.instance, domain: 'evidence', type: 'source', key: sourceId}),
    origin: a.extractor, classification: 'authoritative', observed_at, effective_at: eff,
    source: {id: sourceId, authority: a.authority, ref: a.ref, version},
    supersedes: prev ? [prev.id] : [],
    missing_evidence: state === 'current' ? [] : [state === 'unavailable' ? 'the source could not be read; its facts are as last observed' : 'the source moved to a version that could not be projected; its facts are as last observed'],
    attributes: {state, digest: null, count: null, from_version: was?.version ?? null, changes: null, nodes: [], relationships: [], why: null, live_version: null, ...attrs}});
  let live;
  try { live = a.current(); }
  catch (e) {
    if (was?.state === 'unavailable') return {none: `${sourceId} is already recorded as unavailable`};
    return {record: record('unavailable', was?.version ?? null, {why: clip(e.message || e)})};
  }
  if (was && was.state === 'current' && was.version === live.version) return {none: `${sourceId}@${live.version} is already observed`};
  const d = projection.diffFor(sourceId, live.version);
  if (!d.ok) {
    if (was?.state === 'stale' && was.live === live.version) return {none: `${sourceId} is already recorded as stale at ${live.version}`};
    return {record: record('stale', was?.version ?? null, {why: clip(d.why), live_version: live.version})};
  }
  const listed = d.changes.count <= CHANGE_LIST_MAX;
  return {record: record('current', live.version, {digest: d.digest, count: d.count, changes: {...d.changes, listed},
    nodes: listed ? d.nodes : [], relationships: listed ? d.relationships : []},
    live.effective_at ?? effective_at)};
}

/** The change event of one applied ledger entry (projection.log item). */
export function eventOf(item) {
  if (item.observation) {
    const o = item.observation;
    return {seq: item.seq, hash: item.hash, key: o.state === 'current' ? `${o.source}@${o.to_version}` : `${o.source}@${o.to_version}#${o.state}@${item.seq}`,
      source: o.source, from_version: o.from_version, to_version: o.to_version, state: o.state, replay: o.replay,
      nodes: o.nodes, relationships: o.relationships};
  }
  return {seq: item.seq, hash: item.hash, key: `graph@${item.hash}`, source: 'graph', from_version: item.parent, to_version: item.hash,
    state: 'current', replay: 'applied', kind: item.kind, author: item.author, assertions: item.records, retractions: item.retractions};
}

/**
 * The change events after ledger seq `after`, up to the view's cursor, in ledger order: {events, cursor, more}. A
 * consumer keeps `cursor` and asks again from it; `key` (source plus version) identifies an event across re-reads.
 */
export function changeEvents(projection, {after = 0, limit = 100, view = projection.at()} = {}) {
  if (!Number.isInteger(after) || after < 0) throw new RangeError('after is a ledger seq');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError('limit is 1 to 10000');
  const items = projection.log.filter(x => x.seq > after && x.seq <= view.seq);
  const page = items.slice(0, limit), more = items.length > limit;
  const events = page.map(item => {
    const e = eventOf(item);
    if (e.source !== 'graph') return e;
    // a graph-ledger entry names the subjects it touched: what it asserted, and what it retracted
    const records = [...e.assertions.map(id => view.assertion(id).record),
      ...e.retractions.map(id => view.assertion(projection.retractionOf(id).retracts).record)];
    return {...e, nodes: [...new Set(records.filter(r => r.kind === 'entity').map(r => r.subject))].sort(byString),
      relationships: [...new Set(records.filter(r => r.kind === 'relationship').map(r => r.subject))].sort(byString)};
  });
  return {events, cursor: page.length ? page.at(-1).seq : after, more};
}

/**
 * What a change event reaches: the reverse impact closure of what it changed -- the changed entities, and for a changed
 * relationship its dependent end -- taken both just before and just after the change (a withdrawn node's dependents
 * are found where it still was). Plus the relationships incident to a changed entity (its qualifications,
 * verifications, mentions), which a consumer reassesses without the graph declaring them invalid. Bounded, explained.
 */
export function affected(projection, event, opts = {}) {
  if (event.nodes === null) return {event: {seq: event.seq, key: event.key, source: event.source}, unknown: true, seeds: [], nodes: [], incident: [],
    why: 'the changed subjects were too many to list and the source could not be re-derived here', coverage: {truncated: true}};
  const changed = [...event.nodes];
  const relationships = event.relationships ?? [];
  const after = projection.at(event.seq), before = projection.at(event.seq - 1);
  const seeds = new Set(changed);
  for (const subject of relationships) {
    const r = [after, before].map(v => v.query(subject, 'recorded')).flat()[0];
    if (!r) continue;
    const rec = (after.assertion(r.id) ?? before.assertion(r.id)).record, impact = RELATIONSHIPS[rec.type].impact;
    if (impact === 'to->from') seeds.add(rec.from); else if (impact === 'from->to') seeds.add(rec.to);
  }
  const reach = [after, before].map(v => closure(v, [...seeds], {...opts, direction: 'reverse', mode: opts.mode ?? 'established'}));
  const nodes = new Map();
  for (const r of reach) for (const n of r.nodes) if (!nodes.has(n.id)) nodes.set(n.id, {...n, seen_at: r.cursor});
  const incident = new Map();
  for (const v of [before, after]) for (const n of changed) for (const e of v.edgesOf(n, {mode: 'established'})) if (!incident.has(e.subject)) incident.set(e.subject, {...e, seen_at: v.seq});
  return {event: {seq: event.seq, key: event.key, source: event.source}, seeds: [...seeds].sort(byString),
    nodes: [...nodes.values()].sort((x, y) => x.depth - y.depth || byString(x.id, y.id)),
    incident: [...incident.values()].sort((x, y) => byString(x.subject, y.subject)),
    coverage: {truncated: reach.some(r => r.coverage.truncated), before: reach[1].coverage, after: reach[0].coverage},
    continuation: {after: reach[0].continuation, before: reach[1].continuation}};
}

/**
 * Where each registered source stands against the graph, checked NOW (this reads each source's current version; it
 * writes nothing): current, stale (the source moved since it was observed, or its last observation recorded it so),
 * unavailable, or never-observed. `synchronization` says how the graph learns of a change: only by an observation.
 */
export function freshness(projection, {view = projection.at()} = {}) {
  const recorded = new Map(view.sources().map(s => [s.id, s]));
  return [...projection.adapters.keys()].sort(byString).map(id => {
    const r = recorded.get(id) ?? null;
    let live = null, why = null;
    try { live = projection.adapters.get(id).current().version; } catch (e) { why = clip(e.message || e); }
    const state = live === null ? 'unavailable' : !r ? 'never-observed'
      : r.state !== 'current' || r.replay !== 'applied' || r.version !== live ? 'stale' : 'current';
    return {source: id, state, recorded_version: r?.version ?? null, recorded_state: r?.state ?? null, replay: r?.replay ?? null,
      observed_at: r?.observed_at ?? null, live_version: live, why,
      synchronization: 'on observation only: no detector runs continuously in this foundation'};
  });
}
