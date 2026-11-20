// Slice B2 (KD2-8): the dependency questions of Graph B, answered on the REAL graph of this checkout at its HEAD commit,
// each with explained paths, its sources and versions, and the lines the facts were read from: what depends on an
// external package; what a component needs from its environment; which manifest authorized changes to a file and under
// which region limit; what a change to a lockfile entry, to the TELOS pin or to a workflow reaches. No provider, no network.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {answer, impact, needsOf, packageDependents, authorityOf, subjectOf} from './impact.mjs';
import {fileId} from './extract/repo.mjs';
import {workflowId} from './extract/verification.mjs';
import {npmPackageId, envId, executableId, hostId, runtimeId, repositoryId, builtinId} from './extract/code.mjs';
import {telosFileId, runnerId} from './extract/pins.mjs';
import {grantId} from './extract/authority.mjs';
import {realGraph, closeRealGraph, ROOT} from './fixtures/repo.mjs';

after(closeRealGraph);
const HEAD = () => execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
const show = p => execFileSync('git', ['-C', ROOT, 'show', `${HEAD()}:${p}`], {encoding: 'utf8', maxBuffer: 1 << 26});
const ids = xs => xs.map(n => n.id);
const all = r => Object.values(r.affected).flat();
const atCommit = sources => sources.every(s => s.version === HEAD());

test('query: what depends on @google/genai -- the resolved version, its importers (run-time and test apart), its declaration, its reach', () => {
  const g = realGraph(), r = packageDependents(g.graph, '@google/genai');
  const lock = JSON.parse(show('package-lock.json')).packages['pantheon/node_modules/@google/genai'];
  assert.deepEqual(r.packages.map(p => [p.id, p.version, p.integrity]), [[npmPackageId('@google/genai', lock.version), lock.version, lock.integrity]], 'the lockfile\'s resolved version and integrity');
  const run = r.direct.imports['run-time'].shown, test_ = r.direct.imports.test.shown;
  for (const f of ['pantheon/bin/pantheon-build.mjs', 'pantheon/src/sdk/live.mjs']) assert.ok(run.some(x => x.id === fileId(f)), `${f} imports it at run time`);
  assert.ok(test_.some(x => x.id === fileId('pantheon/tests/google-long-decode.test.mjs')) && !run.some(x => /\.test\.mjs$/.test(x.id)), 'a test\'s import is a test need');
  for (const x of [...run, ...test_]) {
    assert.ok(x.lines.length && x.lines.every(n => show(decodeURIComponent(x.id.split('/systems/')[1].split('/').slice(1).join('/'))).split('\n')[n - 1].includes('@google/genai')), `${x.id}: the line names it`);
    assert.ok(x.sources.some(s => s.source === 'ophanim.imports') && atCommit(x.sources), `${x.id}: its source and version`);
  }
  assert.deepEqual(r.direct.declarations.map(d => [d.id, d.declarations[0].declared, d.declarations[0].resolved.version]), [[fileId('pantheon/package.json'), JSON.parse(show('pantheon/package.json')).dependencies['@google/genai'], lock.version]]);
  assert.ok(r.reach.counts.consumers > 0 && r.reach.affected.consumers.shown.every(n => n.via.length > 0), 'the reach, each node with its explained path');
  assert.ok(r.reach.coverage && 'truncated' in r.reach.coverage, 'bounded, with its coverage');
  // Two installed versions of one name are two packages.
  assert.deepEqual(packageDependents(g.graph, '@types/node').packages.map(p => p.version).sort(), ['24.10.1', '26.6.3']);
  assert.equal(subjectOf(g.graph.view(), 'package:@types/node').error, 'AMBIGUOUS');
});

test('query: what a component needs from its environment -- variable names, programs, hosts, files, packages; run-time and test apart', () => {
  const g = realGraph(), r = needsOf(g.graph, 'ophanim/public/github.mjs'), rt = r.needs['run-time'];
  const text = show('ophanim/public/github.mjs').split('\n');
  for (const name of ['GITHUB_TOKEN', 'GITHUB_REPOSITORY']) {
    const x = rt.environment.shown.find(e => e.name === name);
    assert.ok(x && x.lines.every(n => text[n - 1].includes(name)) && x.sources.every(s => s.source === 'ophanim.environment' && s.version === HEAD()), `${name}: by name, with its line, source and version`);
  }
  assert.ok(rt.executables.shown.some(e => e.id === executableId('git')), 'it runs git');
  assert.ok(rt.packages.shown.some(e => e.id === builtinId('child_process')));
  assert.deepEqual(Object.keys(r.needs.test), [], 'a run-time module has no test need');
  assert.ok(!(rt.hosts?.shown ?? []).some(h => h.id === hostId('api.github.com')), 'a host in a constant is not a request\'s URL literal');
  assert.ok(g.graph.view().edgesOf(fileId('ophanim/public/github.mjs'), {mode: 'possible', types: ['mentions']}).some(e => e.to === hostId('api.github.com')), 'it is a mention');
  // Files read by path: cli.mjs reads fixtures.mjs by a path from import.meta.url.
  const cli = needsOf(g.graph, 'ophanim/cli.mjs');
  assert.ok(cli.needs['run-time'].files.shown.some(f => f.id === fileId('ophanim/fixtures.mjs') && f.how.includes('read')));
  // Transitive: the needs of what it imports, each with the path from the subject; bounded.
  const tr = needsOf(g.graph, 'ophanim/operate/cli.mjs', {transitive: true});
  assert.ok(tr.files > 10 && tr.needs['run-time'].environment.shown.some(e => e.path?.length > 0), `${tr.files} files: needs reached through imports carry their path`);
  assert.ok('truncated' in tr.coverage);
});

test('query: which manifest authorized changes to a file, and under which region limit -- quoted; coordinator-only governance', () => {
  const g = realGraph(), r = authorityOf(g.graph, 'ophanim/graph/impact.mjs');
  const own = JSON.parse(show('docs/execution/kg-slice-b2-ownership.json')), mine = r.authorized_by.find(x => x.grant === grantId('docs/execution/kg-slice-b2-ownership.json', 'KGB2', 'agent-kg-slice-b2'));
  assert.deepEqual(mine.region_limits, [{key: 'ophanim/graph/impact.mjs', limit: own.subwaves.KGB2['agent-kg-slice-b2'].region_limits['ophanim/graph/impact.mjs']}], 'the region limit, verbatim');
  assert.deepEqual([mine.wave, mine.authorization, mine.branch], [own.wave, own.authorization, 'kg/slice-b2']);
  assert.ok(mine.sources.every(s => s.source === 'ophanim.authority' && s.version === HEAD()) && /join/.test(mine.join), 'its source, version, and the glob match labelled as a join');
  assert.ok(r.authorized_by.some(x => x.manifest === 'docs/execution/kg-slice-b-ownership.json'), 'Slice B\'s manifest authorized it too');
  const pkg = authorityOf(g.graph, 'package.json');
  assert.ok(pkg.governed_by.some(x => x.manifest === 'docs/execution/kg-slice-b2-ownership.json' && x.entry === 'package.json'), 'coordinator-only: governs');
  assert.ok(pkg.authorized_by.some(x => x.agent === 'agent-3b-lint-ophanim' && x.region_limits.some(l => l.key === 'package.json')), 'an allowed extra, under its region limit');
  assert.equal(authorityOf(g.graph, 'no/such/path.mjs').gaps[0].category, 'authority');
});

test('query: what a change to a lockfile entry, to the TELOS pin, or to a workflow reaches -- explained, sourced, bounded', () => {
  const g = realGraph(), v = g.graph.view();
  const lock = answer(g.graph, 'invalidates', 'lock:package-lock.json#pantheon/node_modules/@google/genai');
  assert.equal(lock.error, undefined, lock.why);
  const live = lock.invalidates.affected.consumers.shown.find(n => n.id === fileId('pantheon/src/sdk/live.mjs'));
  assert.ok(live && live.via[0].type === 'depends-on' && live.via[0].sources.some(s => s.source === 'ophanim.imports'), 'its importer, by an import edge of the imports source');
  assert.ok(lock.coverage && lock.sources.every(s => s.version), 'bounded, with every source\'s version');
  const telos = impact(v, [repositoryId('telos')], {maxNodes: 2000, maxEdges: 20000});
  const gov = all(telos).find(n => n.id === fileId('ophanim/governance.mjs'));
  assert.ok(gov && gov.depth === 1 && gov.via[0].sources.some(s => s.source === 'ophanim.pins'), 'the module that pins it, one hop');
  const pinned = JSON.parse(JSON.stringify(v.node(repositoryId('telos')).attributes));
  assert.equal(pinned.commit, /TELOS_COMMIT = '([0-9a-f]{40})'/.exec(show('ophanim/governance.mjs'))[1]);
  assert.ok(all(telos).some(n => n.id === telosFileId('build-gate/sign.mjs')), 'and each pinned TELOS file');
  assert.ok(all(telos).length > 10 && all(telos).every(n => n.via.length > 0), 'what imports governance.mjs, each with its path');
  // A workflow sets GITHUB_TOKEN from a secret (by name); github.mjs reads it: a change to the workflow reaches the reader.
  const wf = impact(v, [workflowId('.github/workflows/operate.yml')]);
  const reader = all(wf).find(n => n.id === fileId('ophanim/public/github.mjs'));
  assert.ok(reader && reader.via.map(p => p.type).join() === 'produces,consumes', 'through the variable, by name');
  // The workflow's declarations: an action at a mutable tag, its runner, the Node version; package.json's engines.
  const decl = v.edgesOf(workflowId('.github/workflows/qualification.yml')).filter(e => e.type === 'depends-on').map(e => [e.to, v.assertion(e.assertions.find(a => v.assertion(a).record.source.id === 'ophanim.pins') ?? e.assertions[0]).record.attributes]);
  const checkout = decl.find(([to]) => to === repositoryId('github.com/actions/checkout'));
  assert.ok(checkout && checkout[1].declarations[0].ref === 'v4' && /mutable/.test(checkout[1].declarations[0].ref_kind));
  assert.equal(decl.find(([to]) => to === runtimeId('node'))[1].declarations[0].version, /node-version: '([^']+)'/.exec(show('.github/workflows/qualification.yml'))[1]);
  assert.ok(decl.some(([to]) => to === runnerId('ubuntu-24.04')), 'the runner it runs on');
  assert.ok(v.edgesOf(fileId('package.json')).some(e => e.type === 'depends-on' && e.to === runtimeId('node')), 'package.json\'s engines');
  assert.ok(v.edgesOf(repositoryId('ophanim')).some(e => e.type === 'derived-from' && e.to === repositoryId('argo')), 'PROVENANCE.json\'s declared lineage');
  assert.ok(!v.subjects().some(s => s.includes(envId('GITHUB_TOKEN')) && v.query(s, 'recorded').some(a => /ghp_|github_pat_/.test(JSON.stringify(v.assertion(a.id).record)))), 'a secret by name, never a value');
});
