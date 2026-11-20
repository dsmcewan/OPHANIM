// What this repository pins from outside itself (ophanim/graph/deps/pins.mjs): the TELOS commit and file digests that
// ophanim/governance.mjs declares, the ARGO lineage PROVENANCE.json records, and the actions and Node version the CI
// workflows and package.json name. SYNTHETIC: every repository below is a temporary one made here (the "TELOS
// checkout" too); the last test reads the REAL repository at HEAD without a TELOS checkout. No provider, no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {entityId} from '../../packages/graph/index.mjs';
import {repoSource, fileId, changeId} from './extract/repo.mjs';
import {workflowId} from './extract/verification.mjs';
import {openSystemsGraph} from './extract/index.mjs';
import {tempRepo, git, ROOT, T0, at} from './fixtures/repo.mjs';
import {repositoryId, fileIdIn, packageId} from './deps/ids.mjs';
import {pinsFacts, pinsSource, pinTables, workflowDeclarations, siblingChangeId, SOURCE_ID, EXTRACTOR, PINS_ORIGIN, GOVERNANCE, PROVENANCE} from './deps/pins.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const lines = (...l) => l.join('\n') + '\n';
const ent = (drafts, id) => drafts.find(d => d.entity === id);
const rel = (drafts, type, from, to) => drafts.find(d => d.type === type && d.from === from && d.to === to);
const C40 = c => c.repeat(40);

// The pin file as ophanim/governance.mjs writes it: the commit, the TELOS table, a table of local checkers, and the
// run-time comparison that says what each table's paths are relative to.
const governance = ({commit = C40('a'), telos = {}, check = {}, compare = true} = {}) => lines(
  "import path from 'node:path';",
  ...(commit ? [`export const TELOS_COMMIT = '${commit}';`] : []),
  'export const TELOS_PINS = Object.freeze({',
  ...Object.entries(telos).map(([p, h]) => `  '${p}': '${h}',`),
  '});',
  'const CHECK_PINS = Object.freeze({',
  ...Object.entries(check).map(([p, h]) => `  '${p}': '${h}',`),
  '});',
  'const assertPins = () => {',
  "  for (const [rel, sha] of Object.entries(TELOS_PINS)) if (rawHash(regular(path.join(telosRoot, rel))) !== sha) fail('Pinned TELOS source changed: ' + rel);",
  ...(compare ? ["  for (const [rel, sha] of Object.entries(CHECK_PINS)) if (rawHash(regular(path.join(HERE, 'governance', rel))) !== sha) fail('Pinned local verifier changed: ' + rel);"] : []),
  '};');
const GATE = 'export const gate = 1;\n', MERKLE = 'export const merkle = 2;\n';

/** A temporary "TELOS checkout" holding two files at one commit. */
function telosCheckout(t) {
  const {repo, commit, write} = tempRepo(t, 'ophanim-deps-telos-');
  const c = commit({'build-gate/gate.mjs': GATE, 'merkle-dag/merkle.mjs': MERKLE}, 'telos');
  return {repo, commit: c, write, commitMore: commit};
}

test('PIN TABLES: the commit, each table with the line of every entry, and what the file compares each table against', () => {
  const text = governance({commit: C40('a'), telos: {'build-gate/gate.mjs': '1'.repeat(40) + '2'.repeat(24)}, check: {'check-a.mjs': sha('x')}});
  const r = pinTables(text);
  assert.deepEqual(r.commit, {value: C40('a'), line: 2});
  assert.deepEqual(r.tables, [
    {name: 'TELOS_PINS', line: 3, exported: true, entries: [{path: 'build-gate/gate.mjs', sha256: '1'.repeat(40) + '2'.repeat(24), line: 4}], unread_lines: [], duplicates: []},
    {name: 'CHECK_PINS', line: 6, exported: false, entries: [{path: 'check-a.mjs', sha256: sha('x'), line: 7}], unread_lines: [], duplicates: []},
  ]);
  assert.deepEqual(r.comparisons, {TELOS_PINS: {root: 'telosRoot', dir: null, line: 10}, CHECK_PINS: {root: 'HERE', dir: 'governance', line: 11}});
});

test('PIN TABLES: a line of a table that is not an entry is listed as unread, and a repeated path is listed, never silently taken', () => {
  const r = pinTables(lines('const CHECK_PINS = Object.freeze({', "  'a.mjs': '" + sha('a') + "',", '  [computed]: digestOf(x),', "  'a.mjs': '" + sha('b') + "',", "  'short.mjs': 'abc',", '});'));
  assert.deepEqual(r.tables, [{name: 'CHECK_PINS', line: 1, exported: false, entries: [{path: 'a.mjs', sha256: sha('a'), line: 2}], unread_lines: [3, 5], duplicates: [{path: 'a.mjs', line: 4}]}]);
  assert.equal(r.commit, null);
});

test('TELOS PINS are stated as DECLARED: the repository, each pinned file with its pinned digest, and the dependency; nothing here says whether a digest holds', t => {
  const pins = {'build-gate/gate.mjs': sha(GATE), 'merkle-dag/merkle.mjs': sha(MERKLE)};
  const {repo: home, commit: commitHome} = tempRepo(t);
  const head = commitHome({[GOVERNANCE]: governance({commit: C40('b'), telos: pins})}, 'pins');
  const facts = pinsFacts(home, head);
  assert.deepEqual(ent(facts, repositoryId('telos')), {entity: repositoryId('telos'), ref: `${GOVERNANCE}#TELOS_COMMIT`,
    attributes: {name: 'telos', pinned_commit: C40('b'), pinned_by: GOVERNANCE, line: 2, pinned_files: 2}});
  assert.deepEqual(ent(facts, fileIdIn('telos', 'build-gate/gate.mjs')), {entity: fileIdIn('telos', 'build-gate/gate.mjs'), ref: `${GOVERNANCE}#TELOS_PINS`,
    attributes: {repository: 'telos', path: 'build-gate/gate.mjs', sha256: sha(GATE), commit: C40('b'), pinned_by: GOVERNANCE, line: 4}});
  assert.deepEqual(rel(facts, 'depends-on', fileId(GOVERNANCE), fileIdIn('telos', 'merkle-dag/merkle.mjs')), {type: 'depends-on', from: fileId(GOVERNANCE),
    to: fileIdIn('telos', 'merkle-dag/merkle.mjs'), ref: `${GOVERNANCE}#TELOS_PINS`,
    attributes: {basis: 'digest pin', table: 'TELOS_PINS', sha256: sha(MERKLE), commit: C40('b'), line: 5}});
  assert.deepEqual(rel(facts, 'depends-on', fileId(GOVERNANCE), repositoryId('telos')).attributes, {basis: 'commit pin', commit: C40('b'), line: 2});
  // Whether a pinned digest holds is a comparison with the sibling's own file, made by the audit (deps/query.mjs): a
  // fact of this source is the same for the same commit whether or not a TELOS checkout is at hand.
  assert.deepEqual(facts.filter(d => d.entity && (Object.hasOwn(d.attributes, 'verified') || Object.hasOwn(d.attributes, 'found'))), []);
  assert.deepEqual(Object.keys(pinsSource({repo: home})).sort(), ['authority', 'current', 'extractor', 'id', 'readAt', 'ref']);
});

test('TELOS PINS without a declared commit: the pins are stated, and the facts say there is no commit to check them at', t => {
  const {repo, commit} = tempRepo(t);
  const head = commit({[GOVERNANCE]: governance({commit: null, telos: {'build-gate/gate.mjs': sha(GATE)}})}, 'pins');
  const facts = pinsFacts(repo, head);
  const gate = ent(facts, fileIdIn('telos', 'build-gate/gate.mjs'));
  assert.deepEqual([gate.attributes.commit, Object.hasOwn(gate.attributes, 'verified'), gate.missing_evidence],
    [null, false, [`${GOVERNANCE} states no TELOS_COMMIT: there is no commit to check the pinned digest at`]]);
  assert.equal(rel(facts, 'depends-on', fileId(GOVERNANCE), repositoryId('telos')), undefined, 'no commit pin is stated');
  assert.equal(ent(facts, repositoryId('telos')).attributes.pinned_commit, null);
});

test('LOCAL CHECKER PINS: each is compared with the file\'s blob AT THE SAME COMMIT; a differing digest is `matches: false`, a missing file is listed, a table the file never compares is not placed', t => {
  const {repo, commit, write} = tempRepo(t);
  const good = 'export const ok = true;\n', drift = 'export const drifted = true;\n';
  const head = commit({[GOVERNANCE]: governance({check: {'check-a.mjs': sha(good), 'check-b.mjs': sha('what was pinned'), 'check-gone.mjs': sha('gone')}}),
    'ophanim/governance/check-a.mjs': good, 'ophanim/governance/check-b.mjs': drift}, 'pins');
  write({'ophanim/governance/check-a.mjs': 'export const ok = "edited, not committed";\n'});
  const facts = pinsFacts(repo, head);
  assert.deepEqual(rel(facts, 'depends-on', fileId(GOVERNANCE), fileId('ophanim/governance/check-a.mjs')), {type: 'depends-on', from: fileId(GOVERNANCE), to: fileId('ophanim/governance/check-a.mjs'),
    ref: `${GOVERNANCE}#CHECK_PINS`, attributes: {basis: 'digest pin', table: 'CHECK_PINS', sha256: sha(good), found: sha(good), matches: true, line: 6}});
  assert.deepEqual(rel(facts, 'depends-on', fileId(GOVERNANCE), fileId('ophanim/governance/check-b.mjs')).attributes,
    {basis: 'digest pin', table: 'CHECK_PINS', sha256: sha('what was pinned'), found: sha(drift), matches: false, line: 7});
  assert.equal(rel(facts, 'depends-on', fileId(GOVERNANCE), fileId('ophanim/governance/check-gone.mjs')), undefined, 'no edge to a file the tree does not hold');
  const g = ent(facts, fileId(GOVERNANCE));
  assert.deepEqual(g.attributes.local_pins, {count: 3, matching: 1, mismatched: ['ophanim/governance/check-b.mjs'], unresolved: ['ophanim/governance/check-gone.mjs']});
  assert.deepEqual(g.attributes.pin_tables, [{name: 'TELOS_PINS', line: 3, entries: 0, pins: 'telos', compared_at_line: 11}, {name: 'CHECK_PINS', line: 5, entries: 3, pins: 'ophanim/governance/', compared_at_line: 12}]);
  assert.deepEqual(g.missing_evidence, ['1 locally pinned path(s) are not in the tree at this commit']);
  // Without the comparison line the file does not say where CHECK_PINS' paths are: no edge is guessed.
  const bare = commit({[GOVERNANCE]: governance({check: {'check-a.mjs': sha(good)}, compare: false}), 'ophanim/governance/check-a.mjs': good}, 'no comparison');
  const f2 = pinsFacts(repo, bare);
  assert.deepEqual(f2.filter(d => d.type === 'depends-on'), [rel(f2, 'depends-on', fileId(GOVERNANCE), repositoryId('telos'))]);
  assert.deepEqual(ent(f2, fileId(GOVERNANCE)).attributes.pin_tables[1], {name: 'CHECK_PINS', line: 5, entries: 1, pins: null, compared_at_line: null});
  assert.deepEqual(ent(f2, fileId(GOVERNANCE)).missing_evidence, [`${GOVERNANCE} does not say what the paths of CHECK_PINS are relative to: its 1 pin(s) are not placed`]);
});

test('NO PIN FILE: a repository without ophanim/governance.mjs states no TELOS pin, and says the file was not there', t => {
  const {repo, commit} = tempRepo(t);
  const head = commit({'README.md': 'x\n'}, 'bare');
  const facts = pinsFacts(repo, head);
  assert.equal(ent(facts, repositoryId('telos')), undefined);
  assert.equal(ent(facts, fileId(GOVERNANCE)), undefined);
  assert.ok(ent(facts, repositoryId('ophanim')).missing_evidence.includes(`${GOVERNANCE} is not in the tree at this commit: no TELOS pin is read`));
});

const provenance = pairs => JSON.stringify({schema: 1, argoSourceCommit: C40('d'), pantheonSourceCommit: C40('e'), filteredCommits: pairs,
  includedPaths: ['pantheon/', 'packages/model-client/'], excludedPaths: ['**/*.pyc'], retainedInArgo: ['tools/mesh.mjs'], extraction: 'Git fast-export and fast-import.', note: 'kept'}, null, 2);

test('ARGO LINEAGE: PROVENANCE.json gives the sibling repository, the derivation with its fields, and each filtered commit pair as two changes', t => {
  const {repo, commit} = tempRepo(t);
  const c1 = commit({'pantheon/a.mjs': 'export const a = 1;\n'}, 'filtered in');
  const head = commit({[PROVENANCE]: provenance({[C40('1')]: c1, [C40('2')]: C40('9'), 'not-a-commit': c1})}, 'provenance');
  const facts = pinsFacts(repo, head);
  assert.deepEqual(ent(facts, repositoryId('argo')), {entity: repositoryId('argo'), ref: PROVENANCE, attributes: {name: 'argo', source_commit: C40('d'), stated_by: PROVENANCE},
    missing_evidence: [`the lineage is what ${PROVENANCE} declares; it is not checked against the ARGO repository`]});
  assert.deepEqual(rel(facts, 'derived-from', repositoryId('ophanim'), repositoryId('argo')), {type: 'derived-from', from: repositoryId('ophanim'), to: repositoryId('argo'), ref: PROVENANCE,
    attributes: {basis: 'provenance record', argo_source_commit: C40('d'), pantheon_source_commit: C40('e'), filtered_commits: 2, included_paths: ['pantheon/', 'packages/model-client/'],
      excluded_paths: ['**/*.pyc'], retained_in_argo: ['tools/mesh.mjs'], extraction: 'Git fast-export and fast-import.'}});
  assert.deepEqual(ent(facts, siblingChangeId('argo', C40('1'))), {entity: siblingChangeId('argo', C40('1')), ref: `${PROVENANCE}#filteredCommits`, attributes: {repository: 'argo', commit: C40('1')}});
  assert.equal(siblingChangeId('argo', C40('1')), entityId({domain: 'systems', type: 'change', key: `argo:${C40('1')}`}));
  assert.deepEqual(ent(facts, changeId(c1)), {entity: changeId(c1), ref: `${PROVENANCE}#filteredCommits`, attributes: {commit: c1, filtered_from: [C40('1')], in_ancestry: true}});
  assert.deepEqual(ent(facts, changeId(C40('9'))).attributes, {commit: C40('9'), filtered_from: [C40('2')], in_ancestry: false}, 'a commit the record names that is not an ancestor is stated as such');
  assert.deepEqual(rel(facts, 'derived-from', changeId(c1), siblingChangeId('argo', C40('1'))).attributes, {basis: 'filtered commit'});
  const home = ent(facts, repositoryId('ophanim'));
  assert.deepEqual(home.attributes.provenance, {file: PROVENANCE, schema: 1, filtered_commits: 2, unread_pairs: 1, uninterpreted_keys: ['note']});
  assert.equal(home.status, undefined);
  assert.ok(home.missing_evidence.includes(`1 entry(ies) of filteredCommits in ${PROVENANCE} are not a commit id naming a commit id and were not read`));
});

test('ARGO LINEAGE: a missing, malformed or commit-less PROVENANCE.json is an UNRESOLVED repository fact with the reason; the source does not throw and names no ARGO', t => {
  const {repo, commit} = tempRepo(t);
  const absent = commit({'README.md': 'x\n'}, 'no provenance');
  const malformed = commit({[PROVENANCE]: '{"argoSourceCommit": '}, 'malformed');
  const commitless = commit({[PROVENANCE]: JSON.stringify({schema: 1, filteredCommits: {}})}, 'no commit');
  const reasons = [absent, malformed, commitless].map(c => {
    const facts = pinsFacts(repo, c), home = ent(facts, repositoryId('ophanim'));
    return [home.status, home.missing_evidence.find(m => m.startsWith(PROVENANCE)), ent(facts, repositoryId('argo')), facts.filter(d => d.type === 'derived-from').length];
  });
  assert.deepEqual(reasons, [
    ['unresolved', `${PROVENANCE} is not in the tree at this commit: the lineage of this repository is not stated`, undefined, 0],
    ['unresolved', `${PROVENANCE} is not valid JSON at this commit: the lineage of this repository is not read`, undefined, 0],
    ['unresolved', `${PROVENANCE} does not state argoSourceCommit as a commit id: the lineage of this repository is not read`, undefined, 0],
  ]);
});

const WORKFLOW = lines(
  'name: q',
  'on: push',
  'jobs:',
  '  q:',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      # - uses: commented/out@v1',
  "      - uses: 'actions/setup-node@v4'   # the runtime",
  '        with:',
  "          node-version: '24.22.1'",
  '      - name: script',
  '        run: |',
  '          echo "uses: not/an-action@v9"',
  '          node-version: 1',
  '      - name: keep',
  '        uses: actions/upload-artifact@0123456789abcdef0123456789abcdef01234567 # v4',
  '      - uses: ./.github/actions/local',
  '      - uses: docker://alpine:3',
  '      - uses: github/codeql-action/init@v3',
  '      - uses: actions/checkout@v3',
  '        with:',
  '          node-version: ${{ matrix.node }}',
);

test('WORKFLOW LINES: `uses:` and `node-version:` are read line by line; a comment and a script block are not, and a use that is not owner/name@ref is listed apart', () => {
  assert.deepEqual(workflowDeclarations(WORKFLOW), {
    uses: [{name: 'actions/checkout', ref: 'v4', line: 6}, {name: 'actions/setup-node', ref: 'v4', line: 8},
      {name: 'actions/upload-artifact', ref: '0123456789abcdef0123456789abcdef01234567', line: 16}, {name: 'github/codeql-action/init', ref: 'v3', line: 19}, {name: 'actions/checkout', ref: 'v3', line: 20}],
    other_uses: [{value: './.github/actions/local', line: 17}, {value: 'docker://alpine:3', line: 18}],
    node_versions: [{version: '24.22.1', line: 10}],
    node_expressions: [{text: '${{ matrix.node }}', line: 22}],
  });
});

test('CI: each workflow depends on the actions it uses (with the refs seen) and on the Node it sets up; package.json engines.node is a dependency of package.json', t => {
  const {repo, commit} = tempRepo(t);
  const head = commit({'.github/workflows/q.yml': WORKFLOW, '.github/workflows/r.yaml': lines('jobs:', '  r:', '    steps:', '      - uses: actions/checkout@v4'),
    '.github/workflows/notes.txt': 'uses: not/a-workflow@v1\n', 'package.json': JSON.stringify({name: 'fixture', engines: {node: '>=24 <25'}})}, 'ci');
  const facts = pinsFacts(repo, head), q = workflowId('.github/workflows/q.yml'), r = workflowId('.github/workflows/r.yaml'), node = packageId('program', 'node');
  assert.deepEqual(ent(facts, q), {entity: q, ref: '.github/workflows/q.yml', attributes: {file: '.github/workflows/q.yml',
    uses: ['actions/checkout@v3', 'actions/checkout@v4', 'actions/setup-node@v4', 'actions/upload-artifact@0123456789abcdef0123456789abcdef01234567', 'github/codeql-action/init@v3'],
    node_versions: ['24.22.1'], other_uses: ['./.github/actions/local', 'docker://alpine:3'], node_expressions: ['${{ matrix.node }}']},
    missing_evidence: ['2 `uses:` value(s) are not owner/name@ref (a local or container action) and are listed, not resolved', '1 `node-version:` value(s) are expressions and are listed, not resolved']});
  assert.deepEqual(ent(facts, packageId('action', 'actions/checkout')), {entity: packageId('action', 'actions/checkout'), ref: '.github/workflows',
    attributes: {ecosystem: 'action', name: 'actions/checkout', refs: ['v3', 'v4'], workflows: ['.github/workflows/q.yml', '.github/workflows/r.yaml']}});
  assert.deepEqual(rel(facts, 'depends-on', q, packageId('action', 'actions/checkout')), {type: 'depends-on', from: q, to: packageId('action', 'actions/checkout'), ref: '.github/workflows/q.yml',
    attributes: {basis: 'uses', refs: ['v3', 'v4'], lines: [6, 20]}});
  assert.deepEqual(rel(facts, 'depends-on', r, packageId('action', 'actions/checkout')).attributes, {basis: 'uses', refs: ['v4'], lines: [4]});
  assert.deepEqual(rel(facts, 'depends-on', q, node).attributes, {basis: 'node-version', versions: ['24.22.1'], lines: [10, 22], expressions: ['${{ matrix.node }}']});
  assert.equal(rel(facts, 'depends-on', r, node), undefined, 'a workflow that sets up no Node states no dependency on it');
  assert.deepEqual(rel(facts, 'depends-on', fileId('package.json'), node), {type: 'depends-on', from: fileId('package.json'), to: node, ref: 'package.json', attributes: {basis: 'engines.node', version: '>=24 <25'}});
  assert.deepEqual(ent(facts, node), {entity: node, ref: '.github/workflows', attributes: {ecosystem: 'program', name: 'node',
    versions: [{stated_by: '.github/workflows/q.yml', version: '24.22.1'}, {stated_by: 'package.json', version: '>=24 <25'}]}});
  assert.equal(ent(facts, workflowId('.github/workflows/notes.txt')), undefined, 'only *.yml and *.yaml are workflows');
  assert.equal(ent(facts, packageId('action', 'not/an-action')), undefined);
});

test('CI: a package.json that is not valid JSON is said so on the repository fact; no Node dependency is made up for it', t => {
  const {repo, commit} = tempRepo(t);
  const head = commit({'package.json': '{"engines": '}, 'broken');
  const facts = pinsFacts(repo, head);
  assert.equal(ent(facts, packageId('program', 'node')), undefined);
  assert.ok(ent(facts, repositoryId('ophanim')).missing_evidence.includes('package.json is not valid JSON at this commit: engines.node is not read'));
});

test('THE GRAPH: observed after the repository source, every pin, lineage and CI relationship is admitted from a DECLARED basis and established', t => {
  const telos = telosCheckout(t);
  const {repo, commit} = tempRepo(t);
  const good = 'export const ok = true;\n';
  const c1 = commit({'pantheon/a.mjs': 'export const a = 1;\n'}, 'filtered in');
  const head = commit({[GOVERNANCE]: governance({commit: telos.commit, telos: {'build-gate/gate.mjs': sha(GATE), 'merkle-dag/merkle.mjs': sha(MERKLE)}, check: {'check-a.mjs': sha(good)}}),
    'ophanim/governance/check-a.mjs': good, [PROVENANCE]: provenance({[C40('1')]: c1}), '.github/workflows/q.yml': WORKFLOW,
    'package.json': JSON.stringify({name: 'fixture', engines: {node: '>=24 <25'}})}, 'everything');
  assert.deepEqual(PINS_ORIGIN, {kind: 'extractor', basis: 'declared', sources: [SOURCE_ID]});
  const source = pinsSource({repo});
  const g = openSystemsGraph({sources: [repoSource({repo}), source], extraOrigins: {[EXTRACTOR]: {...PINS_ORIGIN, keys: ['graph-extractor']}}});
  t.after(g.close);
  g.graph.observe('ophanim.repo', {...g.by, observed_at: T0});
  const o = g.graph.observe(SOURCE_ID, {...g.by, observed_at: at(1)});
  assert.equal(o.recorded, true, o.why);
  assert.equal(o.record.source.version, head);
  const v = g.graph.view();
  const edge = (type, from, to) => {
    const e = v.edgesOf(from).find(x => x.type === type && x.to === to);
    return e ? e.assertions.map(a => v.established(a)) : null;
  };
  assert.deepEqual([
    edge('depends-on', fileId(GOVERNANCE), repositoryId('telos')),
    edge('depends-on', fileId(GOVERNANCE), fileIdIn('telos', 'build-gate/gate.mjs')),
    edge('depends-on', fileId(GOVERNANCE), fileIdIn('telos', 'merkle-dag/merkle.mjs')),
    edge('depends-on', fileId(GOVERNANCE), fileId('ophanim/governance/check-a.mjs')),
    edge('derived-from', repositoryId('ophanim'), repositoryId('argo')),
    edge('derived-from', changeId(c1), siblingChangeId('argo', C40('1'))),
    edge('depends-on', workflowId('.github/workflows/q.yml'), packageId('action', 'actions/setup-node')),
    edge('depends-on', workflowId('.github/workflows/q.yml'), packageId('program', 'node')),
    edge('depends-on', fileId('package.json'), packageId('program', 'node')),
  ], Array.from({length: 9}, () => [true]));
  assert.deepEqual(v.node(repositoryId('ophanim')).conflicts, [], 'the repository node this source shares with the repository source disagrees on nothing');
  assert.deepEqual(v.node(changeId(c1)).conflicts, []);
  // The same commit read again is the same facts in the same order, and a fresh replay re-derives the projection.
  assert.deepEqual(source.readAt(head), source.readAt(head));
  const again = g.open();
  assert.deepEqual([again.digest(), again.verification.complete], [g.graph.digest(), true]);
});

test('THE REAL REPOSITORY at HEAD: the pin table, the lineage record and the workflows are read, and no pin is called verified', () => {
  const head = git(ROOT, 'rev-parse', 'HEAD'), facts = pinsFacts(ROOT, head);
  const telosFiles = facts.filter(d => d.entity?.includes('/telos:'));
  assert.ok(telosFiles.length > 0, 'the real pin table has entries');
  assert.deepEqual(telosFiles.filter(d => Object.hasOwn(d.attributes, 'verified') || d.missing_evidence?.length), []);
  assert.equal(ent(facts, repositoryId('telos')).attributes.pinned_files, telosFiles.length);
  assert.equal(ent(facts, repositoryId('ophanim')).status, undefined, 'PROVENANCE.json is read');
  assert.ok(rel(facts, 'derived-from', repositoryId('ophanim'), repositoryId('argo')));
  assert.ok(rel(facts, 'depends-on', fileId('package.json'), packageId('program', 'node')));
  assert.equal(new Set(facts.map(d => d.entity ?? `${d.type}(${d.from} -> ${d.to})`)).size, facts.length, 'no subject is stated twice');
});
