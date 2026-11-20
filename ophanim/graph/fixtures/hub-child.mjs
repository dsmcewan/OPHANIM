#!/usr/bin/env node
// A CHILD PROCESS of the hub-readiness determination (ophanim/graph/hub.mjs), so each measurement has a process of its own:
//
//   node ophanim/graph/fixtures/hub-child.mjs scale ROOT OPTIONS_JSON   build the federation at a size under ROOT and run
//                                                                       the cost criteria (hub.mjs scaleRun); one JSON line
//   node ophanim/graph/fixtures/hub-child.mjs open ROOT [SNAPSHOT_DIR]   open the central of the world at ROOT in this
//                                                                       FRESH process, in full or from the signed snapshot
//                                                                       (pinned to the world's synthetic snapshot key); one
//                                                                       JSON line {ms, rss_mb, heap_mb, seq, digest, snapshot}
//
// Modules are loaded before the clock starts. Synthetic keys only; everything stays under ROOT.
import {worldOf} from './hub-world.mjs';
import {scaleRun} from '../hub.mjs';

const [mode, root, arg] = process.argv.slice(2);
if (mode === 'scale') {
  const o = JSON.parse(arg);
  process.stdout.write(JSON.stringify(scaleRun({root, ...o})) + '\n');
} else if (mode === 'open') {
  const w = worldOf(root);
  const t0 = process.hrtime.bigint();
  const central = w.central(arg ? {snapshot: {dir: arg, keys: {'central-snapshot': w.snapshotKey.publicJwk}}} : {});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const view = central.graph.view(), m = process.memoryUsage();
  process.stdout.write(JSON.stringify({ms: Math.round(ms * 10) / 10, rss_mb: Math.round(m.rss / 1e6), heap_mb: Math.round(m.heapUsed / 1e6), seq: view.seq, digest: view.digest(),
    assertions: view.stats().assertions, snapshot: (s => (s ? {used: s.used, seq: s.seq ?? null, reason: s.reason ?? null} : null))(central.graph.verification?.snapshot)}) + '\n');
} else {
  process.stderr.write('usage: hub-child.mjs scale ROOT OPTIONS_JSON | open ROOT [SNAPSHOT_DIR]\n');
  process.exit(2);
}
