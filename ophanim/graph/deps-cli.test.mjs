// The opt-in dependency sources from the command line (ophanim/graph/deps/cli.mjs). SYNTHETIC: the repository below is made in
// a temporary directory by this test. Each run builds its graph afresh with synthetic keys; no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileId} from './extract/repo.mjs';
import {npmPackageId} from './deps/ids.mjs';
import {tempRepo, ROOT} from './fixtures/repo.mjs';

const CLI = path.join(ROOT, 'ophanim/graph/deps/cli.mjs');
// The siblings' locations come from the environment; a test names none, so none is read.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^OPHANIM_(TELOS|ARGO|LEXI)_ROOT$/.test(k)));
const run = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], {encoding: 'utf8', env}); return {status: r.status, out: r.stdout, err: r.stderr}; };
const FILES = {'package.json': JSON.stringify({name: 'cli', dependencies: {leftpad: '1.0.0'}}),
  'package-lock.json': JSON.stringify({lockfileVersion: 3, packages: {'': {name: 'cli'}, 'node_modules/leftpad': {version: '1.0.0', integrity: 'sha512-AAAA'}}}),
  'a.mjs': "import leftpad from 'leftpad';\nexport function a() { return leftpad(1); }\n"};

test('needs and needed-by answer in JSON with exit 0, naming the commit the graph was built at', t => {
  const {repo, commit} = tempRepo(t), head = commit(FILES, 'fixture');
  const needs = run('needs', 'a.mjs', '--repo', repo, '--no-status', '--no-lessons');
  assert.equal(needs.status, 0, needs.err);
  const n = JSON.parse(needs.out);
  assert.deepEqual([n.graph.commit, n.subject, n.direct.packages.map(p => p.name)], [head, fileId('a.mjs'), ['npm:leftpad@1.0.0']]);
  assert.deepEqual(n.graph.absent.map(a => a.repository), ['telos', 'argo', 'lexi']);
  const by = JSON.parse(run('needed-by', 'package:leftpad', '--repo', repo, '--no-status', '--no-lessons').out);
  assert.deepEqual([by.subject, by.direct.map(d => d.name)], [npmPackageId('leftpad', '1.0.0'), ['a.mjs', 'a.mjs#a', 'package.json']]);
});

test('a subject the graph does not hold exits 1 with the reason; a malformed command exits 2 with the usage', t => {
  const {repo, commit} = tempRepo(t); commit(FILES, 'fixture');
  const missing = run('needs', 'nowhere.mjs', '--repo', repo, '--no-status', '--no-lessons');
  assert.deepEqual([missing.status, JSON.parse(missing.out).error], [1, 'NOT_FOUND']);
  const twice = run('stats', '--repo', repo, '--state', 'one=/nowhere', '--state', 'two=/nowhere');
  assert.equal(twice.status, 2, 'one runtime state directory: the board source and the runtime source read the same one');
  const usage = run('needs');
  assert.deepEqual([usage.status, usage.out], [2, '']);
  assert.match(usage.err, /^usage: node ophanim\/graph\/deps\/cli\.mjs /);
  assert.equal(run('frobnicate', 'x').status, 2);
});

test('audit and stats need no subject', t => {
  const {repo, commit} = tempRepo(t), head = commit(FILES, 'fixture');
  const a = JSON.parse(run('audit', '--repo', repo, '--no-status', '--no-lessons').out);
  assert.deepEqual(a.repositories.map(r => [r.repository, r.read_at, r.files_read, r.counts]), [['ophanim', head, 1, {calls: 1}]]);
  const s = JSON.parse(run('stats', '--repo', repo, '--no-status', '--no-lessons').out);
  assert.deepEqual(Object.keys(s.graph.sources).sort(), ['ophanim.authority', 'ophanim.calls', 'ophanim.environment', 'ophanim.imports', 'ophanim.literals', 'ophanim.packages', 'ophanim.paths', 'ophanim.pins',
    'ophanim.records', 'ophanim.repo', 'ophanim.verification'], 'Slice B2\'s sources and, beside them, the calls');
});
