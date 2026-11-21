#!/usr/bin/env node
// A separate process for Slice D part 2's concurrency test (demonstration 8 in the loop; not a test file). It opens the
// SYNTHETIC world a test built (fixtures/graph-d2.mjs: its status, work and graph ledgers, its SYNTHETIC keys), waits for
// <repo>/status/go, then runs the scheduler's tick WITH the graph loop and the scripted executors until a tick dispatches
// nothing (at most four ticks), and prints a JSON summary of what it did. No provider is called.
//   node graph-d2-child.mjs <repo> <name>
import fs from 'node:fs';
import path from 'node:path';
import {tick} from '../scheduler.mjs';
import {openWorld, loopOf, graphExecutors, LIMITS} from './graph-d2.mjs';

const [repo, name] = process.argv.slice(2);
const w = openWorld(repo);
const plans = JSON.parse(fs.readFileSync(path.join(repo, 'status', 'plans.json'), 'utf8'));
const go = path.join(repo, 'status', 'go'), deadline = Date.now() + 60_000;
while (!fs.existsSync(go) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
const {ex} = graphExecutors(w, plans);
const summary = {name, ticks: 0, dispatched: [], skipped: [], blocked: {}, cycles: [], opened: []};
for (let i = 0; i < 4; i++) {
  const loop = loopOf(w);
  const r = await tick({repo: w.repo, statusRoot: w.statusRoot, workRoot: w.workRoot, executors: ex, limits: LIMITS, holder: `process-${name}`, graph: loop});
  summary.ticks++;
  summary.dispatched.push(...r.dispatched.map(d => `${d.item}:${d.stage}:${d.status}`));
  summary.skipped.push(...r.skipped.map(s => `${s.item}:${s.gate}:${String(s.why).slice(0, 80)}`));
  for (const b of r.queue?.blocked ?? []) summary.blocked[b.item] = b.code;
  summary.cycles = r.queue?.cycles ?? summary.cycles;
  summary.opened.push(...(r.graph?.stats?.opened ?? []).map(o => o.mode));
  if (!r.dispatched.length && !r.skipped.length) break;
}
console.log(JSON.stringify(summary));
