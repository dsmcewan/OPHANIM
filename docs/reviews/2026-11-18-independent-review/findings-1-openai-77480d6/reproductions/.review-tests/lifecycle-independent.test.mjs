import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {makeRetriever, buildDossier} from '../ophanim/operate/context.mjs';
import {earliestGate, requirementDigest} from '../ophanim/operate/gates.mjs';
import {tick, watch} from '../ophanim/operate/scheduler.mjs';
import {reconcile} from '../ophanim/operate/reconcile.mjs';
import {openWorkLedger, outputsDigest} from '../ophanim/operate/work-ledger.mjs';
import {makeExecutors} from '../ophanim/operate/stages.mjs';
import {withDispatch} from '../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, planFor, json, LIMITS, FIVE} from '../ophanim/operate/test-fixtures.mjs';

test('issue title/state changes alter shown bytes without altering their version', () => {
  const issues = [{number: 1, title: 'old title', state: 'open', body: 'unchanged body'}];
  const r = makeRetriever({repo: process.cwd(), statusRoot: '.', issues});
  const a = r.run({op: 'issue', number: 1});
  issues[0].title = 'new title'; issues[0].state = 'closed';
  const b = r.run({op: 'issue', number: 1});
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.notEqual(a.text, b.text);
  assert.equal(a.version, b.version, 'BUG: changed bytes retain the same version');
});

test('a disqualified review removes downstream reuse and only flags a Resolved item', () => {
  const item = {item: 'target', title: 'requirement', basis: 'required behavior', state: 'Ready', entry: 'entry'};
  const stages = [];
  for (const stage of ['plan', 'implement', 'review', 'validate', 'outcome']) {
    const prev = stages.at(-1);
    stages.push({stage, hash: stage, status: 'passed', identity: {item: item.item, requirement: requirementDigest(item)},
      handoff: {from: prev?.hash ?? null}, inputs: {upstream: prev ? outputsDigest(prev.outputs) : null},
      outputs: stage === 'plan' ? {deps: {}, evidence: []} : stage === 'review' ? {cycle: 'bad-cycle'} : {stage}});
  }
  const args = {item, history: [item], depStatus: () => null, stages, reassessments: [{hash: 'reassessment', cycle: 'bad-cycle', findings: [{why: 'disqualified reviewer'}]}]};
  const active = earliestGate(args);
  assert.equal(active.gate, 'review');
  assert.deepEqual(Object.keys(active.reuse), ['plan', 'implement']);
  const resolved = {...item, state: 'Resolved', evidence: {ticket: 'ticket', commit: 'commit', review: {cycle: 'bad-cycle', close_entry: 'close', outcome: 'verified', reviewers: ['a', 'b', 'c'].map(lab => ({lab}))}}};
  assert.equal(earliestGate({...args, item: resolved}).gate, 'reverification-needed');
  assert.equal(resolved.state, 'Resolved');
});

test('a cited derived relations view changes but its approved plan remains reusable', async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = fixture(repo, [{item: 'target'}]);
    const turn = scriptedTurn({planner: ({prompt}) => json(planFor(prompt, {
      evidence: [{ref: 'status:target#relations', why: 'no downstream work depends on this item'}],
    }))});
    const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir});
    await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    const p = w.stages('target')[0];
    assert.equal(p.status, 'passed');
    const before = buildDossier({repo, statusRoot: f.statusRoot, item: 'target'}).entries.find(e => e.source === 'status:target#relations');
    f.S.set({item: 'consumer', title: 'new consumer', state: 'Ready', basis: 'depends on target', checked: '2026-11-18', depends_on: ['target']});
    const after = buildDossier({repo, statusRoot: f.statusRoot, item: 'target'}).entries.find(e => e.source === 'status:target#relations');
    assert.notEqual(before.version, after.version);
    assert.equal(reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.find(i => i.item === 'target').gate.gate, 'implement', 'BUG: a cited changed view does not stale the plan');
  });
});

test('watch never wakes an evidence-blocked plan when only the missing evidence appears', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-watch-'));
  try {
    const f = fixture(repo, [{item: 'target'}]);
    let calls = 0;
    const plan = async () => {
      calls++;
      const d = buildDossier({repo, statusRoot: f.statusRoot, item: 'target'});
      return {status: 'blocked', outputs: {context: {dossier: {stable: d.stable}}}, team: [], contributions: [], findings: [], usage: {provider_calls: 0},
        blocker: {code: 'EVIDENCE_INSUFFICIENT', what: 'missing notes.md', role: 'lead@orch', resume_when: 'notes appear'}, next: {stage: 'plan', why: 'need evidence'}};
    };
    const state = {last: null};
    const args = {repo, ...f, state, once: true, executors: {plan}, limits: LIMITS};
    assert.equal((await watch(args)).length, 1);
    fs.writeFileSync(path.join(repo, 'notes.md'), 'new evidence');
    const w = openWorkLedger({root: f.workRoot});
    assert.equal(reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items[0].gate.gate, 'plan', 'explicit reconciliation sees the new evidence');
    assert.equal((await watch(args)).length, 0, 'BUG: watch does not reconcile the changed evidence');
    assert.equal(calls, 1);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('diagnose implementation fixture failure without live providers', async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = fixture(repo, [{item: 'target'}]);
    const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, profile: 'argo', ...FIVE});
    await tick({repo, ...f, executors: {plan: ex.plan, implement: ex.implement}, limits: {...LIMITS, iterations: 2}});
    const w = openWorkLedger({root: f.workRoot});
    console.log('IMPLEMENT DIAGNOSTIC', JSON.stringify(w.stages('target').map(s => ({stage: s.stage, status: s.status, outputs: s.stage === 'implement' ? s.outputs : undefined}))));
  });
});
