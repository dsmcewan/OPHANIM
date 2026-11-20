// Slice B, KB2, KB3, KB5: impact analysis (demonstration 2), historical traceability (demonstration 3), source
// invalidation (demonstration 7) and the section-8 queries, on the REAL graph of this checkout at its HEAD commit
// (repository, verification, register, lessons, status ledger) where a real record exists, and on SYNTHETIC temporary
// repositories and a COPY of the status ledger where the demonstration needs a change or a loss no real record shows.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {digest} from '../../packages/ledger/canonical.mjs';
import os from 'node:os';
import path from 'node:path';
import {impact, impactOfRange, reassess, reassessmentSet, trace, answer, subjectOf, CHANGE_TYPES, QUALIFY_TYPES, QUERIES, discoveryId} from './impact.mjs';
import {fileId, symbolId, contractId, ticketId, itemId, repoSource} from './extract/repo.mjs';
import {recordId} from './extract/records.mjs';
import {mutationId, suiteId, workflowId} from './extract/verification.mjs';
import {statusSource} from './extract/ledgers.mjs';
import {openSystemsGraph} from './extract/index.mjs';
import {tempRepo, realGraph, closeRealGraph, ROOT, T0, at} from './fixtures/repo.mjs';

after(closeRealGraph);
const ids = xs => xs.map(n => n.id);
const all = r => Object.values(r.affected).flat();

test('impact: a real component change reaches its consumers, tests, suites, workflows, ticket and citing records; unrelated work is untouched', () => {
  const v = realGraph().graph.view();
  const chairs = fileId('ophanim/efficiency/investigation/chairs.mjs');
  const r = impact(v, [chairs]);
  assert.ok(ids(r.affected.tests).includes(fileId('ophanim/efficiency/investigation/chairs.test.mjs')), 'its own test');
  assert.ok(ids(r.affected.suites).includes(suiteId('test:proof')) && ids(r.affected.workflows).includes(workflowId('.github/workflows/qualification.yml')), 'the suite and the workflow that run it');
  assert.ok(ids(r.affected.work).includes(ticketId('co1-readability')), 'the ticket it implements');
  for (const n of all(r)) {
    assert.ok(n.via.length > 0 && n.via.every(p => CHANGE_TYPES.includes(p.type)), `${n.id}: an explained path along change-carrying relationships`);
    assert.ok(n.via[0].sources.some(s => s.version === v.sources().find(x => x.id === s.source).version), `${n.id}: each step names the source version that states it`);
  }
  // Targeted: the closure is complete within its bounds and touches a few nodes of the thousands in the graph.
  assert.equal(r.coverage.truncated, false);
  assert.ok(all(r).length < 50 && v.stats().entities > 3000, `${all(r).length} affected of ${v.stats().entities} entities`);
  for (const unrelated of [fileId('ophanim/operate/context.mjs'), fileId('packages/graph/schema.mjs'), suiteId('test:@argo/graph')]) assert.ok(!ids(all(r)).includes(unrelated), `${unrelated} is untouched`);
  // A central component: bounded, with its continuation, and the records that cite it named, never declared affected.
  const ctx = impact(v, [fileId('ophanim/operate/context.mjs')], {depth: 2, maxNodes: 120});
  assert.equal(ctx.coverage.truncated, true);
  assert.ok(ctx.continuation, 'a cut closure says how to continue');
  assert.ok(ctx.citing.some(c => c.record === recordId('L-504') && /cites it/.test(c.direction)), 'context.mjs cites L-504');
  assert.ok(!ids(all(ctx)).some(id => id.includes('/evidence/record/register/')), 'a citing record is never in the affected set');
  assert.ok(ctx.qualifications.length > 0 && ctx.qualifications.every(q => QUALIFY_TYPES.includes(q.relationship.type)), 'qualifications to reassess, one hop');
});

test('impact: only change-carrying relationships are followed -- a qualification is reported one hop, never propagated; a mention is never followed', () => {
  const v = realGraph().graph.view();
  // wave3-evidence.test.mjs is declared (wave3-evidence.mutate.mjs) to decide mutations of context.mjs: it VERIFIES it.
  const t = fileId('ophanim/operate/wave3-evidence.test.mjs'), ctx = fileId('ophanim/operate/context.mjs');
  assert.ok(v.edgesOf(t).some(e => e.type === 'verifies' && e.to === ctx));
  const r = impact(v, [t], {maxNodes: 2000, maxEdges: 20000});
  assert.ok(r.qualifications.some(q => q.qualification_of === ctx && q.because === t), 'the module it verifies is named for reassessment');
  assert.ok(!ids(all(r)).includes(ctx), 'the module itself did not change: it is not affected');
  assert.ok(!ids(all(r)).includes(fileId('ophanim/operate/stages.mjs')), 'and nothing that imports it is reached through the test');
  assert.ok(ids(r.affected.mutations).includes(mutationId('ophanim/operate/wave3-evidence.mutate.mjs', 'E1')), 'the mutations it decides are affected');
  assert.ok(ids(r.affected.suites).includes(suiteId('test:proof')));
  assert.ok(!ids(all(r)).some(id => id.includes('/evidence/record/')), 'no record through a mention');
});

test('impact: a contract change reaches what carries it and their consumers', () => {
  const v = realGraph().graph.view();
  const c = subjectOf(v, 'ophanim.graph/v1');
  assert.deepEqual(c, {id: contractId('ophanim.graph/v1')});
  const r = impact(v, [c.id], {depth: 2});
  assert.deepEqual(r.carriers.map(x => x.carrier), [symbolId('packages/graph/schema.mjs', 'GRAPH_SCHEMA')]);
  for (const m of ['packages/graph/kinds.mjs', 'packages/graph/projection.mjs']) assert.ok(ids(r.affected.consumers).includes(fileId(m)), `${m} consumes GRAPH_SCHEMA`);
});

test('impact: a commit range seeds the files it changed, at the range\'s end (SYNTHETIC repository)', t => {
  const {repo, commit} = tempRepo(t);
  const c1 = commit({'lib/a.mjs': "import {b} from './b.mjs';\nexport const a = b;\n", 'lib/b.mjs': 'export const b = 1;\n', 'lib/c.mjs': 'export const c = 1;\n', 'lib/old.mjs': 'export const o = 1;\n'});
  const c2 = commit({'lib/b.mjs': 'export const b = 2;\n', 'lib/old.mjs': null}, 'b changes, old goes');
  const g = openSystemsGraph({sources: [repoSource({repo})]});
  t.after(g.close);
  g.graph.observe('ophanim.repo', {...g.by, observed_at: T0});
  const r = impactOfRange(g.graph.view(), {repo, from: c1, to: c2});
  assert.deepEqual([r.seeds, r.range.removed], [[fileId('lib/b.mjs')], ['lib/old.mjs']]);
  assert.ok(ids(r.affected.consumers).includes(fileId('lib/a.mjs')) && !ids(r.affected.consumers).includes(fileId('lib/c.mjs')));
});

test('reassess: a changed source and a missing source give RECORDED reassessment sets, with why, and no completion claim', t => {
  // Changed (SYNTHETIC repository): b.mjs changes; a.mjs imports it; c.mjs does not.
  const {repo, commit} = tempRepo(t);
  commit({'lib/a.mjs': "import {b} from './b.mjs';\nexport const a = b;\n", 'lib/b.mjs': 'export const b = 1;\n', 'lib/c.mjs': 'export const c = 1;\n'});
  // Missing: a COPY of the real status ledger, which then becomes unreadable.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-b-status-'));
  t.after(() => fs.rmSync(copy, {recursive: true, force: true}));
  fs.cpSync(path.join(ROOT, 'status/ledger'), path.join(copy, 'ledger'), {recursive: true, filter: s => !s.includes(`${path.sep}keys`)});
  const g = openSystemsGraph({sources: [repoSource({repo}), statusSource({root: path.join(copy, 'ledger')})]});
  t.after(g.close);
  g.graph.observe('ophanim.repo', {...g.by, observed_at: T0});
  g.graph.observe('ophanim.status', {...g.by, observed_at: T0});
  commit({'lib/b.mjs': 'export const b = 2;\n'}, 'b changes');
  const changed = g.graph.observe('ophanim.repo', {...g.by, observed_at: at(1)}).event;
  const rc = reassess(g.graph, changed, {by: g.rule, observed_at: at(2)});
  assert.equal(rc.recorded, true);
  const rec = g.graph.view().assertion(rc.id).record;
  assert.deepEqual([rec.subject, rec.classification, rec.origin, rec.attributes.completion], [discoveryId(`reassess/${changed.seq}`), 'derived', 'ophanim.impact.rule', 'not claimed']);
  assert.equal(rec.inputs.length, 1, 'derived from the observation that caused it');
  const members = rec.attributes.members.map(m => m.id);
  assert.ok(members.includes(fileId('lib/a.mjs')) && members.includes(fileId('lib/b.mjs')), 'what changed and what imports it');
  assert.ok(!members.includes(fileId('lib/c.mjs')), 'nothing outside the change\'s neighbourhood');
  assert.ok(rec.attributes.members.every(m => m.status === 'reassess' && m.why), 'each member says why');
  // The status ledger becomes unreadable: recorded unavailable; what it gave is UNVERIFIABLE, never current.
  fs.rmSync(path.join(copy, 'ledger'), {recursive: true, force: true});
  const lost = g.graph.observe('ophanim.status', {...g.by, observed_at: at(3)});
  assert.deepEqual([lost.recorded, lost.state], [true, 'unavailable']);
  const rm = reassess(g.graph, lost.event, {by: g.rule, observed_at: at(4)});
  const m = g.graph.view().assertion(rm.id).record, full = reassessmentSet(g.graph, lost.event);
  assert.equal(m.attributes.event.state, 'unavailable');
  assert.ok(full.members.length > 50 && full.members.every(x => x.status === 'unverifiable'), `${full.members.length} facts and dependents, every one unverifiable`);
  assert.ok(full.members.some(x => x.id === itemId('k6')), 'the status items it stated are among them');
  assert.deepEqual([m.attributes.total, m.attributes.members_digest], [full.members.length, 'sha256:' + digest(full.members.map(x => x.id).sort())], 'the record identifies the whole set');
  assert.ok(m.attributes.members.length > 0 && m.attributes.members.every(x => x.status === 'unverifiable'), 'what it lists is unverifiable');
  assert.equal(m.attributes.truncated, m.attributes.members.length < full.members.length, 'a cut is stated');
  assert.ok(m.missing_evidence.length > 0 && m.attributes.completion === 'not claimed');
  assert.equal(g.graph.freshness().find(f => f.source === 'ophanim.status').state, 'unavailable');
  // Recorded: a replay of the graph ledger still holds both sets.
  const again = g.open();
  assert.ok(again.view().assertion(rc.id) && again.view().assertion(rm.id), 'both reassessment sets are on the graph ledger');
  assert.deepEqual(reassessmentSet(g.graph, changed).members.map(x => x.id).sort(), [...members].sort(), 'the record is the set the rule computes');
});

test('trace: a real component traced backward through its requirement, evidence, commits and corrections; a link no source states is a GAP', () => {
  const v = realGraph().graph.view();
  // chairs.mjs: a ticket names it as its slot, and the ticket names its status item.
  const chairs = trace(v, fileId('ophanim/efficiency/investigation/chairs.mjs'));
  const kinds = chairs.requirements.map(r => r.kind);
  assert.deepEqual(kinds, ['ticket', 'status item']);
  assert.equal(chairs.requirements[1].on_status_ledger, true);
  assert.match(chairs.requirements[1].join, /names its item/);
  assert.ok(chairs.evidence.tests.shown.some(x => x.id === fileId('ophanim/efficiency/investigation/chairs.test.mjs')));
  assert.ok(chairs.commits.total >= 1 && chairs.commits.introduced.commit, 'the first commit that changed it');
  assert.ok(chairs.gaps.some(g => g.category === 'mutations'), 'no runner edits it: a gap, stated');
  // context.mjs: no source states the requirement that introduced it -- a gap, never filled by resemblance.
  const ctx = trace(v, fileId('ophanim/operate/context.mjs'));
  assert.deepEqual(ctx.requirements, []);
  assert.ok(ctx.gaps.some(g => g.category === 'requirement'));
  assert.ok(ctx.register.shown.some(r => r.entry === 'L-504' && /textual/.test(r.basis)), 'the register entries that name it, as mentions');
  assert.ok(ctx.evidence.verifiers.shown.some(x => x.id === fileId('ophanim/operate/wave3-evidence.test.mjs')), 'the test a runner declares decides it');
  assert.ok(ctx.evidence.mutations.shown.some(x => x.id === mutationId('ophanim/operate/wave3-evidence.mutate.mjs', 'E1')));
  assert.ok(ctx.corrections.lessons.some(c => c.id.endsWith('/stored-not-delivered') && c.kind === 'lesson (detector)'), 'the lesson whose detector is its test');
  assert.ok(ctx.gaps.some(g => g.category === 'correction commit' && /stored-not-delivered/.test(g.why)), 'a fix named as text that resolves to no commit is a gap');
  for (const s of ctx.sources) assert.ok(s.version, `${s.source} names its version`);
});

test('answer: the section-8 queries, each bounded, explained, with its sources and versions', () => {
  const g = realGraph(), subject = 'ophanim/efficiency/investigation/chairs.mjs';
  for (const q of QUERIES) {
    const a = answer(g.graph, q, subject, q === 'changed-since' ? {since: trace(g.graph.view(), fileId(subject)).commits.introduced.commit} : {});
    assert.equal(a.error, undefined, `${q}: ${a.why}`);
    assert.equal(a.subject, fileId(subject));
    assert.ok(Array.isArray(a.sources) && a.sources.length > 0 && a.sources.every(s => s.version), `${q}: names its sources and versions`);
  }
  assert.ok(answer(g.graph, 'governs', subject).gaps.some(x => x.category === 'governance'), 'no governs relationship is stated: said so');
  assert.ok(answer(g.graph, 'unknown', subject).gaps.length > 0);
  assert.ok(answer(g.graph, 'invalidates', subject).invalidates.affected.tests.total > 0);
  assert.equal(answer(g.graph, 'why', 'no/such/file.mjs').error, 'NOT_FOUND');
  assert.equal(answer(g.graph, 'dependents', subject, {maxNodes: 1e9}).error, 'BAD_REQUEST', 'a bound above its ceiling is refused');
});
