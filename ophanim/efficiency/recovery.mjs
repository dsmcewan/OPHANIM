// ophanim/efficiency/recovery.mjs -- close an efficiency assessment that a crash interrupted.
//
// Called only while the CLI holds its synthetic-driver lock, before starting a
// new runtime convergence. Recovery records an interruption; it never replays
// work, signs a decision, or activates an optimization.
//
// Purpose: when the previous run settled a convergence but died before writing its assessment, write a
//   conservative `no_change` / `interrupted-assessment` report for it, so every settled convergence has
//   exactly one assessment and the lost cost is recorded as unmeasured rather than as zero.
// Inputs:  recoverInterruptedAssessment({stateDir, priorRuntime, scope, governance}): the canonical state
//   directory, the runtime state found at start-up (must be the current committed snapshot), the run's
//   scope, and the fixture governance (whose identity the retained trace must name).
// Outputs: null when there is nothing to recover (no prior runtime, no settled convergence, or an
//   assessment already exists); otherwise writes trace.json (if missing) and assessment.json under
//   <stateDir>/efficiency/convergences/<commit>/ and returns the efficiency record, verified.
// Invariants: a retained trace is used only after it re-binds to the committed snapshot; a missing one is
//   reconstructed from committed state only, with every unobserved measurement null and listed as missing
//   (current source or configuration is never taken as the interrupted run's policy); files are
//   write-once; a partial experiment directory is described, never resumed.
// Must never: replay or retry work or an experiment, sign or authorize a decision, activate an
//   optimization, or invent a measurement.
import fs from 'node:fs';
import path from 'node:path';
import {canonical,digest,readRuntimeSnapshot} from '../board.mjs';
import {analyzeTrace,applicabilityFingerprint} from './analyze.mjs';
import {verifyEfficiencyRecord} from './assessment.mjs';

const VERSION='ophanim.efficiency/v1';
const MAX_FILE_BYTES=16*1024*1024;
const fail=message=>{throw Error(`Efficiency recovery: ${message}`);};
const same=(a,b)=>canonical(a)===canonical(b);
// Parse a bounded regular JSON file at its canonical path (no symbolic link).
function regularJson(file){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE_BYTES||fs.realpathSync(file)!==file)
    fail('bounded canonical evidence file required');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
// Create (if needed) a canonical directory.
function directory(dir){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(!fs.lstatSync(dir).isDirectory()||fs.realpathSync(dir)!==dir)fail('canonical evidence directory required');
}
// Write-once via hard link from a private temporary file; an existing (or concurrently written) file must
// already hold exactly `value`.
function put(file,value){
  if(fs.existsSync(file)){if(!same(regularJson(file),value))fail('immutable recovery record differs');return;}
  const bytes=canonical(value);
  if(Buffer.byteLength(bytes)>MAX_FILE_BYTES)fail('recovery record size bound');
  const temporary=`${file}.${process.pid}.recovery.tmp`;
  const fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.linkSync(temporary,file);}
  catch(error){if(error.code!=='EEXIST'||!same(regularJson(file),value))throw error;}
  finally{fs.unlinkSync(temporary);}
}
// The projections assessment.mjs puts in a trace, rebuilt from committed state: the obligation graph,
// acceptance evidence, accepted outputs by id, confirmed effects by key, and each attempt's inputs.
function graph(state){
  return Object.values(state.obligations).map(row=>{
    const spec=row.spec;
    const acceptedEvent=state.events.findLast(
      event=>event.type==='work.accepted'&&event.id===spec.id&&event.attempt===row.accepted?.attempt);
    return {id:spec.id,kind:spec.kind,scope:spec.scope,dependsOn:spec.dependsOn,specSha:digest(spec),status:row.status,
      ...(row.accepted?{acceptedAttempt:row.accepted.attempt}:{}),
      ...(Number.isFinite(acceptedEvent?.atMs)?{acceptedAt:acceptedEvent.atMs}:{})};
  }).sort((a,b)=>a.id.localeCompare(b.id));
}
function acceptance(state){
  return Object.values(state.obligations).filter(row=>row.status==='accepted').map(row=>({
    id:row.spec.id,specSha:digest(row.spec),outputSha:row.accepted.sha256,planRef:row.accepted.planRef,
    evidenceRefs:row.accepted.verification?.evidenceRefs??[],publication:row.candidate.published,
  })).sort((a,b)=>a.id.localeCompare(b.id));
}
function outputProjection(state){
  return Object.fromEntries(
    Object.values(state.obligations).filter(row=>row.status==='accepted')
      .sort((a,b)=>a.spec.id.localeCompare(b.spec.id)).map(row=>[row.spec.id,row.accepted.output]));
}
function effectProjection(state){
  return Object.values(state.effects).filter(effect=>effect.status==='confirmed').map(
    ({key,payload})=>({key,payload})).sort((a,b)=>a.key.localeCompare(b.key));
}
const eventValue=({sequence,...event})=>event;
function committedInputs(state,id,attempt){
  const spec=state.obligations[id].spec,{expected,...brief}=spec;
  const dependencies=Object.fromEntries(spec.dependsOn.map(dep=>{
    const accepted=state.obligations[dep].accepted;
    if(!accepted||digest(accepted.output)!==accepted.sha256)fail('dependency bytes differ');
    return [dep,{output:accepted.output,sha256:accepted.sha256}];
  }));
  const inputs={...spec.inputs,dependencies};
  return {inputSha:digest(inputs),inputBytes:Buffer.byteLength(canonical(inputs)),
    contextBytes:Buffer.byteLength(canonical({obligation:brief,inputs,priorAttempts:attempt-1}))};
}
// A retained (or reconstructed) trace must match the committed snapshot it names: graph, acceptance,
// release, scope, authority, an in-order subsequence of the committed events ending on the settle, the
// convergence result, the committed policy context, and every recorded attempt's timing and inputs.
function verifyRetained(trace,{commit,state},governance){
  if(trace.schema!=='ophanim.efficiency.trace/v1'||trace.boardCommit!==commit||trace.stateSha!==digest(state))
    fail('retained trace snapshot differs');
  if(!same(trace.obligations,graph(state))||!same(trace.accepted,acceptance(state)))
    fail('retained trace obligation graph or acceptance differs');
  if(!same(trace.release,state.releases[state.activeRelease]))fail('retained trace release differs');
  if(trace.scopeSha!==applicabilityFingerprint({obligations:trace.obligations,configuration:trace.configuration}))
    fail('retained trace scope differs');
  if(governance?.identity&&!same(trace.authority,governance.identity))fail('retained fixture authority differs');
  if(!Array.isArray(trace.events)||trace.events.length>25000)fail('bounded retained event list required');
  let cursor=0;
  for(const event of trace.events){
    while(cursor<state.events.length&&!same(event,eventValue(state.events[cursor])))cursor++;
    if(cursor===state.events.length)fail('retained event differs from committed history');
    cursor++;
  }
  const settled=state.events.at(-1);
  if(!trace.events.length||!same(trace.events.at(-1),eventValue(settled)))
    fail('retained trace omits committed convergence');
  if(trace.original?.convergence!==settled.convergence||trace.original.outputSha!==digest(outputProjection(state))||
    trace.original.effectSha!==digest(effectProjection(state))||trace.original.slots!==trace.configuration.slots)
    fail('retained convergence result differs');
  const opened=state.events.findLast(event=>event.type==='runtime.opened');
  if(opened?.efficiencyContext){
    if(!same(trace.configuration,opened.efficiencyContext.configuration)||
      !same(trace.policy,opened.efficiencyContext.policy))
      fail('retained policy context differs from committed context');
  }
  analyzeTrace(trace);
  for(const attempt of trace.attempts){
    const start=state.events.find(
      event=>event.type==='work.started'&&event.id===attempt.id&&event.attempt===attempt.attempt);
    const end=state.events.find(
      event=>['work.persisted','work.failed'].includes(event.type)&&event.id===attempt.id&&
      event.attempt===attempt.attempt);
    if(start?.atMs!==attempt.startedAt||end?.atMs!==attempt.endedAt)
      fail('retained attempt timing differs from committed events');
    const expected=committedInputs(state,attempt.id,attempt.attempt);
    for(const field of ['inputSha','inputBytes','contextBytes'])
      if(attempt[field]!==undefined&&attempt[field]!==expected[field])
        fail(`retained ${field} differs from committed inputs`);
  }
}
// A trace rebuilt from committed state alone: events from the last opening, no attempts or checks, and
// every measurement the crash lost set to null and listed under recovery.missingMeasurements.
function reconstruct({commit,state},scope,governance){
  const settled=state.events.at(-1),opened=state.events.findLast(event=>event.type==='runtime.opened');
  const context=opened?.efficiencyContext;
  // Current source/configuration is not evidence of the interrupted run's
  // original policy. Use only the context committed in that run, or nulls.
  const configuration=context?JSON.parse(canonical(context.configuration)):{
    slots:opened?.slots??1,workerRegistry:state.releases[state.activeRelease].workers,
    workerArtifactSha:null,policySha:null,inputRevision:null,
  };
  const obligations=graph(state),scopeSha=applicabilityFingerprint({obligations,configuration});
  const start=Number.isFinite(opened?.atMs)?opened.atMs:settled.atMs;
  if(start>settled.atMs)fail('committed convergence timestamps are not ordered');
  const events=state.events.filter(event=>Number.isFinite(event.atMs)&&event.atMs>=start).map(eventValue);
  return {schema:'ophanim.efficiency.trace/v1',boardCommit:commit,stateSha:digest(state),scopeSha,configuration,
    policy:context?.policy??{schema:'ophanim.efficiency.missing-policy/v1',originalPolicy:null},
    release:state.releases[state.activeRelease],authority:governance?.identity??null,obligations,
    accepted:acceptance(state),events,attempts:[],verifications:[],
    window:{startedAt:start,endedAt:settled.atMs},
    original:{
      convergence:settled.convergence,slots:configuration.slots,outputSha:digest(outputProjection(state)),
      effectSha:digest(effectProjection(state)),durationMs:null,
      measurements:{
        acceptedStageSamples:null,p95StageAcceptanceMs:null,workerContextBytes:null,verificationCalls:null},
      modelCalls:null},
    recovery:{
      schema:'ophanim.efficiency.recovered-trace/v1',source:'committed-snapshot',
      originalScopeContext:context?'committed':'unavailable',
      measurementCoverage:'unavailable',
      missingMeasurements:[
        'attempt-timings','verification-timings','input-context-bytes','original-run-duration',
        'interrupted-assessment-cost']}};
}
// What a partial experiment left behind, described (at most 128 top-level names) but not resumed.
function replayEvidence(reportDir){
  const root=path.join(reportDir,'experiment');
  if(!fs.existsSync(root))return null;
  if(!fs.lstatSync(root).isDirectory()||fs.realpathSync(root)!==root)fail('canonical retained experiment required');
  const entries=fs.readdirSync(root).sort();
  return {root,preserved:true,retried:false,topLevelEntries:entries.slice(0,128),
    additionalEntries:Math.max(0,entries.length-128)};
}

// See the header.
export async function recoverInterruptedAssessment({stateDir,priorRuntime,scope,governance}={}){
  if(!priorRuntime)return null;
  if(!path.isAbsolute(stateDir??'')||path.resolve(stateDir)!==stateDir||fs.realpathSync(stateDir)!==stateDir)
    fail('canonical absolute state directory required');
  const snapshot=readRuntimeSnapshot(stateDir);
  if(!snapshot.state||digest(snapshot.state)!==digest(priorRuntime))
    fail('prior runtime is not the current committed snapshot');
  const settled=snapshot.state.events?.at(-1);
  if(settled?.type!=='runtime.settled'||!Number.isFinite(settled.atMs))return null;
  const reportDir=path.join(stateDir,'efficiency','convergences',snapshot.commit.replace(':','-'));
  const reportFile=path.join(reportDir,'assessment.json');
  if(fs.existsSync(reportFile))return null;
  directory(reportDir);
  const traceFile=path.join(reportDir,'trace.json'),retained=fs.existsSync(traceFile);
  const trace=retained?regularJson(traceFile):reconstruct(snapshot,scope,governance);
  verifyRetained(trace,snapshot,governance);
  if(!retained)put(traceFile,trace);
  const traceSha=digest(trace),analysis=analyzeTrace(trace);
  const report={
    schema:VERSION,scopeSha:trace.scopeSha,traceSha,analysis,outcome:'no_change',reason:'interrupted-assessment',
    recovery:{
      schema:'ophanim.efficiency.assessment-recovery/v1',trace:retained?'retained':'reconstructed',
      optimizationAttempted:false,replayRetried:false,
      measurementCoverage:trace.recovery?.measurementCoverage??(retained?'retained-observations-only':'unavailable'),
      partialReplayEvidence:replayEvidence(reportDir),
      missingMeasurements:[
        ...new Set(
          [...(trace.recovery?.missingMeasurements??[]),'interrupted-assessment-cost','partial-replay-cost'])]},
    cost:{wallMs:null,controllerCpuMicros:null,replayBudgetMs:trace.policy?.replayBudgetMs??null,modelCalls:null,
      providerSpend:null}};
  put(reportFile,report);
  const record={
    outcome:report.outcome,reason:report.reason,traceSha,scopeSha:trace.scopeSha,boardCommit:snapshot.commit,
    reportFile};
  verifyEfficiencyRecord({stateDir,record});
  return record;
}
