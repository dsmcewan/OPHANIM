import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeTrace,applicabilityFingerprint} from './analyze.mjs';
import {assessOptimizationAdmission,admissionDigest,optimizationRecipeSha,baselineEvidenceSha} from './admission.mjs';

const sha=letter=>letter.repeat(64);
function traceOf({chains=3,length=3,workerMs=250,checkMs=5,offset=0,custom=null}={}){
  const definitions=custom??Array.from({length:chains},(_,chain)=>Array.from({length},(_,step)=>({id:`chain-${chain}:${step}`,dependsOn:step?[`chain-${chain}:${step-1}`]:[],workerMs,checkMs}))).flat();
  const obligations=[],attempts=[],verifications=[];let now=offset;
  for(const item of definitions){
    const startedAt=now,endedAt=startedAt+item.workerMs,acceptedAt=endedAt+item.checkMs;
    obligations.push({id:item.id,kind:'fixture-worker',scope:'department:operations',dependsOn:item.dependsOn,specSha:admissionDigest({id:item.id,dependsOn:item.dependsOn}),status:'accepted',acceptedAttempt:1,acceptedAt});
    attempts.push({id:item.id,attempt:1,startedAt,endedAt,inputSha:sha('a'),inputBytes:100,contextBytes:100});
    verifications.push({id:item.id,attempt:1,purpose:'accept',startedAt:endedAt,endedAt:acceptedAt,candidateSha:sha('b'),ok:true});
    now=acceptedAt+1;
  }
  const policy={schema:'ophanim.efficiency/v1',replayBudgetMs:30000,maxQualifiedConvergences:20};
  const configuration={slots:1,workerRegistry:[{id:'worker',version:'1',kinds:['fixture-worker'],scopes:['department:operations']}],workerArtifactSha:sha('c'),policySha:admissionDigest(policy),inputRevision:sha('d')};
  return {schema:'ophanim.efficiency.trace/v1',obligations,attempts,verifications,window:{startedAt:offset,endedAt:now},configuration,policy,scopeSha:applicabilityFingerprint({obligations,configuration}),release:{id:'baseline'},original:{convergence:'accepted_change',slots:1,modelCalls:0,outputSha:sha('e'),effectSha:sha('f'),durationMs:now-offset}};
}
function priorFor(trace,extra={}){
  // Observed synthetic replay: 1910 - 1481 = 429 ms; twenty repeats save
  // 8580 ms versus a 24046 ms benchmark and 30169 ms full assessment.
  return {verified:true,scopeSha:trace.scopeSha,recipeSha:optimizationRecipeSha(),baselineEvidenceSha:baselineEvidenceSha(trace),outcome:'no_change',evidenceSha:sha('1'),blockers:['Stage p95 latency materially regressed','Measured trial cost exceeds conservative forecast'],measured:{baselineConservativeMs:1910,candidateConservativeMs:1481,conservativeSavedMs:429,trialCostMs:24046,forecastGrossSavedMs:8580,forecastNetSavedMs:-15466,assessmentCostMs:30169},...extra};
}

test('cold screen admits a plausible worker-dominant DAG with an explicit bounded workload',()=>{
  const trace=traceOf(),result=assessOptimizationAdmission({trace,expectedQualifiedConvergences:20});
  assert.equal(result.admitted,true,JSON.stringify(result.blockers));
  assert.equal(result.outcome,'admit');assert.equal(result.policyAuthorization,false);
  assert.equal(result.measurements.workerMs,2250);assert.equal(result.measurements.workerCriticalPathMs,750);
  assert.equal(result.measurements.upperOpportunityMs,1500);
  assert.ok(result.estimates.predictedSavingMs<result.measurements.upperOpportunityMs);
  assert.ok(result.estimates.trialAndVerificationMs<=30000);
  assert.ok(result.forecast.netSavedMs>0);
  assert.equal(result.forecast.realizedSavedMs,0);
  assert.equal(result.forecast.conditional,true);
  assert.equal(result.replays,0);assert.equal(result.modelCalls,0);assert.equal(result.monetaryGainEstimate,false);
});

test('absent an explicit expected workload, only one convergence is forecast and no experiment is admitted',()=>{
  const result=assessOptimizationAdmission({trace:traceOf()});
  assert.equal(result.admitted,false);assert.equal(result.forecast.expectedQualifiedConvergences,1);
  assert.equal(result.forecast.workloadSource,'default-single-convergence');
  assert.ok(result.blockers.includes('forecast-does-not-cover-trial-and-approval-cost'));
  for(const expectedQualifiedConvergences of [0,21,1.5,NaN,Infinity])assert.equal(assessOptimizationAdmission({trace:traceOf(),expectedQualifiedConvergences}).admitted,false);
});

test('worker-only critical path does not borrow the worker component of a verification-heavy path',()=>{
  const trace=traceOf({custom:[
    {id:'a:1',dependsOn:[],workerMs:500,checkMs:1},{id:'a:2',dependsOn:['a:1'],workerMs:500,checkMs:1},
    {id:'b:1',dependsOn:[],workerMs:10,checkMs:900},{id:'b:2',dependsOn:['b:1'],workerMs:10,checkMs:900},
  ]});
  assert.equal(analyzeTrace(trace).criticalPath.workMs,20);
  const result=assessOptimizationAdmission({trace,expectedQualifiedConvergences:20});
  assert.equal(result.measurements.workerCriticalPathMs,1000);
  assert.equal(result.measurements.upperOpportunityMs,20);assert.equal(result.admitted,false);
});

test('serial, small, verification-dominated and replay-infeasible workloads are declined without a replay',()=>{
  for(const options of [{chains:1,length:9},{chains:2,length:3,workerMs:15,checkMs:100},{workerMs:1000,checkMs:5}]){
    const result=assessOptimizationAdmission({trace:traceOf(options),expectedQualifiedConvergences:20});
    assert.equal(result.admitted,false,JSON.stringify(options));assert.equal(result.replays,0);assert.ok(result.blockers.length);
  }
});

test('caller estimates cannot lower uncertainty, costs or final-gate allowances',()=>{
  const trace=traceOf(),base=assessOptimizationAdmission({trace,expectedQualifiedConvergences:20});
  const zero=assessOptimizationAdmission({trace,expectedQualifiedConvergences:20,estimates:{trialAndVerificationMs:0,approvalAndRolloutMs:0,regressionAllowanceMs:0,processStartupMs:0,source:'operator finite estimate'}});
  assert.equal(zero.estimates.totalCostMs,base.estimates.totalCostMs);
  assert.equal(zero.estimates.regressionAllowanceMs,base.estimates.regressionAllowanceMs);
  for(const estimates of [{relativeUncertainty:0},{relativeUncertainty:0.8},{trialAndVerificationMs:Infinity},{approvalAndRolloutMs:NaN},{skipFinalGate:true},{maximumConvergences:100}])assert.equal(assessOptimizationAdmission({trace,expectedQualifiedConvergences:20,estimates}).admitted,false);
  const costly=assessOptimizationAdmission({trace,expectedQualifiedConvergences:20,estimates:{approvalAndRolloutMs:20000}});
  assert.equal(costly.admitted,false);assert.ok(costly.forecast.netSavedMs<0);
});

test('retained negative 15.466-second forecast and p95 blockers prevent another identical recipe',()=>{
  const trace=traceOf(),priorOutcome=priorFor(trace);
  const result=assessOptimizationAdmission({trace,expectedQualifiedConvergences:20,priorOutcome});
  assert.equal(result.admitted,false);
  assert.equal(result.prior.measured.forecastNetSavedMs,-15466);
  assert.equal(result.prior.measured.forecastGrossSavedMs-result.prior.measured.assessmentCostMs,-21589);
  assert.deepEqual(result.prior.retainedBlockers,priorOutcome.blockers);
  assert.ok(result.blockers.includes('retained-outcome-has-no-materially-new-applicable-condition'));
  assert.ok(result.estimates.trialAndVerificationMs>=priorOutcome.measured.trialCostMs);
  assert.ok(result.estimates.approvalAndRolloutMs>=priorOutcome.measured.assessmentCostMs-priorOutcome.measured.trialCostMs);
  for(const next of [traceOf({offset:10000}),traceOf({workerMs:251})]){
    assert.equal(next.scopeSha,trace.scopeSha);
    assert.equal(baselineEvidenceSha(next),baselineEvidenceSha(trace));
    assert.notEqual(admissionDigest(next),admissionDigest(trace));
    assert.ok(assessOptimizationAdmission({trace:next,expectedQualifiedConvergences:20,priorOutcome}).blockers.includes('retained-outcome-has-no-materially-new-applicable-condition'));
  }
});

test('prior evidence requires external verification and exact scope, recipe and accepted results',()=>{
  const trace=traceOf(),prior=priorFor(trace);
  assert.equal(assessOptimizationAdmission({trace,expectedQualifiedConvergences:20,priorOutcome:{...prior,verified:false}}).reason,'invalid-or-incomplete-admission-evidence');
  for(const changed of [{scopeSha:sha('2')},{recipeSha:sha('2')},{baselineEvidenceSha:sha('2')}]){
    const result=assessOptimizationAdmission({trace,expectedQualifiedConvergences:20,priorOutcome:{...prior,...changed}});
    assert.equal(result.prior.applicable,false);assert.equal(result.admitted,true);
  }
  const forged={...prior,measured:{...prior.measured,forecastNetSavedMs:1000}};
  assert.equal(assessOptimizationAdmission({trace,expectedQualifiedConvergences:20,priorOutcome:forged}).reason,'invalid-or-incomplete-admission-evidence');
});

test('a new hash or material flag is insufficient; verified condition change needs actual opportunity',()=>{
  const trace=traceOf({workerMs:380}),priorOutcome=priorFor(trace);
  assert.equal(assessOptimizationAdmission({trace,expectedQualifiedConvergences:20,priorOutcome,newEvidence:{material:true,verified:true}}).admitted,false);
  const newEvidence={verified:true,evidenceSha:sha('2'),scopeSha:trace.scopeSha,recipeSha:optimizationRecipeSha(),baselineEvidenceSha:baselineEvidenceSha(trace),traceSha:admissionDigest(trace),condition:{kind:'execution-environment',previousSha:sha('3'),currentSha:sha('4')}};
  const result=assessOptimizationAdmission({trace,expectedQualifiedConvergences:20,priorOutcome,newEvidence});
  assert.equal(result.admitted,true,JSON.stringify(result.blockers));
  assert.equal(result.policyAuthorization,false);assert.equal(result.replays,0);
  const unchanged={...newEvidence,condition:{...newEvidence.condition,currentSha:sha('3')}};
  assert.equal(assessOptimizationAdmission({trace,expectedQualifiedConvergences:20,priorOutcome,newEvidence:unchanged}).admitted,false);
  const tooSmall=traceOf({workerMs:100});
  assert.equal(assessOptimizationAdmission({trace:tooSmall,expectedQualifiedConvergences:20,priorOutcome,newEvidence:{...newEvidence,traceSha:admissionDigest(tooSmall)}}).admitted,false);
});

test('caller-supplied analysis cannot turn incomplete or changed observations into opportunity',()=>{
  const trace=traceOf(),analysis=analyzeTrace(trace);analysis.scheduling.workerMs+=100000;
  assert.equal(assessOptimizationAdmission({trace,analysis,expectedQualifiedConvergences:20}).admitted,false);
  const missing=structuredClone(trace);missing.verifications.pop();
  assert.equal(assessOptimizationAdmission({trace:missing,expectedQualifiedConvergences:20}).admitted,false);
  assert.deepEqual(assessOptimizationAdmission({trace,expectedQualifiedConvergences:20}),assessOptimizationAdmission({trace,expectedQualifiedConvergences:20}));
});
