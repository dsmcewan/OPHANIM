// The code source (ophanim/graph/deps/code.mjs), opt-in beside Slice B2's sources: for this repository, which function
// calls which; for a sibling repository, everything its code needs, in B2's types and id forms. SYNTHETIC: every
// repository below is made in a temporary directory by this test; its packages do not exist. Synthetic keys only; no
// network, no provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {codeFacts, codeSource, codeOrigin, CODE_EXTRACTOR, sourceIdOf} from './deps/code.mjs';
import {npmPackageId, unresolvedPackageId, builtinId, pythonModuleId, envId, executableId, fileIdIn, symbolIdIn, repositoryId} from './deps/ids.mjs';
import {parserVersion} from './deps/parse.mjs';
import {repoSource, fileId, symbolId} from './extract/repo.mjs';
import {sourcesOf, openSystemsGraph, observeAll} from './extract/index.mjs';
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
const S = 'argo', F = p => fileIdIn(S, p);

// ---- this repository: calls, and nothing Slice B2 already states ---------------------------------------------------------

test('THIS REPOSITORY: a function depends on the function it calls, in its own file, in another file, and through a workspace package\'s re-export', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head);
  const run = symbolId('app/main.mjs', 'run'), helper = symbolId('app/util.mjs', 'helper'), inner = symbolId('app/util.mjs', 'inner');
  assert.deepEqual(rel(facts, 'depends-on', run, helper).attributes, {basis: 'call', line: 11});
  assert.deepEqual(rel(facts, 'depends-on', helper, inner).attributes, {basis: 'call', line: 1});
  assert.deepEqual(ent(facts, inner).attributes, {module: 'app/util.mjs', name: 'inner', kind: 'function', line: 2, exported: false});
  assert.deepEqual(rel(facts, 'depends-on', run, symbolId('packages/lib/pad.mjs', 'pad')).attributes, {basis: 'call', line: 11, through: ['@fixture/lib', 'packages/lib/index.mjs']});
});

test('THIS REPOSITORY: a call into a package names the package as Slice B2 resolves the import: the version the root lockfile installs, or the unresolved name', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head);
  assert.deepEqual(rel(facts, 'depends-on', symbolId('packages/lib/pad.mjs', 'pad'), npmPackageId('leftpad', '1.2.3')).attributes, {basis: 'call', line: 2, imported: ['default']});
  assert.deepEqual(rel(facts, 'depends-on', symbolId('app/main.mjs', 'run'), unresolvedPackageId('undeclared-pkg')).attributes, {basis: 'call', line: 11, imported: ['default']});
});

test('THIS REPOSITORY: nothing Slice B2 already states is stated again: only symbols and calls, and the reading\'s own gaps', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head);
  assert.deepEqual([...new Set(facts.filter(d => d.type).map(d => `${d.type} [${d.attributes.basis}]`))].sort(), ['depends-on [call]']);
  assert.deepEqual([...new Set(facts.filter(d => d.entity).map(d => d.entity.split('/')[2]))].sort(), ['repository', 'symbol']);
  const root = ent(facts, repositoryId('ophanim'));
  assert.deepEqual(root.attributes, {calls_read_at: head, parser: `typescript ${parserVersion()}`, readers: `typescript ${parserVersion()} for JavaScript and TypeScript; a line-and-token reader for Python (no calls)`,
    files_read: 5, counts: {calls: 5}, unresolved: {calls: 0}, not_parsed: [{file: 'app/broken.mjs', why: 'the parser reports 1 syntax error(s); first at line 1: \',\' expected.'}]});
  assert.deepEqual(root.missing_evidence, ['1 file(s) the parser rejected give no facts']);
  assert.equal(codeSource({repo}).id, 'ophanim.calls');
});

test('THIS REPOSITORY: a call outside any function to a package the file imports adds nothing to the import; to a function of another file it is the file\'s dependency on that function', t => {
  const {repo, commit} = tempRepo(t);
  const head = commit({'package.json': json({name: 'top', dependencies: {leftpad: '1.0.0'}}),
    'a.mjs': lines("import leftpad from 'leftpad';", "import {b} from './b.mjs';", "export const padded = leftpad(b());"), 'b.mjs': lines("export function b() { return 'x'; }")}, 'top-level');
  const facts = codeFacts(repo, head);
  assert.deepEqual(facts.filter(d => d.type).map(d => [d.from, d.to, d.attributes]), [[fileId('a.mjs'), symbolId('b.mjs', 'b'), {basis: 'call outside any top-level function', line: 3}]]);
});

test('THIS REPOSITORY: an import that names no package and no file states no call, and is listed as unresolved', t => {
  const {repo, commit} = tempRepo(t);
  const head = commit({'package.json': json({name: 'alias'}), 'a.mjs': lines("import {x} from '#internal/x';", "import {y} from '/abs/y.mjs';", "export function f() { return x() + y(); }")}, 'aliases');
  const facts = codeFacts(repo, head);
  assert.deepEqual(facts.filter(d => d.from === symbolId('a.mjs', 'f')), []);
});

test('THIS REPOSITORY, IN THE GRAPH: observed after Slice B2\'s sources, a call is established, and a change to a package reaches the function that calls into it', t => {
  const {repo, head} = setup(t);
  const {sources} = sourcesOf({repo, status: null, lessons: false});
  const g = openSystemsGraph({sources: [...sources, codeSource({repo})], extraOrigins: {[CODE_EXTRACTOR]: {...codeOrigin(['ophanim']), keys: ['graph-extractor']}}});
  t.after(g.close);
  const observed = observeAll(g.graph, g.by, {observed_at: T0});
  assert.deepEqual([observed['ophanim.calls'].recorded, observed['ophanim.calls'].version], [true, head], observed['ophanim.calls'].why);
  const v = g.graph.view(), run = symbolId('app/main.mjs', 'run'), pad = symbolId('packages/lib/pad.mjs', 'pad'), leftpad = npmPackageId('leftpad', '1.2.3');
  const established = (from, to) => v.edgesOf(from, {mode: 'established', types: ['depends-on']}).filter(e => e.from === from && e.to === to).length;
  assert.deepEqual([established(run, symbolId('app/util.mjs', 'helper')), established(run, pad), established(pad, leftpad)], [1, 1, 1]);
  const ids = Object.values(impact(v, [leftpad]).affected).flat().map(n => n.id);
  assert.ok(ids.includes(fileId('packages/lib/pad.mjs')) && ids.includes(pad) && ids.includes(run), 'B2 states the importer; this source adds the functions that call through it');
  const again = g.open();
  assert.deepEqual([again.digest(), again.verification.complete], [g.graph.digest(), true], 'a replay re-derives the same graph from git');
});

// ---- a sibling repository: everything its code needs ---------------------------------------------------------------------

test('A SIBLING: an import of a package is a dependency on the version its lockfile resolves, with where it is declared', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head, {name: S}), leftpad = npmPackageId('leftpad', '1.2.3');
  assert.deepEqual(ent(facts, leftpad).attributes, {name: 'leftpad', version: '1.2.3', integrity: ['sha512-AAAA'], locks: [{lockfile: 'package-lock.json', entry: 'node_modules/leftpad'}]});
  assert.deepEqual(rel(facts, 'depends-on', F('packages/lib/pad.mjs'), leftpad).attributes, {basis: 'import', need: 'run-time', specifiers: ['leftpad'], lines: [1],
    declared_in: 'packages/lib/package.json', range: '^1.2.0', kind: 'dependencies'});
  assert.deepEqual(rel(facts, 'depends-on', F('packages/lib/package.json'), leftpad).attributes, {basis: 'declared dependency', kind: 'dependencies', range: '^1.2.0'});
  assert.deepEqual(rel(facts, 'derived-from', leftpad, F('package-lock.json')).attributes, {basis: 'the lockfile resolves it'});
  assert.deepEqual(rel(facts, 'derived-from', npmPackageId('typescript', '5.9.3'), F('package-lock.json')).attributes, {basis: 'the lockfile resolves it', dev: true});
});

test('A SIBLING: an import of a workspace package is the file its exports name; an import no manifest declares is still a dependency, unresolved and marked undeclared', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head, {name: S}), main = F('app/main.mjs');
  assert.deepEqual(rel(facts, 'depends-on', main, F('packages/lib/index.mjs')).attributes,
    {basis: 'import through the workspace package\'s exports', need: 'run-time', workspace: 'packages/lib', specifiers: ['@fixture/lib'], lines: [4]});
  const ghost = unresolvedPackageId('undeclared-pkg'), edge = rel(facts, 'depends-on', main, ghost);
  assert.deepEqual(edge.attributes, {basis: 'import', need: 'run-time', undeclared: true, specifiers: ['undeclared-pkg'], lines: [5]});
  assert.equal(edge.uncertainty, 'no package.json at or above app/ declares undeclared-pkg');
  assert.deepEqual([ent(facts, ghost).status, ent(facts, repositoryId(S)).attributes.undeclared_imports], ['unresolved', [{file: 'app/main.mjs', package: 'undeclared-pkg'}]]);
});

test('A SIBLING: a built-in module, a variable NAME and a program run by name are each what the file needs, in Slice B2\'s types', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head, {name: S}), main = F('app/main.mjs');
  assert.deepEqual(rel(facts, 'depends-on', main, builtinId('fs')).attributes, {basis: 'import', need: 'run-time', specifiers: ['node:fs'], lines: [1]});
  assert.deepEqual(ent(facts, builtinId('child_process')).attributes, {name: 'node:child_process', runtime: 'node'});
  assert.deepEqual(rel(facts, 'consumes', main, envId('APP_HOME')).attributes, {basis: 'environment variable read', need: 'run-time', lines: [7]});
  assert.deepEqual(ent(facts, envId('APP_HOME')).attributes, {name: 'APP_HOME'});
  assert.deepEqual(rel(facts, 'depends-on', main, executableId('git')).attributes, {basis: 'program run', need: 'run-time', calls: ['spawn'], lines: [11]});
  assert.deepEqual([envId('APP_HOME'), executableId('git'), builtinId('fs')].map(id => /^ophanim\/(systems\/[a-z-]+)\//.exec(id)?.[1]), ['systems/environment-variable', 'systems/executable', 'systems/package']);
  assert.ok(!JSON.stringify(facts).includes('/srv/app'), 'the default beside the variable is never kept');
});

test('A SIBLING: a path relative to the file is exact; a path joined to a root the file computes resolves only when one tracked file fits', t => {
  const {repo, head} = setup(t), facts = codeFacts(repo, head, {name: S}), main = F('app/main.mjs');
  const config = rel(facts, 'consumes', main, F('app/config.json'));
  assert.deepEqual(config.attributes, {basis: 'file read by path', need: 'run-time', calls: ['readFileSync'], lines: [8], as_written: './config.json', anchor: 'the file\'s own directory'});
  assert.equal(config.uncertainty, undefined, 'a path beside the file is exact: nothing was assumed');
  const table = rel(facts, 'consumes', main, F('app/data/table.json'));
  assert.deepEqual(table.attributes, {basis: 'file read by path', need: 'run-time', calls: ['readFileSync'], lines: [9], as_written: 'app/data/table.json', anchor: 'the repository root'});
  assert.equal(table.uncertainty, 'the path is joined to a root this file computes; it is taken as the one tracked file the path names from the repository root or a directory above the file');
  assert.deepEqual(ent(facts, main).attributes.unresolved_reads, [{as_written: 'var/state.json', line: 10, why: 'no tracked file fits'}]);
});

test('A SIBLING: a path that two tracked files fit is not resolved: both are named and no edge is made', t => {
  const {repo, commit} = tempRepo(t);
  const head = commit({'package.json': json({name: 'two'}), 'conf/x.json': '{}\n', 'app/conf/x.json': '{}\n',
    'app/main.mjs': lines("import fs from 'node:fs';", "import path from 'node:path';", "export const x = fs.readFileSync(path.join(ROOT, 'conf/x.json'));")}, 'two fits');
  const facts = codeFacts(repo, head, {name: S}), main = F('app/main.mjs');
  assert.deepEqual(ent(facts, main).attributes.unresolved_reads, [{as_written: 'conf/x.json', line: 3, why: 'more than one tracked file fits', candidates: ['app/conf/x.json', 'conf/x.json']}]);
  assert.deepEqual(facts.filter(d => d.type === 'consumes' && d.from === main), []);
});

test('A SIBLING: its files are its own nodes with the digest of their bytes, a file defines its symbols, a TypeScript specifier resolves, and a test file\'s needs are marked test', t => {
  const {repo, commit} = tempRepo(t);
  const aText = lines("import {b} from './b.js';", "export function a(): number { return b(); }");
  const head = commit({'package.json': json({name: 'sib', type: 'module'}), 'src/a.ts': aText, 'src/b.ts': lines("export function b(): number { return 1; }"),
    'tests/a.test.mjs': lines("import {a} from '../src/a.ts';", "a();")}, 'sibling');
  const facts = codeFacts(repo, head, {name: 'telos'});
  const a = fileIdIn('telos', 'src/a.ts'), b = fileIdIn('telos', 'src/b.ts');
  assert.deepEqual([ent(facts, a).attributes.path, ent(facts, a).attributes.content_sha256, ent(facts, a).attributes.need], ['src/a.ts', createHash('sha256').update(aText).digest('hex'), 'run-time']);
  assert.deepEqual(ent(facts, b).attributes.functions, 1, 'a file first seen as an import target is completed by its own reading');
  assert.deepEqual(rel(facts, 'depends-on', a, b).attributes, {basis: 'import', need: 'run-time', resolved_as: 'src/b.ts', specifiers: ['./b.js'], lines: [1]});
  assert.deepEqual(rel(facts, 'depends-on', symbolIdIn('telos', 'src/a.ts', 'a'), symbolIdIn('telos', 'src/b.ts', 'b')).attributes, {basis: 'call', line: 2});
  assert.deepEqual(rel(facts, 'produces', b, symbolIdIn('telos', 'src/b.ts', 'b')).attributes, {basis: 'the file defines it'});
  assert.equal(rel(facts, 'depends-on', fileIdIn('telos', 'tests/a.test.mjs'), a).attributes.need, 'test');
  assert.deepEqual([ent(facts, repositoryId('telos')).attributes.read_at, codeSource({repo, name: 'telos'}).id], [head, 'sibling.telos.code']);
  assert.ok(!facts.some(d => (d.entity ?? d.from).includes('/systems/module/src/')), 'nothing of the sibling is written under this repository\'s file ids');
});

test('A SIBLING, PYTHON: an import of a module of the repository is the file it names, any other import is a module by its import name, and a variable is its NAME', t => {
  const {repo, commit} = tempRepo(t);
  const head = commit({'app/__init__.py': '', 'app/util.py': 'def helper():\n    return 1\n', 'app/data/__init__.py': '', 'app/data/table.py': 'ROWS = []\n',
    'app/main.py': lines('import os', 'import fastapi.responses', 'from . import util', 'from .util import helper', 'from app.data import table', 'from ..outside import nothing',
      'HOME = os.environ["LEXI_HOME"]', 'def run():', '    return helper()')}, 'python');
  const facts = codeFacts(repo, head, {name: 'lexi'}), main = fileIdIn('lexi', 'app/main.py');
  assert.deepEqual(rel(facts, 'depends-on', main, fileIdIn('lexi', 'app/util.py')).attributes, {basis: 'import', need: 'run-time', specifiers: ['.', '.util'], lines: [3, 4]});
  assert.deepEqual(rel(facts, 'depends-on', main, fileIdIn('lexi', 'app/data/table.py')).attributes, {basis: 'import', need: 'run-time', anchor: 'the repository root', specifiers: ['app.data'], lines: [5]});
  assert.deepEqual(rel(facts, 'depends-on', main, pythonModuleId('fastapi')).attributes, {basis: 'import', need: 'run-time', specifiers: ['fastapi.responses'], lines: [2]});
  assert.deepEqual(ent(facts, pythonModuleId('os')).attributes, {name: 'os', ecosystem: 'python', note: 'a module by its import name: the import does not say whether it is the standard library or an installed distribution'});
  assert.deepEqual(rel(facts, 'consumes', main, envId('LEXI_HOME')).attributes, {basis: 'environment variable read', need: 'run-time', lines: [7]});
  assert.deepEqual(ent(facts, symbolIdIn('lexi', 'app/main.py', 'run')).attributes, {module: 'app/main.py', name: 'run', kind: 'function', line: 8, exported: true});
  assert.deepEqual(ent(facts, repositoryId('lexi')).attributes.unresolved_imports, [{file: 'app/main.py', specifier: '..outside', line: 6}]);
});

test('A SIBLING, PYTHON: a module two directories hold is not resolved, and a relative import that climbs out of the repository is not answered from its root', t => {
  const {repo, commit} = tempRepo(t);
  const head = commit({'conftest.py': 'X = 1\n', 'pkg/conftest.py': 'X = 2\n', 'pkg/tests/test_a.py': 'import conftest\n', 'pkg/a.py': 'from ... import conftest\n'}, 'python edges');
  const facts = codeFacts(repo, head, {name: 'lexi'});
  assert.deepEqual(ent(facts, repositoryId('lexi')).attributes.unresolved_imports, [{file: 'pkg/a.py', specifier: '...', line: 1},
    {file: 'pkg/tests/test_a.py', specifier: 'conftest', line: 1, why: 'more than one directory holds a module of this name'}]);
  assert.deepEqual(facts.filter(d => d.type === 'depends-on'), []);
});

test('READ AT THE COMMIT, never the working tree, and the same commit gives the same facts', t => {
  const {repo, head, write} = setup(t);
  write({'app/util.mjs': "import x from 'only-in-the-working-tree';\nexport function helper() { return x(); }\n"});
  for (const name of ['ophanim', S]) {
    const facts = codeFacts(repo, head, {name});
    assert.ok(!JSON.stringify(facts).includes('only-in-the-working-tree'), `${name}: an uncommitted import is not in the commit`);
    assert.deepEqual(codeFacts(repo, head, {name}), facts);
  }
});

test('A SIBLING, IN THE GRAPH: its facts are established under their own source, and a change to a file it reads by path reaches the reader', t => {
  const {repo, head} = setup(t);
  const g = openSystemsGraph({sources: [codeSource({repo, name: S})], extraOrigins: {[CODE_EXTRACTOR]: {...codeOrigin([S]), keys: ['graph-extractor']}}});
  t.after(g.close);
  const o = g.graph.observe(sourceIdOf(S), {...g.by, observed_at: at(1)});
  assert.deepEqual([o.recorded, o.record.source.version], [true, head], o.why);
  const v = g.graph.view(), main = F('app/main.mjs');
  const established = (from, to, type) => v.edgesOf(from, {mode: 'established', types: [type]}).filter(e => e.from === from && e.to === to).length;
  assert.deepEqual([established(main, F('app/config.json'), 'consumes'), established(main, unresolvedPackageId('undeclared-pkg'), 'depends-on'), established(main, envId('APP_HOME'), 'consumes')], [1, 0, 1],
    'an edge to a package nothing resolves is recorded, not established');
  assert.ok(Object.values(impact(v, [F('app/data/table.json')]).affected).flat().some(n => n.id === main), 'the reader of the table is affected by a change to it');
});
