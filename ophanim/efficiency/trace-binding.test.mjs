import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,digest,STATE_SCHEMA} from '../board.mjs';
import {applicabilityFingerprint} from './analyze.mjs';
import {verifyAdmissionTrace} from './trace-binding.mjs';

function fixture(){
  const spec={id:'one',kind:'step',scope:'department:ops',dependsOn:[],inputs:{raw:'synthetic'},expected:{value:'accepted'},outputKey:'one',maxAttempts:2};
  const worker={id:'worker',version:'1',kinds:['step'],scopes:['department:ops']};
  const candidate={id:'one:1',sha256:digest(spec.expected),output:spec.expected,checks:[]};
  const evidence={attempt:1,totalAttempt:1,dependencyVersions:[],stateSchema:STATE_SCHEMA};
  const request={candidate:{id:candidate.id,sha256:candidate.sha256,output:candidate.output},obligation:spec,worker,evidence};
  const proof={ok:true,planRef:'sha256:'+'a'.repeat(64),obligationId:spec.id,obligationSha:digest(spec),candidateSha:candidate.sha256,evidenceRefs:['sha256:'+'a'.repeat(64),'sha256:'+digest(request)]};
  const published={commit:'commit:'+'b'.repeat(64),entry:'entry:'+'c'.repeat(64),blob:'blob:'+'d'.repeat(64)};
  const policy={schema:'fixture-policy',replayBudgetMs:30000,maxQualifiedConvergences:20};
  const configuration={slots:1,workerRegistry:[worker],workerArtifactSha:'e'.repeat(64),policySha:digest(policy),inputRevision:'input-r1'};
  const obligation={id:spec.id,kind:spec.kind,scope:spec.scope,dependsOn:[],specSha:digest(spec),status:'accepted',acceptedAttempt:1,acceptedAt:25};
  const scopeSha=applicabilityFingerprint({obligations:[obligation],configuration});
  const events=[
    {type:'runtime.opened',atMs:10,slots:1,release:'baseline',efficiencyContext:{scopeSha,configuration,policy}},
    {type:'work.started',atMs:12,id:'one',attempt:1,worker:worker.id},
    {type:'work.persisted',atMs:20,id:'one',attempt:1,sha256:candidate.sha256},
    {type:'gate.accepted',atMs:24,id:'one',attempt:1,sha256:candidate.sha256},
    {type:'work.accepted',atMs:25,id:'one',attempt:1,sha256:candidate.sha256},
    {type:'runtime.settled',atMs:30,accepted:1,held:0,dispatches:1,convergence:'accepted_change',blockers:[]},
  ];
  const state={schema:STATE_SCHEMA,revision:events.length,events:events.map((event,index)=>({sequence:index+1,...event})),obligations:{one:{spec,status:'accepted',attempt:1,accepted:{output:spec.expected,sha256:candidate.sha256,worker,planRef:proof.planRef,verification:proof,attempt:1},candidate:{candidate,worker,evidence,published}}},effects:{},activeRelease:'baseline',releases:{baseline:{id:'baseline',workers:[worker]}}};
  const {expected,...brief}=spec,inputs={...spec.inputs,dependencies:{}};
  const snapshot={commit:'commit:'+'f'.repeat(64),state};
  const trace={schema:'ophanim.efficiency.trace/v1',boardCommit:snapshot.commit,stateSha:digest(state),scopeSha,configuration,policy,release:state.releases.baseline,
    obligations:[obligation],accepted:[{id:spec.id,specSha:digest(spec),outputSha:candidate.sha256,planRef:proof.planRef,evidenceRefs:proof.evidenceRefs,publication:published}],events,
    attempts:[{id:'one',attempt:1,startedAt:12,endedAt:20,status:'produced',inputSha:digest(inputs),inputBytes:Buffer.byteLength(canonical(inputs)),contextBytes:Buffer.byteLength(canonical({obligation:brief,inputs,priorAttempts:0}))}],
    verifications:[{id:'one',attempt:1,startedAt:21,endedAt:23,purpose:'accept',candidateSha:candidate.sha256,ok:true}],
    window:{startedAt:5,endedAt:35},original:{convergence:'accepted_change',slots:1,outputSha:digest({one:spec.expected}),effectSha:digest([]),durationMs:30,modelCalls:0}};
  return {trace:structuredClone(trace),snapshot:structuredClone(snapshot)};
}

test('fresh trace binds graph, accepted request, events, inputs and check envelopes',()=>{
  const {trace,snapshot}=fixture(),result=verifyAdmissionTrace(trace,snapshot);
  assert.equal(result.ok,true);assert.equal(result.complete,true);assert.equal(result.scopeMatchesRequest,true);
  assert.deepEqual(result.verified,{obligations:1,attempts:1,verificationEnvelopes:1});
  assert.equal(result.limits.exactVerifierDurationsAuthenticated,false);
  assert.equal(result.limits.signatureVerification,false);
  assert.equal(verifyAdmissionTrace(trace,snapshot.state).boardCommit,null);
});

test('self-consistent fabricated observations cannot replace committed measurements',()=>{
  for(const [modify,pattern] of [
    [trace=>{trace.attempts[0].startedAt=11;},/attempt timing/],
    [trace=>{trace.attempts[0].inputBytes++;},/inputBytes/],
    [trace=>{trace.obligations[0].scope='department:other';},/obligation graph/],
    [trace=>{trace.events.splice(1,1);},/omits or changes/],
    [trace=>{trace.configuration.slots=3;trace.original.slots=3;},/projection differs/],
    [trace=>{trace.policy.replayBudgetMs=60000;},/policy\/configuration/],
    [trace=>{trace.original.effectSha='0'.repeat(64);},/projection differs/],
    [trace=>{trace.original.outputSha='0'.repeat(64);},/projection differs/],
  ]){const {trace,snapshot}=fixture();modify(trace);assert.throws(()=>verifyAdmissionTrace(trace,snapshot),pattern);}
});

test('verification samples must match candidate, gate decision, timing envelope and exact count',()=>{
  for(const [modify,pattern] of [
    [trace=>{trace.verifications[0].candidateSha='0'.repeat(64);},/candidate differs/],
    [trace=>{trace.verifications[0].ok=false;},/result differs/],
    [trace=>{trace.verifications[0].endedAt=25;},/envelope/],
    [trace=>{trace.verifications=[];},/observations are missing/],
    [trace=>{trace.verifications.push({...trace.verifications[0],startedAt:23,endedAt:23});},/result differs/],
    [trace=>{trace.verifications[0].purpose='replay';},/replay verification differs/],
  ]){const {trace,snapshot}=fixture();modify(trace);assert.throws(()=>verifyAdmissionTrace(trace,snapshot),pattern);}
});

test('old traces require explicit legacy mode and never return complete assurance',()=>{
  const {trace,snapshot}=fixture();delete snapshot.state.events[0].efficiencyContext;delete trace.events[0].efficiencyContext;
  trace.stateSha=digest(snapshot.state);
  assert.throws(()=>verifyAdmissionTrace(trace,snapshot),/efficiency context required/);
  const result=verifyAdmissionTrace(trace,snapshot,{legacy:true});
  assert.equal(result.complete,false);assert.ok(result.missing.includes('committed-policy-context'));
  trace.attempts[0].inputSha='0'.repeat(64);
  assert.throws(()=>verifyAdmissionTrace(trace,snapshot,{legacy:true}),/inputSha/);
});

test('retained accepted replay checks are bound to current opening and cannot be relabeled as new work',()=>{
  const {trace,snapshot}=fixture();
  const opened={type:'runtime.opened',atMs:50,slots:1,release:'baseline',efficiencyContext:snapshot.state.events[0].efficiencyContext};
  const settled={type:'runtime.settled',atMs:60,accepted:1,held:0,dispatches:0,convergence:'no_change',blockers:[]};
  snapshot.state.events.push({sequence:7,...opened},{sequence:8,...settled});snapshot.state.revision=8;trace.stateSha=digest(snapshot.state);
  trace.events=[opened,settled];trace.attempts=[];trace.verifications[0]={...trace.verifications[0],purpose:'replay',startedAt:41,endedAt:48};
  trace.window={startedAt:40,endedAt:65};trace.original.durationMs=25;trace.original.convergence='no_change';
  assert.equal(verifyAdmissionTrace(trace,snapshot).complete,true);
  trace.verifications[0].endedAt=51;assert.throws(()=>verifyAdmissionTrace(trace,snapshot),/opening boundary/);
});
