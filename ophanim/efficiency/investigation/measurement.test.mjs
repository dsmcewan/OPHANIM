import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest} from '../../board.mjs';
import {applicabilityFingerprint} from '../analyze.mjs';
import {planMeasurement,MEASUREMENT_FORECAST} from './measurement-plan.mjs';
import {qualifyMeasurement,verifyMeasurementQualification} from './measurement.mjs';

const hex=c=>c.repeat(64);
function evidence(){
  const trace={boardCommit:`commit:${hex('1')}`,stateSha:hex('2'),configuration:{slots:1,workerRegistry:[
    {id:'worker',version:'1',kinds:['step'],scopes:['department:ops']}],workerArtifactSha:hex('3'),policySha:hex('4'),inputRevision:'synthetic-r1'},
    release:{id:'baseline'},window:{startedAt:0,endedAt:35},original:{convergence:'accepted_change',outputSha:hex('5'),effectSha:hex('6')},
    obligations:[{id:'a',kind:'step',scope:'department:ops',dependsOn:[],specSha:hex('7'),status:'accepted',acceptedAttempt:1,acceptedAt:20}],
    attempts:[{id:'a',attempt:1,startedAt:0,endedAt:17,inputSha:hex('8'),inputBytes:10,contextBytes:20}],verifications:[],events:[]};
  trace.scopeSha=applicabilityFingerprint(trace);
  const timer='timer-resume-lag-ms',transform='transform-body-wall-ms';
  const candidate={id:'stage-envelope',scopeSha:trace.scopeSha,evidenceSha:hex('b'),applicabilitySha:hex('c'),
    question:'Which phase grew?',decision:'Decide whether separate spans are worth collecting.',metric:'stage-p95-ms',componentIds:['worker-reasoning'],
    observations:[{signal:'matched-candidate-tail-phase-deltas',samples:[{id:'a',stageMs:180}]}],hypotheses:[
      {id:'timer',componentId:'worker-reasoning',explanation:'The timer resumed later.',predictions:[{signal:timer,direction:'increase'},{signal:transform,direction:'unchanged'}]},
      {id:'transform',componentId:'worker-reasoning',explanation:'Transformation took longer.',predictions:[{signal:timer,direction:'unchanged'},{signal:transform,direction:'increase'}]},
    ]};
  const raw={schema:'ophanim.historical-latency-investigation/v1',probes:[{scopeSha:trace.scopeSha,evidenceSha:candidate.evidenceSha,
    baselineTrace:trace,selection:{candidates:[candidate]},measurements:{stageP95:{baselineMs:200,candidateMs:380,limitMs:275,passed:false}}}]};
  const receipt={...raw,receiptSha:digest(raw)};
  const forecast=horizon=>({schema:MEASUREMENT_FORECAST,scopeSha:trace.scopeSha,basis:'Controlled test forecast',estimatedInvestigationMs:8000,
    estimates:{expectedConvergences:horizon,applicability:1,confidence:0.9,decisionChangeProbability:0.9,
      avoidableLossMsPerConvergence:1200,rolloutMs:200,regressionMs:200,opportunityCostMs:100}});
  return {receipt,expectedSha:receipt.receiptSha,forecast};
}

test('missing evidence selects only direct discriminators and preserves unknown historical value',()=>{
  const {receipt,expectedSha,forecast}=evidence();
  const historical=planMeasurement({receipt,expectedSha});
  assert.equal(historical.decision.outcome,'insufficient_evidence');
  assert.equal(historical.decision.selected,null);
  assert.equal(historical.stageP95.passed,false);
  assert.deepEqual(historical.requirements.map(row=>row.id),['timer-resume-lag-ms','transform-body-wall-ms']);
  assert.ok(historical.requirements.every(row=>row.discriminatingPairs.length===1&&row.overhead.status==='requires-matched-calibration'));
  assert.ok(historical.rejectedMeasurements.some(row=>row.id==='event-loop-delay-and-utilization'));
  const positive=planMeasurement({receipt,expectedSha,forecast:forecast(20)});
  assert.equal(positive.decision.outcome,'proposed');
  assert.equal(positive.decision.selected.value.expectedCandidateGrossGainMs,null);
  assert.equal(positive.authority.execution,false);
  assert.equal(positive.authority.policyActivation,false);
  assert.equal(positive.calibration.obligationId,'a');
  assert.throws(()=>planMeasurement({receipt,expectedSha:hex('e')}),/Exact independently retained/);
  assert.throws(()=>planMeasurement({receipt,expectedSha,forecast:{...forecast(20),scopeSha:hex('e')}}),/Exact scoped/);
  assert.throws(()=>planMeasurement({receipt,expectedSha,forecast:{...forecast(20),estimatedInvestigationMs:3001}}),/Exact scoped/);
});

test('negative value skips read-only authorization and samples, and interrupted claims stay reserved',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-measurement-admission-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {receipt,expectedSha,forecast}=evidence();
  const historyFile=path.join(dir,'history.json');
  const stateRoot=path.join(dir,'state');
  const fakeReport=path.join(dir,'missing-signed-report.json');
  fs.writeFileSync(historyFile,JSON.stringify(receipt));
  const args={historyFile,expectedSha,stateRoot,admissionProofFile:fakeReport};
  const low=await qualifyMeasurement({...args,forecast:forecast(1)});
  assert.equal(low.outcome,'no_change');
  assert.equal(low.plan.decision.reason,'nonpositive-information-value');
  assert.equal(low.executed,false);
  assert.equal(low.replays+low.modelCalls+low.destinationEffects,0);
  const retry=await qualifyMeasurement({...args,forecast:forecast(1)});
  assert.equal(retry.plan.decision.reason,'retained-applicable-decision');
  const journal=path.join(stateRoot,'scopes',low.plan.applicability.scopeSha,'measurements',low.plan.identity);
  assert.deepEqual(fs.readdirSync(journal),['admission-0.json']);

  await assert.rejects(qualifyMeasurement({...args,forecast:forecast(20)}),/Command failed/);
  const interrupted=await qualifyMeasurement({...args,forecast:forecast(20)});
  assert.equal(interrupted.reason,'measurement-failure-retained');
  assert.equal(interrupted.executed,false);
  assert.deepEqual(fs.readdirSync(journal).sort(),['admission-0.json','admission-1.json','attempt.json','failure.json']);
  assert.equal(JSON.parse(fs.readFileSync(interrupted.failureFile)).phase,'signed-source-verification');

  const orphanRoot=path.join(dir,'orphan');
  const orphanJournal=path.join(orphanRoot,path.relative(stateRoot,journal));
  fs.mkdirSync(orphanJournal,{recursive:true});
  for(const name of ['admission-0.json','admission-1.json'])fs.copyFileSync(path.join(journal,name),path.join(orphanJournal,name));
  const orphaned=await qualifyMeasurement({...args,stateRoot:orphanRoot,forecast:forecast(20)});
  assert.equal(orphaned.reason,'interrupted-admission-retained');
  assert.equal(orphaned.executed,false);
  assert.deepEqual(fs.readdirSync(orphanJournal).sort(),['admission-0.json','admission-1.json']);

  const bogus=path.join(journal,'qualification.json');
  fs.writeFileSync(bogus,'{}');
  await assert.rejects(verifyMeasurementQualification({...args,reportFile:bogus,expectedReportSha:hex('f')}),/Exact retained qualification digest/);
});
