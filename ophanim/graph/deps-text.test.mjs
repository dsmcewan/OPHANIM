// The textual source of the dependency graph (ophanim/graph/deps/text.mjs): the hosts and the tracked paths a file NAMES
// in a string. A name is a mention, never a dependency: impact does not follow it. SYNTHETIC: the repository below is
// made in a temporary directory by this test, and its hosts do not exist. Synthetic keys only; no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {textFacts, textSource, textOrigin, TEXT_EXTRACTOR, textSourceIdOf} from './deps/text.mjs';
import {hostId, fileIdIn} from './deps/ids.mjs';
import {repoSource, fileId} from './extract/repo.mjs';
import {openSystemsGraph} from './extract/index.mjs';
import {impact} from './impact.mjs';
import {tempRepo, T0, at} from './fixtures/repo.mjs';

const lines = (...l) => l.join('\n') + '\n';
const FILES = {
  'app/client.mjs': lines(
    "const BASE = 'https://api.example.test/v1';",
    "const again = `https://api.example.test/v2/${id}`;",
    "const table = 'app/data/table.json';",
    "const near = './notes.md';",
    "const absent = 'app/data/missing.json';",
    "// https://comment.example.test and app/data/other.json are in a comment",
    "export const urls = [BASE, again, table, near, absent];",
  ),
  'app/data/table.json': '[]\n', 'app/data/other.json': '[]\n', 'app/notes.md': 'notes\n',
};
const rel = (facts, from, to) => facts.find(d => d.type === 'mentions' && d.from === from && d.to === to);

test('A HOST NAMED IN A STRING is a mention with its lines; a host in a comment is not', t => {
  const {repo, commit} = tempRepo(t), head = commit(FILES, 'fixture'), facts = textFacts(repo, head);
  const host = hostId('api.example.test'), client = fileId('app/client.mjs');
  assert.deepEqual(facts.find(d => d.entity === host).attributes, {host: 'api.example.test', named_by: 1});
  assert.deepEqual(rel(facts, client, host).attributes, {basis: 'the file names this host in a string', lines: [1, 2]});
  assert.deepEqual(facts.filter(d => d.entity?.includes('/systems/service/')).map(d => d.entity), [host]);
});

test('A TRACKED PATH NAMED IN A STRING is a mention only when the string is exactly a tracked file, from the root or beside the file', t => {
  const {repo, commit} = tempRepo(t), head = commit(FILES, 'fixture'), facts = textFacts(repo, head), client = fileId('app/client.mjs');
  assert.deepEqual(rel(facts, client, fileId('app/data/table.json')).attributes, {basis: 'the file names this path in a string', lines: [3], as_written: 'app/data/table.json'});
  assert.deepEqual(rel(facts, client, fileId('app/notes.md')).attributes, {basis: 'the file names this path in a string', lines: [4], as_written: './notes.md'});
  assert.deepEqual(facts.filter(d => d.type === 'mentions' && d.from === client).map(d => d.to).sort(), [fileId('app/data/table.json'), fileId('app/notes.md'), hostId('api.example.test')].sort(),
    'a path that is not tracked, and a path in a comment, are not mentions');
  assert.ok(facts.every(d => !d.type || d.type === 'mentions'), 'this source states mentions and nothing else');
});

test('IN THE GRAPH a mention is established and is NOT a dependency: a change to the named file does not affect the file that names it', t => {
  const {repo, commit} = tempRepo(t), head = commit(FILES, 'fixture');
  const g = openSystemsGraph({sources: [repoSource({repo}), textSource({repo})], extraOrigins: {[TEXT_EXTRACTOR]: {...textOrigin(['ophanim']), keys: ['graph-extractor']}}});
  t.after(g.close);
  g.graph.observe('ophanim.repo', {...g.by, observed_at: T0});
  const o = g.graph.observe(textSourceIdOf('ophanim'), {...g.by, observed_at: at(1)});
  assert.deepEqual([o.recorded, o.record.source.version], [true, head], o.why);
  const v = g.graph.view(), client = fileId('app/client.mjs'), table = fileId('app/data/table.json');
  assert.equal(v.edgesOf(client, {mode: 'established', types: ['mentions']}).filter(e => e.to === table).length, 1);
  const r = impact(v, [table]);
  assert.deepEqual(Object.values(r.affected).flat().map(n => n.id), [], 'nothing is declared affected through a mention');
  assert.deepEqual(r.citing.map(c => c.record), [client], 'the file that names it is listed for reassessment');
});

test('A SIBLING REPOSITORY\'S mentions are between its own nodes, which this source states', t => {
  const {repo, commit} = tempRepo(t), head = commit(FILES, 'fixture'), facts = textFacts(repo, head, {name: 'lexi'});
  const client = fileIdIn('lexi', 'app/client.mjs'), table = fileIdIn('lexi', 'app/data/table.json');
  assert.ok(rel(facts, client, table));
  assert.deepEqual([client, table].map(id => facts.some(d => d.entity === id)), [true, true]);
  assert.equal(textSource({repo, name: 'lexi'}).id, 'sibling.lexi.code-text');
});
