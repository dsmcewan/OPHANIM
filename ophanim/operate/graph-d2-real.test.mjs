// Knowledge graphs, Slice D part 2 (docs/knowledge-graph/slice-d2.md), on the REAL graph of this checkout (the repository,
// its verification, records, lessons, learning and dependency sources at HEAD, read only) beside a SYNTHETIC work ledger:
// KD2-5, a relevant failure mechanism becomes a PROPOSAL to the coordinator, never an edit of the lessons registry or the
// register; KD2-6, the added cost of a tick with the graph, measured (one open per tick, from the signed snapshot). The
// graph ledger, its snapshot and every key are SYNTHETIC and temporary. No provider is called.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {generateSigner} from '../../packages/ledger/index.mjs';
import {createGraphLedger} from '../../packages/graph/index.mjs';
import {originsOf, ORDER, ROOT} from '../graph/extract/index.mjs';
import {tick} from './scheduler.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {createGraphLoop, loopSources, LOOP_BOUNDS} from './graph-loop.mjs';
import {d2World, graphExecutors, LIMITS, T0} from './fixtures/graph-d2.mjs';

const sha = f => createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const GUARDED = ['ophanim/lessons/corrections.json', 'docs/OPEN-LIMITATIONS.md'];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-d2-real-'));
after(() => fs.rmSync(dir, {recursive: true, force: true}));
const keys = {operator: generateSigner('graph-operator'), extractor: generateSigner('graph-extractor'), rule: generateSigner('graph-rule'), snapshot: generateSigner('graph-snapshot')};
const anchor = createGraphLedger({dir: path.join(dir, 'graph'), operator: keys.operator, order: keys.operator, authority: {orderer: 'graph-operator', operators: ['graph-operator'],
  keyring: {'graph-operator': keys.operator.publicJwk, 'graph-extractor': keys.extractor.publicJwk, 'graph-rule': keys.rule.publicJwk}}});
fs.mkdirSync(path.join(dir, 'snapshots'));
/** A loop over the real graph and the work ledger at `workRoot` (a SYNTHETIC fixture's). */
const realLoop = (workRoot, stateDir) => createGraphLoop({dir: path.join(dir, 'graph'), anchor, origins: originsOf(),
  sources: () => loopSources({repo: ROOT, workRoot, only: null, lessons: true, deps: true}),
  snapshot: {dir: path.join(dir, 'snapshots'), keys: {[keys.snapshot.key_id]: keys.snapshot.publicJwk}, signer: keys.snapshot},
  writers: {extractor: {signer: keys.extractor, order: keys.operator}, rule: {signer: keys.rule, order: keys.operator}}, stateDir, workRoot, observed_at: () => T0});
const ms = t => Math.round(Number(process.hrtime.bigint() - t) / 1e6);

test('KD2-6 the added cost of a tick with the graph, on the real graph: one open per tick, from the signed snapshot; measured', async t => {
  const plainWorld = d2World(['x']), graphWorld = d2World(['x']);
  try {
    // The real graph is built once (every source observed, in order) and its snapshot written: the loop's first use. The
    // work ledger exists first, so the work graph is one of the registered sources the snapshot is taken with.
    openWorkLedger({root: graphWorld.workRoot});
    const first = realLoop(graphWorld.workRoot, graphWorld.stateDir);
    const t0 = process.hrtime.bigint();
    const g = first.open();
    first.observe(ORDER.filter(id => g.projection.adapters.has(id)));
    const built = ms(t0), facts = g.view().stats().current;
    const t1 = process.hrtime.bigint();
    first.checkpoint();
    const snapshotMs = ms(t1);
    // The same tick without and with the graph (scripted executors: five stages of one item).
    const ta = process.hrtime.bigint();
    const a = await tick({repo: plainWorld.repo, statusRoot: plainWorld.statusRoot, workRoot: plainWorld.workRoot, executors: graphExecutors(plainWorld).ex, limits: LIMITS});
    const plainMs = ms(ta);
    const loop = realLoop(graphWorld.workRoot, graphWorld.stateDir);
    const tb = process.hrtime.bigint();
    const b = await tick({repo: graphWorld.repo, statusRoot: graphWorld.statusRoot, workRoot: graphWorld.workRoot, executors: graphExecutors(graphWorld).ex, limits: LIMITS, graph: loop});
    const graphMs = ms(tb);
    assert.deepEqual(b.dispatched.map(d => d.stage), a.dispatched.map(d => d.stage), 'the same work');
    const s = b.graph.stats;
    assert.equal(s.opens, 1, 'one open per tick');
    assert.deepEqual(s.opened.map(o => [o.mode, o.rederived]), [['snapshot', 0]], `from the snapshot: nothing re-derived (${JSON.stringify(s.opened)})`);
    assert.equal(s.events.deferred, 0, `at most ${LOOP_BOUNDS.events} reassessments per tick, none deferred here`);
    // An idle tick with the graph: the floor of the per-tick cost.
    const tc = process.hrtime.bigint();
    const c = await tick({repo: graphWorld.repo, statusRoot: graphWorld.statusRoot, workRoot: graphWorld.workRoot, executors: graphExecutors(graphWorld).ex, limits: LIMITS, graph: realLoop(graphWorld.workRoot, graphWorld.stateDir)});
    const idleMs = ms(tc);
    assert.deepEqual(c.graph.stats.opened.map(o => o.mode), ['snapshot']);
    const round = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
    t.diagnostic(`real graph: ${facts} current facts; built (full open and every source observed) in ${built} ms; snapshot written in ${snapshotMs} ms`);
    t.diagnostic(`tick of one item, five scripted stages: ${plainMs} ms without the graph, ${graphMs} ms with it (added ${graphMs - plainMs} ms); graph parts ${JSON.stringify(round(s.ms))} ms; work observations ${s.observations.length}`);
    t.diagnostic(`idle tick with the graph: ${idleMs} ms (graph parts ${JSON.stringify(round(c.graph.stats.ms))} ms)`);
  } finally { plainWorld.done(); graphWorld.done(); }
});

test('KD2-5 a relevant failure mechanism becomes a PROPOSAL to the coordinator, written as a record, once; the lessons registry and the register are never edited', () => {
  const before = Object.fromEntries(GUARDED.map(f => [f, sha(f)]));
  const w = d2World(['x']);
  try {
    const loop = realLoop(w.workRoot, w.stateDir);
    loop.open();
    // A SYNTHETIC failed review record whose finding names a real component: the learning graph relates it.
    const record = {hash: 'sha256:' + 'f'.repeat(64), stage: 'review', status: 'failed', identity: {item: 'x'},
      findings: [{id: 'f1', severity: 'major', file: 'ophanim/operate/context.mjs', text: 'SYNTHETIC: a reviewer saw evidence stored and not delivered'}]};
    const wb = loop.writeBack(record);
    assert.equal(wb.proposals.length, 1);
    assert.equal(wb.proposals[0].recorded, true);
    const p = JSON.parse(fs.readFileSync(wb.proposals[0].file, 'utf8'));
    assert.deepEqual([p.schema, p.to, p.applied, p.kind, p.subject], ['ophanim.coordinator-proposal/v1', 'coordinator', false, 'lesson-instance', 'ophanim/operate/context.mjs']);
    assert.ok(p.classes.some(c => /stored-not-delivered/.test(c.id)), JSON.stringify(p.classes.map(c => c.id)));
    assert.ok(path.relative(w.stateDir, wb.proposals[0].file).startsWith('graph-proposals'), 'recorded under the operate state directory');
    assert.match(p.authority, /coordinator, who alone edits ophanim\/lessons/);
    // Once: the same discovery again records nothing new.
    assert.deepEqual(loop.writeBack(record).proposals.map(x => x.recorded), [false]);
    assert.equal(fs.readdirSync(path.join(w.stateDir, 'graph-proposals')).length, 1);
    // Never a direct edit: the registry and the register are byte-identical.
    assert.deepEqual(Object.fromEntries(GUARDED.map(f => [f, sha(f)])), before);
  } finally { w.done(); }
});
