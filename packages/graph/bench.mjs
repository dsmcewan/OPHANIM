#!/usr/bin/env node
// Measure the foundation on a synthetic large graph (docs/knowledge-graph/architecture.md "Measured"). Not a test:
// numbers vary by machine. Synthetic keys, a temporary ledger, no provider, nothing outside the temporary directory.
//
//   node packages/graph/bench.mjs [--nodes 60000] [--edges 240000] [--entries 2000]
//
// 1. One source of N nodes and E random depends-on edges, observed once through the real path (the extractor's facts
//    re-derived, validated, digested and applied; one observation entry on a packages/ledger chain), then replayed by
//    a fresh open; then a 3-hop neighbourhood, a reverse impact closure at the defaults and at the ceilings.
// 2. A graph ledger of `entries` entries of 10 tool observations each (what no source re-derives), replayed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateSigner} from '../ledger/chain.mjs';
import {createGraphLedger, openGraph} from './kinds.mjs';
import {defineOrigins, assertion} from './schema.mjs';
import {neighborhood, closure, CEILINGS} from './traverse.mjs';
import {versionOf} from './identity.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg('--nodes', 60_000), E = arg('--edges', 240_000), ENTRIES = arg('--entries', 2000);
const ms = t0 => Number(process.hrtime.bigint() - t0) / 1e6;
const now = () => process.hrtime.bigint();
let seed = 42;                                          // mulberry32: deterministic, integer arithmetic only
const rand = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };

const keys = {op: generateSigner('op'), ex: generateSigner('ex'), tool: generateSigner('tool')};
const origins = defineOrigins({'bench.extractor': {kind: 'extractor', basis: 'structural', keys: ['ex'], sources: ['bench.source']},
  'bench.tool': {kind: 'tool', basis: 'measured', keys: ['tool']}});
const node = i => `ophanim/systems/component/n${i}`;
const drafts = [];
for (let i = 0; i < N; i++) drafts.push({entity: node(i), attributes: {}});
const seen = new Set();
while (seen.size < E) {
  const a = Math.floor(rand() * N), b = Math.floor(rand() * N);
  if (a === b || seen.has(a * N + b)) continue;
  seen.add(a * N + b);
  drafts.push({type: 'depends-on', from: node(a), to: node(b), attributes: {}});
}
const version = versionOf({bench: 'source', N, E, seed: 42});
const source = {id: 'bench.source', extractor: 'bench.extractor', authority: 'synthetic benchmark source', ref: 'bench', current: () => ({version}), readAt: () => drafts};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-bench-'));
const out = {nodes: N, edges: E};
try {
  const dir = path.join(root, 'ledger');
  fs.mkdirSync(dir);
  const keyring = Object.fromEntries(Object.values(keys).map(k => [k.key_id, k.publicJwk]));
  const anchor = createGraphLedger({dir, authority: {keyring, orderer: 'op', operators: ['op']}, operator: keys.op, order: keys.op});
  let t = now();
  const g = openGraph({dir, anchor, origins, sources: [source]});
  g.observe('bench.source', {signer: keys.ex, order: keys.op, observed_at: '2026-11-20T00:00:00.000Z'});
  out.first_observation_ms = ms(t);
  out.ledger_bytes = fs.readdirSync(path.join(dir, 'objects')).reduce((n, f) => n + fs.statSync(path.join(dir, 'objects', f)).size, 0) + fs.statSync(path.join(dir, 'chain.jsonl')).size;
  t = now();
  const r = openGraph({dir, anchor, origins, sources: [source]});
  out.replay_ms = ms(t);
  out.same_digest = r.digest() === g.digest();
  const v = r.view();
  out.stats = v.stats();
  t = now(); const hood = neighborhood(v, node(0), {depth: 3}); out.three_hop = {ms: ms(t), nodes: hood.nodes.length, limit: hood.coverage.limit};
  t = now(); const c1 = closure(v, node(1)); out.closure_defaults = {ms: ms(t), nodes: c1.nodes.length, limit: c1.coverage.limit};
  t = now(); const c2 = closure(v, node(1), {depth: CEILINGS.depth, maxNodes: CEILINGS.maxNodes, maxEdges: CEILINGS.maxEdges}); out.closure_ceilings = {ms: ms(t), nodes: c2.nodes.length, limit: c2.coverage.limit};
  t = now(); v.digest(); out.digest_ms = ms(t);

  // 2. the graph ledger's own records
  const dir2 = path.join(root, 'ledger2');
  fs.mkdirSync(dir2);
  const anchor2 = createGraphLedger({dir: dir2, authority: {keyring, orderer: 'op', operators: ['op']}, operator: keys.op, order: keys.op});
  const g2 = openGraph({dir: dir2, anchor: anchor2, origins, sources: []});
  t = now();
  for (let e = 0; e < ENTRIES; e++) {
    g2.assert(Array.from({length: 10}, (_, i) => assertion({entity: `ophanim/evidence/observation/e${e}-${i}`, origin: 'bench.tool', classification: 'observed',
      source: {id: 'bench.runs', authority: 'benchmark', ref: 'bench', version}, run: {id: `r${e}`}, observed_at: '2026-11-20T00:00:00.000Z'})), {signer: keys.tool, order: keys.op});
  }
  out.ledger_entries = ENTRIES;
  out.append_ms_per_entry = ms(t) / ENTRIES;
  t = now();
  const r2 = openGraph({dir: dir2, anchor: anchor2, origins, sources: []});
  out.ledger_replay_ms = ms(t);
  out.ledger_assertions = r2.view().stats().assertions;
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
console.log(JSON.stringify(out, null, 2));
