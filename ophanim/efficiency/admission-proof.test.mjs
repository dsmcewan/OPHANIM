import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFixtures} from '../fixtures.mjs';
import {digest} from '../board.mjs';
import {controlledPositiveModel,controlledDualGateModel} from './admission-proof.mjs';
import {assessEfficiency} from '../governance/check-efficiency.mjs';

function input(){
  const request={batches:[{count:2,namespace:'model'}],maxDispatches:1000,workerOptions:{version:'synthetic-v1',delayMs:150}};
  const fixture=makeFixtures(request.batches[0]);
  const acceptance={outputSha:digest(Object.fromEntries(fixture.obligations.map(s=>[s.id,s.expected]))),effectSha:digest(fixture.expectedEffects)};
  return {request,acceptance};
}

test('unchanged gate accepts an explicitly modeled positive case without producing a measured or signed admission',()=>{
  const fixture=input(),report=controlledPositiveModel(fixture);
  assert.deepEqual(report,controlledPositiveModel(fixture));
  assert.equal(report.evidenceClass,'deterministic-model');assert.equal(report.productionAdmission,false);
  assert.equal(report.evaluation.eligible,true);assert.equal(report.evaluation.conservativeSavedMs,1500);
  assert.equal(report.cost.trialCostMs,23270);assert.equal(report.evaluation.forecastNetSavedMs,6730);
  assert.equal(report.fullAssessmentNetMs,5730);assert.equal(report.evaluation.realizedNetSavedMs,-23270);
  assert.equal(report.boundaries.policyDecisionsIssued,0);assert.equal(report.boundaries.policyActivations,0);
  assert.match(report.timingOrigin,/not wall-clock/);assert.ok(!Object.hasOwn(report,'planRef'));
});

test('modeled positive case retains real acceptance identity and exact unchanged cost/latency boundaries',()=>{
  const fixture=input();assert.throws(()=>controlledPositiveModel({...fixture,acceptance:{...fixture.acceptance,outputSha:'0'.repeat(64)}}));
  const {measurements}=controlledPositiveModel(fixture);
  assert.equal(assessEfficiency({...measurements,trialCostMs:30000}).eligible,false);
  assert.equal(assessEfficiency({...measurements,candidateP95Ms:[1000,1000,1000]}).eligible,false);
  assert.equal(assessEfficiency({...measurements,candidateRecoveryMs:5000}).eligible,false);
});

test('one exact nine-node fixture model passes both unchanged screens without creating authority',()=>{
  const request={batches:[{count:3,namespace:'admission'}],maxDispatches:1000,workerOptions:{version:'synthetic-v1',delayMs:300}};
  const fixture=makeFixtures(request.batches[0]),acceptance={outputSha:digest(Object.fromEntries(fixture.obligations.map(s=>[s.id,s.expected]))),effectSha:digest(fixture.expectedEffects)};
  const report=controlledDualGateModel({request,acceptance});
  assert.equal(report.evidenceClass,'deterministic-model');assert.equal(report.productionAdmission,false);
  assert.equal(report.screeningDecision.admitted,true);assert.equal(report.screeningDecision.policyAuthorization,false);
  assert.equal(report.screeningDecision.replays,0);assert.equal(report.finalNumericEvaluation.eligible,true);
  assert.equal(report.acceptance.obligations,9);assert.equal(report.measurements.trialCostMs,25055);
  assert.equal(report.finalNumericEvaluation.conservativeSavedMs,2400);
  assert.equal(report.finalNumericEvaluation.forecastNetSavedMs,22945);
});
