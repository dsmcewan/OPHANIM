// Slice D part 1, the LEARNING graph (KD1-3, KD1-4; docs/knowledge-graph/slice-d1.md): the lessons registry EXTENDED (its
// instances as defects, its fixes as repairs, its classes without a detector as detection gaps), review findings from the
// cycle LEDGER through its reader, mutation outcomes OBSERVED with their run; `shares-failure-mechanism-with` admitted
// only from a declared basis, similarity at most a hypothesis; learning reuse (demonstration 5) on REAL data; and the
// negative cases of demonstration 12 at this level (a broken reference, a similarity-only link, a withheld path).
// REAL: the registry, the register, the repository and its mutation runners' tables. SYNTHETIC: the cycle ledger and a
// mutation run's summary (none is committed: the runners' logs are not in the repository).
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertion} from '../../packages/graph/index.mjs';
import {learningFacts, learningSource, cycleLearningSource, learningReuse, registryMechanisms, recordRegistryMechanisms, sharedMechanismRecord, assertSharedMechanism,
  similarityCandidates, proposeSimilarMechanism, similarityRecord, recordMutationOutcomes, withheldRefusal, classId, findingId,
  LEARNING_SOURCE, CYCLE_LEARNING_SOURCE, LEARNING_RULE, SIMILARITY_RULE, MUTATION_TOOL} from './learning.mjs';
import {REGISTRY_PATH} from './lessons.mjs';
import {openSystemsGraph, ROOT} from './extract/index.mjs';
import {fileId} from './extract/repo.mjs';
import {mutationId} from './extract/verification.mjs';
import {d1CycleLedger} from './fixtures/d1-work.mjs';
import {d1Graph, T0} from './fixtures/d1-graph.mjs';

let real = null;
/** The REAL learning graph of this checkout at HEAD: repository, verification, the register's records, lessons, learning. */
const realLearning = () => (real ??= d1Graph({only: ['ophanim.repo', 'ophanim.verification', 'ophanim.records', 'ophanim.lessons', LEARNING_SOURCE]}));
after(() => { if (real) real.close(); });
const registry = () => JSON.parse(fs.readFileSync(path.join(ROOT, REGISTRY_PATH), 'utf8'));
const edge = (v, type, from, to) => v.edgesOf(from, {mode: 'established', types: [type]}).some(e => e.from === from && e.to === to);
const ofSource = (v, source, kind) => v.subjects().filter(s => !s.includes('(') && s.includes(`/learning/${kind}/`) && v.query(s, 'established').some(a => a.source.id === source));

test('learning: the lessons registry EXTENDED, read only -- every instance a defect of its class, every fix a repair, every class without a detector a detection gap (REAL registry)', () => {
  const bytes = fs.readFileSync(path.join(ROOT, REGISTRY_PATH));
  const g = realLearning(), v = g.graph.view(), reg = registry();
  assert.deepEqual([g.observed[LEARNING_SOURCE].recorded, g.observed[LEARNING_SOURCE].state], [true, 'current']);
  const instances = reg.classes.reduce((n, c) => n + c.instances.length, 0), fixed = reg.classes.filter(c => c.fixed_in), none = reg.classes.filter(c => c.detector?.kind !== 'test');
  assert.equal(ofSource(v, LEARNING_SOURCE, 'defect').length, instances, 'one defect per recorded instance');
  assert.equal(ofSource(v, LEARNING_SOURCE, 'repair').length, fixed.length, 'one repair per recorded fix');
  assert.equal(ofSource(v, LEARNING_SOURCE, 'detection-gap').length, none.length, 'one detection gap per class without an executable detector');
  for (const c of reg.classes) {
    const fc = classId(c.id);
    const defects = v.edgesOf(fc, {mode: 'established', types: ['documented-in']}).filter(e => e.to === fc && e.from.includes('/learning/defect/'));
    assert.equal(defects.length, c.instances.length, `${c.id}: its instances are its defects`);
    const repairs = v.edgesOf(fc, {mode: 'established', types: ['introduced-because-of']}).filter(e => e.to === fc && e.from.includes('/learning/repair/'));
    assert.equal(repairs.length, c.fixed_in ? 1 : 0, `${c.id}: a repair exactly when the registry records a fix`);
  }
  for (const c of fixed) {
    const r = v.edgesOf(classId(c.id), {mode: 'established', types: ['introduced-because-of']}).find(e => e.to === classId(c.id) && e.from.includes('/learning/repair/'));
    assert.equal(v.node(r.from).attributes.fixed_in, c.fixed_in.length > 300 ? v.node(r.from).attributes.fixed_in : c.fixed_in);
    assert.equal(v.node(r.from).attributes.commit === null, !/^[0-9a-f]{7,40}\b/.test(c.fixed_in), `${c.id}: a fix that names no commit says so`);
  }
  const gap = v.node(classId('withheld-path-read').replace('/failure-class/', '/detection-gap/'));
  assert.match(gap.attributes.next, /exclusion pathspec/, 'the gap carries the registry\'s next step');
  // EXTENDS, never duplicates: the learning source asserts no class, detector edge or fix edge of Slice A's.
  for (const s of v.subjects()) for (const a of v.query(s, 'established').filter(x => x.source.id === LEARNING_SOURCE)) {
    assert.ok(!a.subject.includes('/learning/failure-class/') || a.subject.includes('('), `${a.subject}: Slice A's class is not re-asserted`);
    assert.ok(!a.subject.startsWith('detects('), `${a.subject}: Slice A's detector edge is not re-asserted`);
  }
  // Keyed by what an instance records, never by its position: reversing the instances changes no subject.
  const text = fs.readFileSync(path.join(ROOT, REGISTRY_PATH), 'utf8'), rev = JSON.parse(text);
  for (const c of rev.classes) c.instances.reverse();
  const subjects = t => learningFacts(t).map(d => d.entity ?? `${d.type}(${d.from} -> ${d.to})`).sort();
  assert.deepEqual(subjects(JSON.stringify(rev)), subjects(text));
  assert.deepEqual(fs.readFileSync(path.join(ROOT, REGISTRY_PATH)), bytes, 'the registry is unchanged');
});

test('learning: observed without Slice A\'s lessons source, the learning facts\' references are broken and the observation is REFUSED (demonstration 12)', t => {
  const g = openSystemsGraph({sources: [learningSource({repo: ROOT})]});
  t.after(() => g.close());
  assert.throws(() => g.graph.observe(LEARNING_SOURCE, {...g.by, observed_at: T0}), e => e.code === 'GRAPH_REFUSED' && /GRAPH_REFERENCE broken reference/.test(e.message));
});

test('demonstration 5: learning reuse -- a new failure on a REAL component is related to the established failure classes, their detectors, previous repairs and lessons, with paths', () => {
  const v = realLearning().graph.view();
  const r = learningReuse(v, {component: 'ophanim/operate/context.mjs', test: 'ophanim/operate/context.test.mjs#reviewers and validators use their own evidence',
    claim: 'the dossier stored the evidence but the seat was never delivered it'});
  const ids = r.established.classes.map(c => c.id);
  assert.ok(ids.includes(classId('stored-not-delivered')) && ids.includes(classId('bound-declared-not-enforced')), ids.join(', '));
  for (const c of r.established.classes) {
    assert.equal(c.path.at(-1).type, 'detects', `${c.id}: the path ends at the detector`);
    assert.match(c.path.at(-1).join, /the registry names its detector as/, 'the join on the detector\'s file is labelled');
    assert.ok(c.path.every(p => p.sources.length && p.sources.every(s => s.version)), 'every step names its source and version');
    assert.ok(c.defects.length > 0 && c.repairs.length > 0, `${c.id}: its recorded defects and previous repairs`);
    assert.ok(r.next.run.includes(c.detector.test), 'the detector is the test to run, instead of rediscovering the problem');
  }
  const stored = r.established.classes.find(c => c.id === classId('stored-not-delivered'));
  assert.equal(stored.detector.exact, true, 'the failing test is the class\'s own detector');
  // Textual and hypothetical apart: a register entry that names the file is not a lesson about it.
  assert.ok(r.textual.register.length > 0 && r.textual.register.every(x => /^textual/.test(x.basis)));
  assert.ok(r.hypothetical.similar.every(x => x.classification === 'hypothetical' && x.established === false));
  assert.ok(!r.established.classes.some(c => r.textual.register.some(x => x.id === c.id)));
  // A failing test alone: its class, the fix that repaired it, the test to run.
  const f = learningReuse(v, {test: 'pantheon/tests/output-cap-serialized.test.mjs#fit output xs is serialized'});
  assert.deepEqual(f.established.classes.map(c => c.id), [classId('declared-dimension-not-serialized')]);
  assert.equal(f.established.classes[0].repairs[0].commit, 'cbe0622');
  // A component nothing relates: a gap, never a guess.
  const none = learningReuse(v, {component: 'ophanim/graph/lessons.mjs'});
  assert.deepEqual([none.established.classes.length, none.gaps.map(x => x.category)], [0, ['learning']]);
});

test('learning: shares-failure-mechanism-with is admitted ONLY from a declared basis; similar text is at most a hypothesis, never established nor shown as such (demonstration 12)', t => {
  const g = realLearning(), v0 = g.graph.view();
  // Declared: the registry records two instances under one class.
  const cands = registryMechanisms(v0);
  assert.ok(cands.length > 0 && cands.every(m => m.inputs.every(id => v0.assertion(id).source.id === LEARNING_SOURCE)));
  const w = recordRegistryMechanisms(g.graph, g.rule, {observed_at: T0});
  assert.equal(w.appended, true);
  const v1 = g.graph.view(), link = cands[0];
  const sub = v1.edgesOf(link.a, {mode: 'established', types: ['shares-failure-mechanism-with']}).find(e => [e.from, e.to].includes(link.b));
  assert.ok(sub, 'established from the registry\'s declaration');
  assert.equal(v1.assertion(sub.assertions[0]).origin, LEARNING_RULE);
  // Never from a textual or an inferred basis, never without inputs.
  const mention = v1.subjects().find(s => s.startsWith('mentions(') && v1.query(s, 'established').length);
  const textual = v1.query(mention, 'established')[0].id;
  const [x, y] = [classId('stored-not-delivered'), classId('bound-declared-not-enforced')];
  assert.throws(() => sharedMechanismRecord(v1, g.graph.projection.origins, {a: x, b: y, basis: 'they read alike', inputs: [textual]}), e => e.code === 'LEARNING_BASIS' && /textual basis/.test(e.message));
  assert.throws(() => sharedMechanismRecord(v1, g.graph.projection.origins, {a: x, b: y, basis: 'they read alike', inputs: []}), e => e.code === 'LEARNING_BASIS');
  // Similarity: a hypothetical candidate between two classes, recorded, never established, listed apart by the query.
  const cand = similarityCandidates(v1, 'the record claims a behaviour that the serialized request does not have')[0];
  assert.ok(cand && cand.classification === 'hypothetical' && cand.established === false, 'similar text yields a labelled candidate');
  const p = proposeSimilarMechanism(g.graph, {a: x, b: y, score: 0.5, shared: ['dossier']}, g.rule);
  assert.equal(p.appended, true);
  const v2 = g.graph.view(), s = v2.edgesOf(x, {mode: 'possible', types: ['shares-failure-mechanism-with']}).find(e => [e.from, e.to].includes(y));
  assert.ok(s, 'the hypothesis is recorded');
  assert.deepEqual(v2.query(s.subject, 'established'), [], 'and never established');
  assert.match(v2.query(s.subject, 'possible')[0].why, /^hypothetical/);
  const reuse = learningReuse(v2, {component: 'ophanim/operate/context.mjs'});
  const shown = reuse.established.classes.flatMap(c => c.mechanisms.map(m => m.with));
  assert.ok(!shown.includes(x) && !shown.includes(y), 'a hypothetical link is never shown as established');
  assert.ok(reuse.hypothetical.links.some(l => [l.from, l.to].includes(x) && [l.from, l.to].includes(y) && l.established === false), 'it is listed as a hypothesis');
  // The schema itself refuses a derived link from the textual similarity rule, and anything but a proposal from an agent.
  const derived = {...similarityRecord(v2, {a: x, b: y, score: 0.9}), classification: 'derived', inputs: [textual], missing_evidence: []};
  assert.throws(() => g.graph.assert([assertion({...derived, kind: 'relationship', id: undefined})], g.rule), e => e.code === 'GRAPH_REFUSED' && /may not be admitted as derived from a textual basis/.test(e.message));
  t.diagnostic(`${cands.length} declared mechanism links from the registry's classes; a similarity candidate stays hypothetical`);
});

test('learning: review findings from the cycle LEDGER through its reader -- reproductions and repairs (SYNTHETIC cycle ledger); a withheld path is NEVER read', async t => {
  const c = await d1CycleLedger();
  t.after(() => fs.rmSync(c.dir, {recursive: true, force: true}));
  const g = d1Graph({cycle: {root: c.root, anchor: c.anchor}, only: ['ophanim.cycle', CYCLE_LEARNING_SOURCE], lessons: false});
  t.after(() => g.close());
  const v = g.graph.view(), F = findingId(c.fixed), D = findingId(c.deferred);
  const repair = v.edgesOf(F, {mode: 'established', types: ['introduced-because-of']}).find(e => e.to === F);
  assert.ok(repair, 'the fixed finding has its repair');
  assert.deepEqual([v.node(repair.from).attributes.commit, v.node(repair.from).attributes.before.exit, v.node(repair.from).attributes.after.exit], ['d'.repeat(40), 1, 0]);
  assert.ok(edge(v, 'verified-by', repair.from, fileId(c.test)), 'verified by the test shown failing before and passing after');
  assert.deepEqual(v.edgesOf(D, {mode: 'established', types: ['introduced-because-of']}).filter(e => e.to === D), [], 'a deferred finding has no repair');
  assert.ok(v.edgesOf(F, {mode: 'established', types: ['derived-from']}).some(e => e.to === F && e.from.includes('/learning/reproduction/')), 'the reviewer\'s reproduction');
  const r = learningReuse(v, {component: c.file});
  assert.deepEqual(r.established.findings.map(f => f.id).sort(), [D, F].sort());
  assert.ok(r.established.findings.every(f => f.join === 'the finding names this file'));
  // A withheld path: refused before anything is read from it.
  const hidden = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-d1-withheld-')), 'findings-1-lab', 'cycles');
  t.after(() => fs.rmSync(path.dirname(path.dirname(hidden)), {recursive: true, force: true}));
  fs.cpSync(c.root, hidden, {recursive: true});
  const read = [], orig = {readFileSync: fs.readFileSync, existsSync: fs.existsSync, openSync: fs.openSync, readdirSync: fs.readdirSync};
  for (const k of Object.keys(orig)) fs[k] = (p, ...rest) => { if (/findings-/.test(String(p))) read.push(`${k} ${p}`); return orig[k](p, ...rest); };
  try {
    const s = cycleLearningSource({root: hidden, anchor: c.anchor});
    assert.throws(() => s.current(), e => e.code === 'WITHHELD');
    assert.throws(() => s.readAt('sha256:' + '0'.repeat(64)), e => e.code === 'WITHHELD');
    assert.throws(() => learningSource({repo: path.dirname(hidden)}), e => e.code === 'WITHHELD');
    assert.throws(() => withheldRefusal('docs/reviews/2026-11-18-independent-review/findings-2-openai/x.json'), e => e.code === 'WITHHELD');
  } finally { Object.assign(fs, orig); }
  assert.deepEqual(read, [], 'not one read of a withheld path');
  // And no learning fact of the real graph names one.
  const rv = realLearning().graph.view();
  assert.ok(!rv.subjects().some(s => /findings-/.test(decodeURIComponent(s)) && rv.query(s, 'established').some(a => a.source.id === LEARNING_SOURCE)));
});

test('learning: mutation outcomes are OBSERVED with their run from a runner\'s own summary (a SYNTHETIC summary over the REAL runner table): killed -> detected, survived -> a detection gap', () => {
  const g = realLearning(), runner = 'ophanim/graph/graph-b2.mutate.mjs', deps = 'ophanim/graph/extract-deps.test.mjs';
  const summary = {suites: [deps], mutations: [
    {id: 'D1', what: 'SYNTHETIC outcome: a comment is not blanked', tests: [[deps, '^deps: a URL']], files: ['ophanim/graph/extract/code.mjs'], killed: true, ran: 2, pass: 1, fail: 1, cancelled: 0, failed: ['deps: a URL ...']},
    {id: 'D6', what: 'SYNTHETIC outcome: test needs merged', tests: [[deps, '^deps: test needs']], files: ['ophanim/graph/extract/code.mjs'], killed: false, ran: 1, pass: 1, fail: 0, cancelled: 0, failed: []}]};
  const w = recordMutationOutcomes(g.graph, {summary, runner, commit: g.commit, observed_at: T0}, g.tool);
  assert.equal(w.appended, true);
  const v = g.graph.view();
  const outcomes = v.edgesOf(mutationId(runner, 'D1'), {mode: 'established', types: ['derived-from']}).filter(e => e.from.includes('/learning/mutation-outcome/'));
  assert.equal(outcomes.length, 1);
  const o = v.query(outcomes[0].from, 'established')[0];
  assert.deepEqual([o.classification, o.origin, v.assertion(o.id).record.run.runner], ['observed', MUTATION_TOOL, runner], 'observed, with its run');
  assert.ok(edge(v, 'detects', fileId(deps), outcomes[0].from), 'the deciding test detected the killed mutation');
  const survivor = v.edgesOf(mutationId(runner, 'D6'), {mode: 'established', types: ['derived-from']}).find(e => e.from.includes('/learning/mutation-outcome/')).from;
  assert.ok(v.edgesOf(survivor, {mode: 'established', types: ['derived-from']}).some(e => e.to === survivor && e.from.includes('/learning/detection-gap/')), 'a survivor is a detection gap');
  const r = learningReuse(v, {component: 'ophanim/graph/extract/code.mjs'});
  assert.ok(r.established.mutations.some(m => m.mutation === mutationId(runner, 'D1') && m.outcomes.length === 1 && m.outcomes[0].killed === true));
  assert.ok(r.established.mutations.some(m => m.outcomes.length === 0 && m.result === 'no recorded run of this mutation'), 'a mutation with no recorded run says so; no result is assumed');
  // A tool admits only observed assertions, each with its run.
  assert.throws(() => g.graph.assert([{...v.assertion(o.id).record, run: null, id: null}].map(x => assertion({...x, entity: x.subject})), g.tool), e => e.code === 'GRAPH_REFUSED');
});
