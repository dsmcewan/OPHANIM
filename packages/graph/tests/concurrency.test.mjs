// Two processes appending to one graph ledger (KD11; demonstration 8 at foundation level): both go through
// packages/ledger's append discipline (its lock, verify-before-append, re-derivation under the lock). A duplicate is
// recorded once, nothing either writes is lost, and the source change both observe is one observation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {world, SYSTEM, SYSTEM_SNAPSHOT, C, id, T0, planned} from './fixture.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'child.mjs');
const run = (args) => new Promise(resolve => {
  const c = spawn(process.execPath, [CHILD, ...args], {stdio: ['ignore', 'pipe', 'pipe']});
  let out = '', err = '';
  c.stdout.on('data', d => { out += d; });
  c.stderr.on('data', d => { err += d; });
  c.once('close', code => resolve({code, out, err}));
});

test('concurrency: two processes appending at once lose no update and record each duplicate once (demonstration 8)', {timeout: 180_000}, async t => {
  const w = world(t), N = 25;
  w.open().observe(SYSTEM, {...w.by('extractor'), observed_at: T0});
  w.publish({...SYSTEM_SNAPSHOT, entities: {...SYSTEM_SNAPSHOT.entities, [C('session')]: {moved: true}}});
  const before = w.open().ledger.read().length;
  const children = ['a', 'b'].map(name => run(['race', w.dir, name, String(N)]));
  fs.writeFileSync(path.join(w.dir, 'go'), '');
  const results = await Promise.all(children);
  for (const r of results) assert.equal(r.code, 0, r.err);
  const summaries = results.map(r => JSON.parse(r.out.trim().split('\n').at(-1)));
  const g = w.open();
  assert.equal(g.verification.complete, true, 'the ledger both wrote verifies and re-derives');
  // Nothing lost: every observation either wrote is there.
  for (const r of [...planned(N, 'shared'), ...planned(N, 'own-a'), ...planned(N, 'own-b')]) assert.ok(g.projection.knows(r.id), r.subject);
  // Each duplicate once: one assertion per shared subject, one edge, one ledger entry each.
  const v = g.view();
  for (let i = 0; i < N; i++) {
    const s = id('evidence', 'observation', `shared-${i}`);
    assert.equal(v.query(s, 'recorded').length, 1, s);
    assert.deepEqual(v.edgesOf(s).map(e => e.assertions.length), [1], `${s}: one verifies edge, one supporting assertion`);
  }
  const written = g.ledger.read().filter((e, i) => i >= before && e.kind.startsWith('graph.'));
  assert.equal(written.length, 1 + N * 4, 'one observation, N shared observations and edges, and N own observations for each writer');
  assert.deepEqual([summaries.reduce((n, s) => n + s.appended, 0), summaries.reduce((n, s) => n + s.observed, 0)], [N * 4, 1],
    'what the writers say they appended adds up to what is there; the shared source change was observed once');
  assert.equal(g.reconcile().equal, true);
});
