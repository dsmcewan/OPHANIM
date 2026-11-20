// Slice D part 1, WHY A COMPONENT EXISTS (KD1-6; the directive's section 10, OPHANIM as its own first built system;
// docs/knowledge-graph/slice-d1.md): the requirement and the decision that introduced a component, from what the sources
// STATE, each a join on an identity both sources state (Slice B's cross-source join rule, slice-b.md section 12),
// labelled with its basis and recorded as a derived assertion of the registered rule; a link no source states is a GAP,
// never filled by resemblance; a recorded join whose input is withdrawn is stale (demonstration 12). REAL: the repository
// at HEAD, the register and the status ledger. SYNTHETIC: a temporary repository and the work-ledger fixture.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {whyExists, whyJoins, recordWhy, WHY_RULE} from './why.mjs';
import {workGraphSource, WORK_GRAPH_SOURCE} from './work.mjs';
import {openSystemsGraph} from './extract/index.mjs';
import {STATUS_ANCHOR} from './extract/ledgers.mjs';
import {repoSource, fileId, ticketId, itemId} from './extract/repo.mjs';
import {recordId} from './extract/records.mjs';
import {promptId} from './work.mjs';
import {d1WorkLedger} from './fixtures/d1-work.mjs';
import {d1Graph, ROOT} from './fixtures/d1-graph.mjs';
import {tempRepo, at, T0} from './fixtures/repo.mjs';

let real = null;
const realWhy = () => (real ??= d1Graph({only: ['ophanim.repo', 'ophanim.records', 'ophanim.status'], lessons: false, status: {root: path.join(ROOT, 'status/ledger'), anchor: STATUS_ANCHOR}}));
after(() => { if (real) real.close(); });

test('why it exists (KD1-6): REAL components -- the requirement and the decision from what the sources state, each a labelled join with its basis', () => {
  const v = realWhy().graph.view();
  // A ticket names the path as its slot; the status ledger states the ticket's item.
  const chairs = whyExists(v, fileId('ophanim/efficiency/investigation/chairs.mjs'));
  assert.deepEqual(chairs.requirements.map(j => [j.kind, j.to]), [['ticket', ticketId('co1-readability')], ['status item', itemId('co1-readability')]]);
  assert.match(chairs.requirements[1].join, /the status ledger states the item under the same id/);
  assert.ok(chairs.requirements[1].sources.some(s => s.source === 'ophanim.status') && chairs.requirements[1].sources.some(s => s.source === 'ophanim.repo'), 'both sides of the join');
  // The commit that introduced it names a register id the register defines: the decision.
  const billing = whyExists(v, fileId('pantheon/src/route/gemini-billing.mjs'));
  assert.deepEqual(billing.decisions.map(d => d.entry), ['L-136']);
  assert.match(billing.decisions[0].join, /^the commit that introduced it \(0fbf93e/);
  assert.match(billing.introduced_by.commit, /^0fbf93e/);
  assert.deepEqual(billing.gaps.map(g => g.category), ['requirement'], 'no ticket names it: a gap, stated');
  assert.deepEqual(whyExists(v, fileId('packages/graph/checkpoint.mjs')).decisions.map(d => d.entry), ['KG-1']);
  // A register entry that only NAMES a file is textual: listed apart, never its decision.
  const ctx = whyExists(v, fileId('ophanim/operate/context.mjs'));
  assert.ok(ctx.textual.register.length > 0 && ctx.textual.register.every(r => /^textual/.test(r.basis)));
  assert.deepEqual([ctx.decisions, ctx.gaps.map(g => g.category)], [[], ['requirement', 'decision']]);
  // No source states anything: gaps.
  assert.deepEqual(whyExists(v, fileId('ophanim/graph/lessons.mjs')).gaps.map(g => g.category), ['requirement', 'decision']);
});

test('why it exists: the joins are RECORDED as derived introduced-because-of of the registered rule, from the assertions that state them; again is a no-op', t => {
  const g = realWhy(), subject = fileId('pantheon/src/route/gemini-billing.mjs');
  const w = recordWhy(g.graph, subject, g.rule, {observed_at: T0});
  assert.equal(w.appended, true);
  const v = g.graph.view(), e = v.edgesOf(subject, {mode: 'established', types: ['introduced-because-of']}).find(x => x.to === recordId('L-136'));
  assert.ok(e, 'established');
  const a = v.assertion(e.assertions[0]).record;
  assert.deepEqual([a.classification, a.origin, a.attributes.kind, a.attributes.basis], ['derived', WHY_RULE, 'register entry', 'declared']);
  assert.ok(a.inputs.length >= 3 && a.inputs.every(id => v.established(id)), 'its inputs: the commit, the path\'s commit edge, the register entry');
  assert.deepEqual(whyExists(v, subject).recorded.map(r => [r.to, r.established]), [[recordId('L-136'), true]]);
  assert.equal(recordWhy(g.graph, subject, g.rule, {observed_at: at(5)}).appended, false);
});

/** A synthetic repository and the work fixture: lib/sdk-transport.mjs is a plan's slice; lib/lessons.mjs is no one's. */
function world(t) {
  const {repo, commit} = tempRepo(t);
  commit({'lib/sdk-transport.mjs': 'export const x = 1;\n', 'lib/lessons.mjs': 'export const lessons = 1;\n', 'lib/a.mjs': 'export const a = 1;\n', 'lib/b.mjs': 'export const b = 1;\n',
    'tickets/x.json': JSON.stringify({schema: 'ophanim.ticket/v1', item: 'x', path: 'lib/a.mjs', copy: []})}, 'add the synthetic modules');
  const w = d1WorkLedger();
  t.after(() => fs.rmSync(w.dir, {recursive: true, force: true}));
  const g = openSystemsGraph({sources: [repoSource({repo}), workGraphSource({root: w.root, anchor: w.anchor})]});
  t.after(() => g.close());
  g.graph.observe('ophanim.repo', {...g.by, observed_at: T0});
  g.graph.observe(WORK_GRAPH_SOURCE, {...g.by, observed_at: T0});
  return {g, w, commit};
}

test('why it exists: a plan of the work ledger names the path as a slice -> its item and the prompt the intake recorded it from (SYNTHETIC)', t => {
  const {g} = world(t);
  const r = whyExists(g.graph.view(), fileId('lib/sdk-transport.mjs'));
  assert.deepEqual(r.requirements.map(j => [j.kind, j.to]), [['plan slice', itemId('sdk-transport')], ['prompt', promptId('status', 'sdk-transport')]]);
  assert.ok(r.requirements.every(j => j.basis === 'declared' && j.sources.some(s => s.source === WORK_GRAPH_SOURCE)));
});

test('why it exists: a GAP is never filled by inference -- an item whose name resembles the file is not its requirement (demonstration 12)', t => {
  const {g} = world(t);
  const v = g.graph.view(), subject = fileId('lib/lessons.mjs');
  assert.ok(v.nodeIn(itemId('graph-lessons'), 'established'), 'an item named like the file exists');
  const r = whyExists(v, subject);
  assert.deepEqual([r.requirements, r.decisions, r.gaps.map(x => x.category)], [[], [], ['requirement', 'decision']]);
  assert.deepEqual(whyJoins(v, subject), [], 'no join is made on resemblance');
});

test('why it exists: a recorded join whose input is withdrawn is STALE, kept and never shown as established (demonstration 12)', t => {
  const {g, commit} = world(t);
  const subject = fileId('lib/a.mjs');
  assert.equal(recordWhy(g.graph, subject, g.rule, {observed_at: at(1)}).appended, true);
  assert.deepEqual(whyExists(g.graph.view(), subject).recorded.map(r => [r.to, r.established]), [[ticketId('x'), true]]);
  commit({'tickets/x.json': JSON.stringify({schema: 'ophanim.ticket/v1', item: 'x', path: 'lib/b.mjs', copy: []})}, 'the ticket moves its slot');
  g.graph.observe('ophanim.repo', {...g.by, observed_at: at(2)});
  const r = whyExists(g.graph.view(), subject);
  assert.deepEqual(r.recorded.map(x => [x.to, x.established]), [[ticketId('x'), false]]);
  assert.match(r.recorded[0].assertions[0].why, /^stale/);
  assert.deepEqual(r.requirements, [], 'and the requirement is a gap again');
});
