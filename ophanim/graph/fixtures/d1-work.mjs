// FIXTURES for Slice D part 1 (docs/knowledge-graph/slice-d1.md): a work ledger written through its OWN writer
// (ophanim/operate/work-ledger.mjs openWorkLedger: intake, claim, spend, billing, stage, release, reassessment) in a
// temporary directory with SYNTHETIC keys generated for the fixture, and a review-cycle ledger written through Pantheon's
// own recorder. This container holds 0 work-ledger entries (docs/knowledge-graph/inventory.md (a)), so every record here
// is SYNTHETIC and labelled so wherever a test uses it. No provider is called; the review turns are scripted.
//
// The work: the directive's own example of Graph E. Three independent items each require a shared model/runtime
// capability contract that no source implements (the missing prerequisite), two also require the Antigravity SDK runtime
// (which the real capability graph provides), and one an existing module; a fourth item shares nothing. Two items run
// the whole lifecycle (plan -> implement -> review -> validate -> outcome), so each has a completion claim.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openWorkLedger, outputsDigest} from '../../operate/work-ledger.mjs';
import {digest} from '../../../packages/ledger/canonical.mjs';
import {openPantheonLedger} from '../../../pantheon/src/ledger/system.mjs';
import {reviewCycle} from '../../../pantheon/src/ledger/review-cycle.mjs';

export const T = minutes => new Date(Date.parse('2026-11-20T10:00:00.000Z') + minutes * 60_000).toISOString();
const H = x => 'sha256:' + digest(x);
const C = c => String(c).repeat(40).slice(0, 40);
/** The prerequisites the plans name (graph ids). */
export const SHARED_CONTRACT = 'ophanim/systems/component/model-runtime-capability-contract';
export const SDK_RUNTIME = 'ophanim/capability/runtime/antigravity-sdk';
export const SCHEDULER = 'ophanim/systems/module/ophanim/operate/scheduler.mjs';
export const ITEMS = Object.freeze(['sdk-transport', 'team-construction', 'resource-accounting', 'unrelated-docs', 'graph-lessons']);

/**
 * A work ledger at `<dir>/work`. `files` names the evidence each item's plan cites ({transport, team, accounting, docs,
 * validated}); `keep` keeps the controller's keys (a writer process needs them; a reader never does). Returns {root,
 * anchor, records: {<item>: {plan, implement, review, validate, outcome, claims}}, candidate, files}.
 */
export function d1WorkLedger({dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-d1-work-')), files = {}, keep = false} = {}) {
  const f = {transport: 'lib/transport.mjs', team: 'lib/team.mjs', accounting: 'lib/accounting.mjs', docs: 'lib/docs.mjs', validated: 'lib/transport.mjs', ...files};
  const root = path.join(dir, 'work'), w = openWorkLedger({root});
  const budget = {provider_calls: 5, iterations: 2, elapsed_ms: 600_000, retries: 1};
  let t = 0;
  const at = () => T(t++);
  const records = {};
  const identity = item => ({item, requirement: H({requirement: item}), ticket: {path: `tickets/${item}.json`, digest: H({ticket: item})}});
  const NEXT = {plan: 'implement', implement: 'review', review: 'validate', validate: 'outcome', outcome: null};
  const stage = (item, name, {from = null, outputs, charge = null}) => {
    const up = from ? records[item][from] : null;
    const inputs = {upstream: up ? outputsDigest(up.outputs) : null, stage: name};
    const claim = w.claim({item, stage: name, attempt: 1, inputs, holder: 'fixture-controller', budget, at: at()});
    if (charge) charge(claim);
    const hash = w.recordStage({claim, from: up?.hash ?? null, stage: name, attempt: 1, status: 'passed', identity: identity(item), inputs, outputs,
      team: [{role: name === 'plan' ? 'planner' : name}], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: NEXT[name], why: `fixture: the ${name} passed`}, at: at()});
    w.release({claim, item, stage: name, outcome: 'completed', why: 'recorded', at: at()});
    (records[item] ??= {claims: []}).claims.push(claim);
    records[item][name] = {hash, outputs};
    return hash;
  };
  const planOf = (item, {requires = [], capabilities = [], evidence = [], slices = [], units = null, dependencies = []}) => ({
    problem: {statement: `SYNTHETIC: the ${item} objective, a fixture of the directive's Graph E example`, justification: 'a synthetic fixture for the work graph; no real requirement'},
    scope: [item], exclusions: ['everything else'], dependencies, capabilities, requires, acceptance: [{id: 'a1', criterion: 'the synthetic criterion holds', test: {cmd: 'true'}}],
    slices: slices.length ? slices : [{id: 's1', title: item, slot: 'main', path: `lib/${item}.mjs`}], copy: [], proposes: {state: 'Resolved', basis: 'synthetic'},
    limits: {provider_calls: 5, revisions: 1, elapsed_ms: 600_000}, stopping: ['fixture'], recovery: 'rerun the fixture', rollback: 'delete the fixture',
    unresolved: [], evidence: evidence.map(p => ({ref: `file:${p}`, why: 'cited'})), context: {sufficient: true, gaps: [], uncertainty: []},
    ...(units ? {work_units: units} : {})});
  const plan = (item, spec) => stage(item, 'plan', {outputs: {plan: planOf(item, spec), plan_digest: H(planOf(item, spec)), ticket: identity(item).ticket, deps: {},
    evidence: (spec.evidence ?? []).map(p => ({path: p, sha256: H({file: p})}))}});
  const chain = (item, {files: changed, validated}) => {
    stage(item, 'implement', {from: 'plan', outputs: {commit: C('c'), branch: `fixture/${item}`, files: changed}, charge: claim => {
      w.recordSpend({claim, provider_calls: 2, at: at()});
      w.recordBilling({claim, kind: 'failover', setting: 'metered_gemini_failover', vendor: 'agy_google', model: 'fixture-model', source: 'fixture', budget: 3, policy: H({policy: 'fixture'}), at: at()});
    }});
    stage(item, 'review', {from: 'implement', outputs: {cycle: H({cycle: item}), close: H({close: item}), outcome: 'verified', labs: ['lab-a', 'lab-b', 'lab-c']}});
    stage(item, 'validate', {from: 'review', outputs: {verdict: 'accept', reasons: [], criteria: [{id: 'a1', met: true}],
      sources: [{source: `file:${validated}`, version: H({file: validated}), delivered: true}]}});
    stage(item, 'outcome', {from: 'validate', outputs: {to: 'Resolved', proposal_digest: H({proposal: item}), item, commit: C('c'), signed: false}});
  };
  for (const item of ITEMS) w.intake({source: 'status', ref: item, item, classification: 'item', why: 'SYNTHETIC: a fixture item', at: at()});
  const candidate = w.intake({source: 'issue', ref: 'fixture/issues#7', item: null, classification: 'candidate', why: 'SYNTHETIC: an unmarked issue, recorded, never executed', at: at()});
  plan('sdk-transport', {requires: [SDK_RUNTIME, {id: SHARED_CONTRACT, why: 'the transport is routed through the shared capability contract'}], evidence: [f.transport]});
  chain('sdk-transport', {files: [f.transport], validated: f.validated});
  plan('team-construction', {requires: [{id: SHARED_CONTRACT, why: 'teams are assembled from the capability contract'}], capabilities: [SDK_RUNTIME, 'dynamic team construction'],
    evidence: [f.team], units: [
      {unit_id: 'u1', depends_on: [], owned_paths: [f.team], difficulty: 'easy', specialist_role: 'node-engineer', allowed_subagents: [], verify_cmd: 'true', invariants: ['synthetic']},
      {unit_id: 'u2', depends_on: ['u1'], owned_paths: ['lib/team-roles.mjs'], difficulty: 'easy', specialist_role: 'node-engineer', allowed_subagents: [], verify_cmd: 'true', invariants: ['synthetic']}]});
  plan('resource-accounting', {requires: [SHARED_CONTRACT, SCHEDULER], capabilities: ['accurate resource accounting'], evidence: [f.accounting], dependencies: ['sdk-transport']});
  plan('unrelated-docs', {evidence: [f.docs]});
  chain('unrelated-docs', {files: [f.docs], validated: f.docs});
  plan('graph-lessons', {evidence: [f.docs], slices: [{id: 's1', title: 'lessons', slot: 'main', path: 'lib/not-the-lessons-module.mjs'}]});
  w.recordReassessment({item: 'sdk-transport', cycle: H({cycle: 'sdk-transport'}), recorded_policy: H({policy: 1}), policy: H({policy: 2}), findings: [{review: null, why: 'a later alias rule'}], at: at()});
  if (!keep) fs.rmSync(path.join(root, 'keys'), {recursive: true, force: true});          // a reader holds no key
  return {dir, root, anchor: w.anchor, records, candidate, files: f, writer: keep ? w : null};
}

/** Append one more synthetic plan through the writer (the keys must be kept): a later entry, a new version of the ledger. */
export function appendPlan(w, {item, requires = [], evidence = [], units = null, at = T(500)}) {
  const budget = {provider_calls: 1, iterations: 1, elapsed_ms: 60_000, retries: 0};
  const identity = {item, requirement: H({requirement: item})};
  const claim = w.claim({item, stage: 'plan', attempt: 1, inputs: {late: item}, holder: 'fixture-controller', budget, at});
  const doc = {problem: {statement: `SYNTHETIC: ${item}`}, dependencies: [], capabilities: [], requires, slices: [], acceptance: [], ...(units ? {work_units: units} : {})};
  const hash = w.recordStage({claim, stage: 'plan', attempt: 1, status: 'passed', identity, inputs: {late: item}, outputs: {plan: doc, evidence: evidence.map(p => ({path: p, sha256: H({file: p})}))},
    team: [{role: 'planner'}], contributions: [], findings: [], usage: {provider_calls: 0}, next: {stage: 'implement', why: 'fixture'}, at: new Date(Date.parse(at) + 60_000).toISOString()});
  w.release({claim, item, stage: 'plan', outcome: 'completed', why: 'recorded', at: new Date(Date.parse(at) + 120_000).toISOString()});
  return hash;
}

const reply = (verdict, findings = []) => '```json\n' + JSON.stringify({verdict, findings}) + '\n```';
/**
 * A review-cycle ledger with one cycle and two findings on `file`: one FIXED (a commit, and a test shown failing before
 * and passing after), one deferred; the keys removed for the reader. SYNTHETIC: scripted turns, no provider.
 */
export async function d1CycleLedger({dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-d1-cycle-')), file = 'lib/transport.mjs', test = 'tests/transport.test.mjs'} = {}) {
  const root = path.join(dir, 'cycles');
  const sys = openPantheonLedger({root}), rec = sys.recorder();
  const diff = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 2;\n`;
  const author = rec.recordTurn({seat: {seat_id: 'fixture-work@author', vendor: 'anthropic', mode: 'work', occupancy_gen: 1},
    requested_model: 'fixture-author-model', served_model: 'fixture-author-model', response_id: 'resp_author', reply: 'the change'});
  let n = 0;
  const turn = async ({vendor, model}) => ({response_id: `resp_${vendor}_${++n}`, served_model: model, text: vendor === 'xai'
    ? reply('request_changes', [{severity: 'major', file, line: 1, claim: 'the transport drops the served model identity on a handoff', reproduction: {kind: 'test', run: test}}])
    : vendor === 'openai' ? reply('request_changes', [{severity: 'minor', file, line: 1, claim: 'a log line is unclear', reproduction: null}]) : reply('approve')});
  const r = await reviewCycle({ledger: rec, change: {scope: 'ophanim', base: C('a'), head: C('b'), diff, files: [file], author_labs: ['anthropic'], author_turns: [author]}, turn});
  const fixed = r.reviews.find(x => x.lab === 'xai').findings[0], deferred = r.reviews.find(x => x.lab === 'openai').findings[0];
  rec.fixFinding({finding: fixed.hash, commit: C('d'), test, before: {commit: C('b'), exit: 1}, after: {commit: C('d'), exit: 0}});
  rec.deferFinding({finding: deferred.hash, reason: 'fixture: scheduled for the next cycle'});
  fs.rmSync(path.join(root, 'keys'), {recursive: true, force: true});
  return {dir, root, anchor: fs.readFileSync(path.join(root, 'ANCHOR'), 'utf8').trim(), cycle: r.cycle, fixed: fixed.hash, deferred: deferred.hash, file, test};
}
