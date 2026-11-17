// K5 interim hardening: the file-based efficiency records no longer let a written file inflate the
// measured saving. A legacy aggregate must be the non-negative shape its writer produced, and a
// `.result.json` counts only when it is bound to a recorded use and a retained accepted trace.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runRuntime,loadRuntime} from '../runtime.mjs';
import {readRuntimeSnapshot,digest} from '../board.mjs';
import {assessConvergence,readAssessmentDebits,recordAssessmentDebit} from './assessment.mjs';

async function withDir(fn){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-measured-')));
  try{return await fn(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}
}
const sha=n=>String(n).repeat(64);

test('a legacy debit aggregate is refused unless it is non-negative integers in the shape its writer produced',()=>withDir(dir=>{
  const usesDir=path.join(dir,'uses');fs.mkdirSync(usesDir);
  recordAssessmentDebit({usesDir,useFile:path.join(usesDir,'one.json'),traceSha:sha(1),assessmentCostMs:10,charged:true});
  const legacy=path.join(usesDir,'assessment-costs','legacy.json');
  const write=value=>fs.writeFileSync(legacy,JSON.stringify(value));
  // The shape the earlier mutable ledger wrote is still read.
  write({additionalAssessmentCostMs:4,unmeasuredAssessments:1,lastTraceSha:sha(2),lastInterruptedTraceSha:sha(3)});
  assert.deepEqual(readAssessmentDebits(usesDir),{additionalAssessmentCostMs:14,unmeasuredAssessments:1});
  // A negative aggregate would have lowered the measured cost and raised the measured saving.
  for(const forged of [
    {additionalAssessmentCostMs:-100000,unmeasuredAssessments:0},
    {additionalAssessmentCostMs:4,unmeasuredAssessments:-1},
    {additionalAssessmentCostMs:4.5,unmeasuredAssessments:0},
    {additionalAssessmentCostMs:'4',unmeasuredAssessments:0},
    {unmeasuredAssessments:0},
    {additionalAssessmentCostMs:4,unmeasuredAssessments:0,bonusMs:9},
    {additionalAssessmentCostMs:4,unmeasuredAssessments:0,lastTraceSha:'not-a-hash'},
    [],
  ]){
    write(forged);
    assert.throws(()=>readAssessmentDebits(usesDir),/Legacy efficiency debit is not a non-negative aggregate/,JSON.stringify(forged));
  }
  fs.rmSync(legacy);
  // A write-once debit with a negative cost is refused the same way.
  fs.writeFileSync(path.join(usesDir,'assessment-costs','one',`debit-${sha(4)}.json`),
    JSON.stringify({schema:'ophanim.efficiency-debit/v1',traceSha:sha(4),assessmentCostMs:-500}));
  assert.throws(()=>readAssessmentDebits(usesDir),/Unexpected efficiency ledger record/);
}));

const worker={id:'w',version:'1',kinds:['k'],scopes:['s'],run:async({obligation})=>({output:{id:obligation.id}})};
const spec=(id,dependsOn=[])=>({id,kind:'k',scope:'s',outputKey:id,dependsOn,inputs:{},expected:null,maxAttempts:1});
const governance={verifyCandidate:async()=>({ok:true,planRef:null,evidenceRefs:[]}),authorizePlan:async()=>({ok:true})};

test('a result file counts as a qualified convergence only when it is bound to a recorded use and its trace',()=>withDir(async dir=>{
  const stateDir=path.join(dir,'state'),root=path.join(dir,'efficiency');fs.mkdirSync(stateDir);
  const startedAt=Date.now();
  await runRuntime({stateDir,obligations:[spec('a'),spec('b')],workers:[worker],governance,slots:3});
  const scopeSha=sha('a'),usesDir=path.join(root,'scopes',scopeSha,'uses');fs.mkdirSync(usesDir,{recursive:true});
  const promotion={expected:{scopeSha,fromSlots:1,toSlots:3},efficiency:{baselineConservativeMs:5000,totalAssessmentCostMs:100}};
  const intent=stateDir=>({schema:'ophanim.efficiency/v1',stateDir,decisionId:'sha256:'+sha('d'),scopeSha});
  const useFile=path.join(usesDir,`${digest(stateDir)}.json`);
  fs.writeFileSync(useFile,JSON.stringify(intent(stateDir)));
  // Two forged results: one with no use at all, one whose use names a state directory holding no such trace.
  const forged={traceSha:sha('f'),executionMs:1,assessmentCostMs:0,observedSavingMs:4999};
  fs.writeFileSync(path.join(usesDir,'invented.result.json'),JSON.stringify(forged));
  const elsewhere=path.join(dir,'elsewhere');
  fs.writeFileSync(path.join(usesDir,`${digest(elsewhere)}.json`),JSON.stringify(intent(elsewhere)));
  fs.writeFileSync(path.join(usesDir,`${digest(elsewhere)}.result.json`),JSON.stringify(forged));

  const snapshot=readRuntimeSnapshot(stateDir);
  const output={convergence:'accepted_change',slots:3,dispatches:2,durationMs:1200,startedAt,endedAt:Date.now(),
    outputs:{},effects:[],measurements:{},limits:{modelCalls:0}};
  const record=await assessConvergence({root,stateDir,scope:{graph:[],configuration:{slots:3,workerRegistry:[{id:'w',version:'1',kinds:['k'],scopes:['s']}]},policy:{}},state:loadRuntime(stateDir),
    boardCommit:snapshot.commit,output,request:{},replayRequest:null,priorRuntime:null,attempts:[],verifications:[],events:[],
    governance:{identity:'stub'},use:{slots:3,use:useFile,promotion},interrupted:null});
  const value=JSON.parse(fs.readFileSync(record.reportFile,'utf8')).measuredValue;
  const own=JSON.parse(fs.readFileSync(useFile.replace(/\.json$/,'.result.json'),'utf8'));
  assert.equal(own.observedSavingMs,5000-1200-own.assessmentCostMs);
  assert.equal(value.qualifiedConvergences,1,'only the result bound to this use and its retained trace counts');
  assert.equal(value.unboundResults,2);
  assert.equal(value.measuredNetMs,own.observedSavingMs-100,'the realized result already carries its assessment cost');
}));
