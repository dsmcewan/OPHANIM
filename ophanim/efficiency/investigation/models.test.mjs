import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../../board.mjs';
import {buildContributionRegistry, discoverVariables} from '../contributions.mjs';
import {buildFunctionalModels} from './models.mjs';

const sha=character=>character.repeat(64);
function trace(){
  return {
    boardCommit:`commit:${sha('1')}`,stateSha:sha('2'),configuration:{slots:1,workerRegistry:[{id:'worker',version:'1',kinds:['step'],scopes:['department:ops']}],
      workerArtifactSha:sha('a'),policySha:sha('b'),inputRevision:'r1'},
    release:{id:'baseline'},window:{startedAt:0,endedAt:35},original:{convergence:'accepted_change',outputSha:sha('e'),effectSha:sha('f')},
    obligations:[{id:'a',kind:'step',scope:'department:ops',dependsOn:[],specSha:sha('1'),status:'accepted',acceptedAttempt:2,acceptedAt:20}],
    attempts:[{id:'a',attempt:1,startedAt:0,endedAt:5,inputSha:sha('3'),inputBytes:10,contextBytes:20},
      {id:'a',attempt:2,startedAt:7,endedAt:18,inputSha:sha('3'),inputBytes:10,contextBytes:20}],
    verifications:[{id:'a',attempt:2,startedAt:18,endedAt:20,purpose:'accept',candidateSha:sha('4'),ok:true}],
    events:[{type:'work.failed',id:'a',attempt:1,atMs:5},{type:'work.accepted',id:'a',attempt:2,atMs:20},
      {type:'runtime.settled',convergence:'accepted_change',accepted:1,atMs:20}],
  };
}

test('the same 14 functions retain their contracts and evidence binding',()=>{
  const input=trace(),registry=buildContributionRegistry({trace:input}),variables=discoverVariables({trace:input,registry});
  const model=buildFunctionalModels({trace:input,registry,variables});
  assert.equal(model.schema,'ophanim.functional-models/v1');
  assert.equal(model.traceSha,digest(input));
  assert.equal(model.scopeSha,registry.scopeSha);
  assert.deepEqual(model.system.result,input.original);
  assert.equal(model.functions.length,14);
  assert.deepEqual(model,buildFunctionalModels({trace:input}));
  const {modelSha,...body}=model;
  assert.equal(modelSha,digest(body));
  for(const [index,fn] of model.functions.entries()){
    const source=registry.components[index];
    assert.equal(fn.id,source.id);
    assert.deepEqual(fn.contract,source.contract);
    assert.deepEqual(fn.dependencies,source.dependencies);
    assert.deepEqual(fn.requiredContribution.requiredBy,source.consumers);
    assert.equal(fn.implementationConditions.redundant.status,'not-established');
    assert.ok(fn.immutableRequirements.systemInvariantRefs.includes('controller-authority'));
  }
  assert.deepEqual(model.authority,{executeInvestigation:false,verifyPolicy:false,activatePolicy:false});
});

test('only qualified variable levels are identified and scope guardrails remain immutable',()=>{
  const model=buildFunctionalModels({trace:trace()}),byId=new Map(model.functions.map(fn=>[fn.id,fn]));
  const concurrency=byId.get('concurrency');
  assert.deepEqual(concurrency.controllableVariables.find(variable=>variable.id==='scheduler-slots').permittedRange,
    {kind:'allowed-levels',levels:[1,3],qualification:'independent-controlled-replay-required'});
  assert.equal(byId.get('worker-routing').controllableVariables.find(variable=>variable.id==='provider-allocation').permittedRange.kind,'unqualified');
  assert.equal(byId.get('review').controllableVariables.find(variable=>variable.id==='required-review-and-acceptance').permittedRange.kind,'fixed');
  assert.ok(concurrency.environmentalVariables.some(factor=>factor.id==='host-and-storage-contention'));
  assert.ok(concurrency.interactions.every(interaction=>interaction.evidenceClass==='structural'&&interaction.causalStatus==='unmeasured'));
  assert.ok(concurrency.hypotheses.length&&concurrency.hypotheses.every(hypothesis=>hypothesis.status==='untested'));
  assert.equal(byId.get('worker-reasoning').failureBehavior.events[0].count,1);
  assert.equal(byId.get('worker-reasoning').implementationConditions.deterministic.status,'current-synthetic-mechanism');
  assert.equal(byId.get('review').implementationConditions.replaceable.status,'mechanism-only');
});

test('shared and missing metrics preserve uncertainty',()=>{
  const input=trace(),model=buildFunctionalModels({trace:input});
  const context=model.functions.find(fn=>fn.id==='context'),board=model.functions.find(fn=>fn.id==='board-integrity');
  assert.equal(context.observations[0].value,40);
  assert.equal(context.observations[0].evidence.kind,'trace-measurement');
  assert.equal(context.uncertainty[0].reason,'shared-attribution');
  assert.equal(board.observations[0].value,null);
  assert.equal(board.uncertainty[0].reason,'measurement-unavailable');
  const recovered=buildFunctionalModels({trace:{...input,recovery:{measurementCoverage:'unavailable'}}});
  assert.equal(recovered.functions.find(fn=>fn.id==='worker-reasoning').failureBehavior.events[0].count,null);
});

test('independent observations evolve the model without converting comparison to causality',()=>{
  const input=trace(),base=buildFunctionalModels({trace:input}),reference={receiptSha:sha('d'),observationId:'check-wall'};
  const observed={schema:'ophanim.functional-observation/v1',id:reference.observationId,receiptSha:reference.receiptSha,
    scopeSha:base.scopeSha,componentId:'review',metric:'verification.totalMs',unit:'ms',value:2,samples:8,method:'controlled-comparison'};
  const model=buildFunctionalModels({trace:input,verifiedObservations:[reference],verifyObservation:resolved=>{
    assert.deepEqual(resolved,reference);
    return observed;
  }});
  assert.notEqual(base.modelSha,model.modelSha);
  assert.equal(base.traceSha,model.traceSha);
  assert.deepEqual(model.evidenceBinding.observationReceiptShas,[reference.receiptSha]);
  const review=model.functions.find(fn=>fn.id==='review');
  const measurement=review.observations.find(row=>row.evidence.kind==='independently-verified');
  assert.equal(measurement.causalStatus,'not-established');
  assert.deepEqual(measurement.evidence.refs,[reference.receiptSha]);
  assert.ok(review.uncertainty.some(row=>row.metric===measurement.metric&&row.status==='unresolved'));
});

test('unverified, duplicate, mismatched, and causal claims cannot enter the model',()=>{
  const input=trace(),base=buildFunctionalModels({trace:input}),reference={receiptSha:sha('d'),observationId:'check-wall'};
  const observation={schema:'ophanim.functional-observation/v1',id:reference.observationId,receiptSha:reference.receiptSha,
    scopeSha:base.scopeSha,componentId:'review',metric:'verification.totalMs',unit:'ms',value:2,samples:8,method:'controlled-comparison'};
  assert.throws(()=>buildFunctionalModels({trace:input,verifiedObservations:[reference]}),/independent observation resolver required/);
  assert.throws(()=>buildFunctionalModels({trace:input,verifiedObservations:[{...reference,verified:true}],verifyObservation:()=>observation}),/exact observation reference/);
  assert.throws(()=>buildFunctionalModels({trace:input,verifiedObservations:[reference,reference],verifyObservation:()=>observation}),/duplicate observation/);
  for(const alteration of [{scopeSha:sha('e')},{receiptSha:sha('f')},{causalStatus:'proven'},{value:Infinity},{method:'hypothesis'}]){
    assert.throws(()=>buildFunctionalModels({trace:input,verifiedObservations:[reference],verifyObservation:()=>({...observation,...alteration})}),/scope, or measurement differs/);
  }
  const registry=buildContributionRegistry({trace:input}),variables=discoverVariables({trace:input,registry});
  assert.throws(()=>buildFunctionalModels({trace:{...input,stateSha:sha('5')},registry,variables}),/trace and catalog bindings differ/);
});
