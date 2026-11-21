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

// Slice D part 1 (docs/knowledge-graph/slice-d1.md): why-exists and learning about REAL components; shared-prerequisites
// over a SYNTHETIC work ledger (this container holds none), built with the real capability graph.
test('cli: the Slice D part 1 queries -- why-exists and learning on real components, shared-prerequisites on a synthetic work ledger', async () => {
  const {d1WorkLedger, SHARED_CONTRACT} = await import('./fixtures/d1-work.mjs');
  const fs = await import('node:fs');
  const built = realGraph();
  const ask = argv => { const r = run(argv, {built}); assert.equal(r.code, 0, `${argv.join(' ')}: ${r.output.slice(0, 300)}`); return JSON.parse(r.output); };
  const why = ask(['why-exists', 'pantheon/src/route/gemini-billing.mjs']);
  assert.deepEqual([why.query, why.decisions.map(d => d.entry), why.graph.commit], ['why-exists', ['L-136'], built.commit]);
  const learn = ask(['learning', 'ophanim/operate/context.mjs', '--claim', 'stored but never delivered']);
  assert.ok(learn.established.classes.length > 0 && learn.established.classes.every(c => c.path.at(-1).type === 'detects'));
  assert.equal(run(['shared-prerequisites'], {built}).code, 2, 'it names the work ledger it reads');
  assert.equal(run(['why-exists'], {built}).code, 2);
  const w = d1WorkLedger();
  try {
    const r = run(['shared-prerequisites', '--work-root', w.root, '--work-anchor', w.anchor, '--commit', built.commit]);
    assert.equal(r.code, 0, r.output.slice(0, 300));
    const f = JSON.parse(r.output).findings.find(x => x.prerequisite === SHARED_CONTRACT);
    assert.deepEqual([f.items.length, f.existence.exists], [3, false]);
  } finally { fs.default.rmSync(w.dir, {recursive: true, force: true}); }
});

// The hub-readiness determination (hub.mjs; docs/knowledge-graph/hub-and-spoke.md): ADVISORY, on a synthetic federation
// of three departments sized from THIS graph, here at a tiny scale so the cell stays fast.
test('cli: hub-readiness -- the determination on this repository, sized from its own graph, with its criteria and verdict', () => {
  const built = realGraph();
  const r = run(['hub-readiness', '--scales', '0.002'], {built});
  assert.equal(r.code, 0, r.output.slice(0, 300));
  const a = JSON.parse(r.output);
  assert.deepEqual([a.schema, a.graph.commit, a.criteria.map(c => c.id)], ['ophanim.hub-readiness/v1', built.commit, ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12']]);
  assert.equal(a.sizing.measured.entities, built.graph.view().stats().entities, 'each department is sized from this graph');
  assert.ok(['APPROPRIATE', 'APPROPRIATE WITH CONDITIONS', 'NOT APPROPRIATE NOW'].includes(a.verdict.verdict));
  assert.ok(a.verdict.failing.every(id => a.criteria.find(c => c.id === id).blocking), 'a failing criterion is a blocking one');
  assert.ok(a.criteria.every(c => c.threshold) && a.code_facts.every(f => f.at), 'every threshold stated, every code fact located');
  assert.ok(a.register['KG-14'].graph_id && a.register['KG-4'].status, 'the register is read through the graph\'s records source');
  assert.equal(run(['hub-readiness', '--scales', '0'], {built}).code, 2);
});
