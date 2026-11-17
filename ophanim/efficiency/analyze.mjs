// ophanim/efficiency/analyze.mjs -- pure analysis of one convergence's retained trace.
//
// Pure analysis of bounded controller observations. This module does not read
// files, call providers, infer unobserved timings, or authorize policy changes.
//
// Purpose: validate a trace's obligations, worker attempts and acceptance/replay checks against one
//   observation window, and summarise what they show: the applicability fingerprint (what the trace is
//   evidence about), the measured critical path, scheduling waits and unused slot time, verification
//   repetition, retries and input/context bytes. Every summary carries its own interpretation limit.
// Inputs:  analyzeTrace({obligations, attempts, verifications, window, configuration}) -- the trace shape
//   assessment.mjs retains. applicabilityPayload / applicabilityFingerprint({obligations, configuration}).
// Outputs: an `ophanim.efficiency.analysis/v1` object (deterministic for a given trace); the fingerprint is
//   the sha256 of the CODE_UNIT_V1 canonical applicability payload.
// Invariants: pure and deterministic; every input is bounded (LIMITS) and typed, and an inconsistent
//   trace throws `Efficiency trace: ...` -- e.g. concurrency above the declared slots, overlapping attempts,
//   work before a dependency was accepted, or acceptance before the accepted attempt ended. Missing timings
//   are reported as missing, never filled in; scheduler slots and observations are not part of the
//   applicability key (governance re-derives that payload independently).
// Must never: read files or the clock, call a provider, infer an unobserved timing, or claim a speedup or
//   policy authorization.
import {createHash} from 'node:crypto';
import {canonicalCodeUnit} from '../../packages/ledger/canonical.mjs';

// Hard bounds on what one trace may contain (spanMs: one week; bytes: 16 MiB per sample).
const LIMITS = Object.freeze(
  {obligations:1000, attempts:10000, verifications:20000, workers:32, dependencies:32, spanMs:7*24*60*60*1000,
    bytes:16*1024*1024});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const SHA = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['pending','running','gating','effect_pending','accepted','held']);
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const sum = values => values.reduce((total,value)=>total+value,0);
const fail = message => {throw Error(`Efficiency trace: ${message}`);};
const string = (value,label,max=192) => {
  if(typeof value!=='string'||!value||value.length>max)fail(`invalid ${label}`);
  return value;
};
// Typed field checks: each returns the value or throws `Efficiency trace: invalid <label>`.
const identifier = (value,label) => {
  if(typeof value!=='string'||!ID.test(value))fail(`invalid ${label}`);return value;};
const hashValue = (value,label) => {
  if(typeof value!=='string'||!SHA.test(value))fail(`invalid ${label}`);return value;};
const finite = (value,label) => {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>Number.MAX_SAFE_INTEGER)
    fail(`invalid ${label}`);return value;};
const integer = (value,label,min,max) => {
  if(!Number.isSafeInteger(value)||value<min||value>max)fail(`invalid ${label}`);return value;};
function array(value,label,max,min=0){
  if(!Array.isArray(value)||value.length<min||value.length>max)fail(`bounded ${label} required`);
  return value;
}
function uniqueIds(value,label,max){
  const items=array(value,label,max).map(item=>identifier(item,label));
  if(new Set(items).size!==items.length)fail(`duplicate ${label}`);
  return items.sort(compare);
}
// The analysis digests are CODE_UNIT_V1 (packages/ledger/canonical.mjs), the order they were always computed in.
const canonical=value=>canonicalCodeUnit(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

// The obligation graph, validated: unique ids, sorted dependency ids, every dependency present and no
// cycle. Returns the rows (by id), a lookup and a dependencies-first order.
function graphOf(obligations){
  const rows=array(obligations,'obligations',LIMITS.obligations).map(row=>({
    id:identifier(row?.id,'obligation id'),kind:identifier(row.kind,'kind'),scope:identifier(row.scope,'scope'),
    dependsOn:uniqueIds(row.dependsOn,'dependencies',LIMITS.dependencies),
    specSha:row.specSha==null?null:hashValue(row.specSha,'spec hash'),
  })).sort((a,b)=>compare(a.id,b.id));
  const byId=new Map(rows.map(row=>[row.id,row]));
  if(byId.size!==rows.length)fail('duplicate obligation id');
  const visiting=new Set(),visited=new Set(),order=[];
  function visit(id){
    if(visited.has(id))return;
    if(visiting.has(id))fail('dependency cycle');
    const row=byId.get(id);if(!row)fail(`missing dependency ${id}`);
    visiting.add(id);row.dependsOn.forEach(visit);visiting.delete(id);visited.add(id);order.push(id);
  }
  rows.forEach(row=>visit(row.id));
  return {rows,byId,order};
}
// The worker registry, validated and ordered: unique ids, each with at least one kind and one scope.
function workersOf(registry){
  const workers=array(registry,'worker registry',LIMITS.workers,1).map(worker=>({
    id:identifier(worker?.id,'worker id'),version:string(worker.version,'worker version',128),
    kinds:uniqueIds(worker.kinds,'worker kinds',64),scopes:uniqueIds(worker.scopes,'worker scopes',64),
  })).sort((a,b)=>compare(a.id,b.id));
  if(new Set(workers.map(worker=>worker.id)).size!==workers.length||
    workers.some(worker=>!worker.kinds.length||!worker.scopes.length))fail('unique scoped workers required');
  return workers;
}

// This exact payload is independently reconstructed by governance. Scheduler
// slots and all observations deliberately remain outside its applicability key.
export function applicabilityPayload({obligations,configuration}={}){
  if(!configuration||typeof configuration!=='object')fail('explicit configuration required');
  return {
    schema:'ophanim.efficiency.applicability/v1',
    obligations:graphOf(obligations).rows,
    workers:workersOf(configuration.workerRegistry),
    workerArtifactSha:configuration.workerArtifactSha==null?
      null:hashValue(configuration.workerArtifactSha,'worker artifact hash'),
    policySha:configuration.policySha==null?null:hashValue(configuration.policySha,'policy hash'),
    inputRevision:configuration.inputRevision==null?null:string(configuration.inputRevision,'input revision',256),
  };
}
export const applicabilityFingerprint = input => digest(applicabilityPayload(input));

// A non-negative, ordered interval inside the observation window.
function interval(row,window,label){
  const startedAt=finite(row.startedAt,`${label} start`),endedAt=finite(row.endedAt,`${label} end`);
  if(endedAt<startedAt||startedAt<window.startedAt||endedAt>window.endedAt)
    fail(`${label} outside ordered observation window`);
  return {startedAt,endedAt};
}
const duration = value => value.endedAt-value.startedAt;
// Time covered by at least one interval (the union of the intervals' lengths).
function busyMs(intervals){
  let total=0,start=null,end=null;
  for(const row of [...intervals].sort((a,b)=>a.startedAt-b.startedAt||a.endedAt-b.endedAt)){
    if(start===null){start=row.startedAt;end=row.endedAt;}
    else if(row.startedAt<=end)end=Math.max(end,row.endedAt);
    else {total+=end-start;start=row.startedAt;end=row.endedAt;}
  }
  return total+(start===null?0:end-start);
}
// The largest number of non-empty intervals open at once; at equal times an end is counted before a start.
function maximumConcurrency(intervals){
  const points=intervals.filter(row=>duration(row)>0).flatMap(row=>[[row.startedAt,1],[row.endedAt,-1]]).sort(
    (a,b)=>a[0]-b[0]||a[1]-b[1]);
  let active=0,maximum=0;
  for(const [,change] of points){active+=change;maximum=Math.max(maximum,active);}
  return maximum;
}
// Group rows by their obligation id.
function byObligation(values){
  const map=new Map();
  for(const row of values){if(!map.has(row.id))map.set(row.id,[]);map.get(row.id).push(row);}return map;
}

/**
 * All timestamps must share one clock and lie in window. acceptedAt may precede
 * window when acceptance happened in a prior run. Missing prior attempt timing
 * is reported as incomplete coverage; zero measured time is not zero work.
 * Only hashes and byte counts are consumed for input/context observations.
 */
export function analyzeTrace({obligations,attempts,verifications=[],window,configuration}={}){
  const applicability=applicabilityPayload({obligations,configuration});
  const graph=graphOf(obligations),slots=integer(configuration.slots,'slots',1,8);
  const startedAt=finite(window?.startedAt,'window start'),endedAt=finite(window?.endedAt,'window end');
  if(endedAt<startedAt||endedAt-startedAt>LIMITS.spanMs)fail('bounded ordered observation window required');
  const observationWindow={startedAt,endedAt},spanMs=endedAt-startedAt;
  // Final state per obligation; an acceptance time needs an accepted status and may not be after the window.
  const states=new Map(obligations.map(row=>{
    if(!STATUSES.has(row.status))fail(`invalid status for ${row.id}`);
    const acceptedAttempt=row.acceptedAttempt==null?null:integer(row.acceptedAttempt,'accepted attempt',1,1000000);
    const acceptedAt=row.acceptedAt==null?null:finite(row.acceptedAt,'acceptance time');
    if(acceptedAt!==null&&(row.status!=='accepted'||acceptedAt>endedAt))
      fail('acceptance time inconsistent with final state');
    if(row.status!=='accepted'&&acceptedAttempt!==null)fail('accepted attempt on an unaccepted obligation');
    return [row.id,{...graph.byId.get(row.id),status:row.status,acceptedAttempt,acceptedAt}];
  }));
  const measuredAttempts=array(attempts,'attempts',LIMITS.attempts).map(row=>{
    const id=identifier(row?.id,'attempt obligation');if(!states.has(id))fail('attempt for unknown obligation');
    const result={
      id,attempt:integer(row.attempt,'attempt number',1,1000000),...interval(row,observationWindow,'worker interval')};
    for(const key of ['inputSha'])if(row[key]!=null)result[key]=hashValue(row[key],key);
    for(const key of ['inputBytes','contextBytes'])if(row[key]!=null)result[key]=integer(row[key],key,0,LIMITS.bytes);
    if(row.status!=null)result.status=string(row.status,'attempt status',64);
    return result;
  }).sort((a,b)=>a.startedAt-b.startedAt||compare(a.id,b.id)||a.attempt-b.attempt);
  const attemptKeys=new Set();
  for(const row of measuredAttempts){
    const key=canonical([row.id,row.attempt]);if(attemptKeys.has(key))fail('duplicate attempt timing');
    attemptKeys.add(key);}
  const measuredVerifications=array(verifications,'verifications',LIMITS.verifications).map(row=>{
    const id=identifier(row?.id,'verification obligation');
    if(!states.has(id))fail('verification for unknown obligation');
    if(!['accept','replay'].includes(row.purpose))fail('explicit verification purpose required');
    const result={
      id,attempt:integer(row.attempt,'verification attempt',1,1000000),purpose:row.purpose,
      ...interval(row,observationWindow,'verification interval')};
    if(row.candidateSha!=null)result.candidateSha=hashValue(row.candidateSha,'candidate hash');
    if(row.ok!=null){if(typeof row.ok!=='boolean')fail('boolean verification result required');result.ok=row.ok;}
    return result;
  }).sort((a,b)=>a.startedAt-b.startedAt||compare(a.id,b.id)||a.attempt-b.attempt);
  // Cross-checks between the final states and the measured intervals.
  const attemptsById=byObligation(measuredAttempts),checksById=byObligation(measuredVerifications);
  const maxActive=maximumConcurrency(measuredAttempts);
  if(maxActive>slots)fail('observed worker concurrency exceeds declared slots');
  for(const row of states.values()){
    const own=attemptsById.get(row.id)??[];
    const acceptanceChecks=(checksById.get(row.id)??[]).filter(check=>check.purpose==='accept');
    if(maximumConcurrency(own)>1)fail('overlapping attempts for one obligation');
    if(maximumConcurrency([...own,...acceptanceChecks])>1)
      fail('overlapping work and acceptance checks for one obligation');
    if(row.status==='accepted')for(const dep of row.dependsOn)if(states.get(dep).status!=='accepted')
      fail('accepted obligation has an unaccepted dependency');
    if(row.acceptedAttempt!==null&&own.some(attempt=>attempt.attempt>row.acceptedAttempt))
      fail('worker attempt after retained acceptance');
    if(row.acceptedAt!==null&&own.some(attempt=>attempt.endedAt>row.acceptedAt))
      fail('worker interval after acceptance');
    if(row.acceptedAt!==null&&acceptanceChecks.some(check=>check.endedAt>row.acceptedAt))
      fail('acceptance check after retained acceptance; mark later checks as replay');
    for(const attempt of own)for(const dep of row.dependsOn){
      const accepted=states.get(dep).acceptedAt;
      if(accepted!==null&&accepted>attempt.startedAt)fail('worker began before dependency acceptance');
    }
  }

  // The longest weighted dependency path is a measured service-time lower
  // bound, not wall-clock latency or a prediction of a faster scheduler.
  const paths=new Map(),missing=[],nodeWork=[];
  for(const id of graph.order){
    const row=states.get(id);if(row.status!=='accepted')continue;
    const own=attemptsById.get(id)??[],checks=(checksById.get(id)??[]).filter(check=>check.purpose==='accept');
    const acceptedAttempt=row.acceptedAttempt;
    const finalAttempt=acceptedAttempt===null?null:own.find(attempt=>attempt.attempt===acceptedAttempt);
    if(!finalAttempt)
      missing.push({id,reason:acceptedAttempt===null?'accepted-attempt-unknown':'accepted-attempt-not-observed'});
    const workMs=sum(own.map(duration)),verificationMs=sum(checks.map(duration));
    const node={
      id,attempts:own.length,workMs,verificationMs,acceptedAttemptWorkMs:finalAttempt?duration(finalAttempt):null,
      priorAttemptWorkMs:acceptedAttempt===null?
        null:sum(own.filter(attempt=>attempt.attempt<acceptedAttempt).map(duration))};
    nodeWork.push(node);
    // Extend the heaviest dependency path (ties broken by the lexically smallest id sequence).
    let previous={obligationIds:[],workMs:0,verificationMs:0,observedMs:0};
    for(const dep of row.dependsOn){
      const path=paths.get(dep);
      if(path.observedMs>previous.observedMs||path.observedMs===previous.observedMs&&
        (!previous.obligationIds.length||
          compare(path.obligationIds.join('\0'),previous.obligationIds.join('\0'))<0))previous=path;}
    paths.set(
      id,{obligationIds:[...previous.obligationIds,id],workMs:previous.workMs+workMs,
        verificationMs:previous.verificationMs+verificationMs,observedMs:previous.observedMs+workMs+verificationMs});
  }
  // The critical path: the heaviest path ending at an accepted obligation nothing accepted depends on.
  let critical={obligationIds:[],workMs:0,verificationMs:0,observedMs:0};
  const ancestors=new Set([...states.values()].filter(row=>row.status==='accepted').flatMap(row=>row.dependsOn));
  for(const [id,path] of paths)
    if(!ancestors.has(id)&&
      (path.observedMs>critical.observedMs||path.observedMs===critical.observedMs&&
        (!critical.obligationIds.length||compare(path.obligationIds.join('\0'),critical.obligationIds.join('\0'))<0)))
      critical=path;
  // Ready wait per attempt: from when it could have started (window start, its previous attempt and that
  // attempt's acceptance checks, and every dependency's acceptance) to when it did. Unknown when a
  // dependency's acceptance time is not in the trace.
  const waits=[],unknownWaits=[];
  for(const row of states.values()){
    let previousEnd=startedAt;
    for(const attempt of [...(attemptsById.get(row.id)??[])].sort((a,b)=>a.attempt-b.attempt)){
      const unknownDependencies=row.dependsOn.filter(id=>states.get(id).acceptedAt===null);
      if(unknownDependencies.length)
        unknownWaits.push(
          {id:row.id,attempt:attempt.attempt,reason:'dependency-acceptance-time-unavailable',
          dependencies:unknownDependencies});
      else {
        const readyAt=Math.max(startedAt,previousEnd,...row.dependsOn.map(id=>states.get(id).acceptedAt));
        if(readyAt>attempt.startedAt)fail('retry began before prior attempt or verification ended');
        waits.push(
          {id:row.id,attempt:attempt.attempt,readyAt,startedAt:attempt.startedAt,waitMs:attempt.startedAt-readyAt});
      }
      previousEnd=Math.max(
        attempt.endedAt,
        ...(checksById.get(row.id)??[]).filter(
          check=>check.purpose==='accept'&&check.attempt===attempt.attempt).map(check=>check.endedAt));
    }
  }
  // Repetition: checks of the same candidate for the same obligation, and attempts with the same input
  // hash; every occurrence after the first counts as repeated.
  const candidateGroups=new Map();
  for(const check of measuredVerifications)
    if(check.candidateSha){
      const key=canonical([check.id,check.candidateSha]);if(!candidateGroups.has(key))candidateGroups.set(key,[]);
      candidateGroups.get(key).push(check);}
  const repeatedChecks=[...candidateGroups.values()].flatMap(group=>group.slice(1));
  const inputGroups=new Map();
  for(const attempt of measuredAttempts)
    if(attempt.inputSha){
      const key=canonical([attempt.id,attempt.inputSha]);if(!inputGroups.has(key))inputGroups.set(key,[]);
      inputGroups.get(key).push(attempt);}
  const repeatedInputs=[...inputGroups.values()].flatMap(group=>group.slice(1));
  const workerMs=sum(measuredAttempts.map(duration)),workerBusyMs=busyMs(measuredAttempts),
    verificationMs=sum(measuredVerifications.map(duration));
  const acceptedCount=[...states.values()].filter(row=>row.status==='accepted').length;
  // The applicability identity is complete only when every spec, the worker artifact, the policy and the
  // input revision are all identified by hash.
  const completeIdentity=applicability.obligations.every(row=>row.specSha!==null)&&
    applicability.workerArtifactSha!==null&&applicability.policySha!==null&&applicability.inputRevision!==null;
  return {
    schema:'ophanim.efficiency.analysis/v1',
    applicability:{fingerprint:digest(applicability),identity:applicability,complete:completeIdentity},
    window:{...observationWindow,durationMs:spanMs},configuration:{slots},
    obligations:{total:states.size,accepted:acceptedCount,unaccepted:states.size-acceptedCount},
    criticalPath:{
      status:!paths.size||!nodeWork.some(row=>row.attempts)?'no-evidence':missing.length?'partial':'observed',
      ...critical,missing,nodeWork,
      interpretation:'Longest accepted dependency path weighted by observed worker attempts and acceptance checks; excludes replay checks and unobserved history. It is not observed wall-clock latency or a speedup prediction.'},
    scheduling:{
      workerMs,workerBusyMs,noWorkerActivityMs:spanMs-workerBusyMs,workerSlotUnusedMs:spanMs*slots-workerMs,
      maxConcurrentWorkers:maxActive,
      noWorkerOrVerificationActivityMs:spanMs-busyMs([...measuredAttempts,...measuredVerifications]),
      readyWaitMs:sum(waits.map(row=>row.waitMs)),measuredWaits:waits,unmeasuredWaits:unknownWaits,
      interpretation:'Ready wait and unused worker time include controller work, persistence, required checks and bounded scheduling; the trace does not establish avoidable idle time.'},
    verification:{
      calls:measuredVerifications.length,totalMs:verificationMs,busyMs:busyMs(measuredVerifications),
      acceptCalls:measuredVerifications.filter(row=>row.purpose==='accept').length,
      replayCalls:measuredVerifications.filter(row=>row.purpose==='replay').length,
      repeatedCandidateCalls:repeatedChecks.length,repeatedCandidateMs:sum(repeatedChecks.map(duration)),
      missingCandidateHashes:measuredVerifications.filter(row=>!row.candidateSha).length,
      interpretation:'Repeated verification is observed repetition, not evidence that a required safety check can be removed.'},
    retries:{
      observedAttempts:measuredAttempts.length,
      observedRetryAttempts:measuredAttempts.filter(row=>row.attempt>1).length,
      observedRetryWorkMs:sum(measuredAttempts.filter(row=>row.attempt>1).map(duration)),
      priorAcceptanceAttemptWorkMs:sum(nodeWork.map(row=>row.priorAttemptWorkMs??0))},
    context:{
      inputByteSamples:measuredAttempts.filter(row=>row.inputBytes!==undefined).length,
      contextByteSamples:measuredAttempts.filter(row=>row.contextBytes!==undefined).length,
      observedInputBytes:sum(measuredAttempts.map(row=>row.inputBytes??0)),
      observedContextBytes:sum(measuredAttempts.map(row=>row.contextBytes??0)),
      missingInputHashes:measuredAttempts.filter(row=>!row.inputSha).length,
      repeatedInputSamples:repeatedInputs.length,repeatedInputBytes:sum(repeatedInputs.map(row=>row.inputBytes??0)),
      repeatedInputByteSamples:repeatedInputs.filter(row=>row.inputBytes!==undefined).length,
      interpretation:'Byte counts describe serialized local inputs; matching hashes show exact input replay for the same obligation. They do not measure provider tokens, semantic usefulness, caching or waste.'},
    providerAllocation:{
      status:'no-evidence',
      reason:'No provider/model allocation, token usage, prices, latency or comparable model-quality observations are supplied by this trace.'},
    limits:{observedWindowOnly:true,policyAuthorization:false,providerBenefitEstimate:false},
  };
}
