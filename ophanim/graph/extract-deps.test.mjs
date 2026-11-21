// Slice B2 (KD2-1 to KD2-7): the dependency sources of Graph B -- packages and imports, the environment, files read by
// path, pinned external sources, authority (the ownership manifests), the literals' mentions, and the board's
// obligations -- each a registered source read at a commit with its extractor's version. Real data: this checkout at its
// HEAD commit. SYNTHETIC: the temporary repositories below (their own history), and the board (fixtures/board.mjs: this
// container holds none). No provider, no network: hosts are read from code, never contacted. Synthetic keys only.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync, execFileSync} from 'node:child_process';
import {fileId} from './extract/repo.mjs';
import {WITHHELD} from './extract/git.mjs';
import {scanJs, scanPy, codeAt, needOf, npmPackageId, unresolvedPackageId, builtinId, workspacePackageId, envId, executableId, hostId, runtimeId, repositoryId} from './extract/code.mjs';
import {packagesFacts, importsFacts, PACKAGES_ORIGIN, IMPORTS_ORIGIN} from './extract/packages.mjs';
import {environmentFacts, pathsFacts, literalsFacts, ENVIRONMENT_ORIGIN, PATHS_ORIGIN, LITERALS_ORIGIN} from './extract/needs.mjs';
import {pinsFacts, telosFileId, governancePins, GOVERNANCE} from './extract/pins.mjs';
import {authorityFacts, grantId, changeSetId, authorizationId, grantsOf, globOf, AUTHORITY_ORIGIN} from './extract/authority.mjs';
import {boardFacts, boardSource, obligationId, BOARD_ORIGIN} from './extract/board.mjs';
import {sourcesOf, openSystemsGraph, observeAll, ORDER, DEPENDENCY_SOURCES, EXTRACTOR_MODULES, extractorVersionOf, ORIGIN_SPEC} from './extract/index.mjs';
import {impact, needsOf, authorityOf} from './impact.mjs';
import {fixtureBoard} from './fixtures/board.mjs';
import {tempRepo, realGraph, closeRealGraph, git, ROOT, T0} from './fixtures/repo.mjs';

after(closeRealGraph);
const HEAD = () => git(ROOT, 'rev-parse', 'HEAD');
const rels = (drafts, type) => drafts.filter(d => d.type === type);
const edge = (drafts, type, from, to) => drafts.find(d => d.type === type && d.from === from && d.to === to);
const node = (drafts, id) => drafts.find(d => d.entity === id);
// The file at HEAD, untrimmed (line numbers are the file's own).
const show = p => execFileSync('git', ['-C', ROOT, 'show', `${HEAD()}:${p}`], {encoding: 'utf8', maxBuffer: 1 << 26});

// ---- the synthetic repository the negative cases share -----------------------------------------------------------------
const LOCK = {name: 'fixture', lockfileVersion: 3, requires: true, packages: {
  '': {name: 'fixture', workspaces: ['lib'], dependencies: {'left-pad': '^1.0.0'}},
  'lib': {name: '@fixture/lib', version: '1.0.0'},
  'node_modules/@fixture/lib': {resolved: 'lib', link: true},
  'node_modules/left-pad': {version: '1.3.0', resolved: 'https://registry.example.invalid/left-pad/-/left-pad-1.3.0.tgz', integrity: 'sha512-SYNTHETICLEFTPAD'},
}};
const MANIFEST = {schema: 'ophanim.wave-ownership/v1', wave: 'W', base_commit: 'abc1234', authorization: 'synthetic: the fixture\'s own words, quoted',
  coordinator_only: ['package-lock.json'], subwaves: {S: {'agent-a': {branch: 'fixture/a', files: ['src/**', 'lib/index.mjs (the index only)'], region_limits: {'src/a.mjs': 'imports only; nothing else'}}}}};
const A = [
  "import fs from 'node:fs';",
  "import {execFileSync} from 'node:child_process';",
  "import {x} from '@fixture/lib';",
  "import pad from 'left-pad';",
  "import ghost from 'SRC/board/index.mjs';",
  '// process.env.COMMENT_ONLY and https://comment.example.invalid/x and lib/notes.md are only named in this comment',
  "const API = 'https://api.example.invalid/v1';",
  'const doc = `import y from "@fixture/lib/extra"`;',
  'export const token = process.env.FIXTURE_TOKEN;',
  "process.env.CHILD_FLAG = '1';",
  "export const read = () => fs.readFileSync(new URL('../lib/config.json', import.meta.url), 'utf8');",
  "export const hit = () => fetch('https://data.example.invalid/x');",
  "export const head = () => execFileSync('git', ['rev-parse', 'HEAD']);",
  'export const all = {x, pad, ghost, API, doc};', ''].join('\n');
const FILES = {
  'package.json': JSON.stringify({name: 'fixture', private: true, type: 'module', workspaces: ['lib'], dependencies: {'left-pad': '^1.0.0'}}, null, 2),
  'package-lock.json': JSON.stringify(LOCK, null, 2),
  'lib/package.json': JSON.stringify({name: '@fixture/lib', version: '1.0.0', type: 'module', exports: {'.': './index.mjs', './extra': './extra.mjs'}}, null, 2),
  'lib/index.mjs': 'export const x = 1;\n', 'lib/extra.mjs': 'export const y = 2;\n', 'lib/config.json': '{"a": 1}\n', 'lib/notes.md': '# notes\n',
  'lib/board/index.mjs': 'export const board = 1;\n',                // what the alias SRC/board/index.mjs resembles: never its target
  'src/a.mjs': A,
  'tests/a.test.mjs': "import {test} from 'node:test';\ntest('x', () => [process.env.TEST_ONLY_FLAG, process.env.FIXTURE_TOKEN]);\n",
  'docs/execution/x-ownership.json': JSON.stringify(MANIFEST, null, 2),
};
const fixtureRepo = t => { const r = tempRepo(t); return {...r, commit1: r.commit(FILES, 'fixture')}; };

test('deps: every new source is registered with its basis and declares its extractor\'s version (its module and local imports)', async t => {
  assert.deepEqual([PACKAGES_ORIGIN.basis, IMPORTS_ORIGIN.basis, ENVIRONMENT_ORIGIN.basis, PATHS_ORIGIN.basis, LITERALS_ORIGIN.basis, AUTHORITY_ORIGIN.basis, BOARD_ORIGIN.basis],
    ['declared', 'structural', 'structural', 'structural', 'textual', 'declared', 'declared']);
  const b = await fixtureBoard();
  t.after(() => fs.rmSync(b.dir, {recursive: true, force: true}));
  const {sources} = sourcesOf({repo: ROOT, commit: 'HEAD', board: {stateDir: b.stateDir}});
  for (const id of [...DEPENDENCY_SOURCES, 'ophanim.board']) {
    const s = sources.find(x => x.id === id);
    assert.ok(s, `${id} is composed`);
    assert.ok(ORDER.includes(id) && ORIGIN_SPEC[s.extractor], `${id} is in ORDER and its extractor is registered`);
    assert.match(s.extractorVersion ?? '', /^sha256:[0-9a-f]{64}$/, `${id} declares its extractor version`);
    assert.equal(s.extractorVersion, extractorVersionOf(EXTRACTOR_MODULES[id].module), `${id}: the digest of its module closure`);
  }
  assert.ok(DEPENDENCY_SOURCES.every(id => ORDER.indexOf(id) > ORDER.indexOf('ophanim.verification')), 'observed after the sources whose nodes they name');
  assert.ok(ORDER.indexOf('ophanim.packages') < ORDER.indexOf('ophanim.imports'), 'the packages before the imports that resolve to them');
});

test('deps: the real repository at its commit -- every new source current, counts cross-checked against independent readings', t => {
  const g = realGraph(), commit = HEAD(), v = g.graph.view();
  for (const s of DEPENDENCY_SOURCES) assert.deepEqual([g.observed[s].state, g.observed[s].version], ['current', commit], s);
  // packages: one node per installed (name, version) of the two lockfiles, read here from the JSON itself.
  const pk = packagesFacts(ROOT, commit), locks = ['package-lock.json', 'pantheon/package-lock.json'].map(p => JSON.parse(show(p)));
  const installed = new Set(locks.flatMap(l => Object.entries(l.packages).filter(([k, e]) => k.includes('node_modules/') && !e.link && e.version).map(([k, e]) => `${e.name ?? k.slice(k.lastIndexOf('node_modules/') + 13)}@${e.version}`)));
  const nodes = pk.filter(d => d.entity?.includes('/systems/package/npm/') && !d.status).map(d => decodeURIComponent(d.entity.split('/systems/package/npm/')[1]));
  assert.deepEqual(nodes.sort(), [...installed].sort(), 'every installed (name, version) of the lockfiles, and nothing else');
  const manifests = ['package.json', 'packages/graph/package.json', 'packages/ledger/package.json', 'packages/model-client/package.json', 'pantheon/package.json'].map(p => [p, JSON.parse(show(p))]);
  const declared = manifests.flatMap(([p, j]) => ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(f => Object.keys(j[f] ?? {}).map(n => `${p}#${n}`)));
  const declarations = rels(pk, 'depends-on').filter(d => d.attributes.declarations).flatMap(d => d.attributes.declarations.map(x => `${d.from.split('/systems/file/')[1]}#${decodeURIComponent(d.to.split('/package/npm/')[1]).replace(/@[^@]+$/, '')}`));
  assert.deepEqual(declarations.sort(), declared.sort(), 'every declared dependency of the package.json files');
  assert.equal(pk.filter(d => d.entity?.includes('/systems/package/workspace/')).length, JSON.parse(show('package.json')).workspaces.length, 'one node per workspace');
  // imports: the static specifiers each module requests, cross-checked against V8's own module parser.
  const code = codeAt(ROOT, commit), mjs = code.files.filter(f => f.path.endsWith('.mjs'));
  const mine = Object.fromEntries(mjs.map(f => [f.path, [...new Set(f.imports.filter(i => i.kind === 'static' || i.kind === 'export' || i.kind === 'side').map(i => i.specifier))].sort()]));
  const v8 = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', `
    const vm = require('node:vm'), {execFileSync} = require('node:child_process'), out = {};
    for (const p of JSON.parse(process.argv[1])) { const src = execFileSync('git', ['-C', process.argv[2], 'show', process.argv[3] + ':' + p], {encoding: 'utf8', maxBuffer: 1 << 26});
      try { out[p] = [...new Set(new vm.SourceTextModule(src).moduleRequests.map(r => r.specifier))].sort(); } catch (e) { out[p] = 'unparsed'; } }
    process.stdout.write(JSON.stringify(out));`, JSON.stringify(mjs.map(f => f.path)), ROOT, commit], {encoding: 'utf8', maxBuffer: 1 << 26});
  assert.equal(v8.status, 0, v8.stderr);
  const theirs = JSON.parse(v8.stdout), parsed = Object.keys(theirs).filter(p => theirs[p] !== 'unparsed');
  assert.ok(parsed.length > 500, `${parsed.length} modules parsed by V8`);
  assert.deepEqual(Object.fromEntries(parsed.map(p => [p, mine[p]])), Object.fromEntries(parsed.map(p => [p, theirs[p]])), 'the lexer reads exactly the import specifiers V8 reads');
  const builtins = new Set(code.files.flatMap(f => f.imports.filter(i => i.specifier?.startsWith('node:')).map(i => i.specifier.replace(/^node:/, ''))));
  assert.equal(v.subjects().filter(s => s.includes('/systems/package/node/') && !s.includes('(')).length, builtins.size, 'one node per node: built-in imported');
  // environment, paths, literals: every fact names a line that, read independently, carries what it records.
  const lineOf = (p, n) => show(p).split('\n')[n - 1] ?? '';
  const env = environmentFacts(ROOT, commit);
  for (const r of [...rels(env, 'consumes'), ...rels(env, 'produces')]) {
    const name = decodeURIComponent(r.to.split('/environment-variable/')[1]), file = r.ref;
    assert.ok(r.attributes.lines.every(n => new RegExp(`(process\\s*\\.\\s*env\\s*(\\.\\s*${name}\\b|\\[\\s*['"\`]${name}['"\`])|os\\.(environ|getenv)[^\\n]*['"]${name}['"])`).test(lineOf(file, n))), `${file} names ${name} on its lines`);
  }
  for (const r of rels(pathsFacts(ROOT, commit), 'consumes')) {
    const target = decodeURIComponent(r.to.split(/\/systems\/(?:file|module|test)\//)[1]);
    assert.ok(r.attributes.lines.some(n => lineOf(r.ref, n).includes(path.posix.basename(target))), `${r.ref}:${r.attributes.lines} names ${target}`);
  }
  // pins: TELOS's commit and pinned digests are the module's own values.
  const pins = pinsFacts(ROOT, commit), gov = governancePins(show(GOVERNANCE));
  assert.equal(node(pins, repositoryId('telos')).attributes.commit, gov.commit.value);
  const telosTable = gov.tables.find(x => x.root.kind === 'telos');
  assert.deepEqual(pins.filter(d => d.entity?.includes('/telos:')).map(d => [d.attributes.path, d.attributes.sha256]).sort(), telosTable.entries.map(e => [e.rel, e.sha]).sort());
  const uses = ['operate.yml', 'public-record.yml', 'qualification.yml'].flatMap(w => show(`.github/workflows/${w}`).split('\n').filter(l => /^\s*(-\s+)?uses:/.test(l)));
  assert.equal(rels(pins, 'depends-on').filter(d => d.from.includes('/systems/workflow/')).flatMap(d => d.attributes.declarations.filter(x => x.uses)).length, uses.length, 'every uses: line of the workflows');
  // authority: the grants, coordinator-only entries and files entries the manifests' JSON holds.
  const au = authorityFacts(ROOT, commit), mf = git(ROOT, 'ls-tree', '--name-only', commit, 'docs/execution/').split('\n').filter(p => /-ownership\.json$/.test(p)).map(p => [p, JSON.parse(show(p))]);
  assert.equal(au.filter(d => d.entity?.includes('/evidence/authorization/') && d.entity.includes('%23')).length, mf.reduce((n, [, m]) => n + grantsOf(m).length, 0), 'one node per grant');
  assert.equal(rels(au, 'governs').length, mf.reduce((n, [, m]) => n + new Set(m.coordinator_only).size, 0), 'one governs per coordinator_only entry');
  assert.equal(rels(au, 'authorizes').length, mf.reduce((n, [, m]) => n + grantsOf(m).reduce((k, g) => k + new Set([...(g.grant.files ?? []).map(globOf), ...(g.grant.allowed_extra ?? [])]).size, 0), 0), 'one authorizes per files glob or allowed extra');
  const counts = Object.fromEntries([...DEPENDENCY_SOURCES].map(s => [s, g.observed[s].count]));
  t.diagnostic(`dependency sources at ${commit.slice(0, 12)}: ${JSON.stringify(counts)}; installed packages ${installed.size}, built-ins ${builtins.size}, V8-parsed modules ${parsed.length}`);
});

test('deps: a URL, an environment name or a path in a comment is a mention, never a dependency; a literal outside a recognized call is a mention', t => {
  const {repo, commit1} = fixtureRepo(t), a = fileId('src/a.mjs');
  const env = environmentFacts(repo, commit1), paths = pathsFacts(repo, commit1), lit = literalsFacts(repo, commit1), imp = importsFacts(repo, commit1);
  const deps = [...env, ...paths, ...imp].filter(d => d.type);
  for (const id of [envId('COMMENT_ONLY'), hostId('comment.example.invalid'), fileId('lib/notes.md'), hostId('api.example.invalid')]) {
    assert.ok(!deps.some(d => d.to === id), `${id} is no dependency`);
    assert.equal(edge(lit, 'mentions', a, id)?.type, 'mentions', `${id} is a mention of src/a.mjs`);
  }
  assert.deepEqual([...new Set(lit.filter(d => d.type).map(d => d.type))], ['mentions'], 'the literals source admits mentions only');
  assert.deepEqual(edge(lit, 'mentions', a, hostId('api.example.invalid')).attributes.in, ['string']);
  assert.deepEqual(edge(lit, 'mentions', a, envId('COMMENT_ONLY')).attributes.in, ['comment']);
  // What the recognized calls prove.
  assert.ok(edge(env, 'consumes', a, envId('FIXTURE_TOKEN')) && edge(env, 'produces', a, envId('CHILD_FLAG')), 'process.env read, and set for a child');
  assert.ok(edge(env, 'depends-on', a, hostId('data.example.invalid')), 'fetch of a literal URL names its host');
  assert.ok(edge(env, 'depends-on', a, executableId('git')), 'execFileSync of a literal command');
  assert.deepEqual(edge(paths, 'consumes', a, fileId('lib/config.json')).attributes.how, ['read'], 'an fs read of new URL(..., import.meta.url)');
  assert.ok(!imp.some(d => d.type && d.from === a && d.to === fileId('lib/extra.mjs')), 'an import inside a template literal is not an import');
  // The lexer itself: a comment, a string and a regular expression are not code.
  const s = scanJs("const r = /'[a-z]+'/g; // process.env.NOPE\nconst u = 'x // y'; const v = `${process.env.YES}`;\n");
  assert.ok(!/NOPE/.test(s.masked) && /process\.env\.YES/.test(s.masked) && !/x \/\/ y/.test(s.masked));
  assert.deepEqual([...s.strings.values()].map(x => x.value), ['x // y', null]);
  const py = scanPy("import os\n# os.environ['NOPE']\nx = os.environ['YES']\ns = \"os.getenv('NOPE2')\"\n");
  assert.ok(/os\.environ\['   '\]/.test(py.masked) && !/NOPE/.test(py.masked));
});

test('deps: no environment value is read -- a planted synthetic value appears in no fact; only the name does', t => {
  const value = `synthetic-value-${process.pid}-${Date.now()}`;
  process.env.FIXTURE_TOKEN = value; process.env.OPHANIM_FIXTURE_NEVER_SET = value;
  t.after(() => { delete process.env.FIXTURE_TOKEN; delete process.env.OPHANIM_FIXTURE_NEVER_SET; });
  const {repo, commit1} = fixtureRepo(t);
  const g = openSystemsGraph({sources: sourcesOf({repo, commit: commit1, status: null, lessons: false}).sources});
  t.after(g.close);
  const o = observeAll(g.graph, g.by, {observed_at: T0});
  for (const s of DEPENDENCY_SOURCES) assert.equal(o[s].state, 'current', `${s}: ${o[s].why}`);
  const v = g.graph.view(), all = JSON.stringify(v.subjects().flatMap(x => v.query(x, 'recorded').map(a => v.assertion(a.id).record)));
  assert.ok(all.includes('FIXTURE_TOKEN') && !all.includes(value), 'the name is recorded, the value is not');
  assert.ok(!JSON.stringify(environmentFacts(ROOT, HEAD())).includes(value), 'the real repository\'s facts do not carry it either');
});

test('deps: an alias resolves through the workspace or is a gap; the version is the lockfile\'s resolved one, not the declared range', t => {
  const {repo, commit1} = fixtureRepo(t), a = fileId('src/a.mjs');
  const imp = importsFacts(repo, commit1), pk = packagesFacts(repo, commit1);
  assert.match(edge(imp, 'depends-on', a, fileId('lib/index.mjs')).attributes.via, /workspace @fixture\/lib exports "\."/, 'a workspace name resolves to its export');
  assert.match(edge(imp, 'depends-on', a, npmPackageId('left-pad', '1.3.0')).attributes.via, /package-lock\.json#node_modules\/left-pad/);
  const ghost = node(imp, unresolvedPackageId('SRC'));
  assert.deepEqual([ghost.status, ghost.attributes.imported_by], ['unresolved', ['src/a.mjs']], 'an alias nothing resolves is a gap');
  assert.ok(edge(imp, 'depends-on', a, unresolvedPackageId('SRC')), 'the import is kept, to the unresolved node');
  assert.ok(!imp.some(d => d.type && d.from === a && /\/systems\/(module|file)\//.test(d.to) && d.to !== fileId('lib/index.mjs')), 'and is never guessed to a file');
  assert.ok(edge(imp, 'depends-on', a, builtinId('fs')) && edge(imp, 'depends-on', builtinId('fs'), runtimeId('node')), 'a node: built-in is a package of the Node runtime');
  assert.deepEqual([node(pk, npmPackageId('left-pad', '1.3.0')).attributes.version, node(pk, npmPackageId('left-pad', '1.3.0')).attributes.integrity], ['1.3.0', 'sha512-SYNTHETICLEFTPAD']);
  const decl = edge(pk, 'depends-on', fileId('package.json'), npmPackageId('left-pad', '1.3.0')).attributes.declarations[0];
  assert.deepEqual([decl.declared, decl.resolved.version], ['^1.0.0', '1.3.0'], 'the declared range, apart from the resolved version');
  assert.ok(node(pk, workspacePackageId('@fixture/lib')) && edge(pk, 'depends-on', workspacePackageId('@fixture/lib'), fileId('lib/index.mjs')));
  // Real: pantheon declares openai ^7.23.0; the root lockfile resolved 7.23.0.
  const real = packagesFacts(ROOT, HEAD()), openai = edge(real, 'depends-on', fileId('pantheon/package.json'), npmPackageId('openai', '7.23.0'));
  assert.deepEqual([openai.attributes.declarations[0].declared, openai.attributes.declarations[0].resolved.version], ['^7.23.0', '7.23.0']);
});

test('deps: test needs are kept apart from run-time needs', t => {
  const {repo, commit1} = fixtureRepo(t);
  assert.deepEqual(['src/a.mjs', 'tests/a.test.mjs', 'lib/tests/x.mjs', 'pantheon/tests/fixtures/y.mjs', 'x.mutate.mjs'].map(needOf), ['run-time', 'test', 'test', 'test', 'test']);
  const env = environmentFacts(repo, commit1);
  assert.equal(edge(env, 'consumes', fileId('src/a.mjs'), envId('FIXTURE_TOKEN')).attributes.need, 'run-time');
  assert.equal(edge(env, 'consumes', fileId('tests/a.test.mjs'), envId('FIXTURE_TOKEN')).attributes.need, 'test', 'the same variable, read by a test: a separate fact');
  const g = openSystemsGraph({sources: sourcesOf({repo, commit: commit1, status: null, lessons: false}).sources});
  t.after(g.close);
  observeAll(g.graph, g.by, {observed_at: T0});
  const run = needsOf(g.graph, 'src/a.mjs'), tst = needsOf(g.graph, 'tests/a.test.mjs');
  assert.deepEqual(run.needs['run-time'].environment.shown.map(x => x.name).sort(), ['CHILD_FLAG', 'FIXTURE_TOKEN']);
  assert.deepEqual(Object.keys(run.needs.test), [], 'no test need of a run-time file');
  assert.deepEqual([Object.keys(tst.needs['run-time']), tst.needs.test.environment.shown.map(x => x.name).sort()], [[], ['FIXTURE_TOKEN', 'TEST_ONLY_FLAG']]);
  // Real: a fixture's variables are test needs only.
  const real = environmentFacts(ROOT, HEAD());
  const fake = [...rels(real, 'consumes'), ...rels(real, 'produces')].filter(d => d.to.includes('/environment-variable/FAKE_'));
  assert.ok(fake.length > 10 && fake.every(d => d.attributes.need === 'test'), `${fake.length} FAKE_* reads and writes, every one a test need`);
});

test('deps: a manifest\'s grants, region limits and coordinator-only paths are recorded as quoted', t => {
  const {repo, commit1} = fixtureRepo(t), au = authorityFacts(repo, commit1);
  const m = 'docs/execution/x-ownership.json', grant = node(au, grantId(m, 'S', 'agent-a'));
  assert.deepEqual([grant.attributes.files, grant.attributes.region_limits], [MANIFEST.subwaves.S['agent-a'].files, MANIFEST.subwaves.S['agent-a'].region_limits], 'quoted');
  assert.equal(node(au, authorizationId(m)).attributes.authorization, MANIFEST.authorization);
  assert.deepEqual(edge(au, 'authorizes', grantId(m, 'S', 'agent-a'), changeSetId('src/**')).attributes.region_limits, ['src/a.mjs']);
  assert.ok(edge(au, 'governs', authorizationId(m), changeSetId('package-lock.json')));
  const g = openSystemsGraph({sources: sourcesOf({repo, commit: commit1, status: null, lessons: false}).sources});
  t.after(g.close);
  observeAll(g.graph, g.by, {observed_at: T0});
  const a = authorityOf(g.graph, 'src/a.mjs');
  assert.deepEqual(a.authorized_by.map(x => [x.agent, x.region_limits]), [['agent-a', [{key: 'src/a.mjs', limit: 'imports only; nothing else'}]]]);
  assert.deepEqual(authorityOf(g.graph, 'lib/index.mjs').authorized_by.map(x => x.entries), [['lib/index.mjs (the index only)']], 'the entry with its words');
  assert.deepEqual(authorityOf(g.graph, 'package-lock.json').governed_by.map(x => x.entry), ['package-lock.json']);
  assert.equal(authorityOf(g.graph, 'lib/notes.md').gaps[0].category, 'authority', 'a path no manifest names: a gap');
  // Real: this slice's own manifest, its region limit for impact.mjs, verbatim.
  const real = authorityFacts(ROOT, HEAD()), own = JSON.parse(show('docs/execution/kg-slice-b2-ownership.json')).subwaves.KGB2['agent-kg-slice-b2'];
  assert.deepEqual(node(real, grantId('docs/execution/kg-slice-b2-ownership.json', 'KGB2', 'agent-kg-slice-b2')).attributes.region_limits, own.region_limits);
});

test('deps: the working tree is never read -- a change in the working tree only is absent from every new source', t => {
  const {repo, write, commit1} = fixtureRepo(t);
  write({'src/a.mjs': `${A}\nexport const w = process.env.WORKTREE_ONLY ?? fetch('https://worktree.example.invalid/');\n`,
    'package-lock.json': JSON.stringify({...LOCK, packages: {...LOCK.packages, 'node_modules/left-pad': {...LOCK.packages['node_modules/left-pad'], version: '9.9.9'}}}),
    'docs/execution/x-ownership.json': JSON.stringify({...MANIFEST, coordinator_only: ['src/**']}), 'lib/untracked.mjs': 'export const u = process.env.UNTRACKED;\n'});
  const all = JSON.stringify([packagesFacts, importsFacts, environmentFacts, pathsFacts, literalsFacts, pinsFacts, authorityFacts].flatMap(f => f(repo, commit1)));
  for (const s of ['WORKTREE_ONLY', 'worktree.example.invalid', '9.9.9', 'UNTRACKED', 'lib/untracked.mjs']) assert.ok(!all.includes(s), `${s} is the working tree's, not the commit's`);
  const au = authorityFacts(repo, commit1), m = authorizationId('docs/execution/x-ownership.json');
  assert.ok(edge(au, 'governs', m, changeSetId('package-lock.json')) && !edge(au, 'governs', m, changeSetId('src/**')), 'the commit\'s manifest, not the working tree\'s');
  assert.ok(all.includes('left-pad@1.3.0'), 'the commit\'s lockfile');
});

test('deps: the board\'s obligations through its own reader, read only (SYNTHETIC board: this container holds none)', async t => {
  const b = await fixtureBoard();
  t.after(() => fs.rmSync(b.dir, {recursive: true, force: true}));
  const digestDir = dir => createHash('sha256').update(fs.readdirSync(dir, {recursive: true}).sort().map(f => { const p = path.join(dir, f); return fs.statSync(p).isFile() ? `${f}:${createHash('sha256').update(fs.readFileSync(p)).digest('hex')}` : f; }).join('\n')).digest('hex');
  const before = digestDir(b.stateDir), s = boardSource({stateDir: b.stateDir}), version = s.current().version, facts = s.readAt(version);
  assert.deepEqual(facts.filter(d => d.entity).map(d => d.attributes.id).sort(), b.obligations, 'every obligation');
  assert.deepEqual(rels(facts, 'depends-on').map(d => [decodeURIComponent(d.from.split('/obligation/')[1]), decodeURIComponent(d.to.split('/obligation/')[1])]).sort(), b.edges, 'every dependsOn');
  assert.equal(digestDir(b.stateDir), before, 'the board is byte for byte as it was');
  assert.ok(!JSON.stringify(facts).includes(b.stateDir) && !JSON.stringify(facts).includes('synthetic-input-value'), 'no absolute path, no input value');
  assert.deepEqual(node(facts, obligationId('plan')).attributes.input_names, ['seed'], 'input NAMES only');
  const absent = path.join(os.tmpdir(), `ophanim-graph-b2-no-board-${process.pid}-${Date.now()}`);
  assert.throws(() => boardSource({stateDir: absent}).current(), /no board/);
  assert.equal(fs.existsSync(absent), false, 'nothing is created where no board is');
  assert.throws(() => boardFacts(b.stateDir, 'f'.repeat(64)), /not in the store|Runtime/, 'a commit the board does not hold is refused');
  const g = openSystemsGraph({sources: [{...boardSource({stateDir: b.stateDir}), extractorVersion: extractorVersionOf(EXTRACTOR_MODULES['ophanim.board'].module)}]});
  t.after(g.close);
  const o = g.graph.observe('ophanim.board', {...g.by, observed_at: T0});
  assert.deepEqual([o.recorded, o.state, o.record.source.version], [true, 'current', version]);
  const r = impact(g.graph.view(), [obligationId('plan')]);
  assert.deepEqual(r.affected.work.map(n => n.id).sort(), [obligationId('build'), obligationId('ship')], 'a change to an obligation reaches what depends on it');
});

test('deps: no fact names a withheld path; impact follows consumes (a file read by path reaches its reader)', t => {
  const v = realGraph().graph.view();
  assert.ok(!v.subjects().some(s => WITHHELD.test(decodeURIComponent(s))), 'no subject');
  const facts = JSON.stringify([environmentFacts, pathsFacts, literalsFacts, importsFacts].flatMap(f => f(ROOT, HEAD())));
  assert.ok(!/findings-/.test(facts), 'no fact text names a withheld path');
  const {repo, commit1} = fixtureRepo(t);
  const g = openSystemsGraph({sources: sourcesOf({repo, commit: commit1, status: null, lessons: false}).sources});
  t.after(g.close);
  observeAll(g.graph, g.by, {observed_at: T0});
  const r = impact(g.graph.view(), [fileId('lib/config.json')]);
  assert.ok(r.affected.consumers.some(n => n.id === fileId('src/a.mjs') && n.via[0].type === 'consumes'), 'consumes carries the change to the reader');
  const e = impact(g.graph.view(), [envId('CHILD_FLAG')]);
  assert.deepEqual(e.affected.consumers.map(n => n.id), [], 'a variable nothing reads reaches no reader');
});
