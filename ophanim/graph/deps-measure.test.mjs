// The measures over the dependency graph (ophanim/graph/deps/measure.mjs), ported from TELOS's Lachesis
// (lachesis/measure.mjs at 0c9b539): dependencies, blast radius, relevance and an ADVISORY risk class. SYNTHETIC: the
// repository below is made in a temporary directory by this test. Synthetic keys only; no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dependencies, blastRadius, relevance, riskClass, classOf, assess, coverageOf, RISK} from './deps/measure.mjs';
import {repoSource, fileId} from './extract/repo.mjs';
import {openSystemsGraph} from './extract/index.mjs';
import {tempRepo, T0} from './fixtures/repo.mjs';

// hub.mjs is imported by twelve leaves; mid.mjs imports hub and is imported by three; a.mjs and b.mjs import each other.
const FILES = {
  'hub.mjs': 'export const hub = 1;\n',
  'mid.mjs': "import {hub} from './hub.mjs';\nexport const mid = hub;\n",
  ...Object.fromEntries([1, 2, 3].map(i => [`m${i}.mjs`, `import {mid} from './mid.mjs';\nexport const m${i} = mid;\n`])),
  ...Object.fromEntries(Array.from({length: 8}, (_, i) => [`leaf${i}.mjs`, `import {hub} from './hub.mjs';\nexport const leaf${i} = hub;\n`])),
  'a.mjs': "import {b} from './b.mjs';\nexport const a = () => b;\n", 'b.mjs': "import {a} from './a.mjs';\nexport const b = () => a;\n",
  'alone.mjs': 'export const alone = 1;\n',
};
const graph = t => {
  const {repo, commit} = tempRepo(t); commit(FILES, 'fixture');
  const g = openSystemsGraph({sources: [repoSource({repo})]});
  t.after(g.close);
  g.graph.observe('ophanim.repo', {...g.by, observed_at: T0});
  return g.graph.view();
};
const files = (...names) => names.map(n => fileId(n)).sort();

test('DEPENDENCIES are everything a node needs, through every hop, without the node itself; a cycle ends', t => {
  const v = graph(t);
  assert.deepEqual(dependencies(v, fileId('m1.mjs'), {types: ['depends-on']}).nodes, files('mid.mjs', 'hub.mjs'));
  assert.deepEqual(dependencies(v, fileId('a.mjs'), {types: ['depends-on']}).nodes, files('b.mjs'));
  assert.deepEqual(dependencies(v, fileId('hub.mjs'), {types: ['depends-on']}), {count: 0, nodes: []});
});

test('BLAST RADIUS is what depends on a node, to a depth, without the node itself', t => {
  const v = graph(t), hub = fileId('hub.mjs');
  assert.equal(blastRadius(v, hub, {types: ['depends-on']}).count, 12);
  assert.deepEqual(blastRadius(v, hub, {types: ['depends-on'], depth: 1}).nodes, files('mid.mjs', ...Array.from({length: 8}, (_, i) => `leaf${i}.mjs`)));
  assert.deepEqual(blastRadius(v, fileId('mid.mjs'), {types: ['depends-on']}).nodes, files('m1.mjs', 'm2.mjs', 'm3.mjs'));
  assert.deepEqual(blastRadius(v, fileId('a.mjs'), {types: ['depends-on']}).nodes, files('b.mjs'));
  assert.deepEqual(blastRadius(v, hub, {types: ['depends-on'], depth: 0}), {count: 0, nodes: []});
  assert.throws(() => blastRadius(v, hub, {depth: -1}), /depth is a non-negative integer or Infinity/);
});

test('THE RISK CLASS is advisory and blast-driven: 10 or more dependents is high, 3 or more medium, fewer low; low is raised to medium unless coverage is attested complete', t => {
  const v = graph(t), types = ['depends-on'];
  assert.deepEqual(RISK, {high: 10, medium: 3});
  assert.deepEqual([riskClass(v, fileId('hub.mjs'), {types}).class, riskClass(v, fileId('mid.mjs'), {types}).class], ['high', 'medium']);
  assert.deepEqual(riskClass(v, fileId('alone.mjs'), {types}), {class: 'medium', blast_radius: 0, coverage: 'unverified', advisory: true});
  assert.equal(riskClass(v, fileId('alone.mjs'), {types, coverage: 'attested-complete'}).class, 'low');
});

test('RELEVANCE credits a dependency for each direct dependent, normalised by the most depended-on node', t => {
  const v = graph(t);
  assert.equal(relevance(v, fileId('hub.mjs')), 1);
  assert.equal(relevance(v, fileId('mid.mjs')), 3 / 9);
  assert.equal(relevance(v, fileId('alone.mjs')), 0);
});

test('AN ASSESSMENT names the cursor and the projection it was measured on, and a node the graph does not hold is refused', t => {
  const v = graph(t), r = assess(v, fileId('hub.mjs'), {types: ['depends-on']});
  assert.deepEqual(r, {node: fileId('hub.mjs'), cursor: v.seq, digest: v.digest(), dependencies: 0, class: 'high', blast_radius: 12, relevance: 1, coverage: 'unverified', advisory: true});
  assert.throws(() => assess(v, fileId('nowhere.mjs')), /is not established in the graph at cursor/);
});

test('COVERAGE is attested complete only when every source is current and no reading reports a gap', t => {
  const v = graph(t);
  assert.deepEqual(coverageOf(v), {coverage: 'attested-complete', why: []});
  assert.deepEqual(coverageOf(v, {gaps: ['2 file(s) the parser rejected give no facts']}), {coverage: 'unverified', why: ['2 file(s) the parser rejected give no facts']});
  assert.deepEqual(coverageOf({...v, sources: () => [{id: 'ophanim.repo', state: 'stale'}]}), {coverage: 'unverified', why: ['source ophanim.repo is stale']});
});

test('THE THRESHOLDS ARE INCLUSIVE: ten dependents is high and three is medium, as in Lachesis', () => {
  assert.deepEqual([10, 9, 3, 2].map(n => classOf(n, 'attested-complete').class), ['high', 'medium', 'medium', 'low']);
});

test('RELEVANCE weighs a direct dependent at 3 and a check that verifies the node at 2', () => {
  // A view of four nodes written out by hand: x depends on a; the check t verifies b.
  const id = (type, key) => `ophanim/systems/${type}/${key}`, a = id('module', 'a'), b = id('module', 'b'), x = id('module', 'x'), check = id('test', 't');
  const edges = [{type: 'depends-on', from: x, to: a}, {type: 'verifies', from: check, to: b}];
  const view = {seq: 1, subjects: () => [a, b, x, check], nodeIn: () => true,
    edgesOf: (n, {types}) => edges.filter(e => (e.from === n || e.to === n) && types.includes(e.type))};
  assert.deepEqual([relevance(view, a), relevance(view, b), relevance(view, x)], [1, 2 / 3, 0]);
});
