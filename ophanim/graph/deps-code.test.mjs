// The code-dependency source (ophanim/graph/deps/code.mjs): what a repository's code needs beyond its relative imports
// -- packages and their locked versions, the platform's own modules, environment variable names, programs, files read
// by path, and calls between functions -- read at a commit with a real parser. SYNTHETIC: the repository below is made
// in a temporary directory by this test; its packages do not exist. Synthetic keys only; no network, no provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {codeFacts, codeSource, codeOrigin, CODE_EXTRACTOR, sourceIdOf} from './deps/code.mjs';
import {packageId, envId, fileIdIn, symbolIdIn, repositoryId} from './deps/ids.mjs';
import {parserVersion} from './deps/parse.mjs';
import {repoSource, fileId, symbolId} from './extract/repo.mjs';
import {openSystemsGraph} from './extract/index.mjs';
import {impact} from './impact.mjs';
import {tempRepo, T0, at} from './fixtures/repo.mjs';

const lines = (...l) => l.join('\n') + '\n';
const json = v => JSON.stringify(v, null, 2) + '\n';
const FILES = {
  'package.json': json({name: 'fixture', private: true, type: 'module', workspaces: ['packages/*'], devDependencies: {typescript: '5.9.3'}}),
  'package-lock.json': json({name: 'fixture', lockfileVersion: 3, packages: {
    '': {name: 'fixture', workspaces: ['packages/*']},
    'node_modules/leftpad': {version: '1.2.3', resolved: 'https://registry.example.test/leftpad/-/leftpad-1.2.3.tgz', integrity: 'sha512-AAAA'},
    'node_modules/typescript': {version: '5.9.3', resolved: 'https://registry.example.test/typescript/-/typescript-5.9.3.tgz', integrity: 'sha512-BBBB', dev: true},
    'node_modules/@fixture/lib': {resolved: 'packages/lib', link: true},
    'packages/lib': {name: '@fixture/lib', version: '0.0.0', dependencies: {leftpad: '^1.2.0'}},
  }}),
  'packages/lib/package.json': json({name: '@fixture/lib', type: 'module', exports: './index.mjs', dependencies: {leftpad: '^1.2.0'}}),
  'packages/lib/index.mjs': lines("export {pad} from './pad.mjs';"),
  'packages/lib/pad.mjs': lines("import leftpad from 'leftpad';", "export function pad(s) { return leftpad(s, 4); }"),
  'app/main.mjs': lines(
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import {spawn} from 'node:child_process';",
    "import {pad} from '@fixture/lib';",
    "import missing from 'undeclared-pkg';",
    "import {helper} from './util.mjs';",
    "const ROOT = process.env.APP_HOME ?? '/srv/app';",
    "const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));",
    "const table = fs.readFileSync(path.join(ROOT, 'app/data/table.json'), 'utf8');",
    "const elsewhere = fs.readFileSync(path.join(ROOT, 'var/state.json'), 'utf8');",
    "export function run() { spawn('git', ['status']); return pad(helper()) + missing(config, table, elsewhere); }",
  ),
  'app/util.mjs': lines("export function helper() { return inner(); }", "function inner() { return 1; }"),
  'app/config.json': '{}\n', 'app/data/table.json': '[]\n',
  'app/broken.mjs': "import {a from './a.mjs';\n",
};
const rel = (facts, type, from, to) => facts.find(d => d.type === type && d.from === from && d.to === to);
const ent = (facts, id) => facts.find(d => d.entity === id);
const setup = t => { const r = tempRepo(t); return {...r, head: r.commit(FILES, 'fixture')}; };

test('PACKAGES: an import of a package is a dependency on it, with where it is declared and the version the lockfile pins', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head);
  const leftpad = packageId('npm', 'leftpad'), pad = fileId('packages/lib/pad.mjs');
  assert.deepEqual(ent(facts, leftpad).attributes, {ecosystem: 'npm', name: 'leftpad',
    locked: [{version: '1.2.3', integrity: 'sha512-AAAA', registry: 'registry.example.test', lockfile: 'package-lock.json', at: 'node_modules/leftpad', dev: false}]});
  assert.deepEqual(rel(facts, 'depends-on', pad, leftpad).attributes, {basis: 'import', specifiers: ['leftpad'], lines: [1],
    declared_in: 'packages/lib/package.json', range: '^1.2.0', kind: 'dependencies'});
  assert.deepEqual(rel(facts, 'depends-on', fileId('packages/lib/package.json'), leftpad).attributes, {basis: 'declared dependency', kind: 'dependencies', range: '^1.2.0'});
  assert.deepEqual(rel(facts, 'depends-on', fileId('package.json'), packageId('npm', 'typescript')).attributes, {basis: 'declared dependency', kind: 'devDependencies', range: '5.9.3'});
});

test('A PACKAGE OF THE REPOSITORY ITSELF is named with its directory, and an import of it reaches the file its exports name', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head);
  const lib = packageId('npm', '@fixture/lib'), main = fileId('app/main.mjs');
  assert.deepEqual(ent(facts, lib).attributes, {ecosystem: 'npm', name: '@fixture/lib', local: 'packages/lib', manifest: 'packages/lib/package.json', entry: 'packages/lib/index.mjs'});
  assert.deepEqual(rel(facts, 'depends-on', main, lib).attributes, {basis: 'import', specifiers: ['@fixture/lib'], lines: [4], local: 'packages/lib'});
  assert.deepEqual(rel(facts, 'depends-on', main, fileId('packages/lib/index.mjs')).attributes, {basis: 'import through the package\'s exports', specifiers: ['@fixture/lib'], lines: [4]});
});

test('AN IMPORT NO MANIFEST DECLARES is still a dependency, marked undeclared and listed on the repository', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head);
  const edge = rel(facts, 'depends-on', fileId('app/main.mjs'), packageId('npm', 'undeclared-pkg'));
  assert.deepEqual(edge.attributes, {basis: 'import', specifiers: ['undeclared-pkg'], lines: [5], undeclared: true});
  assert.equal(edge.uncertainty, 'no package.json at or above app/ declares undeclared-pkg');
  assert.deepEqual(ent(facts, repositoryId('ophanim')).attributes.undeclared_imports, [{file: 'app/main.mjs', package: 'undeclared-pkg'}]);
});

test('THE PLATFORM, THE ENVIRONMENT AND PROGRAMS: a platform module, a variable NAME and a program run by name are each a dependency of the file', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head), main = fileId('app/main.mjs');
  assert.deepEqual(rel(facts, 'depends-on', main, packageId('node', 'fs')).attributes, {basis: 'import', specifiers: ['node:fs'], lines: [1]});
  assert.deepEqual(rel(facts, 'depends-on', main, packageId('node', 'child_process')).attributes, {basis: 'import', specifiers: ['node:child_process'], lines: [3]});
  assert.deepEqual(rel(facts, 'consumes', main, envId('APP_HOME')).attributes, {basis: 'environment variable read', lines: [7]});
  assert.deepEqual(ent(facts, envId('APP_HOME')).attributes, {name: 'APP_HOME', read_by: 1});
  assert.deepEqual(rel(facts, 'depends-on', main, packageId('program', 'git')).attributes, {basis: 'program run', calls: ['spawn'], lines: [11]});
  assert.ok(!JSON.stringify(facts).includes('/srv/app'), 'the default beside the variable is never kept');
});

test('FILES READ BY PATH: a path relative to the file is exact; a path joined to a root the file computes resolves only when one tracked file fits', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head), main = fileId('app/main.mjs');
  assert.deepEqual(rel(facts, 'consumes', main, fileId('app/config.json')).attributes, {basis: 'file read by path', calls: ['readFileSync'], lines: [8], as_written: './config.json', anchor: 'the file\'s own directory'});
  const table = rel(facts, 'consumes', main, fileId('app/data/table.json'));
  assert.deepEqual(table.attributes, {basis: 'file read by path', calls: ['readFileSync'], lines: [9], as_written: 'app/data/table.json', anchor: 'the repository root'});
  assert.equal(table.uncertainty, 'the path is joined to a root this file computes; it is taken as the one tracked file the path names from the repository root or a directory above the file');
  assert.deepEqual(ent(facts, main).attributes.unresolved_reads, [{as_written: 'var/state.json', line: 10, why: 'no tracked file fits'}]);
});

test('CALLS: a function depends on the function it calls, in its own file, in another file, and through a package\'s re-export', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head);
  const run = symbolId('app/main.mjs', 'run'), helper = symbolId('app/util.mjs', 'helper'), inner = symbolId('app/util.mjs', 'inner');
  assert.deepEqual(rel(facts, 'depends-on', run, helper).attributes, {basis: 'call', line: 11});
  assert.deepEqual(rel(facts, 'depends-on', helper, inner).attributes, {basis: 'call', line: 1});
  assert.deepEqual(ent(facts, inner).attributes, {module: 'app/util.mjs', name: 'inner', kind: 'function', line: 2, exported: false});
  assert.deepEqual(rel(facts, 'depends-on', run, symbolId('packages/lib/pad.mjs', 'pad')).attributes,
    {basis: 'call', line: 11, through: ['@fixture/lib', 'packages/lib/index.mjs']});
  assert.deepEqual(rel(facts, 'depends-on', run, packageId('npm', 'undeclared-pkg')).attributes, {basis: 'call', line: 11, imported: ['default']});
  assert.deepEqual(rel(facts, 'depends-on', symbolId('packages/lib/pad.mjs', 'pad'), packageId('npm', 'leftpad')).attributes, {basis: 'call', line: 2, imported: ['default']});
});

test('A CALL OUTSIDE ANY FUNCTION to a package it imports adds nothing to the import: one dependency, stated once', t => {
  const {repo, commit} = tempRepo(t);
  const head = commit({'package.json': json({name: 'top', dependencies: {leftpad: '1.0.0'}}),
    'a.mjs': lines("import leftpad from 'leftpad';", "import {b} from './b.mjs';", "export const padded = leftpad(b());"), 'b.mjs': lines("export function b() { return 'x'; }")}, 'top-level');
  const facts = codeFacts(repo, head);
  assert.deepEqual(facts.filter(d => d.from === fileId('a.mjs') && d.to === packageId('npm', 'leftpad')).map(d => d.attributes),
    [{basis: 'import', specifiers: ['leftpad'], lines: [1], declared_in: 'package.json', range: '1.0.0', kind: 'dependencies'}]);
  assert.deepEqual(rel(facts, 'depends-on', fileId('a.mjs'), symbolId('b.mjs', 'b')).attributes, {basis: 'call outside any top-level function', line: 3});
});

test('AN IMPORT THAT NAMES NO PACKAGE AND NO FILE (a subpath alias, an absolute path) is listed as unresolved, and a call through it states nothing', t => {
  const {repo, commit} = tempRepo(t);
  const head = commit({'package.json': json({name: 'alias'}), 'a.mjs': lines("import {x} from '#internal/x';", "import {y} from '/abs/y.mjs';", "export function f() { return x() + y(); }")}, 'aliases');
  const facts = codeFacts(repo, head);
  assert.deepEqual(ent(facts, repositoryId('ophanim')).attributes.unresolved_imports, [{file: 'a.mjs', specifier: '#internal/x', line: 1}, {file: 'a.mjs', specifier: '/abs/y.mjs', line: 2}]);
  assert.deepEqual(facts.filter(d => d.from === symbolId('a.mjs', 'f')), []);
});

test('A FILE THE PARSER REJECTS gives no facts and is named on the repository, with what the reading rests on', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head);
  const root = ent(facts, repositoryId('ophanim')).attributes;
  assert.deepEqual(root.not_parsed, [{file: 'app/broken.mjs', why: 'the parser reports 1 syntax error(s); first at line 1: \',\' expected.'}]);
  assert.deepEqual([root.commit, root.parser, root.files_read], [head, `typescript ${parserVersion()}`, 5]);
  assert.ok(!facts.some(d => d.from === fileId('app/broken.mjs')), 'no fact comes from the rejected file');
});

test('READ AT THE COMMIT, never the working tree, and the same commit gives the same facts', t => {
  const {repo, head, write} = setup(t);
  write({'app/util.mjs': "import x from 'only-in-the-working-tree';\nexport function helper() { return x; }\n"});
  const facts = codeFacts(repo, head);
  assert.ok(!ent(facts, packageId('npm', 'only-in-the-working-tree')), 'an uncommitted import is not in the commit');
  assert.deepEqual(codeFacts(repo, head), facts);
  assert.ok(!facts.some(d => d.type === 'produces' && d.attributes.basis === 'the file defines it'), 'for this repository the repository source states which file defines a symbol');
});

test('IN THE GRAPH: observed after the repository, the facts are established and a change to a configuration file reaches the code that reads it', t => {
  const {repo, head} = setup(t);
  const g = openSystemsGraph({sources: [repoSource({repo}), codeSource({repo})], extraOrigins: {[CODE_EXTRACTOR]: {...codeOrigin(['ophanim']), keys: ['graph-extractor']}}});
  t.after(g.close);
  g.graph.observe('ophanim.repo', {...g.by, observed_at: T0});
  const o = g.graph.observe(sourceIdOf('ophanim'), {...g.by, observed_at: at(1)});
  assert.deepEqual([o.recorded, o.record.source.version], [true, head], o.why);
  const v = g.graph.view(), main = fileId('app/main.mjs');
  const established = (from, to, type) => v.edgesOf(from, {mode: 'established', types: [type]}).filter(e => e.from === from && e.to === to).length;
  assert.deepEqual([established(main, fileId('app/config.json'), 'consumes'), established(main, packageId('npm', 'undeclared-pkg'), 'depends-on'),
    established(main, envId('APP_HOME'), 'consumes'), established(symbolId('app/main.mjs', 'run'), symbolId('app/util.mjs', 'helper'), 'depends-on')], [1, 1, 1, 1]);
  const reached = impact(v, [fileId('app/data/table.json')]);
  assert.ok(Object.values(reached.affected).flat().some(n => n.id === main), 'the reader of the table is affected by a change to it');
  const viaPackage = impact(v, [packageId('npm', 'leftpad')]);
  const ids = Object.values(viaPackage.affected).flat().map(n => n.id);
  assert.ok(ids.includes(fileId('packages/lib/pad.mjs')) && ids.includes(symbolId('app/main.mjs', 'run')), 'a change to a package reaches its importer and the function that calls through it');
  const again = g.open();
  assert.deepEqual([again.digest(), again.verification.complete], [g.graph.digest(), true], 'a replay re-derives the same graph from git');
});

test('A SIBLING REPOSITORY is read the same way under its own name: its files are its own nodes and its relative imports are stated here', t => {
  const {repo, commit} = tempRepo(t);
  const head = commit({'package.json': json({name: 'sib', type: 'module'}), 'src/a.ts': lines("import {b} from './b.js';", "export function a(): number { return b(); }"),
    'src/b.ts': lines("export function b(): number { return 1; }")}, 'sibling');
  const facts = codeFacts(repo, head, {name: 'telos'});
  const a = fileIdIn('telos', 'src/a.ts'), b = fileIdIn('telos', 'src/b.ts');
  assert.deepEqual(ent(facts, a).attributes.path, 'src/a.ts');
  assert.deepEqual(rel(facts, 'depends-on', a, b).attributes, {basis: 'import', specifiers: ['./b.js'], lines: [1], resolved_as: 'src/b.ts'});
  assert.deepEqual(rel(facts, 'depends-on', symbolIdIn('telos', 'src/a.ts', 'a'), symbolIdIn('telos', 'src/b.ts', 'b')).attributes, {basis: 'call', line: 2});
  assert.deepEqual(rel(facts, 'produces', b, symbolIdIn('telos', 'src/b.ts', 'b')).attributes, {basis: 'the file defines it'});
  assert.ok(ent(facts, repositoryId('telos')), 'the sibling has its own repository node');
  assert.ok(!facts.some(d => (d.entity ?? d.from).includes('/systems/module/src/')), 'nothing of the sibling is written under this repository\'s file ids');
  assert.equal(codeSource({repo, name: 'telos'}).id, 'sibling.telos.code');
});
