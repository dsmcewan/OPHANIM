// The dependency graph's composition and questions (ophanim/graph/deps/index.mjs, query.mjs): one graph over this
// repository's sources and its siblings', and the two questions a dependency graph exists for -- what does this need,
// and what needs this -- each answer naming the source, the version and the lines it rests on. SYNTHETIC: the two
// repositories below are made in temporary directories by this test. Synthetic keys only; no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dependencyGraph} from './deps/index.mjs';
import {subjectOf, needs, neededBy, audit} from './deps/query.mjs';
import {packageId, envId, fileIdIn, symbolIdIn} from './deps/ids.mjs';
import {fileId, symbolId} from './extract/repo.mjs';
import {tempRepo, T0} from './fixtures/repo.mjs';

const lines = (...l) => l.join('\n') + '\n';
const json = v => JSON.stringify(v, null, 2) + '\n';
const HOME_FILES = {
  'package.json': json({name: 'home', type: 'module', dependencies: {leftpad: '^1.0.0'}}),
  'package-lock.json': json({lockfileVersion: 3, packages: {'': {name: 'home'}, 'node_modules/leftpad': {version: '1.0.4', integrity: 'sha512-AAAA', resolved: 'https://registry.example.test/leftpad.tgz'}}}),
  'app/main.mjs': lines("import fs from 'node:fs';", "import leftpad from 'leftpad';", "import {helper} from './util.mjs';",
    "const where = process.env.APP_HOME;", "const table = fs.readFileSync(new URL('./table.json', import.meta.url), 'utf8');",
    "export function run() { return leftpad(helper(table + where)); }", "const site = 'https://api.example.test/v1';", "export const s = site;"),
  'app/util.mjs': lines("export function helper(x) { return x; }"),
  'app/table.json': '[]\n', 'app/broken.mjs': 'export const = ;\n',
};
const SIBLING_FILES = {'package.json': json({name: 'sib'}), 'lib/a.mjs': lines("import {b} from './b.mjs';", "export function a() { return b(); }"), 'lib/b.mjs': lines("export function b() { return 1; }")};
const setup = t => {
  const home = tempRepo(t), sib = tempRepo(t), head = home.commit(HOME_FILES, 'home'), sibHead = sib.commit(SIBLING_FILES, 'sibling');
  const g = dependencyGraph({repo: home.repo, status: null, lessons: false, verification: false, records: false, siblings: {telos: {repo: sib.repo}}, observed_at: T0});
  t.after(g.close);
  return {g, v: g.graph.view(), head, sibHead};
};

test('ONE GRAPH: this repository\'s sources and each sibling\'s are observed, each at its own commit, and a sibling with no checkout is said to be absent', t => {
  const {g, head, sibHead} = setup(t);
  assert.deepEqual(Object.fromEntries(Object.entries(g.observed).map(([k, o]) => [k, [o.recorded, o.version]])), {
    'ophanim.repo': [true, head], 'ophanim.code': [true, head], 'ophanim.code-text': [true, head], 'ophanim.pins': [true, head], 'ophanim.ownership': [true, head],
    'sibling.telos.code': [true, sibHead], 'sibling.telos.code-text': [true, sibHead], 'sibling.telos.weave': [true, sibHead]});
  assert.deepEqual(g.absent, [{repository: 'argo', why: 'no checkout was given'}, {repository: 'lexi', why: 'no checkout was given'}]);
});

test('TELOS IS READ AT THE COMMIT THIS REPOSITORY PINS, not at whatever its checkout has moved to; a pin the checkout lacks is said so', t => {
  const home = tempRepo(t), sib = tempRepo(t);
  const pinned = sib.commit(SIBLING_FILES, 'pinned'), later = sib.commit({'lib/c.mjs': 'export const c = 3;\n'}, 'later');
  home.commit({...HOME_FILES, 'ophanim/governance.mjs': `export const TELOS_COMMIT = '${pinned}';\n`}, 'pins telos');
  const g = dependencyGraph({repo: home.repo, status: null, lessons: false, verification: false, records: false, siblings: {telos: {repo: sib.repo}}, observed_at: T0});
  t.after(g.close);
  assert.notEqual(pinned, later);
  assert.deepEqual([g.observed['sibling.telos.code'].version, g.pinned], [pinned, {telos: {commit: pinned, by: 'ophanim/governance.mjs'}}]);
  home.commit({'ophanim/governance.mjs': `export const TELOS_COMMIT = '${'a'.repeat(40)}';\n`}, 'pins a commit the checkout lacks');
  const lacking = dependencyGraph({repo: home.repo, status: null, lessons: false, verification: false, records: false, siblings: {telos: {repo: sib.repo}}, observed_at: T0});
  t.after(lacking.close);
  assert.deepEqual(lacking.absent.find(a => a.repository === 'telos'), {repository: 'telos', why: `its checkout does not hold the pinned commit ${'a'.repeat(40)}`});
  assert.equal(lacking.observed['sibling.telos.code'], undefined, 'nothing is read of a sibling at a commit other than the pinned one');
});

test('A RUNTIME STATE DIRECTORY is a source under its own name; one that cannot be read is recorded unavailable with the reason and states nothing', t => {
  const home = tempRepo(t), empty = tempRepo(t);
  home.commit(HOME_FILES, 'home');
  const g = dependencyGraph({repo: home.repo, status: null, lessons: false, verification: false, records: false, states: [{name: 'nothing-here', stateDir: empty.repo}], observed_at: T0});
  t.after(g.close);
  const o = g.observed['ophanim.runtime.nothing-here'];
  assert.deepEqual([o.state, typeof o.why, o.count], ['unavailable', 'string', null]);
  assert.throws(() => dependencyGraph({repo: home.repo, states: [{name: 'Bad Name', stateDir: empty.repo}]}), /a runtime state has a short lowercase name/);
});

test('A SUBJECT is named the way a person writes it: a path, a path#function, npm:name, env:NAME, program:name, host:name, sibling:path', t => {
  const {v} = setup(t);
  assert.deepEqual(['app/main.mjs', 'app/main.mjs#run', 'npm:leftpad', 'env:APP_HOME', 'node:fs', 'telos:lib/a.mjs', 'telos:lib/a.mjs#a', fileId('app/util.mjs')].map(s => subjectOf(v, s).id),
    [fileId('app/main.mjs'), symbolId('app/main.mjs', 'run'), packageId('npm', 'leftpad'), envId('APP_HOME'), packageId('node', 'fs'), fileIdIn('telos', 'lib/a.mjs'), symbolIdIn('telos', 'lib/a.mjs', 'a'), fileId('app/util.mjs')]);
  assert.deepEqual(subjectOf(v, 'npm:never-heard-of'), {error: 'NOT_FOUND', why: 'npm:never-heard-of names nothing the graph holds at cursor ' + v.seq});
});

test('WHAT DOES IT NEED: the direct dependencies by kind, each with the relationship, the lines and the source and version that state it', t => {
  const {v, head} = setup(t), r = needs(v, 'app/main.mjs');
  assert.deepEqual(Object.fromEntries(Object.entries(r.direct).map(([k, xs]) => [k, xs.map(x => x.name)])), {
    packages: ['npm:leftpad'], platform: ['node:fs'], environment: ['env:APP_HOME'], programs: [], files: ['app/table.json', 'app/util.mjs'], functions: ['app/util.mjs#helper'], siblings: [], other: []});
  const [pkg] = r.direct.packages;
  assert.deepEqual(pkg, {name: 'npm:leftpad', id: packageId('npm', 'leftpad'), relationship: 'depends-on', basis: 'import', lines: [2],
    stated_by: [{source: 'ophanim.code', version: head}], declared_in: 'package.json', range: '^1.0.0', locked: ['1.0.4']});
  assert.deepEqual(r.direct.files.map(f => [f.name, f.relationship, f.basis, f.stated_by.map(s => s.source)]),
    [['app/table.json', 'consumes', 'file read by path', ['ophanim.code']], ['app/util.mjs', 'depends-on', 'import', ['ophanim.repo']]]);
  // Everything reachable: the package, the platform module, the variable, the table, util.mjs and its helper.
  assert.deepEqual([r.transitive.count, r.subject, r.cursor], [6, fileId('app/main.mjs'), v.seq]);
  assert.deepEqual(needs(v, 'app/main.mjs#run').direct.functions.map(f => f.name), ['app/util.mjs#helper']);
  assert.deepEqual(r.mentions, [{name: 'host:api.example.test', lines: [7], stated_by: [{source: 'ophanim.code-text', version: head}], note: 'named in a string: not a dependency'}]);
});

test('WHAT NEEDS IT: the dependents of a package, a file and an environment variable, with the advisory class and what the coverage rests on', t => {
  const {v} = setup(t);
  const pkg = neededBy(v, 'npm:leftpad');
  assert.deepEqual(pkg.direct.map(d => d.name), ['app/main.mjs', 'app/main.mjs#run', 'package-lock.json', 'package.json']);
  assert.deepEqual(neededBy(v, 'app/table.json').direct.map(d => [d.name, d.basis]), [['app/main.mjs', 'file read by path']]);
  assert.deepEqual(neededBy(v, 'env:APP_HOME').direct.map(d => d.name), ['app/main.mjs']);
  assert.deepEqual([pkg.assessment.blast_radius, pkg.assessment.class, pkg.assessment.advisory, pkg.assessment.coverage], [4, 'medium', true, 'unverified']);
  // Every gap a reading of the repository reported lowers the coverage of an answer about it: none is judged irrelevant here.
  assert.deepEqual(pkg.coverage.why, ['ophanim: 1 file(s) the parser rejected give no facts',
    'ophanim: PROVENANCE.json is not in the tree at this commit: the lineage of this repository is not stated',
    'ophanim: ophanim/governance.mjs is not in the tree at this commit: no TELOS pin is read']);
  assert.deepEqual(neededBy(v, 'telos:lib/b.mjs').direct.map(d => d.name), ['telos:lib/a.mjs', 'telos:lib/a.mjs#a']);
});

test('THE AUDIT lists, per repository, what each reading could not state, and where two sources of one repository agree or differ', t => {
  const {v, head, sibHead} = setup(t), a = audit(v);
  assert.deepEqual(a.repositories.map(r => [r.repository, r.commit]), [['ophanim', head], ['telos', sibHead]]);
  const home = a.repositories[0];
  assert.deepEqual([home.files_read, home.not_parsed.map(x => x.file), home.undeclared_imports, home.unresolved.reads], [3, ['app/broken.mjs'], [], 0]);
  assert.deepEqual(a.repositories[1].weave, {stated: null, why: 'docs/runs/clotho-self-weave/thread-ledger.snapshot.jsonl is not in the tree at this commit'});
  assert.deepEqual(a.sources.map(s => [s.id, s.state]), [['ophanim.code', 'current'], ['ophanim.code-text', 'current'], ['ophanim.ownership', 'current'], ['ophanim.pins', 'current'], ['ophanim.repo', 'current'],
    ['sibling.telos.code', 'current'], ['sibling.telos.code-text', 'current'], ['sibling.telos.weave', 'current']]);
});
