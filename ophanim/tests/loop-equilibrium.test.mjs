import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runRuntime,loadRuntime,activateRelease,ASSIGNMENT_POLICY} from '../runtime.mjs';
import {readRuntimeSnapshot,digest,canonical,verifyRuntimeChain,withRuntimeBoard,boardPath,diffState,CHECKPOINT_INTERVAL} from '../board.mjs';
import {openBoard} from '../../pantheon/src/board/index.mjs';
import {publish} from '../../pantheon/src/board/dag.mjs';
import {recordAssessmentDebit,readAssessmentDebits} from '../efficiency/assessment.mjs';
import {createGovernance} from '../governance.mjs';

// Stub authority: these tests exercise controller bookkeeping, not TELOS.
function stubGovernance(overrides={}) {
  const calls={verifyCandidate:0};
  return {calls,governance:{
    verifyCandidate:async({candidate})=>{calls.verifyCandidate++;return candidate.output?.refuse?{ok:false,reason:'refused'}:{ok:true,planRef:null,evidenceRefs:[]};},
    authorizePlan:async()=>({ok:true}),
    ...overrides,
  }};
}
const worker={id:'w',version:'1',kinds:['k'],scopes:['s'],
  run:async({obligation,inputs})=>({output:{id:obligation.id,deps:Object.keys(inputs.dependencies),...obligation.inputs}})};
const spec=(id,dependsOn=[],inputs={})=>({id,kind:'k',scope:'s',outputKey:id,dependsOn,inputs,expected:null,maxAttempts:1});
function boardBytes(dir){
  return fs.readdirSync(dir,{withFileTypes:true}).reduce((sum,entry)=>{
    const file=path.join(dir,entry.name);return sum+(entry.isDirectory()?boardBytes(file):fs.statSync(file).size);
  },0);
}
async function withState(fn){
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-loop-'));
  try{return await fn(stateDir);}finally{fs.rmSync(stateDir,{recursive:true,force:true});}
}

test('a settled head with nothing unresolved is reused without writing a new record',()=>withState(async stateDir=>{
  const {calls,governance}=stubGovernance(),obligations=[spec('a'),spec('b',['a']),spec('c',['b'])];
  const first=await runRuntime({stateDir,obligations,workers:[worker],governance});
  assert.equal(first.convergence,'accepted_change');assert.equal(first.reused,undefined);
  const head=readRuntimeSnapshot(stateDir).commit,bytes=boardBytes(path.join(stateDir,'pantheon'));
  for(let run=0;run<3;run++){
    calls.verifyCandidate=0;
    const again=await runRuntime({stateDir,obligations,workers:[worker],governance});
    assert.equal(again.reused,true);assert.equal(again.convergence,'no_change');assert.equal(again.dispatches,0);
    assert.equal(again.boardCommit,head);assert.equal(again.state.revision,first.state.revision);
    // The handoff is still verified: every accepted row is rechecked before reuse.
    assert.equal(calls.verifyCandidate,3);
  }
  assert.equal(readRuntimeSnapshot(stateDir).commit,head);
  assert.equal(boardBytes(path.join(stateDir,'pantheon')),bytes);
}));

test('an unchanged blocked convergence is reused and still reports its blockers',()=>withState(async stateDir=>{
  const {governance}=stubGovernance(),obligations=[spec('a',[],{refuse:true}),spec('b',['a'])];
  const first=await runRuntime({stateDir,obligations,workers:[worker],governance});
  assert.equal(first.convergence,'blocked');
  const again=await runRuntime({stateDir,obligations,workers:[worker],governance});
  assert.equal(again.reused,true);assert.equal(again.convergence,'blocked');
  assert.deepEqual(again.blockers,first.blockers);assert.equal(again.boardCommit,first.boardCommit);
}));

test('a new obligation or an interrupted head is not mistaken for equilibrium',()=>withState(async stateDir=>{
  const {governance}=stubGovernance();
  await runRuntime({stateDir,obligations:[spec('a')],workers:[worker],governance});
  const grown=await runRuntime({stateDir,obligations:[spec('a'),spec('b',['a'])],workers:[worker],governance});
  assert.equal(grown.reused,undefined);assert.equal(grown.convergence,'accepted_change');assert.equal(grown.dispatches,1);
  let calls=0;
  const fault=async event=>{if(event==='after-work-persisted'&&calls++===0)throw Error('controller died after persistence');};
  await assert.rejects(runRuntime({stateDir,obligations:[spec('a'),spec('b',['a']),spec('c')],workers:[worker],governance,fault}),/controller died/);
  assert.equal(loadRuntime(stateDir).events.at(-1).type,'work.persisted');
  const resumed=await runRuntime({stateDir,obligations:[spec('a'),spec('b',['a']),spec('c')],workers:[worker],governance});
  assert.equal(resumed.reused,undefined);assert.equal(resumed.convergence,'accepted_change');
  assert.equal(verifyRuntimeChain(stateDir).ok,true);
}));

test('work.started records the ready set and rank that determine each assignment',()=>withState(async stateDir=>{
  const {governance}=stubGovernance(),obligations=[spec('a'),spec('b'),spec('c'),spec('d',['a','b','c'])];
  await runRuntime({stateDir,obligations,workers:[worker],governance,slots:2});
  const starts=loadRuntime(stateDir).events.filter(event=>event.type==='work.started');
  const view=starts.map(({id,assignment})=>({id,...assignment}));
  const wave=(ready,rank,id)=>({id,policy:ASSIGNMENT_POLICY,readySetSha:digest(ready),ready:ready.length,rank,slots:2,choice:0});
  assert.deepEqual(view,[wave(['a','b','c'],0,'a'),wave(['a','b','c'],1,'b'),wave(['c'],0,'c'),wave(['d'],0,'d')]);
}));

test('planning requires governance plan registration',()=>withState(async stateDir=>{
  const {governance}=stubGovernance();delete governance.authorizePlan;
  const planning={planner:{id:'p',version:'1',plan:async()=>({})},validatePlan:async()=>({ok:true,obligations:[spec('a')]}),request:{},policy:{}};
  await assert.rejects(runRuntime({stateDir,planning,workers:[worker],governance}),/Governance plan registration required/);
}));

test('release activation accepts only an ok:true decision verification',()=>withState(async stateDir=>{
  const {governance}=stubGovernance({
    issueActivationDecision:async input=>({signed:input}),
    verifyActivationDecision:async()=>({valid:true}),
  });
  await runRuntime({stateDir,obligations:[],workers:[worker],governance});
  const release={id:'r2',artifactSha:'a'.repeat(64),stateSchema:'ophanim.runtime/v1',planRef:'sha256:'+'b'.repeat(64),
    workers:[{id:'w',version:'1',kinds:['k'],scopes:['s']}]};
  await assert.rejects(activateRelease({stateDir,release,governance}),/Release decision refused/);
  assert.equal(loadRuntime(stateDir).activeRelease,'baseline');
}));

test('governance requires an explicit TELOS checkout',async()=>{
  await assert.rejects(createGovernance({root:path.join(os.tmpdir(),'ophanim-no-telos')}),/Explicit absolute TELOS checkout required/);
});

test('the runtime chain verifies every transition and recomputes assignments',()=>withState(async stateDir=>{
  const {governance}=stubGovernance(),obligations=[spec('a'),spec('b'),spec('c'),spec('d',['a','b','c']),spec('x',[],{refuse:true})];
  await runRuntime({stateDir,obligations,workers:[worker],governance,slots:2});
  await runRuntime({stateDir,obligations:[...obligations,spec('e',['d'])],workers:[worker],governance,slots:3});
  const chain=verifyRuntimeChain(stateDir);
  assert.equal(chain.ok,true);assert.equal(chain.head,readRuntimeSnapshot(stateDir).commit);
  assert.equal(chain.commits,loadRuntime(stateDir).revision);assert.equal(chain.assignmentsChecked,6);assert.equal(chain.legacyAssignments,0);
}));

test('the runtime chain refuses a rewritten accepted obligation',()=>withState(async stateDir=>{
  const {governance}=stubGovernance();
  await runRuntime({stateDir,obligations:[spec('a'),spec('b',['a'])],workers:[worker],governance});
  await withRuntimeBoard(stateDir,async board=>{
    board.state.obligations.a.accepted.output.id='substituted';
    await board.save(board.state,{type:'fixture.tamper'});
  });
  assert.throws(()=>verifyRuntimeChain(stateDir),/accepted obligation changed: a/);
}));

test('the runtime chain refuses an assignment that does not follow from the ready set',()=>withState(async stateDir=>{
  const {governance}=stubGovernance();
  await runRuntime({stateDir,obligations:[spec('a'),spec('b')],workers:[worker],governance,slots:2});
  await withRuntimeBoard(stateDir,async board=>{
    board.state.obligations.c={spec:spec('c'),status:'running',attempt:1,releaseAttempts:1,candidate:null,history:[],reason:null};
    await board.save(board.state,{type:'work.started',id:'c',attempt:1,worker:'w',
      assignment:{policy:'ophanim.assignment.sorted-id-round-robin/v1',readySetSha:digest(['c']),ready:1,rank:0,slots:1,choice:0}});
  });
  assert.throws(()=>verifyRuntimeChain(stateDir),/assignment does not follow/);
}));

test('efficiency debits are write-once per trace and totals are derived',()=>withState(async stateDir=>{
  const usesDir=path.join(stateDir,'uses');fs.mkdirSync(usesDir);
  const sha=n=>String(n).repeat(64);
  recordAssessmentDebit({usesDir,useFile:path.join(usesDir,'one.json'),traceSha:sha(1),assessmentCostMs:10,charged:true});
  // Re-assessing the same trace does not charge it twice, even with a new measurement.
  recordAssessmentDebit({usesDir,useFile:path.join(usesDir,'one.json'),traceSha:sha(1),assessmentCostMs:99,charged:true});
  recordAssessmentDebit({usesDir,useFile:path.join(usesDir,'one.json'),traceSha:sha(2),assessmentCostMs:7,charged:false,interrupted:{traceSha:sha(3)}});
  recordAssessmentDebit({usesDir,useFile:path.join(usesDir,'two.json'),traceSha:sha(4),assessmentCostMs:5,charged:true,interrupted:{traceSha:sha(3)}});
  fs.writeFileSync(path.join(usesDir,'assessment-costs','legacy.json'),JSON.stringify({additionalAssessmentCostMs:4,unmeasuredAssessments:1}));
  assert.deepEqual(readAssessmentDebits(usesDir),{additionalAssessmentCostMs:19,unmeasuredAssessments:3});
  fs.writeFileSync(path.join(usesDir,'assessment-costs','one','stray.json'),'{}');
  assert.throws(()=>readAssessmentDebits(usesDir),/Unexpected efficiency ledger record/);
}));

function recordKinds(stateDir){
  const board=openBoard(boardPath(stateDir)),kinds=[];
  for(let cid=board.refs.resolve('refs/board/ophanim');cid;){
    const commit=board.store.get(cid);
    kinds.unshift(commit.records.map(r=>board.store.get(r)).find(e=>e.kind==='trace').payload.test);
    cid=commit.parents[0]??null;
  }
  return kinds;
}

test('intermediate commits are deltas and settled heads are full checkpoints',()=>withState(async stateDir=>{
  const {governance}=stubGovernance(),obligations=[spec('a'),spec('b',['a']),spec('c',['b'])];
  const result=await runRuntime({stateDir,obligations,workers:[worker],governance});
  const kinds=recordKinds(stateDir);
  assert.equal(kinds.length,result.state.revision);
  assert.equal(kinds[0],'ophanim-state');assert.equal(kinds.at(-1),'ophanim-state');
  assert.ok(kinds.slice(1,-1).every(kind=>kind==='ophanim-state-delta'));
  assert.equal(digest(loadRuntime(stateDir)),digest(result.state));
  const chain=verifyRuntimeChain(stateDir);
  assert.equal(chain.deltas,kinds.length-2);
  // Every intermediate head materializes to the state its delta recorded.
  const board=openBoard(boardPath(stateDir));
  for(let cid=board.refs.resolve('refs/board/ophanim');cid;cid=board.store.get(cid).parents[0]??null)
    assert.equal(readRuntimeSnapshot(stateDir,cid).state.revision>0,true);
}));

test('an interrupted delta head materializes for recovery',()=>withState(async stateDir=>{
  const {governance}=stubGovernance(),obligations=[spec('a'),spec('b',['a'])];
  const fault=async event=>{if(event==='after-work-persisted')throw Error('controller died');};
  await assert.rejects(runRuntime({stateDir,obligations,workers:[worker],governance,fault}),/controller died/);
  assert.equal(recordKinds(stateDir).at(-1),'ophanim-state-delta');
  assert.equal(loadRuntime(stateDir).obligations.a.status,'gating');
  const resumed=await runRuntime({stateDir,obligations,workers:[worker],governance});
  assert.equal(resumed.complete,true);assert.equal(verifyRuntimeChain(stateDir).ok,true);
}));

test('a long session takes a checkpoint every interval',()=>withState(async stateDir=>{
  const {governance}=stubGovernance(),obligations=Array.from({length:20},(_,i)=>spec(`o${String(i).padStart(2,'0')}`));
  const result=await runRuntime({stateDir,obligations,workers:[worker],governance,slots:4});
  assert.ok(result.state.revision>CHECKPOINT_INTERVAL+2);
  const kinds=recordKinds(stateDir);
  let run=0,longest=0;for(const kind of kinds){run=kind==='ophanim-state-delta'?run+1:0;longest=Math.max(longest,run);}
  assert.equal(longest,CHECKPOINT_INTERVAL);
  assert.equal(verifyRuntimeChain(stateDir).ok,true);
}));

test('a delta whose recorded result differs is refused when materialized',()=>withState(async stateDir=>{
  const {governance}=stubGovernance();
  await runRuntime({stateDir,obligations:[spec('a')],workers:[worker],governance});
  const prior=loadRuntime(stateDir),next=structuredClone(prior);
  next.revision++;next.events.push({sequence:next.revision,type:'fixture.forged'});
  const delta=diffState(prior,next);delta.changed.activeRelease='forged';
  const board=openBoard(boardPath(stateDir));
  const written=await publish({...board,ref:'refs/board/ophanim',author:{vendor:'controller'},budgetCheck:false,
    entries:[{kind:'trace',payload:{test:'ophanim-state-delta'},blob:canonical(delta)}],msg:'forged'});
  assert.equal(written.ok,true);
  assert.throws(()=>loadRuntime(stateDir),/differs from its recorded state digest/);
  assert.throws(()=>verifyRuntimeChain(stateDir),/differs from its recorded state digest/);
}));

test('boards written as full v1 snapshots still decode and verify',()=>withState(async stateDir=>{
  const {governance}=stubGovernance();
  await runRuntime({stateDir,obligations:[spec('a')],workers:[worker],governance});
  const state=loadRuntime(stateDir),board=openBoard(boardPath(stateDir));
  for(const type of ['fixture.one','fixture.two']){
    state.revision++;state.events.push({sequence:state.revision,type});
    const written=await publish({...board,ref:'refs/board/ophanim',author:{vendor:'controller'},budgetCheck:false,
      entries:[{kind:'trace',payload:{test:'ophanim-state'},blob:canonical(state)}],msg:type});
    assert.equal(written.ok,true);
  }
  assert.equal(digest(loadRuntime(stateDir)),digest(state));
  assert.equal(verifyRuntimeChain(stateDir).ok,true);
}));
