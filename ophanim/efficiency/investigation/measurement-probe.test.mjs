import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../../board.mjs';
import {makeFixtures} from '../../fixtures.mjs';
import {createPhaseRecorder, MEASUREMENT_RECIPE, runMeasurementProbe} from './measurement-probe.mjs';

const scopeSha=digest('measurement test scope');
const sourceSha=digest('measurement test source');
const recipeId='phase-probe.test';

test('optional recorder preserves missing and invalid boundaries without interrupting work',()=>{
  const names=['startedNs','endedNs'];
  const incomplete=createPhaseRecorder(names,{enabled:true});
  incomplete.mark('startedNs');
  assert.equal(incomplete.finish(),null);
  incomplete.mark('endedNs');
  assert.ok(incomplete.finish().endedNs>=incomplete.finish().startedNs);
  const misplaced=createPhaseRecorder(names,{enabled:true});
  misplaced.mark('endedNs');
  misplaced.mark('startedNs');
  misplaced.mark('endedNs');
  assert.equal(misplaced.finish(),null);
  const disabled=createPhaseRecorder(names);
  disabled.mark('startedNs');
  disabled.mark('endedNs');
  assert.equal(disabled.finish(),null);
  assert.throws(()=>createPhaseRecorder(['startedNs','startedNs']),/Bounded phase/);
});

test('isolated factorial probe matches frozen output and effect proposal with optional phase collection', {timeout:8000},async()=>{
  const fixture={count:2,namespace:'measurement-test',department:'operations'};
  const obligationId='measurement-test-case-002:draft';
  const receipt=await runMeasurementProbe({scopeSha,sourceSha,recipeId,fixture,obligationId,maxWallMs:5000});
  const original=makeFixtures(fixture).obligations.find(row=>row.id===obligationId);
  assert.equal(receipt.samples.length,32);
  assert.equal(new Set(receipt.samples.map(row=>row.sampleId)).size,32);
  assert.equal(receipt.workload.expectedOutputsSha,digest({[obligationId]:original.expected}));
  assert.equal(receipt.workload.expectedEffectsSha,digest([{key:original.effectKey,payload:original.expected}]));
  let previousEnd=0;
  for(const row of receipt.samples){
    const {trial,condition,collection,inputSha,outputsSha,effectsSha}=row;
    assert.equal(row.sampleId,digest({scopeSha,sourceSha,recipeId,trial,condition,collection,inputSha}));
    assert.equal(inputSha,receipt.workload.inputSha);
    assert.equal(outputsSha,receipt.workload.expectedOutputsSha);
    assert.equal(effectsSha,receipt.workload.expectedEffectsSha);
    assert.ok(previousEnd<=row.startedNs&&row.startedNs<=row.endedNs&&row.endedNs<=receipt.resource.elapsedNs);
    previousEnd=row.endedNs;
    if (collection==='off') assert.equal(row.marks,null);
    else {
      assert.deepEqual(Object.keys(row.marks),MEASUREMENT_RECIPE.markNames);
      const ordered=[row.startedNs,...MEASUREMENT_RECIPE.markNames.map(name=>row.marks[name]),row.endedNs];
      assert.ok(ordered.every((value,index)=>index===0||value>=ordered[index-1]));
      if(condition==='timer'||condition==='combined')
        assert.ok(row.marks.timerEnteredNs-row.marks.timerScheduledNs>=MEASUREMENT_RECIPE.timerHoldNs);
    }
  }
  assert.equal(receipt.overhead.markCalibration.length,MEASUREMENT_RECIPE.calibrationRounds);
  assert.ok(receipt.overhead.markCalibration.every(row=>row.onNs>0&&row.offNs>0));
  assert.equal(receipt.boundaries.destinationEffects,0);
  assert.equal(receipt.boundaries.modelCalls,0);
});

test('malformed scope, unknown method, oversized protocol and expired budget are refused',async()=>{
  const fixed={scopeSha,sourceSha,recipeId};
  await assert.rejects(runMeasurementProbe({...fixed,scopeSha:'unbound'}),/Exact bounded/);
  await assert.rejects(runMeasurementProbe({...fixed,repeats:7}),/Exact bounded/);
  await assert.rejects(runMeasurementProbe({...fixed,methods:['everything']}),/Exact bounded/);
  await assert.rejects(runMeasurementProbe({...fixed,fixture:{count:7,namespace:'measurement-test'}}),/Bounded measurement fixture/);
  await assert.rejects(runMeasurementProbe({...fixed,obligationId:'different-stage'}),/absent from frozen fixture/);
  await assert.rejects(runMeasurementProbe({...fixed,maxWallMs:1}),/wall limit/);
});
