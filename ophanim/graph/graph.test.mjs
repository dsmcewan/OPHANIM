// THE GRAPH FOUNDATION: the contract, the projection ledger and the bounded questions (contract.mjs, store.mjs,
// query.mjs). Every graph here is a real ledger on disk in a temporary directory; nothing is mocked.
// Each test's comment names the defect it would catch.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertionRefusal, parseId, slotOf, aidOf, RELATIONS, DOMAINS, GRAPH_SCHEMA} from './contract.mjs';
import {openGraph, fold, diffOps} from './store.mjs';
import {neighborhood, impact, trace, contextPackage, renderContext, CONTEXT_SCHEMA} from './query.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AT = '2026-11-20T00:00:00.000Z';
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };
const I = 'ophanim';
const id = (domain, type, key, instance = I) => `${instance}:${domain}:${type}:${key}`;
const SRC = (ref = 'a.mjs', version = 'sha256:' + '1'.repeat(64), authority = 'repository') => ({authority, ref, version});
const base = (over = {}) => ({source: SRC(), origin: {kind: 'extractor', name: 'test'}, class: 'observed', status: 'unverified', ...over});
const ent = (eid, attrs = {}, over = {}) => ({kind: 'entity', id: eid, attrs, ...base(over)});
const rel = (r, from, to, over = {}) => ({kind: 'relation', rel: r, from, to, ...base(over)});
const C = k => id('systems', 'component', k), CAP = k => id('systems', 'capability', k), T = k => id('systems', 'test', k);
const refusalOf = fn => { try { fn(); return null; } catch (e) { return e.code ?? 'threw'; } };

test('THE CONTRACT ADMITS a well-formed entity and relationship, and gives the same statement the same identity', () => {
  const a = ent(C('src/a.mjs'), {language: 'js'}), r = rel('depends-on', C('src/a.mjs'), C('src/b.mjs'));
  assert.equal(assertionRefusal(a, {instance: I}), null);
  assert.equal(assertionRefusal(r, {instance: I}), null);
  assert.deepEqual(parseId(C('src/a.mjs')), {instance: I, domain: 'systems', type: 'component', key: 'src/a.mjs'});
  // Seen at another time, it is the same assertion; from another version of the source, the same slot and a new assertion.
  assert.equal(aidOf({...a, observed_at: AT}), aidOf(a));
  const later = {...a, source: SRC('a.mjs', 'sha256:' + '2'.repeat(64))};
  assert.deepEqual([slotOf(later) === slotOf(a), aidOf(later) === aidOf(a)], [true, false]);
  assert.deepEqual([Object.keys(DOMAINS).sort(), Object.keys(RELATIONS).length >= 16], [['capability', 'evidence', 'learning', 'systems', 'work'], true]);
});

test('NEGATIVE CASES: an invalid identity, an unknown type, an unsupported edge, a wrong direction, missing provenance, another instance\'s name and a model\'s claim are each refused by name', () => {
  const cases = [
    ['an identity with no type', ent('ophanim:systems:src/a.mjs'), 'GRAPH_IDENTITY'],
    ['a domain that does not exist', ent('ophanim:finance:component:x'), 'GRAPH_IDENTITY'],
    ['a type of another domain', ent('ophanim:work:component:x'), 'GRAPH_IDENTITY'],
    ['an instance name that is not one', ent('Ophanim HQ:systems:component:x'), 'GRAPH_IDENTITY'],
    ['a relationship type that is not in the table', rel('resembles', C('a'), C('b')), 'GRAPH_RELATION'],
    ['an edge between endpoint types its row does not allow', rel('runs-in', C('a'), C('b')), 'GRAPH_ENDPOINT'],
    // The direction is part of the meaning: a test verifies a component, a component does not verify a test.
    ['an edge in the wrong direction', rel('verifies', C('a'), T('a.test.mjs')), 'GRAPH_ENDPOINT'],
    ['an edge from a thing to itself', rel('depends-on', C('a'), C('a')), 'GRAPH_ENDPOINT'],
    ['no source', (({source, ...x}) => x)(ent(C('a'))), 'GRAPH_PROVENANCE'],
    ['a source without a version', ent(C('a'), {}, {source: {authority: 'repository', ref: 'a.mjs'}}), 'GRAPH_PROVENANCE'],
    ['a source authority that is not one', ent(C('a'), {}, {source: SRC('a', 'v1', 'hearsay')}), 'GRAPH_PROVENANCE'],
    ['no origin', (({origin, ...x}) => x)(ent(C('a'))), 'GRAPH_PROVENANCE'],
    ['another instance\'s entity', ent(id('systems', 'component', 'a', 'finance')), 'GRAPH_FOREIGN_INSTANCE'],
    ['an edge to another instance, outside the federation projection', rel('depends-on', C('a'), id('systems', 'component', 'b', 'tech')), 'GRAPH_FOREIGN_INSTANCE'],
    ['a federation source outside the federation projection', ent(C('a'), {}, {source: SRC('tech', 'v1', 'federation')}), 'GRAPH_PROVENANCE'],
    // WHAT A MODEL SAYS IS A HYPOTHESIS: it cannot arrive as an observation, however it is worded.
    ['a model\'s dependency claim offered as observed', rel('depends-on', C('a'), C('b'), {origin: {kind: 'model', name: 'gemini-4-carbon'}}), 'GRAPH_MODEL_CLAIM'],
    ['an agent\'s shared-mechanism claim offered as derived', rel('shares-failure-mechanism-with', id('learning', 'defect', 'd1'), id('learning', 'defect', 'd2'), {origin: {kind: 'agent', name: 'reflection'}, class: 'derived'}), 'GRAPH_MODEL_CLAIM'],
    ['a model\'s hypothesis marked verified', rel('depends-on', C('a'), C('b'), {origin: {kind: 'model', name: 'm'}, class: 'hypothetical', status: 'verified', evidence: [{ref: 'x', version: 'v'}]}), 'GRAPH_MODEL_CLAIM'],
    ['a file read called an authority', ent(C('a'), {}, {class: 'authoritative'}), 'GRAPH_CLASS'],
    ['an operator\'s statement called derived', ent(C('a'), {}, {class: 'derived', origin: {kind: 'operator', name: 'controller'}}), 'GRAPH_CLASS'],
    ['verified with no evidence named', ent(C('a'), {}, {status: 'verified'}), 'GRAPH_STATUS'],
    ['a verified hypothesis', ent(C('a'), {}, {class: 'hypothetical', status: 'qualified', evidence: [{ref: 'x', version: 'v'}]}), 'GRAPH_STATUS'],
    ['an unknown field', {...ent(C('a')), confidence: 0.9}, 'GRAPH_SHAPE'],
    ['a scope that is not one', ent(C('a'), {}, {scope: 'public'}), 'GRAPH_SCOPE'],
  ];
  for (const [name, a, code] of cases) assert.equal(assertionRefusal(a, {instance: I})?.code ?? null, code, name);
  // The same hypothesis, said as one, is admitted: a model may propose.
  assert.equal(assertionRefusal(rel('depends-on', C('a'), C('b'), {origin: {kind: 'model', name: 'm'}, class: 'hypothetical'}), {instance: I}), null);
  // And the store refuses what the contract refuses: nothing of a refused reading is written.
  const g = openGraph({root: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-neg-')), 'g'), instance: I});
  assert.equal(refusalOf(() => g.sync('repository', 'c1', [ent(C('ok')), rel('resembles', C('a'), C('b'))], {at: AT})), 'GRAPH_RELATION');
  assert.deepEqual([g.projection().seq, g.projection().records().length], [0, 0]);
  fs.rmSync(path.dirname(g.root), {recursive: true, force: true});
});

test('A READING IS IDEMPOTENT; a later version supersedes; what the source no longer says is retracted; and none of it is deleted', t => {
  const g = openGraph({root: path.join(tmp(t), 'g'), instance: I});
  const v1 = [ent(C('a'), {exports: 1}), ent(C('b')), rel('depends-on', C('a'), C('b'))];
  assert.deepEqual([g.sync('repository', 'c1', v1, {at: AT}).applied, g.projection().records().length], [true, 3]);
  // The same reading again: no batch, no duplicate.
  assert.deepEqual([g.sync('repository', 'c1', v1, {at: AT}).why, g.batches().length, g.projection().records().length], ['already-applied', 1, 3]);
  // A new version of a.mjs: its entity changes, and it no longer imports b.
  const v2 = [ent(C('a'), {exports: 2}, {source: SRC('a.mjs', 'sha256:' + '2'.repeat(64))}), ent(C('b'))];
  assert.equal(g.sync('repository', 'c2', v2, {at: AT}).applied, true);
  const p = g.projection();
  assert.deepEqual([p.entity(C('a')).attrs.exports, p.out(C('a'), 'depends-on').length, p.records().length, p.cursor('repository')], [2, 0, 2, 'c2']);
  // HISTORY: both endings are on the record, with how each ended; the graph as it was is still answerable.
  assert.deepEqual(p.history().filter(r => r.ended).map(r => [r.a.kind, r.ended.by, r.from_seq, r.to_seq]).sort(), [['entity', 'superseded', 1, 2], ['relation', 'retracted', 1, 2]]);
  assert.deepEqual([g.at(1).entity(C('a')).attrs.exports, g.at(1).out(C('a'), 'depends-on').length, g.at(1).seq], [1, 1, 1]);
  assert.deepEqual(p.changesSince(1).began.map(r => r.a.id), [C('a')]);
  assert.deepEqual(p.changesSince(1).ended.map(r => r.ended.by).sort(), ['retracted', 'superseded']);
});

test('A TARGETED READING changes only what is stated under the references it names: the rest of the source is left alone', t => {
  const g = openGraph({root: path.join(tmp(t), 'g'), instance: I});
  g.sync('repository', 'c1', [ent(C('a'), {n: 1}, {source: SRC('a.mjs', 'v1')}), ent(C('b'), {n: 1}, {source: SRC('b.mjs', 'v1')})], {at: AT});
  // Only a.mjs changed. Without the reference list this reading would retract b.
  g.sync('repository', 'c2', [ent(C('a'), {n: 2}, {source: SRC('a.mjs', 'v2')})], {at: AT, refs: ['a.mjs']});
  const p = g.projection();
  assert.deepEqual([p.entity(C('a')).attrs.n, p.entity(C('b')).exists, p.entity(C('b')).attrs.n], [2, true, 1]);
});

test('CONTRADICTORY EVIDENCE stays distinguishable: two sources that disagree are both kept, and a model\'s inference never replaces an observation', t => {
  const g = openGraph({root: path.join(tmp(t), 'g'), instance: I});
  const M = id('capability', 'model', 'google/gemini-4-carbon');
  g.sync('config', 'k1', [ent(M, {window: 1000000}, {source: SRC('capability-facts.json', 'v1', 'config'), class: 'observed'})], {at: AT});
  g.sync('run-ledger', 'r1', [ent(M, {window: 200000}, {source: SRC('run:1', 'h1', 'run-ledger'), class: 'observed'})], {at: AT});
  g.sync('work-ledger', 'w1', [ent(M, {window: 4000000, native_subagents: true}, {source: SRC('entry:9', 'h9', 'work-ledger'), origin: {kind: 'model', name: 'gemini-4-carbon'}, class: 'hypothetical'})], {at: AT});
  const e = g.projection().entity(M);
  // The value shown is an observation's, never the hypothesis's; the disagreement is listed with every source.
  assert.notEqual(e.attrs.window, 4000000);
  assert.deepEqual(e.conflicts.find(c => c.attr === 'window').values.map(v => [v.value, v.class, v.source.authority]).sort((a, b) => a[0] - b[0]),
    [[200000, 'observed', 'run-ledger'], [1000000, 'observed', 'config'], [4000000, 'hypothetical', 'work-ledger']]);
  // What only the hypothesis says is shown as its own, and marked.
  assert.deepEqual([e.attrs.native_subagents, e.assertions.find(r => 'native_subagents' in (r.a.attrs ?? {})).a.class], [true, 'hypothetical']);
  assert.equal(e.assertions.length, 3);
});

test('A BROKEN REFERENCE is kept and named unresolved, never passed off as a thing that exists', t => {
  const g = openGraph({root: path.join(tmp(t), 'g'), instance: I});
  g.sync('repository', 'c1', [ent(C('a')), rel('depends-on', C('a'), C('gone'))], {at: AT});
  const p = g.projection();
  assert.deepEqual(p.unresolved().map(u => [u.rel, u.missing]), [['depends-on', [C('gone')]]]);
  assert.deepEqual([p.entity(C('gone')).exists, p.entity(C('gone')).unresolved, p.entity('not an id')], [false, true, null]);
  assert.equal(neighborhood(p, C('a')).nodes.find(n => n.id === C('gone')).exists, false);
  assert.match(renderContext(contextPackage(p, {focus: C('a')})), /ophanim:systems:component:gone \(UNRESOLVED\)/);
});

test('THE CURSOR RULE: a batch that does not start where its source stands is not written; the same batch again is a no-op; sources are ordered each on its own', t => {
  const g = openGraph({root: path.join(tmp(t), 'g'), instance: I});
  const op = a => ({op: 'assert', a});
  assert.equal(g.commit({source: 'work-ledger', from: null, to: 'seq:5', at: AT, ops: [op(ent(C('a'), {}, {source: SRC('e5', 'h5', 'work-ledger')}))]}).applied, true);
  // Replayed: nothing is written twice.
  assert.deepEqual(g.commit({source: 'work-ledger', from: null, to: 'seq:5', at: AT, ops: [op(ent(C('a'), {}, {source: SRC('e5', 'h5', 'work-ledger')}))]}), {applied: false, why: 'already-applied', at: '"seq:5"'});
  // Computed against an older state than the graph is at: refused as stale, to be computed again.
  assert.equal(g.commit({source: 'work-ledger', from: 'seq:3', to: 'seq:9', at: AT, ops: []}).why, 'stale');
  // Another source has its own cursor.
  assert.equal(g.commit({source: 'repository', from: null, to: 'c1', at: AT, ops: [op(ent(C('b')))]}).applied, true);
  assert.deepEqual([g.batches().length, g.projection().cursor('work-ledger'), g.projection().cursor('repository')], [2, 'seq:5', 'c1']);
  assert.equal(refusalOf(() => g.commit({source: 'repository', from: 'c1', to: 'c2', at: AT, ops: [{op: 'retract', slot: 'nonsense', why: 'x'}]})), 'GRAPH_REFUSED');
});

test('RESTART: a graph that is opened again is the same graph; a reader without the projector key can ask and cannot write; a chain that was edited is refused whole', t => {
  const root = path.join(tmp(t), 'g');
  const g = openGraph({root, instance: I});
  g.sync('repository', 'c1', [ent(C('a')), ent(C('b')), rel('depends-on', C('a'), C('b'))], {at: AT});
  const digest = g.projection().digest();
  const again = openGraph({root, instance: I, create: false});
  assert.deepEqual([again.projection().digest(), again.verify().ok, again.instance], [digest, true, I]);
  assert.equal(refusalOf(() => openGraph({root, instance: 'finance', create: false})), 'GRAPH_FOREIGN_INSTANCE');
  assert.equal(refusalOf(() => openGraph({root: path.join(root, 'absent'), instance: I, create: false})), 'NO_GRAPH');
  // A copy without the keys: verifiable and queryable, not writable.
  const copy = path.join(path.dirname(root), 'copy');
  fs.cpSync(root, copy, {recursive: true}); fs.rmSync(path.join(copy, 'keys'), {recursive: true});
  const reader = openGraph({root: copy, instance: I, create: false});
  assert.deepEqual([reader.projection().digest(), reader.canWrite(), refusalOf(() => reader.sync('repository', 'c2', [ent(C('z'))], {at: AT}))], [digest, false, 'NO_AUTHORITY']);
  // An edited chain: refused, not repaired.
  const chain = path.join(copy, 'chain.jsonl');
  fs.writeFileSync(chain, fs.readFileSync(chain, 'utf8').replace(/"seq":2/, '"seq":7'));
  assert.equal(refusalOf(() => openGraph({root: copy, instance: I, create: false})), 'GRAPH_CORRUPT');
});

test('REPLAY IS DETERMINISTIC: the same sources at the same versions give the same projection whatever order they were read in, and folding the batches again gives the same state', t => {
  const d = tmp(t);
  const sources = {
    repository: ['c1', [ent(C('a')), ent(C('b')), rel('depends-on', C('a'), C('b'))]],
    config: ['k1', [ent(id('capability', 'model', 'google/m'), {window: 1}, {source: SRC('facts.json', 'v1', 'config')})]],
    'lessons-registry': ['l1', [ent(id('learning', 'failure-class', 'x'), {}, {source: SRC('corrections.json', 'v1', 'lessons-registry')})]],
  };
  const build = (name, order) => { const g = openGraph({root: path.join(d, name), instance: I}); for (const s of order) g.sync(s, sources[s][0], sources[s][1], {at: AT}); return g; };
  const one = build('one', ['repository', 'config', 'lessons-registry']), two = build('two', ['lessons-registry', 'config', 'repository']);
  assert.equal(one.projection().digest(), two.projection().digest());
  assert.equal(fold(one.batches()).digest(), one.projection().digest());
  // ...and an incremental history ends at the same state as one reading of the final versions.
  const inc = openGraph({root: path.join(d, 'inc'), instance: I});
  inc.sync('repository', 'c0', [ent(C('a')), ent(C('old')), rel('depends-on', C('a'), C('old'))], {at: AT});
  inc.sync('repository', 'c1', sources.repository[1], {at: AT});
  const direct = openGraph({root: path.join(d, 'direct'), instance: I});
  direct.sync('repository', 'c1', sources.repository[1], {at: AT});
  assert.equal(inc.projection().digest(), direct.projection().digest());
  assert.deepEqual(diffOps(inc.projection().assertionsOf('repository'), sources.repository[1]), []);
});

test('CONCURRENCY: several processes reading the same change apply it once, processes on different sources lose nothing, and the chain verifies', async t => {
  const root = path.join(tmp(t), 'g');
  openGraph({root, instance: I});
  const child = job => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(HERE, 'test-writer-child.mjs'), root, I, JSON.stringify(job)], {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    c.stdout.on('data', x => { out += x; }); c.stderr.on('data', x => { err += x; });
    c.on('close', code => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').at(-1))) : reject(new Error(`child exited ${code}: ${err.slice(-400)}`))));
  });
  const shared = {source: 'work-ledger', to: 'seq:7', assertions: [ent(CAP('sdk-gateway'), {}, {source: SRC('entry:7', 'h7', 'work-ledger')}), rel('requires-capability', id('work', 'item', 'a'), CAP('sdk-gateway'), {source: SRC('entry:7', 'h7', 'work-ledger')})]};
  const own = n => ({source: `unit:${n}`, to: 'v1', assertions: [ent(C(`unit-${n}.mjs`), {}, {source: SRC(`unit-${n}.mjs`, 'v1')})]});
  const [same, owned] = await Promise.all([Promise.all([child(shared), child(shared), child(shared), child(shared)]), Promise.all([child(own(1)), child(own(2)), child(own(3))])]);
  const g = openGraph({root, instance: I, create: false}), p = g.projection();
  // The shared change: applied by exactly one writer, seen as already applied by the others. No duplicate claim.
  assert.deepEqual(same.map(r => r.applied).sort(), [false, false, false, true]);
  assert.deepEqual([g.batches().filter(b => b.source === 'work-ledger').length, p.in(CAP('sdk-gateway'), 'requires-capability').length], [1, 1]);
  // The others: every one landed. No lost update.
  assert.deepEqual([owned.map(r => r.applied), [1, 2, 3].map(n => p.has(C(`unit-${n}.mjs`))), g.batches().length, g.verify().ok], [[true, true, true], [true, true, true], 4, true]);
});

test('BOUNDED TRAVERSAL: a neighbourhood stops at its depth and at its count, says so, and names where to continue', t => {
  const g = openGraph({root: path.join(tmp(t), 'g'), instance: I});
  const chain = Array.from({length: 8}, (_, i) => C(`n${i}`));
  g.sync('repository', 'c1', [...chain.map(c => ent(c)), ...chain.slice(1).map((c, i) => rel('depends-on', chain[i], c)), ...Array.from({length: 30}, (_, i) => [ent(C(`leaf${i}`)), rel('depends-on', C(`leaf${i}`), chain[0])]).flat()], {at: AT});
  const p = g.projection();
  const near = neighborhood(p, chain[0], {depth: 2, direction: 'out'});
  assert.deepEqual([near.nodes.map(n => n.id), near.truncated.reason, near.truncated.continue_from], [[chain[0], chain[1], chain[2]], 'depth', [chain[2]]]);
  const few = neighborhood(p, chain[0], {depth: 1, limit: 5});
  assert.deepEqual([few.nodes.length, few.truncated.reason, few.truncated.limit], [5, 'limit', 5]);
  assert.equal(neighborhood(p, chain[0], {depth: 8, direction: 'out'}).truncated, null, 'the whole chain fits: nothing was cut and nothing says it was');
  // The bounds are the query's own: asking for more than the ceiling does not get it.
  assert.equal(neighborhood(p, chain[0], {depth: 99, limit: 999999}).nodes.length, 38);
  const pkg = contextPackage(p, {focus: chain[0], depth: 1, limit: 4});
  assert.deepEqual([pkg.schema, pkg.coverage.complete, pkg.coverage.stopped, pkg.nodes.length, pkg.graph.digest === p.digest()], [CONTEXT_SCHEMA, false, 'limit', 4, true]);
  assert.ok(pkg.retrieve.every(r => r.ref && r.version), 'every entry of the package names the source and version to read');
});

test('IMPACT follows the meaning of each relationship: what depends on a changed thing is reached, what it depends on is not, unrelated things are absent, and a hypothesis carries nothing unless asked', t => {
  const g = openGraph({root: path.join(tmp(t), 'g'), instance: I});
  const gw = C('gateway.mjs'), turn = C('turn.mjs'), fs_ = C('fs-util.mjs'), other = C('unrelated.mjs'), test_ = T('gateway.test.mjs'), cap = CAP('sdk-gateway'), item = id('work', 'item', 'a'), plan = id('work', 'plan', 'a@1');
  g.sync('repository', 'c1', [gw, turn, fs_, other, C('maybe.mjs')].map(c => ent(c)).concat([ent(test_), ent(cap), ent(item), ent(plan),
    rel('depends-on', turn, gw), rel('depends-on', gw, fs_), rel('verifies', test_, gw), rel('implements', gw, cap),
    rel('requires-capability', item, cap), rel('cited-by', gw, plan),
    rel('depends-on', C('maybe.mjs'), gw, {origin: {kind: 'model', name: 'm'}, class: 'hypothetical'})]), {at: AT});
  const p = g.projection();
  const r = impact(p, gw);
  assert.deepEqual(r.affected.map(a => [a.id, a.distance, a.via.rel]), [[cap, 1, 'implements'], [test_, 1, 'verifies'], [plan, 1, 'cited-by'], [turn, 1, 'depends-on'], [item, 2, 'requires-capability']].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)));
  // What the gateway depends on is not affected by a change of the gateway; the unrelated file is absent; the model's guess is not followed.
  assert.deepEqual([fs_, other, C('maybe.mjs')].map(x => r.affected.some(a => a.id === x)), [false, false, false]);
  const withGuesses = impact(p, gw, {hypotheses: true}).affected.find(a => a.id === C('maybe.mjs'));
  assert.deepEqual([withGuesses.distance, withGuesses.rests_on_hypothesis], [1, true]);
  // A change of the utility reaches the gateway and, through it, everything above.
  assert.deepEqual(impact(p, fs_).affected.map(a => a.id).includes(item), true);
  assert.equal(impact(p, gw, {depth: 1}).truncated.reason, 'depth');
});

test('TRACE walks backwards from a component to why it exists and what has been established about it', t => {
  const g = openGraph({root: path.join(tmp(t), 'g'), instance: I});
  const gw = C('gateway.mjs'), req = id('evidence', 'requirement', 'prompt-1'), dec = id('evidence', 'decision', 'L-724'), lim = id('learning', 'limitation', 'L-724'), tst = T('gateway.test.mjs'), fc = id('learning', 'failure-class', 'bound-declared-not-enforced'), cor = id('learning', 'correction', 'w7'), unit = id('work', 'unit', 'run1/gateway');
  g.sync('repository', 'c1', [gw, req, dec, lim, tst, fc, cor, unit].map(x => ent(x)).concat([
    rel('introduced-because-of', gw, req), rel('governs', dec, gw), rel('governs', lim, gw), rel('verifies', tst, gw), rel('detects', tst, fc), rel('modifies', unit, gw),
    rel('corrects', cor, fc), rel('applies-to', fc, gw)]), {at: AT});
  const steps = trace(g.projection(), gw).steps;
  const role = x => steps.find(s => s.id === x)?.role ?? null;
  assert.deepEqual([req, dec, tst, unit, fc, cor].map(role), ['reason', 'contract', 'verification', 'changed-by', 'lesson', 'correction']);
  assert.deepEqual([steps[0].id, steps[0].role, steps.find(s => s.id === cor).distance], [gw, 'subject', 2]);
});

test('a batch is a ledger entry like any other: the schema names it, and a graph is never started without its anchor', t => {
  const root = path.join(tmp(t), 'g');
  const g = openGraph({root, instance: I});
  g.sync('repository', 'c1', [ent(C('a'))], {at: AT});
  assert.deepEqual([g.batches()[0].schema, g.batches()[0].instance, g.batches()[0].from, g.batches()[0].to, g.batches()[0].ops.map(o => o.op)], [GRAPH_SCHEMA, I, null, 'c1', ['assert']]);
  fs.rmSync(path.join(root, 'ANCHOR'));
  assert.match(String(spawnSync(process.execPath, ['-e', `import(${JSON.stringify(path.join(HERE, 'store.mjs'))}).then(m => m.openGraph({root: ${JSON.stringify(root)}, instance: 'ophanim'})).catch(e => { console.log(e.message); })`], {encoding: 'utf8'}).stdout), /without its ANCHOR is not opened/);
});
