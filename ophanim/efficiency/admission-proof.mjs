// ophanim/efficiency/admission-proof.mjs -- the evidence report behind efficiency admission.
//
// Separate real timing evidence from a deterministic capacity model. This file
// cannot issue an efficiency decision or activate a scheduler policy.
//
// Purpose: assemble, with each piece labelled by its evidence class, what is known about widening the
//   scheduler from 1 to 3 slots: (1) a retained measured replay, re-checked from its files and optionally
//   re-verified by TELOS; (2) deterministic capacity models whose timings are declared assumptions, not
//   measurements; (3) optional measured paired probes (one 1-slot and one 3-slot run); and (4) one fresh
//   real baseline run that must read the retained experiment and decline to replay it.
// Inputs:  buildAdmissionProof({outputDir, manifestFile, probeRoots, telosRoot, verifySigned}); the CLI:
//   `report --output ROOT --manifest FILE [--probes ROOT,ROOT]` or `probe --output ROOT [--count N --delay MS]`.
// Outputs: JSON reports written under a fresh output directory (admission-proof.json,
//   retained-baseline-proof.json, paired-report.json, per-run request/result/watchdog files).
// Invariants: every output directory must be fresh, absolute and canonical; retained files are read
//   only through inside() and must match their recorded hashes; the retained original's file inventory
//   must be unchanged by the fresh baseline; every report carries boundaries() (no model calls, business
//   connections, policy decisions or activations) and productionAdmission false.
// Must never: issue or activate an efficiency decision, present a modeled timing as measured, or modify
//   the retained evidence it reads.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {canonical,digest,readRuntimeSnapshot} from '../board.mjs';
import {makeFixtures,createPlanning,createWorkers,writeJson} from '../fixtures.mjs';
import {guardWorker} from '../watchdog.mjs';
import {verifyReplayTrial} from './replay.mjs';
import {assessEfficiency} from '../governance/check-efficiency.mjs';
import {efficiencyScope,verifyEfficiencyRecord} from './assessment.mjs';
import {readRetainedExperiment} from './prior.mjs';
import {assessOptimizationAdmission} from './admission.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const rawSha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const same=(a,b,message)=>assert.equal(canonical(a),canonical(b),message);
const effects=values=>values.map(({key,payload})=>({key,payload})).sort((a,b)=>a.key.localeCompare(b.key));
const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
// The fixed limits every report states: nothing here calls a model or decides or activates a policy.
const boundaries=()=>({modelCalls:0,businessConnections:0,policyDecisionsIssued:0,policyActivations:0});

// An absolute, canonical, empty directory (created if missing) -- evidence is never written over.
function fresh(root) {
  assert.ok(path.isAbsolute(root),'Absolute evidence root required');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  assert.equal(fs.realpathSync(root),root,'Canonical evidence root required');
  assert.equal(fs.readdirSync(root).length,0,'Fresh evidence directory required');
}
// A path under `root` from a relative name in a manifest: no absolute path, no `.`/`..` segment, no
// backslash, and no symbolic link (the real path must equal the joined path).
function inside(root,relative) {
  assert.ok(
    typeof relative==='string'&&!path.isAbsolute(relative)&&
    relative.split('/').every(x=>x&&!['.','..'].includes(x))&&!relative.includes('\\'));
  const file=path.join(root,relative);assert.equal(fs.realpathSync(file),file);return file;
}
// Per-attempt stage latency: work.started to work.accepted for each (id, attempt), within the run window.
function stageSamples(state,result) {
  const starts=new Map(),samples=[];
  for(const event of state.events) {
    if(event.atMs<result.startedAt||event.atMs>result.endedAt)continue;
    const key=JSON.stringify([event.id,event.attempt]);
    if(event.type==='work.started')starts.set(key,event.atMs);
    if(event.type==='work.accepted'&&starts.has(key))samples.push(event.atMs-starts.get(key));
  }
  assert.ok(samples.length);return samples;
}
// What a correct run of `request` must produce: the fixtures' obligations, expected outputs and effects.
function expectedAcceptance(request) {
  const fixtures=request.batches.map(makeFixtures),obligations=fixtures.flatMap(f=>f.obligations);
  return {obligations,outputs:Object.fromEntries(obligations.map(s=>[s.id,s.expected])),
    effects:effects(fixtures.flatMap(f=>f.expectedEffects))};
}

// Historical timing is reproduced from its retained raw results/controller
// events. Optional TELOS replay confirms acceptance, not present-day speed.
export async function reproduceRetainedEvaluation({manifestFile,telosRoot,verifySigned=true}={}) {
  assert.ok(path.isAbsolute(manifestFile));const root=path.dirname(manifestFile),manifest=read(manifestFile);
  assert.equal(manifest.schema,'ophanim.scheduler-replay/v1');assert.equal(manifest.status,'completed');
  assert.equal(manifest.trials.length,8);
  // Every retained file must still hash to its recorded value (at most 512 MiB read in total).
  let bytes=0;
  for(const [relative,sha]of Object.entries(manifest.files)) {
    const file=inside(root,relative);bytes+=fs.statSync(file).size;
    assert.ok(bytes<=512*1024*1024);assert.equal(rawSha(file),sha,`Retained evidence changed: ${relative}`);
  }
  const expected=expectedAcceptance(manifest.request),original=read(inside(root,manifest.original.resultFile));
  same(original.outputs,expected.outputs);same(effects(original.effects),expected.effects);
  assert.equal(rawSha(inside(root,manifest.original.resultFile)),manifest.original.resultSha);
  const originalSnapshot=readRuntimeSnapshot(manifest.original.stateRoot,manifest.original.boardCommit);
  assert.equal(digest(originalSnapshot.state),manifest.original.stateSha);
  let signedNodes=0;
  if(verifySigned) {
    const checked=await verifyReplayTrial(
      {stateDir:manifest.original.stateRoot,resultFile:inside(root,manifest.original.resultFile),
        request:manifest.request,boardCommit:manifest.original.boardCommit,telosRoot});
    signedNodes+=checked.accepted;
  }
  // Each trial: its snapshot and result must match the manifest and produce the expected outputs and
  // exactly one write per effect; its timings are taken from the retained result, not re-measured.
  const rows=[];
  for(const trial of manifest.trials) {
    const stateDir=inside(root,trial.stateDir),resultFile=inside(root,trial.resultFile),result=read(resultFile);
    const snapshot=readRuntimeSnapshot(stateDir,trial.boardCommit);
    assert.equal(digest(snapshot.state),trial.stateSha);
    assert.equal(readRuntimeSnapshot(stateDir).commit,trial.boardCommit);
    same(result.outputs,expected.outputs);same(effects(result.effects),expected.effects);
    assert.equal(result.held.length,0);assert.equal(result.blockers.length,0);
    assert.equal(result.destinationInvocations.length,expected.effects.length);
    assert.ok(result.effects.every(effect=>effect.writeCount===1));
    assert.equal(result.durationMs,result.endedAt-result.startedAt);
    if(verifySigned) {
      const checked=await verifyReplayTrial(
        {stateDir,resultFile,request:manifest.request,boardCommit:trial.boardCommit,telosRoot});
      signedNodes+=checked.accepted;
    }
    rows.push({id:trial.id,kind:trial.kind,slots:trial.slots,pair:trial.pair,
      durationMs:result.durationMs,stageP95Ms:p95(stageSamples(snapshot.state,result)),
      recoveryMs:trial.kind==='recovery'?result.durationMs:null,
      outputSha:digest(result.outputs),effectSha:digest(effects(result.effects))});
  }
  const clean=rows.filter(row=>row.kind==='clean'),
    select=(slots,key)=>clean.filter(row=>row.slots===slots).map(row=>row[key]);
  const measurements={
    baselineMs:select(1,'durationMs'),candidateMs:select(3,'durationMs'),baselineP95Ms:select(1,'stageP95Ms'),
    candidateP95Ms:select(3,'stageP95Ms'),
    baselineRecoveryMs:rows.find(row=>row.kind==='recovery'&&row.slots===1).recoveryMs,
    candidateRecoveryMs:rows.find(row=>row.kind==='recovery'&&row.slots===3).recoveryMs,
    trialCostMs:manifest.measurements.benchmarkWallMs};
  // The governance numeric gate, re-run on the reproduced measurements, must reach the recorded comparison.
  const evaluation=assessEfficiency(measurements);
  assert.equal(evaluation.conservativeSavedMs,manifest.comparison.conservativeSavedMs);
  assert.equal(evaluation.forecastNetSavedMs,manifest.comparison.forecastNetSavedMs);
  return {schema:'ophanim.admission-observation/v1',evidenceClass:'retained-measured-evaluation',manifestFile,
    manifestSha:rawSha(manifestFile),
    recordedAt:manifest.startedAt,request:manifest.request,measurements,evaluation,rows,
    acceptance:{
      outputSha:digest(expected.outputs),effectSha:digest(expected.effects),obligations:expected.obligations.length,
      effects:expected.effects.length,
      signedNodesReverified:signedNodes,
      verification:verifySigned?'actual TELOS semantic replay':'retained hashes only'},
    interpretation:'Historical local timings; independent acceptance recheck does not rerun or improve those timings.',
    boundaries:boundaries()};
}

// A deterministic schedule of the dependency graph with `slots` workers: repeatedly start up to `slots`
// ready obligations (in id order), each wave taking serviceMs plus controllerMs per accepted worker.
function modeledSchedule(obligations,slots,{serviceMs,controllerMs,startupMs}) {
  const accepted=new Set(),waves=[],latencies=[];let time=startupMs;
  while(accepted.size<obligations.length) {
    const ready=obligations.filter(row=>!accepted.has(row.id)&&row.dependsOn.every(id=>accepted.has(id))).sort(
      (a,b)=>a.id.localeCompare(b.id)).slice(0,slots);
    assert.ok(ready.length,'Model requires an acyclic admitted graph');
    const start=time;
    // Runtime waits for each whole ready batch; a serialized controller accepts
    // its completed workers. These are declared model costs, never timestamps.
    for(let index=0;index<ready.length;index++)latencies.push(serviceMs+(index+1)*controllerMs);
    time+=serviceMs+ready.length*controllerMs;
    waves.push({start,finish:time,ids:ready.map(row=>row.id)});
    ready.forEach(row=>accepted.add(row.id));
  }
  return {durationMs:time,p95Ms:p95(latencies),waves};
}

// The preserved six-node graph under declared costs for a hypothetical cheaper controller: shows the
// unchanged numeric gate (assessEfficiency) can admit a feasible case. A model, not a qualification.
export function controlledPositiveModel({request,acceptance}={}) {
  const expected=expectedAcceptance(request);
  assert.equal(expected.obligations.length,6,'The bounded positive model uses the preserved two-case graph');
  assert.equal(acceptance?.outputSha,digest(expected.outputs));
  assert.equal(acceptance.effectSha,digest(expected.effects));
  // A hypothetical cheaper local controller. No source/configuration or
  // authority changes are performed to make this assumption true.
  const assumptions = {
    serviceMs: 500,
    controllerMs: 5,
    startupMs: 20,
    verificationPerNodeMs: 5,
    fullAuthorityOverheadMs: 1000,
    recovery:
      'Conservative complete second execution after a lost outcome; one effect per stable key is required by the ' +
        'separately verified acceptance evidence.'
  };
  const baseline=modeledSchedule(expected.obligations,1,assumptions),
    candidate=modeledSchedule(expected.obligations,3,assumptions);
  const cleanCostMs=3*(baseline.durationMs+candidate.durationMs);
  const recoveryCostMs=2*(baseline.durationMs+candidate.durationMs);
  const verificationCostMs=9*expected.obligations.length*assumptions.verificationPerNodeMs;
  const trialCostMs=cleanCostMs+recoveryCostMs+verificationCostMs;
  const measurements={baselineMs:Array(3).fill(baseline.durationMs),candidateMs:Array(3).fill(candidate.durationMs),
    baselineP95Ms:Array(3).fill(baseline.p95Ms),candidateP95Ms:Array(3).fill(candidate.p95Ms),
    baselineRecoveryMs:baseline.durationMs,candidateRecoveryMs:candidate.durationMs,trialCostMs};
  assert.ok(trialCostMs<=30000,'Model must obey the unchanged replay allowance');
  const evaluation=assessEfficiency(measurements);
  const fullAssessmentNetMs=evaluation.forecastGrossSavedMs-trialCostMs-assumptions.fullAuthorityOverheadMs;
  assert.equal(evaluation.eligible,true);assert.ok(fullAssessmentNetMs>0);
  return {
    schema: 'ophanim.admission-capacity-model/v1',
    evidenceClass: 'deterministic-model',
    timingOrigin: 'explicit assumptions, not wall-clock measurements',
    assumptions,
    requestSha: digest(request),
    acceptance: {
      outputSha: acceptance.outputSha,
      effectSha: acceptance.effectSha,
      obligations: expected.obligations.length,
      effects: expected.effects.length
    },
    schedules: {baseline, candidate},
    cost: {
      cleanCostMs,
      recoveryCostMs,
      verificationCostMs,
      trialCostMs,
      fullAuthorityOverheadMs: assumptions.fullAuthorityOverheadMs
    },
    measurements,
    evaluation,
    fullAssessmentNetMs,
    productionAdmission: false,
    interpretation:
      'The unchanged numeric gate admits a feasible capacity model. This is neither an actual runtime qualification ' +
        'nor a signed scheduler decision.',
    boundaries: boundaries()
  };
}

// The nine-node fixture under declared costs, passed through both unchanged decision functions: the
// admission screening (on a modeled width-1 trace built to the trace schema) and the numeric gate.
export function controlledDualGateModel({request,acceptance}={}) {
  const expected=expectedAcceptance(request);assert.equal(expected.obligations.length,9);
  assert.equal(acceptance.outputSha,digest(expected.outputs));
  assert.equal(acceptance.effectSha,digest(expected.effects));
  const assumptions={serviceMs:400,controllerMs:5,startupMs:20,verificationPerNodeMs:5};
  const baseline=modeledSchedule(expected.obligations,1,assumptions),
    candidate=modeledSchedule(expected.obligations,3,assumptions);
  // The scope is built exactly as the runtime builds it, so the modeled trace binds to a real scope.
  const fixtures=request.batches.map(makeFixtures),
    options={department:fixtures[0].department,departments:[...new Set(fixtures.map(f=>f.department))].sort(),
    version:'synthetic-v1',delayMs:15,...request.workerOptions};
  const registry=createWorkers(options).map(({id,version,kinds,scopes})=>({id,version,kinds,scopes})).sort(
    (a,b)=>a.id.localeCompare(b.id));
  const artifact={
    schema:'ophanim.synthetic-worker-artifact/v1',
    sourceSha:rawSha(fileURLToPath(new URL('../fixtures.mjs',import.meta.url))),options,workers:registry};
  const normalizedRequest={batches:request.batches,maxDispatches:request.maxDispatches,workerOptions:options};
  const scope=efficiencyScope(
    {obligations:expected.obligations,planning:createPlanning({batches:request.batches}),
      workerArtifactSha:digest(artifact),registry,request:normalizedRequest,slots:1});
  // A width-1 trace from the modeled baseline: one obligation per wave, its attempt and its acceptance check.
  const obligations=[],attempts=[],verifications=[];
  for(const wave of baseline.waves){
    assert.equal(wave.ids.length,1);const spec=expected.obligations.find(row=>row.id===wave.ids[0]);
    const {expected:output,...brief}=spec;
    const inputs={
      ...spec.inputs,
      dependencies:Object.fromEntries(
        spec.dependsOn.map(id=>[id,{output:expected.outputs[id],sha256:digest(expected.outputs[id])}]))};
    const startedAt=wave.start,endedAt=startedAt+assumptions.serviceMs,acceptedAt=wave.finish;
    obligations.push(
      {id:spec.id,kind:spec.kind,scope:spec.scope,dependsOn:spec.dependsOn,specSha:digest(spec),status:'accepted',
        acceptedAttempt:1,acceptedAt});
    attempts.push(
      {id:spec.id,attempt:1,startedAt,endedAt,inputSha:digest(inputs),
        inputBytes:Buffer.byteLength(canonical(inputs)),
        contextBytes:Buffer.byteLength(canonical({obligation:brief,inputs,priorAttempts:0}))});
    verifications.push(
      {id:spec.id,attempt:1,purpose:'accept',startedAt:endedAt,endedAt:acceptedAt,candidateSha:digest(output),ok:true});
  }
  const modeledTrace={
    schema:'ophanim.efficiency.trace/v1',timingOrigin:'modeled; no runtime timestamps',obligations,attempts,
    verifications,
    window:{startedAt:0,endedAt:baseline.durationMs},configuration:scope.configuration,policy:scope.policy,
    scopeSha:scope.scopeSha,release:{id:'baseline'},
    original:{
      convergence:'accepted_change',slots:1,modelCalls:0,outputSha:acceptance.outputSha,
      effectSha:acceptance.effectSha,durationMs:baseline.durationMs}};
  const screeningDecision=assessOptimizationAdmission({trace:modeledTrace,expectedQualifiedConvergences:20});
  assert.equal(screeningDecision.admitted,true,JSON.stringify(screeningDecision.blockers));
  assert.equal(screeningDecision.policyAuthorization,false);
  // Replay cost as the experiment would spend it: five runs of each width and nine checks per node.
  const trialCostMs=5*(
    baseline.durationMs+candidate.durationMs)+9*expected.obligations.length*assumptions.verificationPerNodeMs;
  const measurements={baselineMs:Array(3).fill(baseline.durationMs),candidateMs:Array(3).fill(candidate.durationMs),
    baselineP95Ms:Array(3).fill(baseline.p95Ms),candidateP95Ms:Array(3).fill(candidate.p95Ms),
    baselineRecoveryMs:baseline.durationMs,candidateRecoveryMs:candidate.durationMs,trialCostMs};
  const finalNumericEvaluation=assessEfficiency(measurements);assert.equal(finalNumericEvaluation.eligible,true);
  assert.ok(trialCostMs<=30000);
  return {
    schema: 'ophanim.admission-dual-gate-model/v1',
    evidenceClass: 'deterministic-model',
    timingOrigin: 'declared capacity assumptions, not measured execution',
    requestSha: digest(request),
    acceptance: {outputSha: acceptance.outputSha, effectSha: acceptance.effectSha, obligations: 9, effects: 3},
    assumptions,
    modeledTrace,
    measurements,
    screeningDecision,
    finalNumericEvaluation,
    productionAdmission: false,
    interpretation:
      'The same nine-node fixture contracts pass both unchanged decision functions under the declared modeled ' +
        'capacities. No measured trial, signed authority or activated policy is produced.',
    boundaries: boundaries()
  };
}

// Read (and optionally re-verify with TELOS) one measured pair written by runPairedProbe: both widths must
// produce the same outputs, effects and worker context; reports the observed saving and the p95 limit.
export async function readPairedProbe({root,telosRoot,verifySigned=true}={}) {
  const preflight=read(path.join(root,'preflight.json')),rows=[];
  assert.equal(preflight.kind,'measured-pair-not-admission');
  const expected=expectedAcceptance(preflight.request);
  for(const slots of [1,3]) {
    const dir=path.join(root,String(slots)),resultFile=path.join(dir,'result.json'),stateDir=path.join(dir,'state'),
      result=read(resultFile),guard=read(path.join(dir,'watchdog.json'));
    assert.equal(guard.exitCode,0);assert.equal(result.slots,slots);
    same(result.outputs,expected.outputs);same(effects(result.effects),expected.effects);
    const verification=verifySigned?
      await verifyReplayTrial({stateDir,resultFile,request:preflight.request,telosRoot})
      :read(path.join(dir,'verification.json'));
    const snapshot=readRuntimeSnapshot(stateDir);
    rows.push(
      {slots,durationMs:result.durationMs,stageP95Ms:p95(stageSamples(snapshot.state,result)),
        contextBytes:verification.derivedWorkerContextBytes,
      outputSha:digest(result.outputs),effectSha:digest(effects(result.effects)),accepted:verification.accepted,
      modelCalls:result.limits.modelCalls,
      files:{
        resultFile,resultSha:rawSha(resultFile),watchdogFile:path.join(dir,'watchdog.json'),
        watchdogSha:rawSha(path.join(dir,'watchdog.json'))},boardCommit:snapshot.commit});
  }
  same(rows[0].outputSha,rows[1].outputSha);same(rows[0].effectSha,rows[1].effectSha);
  same(rows[0].contextBytes,rows[1].contextBytes);
  const savedMs=rows[0].durationMs-rows[1].durationMs,p95LimitMs=rows[0].stageP95Ms*1.25+25;
  return {
    schema: 'ophanim.admission-paired-probe/v1',
    evidenceClass: 'measured-preflight-pair',
    root,
    request: preflight.request,
    rows,
    savedMs,
    fraction: savedMs / rows[0].durationMs,
    p95LimitMs,
    p95Passed: rows[1].stageP95Ms <= p95LimitMs,
    productionAdmission: false,
    interpretation:
      'One measured pair establishes only this observed run difference. Three pairs, both recovery trials, full cost ' +
        'and independent admission are still required.',
    boundaries: boundaries()
  };
}

// Run one guarded 1-slot and one guarded 3-slot execution of a small fixture into a fresh directory,
// verify each, and write the paired report. Measured, but one pair is not admission evidence.
export async function runPairedProbe({outputDir,count=2,delayMs=500,telosRoot}={}) {
  assert.ok([2,3].includes(count));assert.ok(Number.isInteger(delayMs)&&delayMs>=0&&delayMs<=1000);fresh(outputDir);
  const request={
    batches:[{count,namespace:'admission'}],maxDispatches:1000,workerOptions:{version:'synthetic-v1',delayMs}};
  for(const slots of [1,3]) {
    const dir=path.join(outputDir,String(slots)),stateDir=path.join(dir,'state'),
      resultFile=path.join(dir,'result.json'),requestFile=path.join(dir,'request.json'),
      reportFile=path.join(dir,'watchdog.json');
    writeJson(requestFile,{...request,stateDir,resultFile,slots,...telosRoot?{telosRoot}:{}});
    const guard=await guardWorker(
      {requestFile,reportFile,replay:true,replayRoot:outputDir,timeoutMs:30000,stallMs:10000});
    assert.equal(guard.exitCode,0,guard.stderr||guard.reason);
    writeJson(path.join(dir,'verification.json'),await verifyReplayTrial({stateDir,resultFile,request,telosRoot}));
  }
  writeJson(path.join(outputDir,'preflight.json'),{kind:'measured-pair-not-admission',request});
  const report=await readPairedProbe({root:outputDir,telosRoot,verifySigned:false});
  writeJson(path.join(outputDir,'paired-report.json'),report);return report;
}

// Hash of every regular file under root (by relative path); refuses symbolic links and special files.
function inventory(root) {
  const files={};
  function walk(directory){
    for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const file=path.join(directory,entry.name);assert.ok(!entry.isSymbolicLink());
      if(entry.isDirectory())walk(file);
      else {assert.ok(entry.isFile());files[path.relative(root,file)]=rawSha(file);}
    }
  }
  walk(root);return {fileCount:Object.keys(files).length,sha256:digest(files)};
}

// Exactly one real baseline. The supplied scope ledger already contains the
// completed experiment; the normal controller must read it and decline replay.
export async function runRetainedAdmissionBaseline({outputDir,manifestFile,telosRoot}={}) {
  fresh(outputDir);
  const manifest=read(manifestFile),originalRoot=manifest.original.stateRoot,
    efficiencyRoot=path.join(originalRoot,'efficiency');
  const markerFile=path.join(efficiencyRoot,'scopes',manifest.scopeSha,'experiment.json'),marker=read(markerFile);
  assert.equal(marker.evidenceRoot,path.dirname(manifestFile));
  const oldTrace=read(path.join(path.dirname(marker.evidenceRoot),'trace.json'));
  const prior=readRetainedExperiment(markerFile,oldTrace);assert.equal(prior.verified,true);
  const request=manifest.request,expected=expectedAcceptance(request);
  const registry=createWorkers(request.workerOptions).map(
    ({id,version,kinds,scopes})=>({id,version,kinds,scopes})).sort((a,b)=>a.id.localeCompare(b.id));
  const artifact={
    schema:'ophanim.synthetic-worker-artifact/v1',
    sourceSha:rawSha(fileURLToPath(new URL('../fixtures.mjs',import.meta.url))),options:request.workerOptions,
    workers:registry};
  const scope=efficiencyScope(
    {obligations:expected.obligations,planning:createPlanning({batches:request.batches}),
      workerArtifactSha:digest(artifact),registry,request,slots:1});
  assert.equal(scope.scopeSha,manifest.scopeSha,'Current source/input scope differs from the original ledger');
  // Snapshot the retained inputs, so the run can be shown not to have changed them.
  const before=inventory(originalRoot),
    inputHashes={
        requestSha:digest(request),manifestSha:rawSha(manifestFile),markerSha:rawSha(markerFile),
      originalBoardCommit:readRuntimeSnapshot(originalRoot).commit};
  const stateDir=path.join(outputDir,'state'),resultFile=path.join(outputDir,'result.json'),
    requestFile=path.join(outputDir,'request.json'),watchdogFile=path.join(outputDir,'watchdog.json');
  writeJson(
    requestFile,
    {...request,stateDir,resultFile,slots:1,efficiencyRoot,expectedQualifiedConvergences:20,
      ...telosRoot?{telosRoot}:{}});
  const started=performance.now();
  const guard=await guardWorker({requestFile,reportFile:watchdogFile,timeoutMs:30000,stallMs:10000});
  const processWallMs=performance.now()-started;
  assert.equal(guard.exitCode,0,guard.stderr||guard.reason);
  const result=read(resultFile),record=result.efficiency;
  const assessment=verifyEfficiencyRecord({stateDir,record,output:result});
  assert.equal(result.complete,true);assert.equal(result.slots,1);
  assert.equal(result.dispatches,expected.obligations.length);
  same(result.outputs,expected.outputs);same(effects(result.effects),expected.effects);
  // The controller must have read the retained experiment as an applicable prior and declined to replay.
  assert.equal(assessment.admission.decision.prior.applicable,true,assessment.reason);
  assert.equal(assessment.admission.decision.forecast.expectedQualifiedConvergences,20);
  assert.equal(assessment.admission.decision.replays,0);assert.equal(assessment.admission.decision.admitted,false);
  assert.equal(assessment.priorMarker,markerFile);assert.equal(assessment.outcome,'no_change');
  assert.ok(!assessment.experiment);assert.ok(!fs.existsSync(path.join(path.dirname(record.reportFile),'experiment')));
  const after=inventory(originalRoot);same(after,before,'Fresh matching baseline modified retained original inputs');
  same(inputHashes,
    {requestSha:digest(manifest.request),manifestSha:rawSha(manifestFile),markerSha:rawSha(markerFile),
      originalBoardCommit:readRuntimeSnapshot(originalRoot).commit});
  const proof={
    schema:'ophanim.retained-admission-baseline/v1',evidenceClass:'measured-fresh-matching-baseline',
    requestSha:digest(request),scopeSha:manifest.scopeSha,
    stateDir,resultFile,resultSha:rawSha(resultFile),watchdogFile,assessmentFile:record.reportFile,
    assessmentSha:rawSha(record.reportFile),
    execution:{
      baselineRuns:1,accepted:result.accepted.length,dispatches:result.dispatches,baselineMs:result.durationMs,
      processWallMs},
    admission:assessment.admission,outcome:assessment.outcome,reason:assessment.reason,
    overhead:{wholeAssessmentWallMs:assessment.cost.wallMs,gateWallMs:assessment.admission.cost.wallMs,
      gateIncludedInWholeAssessment:true,controllerCpuMicros:assessment.cost.controllerCpuMicros},
    retained:{markerFile,inputHashes,before,after,unchanged:true},replays:0,newExperimentDirectories:0,
    verification:'verifyEfficiencyRecord rederived the trace, contribution registry, variables and admission decision',
    boundaries:boundaries()};
  writeJson(path.join(outputDir,'retained-baseline-proof.json'),proof);return proof;
}

// The whole report: the fresh baseline, the reproduced retained evaluation, the positive capacity model,
// any paired probes, and the dual-gate model when a nine-node probe supplies its acceptance hashes.
export async function buildAdmissionProof({outputDir,manifestFile,probeRoots=[],telosRoot,verifySigned=true}={}) {
  fresh(outputDir);
  const freshBaseline=await runRetainedAdmissionBaseline(
    {outputDir:path.join(outputDir,'fresh-baseline'),manifestFile,telosRoot});
  const retained=await reproduceRetainedEvaluation({manifestFile,telosRoot,verifySigned});
  const controlled=controlledPositiveModel({request:retained.request,acceptance:retained.acceptance});
  const probes=[];for(const root of probeRoots)probes.push(await readPairedProbe({root,telosRoot,verifySigned}));
  const nineNodeProbe=probes.find(probe=>probe.rows[0].accepted===9);
  const dualGateModel=nineNodeProbe?
    controlledDualGateModel({request:nineNodeProbe.request,acceptance:nineNodeProbe.rows[0]}):null;
  const report={schema:'ophanim.admission-proof/v1',freshBaseline,retained,controlled,dualGateModel,probes,
    conclusions:{
      measuredHistoricalGainMs:retained.evaluation.conservativeSavedMs,
      measuredHistoricalAdmission:retained.evaluation.eligible,
      deterministicPositiveCase:controlled.evaluation.eligible,actualNewPolicyAdmitted:false},boundaries:boundaries()};
  const reportFile=path.join(outputDir,'admission-proof.json');writeJson(reportFile,report);
  return {...report,reportFile};
}

// CLI: `report` builds the full proof; `probe` runs one measured pair. Options are --name value pairs.
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [mode,...argv]=process.argv.slice(2),options={};
    for(let i=0;i<argv.length;i+=2){
      assert.ok(argv[i]?.startsWith('--')&&argv[i+1]);options[argv[i].slice(2)]=argv[i+1];}
    const telosRoot=options.telos??process.env.OPHANIM_TELOS_ROOT;
    const result=mode==='report'?
      await buildAdmissionProof(
        {outputDir:options.output,manifestFile:options.manifest,probeRoots:options.probes?.split(',')??[],telosRoot}):
      mode==='probe'?
        await runPairedProbe(
          {outputDir:options.output,count:Number(options.count??2),delayMs:Number(options.delay??500),telosRoot}):null;
    assert.ok(result,
      'Use report --output ROOT --manifest FILE [--probes ROOT,ROOT], or probe --output ROOT [--count 2 --delay 500]');
    process.stdout.write(
      JSON.stringify(
        mode==='report'?{reportFile:result.reportFile,conclusions:result.conclusions}:{
          root:result.root,savedMs:result.savedMs,p95Passed:result.p95Passed})+'\n');
  }catch(error){process.stderr.write(error.stack+'\n');process.exitCode=1;}
}
