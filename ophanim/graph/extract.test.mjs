// Slice B, KB1: the REAL extractors -- the repository at a commit, its declared verification (mutation runners read as
// text), the register's records as mentions, and the ledgers read only against pinned anchors -- as registered origins
// whose facts are authoritative only by observing a source at a version. Real data: this checkout at its HEAD commit and
// its status ledger. SYNTHETIC: the temporary repositories below, and the work and cycle ledgers (fixtures/ledgers.mjs:
// this container holds none). No provider, synthetic keys only.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {closure, entityId, idRefusal} from '../../packages/graph/index.mjs';
import {repoFacts, repoSource, SPEC, fileId, symbolId, contractId, ticketId, itemId, changeId, REPO_ORIGIN} from './extract/repo.mjs';
import {verificationFacts, mutationTable, mutationId, suiteId, workflowId, RUNNER} from './extract/verification.mjs';
import {recordsFacts, recordId, RECORDS_ORIGIN, registerEntries} from './extract/records.mjs';
import {statusSource, workSource, cycleSource, readStatusLedger, STATUS_ANCHOR, itemId as statusItem} from './extract/ledgers.mjs';
import {sourcesOf, openSystemsGraph, observeAll, ORIGIN_SPEC} from './extract/index.mjs';
import {treeAt, WITHHELD} from './extract/git.mjs';
import {fixtureWorkLedger, fixtureCycleLedger} from './fixtures/ledgers.mjs';
import {tempRepo, realGraph, closeRealGraph, git, ROOT, T0, at, PACKAGE, LIB_PACKAGE, WORKFLOW} from './fixtures/repo.mjs';

after(closeRealGraph);
const HEAD = () => git(ROOT, 'rev-parse', 'HEAD');
const rels = (drafts, type) => drafts.filter(d => d.type === type);
const has = (drafts, type, from, to) => drafts.some(d => d.type === type && d.from === from && d.to === to);

test('extract: the repository is read at a commit, never the working tree', t => {
  const {repo, commit, write} = tempRepo(t);
  const c1 = commit({'lib/a.mjs': "import {b} from './b.mjs';\nexport const a = b + 1;\n", 'lib/b.mjs': 'export const b = 1;\n', 'lib/c.mjs': 'export const c = 2;\n',
    'tests/a.test.mjs': "import {test} from 'node:test';\nimport {a} from '../lib/a.mjs';\ntest('a is two', () => {});\n"}, 'first');
  // The working tree moves on without a commit: a.mjs now imports c.mjs, a new untracked file, a deleted test.
  write({'lib/a.mjs': "import {c} from './c.mjs';\nexport const a = c;\n", 'lib/d.mjs': 'export const d = 4;\n', 'tests/a.test.mjs': null});
  const facts = repoFacts(repo, c1);
  assert.ok(has(facts, 'depends-on', fileId('lib/a.mjs'), fileId('lib/b.mjs')), 'the import at the commit');
  assert.ok(!has(facts, 'depends-on', fileId('lib/a.mjs'), fileId('lib/c.mjs')), 'not the working tree\'s import');
  assert.ok(has(facts, 'consumes', fileId('lib/a.mjs'), symbolId('lib/b.mjs', 'b')), 'a named import consumes the exported symbol');
  assert.ok(has(facts, 'depends-on', fileId('tests/a.test.mjs'), fileId('lib/a.mjs')), 'the test deleted from the working tree is still the commit\'s');
  assert.ok(!facts.some(d => d.entity === fileId('lib/d.mjs')), 'an untracked file is not in the commit');
  const a = facts.find(d => d.entity === fileId('lib/a.mjs'));
  assert.equal(a.attributes.blob, git(repo, 'rev-parse', `${c1}:lib/a.mjs`), 'the blob is the commit\'s object');
  assert.deepEqual(facts.find(d => d.entity === fileId('tests/a.test.mjs')).attributes.cases, ['a is two']);
  // Observed through the registered extractor, the version is the commit; a commit later moves it, and replay re-derives both.
  const g = openSystemsGraph({sources: [repoSource({repo})]});
  t.after(g.close);
  const o1 = g.graph.observe('ophanim.repo', {...g.by, observed_at: T0});
  assert.deepEqual([o1.recorded, o1.record.source.version], [true, c1]);
  const c2 = commit({}, 'commit the working tree');
  const o2 = g.graph.observe('ophanim.repo', {...g.by, observed_at: at(1)});
  assert.deepEqual([o2.record.attributes.from_version, o2.record.source.version], [c1, c2]);
  assert.ok(o2.event.relationships.includes(`depends-on(${fileId('lib/a.mjs')} -> ${fileId('lib/c.mjs')})`));
  assert.ok(g.graph.view(o1.seq).established(g.graph.view(o1.seq).edgesOf(fileId('lib/a.mjs')).find(e => e.to === fileId('lib/b.mjs')).assertions[0]), 'the earlier commit\'s edge stays viewable as of its cursor');
  const again = g.open();
  assert.deepEqual([again.digest(), again.verification.complete], [g.graph.digest(), true], 'a replay re-derives both commits from git');
});

test('extract: the import regex is ophanim/ledger/layering.test.mjs\'s', () => {
  const text = fs.readFileSync(path.join(ROOT, 'ophanim/ledger/layering.test.mjs'), 'utf8');
  const m = /^const SPEC = \/(.+)\/g;$/m.exec(text);
  assert.ok(m, 'the layering test names SPEC');
  assert.equal(SPEC.source, m[1]);
  assert.equal(REPO_ORIGIN.basis, 'structural');
});

test('extract: the real repository at its commit -- files, modules, tests, symbols, imports, contracts, commits; withheld paths counted, never read', t => {
  const g = realGraph(), v = g.graph.view(), commit = HEAD();
  assert.equal(g.commit, commit);
  for (const s of ['ophanim.repo', 'ophanim.verification', 'ophanim.records', 'ophanim.status', 'ophanim.lessons']) assert.equal(g.observed[s].state, 'current', s);
  for (const s of ['ophanim.repo', 'ophanim.verification', 'ophanim.records']) assert.equal(g.observed[s].version, commit, `${s} is at the commit`);
  const repoNode = v.node(entityId({domain: 'systems', type: 'repository', key: 'ophanim'}));
  const tree = git(ROOT, 'ls-tree', '-r', '--name-only', commit).split('\n').filter(Boolean);
  assert.equal(repoNode.attributes.files + repoNode.attributes.withheld.count, tree.length, 'every path of the tree is a node or counted as withheld');
  assert.equal(repoNode.attributes.withheld.count, tree.filter(p => WITHHELD.test(p)).length);
  assert.ok(!v.subjects().some(s => /findings-/.test(decodeURIComponent(s))), 'no fact names a withheld path');
  // Real edges a reader can check by hand.
  const ctx = fileId('ophanim/operate/context.mjs');
  assert.ok(v.edgesOf(ctx).some(e => e.type === 'depends-on' && e.from === fileId('ophanim/operate/context.test.mjs')), 'context.test.mjs imports context.mjs');
  assert.ok(v.edgesOf(symbolId('ophanim/operate/context.mjs', 'makeRetriever')).some(e => e.type === 'consumes' && e.from === fileId('ophanim/operate/stages.mjs')), 'stages.mjs imports makeRetriever');
  assert.ok(v.edgesOf(contractId('ophanim.graph/v1')).some(e => e.type === 'implements' && e.from === symbolId('packages/graph/schema.mjs', 'GRAPH_SCHEMA')));
  assert.ok(v.edgesOf(ticketId('co1-readability')).some(e => e.type === 'implements' && e.from === fileId('ophanim/efficiency/investigation/chairs.mjs')), 'the ticket\'s slot implements it');
  assert.ok(v.edgesOf(ticketId('co1-readability')).some(e => e.type === 'depends-on' && e.to === itemId('co1-readability')));
  assert.ok(v.edgesOf(fileId('ophanim/operate/context.mjs')).some(e => e.type === 'derived-from' && e.to === changeId(git(ROOT, 'log', '-1', '--format=%H', '--', 'ophanim/operate/context.mjs'))),
    'the last commit that changed it is one it is derived from');
  const endOf = s => /^[a-z-]+\((\S+) -> /.exec(s)?.[1] ?? s;
  assert.deepEqual(v.subjects().filter(s => idRefusal(endOf(s)) !== null), [], 'every subject is a registered id');
  const by = Object.fromEntries(Object.entries(g.observed).map(([k, x]) => [k, x.count]));
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  const t0 = process.hrtime.bigint(), again = g.open(), replay = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.deepEqual([again.digest(), again.verification.complete], [g.graph.digest(), true], 'a fresh replay re-derives the same projection');
  t.diagnostic(`real graph at ${commit.slice(0, 12)}: ${total} facts ${JSON.stringify(by)}; observe ms ${JSON.stringify(Object.fromEntries(Object.entries(g.observed).map(([k, x]) => [k, Math.round(x.ms)])))}; replay (fresh open, git readings cached in this process) ${Math.round(replay)} ms (${(replay * 1000 / total).toFixed(1)} µs a fact)`);
});

test('extract: mutation runners are read as TEXT, never imported -- every committed runner\'s mutations, targets and deciding tests', t => {
  // A canary runner: importing or running it writes a marker file. Reading it must not.
  const {repo, commit} = tempRepo(t), marker = path.join(os.tmpdir(), `ophanim-graph-b-canary-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, {force: true}));
  const canary = [`import fs from 'node:fs';`, `fs.writeFileSync(${JSON.stringify(marker)}, 'the runner ran');`,
    `const TARGET = 'lib/a.mjs', SUITE = 'tests/a.test.mjs';`, 'const one = (file, from, to) => ({file, from, to});',
    'export const MUTATIONS = [', "  {id: 'C1', what: 'a canary', tests: [SUITE], edits: [one(TARGET, 'x', 'y')]},", '];', ''].join('\n');
  const c = commit({'lib/a.mjs': 'export const x = 1;\n', 'tests/a.test.mjs': "import {x} from '../lib/a.mjs';\n", 'tests/canary.mutate.mjs': canary, 'package.json': PACKAGE,
    'lib/package.json': LIB_PACKAGE, '.github/workflows/q.yml': WORKFLOW}, 'canary');
  const facts = verificationFacts(repo, c);
  assert.equal(fs.existsSync(marker), false, 'the runner was not executed');
  const m = mutationId('tests/canary.mutate.mjs', 'C1');
  assert.ok(facts.some(d => d.entity === m && d.attributes.what === 'a canary'));
  assert.ok(has(facts, 'depends-on', m, fileId('lib/a.mjs')) && has(facts, 'depends-on', m, fileId('tests/a.test.mjs')));
  assert.ok(has(facts, 'verifies', fileId('tests/a.test.mjs'), fileId('lib/a.mjs')), 'the deciding test verifies the edited file, as the runner declares');
  // Every runner of this checkout, at its commit: the count read as text equals the count the runner states of itself
  // in its own no-run mode (`--check`, which exits before any mutation is applied) -- read here as the cross-check only.
  const runners = treeAt(ROOT, HEAD()).entries.filter(e => RUNNER.test(e.path));
  let mutations = 0;
  for (const r of runners) {
    const table = mutationTable(git(ROOT, 'show', `HEAD:${r.path}`));
    const own = spawnSync(process.execPath, [path.join(ROOT, r.path), '--check'], {cwd: ROOT, encoding: 'utf8'});
    assert.equal(own.status, 0, `${r.path} --check: ${own.stderr}`);
    assert.equal(table.mutations.length, Number(/(\d+) mutation/.exec(own.stdout)[1]), `${r.path}: every mutation the runner lists is read`);
    assert.equal(new Set(table.mutations.map(x => x.id)).size, table.mutations.length, `${r.path}: ids read once`);
    for (const x of table.mutations) {
      assert.ok(x.files.length > 0, `${r.path} ${x.id}: its target file is read`);
      assert.ok(x.tests.length > 0 && x.tests.every(f => /\.test\.mjs$/.test(f)), `${r.path} ${x.id}: its deciding test files are read`);
    }
    mutations += table.mutations.length;
  }
  const g1 = mutationTable(git(ROOT, 'show', 'HEAD:packages/graph/tests/graph.mutate.mjs')).mutations.find(x => x.id === 'G1');
  assert.deepEqual([g1.files, g1.tests], [['packages/graph/schema.mjs'], ['packages/graph/tests/ledger.test.mjs', 'packages/graph/tests/schema.test.mjs']], 'helper calls are evaluated as text');
  const k3 = mutationTable(git(ROOT, 'show', 'HEAD:ophanim/operate/wave3-evidence.mutate.mjs')).mutations.find(x => x.id === 'K3');
  assert.deepEqual([k3.what, k3.files, k3.tests], ['the status comparison is dropped for review', ['ophanim/operate/gates.mjs'], ['ophanim/operate/wave3-wake.test.mjs']], 'a generated family is expanded as text');
  t.diagnostic(`${runners.length} runners, ${mutations} mutations read as text, each with its target and deciding tests`);
});

test('extract: suites and workflows through the gate\'s own reader at the commit', () => {
  const v = realGraph().graph.view();
  const proof = suiteId('test:proof');
  assert.ok(v.edgesOf(proof).some(e => e.type === 'depends-on' && e.to === fileId('ophanim/graph/lessons.test.mjs')), 'test:proof runs the lessons adapter\'s test');
  assert.ok(v.edgesOf(proof).some(e => e.type === 'derived-from' && e.to === fileId('package.json')));
  const q = workflowId('.github/workflows/qualification.yml');
  assert.ok(v.edgesOf(q).some(e => e.type === 'depends-on' && e.to === proof), 'qualification.yml runs test:proof');
  assert.ok(v.edgesOf(suiteId('test:@argo/graph')).some(e => e.type === 'depends-on' && e.to === fileId('packages/graph/tests/schema.test.mjs')));
  const g1 = mutationId('packages/graph/tests/graph.mutate.mjs', 'G1');
  assert.ok(v.edgesOf(g1).some(e => e.type === 'depends-on' && e.to === fileId('packages/graph/schema.mjs')));
  assert.ok(v.edgesOf(fileId('packages/graph/schema.mjs')).some(e => e.type === 'verifies' && e.from === fileId('packages/graph/tests/schema.test.mjs')));
  assert.equal(v.node(g1).attributes.result, null, 'a mutation result is not in the repository and is not claimed');
});

test('extract: the register\'s ids are mentions, never dependencies; an id no entry defines is unresolved', t => {
  const g = realGraph(), v = g.graph.view();
  assert.equal(RECORDS_ORIGIN.basis, 'textual');
  const facts = recordsFacts(ROOT, g.commit), relTypes = new Set(facts.filter(d => d.type).map(d => d.type));
  assert.deepEqual([...relTypes], ['mentions'], 'every relationship of the records source is a mention');
  assert.equal(g.observed['ophanim.records'].state, 'current');
  const reg = registerEntries(git(ROOT, 'show', `${g.commit}:docs/OPEN-LIMITATIONS.md`));
  assert.ok(reg.has('L-504') && reg.has('KG-1'));
  const ctx = fileId('ophanim/operate/context.mjs');
  const cites = v.edgesOf(ctx, {mode: 'possible'}).filter(e => e.type === 'mentions' && e.from === ctx).map(e => e.to);
  assert.ok(cites.includes(recordId('L-504')), 'context.mjs cites L-504');
  // A mention is not followed by impact: the cited entry is not in the reverse closure of the file it is cited in.
  const reach = closure(v, ctx, {depth: 2, maxNodes: 2000, maxEdges: 20000}).nodes.map(n => n.id);
  assert.ok(!reach.some(id => id.includes('/evidence/record/register/')), 'no register entry is a dependent of the file that cites it');
  // An id cited by code but not an entry of the register: recorded unresolved (a synthetic repository).
  const {repo, commit} = tempRepo(t);
  const c = commit({'docs/OPEN-LIMITATIONS.md': '# r\n\n| ID | Item | Status |\n|---|---|---|\n| L-900 | names `lib/a.mjs` | open |\n', 'lib/a.mjs': '// see L-900 and L-901\nexport const a = 1;\n'});
  const f = recordsFacts(repo, c);
  assert.ok(has(f, 'mentions', recordId('L-900'), fileId('lib/a.mjs')) && has(f, 'mentions', fileId('lib/a.mjs'), recordId('L-900')));
  const ghost = f.find(d => d.entity === recordId('L-901'));
  assert.deepEqual([ghost.status, ghost.attributes.cited_by], ['unresolved', ['lib/a.mjs']]);
});

test('extract: the status ledger is read ONLY, against its pinned anchor; an absent or foreign ledger is refused and nothing is created', t => {
  const root = path.join(ROOT, 'status/ledger');
  const digestDir = dir => createHash('sha256').update(fs.readdirSync(dir, {recursive: true}).sort().map(f => { const p = path.join(dir, f); return fs.statSync(p).isFile() ? `${f}:${createHash('sha256').update(fs.readFileSync(p)).digest('hex')}` : f; }).join('\n')).digest('hex');
  const before = digestDir(root);
  const s = statusSource({root}), version = s.current().version, facts = s.readAt(version);
  const S = readStatusLedger({root, anchor: STATUS_ANCHOR}), board = S.board();
  assert.equal(version, board.head);
  assert.equal(facts.filter(d => d.entity?.includes('/work/item/') && d.status !== 'unresolved').length, board.items.length);
  assert.equal(facts.filter(d => d.entity?.includes('/evidence/record/status/')).length, S.ledger.read().filter(e => e.kind === 'status').length, 'one record per status entry');
  assert.ok(has(facts, 'depends-on', statusItem('p8-p9-admission'), statusItem('k6')));
  assert.equal(digestDir(root), before, 'the status ledger is byte for byte as it was');
  // Absent: refused, and the root is not created. Foreign: refused.
  const absent = path.join(os.tmpdir(), `ophanim-graph-b-no-ledger-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(absent, {recursive: true, force: true}));
  assert.throws(() => statusSource({root: absent}).current(), /no status ledger/);
  assert.equal(fs.existsSync(absent), false, 'nothing is created where no ledger is');
  assert.throws(() => statusSource({root, anchor: 'sha256:' + '0'.repeat(64)}).current(), /not the one the caller pinned/);
  // Observed as a source: the absent one is recorded unavailable, visibly.
  const g = openSystemsGraph({sources: [statusSource({root: absent})]});
  t.after(g.close);
  const o = g.graph.observe('ophanim.status', {...g.by, observed_at: T0});
  assert.deepEqual([o.recorded, o.state], [true, 'unavailable']);
  assert.equal(fs.existsSync(absent), false);
});

test('extract: the work and cycle ledgers through their own readers, read only (SYNTHETIC fixtures: this container holds none)', async t => {
  const w = fixtureWorkLedger(), c = await fixtureCycleLedger();
  t.after(() => { fs.rmSync(w.dir, {recursive: true, force: true}); fs.rmSync(c.dir, {recursive: true, force: true}); });
  const {sources} = sourcesOf({repo: ROOT, commit: 'HEAD', work: {root: w.root, anchor: w.anchor}, cycle: {root: c.root, anchor: c.anchor}, lessons: false});
  const g = openSystemsGraph({sources: sources.filter(s => ['ophanim.status', 'ophanim.work', 'ophanim.cycle'].includes(s.id))});
  t.after(g.close);
  const o = observeAll(g.graph, g.by, {observed_at: T0});
  for (const s of ['ophanim.status', 'ophanim.work', 'ophanim.cycle']) assert.equal(o[s].state, 'current', s);
  const hexOf = h => h.replace(/^sha256:/, '');
  const v = g.graph.view(), stage = entityId({domain: 'work', type: 'execution', key: hexOf(w.plan)});
  assert.ok(v.edgesOf(stage).some(e => e.type === 'depends-on' && e.to === itemId('co1-readability')), 'the stage record names its item');
  assert.equal(v.node(itemId('co1-readability')).assertions.length, 2, 'the item is stated by the status ledger and by the work ledger');
  const review = entityId({domain: 'work', type: 'review', key: hexOf(c.cycle)}), finding = entityId({domain: 'learning', type: 'finding', key: hexOf(c.finding)});
  assert.equal(v.node(review).attributes.reviews.length, 3);
  assert.equal(v.node(finding).attributes.resolution.status, 'deferred');
  assert.ok(v.edgesOf(finding).some(e => e.type === 'derived-from' && e.to === review));
  assert.throws(() => workSource({root: w.root, anchor: 'sha256:' + '1'.repeat(64)}).current(), /not the one the caller pinned/);
  assert.equal(fs.existsSync(path.join(w.root, 'keys')), false, 'the reader created no key');
});

test('extract: demonstration 12 at this level -- an unregistered extractor, a broken reference and a stale record are refused or marked unresolved', t => {
  const {repo, commit} = tempRepo(t);
  const c1 = commit({'lib/a.mjs': "import {z} from './missing.mjs';\nexport const a = 1;\n", 'tickets/x.json': JSON.stringify({schema: 'ophanim.ticket/v1', item: 'x', path: 'lib/gone.mjs', copy: []})});
  // An extractor that is not registered: its observation is refused at the write, and nothing is admitted.
  const rogue = {...repoSource({repo}), extractor: 'ophanim.unregistered'};
  const g = openSystemsGraph({sources: [rogue]});
  t.after(g.close);
  assert.throws(() => g.graph.observe('ophanim.repo', {...g.by, observed_at: T0}), e => e.code === 'GRAPH_REFUSED' && /origin "ophanim.unregistered" is not registered/.test(e.message));
  assert.deepEqual([g.graph.view().stats().current, g.graph.projection.seq], [0, 0], 'nothing was written');
  // A registered extractor that is not registered FOR this source: recorded stale, with why, and no fact admitted.
  const misfiled = {...repoSource({repo}), extractor: 'ophanim.records.extractor'};
  const m = openSystemsGraph({sources: [misfiled]});
  t.after(m.close);
  assert.throws(() => m.graph.observe('ophanim.repo', {...m.by, observed_at: T0}), /does not project source|only the registered extractor/);
  assert.equal(m.graph.view().stats().current, 0);
  // A broken reference is never an edge to nothing: an unresolved import and a ticket path the tree lacks are listed.
  const facts = repoFacts(repo, c1);
  assert.deepEqual(facts.find(d => d.entity === fileId('lib/a.mjs')).attributes.unresolved_imports, ['./missing.mjs']);
  assert.ok(!facts.some(d => d.type === 'implements' && d.to === ticketId('x')), 'no slot edge to a path the tree lacks');
  assert.deepEqual(facts.find(d => d.entity === ticketId('x')).attributes.unresolved_paths, ['lib/gone.mjs']);
  // A stale record: the source moved after it was observed; freshness says so until it is observed again.
  const h = openSystemsGraph({sources: [repoSource({repo})]});
  t.after(h.close);
  h.graph.observe('ophanim.repo', {...h.by, observed_at: T0});
  commit({'lib/b.mjs': 'export const b = 2;\n'}, 'moves on');
  assert.equal(h.graph.freshness()[0].state, 'stale');
  assert.equal(Object.keys(ORIGIN_SPEC).includes('ophanim.unregistered'), false);
});
