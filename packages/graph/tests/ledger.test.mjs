// The graph ledger's behaviours on a REAL packages/ledger chain with synthetic keys: refusals (demonstration 12),
// idempotency, admission and the hypothetical, contradictions (demonstration 6), history and as-of views, derived
// staleness, and the bases a relationship may be admitted from.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {assertion, retraction, closure, contradictions, neighborhood, GRAPH_SCHEMA} from '../index.mjs';
import {world, SYSTEM, C, id, src, RUN, T0, at, V1, dirSource} from './fixture.mjs';

const refused = (fn, re) => assert.throws(fn, e => e.code === 'GRAPH_REFUSED' && re.test(e.message), String(re));
const tool = (over, origin = 'synthetic.tool') => assertion({origin, classification: 'observed', source: src('synthetic.runs', V1), run: RUN, observed_at: T0, ...over});
const proposal = (over, origin = 'synthetic.agent') => assertion({origin, classification: 'hypothetical', source: src('synthetic.notes'), observed_at: T0, missing_evidence: ['proposed, not checked'], ...over});
const obs = (key, attributes = {}) => tool({entity: id('evidence', 'observation', key), attributes});
function observed(t) {
  const w = world(t), g = w.open();
  g.observe(SYSTEM, {...w.by('extractor'), observed_at: T0});
  return {w, g};
}

test('refusals: invalid ids, unsupported edges, unauthorized writes, broken references and unverified claims are refused and leave the ledger unchanged (demonstration 12)', t => {
  const {w, g} = observed(t);
  const o1 = obs('o1');
  g.assert([o1], w.by('tool'));
  const v2 = tool({entity: o1.subject, supersedes: [o1.id], attributes: {v: 2}});
  g.supersede([v2], w.by('tool'));
  const entries = g.ledger.read().length, digest = g.digest();
  refused(() => g.assert([tool({entity: id('learning', 'widget', 'x')})], w.by('tool')), /"widget" is not an entity type/);
  refused(() => g.assert([tool({type: 'causes', from: o1.subject, to: C('sdk-gateway')})], w.by('tool')), /"causes" is not registered/);
  refused(() => g.assert([tool({type: 'detects', from: id('learning', 'failure-class', 'f1'), to: id('systems', 'test', 't1')})], w.by('tool')), /detects does not join/);
  refused(() => g.assert([proposal({entity: id('evidence', 'claim', 'c')}, 'rogue.agent')], w.by('agent')), /origin "rogue.agent" is not registered/);
  refused(() => g.assert([obs('o9')], w.by('agent')), /key "agent-key" may not write as origin "synthetic.tool"/);
  refused(() => g.assert([assertion({entity: C('handmade'), origin: 'synthetic.extractor', classification: 'authoritative', source: src(SYSTEM, V1), observed_at: T0})], w.by('extractor')),
    /projected from its source by observing it/);
  refused(() => g.assert([proposal({type: 'depends-on', from: C('session'), to: C('ghost')})], w.by('agent')), /broken reference: ophanim\/systems\/component\/ghost is not in the graph/);
  refused(() => g.assert([tool({type: 'verifies', from: o1.subject, to: C('ghost')})], w.by('tool')), /ghost is not in the graph/);
  refused(() => g.assert([assertion({entity: id('evidence', 'conclusion', 'c1'), origin: 'synthetic.rule', classification: 'derived', source: src('synthetic.rules'), observed_at: T0, inputs: [V1]})], w.by('rule')),
    /derived from sha256:1+, which is not a current assertion/);
  refused(() => g.assert([proposal({entity: id('evidence', 'claim', 'm'), status: 'verified', verified_by: [o1.id]}, 'synthetic.model')], w.by('model')), /never verified/);
  refused(() => g.assert([tool({entity: id('evidence', 'claim', 'm')}, 'synthetic.model')], w.by('model')), /model origin synthetic.model may not admit an assertion classified observed/);
  refused(() => g.supersede([tool({entity: o1.subject, supersedes: [o1.id], attributes: {v: 3}})], w.by('tool')), /GRAPH_STALE .* already superseded/);
  g.assert([proposal({entity: id('evidence', 'claim', 'only-proposed')})], w.by('agent'));
  const entries2 = g.ledger.read().length;
  refused(() => g.assert([tool({type: 'supports', from: o1.subject, to: id('evidence', 'claim', 'only-proposed')})], w.by('tool')), /needs established endpoints/);
  refused(() => g.retract([retraction({retracts: v2.id, origin: 'synthetic.other-tool', reason: 'not mine', observed_at: T0})], w.by('other')), /retracted by its own origin/);
  assert.deepEqual([entries2 - entries, g.ledger.read().length - entries2], [1, 0], 'every refused write left the ledger as it was');
  assert.notEqual(g.digest(), digest);
  assert.equal(g.view(entries).digest(), digest, 'and the view before the one admitted proposal is unchanged');
  assert.equal(w.open().verification.complete, true);
});

test('idempotency: the same assertion again, at any later time, is a no-op; so is a repeated retraction or observation', t => {
  const {w, g} = observed(t);
  const o1 = obs('o1'), edge = tool({type: 'verifies', from: o1.subject, to: C('sdk-gateway')});
  assert.equal(g.assert([o1, edge], w.by('tool')).appended, true);
  const entries = g.ledger.read().length;
  const again = g.assert([{...o1, observed_at: at(30)}, {...tool({type: 'verifies', from: o1.subject, to: C('sdk-gateway'), observed_at: at(31)})}], w.by('tool'));
  assert.deepEqual([again.appended, again.duplicates], [false, [o1.id, edge.id]], 'observed later, the same assertion has the same id');
  assert.equal(g.observe(SYSTEM, {...w.by('extractor'), observed_at: at(32)}).recorded, false);
  const edges = g.view().edgesOf(o1.subject);
  assert.deepEqual(edges.map(e => [e.type, e.assertions]), [['verifies', [edge.id]]], 'one edge, one supporting assertion');
  const r = retraction({retracts: edge.id, origin: 'synthetic.tool', reason: 'the run was misattributed', observed_at: at(40)});
  assert.equal(g.retract([r], w.by('tool')).appended, true);
  assert.equal(g.retract([{...r, observed_at: at(41)}], w.by('tool')).appended, false);
  assert.equal(g.ledger.read().length, entries + 1, 'the repeats wrote nothing');
  assert.equal(w.open().view().edgesOf(o1.subject).length, 0, 'and a replay agrees');
});

test('hypothetical: a proposal is never established or verified, and never overwrites, retracts or invalidates what is', t => {
  const {w, g} = observed(t);
  const dep = proposal({type: 'depends-on', from: C('unrelated-b'), to: C('sdk-gateway')}, 'synthetic.model');
  g.assert([dep], w.by('model'));
  const v = g.view();
  assert.deepEqual([v.current(dep.id), v.established(dep.id)], [true, false]);
  assert.deepEqual(v.query(dep.subject, 'established'), []);
  assert.deepEqual(v.query(dep.subject, 'possible').map(x => [x.id, x.why.split(':')[0]]), [[dep.id, 'hypothetical']]);
  assert.equal(v.edgesOf(C('sdk-gateway')).some(e => e.subject === dep.subject), false, 'not an established edge');
  assert.equal(closure(v, C('sdk-gateway')).nodes.some(n => n.id === C('unrelated-b')), false, 'impact never follows a proposal');
  assert.equal(closure(v, C('sdk-gateway'), {mode: 'possible'}).nodes.some(n => n.id === C('unrelated-b')), true, 'unless the possible is asked for');
  // A verified observation stays what it is, whoever proposes otherwise -- its own tool included.
  const o1 = obs('o1', {outcome: 'pass'});
  g.assert([o1], w.by('tool'));
  refused(() => g.supersede([proposal({entity: o1.subject, supersedes: [o1.id], attributes: {outcome: 'fail'}}, 'synthetic.tool')], w.by('tool')), /GRAPH_HYPOTHETICAL a hypothetical assertion never supersedes a observed one/);
  refused(() => g.assert([proposal({entity: id('evidence', 'claim', 'x'), invalidates: [o1.id]}, 'synthetic.tool')], w.by('tool')), /never invalidates a observed one/);
  refused(() => g.supersede([proposal({entity: o1.subject, supersedes: [o1.id]})], w.by('agent')), /never supersedes|own origin/);
  const after = g.view();
  assert.deepEqual([after.established(o1.id), after.node(o1.subject).attributes.outcome], [true, 'pass']);
  assert.equal(after.query(o1.subject, 'transitions')[0].may.supersede[0], 'synthetic.tool (not as hypothetical)', 'what may change it is stated');
});

test('contradictions: conflicting observations are both kept, linked, and retrievable as a contradiction set (demonstration 6)', t => {
  const {w, g} = observed(t);
  const a = obs('run-a', {outcome: 'pass'}), b = tool({entity: id('evidence', 'observation', 'run-b'), attributes: {outcome: 'fail'}}, 'synthetic.other-tool');
  g.assert([a], w.by('tool'));
  g.assert([b], w.by('other'));
  const link = tool({type: 'contradicts', from: a.subject, to: b.subject});
  g.assert([link], w.by('tool'));
  // A model explains it away: its hypothesis stays a hypothesis beside the evidence, never instead of it.
  const h = proposal({entity: id('evidence', 'hypothesis', 'flaky')}, 'synthetic.model');
  g.assert([h, proposal({type: 'contradicts', from: h.subject, to: a.subject}, 'synthetic.model')], w.by('model'));
  const v = g.view();
  for (const x of [a, b]) assert.deepEqual([v.current(x.id), v.established(x.id)], [true, true], `${x.subject} stays established`);
  const set = contradictions(v, a.subject);
  assert.deepEqual(set.members.map(m => [m.id, m.established]).sort(), [[h.subject, false], [a.subject, true], [b.subject, true]].sort());
  assert.deepEqual(set.members.find(m => m.id === b.subject).assertions.map(x => x.id), [b.id], 'each side carries its own evidence');
  assert.deepEqual(contradictions(v, b.subject, {mode: 'established'}).members.map(m => m.id).sort(), [a.subject, b.subject].sort());
  // Two origins disagree on one subject: both values are kept and listed; a hypothesis never changes the value shown.
  const m = id('evidence', 'observation', 'window');
  g.assert([tool({entity: m, attributes: {tokens: 200000}})], w.by('tool'));
  g.assert([tool({entity: m, attributes: {tokens: 1000000}}, 'synthetic.other-tool')], w.by('other'));
  g.assert([proposal({entity: m, attributes: {tokens: 5}}, 'synthetic.model')], w.by('model'));
  const n = g.view().node(m);
  assert.deepEqual(n.conflicts.map(c => [c.attribute, c.values.map(x => x.value).sort((x, y) => x - y)]), [['tokens', [5, 200000, 1000000]]]);
  assert.notEqual(n.attributes.tokens, 5);
});

test('history: after a supersession and a retraction every as-of view is exact, and nothing is deleted', t => {
  const {w, g} = observed(t);
  const v1 = obs('o1', {v: 1});
  const s1 = g.assert([v1], w.by('tool')).seq;
  const v2 = tool({entity: v1.subject, supersedes: [v1.id], attributes: {v: 2}});
  const s2 = g.supersede([v2], w.by('tool')).seq;
  const s3 = g.retract([retraction({retracts: v2.id, origin: 'synthetic.tool', reason: 'withdrawn', observed_at: T0})], w.by('tool')).seq;
  const [a, b, c] = [s1, s2, s3].map(s => g.view(s));
  assert.deepEqual([a.node(v1.subject).attributes, a.assertion(v2.id)], [{v: 1}, null], 'as of the first entry: v1, and v2 not yet');
  assert.deepEqual([b.node(v1.subject).attributes, b.assertion(v1.id).retired], [{v: 2}, {seq: s2, how: 'superseded', by: v2.id}]);
  assert.equal(c.node(v1.subject).present, false);
  assert.deepEqual(c.query(v1.subject, 'recorded').map(x => [x.id, x.retired?.how]), [[v1.id, 'superseded'], [v2.id, 'retracted']], 'both kept, each with what ended it');
  assert.equal(new Set([a, b, c].map(x => x.digest())).size, 3);
  const again = w.open();
  assert.deepEqual([s1, s2, s3].map(s => again.view(s).digest()), [a, b, c].map(x => x.digest()), 'a replay gives the same views');
  assert.ok(g.ledger.read().filter(e => e.kind.startsWith('graph.')).length >= 4, 'supersession and retraction are new entries');
});

test('derived: a derived assertion names its inputs, and once an input is retracted it is no longer established', t => {
  const {w, g} = observed(t);
  const o1 = obs('o1');
  g.assert([o1], w.by('tool'));
  const d = assertion({entity: id('evidence', 'conclusion', 'c1'), origin: 'synthetic.rule', classification: 'derived', source: src('synthetic.rules'), observed_at: T0, inputs: [o1.id]});
  g.assert([d], w.by('rule'));
  assert.equal(g.view().established(d.id), true);
  g.retract([retraction({retracts: o1.id, origin: 'synthetic.tool', reason: 'bad run', observed_at: T0})], w.by('tool'));
  const v = g.view();
  assert.deepEqual([v.current(d.id), v.established(d.id), v.query(d.subject, 'possible')[0].why.split(':')[0]], [true, false, 'stale']);
});

test('bases: depends-on is never admitted from textual similarity or a model\'s inference; text is a mention', t => {
  const {w, g} = observed(t);
  const text = (type, over = {}) => assertion({type, from: id('systems', 'file', 'readme'), to: C('session'), origin: 'synthetic.text-rule', classification: 'derived',
    source: src('synthetic.text'), observed_at: T0, inputs: [g.view().query(id('systems', 'file', 'readme'), 'established')[0].id], ...over});
  refused(() => g.assert([text('depends-on')], w.by('text')), /depends-on may not be admitted as derived from a textual basis/);
  assert.equal(g.assert([text('mentions')], w.by('text')).appended, true);
  const guess = proposal({type: 'depends-on', from: id('systems', 'file', 'readme'), to: C('session')}, 'synthetic.model');
  g.assert([guess], w.by('model'));
  assert.equal(g.view().established(guess.id), false, 'a model\'s dependency stays a proposal');
  assert.equal(neighborhood(g.view(), C('session'), {types: ['depends-on']}).nodes.some(n => n.id === id('systems', 'file', 'readme')), false);
});

test('unregistered origin: an extractor nobody registered never admits an authoritative assertion', t => {
  const w = world(t);
  const g = w.open({sources: [dirSource(w.srcRoot), {...dirSource(w.srcRoot), id: 'synthetic.rogue', extractor: 'rogue.extractor'}]});
  // the rogue source reads the same snapshot, published under its own id
  fs.cpSync(path.join(w.srcRoot, SYSTEM), path.join(w.srcRoot, 'synthetic.rogue'), {recursive: true});
  assert.throws(() => g.observe('synthetic.rogue', {...w.by('extractor'), observed_at: T0}), /origin "rogue.extractor" is not registered/);
  const v = g.view();
  assert.equal(v.subjects().length, 0, 'nothing of it entered the graph');
  assert.equal(g.ledger.read().filter(e => e.kind.startsWith('graph.')).length, 0);
  assert.equal(GRAPH_SCHEMA, 'ophanim.graph/v1');
});
