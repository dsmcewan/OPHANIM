// The metrics per executable capability (knowledge graphs, Slice C1, KC5): each defined metric extracted from SYNTHETIC
// fixture records (pantheon/tests/fixtures/capability-records.json, every record marked synthetic, laid out on disk in a
// temporary directory as the real records are), with its sources and coverage; no qualified-for without an owner-defined
// criterion; the metrics as observed assertions a registered tool admits; the command-line report, on fixtures and on an
// owner's PANTHEON_HOME.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {capabilitySnapshot, E} from '../src/capability/graph.mjs';
import {extractMetrics, loadRecords, observedAssertions, qualificationsOf, METRIC_DEFINITIONS, QUALIFICATION_CRITERION} from '../src/capability/metrics.mjs';
import {run} from '../src/capability/cli.mjs';
import {recordRefusal} from '../../packages/graph/schema.mjs';
import {registries, capabilityWorld, writeRecords, KEYS, T0} from './fixtures/capability-helpers.mjs';

const SNAP = capabilitySnapshot(registries());
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-records-'));
process.on('exit', () => fs.rmSync(DIR, {recursive: true, force: true}));
const SPEC = writeRecords(DIR);
const R = p => path.join(DIR, p);
const M = extractMetrics(loadRecords(SPEC), {snapshot: SNAP});
const zero = {answered: 0, accepted: 0, revised: 0, refused: 0, failed: 0, 'identity-mismatch': 0};
const counts = over => ({...zero, ...over});

test('metrics: each defined metric is extracted per executable capability from the records that hold it, with its sources and coverage', () => {
  assert.deepEqual(M.definitions, ['attempts', 'provider_requests', 'outcomes', 'tokens', 'cost_usd', 'latency_ms', 'billing_refusals', 'gemini_requests']);
  assert.ok(METRIC_DEFINITIONS.every(d => d.definition.length > 60 && d.sources.length && d.unit), 'each metric is defined: what it counts, from what, in what unit');
  const lane = M.capabilities['agy-cli/agy_google/gemini-4-hydrogen-high'];
  assert.equal(lane.attempts, 3);
  assert.deepEqual(lane.provider_requests, {value: 6, unknown_counted_as_one: 1}, '1 + 1 + an unknown count taken as one, + the work-ledger stage\'s 3');
  assert.deepEqual(lane.outcomes, {implementer: {'stakes:normal/depth:standard': counts({answered: 2, accepted: 1, revised: 1, 'identity-mismatch': 1})}});
  assert.deepEqual(lane.stages, {implementer: {passed: 1}});
  assert.deepEqual(lane.tokens, {input: 800, output: 1500, n: 1, missing: 2});
  assert.deepEqual(lane.latency_ms, {n: 2, median: 5000, p90: 6000, max: 6000});
  assert.equal(lane.cost_usd.value, null, 'no cost is stated: unknown, never estimated');
  assert.deepEqual(lane.sources.map(s => path.relative(DIR, s)), ['boards/board-a/run.json', 'work-stages.jsonl']);
  assert.deepEqual(M.capabilities['api/openai/gpt-6.1-sol'].outcomes, {reviewer: {'stakes:normal/depth:standard': counts({answered: 2})}});
  assert.deepEqual(M.capabilities['api/openai/gpt-6.1-sol'].tokens, {input: 1350, output: 190, n: 2, missing: 0});
  const scout = M.capabilities['api/xai/grok-4.3'];
  assert.deepEqual(scout.outcomes, {scout: {'difficulty:medium': counts({answered: 1, failed: 1})}});
  assert.deepEqual([scout.cost_usd.value, scout.cost_usd.n, scout.cost_usd.missing], [null, 1, 1], 'one attempt states a cost, one does not: unknown');
  const carbon = M.capabilities['api/agy_google/gemini-4-carbon'];
  assert.deepEqual([carbon.outcomes.implementer.unrecorded.refused, carbon.billing_refusals, carbon.provider_requests.value], [1, {METERED_GEMINI_DISABLED: 1}, 0]);
  assert.deepEqual(carbon.tokens, {input: null, output: null, n: 0, missing: 1}, 'no usage reported: unknown, never 0');
  assert.deepEqual(carbon.latency_ms, {n: 0, median: null, p90: null, max: null});
  const sdk = M.capabilities['agy-sdk/agy_google/gemini-3.6-flash'];
  assert.deepEqual([sdk.gemini_requests, sdk.billing_refusals], [{primary: 1}, {METERED_GEMINI_BUDGET_EXHAUSTED: 1}], 'the usage record and the relay\'s refusal');
  assert.deepEqual(M.capabilities['api/agy_google/gemini-4-hydrogen'].gemini_requests, {failover: 1});
  assert.deepEqual([M.capabilities['api/xai/grok-4.7'].attempts, M.capabilities['api/xai/grok-4.7'].provider_requests.value, M.capabilities['api/xai/grok-4.7'].outcomes],
    [1, 4, {reviewer: {'change-review': counts({answered: 1})}}], 'a review transcript');
  assert.deepEqual(M.capabilities['api/xai/grok-4.6'].outcomes, {implementer: {'difficulty:easy': counts({answered: 1})}}, 'a practice pair\'s run');
  assert.deepEqual(M.capabilities['api/xai/grok-4.6'].tokens.input, 400);
  assert.deepEqual(M.unmapped.map(u => u.why), ['the attempt records transport agy, which does not say whether the CLI or the SDK seat served it'], 'an ambiguous seat is listed, never guessed');
  const c = M.coverage;
  assert.deepEqual([c.runs, c.practice_runs, c.live_runs, c.synthetic_runs, c.stages, c.stages_unattributed, c.transcripts, c.gemini_rows, c.relay_outcomes, c.unreadable.length],
    [3, 1, 0, 3, 2, 1, 1, 2, 2, 0]);
  assert.equal(M.snapshot, SNAP.digest);
  assert.equal(M.capabilities['api/anthropic/claude-opus-5-5'].tokens.input, 1000);
});

test('KG-6: the accepted outcome of an agy work turn maps onto the capability its turn records (agy-cli); a turn recorded before, saying agy, stays readable and is listed unmapped', () => {
  const LANE = 'gemini-4-hydrogen-high';
  const shippedRun = transport => ({providers: {kind: 'synthetic'}, shipped: true, gates: [{gate: 'REVIEW', ok: true}], revisions: [{slots: [{}]}], attempts: [],
    turns: [{vendor: 'agy_google', model: LANE, purpose: 'work', transport, selection: null}]});
  const N = extractMetrics({runs: [{run: shippedRun('agy-cli'), source: 'new', practice: false}, {run: shippedRun('agy'), source: 'old', practice: false}],
    stages: [], transcripts: [], gemini: [], relay: [], unreadable: [], read: {}}, {snapshot: SNAP});
  assert.deepEqual(N.capabilities[`agy-cli/agy_google/${LANE}`]?.outcomes, {implementer: {unrecorded: counts({accepted: 1})}}, 'the new turn\'s accepted outcome is mapped');
  assert.deepEqual(N.unmapped.map(u => [u.source, u.seat.transport, u.role, u.why]),
    [['old', 'agy', 'implementer', 'the turn records transport agy, which does not say whether the CLI or the SDK seat served it']], 'the old turn is listed, never guessed');
});

test('no qualified-for without an owner-defined criterion; the metrics are observed assertions that a registered tool admits, never a qualification', t => {
  assert.equal(QUALIFICATION_CRITERION, null, 'the owner has defined no criterion');
  assert.deepEqual(M.qualification.emitted, []);
  assert.match(M.qualification.why, /no owner-defined qualification criterion exists: no qualified-for is emitted/);
  assert.deepEqual(qualificationsOf(M.capabilities, {criterion: {rule: 'accepted >= 1'}}).emitted, [], 'a criterion is the owner\'s to define, not a caller\'s');
  const records = observedAssertions(M, {observed_at: T0, synthetic: true});
  assert.equal(records.filter(r => r.type === 'qualified-for').length, 0);
  assert.equal(records.filter(r => r.kind === 'entity').length, Object.keys(M.capabilities).length);
  assert.ok(records.every(r => r.classification === 'observed' && r.run.id === M.digest && r.origin === 'pantheon.capability.metrics'));
  assert.ok(records.filter(r => r.kind === 'entity').every(r => r.attributes.evidence_type === 'measured' && r.attributes.synthetic === true && /SYNTHETIC/.test(r.uncertainty)));
  const w = capabilityWorld(t);
  w.observeAll();
  for (const r of records) assert.equal(recordRefusal(r, {origins: w.graph.projection.origins}), null, r.subject);
  assert.equal(w.graph.assert(records, w.by(KEYS.metrics)).appended, true, 'the metrics tool admits them, as observed');
  const view = w.graph.view();
  const m = view.edgesOf(E('capability', 'agy-cli/agy_google/gemini-4-hydrogen-high'), {types: ['measures']});
  assert.equal(m.length, 1, 'the capability is measured by its observation');
  assert.equal(view.node(m[0].from).attributes.attempts, 3);
  assert.deepEqual(view.edgesOf(E('role', 'implementer'), {types: ['qualified-for']}), []);
  // Only the registered tool's key writes as the tool: an extractor's key may not admit a measurement.
  const other = observedAssertions(M, {observed_at: T0, run: {id: 'another-run'}}).filter(r => r.kind === 'entity');
  assert.throws(() => w.graph.assert(other, w.by(KEYS.declared)), /may not write as origin "pantheon\.capability\.metrics"/);
});

test('cli: the report prints the metrics per capability with sources and coverage, labelled synthetic; it runs on an owner\'s PANTHEON_HOME', () => {
  let out = '';
  const write = s => { out += s; };
  assert.equal(run(['metrics', '--boards', SPEC.boards, '--practice', SPEC.practice, '--work-stages', SPEC.workStages, '--transcripts', SPEC.transcripts,
    '--gemini-usage', SPEC.geminiUsage, '--relay-outcomes', SPEC.relayOutcomes, '--synthetic'], {write, snapshot: SNAP}), 0);
  assert.match(out, /\[SYNTHETIC: computed from fixtures, not live operational evidence\]/);
  assert.match(out, /agy-cli\/agy_google\/gemini-4-hydrogen-high\n {4}attempts 3; provider requests 6 \(1 unknown, counted as one\)/);
  assert.match(out, /implementer @ stakes:normal\/depth:standard: answered 2, accepted 1, revised 1, identity-mismatch 1/);
  assert.match(out, /coverage: 3 run\(s\) \(0 live, 3 synthetic or undeclared; 1 from practice pairs\)/);
  assert.ok(out.includes(`sources: ${R('boards/board-a/run.json')}, ${R('work-stages.jsonl')}`), 'each capability names the records it was read from');
  assert.match(out, /qualified-for: none\. no owner-defined qualification criterion exists/);
  // The owner's records: every run.json under $PANTHEON_HOME/boards, read with no flag.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-home-'));
  try {
    fs.mkdirSync(path.join(home, 'boards', 'b1'), {recursive: true});
    fs.copyFileSync(R('boards/board-b/run.json'), path.join(home, 'boards', 'b1', 'run.json'));
    out = '';
    assert.equal(run(['metrics'], {write, env: {PANTHEON_HOME: home}, snapshot: SNAP}), 0);
    assert.match(out, /coverage: 1 run\(s\)/);
    assert.match(out, /api\/xai\/grok-4\.3\n {4}attempts 2/);
    assert.doesNotMatch(out, /SYNTHETIC/, 'not labelled synthetic unless it says so; the run itself declares what answered it');
    out = '';
    assert.equal(run(['snapshot'], {write, snapshot: SNAP}), 0);
    // The SDK seat's bubble as the code now provides it (Slice C2: its jail); an API seat's lifetime does not hold.
    assert.match(out, /agy-sdk\/agy_google\/gemini-3\.6-flash +available; bubble: sandbox holds, credentials holds, tools holds, lifetime holds\n/);
    assert.match(out, /api\/openai\/gpt-6-astra +available; bubble: sandbox not-applicable, credentials holds, tools holds, lifetime DOES NOT HOLD\n/);
  } finally { fs.rmSync(home, {recursive: true, force: true}); }
});
