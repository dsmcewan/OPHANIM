// Independent review round 2, assignment 2 (xAI grok-4.7, 77480d6): regression tests for questions 6 and 7 in the
// lifecycle's projection of a pipeline run. Synthetic names and temporary ledgers only; no provider is called.
//   Q6  the implement stage's projection keeps a turn asked as one model and served by another apart from a turn of
//       the served model, so the asked identity stays excluded from the later panel and the validator;
//   Q7  DECISION 6 (owner, 2026-11-19): the dispatcher exception is confined to the pinned Stage 5 review of its own
//       unit. Its requested and serving identities are excluded from the later three-lab review and the validator,
//       even when its Stage 5 review only approved; a different model of its lab stays eligible; when no eligible
//       capacity is left nothing falls back to it. The end-to-end lifecycle (the pinned Stage 5 review succeeds, the
//       dispatcher is on neither the panel nor the validator, the three-lab panel qualifies) is fit-lifecycle.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {dedupe, arbiterExclusions} from './stages.mjs';
import {contributionsOf, arbitersOf} from '../../pantheon/src/pipeline/record.mjs';
import {contributorKeys, candidateRefusal, reviewerRefusal} from '../../pantheon/src/review/identity.mjs';
import {reviewSeatsByModel, reviewCycle} from '../../pantheon/src/ledger/review-cycle.mjs';
import {openPantheonLedger} from '../../pantheon/src/ledger/system.mjs';
import {labOf} from '../../pantheon/src/config/models.mjs';

// The implement stage's projection of contributionsOf (stages.mjs implementUnits), row for row.
const project = run => contributionsOf(run).filter(c => c.kind !== 'plan').map(c => {
  const model = c.served_model ?? c.model;
  return {purpose: c.kind, vendor: c.vendor, model, ...(c.served_model && c.model && c.served_model !== c.model ? {requested_model: c.model} : {}), lab: labOf(c.vendor, model)};
});
const PLAN = {purpose: 'plan', vendor: 'anthropic', model: 'claude-fable-5-2', lab: 'anthropic'};

test('Q6 (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 6): a distinct requested model survives the projection', () => {
  const run = {planner: {vendor: 'anthropic', model: 'claude-sonnet-5', served_model: 'claude-sonnet-5'}, units: {u: {unit_id: 'u',
    attempts: [{status: 'written', vendor: 'agy_google', model: 'gemini-4-hydrogen-medium', served_model: 'gemini-4-hydrogen-medium'}],
    a2a: {calls: [{status: 'answered', role: 'helper', vendor: 'xai', model: 'grok-4.6', served_model: 'grok-4.7'},
      {status: 'answered', role: 'helper', vendor: 'xai', model: 'grok-4.7', served_model: 'grok-4.7'}]}, reviews: []}}};
  const rows = dedupe([PLAN, ...project(run)]);
  const keys = contributorKeys(rows);
  assert.deepEqual(keys.models.filter(m => m.startsWith('xai/')), ['xai/grok-4.6', 'xai/grok-4.7']);
  assert.match(candidateRefusal({vendor: 'xai', model: 'grok-4.6'}, keys), /grok-4\.6 contributed/);
  assert.match(reviewerRefusal({vendor: 'xai', model: 'grok-4.6', served_model: 'grok-4.6-20261118'}, keys), /grok-4\.6 contributed/);
  // Order does not matter: the later row does not overwrite the earlier one.
  assert.deepEqual(contributorKeys(dedupe([PLAN, ...project(run).reverse()])).models, keys.models);
});

// A fit run: Anthropic planner, Google implementer, xAI subagent, and the OpenAI dispatcher, which is ALSO the pinned
// Stage 5 reviewer of its unit and only approved.
const fitRun = (dispatch = {vendor: 'openai', model: 'gpt-6-astra', served_model: 'gpt-6-astra'}) => ({
  planner: {vendor: 'anthropic', model: 'claude-fable-5-2', served_model: 'claude-fable-5-2'},
  units: {u: {unit_id: 'u', dispatch: {...dispatch, rubric_hash: 'sha256:' + 'ab'.repeat(32)},
    attempts: [{status: 'written', vendor: 'agy_google', model: 'gemini-4-carbon-high', served_model: 'gemini-4-carbon-high'}],
    a2a: {calls: [{status: 'answered', role: 'helper', vendor: 'xai', model: 'grok-4.7', served_model: 'grok-4.7'}]},
    reviews: [{status: 'approved', fed_revision: false, pinned_to_dispatcher: true, vendor: dispatch.vendor, model: dispatch.model, served_model: dispatch.served_model}]}},
});
const stageRows = run => dedupe([PLAN, ...project(run), ...arbiterExclusions(arbitersOf(run))]);

test('Q7 (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 7; Decision 6): the dispatcher is not an author, and is excluded from later judgment even when Stage 5 only approved', () => {
  const run = fitRun();
  // Not reclassified: the dispatcher authored nothing.
  assert.equal(contributionsOf(run).some(c => c.model === 'gpt-6-astra'), false);
  assert.deepEqual(arbitersOf(run).map(a => [a.role, a.authored, a.model]), [['dispatcher', false, 'gpt-6-astra']]);
  const rows = stageRows(run);
  assert.deepEqual(rows.filter(r => r.purpose === 'arbiter').map(r => [r.vendor, r.model]), [['openai', 'gpt-6-astra']]);
  const keys = contributorKeys(rows);
  assert.ok(keys.models.includes('openai/gpt-6-astra'));
  // SELECTION: the dispatcher's model is not asked, under any name the identity policy treats as it.
  assert.match(candidateRefusal({vendor: 'openai', model: 'gpt-6-astra'}, keys), /gpt-6-astra contributed/);
  assert.equal(reviewSeatsByModel({n: 3, contributions: rows}).some(s => s.model === 'gpt-6-astra'), false);
  assert.equal(reviewSeatsByModel({n: 1, contributions: rows, seating: {reviewer: [{vendor: 'openai', model: 'gpt-6-astra', why: 'probe'}, {vendor: 'xai', model: 'grok-4.6', why: 'probe'}]}})[0].model, 'grok-4.6');
  // ADMISSION: an eligible seat whose answer the dispatcher's model served is not a review.
  assert.match(reviewerRefusal({vendor: 'openai', model: 'gpt-6-sol', served_model: 'gpt-6-astra-20261118'}, keys), /gpt-6-astra contributed/);
  // A different model of the same lab is still eligible, at selection and at admission.
  assert.equal(candidateRefusal({vendor: 'openai', model: 'gpt-6-sol'}, keys), null);
  assert.equal(reviewerRefusal({vendor: 'openai', model: 'gpt-6-sol', served_model: 'gpt-6-sol'}, keys), null);
  const probe = {reviewer: [{vendor: 'openai', model: 'gpt-6-astra', why: 'probe'}, {vendor: 'openai', model: 'gpt-6-sol', why: 'probe'}, {vendor: 'xai', model: 'grok-4.6', why: 'probe'}, {vendor: 'anthropic', model: 'claude-sonnet-5', why: 'probe'}]};
  const panel = reviewSeatsByModel({n: 3, contributions: rows, seating: probe});
  assert.equal(new Set(panel.map(s => s.lab)).size, 3, 'an independent three-lab panel still qualifies');
  assert.ok(panel.some(s => s.model === 'gpt-6-sol') && !panel.some(s => s.model === 'gpt-6-astra'), JSON.stringify(panel));
});

test('Q7 (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 7; Decision 6): the requested and the serving identity are both excluded; a resumed unit keeps its arbiter', () => {
  const rows = stageRows(fitRun({vendor: 'openai', model: 'gpt-6-astra', served_model: 'gpt-6-luna'}));
  const keys = contributorKeys(rows);
  assert.ok(keys.models.includes('openai/gpt-6-astra') && keys.models.includes('openai/gpt-6-luna'), JSON.stringify(keys.models));
  // A unit resumed from its sealed checkpoint made no dispatcher call in this run: the checkpoint's dispatch is its arbiter.
  const resumed = {planner: {vendor: 'anthropic', model: 'claude-fable-5-2', served_model: 'claude-fable-5-2'}, units: {u: {unit_id: 'u', resumed: true, attempts: [], a2a: {calls: []}, reviews: [],
    checkpoint: {contributions: [{kind: 'work', role: 'implementer', vendor: 'agy_google', model: 'gemini-4-carbon-high', served_model: 'gemini-4-carbon-high'}],
      dispatch: {vendor: 'openai', model: 'gpt-6.1-sol', served_model: 'gpt-6.1-sol', rubric_hash: 'sha256:' + 'cd'.repeat(32)}}}}};
  assert.deepEqual(arbitersOf(resumed).map(a => [a.model, a.from_checkpoint]), [['gpt-6.1-sol', true]]);
  assert.match(candidateRefusal({vendor: 'openai', model: 'gpt-6.1-sol'}, contributorKeys(stageRows(resumed))), /gpt-6\.1-sol contributed/);
});

test('Q7 (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 7; Decision 6): no capacity is no review, never a fallback to the dispatcher', () => {
  const rows = stageRows(fitRun());
  const every = ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'grok-4.6', 'gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.6-flash', 'gemini-3.8-flash', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001']
    .map(model => ({purpose: 'work', vendor: model.startsWith('gpt') ? 'openai' : model.startsWith('grok') ? 'xai' : model.startsWith('gemini') ? 'agy_google' : 'anthropic', model}));
  assert.throws(() => reviewSeatsByModel({n: 1, contributions: [...rows, ...every]}), e => e.code === 'NO_SEATS');
});

test('Q7 (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 7; Decision 6): a cycle opened with the arbiter rows records them and refuses an answer the dispatcher served', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2a2-arbiter-'));
  try {
    const sys = openPantheonLedger({root: path.join(dir, 'ledger')}), rec = sys.recorder();
    const C = c => String(c).repeat(40).slice(0, 40), DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n';
    const APPROVE = '```json\n{"verdict": "approve", "findings": []}\n```';
    let k = 0;
    const r = await reviewCycle({ledger: rec, change: {scope: 'arbiter', base: C('a'), head: C('b'), diff: DIFF, files: ['x'], independence: 'model', contributions: stageRows(fitRun())},
      seats: [{vendor: 'openai', model: 'gpt-6-sol'}, {vendor: 'xai', model: 'grok-4.6'}, {vendor: 'anthropic', model: 'claude-sonnet-5'}],
      turn: async ({vendor, model}) => ({text: APPROVE, response_id: `arb_${++k}`, served_model: vendor === 'openai' ? 'gpt-6-astra' : model})});
    const cycle = sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === r.cycle));
    assert.ok(cycle.author_models.includes('openai/gpt-6-astra'), 'the cycle records the dispatcher among the excluded models');
    assert.equal(r.reviews.length, 2);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0].why, /gpt-6-astra contributed/);
    assert.equal(sys.ledger.verify().ok, true);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
