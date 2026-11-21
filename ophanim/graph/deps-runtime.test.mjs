// The runtime source (ophanim/graph/deps/runtime.mjs): what OPHANIM's runtime recorded in one state directory, read
// only, as graph facts at the board head -- what the board source (ophanim/graph/extract/board.mjs) does not state, on
// the board source's obligation nodes. REAL: every state below is produced here by the real controller
// (ophanim/runtime.mjs) with the repository's deterministic fixture workers (ophanim/fixtures.mjs), the fixture-only
// governance over the pinned TELOS checkout (OPHANIM_TELOS_ROOT) and the synthetic destination, in a temporary
// directory. SYNTHETIC: the requests those fixtures hold, the graph's keys, and the states changed by hand in the
// tests that say so (a tampered chain; a state no controller would write). No provider, no retained state.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runRuntime, loadRuntime} from '../runtime.mjs';
import {readRuntimeSnapshot, verifyRuntimeChain, withRuntimeBoard, digest} from '../board.mjs';
import {createGovernance} from '../governance.mjs';
import {makeFixtures, createWorkers, createSyntheticDestination} from '../fixtures.mjs';
import {parseId} from '../../packages/graph/index.mjs';
import {openSystemsGraph} from './extract/index.mjs';
import {T0, at} from './fixtures/repo.mjs';
import {boardSource, obligationId, BOARD_SOURCE, BOARD_EXTRACTOR, BOARD_ORIGIN} from './extract/board.mjs';
import {runtimeSource, runtimeFacts, stateId, executionId, outputId, effectId, workerId, planId, SOURCE_ID, EXTRACTOR, RUNTIME_ORIGIN} from './deps/runtime.mjs';

const N = 'proof-ops';
const ORIGINS = {[EXTRACTOR]: {...RUNTIME_ORIGIN, keys: ['graph-extractor']}};
const WORKER_VERSION = 'synthetic-v1', SCOPE = 'department:operations';
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
const tempDir = prefix => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };

/**
 * A settled state: `count` cases of three obligations each (normalize <- route <- draft, the draft with one effect).
 * Case 002's routing worker always invents an owner, so its route is rejected at the gate twice and HELD and its
 * draft stays pending. run(n) converges the same state again over n cases.
 */
async function produce(count = 2) {
  const stateDir = tempDir('ophanim-graph-runtime-');
  const governance = await createGovernance({root: stateDir, fixtureOnly: true, ...(process.env.OPHANIM_TELOS_ROOT ? {telosRoot: process.env.OPHANIM_TELOS_ROOT} : {})});
  const effectAdapter = createSyntheticDestination(path.join(stateDir, 'destination'));
  const workers = createWorkers({delayMs: 0, permanentCase: 'pilot-case-002'});
  const run = n => runRuntime({stateDir, governance, effectAdapter, workers, obligations: makeFixtures({count: n}).obligations});
  const result = await run(count);
  return {stateDir, run, result};
}
const specs = Object.fromEntries(makeFixtures({count: 3}).obligations.map(o => [o.id, o]));
const factsOf = stateDir => { const {commit, state} = readRuntimeSnapshot(stateDir); return {commit, state, facts: runtimeFacts(state, {name: N, commit})}; };
const entity = (facts, id) => facts.find(d => d.entity === id) ?? null;
const edges = (facts, type) => facts.filter(d => d.type === type).map(d => [d.from, d.to]);
const tally = xs => { const out = {}; for (const x of [...xs].sort()) out[x] = (out[x] ?? 0) + 1; return out; };
/** What a draft is: an entity's `domain/type`, or a relationship's type. */
const sort = d => (d.entity ? `${parseId(d.entity).domain}/${parseId(d.entity).type}` : d.type);
const subject = d => d.entity ?? `${d.type}(${d.from} -> ${d.to})`;
/** A commit id as the version both sources of the board observe it at: its 64 hex, without `commit:`. */
const versionOf = commit => commit.replace(/^commit:/, '');
const boardFactsOf = stateDir => { const b = boardSource({stateDir}); return b.readAt(b.current().version); };
/** Every file under `dir` with its size and modification time: what a read must leave exactly as it was. */
const listing = dir => fs.readdirSync(dir, {recursive: true, withFileTypes: true}).filter(e => e.isFile())
  .map(e => { const p = path.join(e.parentPath, e.name), s = fs.statSync(p); return [path.relative(dir, p), s.size, s.mtimeMs]; }).sort((a, b) => (a[0] < b[0] ? -1 : 1));
/** An obligation's node: the board source's id for it (the bare obligation id, no state name). */
const O = id => obligationId(id), X = (id, n) => executionId(N, id, n), W = kind => workerId(N, `synthetic-${kind}`);

let base;
before(async () => { base = await produce(2); });

test('OBLIGATIONS: each on the board source\'s node id, with only what the board source does not state (the state\'s name, the reason, the digest of its spec, its effect key, its accepted digest); no depends-on between obligations, which is the board source\'s', () => {
  const {facts, state} = factsOf(base.stateDir), board = boardFactsOf(base.stateDir);
  assert.deepEqual(base.result.held.map(h => [h.id, h.status, h.reason]), [['pilot-case-002:route', 'held', 'gate-rejected'], ['pilot-case-002:draft', 'pending', 'dependency-held']],
    'the state under test: one obligation held by the gate, the one after it waiting');
  const mine = facts.filter(d => d.entity?.includes('/work/obligation/'));
  assert.deepEqual(mine.map(d => d.entity), Object.keys(state.obligations).sort().map(O));
  assert.deepEqual(mine.map(d => d.entity), board.filter(d => d.entity).map(d => d.entity), 'the same nodes as the board source states, by its ids');
  const route = specs['pilot-case-001:route'];
  assert.deepEqual(entity(facts, O('pilot-case-001:route')), {entity: O('pilot-case-001:route'), ref: `runtime/${N}#obligations/pilot-case-001:route`,
    attributes: {state: N, id: 'pilot-case-001:route', reason: null, spec_sha256: digest(route), effect_key: null, accepted_sha256: digest(route.expected)}});
  assert.deepEqual(entity(facts, O('pilot-case-002:route')).attributes, {state: N, id: 'pilot-case-002:route', reason: 'gate-rejected', spec_sha256: digest(specs['pilot-case-002:route']),
    effect_key: null, accepted_sha256: null});
  assert.deepEqual(entity(facts, O('pilot-case-002:draft')).attributes, {state: N, id: 'pilot-case-002:draft', reason: null, spec_sha256: digest(specs['pilot-case-002:draft']),
    effect_key: 'pilot:draft:pilot-case-002', accepted_sha256: null});
  // Of the attributes the board source states on an obligation, this source repeats the obligation's own id and no other.
  const boardNames = id => Object.keys(entity(board, id).attributes);
  assert.deepEqual(mine.map(d => [d.entity, Object.keys(d.attributes).filter(k => boardNames(d.entity).includes(k)), d.attributes.id]),
    mine.map(d => [d.entity, ['id'], entity(board, d.entity).attributes.id]));
  // Obligation -> obligation is the board source's fact (each spec's dependsOn), and this source states none of it;
  // an attempt's depends-on its obligation is the next test's.
  assert.deepEqual(edges(board, 'depends-on'), [
    [O('pilot-case-001:draft'), O('pilot-case-001:route')], [O('pilot-case-001:route'), O('pilot-case-001:normalize')],
    [O('pilot-case-002:draft'), O('pilot-case-002:route')], [O('pilot-case-002:route'), O('pilot-case-002:normalize')]]);
  assert.deepEqual(edges(facts, 'depends-on').filter(([from]) => from.includes('/work/obligation/')), []);
  const stated = new Set(board.filter(d => d.type).map(subject));
  assert.deepEqual(facts.filter(d => d.type && stated.has(subject(d))), [], 'no relationship of this source is one the board source states');
  assert.deepEqual(facts.filter(d => d.status !== undefined), [], 'nothing is unresolved in a state the controller wrote');
});

test('ATTEMPTS: each an execution with its worker and outcome, depending on its obligation; a held obligation keeps both rejected attempts', () => {
  const {facts, state} = factsOf(base.stateDir);
  const executions = facts.filter(d => d.entity?.includes('/work/execution/'));
  assert.deepEqual(executions.map(d => [d.entity, d.attributes.outcome, d.attributes.worker]), [
    [X('pilot-case-001:draft', 1), 'accepted', 'synthetic-draft-task'], [X('pilot-case-001:normalize', 1), 'accepted', 'synthetic-normalize-intake'],
    [X('pilot-case-001:route', 1), 'accepted', 'synthetic-route-intake'], [X('pilot-case-002:normalize', 1), 'accepted', 'synthetic-normalize-intake'],
    [X('pilot-case-002:route', 1), 'gate-rejected', 'synthetic-route-intake'], [X('pilot-case-002:route', 2), 'gate-rejected', 'synthetic-route-intake']]);
  const rejected = state.obligations['pilot-case-002:route'].history[1].candidateSha;
  assert.deepEqual(entity(facts, X('pilot-case-002:route', 2)), {entity: X('pilot-case-002:route', 2), ref: `runtime/${N}#obligations/pilot-case-002:route/attempts/2`,
    attributes: {state: N, obligation: 'pilot-case-002:route', attempt: 2, outcome: 'gate-rejected', worker: 'synthetic-route-intake', worker_version: null,
      candidate_sha256: rejected, release: 'baseline', reason_sha256: null, repair: {status: 'open', reason: 'gate-rejected', resolved_by_attempt: null}}});
  assert.notEqual(rejected, digest(specs['pilot-case-002:route'].expected), 'the rejected candidate is not the expected answer');
  assert.deepEqual(entity(facts, X('pilot-case-001:draft', 1)).attributes, {state: N, obligation: 'pilot-case-001:draft', attempt: 1, outcome: 'accepted',
    worker: 'synthetic-draft-task', worker_version: WORKER_VERSION, candidate_sha256: digest(specs['pilot-case-001:draft'].expected), release: 'baseline',
    reason_sha256: null, repair: null});
  assert.deepEqual(edges(facts, 'depends-on').filter(([from]) => from.includes('/work/execution/')), executions.map(d => [d.entity, O(d.attributes.obligation)]));
  // The workers are the active release's registry; each contributed to the attempts the record names it for.
  assert.deepEqual(facts.filter(d => d.entity?.includes('/capability/agent/')).map(d => [d.entity, d.attributes]), ['draft-task', 'normalize-intake', 'route-intake'].map(kind =>
    [W(kind), {state: N, id: `synthetic-${kind}`, version: WORKER_VERSION, kinds: [kind], scopes: [SCOPE], versions: [WORKER_VERSION], described_by_release: 'baseline', active: true,
      releases: ['baseline'], registrations_differ: false}]));
  assert.deepEqual(edges(facts, 'contributed-to'), [
    [W('draft-task'), X('pilot-case-001:draft', 1)], [W('normalize-intake'), X('pilot-case-001:normalize', 1)], [W('normalize-intake'), X('pilot-case-002:normalize', 1)],
    [W('route-intake'), X('pilot-case-001:route', 1)], [W('route-intake'), X('pilot-case-002:route', 1)], [W('route-intake'), X('pilot-case-002:route', 2)]]);
  // What an accepted attempt was built on: the accepted output of each dependency, at the digest the candidate recorded.
  assert.deepEqual(edges(facts, 'consumes'), [[X('pilot-case-001:draft', 1), outputId(N, 'pilot-case-001:route')], [X('pilot-case-001:route', 1), outputId(N, 'pilot-case-001:normalize')]]);
});

test('ARTIFACTS: an accepted output and a confirmed effect each with its digest, produced by its obligation; no input or output VALUE is in any fact', () => {
  const {facts, state} = factsOf(base.stateDir);
  const draft = specs['pilot-case-001:draft'], row = state.obligations['pilot-case-001:draft'];
  assert.deepEqual(entity(facts, outputId(N, 'pilot-case-001:draft')), {entity: outputId(N, 'pilot-case-001:draft'), ref: `runtime/${N}#obligations/pilot-case-001:draft/accepted`,
    attributes: {state: N, artifact: 'accepted-output', obligation: 'pilot-case-001:draft', output_key: 'pilot-case-001:draft', sha256: digest(draft.expected), attempt: 1,
      worker: 'synthetic-draft-task', release: 'baseline', plan_ref: row.accepted.planRef, verification_sha256: digest(row.accepted.verification),
      published_commit: row.candidate.published.commit, published_blob: row.candidate.published.blob}});
  assert.match(row.accepted.planRef, /^sha256:[0-9a-f]{64}$/, 'the plan reference is TELOS\'s, a digest');
  const effect = effectId(N, 'pilot:draft:pilot-case-001');
  assert.deepEqual(entity(facts, effect), {entity: effect, ref: `runtime/${N}#effects/pilot:draft:pilot-case-001`,
    attributes: {state: N, artifact: 'effect', key: 'pilot:draft:pilot-case-001', obligation: 'pilot-case-001:draft', sha256: digest(draft.expected), effect_status: 'confirmed',
      receipt_sha256: digest(state.effects['pilot:draft:pilot-case-001'].receipt)}});
  assert.deepEqual(facts.filter(d => d.entity?.includes('/work/artifact/')).map(d => d.entity), [
    effect, outputId(N, 'pilot-case-001:draft'), outputId(N, 'pilot-case-001:normalize'), outputId(N, 'pilot-case-001:route'), outputId(N, 'pilot-case-002:normalize')],
  'the held obligation and the one waiting on it have no output');
  assert.deepEqual(edges(facts, 'produces'), [
    [X('pilot-case-001:draft', 1), outputId(N, 'pilot-case-001:draft')], [X('pilot-case-001:normalize', 1), outputId(N, 'pilot-case-001:normalize')],
    [X('pilot-case-001:route', 1), outputId(N, 'pilot-case-001:route')], [X('pilot-case-002:normalize', 1), outputId(N, 'pilot-case-002:normalize')],
    [O('pilot-case-001:draft'), effect], [O('pilot-case-001:draft'), outputId(N, 'pilot-case-001:draft')], [O('pilot-case-001:normalize'), outputId(N, 'pilot-case-001:normalize')],
    [O('pilot-case-001:route'), outputId(N, 'pilot-case-001:route')], [O('pilot-case-002:normalize'), outputId(N, 'pilot-case-002:normalize')]]);
  // Values the state holds (a request's fields, an owner table, an accepted output, an effect's payload) and the graph must not.
  const text = JSON.stringify(facts);
  const values = ['alex@example.invalid', 'sam@example.invalid', 'Replace meeting room lamp', 'Install approved editor', 'Facilities queue', 'IT queue', 'Records queue',
    'synthetic-r1', 'trusted synthetic oracle'];
  const held = JSON.stringify(state);
  assert.deepEqual(values.filter(value => !held.includes(value)), [], 'each of those values is in the state that was read');
  assert.deepEqual(values.filter(value => text.includes(value)), [], 'and none is in the facts');
});

test('THE STATE: one record node with the real head commit id, the revision, the counts, the releases and the active release', () => {
  const {facts, state, commit} = factsOf(base.stateDir);
  assert.match(commit, /^commit:[0-9a-f]{64}$/, 'the state node keeps the commit id as the board writes it');
  assert.deepEqual(entity(facts, stateId(N)), {entity: stateId(N), ref: `runtime/${N}`, attributes: {state: N, schema: 'ophanim.runtime/v1', commit, revision: 26,
    obligations: 6, by_status: {accepted: 4, held: 1, pending: 1}, executions: 6, effects: {confirmed: 1}, repairs: {open: 2}, events: 26,
    event_types: {'effect.confirmed': 1, 'effect.intent': 1, 'gate.accepted': 4, 'gate.rejected': 2, 'runtime.opened': 1, 'runtime.settled': 1, 'work.accepted': 4,
      'work.persisted': 6, 'work.started': 6},
    last_event: {sequence: 26, type: 'runtime.settled'}, active_release: 'baseline', pending_release: null,
    releases: [{id: 'baseline', artifact_sha256: state.releases.baseline.artifactSha, plan_ref: null, workers: 3}], release_count: 1,
    release_history: [], release_history_count: 0, plans: 0, workers: 3, history_unread: 0}});
  assert.equal(readRuntimeSnapshot(base.stateDir).state.events.length, 26);
  assert.deepEqual(tally(facts.map(sort)), {'capability/agent': 3, 'consumes': 2, 'contributed-to': 6,
    'depends-on': 6, 'evidence/record': 1, 'produces': 9, 'work/artifact': 5, 'work/execution': 6, 'work/obligation': 6});
  const obligations = Object.keys(state.obligations).sort().map(O);
  assert.deepEqual(facts.filter(d => d.entity && !parseId(d.entity).key.startsWith(`runtime/${N}/`)).map(d => d.entity), obligations,
    'every key starts with runtime/<name>/ except an obligation\'s, which is the board source\'s bare id');
  // The same state under another name: every execution, artifact, worker, state node and edge is its own; the
  // obligation nodes, whose ids carry no state name, are the same nodes.
  const other = new Set(runtimeFacts(state, {name: 'other-state', commit}).map(subject));
  assert.deepEqual(facts.map(subject).filter(s => other.has(s)), obligations, 'the same state under another name shares its obligation nodes and no other subject');
  assert.throws(() => runtimeFacts(state, {name: 'Proof Ops', commit}), /is not a state name/);
});

test('GRAPH: observed after the board source over the same state directory, the two meet on the obligation nodes with no conflict -- the dependency between obligations is the board source\'s alone, an attempt\'s dependence on its obligation is this source\'s, and both are at the same version; a second state directory is a second source that shares the obligation nodes of equal ids', t => {
  const second = 'ophanim.runtime.second';
  const g = openSystemsGraph({sources: [boardSource({stateDir: base.stateDir}), runtimeSource({stateDir: base.stateDir, name: N}), runtimeSource({stateDir: base.stateDir, name: 'second', id: second})],
    extraOrigins: {[BOARD_EXTRACTOR]: {...BOARD_ORIGIN, keys: ['graph-extractor']}, [EXTRACTOR]: {...RUNTIME_ORIGIN, sources: [SOURCE_ID, second], keys: ['graph-extractor']}}});
  t.after(g.close);
  assert.equal(RUNTIME_ORIGIN.basis, 'declared', 'the one basis that admits depends-on, produces, consumes and contributed-to from an extractor');
  const ob = g.graph.observe(BOARD_SOURCE, {...g.by, observed_at: T0});
  assert.equal(ob.recorded, true, ob.why);
  const o = g.graph.observe(SOURCE_ID, {...g.by, observed_at: at(1)});
  assert.equal(o.recorded, true, o.why);
  const head = readRuntimeSnapshot(base.stateDir).commit, version = versionOf(head);
  assert.match(version, /^[0-9a-f]{64}$/);
  assert.deepEqual([[ob.state, ob.record.source.version, ob.record.attributes.count], [o.state, o.record.source.version, o.record.attributes.count]],
    [['current', version, 10], ['current', version, 44]], 'both sources of the board are at the controller commit\'s 64 hex');
  const v = g.graph.view();
  // Every assertion ever recorded of one edge: [its source, whether it is established].
  const stated = (node, type, to) => v.edgesOf(node, {mode: 'recorded'}).filter(e => e.type === type && e.from === node && e.to === to)
    .map(e => e.assertions.map(a => [v.assertion(a).source.id, v.established(a)]));
  assert.deepEqual(stated(O('pilot-case-001:route'), 'depends-on', O('pilot-case-001:normalize')), [[[BOARD_SOURCE, true]]], 'an accepted obligation depends on the one before it: the board source\'s assertion and no other');
  assert.deepEqual(stated(O('pilot-case-002:draft'), 'depends-on', O('pilot-case-002:route')), [[[BOARD_SOURCE, true]]], 'a waiting obligation depends on the held one: the board source\'s assertion and no other');
  assert.deepEqual(stated(X('pilot-case-001:route', 1), 'depends-on', O('pilot-case-001:route')), [[[SOURCE_ID, true]]], 'an attempt depends on its obligation');
  assert.deepEqual(stated(X('pilot-case-002:route', 2), 'depends-on', O('pilot-case-002:route')), [[[SOURCE_ID, true]]], 'a rejected attempt depends on the held obligation');
  assert.deepEqual(stated(O('pilot-case-001:draft'), 'produces', effectId(N, 'pilot:draft:pilot-case-001')), [[[SOURCE_ID, true]]]);
  assert.deepEqual(stated(W('route-intake'), 'contributed-to', X('pilot-case-002:route', 2)), [[[SOURCE_ID, true]]]);
  assert.deepEqual(stated(X('pilot-case-001:draft', 1), 'consumes', outputId(N, 'pilot-case-001:route')), [[[SOURCE_ID, true]]]);
  // One obligation node, both sources' attributes on it, nothing they disagree on.
  const chain = verifyRuntimeChain(base.stateDir), held = v.node(O('pilot-case-002:route'));
  assert.deepEqual([held.established, held.assertions.map(a => a.source.id).sort(), held.conflicts, held.attributes], [true, [BOARD_SOURCE, SOURCE_ID], [],
    {id: 'pilot-case-002:route', kind: 'route-intake', scope: SCOPE, output_key: 'pilot-case-002:routed', status: 'held', attempt: 2, release_attempts: 2, max_attempts: 2,
      input_names: ['owners'], depends_on: ['pilot-case-002:normalize'], revision: 26, chain: {commits: chain.commits, deltas: chain.deltas},
      state: N, reason: 'gate-rejected', spec_sha256: digest(specs['pilot-case-002:route']), effect_key: null, accepted_sha256: null}]);
  assert.deepEqual(Object.keys(readRuntimeSnapshot(base.stateDir).state.obligations).sort().map(id => [id, v.node(O(id)).conflicts]),
    Object.keys(specs).filter(id => !id.startsWith('pilot-case-003')).sort().map(id => [id, []]), 'no obligation node has an attribute the two sources disagree on');
  assert.equal(v.node(stateId(N)).attributes.commit, head, 'the real commit id is kept on the state node');
  const again = g.graph.observe(SOURCE_ID, {...g.by, observed_at: at(2)});
  assert.deepEqual([again.recorded, again.why], [false, `${SOURCE_ID}@${version} is already observed`]);
  // The same state directory under a second name: its executions, artifacts and state node are its own nodes; its
  // obligations are the SAME nodes (the board source's ids carry no state name), so each now has two state names.
  const o2 = g.graph.observe(second, {...g.by, observed_at: at(3)});
  assert.equal(o2.recorded, true, o2.why);
  const w = g.graph.view(), sources = id => w.node(id).assertions.map(a => a.source.id).sort();
  assert.deepEqual([sources(executionId('second', 'pilot-case-001:route', 1)), sources(outputId('second', 'pilot-case-001:route')), sources(stateId('second')),
    sources(X('pilot-case-001:route', 1)), sources(outputId(N, 'pilot-case-001:route')), sources(stateId(N))], [[second], [second], [second], [SOURCE_ID], [SOURCE_ID], [SOURCE_ID]]);
  const shared = w.node(O('pilot-case-001:route'));
  assert.deepEqual([shared.established, sources(O('pilot-case-001:route')), shared.conflicts.map(c => [c.attribute, c.values.map(x => x.value).sort()])],
    [true, [BOARD_SOURCE, SOURCE_ID, second], [['state', [N, 'second']]]], 'one obligation node for both state names, which is the one thing they disagree on');
  assert.deepEqual([o2.record.attributes.count, w.stats().current], [44, 10 + 2 * 44 + 3]);
});

test('VERSION: the controller commit at the board head, as its 64 hex; two readings of one head are identical; after the state advances the earlier version still reads as it did', async t => {
  const s = await produce(2);
  const source = runtimeSource({stateDir: s.stateDir, name: N});
  const head1 = readRuntimeSnapshot(s.stateDir).commit, v1 = source.current().version;
  assert.match(v1, /^[0-9a-f]{64}$/);
  assert.deepEqual([`commit:${v1}`, v1], [head1, boardSource({stateDir: s.stateDir}).current().version], 'the version is the commit id\'s 64 hex, the board source\'s version of the same head');
  const f1 = source.readAt(v1);
  assert.deepEqual(source.readAt(v1), f1);
  assert.deepEqual(runtimeSource({stateDir: s.stateDir, name: N}).readAt(v1), f1, 'another reader of the same head');
  assert.equal(source.current().version, v1);
  const g = openSystemsGraph({sources: [source], extraOrigins: ORIGINS});
  t.after(g.close);
  const o1 = g.graph.observe(SOURCE_ID, {...g.by, observed_at: T0});
  assert.equal(o1.recorded, true, o1.why);
  // The state advances: a third case is admitted and converges; the held route stays held.
  const advanced = await s.run(3);
  assert.deepEqual([advanced.accepted.length, advanced.held.length], [7, 2]);
  const head2 = readRuntimeSnapshot(s.stateDir).commit, v2 = source.current().version;
  assert.deepEqual([v2 === v1, `commit:${v2}`], [false, head2]);
  assert.deepEqual(source.readAt(v1), f1, 'the earlier version is read from its own commit, not from the head');
  const f2 = source.readAt(v2);
  assert.deepEqual([entity(f1, stateId(N)).attributes.commit, entity(f2, stateId(N)).attributes.commit], [head1, head2]);
  assert.deepEqual([entity(f1, O('pilot-case-003:route')), entity(f2, O('pilot-case-003:route')).attributes.accepted_sha256], [null, digest(specs['pilot-case-003:route'].expected)]);
  const o2 = g.graph.observe(SOURCE_ID, {...g.by, observed_at: at(1)});
  assert.deepEqual([o2.recorded, o2.record.attributes.from_version, o2.record.source.version], [true, v1, v2]);
  assert.ok(o2.event.nodes.includes(O('pilot-case-003:route')) && !o2.event.nodes.includes(O('pilot-case-001:route')), 'the change is the new case, not what stayed');
  assert.deepEqual([g.graph.view(o1.seq).node(O('pilot-case-003:route')).present, g.graph.view().node(O('pilot-case-003:route')).established], [false, true]);
  const replay = g.open();
  assert.deepEqual([replay.digest(), replay.verification.complete], [g.graph.digest(), true], 'a replay re-derives both versions from the board');
  // A version that is no commit of this state's board is refused, not answered from the head; so is one that is not a
  // commit's 64 hex (the commit id as the board writes it, or a digest of it).
  assert.throws(() => source.readAt('0'.repeat(64)), /commit:0{64} is not in the store/);
  assert.throws(() => source.readAt(head2), /is not a controller commit id/);
  assert.throws(() => source.readAt('sha256:' + v2), /is not a controller commit id/);
});

test('UNVERIFIED CHAIN: a state whose chain does not verify is recorded unavailable with the reason and gives no facts', async t => {
  const stateDir = tempDir('ophanim-graph-runtime-tampered-');
  fs.cpSync(base.stateDir, stateDir, {recursive: true});
  const source = runtimeSource({stateDir, name: N});
  const v1 = source.current().version, f1 = source.readAt(v1);
  // SYNTHETIC: a commit no controller would write -- an accepted obligation's output rewritten after its acceptance.
  await withRuntimeBoard(stateDir, async board => {
    board.state.obligations['pilot-case-001:normalize'].accepted.output.summary = 'substituted';
    await board.save(board.state, {type: 'fixture.tamper'});
  });
  const head = readRuntimeSnapshot(stateDir).commit;
  assert.throws(() => source.current(), /Runtime chain commit:[0-9a-f]{64}: accepted obligation changed: pilot-case-001:normalize/);
  assert.throws(() => source.readAt(versionOf(head)), /accepted obligation changed: pilot-case-001:normalize/);
  const g = openSystemsGraph({sources: [runtimeSource({stateDir, name: N})], extraOrigins: ORIGINS});
  t.after(g.close);
  const o = g.graph.observe(SOURCE_ID, {...g.by, observed_at: T0});
  assert.deepEqual([o.recorded, o.state, o.record.source.version, o.record.attributes.count], [true, 'unavailable', null, null]);
  assert.match(o.record.attributes.why, /^Runtime chain commit:[0-9a-f]{64}: accepted obligation changed: pilot-case-001:normalize$/);
  assert.deepEqual(g.graph.view().subjects(), [o.record.subject], 'the graph holds the source\'s unavailability and nothing else');
  // The version before the tampering rests on its own chain, which still verifies: it reads as it did.
  assert.deepEqual(source.readAt(v1), f1);
  // No state at all is also a reason, never an empty reading.
  const empty = runtimeSource({stateDir: path.join(stateDir, 'no-such-state'), name: N});
  assert.throws(() => empty.current(), /has no runtime board/);
});

test('UNRESOLVED: an effect naming a missing obligation, an effect not confirmed, a worker in no release and an attempt with no outcome are recorded so, never dropped or filled in; a dependsOn naming a missing obligation is the board source\'s to state, and this source states neither it nor the edge', t => {
  // SYNTHETIC: the real state, changed by hand into one no controller would write (the runtime refuses each of these).
  const {state, commit} = factsOf(base.stateDir), changed = structuredClone(state);
  changed.obligations['pilot-case-001:route'].spec.dependsOn.push('pilot-case-009:normalize');
  changed.effects['pilot:draft:pilot-case-009'] = {...structuredClone(state.effects['pilot:draft:pilot-case-001']), key: 'pilot:draft:pilot-case-009', obligationId: 'pilot-case-009:draft'};
  changed.effects['pilot:draft:pilot-case-001'].status = 'intent';
  delete changed.effects['pilot:draft:pilot-case-001'].receipt;
  changed.obligations['pilot-case-001:normalize'].history[0].worker = 'departed-worker';
  changed.obligations['pilot-case-002:route'].history.pop();
  changed.plans = {['a'.repeat(64)]: {planner: {id: 'synthetic-intake-planner', version: '1'}, requestSha: 'b'.repeat(64), policySha: 'c'.repeat(64), proposalSha: 'd'.repeat(64),
    obligationsSha: 'e'.repeat(64), proposal: {obligations: [{inputs: {request: {requester: 'alex@example.invalid'}}}]}, authorization: {ok: true}}};
  const facts = runtimeFacts(changed, {name: N, commit});
  const dependency = O('pilot-case-009:normalize'), ghost = O('pilot-case-009:draft'), orphan = effectId(N, 'pilot:draft:pilot-case-009');
  const effect = effectId(N, 'pilot:draft:pilot-case-001'), departed = workerId(N, 'departed-worker');
  assert.deepEqual(facts.filter(d => d.status !== undefined), [
    {entity: departed, ref: `runtime/${N}#releases`, status: 'unresolved', missing_evidence: ['named as the worker of 1 attempt(s) but registered in no release of the state at this commit'],
      attributes: {state: N, id: 'departed-worker', named_by: ['pilot-case-001:normalize attempt 1']}},
    {entity: effect, ref: `runtime/${N}#effects/pilot:draft:pilot-case-001`, status: 'unresolved', missing_evidence: ['the state records this effect as "intent", not as confirmed'],
      attributes: {state: N, artifact: 'effect', key: 'pilot:draft:pilot-case-001', obligation: 'pilot-case-001:draft', sha256: state.effects['pilot:draft:pilot-case-001'].sha256,
        effect_status: 'intent', receipt_sha256: null}},
    {entity: X('pilot-case-002:route', 2), ref: `runtime/${N}#obligations/pilot-case-002:route/attempts/2`, status: 'unresolved',
      missing_evidence: ['the obligation counts 2 attempt(s) but the state holds no history entry, no interruption and no attempt in flight for attempt 2'],
      attributes: {state: N, obligation: 'pilot-case-002:route', attempt: 2, outcome: 'unrecorded', worker: 'synthetic-route-intake', worker_version: null, candidate_sha256: null,
        release: 'baseline', reason_sha256: null, repair: {status: 'open', reason: 'gate-rejected', resolved_by_attempt: null}}},
    {entity: ghost, ref: `runtime/${N}#obligations/pilot-case-009:draft`, status: 'unresolved',
      missing_evidence: ['named by 1 effect(s) of the state but not an obligation of the state at this commit'],
      attributes: {state: N, id: 'pilot-case-009:draft', named_by_effects: ['pilot:draft:pilot-case-009']}},
  ]);
  assert.deepEqual(edges(facts, 'produces').filter(([from]) => from === ghost), [[ghost, orphan]], 'the edge from the missing obligation to the effect that names it is kept');
  // The missing obligation a dependsOn names, and the edge to it, are the board source's facts: nothing here is about it.
  assert.deepEqual(facts.filter(d => [d.entity, d.from, d.to].includes(dependency)), []);
  assert.deepEqual(edges(facts, 'depends-on').filter(([from]) => from.includes('/work/obligation/')), []);
  assert.deepEqual(edges(facts, 'contributed-to').filter(([from]) => from === departed), [[departed, X('pilot-case-001:normalize', 1)]]);
  // A plan is its digests and its planner; the proposal a planner wrote is a value and stays in the state.
  assert.deepEqual(entity(facts, planId(N, 'a'.repeat(64))), {entity: planId(N, 'a'.repeat(64)), ref: `runtime/${N}#plans/${'a'.repeat(64)}`,
    attributes: {state: N, id: 'a'.repeat(64), planner: 'synthetic-intake-planner', planner_version: '1', request_sha256: 'b'.repeat(64), policy_sha256: 'c'.repeat(64),
      proposal_sha256: 'd'.repeat(64), obligations_sha256: 'e'.repeat(64), authorized: true, authorization_sha256: digest({ok: true})}});
  assert.equal(JSON.stringify(facts).includes('alex@example.invalid'), false);
  // In a real graph: the unresolved ends are present, not established, and the edges to them are recorded, not established.
  const real = runtimeSource({stateDir: base.stateDir, name: N});
  const g = openSystemsGraph({sources: [{...real, readAt: () => facts}], extraOrigins: ORIGINS});
  t.after(g.close);
  const o = g.graph.observe(SOURCE_ID, {...g.by, observed_at: T0});
  assert.equal(o.recorded, true, o.why);
  const v = g.graph.view(), attempt = X('pilot-case-001:route', 1);
  const modes = (from, type, to) => ['established', 'possible'].map(mode => v.edgesOf(from, {mode}).some(e => e.type === type && e.from === from && e.to === to));
  assert.deepEqual([v.node(ghost).present, v.node(ghost).established, modes(ghost, 'produces', orphan), v.node(orphan).established], [true, false, [false, true], true]);
  assert.deepEqual([v.node(dependency).present, modes(attempt, 'depends-on', O('pilot-case-001:route'))], [false, [true, true]]);
  assert.deepEqual([v.node(effect).established, v.edgesOf(effect).length, v.edgesOf(effect, {mode: 'possible'}).length], [false, 0, 1]);
});

test('RELEASES AND ATTEMPTS IN FLIGHT: every release and each change of release are on the state node; a worker is described as the active release registers it, with every version it had; an interrupted attempt and one still running are outcomes, not gaps', () => {
  // SYNTHETIC: the real state, changed by hand into a head these fixtures do not reach in-process -- a second release
  // activated, an attempt a later controller fenced, an attempt still running. (The real path to each is a killed
  // controller or a signed release decision: ophanim/proof.mjs.)
  const {state, commit} = factsOf(base.stateDir), changed = structuredClone(state);
  changed.releases['release-v2'] = {id: 'release-v2', artifactSha: 'f'.repeat(64), stateSchema: state.schema, planRef: 'sha256:' + '1'.repeat(64),
    workers: state.releases.baseline.workers.filter(w => w.id !== 'synthetic-draft-task').map(w => ({...w, version: 'synthetic-v2'}))};
  changed.activeRelease = 'release-v2';
  changed.releaseHistory.push({kind: 'activate', fromRelease: 'baseline', toRelease: 'release-v2', decision: {decisionId: 'synthetic-decision'}});
  changed.obligations['pilot-case-002:route'].history.pop();
  changed.events.push({sequence: 27, type: 'work.interrupted', id: 'pilot-case-002:route', attempt: 2});
  Object.assign(changed.obligations['pilot-case-002:draft'], {status: 'running', attempt: 1, releaseAttempts: 1});
  changed.events.push({sequence: 28, type: 'work.started', id: 'pilot-case-002:draft', attempt: 1, worker: 'synthetic-draft-task'});
  const facts = runtimeFacts(changed, {name: N, commit});
  const {active_release, releases, release_count, release_history, release_history_count, by_status, executions, last_event} = entity(facts, stateId(N)).attributes;
  assert.deepEqual({active_release, releases, release_count, release_history, release_history_count, by_status, executions, last_event}, {active_release: 'release-v2',
    releases: [{id: 'baseline', artifact_sha256: state.releases.baseline.artifactSha, plan_ref: null, workers: 3},
      {id: 'release-v2', artifact_sha256: 'f'.repeat(64), plan_ref: 'sha256:' + '1'.repeat(64), workers: 2}], release_count: 2,
    release_history: [{kind: 'activate', from: 'baseline', to: 'release-v2', decision_sha256: digest({decisionId: 'synthetic-decision'})}], release_history_count: 1,
    by_status: {accepted: 4, held: 1, running: 1}, executions: 7, last_event: {sequence: 28, type: 'work.started'}});
  assert.deepEqual(facts.filter(d => d.entity?.includes('/capability/agent/')).map(d => d.attributes), [
    {state: N, id: 'synthetic-draft-task', version: 'synthetic-v1', kinds: ['draft-task'], scopes: [SCOPE], versions: ['synthetic-v1'], described_by_release: 'baseline', active: false,
      releases: ['baseline'], registrations_differ: false},
    {state: N, id: 'synthetic-normalize-intake', version: 'synthetic-v2', kinds: ['normalize-intake'], scopes: [SCOPE], versions: ['synthetic-v1', 'synthetic-v2'],
      described_by_release: 'release-v2', active: true, releases: ['baseline', 'release-v2'], registrations_differ: true},
    {state: N, id: 'synthetic-route-intake', version: 'synthetic-v2', kinds: ['route-intake'], scopes: [SCOPE], versions: ['synthetic-v1', 'synthetic-v2'],
      described_by_release: 'release-v2', active: true, releases: ['baseline', 'release-v2'], registrations_differ: true}]);
  assert.deepEqual([X('pilot-case-002:route', 2), X('pilot-case-002:draft', 1)].map(id => entity(facts, id)), [
    {entity: X('pilot-case-002:route', 2), ref: `runtime/${N}#obligations/pilot-case-002:route/attempts/2`, attributes: {state: N, obligation: 'pilot-case-002:route', attempt: 2,
      outcome: 'interrupted', worker: 'synthetic-route-intake', worker_version: null, candidate_sha256: null, release: 'baseline', reason_sha256: null,
      repair: {status: 'open', reason: 'gate-rejected', resolved_by_attempt: null}}},
    {entity: X('pilot-case-002:draft', 1), ref: `runtime/${N}#obligations/pilot-case-002:draft/attempts/1`, attributes: {state: N, obligation: 'pilot-case-002:draft', attempt: 1,
      outcome: 'running', worker: 'synthetic-draft-task', worker_version: null, candidate_sha256: null, release: null, reason_sha256: null, repair: null}}]);
  assert.deepEqual(facts.filter(d => d.status !== undefined), []);
});

test('A HEAD THE CONTROLLER DIED AT is read as it stands: the attempt at the gate is an execution whose outcome is the row\'s status, a failed attempt keeps the digest of its reason and never the text; resumed, the same attempt is accepted and the repair resolved', async () => {
  const stateDir = tempDir('ophanim-graph-runtime-died-');
  const governance = await createGovernance({root: stateDir, fixtureOnly: true, ...(process.env.OPHANIM_TELOS_ROOT ? {telosRoot: process.env.OPHANIM_TELOS_ROOT} : {})});
  const context = {stateDir, governance, effectAdapter: createSyntheticDestination(path.join(stateDir, 'destination')), workers: createWorkers({delayMs: 0}),
    obligations: makeFixtures({count: 1}).obligations};
  const text = 'synthetic fault: the lamp request was dropped';
  // The first attempt fails before it publishes (recorded as the worker's failure); the second is persisted, and the
  // controller dies before it gates it.
  const fault = async (event, payload) => {
    if (event === 'before-work-publish' && payload.attempt === 1) throw new Error(text);
    if (event === 'after-work-persisted') throw new Error('controller died');
  };
  await assert.rejects(runRuntime({...context, fault}), /controller died/);
  const source = runtimeSource({stateDir, name: N}), died = source.current().version, facts = source.readAt(died);
  const id = 'pilot-case-001:normalize', expected = digest(specs[id].expected);
  const attempts = fs => [1, 2].map(n => entity(fs, X(id, n)).attributes);
  assert.deepEqual(attempts(facts), [
    {state: N, obligation: id, attempt: 1, outcome: 'worker-failed', worker: 'synthetic-normalize-intake', worker_version: null, candidate_sha256: null, release: 'baseline',
      reason_sha256: digest(text), repair: {status: 'open', reason: 'worker-failed', resolved_by_attempt: null}},
    {state: N, obligation: id, attempt: 2, outcome: 'gating', worker: 'synthetic-normalize-intake', worker_version: WORKER_VERSION, candidate_sha256: expected, release: 'baseline',
      reason_sha256: null, repair: null}]);
  const node = entity(facts, stateId(N)).attributes;
  assert.deepEqual([entity(facts, O(id)).attributes, node.by_status, node.executions, node.last_event.type, entity(facts, outputId(N, id))],
    [{state: N, id, reason: null, spec_sha256: digest(specs[id]), effect_key: null, accepted_sha256: null}, {gating: 1, pending: 2}, 2, 'work.persisted', null]);
  assert.deepEqual([JSON.stringify(loadRuntime(stateDir)).includes(text), JSON.stringify(facts).includes(text)], [true, false], 'the failure\'s text is in the state and not in the facts');
  const resumed = await runRuntime(context);
  assert.equal(resumed.complete, true);
  const now = source.readAt(source.current().version);
  assert.deepEqual(attempts(now), [
    {state: N, obligation: id, attempt: 1, outcome: 'worker-failed', worker: 'synthetic-normalize-intake', worker_version: null, candidate_sha256: null, release: 'baseline',
      reason_sha256: digest(text), repair: {status: 'resolved', reason: 'worker-failed', resolved_by_attempt: 2}},
    {state: N, obligation: id, attempt: 2, outcome: 'accepted', worker: 'synthetic-normalize-intake', worker_version: WORKER_VERSION, candidate_sha256: expected, release: 'baseline',
      reason_sha256: null, repair: null}]);
  assert.deepEqual([entity(now, outputId(N, id)).attributes.sha256, entity(now, outputId(N, id)).attributes.attempt], [expected, 2]);
  assert.deepEqual(source.readAt(died), facts, 'the head the controller died at still reads as it stood');
});

test('READ ONLY: reading the head leaves every file of the state directory exactly as it was', () => {
  const was = listing(base.stateDir);
  const source = runtimeSource({stateDir: base.stateDir, name: N});
  const version = source.current().version;
  assert.equal(source.readAt(version).length, 44);
  assert.deepEqual(listing(base.stateDir), was);
  assert.deepEqual(loadRuntime(base.stateDir).revision, 26);
  // The module reaches the state only through the board's readers: no controller, no writer, no worker.
  const text = fs.readFileSync(new URL('./deps/runtime.mjs', import.meta.url), 'utf8');
  const imports = [...text.matchAll(/^import\s+(?:.+?\s+from\s+)?'([^']+)';$/gm)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['../../../packages/graph/index.mjs', '../../board.mjs', '../extract/board.mjs', 'node:fs']);
  assert.deepEqual(/withRuntimeBoard|publishWorkerCandidate|openBoard|runRuntime|\.run\(/.exec(text), null);
});
