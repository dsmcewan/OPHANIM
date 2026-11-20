// The hub-readiness determination (ophanim/graph/hub.mjs; docs/knowledge-graph/hub-and-spoke.md), on SMALL SYNTHETIC
// federations with known answers: three departmental instances (Finance, Technology, Compliance) and the central hub,
// each on its own real packages/ledger chain with synthetic keys (fixtures/hub-world.mjs, on Slice E's machinery).
// A REGISTER HOLE is asserted as the CURRENT behaviour and named as the hole it is (KG-14, KG-8, and one unregistered):
// when one is fixed its test fails, and the coordinator turns it into a guard. No provider, no network, temp dirs only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {criterion, verdict, criteria, codeFacts, ledgerDigests, withheldSearch, collectiveGraph, scaleRun, freshnessRun, ingestionRun, learningRun, dualRoleRun,
  governanceRun, replicationRun, lineageRun, PRIORITY, THRESHOLDS, SMALL, CODE_FACTS} from './hub.mjs';
import {hubWorld, seed, departmentSnapshot, DEPARTMENTS, NODES, WITHHELD_MARK, at} from './fixtures/hub-world.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEAD = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
const memo = fn => { let v; return () => (v ??= fn()); };
const ingestion = memo(() => ingestionRun()), replication = memo(() => replicationRun({commit: HEAD})), learning = memo(() => learningRun());
const freshness = memo(() => freshnessRun()), dual = memo(() => dualRoleRun()), governance = memo(() => governanceRun()), lineage = memo(() => lineageRun());
const smallScale = memo(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-hub-test-scale-'));
  try { return {scale: 1, size: {entities: 30, relationships: 90}, run: scaleRun({root, size: {entities: 30, relationships: 90}, rounds: 2, opens: 1})}; }
  finally { fs.rmSync(root, {recursive: true, force: true}); }
});
/** The repository facts criteria() reads, as a synthetic record: KG-4 pending, no replication command, two state variables. */
const repoFacts = (o = {}) => ({register: {'KG-4': {status: 'pending owner (reserved items)'}}, decisions: {slice_e: 'the production access policy; key custody'},
  state: {shown: [{name: 'OPHANIM_STATUS_LEDGER', runtime_readers: 3}], total: 1, more: 0}, tracked_state: {status_ledger_files: 87}, replication_symbols: [], ...o});
const measurements = (o = {}) => ({scales: [smallScale()], freshness: freshness(), ingestion: ingestion(), learning: learning(), dual: dual(), governance: governance(),
  replication: replication(), lineage: lineage(), repo: repoFacts(), own: {exported: true, nodes: 1}, facts: codeFacts(ROOT, HEAD), ...o});
const clone = x => JSON.parse(JSON.stringify(x));
const row = (rows, id) => rows.find(r => r.id === id);

test('hub: the verdict -- known answers: all pass is APPROPRIATE; conditions in PRIORITY order; a blocking fail is NOT APPROPRIATE NOW', () => {
  const pass = PRIORITY.map(id => criterion(id, id, 'pass'));
  assert.deepEqual(verdict(pass), {verdict: 'APPROPRIATE', failing: [], conditions: [], path: []});
  const cond = [...pass.filter(c => !['R4', 'R9'].includes(c.id)), criterion('R4', 'cost', 'gap', {condition: 'wire the snapshot'}), criterion('R9', 'replicate', 'condition', {condition: 'a command'})];
  const v = verdict(cond);
  assert.equal(v.verdict, 'APPROPRIATE WITH CONDITIONS');
  assert.deepEqual(v.conditions.map(c => c.criterion), ['R9', 'R4'], 'R9 comes before R4 in PRIORITY');
  const bad = [...cond.filter(c => c.id !== 'R5'), criterion('R5', 'ingestion', 'fail', {blocking: true, condition: 'refuse the splice'})];
  const n = verdict(bad);
  assert.deepEqual([n.verdict, n.failing, n.path.map(p => p.criterion), n.path[0].blocking], ['NOT APPROPRIATE NOW', ['R5'], ['R5', 'R9', 'R4'], true]);
  const soft = verdict([...pass.filter(c => c.id !== 'R8'), criterion('R8', 'load', 'fail', {blocking: false, condition: 'off the tick'})]);
  assert.equal(soft.verdict, 'APPROPRIATE WITH CONDITIONS', 'a non-blocking fail is a condition, not a refusal');
  assert.throws(() => criterion('R1', 'x', 'maybe'));
  assert.deepEqual(Object.keys(THRESHOLDS).sort(), [...PRIORITY].sort(), 'every criterion states its threshold');
});

test('hub: R1 -- the hub leaves every department ledger byte for byte, holds no withheld value, and the search finds a leak when there is one', () => {
  const w = hubWorld();
  try {
    const s = seed(w, SMALL), d0 = ledgerDigests(w), central = w.central();
    central.catchUp({by: w.centralBy, now: at(10)});
    assert.deepEqual(ledgerDigests(w), d0, 'catch-up, linking and propagation leave every department ledger as written');
    const r = withheldSearch(w);
    assert.ok(r.planted.restricted > 5 && r.planted.internal > 5, 'withheld values are planted in every class');
    assert.deepEqual([r.found.restricted, r.found.internal, r.found.other, r.restricted_ids_disclosed_by_owner.total], [0, 0, 0, 0]);
    assert.ok(r.restricted_ids_named_by_a_referrer.total > 0, 'Compliance names Technology\'s vault in its own reference: told apart from a disclosure');
    // Positive controls: a department's own write changes its digest; a copied value IS found.
    s.republish('technology', 11, {extra: {'technology/systems/api/leaky': {access: 'public', attributes: {note: `${WITHHELD_MARK}technology-vault-key`}}}});
    assert.notEqual(ledgerDigests(w).technology, d0.technology, 'the digest sees a department\'s own write');
    central.catchUp({by: w.centralBy, now: at(12)});
    assert.ok(withheldSearch(w).found.restricted >= 1, 'the search finds a restricted value the department copied into a public attribute (KG-8)');
  } finally { w.close(); }
  assert.equal(governance().central_writes_department.code, 'FEDERATION_UNAUTHORIZED');
});

test('hub: R2 -- the collective graph links exactly the permitted cross-department dependencies, with provenance, and nothing forbidden', () => {
  const w = hubWorld();
  try {
    const s = seed(w, SMALL), central = w.central();
    central.catchUp({by: w.centralBy, now: at(10)});
    const g = collectiveGraph(w, central, s, at(10));
    assert.deepEqual(g.links.map(l => l.link), [`consumes ${NODES.control} -> ${NODES.report}`, `depends-on ${NODES.run} -> ${NODES.api}`]);
    assert.deepEqual([g.linked_exactly_the_permitted, g.provenance, g.forbidden_linked], [true, true, []]);
    assert.ok(g.links.every(l => l.established && l.inputs === 2 && l.reference.anchor === w.anchors[l.reference.instance]));
    assert.deepEqual(g.unresolved, [{from: NODES.control, to: NODES.vault, reason: 'missing-node'}], 'a reference to a restricted node never resolves');
    assert.equal(g.withheld_references.compliance, 1, 'a reference of a type the policy does not permit (mentions) is withheld at the department');
    assert.deepEqual(g.transitive.reaches, [NODES.run, NODES.report, NODES.control], 'a change to Technology\'s API reaches Finance and then Compliance');
    assert.deepEqual(g.transitive.instances, ['compliance', 'finance', 'technology']);
  } finally { w.close(); }
});

test('hub: R3 -- a disconnected department reads stale; departments run while the hub is down; catch-up goes by version, once', () => {
  const f = freshness();
  assert.equal(f.disconnected.state, 'stale');
  assert.ok(f.disconnected.reasons.some(r => /unreachable/.test(r)));
  assert.deepEqual([f.disconnected.stale_links, f.disconnected.link_of_others_stale, f.disconnected.others], [[`consumes ${NODES.control} -> ${NODES.report}`], false, {finance: 'current', technology: 'current'}]);
  assert.ok(f.independent.every(d => d.published && d.answered && d.hub_reachable === false), 'each department records, publishes and answers with the hub down');
  for (const c of f.catch_up) assert.deepEqual([c.imported_now, c.in_order, c.duplicates, c.chain_equals_outbox], [c.expected_now, true, 0, true], c.instance);
  assert.deepEqual(f.repeat, {imported: 0, notices: 0});
  assert.equal(f.all_current_after, true);
});

test('hub: R5 REGISTER HOLE KG-14 -- a spliced chain (previous not the stored tail) is STORED, never imported, and freshness still reads current', () => {
  const s = ingestion().splice;
  assert.deepEqual([s.stored, s.imported, s.freshness, s.pending_reported], [2, 0, 'current', 0], 'KG-14 as it stands: the hub halts silently');
});

test('hub: R5 guards and holes -- a fork and two spoofs refused; a rollback (UNREGISTERED) and the genesis spoof (KG-8) accepted; a copied value leaks (KG-8)', () => {
  const g = ingestion();
  assert.deepEqual([g.fork.accepted, g.fork.refused], [false, ['FEDERATION_FORK']]);
  assert.deepEqual([g.spoof_other_anchor.refused, g.spoof_unpinned_key.refused], [['FEDERATION_IDENTITY'], ['FEDERATION_SIGNATURE']]);
  assert.ok(g.rollback.offered_seq < g.rollback.previous_seq);
  assert.deepEqual([g.rollback.stored, g.rollback.imported, g.rollback.projection_reverted, g.rollback.freshness], [1, 1, true, 'current'],
    'UNREGISTERED: an export of an earlier view, chained after the tail, rolls the hub\'s projection back');
  assert.deepEqual([g.genesis_spoof.same_anchor, g.genesis_spoof.imported, g.genesis_spoof.forged_fact_in_hub], [true, 1, true], 'KG-8: a re-created ledger is the same instance to the hub');
  assert.equal(g.value_leak.restricted_value_in_hub, true, 'KG-8: the hub cannot tell a copied restricted value');
});

test('hub: R9 -- three replicas from one commit, each with its own status, work, cycle, run and graph ledgers and keys; nothing shared', () => {
  const r = replication();
  assert.deepEqual(r.replicas.map(x => x.instance), DEPARTMENTS);
  assert.ok(r.replicas.every(x => x.commit === HEAD && Object.keys(x.anchors).length === 5));
  assert.deepEqual(r.fresh, {anchors: 15, distinct: 15, roots_disjoint: true, key_dirs_disjoint: true});
});

test('hub: R10 REGISTER HOLE KG-8 -- replicas made with identical authority share one anchor, and one is accepted at the hub as another', () => {
  const r = replication();
  assert.deepEqual(r.template.same_anchor_by_ledger, {status: false, work: false, cycle: false, run: false, graph: true},
    'the ledger creators that generate their own keys give distinct anchors; the graph ledger made from one template does not');
  assert.equal(r.impersonation.identical_anchors, true);
  assert.deepEqual([r.impersonation.finance_key_signs_as_compliance.imported, r.impersonation.finance_key_signs_as_compliance.forged_fact_in_hub], [1, true],
    'KG-8 at the hub: Finance, holding the shared template keys, is imported as Compliance');
  assert.deepEqual([r.separate.distinct_anchors, r.separate.finance_key_signs_as_compliance.refused], [true, ['FEDERATION_SIGNATURE']], 'with keys of its own each replica is told apart');
});

test('hub: R12 -- a defect in Technology reaches Finance and, transitively, Compliance through the hub with provenance; a lesson does not cross the test policy', () => {
  const l = learning();
  assert.deepEqual(l.defect.notices, {finance: 1, technology: 0, compliance: 1});
  for (const d of ['finance', 'compliance']) {
    assert.ok(l.defect.provenance[d].every(p => p.origin === 'technology' && p.export && p.entries && p.via === 'central'), d);
    assert.ok(l.defect.received[d].recorded === 1 && l.defect.received[d].ledger_verifies && l.defect.received[d].own_keys_in_keyring > 0 && l.defect.received[d].foreign_keys_in_keyring === 0, d);
  }
  assert.deepEqual(l.defect.provenance.compliance[0].references, [NODES.control], 'the notice names the recipient\'s own node only');
  assert.equal(l.defect.ledger_files_copied_to_hub, 0);
  assert.deepEqual([l.lesson.withheld_references, l.lesson.linked, l.lesson.applies_to_admissible_across], [1, false, true]);
});

test('hub: R6 -- the central refuses a department named as itself, but a caller-added origin records hub-own facts no policy filters', () => {
  const d = dual();
  assert.equal(d.department_named_as_the_central.refused, true);
  assert.deepEqual([d.hub_own_fact_without_export.recorded, d.hub_own_fact_without_export.established_in_collective_graph, d.hub_own_fact_without_export.detail_unfiltered_in_hub],
    [true, true, true], 'openCentral spreads its options after its origins: separation of the hub\'s own facts is a deployment rule, not a guard');
});

test('hub: R7 -- the hub cannot write into a department, sign its status, or put work in its ledger', () => {
  const g = governance();
  assert.equal(g.central_writes_department.refused, true);
  assert.equal(g.keys.department_keyrings_hold_a_central_key, false);
  assert.equal(g.hub_signed_status_in_replica.refused, true);
  assert.equal(g.federation_intake_in_replica.refused, true);
});

test('hub: R11 -- an export names no code; an export carrying a type the hub\'s contract lacks is refused whole', () => {
  const l = lineage();
  assert.deepEqual([l.contract, l.contract_version_named, l.code_fields], ['ophanim.graph/v1', false, []]);
  assert.equal(l.newer_type_export.stored, 0);
  assert.match(l.newer_type_export.refused[0], /not an entity type/);
});

test('hub: the criteria from the measurements -- as built: NOT APPROPRIATE NOW (R5, R10); repaired: only the conditions remain', () => {
  const m = measurements(), rows = criteria(m), v = verdict(rows);
  assert.deepEqual(rows.map(r => r.id), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12']);
  assert.deepEqual([v.verdict, v.failing], ['NOT APPROPRIATE NOW', ['R5', 'R10']]);
  assert.deepEqual(Object.fromEntries(rows.map(r => [r.id, r.status])), {R1: 'pass', R2: 'pass', R3: 'pass', R4: 'pass', R5: 'fail', R6: 'condition', R7: 'condition', R8: 'pass',
    R9: 'gap', R10: 'fail', R11: 'gap', R12: 'condition'});
  assert.match(row(rows, 'R5').condition, /splice, rollback, genesis_spoof/);
  assert.ok(rows.every(r => r.threshold && (r.status === 'pass' || r.condition)), 'every criterion states its threshold, and every open one its condition');
  // The holes repaired (as the measurements would read): R5 and R10 pass, the rest are conditions.
  const fixed = clone(m);
  for (const k of ['splice', 'rollback', 'genesis_spoof']) fixed.ingestion[k].accepted = false;
  fixed.ingestion.value_leak.restricted_value_in_hub = false;
  fixed.replication.template.same_anchor_by_ledger.graph = false;
  fixed.replication.impersonation.finance_key_signs_as_compliance.imported = 0;
  const f = verdict(criteria(fixed));
  assert.deepEqual([f.verdict, f.conditions.map(c => c.criterion)], ['APPROPRIATE WITH CONDITIONS', ['R7', 'R9', 'R11', 'R6', 'R12']]);
  // Each criterion's check, one fault at a time.
  const fault = (edit, id, status) => { const x = clone(fixed); edit(x); assert.equal(row(criteria(x), id).status, status, `${id} under the fault`); };
  fault(x => { x.scales[0].run.r1.found.internal = 1; }, 'R1', 'fail');
  fault(x => { x.scales[0].run.r1.ledgers_unchanged.all = false; }, 'R1', 'fail');
  fault(x => { x.scales[0].run.r2.forbidden_linked = ['mentions x -> y']; }, 'R2', 'fail');
  fault(x => { x.scales[0].run.r2.transitive.reaches.pop(); }, 'R2', 'fail');
  fault(x => { x.freshness.catch_up[0].duplicates = 1; }, 'R3', 'fail');
  fault(x => { x.freshness.disconnected.state = 'current'; }, 'R3', 'fail');
  fault(x => { x.scales[0].run.opens.find(o => o.mode === 'full').ms = 5000; }, 'R4', 'gap');
  fault(x => { for (const o of x.scales[0].run.opens) o.ms = 5000; }, 'R4', 'fail');
  fault(x => { x.ingestion.splice.accepted = true; }, 'R5', 'fail');
  fault(x => { x.ingestion.value_leak.restricted_value_in_hub = true; }, 'R5', 'condition');
  fault(x => { x.dual.hub_own_fact_without_export.recorded = false; }, 'R6', 'pass');
  fault(x => { x.governance.hub_signed_status_in_replica.refused = false; }, 'R7', 'fail');
  fault(x => { x.repo.register['KG-4'].status = 'decided'; }, 'R7', 'pass');
  fault(x => { for (const t of x.scales[0].run.ticks) t.catch_up_ms = 5000; }, 'R8', 'fail');
  fault(x => { x.scales[0].run.opens.find(o => o.mode === 'full').ms = 5000; }, 'R8', 'condition');
  fault(x => { x.repo.replication_symbols = ['ophanim/replicate.mjs#replicate']; }, 'R9', 'pass');
  fault(x => { x.replication.fresh.distinct = 14; x.repo.replication_symbols = ['ophanim/replicate.mjs#replicate']; }, 'R9', 'gap');
  fault(x => { x.replication.template.same_anchor_by_ledger.status = true; }, 'R10', 'fail');
  fault(x => { x.lineage.code_fields = ['commit']; x.lineage.contract_version_named = true; }, 'R11', 'condition');
  fault(x => { x.learning.defect.notices.compliance = 0; }, 'R12', 'fail');
  fault(x => { x.learning.lesson.linked = true; }, 'R12', 'pass');
});

test('hub: the cost run at a small scale -- the snapshot open reproduces the full open, and the hub as built does not use one', () => {
  const r = smallScale().run;
  const full = r.opens.find(o => o.mode === 'full'), snap = r.opens.find(o => o.mode === 'snapshot');
  assert.ok(full && snap && !full.error && !snap.error, JSON.stringify(r.opens).slice(0, 300));
  assert.deepEqual([snap.digest, snap.seq, snap.snapshot.used, full.snapshot], [full.digest, full.seq, true, null]);
  assert.equal(r.r1.hub_as_built_snapshot, null, 'openCentral opened in full: nothing passed a snapshot');
  // Each tick: three imports; Technology's API change notifies Finance and (through Finance's report) Compliance, and
  // Finance's own change notifies Compliance: three notices.
  assert.ok(r.ticks.length === 2 && r.ticks.every(t => t.notices === 3 && Object.values(t.imported).every(n => n === 1)), JSON.stringify(r.ticks));
  assert.equal(r.idle.imported, 0);
});

test('hub: determinism and the code facts -- a department\'s inventory is a function of its size; every cited code fact is located at the commit', () => {
  const a = departmentSnapshot('finance', {entities: 40, relationships: 120}), b = departmentSnapshot('finance', {entities: 40, relationships: 120});
  assert.deepEqual(a, b);
  assert.equal(Object.keys(a.entities).length, 40);
  assert.equal(a.relationships.length, 120);
  const facts = codeFacts(ROOT, HEAD);
  assert.equal(facts.length, CODE_FACTS.length);
  assert.deepEqual(facts.filter(f => f.gap), [], 'every code fact the determination cites is at a file:line of the commit');
  assert.ok(facts.every(f => /^[\w./-]+:\d+$/.test(f.at)));
});
