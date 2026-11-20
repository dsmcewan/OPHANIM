// Knowledge graphs, Slice D part 2 (docs/knowledge-graph/slice-d2.md): the graph IN the foundry's loop. The cursor in the
// input signature (KD2-1), the graph-derived gates -- block, reason, unlock, the prerequisite's own work, cycles, a
// hypothetical never blocking, unrelated work untouched (KD2-2) --, the typed requirements re-checked by version and stale
// validity re-planned (KD2-3), the write-back and discoveries (KD2-5) and the per-tick open (KD2-6), over a SYNTHETIC
// world: a fixture status ledger signed by a SYNTHETIC owner key, a work ledger, and a graph ledger with SYNTHETIC keys
// (fixtures/graph-d2.mjs). The stage executors are scripted: no provider is called.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {tick, watch, inputSignature} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {GRAPH_ABSENT} from './gates.mjs';
import {planId} from '../graph/work.mjs';
import {reassessmentId} from '../graph/reassess.mjs';
import {d2World, loopOf, graphExecutors, setPrereqs, hypotheticalRequirement, LIMITS, PREREQ, PREREQ2, OTHER, PREREQ_SOURCE} from './fixtures/graph-d2.mjs';

const at = w => ({repo: w.repo, statusRoot: w.statusRoot, workRoot: w.workRoot});
const run = (w, ex, loop, limits = LIMITS, only = null) => tick({...at(w), executors: ex, limits, graph: loop, only});
const gateOf = (w, item, loop = null) => reconcile({...at(w), workLedger: openWorkLedger({root: w.workRoot}), ...(loop ? {graph: loop.context({write: false})} : {})}).items.find(i => i.item === item).gate;
const done = (r, item) => r.dispatched.filter(d => d.item === item).map(d => d.stage);
const WHY = 'the work is routed through the dispatch interface it names';

test('KD2-1 the graph cursor is in the input signature: a change in the graph wakes a tick, an unchanged graph does not', async () => {
  const w = d2World(['a']);
  try {
    const loop = loopOf(w);
    const s1 = inputSignature({...at(w), graph: loop}), s2 = inputSignature({...at(w), graph: loop}), plain = inputSignature(at(w));
    assert.equal(s1, s2, 'an unchanged graph does not wake');
    // Only the graph changes: another actor establishes the prerequisite and observes the source (a new implemented-by).
    setPrereqs(w.prereqFile, {established: {[OTHER]: null, [PREREQ]: null}});
    const other = loopOf(w);
    other.open();
    assert.equal(other.observe([PREREQ_SOURCE])[0].recorded, true);
    const s3 = inputSignature({...at(w), graph: loop});
    assert.notEqual(s3, s2, 'the graph changed: the signature changed');
    assert.equal(inputSignature(at(w)), plain, 'nothing else changed: the status, work, tickets and routing are as they were');
    // watch ticks on a change of the graph alone, and not without one.
    const {ex} = graphExecutors(w);
    const state = {last: null};
    assert.equal((await watch({...at(w), executors: ex, limits: {...LIMITS, iterations: 1}, graph: loop, once: true, state})).length, 1, 'the first check ticks');
    assert.equal((await watch({...at(w), executors: ex, limits: {...LIMITS, iterations: 1}, graph: loop, once: true, state})).length, 0, 'nothing changed: no tick');
    setPrereqs(w.prereqFile, {established: {[OTHER]: null}});
    other.open();
    assert.equal(other.observe([PREREQ_SOURCE])[0].recorded, true);
    assert.equal((await watch({...at(w), executors: ex, limits: {...LIMITS, iterations: 1}, graph: loop, once: true, state})).length, 1, 'the graph changed: a tick');
  } finally { w.done(); }
});

test('KD2-2 a MISSING prerequisite blocks after planning, with its id and the plan line; one candidate; shared, never merged; its establishment wakes and UNLOCKS; unrelated work untouched', async () => {
  const w = d2World(['b1', 'b2', 'u']);
  try {
    const {ex} = graphExecutors(w, {b1: [{id: PREREQ, why: WHY}], b2: [{id: PREREQ, why: `${WHY} (b2)`}]});
    const r1 = await run(w, ex, loopOf(w));
    assert.deepEqual([done(r1, 'b1'), done(r1, 'b2'), done(r1, 'u')], [['plan'], ['plan'], ['plan', 'implement', 'review', 'validate', 'outcome']]);
    for (const item of ['b1', 'b2']) {
      const b = r1.blocked.find(x => x.item === item);
      assert.equal(b.gate, 'blocked');
      assert.equal(b.blocker.code, 'GRAPH_PREREQUISITE_MISSING');
      assert.equal(b.blocker.prerequisite, PREREQ, 'the block names the prerequisite');
      assert.equal(b.blocker.line, 'requires[0]', 'and the plan line that states the requirement');
      assert.match(b.blocker.statement, /dispatch interface it names/);
      assert.match(b.blocker.what, /MISSING/);
      assert.deepEqual(b.blocker.implementers, []);
      assert.match(b.blocker.candidate, /^graph:prerequisite\//);
    }
    // The discovery is ONE intake candidate, recorded unsigned, never executed: no claim names anything but a status item.
    const cdir = path.join(w.stateDir, 'graph-candidates'), files = fs.readdirSync(cdir);
    assert.equal(files.length, 1, 'once, whatever the number of requiring items');
    const c = JSON.parse(fs.readFileSync(path.join(cdir, files[0]), 'utf8'));
    assert.deepEqual([c.classification, c.executable, c.prerequisite, c.required_by], ['candidate', false, PREREQ, ['b1', 'b2']]);
    const work = openWorkLedger({root: w.workRoot});
    assert.deepEqual([...new Set(work.claims().map(x => x.item))].sort(), ['b1', 'b2', 'u'], 'nothing but the owner\'s items is claimed');
    const status = openStatusLedger({root: w.statusRoot, create: false});
    assert.deepEqual(status.board().items.map(i => i.item).sort(), ['b1', 'b2', 'u'], 'the status ledger is the owner\'s: nothing is added');
    // An idle tick from a fresh process's loop: nothing is dispatched; the queue reports the blocks and the shared prerequisite.
    const l2 = loopOf(w), r2 = await run(w, ex, l2);
    assert.deepEqual(r2.dispatched, []);
    assert.deepEqual(r2.queue.blocked.filter(b => b.code === 'GRAPH_PREREQUISITE_MISSING').map(b => [b.item, b.prerequisite, b.line]), [['b1', PREREQ, 'requires[0]'], ['b2', PREREQ, 'requires[0]']]);
    assert.deepEqual(r2.queue.shared.map(s => [s.prerequisite, s.items, s.exists]), [[PREREQ, ['b1', 'b2'], false]], 'shared: two items, two entries, never merged');
    assert.equal(fs.readdirSync(cdir).length, 1, 'the candidate is not recorded again');
    // Unrelated work is untouched: its gate with the graph is exactly its gate without it.
    assert.deepEqual(gateOf(w, 'u', l2), gateOf(w, 'u'));
    for (const s of openWorkLedger({root: w.workRoot}).stages('u')) assert.ok(!('graph' in s.inputs) && !('graph_unlocked' in s.inputs), `u's ${s.stage} identity carries no graph input`);
    // The prerequisite is established (a new implemented-by): the change wakes the tick and both items are unlocked.
    const sig = inputSignature({...at(w), graph: l2});
    setPrereqs(w.prereqFile, {established: {[OTHER]: null, [PREREQ]: null}});
    const l3 = loopOf(w);
    const r3 = await run(w, ex, l3);
    assert.notEqual(inputSignature({...at(w), graph: l3}), sig);
    assert.deepEqual([done(r3, 'b1'), done(r3, 'b2'), done(r3, 'u')], [['implement', 'review', 'validate', 'outcome'], ['implement', 'review', 'validate', 'outcome'], []]);
    assert.deepEqual(r3.queue.unlocked.map(u => [u.item, u.unlocked]), [['b1', [PREREQ]], ['b2', [PREREQ]]]);
    const w3 = openWorkLedger({root: w.workRoot});
    for (const item of ['b1', 'b2']) {
      const impl = w3.stages(item).find(s => s.stage === 'implement');
      assert.equal(impl.inputs.graph_unlocked[0].prerequisite, PREREQ, 'the unlock is recorded on the attempt');
      assert.match(impl.inputs.graph, /^sha256:/, 'the graph-derived input is in the attempt identity');
    }
    const implClaims = w3.claims().filter(x => x.stage === 'implement' && ['b1', 'b2'].includes(x.item));
    assert.deepEqual(implClaims.map(x => x.item).sort(), ['b1', 'b2'], 'two claims, each item its own');
    assert.deepEqual(gateOf(w, 'u', l3), gateOf(w, 'u'), 'and the unrelated item is still untouched');
  } finally { w.done(); }
});

test('KD2-2 a HYPOTHETICAL requirement never blocks: it is recorded as advisory', async () => {
  const w = d2World(['h']);
  try {
    const {ex} = graphExecutors(w, {h: [{id: OTHER, why: 'the index the work reads, which exists'}]});
    const loop = loopOf(w);
    await run(w, ex, loop, {...LIMITS, iterations: 1});
    const plan = openWorkLedger({root: w.workRoot}).stages('h').find(s => s.stage === 'plan');
    const before = gateOf(w, 'h', loop);
    assert.equal(before.gate, 'implement');
    assert.equal(hypotheticalRequirement(loop, w, plan.hash, PREREQ).appended, true, 'an agent claims the plan needs the missing prerequisite');
    const g = gateOf(w, 'h', loop);
    assert.equal(g.gate, 'implement', 'not blocked');
    assert.deepEqual(g.graph.advisory.map(a => [a.prerequisite, a.classification]), [[PREREQ, 'hypothetical']], 'recorded as advisory');
    assert.equal(g.graph.basis, before.graph.basis, 'and the attempt identity is not changed by it');
    const r = await run(w, ex, loopOf(w));
    assert.deepEqual(done(r, 'h'), ['implement', 'review', 'validate', 'outcome']);
  } finally { w.done(); }
});

test('KD2-2 the prerequisite\'s own work is not blocked and the others wait for it (dependencyOrder); a prerequisite cycle is reported and refused, never looped', async () => {
  const w = d2World(['a-needs', 'z-builds', 'c1', 'c2']);
  try {
    const {ex} = graphExecutors(w, {'a-needs': [{id: PREREQ, why: WHY}], 'z-builds': [{id: PREREQ, why: 'this item builds the dispatch interface', implements: true}],
      c1: [{id: PREREQ2, why: 'c1 needs the ledger interface c2 builds'}, {id: 'ophanim/systems/interface/graph-loop-cycle', why: 'c1 builds the cycle interface', implements: true}],
      c2: [{id: 'ophanim/systems/interface/graph-loop-cycle', why: 'c2 needs the cycle interface c1 builds'}, {id: PREREQ2, why: 'c2 builds the ledger interface', implements: true}]});
    const r1 = await run(w, ex, loopOf(w));
    assert.deepEqual(done(r1, 'z-builds'), ['plan', 'implement', 'review', 'validate', 'outcome'], 'the item that implements it is not blocked');
    assert.deepEqual(done(r1, 'a-needs'), ['plan']);
    assert.equal(r1.blocked.find(x => x.item === 'a-needs').blocker.code, 'GRAPH_PREREQUISITE_MISSING');
    assert.equal(fs.existsSync(path.join(w.stateDir, 'graph-candidates')), false, 'no candidate: once every item had its turn to plan, an item implements every missing prerequisite');
    assert.deepEqual([done(r1, 'c1'), done(r1, 'c2')], [['plan'], ['plan']]);
    const r2 = await run(w, ex, loopOf(w));
    for (const item of ['c1', 'c2']) {
      const x = r2.queue.blocked.find(y => y.item === item);
      assert.equal(x.code, 'GRAPH_PREREQUISITE_CYCLE');
      assert.deepEqual([...x.cycle].sort(), ['c1', 'c2']);
    }
    assert.deepEqual(r2.dispatched, [], 'refused, not looped: nothing is dispatched again');
    const b = r2.queue.blocked.find(x => x.item === 'a-needs');
    assert.deepEqual([b.code, b.prerequisite, b.line, b.implementers], ['GRAPH_PREREQUISITE_MISSING', PREREQ, 'requires[0]', ['z-builds']], 'it waits for the item that implements it');
    assert.deepEqual(r2.queue.cycles.map(c => [...c].sort()), [['c1', 'c2']]);
    assert.ok(r2.queue.order.indexOf('z-builds') < r2.queue.order.indexOf('a-needs'), 'the waiting item is ordered after the one that implements its prerequisite');
    const rec = reconcile({...at(w), workLedger: openWorkLedger({root: w.workRoot}), graph: loopOf(w).context()});
    assert.deepEqual(rec.items.find(i => i.item === 'a-needs').graph_depends_on, ['z-builds']);
    assert.equal(openWorkLedger({root: w.workRoot}).claims().filter(c => ['c1', 'c2'].includes(c.item) && c.stage !== 'plan').length, 0, 'no stage after the plan was claimed in the cycle');
  } finally { w.done(); }
});

test('KD2-3 typed requirements are bound by version and re-checked: a changed graph fact makes the plan stale, with D1\'s reassessment set recorded, and it is RE-PLANNED, not executed', async () => {
  const w = d2World(['v', 'quiet']);
  try {
    const {ex} = graphExecutors(w, {v: [{id: OTHER, why: 'the index the work reads, which exists'}]});
    const loop = loopOf(w);
    await run(w, ex, loop, {...LIMITS, iterations: 1}, 'v');
    const W = () => openWorkLedger({root: w.workRoot});
    const plan = W().stages('v').find(s => s.stage === 'plan');
    assert.match(plan.outputs.plan.requires[0].version, /^sha256:/, 'bound to the version the graph stated');
    assert.notEqual(plan.outputs.plan.requires[0].version, GRAPH_ABSENT);
    assert.equal(gateOf(w, 'v', loop).gate, 'implement', 'valid while the graph states the same');
    const quiet = gateOf(w, 'quiet', loop);
    // The graph fact the plan cited changes (the index is now implemented by another module), and the graph observes it.
    setPrereqs(w.prereqFile, {established: {[OTHER]: 'ophanim/systems/module/lib/another-index.mjs'}});
    const actor = loopOf(w);
    actor.open();
    assert.equal(actor.observe([PREREQ_SOURCE])[0].recorded, true);
    const g = gateOf(w, 'v', loopOf(w));
    assert.equal(g.gate, 'plan', 'stale: planned again');
    const why = g.stale.filter(s => s.record === plan.hash).flatMap(s => s.why);
    assert.ok(why.some(x => x.startsWith(`graph fact ${OTHER} changed`)), JSON.stringify(why));
    assert.ok(why.some(x => x.startsWith('reassessed: fixture.prerequisites changed')), JSON.stringify(why));
    assert.deepEqual(gateOf(w, 'quiet', loopOf(w)), quiet, 'the item that cites nothing of it is untouched');
    const l2 = loopOf(w);
    const r = await run(w, ex, l2, {...LIMITS, iterations: 1}, 'v');
    assert.deepEqual(r.dispatched.map(d => [d.item, d.stage]), [['v', 'plan']], 're-planned, not implemented on stale validity');
    assert.equal(W().stages('v').filter(s => s.stage === 'implement').length, 0);
    // D1's reassessment set is RECORDED on the graph (reconcile's graph context, on the observation event), claiming nothing.
    const view = l2.graph().view(), ev = l2.graph().events({after: 0, limit: 1000}).events.filter(e => e.source === PREREQ_SOURCE).at(-1);
    const set = view.node(reassessmentId(`reassess-work/event/${ev.seq}`));
    assert.equal(set.present, true, 'recorded');
    assert.equal(set.attributes.completion, 'not claimed');
    assert.ok(set.attributes.members.some(m => m.id === planId(plan.hash)), 'the plan is a member');
    assert.equal(gateOf(w, 'v', loopOf(w)).gate, 'implement', 'the new plan is valid on the new fact');
    // Without the graph a plan with typed requirements cannot be re-checked: never presumed valid.
    assert.match(gateOf(w, 'v').stale.flatMap(s => s.why).join('; '), /no knowledge graph is supplied/);
  } finally { w.done(); }
});

test('KD2-5 and KD2-6 the write-back is idempotent and the tick opens the graph once, from its signed snapshot, never re-derived in full', async () => {
  const w = d2World(['x']);
  try {
    const {ex} = graphExecutors(w);
    const l1 = loopOf(w), r1 = await run(w, ex, l1);
    assert.deepEqual(done(r1, 'x'), ['plan', 'implement', 'review', 'validate', 'outcome']);
    assert.equal(r1.graph.stats.opens, 1, 'one open per tick');
    const work = openWorkLedger({root: w.workRoot}).verify().head;
    // The work graph holds the attempt's records, observed at the work ledger's head after the last append.
    assert.equal(l1.graph().view().sources().find(s => s.id === 'ophanim.work-graph').version, work, 'observed at the work ledger\'s head');
    const v = l1.graph().view();
    for (const k of ['plan', 'artifact', 'review', 'validation', 'obligation']) assert.ok(v.subjects().some(s => s.startsWith(`ophanim/work/${k}/`) && v.nodeIn(s, 'established')), `the work graph holds the ${k}`);
    // A repeated observation is a no-op: nothing is appended twice.
    assert.deepEqual(l1.observeWork().map(o => o.recorded), [false]);
    // The next tick records the ticket the plan wrote (an intake, once); the one after it is idle and appends NOTHING.
    const l2 = loopOf(w), r2 = await run(w, ex, l2);
    assert.deepEqual(r2.dispatched, []);
    const head = l2.graph().view().seq;
    const l3 = loopOf(w), r3 = await run(w, ex, l3);
    assert.deepEqual(r3.dispatched, []);
    assert.deepEqual(r3.graph.stats.opened.map(o => [o.mode, o.snapshot_seq, o.rederived]), [['snapshot', head, 0]], 'opened from the snapshot at the head, nothing re-derived');
    assert.equal(l3.graph().view().seq, head, 'the idle tick appended nothing to the graph');
    assert.equal(r3.graph.snapshot, null, 'and wrote no new snapshot');
    assert.equal(r3.graph.stats.observations.filter(o => o.recorded).length, 0);
  } finally { w.done(); }
});

test('KD2-6 the per-tick bound on reassessment: at most the bound of event sets is computed per tick; the rest the next tick, counted, never dropped', async () => {
  const w = d2World(['v']);
  try {
    const {ex} = graphExecutors(w, {v: [{id: OTHER, why: 'the index the work reads, which exists'}]});
    await run(w, ex, loopOf(w), {...LIMITS, iterations: 1}, 'v');
    // Two changes of the source the plan rests on, each observed: two change events.
    for (const m of ['index-one', 'index-two']) {
      setPrereqs(w.prereqFile, {established: {[OTHER]: `ophanim/systems/module/lib/${m}.mjs`}});
      const actor = loopOf(w);
      actor.open();
      assert.equal(actor.observe([PREREQ_SOURCE])[0].recorded, true);
    }
    const loop = loopOf(w, {bounds: {events: 1}});
    loop.open();
    const rec = () => reconcile({...at(w), workLedger: openWorkLedger({root: w.workRoot}), graph: loop.context()});
    rec();
    assert.deepEqual([loop.stats().events.considered, loop.stats().events.deferred], [2, 1], 'one set computed, one deferred and counted');
    loop.open();                                                   // the next tick
    const g = rec().items[0].gate;
    assert.deepEqual([loop.stats().events.considered, loop.stats().events.deferred], [2, 0], 'the deferred one is computed the next tick');
    assert.equal(g.stale.flatMap(s => s.why).filter(x => x.startsWith('reassessed:')).length, 2, 'both events reach the plan: none was dropped');
  } finally { w.done(); }
});
