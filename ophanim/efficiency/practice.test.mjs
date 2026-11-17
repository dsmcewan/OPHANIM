// Audit C3: the cycle's practice assessment comes from the existing chair investigation ranking, and the
// cycle closes with it on the ledger; a later dispatch loads only what a closed cycle admitted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {practiceAssessment, PRACTICE_OUTCOME_OF} from './practice.mjs';
import {rankChairQuestions} from './investigation/chairs.mjs';
import {digest} from '../board.mjs';
import {openSystemLedger} from '../ledger/system.mjs';
import {reviewCycle} from '../../pantheon/src/ledger/review-cycle.mjs';
import {loadPractice} from '../../pantheon/src/ledger/practice-kinds.mjs';

const hex = c => c.repeat(64);
function projection({implRework = 2, checkRework = 1} = {}) {
  const row = (chair, metrics) => ({chair, occupants: [{vendor: 'openai', model: 'gpt-6-sol', entries: 2}], metrics: {entries: 2, reseats: 0, ...metrics}});
  return {schema: 'pantheon.chair-contributions/v1', boardSha: hex('b'), projectionSha: hex('a'),
    limits: {ranksModels: false, authorizesSeatChange: false, basis: 'derived'},
    chairs: [row('lead@orch', {plans: 1, rework: 0}), row('impl@build', {rework: implRework}), row('check@review', {rework: checkRework}), row('scout@opt', {forks: 1}), row('arbiter@judge', {syntheses: 0})]};
}
const economics = {expectedConvergences: 10, applicability: 0.8, confidence: 0.7, decisionChangeProbability: 0.5,
  avoidableLossMsPerConvergence: 60000, expectedCandidateGainMsPerConvergence: null, rolloutMs: 1000, regressionMs: 1000, opportunityCostMs: 1000, sourceSha: hex('c')};

test('the ranking\'s decision is the assessment: its question, a bounded outcome, unmeasured and so provisional', () => {
  const none = practiceAssessment(projection());
  assert.equal(none.outcome, 'insufficient_evidence', 'without a forecast the ranking stays unresolved');
  assert.equal(none.question, 'Which contributing function accounts for the observed rework?');
  assert.equal(none.measured, false);
  assert.equal(none.provisional, true);
  assert.deepEqual(none.evidence[0], {kind: 'digest', schema: 'ophanim.investigation-decision/v1', sha: digest(rankChairQuestions(projection()).decision)});
  assert.deepEqual(none.evidence[1], {kind: 'digest', schema: 'pantheon.chair-contributions/v1', sha: hex('a')});
  const measured = practiceAssessment(projection(), {economics});
  assert.equal(measured.outcome, 'propose_measurement', 'a positive-value measurement is proposed, not run');
  assert.equal(measured.investigation.selected, 'attribute.rework');
  const p = projection({implRework: 0, checkRework: 0});
  p.chairs[2].metrics.occupancy = {inconsistent: [{instance: 'slot:alpha', why: 'entry 1 has gen 1, expected 2'}], unrecorded: []};
  const blocked = practiceAssessment(p, {economics});
  assert.equal(blocked.outcome, 'insufficient_evidence');
  assert.match(blocked.question, /occupancy-trail-inconsistent/);
  assert.deepEqual(Object.keys(PRACTICE_OUTCOME_OF).sort(), ['blocked', 'insufficient_evidence', 'no_change', 'proposed']);
  assert.throws(() => practiceAssessment(projection(), {contribution: 'not-a-hash'}), /ledger entry hash/);
});

test('the assessment closes a cycle on OPHANIM\'s full ledger; an assessment that admits nothing leaves dispatch on the provisional default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-practice-'));
  try {
    const sys = openSystemLedger({root: path.join(dir, 'ledger')}), rec = sys.recorder();
    const approve = async ({vendor, model}) => ({text: '```json\n{"verdict":"approve","findings":[]}\n```', response_id: `resp_${vendor}`, served_model: model});
    const C = n => String(n).repeat(40);
    const r = await reviewCycle({ledger: rec, change: {scope: 'ophanim', base: C('a'), head: C('b'), diff: 'diff --git a/x b/x\n', files: ['x'], author_labs: ['anthropic']}, turn: approve});
    assert.throws(() => rec.closeCycle(r.cycle), /no practice assessment/);
    const {investigation, ...assessment} = practiceAssessment(projection(), {economics});
    assert.equal(investigation.outcome, 'proposed');
    const d = rec.recordDisposition({cycle: r.cycle, ...assessment});
    assert.deepEqual(rec.closeCycle(r.cycle).practice, [d]);
    assert.equal(sys.ledger.verify().ok, true);
    const loaded = loadPractice({ledger: sys.ledger, profile: 'argo', pools: []});
    assert.equal(loaded.disposition, null, 'propose_measurement admits no policy: the provisional default stays loaded');
    assert.match(loaded.reason, /provisional default/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
