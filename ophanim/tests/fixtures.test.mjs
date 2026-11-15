import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {makeFixtures,createPlanning,createWorkers,createSyntheticDestination,digest,canonical} from '../fixtures.mjs';

test('workers derive fixture outputs from inputs and accepted dependencies without the oracle',async()=>{
  const fixture=makeFixtures({count:3}),workers=createWorkers({delayMs:0}),accepted={};
  for(const spec of fixture.obligations){
    const {expected,...obligation}=spec;
    const dependencies=Object.fromEntries(spec.dependsOn.map(id=>[id,{output:accepted[id],sha256:digest(accepted[id])}]));
    const worker=workers.find(row=>row.kinds.includes(spec.kind));
    const reply=await worker.run({obligation,inputs:{...spec.inputs,dependencies},priorAttempts:0});
    assert.deepEqual(reply.output,expected);accepted[spec.id]=reply.output;
    if(spec.effectKey)assert.deepEqual(reply.effects,[{key:spec.effectKey,payload:expected}]);
  }
});

test('missing request facts fail rather than being invented',async()=>{
  const fixture=makeFixtures({count:1,missingCase:'pilot-case-001'}),{expected,...obligation}=fixture.obligations[0];
  const worker=createWorkers({delayMs:0})[0];
  await assert.rejects(worker.run({obligation,inputs:{...obligation.inputs,dependencies:{}},priorAttempts:0}),/Required request field missing/);
});

test('planning worker proposes a bounded DAG and validator rejects changed scope, dependency and ownership',async()=>{
  const planning=createPlanning({batches:[{count:2}]}),proposal=await planning.planner.plan({request:planning.request,policy:planning.policy});
  assert.equal(proposal.obligations.length,6);
  assert.ok(proposal.obligations.every(row=>!Object.hasOwn(row,'expected')));
  assert.equal(planning.validatePlan({proposal,request:planning.request,policy:planning.policy}).ok,true);
  for(const change of [p=>{p.obligations[0].scope='department:restricted';},p=>{p.obligations[1].dependsOn=[];},p=>{p.obligations[0].outputKey=p.obligations[1].outputKey;}]){
    const altered=structuredClone(proposal);change(altered);
    assert.equal(planning.validatePlan({proposal:altered,request:planning.request,policy:planning.policy}).ok,false);
  }
});

test('synthetic destination detects conflicting duplicate identity and records every apply invocation',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-destination-'));
  try{
    const adapter=createSyntheticDestination(root),effect=makeFixtures({count:1}).expectedEffects[0];
    await adapter.apply(effect);await adapter.apply(effect);
    assert.equal(adapter.list().length,1);assert.equal(adapter.invocations().length,2);
    assert.equal(canonical((await adapter.inspect(effect.key)).payload),canonical(effect.payload));
    await assert.rejects(adapter.apply({...effect,payload:{...effect.payload,title:'substituted'}}),/Conflicting duplicate/);
    assert.equal(adapter.invocations().length,3);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
