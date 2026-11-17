// Corrections after the review of b9fa745 (model-level review independence, pantheon.cycle/v3). Each test fails on
// that commit:
//   1. the identity policy is PINNED on each v3 cycle: a later alias-rule change does not change a recorded ledger's
//      validity (replayed in a fresh process over changed configuration); the correction is new evidence;
//   2. a reviewer whose identity is unresolved does not qualify (its response is kept);
//   3. identity and lab come from the MODEL, across routes, aliases and snapshots, never from the transport.
// Reviewer turns are scripted: this is identity and enforcement, not an evaluation of any model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openPantheonLedger} from '../src/ledger/system.mjs';
import {reviewCycle, reviewSeatsByModel} from '../src/ledger/review-cycle.mjs';
import {resolveModel, reviewerIdentity, reviewerRefusal, contributorKeys, currentPolicy, policyDigest, reassess} from '../src/review/identity.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const C = n => String(n).repeat(40).slice(0, 40);
const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n';
const APPROVE = '```json\n{"verdict": "approve", "findings": []}\n```';
let n = 0;
/** A scripted reviewer turn; `served(vendor, model)` names the model that "answered". */
const turnWith = (served = (_v, m) => m) => async ({vendor, model}) => ({text: APPROVE, response_id: `ip_${vendor}_${++n}`, served_model: served(vendor, model)});
const assess = (rec, cycle) => rec.recordDisposition({cycle, outcome: 'insufficient_evidence', question: 'fixture', provenance: {by: {role: 'lead@orch'}, method: 'fixture'}});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-identity-'));
const change = (scope, contributions) => ({scope, base: C('a'), head: C('b'), diff: DIFF, files: ['x'], independence: 'model', contributions});
const PLAN_OPUS = {purpose: 'plan', vendor: 'anthropic', model: 'claude-opus-4-6'};
const SEATS = third => [{vendor: 'xai', model: 'grok-4.7'}, {vendor: 'openai', model: 'gpt-6-sol'}, third];
const payloadOf = (sys, h) => sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === h));

test('3. the resolver: one model has one identity and one lab through every route, alias and snapshot; the lab is never taken from the transport', () => {
  const id = (v, m) => resolveModel(v, m).id;
  // The reviewed defect: a dated snapshot of an Anthropic model, answered through the Google route.
  assert.equal(id('agy_google', 'claude-opus-4-6-20261117'), 'anthropic/claude-opus-4-6');
  assert.equal(id('agy_google', 'claude-opus-4-6-20261117'), id('anthropic', 'claude-opus-4-6-20261117'));
  assert.equal(id('agy_google', 'claude-opus-4-6-thinking'), id('anthropic', 'claude-opus-4-6'), 'a lane (effort) name and the API name');
  assert.equal(id('agy_google', 'gemini-3.8-flash-high'), id('google', 'gemini-3.8-flash-20261001'), 'an effort variant and a snapshot');
  assert.equal(resolveModel('agy_google', 'claude-sonnet-5').lab, 'anthropic', 'the route is not the lab');
  // Unresolved: no identity, no lab. Not "google because it came through the Google route".
  const lost = resolveModel('agy_google', 'mystery-model-9');
  assert.deepEqual([lost.known, lost.id, lost.lab], [false, null, null]);
  assert.match(lost.why, /not inferred from the agy_google route/);
  // A direct vendor serves only its own lab's models: anything else is unresolved, not relabelled.
  assert.equal(resolveModel('openai', 'claude-sonnet-5').known, false);
  assert.equal(resolveModel('nobody', 'grok-4.7').known, false);
  // Consumers: a contributor through the route excludes the same model through any other name, in the selector too.
  const routed = [{purpose: 'plan', vendor: 'agy_google', model: 'claude-opus-4-6-20261117'}];
  assert.deepEqual(contributorKeys(routed).models, ['anthropic/claude-opus-4-6']);
  assert.deepEqual(contributorKeys(routed).contributing_labs, ['anthropic']);
  const seats = reviewSeatsByModel({n: 4, contributions: routed});
  assert.ok(!seats.some(s => s.identity === 'anthropic/claude-opus-4-6'));
  assert.equal(seats.find(s => s.lab === 'anthropic').shared_lab, true, 'and the lab it shares is Anthropic, not Google');
  assert.equal(seats.find(s => s.lab === 'google').shared_lab, false);
});

test('3. the ledger: a contributor answering through another route under a snapshot name is refused; the cycle does not close and does not count three labs', async () => {
  const dir = tmp();
  try {
    const sys = openPantheonLedger({root: path.join(dir, 'ledger')}), rec = sys.recorder();
    // Asked: the Google seat. Answered: claude-opus-4-6-20261117, the model that wrote the plan.
    const r = await reviewCycle({ledger: rec, change: change('routed', [PLAN_OPUS]), seats: SEATS({vendor: 'agy_google', model: 'gemini-3.6-flash'}),
      turn: turnWith((v, m) => (v === 'agy_google' ? 'claude-opus-4-6-20261117' : m))});
    assert.equal(r.failed.length, 1, 'that review is not recorded');
    assert.match(r.failed[0].why, /google\/gemini-3\.6-flash was asked and anthropic\/claude-opus-4-6 answered|anthropic\/claude-opus-4-6 contributed/);
    assess(rec, r.cycle);
    assert.throws(() => rec.closeCycle(r.cycle), /2 of 3 reviews are recorded/);
    // The answer itself is kept on the ledger, with the model that served it.
    const turns = sys.ledger.read().filter(e => e.kind === 'turn').map(e => sys.ledger.payloadOf(e));
    assert.ok(turns.some(t => t.served_model === 'claude-opus-4-6-20261117' && t.requested_model === 'gemini-3.6-flash'));
    assert.equal(sys.ledger.verify().ok, true);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('2. an unresolved reviewer does not qualify: the response is preserved and the gap recorded, and it is not an approval', async () => {
  // The resolver boundary: asked-for or answering model unknown, or of two labs.
  assert.equal(reviewerIdentity({vendor: 'xai', model: 'grok-4.7', served_model: 'grok-9-unreleased'}).code, 'UNRESOLVED');
  assert.equal(reviewerIdentity({vendor: 'xai', model: 'grok-next'}).code, 'UNRESOLVED');
  assert.equal(reviewerIdentity({vendor: 'agy_google', model: 'gemini-3.6-flash', served_model: 'claude-sonnet-5'}).code, 'LAB_MISMATCH');
  assert.match(reviewerRefusal({vendor: 'xai', model: 'grok-4.7', served_model: 'grok-9-unreleased'}, {models: [], labs: []}), /the model that answered is unresolved/);
  assert.deepEqual(reviewerIdentity({vendor: 'xai', model: 'grok-4.7', served_model: 'grok-4.7-20261101'}), {lab: 'xai', ids: ['xai/grok-4.7']});
  const dir = tmp();
  try {
    const sys = openPantheonLedger({root: path.join(dir, 'ledger')}), rec = sys.recorder();
    const r = await reviewCycle({ledger: rec, change: change('unknown', [PLAN_OPUS]), seats: SEATS({vendor: 'agy_google', model: 'gemini-3.6-flash'}),
      turn: turnWith((v, m) => (v === 'xai' ? 'grok-9-unreleased' : m))});
    assert.deepEqual(r.reviews.map(x => x.lab).sort(), ['google', 'openai']);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0].why, /the model that answered is unresolved: "grok-9-unreleased" is not a model this identity policy declares/);
    const state = rec.cycleState(r.cycle);
    assert.equal(state.reviews.length, 2, 'it is not counted as a review');
    assert.ok(state.attempts.some(a => a.outcome === 'failed' && /unresolved/.test(a.why)), 'the gap is recorded as a failed attempt, with the reason');
    assert.ok(sys.ledger.read().some(e => e.kind === 'turn' && sys.ledger.payloadOf(e).served_model === 'grok-9-unreleased'), 'the response is preserved');
    assess(rec, r.cycle);
    assert.throws(() => rec.closeCycle(r.cycle), /2 of 3 reviews are recorded/);
    // A contributor that cannot be resolved: nothing can be shown about who may review, so no cycle opens.
    await assert.rejects(reviewCycle({ledger: rec, change: change('lost', [{purpose: 'work', vendor: 'agy_google', model: 'mystery-model-9'}]), turn: turnWith()}), e => e.code === 'UNRESOLVED_CONTRIBUTOR');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('1. the policy is pinned: a v3 cycle carries its rules, and a fresh process over CHANGED alias rules verifies the old ledger as before; the correction is reported as new evidence', async () => {
  const dir = tmp();
  try {
    const root = path.join(dir, 'ledger');
    const sys = openPantheonLedger({root}), rec = sys.recorder();
    const fable = {purpose: 'plan', vendor: 'anthropic', model: 'claude-fable-5-2'};
    const r = await reviewCycle({ledger: rec, change: change('pinned', [fable]), seats: [{vendor: 'xai', model: 'grok-4.7'}, {vendor: 'openai', model: 'gpt-6-sol'}, {vendor: 'anthropic', model: 'claude-sonnet-5'}], turn: turnWith()});
    assess(rec, r.cycle);
    assert.equal(rec.closeCycle(r.cycle).outcome, 'verified');
    const c = payloadOf(sys, r.cycle);
    // Retrievable and immutable: the whole policy is on the cycle, and its digest is of exactly those rules.
    assert.equal(c.identity_policy.digest, policyDigest(c.identity_policy.rules));
    assert.equal(c.identity_policy.digest, policyDigest(currentPolicy()));
    for (const k of ['same_model', 'model_lab', 'vendor_lab', 'routes', 'resolver']) assert.ok(k in c.identity_policy.rules, `the policy carries ${k}`);
    assert.deepEqual(c.contributors, [{vendor: 'anthropic', model: 'claude-fable-5-2'}], 'and the raw names it was opened with');
    const anchor = sys.anchor;

    // A copy of the code with CHANGED rules: claude-sonnet-5 is now declared to be claude-fable-5-2 (an alias correction),
    // and a lab mapping is changed too. A fresh process, with nothing cached, replays the recorded ledger.
    const copy = path.join(dir, 'code');
    fs.mkdirSync(path.join(copy, 'pantheon'), {recursive: true});
    fs.cpSync(path.join(REPO, 'pantheon', 'src'), path.join(copy, 'pantheon', 'src'), {recursive: true});
    fs.cpSync(path.join(REPO, 'packages'), path.join(copy, 'packages'), {recursive: true, filter: s => !s.includes(`${path.sep}node_modules`)});
    for (const nm of ['node_modules', path.join('pantheon', 'node_modules')]) if (fs.existsSync(path.join(REPO, nm))) fs.symlinkSync(path.join(REPO, nm), path.join(copy, nm));
    const rulesFile = path.join(copy, 'pantheon', 'src', 'config', 'model-identity.json');
    const rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
    rules.same_model['claude-sonnet-5'] = {model: 'claude-fable-5-2', basis: 'fixture: a later alias correction'};
    fs.writeFileSync(rulesFile, JSON.stringify(rules));
    const script = `
      const {openPantheonLedger} = await import(${JSON.stringify(path.join(copy, 'pantheon/src/ledger/system.mjs'))});
      const id = await import(${JSON.stringify(path.join(copy, 'pantheon/src/review/identity.mjs'))});
      const sys = openPantheonLedger({root: ${JSON.stringify(root)}, anchor: ${JSON.stringify(anchor)}});
      const v = sys.ledger.verify();
      const state = sys.recorder().cycleState(${JSON.stringify(r.cycle)});
      const now = id.resolveModel('anthropic', 'claude-sonnet-5').id;
      const again = id.reassess ? id.reassess({cycle: state.cycle, reviews: state.reviews}) : null;
      console.log(JSON.stringify({ok: v.ok, why: v.why ?? null, now, labs: state.reviews.map(x => x.lab).sort(), again}));`;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', env: {...process.env, OPHANIM_LEDGER_ANCHOR: ''}}).trim().split('\n').at(-1));
    assert.equal(out.now, 'anthropic/claude-fable-5-2', 'the changed rules are in force in that process');
    assert.equal(out.ok, true, `the recorded ledger verifies under the policy it recorded (${out.why})`);
    assert.deepEqual(out.labs, ['anthropic', 'openai', 'xai'], 'and its reviews count for the labs they counted for');
    // The correction is NEW EVIDENCE about the old cycle: reported, with the review it concerns; nothing is rewritten.
    assert.equal(out.again.changed, true);
    assert.equal(out.again.recorded, c.identity_policy.digest);
    assert.equal(out.again.findings.length, 1);
    assert.match(out.again.findings[0].why, /anthropic\/claude-fable-5-2 contributed/);
    // Under the recorded policy itself there is nothing to report.
    assert.deepEqual(reassess({cycle: c, reviews: rec.cycleState(r.cycle).reviews}).findings, []);
    assert.equal(sys.ledger.verify().ok, true);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
