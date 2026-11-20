// The tools' side of feeding Detect (feed.mjs): the flags, the whole-run rule for gates, this repository's files only for
// stress, and the wheels: a lane that fails to load or write is a reported skip, never a throw and never a verdict.
// The lane is injected here, so no cell depends on this checkout's switch or on whether its tree is clean.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {feedDetect, feedLine, gatePartial, stressFeedable} from './feed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('feed flags: the gate and the stress tool parse --self-repair-records DIR and --no-self-repair-records themselves', () => {
  for (const [tool, args] of [['check.mjs', ['logs']], ['stress.mjs', ['--files', path.join(HERE, 'toolkit-feed.test.mjs')]]]) {
    const bare = spawnSync(process.execPath, [path.join(HERE, tool), ...args, '--self-repair-records'], {encoding: 'utf8', timeout: 60_000});
    assert.notEqual(bare.status, 0, `${tool}: a missing directory is refused`);
    assert.match(bare.stderr, /--self-repair-records takes a directory/, tool);
    const next = spawnSync(process.execPath, [path.join(HERE, tool), ...args, '--self-repair-records', '--no-self-repair-records'], {encoding: 'utf8', timeout: 60_000});
    assert.match(next.stderr, /--self-repair-records takes a directory/, `${tool}: a flag is not taken as the directory`);
  }
});

test('feed: the lane is called with the kind, the record and the directory; off means it is not called at all', async () => {
  const calls = [];
  const load = async () => ({feedRecord: a => { calls.push(a); return {written: '/r/x.json', commit: 'a'.repeat(40)}; }});
  assert.ok((await feedDetect({kind: 'gate', record: {v: 1}, load, repo: '/repo', env: {}})).written);
  assert.ok((await feedDetect({kind: 'stress', record: {v: 2}, feed: '/dir', load, repo: '/repo', env: {}})).written);
  assert.deepEqual(calls.map(c => [c.kind, c.record.v, c.dir, c.repo]), [['gate', 1, null, '/repo'], ['stress', 2, '/dir', '/repo']]);
  const off = await feedDetect({kind: 'gate', record: {}, feed: false, load: async () => { throw new Error('must not load'); }});
  assert.match(off.skipped, /--no-self-repair-records/);
});

test('feed: a lane that fails to load, or throws while writing, is a reported skip and never a throw (the gate\'s verdict stands)', async () => {
  const broken = await feedDetect({kind: 'gate', record: {}, load: async () => { throw new SyntaxError('Unexpected token in self-repair.mjs'); }});
  assert.match(broken.skipped, /could not be loaded or written .*verdict is unaffected/);
  const throws = await feedDetect({kind: 'gate', record: {}, load: async () => ({feedRecord: () => { throw new Error('disk full'); }})});
  assert.match(throws.skipped, /disk full/);
  assert.match(feedLine(broken), /^self-repair: no record for Detect \(/);
  assert.match(feedLine({written: path.join(process.cwd(), 'r.json'), commit: 'b'.repeat(40)}), /^self-repair: record for Detect written to r\.json \(commit b{12}\)$/);
});

test('feed: only a WHOLE gate run feeds Detect (it reads the latest gate record as the whole picture)', () => {
  assert.equal(gatePartial('run', {only: 'real-bwrap', suites: []}), true);
  assert.equal(gatePartial('run', {only: null, suites: ['test:proof']}), true);
  assert.equal(gatePartial('run', {only: null, suites: []}), false);
  assert.equal(gatePartial('logs', {only: null, suites: []}), false);
});

test('feed: a stress record keeps this repository\'s files only; a run of files outside it is not fed', () => {
  const rec = {verdict: 'FAIL', repeat: 3, files: ['../tmp/x.test.mjs', '/abs/y.test.mjs', 'pantheon/tests/a.test.mjs'],
    byTest: [{file: '../tmp/x.test.mjs', name: 'n'}, {file: 'pantheon/tests/a.test.mjs', name: 'm', rounds: [2], pattern: 'intermittent'}]};
  const fed = stressFeedable(rec);
  assert.deepEqual(fed.files, ['pantheon/tests/a.test.mjs']);
  assert.deepEqual(fed.byTest.map(t => t.file), ['pantheon/tests/a.test.mjs']);
  assert.equal(fed.repeat, 3);
  assert.equal(stressFeedable({files: ['../tmp/x.test.mjs'], byTest: []}), null);
  assert.equal(stressFeedable({}), null);
});
