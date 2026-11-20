// Change events and source observation (KD10; demonstration 2 at foundation level): a changed source yields its
// affected reverse neighbourhood and nothing else; events are ordered by ledger seq, keyed by source plus version and
// read through a cursor; the cursor rule refuses an observation computed on an older state; and stale, unavailable
// and never-observed sources are visible states.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {affected, observationOf, assertion, CHANGE_LIST_MAX} from '../index.mjs';
import {world, SYSTEM, SYSTEM_SNAPSHOT, C, id, src, RUN, T0, at, V1, dirSource, publish} from './fixture.mjs';

const ex = (w, minutes) => ({...w.by('extractor'), observed_at: at(minutes)});
const withEntity = (snap, entity, attributes) => ({...snap, entities: {...snap.entities, [entity]: attributes}});

test('impact: a changed source yields its affected reverse neighbourhood only, not a global invalidation (demonstration 2)', t => {
  const w = world(t), g = w.open();
  g.observe(SYSTEM, ex(w, 0));
  w.publish(withEntity(SYSTEM_SNAPSHOT, C('sdk-gateway'), {version: 2}));
  const e = g.observe(SYSTEM, ex(w, 1)).event;
  assert.deepEqual([e.nodes, e.relationships], [[C('sdk-gateway')], []], 'the event names what changed');
  const a = affected(g.projection, e);
  assert.deepEqual(a.nodes.map(n => n.id).sort(), [C('sdk-gateway'), C('session'), id('capability', 'capability', 'agy-transport'), id('work', 'work-unit', 'u1'), id('work', 'plan', 'p1')].sort());
  assert.deepEqual(a.nodes.find(n => n.id === id('work', 'plan', 'p1')).path.map(s => s.type), ['implemented-by', 'requires-capability', 'depends-on'], 'each reached node says why');
  assert.deepEqual(a.incident.map(x => x.type).sort(), ['depends-on', 'governs', 'implemented-by', 'mentions', 'verifies'], 'the verification and the governing contract are named for reassessment');
  // A dependency dropped by the source reaches its dependent end, found where it still was.
  const dropped = {...SYSTEM_SNAPSHOT, relationships: SYSTEM_SNAPSHOT.relationships.filter(([type, from]) => !(type === 'depends-on' && from === C('session')))};
  w.publish(withEntity(dropped, C('sdk-gateway'), {version: 2}));
  const e2 = g.observe(SYSTEM, ex(w, 2)).event;
  assert.deepEqual([e2.nodes, e2.relationships], [[], [`depends-on(${C('session')} -> ${C('sdk-gateway')})`]]);
  assert.deepEqual(affected(g.projection, e2).nodes.map(n => n.id), [C('session')]);
  // An unrelated change reaches only its own dependents.
  w.publish(withEntity(withEntity(dropped, C('sdk-gateway'), {version: 2}), C('unrelated-b'), {moved: true}));
  const e3 = g.observe(SYSTEM, ex(w, 3)).event;
  assert.deepEqual(affected(g.projection, e3).nodes.map(n => n.id).sort(), [C('unrelated-a'), C('unrelated-b')]);
  // History: the version before a change is still there to view.
  assert.deepEqual([g.view(e.seq - 1).node(C('sdk-gateway')).attributes, g.view().node(C('sdk-gateway')).attributes], [{version: 1}, {version: 2}]);
});

test('events: change events are ordered by ledger seq, keyed by source plus version, and read through a cursor', t => {
  const w = world(t), g = w.open();
  g.observe(SYSTEM, ex(w, 0));
  g.assert([assertion({entity: id('evidence', 'observation', 'o1'), origin: 'synthetic.tool', classification: 'observed', source: src('synthetic.runs', V1), run: RUN, observed_at: T0})], w.by('tool'));
  const v2 = w.publish(withEntity(SYSTEM_SNAPSHOT, C('session'), {moved: 1}));
  g.observe(SYSTEM, ex(w, 1));
  assert.equal(g.observe(SYSTEM, ex(w, 2)).recorded, false, 'the same version again is not an event');
  const all = g.events().events;
  assert.deepEqual(all.map(e => e.source), [SYSTEM, 'graph', SYSTEM]);
  assert.ok(all.every((e, i) => i === 0 || e.seq > all[i - 1].seq), 'in ledger order');
  assert.equal(all[2].key, `${SYSTEM}@${v2}`);
  assert.deepEqual([all[2].from_version, all[2].to_version], [all[0].to_version, v2]);
  assert.deepEqual(all[1].nodes, [id('evidence', 'observation', 'o1')]);
  // A consumer reading one at a time, from its cursor, sees the same events, once each.
  const read = [];
  for (let cursor = 0, n = 0; n < 10; n++) { const p = g.events({after: cursor, limit: 1}); read.push(...p.events); cursor = p.cursor; if (!p.more) break; }
  assert.deepEqual(read.map(e => e.key), all.map(e => e.key));
  assert.deepEqual(g.events({after: all.at(-1).seq}).events, []);
  assert.deepEqual(w.open().events().events.map(e => e.key), all.map(e => e.key), 'a replay gives the same events under the same keys');
});

test('cursor rule: an observation computed on an older state is refused when it lands after a newer one, and read again (pull request 70)', t => {
  const w = world(t), g = w.open();
  g.observe(SYSTEM, ex(w, 0));
  // A slow reader computes V1 -> V2 and is overtaken: the source moves on to V3, which is observed, and then to V4
  // (V1's facts again, under a new version), which is observed too. Then the slow reading lands.
  w.publish(withEntity(SYSTEM_SNAPSHOT, C('sdk-gateway'), {version: 2}));
  const late = observationOf(g.projection, SYSTEM, {observed_at: at(1)}).record;
  w.publish(withEntity(SYSTEM_SNAPSHOT, C('sdk-gateway'), {version: 3}));
  g.observe(SYSTEM, ex(w, 2));
  const v3 = w.publish({...SYSTEM_SNAPSHOT, note: 'reverted'});
  g.observe(SYSTEM, ex(w, 3));
  assert.throws(() => g.supersede([late], w.by('extractor')), e => e.code === 'GRAPH_REFUSED' && /^GRAPH_STALE the observation of synthetic.system starts at/.test(e.message));
  const v = g.view();
  assert.deepEqual([v.sources()[0].version, v.node(C('sdk-gateway')).attributes], [v3, {version: 1}], 'the source stays where its last observation left it');
  assert.equal(g.events().events.length, 3);
  // Two writers on one change: the one that loses the race reads again and finds it recorded.
  const other = w.open();
  w.publish(withEntity(SYSTEM_SNAPSHOT, C('session'), {moved: 2}));
  assert.equal(g.observe(SYSTEM, ex(w, 4)).recorded, true);
  assert.deepEqual(other.observe(SYSTEM, ex(w, 5)).recorded, false);
  assert.equal(other.events().events.length, 4);
});

test('freshness: never-observed, stale and unavailable sources are visible states, and nothing claims continuous synchronization', t => {
  const w = world(t);
  publish(w.srcRoot, 'synthetic.other', {entities: {[C('other')]: {}}, relationships: []});
  let gone = false;
  const g = w.open({sources: [dirSource(w.srcRoot, SYSTEM, {gone: () => gone}), dirSource(w.srcRoot, 'synthetic.other')]});
  const state = () => Object.fromEntries(g.freshness().map(f => [f.source, f.state]));
  assert.deepEqual(state(), {[SYSTEM]: 'never-observed', 'synthetic.other': 'never-observed'});
  assert.ok(g.freshness().every(f => /^on observation only/.test(f.synchronization)));
  g.observe(SYSTEM, ex(w, 0));
  assert.equal(state()[SYSTEM], 'current');
  w.publish(withEntity(SYSTEM_SNAPSHOT, C('session'), {moved: 1}));
  assert.equal(state()[SYSTEM], 'stale', 'the source moved and nothing observed it');
  gone = true;
  assert.equal(state()[SYSTEM], 'unavailable');
  const u = g.observe(SYSTEM, ex(w, 1));
  assert.deepEqual([u.recorded, u.state, u.event.key.includes('#unavailable@')], [true, 'unavailable', true], 'recorded visibly as an event');
  assert.equal(g.observe(SYSTEM, ex(w, 2)).recorded, false, 'and once');
  assert.equal(g.view().node(C('sdk-gateway')).present, true, 'its facts stay, as last observed');
  gone = false;
  assert.equal(g.observe(SYSTEM, ex(w, 3)).state, 'current');
  // A version the extractor cannot project is recorded as stale, its facts as last observed.
  w.publish({...SYSTEM_SNAPSHOT, relationships: [...SYSTEM_SNAPSHOT.relationships, ['causes', C('session'), C('sdk-gateway')]]});
  const s = g.observe(SYSTEM, ex(w, 4));
  assert.deepEqual([s.state, /"causes" is not registered/.test(s.record.attributes.why)], ['stale', true]);
  assert.equal(state()[SYSTEM], 'stale');
  assert.deepEqual(g.view().node(C('session')).attributes, {moved: 1});
});

test('bounded: an observation lists at most CHANGE_LIST_MAX changed subjects; beyond that their count and digest, and replay re-derives the list', t => {
  const entities = {};
  for (let i = 0; i <= CHANGE_LIST_MAX; i++) entities[C(`n${i}`)] = {};
  const w = world(t, {snapshot: {entities, relationships: []}}), g = w.open();
  const r = g.observe(SYSTEM, ex(w, 0));
  const a = r.record.attributes;
  assert.deepEqual([a.changes.count, a.changes.listed, a.nodes.length, a.relationships.length], [CHANGE_LIST_MAX + 1, false, 0, 0], 'the record stays small');
  assert.equal(r.event.nodes.length, CHANGE_LIST_MAX + 1, 'the event names every change, re-derived from the versions');
  assert.equal(w.open().events().events[0].nodes.length, CHANGE_LIST_MAX + 1, 'and so does a replay');
  const blind = w.open({sources: [dirSource(w.srcRoot, SYSTEM, {gone: () => true})]});
  const e = blind.events().events[0];
  assert.deepEqual([e.nodes, affected(blind.projection, e).unknown], [null, true], 'a replay that cannot read the source says the changes are unknown');
});
