// Regression tests for independent review round 2, assignment 1 (Lifecycle and evidence), OpenAI gpt-6.1-sol at
// 77480d6 (docs/reviews/2026-11-18-independent-review/findings-1-openai-77480d6/findings-1-openai.md). Each test
// failed at 8e6d5e0.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {makeRetriever, buildDossier} from './context.mjs';
import {planValidity, requirementDigest} from './gates.mjs';
import {tick, watch, inputSignature} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {makeExecutors} from './stages.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, planFor, json, LIMITS} from './test-fixtures.mjs';

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Question 5: the issue view delivers its title and state, so its version must cover them.
test('an issue view is versioned over the exact bytes delivered: a title or state change is a new version (round 2, assignment 1, OpenAI gpt-6.1-sol, 77480d6, question 5)', () => {
  const issues = [{number: 1, title: 'old title', state: 'open', body: 'unchanged body'}];
  const r = makeRetriever({repo: process.cwd(), statusRoot: '.', issues});
  const a = r.run({op: 'issue', number: 1});
  issues[0].title = 'new title';
  const b = r.run({op: 'issue', number: 1});
  issues[0].state = 'closed';
  const c = r.run({op: 'issue', number: 1});
  assert.ok(a.ok && b.ok && c.ok);
  assert.notEqual(a.version, b.version, 'a changed title is a changed view');
  assert.notEqual(b.version, c.version, 'a changed state is a changed view');
  assert.equal(r.versionOf({op: 'issue', number: 1}), c.version, 'versionOf agrees with what is delivered');
});

// Questions 1 and 5: an undefined current version of a cited non-file view is not "unchanged".
test('a cited view whose current version cannot be established makes the plan stale; a work-ledger view is not judged (round 2, assignment 1, OpenAI gpt-6.1-sol, 77480d6, questions 1 and 5)', () => {
  const requirement = {item: 'x', title: 't', basis: 'b'};
  const plan = {hash: 'p', identity: {item: 'x', requirement: requirementDigest(requirement)},
    outputs: {deps: {}, evidence: [{ref: 'S3', source: 'status:x#relations', version: 'sha256:aa', request: {op: 'dossier', source: 'status:x#relations'}}]}};
  const args = {requirement, deps: {}, ticket: null};
  assert.equal(planValidity(plan, {...args, versionOf: () => 'sha256:aa'}).valid, true);
  const unknown = planValidity(plan, {...args, versionOf: () => undefined});
  assert.equal(unknown.valid, false);
  assert.match(unknown.why.join(';'), /cannot be re-read/);
  assert.equal(planValidity(plan, args).valid, false, 'no re-reader at all is not a pass');
  assert.equal(planValidity(plan, {...args, versionOf: () => null}).valid, false, 'a view that is gone');
  const work = {...plan, outputs: {deps: {}, evidence: [{ref: 'S2', source: 'work:x#records', version: 'h', request: {op: 'work', item: 'x'}}]}};
  assert.equal(planValidity(work, {...args, versionOf: () => undefined}).valid, true, 'recording an attempt is not new evidence');
});

// Questions 1 and 5: a derived dossier view the plan cites is re-derived on reuse.
test('a plan citing a derived relations view is reused while the view is unchanged and is stale once its bytes change (round 2, assignment 1, OpenAI gpt-6.1-sol, 77480d6, questions 1 and 5)', async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = fixture(repo, [{item: 'target'}]);
    const turn = scriptedTurn({planner: ({prompt}) => json(planFor(prompt, {evidence: [{ref: 'status:target#relations', why: 'no downstream work depends on this item'}]}))});
    const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir});
    await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    const p = w.stages('target')[0];
    assert.equal(p.status, 'passed');
    assert.ok(p.outputs.evidence.some(e => e.request?.op === 'dossier' && e.source === 'status:target#relations'), 'the plan cites the derived view');
    const gateOf = () => reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.find(i => i.item === 'target').gate;
    assert.equal(gateOf().gate, 'implement', 'an unchanged derived view keeps the plan reusable');
    const before = buildDossier({repo, statusRoot: f.statusRoot, item: 'target'}).entries.find(e => e.source === 'status:target#relations');
    f.S.set({item: 'consumer', title: 'new consumer', state: 'Ready', basis: 'depends on target', checked: '2026-11-18', depends_on: ['target']});
    const after = buildDossier({repo, statusRoot: f.statusRoot, item: 'target'}).entries.find(e => e.source === 'status:target#relations');
    assert.notEqual(before.version, after.version);
    const g = gateOf();
    assert.equal(g.gate, 'plan', 'a cited derived view that changed stales the plan');
    assert.match(JSON.stringify(g.stale), /status:target#relations changed/);
  });
});

// Question 5: watch wakes a plan blocked on missing evidence when that evidence appears.
test('watch wakes an evidence-blocked plan when only the missing evidence appears, and not before (round 2, assignment 1, OpenAI gpt-6.1-sol, 77480d6, question 5)', async () => {
  const repo = tmp('r2a1-watch-');
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
    assert.equal((await watch(args)).length, 0, 'nothing changed: no tick');
    fs.writeFileSync(path.join(repo, 'notes.md'), 'new evidence');
    assert.equal((await watch(args)).length, 1, 'the missing evidence appeared: a tick runs');
    assert.equal(calls, 2);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// Question 5: the recovery sources of an item with an evidence gap are part of the signature.
test('the watch signature changes when a retained run of an item with an evidence gap appears (round 2, assignment 1, OpenAI gpt-6.1-sol, 77480d6, question 5)', () => {
  const repo = tmp('r2a1-recovery-');
  try {
    const f = fixture(repo, [{item: 'done', state: 'Resolved', basis: 'resolved without evidence'}]);
    openWorkLedger({root: f.workRoot});
    const bundlesDir = path.join(repo, 'retained');
    fs.mkdirSync(bundlesDir);
    const sig = () => inputSignature({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, bundlesDir});
    const w = openWorkLedger({root: f.workRoot});
    assert.equal(reconcile({repo, statusRoot: f.statusRoot, workLedger: w, bundlesDir}).items[0].gate.gate, 'evidence-gap');
    const a = sig();
    assert.equal(sig(), a, 'stable while nothing changes');
    fs.mkdirSync(path.join(bundlesDir, 'run-1'));
    fs.writeFileSync(path.join(bundlesDir, 'run-1', 'evidence.json'), JSON.stringify({item: 'done'}));
    assert.notEqual(sig(), a, 'a new retained run of the item is a new input');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});
