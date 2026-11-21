// The execution service (service.mjs): its config, its single-instance lock, the loop's status and log, the
// lifetime provider-call cap, and the NO_AUTHORITY stop. Executors are scripted; nothing calls a provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {readServiceConfig, acquireLock, runService, SERVICE_CONFIG_SCHEMA} from './service.mjs';

function setup(items, limits = {total_provider_calls: 100, stage_provider_calls: 2}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'service-'));
  const S = openStatusLedger({root: path.join(repo, 'status', 'ledger')});
  for (const i of items) S.set({checked: '2026-11-17', basis: `the requirement of ${i}`, item: i, title: i, state: 'Ready'});
  fs.mkdirSync(path.join(repo, 'tickets'));
  openWorkLedger({root: path.join(repo, 'status', 'work')});
  const file = path.join(repo, 'operate.json');
  fs.writeFileSync(file, JSON.stringify({schema: SERVICE_CONFIG_SCHEMA, repo: '.', issues: {source: 'none'}, interval_s: 10, limits}));
  return {repo, file, done: () => fs.rmSync(repo, {recursive: true, force: true})};
}
// Scripted executors: every stage passes for 2 provider calls (the ticket is not needed by these executors).
const calls = [];
const pass = stage => async ctx => { calls.push(`${ctx.item}:${stage}`); return {status: 'passed', outputs: {[stage]: true, n: calls.length}, team: [], contributions: [], findings: [], usage: {provider_calls: 2}, next: {stage: null, why: 'ok'}}; };
const executors = Object.fromEntries(['plan', 'implement', 'review', 'validate', 'outcome'].map(s => [s, pass(s)]));
const noSleep = async () => {};

test('the service config is validated: a declared provider-call cap, known keys only, a sane interval', () => {
  const s = setup([]);
  try {
    const write = c => { fs.writeFileSync(s.file, JSON.stringify({schema: SERVICE_CONFIG_SCHEMA, interval_s: 60, limits: {total_provider_calls: 5}, ...c})); return () => readServiceConfig(s.file); };
    assert.equal(write({})().limits.total_provider_calls, 5);
    assert.throws(write({limits: {stage_provider_calls: 5}}), /total_provider_calls must be declared/);
    assert.throws(write({extra: 1}), /unknown service config key/);
    assert.throws(write({interval_s: 1}), /at least 10/);
    assert.throws(write({limits: {total_provider_calls: 5, turbo: 1}}), /unknown limit/);
    assert.throws(write({issues: {source: 'github'}}), /owner\/name/);
  } finally { s.done(); }
});

test('one service per work ledger: a live holder is refused, a dead one\'s lock is taken over and recorded, another host is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
  const file = path.join(dir, 'service.lock');
  try {
    const a = acquireLock(file);
    assert.throws(() => acquireLock(file), e => e.code === 'SERVICE_RUNNING');
    a.release();
    fs.writeFileSync(file, JSON.stringify({pid: 2 ** 22 + 7, host: os.hostname(), started: '2026-11-17T00:00:00Z'}));
    const b = acquireLock(file);
    assert.match(b.takeover.why, /not running: its lock is stale/);
    b.release();
    fs.writeFileSync(file, JSON.stringify({pid: process.pid, host: 'another-machine', started: '2026-11-17T00:00:00Z'}));
    assert.throws(() => acquireLock(file), /served from another-machine/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('the service runs ticks until stopped, writes its status and log, ticks only on change, and never exceeds its lifetime cap', async () => {
  const s = setup(['a', 'b'], {total_provider_calls: 6, stage_provider_calls: 2});
  try {
    const config = readServiceConfig(s.file);
    calls.length = 0;
    const r = await runService({config, executors, maxTicks: 3, sleep: noSleep});
    assert.equal(r.code, 0);
    assert.equal(r.stopped, 'max-ticks');
    // 6 calls at 2 per stage: three stages in all, however many ticks ran.
    assert.equal(calls.length, 3);
    const status = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'service-status.json'), 'utf8'));
    assert.equal(status.state, 'stopped');
    const log = fs.readFileSync(path.join(config.stateDir, 'service.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual([log[0].event, log.at(-1).event], ['started', 'stopped']);
    assert.ok(log.filter(e => e.event === 'tick').length >= 1);
    // A restart: the cap is the work ledger's lifetime total, so nothing more is dispatched.
    const again = await runService({config, executors, maxTicks: 2, sleep: noSleep});
    assert.equal(again.code, 0);
    assert.equal(calls.length, 3, 'the cap holds across restarts');
    const st = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'service-status.json'), 'utf8'));
    assert.equal(st.state, 'stopped');
    assert.equal(fs.existsSync(path.join(config.workRoot, 'service.lock')), false, 'the lock is released on stop');
  } finally { s.done(); }
});

test('a second service on the same ledger is refused while the first runs; a signal stops the loop between ticks', async () => {
  const s = setup(['a']);
  try {
    const config = readServiceConfig(s.file);
    const ac = new AbortController();
    let second = null;
    const slow = async (ms, sig) => {
      second ??= await runService({config, executors, maxTicks: 1, sleep: noSleep});
      ac.abort();
    };
    const first = await runService({config, executors, signal: ac.signal, sleep: slow});
    assert.equal(second.code, 1);
    assert.match(second.refused, /already running/);
    assert.equal(first.code, 0);
    assert.equal(first.stopped, 'signal');
  } finally { s.done(); }
});

test('without the controller key the service stops with NO_AUTHORITY and records nothing', async () => {
  const s = setup(['a']);
  try {
    const config = readServiceConfig(s.file);
    fs.rmSync(path.join(config.workRoot, 'keys'), {recursive: true, force: true});
    const before = openWorkLedger({root: config.workRoot}).verify().entries;
    const r = await runService({config, maxTicks: 3, sleep: noSleep});
    assert.equal(r.code, 3);
    assert.equal(r.blocked.blocked, 'NO_AUTHORITY');
    assert.equal(openWorkLedger({root: config.workRoot}).verify().entries, before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(config.stateDir, 'service-status.json'), 'utf8')).state, 'blocked');
  } finally { s.done(); }
});
