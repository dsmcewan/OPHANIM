// ophanim/efficiency/investigation/measurement-verify.mjs -- independent check of a phase-boundary probe packet.
//
// Read-only verifier. The expected scope, recipe and accepted artifacts come
// from the caller's independently rechecked source evidence and admission.
//
// Purpose: decide, from the raw samples of one measurement probe (measurement-probe.mjs), whether the
//   two proposed explanations of a slow worker callback -- timer resumption lag and transformation
//   time -- can be told apart. The probe runs one frozen fixture obligation under four conditions
//   (baseline, timer delay only, transformation work only, both), each with phase marks collected
//   ('on') and not collected ('off'), in a counterbalanced order, for `repeats` trials.
// Inputs:  the probe packet and the expected identity (scope, source and recipe digests, the frozen
//   fixture and obligation, accepted output and effect digests, repeats, wall allowance, optionally
//   the retained packet digest).
// Outputs: an 'ophanim.measurement-verification/v1' object: per-contrast distributions and verdicts,
//   hypothesis statuses, the interaction check, the marker-overhead assessment, and -- only when both
//   interventions are distinguished -- two functional observations for the worker-reasoning model.
// Invariants: the workload is rebuilt from fixtures.mjs and must match the signed accepted output and
//   effects; the packet's recorded source digests must equal the current bytes of
//   measurement-probe.mjs and fixtures.mjs; every sample must keep the accepted output and effects,
//   carry its scoped identity, and lie inside the monotonic observation window in order; every
//   verdict needs every block to clear its fixed threshold (THRESHOLDS).
// Must never: run the probe, a worker, a replay or a model, write a file, or grant authority -- the
//   packet must itself declare NO_AUTHORITY, and so does the result. Historical attribution stays
//   'unresolved': a synthetic calibration says nothing about why a past run was slow.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {canonical,digest} from '../../board.mjs';
import {makeFixtures} from '../../fixtures.mjs';

const HASH=/^[a-f0-9]{64}$/;
// Phase marks in the order they must occur inside one callback.
const TIMESTAMPS=['timerScheduledNs','timerEnteredNs','transformStartedNs','transformCompletedNs','callbackReturnedNs'];
// Condition order per trial (a 4x4 Latin square), so no condition always runs first or last.
const CONDITIONS=[['baseline','timer','combined','transform'],['timer','transform','baseline','combined'],
  ['transform','combined','timer','baseline'],['combined','baseline','transform','timer']];
const CALIBRATION_ROUNDS=32;
const NS_PER_MS=1000000;
const NO_AUTHORITY={runtimeDispatches:0,replays:0,modelCalls:0,destinationEffects:0,
  executionAuthorized:false,policyAuthorized:false};
// Fixed decision thresholds: the least per-block contrast that counts as an effect of each
// intervention, the margin within which a signal counts as unchanged, and the overhead bounds.
const THRESHOLDS=Object.freeze({minTimerContrastNs:6*NS_PER_MS,minTransformContrastNs:NS_PER_MS,
  equivalenceMarginNs:2.5*NS_PER_MS,maxMarkCalibrationP95Ns:0.5*NS_PER_MS,maxMatchedOverheadP95Ns:10*NS_PER_MS});
const validHash=value=>typeof value==='string'&&HASH.test(value);
const clock=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const exact=(a,b,message)=>assert.equal(canonical(a),canonical(b),message);
// SHA-256 of a source file's raw bytes (not its canonical JSON).
const rawSourceSha=url=>createHash('sha256').update(fs.readFileSync(url)).digest('hex');
// `value` is a plain object with exactly the keys `names`.
const keys=(value,names,message)=>{
  assert.ok(value&&Object.getPrototypeOf(value)===Object.prototype,message);
  assert.deepEqual(Object.keys(value).sort(),[...names].sort(),message);
};

// Rebuild the measured workload from the frozen fixtures: the obligation, its input (with dependency
// outputs), and the expected output and effects, checked against the signed accepted digests.
function reconstructWorkload({fixture,obligationId,acceptedOutputSha,acceptedEffectSha}) {
  assert.ok(fixture&&Number.isSafeInteger(fixture.count)&&fixture.count>=1&&fixture.count<=6,
    'Bounded fixture identity required');
  assert.ok(validHash(acceptedOutputSha)&&validHash(acceptedEffectSha),
    'Exact accepted output and effect identities required');
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

// Check one raw sample against its expected position in the matrix and return its durations: total
// runtime always; with collection on, also the timer wait, the transformation, and the gaps between
// them (continuation) and after them (return). `afterNs` is the previous sample's end, so samples
// must not overlap or go back in time.
function verifySample(sample,{trial,condition,collection,expected,workload,windowNs,afterNs}) {
  keys(sample,['sampleId','trial','condition','collection','inputSha','startedNs','endedNs','marks','outputsSha',
    'effectsSha'],
    'Exact raw measurement sample required');
  const {scopeSha,sourceSha,recipeId}=expected;
  const {inputSha,expectedOutputsSha,expectedEffectsSha}=workload;
  assert.equal(sample.trial,trial,'Counterbalanced measurement block differs');
  assert.equal(sample.condition,condition,'Counterbalanced measurement condition differs');
  assert.equal(sample.collection,collection,'Counterbalanced measurement mode differs');
  assert.equal(sample.sampleId,digest({scopeSha,sourceSha,recipeId,trial,condition,collection,inputSha}),
    'Scoped measurement sample identity differs');
  assert.equal(sample.inputSha,inputSha,'Matched fixture input differs');
  assert.equal(sample.outputsSha,expectedOutputsSha,'Measured worker changed the accepted output');
  assert.equal(sample.effectsSha,expectedEffectsSha,'Measured worker changed the destination proposal');
  assert.ok(clock(sample.startedNs,windowNs)&&clock(sample.endedNs,windowNs)&&
    sample.startedNs>=afterNs&&sample.endedNs>=sample.startedNs,
  'Measurement interval is outside its monotonic observation window');
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
// Nearest-rank percentile.
const percentile=(values,p)=>sort(values)[Math.ceil(values.length*p)-1];
// Summary of a list of per-block values; the raw values are kept in block order.
function distribution(values){
  const ordered=sort(values),middle=Math.floor(ordered.length/2);
  return {samples:values.length,minNs:ordered[0],
    medianNs:ordered.length%2?ordered[middle]:(ordered[middle-1]+ordered[middle])/2,
    p95Ns:percentile(values,.95),maxNs:ordered.at(-1),byBlockNs:values};
}

// Cost of collecting the marks: a dedicated calibration (mark taken minus not taken, per round) and
// the matched on-minus-off runtime of every cell. Both p95 upper values must be within their bounds.
function assessOverhead(overhead,blocks){
  keys(overhead,['markCalibration'],'Raw marker calibration required');
  assert.ok(Array.isArray(overhead.markCalibration)&&overhead.markCalibration.length===CALIBRATION_ROUNDS,
    'Incomplete marker calibration');
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

// Per-block contrasts between conditions (collection-on samples). Each intervention must raise its
// own signal in both settings of the other factor ('supported') and leave the other signal within
// the equivalence margin ('within-margin'). A hypothesis is supported only if all its contrasts hold
// in every block, there are at least as many blocks as condition orders, and the overhead is bounded.
function assessContrasts(blocks,overhead){
  const contrast=(signal,high,low)=>blocks.map(block=>block[high].on[signal]-block[low].on[signal]);
  const signs=(values,minimum)=>({result:values.every(value=>value>=minimum)?'supported':'insufficient_evidence',
    ...distribution(values)});
  const unchanged=values=>({
    result:values.every(value=>Math.abs(value)<=THRESHOLDS.equivalenceMarginNs)?'within-margin':'insufficient_evidence',
    ...distribution(values)});
  const timerAlone=contrast('timerNs','timer','baseline'),timerWithWork=contrast('timerNs','combined','transform');
  const workAlone=contrast('transformNs','transform','baseline'),workWithTimer=contrast('transformNs','combined',
    'timer');
  const contrasts={
    timerAlone:signs(timerAlone,THRESHOLDS.minTimerContrastNs),
    timerWithWork:signs(timerWithWork,THRESHOLDS.minTimerContrastNs),
    workAlone:signs(workAlone,THRESHOLDS.minTransformContrastNs),
    workWithTimer:signs(workWithTimer,THRESHOLDS.minTransformContrastNs),
    timerWhenOnlyWorkChanges:unchanged(contrast('timerNs','transform','baseline')),
    timerWhenWorkChangesWithDelay:unchanged(contrast('timerNs','combined','timer')),
    workWhenOnlyTimerChanges:unchanged(contrast('transformNs','timer','baseline')),
    workWhenTimerChangesWithWork:unchanged(contrast('transformNs','combined','transform')),
    // Difference between an intervention's effect with and without the other one.
    timerInteraction:unchanged(timerWithWork.map((value,index)=>value-timerAlone[index])),
    workInteraction:unchanged(workWithTimer.map((value,index)=>value-workAlone[index])),
  };
  const combines=(...names)=>blocks.length>=CONDITIONS.length&&overhead.bounded&&
    names.every(name=>['supported','within-margin'].includes(contrasts[name].result));
  const timer=combines('timerAlone','timerWithWork','workWhenOnlyTimerChanges');
  const transform=combines('workAlone','workWithTimer','timerWhenOnlyWorkChanges');
  // The matched contrasts identify each intervention in both settings of the
  // other factor. Cross-factor drift still matters when estimating additivity.
  const interactionSignals=['timerInteraction','workInteraction','workWhenTimerChangesWithWork',
    'timerWhenWorkChangesWithDelay'];
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

// Verify one probe packet against the caller's expected identity (see the header).
export function verifyMeasurementProbe({packet,expected}={}){
  assert.ok(expected&&validHash(expected.scopeSha)&&validHash(expected.sourceSha)&&
    typeof expected.recipeId==='string'&&/^[a-zA-Z0-9:._-]{1,120}$/.test(expected.recipeId),
  'Trusted measurement scope and recipe required');
  assert.ok(Number.isSafeInteger(expected.repeats)&&expected.repeats>=3&&expected.repeats<=6&&
    Number.isSafeInteger(expected.maxWallMs)&&expected.maxWallMs>0&&expected.maxWallMs<=5000,
  'Measurement allowance exceeds the fixed bound');
  exact(expected.methods,['phase-boundaries'],'Unsupported measurement technique');
  keys(packet,['schema','scopeSha','sourceSha','recipeId','protocol','workload','sources','samples','overhead',
    'resource','boundaries'],
    'Exact probe evidence required');
  assert.equal(packet.schema,'ophanim.measurement-probe/v1','Unknown measurement evidence schema');
  for(const key of ['scopeSha','sourceSha','recipeId'])
    assert.equal(packet[key],expected[key],`Measurement ${key} differs from the admitted evidence`);
  const {repeats,maxWallMs,methods}=expected;
  // The probe's frozen conditions: timer delay, hold, transformation size, mark names, calibration.
  exact(packet.protocol,{schema:'ophanim.measurement-protocol/v1',methods,repeats,maxWallMs,
    timerDelayMs:3,timerHoldNs:18000000,transformPasses:8192,markNames:TIMESTAMPS,calibrationRounds:CALIBRATION_ROUNDS},
  'Frozen calibration conditions differ');
  const workload=reconstructWorkload(expected);
  exact(packet.workload,workload,'Measurement workload or source outputs differ');
  exact(packet.sources,{probeSha:rawSourceSha(new URL('./measurement-probe.mjs',import.meta.url)),
    fixtureSha:rawSourceSha(new URL('../../fixtures.mjs',import.meta.url))},
      'Measurement implementation differs from its recorded source');
  exact(packet.boundaries,NO_AUTHORITY,'Measurement attempt requested unauthorized effects or authority');
  const {resource}=packet;
  keys(resource,['elapsedNs','cpuUserMicros','cpuSystemMicros','nodeVersion','clock'],
    'Exact probe resource reading required');
  assert.ok(clock(resource.elapsedNs,maxWallMs*NS_PER_MS)&&clock(resource.cpuUserMicros)&&
    clock(resource.cpuSystemMicros)&&
    typeof resource.nodeVersion==='string'&&/^\d+\.\d+\.\d+$/.test(resource.nodeVersion)&&
    resource.clock==='process.hrtime.bigint',
  'Invalid or over-budget probe resource readings');
  // Four conditions times collection on and off per trial.
  assert.ok(Array.isArray(packet.samples)&&packet.samples.length===repeats*8,
    'A complete matched measurement matrix is required');
  // Walk the samples in the order the probe must have taken them: the trial's condition order, and
  // within each condition on/off alternating which goes first.
  const blocks=[];let offset=0,afterNs=0;
  for(let trial=0;trial<repeats;trial++){
    const block={};
    for(const [cell,condition] of CONDITIONS[trial%CONDITIONS.length].entries()){
      const pair={};
      for(const collection of (trial+cell)%2===0?['on','off']:['off','on']){
        const sample=packet.samples[offset++];
        pair[collection]=verifySample(sample,{trial,condition,collection,expected,workload,
          windowNs:resource.elapsedNs,afterNs});
        afterNs=sample.endedNs;
      }
      block[condition]=pair;
    }
    blocks.push(block);
  }
  const packetSha=digest(packet);
  if(expected.packetSha!==undefined)
    assert.equal(packetSha,expected.packetSha,'Measurement packet bytes differ from the retained identity');
  const overhead=assessOverhead(packet.overhead,blocks);
  const {contrasts,hypotheses,interactions,outcome}=assessContrasts(blocks,overhead);
  // Only a distinguished outcome yields observations, scoped to this packet, for the functional model.
  const observations=outcome==='distinguished'?[
    ['calibration-timer-only-median-delta','calibration-timer-wall-delta-ms',contrasts.timerAlone],
    ['calibration-transform-only-median-delta','calibration-transform-wall-delta-ms',contrasts.workAlone],
  ].map(([id,metric,value])=>({schema:'ophanim.functional-observation/v1',receiptSha:packetSha,scopeSha:packet.scopeSha,
    id,componentId:'worker-reasoning',metric,unit:'ms',value:value.medianNs/NS_PER_MS,samples:value.samples,
    method:'controlled-comparison'})):[];
  return {schema:'ophanim.measurement-verification/v1',scopeSha:packet.scopeSha,sourceSha:packet.sourceSha,packetSha,
    outcome,thresholds:THRESHOLDS,hypotheses,contrasts,interactions,overhead,resources:resource,
    quality:{obligationId:workload.obligationId,outputsSha:workload.expectedOutputsSha,
      effectsSha:workload.expectedEffectsSha,samples:packet.samples.length},
    observations,downstream:{criticalPathMs:null,stageP95Ms:null,throughput:null,recoveryMs:null},
    historical:{timerResume:'unresolved',transformation:'unresolved'},authority:NO_AUTHORITY};
}
