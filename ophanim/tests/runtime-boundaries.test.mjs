import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openBoard} from '../../pantheon/src/board/index.mjs';
import {withRuntimeBoard} from '../board.mjs';
import {runRuntime,loadRuntime} from '../runtime.mjs';
import {createGovernance} from '../governance.mjs';
import {makeFixtures,createWorkers,createSyntheticDestination} from '../fixtures.mjs';
import {assertAcceptedBinding} from '../proof.mjs';

async function setup() {
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-boundary-'));
  const governance=await createGovernance({root:stateDir,fixtureOnly:true,...process.env.OPHANIM_TELOS_ROOT?{telosRoot:process.env.OPHANIM_TELOS_ROOT}:{}});
  const effectAdapter=createSyntheticDestination(path.join(stateDir,'destination'));
  return {stateDir,governance,effectAdapter};
}

test('real Pantheon fence rejects publication after ownership changes',async()=>{
  const context=await setup(),spec=makeFixtures({count:1}).obligations[0];spec.maxAttempts=1;
  try{
    const result=await runRuntime({...context,obligations:[spec],workers:createWorkers({delayMs:0}),fault:async(event,payload)=>{
      if(event!=='before-work-publish')return;
      const board=openBoard(path.join(context.stateDir,'pantheon'));
      await board.runtime.fence({resource:payload.lease.resource,holder:{vendor:'anthropic',seat_id:'synthetic-takeover',mode:'work',occupancy_gen:2},ttlMs:10000,reason:'synthetic lease-loss injection'});
    }});
    const row=result.state.obligations[spec.id];
    assert.equal(row.status,'held');assert.equal(row.attempt,1);assert.equal(result.accepted.length,0);
    assert.match(row.history[0].reason,/fenc|lease/i);assert.equal(context.effectAdapter.invocations().length,0);
  }finally{fs.rmSync(context.stateDir,{recursive:true,force:true});}
});

test('cross-department dependency requires an explicit future handoff contract',async()=>{
  const context=await setup(),specs=makeFixtures({count:1}).obligations.slice(0,2);specs[1].scope='department:restricted';
  try{
    await assert.rejects(runRuntime({...context,obligations:specs,workers:createWorkers({departments:['operations','restricted'],delayMs:0})}),/Cross-scope dependency/);
    assert.equal(context.effectAdapter.invocations().length,0);
  }finally{fs.rmSync(context.stateDir,{recursive:true,force:true});}
});

test('restart refuses altered accepted dependency evidence without another destination effect',async()=>{
  const context=await setup(),specs=makeFixtures({count:1}).obligations,workers=createWorkers({delayMs:0});
  try{
    const first=await runRuntime({...context,obligations:specs,workers});assert.equal(first.complete,true);
    await withRuntimeBoard(context.stateDir,async board=>{
      board.state.obligations['pilot-case-001:route'].candidate.evidence.dependencyVersions[0].sha256='0'.repeat(64);
      await board.save(board.state,{type:'fixture.tamper',target:'dependency-version'});
    });
    await assert.rejects(runRuntime({...context,obligations:specs,workers}),/immutable Pantheon publication|dependency versions/);
    assert.equal(context.effectAdapter.invocations().length,1);
    assert.equal(loadRuntime(context.stateDir).obligations['pilot-case-001:draft'].status,'accepted');
  }finally{fs.rmSync(context.stateDir,{recursive:true,force:true});}
});

test('independent verifier binds signed obligation and retained candidate to the exact accepted row',async()=>{
  const context=await setup(),spec=makeFixtures({count:1}).obligations[0],workers=createWorkers({delayMs:0});
  try{
    const result=await runRuntime({...context,obligations:[spec],workers}),row=result.state.obligations[spec.id];
    const proof=await context.governance.verifyPlan({planRef:row.accepted.planRef});assert.equal(proof.ok,true);
    assert.doesNotThrow(()=>assertAcceptedBinding(row,proof));
    const changedSpec=structuredClone(row);changedSpec.spec.inputs.request.summary='Different source request, same accepted output';
    assert.throws(()=>assertAcceptedBinding(changedSpec,proof),/Signed obligation bytes differ/);
    const changedId=structuredClone(row);changedId.spec.id='alternate-obligation';
    assert.throws(()=>assertAcceptedBinding(changedId,proof),/Signed obligation identity differs/);
    const changedCandidate=structuredClone(row);changedCandidate.candidate.candidate.output.summary='Substituted retained bytes';
    assert.throws(()=>assertAcceptedBinding(changedCandidate,proof),/Retained candidate bytes differ/);
    const changedAccepted=structuredClone(row);changedAccepted.accepted.output.summary='Substituted accepted bytes';
    assert.throws(()=>assertAcceptedBinding(changedAccepted,proof),/Accepted output differs/);
  }finally{fs.rmSync(context.stateDir,{recursive:true,force:true});}
});
