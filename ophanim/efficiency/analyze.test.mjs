import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeTrace,applicabilityFingerprint,applicabilityPayload} from './analyze.mjs';

const sha = char => char.repeat(64);
function trace(){
  return {
    configuration:{slots:2,workerRegistry:[{id:'worker',version:'1',kinds:['step'],scopes:['department:ops']}],workerArtifactSha:sha('a'),policySha:sha('b'),inputRevision:'r1'},
    window:{startedAt:0,endedAt:50},
    obligations:[
      {id:'a',kind:'step',scope:'department:ops',dependsOn:[],specSha:sha('1'),status:'accepted',acceptedAttempt:1,acceptedAt:12},
      {id:'b',kind:'step',scope:'department:ops',dependsOn:[],specSha:sha('2'),status:'accepted',acceptedAttempt:1,acceptedAt:22},
      {id:'c',kind:'step',scope:'department:ops',dependsOn:['a','b'],specSha:sha('3'),status:'accepted',acceptedAttempt:1,acceptedAt:40},
    ],
    attempts:[
      {id:'a',attempt:1,startedAt:0,endedAt:10,inputSha:sha('4'),inputBytes:30,contextBytes:50},
      {id:'b',attempt:1,startedAt:0,endedAt:20,inputSha:sha('5'),inputBytes:40,contextBytes:60},
      {id:'c',attempt:1,startedAt:25,endedAt:35,inputSha:sha('6'),inputBytes:50,contextBytes:70},
    ],
    verifications:[
      {id:'a',attempt:1,startedAt:10,endedAt:12,purpose:'accept',candidateSha:sha('7'),ok:true},
      {id:'b',attempt:1,startedAt:20,endedAt:22,purpose:'accept',candidateSha:sha('8'),ok:true},
      {id:'c',attempt:1,startedAt:35,endedAt:40,purpose:'accept',candidateSha:sha('9'),ok:true},
    ],
  };
}

test('fork/join critical path uses the longest accepted dependency chain and union occupancy',()=>{
  const result=analyzeTrace(trace());
  assert.deepEqual(result.criticalPath.obligationIds,['b','c']);
  assert.equal(result.criticalPath.observedMs,37);
  assert.equal(result.criticalPath.workMs,30);
  assert.equal(result.criticalPath.verificationMs,7);
  assert.equal(result.criticalPath.status,'observed');
  assert.equal(result.scheduling.workerMs,40);
  assert.equal(result.scheduling.workerBusyMs,30);
  assert.equal(result.scheduling.maxConcurrentWorkers,2);
  assert.equal(result.scheduling.noWorkerActivityMs,20);
  assert.equal(result.scheduling.noWorkerOrVerificationActivityMs,13);
  assert.equal(result.scheduling.readyWaitMs,3);
  assert.equal(result.context.observedContextBytes,180);
  assert.equal(result.providerAllocation.status,'no-evidence');
});

test('applicability excludes timing, status, replay history, paths and scheduler slots',()=>{
  const one=trace(),two=structuredClone(one);
  two.configuration.slots=3;two.stateDir='/other/machine/private';two.history=[{secret:'ignored'}];
  two.obligations.reverse();two.obligations.forEach(row=>{row.status='held';row.acceptedAt=500;row.acceptedAttempt=7;});
  two.obligations.find(row=>row.id==='c').dependsOn.reverse();
  two.attempts=[];two.verifications=[];two.window={startedAt:500,endedAt:600};
  assert.equal(applicabilityFingerprint(one),applicabilityFingerprint(two));
  assert.equal(applicabilityPayload(one).schema,'ophanim.efficiency.applicability/v1');
  for(const modify of [
    value=>{value.configuration.workerArtifactSha=sha('c');},
    value=>{value.configuration.policySha=sha('c');},
    value=>{value.configuration.inputRevision='r2';},
    value=>{value.obligations[0].specSha=sha('c');},
    value=>{value.obligations[2].dependsOn=['b'];},
    value=>{value.configuration.workerRegistry[0].version='2';},
  ]){const changed=trace();modify(changed);assert.notEqual(applicabilityFingerprint(one),applicabilityFingerprint(changed));}
});

test('failed attempts contribute required work, while replay checks remain separate',()=>{
  const input=trace();input.obligations=input.obligations.slice(0,1);input.obligations[0].acceptedAttempt=2;input.obligations[0].acceptedAt=30;
  input.attempts=[{id:'a',attempt:1,startedAt:0,endedAt:10,inputSha:sha('4'),inputBytes:30,contextBytes:50},{id:'a',attempt:2,startedAt:15,endedAt:25,inputSha:sha('4'),inputBytes:30,contextBytes:51}];
  input.verifications=[{id:'a',attempt:1,startedAt:10,endedAt:12,purpose:'accept',candidateSha:sha('7'),ok:false},{id:'a',attempt:2,startedAt:25,endedAt:30,purpose:'accept',candidateSha:sha('8'),ok:true},{id:'a',attempt:2,startedAt:40,endedAt:45,purpose:'replay',candidateSha:sha('8'),ok:true}];
  const result=analyzeTrace(input);
  assert.equal(result.criticalPath.observedMs,27);assert.equal(result.criticalPath.nodeWork[0].acceptedAttemptWorkMs,10);
  assert.equal(result.retries.priorAcceptanceAttemptWorkMs,10);assert.equal(result.retries.observedRetryAttempts,1);
  assert.equal(result.verification.totalMs,12);assert.equal(result.verification.replayCalls,1);assert.equal(result.verification.repeatedCandidateCalls,1);
  assert.equal(result.verification.repeatedCandidateMs,5);assert.equal(result.context.repeatedInputBytes,30);
  assert.equal(result.scheduling.readyWaitMs,3);
});

test('partial retained history remains unknown instead of being counted as zero work',()=>{
  const input=trace();input.attempts=input.attempts.slice(2);input.verifications=input.verifications.slice(2);
  delete input.obligations[0].acceptedAt;delete input.configuration.workerArtifactSha;
  const result=analyzeTrace(input);
  assert.equal(result.criticalPath.status,'partial');assert.equal(result.criticalPath.missing.length,2);
  assert.equal(result.scheduling.unmeasuredWaits.length,1);assert.equal(result.scheduling.measuredWaits.length,0);
  assert.equal(result.applicability.complete,false);
  input.attempts=[];input.verifications=[];
  assert.equal(analyzeTrace(input).criticalPath.status,'no-evidence');
});

test('scope and obligation identity keep equal inputs from becoming cross-scope reuse recommendations',()=>{
  const input=trace();input.attempts[1].inputSha=input.attempts[0].inputSha;input.obligations[1].scope='department:other';
  const result=analyzeTrace(input);
  assert.equal(result.context.repeatedInputSamples,0);assert.equal(result.limits.policyAuthorization,false);
});

test('invalid graphs, intervals, concurrency and incomplete dependency acceptance fail explicitly',()=>{
  for(const [modify,pattern] of [
    [value=>{value.obligations[0].dependsOn=['c'];},/cycle/],
    [value=>{value.obligations[0].dependsOn=['missing'];},/missing dependency/],
    [value=>{value.attempts[0].endedAt=-1;},/end/],
    [value=>{value.attempts[0].endedAt=60;},/observation window/],
    [value=>{value.configuration.slots=1;},/concurrency/],
    [value=>{value.attempts.push({...value.attempts[0]});},/duplicate attempt/],
    [value=>{value.obligations[0].acceptedAt=26;},/before dependency/],
    [value=>{value.obligations[0].status='held';delete value.obligations[0].acceptedAt;delete value.obligations[0].acceptedAttempt;},/unaccepted dependency/],
    [value=>{value.attempts[0].inputBytes=17*1024*1024;},/inputBytes/],
    [value=>{value.verifications[0].startedAt=9;},/overlapping work/],
  ]){const input=trace();modify(input);assert.throws(()=>analyzeTrace(input),pattern);}
});

test('zero-duration intervals do not invent overlap or lose an accepted chain',()=>{
  const input=trace();input.window={startedAt:0,endedAt:0};
  input.obligations.forEach(row=>row.acceptedAt=0);input.attempts.forEach(row=>{row.startedAt=0;row.endedAt=0;});input.verifications=[];
  const result=analyzeTrace(input);
  assert.equal(result.scheduling.maxConcurrentWorkers,0);assert.equal(result.criticalPath.observedMs,0);
  assert.deepEqual(result.criticalPath.obligationIds,['a','c']);
});
