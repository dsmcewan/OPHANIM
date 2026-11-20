// The weave source (ophanim/graph/deps/weave.mjs): TELOS's Clotho weaves its own dependency graph into a hash-chained,
// signed ledger and commits a snapshot. This source brings that snapshot in as what TELOS DECLARES, after checking the
// chain, every record hash and every signature. SYNTHETIC: the weave below is made and signed by this test with a key
// generated here; the repository is temporary. No network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {weaveFacts, weaveSource, WEAVE_ORIGIN, WEAVE_EXTRACTOR, WEAVE_PATH, weaveSourceIdOf, canonical} from './deps/weave.mjs';
import {codeSource, codeOrigin, CODE_EXTRACTOR, sourceIdOf} from './deps/code.mjs';
import {fileIdIn, symbolIdIn, checkIdIn, changeIdIn, repositoryId} from './deps/ids.mjs';
import {openSystemsGraph} from './extract/index.mjs';
import {tempRepo, git, T0, at} from './fixtures/repo.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');
const REF = 'git-root:' + '1'.repeat(40), COMMIT = 'c'.repeat(40);
const CODE = {'lib/a.mjs': "import {b} from './b.mjs';\nexport function a() { return b(); }\n", 'lib/b.mjs': 'export function b() { return 1; }\n',
  'scripts/test-a.mjs': "import {a} from '../lib/a.mjs';\na();\n", 'docs/a.md': '# A\n\n## Use\n\ntext\n'};

/** A weave signed here: `edges(blob)` gets the blob id of a path in the repository and returns the edge payloads. */
function weave(t, edges, {tamper = null} = {}) {
  const {repo, commit} = tempRepo(t);
  commit(CODE, 'code');
  const blob = p => git(repo, 'rev-parse', `HEAD:${p}`);
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const header = canonical({clotho_weave_header: {pub_key: publicKey.export({type: 'spki', format: 'der'}).toString('base64'), repo_head: git(repo, 'rev-parse', 'HEAD'),
    repository_ref: REF, weave_version: 1, woven_at: '2026-11-20T00:00:00.000Z'}});
  const out = [header];
  for (const payload of edges(blob)) {
    const prev_hash = sha(out.at(-1)), record_hash = sha(canonical({...payload, prev_hash}));
    out.push(canonical({...payload, prev_hash, record_hash, signature: sign(null, Buffer.from(record_hash, 'hex'), privateKey).toString('base64')}));
  }
  out.push(canonical({clotho_weave_trailer: {inventories_consumed: [], orchestrator_refs: [], weavers: []}}));
  if (tamper) tamper(out);
  return {repo, head: commit({[WEAVE_PATH]: out.join('\n') + '\n'}, 'weave'), blob};
}
const sym = (blob, p, symbol) => ({kind: 'code-symbol', locator: {blob_sha: blob(p), path: p, repository_ref: REF, symbol}});
const file = (blob, p) => ({kind: 'repository-file', locator: {blob_sha: blob(p), path: p, repository_ref: REF}});
const edge = (edge_kind, from_locator, to_locator, by = 'clotho-code-weaver') => ({asserted_by: by, assertion_status: 'deterministic-extraction', edge_kind,
  from_locator, from_node: sha(canonical(from_locator)), source_ref: `file:${from_locator.locator.path}@${from_locator.locator.blob_sha}`, to_locator, to_node: sha(canonical(to_locator)),
  woven_at: '2026-11-20T00:00:00.000Z'});
const EDGES = blob => [
  edge('depends-on', sym(blob, 'lib/a.mjs', 'a'), sym(blob, 'lib/b.mjs', 'b')),
  edge('depends-on', file(blob, 'scripts/test-a.mjs'), sym(blob, 'lib/a.mjs', 'a')),
  edge('verified-by', sym(blob, 'lib/a.mjs', 'a'), {kind: 'test', locator: {blob_sha: blob('scripts/test-a.mjs'), path: 'scripts/test-a.mjs', repository_ref: REF}}, 'clotho-test-weaver'),
  edge('documented-in', sym(blob, 'lib/a.mjs', 'a'), {kind: 'doc-section', locator: {heading_path: ['A', 'Use'], path: 'docs/a.md', repository_ref: REF, text_sha256: 'd'.repeat(64)}}, 'clotho-doc-weaver'),
  edge('introduced-by', file(blob, 'lib/b.mjs'), {kind: 'commit', locator: {sha: COMMIT}}, 'clotho-git-weaver'),
  edge('motivated-by', sym(blob, 'lib/a.mjs', 'a'), {kind: 'concern', locator: {entry_hash: 'e'.repeat(64), ledger_path: 'docs/ledgers/x.jsonl', repository_ref: REF}}, 'clotho-ledger-weaver'),
];
const rel = (facts, type, from, to) => facts.find(d => d.type === type && d.from === from && d.to === to);
const root = facts => facts.find(d => d.entity === repositoryId('telos'));

test('A VERIFIED WEAVE is brought in as what the sibling declares: each edge with the record hash that carries it', t => {
  const {repo, head} = weave(t, EDGES), facts = weaveFacts(repo, head);
  const a = symbolIdIn('telos', 'lib/a.mjs', 'a'), b = symbolIdIn('telos', 'lib/b.mjs', 'b');
  const e = rel(facts, 'depends-on', a, b);
  assert.deepEqual(Object.keys(e.attributes).sort(), ['asserted_by', 'assertion_status', 'basis', 'record_hash', 'source_ref']);
  assert.deepEqual([e.attributes.basis, e.attributes.asserted_by, e.attributes.assertion_status], ['the sibling\'s signed weave declares it', 'clotho-code-weaver', 'deterministic-extraction']);
  assert.match(e.attributes.record_hash, /^[0-9a-f]{64}$/);
  assert.ok(rel(facts, 'depends-on', fileIdIn('telos', 'scripts/test-a.mjs'), a), 'a file-to-symbol dependency');
  assert.deepEqual(rel(facts, 'depends-on', fileIdIn('telos', 'lib/a.mjs'), fileIdIn('telos', 'lib/b.mjs')).attributes,
    {basis: 'the weave declares a dependency between symbols of these files', edges: 1});
  assert.deepEqual(root(facts).attributes.weave, {path: WEAVE_PATH, records: 6, verified: 'the hash chain, each record hash and each signature',
    key: 'carried in the weave\'s own header: evidence against tampering, not of who signed', woven_at: '2026-11-20T00:00:00.000Z', woven_from: root(facts).attributes.weave.woven_from,
    stated: 5, stale: 0, unmapped: {'motivated-by': 1}});
});

test('WHAT THE WEAVE CALLS A TEST is its own check node, the documented section keeps its heading, and an introducing commit is the sibling\'s commit', t => {
  const {repo, head} = weave(t, EDGES), facts = weaveFacts(repo, head), a = symbolIdIn('telos', 'lib/a.mjs', 'a');
  const check = checkIdIn('telos', 'scripts/test-a.mjs');
  assert.ok(rel(facts, 'verified-by', a, check));
  assert.deepEqual(rel(facts, 'derived-from', check, fileIdIn('telos', 'scripts/test-a.mjs')).attributes, {basis: 'the weave names this file as a test'});
  assert.deepEqual(rel(facts, 'documented-in', a, fileIdIn('telos', 'docs/a.md')).attributes.section, {heading_path: ['A', 'Use'], text_sha256: 'd'.repeat(64), checked: false});
  assert.ok(rel(facts, 'derived-from', fileIdIn('telos', 'lib/b.mjs'), changeIdIn('telos', COMMIT)));
});

test('A WEAVE THAT DOES NOT VERIFY gives no facts but the reason: a changed record, a broken chain, a bad signature', t => {
  const cases = [
    [out => { out[1] = out[1].replace('"symbol":"b"', '"symbol":"x"'); }, /^line 2: record hash does not match its content$/],
    [out => { out.splice(2, 1); }, /^line 3: broken chain \(prev_hash is not the hash of the line before\)$/],
    [out => { const o = JSON.parse(out[1]); o.signature = Buffer.alloc(64, 7).toString('base64'); out[1] = canonical(o); }, /^line 2: the signature does not verify under the header's key$/],
  ];
  for (const [tamper, why] of cases) {
    const {repo, head} = weave(t, EDGES, {tamper}), facts = weaveFacts(repo, head);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].status, 'unresolved');
    assert.match(facts[0].missing_evidence[0], why);
  }
});

test('AN EDGE WOVEN FROM A FILE THAT HAS SINCE CHANGED is not stated: it is counted as stale, with the blob it was woven from', t => {
  const {repo, head} = weave(t, blob => [edge('depends-on', {kind: 'code-symbol', locator: {blob_sha: 'f'.repeat(40), path: 'lib/a.mjs', repository_ref: REF, symbol: 'a'}}, sym(blob, 'lib/b.mjs', 'b'))]);
  const facts = weaveFacts(repo, head);
  assert.ok(!facts.some(d => d.type === 'depends-on'));
  assert.deepEqual([root(facts).attributes.weave.stated, root(facts).attributes.weave.stale], [0, 1]);
  assert.deepEqual(root(facts).attributes.stale_examples, [{line: 2, path: 'lib/a.mjs', woven_from: 'f'.repeat(40), now: git(repo, 'rev-parse', `${head}:lib/a.mjs`)}]);
});

test('NO WEAVE AT THE COMMIT is said so; it is not an error and not an empty graph', t => {
  const {repo, commit} = tempRepo(t), head = commit(CODE, 'code'), facts = weaveFacts(repo, head);
  assert.deepEqual(facts.map(d => [d.status, d.missing_evidence]), [['unresolved', [`${WEAVE_PATH} is not in the tree at this commit`]]]);
});

test('IN THE GRAPH the sibling\'s declared edge and this repository\'s own reading of the same code support one relationship, each under its own source', t => {
  const {repo, head} = weave(t, EDGES);
  const g = openSystemsGraph({sources: [codeSource({repo, name: 'telos'}), weaveSource({repo})],
    extraOrigins: {[CODE_EXTRACTOR]: {...codeOrigin(['telos']), keys: ['graph-extractor']}, [WEAVE_EXTRACTOR]: {...WEAVE_ORIGIN, keys: ['graph-extractor']}}});
  t.after(g.close);
  g.graph.observe(sourceIdOf('telos'), {...g.by, observed_at: T0});
  const o = g.graph.observe(weaveSourceIdOf('telos'), {...g.by, observed_at: at(1)});
  assert.deepEqual([o.recorded, o.record.source.version], [true, head], o.why);
  const v = g.graph.view(), a = symbolIdIn('telos', 'lib/a.mjs', 'a'), b = symbolIdIn('telos', 'lib/b.mjs', 'b');
  const [call] = v.edgesOf(a, {mode: 'established', types: ['depends-on']}).filter(e => e.to === b);
  assert.deepEqual(call.assertions.map(id => v.assertion(id).record.source.id).sort(), ['sibling.telos.code', 'sibling.telos.weave']);
});
