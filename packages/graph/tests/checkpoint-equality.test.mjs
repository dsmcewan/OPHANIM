// Semantics preserved (register KG-1, KP4; docs/knowledge-graph/checkpoint.md): a graph opened from a snapshot plus the
// entries after it equals the full open of the same ledger -- the projection digest at every cursor, every as-of view in
// every query mode with every record, traversal, change events and the cursor rule, freshness, and the verification
// fields -- for a snapshot at the head; behind it, with assertions, a supersede and a retract after it; with a source
// whose version changed after it; and for a federation import source. A source's replay status is the one the snapshot
// recorded, never better, and the audit (verifySnapshot) performs the full open and compares. A REAL packages/ledger
// chain; SYNTHETIC keys generated per test; no provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {generateSigner} from '../../ledger/chain.mjs';
import {assertion, retraction, writeSnapshot, verifySnapshot, closure, neighborhood, contradictions, affected, observationOf} from '../index.mjs';
import {world, ORIGINS, SYSTEM, SYSTEM_SNAPSHOT, C, id, src, RUN, T0, at, V1, dirSource} from './fixture.mjs';
import {federation, financeSnapshot, technologySnapshot, TECH, F, at as fedAt} from './federation-fixture.mjs';

const ex = (w, minutes) => ({...w.by('extractor'), observed_at: at(minutes)});
const tool = over => assertion({origin: 'synthetic.tool', classification: 'observed', source: src('synthetic.runs', V1), run: RUN, observed_at: T0, ...over});
const changed = (key, attributes) => ({...SYSTEM_SNAPSHOT, entities: {...SYSTEM_SNAPSHOT.entities, [C(key)]: attributes}});
const MODES = ['recorded', 'established', 'possible', 'transitions'];
const EDGE_MODES = ['established', 'possible', 'recorded'];
/** The verification fields a full open reports (rederived counts the work this open did, so it is compared apart). */
const fields = v => ({ok: v.ok, entries: v.entries, head: v.head, partial: v.partial, complete: v.complete, notes: v.notes});

/**
 * Everything a reader of the graph sees: at every cursor, the digest, head, counts, sources and, for every subject, its
 * node, each query mode, its incident edges in each mode and its full records; at the head, the traversals from every
 * node, the change events and their affected neighbourhoods, freshness, the next observation of each source (the
 * cursor rule's state), and the verification fields.
 */
function readout(g) {
  const p = g.projection, head = g.view();
  const asOf = c => {
    const v = g.view(c);
    return {digest: v.digest(), head: v.head, stats: v.stats(), sources: v.sources(), subjects: v.subjects().map(s => ({s, node: v.node(s),
      modes: MODES.map(m => v.query(s, m)), edges: EDGE_MODES.map(mode => v.edgesOf(s, {mode})), records: v.query(s, 'recorded').map(a => v.assertion(a.id).record)}))};
  };
  const nodes = head.subjects().filter(s => !s.includes('('));
  const events = g.events({limit: 10_000});
  return {seq: p.seq, head: p.head, log: p.log, cursors: Array.from({length: p.seq + 1}, (_, c) => asOf(c)),
    traversal: nodes.map(s => ({s, reverse: closure(head, s), forward: closure(head, s, {direction: 'forward'}), possible: closure(head, s, {mode: 'possible'}),
      hood: neighborhood(head, s, {direction: 'both'}), contradictions: contradictions(head, s)})),
    events, affected: events.events.map(e => affected(p, e)), freshness: g.freshness(),
    next: [...p.adapters.keys()].sort().map(sid => { const o = observationOf(p, sid, {observed_at: at(99)}); return o.none ?? o.record.id; }),
    verification: fields(g.verification)};
}
/** The open from the snapshot equals the full open; and the snapshot was used. */
function same(fast, full, {seq, tail}) {
  const s = fast.verification.snapshot;
  assert.deepEqual([s.used, s.seq, s.tail, s.reason], [true, seq, tail, null], JSON.stringify(s.refusals));
  assert.equal(fast.verification.rederived, tail, 'this open re-derived the entries after the snapshot, and only those');
  assert.deepEqual(readout(fast), readout(full));
}
function pinned(dir) {
  const signer = generateSigner('snapshot-key'), keys = {[signer.key_id]: signer.publicJwk};
  return {signer, dir, snapshot: {dir, keys}};
}

// Every kind of entry: observations of a changing source, a tool's records, a supersession, a proposal, a retraction.
function history(w, g, from = 0) {
  const o = tool({entity: id('evidence', 'observation', `o${from}`), attributes: {v: 1}});
  g.assert([o, tool({type: 'verifies', from: o.subject, to: C('session')})], w.by('tool'));
  const o2 = tool({entity: o.subject, supersedes: [o.id], attributes: {v: 2}});
  g.supersede([o2], w.by('tool'));
  g.assert([assertion({entity: id('evidence', 'hypothesis', `h${from}`), origin: 'synthetic.agent', classification: 'hypothetical', source: src('synthetic.notes'),
    observed_at: T0, missing_evidence: ['a guess']}), assertion({type: 'contradicts', from: id('evidence', 'hypothesis', `h${from}`), to: o.subject, origin: 'synthetic.agent',
    classification: 'hypothetical', source: src('synthetic.notes'), observed_at: T0, missing_evidence: ['a guess']})], w.by('agent'));
  g.retract([retraction({retracts: o2.id, origin: 'synthetic.tool', reason: 'superseded run', observed_at: at(from + 6)})], w.by('tool'));
}

test('equality: a snapshot at the head opens to the full open\'s graph', t => {
  const w = world(t, {checkpointEvery: 2}), g = w.open(), s = pinned(path.join(w.dir, 'snapshots'));
  g.observe(SYSTEM, ex(w, 0));
  history(w, g);
  w.publish(changed('sdk-gateway', {version: 2}));
  g.observe(SYSTEM, ex(w, 7));
  const r = writeSnapshot(g, {dir: s.dir, signer: s.signer});
  same(w.open({snapshot: s.snapshot}), w.open(), {seq: r.seq, tail: 0});
});

test('equality: a snapshot behind the head, with assertions, a supersede and a retract after it', t => {
  const w = world(t, {checkpointEvery: 2}), g = w.open(), s = pinned(path.join(w.dir, 'snapshots'));
  g.observe(SYSTEM, ex(w, 0));
  const r = writeSnapshot(g, {dir: s.dir, signer: s.signer});
  history(w, g);
  const kinds = g.ledger.read().filter(e => e.seq > r.seq && e.kind !== 'checkpoint').map(e => e.kind);
  assert.deepEqual(kinds, ['graph.assert', 'graph.supersede', 'graph.assert', 'graph.retract'], 'the tail holds assertions, a supersede and a retract');
  assert.ok(g.ledger.read().some(e => e.seq > r.seq && e.kind === 'checkpoint'), 'and ledger checkpoints between them');
  same(w.open({snapshot: s.snapshot}), w.open(), {seq: r.seq, tail: 4});
});

test('equality: a source whose version changed after the snapshot, before and after it is observed again', t => {
  const w = world(t), g = w.open(), s = pinned(path.join(w.dir, 'snapshots'));
  g.observe(SYSTEM, ex(w, 0));
  history(w, g);
  const r = writeSnapshot(g, {dir: s.dir, signer: s.signer});
  // Moved, not yet observed: both opens hold it as last observed, and both say it is stale.
  w.publish(changed('sdk-gateway', {version: 2}));
  const fast = w.open({snapshot: s.snapshot});
  same(fast, w.open(), {seq: r.seq, tail: 0});
  assert.equal(fast.freshness()[0].state, 'stale');
  const late = observationOf(fast.projection, SYSTEM, {observed_at: at(8)}).record;      // a slow reader: version 1 to 2
  // It moves on and is observed again: the observation after the snapshot is re-derived from the source at that version.
  w.publish(changed('sdk-gateway', {version: 3}));
  const e = g.observe(SYSTEM, ex(w, 9)).event;
  assert.deepEqual(e.nodes, [C('sdk-gateway')]);
  same(w.open({snapshot: s.snapshot}), w.open(), {seq: r.seq, tail: 1});
  // The cursor rule holds on the graph opened from the snapshot as on the full open: the slow reading is refused.
  for (const h of [w.open({snapshot: s.snapshot}), w.open()]) {
    assert.throws(() => h.supersede([late], w.by('extractor')), x => x.code === 'GRAPH_REFUSED' && /^GRAPH_STALE the observation of synthetic.system starts at/.test(x.message));
  }
});

test('equality: a federation import source -- the central opened from a snapshot equals its full open', t => {
  const w = federation(t), s = pinned(path.join(w.root, 'central-snapshots'));
  const tech = w.open('technology'), fin = w.open('finance');
  w.publishSource('technology', technologySnapshot());
  tech.observe(0);
  const tv1 = tech.publish(1).export;
  const ref = {instance: 'technology', anchor: w.anchors.technology, node: TECH.api, version: tv1.nodes.find(n => n.node === TECH.api).version};
  w.publishSource('finance', financeSnapshot(ref));
  fin.observe(2);
  fin.publish(3);
  const central = w.central();
  central.catchUp({by: w.centralBy, now: fedAt(4)});
  const r = writeSnapshot(central.graph, {dir: s.dir, signer: s.signer});
  const compare = (tail, now) => {
    const fast = w.central({snapshot: s.snapshot}), full = w.central();
    same(fast.graph, full.graph, {seq: r.seq, tail});
    assert.deepEqual([fast.dependencies({now}), fast.freshness({now})], [full.dependencies({now}), full.freshness({now})]);
    return fast;
  };
  const head = compare(0, fedAt(5));
  assert.deepEqual(head.dependencies({now: fedAt(5)}).links.map(l => [l.from, l.to, l.established]), [[F.run, TECH.api, true]]);
  // After the snapshot: Technology changes its source and publishes again, and the central imports it.
  w.publishSource('technology', technologySnapshot({api: {tier: 'gold'}}));
  tech.observe(10);
  tech.publish(11);
  const c2 = central.catchUp({by: w.centralBy, now: fedAt(12)});
  assert.ok(c2.imported.technology.length > 0, 'the export after the snapshot is imported');
  const tail = central.graph.ledger.read().filter(e => e.seq > r.seq && e.kind.startsWith('graph.')).length;
  assert.ok(tail > 0);
  compare(tail, fedAt(13));
});

test('never better: a source the snapshot recorded unavailable is never loaded as applied, and the audit says how it differs', t => {
  const w = world(t), g = w.open(), s = pinned(path.join(w.dir, 'snapshots'));
  g.observe(SYSTEM, ex(w, 0));
  g.assert([tool({entity: id('evidence', 'observation', 'o1')})], w.by('tool'));
  let gone = true;
  const sources = () => [dirSource(w.srcRoot, SYSTEM, {gone: () => gone})];
  const blind = w.open({sources: sources()});
  assert.deepEqual(blind.view().sources().map(x => x.replay), ['unavailable']);
  const r = writeSnapshot(blind, {dir: s.dir, signer: s.signer});
  // The source is readable again: the open from the snapshot still holds it as the snapshot recorded it.
  gone = false;
  const fast = w.open({sources: sources(), snapshot: s.snapshot});
  assert.equal(fast.verification.snapshot.used, true, `the snapshot is used: ${fast.verification.snapshot.reason}`);
  assert.deepEqual(fast.verification.snapshot.sources.map(x => [x.id, x.replay]), [[SYSTEM, 'unavailable']]);
  assert.deepEqual(fast.view().sources().map(x => [x.id, x.replay]), [[SYSTEM, 'unavailable']], 'never applied');
  assert.equal(fast.view().node(C('sdk-gateway')).present, false, 'its facts are absent, not assumed');
  assert.equal(fast.verification.complete, false);
  assert.deepEqual(fast.verification.partial.map(p => [p.seq, p.kind]), [[2, 'graph.assert']]);
  assert.match(fast.verification.partial[0].why, /synthetic\.system@sha256:[0-9a-f]+: replay unavailable, as the snapshot at seq 3 recorded it; its facts are not re-derived here/);
  assert.equal(fast.freshness()[0].state, 'stale', 'and freshness says it is not current');
  // Read again in full now, the source is applied: the audit performs that full open and reports the difference.
  const full = w.open({sources: sources()});
  assert.deepEqual(full.view().sources().map(x => x.replay), ['applied']);
  const audit = verifySnapshot({dir: w.ledgerDir, anchor: w.anchor, origins: ORIGINS, sources: sources(), snapshot: s.snapshot});
  assert.deepEqual([audit.ok, audit.used, audit.seq, audit.recorded], [false, true, r.seq, r.projection_digest]);
  assert.match(audit.differences.join('\n'), /at seq 3 the full open's digest is sha256:[0-9a-f]+, the snapshot recorded sha256:/);
  // While the source stays unreadable, the open from the snapshot and the full open agree on the graph.
  gone = true;
  assert.equal(w.open({sources: sources(), snapshot: s.snapshot}).digest(), w.open({sources: sources()}).digest());
});

test('audit: verifySnapshot performs the full open and compares digests; a sound snapshot passes', t => {
  const w = world(t), g = w.open(), s = pinned(path.join(w.dir, 'snapshots'));
  g.observe(SYSTEM, ex(w, 0));
  const r = writeSnapshot(g, {dir: s.dir, signer: s.signer});
  history(w, g);
  const audit = verifySnapshot({dir: w.ledgerDir, anchor: w.anchor, origins: ORIGINS, sources: [dirSource(w.srcRoot)], snapshot: s.snapshot});
  assert.deepEqual([audit.ok, audit.used, audit.seq, audit.differences, audit.at.full, audit.at.snapshot], [true, true, r.seq, [], r.projection_digest, r.projection_digest]);
  assert.equal(audit.full.digest, g.digest());
  // An audit of a snapshot this reader would not use says so, and why.
  const other = verifySnapshot({dir: w.ledgerDir, anchor: w.anchor, origins: ORIGINS, sources: [dirSource(w.srcRoot)], snapshot: {...s.snapshot, keys: {}}});
  assert.deepEqual([other.ok, other.used], [false, false]);
  assert.match(other.reason, /has not pinned/);
});
