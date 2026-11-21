#!/usr/bin/env node
// A separate process for Slice D part 1's concurrency and replay tests (not a test file): it opens the world a test built
// (its graph ledger and SYNTHETIC keys, its work ledger) and does one thing, printing what it did.
//   node d1-child.mjs race <world> <name> <n>   wait for <world>/go; claim the shared prerequisite's item on the work ledger
//                                               through its own writer (one claim can win); observe the work graph; record
//                                               the shared-prerequisite findings; then n assertions of its own. A JSON summary.
//   node d1-child.mjs grind <world> <n>         observe, then record n assertions one at a time, printing each id once written
//   node d1-child.mjs digest <world>            open the graph from its ledger: {digest, complete, seq, work} as JSON
import fs from 'node:fs';
import path from 'node:path';
import {openGraph, assertion, entityId} from '../../../packages/graph/index.mjs';
import {originsOf} from '../extract/index.mjs';
import {workGraphSource, recordSharedPrerequisites, WORK_GRAPH_SOURCE, WORK_RULE, planId} from '../work.mjs';
import {openWorkLedger} from '../../operate/work-ledger.mjs';

const [cmd, world, ...rest] = process.argv.slice(2);
const W = JSON.parse(fs.readFileSync(path.join(world, 'world.json'), 'utf8'));
const keys = JSON.parse(fs.readFileSync(path.join(world, 'keys.json'), 'utf8'));
const open = () => openGraph({dir: path.join(world, 'graph'), anchor: W.anchor, origins: originsOf(), sources: [workGraphSource({root: W.work.root, anchor: W.work.anchor})], lockTimeoutMs: 60_000});
const by = k => ({signer: keys[k], order: keys['graph-operator']});
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const own = (g, key, i) => {
  const plan = planId(W.plan), input = g.view().query(plan, 'established')[0].id;
  return assertion({entity: entityId({domain: 'work', type: 'discovery', key: `${key}/${i}`}), origin: WORK_RULE, classification: 'derived', observed_at: W.at, inputs: [input],
    source: {id: 'ophanim.work-rule', authority: 'a SYNTHETIC record of a test process', ref: key, version: input}, attributes: {i, by: key}});
};

if (cmd === 'race') {
  const [name, n] = [rest[0], Number(rest[1])];
  const go = path.join(world, 'go'), deadline = Date.now() + 30_000;
  while (!fs.existsSync(go) && Date.now() < deadline) sleep(2);
  const summary = {name, claimed: false, refused: null, observed: 0, findings: 0, appended: 0, noops: 0};
  // Two executing tickets want the shared prerequisite: its item is claimed through the work ledger's OWN writer.
  try {
    openWorkLedger({root: W.work.root}).claim({item: W.shared_item, stage: 'plan', attempt: 1, inputs: {by: name}, holder: `process-${name}`,
      budget: {provider_calls: 1, iterations: 1, elapsed_ms: 60_000, retries: 0}});
    summary.claimed = true;
  } catch (e) { summary.refused = String(e.message).slice(0, 200); }
  const g = open();
  if (g.observe(WORK_GRAPH_SOURCE, {...by('graph-extractor'), observed_at: W.at}).recorded) summary.observed++;
  for (const f of recordSharedPrerequisites(g, by('graph-rule'), {observed_at: W.at})) if (f.recorded) summary.findings++;
  for (let i = 0; i < n; i++) { const w = g.assert([own(g, `own-${name}`, i)], by('graph-rule')); if (w.appended) summary.appended++; else summary.noops++; }
  console.log(JSON.stringify(summary));
} else if (cmd === 'grind') {
  const g = open();
  g.observe(WORK_GRAPH_SOURCE, {...by('graph-extractor'), observed_at: W.at});
  fs.writeSync(1, 'observed\n');
  for (let i = 0; i < Number(rest[0]); i++) { const r = own(g, 'grind', i); g.assert([r], by('graph-rule')); fs.writeSync(1, r.id + '\n'); sleep(5); }
} else if (cmd === 'digest') {
  const g = open(), v = g.view(), plan = planId(W.plan);
  console.log(JSON.stringify({digest: g.digest(), seq: v.seq, complete: g.verification.complete, plan_established: v.nodeIn(plan, 'established'),
    sources: v.sources().map(s => [s.id, s.state, s.replay])}));
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
