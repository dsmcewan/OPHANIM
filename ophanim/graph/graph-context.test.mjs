// Slice B, KB4: the `graph` retrieval operation and the dossier's graph view (ophanim/operate/context.mjs). The op returns
// REFERENCES -- source, version, why included, coverage and continuation -- never a summary standing in for the records;
// the records stay retrievable through the existing ops, whose versions and re-checks are unchanged. Real data: this
// checkout's graph at HEAD and its status ledger. SYNTHETIC: the contradictory claim pair (demonstration 6), written by
// synthetic tool and model origins with synthetic keys.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertion, entityId} from '../../packages/graph/index.mjs';
import {makeRetriever, buildDossier, OPS, GRAPH_RETRIEVAL, RETRIEVAL_HELP, DEFAULT_INVESTIGATION} from '../operate/context.mjs';
import {evidenceCheck} from '../operate/gates.mjs';
import {fileId} from './extract/repo.mjs';
import {openSystemsGraph} from './extract/index.mjs';
import {blobId} from './lessons.mjs';
import {realGraph, closeRealGraph, ROOT, T0} from './fixtures/repo.mjs';

after(closeRealGraph);
const STATUS = path.join(ROOT, 'status/ledger');
const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const rowsOf = text => text.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
const retriever = (graph = realGraph().graph) => makeRetriever({repo: ROOT, statusRoot: STATUS, graph});

test('graph op: references with source, version, why, coverage and continuation; each original record is retrievable through the existing ops', () => {
  assert.ok(OPS.includes('graph'));
  const R = retriever(), v = realGraph().graph.view();
  const req = {op: 'graph', query: 'neighbourhood', subject: 'ophanim/efficiency/investigation/chairs.mjs', depth: 1};
  const r = R.run(req);
  assert.equal(r.ok, true, r.why);
  assert.ok(r.source.startsWith(`graph:neighbourhood:${fileId('ophanim/efficiency/investigation/chairs.mjs')}`));
  assert.equal(r.coverage.complete, true);
  assert.equal(r.version, sha(r.text), 'the version is the digest of the bytes delivered');
  assert.match(r.text, /NOT the evidence itself/);
  assert.match(r.text, /^coverage: /m);
  assert.match(r.text, /^sources: .*ophanim\.repo@[0-9a-f]{40} \(current\)/m);
  const rows = rowsOf(r.text);
  assert.ok(rows.length > 3);
  for (const row of rows) {
    assert.ok(row.node && row.why, 'each row names its node and why it is included');
    assert.ok(row.sources.length > 0 && row.sources.every(s => s.source && s.version && s.assertion), `${row.node}: its sources, versions and assertions`);
    assert.ok(row.retrieve.op || row.retrieve.none, `${row.node}: the request that retrieves the original, or why none can`);
  }
  // A reference is followed to the ORIGINAL record: the existing `show` op returns the bytes the fact was made from.
  const test_ = rows.find(x => x.node === fileId('ophanim/efficiency/investigation/chairs.test.mjs'));
  assert.equal(test_.retrieve.op, 'show');
  const original = R.run(test_.retrieve, {cap: 1 << 20});
  assert.equal(original.ok, true, original.why);
  assert.equal(blobId(Buffer.from(original.text, 'utf8')), v.node(test_.node).attributes.blob, 'the retrieved bytes are the blob the graph names');
  // Re-reading the same view gives the same version; the existing ops are as they were.
  assert.equal(R.versionOf(req), r.version);
  assert.equal(R.run({op: 'file', path: 'ophanim/efficiency/investigation/chairs.mjs'}).ok, true);
  assert.equal(RETRIEVAL_HELP(DEFAULT_INVESTIGATION).includes('"op":"graph"'), false, 'the bound review prompt text is unchanged');
  // A cut walk says so and continues exactly where it stopped.
  const cut = R.run({op: 'graph', query: 'neighbourhood', subject: 'ophanim/operate/context.mjs', depth: 1, maxNodes: 5});
  assert.match(cut.text, /^coverage: TRUNCATED \(nodes\)/m);
  const cont = JSON.parse(/^continue: (.+)$/m.exec(cut.text)[1]);
  const next = R.run(cont);
  assert.equal(next.ok, true, next.why);
  const seen = new Set(rowsOf(cut.text).map(x => x.node));
  assert.ok(rowsOf(next.text).length > 0 && rowsOf(next.text).every(x => !seen.has(x.node)), 'the continuation returns what the cut left');
  // So does a cut impact walk, under its own query.
  const imp = R.run({op: 'graph', query: 'impact', subject: 'ophanim/operate/context.mjs', maxNodes: 5});
  const impNext = R.run(JSON.parse(/^continue: (.+)$/m.exec(imp.text)[1]));
  assert.equal(impNext.ok, true, impNext.why);
  assert.ok(impNext.source.startsWith('graph:impact:'));
});

test('graph op: bounded in nodes, depth and bytes whatever the request asks; a forged continuation is refused', () => {
  const R = retriever(), C = GRAPH_RETRIEVAL.ceilings;
  // A retriever whose byte window would hold anything: the node, edge and depth clamps alone bound the walk.
  const wide = makeRetriever({repo: ROOT, statusRoot: STATUS, graph: realGraph().graph, limits: {result_bytes: 1 << 24}});
  const big = wide.run({op: 'graph', query: 'neighbourhood', subject: 'ophanim/operate/context.mjs', depth: 16, maxNodes: 9000, maxEdges: 40000}, {cap: 1 << 24});
  assert.equal(big.coverage.complete, true);
  assert.equal(big.ok, true, big.why);
  assert.ok(rowsOf(big.text).length <= C.maxNodes, `${rowsOf(big.text).length} rows, at most ${C.maxNodes}`);
  assert.match(big.text, new RegExp(`^coverage: .*depth ${C.depth}, at most ${C.maxNodes} nodes and ${C.maxEdges} steps`, 'm'));
  assert.match(big.source, new RegExp(`depth=${C.depth}&maxNodes=${C.maxNodes}&maxEdges=${C.maxEdges}`), 'the view names the bounds it was served under');
  const capped = R.run({op: 'graph', query: 'neighbourhood', subject: 'ophanim/operate/context.mjs', depth: 2, maxNodes: 100});
  assert.ok(capped.bytes <= DEFAULT_INVESTIGATION.result_bytes && capped.coverage.complete === false && capped.coverage.next, 'bytes are windowed like every op, with the request that continues them');
  assert.equal(R.run(capped.coverage.next).coverage.from, capped.coverage.to);
  const forged = Buffer.from(JSON.stringify({v: 1, op: 'neighborhood', seeds: [fileId('ophanim/operate/context.mjs')], params: {depth: 16, maxNodes: 10000, maxEdges: 50000, types: null, direction: 'both', mode: 'established'}, seq: realGraph().graph.view().seq, skip: 0})).toString('base64url');
  assert.equal(R.run({op: 'graph', continuation: forged}).error, 'BAD_REQUEST');
});

test('graph op: without a graph it is UNAVAILABLE, and a citation of it cannot be confirmed unchanged (stale, never presumed valid)', () => {
  const R = makeRetriever({repo: ROOT, statusRoot: STATUS});
  const req = {op: 'graph', query: 'neighbourhood', subject: 'ophanim/efficiency/investigation/chairs.mjs'};
  assert.equal(R.run(req).error, 'UNAVAILABLE');
  assert.equal(R.versionOf(req), undefined);
  const cited = retriever().run(req);
  const check = evidenceCheck({source: cited.source, version: cited.version, request: req}, {versionOf: R.versionOf});
  assert.match(check.why, /cannot be re-read here/);
  assert.equal(evidenceCheck({source: cited.source, version: cited.version, request: req}, {versionOf: retriever().versionOf}), null, 'with the same graph it re-reads unchanged');
});

test('dossier: the graph view is a versioned DERIVED entry inside the budget; without a graph the dossier is exactly as before', () => {
  const item = 'co1-readability', g = realGraph().graph;
  const plain = buildDossier({repo: ROOT, statusRoot: STATUS, item}), again = buildDossier({repo: ROOT, statusRoot: STATUS, item});
  const withGraph = buildDossier({repo: ROOT, statusRoot: STATUS, item, graph: g});
  assert.deepEqual([plain.digest, plain.omissions], [again.digest, again.omissions]);
  assert.equal(withGraph.entries.length, plain.entries.length + 1, 'one entry more: the graph view, last');
  assert.deepEqual(withGraph.entries.filter(x => !x.source.startsWith('graph:')).map(x => [x.id, x.source, x.version]), plain.entries.map(x => [x.id, x.source, x.version]), 'every existing entry is unchanged');
  assert.deepEqual(withGraph.omissions, plain.omissions);
  const e = withGraph.entries.at(-1), view = withGraph.views.get(e.source);
  assert.deepEqual([e.kind, e.source, e.version], ['derived', `graph:${item}#neighbourhood`, view.version]);
  assert.equal(view.version, sha(view.body), 'versioned by the digest of its bytes');
  assert.ok(Buffer.byteLength(e.text) <= GRAPH_RETRIEVAL.dossier_bytes, 'inside the graph view\'s share of the initial view');
  assert.ok(view.body.includes(`"node":"${entityId({domain: 'work', type: 'ticket', key: item})}"`), 'the item\'s ticket is referenced');
  assert.ok(Buffer.byteLength(view.body) > GRAPH_RETRIEVAL.dossier_bytes, 'this view is larger than its share: it is cut');
  assert.deepEqual(e.coverage.next, {op: 'dossier', source: e.source, offset: e.coverage.to}, 'a cut view carries its continuation');
  const rest = makeRetriever({repo: ROOT, statusRoot: STATUS, dossierViews: withGraph.views}).run(e.coverage.next);
  assert.deepEqual([rest.version, rest.coverage.from], [e.version, e.coverage.to], 'and the rest is the same view, from where the cut stopped');
  // A tight initial view: everything stays inside the budget, the graph view cut or omitted with its request.
  const tight = buildDossier({repo: ROOT, statusRoot: STATUS, item, graph: g, limits: {dossier_bytes: 9000}});
  assert.ok(tight.entries.reduce((n, x) => n + Buffer.byteLength(x.text), 0) <= 9000);
  const ge = tight.entries.find(x => x.source.startsWith('graph:'));
  assert.ok(ge ? ge.coverage.next : tight.omissions.some(o => /knowledge graph's view.*"op":"dossier"/.test(o)));
});

test('graph op: a contradictory pair stays distinguishable, and a model\'s inference cannot overwrite verified evidence (SYNTHETIC claims; demonstration 6)', t => {
  const g = openSystemsGraph({sources: [], extraKeys: {'tool-a': 1, 'tool-b': 1, 'model-k': 1}, extraOrigins: {
    'fixture.tool-a': {kind: 'tool', basis: 'measured', keys: ['tool-a']}, 'fixture.tool-b': {kind: 'tool', basis: 'measured', keys: ['tool-b']},
    'fixture.model': {kind: 'model', basis: 'inferred', keys: ['model-k']}}});
  t.after(g.close);
  const A = entityId({domain: 'evidence', type: 'claim', key: 'fixture/suite-passed'}), B = entityId({domain: 'evidence', type: 'claim', key: 'fixture/suite-failed'});
  const run = id => ({source: {id: 'fixture.ci', authority: 'a synthetic CI run', ref: id, version: 'sha256:' + 'c'.repeat(64)}, run: {id}, observed_at: T0, classification: 'observed'});
  const a = assertion({entity: A, origin: 'fixture.tool-a', ...run('run-1'), attributes: {outcome: 'pass'}});
  const b = assertion({entity: B, origin: 'fixture.tool-b', ...run('run-2'), attributes: {outcome: 'fail'}});
  g.graph.assert([a], g.signers['tool-a']);
  g.graph.assert([b], g.signers['tool-b']);
  g.graph.assert([assertion({type: 'contradicts', from: A, to: B, origin: 'fixture.tool-a', ...run('run-1'), attributes: {}})], g.signers['tool-a']);
  // The model infers B is wrong: as a supersession it is refused; as a proposal it is kept, hypothetical, and changes nothing shown.
  const guess = d => assertion({entity: B, origin: 'fixture.model', classification: 'hypothetical', observed_at: T0, source: {id: 'fixture.model', authority: 'a synthetic model', ref: 'inference', version: null},
    missing_evidence: ['a model inference: no run'], attributes: {outcome: 'pass'}, ...d});
  assert.throws(() => g.graph.supersede([guess({supersedes: [b.id]})], g.signers['model-k']), /GRAPH_HYPOTHETICAL/);
  g.graph.assert([guess({})], g.signers['model-k']);
  assert.equal(g.graph.view().node(B).attributes.outcome, 'fail', 'the observed value stands');
  const R = makeRetriever({repo: ROOT, statusRoot: STATUS, graph: g.graph});
  const set = R.run({op: 'graph', query: 'contradictions', subject: A});
  assert.equal(set.ok, true, set.why);
  const members = rowsOf(set.text);
  assert.deepEqual(members.map(m => m.node).sort(), [A, B].sort(), 'both sides are retrievable');
  assert.ok(members.every(m => m.side_established && !m.hypothetical && /neither resolved|the subject/.test(m.why)));
  assert.notDeepEqual(members[0].sources.map(s => s.assertion), members[1].sources.map(s => s.assertion), 'distinguishable: each side with its own assertions');
  const node = R.run({op: 'graph', query: 'node', subject: B});
  const rows = rowsOf(node.text);
  assert.deepEqual(rows.map(r => r.classification).sort(), ['hypothetical', 'observed'], 'the observation and the proposal, side by side');
  assert.match(node.text, /^CONFLICT outcome: /m, 'the disagreement is listed, not resolved');
});
