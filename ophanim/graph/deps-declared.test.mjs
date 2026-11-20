// The declared source of a sibling repository (ophanim/graph/deps/declared.mjs): what its own files DECLARE --
// requirements, compositions of services, CI workflows, and its records of ownership, authority, audited sources and
// gates. SYNTHETIC: the repository below is made in a temporary directory by this test; its packages, images and
// commits do not exist. Synthetic keys only; no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {entityId} from '../../packages/graph/index.mjs';
import {declaredFacts, declaredSource, declaredOrigin, DECLARED_EXTRACTOR, declaredSourceIdOf} from './deps/declared.mjs';
import {codeSource, codeOrigin, CODE_EXTRACTOR, sourceIdOf} from './deps/code.mjs';
import {packageId, envId, fileIdIn, serviceId, changeIdIn, workflowIdIn, repositoryId} from './deps/ids.mjs';
import {openSystemsGraph} from './extract/index.mjs';
import {tempRepo, T0, at} from './fixtures/repo.mjs';

const lines = (...l) => l.join('\n') + '\n';
const json = v => JSON.stringify(v, null, 2) + '\n';
const C1 = '1'.repeat(40), C2 = '2'.repeat(40);
const FILES = {
  'requirements.txt': lines('-r backend/requirements.txt'),
  'backend/requirements.txt': lines('fastapi==0.110.0  # the web framework', 'PyYAML>=6', '-r missing.txt'),
  'docker-compose.yml': lines('services:', '  backend:', '    build: ./backend', '    depends_on: [db]', '    environment:', '      - DATABASE_URL=postgres://user:secret@db/app', '      - LOG_LEVEL',
    '  db:', '    image: postgres:16'),
  'backend/Dockerfile': 'FROM python:3.12\n', 'backend/app.py': 'import os\nX = os.environ["DATABASE_URL"]\n',
  '.github/workflows/ci.yml': lines('name: ci', 'jobs:', '  test:', '    steps:', '      - uses: actions/checkout@v4', '      - run: pytest'),
  'OWNERSHIP.json': json({version: 2, ownership_semantics: 'review responsibility, not an access list', owners: [
    {lane: 'authority', paths: ['backend/', 'docker-compose.yml'], writes_world_state: true}, {lane: 'empty', paths: ['nowhere/'], writes_world_state: false}]}),
  'REPO_INVENTORY.md': lines('# inventory', '', '| Repository | Pinned ref | Retained | Catalogued |', '| --- | --- | ---: | ---: |',
    `| [LEXI](https://github.com/example/LEXI) | \`${C1}\` | 288 | 239 |`, '| Pantheon | ARGO `abc` | 1 | 1 |'),
  'CURRENT-AUTHORITY.json': json({system: 'X', as_of: '2026-07-17', active_plan: {component: 'c', version: 'v15', path: 'docs/plan-v15.md', sha256: 'sha256:' + 'a'.repeat(64)},
    active_authorization: {id: 'authz-008', status: 'AUTHORIZED', authorizes_plan: 'sha256:' + 'a'.repeat(64)},
    superseded: [{plan_version: 'v12', sha256: 'sha256:' + 'b'.repeat(64), authorization: 'authz-005', authz_status: 'AUTHORIZED', superseded_by: 'v15', must_not_govern_new_work: true}]}),
  'records/gates/G0/reference.v1.json': json({gate: 'G0', schema_version: 1, source_commit: C2, clone_commit: C2, clone_fsck: 'pass', zip_integrity: 'pass', tools: {git: '2.44'}}),
};
const rel = (facts, type, from, to) => facts.find(d => d.type === type && d.from === from && d.to === to);
const ent = (facts, id) => facts.find(d => d.entity === id);
const setup = t => { const r = tempRepo(t); const head = r.commit(FILES, 'fixture'); return {...r, head, facts: declaredFacts(r.repo, head, {name: 'lexi'})}; };
const F = p => fileIdIn('lexi', p);

test('REQUIREMENTS: each requirement is a declared dependency on a distribution, with its specifier and line; an include is a dependency on the file it names', t => {
  const {facts} = setup(t), req = F('backend/requirements.txt');
  assert.deepEqual(rel(facts, 'depends-on', req, packageId('pypi', 'fastapi')).attributes, {basis: 'declared requirement', specifier: '==0.110.0', line: 1});
  assert.deepEqual(rel(facts, 'depends-on', req, packageId('pypi', 'pyyaml')).attributes, {basis: 'declared requirement', specifier: '>=6', line: 2});
  assert.deepEqual(ent(facts, packageId('pypi', 'pyyaml')).attributes, {ecosystem: 'pypi', name: 'pyyaml', written: ['PyYAML']});
  assert.deepEqual(rel(facts, 'depends-on', F('requirements.txt'), req).attributes, {basis: 'requirements include', line: 1});
  assert.deepEqual(ent(facts, req).attributes.unresolved_includes, [{path: 'missing.txt', line: 3, why: 'not in the tree at this commit'}]);
});

test('A COMPOSITION: each service with what it is built from, the image it runs, the services it waits for and the variable NAMES it is given, never a value', t => {
  const {facts} = setup(t), backend = serviceId('lexi', 'backend'), db = serviceId('lexi', 'db'), compose = F('docker-compose.yml');
  assert.deepEqual(rel(facts, 'produces', compose, backend).attributes, {basis: 'the composition defines it', line: 2});
  assert.deepEqual(rel(facts, 'depends-on', backend, db).attributes, {basis: 'compose depends_on', composition: 'docker-compose.yml'});
  assert.deepEqual(rel(facts, 'depends-on', db, packageId('image', 'postgres')).attributes, {basis: 'compose image', tag: '16', composition: 'docker-compose.yml'});
  assert.deepEqual(rel(facts, 'depends-on', backend, F('backend/Dockerfile')).attributes, {basis: 'compose build', context: './backend', composition: 'docker-compose.yml'});
  assert.deepEqual([envId('DATABASE_URL'), envId('LOG_LEVEL')].map(e => rel(facts, 'consumes', backend, e).attributes), [
    {basis: 'compose environment', composition: 'docker-compose.yml'}, {basis: 'compose environment', composition: 'docker-compose.yml'}]);
  assert.ok(!JSON.stringify(facts).includes('secret'), 'the value beside a variable name is never kept');
});

test('A WORKFLOW names the actions it uses', t => {
  const {facts} = setup(t), wf = workflowIdIn('lexi', '.github/workflows/ci.yml');
  assert.deepEqual(rel(facts, 'depends-on', wf, packageId('action', 'actions/checkout')).attributes, {basis: 'workflow uses', refs: ['v4'], lines: [5]});
  assert.deepEqual(rel(facts, 'derived-from', wf, F('.github/workflows/ci.yml')).attributes, {basis: 'the workflow is this file'});
});

test('OWNERSHIP: each lane is an authorization that governs the files under its paths at the commit; a path that covers nothing is listed', t => {
  const {facts} = setup(t), lane = entityId({domain: 'evidence', type: 'authorization', key: 'lexi:ownership/authority'});
  assert.deepEqual(facts.filter(d => d.type === 'governs' && d.from === lane).map(d => d.to).sort(), [F('backend/Dockerfile'), F('backend/app.py'), F('backend/requirements.txt'), F('docker-compose.yml')].sort());
  assert.deepEqual(ent(facts, lane).attributes, {lane: 'authority', paths: ['backend/', 'docker-compose.yml'], writes_world_state: true, governs: 4, semantics: 'review responsibility, not an access list'});
  const empty = ent(facts, entityId({domain: 'evidence', type: 'authorization', key: 'lexi:ownership/empty'}));
  assert.deepEqual([empty.attributes.unmatched_paths, empty.missing_evidence], [['nowhere/'], ['1 path(s) cover no file of the tree at this commit']]);
});

test('THE INVENTORY names the commit of each source it audited; a row that names no full commit is listed, not guessed', t => {
  const {facts} = setup(t), inv = F('REPO_INVENTORY.md');
  assert.deepEqual(rel(facts, 'derived-from', inv, changeIdIn('lexi', C1)).attributes, {basis: 'the inventory names this commit as a source it audited', retained: 288, catalogued: 239, line: 5});
  assert.deepEqual(ent(facts, inv).attributes.unread_rows, [{line: 6, why: 'the row names no repository link with a 40-hex commit'}]);
});

test('CURRENT AUTHORITY: the active authorization authorizes the active plan, and the plan supersedes each plan the record lists as superseded', t => {
  const {facts} = setup(t);
  const plan = v => entityId({domain: 'work', type: 'plan', key: `lexi:plan/${v}`}), authz = entityId({domain: 'evidence', type: 'authorization', key: 'lexi:authz-008'});
  assert.deepEqual(rel(facts, 'authorizes', authz, plan('v15')).attributes, {basis: 'the record names the plan this authorization authorizes', plan_sha256: 'sha256:' + 'a'.repeat(64)});
  assert.deepEqual(rel(facts, 'supersedes', plan('v15'), plan('v12')).attributes, {basis: 'the record lists it as superseded', must_not_govern_new_work: true});
  assert.deepEqual(ent(facts, plan('v12')).attributes, {version: 'v12', sha256: 'sha256:' + 'b'.repeat(64), authorization: 'authz-005', authz_status: 'AUTHORIZED', state: 'superseded'});
});

test('A GATE RECORD names the commit it was taken at, with what it says it checked', t => {
  const {facts} = setup(t), gate = entityId({domain: 'evidence', type: 'record', key: 'lexi:gate/G0'});
  assert.deepEqual(ent(facts, gate).attributes, {gate: 'G0', file: 'records/gates/G0/reference.v1.json', schema_version: 1, source_commit: C2, clone_commit: C2, clone_fsck: 'pass', zip_integrity: 'pass', tools: ['git'], signed: false});
  assert.deepEqual(rel(facts, 'derived-from', gate, changeIdIn('lexi', C2)).attributes, {basis: 'the gate record names this commit'});
});

test('A FILE THAT IS NOT WHAT ITS NAME PROMISES is listed with why and gives no facts of its own; the same commit gives the same facts', t => {
  const r = tempRepo(t), head = r.commit({'OWNERSHIP.json': '{not json', 'CURRENT-AUTHORITY.json': json({note: 'no plan'}), 'docker-compose.yml': 'services: [a, b]\n', 'compose.yml': 'services: {}\n'}, 'broken');
  const facts = declaredFacts(r.repo, head, {name: 'argo'}), root = ent(facts, repositoryId('argo'));
  assert.deepEqual(root.attributes.unread.map(u => u.file), ['CURRENT-AUTHORITY.json', 'OWNERSHIP.json', 'compose.yml', 'docker-compose.yml']);
  assert.equal(root.attributes.unread.find(u => u.file === 'compose.yml').why, 'no service could be read');
  assert.deepEqual(facts.filter(d => d.type).length, 0);
  assert.deepEqual(declaredFacts(r.repo, head, {name: 'argo'}), facts);
});

test('IN THE GRAPH the declared facts are established beside the sibling\'s code: a service and the code that reads the same variable meet at the variable', t => {
  const {repo, head} = setup(t);
  const g = openSystemsGraph({sources: [codeSource({repo, name: 'lexi'}), declaredSource({repo, name: 'lexi'})],
    extraOrigins: {[CODE_EXTRACTOR]: {...codeOrigin(['lexi']), keys: ['graph-extractor']}, [DECLARED_EXTRACTOR]: {...declaredOrigin(['lexi']), keys: ['graph-extractor']}}});
  t.after(g.close);
  g.graph.observe(sourceIdOf('lexi'), {...g.by, observed_at: T0});
  const o = g.graph.observe(declaredSourceIdOf('lexi'), {...g.by, observed_at: at(1)});
  assert.deepEqual([o.recorded, o.record.source.version], [true, head], o.why);
  const v = g.graph.view(), readers = v.edgesOf(envId('DATABASE_URL'), {mode: 'established', types: ['consumes']}).map(e => e.from).sort();
  assert.deepEqual(readers, [fileIdIn('lexi', 'backend/app.py'), serviceId('lexi', 'backend')].sort());
  const governed = v.edgesOf(fileIdIn('lexi', 'backend/app.py'), {mode: 'established', types: ['governs']});
  assert.equal(governed.length, 1);
});

test('A PATH THAT COVERS MORE THAN 200 FILES is listed with its count and not expanded; an authorization that names another plan\'s digest authorizes nothing', t => {
  const r = tempRepo(t), many = Object.fromEntries(Array.from({length: 201}, (_, i) => [`many/f${i}.txt`, 'x\n']));
  const head = r.commit({...many, 'OWNERSHIP.json': json({owners: [{lane: 'wide', paths: ['many/']}]}),
    'CURRENT-AUTHORITY.json': json({active_plan: {version: 'v2', sha256: 'sha256:' + 'a'.repeat(64)}, active_authorization: {id: 'authz-1', status: 'AUTHORIZED', authorizes_plan: 'sha256:' + 'b'.repeat(64)}})}, 'wide');
  const facts = declaredFacts(r.repo, head, {name: 'argo'});
  const lane = ent(facts, entityId({domain: 'evidence', type: 'authorization', key: 'argo:ownership/wide'}));
  assert.deepEqual([lane.attributes.governs, lane.attributes.wide_paths, lane.missing_evidence], [0, [{path: 'many/', files: 201}], ['1 path(s) cover more than 200 files and are not expanded']]);
  assert.deepEqual(facts.filter(d => d.type === 'governs' || d.type === 'authorizes'), []);
  assert.deepEqual(ent(facts, entityId({domain: 'evidence', type: 'authorization', key: 'argo:authz-1'})).missing_evidence, ['the authorization names a plan digest that is not the active plan\'s']);
});
