// Knowledge graphs, Slice D part 2 (docs/knowledge-graph/slice-d2.md), KD2-8: DEMONSTRATION 8 IN THE LOOP. Two REAL
// processes run the scheduler's ticks with the graph loop over one SYNTHETIC world (fixtures/graph-d2.mjs, child
// fixtures/graph-d2-child.mjs): the work ledger's append lock and the graph ledger's lock apply between them. Two items
// executing concurrently share a dependency; two more form a prerequisite cycle. No duplicate claim or execution, no
// circular execution (the cycle is reported and refused, never looped), no lost graph update. No provider is called.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openWorkLedger} from './work-ledger.mjs';
import {planId, artifactId, sharedPrerequisiteId} from '../graph/work.mjs';
import {d2World, loopOf, OTHER, PREREQ2} from './fixtures/graph-d2.mjs';

const CHILD = fileURLToPath(new URL('./fixtures/graph-d2-child.mjs', import.meta.url));
const child = (repo, name) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [CHILD, repo, name], {stdio: ['ignore', 'pipe', 'pipe']});
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; });
  p.stderr.on('data', d => { err += d; });
  p.on('error', reject);
  p.on('close', code => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').at(-1))) : reject(new Error(`child ${name} exited ${code}: ${err.slice(-2000)}`))));
});
const CYCLE = 'ophanim/systems/interface/graph-loop-cycle';

test('demonstration 8 (KD2-8): two real processes, two items sharing a dependency and a prerequisite cycle: no duplicate claims, no circular execution, no lost graph updates', async () => {
  const w = d2World(['s1', 's2', 'c1', 'c2']);
  try {
    fs.writeFileSync(path.join(w.repo, 'status', 'plans.json'), JSON.stringify({
      s1: [{id: OTHER, why: 'both items read the shared index'}], s2: [{id: OTHER, why: 'both items read the shared index too'}],
      c1: [{id: PREREQ2, why: 'c1 needs the ledger interface c2 builds'}, {id: CYCLE, why: 'c1 builds the cycle interface', implements: true}],
      c2: [{id: CYCLE, why: 'c2 needs the cycle interface c1 builds'}, {id: PREREQ2, why: 'c2 builds the ledger interface', implements: true}]}));
    openWorkLedger({root: w.workRoot});   // the ledger and its controller key exist before either process starts
    const runs = [child(w.repo, 'one'), child(w.repo, 'two')];
    await new Promise(r => setTimeout(r, 300));
    fs.writeFileSync(path.join(w.repo, 'status', 'go'), '');
    const [one, two] = await Promise.all(runs);
    const all = [...one.dispatched, ...two.dispatched];
    assert.deepEqual([...new Set(openWorkLedger({root: w.workRoot}).claims().map(c => c.holder))].sort(), ['process-one', 'process-two'], 'both processes executed stages: concurrently, on one work ledger');
    // NO DUPLICATE CLAIM OR EXECUTION: each stage of each shared-dependency item ran exactly once, by one process.
    const W = openWorkLedger({root: w.workRoot});
    assert.equal(W.verify().ok, true);
    for (const item of ['s1', 's2']) {
      assert.deepEqual(W.stages(item).map(s => `${s.stage}:${s.status}`), ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed'], `${item}: each stage once`);
      const keys = W.claims(item).map(c => `${c.stage}|${c.key}`);
      assert.equal(new Set(keys).size, keys.length, `${item}: no two claims of one attempt`);
      assert.equal(all.filter(d => d.startsWith(`${item}:`)).length, 5, `${item}: five stages dispatched in all, by the two processes together`);
    }
    // NO CIRCULAR EXECUTION: the cycle is reported by each process and refused; nothing after the plan ran for it.
    for (const item of ['c1', 'c2']) {
      assert.deepEqual(W.stages(item).map(s => s.stage), ['plan'], `${item}: planned once, never executed past the plan`);
      assert.equal(W.claims(item).filter(c => c.stage !== 'plan').length, 0);
    }
    assert.ok([one, two].some(s => s.blocked.c1 === 'GRAPH_PREREQUISITE_CYCLE' && s.blocked.c2 === 'GRAPH_PREREQUISITE_CYCLE'), JSON.stringify([one.blocked, two.blocked]));
    assert.deepEqual([...[one, two].find(s => s.cycles.length).cycles[0]].sort(), ['c1', 'c2']);
    assert.ok(one.ticks + two.ticks <= 8, 'bounded: no process loops on the cycle');
    // NO LOST GRAPH UPDATE: a fresh open holds every record both processes made, equal to a replay from nothing.
    const loop = loopOf(w), g = loop.open();
    loop.observeWork();
    const v = g.view();
    assert.equal(v.sources().find(s => s.id === 'ophanim.work-graph').version, W.verify().head, 'the graph observed the work ledger\'s head');
    for (const s of W.stages()) if (s.stage === 'plan' && s.status === 'passed') assert.ok(v.nodeIn(planId(s.hash), 'established'), `plan ${s.hash.slice(0, 19)} is in the graph`);
    for (const s of W.stages()) if (s.stage === 'implement' && s.status === 'passed') assert.ok(v.nodeIn(artifactId(s.hash), 'established'), `artifact ${s.hash.slice(0, 19)} is in the graph`);
    const rec = g.reconcile();
    assert.equal(rec.equal, true, JSON.stringify(rec.differences?.slice(0, 3)));
    // The shared dependency is ONE finding naming both items: not two, and never a merge.
    const finding = v.query(sharedPrerequisiteId(OTHER), 'recorded').filter(a => a.current);
    assert.equal(finding.length, 1);
    assert.deepEqual(v.node(sharedPrerequisiteId(OTHER)).attributes.items.map(i => i.item), ['s1', 's2']);
    // Each work-ledger version was observed once: a repeated observation appended nothing.
    const versions = g.events({after: 0, limit: 1000}).events.filter(e => e.source === 'ophanim.work-graph').map(e => e.to_version);
    assert.equal(new Set(versions).size, versions.length, 'no observation of one version twice');
  } finally { w.done(); }
});
