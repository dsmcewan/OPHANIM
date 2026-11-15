import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {analyzeTrace} from './analyze.mjs';
import {buildContributionRegistry,discoverVariables} from './contributions.mjs';

function fixture(){
  return {
    configuration:{slots:1,workerRegistry:[{id:'worker',version:'1',kinds:['step'],scopes:['department:ops']}],workerArtifactSha:'a'.repeat(64),policySha:'b'.repeat(64),inputRevision:'r1'},
    release:{id:'baseline'},window:{startedAt:0,endedAt:35},
    obligations:[{id:'a',kind:'step',scope:'department:ops',dependsOn:[],specSha:'1'.repeat(64),status:'accepted',acceptedAttempt:1,acceptedAt:12},{id:'b',kind:'step',scope:'department:ops',dependsOn:['a'],specSha:'2'.repeat(64),status:'accepted',acceptedAttempt:1,acceptedAt:30}],
    attempts:[{id:'a',attempt:1,startedAt:0,endedAt:10,inputSha:'3'.repeat(64),inputBytes:10,contextBytes:20},{id:'b',attempt:1,startedAt:15,endedAt:25,inputSha:'4'.repeat(64),inputBytes:15,contextBytes:25}],
    verifications:[{id:'a',attempt:1,startedAt:10,endedAt:12,purpose:'accept',candidateSha:'5'.repeat(64),ok:true},{id:'b',attempt:1,startedAt:25,endedAt:30,purpose:'accept',candidateSha:'6'.repeat(64),ok:true}],
  };
}

test('registry has source-backed purposes, contracts and reciprocal consumers',()=>{
  const trace=fixture(),registry=buildContributionRegistry({trace,analysis:analyzeTrace(trace)});
  const components=new Map(registry.components.map(row=>[row.id,row]));
  assert.equal(components.size,14);
  assert.equal(components.get('efficiency-admission').mechanismClass,'replaceable-mechanism');
  assert.equal(components.get('optimization-authorization').mechanismClass,'required-governance');
  for(const component of components.values()){
    assert.ok(component.purpose);assert.ok(component.contract.inputs.length);assert.ok(component.contract.outputs.length);assert.ok(component.contract.invariants.length);
    assert.ok(['immutable-acceptance','required-governance','replaceable-mechanism'].includes(component.mechanismClass));
    for(const dependency of component.dependencies){assert.ok(components.has(dependency));assert.ok(components.get(dependency).consumers.includes(component.id));}
    for(const source of component.sources){
      assert.equal(source.href,`./${source.path}`);assert.equal(source.relativeTo,'repository-root');
      const file=fileURLToPath(new URL('../../'+source.path,import.meta.url));
      assert.ok(fs.statSync(file).isFile());assert.ok(fs.readFileSync(file,'utf8').includes(source.symbol));
    }
  }
  assert.deepEqual(registry.criticalPath.obligationIds,['a','b']);assert.equal(registry.criticalPath.observedMs,27);
  assert.equal(components.get('context').observations[0].value,45);
  assert.equal(components.get('board-integrity').observations[0].value,null);
  assert.equal(registry.authorization.policyChange,false);
});

test('catalog identity is stable across timing and local paths while evidence stays bound',()=>{
  const first=fixture(),second=fixture();second.window.endedAt=40;second.stateDir='/another/private/path';
  const one=buildContributionRegistry({trace:first}),two=buildContributionRegistry({trace:second});
  assert.equal(one.registrySha,two.registrySha);assert.equal(one.scopeSha,two.scopeSha);
  assert.notEqual(one.evidenceBinding.analysisSha,two.evidenceBinding.analysisSha);
  assert.deepEqual(one,buildContributionRegistry({trace:first}));
  assert.equal(JSON.stringify(one).includes('/another/private/path'),false);
});

test('variable discovery references only the existing slots contract and never authorizes it',()=>{
  const trace=fixture(),registry=buildContributionRegistry({trace}),result=discoverVariables({trace,registry});
  assert.equal(result.candidateReferences.length,1);
  const candidate=result.candidateReferences[0];assert.equal(candidate.id,'scheduler.slots.1-to-3');assert.deepEqual(candidate.change,{field:'slots',from:1,to:3});
  assert.equal(candidate.authorization,'not-evaluated');assert.equal(candidate.mayApply,false);
  const variables=new Map(result.variables.map(row=>[row.id,row]));
  assert.deepEqual(variables.get('scheduler-slots').candidateRefs,[candidate.id]);
  assert.equal(variables.get('provider-allocation').status,'missing-evidence');assert.equal(variables.get('provider-allocation').currentValue,null);
  assert.equal(variables.get('required-review-and-acceptance').status,'protected');assert.deepEqual(variables.get('required-review-and-acceptance').candidateRefs,[]);
  assert.equal(result.authorization.candidateSelection,false);assert.equal(result.authorization.policyChange,false);
  assert.ok(result.environmentalFactors.some(factor=>factor.id==='host-and-storage-contention'));
  assert.deepEqual(result.constraintRefs,registry.invariants.map(invariant=>invariant.id));
  assert.ok(result.variables.every(variable=>variable.interactionRefs.length));
});

test('supplied analysis and registry are checked rather than trusted',()=>{
  const trace=fixture(),analysis=analyzeTrace(trace);analysis.scheduling.workerMs=0;
  assert.throws(()=>buildContributionRegistry({trace,analysis}),/analysis differs/);
  const registry=buildContributionRegistry({trace});registry.components[0].mechanismClass='replaceable-mechanism';
  assert.throws(()=>discoverVariables({trace,registry}),/registry differs/);
  trace.scopeSha='e'.repeat(64);assert.throws(()=>buildContributionRegistry({trace}),/scope differs/);
});

test('reconstructed and missing observations remain null, including apparent idle time',()=>{
  const trace=fixture();trace.attempts=[];trace.verifications=[];trace.recovery={measurementCoverage:'unavailable'};
  const registry=buildContributionRegistry({trace});
  assert.equal(registry.criticalPath.coverage,'unavailable');assert.equal(registry.criticalPath.observedMs,null);
  assert.equal(registry.criticalPath.obligationIds,null);assert.ok(registry.criticalPath.nodeWork.every(row=>row.workMs===null&&row.verificationMs===null));
  for(const id of ['worker-routing','worker-reasoning','context','scheduling','review','accepted-reuse','recovery']){
    assert.ok(registry.components.find(component=>component.id===id).observations.every(observation=>observation.value===null));
  }
  const variables=discoverVariables({trace,registry});assert.equal(variables.candidateReferences[0].mayApply,false);
});
