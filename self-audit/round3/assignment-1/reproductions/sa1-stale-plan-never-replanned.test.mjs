// SELF-AUDIT repro (assignment 1, Q1/Q5). PASSING = DEFECT PRESENT.
// When a file the approved plan cites changes, the gate correctly routes the item to `plan`. But the scheduler's
// claim for that plan has inputs {upstream: null, requirement} -- the same as the passed plan's -- so the work
// ledger's idempotency rule refuses it ("already completed for these exact inputs"). The stale evidence is never
// searched again; the item is skipped on every tick. The same holds for a changed ticket and a changed dependency.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tick} from '../ophanim/operate/scheduler.mjs';
import {reconcile} from '../ophanim/operate/reconcile.mjs';
import {openWorkLedger} from '../ophanim/operate/work-ledger.mjs';
import {makeExecutors} from '../ophanim/operate/stages.mjs';
import {withDispatch} from '../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, git, LIMITS} from '../ophanim/operate/test-fixtures.mjs';

for (const [label, change] of [
  ['a cited evidence file changes', (repo) => { fs.writeFileSync(path.join(repo, 'verify.mjs'), fs.readFileSync(path.join(repo, 'verify.mjs'), 'utf8') + '// changed\n'); git(repo, 'commit', '-qam', 'change verify'); }],
  ['the approved ticket is edited', (repo) => { const f = path.join(repo, 'tickets', 'target.json'); const t = JSON.parse(fs.readFileSync(f, 'utf8')); t.goal += ' (edited)'; fs.writeFileSync(f, JSON.stringify(t, null, 2) + '\n'); }],
]) {
  test(`DEFECT: ${label}; the gate says plan, but no re-plan is ever dispatched`, async () => {
    await withDispatch(async ctx => {
      const repo = ctx.dir;
      const f = fixture(repo, [{item: 'target'}]);
      const turn = scriptedTurn();
      const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir});
      const r1 = await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
      assert.deepEqual(r1.dispatched.map(d => `${d.stage}:${d.status}`), ['plan:passed']);
      change(repo);
      const w = openWorkLedger({root: f.workRoot});
      const g = reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.find(i => i.item === 'target').gate;
      assert.equal(g.gate, 'plan', 'the gate sees the stale plan (correct)');
      for (let i = 0; i < 2; i++) {
        const r = await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS});
        assert.deepEqual(r.dispatched, [], 'DEFECT: the re-plan is never dispatched');
        assert.match(JSON.stringify(r.skipped), /already completed for these exact inputs/);
      }
      assert.equal(turn.log.filter(l => l.kind === 'planner').length, 1, 'only the first plan was ever made');
    });
  });
}
