// Slice D part 1, the WORK graph (KD1-1, KD1-2, KD1-9; docs/knowledge-graph/slice-d1.md): the work ledger projected READ
// ONLY through its own reader, each fact from the entry that states it; the shared prerequisites of independent items
// (demonstration 1), reported and never acted on; registration with an extractor version; the negative cases of
// demonstration 12 at this level. The work ledger is SYNTHETIC (this container holds none: inventory.md (a)), written
// through the ledger's own writer; the capability graph and the repository the existence check reads are REAL.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {entityId} from '../../packages/graph/index.mjs';
import {workGraphSource, readWorkLedgerOnly, sharedPrerequisites, recordSharedPrerequisites, existenceOf, dependencyCycles, requirementsOf,
  WORK_GRAPH_SOURCE, WORK_RULE, planId, artifactId, stageReviewId, validationId, completionId, promptId, sharedPrerequisiteId} from './work.mjs';
import {D1_SOURCES, D1_MODULES} from './d1-sources.mjs';
import {sourcesOf, openSystemsGraph, extractorVersionOf, ROOT} from './extract/index.mjs';
import {fileId, ticketId, itemId} from './extract/repo.mjs';
import {d1WorkLedger, d1CycleLedger, appendPlan, SHARED_CONTRACT, SDK_RUNTIME, SCHEDULER} from './fixtures/d1-work.mjs';
import {d1Graph, T0} from './fixtures/d1-graph.mjs';

const cleanup = [];
after(() => { for (const f of cleanup) f(); });
const fixture = (opts) => { const w = d1WorkLedger(opts); cleanup.push(() => fs.rmSync(w.dir, {recursive: true, force: true})); return w; };
const hexOf = h => h.replace(/^sha256:/, '');
const edge = (v, type, from, to) => v.edgesOf(from, {mode: 'established', types: [type]}).some(e => e.from === from && e.to === to);
const bytesOf = root => fs.readdirSync(root).filter(f => f !== 'keys').sort().map(f => [f, fs.statSync(path.join(root, f)).isFile() ? fs.readFileSync(path.join(root, f), 'utf8') : 'dir']);

test('work: the work ledger is projected READ ONLY through its own reader, each fact from the entry that states it (SYNTHETIC ledger)', t => {
  const w = fixture();
  const before = bytesOf(w.root);
  const g = d1Graph({work: {root: w.root, anchor: w.anchor}, only: [WORK_GRAPH_SOURCE], lessons: false});
  t.after(() => g.close());
  assert.deepEqual([g.observed[WORK_GRAPH_SOURCE].recorded, g.observed[WORK_GRAPH_SOURCE].state], [true, 'current']);
  const v = g.graph.view(), head = readWorkLedgerOnly({root: w.root, anchor: w.anchor}).verify().head;
  assert.equal(g.observed[WORK_GRAPH_SOURCE].version, head, 'the source version is the ledger\'s head entry');
  // Every fact names the entry that states it, and that entry is on the ledger.
  const entries = new Set(readWorkLedgerOnly({root: w.root, anchor: w.anchor}).ledger.read().map(e => readWorkLedgerOnly({root: w.root, anchor: w.anchor}).ledger.hashOf(e)));
  const facts = v.subjects().flatMap(s => v.query(s, 'established')).filter(a => a.source.id === WORK_GRAPH_SOURCE && !a.subject.includes('/evidence/source/'));
  assert.ok(facts.length > 100, `${facts.length} facts`);
  for (const a of facts) {
    assert.equal(a.source.version, head, a.subject);
    const m = /^status\/work#(sha256:[0-9a-f]{64})$/.exec(a.source.ref);
    if (m === null) assert.equal(a.source.ref, 'status/work', `${a.subject}: a fact names its entry, or the ledger for an item it names`);
    else assert.ok(entries.has(m[1]), `${a.subject}: its entry is on the ledger`);
  }
  // Prompts: one per intake source; a candidate is never executable; an item exists because of its prompt.
  const cand = promptId('issue', 'fixture/issues#7');
  assert.deepEqual([v.node(cand).attributes.classification, v.node(cand).attributes.executable], ['candidate', false]);
  assert.ok(edge(v, 'introduced-because-of', itemId('sdk-transport'), promptId('status', 'sdk-transport')));
  // The lifecycle chain of one item: plan, artifact, review, validation and completion claim.
  const r = w.records['sdk-transport'];
  const P = planId(r.plan.hash), A = artifactId(r.implement.hash), R = stageReviewId(r.review.hash), V = validationId(r.validate.hash), C = completionId(r.outcome.hash);
  assert.ok(edge(v, 'derived-from', P, fileId(w.files.transport)) && edge(v, 'derived-from', P, itemId('sdk-transport')));
  assert.ok(edge(v, 'requires-capability', P, SDK_RUNTIME) && edge(v, 'requires-capability', P, SHARED_CONTRACT), 'the typed requirements');
  assert.ok(edge(v, 'derived-from', ticketId('sdk-transport'), P), 'the ticket the plan wrote');
  assert.ok(edge(v, 'derived-from', A, P) && edge(v, 'produces', A, fileId(w.files.transport)));
  assert.ok(edge(v, 'derived-from', R, A) && edge(v, 'verifies', R, A), 'a review is a qualification of the artifact');
  assert.ok(edge(v, 'derived-from', V, R) && edge(v, 'verifies', V, A) && edge(v, 'derived-from', V, fileId(w.files.validated)));
  assert.ok(edge(v, 'derived-from', C, V));
  assert.deepEqual([v.node(C).attributes.signed, v.node(C).attributes.to], [false, 'Resolved'], 'an unsigned completion claim, never a completion');
  // Resources: the claim's budget, the provider calls charged before they were made, one billed request.
  const lease = entityId({domain: 'work', type: 'lease', key: hexOf(r.claims[1])});
  assert.ok(v.subjects().some(s => s.includes('/work/usage/spend/') && edge(v, 'derived-from', s, lease)));
  assert.ok(v.subjects().some(s => s.includes('/work/request/') && v.node(s).attributes.kind === 'failover' && edge(v, 'derived-from', s, lease)));
  assert.equal(v.node(entityId({domain: 'work', type: 'budget', key: hexOf(r.claims[1])})).attributes.provider_calls, 5);
  // Units: derived from their plan, depending on each other as the plan states.
  const tp = planId(w.records['team-construction'].plan.hash), u1 = entityId({domain: 'work', type: 'work-unit', key: `${hexOf(w.records['team-construction'].plan.hash)}/u1`});
  const u2 = entityId({domain: 'work', type: 'work-unit', key: `${hexOf(w.records['team-construction'].plan.hash)}/u2`});
  assert.ok(edge(v, 'derived-from', u1, tp) && edge(v, 'depends-on', u2, u1));
  // Free text is TEXT: kept on the plan, never an edge.
  assert.deepEqual(v.node(tp).attributes.free_text_capabilities, ['dynamic team construction']);
  assert.ok(edge(v, 'requires-capability', tp, SDK_RUNTIME), 'a graph id in capabilities is a typed requirement');
  assert.equal(v.edgesOf(tp, {mode: 'possible', types: ['requires-capability', 'depends-on']}).filter(e => e.from === tp).length, 2, 'no edge from the free text');
  // READ ONLY: the ledger's bytes are unchanged and no key directory was created.
  assert.deepEqual(bytesOf(w.root), before);
  assert.equal(fs.existsSync(path.join(w.root, 'keys')), false);
});

test('work: an absent work ledger is refused and NOTHING is created; a foreign anchor is refused; the source is recorded unavailable', t => {
  const w = fixture();
  const absent = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-d1-absent-')), 'work');
  t.after(() => fs.rmSync(path.dirname(absent), {recursive: true, force: true}));
  assert.throws(() => readWorkLedgerOnly({root: absent, anchor: w.anchor}), /no work ledger/);
  assert.equal(fs.existsSync(absent), false, 'nothing is created where no ledger is');
  assert.throws(() => readWorkLedgerOnly({root: w.root, anchor: 'sha256:' + '0'.repeat(64)}), /not the one the caller pinned/);
  assert.throws(() => readWorkLedgerOnly({root: 'relative/work', anchor: w.anchor}), /absolute root/);
  assert.throws(() => readWorkLedgerOnly({root: w.root}), /pinned anchor/);
  const g = openSystemsGraph({sources: [workGraphSource({root: absent, anchor: w.anchor})]});
  t.after(() => g.close());
  const o = g.graph.observe(WORK_GRAPH_SOURCE, {...g.by, observed_at: T0});
  assert.deepEqual([o.recorded, o.state], [true, 'unavailable']);
  assert.equal(fs.existsSync(absent), false);
});

test('work: every source of Slice D part 1 is registered and declares its extractor\'s version (KD1-9); an unregistered extractor is refused', async t => {
  const w = fixture(), c = await d1CycleLedger();
  t.after(() => fs.rmSync(c.dir, {recursive: true, force: true}));
  const {sources} = sourcesOf({repo: ROOT, commit: 'HEAD', status: null, work: {root: w.root, anchor: w.anchor}, cycle: {root: c.root, anchor: c.anchor}, deps: false});
  const mine = sources.filter(s => D1_SOURCES.includes(s.id));
  assert.deepEqual(mine.map(s => s.id).sort(), [...D1_SOURCES].sort(), 'each is composed when its input is named');
  for (const s of mine) {
    const {factory, module} = D1_MODULES[s.id];
    assert.equal((await import(pathToFileURL(module).href))[factory.name], factory, `${s.id}: its extractor is defined in ${path.relative(ROOT, module)}`);
    assert.match(s.extractorVersion ?? '', /^sha256:[0-9a-f]{64}$/, s.id);
    assert.equal(s.extractorVersion, extractorVersionOf(module), s.id);
  }
  const g = openSystemsGraph({sources: [workGraphSource({root: w.root, anchor: w.anchor, extractor: 'ophanim.unregistered'})]});
  t.after(() => g.close());
  assert.throws(() => g.graph.observe(WORK_GRAPH_SOURCE, {...g.by, observed_at: T0}), e => e.code === 'GRAPH_REFUSED' && /origin "ophanim.unregistered" is not registered/.test(e.message));
});

test('demonstration 1: two or more independent items requiring one capability or component -- one shared prerequisite, reported with each item\'s requirement and whether it EXISTS (SYNTHETIC work; REAL capability graph and repository)', t => {
  const w = fixture();
  const g = d1Graph({work: {root: w.root, anchor: w.anchor}, only: ['ophanim.repo', WORK_GRAPH_SOURCE], lessons: false, capability: true});
  t.after(() => g.close());
  const v = g.graph.view(), s = sharedPrerequisites(v);
  assert.deepEqual(s.findings.map(f => [f.prerequisite, f.items.map(i => i.item)]), [
    [SDK_RUNTIME, ['sdk-transport', 'team-construction']],
    [SHARED_CONTRACT, ['resource-accounting', 'sdk-transport', 'team-construction']],
  ], 'one finding per prerequisite, naming every item that requires it; the module only one item requires is none; unrelated-docs is in none');
  const [sdk, contract] = s.findings;
  // Each requirement says what states it and where: the plan, the relationship, the ledger entry.
  for (const f of s.findings) for (const i of f.items) for (const r of i.requirements) {
    assert.match(r.ref, /^status\/work#sha256:[0-9a-f]{64}$/, `${i.item}: the entry that states it`);
    assert.ok(r.by.includes('/work/plan/') && ['requires-capability', 'depends-on'].includes(r.relationship));
  }
  assert.equal(contract.items.find(i => i.item === 'sdk-transport').requirements[0].why, 'the transport is routed through the shared capability contract');
  // EXISTS: the runtime from the REAL capability graph (an executable capability combines it); the contract is a GAP.
  assert.equal(sdk.existence.exists, true);
  assert.ok(sdk.existence.by.length > 0 && sdk.existence.by.every(id => id.includes('/capability/capability/')), 'what provides it');
  assert.ok(sdk.existence.sources.every(x => x.source.startsWith('pantheon.')), 'stated by the capability graph, not by the plan that names it');
  assert.equal(contract.existence.exists, false);
  assert.match(contract.existence.gap, /no source states that .* exists/);
  // A node a plan NAMES is established as named, and still not existing: the check reads other sources only.
  assert.equal(v.nodeIn(SHARED_CONTRACT, 'established'), true);
  assert.equal(existenceOf(v, SCHEDULER).exists, true, 'a module the repository holds at the commit exists');
  assert.equal(existenceOf(v, SCHEDULER).basis, 'the repository holds it at the graph\'s commit');
  t.diagnostic(`demonstration 1: ${s.findings.length} shared prerequisites; ${SHARED_CONTRACT.split('/').at(-1)}: ${contract.items.length} items, missing; ${SDK_RUNTIME.split('/').at(-1)}: ${sdk.items.length} items, provided by ${sdk.existence.by.length} executable capabilities`);
});

test('demonstration 1: a shared prerequisite is RECORDED as a report, never merging, reassigning or re-owning a ticket; recording twice is a no-op', t => {
  const w = fixture();
  const g = d1Graph({work: {root: w.root, anchor: w.anchor}, only: ['ophanim.repo', WORK_GRAPH_SOURCE], lessons: false, capability: true});
  t.after(() => g.close());
  const work = v => v.subjects().filter(x => /^ophanim\/work\/(ticket|plan|item|work-unit|prompt|lease)\//.test(x));
  const state = v => Object.fromEntries(work(v).map(x => [x, [v.query(x, 'established').map(a => a.id).sort(), v.edgesOf(x, {mode: 'possible'}).map(e => e.subject).sort()]]));
  const v0 = g.graph.view(), before = state(v0), stats0 = v0.stats();
  const r1 = recordSharedPrerequisites(g.graph, g.rule, {observed_at: T0});
  assert.deepEqual(r1.map(x => x.recorded), [true, true]);
  const v1 = g.graph.view();
  assert.deepEqual(state(v1), before, 'every ticket, plan, item, unit, prompt and lease keeps exactly its assertions and relationships');
  assert.deepEqual([v1.stats().relationships, v1.stats().entities], [stats0.relationships, stats0.entities + 2], 'two findings, and not one relationship more');
  for (const x of r1) {
    const a = v1.query(x.subject, 'established');
    assert.equal(a.length, 1);
    assert.deepEqual([a[0].classification, a[0].origin], ['derived', WORK_RULE]);
    const rec = v1.assertion(a[0].id).record;
    assert.deepEqual(Object.keys(rec.attributes).sort(), ['existence', 'items', 'kind', 'prerequisite', 'report'], 'a report: no merge, owner or assignment field');
    assert.match(rec.attributes.report, /never acted on/);
    assert.equal(x.subject, sharedPrerequisiteId(rec.attributes.prerequisite));
    assert.ok(rec.inputs.length > 0 && rec.inputs.every(id => v1.established(id)), 'derived from the requirement edges that state it');
  }
  assert.deepEqual(v1.query(sharedPrerequisiteId(SHARED_CONTRACT), 'established').map(a => v1.assertion(a.id).record.missing_evidence.length), [1], 'the missing prerequisite carries its gap');
  const r2 = recordSharedPrerequisites(g.graph, g.rule, {observed_at: '2026-11-20T13:00:00.000Z'});
  assert.deepEqual(r2.map(x => x.recorded), [false, false], 'the same findings again: nothing appended');
  assert.equal(g.graph.view().seq, v1.seq);
});

test('work: dependency cycles are reported, never broken silently; the fixture\'s dependencies are acyclic', t => {
  const w = fixture({keep: true});
  appendPlan(w.writer, {item: 'cyclic', units: [
    {unit_id: 'x', depends_on: ['y'], owned_paths: ['lib/x.mjs'], difficulty: 'easy', specialist_role: 'node-engineer', allowed_subagents: [], verify_cmd: 'true', invariants: ['synthetic']},
    {unit_id: 'y', depends_on: ['x'], owned_paths: ['lib/y.mjs'], difficulty: 'easy', specialist_role: 'node-engineer', allowed_subagents: [], verify_cmd: 'true', invariants: ['synthetic']}]});
  const g = d1Graph({work: {root: w.root, anchor: w.anchor}, only: [WORK_GRAPH_SOURCE], lessons: false});
  t.after(() => g.close());
  const cycles = dependencyCycles(g.graph.view());
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].map(id => id.split('/').at(-1)).sort(), ['x', 'y']);
  const plain = fixture();
  const g3 = d1Graph({work: {root: plain.root, anchor: plain.anchor}, only: [WORK_GRAPH_SOURCE], lessons: false});
  t.after(() => g3.close());
  assert.deepEqual(dependencyCycles(g3.graph.view()), []);
});

test('work: requirementsOf types only graph ids; free text is kept as text and an unrequirable id is refused with why', () => {
  const r = requirementsOf({requires: [SHARED_CONTRACT, {id: SDK_RUNTIME, why: 'x'}, 'not an id', 'ophanim/learning/lesson/x'], capabilities: ['accurate resource accounting', SCHEDULER]});
  assert.deepEqual(r.typed.map(x => [x.id, x.type]), [[SHARED_CONTRACT, 'requires-capability'], [SDK_RUNTIME, 'requires-capability'], [SCHEDULER, 'depends-on']]);
  assert.deepEqual(r.free, ['accurate resource accounting']);
  assert.deepEqual(r.refused.map(x => x.value), ['not an id', 'ophanim/learning/lesson/x']);
});
