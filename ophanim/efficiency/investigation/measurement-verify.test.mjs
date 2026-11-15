import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../../board.mjs';
import {makeFixtures} from '../../fixtures.mjs';
import {runMeasurementProbe} from './measurement-probe.mjs';
import {verifyMeasurementProbe} from './measurement-verify.mjs';

const ms=1000000;
function testFixture(repeats=4){
  const fixture={count:1,namespace:'measurement-verification'};
  const frozen=makeFixtures(fixture),target=frozen.obligations.at(-1);
  return {scopeSha:'a'.repeat(64),sourceSha:'b'.repeat(64),recipeId:'phase-verification',methods:['phase-boundaries'],repeats,
    maxWallMs:3000,fixture,obligationId:target.id,acceptedOutputSha:digest(target.expected),
    acceptedEffectSha:digest(frozen.expectedEffects.filter(effect=>effect.key===target.effectKey))};
}

// Independently chosen, exact synthetic clock readings exercise the verifier's
// statistical cases even when the test host introduces timing noise.
function clockFixture(raw){
  const packet=structuredClone(raw);
  let next=0;
  for(const sample of packet.samples){
    const timer=['timer','combined'].includes(sample.condition)?18*ms:3*ms;
    const work=['transform','combined'].includes(sample.condition)?8*ms:100000;
    const startedNs=next,timerScheduledNs=startedNs+1000,timerEnteredNs=timerScheduledNs+timer;
    const transformStartedNs=timerEnteredNs+1000,transformCompletedNs=transformStartedNs+work;
    const callbackReturnedNs=transformCompletedNs+1000,endedNs=callbackReturnedNs+1000;
    Object.assign(sample,{startedNs,endedNs,marks:sample.collection==='on'?
      {timerScheduledNs,timerEnteredNs,transformStartedNs,transformCompletedNs,callbackReturnedNs}:null});
    next=endedNs+1000;
  }
  packet.resource.elapsedNs=next;
  packet.overhead.markCalibration=packet.overhead.markCalibration.map(({round})=>({round,onNs:1500,offNs:1000}));
  return packet;
}

test('independent verifier binds a real matched probe and discriminates precise controls without resolving historical causality',async()=>{
  const expected=testFixture();
  const actual=await runMeasurementProbe(expected);
  const actualVerification=verifyMeasurementProbe({packet:actual,expected:{...expected,packetSha:digest(actual)}});
  assert.ok(['distinguished','insufficient_evidence'].includes(actualVerification.outcome));
  assert.equal(actualVerification.quality.samples,32);
  assert.equal(actualVerification.quality.effectsSha,expected.acceptedEffectSha);
  assert.equal(actualVerification.authority.destinationEffects,0);
  assert.equal(actualVerification.authority.policyAuthorized,false);
  assert.ok(actualVerification.resources.elapsedNs>0);
  assert.equal(actualVerification.overhead.matched.samples,16);
  assert.equal(actualVerification.downstream.stageP95Ms,null);

  const packet=clockFixture(actual);
  const clean=verifyMeasurementProbe({packet,expected:{...expected,packetSha:digest(packet)}});
  assert.equal(clean.outcome,'distinguished');
  assert.ok(Object.values(clean.hypotheses).every(h=>h.status==='supported'));
  assert.equal(clean.contrasts.timerAlone.medianNs,15*ms);
  assert.equal(clean.contrasts.workAlone.medianNs,7900000);
  assert.equal(clean.overhead.calibration.medianNs,500);
  assert.equal(clean.overhead.matched.medianNs,0);
  assert.equal(clean.interactions.status,'within-observed-margin');
  assert.deepEqual(clean.observations.map(o=>o.value),[15,7.9]);
  assert.deepEqual(clean.historical,{timerResume:'unresolved',transformation:'unresolved'});
});

test('noisy phase evidence, too few blocks or excessive overhead stay unresolved',async()=>{
  const expected=testFixture(),raw=await runMeasurementProbe(expected);
  const packet=clockFixture(raw);
  const ambiguous=packet.samples.find(row=>row.trial===0&&row.condition==='timer'&&row.collection==='on');
  ambiguous.marks.timerEnteredNs=ambiguous.marks.timerScheduledNs+3*ms;
  const unresolved=verifyMeasurementProbe({packet,expected});
  assert.equal(unresolved.outcome,'insufficient_evidence');
  assert.equal(unresolved.hypotheses.timerOnly.status,'insufficient_evidence');
  assert.deepEqual(unresolved.hypotheses.timerOnly.rejectedAlternatives,[]);
  assert.deepEqual(unresolved.observations,[]);

  const excessive=clockFixture(raw);
  excessive.overhead.markCalibration.forEach(row=>row.onNs+=ms);
  const unbounded=verifyMeasurementProbe({packet:excessive,expected});
  assert.equal(unbounded.overhead.bounded,false);
  assert.equal(unbounded.outcome,'insufficient_evidence');
  const onlyThree={...expected,repeats:3};
  const incomplete=clockFixture(raw);
  incomplete.protocol.repeats=3;
  incomplete.samples=incomplete.samples.filter(row=>row.trial<3);
  assert.equal(verifyMeasurementProbe({packet:incomplete,expected:onlyThree}).outcome,'insufficient_evidence');
});

test('verifier refuses missing, altered, and mismatched raw evidence',async()=>{
  const expected=testFixture(),raw=await runMeasurementProbe(expected),packet=clockFixture(raw);
  const check=({mutate,error})=>{
    const copy=structuredClone(packet);mutate(copy);
    assert.throws(()=>verifyMeasurementProbe({packet:copy,expected}),error);
  };
  for(const [mutate,error] of [
    [v=>v.samples.pop(),/complete matched measurement matrix/],
    [v=>delete v.samples[0].marks.timerEnteredNs,/phase marks are missing or altered/],
    [v=>v.samples[0].marks.timerEnteredNs=-1,/Invalid monotonic mark/],
    [v=>v.samples[1].marks={},/untaken observations/],
    [v=>v.samples[0].outputsSha='f'.repeat(64),/changed the accepted output/],
    [v=>v.samples[0].sampleId=v.samples[1].sampleId,/sample identity differs/],
    [v=>v.samples[1].startedNs=0,/monotonic observation window/],
    [v=>v.scopeSha='f'.repeat(64),/scopeSha differs/],
    [v=>v.sources.fixtureSha='f'.repeat(64),/implementation differs/],
    [v=>v.protocol.transformPasses++,/Frozen calibration conditions differ/],
    [v=>v.boundaries.policyAuthorized=true,/unauthorized effects or authority/],
  ])check({mutate,error});
  assert.throws(()=>verifyMeasurementProbe({packet,expected:{...expected,acceptedOutputSha:'f'.repeat(64)}}),/signed source/);
  assert.throws(()=>verifyMeasurementProbe({packet,expected:{...expected,acceptedEffectSha:'f'.repeat(64)}}),/signed source/);
  const originalSha=digest(packet);
  packet.resource.cpuUserMicros++;
  assert.throws(()=>verifyMeasurementProbe({packet,expected:{...expected,packetSha:originalSha}}),/retained identity/);
});
