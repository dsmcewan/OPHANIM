// T2 affected-runners' own tests (scripts/test-gates/affected-runners.mjs; TOOLKIT.md), on a synthetic repository with
// two runners and known commits: a changed DECIDING test lists its runner (the lessons class
// runner-deciding-tests-changed-not-rerun), an unrelated change lists none, and --run propagates a runner's failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {affected} from './affected-runners.mjs';
import {tempRepo, runnerText} from './fixtures/toolkit-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'affected-runners.mjs');
const REPO = {
  'lib/a.mjs': 'export const a = 1;\n', 'lib/b.mjs': 'export const b = 1;\n',
  'tests/a.test.mjs': "import {a} from '../lib/a.mjs';\n", 'tests/b.test.mjs': "import {b} from '../lib/b.mjs';\n",
  'tests/a.mutate.mjs': runnerText({id: 'A1', target: 'lib/a.mjs', test: 'tests/a.test.mjs'}),
  'tests/b.mutate.mjs': runnerText({id: 'B1', target: 'lib/b.mjs', test: 'tests/b.test.mjs'}),
  'README.md': 'a synthetic repository\n',
};
const listed = a => a.runners.map(r => [r.file, r.reasons.map(x => x.kind)]);
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));

test('affected runners: a changed DECIDING test lists its runner; a changed target lists its runner', t => {
  const repo = tempRepo(t, REPO);
  const decides = repo.commit({'tests/a.test.mjs': "import {a} from '../lib/a.mjs';\n// a new case\n"});
  assert.deepEqual(listed(affected({root: repo.dir, base: repo.base, head: decides})), [['tests/a.mutate.mjs', ['decides']]],
    'only the deciding test changed: its runner is listed, the other is not');
  const target = repo.commit({'lib/b.mjs': 'export const b = 2;\n'});
  assert.deepEqual(listed(affected({root: repo.dir, base: decides, head: target})), [['tests/b.mutate.mjs', ['target']]]);
  assert.deepEqual(listed(affected({root: repo.dir, base: repo.base, head: target})), [['tests/a.mutate.mjs', ['decides']], ['tests/b.mutate.mjs', ['target']]]);
});

test('affected runners: an unrelated change lists none; a runner whose own file changed is always listed', t => {
  const repo = tempRepo(t, REPO);
  const doc = repo.commit({'README.md': 'changed\n', 'lib/c.mjs': 'export const c = 1;\n'});
  const a = affected({root: repo.dir, base: repo.base, head: doc});
  assert.equal(a.changed, 2);
  assert.deepEqual(a.runners, [], 'no runner edits or is decided by the changed files');
  const own = repo.commit({'tests/b.mutate.mjs': runnerText({id: 'B1', target: 'lib/b.mjs', test: 'tests/b.test.mjs'}) + '// a comment\n'});
  assert.deepEqual(listed(affected({root: repo.dir, base: doc, head: own})), [['tests/b.mutate.mjs', ['own']]]);
  const gone = repo.commit({'tests/b.mutate.mjs': null});
  assert.deepEqual(affected({root: repo.dir, base: own, head: gone}).removed, ['tests/b.mutate.mjs'], 'a deleted runner is reported as removed');
});

test('affected runners: a runner whose table cannot be read is listed, never cleared', t => {
  const repo = tempRepo(t, REPO);
  const head = repo.commit({'tests/odd.mutate.mjs': "const TABLE = [{id: 'X1'}];\nprocess.exit(0);\n", 'README.md': 'changed\n'});
  const a = affected({root: repo.dir, base: head, head});
  assert.deepEqual(listed(a), [['tests/odd.mutate.mjs', ['unread']]], 'even with no change between the commits');
  assert.match(a.runners[0].reasons[0].note, /no MUTATIONS table read/);
});

test('affected runners: --run propagates a failing runner and passes --copy-root and --log through', t => {
  const repo = tempRepo(t, REPO);
  const head = repo.commit({'tests/a.test.mjs': '// changed\n', 'tests/b.test.mjs': '// changed\n'});
  const record = path.join(repo.dir, '.record'), copies = path.join(repo.dir, '.copies'), logs = path.join(repo.dir, '.logs');
  fs.mkdirSync(record);
  const run = env => spawnSync(process.execPath, [TOOL, repo.base, head, '--root', repo.dir, '--run', '--copy-root', copies, '--log', logs],
    {encoding: 'utf8', env: {...CLEAN_ENV, TOOLKIT_RUNNER_RECORD: record, ...env}});
  const bad = run({TOOLKIT_RUNNER_EXIT_B1: '3'});
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /< tests\/a\.mutate\.mjs: exit 0/);
  assert.match(bad.stdout, /< tests\/b\.mutate\.mjs: exit 3/);
  assert.match(bad.stdout, /2 run, 1 exited 0, 1 did not: tests\/b\.mutate\.mjs \(exit 3\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(record, 'A1.json'), 'utf8')), ['--copy-root', copies, '--log', path.join(logs, 'tests_a.mutate.mjs')],
    'each runner gets the copy root and its own log directory');
  const good = run({});
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /2 run, 2 exited 0, 0 did not/);
});

test('affected runners: --run refuses a checkout whose HEAD is not <head>; a list needs no checkout', t => {
  const repo = tempRepo(t, REPO);
  const one = repo.commit({'tests/a.test.mjs': '// changed\n'});
  repo.commit({'README.md': 'later\n'});
  const r = spawnSync(process.execPath, [TOOL, repo.base, one, '--root', repo.dir, '--run'], {encoding: 'utf8', env: CLEAN_ENV});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the runners would test another tree/);
  const list = spawnSync(process.execPath, [TOOL, repo.base, one, '--root', repo.dir, '--json'], {encoding: 'utf8', env: CLEAN_ENV});
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout).runners.map(x => x.file), ['tests/a.mutate.mjs']);
});
