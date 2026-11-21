// T1 reach's own tests (scripts/test-gates/reach.mjs; TOOLKIT.md), on synthetic repositories with known answers: what
// imports a module is found by RESOLVING each specifier (a dynamic import included), never by a name that resembles it;
// runners are read as text; withheld paths are never listed or read; what cannot be read is reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {snapshot, reach, expandModules, TRANSITIVE_BOUND} from './reach.mjs';
import {tempRepo, runnerText} from './fixtures/toolkit-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REACH = path.join(HERE, 'reach.mjs');
const files = r => r.tests.map(t => t.file).sort();

const REPO = {
  'lib/target.mjs': 'export const x = 1;\n',
  'lib/target-extra.mjs': 'export const y = 2;\n',
  'other/target.mjs': 'export const z = 3;\n',
  'lib/mid.mjs': "export {x} from './target.mjs';\n",
  'lib/top.mjs': "import {x} from './mid.mjs';\nexport const t = x;\n",
  'tests/static.test.mjs': "import test from 'node:test';\nimport {x} from '../lib/target.mjs';\ntest('s', () => {});\n",
  'tests/dynamic.test.mjs': "import test from 'node:test';\ntest('d', async () => { const m = await import('../lib/target.mjs'); });\n",
  'tests/template.test.mjs': "test('t', async () => { await import(`../lib/target.mjs?fresh=${Date.now()}`); });\n",
  'tests/similar.test.mjs': "import {y} from '../lib/target-extra.mjs';\nimport {z} from '../other/target.mjs';\n// the text 'lib/target.mjs' in a comment is not an import\n",
  'tests/mid.test.mjs': "import {x} from '../lib/mid.mjs';\n",
  'tests/top.test.mjs': "import {t} from '../lib/top.mjs';\n",
  'tests/opaque.test.mjs': "const name = '../lib/target.mjs';\ntest('o', async () => { await import(name); });\n",
  'tools/edits.mutate.mjs': runnerText({id: 'E1', target: 'lib/target.mjs', test: 'tests/unrelated.test.mjs'}),
  'tools/decided.mutate.mjs': runnerText({id: 'D1', target: 'lib/unrelated.mjs', test: 'tests/static.test.mjs'}),
  'tools/other.mutate.mjs': runnerText({id: 'O1', target: 'lib/unrelated.mjs', test: 'tests/unrelated.test.mjs'}),
  'tests/unrelated.test.mjs': "import test from 'node:test';\ntest('u', () => {});\n",
  'lib/unrelated.mjs': 'export const u = 0;\n',
  'review/findings-round1/evil.test.mjs': "import {x} from '../../lib/target.mjs';\n",
  'findings-top.test.mjs': "import {x} from './lib/target.mjs';\n",
};

test('reach: a static and a DYNAMIC import are found; a similarly named module and a same-named file elsewhere are not', t => {
  const {dir} = tempRepo(t, REPO);
  const r = reach(snapshot({root: dir}), ['lib/target.mjs']);
  assert.deepEqual(files(r), ['tests/dynamic.test.mjs', 'tests/static.test.mjs', 'tests/template.test.mjs'],
    'the static import, the dynamic import and the template-literal import resolve to the module; nothing else does');
  assert.ok(!files(r).includes('tests/similar.test.mjs'), 'lib/target-extra.mjs and other/target.mjs are other modules; a comment naming the path is not an import');
  assert.deepEqual(r.tests.find(x => x.file === 'tests/dynamic.test.mjs').modules, ['lib/target.mjs']);
  // The similarly named module has its own importer, and only it.
  assert.deepEqual(files(reach(snapshot({root: dir}), ['lib/target-extra.mjs'])), ['tests/similar.test.mjs']);
  assert.deepEqual(files(reach(snapshot({root: dir}), ['other/target.mjs'])), ['tests/similar.test.mjs']);
});

test('reach: --transitive follows importers of importers to the stated bound, and says when the bound cut it short', t => {
  const {dir} = tempRepo(t, REPO);
  const snap = snapshot({root: dir});
  const direct = reach(snap, ['lib/target.mjs']);
  assert.ok(!files(direct).includes('tests/mid.test.mjs'), 'direct mode lists direct importers only');
  assert.equal(direct.truncated, true, 'importers remain past level 1 (lib/mid.mjs is imported)');
  const two = reach(snap, ['lib/target.mjs'], {depth: 2});
  assert.deepEqual(two.tests.find(x => x.file === 'tests/mid.test.mjs').via, ['tests/mid.test.mjs', 'lib/mid.mjs', 'lib/target.mjs']);
  assert.ok(!files(two).includes('tests/top.test.mjs'), 'level 3 is past a bound of 2');
  assert.equal(two.truncated, true);
  const all = reach(snap, ['lib/target.mjs'], {depth: TRANSITIVE_BOUND});
  assert.equal(all.tests.find(x => x.file === 'tests/top.test.mjs').level, 3);
  assert.equal(all.truncated, false, 'nothing is left to follow');
});

test('reach: a runner is reached by import, by its mutation table\'s target, or through a deciding test -- read as text, never run', t => {
  const {dir} = tempRepo(t, REPO);
  const record = path.join(dir, 'ran');
  fs.mkdirSync(record);
  process.env.TOOLKIT_RUNNER_RECORD = record;           // a runner that ran would write here
  t.after(() => { delete process.env.TOOLKIT_RUNNER_RECORD; });
  const r = reach(snapshot({root: dir}), ['lib/target.mjs']);
  const by = Object.fromEntries(r.runners.map(x => [x.file, x.basis]));
  assert.deepEqual(by, {'tools/decided.mutate.mjs': ['decides'], 'tools/edits.mutate.mjs': ['target']}, 'the unrelated runner is not listed');
  assert.deepEqual(r.runners.find(x => x.file === 'tools/decided.mutate.mjs').decides, ['tests/static.test.mjs']);
  assert.deepEqual(fs.readdirSync(record), [], 'no runner was executed');
  assert.deepEqual(r.unread, [], 'every synthetic runner\'s table is read');
});

test('reach: withheld paths are never listed or read; an opaque dynamic import is reported, not dropped', t => {
  const {dir} = tempRepo(t, REPO);
  const reads = [], real = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => { reads.push(String(p)); return real(p, ...rest); };
  let snap;
  try { snap = snapshot({root: dir}); } finally { fs.readFileSync = real; }
  assert.ok(reads.length > 5, 'the working tree was read through fs.readFileSync');
  assert.deepEqual(reads.filter(p => /findings-/.test(p)), [], 'no withheld path was read');
  assert.deepEqual(snap.paths.filter(p => /findings-/.test(p)), [], 'no withheld path was listed');
  const r = reach(snap, ['lib/target.mjs']);
  assert.deepEqual(files(r).filter(f => /findings-/.test(f)), []);
  assert.deepEqual(r.opaque.map(o => o.file), ['tests/opaque.test.mjs'], 'the import(name) test may reach the module: it is listed as opaque');
  assert.equal(r.opaque[0].imports[0].line, 2);
  assert.deepEqual(expandModules(snap, ['review/findings-round1/evil.test.mjs']).unknown, ['review/findings-round1/evil.test.mjs'], 'a withheld path is not a module');
});

test('reach: the CLI prints text or JSON, reads a commit from git\'s object store, and exits 2 on a module that is not tracked', t => {
  const repo = tempRepo(t, REPO);
  const run = (...args) => spawnSync(process.execPath, [REACH, '--root', repo.dir, ...args], {encoding: 'utf8'});
  const json = run('lib/target.mjs', '--json');
  assert.equal(json.status, 0, json.stderr);
  const rec = JSON.parse(json.stdout);
  assert.equal(rec.schema, 'ophanim.toolkit.reach/v1');
  assert.deepEqual(rec.tests.map(x => x.file).sort(), ['tests/dynamic.test.mjs', 'tests/static.test.mjs', 'tests/template.test.mjs']);
  const text = run('lib/*.mjs');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /reach of 5 module\(s\) at working tree \(direct importers\)/);
  assert.match(text.stdout, /tests\/similar\.test\.mjs  \[imports lib\/target-extra\.mjs\]/);
  assert.match(text.stdout, /tests\/opaque\.test\.mjs:2/);
  const transitive = run('lib/target.mjs', '--transitive');
  assert.match(transitive.stdout, /tests\/top\.test\.mjs  \[level 3: tests\/top\.test\.mjs -> lib\/top\.mjs -> lib\/mid\.mjs -> lib\/target\.mjs\]/);
  // A commit, not the working tree: a test added after the base commit, uncommitted, is not in the base's reach.
  repo.put({'tests/later.test.mjs': "import {x} from '../lib/target.mjs';\n"});
  repo.git('add', 'tests/later.test.mjs');
  const atBase = JSON.parse(run('lib/target.mjs', '--json', '--ref', repo.base).stdout);
  assert.equal(atBase.ref, repo.base);
  assert.ok(!atBase.tests.some(x => x.file === 'tests/later.test.mjs'), 'the commit does not hold it');
  assert.ok(JSON.parse(run('lib/target.mjs', '--json').stdout).tests.some(x => x.file === 'tests/later.test.mjs'), 'the working tree (tracked files) does');
  const typo = run('lib/targte.mjs');
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /not a tracked file .*lib\/targte\.mjs/);
});
