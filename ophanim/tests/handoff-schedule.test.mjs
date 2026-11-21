import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runRuntime,loadRuntime,handoffFrontier,REFILL_POLICY} from '../runtime.mjs';
import {canonical,digest,readRuntimeSnapshot,verifyRuntimeChain,withRuntimeBoard} from '../board.mjs';
import {applicabilityFingerprint} from '../efficiency/analyze.mjs';
import {verifyAdmissionTrace} from '../efficiency/trace-binding.mjs';

// Stub authority returning the proof shape the trace binding checks. It is
// not TELOS: these tests exercise the controller and the binding only.
function authority() {
  const calls=[],accepted=new Set();
  return {calls,accepted,governance:{
    authorizePlan:async()=>({ok:true}),
    verifyCandidate:async({candidate,obligation,worker,evidence})=>{
      const startedAt=Date.now();
      // Real verification takes time: replays before runtime.opened then end in an earlier millisecond.
      await new Promise(resolve=>setTimeout(resolve,2));
      const request={candidate:{id:candidate.id,sha256:candidate.sha256,output:candidate.output},obligation,worker,evidence};
      const planRef='sha256:'+digest({plan:request});
      const result={ok:true,planRef,obligationId:obligation.id,obligationSha:digest(obligation),candidateSha:candidate.sha256,
        evidenceRefs:[planRef,'sha256:'+digest(request)]};
      calls.push({id:obligation.id,attempt:evidence.totalAttempt??evidence.attempt,startedAt,endedAt:Date.now(),
        purpose:accepted.has(obligation.id)?'replay':'accept',candidateSha:candidate.sha256,ok:true});
      return result;
    },
  }};
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Deterministic worker whose output is what the obligation declares it expects.
function makeWorker(delays={}) {
  return {id:'w',version:'1',kinds:['k'],scopes:['s'],run:async({obligation,inputs})=>{
    await delay(delays[obligation.id]??0);
    return {output:expectedFor(obligation.id,Object.keys(inputs.dependencies))};
  }};
}
const expectedFor=(id,deps)=>({id,deps:[...deps].sort()});
const spec=(id,dependsOn=[])=>({id,kind:'k',scope:'s',outputKey:id,dependsOn,inputs:{},expected:expectedFor(id,dependsOn),maxAttempts:1});
async function withState(fn){
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-handoff-'));
  try{return await fn(stateDir);}finally{fs.rmSync(stateDir,{recursive:true,force:true});}
}
const policy={schema:'fixture-policy',replayBudgetMs:30000,maxQualifiedConvergences:20};
const configuration={slots:1,workerRegistry:[{id:'w',version:'1',kinds:['k'],scopes:['s']}],workerArtifactSha:'e'.repeat(64),policySha:digest(policy),inputRevision:'input-r1'};
const efficiencyContext={scopeSha:'f'.repeat(64),configuration,policy};

// Rebuilds the trace an assessment would retain, from committed events only.
function traceFor(snapshot,verifications){
  const state=snapshot.state,eventValue=({sequence,...event})=>event;
  const openedIndex=state.events.findLastIndex(event=>event.type==='runtime.opened');
  const opened=state.events[openedIndex],settled=state.events.at(-1);
  const acceptedAt=row=>state.events.findLast(event=>event.type==='work.accepted'&&event.id===row.spec.id&&event.attempt===row.accepted?.attempt)?.atMs;
  const rows=Object.values(state.obligations).sort((a,b)=>a.spec.id.localeCompare(b.spec.id));
  const obligations=rows.map(row=>({id:row.spec.id,kind:row.spec.kind,scope:row.spec.scope,dependsOn:row.spec.dependsOn,specSha:digest(row.spec),status:row.status,
    ...(row.accepted?{acceptedAttempt:row.accepted.attempt,acceptedAt:acceptedAt(row)}:{})}));
  const accepted=rows.filter(row=>row.status==='accepted').map(row=>({id:row.spec.id,specSha:digest(row.spec),outputSha:row.accepted.sha256,
    planRef:row.accepted.planRef,evidenceRefs:row.accepted.verification.evidenceRefs,publication:row.candidate.published}));
  const after=state.events.slice(openedIndex);
  const attempts=after.filter(event=>event.type==='work.started').map(start=>{
    const end=after.find(event=>['work.persisted','work.failed'].includes(event.type)&&event.id===start.id&&event.attempt===start.attempt);
    const row=state.obligations[start.id],{expected,...brief}=row.spec;
    const inputs={...row.spec.inputs,dependencies:Object.fromEntries(row.spec.dependsOn.map(id=>[id,{output:state.obligations[id].accepted.output,sha256:state.obligations[id].accepted.sha256}]))};
    return {id:start.id,attempt:start.attempt,startedAt:start.atMs,endedAt:end.atMs,status:'produced',inputSha:digest(inputs),
      inputBytes:Buffer.byteLength(canonical(inputs)),contextBytes:Buffer.byteLength(canonical({obligation:brief,inputs,priorAttempts:start.attempt-1}))};
  });
  const outputs=Object.fromEntries(rows.filter(row=>row.status==='accepted').map(row=>[row.spec.id,row.accepted.output]));
  const startedAt=Math.min(opened.atMs,...verifications.map(v=>v.startedAt));
  return {schema:'ophanim.efficiency.trace/v1',boardCommit:snapshot.commit,stateSha:digest(state),configuration,policy,
    scopeSha:applicabilityFingerprint({obligations,configuration}),release:state.releases[state.activeRelease],obligations,accepted,
    // As in a real assessment, the window opens with the run, which precedes the handoff
    // verifications that happen before runtime.opened; it may not start at the opening event.
    events:after.map(eventValue),attempts,verifications,window:{startedAt,endedAt:settled.atMs},
    original:{convergence:settled.convergence,slots:1,outputSha:digest(outputs),effectSha:digest([]),durationMs:settled.atMs-startedAt,modelCalls:0}};
}

// a, b accepted first; then c (needs a) is added. Only a is on the frontier.
async function twoRuns(stateDir,handoffVerification){
  const auth=authority(),worker=makeWorker(),first=[spec('a'),spec('b')];
  await runRuntime({stateDir,obligations:first,workers:[worker],governance:auth.governance,efficiencyContext});
  ['a','b'].forEach(id=>auth.accepted.add(id));auth.calls.length=0;
  const result=await runRuntime({stateDir,obligations:[...first,spec('c',['a'])],workers:[worker],governance:auth.governance,efficiencyContext,handoffVerification});
  return {auth,result};
}

test('frontier handoff re-verifies only accepted rows that open work consumes',()=>withState(async stateDir=>{
  const {auth,result}=await twoRuns(stateDir,'frontier');
  assert.equal(result.convergence,'accepted_change');
  assert.deepEqual(result.handoff,{mode:'frontier',verified:['a'],skipped:1});
  assert.deepEqual(auth.calls.filter(call=>call.purpose==='replay').map(call=>call.id),['a']);
  const opened=loadRuntime(stateDir).events.findLast(event=>event.type==='runtime.opened');
  assert.deepEqual(opened.handoff,{mode:'frontier',verified:['a']});
  // The default records nothing new and re-verifies every accepted row.
  await withState(async other=>{
    const full=await twoRuns(other,'full');
    assert.deepEqual(full.auth.calls.filter(call=>call.purpose==='replay').map(call=>call.id),['a','b']);
    assert.equal(loadRuntime(other).events.findLast(event=>event.type==='runtime.opened').handoff,undefined);
  });
}));

test('the trace binding accepts exactly the recorded frontier replays',()=>withState(async stateDir=>{
  const {auth}=await twoRuns(stateDir,'frontier');
  const snapshot=readRuntimeSnapshot(stateDir),trace=traceFor(snapshot,auth.calls);
  const binding=verifyAdmissionTrace(trace,snapshot);
  assert.equal(binding.complete,true);
  // Dropping the frontier replay leaves a required observation missing.
  const missing=traceFor(snapshot,auth.calls.filter(call=>call.purpose!=='replay'));
  assert.throws(()=>verifyAdmissionTrace(missing,snapshot),/verification observations are missing/);
  // A recorded frontier that omits a consumed dependency is refused.
  const forged=structuredClone(snapshot);
  const index=forged.state.events.findLastIndex(event=>event.type==='runtime.opened');
  forged.state.events[index].handoff.verified=[];
  const forgedTrace=traceFor(forged,auth.calls.filter(call=>call.purpose!=='replay'));
  assert.throws(()=>verifyAdmissionTrace(forgedTrace,forged),/handoff frontier differs/);
}));

test('frontier handoff requires the verified transition chain',()=>withState(async stateDir=>{
  const auth=authority(),worker=makeWorker(),first=[spec('a'),spec('b')];
  await runRuntime({stateDir,obligations:first,workers:[worker],governance:auth.governance});
  // Rewrite a row the frontier would skip; only the chain check sees it.
  await withRuntimeBoard(stateDir,async board=>{
    board.state.obligations.b.history.push({attempt:9,status:'accepted',worker:'w',candidateSha:'0'.repeat(64)});
    await board.save(board.state,{type:'fixture.tamper'});
  });
  await assert.rejects(runRuntime({stateDir,obligations:[...first,spec('c',['a'])],workers:[worker],governance:auth.governance,handoffVerification:'frontier'}),
    /accepted obligation changed: b/);
}));

test('a settled head reused under frontier handoff makes no TELOS calls',()=>withState(async stateDir=>{
  const auth=authority(),worker=makeWorker(),obligations=[spec('a'),spec('b',['a'])];
  await runRuntime({stateDir,obligations,workers:[worker],governance:auth.governance});
  auth.calls.length=0;
  const again=await runRuntime({stateDir,obligations,workers:[worker],governance:auth.governance,handoffVerification:'frontier'});
  assert.equal(again.reused,true);assert.equal(auth.calls.length,0);
  assert.deepEqual(again.handoff,{mode:'frontier',verified:[],skipped:2});
  assert.deepEqual(handoffFrontier(loadRuntime(stateDir).obligations),[]);
}));

test('refill scheduling fills a freed slot before the slow attempt finishes',()=>withState(async stateDir=>{
  // a is slow; b, c, d are quick. With two slots, wave waits for a before
  // starting c; refill starts c and d as soon as b settles.
  // a's duration must exceed the controller's per-attempt overhead for b and c with room to spare: at 120 ms a loaded
  // CI runner settled a first (CI on 75945ea: +a +b =b +c =a +d). 1500 ms keeps the property under load.
  const worker=makeWorker({a:1500}),obligations=[spec('a'),spec('b'),spec('c'),spec('d')];
  const order=async (dir,schedule)=>{
    const auth=authority();
    const result=await runRuntime({stateDir:dir,obligations,workers:[worker],governance:auth.governance,slots:2,schedule});
    assert.equal(result.complete,true);
    const events=loadRuntime(dir).events;
    return events.filter(event=>['work.started','work.accepted'].includes(event.type)).map(event=>`${event.type==='work.started'?'+':'='}${event.id}`);
  };
  const refill=await order(stateDir,'refill');
  assert.ok(refill.indexOf('+c')<refill.indexOf('=a'),refill.join(' '));
  assert.ok(refill.indexOf('+d')<refill.indexOf('=a'),refill.join(' '));
  await withState(async other=>{
    const wave=await order(other,'wave');
    assert.ok(wave.indexOf('+c')>wave.indexOf('=a'),wave.join(' '));
  });
  const starts=loadRuntime(stateDir).events.filter(event=>event.type==='work.started');
  assert.ok(starts.every(event=>event.assignment.policy===REFILL_POLICY&&Array.isArray(event.assignment.inFlight)));
  assert.deepEqual(starts.find(event=>event.id==='c').assignment.inFlight,['a']);
  const chain=verifyRuntimeChain(stateDir);
  assert.equal(chain.assignmentsChecked,4);
  const opened=loadRuntime(stateDir).events.findLast(event=>event.type==='runtime.opened');
  assert.equal(opened.schedule,'refill');
}));

test('refill produces the same accepted outputs as wave scheduling',()=>withState(async stateDir=>{
  const obligations=[spec('a'),spec('b'),spec('c',['a']),spec('d',['b','c']),spec('e')];
  const outputs=async (dir,schedule)=>{
    const result=await runRuntime({stateDir:dir,obligations,workers:[makeWorker({a:30,e:5})],governance:authority().governance,slots:3,schedule});
    return Object.fromEntries(Object.entries(result.state.obligations).map(([id,row])=>[id,row.accepted.output]));
  };
  const refill=await outputs(stateDir,'refill');
  await withState(async other=>assert.deepEqual(refill,await outputs(other,'wave')));
  assert.equal(verifyRuntimeChain(stateDir).ok,true);
}));

test('a refill assignment that hides an attempt in flight is refused',()=>withState(async stateDir=>{
  await runRuntime({stateDir,obligations:[spec('a'),spec('b'),spec('c')],workers:[makeWorker({a:60})],governance:authority().governance,slots:2,schedule:'refill'});
  await withRuntimeBoard(stateDir,async board=>{
    board.state.obligations.z={spec:spec('z'),status:'running',attempt:1,releaseAttempts:1,candidate:null,history:[],reason:null};
    await board.save(board.state,{type:'work.started',id:'z',attempt:1,worker:'w',
      assignment:{policy:REFILL_POLICY,readySetSha:digest(['z']),ready:1,rank:0,slots:2,inFlight:['nope'],choice:0}});
  });
  assert.throws(()=>verifyRuntimeChain(stateDir),/assignment does not follow/);
}));

test('unknown schedule or handoff modes are refused',async()=>{
  await assert.rejects(runRuntime({stateDir:'/x',workers:[makeWorker()],governance:authority().governance,schedule:'greedy'}),/Known schedule/);
  await assert.rejects(runRuntime({stateDir:'/x',workers:[makeWorker()],governance:authority().governance,handoffVerification:'none'}),/Known schedule/);
});
