// Bounded, explained traversal (KD9; directive section 12): the defaults cut with a stated limit and a continuation that
// resumes exactly; edge, depth and ceiling bounds; explained paths; and impact closure that follows only the
// impact-following types, each in its direction.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertion, neighborhood, closure, resume, DEFAULTS, CEILINGS} from '../index.mjs';
import {world, SYSTEM, C, id, src, RUN, T0, V1} from './fixture.mjs';

// A hub with 1,200 dependents, a chain of ten, and two groups of 50 joined by all 2,500 dependencies.
const BIG = (() => {
  const entities = {[C('hub')]: {}}, relationships = [];
  for (let i = 0; i < 1200; i++) { entities[C(`d${i}`)] = {}; relationships.push(['depends-on', C(`d${i}`), C('hub')]); }
  for (let i = 0; i < 10; i++) entities[C(`c${i}`)] = {};
  for (let i = 0; i < 9; i++) relationships.push(['depends-on', C(`c${i}`), C(`c${i + 1}`)]);
  for (let i = 0; i < 50; i++) { entities[C(`a${i}`)] = {}; entities[C(`b${i}`)] = {}; }
  for (let i = 0; i < 50; i++) for (let j = 0; j < 50; j++) relationships.push(['depends-on', C(`a${i}`), C(`b${j}`)]);
  return {entities, relationships};
})();
function big(t) {
  const w = world(t, {snapshot: BIG}), g = w.open();
  g.observe(SYSTEM, {...w.by('extractor'), observed_at: T0});
  return {w, g, v: g.view()};
}
function pages(v, first) {
  const all = [...first.nodes];
  for (let r = first, n = 0; r.continuation && n < 50; n++) { r = resume(v, r.continuation); all.push(...r.nodes); }
  return all;
}

test('bounds: the defaults cut a large neighbourhood at 500 nodes, say so, and a continuation resumes exactly where it stopped', t => {
  const {v} = big(t);
  assert.deepEqual(DEFAULTS, {depth: 4, maxNodes: 500, maxEdges: 2000});
  const r = neighborhood(v, C('hub'));
  assert.deepEqual([r.nodes.length, r.coverage.truncated, r.coverage.limit, typeof r.continuation], [500, true, 'nodes', 'string']);
  const all = pages(v, r);
  assert.equal(all.length, 1201, 'every dependent and the hub, over the pages');
  assert.equal(new Set(all.map(n => n.id)).size, 1201, 'and none twice');
  assert.deepEqual(closure(v, C('hub')).coverage.returned.nodes, 500, 'closure is bounded the same way');
  assert.equal(pages(v, closure(v, C('hub'))).length, 1201);
});

test('bounds: the edge bound, the depth bound with a deeper continuation, and ceilings no caller can lift', t => {
  const {v} = big(t);
  const dense = neighborhood(v, C('a0'), {depth: 2});
  assert.deepEqual([dense.coverage.limit, dense.coverage.examined], ['edges', 2000], 'the 2,000 steps examined bound the work');
  assert.ok(dense.coverage.returned.edges <= 2000);
  assert.ok(dense.nodes.length <= 100);
  const chain = neighborhood(v, C('c0'), {direction: 'out'});
  assert.deepEqual([chain.nodes.map(n => n.id), chain.coverage.limit], [[0, 1, 2, 3, 4].map(i => C(`c${i}`)), 'depth']);
  const deeper = resume(v, chain.continuation);
  assert.deepEqual(deeper.nodes.map(n => [n.id, n.depth]), [5, 6, 7, 8].map(i => [C(`c${i}`), i]), 'the continuation goes deeper, and only returns what is new');
  assert.deepEqual(pages(v, chain).map(n => n.id), Array.from({length: 10}, (_, i) => C(`c${i}`)));
  for (const bad of [{depth: CEILINGS.depth + 1}, {maxNodes: CEILINGS.maxNodes + 1}, {maxEdges: Infinity}, {depth: -1}]) {
    assert.throws(() => neighborhood(v, C('hub'), bad), RangeError, JSON.stringify(bad));
  }
  assert.throws(() => resume(v, 'not-a-token'), RangeError);
});

test('explained paths: every result node carries the path from the seed and the assertions that support each step and itself', t => {
  const w = world(t), g = w.open();
  g.observe(SYSTEM, {...w.by('extractor'), observed_at: T0});
  // A second, independent origin observes one of the dependencies too.
  const seen = assertion({type: 'depends-on', from: C('session'), to: C('sdk-gateway'), origin: 'synthetic.tool', classification: 'observed', source: src('synthetic.traces', V1), run: RUN, observed_at: T0});
  g.assert([seen], w.by('tool'));
  const v = g.view(), fact = s => v.query(s, 'established').filter(a => a.classification === 'authoritative').map(a => a.id);
  const r = closure(v, C('sdk-gateway'));
  const p1 = r.nodes.find(n => n.id === id('work', 'plan', 'p1'));
  const steps = [`implemented-by(${id('capability', 'capability', 'agy-transport')} -> ${C('sdk-gateway')})`,
    `requires-capability(${id('work', 'work-unit', 'u1')} -> ${id('capability', 'capability', 'agy-transport')})`,
    `depends-on(${id('work', 'plan', 'p1')} -> ${id('work', 'work-unit', 'u1')})`];
  assert.deepEqual(p1.path.map(s => [s.subject, s.assertions]), steps.map(s => [s, fact(s)]));
  assert.deepEqual([p1.depth, p1.assertions.map(a => a.id)], [3, fact(id('work', 'plan', 'p1'))]);
  assert.equal(p1.assertions[0].source.id, SYSTEM);
  const session = r.nodes.find(n => n.id === C('session'));
  assert.deepEqual(session.path[0].assertions.sort(), [...fact(`depends-on(${C('session')} -> ${C('sdk-gateway')})`), seen.id].sort(), 'both origins support the step');
});

test('impact: closure follows only the impact-following types, each in its own direction', t => {
  const w = world(t), g = w.open();
  g.observe(SYSTEM, {...w.by('extractor'), observed_at: T0});
  // Relationships impact never follows: a measured qualification, a contradiction, a mention.
  const tool = over => assertion({origin: 'synthetic.tool', classification: 'observed', source: src('synthetic.runs', V1), run: RUN, observed_at: T0, ...over});
  g.assert([tool({entity: id('evidence', 'observation', 'x')}), tool({entity: id('evidence', 'observation', 'y')})], w.by('tool'));
  g.assert([tool({type: 'contradicts', from: id('evidence', 'observation', 'x'), to: id('evidence', 'observation', 'y')})], w.by('tool'));
  const v = g.view();
  const reverse = closure(v, C('sdk-gateway')).nodes.map(n => n.id).sort();
  assert.deepEqual(reverse, [C('sdk-gateway'), C('session'), id('capability', 'capability', 'agy-transport'), id('work', 'work-unit', 'u1'), id('work', 'plan', 'p1')].sort());
  const near = neighborhood(v, C('sdk-gateway'), {depth: 1}).nodes.map(n => n.id);
  for (const x of [id('systems', 'file', 'readme'), id('systems', 'contract', 'k1'), id('systems', 'test', 't1')]) {
    assert.ok(near.includes(x), `${x} is a neighbour`);
    assert.ok(!reverse.includes(x), `${x} is not reached by a change to the gateway`);
  }
  assert.deepEqual(closure(v, id('work', 'plan', 'p1'), {direction: 'forward'}).nodes.map(n => n.id),
    [id('work', 'plan', 'p1'), id('work', 'work-unit', 'u1'), id('capability', 'capability', 'agy-transport'), C('sdk-gateway'), id('systems', 'contract', 'k1'), id('systems', 'test', 't1')],
    'forward: what the plan rests on, down to the contract that governs the gateway and the test that verifies it');
  assert.deepEqual(closure(v, id('systems', 'contract', 'k1')).nodes.map(n => n.id).sort(), [id('systems', 'contract', 'k1'), ...reverse].sort(), 'a contract change reaches what it governs, and on');
  assert.deepEqual(closure(v, id('evidence', 'observation', 'x')).nodes.map(n => n.id), [id('evidence', 'observation', 'x')], 'a contradiction carries no impact');
  assert.deepEqual(closure(v, C('sdk-gateway'), {types: ['mentions', 'depends-on']}).nodes.map(n => n.id), [C('sdk-gateway'), C('session')], 'asking for a non-impact type does not add it');
});
