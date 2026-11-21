#!/usr/bin/env node
// A separate process for the graph tests (not a test file): it opens the world a test built (its ledger, its synthetic
// keys, its published source) and does one thing, printing what it did.
//   node child.mjs digests <world>          the projection digest at every cursor, as JSON
//   node child.mjs append <world> <n>       append `planned(n)` one at a time, printing each id once it is written
//   node child.mjs race <world> <name> <n>  wait for <world>/go, observe the source, then append n shared and n own
//                                           observations (each shared one with an edge), and print a JSON summary
import fs from 'node:fs';
import path from 'node:path';
import {openGraph} from '../kinds.mjs';
import {assertion} from '../schema.mjs';
import {ORIGINS, OPERATOR, KEY_OF, SYSTEM, dirSource, planned, src, id, C, T0, V1} from './fixture.mjs';

const [cmd, world, ...rest] = process.argv.slice(2);
const keys = JSON.parse(fs.readFileSync(path.join(world, 'keys.json'), 'utf8'));
const anchor = fs.readFileSync(path.join(world, 'anchor'), 'utf8');
const open = () => openGraph({dir: path.join(world, 'ledger'), anchor, origins: ORIGINS, sources: [dirSource(path.join(world, 'src'))], lockTimeoutMs: 60_000});
const by = name => ({signer: keys[KEY_OF[name]], order: keys[OPERATOR]});
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (cmd === 'digests') {
  const g = open();
  console.log(JSON.stringify(Array.from({length: g.projection.seq + 1}, (_, c) => g.digest(c))));
} else if (cmd === 'append') {
  const g = open();
  for (const r of planned(Number(rest[0]))) { g.assert([r], by('tool')); fs.writeSync(1, r.id + '\n'); }
} else if (cmd === 'race') {
  const [name, n] = [rest[0], Number(rest[1])];
  const go = path.join(world, 'go'), deadline = Date.now() + 30_000;
  while (!fs.existsSync(go) && Date.now() < deadline) sleep(2);
  const g = open(), summary = {name, appended: 0, noops: 0, observed: 0};
  if (g.observe(SYSTEM, {...by('extractor'), observed_at: T0}).recorded) summary.observed++;
  const count = w => { if (w.appended) summary.appended += w.ids.length; else summary.noops++; };
  const shared = planned(n, 'shared'), own = planned(n, `own-${name}`);
  for (let i = 0; i < n; i++) {
    count(g.assert([shared[i]], by('tool')));
    count(g.assert([assertion({type: 'verifies', from: id('evidence', 'observation', `shared-${i}`), to: C('sdk-gateway'), origin: 'synthetic.tool',
      classification: 'observed', source: src('synthetic.runs', V1), run: {id: `run-shared-${i}`}, observed_at: T0})], by('tool')));
    count(g.assert([own[i]], by('tool')));
  }
  console.log(JSON.stringify(summary));
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
