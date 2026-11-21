// Deterministic replay (KD8; demonstration 9): the projection digest at every cursor is reproduced by another process;
// a process killed with SIGKILL in the middle of appending recovers by replay without inventing state; the digest does
// not depend on the order a source yields its facts; reconciliation reports a divergent incremental projection; a
// source unreadable at replay is marked, never invented; a ledger that does not verify is set aside and rebuilt.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {assertion, retraction, recoverGraph, GRAPH_SCHEMA} from '../index.mjs';
import {world, SYSTEM, SYSTEM_SNAPSHOT, C, id, src, RUN, T0, at, V1, dirSource, planned} from './fixture.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'child.mjs');
const tool = over => assertion({origin: 'synthetic.tool', classification: 'observed', source: src('synthetic.runs', V1), run: RUN, observed_at: T0, ...over});
const changed = (key, attributes) => ({...SYSTEM_SNAPSHOT, entities: {...SYSTEM_SNAPSHOT.entities, [C(key)]: attributes}});

// A graph with every kind of entry: observations of a changing source, a tool's record, its supersession and
// retraction, a proposal.
function busy(t) {
  const w = world(t), g = w.open();
  g.observe(SYSTEM, {...w.by('extractor'), observed_at: T0});
  const o = tool({entity: id('evidence', 'observation', 'o1'), attributes: {v: 1}});
  g.assert([o, tool({type: 'verifies', from: o.subject, to: C('session')})], w.by('tool'));
  const o2 = tool({entity: o.subject, supersedes: [o.id], attributes: {v: 2}});
  g.supersede([o2], w.by('tool'));
  g.assert([assertion({entity: id('evidence', 'hypothesis', 'h'), origin: 'synthetic.agent', classification: 'hypothetical', source: src('synthetic.notes'), observed_at: T0, missing_evidence: ['a guess']})], w.by('agent'));
  w.publish(changed('sdk-gateway', {version: 2}));
  g.observe(SYSTEM, {...w.by('extractor'), observed_at: at(5)});
  g.retract([retraction({retracts: o2.id, origin: 'synthetic.tool', reason: 'superseded run', observed_at: at(6)})], w.by('tool'));
  return {w, g};
}

test('replay: another process reproduces the projection digest at every cursor', t => {
  const {w, g} = busy(t);
  const here = Array.from({length: g.projection.seq + 1}, (_, c) => g.digest(c));
  assert.equal(new Set(here).size, here.length, 'every cursor has its own digest');
  const r = spawnSync(process.execPath, [CHILD, 'digests', w.dir], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), here);
});

test('replay: a process killed with SIGKILL while appending recovers by replay without inventing state (demonstration 9)', {timeout: 120_000}, async t => {
  const w = world(t), warnings = [];
  w.open().observe(SYSTEM, {...w.by('extractor'), observed_at: T0});
  const plan = planned(400), ids = new Set(plan.map(r => r.id));
  const child = spawn(process.execPath, [CHILD, 'append', w.dir, String(plan.length)], {stdio: ['ignore', 'pipe', 'pipe']});
  const printed = [];
  let buf = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      printed.push(...lines);
      if (printed.length >= 25 && !child.killed) { child.kill('SIGKILL'); resolve(); }
    });
    child.once('close', code => (child.killed ? resolve() : reject(new Error(`the child finished before it was killed (${code})`))));
  });
  await new Promise(resolve => (child.exitCode !== null || child.signalCode ? resolve() : child.once('close', resolve)));
  assert.equal(child.signalCode, 'SIGKILL');
  // An unreadable lock (killed between creating the lock file and writing its holder) is broken only once it is older
  // than lockStaleMs; a readable one names a dead holder and is broken at once. A short bound keeps this test short.
  const g = w.open({log: m => warnings.push(m), lockStaleMs: 2_000, lockTimeoutMs: 30_000});
  assert.equal(g.verification.ok, true);
  const held = plan.filter(r => g.projection.knows(r.id)).map(r => r.id);
  assert.ok(printed.every(x => held.includes(x)), 'everything the child reported written is there');
  assert.ok(held.length >= printed.length && held.length <= printed.length + 1, `at most the one entry written but not yet reported (${held.length} vs ${printed.length})`);
  assert.deepEqual(held, plan.filter((r, i) => i < held.length).map(r => r.id), 'in the order it was written, with no gap');
  const others = g.view().subjects().filter(s => s.startsWith('ophanim/evidence/observation/'));
  assert.ok(others.every(s => ids.has(g.view().query(s, 'recorded')[0].id)), 'nothing that was not planned appeared');
  assert.equal(w.open().digest(), g.digest(), 'two replays agree');
  // Finishing the work after the crash: what is there is a no-op, the rest is appended; the killed holder's lock is broken.
  const done = g.assert(plan, w.by('tool'));
  assert.deepEqual([done.duplicates.length, done.ids.length], [held.length, plan.length - held.length]);
  assert.equal(plan.every(r => g.projection.knows(r.id)), true);
  assert.equal(g.reconcile().equal, true);
  assert.ok(!fs.existsSync(path.join(w.ledgerDir, 'chain.jsonl.lock')), 'no lock is left behind');
});

test('replay: the digest is the same whatever order a source yields its facts in', t => {
  const {w, g} = busy(t);
  const reversed = w.open({sources: [dirSource(w.srcRoot, SYSTEM, {reverse: true})]});
  assert.equal(reversed.verification.complete, true, 'the reversed source re-derives every observation');
  for (let c = 0; c <= g.projection.seq; c++) assert.equal(reversed.digest(c), g.digest(c), `cursor ${c}`);
});

test('reconciliation: a full replay agrees with the incremental projection, and reports one that diverged', t => {
  const {w, g} = busy(t);
  assert.deepEqual([g.reconcile().equal, g.reconcile().differences], [true, []]);
  // A projection updated without its ledger write (the fault a failed write leaves behind).
  const phantom = tool({entity: id('evidence', 'observation', 'phantom')});
  g.projection.apply({seq: g.ledger.read().length + 1, kind: 'graph.assert', author: {key_id: 'tool-key'}, parent: g.projection.head,
    payload: {schema: GRAPH_SCHEMA, records: [phantom]}});
  const r = g.reconcile();
  assert.deepEqual([r.equal, r.ahead, r.differences.map(d => [d.id, d.replay])], [false, true, [[phantom.id, null]]]);
  assert.notEqual(r.incremental.digest, r.replay.digest);
  g.refresh();
  assert.deepEqual([g.projection.knows(phantom.id), g.reconcile().equal], [false, true], 'a refresh replays the ledger and drops what it does not hold');
  void w;
});

test('replay: a source that cannot be read at replay is marked as such, and none of its facts is invented', t => {
  const {w, g} = busy(t);
  const blind = w.open({sources: [dirSource(w.srcRoot, SYSTEM, {gone: () => true})]});
  assert.equal(blind.verification.complete, false);
  assert.ok(blind.verification.partial.length > 0 && blind.verification.partial.every(p => /could not be read/.test(p.why)), JSON.stringify(blind.verification.partial));
  const v = blind.view();
  assert.deepEqual(v.sources().map(s => [s.id, s.replay]), [[SYSTEM, 'unavailable']]);
  assert.equal(v.node(C('sdk-gateway')).present, false, 'the source\'s facts are absent, not assumed');
  const edge = v.query(`verifies(${id('evidence', 'observation', 'o1')} -> ${C('session')})`, 'recorded');
  assert.equal(edge.length, 1, 'what the graph ledger itself holds is still recorded');
  assert.equal(blind.freshness()[0].state, 'unavailable');
  assert.notEqual(blind.digest(), g.digest());
});

test('recovery: a graph ledger that does not verify is set aside whole and rebuilt from its sources; a healthy one is opened as it is', t => {
  const {w, g} = busy(t);
  const opts = {origins: g.projection.origins, sources: [dirSource(w.srcRoot)], create: {authority: w.authority, operator: w.keys['graph-operator'], order: w.keys['graph-operator']},
    observeAs: w.by('extractor'), observed_at: at(60)};
  const healthy = recoverGraph({dir: w.ledgerDir, anchor: w.anchor, ...opts});
  assert.deepEqual([healthy.rebuilt, healthy.set_aside, healthy.graph.digest()], [false, null, g.digest()]);
  const sourceFacts = view => view.subjects().flatMap(s => view.query(s, 'established')).filter(a => a.classification === 'authoritative').map(a => a.subject).sort();
  const before = sourceFacts(g.view());
  // A crash tears the last line.
  const chain = path.join(w.ledgerDir, 'chain.jsonl'), whole = fs.readFileSync(chain, 'utf8'), torn = whole.substring(0, whole.length - 40);
  fs.writeFileSync(chain, torn);
  assert.throws(() => w.open(), e => e.code === 'GRAPH_CORRUPT');
  const r = recoverGraph({dir: w.ledgerDir, anchor: w.anchor, ...opts});
  assert.deepEqual([r.rebuilt, fs.readFileSync(path.join(r.set_aside, 'chain.jsonl'), 'utf8') === torn], [true, true], 'set aside whole, exactly as it was');
  assert.deepEqual(r.graph.ledger.read().map(e => e.kind), ['genesis', 'graph.assert'], 'the new ledger holds only the observation of its source');
  assert.equal(r.graph.verification.complete, true);
  assert.deepEqual(sourceFacts(r.graph.view()), before, 'the sources rebuild what they re-derive');
  assert.equal(r.graph.view().node(id('evidence', 'hypothesis', 'h')).present, false, 'what only the broken ledger held is not carried over');
  assert.equal(r.graph.freshness()[0].state, 'current');
  assert.throws(() => recoverGraph({dir: w.ledgerDir, anchor: V1, ...opts}), e => e.code === 'GRAPH_FOREIGN', 'a ledger of another authority is not set aside');
});
