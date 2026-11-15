import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {withRuntimeBoard,readRuntimeSnapshot,digest,canonical,STATE_SCHEMA} from '../board.mjs';
import {applicabilityFingerprint} from './analyze.mjs';
import {recoverInterruptedAssessment} from './recovery.mjs';
import {verifyEfficiencyRecord} from './assessment.mjs';

async function fixture({timestamped=true,context=true,attempt=false}={}){
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-efficiency-recovery-'));
  const workers=[{id:'synthetic-worker',version:'1',kinds:['step'],scopes:['department:ops']}];
  const spec={id:'one',kind:'step',scope:'department:ops',dependsOn:[],inputs:{value:'synthetic'},expected:{value:'synthetic'},outputKey:'one',maxAttempts:2};
  const configuration={slots:1,workerRegistry:workers,workerArtifactSha:'a'.repeat(64),policySha:'b'.repeat(64),inputRevision:'original-input'};
  const graph=[{id:spec.id,kind:spec.kind,scope:spec.scope,dependsOn:[],specSha:digest(spec)}];
  const scope={graph,configuration,policy:{schema:'test-policy',replayBudgetMs:30000}};
  scope.scopeSha=applicabilityFingerprint({obligations:graph,configuration});
  const state={schema:STATE_SCHEMA,revision:0,events:[],obligations:{one:{spec,status:'held',attempt:0,releaseAttempts:0,candidate:null,history:[],reason:'no-scoped-worker'}},effects:{},activeRelease:'baseline',releases:{baseline:{id:'baseline',artifactSha:digest(workers),stateSchema:STATE_SCHEMA,workers,planRef:null}},pendingRelease:null,releaseHistory:[]};
  await withRuntimeBoard(stateDir,async board=>{
    await board.save(state,{type:'runtime.opened',...(timestamped?{atMs:10}:{}),slots:1,...context?{efficiencyContext:{scopeSha:scope.scopeSha,configuration,policy:scope.policy}}:{}});
    if(attempt){
      await board.save(state,{type:'work.started',id:spec.id,attempt:1,atMs:12,worker:'synthetic-worker'});
      await board.save(state,{type:'work.failed',id:spec.id,attempt:1,atMs:15,reason:'fixture-failure'});
    }
    await board.save(state,{type:'runtime.settled',...(timestamped?{atMs:20}:{}),accepted:0,held:1,dispatches:0,convergence:'blocked',blockers:[{id:'one',reason:'no-scoped-worker'}]});
  });
  return {stateDir,scope,priorRuntime:readRuntimeSnapshot(stateDir).state,governance:{identity:{fixtureOnly:true,authoritySha:'c'.repeat(64)},verifyCandidate(){throw Error('Recovery must not execute governance work');}}};
}

test('missing trace is reconstructed from the committed original context with unknown costs',async()=>{
  const input=await fixture();
  try{
    const before=readRuntimeSnapshot(input.stateDir).commit;
    const changedScope=structuredClone(input.scope);changedScope.configuration.workerArtifactSha='d'.repeat(64);
    const record=await recoverInterruptedAssessment({...input,scope:changedScope});
    assert.equal(record.outcome,'no_change');assert.equal(record.reason,'interrupted-assessment');assert.equal(record.boardCommit,before);
    const report=verifyEfficiencyRecord({stateDir:input.stateDir,record});
    assert.equal(report.scopeSha,input.scope.scopeSha);assert.equal(report.cost.wallMs,null);assert.equal(report.cost.providerSpend,null);
    assert.equal(report.recovery.measurementCoverage,'unavailable');assert.equal(report.analysis.criticalPath.status,'no-evidence');
    const trace=JSON.parse(fs.readFileSync(path.join(path.dirname(record.reportFile),'trace.json'),'utf8'));
    assert.deepEqual(trace.attempts,[]);assert.deepEqual(trace.verifications,[]);assert.equal(trace.original.durationMs,null);
    assert.equal(readRuntimeSnapshot(input.stateDir).commit,before);
    assert.equal(await recoverInterruptedAssessment(input),null);
  }finally{fs.rmSync(input.stateDir,{recursive:true,force:true});}
});

test('retained trace and partial replay bytes survive conservative completion without retry',async()=>{
  const input=await fixture();
  try{
    const first=await recoverInterruptedAssessment(input),reportDir=path.dirname(first.reportFile),traceFile=path.join(reportDir,'trace.json');
    const traceBytes=fs.readFileSync(traceFile);
    fs.unlinkSync(first.reportFile);fs.mkdirSync(path.join(reportDir,'experiment'));
    const partial=path.join(reportDir,'experiment','partial.json');fs.writeFileSync(partial,'{"completed":1}');
    const record=await recoverInterruptedAssessment(input),report=verifyEfficiencyRecord({stateDir:input.stateDir,record});
    assert.deepEqual(fs.readFileSync(traceFile),traceBytes);assert.equal(fs.readFileSync(partial,'utf8'),'{"completed":1}');
    assert.equal(report.recovery.trace,'retained');assert.equal(report.recovery.replayRetried,false);
    assert.equal(report.recovery.measurementCoverage,'unavailable');assert.ok(report.recovery.missingMeasurements.includes('attempt-timings'));
    assert.deepEqual(report.recovery.partialReplayEvidence.topLevelEntries,['partial.json']);
  }finally{fs.rmSync(input.stateDir,{recursive:true,force:true});}
});

test('retained graph mutation is refused before creating an assessment',async()=>{
  const input=await fixture();
  try{
    const first=await recoverInterruptedAssessment(input);fs.unlinkSync(first.reportFile);
    const file=path.join(path.dirname(first.reportFile),'trace.json'),trace=JSON.parse(fs.readFileSync(file,'utf8'));
    trace.obligations[0].scope='department:other';fs.writeFileSync(file,JSON.stringify(trace));
    await assert.rejects(recoverInterruptedAssessment(input),/graph or acceptance differs/);
    assert.equal(fs.existsSync(first.reportFile),false);
  }finally{fs.rmSync(input.stateDir,{recursive:true,force:true});}
});

test('retained attempt input observations must match exact committed inputs',async()=>{
  const input=await fixture({attempt:true});
  try{
    const first=await recoverInterruptedAssessment(input);fs.unlinkSync(first.reportFile);
    const file=path.join(path.dirname(first.reportFile),'trace.json'),trace=JSON.parse(fs.readFileSync(file,'utf8'));
    const {expected,...brief}=input.priorRuntime.obligations.one.spec;
    const inputs={...brief.inputs,dependencies:{}};
    trace.attempts=[{id:'one',attempt:1,startedAt:12,endedAt:15,inputSha:digest(inputs),inputBytes:Buffer.byteLength(canonical(inputs)),contextBytes:Buffer.byteLength(canonical({obligation:brief,inputs,priorAttempts:0}))}];
    fs.writeFileSync(file,JSON.stringify(trace));
    const recovered=await recoverInterruptedAssessment(input);
    assert.equal(verifyEfficiencyRecord({stateDir:input.stateDir,record:recovered}).analysis.context.inputByteSamples,1);
    fs.unlinkSync(first.reportFile);trace.attempts[0].inputSha='e'.repeat(64);fs.writeFileSync(file,JSON.stringify(trace));
    await assert.rejects(recoverInterruptedAssessment(input),/inputSha differs/);
  }finally{fs.rmSync(input.stateDir,{recursive:true,force:true});}
});

test('legacy untimestamped convergence is skipped and absent policy is not inferred from current source',async()=>{
  const legacy=await fixture({timestamped:false}),missing=await fixture({context:false});
  try{
    assert.equal(await recoverInterruptedAssessment(legacy),null);
    assert.equal(fs.existsSync(path.join(legacy.stateDir,'efficiency')),false);
    const record=await recoverInterruptedAssessment(missing),report=verifyEfficiencyRecord({stateDir:missing.stateDir,record});
    assert.equal(report.analysis.applicability.complete,false);assert.equal(report.analysis.applicability.identity.workerArtifactSha,null);
    assert.equal(report.analysis.applicability.identity.policySha,null);assert.equal(report.cost.replayBudgetMs,null);
  }finally{fs.rmSync(legacy.stateDir,{recursive:true,force:true});fs.rmSync(missing.stateDir,{recursive:true,force:true});}
});

test('stale runtime input is rejected and an unfinished head is not called a convergence',async()=>{
  const input=await fixture();
  try{
    const stale=structuredClone(input.priorRuntime);stale.revision++;
    await assert.rejects(recoverInterruptedAssessment({...input,priorRuntime:stale}),/current committed snapshot/);
    await withRuntimeBoard(input.stateDir,board=>board.save(board.state,{type:'runtime.opened',atMs:30,slots:1}));
    assert.equal(await recoverInterruptedAssessment({...input,priorRuntime:readRuntimeSnapshot(input.stateDir).state}),null);
  }finally{fs.rmSync(input.stateDir,{recursive:true,force:true});}
});
