// Who is authorized to change what (ophanim/graph/deps/authority.mjs): the ownership manifests docs/execution/
// *-ownership.json at a commit, each an authorization that GOVERNS the files of that commit's tree its paths and
// patterns cover. SYNTHETIC: every manifest and tree below is made here in a temporary repository; the last test reads
// the REAL repository at HEAD. No provider, no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repoSource, fileId} from './extract/repo.mjs';
import {openSystemsGraph} from './extract/index.mjs';
import {treeAt} from './extract/git.mjs';
import {tempRepo, git, ROOT, T0, at} from './fixtures/repo.mjs';
import {ownershipFacts, ownershipSource, globMatcher, ownedEntry, authorizationId, assignmentId, SOURCE_ID, EXTRACTOR, OWNERSHIP_ORIGIN, MANIFEST, WIDE} from './deps/authority.mjs';

const ent = (drafts, id) => drafts.find(d => d.entity === id);
const rel = (drafts, type, from, to) => drafts.find(d => d.type === type && d.from === from && d.to === to);
const governed = (drafts, from) => drafts.filter(d => d.type === 'governs' && d.from === from).map(d => d.to);
const matched = (pattern, paths) => { const m = globMatcher(pattern); return m.ok ? paths.filter(p => m.test(p)) : m.why; };
const FILE = 'docs/execution/wave-9-ownership.json', AUTH = authorizationId('wave-9');
const TREE = {'lib/a.mjs': 'export const a = 1;\n', 'lib/a.test.mjs': '// a\n', 'lib/b.test.mjs': '// b\n', 'lib/sub/c.mjs': 'export const c = 3;\n',
  'tools/x.sh': 'true\n', 'tools/deep/y.sh': 'true\n', 'docs/REGISTER.md': '# register\n', 'other/z.mjs': 'export const z = 26;\n'};
const manifest = (over = {}) => ({schema: 'ophanim.wave-ownership/v1', wave: 9, base_commit: 'abc1234', authorization: 'owner directive of the day',
  frozen: {candidate: 'f'.repeat(40)}, coordinator_only: ['docs/REGISTER.md', 'docs/execution/**'], dependencies: ['agent-a builds on agent-b; prose, not parsed'],
  subwaves: {'9A': {
    'agent-a': {branch: 'w9/a', base_commit: 'abc1234', findings: ['L-001'], files: ['lib/a.mjs', 'lib/*.test.mjs (existing tests, plus new)', 'tools/'], new_files: ['lib/a.test.mjs'],
      region_limits: {'lib/a.mjs': 'only the parser'}},
    'agent-b': {branch: 'w9/b', files: ['lib/**', 'docs/REGISTER.md'], interface_rule: 'signatures stay'},
  }}, ...over});
const repoWith = (t, m, tree = TREE, file = FILE) => {
  const {repo, commit, write} = tempRepo(t);
  const head = commit({...tree, [file]: typeof m === 'string' ? m : JSON.stringify(m, null, 2)}, 'manifest');
  return {repo, head, commit, write};
};

test('PATTERNS: `*` stays inside one path segment, `**` crosses segments (and may be none), a trailing `/` is everything under a directory, `{a,b}` is either', () => {
  const paths = ['a.mjs', 'lib/a.mjs', 'lib/a.test.mjs', 'lib/sub/c.mjs', 'lib/sub/deep/d.test.mjs', 'libx/e.mjs', 'tools/x.sh', 'tools/deep/y.sh'];
  assert.deepEqual({
    literal: matched('lib/a.mjs', paths),
    star: matched('lib/*.mjs', paths),
    starInName: matched('lib/a*.mjs', paths),
    doubleStar: matched('lib/**', paths),
    doubleStarMiddle: matched('lib/**/*.test.mjs', paths),
    leading: matched('**/*.sh', paths),
    directory: matched('tools/', paths),
    braces: matched('lib/{a,sub/c}.mjs', paths),
    bracesAndStar: matched('{lib,tools}/*', paths),
  }, {
    literal: ['lib/a.mjs'],
    star: ['lib/a.mjs', 'lib/a.test.mjs'],
    starInName: ['lib/a.mjs', 'lib/a.test.mjs'],
    doubleStar: ['lib/a.mjs', 'lib/a.test.mjs', 'lib/sub/c.mjs', 'lib/sub/deep/d.test.mjs'],
    doubleStarMiddle: ['lib/a.test.mjs', 'lib/sub/deep/d.test.mjs'],
    leading: ['tools/x.sh', 'tools/deep/y.sh'],
    directory: ['tools/x.sh', 'tools/deep/y.sh'],
    braces: ['lib/a.mjs', 'lib/sub/c.mjs'],
    bracesAndStar: ['lib/a.mjs', 'lib/a.test.mjs', 'tools/x.sh'],
  });
});

test('PATTERNS: what this reader does not implement is refused with the reason, never matched as if it were literal', () => {
  assert.deepEqual(['lib/?.mjs', 'lib/[ab].mjs', 'lib/{a,{b,c}}.mjs', 'lib/{a,b.mjs', 'lib/a}.mjs', 'lib/a b.mjs', '/abs/a.mjs', '!lib/a.mjs', '', 7].map(p => globMatcher(p).ok),
    Array.from({length: 10}, () => false));
  assert.equal(globMatcher('lib/?.mjs').why, '`?`, `[`, `]`, `\\` and `!` are not read');
});

test('ENTRIES: a path or pattern may carry a parenthesised note, kept as its qualifier; anything else with a space in it is not a path', () => {
  assert.deepEqual(['lib/a.mjs', 'lib/*.test.mjs (existing tests, plus new)', 'package.json (scripts block only)', 'lib/a.mjs, lib/b.mjs', 'see the brief', '', null].map(ownedEntry), [
    {pattern: 'lib/a.mjs', qualifier: null}, {pattern: 'lib/*.test.mjs', qualifier: 'existing tests, plus new'}, {pattern: 'package.json', qualifier: 'scripts block only'}, null, null, null, null]);
});

test('A MANIFEST: one authorization with its schema, wave, base commit and text; one assignment per owning unit; `governs` to each file of the tree a path or pattern covers', t => {
  const {repo, head} = repoWith(t, manifest());
  const facts = ownershipFacts(repo, head), a = assignmentId('wave-9', '9A', 'agent-a'), b = assignmentId('wave-9', '9A', 'agent-b');
  assert.deepEqual(ent(facts, AUTH), {entity: AUTH, ref: FILE, attributes: {file: FILE, schema: 'ophanim.wave-ownership/v1', wave: 9, base_commit: 'abc1234',
    authorization: 'owner directive of the day', frozen: {candidate: 'f'.repeat(40)}, coordinator_only: ['docs/REGISTER.md', 'docs/execution/**'],
    dependencies: ['agent-a builds on agent-b; prose, not parsed'], cross_agent_interfaces: [], units: ['9A/agent-a', '9A/agent-b'], governed_files: 8, owned_files: 7, reserved_files: 2,
    unmatched_patterns: [], directory_patterns: [], wide_patterns: [], uninterpreted_entries: [], uninterpreted_keys: []}});
  assert.deepEqual(rel(facts, 'derived-from', AUTH, fileId(FILE)), {type: 'derived-from', from: AUTH, to: fileId(FILE), ref: FILE, attributes: {}});
  assert.deepEqual(ent(facts, a), {entity: a, ref: `${FILE}#9A/agent-a`, attributes: {manifest: 'wave-9', subwave: '9A', agent: 'agent-a', branch: 'w9/a', base_commit: 'abc1234', starts_after: null, note: null,
    findings: ['L-001'], interface_rules: [], files: ['lib/a.mjs', 'lib/*.test.mjs (existing tests, plus new)', 'tools/'], new_files: ['lib/a.test.mjs'], allowed_extra: [],
    region_limits: [{path: 'lib/a.mjs', limit: 'only the parser'}], governed_files: 5, uninterpreted_keys: []}});
  assert.deepEqual([ent(facts, b).attributes.interface_rules, ent(facts, b).attributes.governed_files, ent(facts, b).attributes.base_commit], [['signatures stay'], 5, null]);
  assert.deepEqual(rel(facts, 'authorizes', AUTH, a), {type: 'authorizes', from: AUTH, to: a, ref: `${FILE}#9A/agent-a`, attributes: {subwave: '9A', agent: 'agent-a'}});
  assert.deepEqual(governed(facts, AUTH), ['docs/REGISTER.md', FILE, 'lib/a.mjs', 'lib/a.test.mjs', 'lib/b.test.mjs', 'lib/sub/c.mjs', 'tools/deep/y.sh', 'tools/x.sh'].map(fileId),
    'other/z.mjs is covered by nothing and is not governed');
  assert.deepEqual(rel(facts, 'governs', AUTH, fileId('lib/a.mjs')), {type: 'governs', from: AUTH, to: fileId('lib/a.mjs'), ref: FILE, attributes: {owners: [
    {unit: '9A/agent-a', lists: ['files'], patterns: ['lib/a.mjs'], region_limits: ['only the parser']}, {unit: '9A/agent-b', lists: ['files'], patterns: ['lib/**']}]}});
  assert.deepEqual(rel(facts, 'governs', AUTH, fileId('lib/a.test.mjs')).attributes, {owners: [
    {unit: '9A/agent-a', lists: ['files', 'new_files'], patterns: ['lib/*.test.mjs', 'lib/a.test.mjs'], qualifiers: ['existing tests, plus new']}, {unit: '9A/agent-b', lists: ['files'], patterns: ['lib/**']}]});
  assert.deepEqual(rel(facts, 'governs', AUTH, fileId('lib/sub/c.mjs')).attributes, {owners: [{unit: '9A/agent-b', lists: ['files'], patterns: ['lib/**']}]}, '`lib/*.test.mjs` does not reach into lib/sub');
  assert.deepEqual(rel(facts, 'governs', AUTH, fileId('tools/deep/y.sh')).attributes, {owners: [{unit: '9A/agent-a', lists: ['files'], patterns: ['tools/']}]});
});

test('LONG TEXT IS BOUNDED: the authorization text is kept to 600 characters, and the prose entries are kept as text, not parsed', t => {
  const {repo, head} = repoWith(t, manifest({authorization: 'x'.repeat(1000), dependencies: ['lib/a.mjs depends on other/z.mjs, says this sentence', 'y'.repeat(1000)]}));
  const facts = ownershipFacts(repo, head), auth = ent(facts, AUTH);
  assert.equal(auth.attributes.authorization, 'x'.repeat(599) + '…');
  assert.deepEqual(auth.attributes.dependencies, ['lib/a.mjs depends on other/z.mjs, says this sentence', 'y'.repeat(399) + '…']);
  assert.equal(rel(facts, 'governs', AUTH, fileId('other/z.mjs')), undefined, 'a path written in a prose entry is not coverage');
  assert.deepEqual(facts.filter(d => d.type && !['governs', 'authorizes', 'derived-from'].includes(d.type)), [], 'no relationship is read out of the prose');
});

test('COORDINATOR-ONLY paths are a reservation of their own (`reserved: coordinator`), never an owner; a path both reserved and listed for a unit says so', t => {
  const {repo, head} = repoWith(t, manifest());
  const facts = ownershipFacts(repo, head);
  assert.deepEqual(rel(facts, 'governs', AUTH, fileId(FILE)), {type: 'governs', from: AUTH, to: fileId(FILE), ref: FILE, attributes: {reserved: 'coordinator', reserved_patterns: ['docs/execution/**']}});
  assert.deepEqual(rel(facts, 'governs', AUTH, fileId('docs/REGISTER.md')), {type: 'governs', from: AUTH, to: fileId('docs/REGISTER.md'), ref: FILE,
    attributes: {owners: [{unit: '9A/agent-b', lists: ['files'], patterns: ['docs/REGISTER.md']}], reserved: 'coordinator', reserved_patterns: ['docs/REGISTER.md']},
    uncertainty: 'the manifest both reserves this path for the coordinator and lists it for a unit'});
  assert.deepEqual(facts.filter(d => d.type === 'governs' && d.attributes.owners?.some(o => o.unit === 'coordinator')), []);
});

test('THE OTHER SHAPE: `workers` (units with no sub-wave), `allowed_extra`, an empty unit, and a manifest with no authorization text, which says so', t => {
  const {repo, head} = repoWith(t, {schema: 'ophanim.wave-ownership/v1', wave: 'One', base_commit: '08ee51a', coordinator_only: [], cross_agent_interfaces: ['a talks to b'],
    workers: {'agent-ci': {branch: 'w1/ci', files: ['tools/**'], allowed_extra: ['other/z.mjs'], starts_after: 'the first wave'}, 'read-only': {files: [], note: 'investigation only'}}});
  const facts = ownershipFacts(repo, head), ci = assignmentId('wave-9', null, 'agent-ci'), ro = assignmentId('wave-9', null, 'read-only');
  const auth = ent(facts, AUTH);
  assert.deepEqual([auth.attributes.wave, auth.attributes.authorization, auth.attributes.units, auth.attributes.cross_agent_interfaces, auth.attributes.dependencies, auth.missing_evidence],
    ['One', null, ['agent-ci', 'read-only'], ['a talks to b'], [], ['the manifest states no authorization text']]);
  assert.deepEqual([ent(facts, ci).attributes.subwave, ent(facts, ci).attributes.starts_after, ent(facts, ci).attributes.allowed_extra, ent(facts, ci).ref], [null, 'the first wave', ['other/z.mjs'], `${FILE}#agent-ci`]);
  assert.deepEqual([ent(facts, ro).attributes.note, ent(facts, ro).attributes.governed_files], ['investigation only', 0]);
  assert.deepEqual(rel(facts, 'governs', AUTH, fileId('other/z.mjs')).attributes, {owners: [{unit: 'agent-ci', lists: ['allowed_extra'], patterns: ['other/z.mjs']}]});
  assert.deepEqual(governed(facts, AUTH), ['other/z.mjs', 'tools/deep/y.sh', 'tools/x.sh'].map(fileId));
});

test('A PATTERN THAT MATCHES NOTHING is recorded on the authorization and makes no relationship; a directory named without `/` or `/**` is listed apart and its files are not taken', t => {
  const {repo, head} = repoWith(t, manifest({coordinator_only: ['docs/GONE.md'], subwaves: {'9A': {'agent-a': {files: ['lib/a.mjs', 'lib/*.none', 'tools', 'lib/su*'], new_files: ['lib/planned.mjs']}}}}));
  const facts = ownershipFacts(repo, head), auth = ent(facts, AUTH);
  assert.deepEqual(governed(facts, AUTH), [fileId('lib/a.mjs')]);
  assert.deepEqual([auth.attributes.unmatched_patterns, auth.attributes.directory_patterns], [['docs/GONE.md', 'lib/*.none', 'lib/planned.mjs'], ['lib/su*', 'tools']]);
  assert.deepEqual(auth.missing_evidence, ['2 pattern(s) name a directory without a trailing `/` or `/**`: the files under it are not taken as covered']);
});

test('A WIDE PATTERN (more than 200 files) is NOT expanded: the pattern and its count are recorded and the authorization says so; exactly 200 files are expanded', t => {
  const many = Object.fromEntries(Array.from({length: WIDE + 1}, (_, i) => [`many/f${i}.txt`, `${i}\n`]));
  const few = Object.fromEntries(Array.from({length: WIDE}, (_, i) => [`few/f${i}.txt`, `${i}\n`]));
  const {repo, head} = repoWith(t, manifest({coordinator_only: ['many/'], subwaves: {'9A': {'agent-a': {files: ['many/**', 'few/**', 'many/f7.txt']}}}}), {...many, ...few});
  const facts = ownershipFacts(repo, head), auth = ent(facts, AUTH);
  assert.equal(WIDE, 200);
  assert.deepEqual(auth.attributes.wide_patterns, [{pattern: 'many/', count: 201}, {pattern: 'many/**', count: 201}]);
  assert.deepEqual(auth.missing_evidence, ['2 pattern(s) match more than 200 files each and are not expanded into relationships: each is listed with its count (wide_patterns)']);
  assert.deepEqual([governed(facts, AUTH).length, governed(facts, AUTH).filter(id => id.includes('/many/')), auth.attributes.governed_files], [201, [fileId('many/f7.txt')], 201],
    'the 200 files of few/** and the one file named by its own path; none from the wide pattern');
  assert.deepEqual(rel(facts, 'governs', AUTH, fileId('many/f7.txt')).attributes, {owners: [{unit: '9A/agent-a', lists: ['files'], patterns: ['many/f7.txt']}]});
});

test('NOTHING IS DROPPED SILENTLY: a key the reader does not interpret, a known key of an unexpected form, an entry that is not a path, and a unit that is not an object are each listed', t => {
  const {repo, head} = repoWith(t, manifest({surprise: {x: 1}, frozen: 'yes', dependencies: 'one string', subwaves: {'9A': {
    'agent-a': {files: ['lib/a.mjs', 'lib/?.mjs', 'see the brief for the rest', 42], mystery: true, findings: 'L-001', region_limits: {'lib/a.mjs, lib/b.mjs': 'both'}},
    'agent-x': 'not a unit'}}}));
  const facts = ownershipFacts(repo, head), auth = ent(facts, AUTH), a = ent(facts, assignmentId('wave-9', '9A', 'agent-a'));
  assert.deepEqual([auth.attributes.uninterpreted_keys, auth.attributes.frozen, auth.attributes.dependencies], [['dependencies', 'frozen', 'surprise'], null, []]);
  assert.deepEqual(auth.attributes.uninterpreted_entries, ['42', 'lib/?.mjs', 'see the brief for the rest']);
  assert.deepEqual(auth.attributes.units, ['9A/agent-a']);
  assert.deepEqual(auth.missing_evidence, ['3 path entry(ies) are not a path or pattern this reader interprets: they are listed, not matched (uninterpreted_entries)',
    '1 unit(s) are not an object with a name this reader reads and are not assignments: 9A/agent-x']);
  assert.deepEqual([a.attributes.uninterpreted_keys, a.attributes.findings, a.attributes.region_limits], [['findings', 'mystery'], [], [{path: 'lib/a.mjs, lib/b.mjs', limit: 'both'}]]);
  assert.deepEqual(governed(facts, AUTH).includes(fileId('lib/a.mjs')), true);
  assert.equal(rel(facts, 'governs', AUTH, fileId('lib/a.mjs')).attributes.owners[0].region_limits, undefined, 'a limit keyed by two paths in one string is kept as text, not attached to a file');
});

test('A MALFORMED MANIFEST, one that is not an object, and one of a schema this reader does not interpret are each an UNRESOLVED authorization with the reason; no relationship, no throw', t => {
  const {repo, commit} = tempRepo(t);
  const head = commit({...TREE, 'docs/execution/broken-ownership.json': '{"schema": ', 'docs/execution/list-ownership.json': '[1, 2]',
    'docs/execution/later-ownership.json': JSON.stringify({schema: 'ophanim.wave-ownership/v2', owners: {x: ['lib/**']}}), 'docs/execution/notes.json': '{}', 'docs/execution/deep/x-ownership.json': '{}'}, 'manifests');
  const facts = ownershipFacts(repo, head);
  assert.deepEqual(facts, [
    {entity: authorizationId('broken'), ref: 'docs/execution/broken-ownership.json', status: 'unresolved', attributes: {file: 'docs/execution/broken-ownership.json'},
      missing_evidence: ['docs/execution/broken-ownership.json is not valid JSON at this commit: nothing is read from it']},
    {entity: authorizationId('later'), ref: 'docs/execution/later-ownership.json', status: 'unresolved', attributes: {file: 'docs/execution/later-ownership.json', schema: 'ophanim.wave-ownership/v2', uninterpreted_keys: ['owners']},
      missing_evidence: ['schema "ophanim.wave-ownership/v2" is not one this reader interprets (ophanim.wave-ownership/v1): nothing else is read from it']},
    {entity: authorizationId('list'), ref: 'docs/execution/list-ownership.json', status: 'unresolved', attributes: {file: 'docs/execution/list-ownership.json'},
      missing_evidence: ['docs/execution/list-ownership.json is not a JSON object: nothing is read from it']},
  ]);
});

test('NO MANIFEST: a repository without docs/execution/*-ownership.json yields no fact', t => {
  const {repo, commit} = tempRepo(t);
  assert.deepEqual(ownershipFacts(repo, commit(TREE, 'no manifests')), []);
  assert.deepEqual([MANIFEST.test('docs/execution/wave-1-ownership.json'), MANIFEST.test('docs/execution/deep/x-ownership.json'), MANIFEST.test('docs/execution/ownership.json')], [true, false, false]);
});

test('THE COMMIT, never the working tree: an uncommitted manifest edit and an untracked file change nothing', t => {
  const {repo, head, write} = repoWith(t, manifest());
  const before = ownershipFacts(repo, head);
  write({[FILE]: JSON.stringify(manifest({coordinator_only: []})), 'lib/new.mjs': 'export const n = 0;\n', 'lib/a.mjs': null});
  assert.deepEqual(ownershipFacts(repo, head), before);
  assert.equal(rel(before, 'governs', AUTH, fileId('lib/new.mjs')), undefined);
});

test('THE GRAPH: observed after the repository source, the authorization governs each covered file from a DECLARED basis and authorizes its units, all established', t => {
  const {repo, head, commit} = repoWith(t, manifest());
  assert.deepEqual(OWNERSHIP_ORIGIN, {kind: 'extractor', basis: 'declared', sources: [SOURCE_ID]});
  const source = ownershipSource({repo});
  const g = openSystemsGraph({sources: [repoSource({repo}), source], extraOrigins: {[EXTRACTOR]: {...OWNERSHIP_ORIGIN, keys: ['graph-extractor']}}});
  t.after(g.close);
  g.graph.observe('ophanim.repo', {...g.by, observed_at: T0});
  const o = g.graph.observe(SOURCE_ID, {...g.by, observed_at: at(1)});
  assert.equal(o.recorded, true, o.why);
  assert.equal(o.record.source.version, head);
  const v = g.graph.view();
  const edge = (type, to) => {
    const e = v.edgesOf(AUTH).find(x => x.type === type && x.to === to);
    return e ? e.assertions.map(a => [v.established(a), v.assertion(a).origin]) : null;
  };
  assert.deepEqual([edge('governs', fileId('lib/a.mjs')), edge('governs', fileId('tools/deep/y.sh')), edge('governs', fileId(FILE)), edge('derived-from', fileId(FILE)),
    edge('authorizes', assignmentId('wave-9', '9A', 'agent-a')), edge('governs', fileId('other/z.mjs'))],
    [[[true, EXTRACTOR]], [[true, EXTRACTOR]], [[true, EXTRACTOR]], [[true, EXTRACTOR]], [[true, EXTRACTOR]], null]);
  assert.equal(v.edgesOf(AUTH).filter(e => e.type === 'governs').length, 8);
  assert.equal(v.node(AUTH).attributes.authorization, 'owner directive of the day');
  // A later commit that removes a governed file withdraws that relationship; a replay re-derives both readings.
  commit({'lib/sub/c.mjs': null}, 'remove a file');
  g.graph.observe('ophanim.repo', {...g.by, observed_at: at(2)});
  const o2 = g.graph.observe(SOURCE_ID, {...g.by, observed_at: at(3)});
  assert.equal(o2.recorded, true, o2.why);
  assert.equal(g.graph.view().edgesOf(AUTH).filter(e => e.type === 'governs').length, 7);
  assert.deepEqual(source.readAt(head), source.readAt(head));
  const again = g.open();
  assert.deepEqual([again.digest(), again.verification.complete], [g.graph.digest(), true]);
});

test('THE REAL REPOSITORY at HEAD: every manifest of the tree is one authorization, every governed id is a file of that tree, and no subject is stated twice', () => {
  const head = git(ROOT, 'rev-parse', 'HEAD'), tree = treeAt(ROOT, head), facts = ownershipFacts(ROOT, head);
  const manifests = tree.entries.filter(e => MANIFEST.test(e.path)).map(e => e.path);
  assert.ok(manifests.length > 0, 'the real tree holds ownership manifests');
  assert.deepEqual(facts.filter(d => d.entity?.includes('/evidence/authorization/')).map(d => d.attributes.file), manifests);
  const files = new Set(tree.entries.map(e => fileId(e.path)));
  assert.deepEqual(facts.filter(d => d.type === 'governs' && !files.has(d.to)), []);
  assert.equal(new Set(facts.map(d => d.entity ?? `${d.type}(${d.from} -> ${d.to})`)).size, facts.length);
  assert.deepEqual(facts.filter(d => d.status === 'unresolved'), [], 'every real manifest is of the schema this reader interprets');
});
