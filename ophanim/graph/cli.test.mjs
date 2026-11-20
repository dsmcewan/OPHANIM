// Slice B, KB5: the command-line query answers the directive's section 8 questions about a REAL component of this
// checkout (its graph at HEAD), each bounded, explained and naming its sources and versions; a usage error and an
// unknown subject say so. One real process run proves the command path end to end (it builds its own graph).
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {run} from './cli.mjs';
import {QUERIES} from './impact.mjs';
import {fileId} from './extract/repo.mjs';
import {realGraph, closeRealGraph, ROOT} from './fixtures/repo.mjs';

after(closeRealGraph);
const SUBJECT = 'ophanim/efficiency/investigation/chairs.mjs';

test('cli: every section-8 query about a real component is answered, bounded, with its sources and versions', () => {
  const built = realGraph();
  const introduced = JSON.parse(run(['trace', SUBJECT], {built}).output).commits.introduced.commit;
  for (const q of QUERIES) {
    const r = run([q, SUBJECT, ...(q === 'changed-since' ? ['--since', introduced] : [])], {built});
    assert.equal(r.code, 0, `${q}: ${r.output.slice(0, 300)}`);
    const a = JSON.parse(r.output);
    assert.deepEqual([a.query, a.subject, a.graph.commit], [q, fileId(SUBJECT), built.commit]);
    assert.ok(a.sources.length && a.sources.every(s => s.source && s.version), `${q}: its sources and versions`);
    assert.ok(Object.values(a.graph.sources).every(s => s.version), `${q}: the graph says what it was built from`);
  }
  const inv = JSON.parse(run(['invalidates', SUBJECT, '--max-nodes', '3'], {built}).output);
  assert.equal(inv.coverage.truncated, true);
  assert.ok(inv.continuation, 'a cut answer says how to continue');
  assert.equal(JSON.parse(run(['why', SUBJECT], {built}).output).exists_because.requirements[0].kind, 'ticket');
  assert.equal(run(['why', 'no/such/file.mjs'], {built}).code, 1);
  assert.equal(run(['nonsense', SUBJECT], {built}).code, 2);
  assert.equal(run(['why'], {built}).code, 2);
  assert.equal(run(['dependents', SUBJECT, '--depth', 'x'], {built}).code, 2);
});

test('cli: the dependency questions (Slice B2, KD2-8) about real subjects, each with its sources and versions', () => {
  const built = realGraph();
  const ask = argv => { const r = run(argv, {built}); assert.equal(r.code, 0, `${argv.join(' ')}: ${r.output.slice(0, 300)}`); return JSON.parse(r.output); };
  const pkg = ask(['package', '@google/genai']);
  assert.ok(pkg.direct.imports['run-time'].total > 0 && pkg.packages[0].version && pkg.graph.commit === built.commit);
  const needs = ask(['needs', 'ophanim/public/github.mjs']);
  assert.ok(needs.needs['run-time'].environment.shown.some(e => e.name === 'GITHUB_TOKEN' && e.lines.length));
  assert.ok(ask(['needs', 'ophanim/public/github.mjs', '--transitive']).transitive);
  const auth = ask(['authority', 'ophanim/graph/impact.mjs']);
  assert.ok(auth.authorized_by.some(a => a.region_limits.length && a.sources.every(s => s.version)));
  for (const subject of ['repository:telos', 'lock:package-lock.json#pantheon/node_modules/@google/genai']) {
    const inv = ask(['invalidates', subject]);
    assert.ok(inv.counts.consumers > 0 && inv.sources.every(s => s.source && s.version), `${subject}: what a change to it reaches, with its sources`);
  }
  for (const a of [pkg, needs, auth]) assert.ok(a.sources.length && a.sources.every(s => s.version), `${a.query}: its sources and versions`);
  assert.equal(run(['package', 'no-such-package'], {built}).code, 1);
});

test('cli: a real process run builds the graph at the commit and answers from it', () => {
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'ophanim/graph/cli.mjs'), 'requirement', SUBJECT, '--commit', head], {encoding: 'utf8', maxBuffer: 1 << 26});
  assert.equal(r.status, 0, r.stderr);
  const a = JSON.parse(r.stdout);
  assert.equal(a.graph.commit, head);
  assert.deepEqual(a.requirements.map(x => x.kind), ['ticket', 'status item']);
  assert.ok(a.requirements.every(x => x.sources.every(s => s.version)));
});
