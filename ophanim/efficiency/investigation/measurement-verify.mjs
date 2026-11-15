// Read-only verifier. The expected scope, recipe and accepted artifacts come
// from the caller's independently rechecked source evidence and admission.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {canonical,digest} from '../../board.mjs';
import {makeFixtures} from '../../fixtures.mjs';

const HASH=/^[a-f0-9]{64}$/;
const TIMESTAMPS=['timerScheduledNs','timerEnteredNs','transformStartedNs','transformCompletedNs','callbackReturnedNs'];
const CONDITIONS=[['baseline','timer','combined','transform'],['timer','transform','baseline','combined'],
  ['transform','combined','timer','baseline'],['combined','baseline','transform','timer']];
const CALIBRATION_ROUNDS=32;
const NS_PER_MS=1000000;
const NO_AUTHORITY={runtimeDispatches:0,replays:0,modelCalls:0,destinationEffects:0,executionAuthorized:false,policyAuthorized:false};
const THRESHOLDS=Object.freeze({minTimerContrastNs:6*NS_PER_MS,minTransformContrastNs:NS_PER_MS,
  equivalenceMarginNs:2.5*NS_PER_MS,maxMarkCalibrationP95Ns:0.5*NS_PER_MS,maxMatchedOverheadP95Ns:10*NS_PER_MS});
const validHash=value=>typeof value==='string'&&HASH.test(value);
const clock=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const exact=(a,b,message)=>assert.equal(canonical(a),canonical(b),message);
const rawSourceSha=url=>createHash('sha256').update(fs.readFileSync(url)).digest('hex');
const keys=(value,names,message)=>{
  assert.ok(value&&Object.getPrototypeOf(value)===Object.prototype,message);
  assert.deepEqual(Object.keys(value).sort(),[...names].sort(),message);
};

function reconstructWorkload({fixture,obligationId,acceptedOutputSha,acceptedEffectSha}) {
  assert.ok(fixture&&Number.isSafeInteger(fixture.count)&&fixture.count>=1&&fixture.count<=6,'Bounded fixture identity required');
  assert.ok(validHash(acceptedOutputSha)&&validHash(acceptedEffectSha),'Exact accepted output and effect identities required');
  const normalized={count:fixture.count,namespace:fixture.namespace,department:fixture.department??'operations'};
  const generated=makeFixtures(normalized);
  const row=generated.obligations.find(row=>row.id===obligationId);
  assert.ok(row,'Unknown frozen measurement obligation');
  const {expected,...obligation}=row;
  const dependencies=Object.fromEntries(row.dependsOn.map(id=>{
    const output=generated.obligations.find(row=>row.id===id).expected;
    return [id,{output,sha256:digest(output)}];
  }));
  const stableEffects=generated.expectedEffects.filter(effect=>effect.key===row.effectKey);
  assert.equal(digest(expected),acceptedOutputSha,'Frozen worker output differs from the signed source');
  assert.equal(digest(stableEffects),acceptedEffectSha,'Frozen destination proposals differ from the signed source');
  return {fixture:normalized,fixtureSha:digest(generated),obligationId,specSha:digest(row),
    inputSha:digest({obligation,inputs:{...row.inputs,dependencies},priorAttempts:0}),
    expectedOutputsSha:digest({[row.id]:expected}),expectedEffectsSha:acceptedEffectSha};
}

function verifySample(sample,{trial,condition,collection,expected,workload,windowNs,afterNs}) {
  keys(sample,['sampleId','trial','condition','collection','inputSha','startedNs','endedNs','marks','outputsSha','effectsSha'],'Exact raw measurement sample required');
  const {scopeSha,sourceSha,recipeId}=expected;
  const {inputSha,expectedOutputsSha,expectedEffectsSha}=workload;
  assert.equal(sample.trial,trial,'Counterbalanced measurement block differs');
  assert.equal(sample.condition,condition,'Counterbalanced measurement condition differs');
  assert.equal(sample.collection,collection,'Counterbalanced measurement mode differs');
  assert.equal(sample.sampleId,digest({scopeSha,sourceSha,recipeId,trial,condition,collection,inputSha}),'Scoped measurement sample identity differs');
  assert.equal(sample.inputSha,inputSha,'Matched fixture input differs');
  assert.equal(sample.outputsSha,expectedOutputsSha,'Measured worker changed the accepted output');
  assert.equal(sample.effectsSha,expectedEffectsSha,'Measured worker changed the destination proposal');
  assert.ok(clock(sample.startedNs,windowNs)&&clock(sample.endedNs,windowNs)&&sample.startedNs>=afterNs&&sample.endedNs>=sample.startedNs,'Measurement interval is outside its monotonic observation window');
  const runtimeNs=sample.endedNs-sample.startedNs;
  if(collection==='off'){
    assert.equal(sample.marks,null,'Collection-off sample contains untaken observations');
    return {runtimeNs};
  }
  keys(sample.marks,TIMESTAMPS,'Required phase marks are missing or altered');
  let previous=sample.startedNs;
  for(const name of TIMESTAMPS){
    const mark=sample.marks[name];
    assert.ok(clock(mark,sample.endedNs)&&mark>=previous,`Invalid monotonic mark ${name}`);
    previous=mark;
  }
  const {timerScheduledNs,timerEnteredNs,transformStartedNs,transformCompletedNs,callbackReturnedNs}=sample.marks;
  return {runtimeNs,timerNs:timerEnteredNs-timerScheduledNs,transformNs:transformCompletedNs-transformStartedNs,
    continuationNs:transformStartedNs-timerEnteredNs,returnNs:callbackReturnedNs-transformCompletedNs};
}

const sort=values=>[...values].sort((a,b)=>a-b);
const percentile=(values,p)=>sort(values)[Math.ceil(values.length*p)-1];
function distribution(values){
  const ordered=sort(values),middle=Math.floor(ordered.length/2);
  return {samples:values.length,minNs:ordered[0],medianNs:ordered.length%2?ordered[middle]:(ordered[middle-1]+ordered[middle])/2,
    p95Ns:percentile(values,.95),maxNs:ordered.at(-1),byBlockNs:values};
}

function assessOverhead(overhead,blocks){
  keys(overhead,['markCalibration'],'Raw marker calibration required');
  assert.ok(Array.isArray(overhead.markCalibration)&&overhead.markCalibration.length===CALIBRATION_ROUNDS,'Incomplete marker calibration');
  const calibration=overhead.markCalibration.map((row,index)=>{
    keys(row,['round','onNs','offNs'],'Exact marker calibration sample required');
    const {round,onNs,offNs}=row;
    assert.equal(round,index,'Marker calibration ordering differs');
    assert.ok(clock(onNs)&&clock(offNs),'Raw marker calibration duration is invalid');
    return onNs-offNs;
  });
  const matched=blocks.flatMap(block=>Object.values(block).map(({on,off})=>on.runtimeNs-off.runtimeNs));
  const markerUpperP95Ns=Math.max(0,percentile(calibration,.95));
  const matchedUpperP95Ns=Math.max(0,percentile(matched,.95));
  return {calibration:distribution(calibration),matched:distribution(matched),markerUpperP95Ns,matchedUpperP95Ns,
    bounded:markerUpperP95Ns<=THRESHOLDS.maxMarkCalibrationP95Ns&&matchedUpperP95Ns<=THRESHOLDS.maxMatchedOverheadP95Ns,
    meaning:'Signed collection-on minus collection-off differences. The matched upper percentile includes execution noise; it is not a per-call causal cost.'};
}

function assessContrasts(blocks,overhead){
  const contrast=(signal,high,low)=>blocks.map(block=>block[high].on[signal]-block[low].on[signal]);
  const signs=(values,minimum)=>({result:values.every(value=>value>=minimum)?'supported':'insufficient_evidence',...distribution(values)});
  const unchanged=values=>({result:values.every(value=>Math.abs(value)<=THRESHOLDS.equivalenceMarginNs)?'within-margin':'insufficient_evidence',...distribution(values)});
  const timerAlone=contrast('timerNs','timer','baseline'),timerWithWork=contrast('timerNs','combined','transform');
  const workAlone=contrast('transformNs','transform','baseline'),workWithTimer=contrast('transformNs','combined','timer');
  const contrasts={
    timerAlone:signs(timerAlone,THRESHOLDS.minTimerContrastNs),timerWithWork:signs(timerWithWork,THRESHOLDS.minTimerContrastNs),
    workAlone:signs(workAlone,THRESHOLDS.minTransformContrastNs),workWithTimer:signs(workWithTimer,THRESHOLDS.minTransformContrastNs),
    timerWhenOnlyWorkChanges:unchanged(contrast('timerNs','transform','baseline')),
    timerWhenWorkChangesWithDelay:unchanged(contrast('timerNs','combined','timer')),
    workWhenOnlyTimerChanges:unchanged(contrast('transformNs','timer','baseline')),
    workWhenTimerChangesWithWork:unchanged(contrast('transformNs','combined','transform')),
    timerInteraction:unchanged(timerWithWork.map((value,index)=>value-timerAlone[index])),
    workInteraction:unchanged(workWithTimer.map((value,index)=>value-workAlone[index])),
  };
  const combines=(...names)=>blocks.length>=CONDITIONS.length&&overhead.bounded&&
    names.every(name=>['supported','within-margin'].includes(contrasts[name].result));
  const timer=combines('timerAlone','timerWithWork','workWhenOnlyTimerChanges');
  const transform=combines('workAlone','workWithTimer','timerWhenOnlyWorkChanges');
  // The matched contrasts identify each intervention in both settings of the
  // other factor. Cross-factor drift still matters when estimating additivity.
  const interactionSignals=['timerInteraction','workInteraction','workWhenTimerChangesWithWork','timerWhenWorkChangesWithDelay'];
  const interactions={status:combines(...interactionSignals)?'within-observed-margin':'insufficient_evidence',
    signals:interactionSignals};
  const hypothesis=(supported,ruledOut)=>({status:supported?'supported':'insufficient_evidence',
    rejectedAlternatives:supported?ruledOut:[]});
  return {contrasts,hypotheses:{timerOnly:hypothesis(timer,['transform-only','unchanged']),
    transformOnly:hypothesis(transform,['timer-only','unchanged']),
    combined:hypothesis(timer&&transform,['timer-only','transform-only','unchanged']),
    baseline:hypothesis(timer&&transform,['timer-only','transform-only','combined'])},
    interactions,outcome:timer&&transform?'distinguished':'insufficient_evidence'};
}

export function verifyMeasurementProbe({packet,expected}={}){
  assert.ok(expected&&validHash(expected.scopeSha)&&validHash(expected.sourceSha)&&
    typeof expected.recipeId==='string'&&/^[a-zA-Z0-9:._-]{1,120}$/.test(expected.recipeId),'Trusted measurement scope and recipe required');
  assert.ok(Number.isSafeInteger(expected.repeats)&&expected.repeats>=3&&expected.repeats<=6&&
    Number.isSafeInteger(expected.maxWallMs)&&expected.maxWallMs>0&&expected.maxWallMs<=5000,'Measurement allowance exceeds the fixed bound');
  exact(expected.methods,['phase-boundaries'],'Unsupported measurement technique');
  keys(packet,['schema','scopeSha','sourceSha','recipeId','protocol','workload','sources','samples','overhead','resource','boundaries'],'Exact probe evidence required');
  assert.equal(packet.schema,'ophanim.measurement-probe/v1','Unknown measurement evidence schema');
  for(const key of ['scopeSha','sourceSha','recipeId'])assert.equal(packet[key],expected[key],`Measurement ${key} differs from the admitted evidence`);
  const {repeats,maxWallMs,methods}=expected;
  exact(packet.protocol,{schema:'ophanim.measurement-protocol/v1',methods,repeats,maxWallMs,
    timerDelayMs:3,timerHoldNs:18000000,transformPasses:8192,markNames:TIMESTAMPS,calibrationRounds:CALIBRATION_ROUNDS},'Frozen calibration conditions differ');
  const workload=reconstructWorkload(expected);
  exact(packet.workload,workload,'Measurement workload or source outputs differ');
  exact(packet.sources,{probeSha:rawSourceSha(new URL('./measurement-probe.mjs',import.meta.url)),
    fixtureSha:rawSourceSha(new URL('../../fixtures.mjs',import.meta.url))},'Measurement implementation differs from its recorded source');
  exact(packet.boundaries,NO_AUTHORITY,'Measurement attempt requested unauthorized effects or authority');
  const {resource}=packet;
  keys(resource,['elapsedNs','cpuUserMicros','cpuSystemMicros','nodeVersion','clock'],'Exact probe resource reading required');
  assert.ok(clock(resource.elapsedNs,maxWallMs*NS_PER_MS)&&clock(resource.cpuUserMicros)&&clock(resource.cpuSystemMicros)&&
    typeof resource.nodeVersion==='string'&&/^\d+\.\d+\.\d+$/.test(resource.nodeVersion)&&resource.clock==='process.hrtime.bigint','Invalid or over-budget probe resource readings');
  assert.ok(Array.isArray(packet.samples)&&packet.samples.length===repeats*8,'A complete matched measurement matrix is required');
  const blocks=[];let offset=0,afterNs=0;
  for(let trial=0;trial<repeats;trial++){
    const block={};
    for(const [cell,condition] of CONDITIONS[trial%CONDITIONS.length].entries()){
      const pair={};
      for(const collection of (trial+cell)%2===0?['on','off']:['off','on']){
        const sample=packet.samples[offset++];
        pair[collection]=verifySample(sample,{trial,condition,collection,expected,workload,windowNs:resource.elapsedNs,afterNs});
        afterNs=sample.endedNs;
      }
      block[condition]=pair;
    }
    blocks.push(block);
  }
  const packetSha=digest(packet);
  if(expected.packetSha!==undefined)assert.equal(packetSha,expected.packetSha,'Measurement packet bytes differ from the retained identity');
  const overhead=assessOverhead(packet.overhead,blocks);
  const {contrasts,hypotheses,interactions,outcome}=assessContrasts(blocks,overhead);
  const observations=outcome==='distinguished'?[
    ['calibration-timer-only-median-delta','calibration-timer-wall-delta-ms',contrasts.timerAlone],
    ['calibration-transform-only-median-delta','calibration-transform-wall-delta-ms',contrasts.workAlone],
  ].map(([id,metric,value])=>({schema:'ophanim.functional-observation/v1',receiptSha:packetSha,scopeSha:packet.scopeSha,
    id,componentId:'worker-reasoning',metric,unit:'ms',value:value.medianNs/NS_PER_MS,samples:value.samples,method:'controlled-comparison'})):[];
  return {schema:'ophanim.measurement-verification/v1',scopeSha:packet.scopeSha,sourceSha:packet.sourceSha,packetSha,
    outcome,thresholds:THRESHOLDS,hypotheses,contrasts,interactions,overhead,resources:resource,
    quality:{obligationId:workload.obligationId,outputsSha:workload.expectedOutputsSha,effectsSha:workload.expectedEffectsSha,samples:packet.samples.length},
    observations,downstream:{criticalPathMs:null,stageP95Ms:null,throughput:null,recoveryMs:null},
    historical:{timerResume:'unresolved',transformation:'unresolved'},authority:NO_AUTHORITY};
}
