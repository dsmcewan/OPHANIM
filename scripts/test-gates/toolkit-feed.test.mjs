// The tools' side of feeding Detect (feed.mjs): the flags, the whole-run rule for gates, this repository's files only for
// stress, and the wheels: a lane that fails to load or write is a reported skip, never a throw and never a verdict.
// The lane is injected here, so no cell depends on this checkout's switch or on whether its tree is clean.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {FEED_FLAGS, feedFlag, feedDetect, feedLine, gatePartial, stressFeedable} from './feed.mjs';

test('feed flags: --no-self-repair-records turns feeding off; --self-repair-records takes a directory', () => {
  const o1 = {};
  assert.equal(feedFlag([FEED_FLAGS.off], 0, o1), 0);
  assert.equal(o1.feed, false);
  const o2 = {};
  assert.equal(feedFlag([FEED_FLAGS.dir, 'rec'], 0, o2), 1);
  assert.equal(o2.feed, path.resolve('rec'));
  assert.throws(() => feedFlag([FEED_FLAGS.dir], 0, {}), /takes a directory/);
  assert.throws(() => feedFlag([FEED_FLAGS.dir, '--json'], 0, {}), /takes a directory/);
  assert.equal(feedFlag(['--json'], 0, {}), -1);
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
