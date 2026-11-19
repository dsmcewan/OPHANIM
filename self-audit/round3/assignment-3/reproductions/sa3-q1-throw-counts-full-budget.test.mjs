// SELF-AUDIT A3 Q1/Q2 (af0dc30). PASSING = DEFECT PRESENT.
// An executor that THROWS having charged nothing is recorded with usage.provider_calls = null (scheduler.mjs:243,
// `e.provider_calls ?? (charged || null)`), and spent() counts a null usage at the claim's FULL stage budget
// (scheduler.mjs:62). The scheduler knows the exact charge (every call is charged on the work ledger before it is made:
// here 0), yet one zero-call exception consumes stage_provider_calls of the declared total, and the next stage is
// refused with a "provider-call budget" stop although no provider was ever called. Not "charged exactly once".
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStatusLedger} from '../packages/ledger/status.mjs';
import {tick} from '../ophanim/operate/scheduler.mjs';

test('Q1: a zero-call exception is counted at the full stage budget and stops the run on budget', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sa3-throw-'));
  try {
    const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
    openStatusLedger({root: statusRoot}).set({checked: '2026-11-17', basis: 'the requirement of alpha', item: 'alpha', title: 'Alpha', state: 'Ready'});
    fs.mkdirSync(path.join(repo, 'tickets'));
    let calls = 0;
    const executors = {plan: async () => { throw new Error('a git read failed before any provider call'); }};
    const limits = {total_provider_calls: 15, stage_provider_calls: 10, stage_attempts: 3};
    const t1 = await tick({repo, statusRoot, workRoot, executors, limits});
    assert.equal(t1.dispatched.length, 1);
    assert.equal(t1.dispatched[0].status, 'failed');
    assert.equal(calls, 0, 'no provider call was made');
    assert.equal(t1.spent.charged, 0, 'nothing was charged on the work ledger');
    assert.equal(t1.spent.calls, 10, 'yet the spend counted is the whole stage budget');
    // The retry of the same stage (attempt 2 of 3) is refused on budget: 15 - 10 < 10.
    const t2 = await tick({repo, statusRoot, workRoot, executors: {plan: async () => { calls++; return {status: 'passed'}; }}, limits});
    assert.equal(t2.dispatched.length, 0);
    assert.match(t2.stopped ?? '', /provider-call budget: 5 left of 15/);
    assert.equal(calls, 0);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});
