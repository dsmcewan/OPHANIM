// Slice D part 1, CONCURRENCY AND REPLAY of the work graph (KD1-7; demonstrations 8 and 9; docs/knowledge-graph/slice-d1.md),
// with REAL separate processes (fixtures/d1-child.mjs): two executing tickets over a shared dependency produce one claim,
// one finding per prerequisite, no lost update and no dependency cycle; a process KILLED mid-write leaves a graph that
// re-opens to the same projection from its ledger (and from a signed snapshot), and a work ledger that cannot be read is
// replayed as unavailable, its facts absent, never invented. SYNTHETIC: the work ledger and the keys.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createGraphLedger, openGraph, entityId, writeSnapshot} from '../../packages/graph/index.mjs';
import {generateSigner} from '../../packages/ledger/index.mjs';
import {originsOf} from './extract/index.mjs';
import {workGraphSource, readWorkLedgerOnly, sharedPrerequisiteId, dependencyCycles, WORK_GRAPH_SOURCE, planId} from './work.mjs';
import {d1WorkLedger, SHARED_CONTRACT, SDK_RUNTIME, T} from './fixtures/d1-work.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/d1-child.mjs');
const SHARED_ITEM = 'capability-contract';
const run = (args, {onLine} = {}) => {
  const c = spawn(process.execPath, [CHILD, ...args], {stdio: ['ignore', 'pipe', 'pipe']});
  let out = '', err = '';
  c.stdout.on('data', d => { out += d; if (onLine) for (const l of String(d).split('\n').filter(Boolean)) onLine(l, c); });
  c.stderr.on('data', d => { err += d; });
  return {child: c, done: new Promise(resolve => c.once('close', (code, signal) => resolve({code, signal, out, err})))};
};
/** A world on disk the children open: the work ledger (its keys kept when a writer needs them), a graph ledger, the keys. */
function world(t, {keep = false} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-d1-world-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const w = d1WorkLedger({dir, keep});
  const keys = Object.fromEntries(['graph-operator', 'graph-extractor', 'graph-rule'].map(k => [k, generateSigner(k)]));
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify(keys));
  fs.mkdirSync(path.join(dir, 'graph'));
  const anchor = createGraphLedger({dir: path.join(dir, 'graph'), operator: keys['graph-operator'], order: keys['graph-operator'],
    authority: {orderer: 'graph-operator', operators: ['graph-operator'], keyring: Object.fromEntries(Object.entries(keys).map(([k, s]) => [k, s.publicJwk]))}});
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({anchor, work: {root: w.root, anchor: w.anchor}, shared_item: SHARED_ITEM, plan: w.records['team-construction'].plan.hash, at: T(900)}));
  const open = (o = {}) => openGraph({dir: path.join(dir, 'graph'), anchor, origins: originsOf(), sources: [workGraphSource({root: w.root, anchor: w.anchor})], ...o});
  return {dir, w, keys, anchor, open};
}

test('demonstration 8: two real processes over a shared dependency -- ONE claim, one finding per prerequisite (no duplicate), no lost update, no dependency cycle', {timeout: 180_000}, async t => {
  const W = world(t, {keep: true}), N = 12;
  const kids = ['a', 'b'].map(name => run(['race', W.dir, name, String(N)]));
  fs.writeFileSync(path.join(W.dir, 'go'), '');
  const results = await Promise.all(kids.map(k => k.done));
  for (const r of results) assert.equal(r.code, 0, r.err);
  const s = results.map(r => JSON.parse(r.out.trim().split('\n').at(-1)));
  // One claim: the work ledger refuses the second live claim on the shared prerequisite's item.
  assert.deepEqual(s.map(x => x.claimed).sort(), [false, true]);
  assert.match(s.find(x => !x.claimed).refused, /already claimed .*no duplicate execution/);
  assert.equal(readWorkLedgerOnly(W.w).claims(SHARED_ITEM).length, 1);
  const g = W.open(), v = g.view();
  assert.equal(g.verification.complete, true, 'the ledger both wrote verifies and re-derives');
  assert.equal(g.reconcile().equal, true, 'the incremental projection equals a replay from nothing');
  assert.equal(v.subjects().filter(x => /\/work\/lease\//.test(x) && !x.includes('(') && v.node(x).attributes.item === SHARED_ITEM).length, 1, 'the graph shows one lease on it');
  // No duplicate: each shared finding recorded once, the one source change observed once.
  for (const p of [SHARED_CONTRACT, SDK_RUNTIME]) assert.equal(v.query(sharedPrerequisiteId(p), 'recorded').length, 1, `${p}: one finding`);
  assert.equal(s.reduce((n, x) => n + x.findings, 0), 2, 'between them the writers recorded the two findings once');
  assert.equal(v.query(entityId({domain: 'evidence', type: 'source', key: WORK_GRAPH_SOURCE}), 'recorded').length, 1, 'one observation of the one change');
  assert.equal(s.reduce((n, x) => n + x.observed, 0), 1);
  // No lost update: every assertion each writer made of its own is there.
  for (const name of ['a', 'b']) for (let i = 0; i < N; i++) assert.equal(v.query(entityId({domain: 'work', type: 'discovery', key: `own-${name}/${i}`}), 'established').length, 1, `${name} ${i}`);
  assert.deepEqual([s.reduce((n, x) => n + x.appended, 0), s.reduce((n, x) => n + x.noops, 0)], [2 * N, 0]);
  // No circular execution: sharing a prerequisite adds no dependency between the items; the work graph has no cycle.
  assert.deepEqual(dependencyCycles(v), []);
});

test('demonstration 9: a process KILLED mid-write -- the graph re-opens to the same projection from its ledger, and from a signed snapshot; an unreadable work ledger is replayed unavailable, never invented', {timeout: 180_000}, async t => {
  const W = world(t), ids = [];
  let killed = false;
  const k = run(['grind', W.dir, '400'], {onLine: (l, c) => { if (/^sha256:/.test(l)) ids.push(l); if (ids.length >= 6 && !killed) { killed = true; c.kill('SIGKILL'); } }});
  const r = await k.done;
  assert.equal(r.signal, 'SIGKILL', 'the writer was killed mid-run');
  const g = W.open({lockStaleMs: 1000}), v = g.view();
  assert.equal(g.verification.complete, true);
  for (const id of ids) assert.ok(g.projection.knows(id), `${id}: what the writer reported written is there`);
  const written = v.subjects().filter(x => x.includes('/work/discovery/grind/'));
  assert.ok(written.length >= ids.length && written.length < 400, `${written.length} of 400 written before the kill: nothing beyond what the ledger holds`);
  assert.equal(g.ledger.read().filter(e => e.kind === 'graph.assert').length, written.length + 1, 'one entry per record, and the observation: no partial entry');
  // The same projection in a FRESH process, and on a replay from nothing.
  const fresh = JSON.parse((await run(['digest', W.dir]).done).out.trim());
  assert.deepEqual([fresh.digest, fresh.complete], [g.digest(), true]);
  assert.deepEqual([g.reconcile().equal, g.reconcile().replay.digest], [true, g.digest()]);
  // From a signed snapshot (a synthetic snapshot key): the same projection.
  const snapDir = path.join(W.dir, 'snapshots'), signer = generateSigner('graph-snapshot');
  writeSnapshot(g, {dir: snapDir, signer});
  const s = W.open({snapshot: {dir: snapDir, keys: {[signer.key_id]: signer.publicJwk}}});
  assert.deepEqual([s.verification.snapshot.used, s.digest()], [true, g.digest()]);
  // No invented state: the work ledger moved away, a fresh process replays it UNAVAILABLE and holds none of its facts.
  fs.renameSync(W.w.root, `${W.w.root}.gone`);
  const gone = JSON.parse((await run(['digest', W.dir]).done).out.trim());
  assert.equal(gone.complete, false, 'the open is partial, and says so');
  assert.equal(gone.plan_established, false, 'the work facts are absent, not assumed');
  assert.ok(gone.sources.some(([id, , replay]) => id === WORK_GRAPH_SOURCE && replay === 'unavailable'));
  assert.equal(W.open().view().nodeIn(planId(W.w.records['team-construction'].plan.hash), 'established'), false);
});
