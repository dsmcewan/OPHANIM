// The opt-in dependency sources composed beside Slice B2's (ophanim/graph/deps/index.mjs) and their questions
// (query.mjs): what does this need, what needs this (through its functions and across sibling repositories), and an
// audit of every reading. SYNTHETIC: the repositories below are made in temporary directories by this test.
// Synthetic keys only; no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {dependencyGraph} from './deps/index.mjs';
import {subjectOf, needs, neededBy, audit} from './deps/query.mjs';
import {npmPackageId, builtinId, envId, fileIdIn, symbolIdIn} from './deps/ids.mjs';
import {sourcesOf} from './extract/index.mjs';
import {fileId, symbolId} from './extract/repo.mjs';
import {tempRepo, T0} from './fixtures/repo.mjs';
import {runRuntime} from '../runtime.mjs';
import {readRuntimeSnapshot} from '../board.mjs';
import {createGovernance} from '../governance.mjs';
import {makeFixtures, createWorkers, createSyntheticDestination} from '../fixtures.mjs';
import {obligationId} from './extract/board.mjs';
import {executionId, stateId} from './deps/runtime.mjs';

const lines = (...l) => l.join('\n') + '\n';
const json = v => JSON.stringify(v, null, 2) + '\n';
const sha = x => createHash('sha256').update(x).digest('hex');
const HOME_FILES = {
  'package.json': json({name: 'home', type: 'module', dependencies: {leftpad: '^1.0.0'}}),
  'package-lock.json': json({lockfileVersion: 3, packages: {'': {name: 'home'}, 'node_modules/leftpad': {version: '1.0.4', integrity: 'sha512-AAAA', resolved: 'https://registry.example.test/leftpad.tgz'}}}),
  'app/main.mjs': lines("import fs from 'node:fs';", "import leftpad from 'leftpad';", "import {helper} from './util.mjs';",
    "const where = process.env.APP_HOME;", "const table = fs.readFileSync(new URL('./table.json', import.meta.url), 'utf8');",
    "export function run() { return leftpad(helper(table + where)); }"),
  'app/util.mjs': lines("export function helper(x) { return x; }"),
  'app/table.json': '[]\n', 'app/broken.mjs': 'export const = ;\n', 'app/config/deep/lanes.json': '{}\n',
};
const SIBLING_FILES = {'package.json': json({name: 'sib'}), 'lib/a.mjs': lines("import {b} from './b.mjs';", "export function a() { return b(); }"), 'lib/b.mjs': lines("export function b() { return 1; }")};
const OPTS = {status: null, lessons: false, verification: false, records: false, observed_at: T0};
const OPT_IN = k => k === 'ophanim.calls' || k === 'ophanim.runtime' || k.startsWith('sibling.');
const setup = t => {
  const home = tempRepo(t), sib = tempRepo(t), head = home.commit(HOME_FILES, 'home'), sibHead = sib.commit(SIBLING_FILES, 'sibling');
  const g = dependencyGraph({repo: home.repo, ...OPTS, siblings: {telos: {repo: sib.repo}}});
  t.after(g.close);
  return {g, v: g.graph.view(), head, sibHead, home, sib};
};

test('OPT-IN, BESIDE SLICE B2: the calls and each sibling\'s sources are observed with B2\'s, each at its own commit; the default open does not include them', t => {
  const {g, head, sibHead, home} = setup(t);
  assert.deepEqual(Object.fromEntries(Object.entries(g.observed).filter(([k]) => OPT_IN(k)).map(([k, o]) => [k, [o.recorded, o.version]])), {
    'ophanim.calls': [true, head], 'sibling.telos.code': [true, sibHead], 'sibling.telos.code-text': [true, sibHead], 'sibling.telos.weave': [true, sibHead], 'sibling.telos.declared': [true, sibHead]});
  assert.deepEqual(['ophanim.packages', 'ophanim.imports', 'ophanim.environment', 'ophanim.paths', 'ophanim.pins', 'ophanim.authority', 'ophanim.literals'].map(id => g.observed[id]?.recorded), Array(7).fill(true),
    'B2\'s sources state what this repository needs; nothing here restates it');
  assert.deepEqual(g.absent, [{repository: 'argo', why: 'no checkout was given'}, {repository: 'lexi', why: 'no checkout was given'}]);
  assert.deepEqual(sourcesOf({repo: home.repo, status: null, lessons: false}).sources.map(s => s.id).filter(OPT_IN), [], 'the default open is unchanged');
  // Every source declares the version of the code that reads it (docs/knowledge-graph/checkpoint.md section 5a).
  assert.deepEqual([...g.graph.projection.adapters.values()].filter(a => !/^sha256:[0-9a-f]{64}$/.test(a.extractorVersion ?? '')).map(a => a.id), []);
});

test('A RUNTIME STATE DIRECTORY that cannot be read is recorded unavailable with the reason, for the board source and for this one, and states nothing', t => {
  const home = tempRepo(t), empty = tempRepo(t);
  home.commit(HOME_FILES, 'home');
  const g = dependencyGraph({repo: home.repo, ...OPTS, state: {name: 'nothing-here', stateDir: empty.repo}});
  t.after(g.close);
  assert.deepEqual(['ophanim.board', 'ophanim.runtime'].map(id => [g.observed[id].state, typeof g.observed[id].why, g.observed[id].count]), [['unavailable', 'string', null], ['unavailable', 'string', null]]);
  assert.throws(() => dependencyGraph({repo: home.repo, state: {name: 'Bad Name', stateDir: empty.repo}}), /a runtime state has a short lowercase name/);
});

test('A RUNTIME STATE the real controller produced is composed once: Slice B2\'s board source states the obligations and what each depends on, this directory\'s source the attempts on the same nodes, both at the controller commit', async t => {
  const home = tempRepo(t), state = tempRepo(t);
  home.commit(HOME_FILES, 'home');
  const governance = await createGovernance({root: state.repo, fixtureOnly: true, ...(process.env.OPHANIM_TELOS_ROOT ? {telosRoot: process.env.OPHANIM_TELOS_ROOT} : {})});
  await runRuntime({stateDir: state.repo, governance, effectAdapter: createSyntheticDestination(path.join(state.repo, 'destination')), workers: createWorkers({delayMs: 0}), obligations: makeFixtures({count: 1}).obligations});
  const g = dependencyGraph({repo: home.repo, ...OPTS, state: {name: 'proof', stateDir: state.repo}});
  t.after(g.close);
  const version = readRuntimeSnapshot(state.repo).commit.replace(/^commit:/, ''), v = g.graph.view();
  assert.deepEqual(['ophanim.board', 'ophanim.runtime'].map(id => [g.observed[id].recorded, g.observed[id].state, g.observed[id].version]), [[true, 'current', version], [true, 'current', version]]);
  const route = obligationId('pilot-case-001:route'), stated = (from, to) => v.edgesOf(from, {mode: 'recorded'}).filter(e => e.type === 'depends-on' && e.from === from && e.to === to).flatMap(e => e.assertions.map(a => v.assertion(a).source.id));
  assert.deepEqual([stated(route, obligationId('pilot-case-001:normalize')), stated(executionId('proof', 'pilot-case-001:route', 1), route)], [['ophanim.board'], ['ophanim.runtime']]);
  assert.deepEqual([v.node(route).conflicts, v.node(route).assertions.map(a => a.source.id).sort(), v.node(stateId('proof')).established], [[], ['ophanim.board', 'ophanim.runtime'], true]);
});

test('TELOS IS READ AT THE COMMIT THIS REPOSITORY PINS, not at whatever its checkout has moved to; a pin the checkout lacks is said so', t => {
  const home = tempRepo(t), sib = tempRepo(t);
  const pinned = sib.commit(SIBLING_FILES, 'pinned'), later = sib.commit({'lib/c.mjs': 'export const c = 3;\n'}, 'later');
  home.commit({...HOME_FILES, 'ophanim/governance.mjs': `export const TELOS_COMMIT = '${pinned}';\n`}, 'pins telos');
  const g = dependencyGraph({repo: home.repo, ...OPTS, siblings: {telos: {repo: sib.repo}}});
  t.after(g.close);
  assert.notEqual(pinned, later);
  assert.deepEqual([g.observed['sibling.telos.code'].version, g.pinned], [pinned, {telos: {commit: pinned, by: 'ophanim/governance.mjs'}}]);
  home.commit({'ophanim/governance.mjs': `export const TELOS_COMMIT = '${'a'.repeat(40)}';\n`}, 'pins a commit the checkout lacks');
  const lacking = dependencyGraph({repo: home.repo, ...OPTS, siblings: {telos: {repo: sib.repo}}});
  t.after(lacking.close);
  assert.deepEqual(lacking.absent.find(a => a.repository === 'telos'), {repository: 'telos', why: `its checkout does not hold the pinned commit ${'a'.repeat(40)}`});
  assert.equal(lacking.observed['sibling.telos.code'], undefined, 'nothing is read of a sibling at a commit other than the pinned one');
});

test('THE AUDIT COMPARES EACH PINNED DIGEST with the sibling\'s own file at the pinned commit: a match, a difference and a path the sibling lacks are each named; a sibling that was not read is said so', t => {
  const home = tempRepo(t), sib = tempRepo(t), pinned = sib.commit(SIBLING_FILES, 'pinned');
  // B2's pin reader takes a table for TELOS's when the module compares it under telosRoot (extract/pins.mjs governancePins).
  home.commit({...HOME_FILES, 'ophanim/governance.mjs': lines(`export const TELOS_COMMIT = '${pinned}';`, 'export const TELOS_PINS = Object.freeze({',
    `  'lib/a.mjs': '${sha(SIBLING_FILES['lib/a.mjs'])}',`, `  'lib/b.mjs': '${sha('not what the file holds')}',`, `  'lib/gone.mjs': '${sha('x')}',`, '});',
    "for (const [rel, sha] of Object.entries(TELOS_PINS)) if (rawHash(regular(path.join(telosRoot, rel))) !== sha) fail('Pinned TELOS source changed: ' + rel);")}, 'pins');
  const withSibling = dependencyGraph({repo: home.repo, ...OPTS, siblings: {telos: {repo: sib.repo}}}), without = dependencyGraph({repo: home.repo, ...OPTS});
  t.after(withSibling.close); t.after(without.close);
  assert.deepEqual(audit(withSibling.graph.view()).pins, [{repository: 'telos', pinned_commit: pinned, pinned_in: 'ophanim/governance.mjs', read_at: pinned, checked: true, pinned: 3, matching: 1,
    differing: [{path: 'lib/b.mjs', pinned: sha('not what the file holds'), found: sha(SIBLING_FILES['lib/b.mjs'])}], absent: ['lib/gone.mjs']}]);
  assert.deepEqual(audit(without.graph.view()).pins, [], 'with no sibling read, nothing of this directory read the repository: B2\'s pin facts stand as declared');
  assert.deepEqual(needs(withSibling.graph.view(), 'ophanim/governance.mjs').direct.siblings.map(d => d.name),
    ['repository:telos', 'telos:lib/a.mjs', 'telos:lib/b.mjs', 'telos:lib/gone.mjs'], 'what a file needs of another repository is listed apart');
  // The pin facts are B2's and the same with and without the checkout: only the audit's comparison differs.
  const pinFacts = g => g.graph.view().node(fileIdIn('telos', 'lib/b.mjs')).assertions.filter(a => a.source.id === 'ophanim.pins').map(a => g.graph.view().assertion(a.id).record.attributes);
  assert.deepEqual(pinFacts(withSibling), pinFacts(without));
});

test('THE AUDIT DOES NOT COMPARE A PIN with a sibling read at another commit: a checkout named at another ref is read as named, and the pin is said not checked', t => {
  const home = tempRepo(t), sib = tempRepo(t), pinned = sib.commit(SIBLING_FILES, 'pinned');
  const later = sib.commit({'lib/a.mjs': lines("import {b} from './b.mjs';", "export function a() { return b() + 1; }")}, 'later');
  home.commit({...HOME_FILES, 'ophanim/governance.mjs': lines(`export const TELOS_COMMIT = '${pinned}';`, 'export const TELOS_PINS = Object.freeze({',
    `  'lib/a.mjs': '${sha(SIBLING_FILES['lib/a.mjs'])}',`, '});',
    "for (const [rel, sha] of Object.entries(TELOS_PINS)) if (rawHash(regular(path.join(telosRoot, rel))) !== sha) fail('Pinned TELOS source changed: ' + rel);")}, 'pins');
  const g = dependencyGraph({repo: home.repo, ...OPTS, siblings: {telos: {repo: sib.repo, ref: later}}});
  t.after(g.close);
  assert.deepEqual([g.observed['sibling.telos.code'].version, g.pinned], [later, {}], 'a ref given for the checkout is read as given; nothing is pinned by it');
  // lib/a.mjs at the later commit is not the pinned file: compared there, the pin would be reported broken.
  assert.deepEqual(audit(g.graph.view()).pins, [{repository: 'telos', pinned_commit: pinned, pinned_in: 'ophanim/governance.mjs', read_at: later, checked: false, pinned: 1,
    why: 'the sibling was read at another commit than the pinned one'}]);
});

test('A SUBJECT is named the way a person writes it: what Slice B2 names, and also a function, a sibling\'s file and a sibling\'s function', t => {
  const {v} = setup(t);
  assert.deepEqual(['app/main.mjs', 'app/main.mjs#run', 'npm:leftpad@1.0.4', 'package:leftpad', 'env:APP_HOME', 'node:fs', 'telos:lib/a.mjs', 'telos:lib/a.mjs#a', fileId('app/util.mjs')].map(s => subjectOf(v, s).id),
    [fileId('app/main.mjs'), symbolId('app/main.mjs', 'run'), npmPackageId('leftpad', '1.0.4'), npmPackageId('leftpad', '1.0.4'), envId('APP_HOME'), builtinId('fs'), fileIdIn('telos', 'lib/a.mjs'),
      symbolIdIn('telos', 'lib/a.mjs', 'a'), fileId('app/util.mjs')]);
  assert.equal(subjectOf(v, 'app/config/deep/lanes.json').id, fileId('app/config/deep/lanes.json'), 'a path of four segments has the shape of a graph id and is still a path');
  assert.deepEqual([subjectOf(v, 'npm:never-heard-of@1.0.0').error, subjectOf(v, 'app/main.mjs#nothing').error, subjectOf(v, 'telos:lib/nowhere.mjs').error], ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
});

test('WHAT DOES IT NEED: the direct dependencies by kind, each with the relationship, the lines and the source and version that state it', t => {
  const {v, head} = setup(t), r = needs(v, 'app/main.mjs');
  assert.deepEqual(Object.fromEntries(Object.entries(r.direct).map(([k, xs]) => [k, xs.map(x => x.name)])), {
    packages: ['npm:leftpad@1.0.4'], platform: ['node:fs'], environment: ['env:APP_HOME'], programs: [], hosts: [], files: ['app/table.json', 'app/util.mjs'], functions: ['app/util.mjs#helper'], siblings: [], other: []});
  assert.deepEqual(r.direct.packages.map(p => [p.relationship, p.lines, p.stated_by, p.need]), [['depends-on', [2], [{source: 'ophanim.imports', version: head}], 'run-time']], 'B2\'s imports source states the import');
  assert.deepEqual(r.direct.files.map(f => [f.name, f.relationship, f.stated_by.map(s => s.source)]), [['app/table.json', 'consumes', ['ophanim.paths']], ['app/util.mjs', 'depends-on', ['ophanim.repo']]]);
  assert.deepEqual([r.subject, r.cursor], [fileId('app/main.mjs'), v.seq]);
  const run = needs(v, 'app/main.mjs#run');
  assert.deepEqual([run.direct.functions.map(f => [f.name, f.basis, f.stated_by]), run.direct.packages.map(p => [p.name, p.imported])],
    [[['app/util.mjs#helper', 'call', [{source: 'ophanim.calls', version: head}]]], [['npm:leftpad@1.0.4', ['default']]]], 'a function\'s needs are this directory\'s: the calls it makes');
  assert.deepEqual(Object.values(needs(v, 'app/util.mjs').direct).flat(), [], 'what depends ON a file is not what the file needs');
});

test('WHAT NEEDS IT: the dependents of a package, a file and a sibling\'s file, with the advisory class and what the coverage rests on', t => {
  const {v} = setup(t);
  const pkg = neededBy(v, 'package:leftpad');
  assert.deepEqual(pkg.direct.map(d => [d.name, d.stated_by.map(s => s.source)]), [['app/main.mjs', ['ophanim.imports']], ['app/main.mjs#run', ['ophanim.calls']], ['package.json', ['ophanim.packages']]]);
  assert.deepEqual(neededBy(v, 'app/table.json').direct.map(d => d.name), ['app/main.mjs']);
  assert.deepEqual(neededBy(v, 'app/util.mjs').direct.map(d => [d.name, d.through_its ?? null]), [['app/main.mjs', null], ['app/main.mjs#run', 'app/util.mjs#helper']],
    'a file is needed by what imports it and by what calls a function it defines');
  assert.deepEqual([pkg.assessment.blast_radius, pkg.assessment.class, pkg.assessment.advisory, pkg.assessment.coverage], [3, 'medium', true, 'unverified']);
  assert.deepEqual(pkg.coverage.why, ['ophanim: 1 file(s) the parser rejected give no facts']);
  assert.deepEqual(neededBy(v, 'telos:lib/b.mjs').direct.map(d => d.name), ['telos:lib/a.mjs', 'telos:lib/a.mjs#a']);
});

test('THE AUDIT lists, per repository this directory read, what each reading could not state, and the state of every source', t => {
  const {v, head, sibHead} = setup(t), a = audit(v);
  assert.deepEqual(a.repositories.map(r => [r.repository, r.read_at]), [['ophanim', head], ['telos', sibHead]]);
  const home = a.repositories[0];
  assert.deepEqual([home.files_read, home.not_parsed.map(x => x.file), home.counts, home.unresolved], [3, ['app/broken.mjs'], {calls: 2}, {calls: 0}]);
  assert.deepEqual(a.repositories[1].weave, {stated: null, why: 'docs/runs/clotho-self-weave/thread-ledger.snapshot.jsonl is not in the tree at this commit'});
  assert.deepEqual(a.sources.filter(s => OPT_IN(s.id)).map(s => [s.id, s.state]), [['ophanim.calls', 'current'], ['sibling.telos.code', 'current'], ['sibling.telos.code-text', 'current'],
    ['sibling.telos.declared', 'current'], ['sibling.telos.weave', 'current']]);
});
