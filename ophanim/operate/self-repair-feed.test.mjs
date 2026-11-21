// FEEDING DETECT (owner, 2026-11-20: "wire the gate and stress records into Detect"). The gates and the stress tool
// hand their records to feedRecord, which writes them, with the commit they ran on, into the lane's records directory:
// only while the owner-signed switch is on (or into a directory given explicitly), and only for a clean working tree.
// Fixture repositories with fresh synthetic owner keys; no provider, no real ledger.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {feedRecord, laneRecordsDir, readRecords, detect, DEFAULT_CONFIG} from './self-repair.mjs';
import {laneRepo} from './fixtures/self-repair-fixture.mjs';

const GATE = {schema: 'ophanim.test-gate/v2', verdict: 'FAIL', results: [{suite: 'test', verdict: 'FAIL', problems: [],
  notes: ['fail: add adds its arguments at test/calc.test.mjs:4 -- testCodeFailure: Expected values to be strictly equal']}]};
const STRESS = {schema: 'ophanim.toolkit.stress/v1', verdict: 'FAIL', repeat: 5, files: ['test/calc.test.mjs'],
  byTest: [{file: 'test/calc.test.mjs', name: 'add adds its arguments', rounds: [2, 4], pattern: 'intermittent'}]};
const filesUnder = d => (fs.existsSync(d) ? fs.readdirSync(d, {recursive: true}).filter(f => f.endsWith('.json')) : []);

test('feed: with the lane ON and a clean tree, a gate record lands where the lane reads, names HEAD, and its regression leads Detect', t => {
  const f = laneRepo(t);
  assert.equal(laneRecordsDir({repo: f.repo, env: {}}), f.records, 'the feeder and the lane\'s CLI agree on the records directory');
  const r = feedRecord({repo: f.repo, kind: 'gate', record: GATE, env: {}});
  assert.ok(r.written, `written: ${JSON.stringify(r)}`);
  assert.equal(r.commit, f.base);
  assert.ok(r.written.startsWith(f.records + path.sep));
  const records = readRecords(f.records);
  assert.deepEqual([records.gate.length, records.gate[0].commit, records.unreadable.length], [1, f.base, 0]);
  const d = detect({repo: f.repo, commit: f.base, records});
  assert.equal(d.defects[0].kind, 'regression', 'the fed regression ranks above the register entries');
  assert.deepEqual(d.defects[0].site, ['test/calc.test.mjs']);
  assert.ok(d.defects.some(x => x.kind === 'register'), 'the register entries are still there, behind it');
});

test('feed: a fed stress record with an intermittent failure is a measured flake, ranked above the register', t => {
  const f = laneRepo(t);
  assert.ok(feedRecord({repo: f.repo, kind: 'stress', record: STRESS, env: {}}).written);
  const d = detect({repo: f.repo, commit: f.base, records: readRecords(f.records)});
  assert.equal(d.defects[0].kind, 'flake');
  assert.deepEqual(d.defects[0].evidence.failure_rate, {failed: 2, rounds: 5});
});

test('feed: with the lane OFF nothing is written, and the reason is the switch', t => {
  for (const lane of [null, 'Ready']) {
    const f = laneRepo(t, {lane});
    const r = feedRecord({repo: f.repo, kind: 'gate', record: GATE, env: {}});
    assert.match(r.skipped ?? '', /dormant/, JSON.stringify(r));
    assert.deepEqual(filesUnder(f.records), []);
  }
});

test('feed: a working tree that is not its commit (a change, or an untracked file) is never fed: its results are not that commit\'s', t => {
  for (const dirty of [repo => fs.appendFileSync(path.join(repo, 'lib/calc.mjs'), '// local change\n'), repo => fs.writeFileSync(path.join(repo, 'lib/new.mjs'), 'export {};\n')]) {
    const f = laneRepo(t);
    dirty(f.repo);
    const r = feedRecord({repo: f.repo, kind: 'stress', record: STRESS, env: {}});
    assert.match(r.skipped ?? '', /working tree differs from/, JSON.stringify(r));
    assert.deepEqual(filesUnder(f.records), []);
  }
});

test('feed: a directory given explicitly is fed whatever the switch, still only for a clean tree; an unknown kind is refused', t => {
  const f = laneRepo(t, {lane: null});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-repair-feed-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const r = feedRecord({repo: f.repo, kind: 'gate', record: GATE, env: {}, dir});
  assert.ok(r.written?.startsWith(dir + path.sep), JSON.stringify(r));
  assert.equal(readRecords(dir).gate[0].commit, f.base);
  assert.throws(() => feedRecord({repo: f.repo, kind: 'lint', record: {}, env: {}, dir}), /a record is one of/);
});

test('feed: Verify\'s own stress run does not feed Detect (its result is evidence for the round, not a record)', () => {
  assert.ok(DEFAULT_CONFIG.commands.stress.includes('--no-self-repair-records'));
});
