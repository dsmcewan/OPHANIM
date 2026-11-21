// The KD12 source adapter over the REAL lessons registry (ophanim/lessons/corrections.json, read only): projected as
// `learning` authoritative assertions by a registered extractor, keyed by class id at the file's git blob id, on a real
// packages/ledger chain with synthetic keys. A change to the registry yields its affected neighbourhood only; a
// replay re-derives every version from git; an unreadable registry is a visible state, and nothing is invented.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateSigner} from '../../packages/ledger/index.mjs';
import {createGraphLedger, openGraph, defineOrigins, affected, closure, entityId} from '../../packages/graph/index.mjs';
import {lessonsSource, lessonFacts, blobId, SOURCE_ID, EXTRACTOR, LESSONS_ORIGIN, REGISTRY_PATH, ROOT} from './lessons.mjs';

const ORIGINS = defineOrigins({[EXTRACTOR]: {...LESSONS_ORIGIN, keys: ['lessons-extractor']}});
const T0 = '2026-11-20T12:00:00.000Z';
const FC = key => entityId({domain: 'learning', type: 'failure-class', key});

function graphOver(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-lessons-graph-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const op = generateSigner('graph-operator'), ex = generateSigner('lessons-extractor');
  const anchor = createGraphLedger({dir, authority: {keyring: {'graph-operator': op.publicJwk, 'lessons-extractor': ex.publicJwk}, orderer: 'graph-operator', operators: ['graph-operator']}, operator: op, order: op});
  const open = (s = source) => openGraph({dir, anchor, origins: ORIGINS, sources: [s]});
  return {open, by: {signer: ex, order: op}};
}
const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=graph-test', '-c', 'user.email=graph-test@example.invalid', ...args], {encoding: 'utf8'}).trim();
function repoWith(t, text) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-lessons-repo-'));
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  git(repo, 'init', '-q');
  fs.mkdirSync(path.join(repo, path.dirname(REGISTRY_PATH)), {recursive: true});
  const commit = (body, msg) => { fs.writeFileSync(path.join(repo, REGISTRY_PATH), body); git(repo, 'add', REGISTRY_PATH); git(repo, 'commit', '-q', '-m', msg); };
  commit(text, 'registry as committed in OPHANIM');
  return {repo, commit};
}

test('lessons: the real registry is projected as learning authoritative assertions, keyed by class id at the file\'s git blob id', t => {
  const file = path.join(ROOT, REGISTRY_PATH), bytes = fs.readFileSync(file), reg = JSON.parse(bytes);
  const {open, by} = graphOver(t, lessonsSource());
  const started = process.hrtime.bigint();
  const g = open(), r = g.observe(SOURCE_ID, {...by, observed_at: T0});
  const projected = Number(process.hrtime.bigint() - started) / 1e6;
  const version = git(ROOT, 'hash-object', REGISTRY_PATH);
  assert.equal(r.record.source.version, version, 'the version is git\'s object id of the registry\'s bytes');
  assert.equal(blobId(bytes), version);
  const v = g.view();
  const classes = v.subjects().filter(s => s.startsWith('ophanim/learning/failure-class/'));
  assert.deepEqual(classes.sort(), reg.classes.map(c => FC(c.id)).sort(), 'one failure class per registry class, keyed by its id');
  // A floor, not a pin: the registry grows with every recorded lesson, and the line above already requires one class per entry.
  assert.ok(classes.length >= 19, `the real registry, not an empty or truncated one: ${classes.length} classes`);
  for (const c of reg.classes) {
    const n = v.node(FC(c.id)), a = n.assertions[0];
    assert.deepEqual([n.established, a.classification, a.origin, a.source.id, a.source.version], [true, 'authoritative', EXTRACTOR, SOURCE_ID, version], c.id);
    assert.equal(n.attributes.instances.length, c.instances.length);
    const missing = v.assertion(a.id).record.missing_evidence;
    assert.equal(missing.some(m => m.startsWith('no executable detector')), c.detector.kind !== 'test', `${c.id}: a class without a detector says so`);
    const detects = v.edgesOf(FC(c.id)).filter(e => e.type === 'detects');
    assert.deepEqual(detects.map(e => e.from), c.detector.kind === 'test' ? [entityId({domain: 'systems', type: 'test', key: `${c.detector.file}#${c.detector.name}`})] : []);
    const fix = v.edgesOf(FC(c.id)).filter(e => e.type === 'introduced-because-of');
    assert.deepEqual(fix.map(e => e.from), c.fixed_in ? [entityId({domain: 'systems', type: 'change', key: c.fixed_in})] : []);
  }
  assert.equal(g.observe(SOURCE_ID, {...by, observed_at: '2026-11-20T13:00:00.000Z'}).recorded, false, 'observed again at the same version: a no-op');
  const replayStarted = process.hrtime.bigint(), again = open(), replayed = Number(process.hrtime.bigint() - replayStarted) / 1e6;
  assert.deepEqual([again.digest(), again.verification.complete], [g.digest(), true], 'a replay re-derives the same projection');
  assert.ok(fs.readFileSync(file).equals(bytes), 'the registry is read, never written');
  t.diagnostic(`lessons registry: ${r.record.attributes.count} facts (${classes.length} classes); observe ${projected.toFixed(1)} ms, replay ${replayed.toFixed(1)} ms`);
  // A change to a detector's test reaches the class it detects, never the other classes it does not.
  const withTest = reg.classes.find(c => c.detector.kind === 'test');
  const reach = closure(v, entityId({domain: 'systems', type: 'test', key: `${withTest.detector.file}#${withTest.detector.name}`})).nodes.map(n => n.id);
  assert.ok(reach.includes(FC(withTest.id)) && reach.filter(x => x.startsWith('ophanim/learning/')).length === reg.classes.filter(c => c.detector.file === withTest.detector.file && c.detector.name === withTest.detector.name).length);
});

test('lessons: a change to the registry yields its affected neighbourhood only, and a replay re-derives every version from git', t => {
  const real = fs.readFileSync(path.join(ROOT, REGISTRY_PATH), 'utf8'), reg = JSON.parse(real);
  const {repo, commit} = repoWith(t, real);
  const {open, by} = graphOver(t, lessonsSource({repo}));
  const g = open();
  g.observe(SOURCE_ID, {...by, observed_at: T0});
  // Reordering the classes changes the bytes and the version, and nothing the graph says.
  commit(JSON.stringify({...reg, classes: [...reg.classes].reverse()}, null, 2) + '\n', 'reorder');
  const moved = g.observe(SOURCE_ID, {...by, observed_at: '2026-11-20T12:01:00.000Z'});
  assert.deepEqual([moved.recorded, moved.event.nodes, moved.event.relationships], [true, [], []], 'a class is keyed by its id, not its position');
  // One class's text changes.
  const target = reg.classes.find(c => c.fixed_in), changed = {...reg, classes: reg.classes.map(c => (c.id === target.id ? {...c, class: `${c.class} (reworded)`} : c))};
  commit(JSON.stringify(changed, null, 2) + '\n', 'reword one class');
  const e = g.observe(SOURCE_ID, {...by, observed_at: '2026-11-20T12:02:00.000Z'}).event;
  assert.deepEqual([e.nodes, e.relationships], [[FC(target.id)], []]);
  const a = affected(g.projection, e);
  assert.deepEqual(a.nodes.map(n => n.id).sort(), [FC(target.id), entityId({domain: 'systems', type: 'change', key: target.fixed_in})].sort(),
    'the class and the fix introduced because of it; no other class');
  assert.equal(g.view(e.seq - 1).node(FC(target.id)).attributes.class, target.class, 'the earlier text is still there to view');
  // The working file is now the last version; every earlier one comes back from git's object store on replay.
  const again = open();
  assert.deepEqual([again.digest(), again.verification.complete], [g.digest(), true]);
  assert.equal(again.view().sources()[0].replay, 'applied');
});

test('lessons: an unreadable registry is recorded as unavailable, and a replay that cannot reach an old version marks it and invents nothing', t => {
  const real = fs.readFileSync(path.join(ROOT, REGISTRY_PATH), 'utf8');
  const {repo} = repoWith(t, real);
  const {open, by} = graphOver(t, lessonsSource({repo}));
  const g = open();
  g.observe(SOURCE_ID, {...by, observed_at: T0});
  fs.rmSync(path.join(repo, REGISTRY_PATH));
  assert.equal(g.freshness()[0].state, 'unavailable');
  const u = g.observe(SOURCE_ID, {...by, observed_at: '2026-11-20T12:05:00.000Z'});
  assert.deepEqual([u.recorded, u.state], [true, 'unavailable']);
  assert.equal(g.view().node(FC(JSON.parse(real).classes[0].id)).present, true, 'the classes stay as last observed');
  // Another checkout without that history: the version cannot be re-derived, so its facts are not there.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-lessons-empty-'));
  t.after(() => fs.rmSync(empty, {recursive: true, force: true}));
  git(empty, 'init', '-q');
  const blind = open(lessonsSource({repo: empty}));
  assert.deepEqual([blind.verification.complete, blind.view().sources()[0].replay], [false, 'unavailable']);
  assert.equal(blind.view().subjects().filter(s => s.startsWith('ophanim/learning/')).length, 0);
  assert.throws(() => lessonFacts('{"schema": "something-else"}'), /not ophanim.owner-corrections\/v1/);
});
