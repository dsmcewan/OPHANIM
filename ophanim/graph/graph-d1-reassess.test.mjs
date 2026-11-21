// Slice D part 1, TARGETED REASSESSMENT of work (KD1-5; demonstrations 2 (its plans and qualifications part) and 7;
// docs/knowledge-graph/slice-d1.md): a change event, or a Slice B impact, mapped onto the work graph -- the plans, units,
// tickets, artifacts, qualifications and completion claims whose cited evidence or requirements changed, RECORDED with
// why, never a completion claim; unrelated work untouched; a source that cannot be read leaves its work UNVERIFIABLE; a
// reassessment whose cause is observed again is stale (demonstration 12). SYNTHETIC: a temporary repository and the work
// ledger fixture. REAL: the repository at HEAD for the impact case (its work still synthetic).
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {workReassessmentSet, reassessWork, REASSESS_RULE, ROLES} from './reassess.mjs';
import {workGraphSource, WORK_GRAPH_SOURCE, planId, artifactId, stageReviewId, validationId, completionId, unitId} from './work.mjs';
import {impact} from './impact.mjs';
import {openSystemsGraph} from './extract/index.mjs';
import {repoSource, fileId, ticketId} from './extract/repo.mjs';
import {d1WorkLedger} from './fixtures/d1-work.mjs';
import {d1Graph} from './fixtures/d1-graph.mjs';
import {tempRepo, at, T0} from './fixtures/repo.mjs';

const cleanup = [];
after(() => { for (const f of cleanup) f(); });
const fixture = opts => { const w = d1WorkLedger(opts); cleanup.push(() => fs.rmSync(w.dir, {recursive: true, force: true})); return w; };
const FILES = {'lib/shared.mjs': 'export const shared = 1;\n', 'lib/transport.mjs': "import {shared} from './shared.mjs';\nexport const transport = shared;\n",
  'lib/team.mjs': 'export const team = 1;\n', 'lib/accounting.mjs': 'export const accounting = 1;\n', 'lib/docs.mjs': 'export const docs = 1;\n', 'lib/validated.mjs': 'export const v = 1;\n'};
/** The chain of one item's records, as graph ids. */
const chainOf = (w, item) => { const r = w.records[item]; return {plan: planId(r.plan.hash), ticket: ticketId(item),
  ...(r.implement ? {artifact: artifactId(r.implement.hash), review: stageReviewId(r.review.hash), validation: validationId(r.validate.hash), completion: completionId(r.outcome.hash)} : {})}; };
/** A synthetic repository and the work fixture citing its files, observed: {g, w, commit, observe}. */
function world(t, files = {}) {
  const {repo, commit} = tempRepo(t);
  commit(FILES, 'the synthetic tree');
  const w = fixture({files});
  const g = openSystemsGraph({sources: [repoSource({repo}), workGraphSource({root: w.root, anchor: w.anchor})]});
  t.after(() => g.close());
  g.graph.observe('ophanim.repo', {...g.by, observed_at: T0});
  g.graph.observe(WORK_GRAPH_SOURCE, {...g.by, observed_at: T0});
  return {g, w, commit, repo, observe: (id, minute) => g.graph.observe(id, {...g.by, observed_at: at(minute)})};
}
const workState = (v, ids) => Object.fromEntries(ids.map(x => [x, [v.query(x, 'recorded').map(a => [a.id, a.retired]), v.edgesOf(x, {mode: 'recorded'}).map(e => e.subject)]]));

test('demonstrations 2 and 7: a changed source component reaches the plans, units, tickets, artifacts, QUALIFICATIONS and COMPLETION CLAIMS resting on it -- recorded, with why; unrelated work UNTOUCHED; no completion claim (SYNTHETIC)', t => {
  const {g, w, commit, observe} = world(t);
  const sdk = chainOf(w, 'sdk-transport'), docs = chainOf(w, 'unrelated-docs'), team = chainOf(w, 'team-construction'), acct = chainOf(w, 'resource-accounting');
  const unrelated = [...Object.values(docs), ...Object.values(team), ...Object.values(acct), unitId(w.records['team-construction'].plan.hash, 'u1')];
  const before = workState(g.graph.view(), unrelated);
  commit({'lib/shared.mjs': 'export const shared = 2;\n'}, 'the shared module changes');
  const o = observe('ophanim.repo', 1);
  assert.equal(o.event.state, 'current');
  const r = reassessWork(g.graph, {event: o.event}, {by: g.rule, observed_at: at(2)});
  assert.equal(r.recorded, true);
  const v = g.graph.view(), rec = v.assertion(r.id).record;
  // What is affected: the plan citing the file that imports the changed module, and everything resting on it.
  const members = new Map(r.set.members.map(m => [m.id, m]));
  for (const [k, id] of Object.entries(sdk)) assert.ok(members.has(id), `${k} of sdk-transport is reassessed`);
  assert.deepEqual([members.get(sdk.plan).role, members.get(sdk.review).role, members.get(sdk.validation).role, members.get(sdk.completion).role],
    ['plan', 'qualification', 'qualification', 'completion claim']);
  assert.match(members.get(sdk.plan).why, /rests on lib\/transport\.mjs \(derived-from\)/, 'why: the plan cites the file that imports the changed module');
  assert.ok(members.get(sdk.completion).path.length >= 2 && members.get(sdk.completion).path.at(-1).from === sdk.completion, 'each member carries its path from the change');
  // Unrelated work: not a member, and every one of its assertions and relationships is exactly as it was.
  for (const id of unrelated) assert.ok(!members.has(id), `${id} is untouched`);
  assert.deepEqual(workState(v, unrelated), before, 'unrelated work keeps every assertion, unretired, and every relationship');
  assert.ok(r.set.untouched > 20, `${r.set.untouched} work nodes untouched`);
  // RECORDED as a derived discovery of the rule, from the observation that caused it; it claims no completion.
  assert.deepEqual([rec.classification, rec.origin, rec.inputs.length, rec.attributes.completion], ['derived', REASSESS_RULE, 1, 'not claimed']);
  assert.deepEqual([rec.invalidates, rec.supersedes], [[], []], 'it invalidates, supersedes and retracts nothing');
  assert.ok(rec.attributes.members.every(m => m.why && !/^complete/i.test(m.status)), 'every member says why; none is complete');
  assert.equal(members.get(sdk.completion).status, ROLES['work/obligation'][1]);
  assert.match(members.get(sdk.completion).status, /unsupported .*not complete/);
  t.diagnostic(`demonstration 2/7: ${r.set.members.length} work nodes reassessed (${Object.entries(r.set.roles).map(([k, n]) => `${n} ${k}`).join(', ')}), ${r.set.untouched} untouched`);
  // A plan's units are reassessed with it.
  commit({'lib/team.mjs': 'export const team = 2;\n'}, 'the team module changes');
  const units = workReassessmentSet(g.graph, {event: observe('ophanim.repo', 3).event});
  const tp = w.records['team-construction'].plan.hash;
  assert.deepEqual(units.members.map(m => m.id).sort(), [team.plan, team.ticket, unitId(tp, 'u1'), unitId(tp, 'u2')].sort());
  assert.deepEqual(units.members.filter(m => m.role === 'unit').map(m => m.status), [ROLES['work/work-unit'][1], ROLES['work/work-unit'][1]]);
});

test('demonstration 7: a file only a VALIDATION cited reaches that qualification and its completion claim -- not the plan, not the artifact (SYNTHETIC)', t => {
  const {g, w, commit, observe} = world(t, {validated: 'lib/validated.mjs'});
  const sdk = chainOf(w, 'sdk-transport');
  commit({'lib/validated.mjs': 'export const v = 2;\n'}, 'the validated evidence changes');
  const s = workReassessmentSet(g.graph, {event: observe('ophanim.repo', 1).event});
  assert.deepEqual(s.members.map(m => m.id).sort(), [sdk.validation, sdk.completion].sort(), 'exactly the qualification resting on it and the claim resting on that');
});

test('demonstration 7: MISSING evidence -- a deleted cited file reaches its plans; an unreadable work ledger leaves every work fact UNVERIFIABLE, none current', t => {
  const {g, w, commit, observe} = world(t);
  const docs = chainOf(w, 'unrelated-docs'), sdk = chainOf(w, 'sdk-transport');
  commit({'lib/docs.mjs': null}, 'the docs module is deleted');
  const del = workReassessmentSet(g.graph, {event: observe('ophanim.repo', 1).event});
  const ids = del.members.map(m => m.id);
  assert.ok(ids.includes(docs.plan) && ids.includes(docs.completion), 'the plans citing the deleted file, and what rests on them');
  assert.ok(!ids.includes(sdk.plan), 'not the plans that do not cite it');
  // The work ledger becomes unreadable.
  fs.renameSync(w.root, `${w.root}.moved`);
  cleanup.push(() => fs.rmSync(`${w.root}.moved`, {recursive: true, force: true}));
  const lost = observe(WORK_GRAPH_SOURCE, 2);
  assert.deepEqual([lost.recorded, lost.state], [true, 'unavailable']);
  const r = reassessWork(g.graph, {event: lost.event}, {by: g.rule, observed_at: at(3)});
  assert.ok(r.set.members.length > 50 && r.set.members.every(m => /^unverifiable: ophanim\.work-graph is unavailable/.test(m.status)), `${r.set.members.length} work facts, every one unverifiable`);
  const rec = g.graph.view().assertion(r.id).record;
  assert.deepEqual([rec.attributes.completion, rec.missing_evidence.length, rec.attributes.event.state], ['not claimed', 1, 'unavailable']);
});

test('demonstration 12: a STALE record -- a reassessment is derived from its observation; once the source is observed again, it is stale, not established', t => {
  const {g, commit, observe} = world(t);
  commit({'lib/shared.mjs': 'export const shared = 2;\n'}, 'first change');
  const r = reassessWork(g.graph, {event: observe('ophanim.repo', 1).event}, {by: g.rule, observed_at: at(2)});
  assert.equal(g.graph.view().query(r.subject, 'established').length, 1);
  commit({'lib/team.mjs': 'export const team = 2;\n'}, 'second change');
  observe('ophanim.repo', 3);
  const v = g.graph.view();
  assert.deepEqual(v.query(r.subject, 'established'), [], 'its input was superseded: it is no longer established');
  assert.match(v.query(r.subject, 'possible')[0].why, /^stale/, 'it is kept, current but stale');
});

test('demonstration 2: a Slice B impact of a REAL component maps onto the work resting on its consumers; unrelated work untouched (REAL repository, SYNTHETIC work)', t => {
  const w = fixture({files: {transport: 'ophanim/graph/impact.mjs', validated: 'ophanim/graph/impact.mjs', docs: 'docs/knowledge-graph/architecture.md',
    team: 'docs/knowledge-graph/slice-b.md', accounting: 'docs/knowledge-graph/slice-b2.md'}});
  const g = d1Graph({work: {root: w.root, anchor: w.anchor}, only: ['ophanim.repo', WORK_GRAPH_SOURCE], lessons: false});
  t.after(() => g.close());
  const v = g.graph.view(), seed = fileId('ophanim/graph/extract/git.mjs');
  const im = impact(v, [seed]);
  assert.ok(im.affected.consumers.some(n => n.id === fileId('ophanim/graph/impact.mjs')), 'impact.mjs imports the changed component');
  const r = reassessWork(g.graph, {impact: im, source: 'impact'}, {by: g.rule, observed_at: T0});
  const ids = new Set(r.set.members.map(m => m.id)), sdk = chainOf(w, 'sdk-transport'), docs = chainOf(w, 'unrelated-docs');
  for (const id of Object.values(sdk)) assert.ok(ids.has(id), `${id}: rests on a consumer of the changed component`);
  for (const id of Object.values(docs)) assert.ok(!ids.has(id), `${id}: untouched`);
  const rec = g.graph.view().assertion(r.id).record;
  assert.deepEqual([rec.attributes.completion, rec.attributes.seeds, rec.inputs.every(id => g.graph.view().established(id))], ['not claimed', [seed], true]);
});
