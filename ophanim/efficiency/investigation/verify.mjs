// Independent, read-only inspection of persisted synthetic experiment evidence.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {canonical,digest,readRuntimeSnapshot} from '../../board.mjs';
import {createGovernance} from '../../governance.mjs';
import {evaluateEfficiency} from '../../governance/check-efficiency.mjs';
import {verifyReplayTrial} from '../replay.mjs';

const SHA=/^[a-f0-9]{64}$/;
const EVIDENCE_FILE_BYTES=8*1024*1024;
const PAIRED_SCHEMA='ophanim.investigation-pair/v1';
const LATENCY_SCHEMA='ophanim.investigation-latency-evidence/v1';
const EVENT_FIELDS={
  'work.started':'startedAt',
  'work.persisted':'persistedAt',
  'gate.accepted':'gateAt',
  'work.accepted':'acceptedAt',
};
const PHASES={
  readyToStartMs:'Readiness to dispatch, including controller scheduling and batch wait.',
  startToPersistMs:'Dispatch to candidate persistence, including worker activity, lease handling and publication.',
  persistToGateMs:'Persistence to gate acceptance, including controller scheduling, verification and event publication.',
  gateToAcceptedMs:'Gate acceptance to obligation acceptance, including effects and controller publication.',
};
const WORKER_SIGNALS={
  workerCallbackMs:'Retained driver callback span, including configured timer wait and the transformation. Bound to its enclosing committed interval.',
  nonCallbackBeforePersistMs:'Remainder of dispatch-to-persistence outside the driver callback. Does not assign it to a particular mechanism.',
};
const AUTHORITY=Object.freeze({execution:false,policyActivation:false});
const same=(left,right,message)=>assert.equal(canonical(left),canonical(right),message);
const clock=value=>Number.isSafeInteger(value)&&value>=0;
const eventValue=({sequence,...event})=>event;
const selectP95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*0.95)-1];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

function exactPath(value,check) {
  assert.ok(typeof value==='string'&&path.isAbsolute(value)&&path.resolve(value)===value,'Canonical absolute evidence path required');
  const stat=fs.lstatSync(value);
  assert.ok(check(stat)&&fs.realpathSync(value)===value,'Canonical evidence path required');
  return value;
}
const directory=value=>exactPath(value,stat=>stat.isDirectory());
function read(file) {
  exactPath(file,stat=>stat.isFile()&&stat.size<=EVIDENCE_FILE_BYTES);
  const bytes=fs.readFileSync(file);
  assert.ok(bytes.length<=EVIDENCE_FILE_BYTES,'Evidence file exceeds bound');
  return {value:JSON.parse(bytes),sha:hash(bytes)};
}

function observationWindow(value,label) {
  assert.ok(clock(value.startedAt)&&clock(value.endedAt)&&value.endedAt>=value.startedAt&&
    clock(value.durationMs)&&Math.abs(value.durationMs-(value.endedAt-value.startedAt))<=2&&value.durationMs<=30000,`Invalid ${label} observation window`);
}

function requiredStageEvents(state,slots) {
  const opened=state.events.filter(event=>event.type==='runtime.opened');
  const settled=state.events.at(-1);
  assert.ok(opened.length===1&&opened[0].slots===slots&&settled.type==='runtime.settled'&&
    settled.convergence==='accepted_change','Clean single-convergence trial required');
  return {openedAt:opened[0].atMs,settledAt:settled.atMs};
}

// Boundaries come from committed events. The individual causes inside each
// interval are unavailable unless another independently verified source exists.
function committedStages(state,openedAt) {
  const byId=new Map();
  const obligations=Object.values(state.obligations);
  assert.ok(obligations.length>=6&&obligations.length<=36,'Bounded paired observation requires six to thirty-six obligations');
  for(const row of obligations)byId.set(row.spec.id,{id:row.spec.id,kind:row.spec.kind,dependsOn:row.spec.dependsOn,attempt:row.accepted.attempt});
  for(const event of state.events) {
    const field=EVENT_FIELDS[event.type];
    if(!field)continue;
    const row=byId.get(event.id);
    assert.ok(row&&event.attempt===row.attempt&&!Object.hasOwn(row,field)&&clock(event.atMs),'Missing, repeated or inconsistent committed stage boundary');
    row[field]=event.atMs;
  }
  for(const row of byId.values()) {
    const readyAt=Math.max(openedAt,...row.dependsOn.map(id=>byId.get(id)?.acceptedAt));
    assert.ok(clock(readyAt)&&readyAt<=row.startedAt&&row.startedAt<=row.persistedAt&&row.persistedAt<=row.gateAt&&row.gateAt<=row.acceptedAt,
      'Committed stage boundaries are incomplete or out of order');
    row.readyAt=readyAt;
    row.readyToStartMs=row.startedAt-readyAt;
    row.startToPersistMs=row.persistedAt-row.startedAt;
    row.persistToGateMs=row.gateAt-row.persistedAt;
    row.gateToAcceptedMs=row.acceptedAt-row.gateAt;
    row.stageMs=row.acceptedAt-row.startedAt;
  }
  return [...byId.values()].sort((left,right)=>left.id.localeCompare(right.id));
}

function dependentPath(rows) {
  const byId=new Map(rows.map(row=>[row.id,row]));
  const longest=new Map();
  function visit(id) {
    if(longest.has(id))return longest.get(id);
    const row=byId.get(id);
    const prefix=row.dependsOn.map(visit).sort((left,right)=>right.observedStageMs-left.observedStageMs||left.ids.join().localeCompare(right.ids.join()))[0];
    const result={ids:[...(prefix?.ids??[]),id],observedStageMs:(prefix?.observedStageMs??0)+row.stageMs};
    longest.set(id,result);
    return result;
  }
  return rows.map(row=>visit(row.id)).sort((left,right)=>right.observedStageMs-left.observedStageMs||left.ids.join().localeCompare(right.ids.join()))[0];
}

function bindWorkerIntervals(stages,intervals) {
  assert.ok(Array.isArray(intervals)&&intervals.length===stages.length,'Exact retained callback interval coverage required');
  const byId=new Map(stages.map(row=>[row.id,row]));
  for(const interval of intervals) {
    const row=byId.get(interval.id);
    assert.ok(row&&row.attempt===interval.attempt&&row.kind===interval.kind&&!Object.hasOwn(row,'workerCallbackMs')&&
      clock(interval.startedAt)&&clock(interval.endedAt)&&interval.startedAt>=row.startedAt&&interval.startedAt<=interval.endedAt&&
      interval.endedAt<=row.persistedAt,'Retained callback interval differs from its committed work envelope');
    row.workerCallbackMs=interval.endedAt-interval.startedAt;
    row.nonCallbackBeforePersistMs=row.startToPersistMs-row.workerCallbackMs;
  }
}

async function verifyPairSide({root,slots,request,telosRoot,expected}) {
  const dir=directory(path.join(root,String(slots))),stateDir=directory(path.join(dir,'state'));
  const requestFile=path.join(dir,'request.json'),resultFile=path.join(dir,'result.json'),watchdogFile=path.join(dir,'watchdog.json');
  const dispatched=read(requestFile);
  const {stateDir:retainedState,resultFile:retainedResult,slots:retainedSlots,telosRoot:retainedTelos,...requestBody}=dispatched.value;
  assert.equal(retainedState,stateDir,'Request uses a different state root');
  assert.equal(retainedResult,resultFile,'Request uses a different result file');
  assert.equal(retainedSlots,slots,'Request uses a different scheduler setting');
  same(requestBody,request,'Normalized fixture inputs differ between paired trials');
  // Verification uses the independently selected, pinned checkout.
  assert.ok(retainedTelos===undefined||path.isAbsolute(retainedTelos),'Invalid retained TELOS path');
  const run=read(resultFile),watchdog=read(watchdogFile),result=run.value,guard=watchdog.value;
  const snapshot=readRuntimeSnapshot(stateDir),state=snapshot.state;
  assert.equal(result.slots,slots,'Result uses a different scheduler setting');
  observationWindow(result,'runtime');
  observationWindow(guard,'watchdog');
  assert.ok(guard.schema==='ophanim.watchdog/v1'&&guard.exitCode===0&&guard.signal===null&&guard.reason==='worker-exited'&&
    guard.startedAt<=result.startedAt&&result.endedAt<=guard.endedAt,'Watchdog did not record a clean, bounded execution');
  const {openedAt,settledAt}=requiredStageEvents(state,slots);
  assert.ok(result.startedAt<=openedAt&&openedAt<=settledAt&&settledAt<=result.endedAt,'Run window excludes committed events');
  same(guard.events,state.events.map(eventValue),'Watchdog events differ from Pantheon committed state');
  if(expected) {
    assert.equal(expected.boardCommit,snapshot.commit,'Retained report has a different board commit');
    assert.equal(expected.files?.resultSha,run.sha,'Retained report has a different runtime result digest');
    assert.equal(expected.files?.watchdogSha,watchdog.sha,'Retained report has a different watchdog digest');
  }
  const checked=await verifyReplayTrial({stateDir,resultFile,request,boardCommit:snapshot.commit,...telosRoot?{telosRoot}:{}});
  assert.ok(checked.ok&&checked.fixtureOnly&&checked.runtimeDispatches===0,'TELOS signed replay verification required');
  assert.equal(readRuntimeSnapshot(stateDir).commit,snapshot.commit,'Board moved during read-only verification');
  for(const [file,sha] of [[requestFile,dispatched.sha],[resultFile,run.sha],[watchdogFile,watchdog.sha]])assert.equal(read(file).sha,sha,'Evidence changed during verification');
  const stages=committedStages(state,openedAt);
  bindWorkerIntervals(stages,result.intervals);
  const stageP95Ms=selectP95(stages.map(row=>row.stageMs));
  assert.equal(stageP95Ms,checked.derivedStageP95Ms,'Independent stage timing differs');
  assert.equal(stages.length,checked.accepted,'Stage sample coverage differs from signed acceptance');
  assert.equal(result.measurements.verificationCalls.verifyCandidate,checked.verificationCalls,'Fixture verification work differs');
  const dependencyPath=dependentPath(stages);
  const row={
    slots,boardCommit:snapshot.commit,stateSha:checked.stateSha,scopeSha:checked.scopeSha,
    source:{stateDir,resultFile,watchdogFile,requestFile},
    policySha:checked.policySha,governanceContractSha:checked.governanceContractSha,workerArtifactSha:checked.workerArtifactSha,
    durationMs:result.durationMs,watchdogDurationMs:guard.durationMs,stageP95Ms,stages,
    dependencyPath:{...dependencyPath,coverage:'observed stage intervals along the dependency graph'},
    contextBytes:checked.derivedWorkerContextBytes,verificationCalls:checked.verificationCalls,
    verifierCpuMs:null,workerCpuMs:null,recoveryMs:null,
    accepted:checked.accepted,confirmedEffects:checked.effects,outputSha:checked.outputSha,effectSha:checked.effectSha,
    files:{requestSha:dispatched.sha,resultSha:run.sha,watchdogSha:watchdog.sha},
  };
  if(expected)for(const key of ['durationMs','stageP95Ms','contextBytes','accepted','outputSha','effectSha'])assert.equal(row[key],expected[key],`Retained report's ${key} differs from independently checked evidence`);
  return row;
}

export async function verifyPairedInvestigation({root,telosRoot=process.env.OPHANIM_TELOS_ROOT,expected}={}) {
  directory(root);
  const preflight=read(path.join(root,'preflight.json'));
  const request=preflight.value.request;
  assert.equal(preflight.value.kind,'measured-pair-not-admission','Expected measured synthetic paired probe evidence');
  assert.ok(request&&Object.keys(request).sort().join(',')==='batches,maxDispatches,workerOptions','Closed paired observation request required');
  const widthRows=expected?.rows;
  if(expected) {
    same(expected.request,request,'Retained report has different fixture inputs');
    assert.ok(widthRows?.length===2&&widthRows[0].slots===1&&widthRows[1].slots===3,'Both retained scheduler widths required');
  }
  const baseline=await verifyPairSide({root,slots:1,request,telosRoot,expected:widthRows?.[0]});
  const candidate=await verifyPairSide({root,slots:3,request,telosRoot,expected:widthRows?.[1]});
  assert.equal(read(path.join(root,'preflight.json')).sha,preflight.sha,'Fixture request changed during verification');
  for(const key of ['scopeSha','policySha','governanceContractSha','workerArtifactSha','outputSha','effectSha','contextBytes','accepted','verificationCalls','confirmedEffects'])assert.equal(candidate[key],baseline[key],`Paired evidence changed ${key}`);
  const matchedStageDeltas=baseline.stages.map((left,index)=>{
    const right=candidate.stages[index];
    assert.equal(right.id,left.id,'Paired stages cannot match different obligations');
    return {id:left.id,kind:left.kind,...Object.fromEntries([...Object.keys(PHASES),...Object.keys(WORKER_SIGNALS),'stageMs'].map(metric=>[metric,right[metric]-left[metric]]))};
  });
  const stageLimitMs=baseline.stageP95Ms*1.25+25;
  const stageP95={baselineMs:baseline.stageP95Ms,candidateMs:candidate.stageP95Ms,limitMs:stageLimitMs,passed:candidate.stageP95Ms<=stageLimitMs};
  const scopeSha=baseline.scopeSha,requestSha=digest(request),authority=AUTHORITY;
  const outcome={
    schema:PAIRED_SCHEMA,scopeSha,request,requestSha,preflightSha:preflight.sha,authority,
    source:{root,preflightFile:path.join(root,'preflight.json')},
    outcomes:{outputQuality:'verified identical fixture outputs',effects:'verified identical stable effects, each applied once',recovery:'unmeasured'},
    rows:[baseline,candidate],matchedStageDeltas,phases:{...PHASES,...WORKER_SIGNALS},stageP95,
    throughputSavedMs:baseline.durationMs-candidate.durationMs,
    verifiedNodes:baseline.accepted+candidate.accepted,
    assessment:stageP95.passed?'inconclusive':'hard-constraint-violated',
    unresolved:['cause of measured phase changes','variability across controlled repeats','comparable recovery latency','downstream workload and realized value'],
  };
  return {...outcome,evidenceSha:digest(outcome)};
}

const SIGNAL_CONTRASTS={
  workerCallbackMs:[
    {id:'timer-resume-lag',componentId:'worker-reasoning',observable:'timer-resume-lag-ms',
      explanation:'The configured wait may have resumed later under the observed overlap.'},
    {id:'transform-body-wall',componentId:'worker-reasoning',observable:'transform-body-wall-ms',
      explanation:'Work after timer resume may have taken longer under the observed overlap.'},
  ],
  nonCallbackBeforePersistMs:[
    {id:'lease-and-setup',componentId:'board-integrity',observable:'dispatch-to-callback-entry-ms',
      explanation:'The additional dispatch-to-persistence span may have accrued before callback entry.'},
    {id:'candidate-publication',componentId:'board-integrity',observable:'callback-exit-to-candidate-persistence-ms',
      explanation:'The additional dispatch-to-persistence span may have accrued after the callback ended.'},
  ],
  persistToGateMs:[
    {id:'verifier-elapsed',componentId:'review',observable:'verifier-body-wall-ms',
      explanation:'The independent check may have elapsed longer under the observed overlap.'},
    {id:'gate-envelope-residual',componentId:'scheduling',observable:'gate-envelope-non-check-ms',
      explanation:'The extra interval may have accumulated in waiting, controller work or publication around the check.'},
  ],
  gateToAcceptedMs:[
    {id:'effect-operations',componentId:'effects',observable:'effect-adapter-wall-ms',
      explanation:'The retained effects path may have elapsed longer between gate and acceptance.'},
    {id:'acceptance-publication',componentId:'board-integrity',observable:'acceptance-non-effect-wall-ms',
      explanation:'The extra interval may have accumulated in controller work and publication around effect handling.'},
  ],
};

// Use the evidence to select which envelope is worth trying to explain.
// These paired predictions label dominant explanations; mixed results leave
// both unproven and can require another independent measurement.
export function latencyInvestigationFindings(verified) {
  return checkedLatencyProbes(verified).filter(probe=>!probe.stageP95.passed&&probe.throughputSavedMs>0).map(probe=>{
    const [baseline,candidate]=probe.rows;
    const tail=candidate.stages.filter(row=>row.stageMs>=probe.stageP95.candidateMs);
    const matched=probe.matchedStageDeltas.filter(row=>tail.some(stage=>stage.id===row.id));
    const bySignal=Object.keys(SIGNAL_CONTRASTS).map(signal=>({signal,deltaMs:Math.max(...matched.map(row=>row[signal]))}))
      .sort((left,right)=>right.deltaMs-left.deltaMs||left.signal.localeCompare(right.signal));
    const focus=bySignal[0];
    assert.ok(focus.deltaMs>0,'No positively contributing matched stage envelope found');
    const contenders=SIGNAL_CONTRASTS[focus.signal];
    const componentIds=[...new Set(['scheduling','concurrency',...contenders.map(item=>item.componentId)])].sort();
    return {
      id:'throughput-stage-tail-tradeoff',scopeSha:probe.scopeSha,evidenceSha:probe.evidenceSha,
      applicabilitySha:digest({scopeSha:probe.scopeSha,requestSha:probe.requestSha,policySha:baseline.policySha,
        workerArtifactSha:baseline.workerArtifactSha,outputSha:baseline.outputSha,effectSha:baseline.effectSha}),
      metric:'stage-p95-ms',componentIds,
      question:`What accounts for the observed ${focus.signal} increase on matched tail stages at the wider scheduler setting?`,
      decision:'Decide which isolated phase measurement could justify a further scheduler investigation within the stage limit.',
      observations:[
        {signal:'completion-ms',baseline:baseline.durationMs,candidate:candidate.durationMs,delta:-probe.throughputSavedMs,unit:'ms'},
        {signal:'stage-p95-ms',baseline:probe.stageP95.baselineMs,candidate:probe.stageP95.candidateMs,
          limit:probe.stageP95.limitMs,passed:false,unit:'ms'},
        {signal:'matched-candidate-tail-phase-deltas',samples:matched,unit:'ms',coverage:'Ready-to-start is outside stage p95; matched phase intervals do not establish causes.'},
        {signal:'largest-matched-tail-increase',...focus,unit:'ms',coverage:probe.phases[focus.signal]},
      ],
      hypotheses:contenders.map(hypothesis=>({id:hypothesis.id,componentId:hypothesis.componentId,
        explanation:hypothesis.explanation,predictions:contenders.map(other=>({signal:other.observable,direction:other===hypothesis?'increase':'unchanged'}))})),
    };
  });
}

function checkedLatencyProbes(verified) {
  const {evidenceSha,...body}=verified;
  assert.ok(body.schema===LATENCY_SCHEMA&&evidenceSha===digest(body),'Exact independently reconstructed latency evidence required');
  return body.probes;
}

// Models consume exact references resolved after a read-only recheck. The
// measurements describe spans and aggregate differences, leaving causality open.
export async function openLatencyModelEvidence(options) {
  const checked=await verifyLatencyEvidence(options);
  const findings=latencyInvestigationFindings(checked),observations=[];
  for(const probe of checked.probes) {
    const [baseline,candidate]=probe.rows;
    const sampleCount=probe.matchedStageDeltas.length;
    function add({id,componentId,metric,unit,value,samples}) {
      observations.push(Object.freeze({schema:'ophanim.functional-observation/v1',receiptSha:probe.evidenceSha,scopeSha:probe.scopeSha,
        id,componentId,metric,unit,value,samples,method:'controlled-comparison'}));
    }
    add({id:'paired-completion-delta',componentId:'concurrency',metric:'completion-delta-ms',unit:'ms',value:candidate.durationMs-baseline.durationMs,samples:1});
    add({id:'paired-stage-p95-delta',componentId:'scheduling',metric:'stage-p95-delta-ms',unit:'ms',
      value:candidate.stageP95Ms-baseline.stageP95Ms,samples:sampleCount});
    add({id:'paired-worker-callback-max-delta',componentId:'worker-reasoning',metric:'maximum-matched-worker-callback-delta-ms',unit:'ms',
      value:Math.max(...probe.matchedStageDeltas.map(row=>row.workerCallbackMs)),samples:sampleCount});
    add({id:'paired-verification-count-delta',componentId:'review',metric:'verification-call-delta',unit:'calls',
      value:candidate.verificationCalls-baseline.verificationCalls,samples:1});
  }
  const byId=new Map(observations.map(row=>[`${row.receiptSha}:${row.id}`,row]));
  return {checked,findings,
    referencesFor:scopeSha=>observations.filter(row=>row.scopeSha===scopeSha).map(({receiptSha,id:observationId})=>({receiptSha,observationId})),
    verifyObservation:({receiptSha,observationId})=>byId.get(`${receiptSha}:${observationId}`)??null,
  };
}

export async function verifyLatencyEvidence({reportFile,expectedReportSha,telosRoot=process.env.OPHANIM_TELOS_ROOT}={}) {
  const report=read(reportFile);
  if(expectedReportSha!==undefined)assert.ok(SHA.test(expectedReportSha)&&report.sha===expectedReportSha,'Retained report digest differs');
  assert.equal(report.value.schema,'ophanim.admission-proof/v1','Expected retained admission proof report');
  assert.ok(Array.isArray(report.value.probes)&&report.value.probes.length>=1&&report.value.probes.length<=4,'Bounded retained paired probe set required');
  assert.equal(new Set(report.value.probes.map(probe=>probe.root)).size,report.value.probes.length,'Duplicate probe root');
  const probes=[];
  for(const expected of report.value.probes) {
    assert.equal(expected.schema,'ophanim.admission-paired-probe/v1','Historical pair schema differs');
    probes.push(await verifyPairedInvestigation({root:expected.root,telosRoot,expected}));
  }
  assert.equal(read(reportFile).sha,report.sha,'Retained report changed during verification');
  const outcome={schema:LATENCY_SCHEMA,sourceReportSha:report.sha,probes,authority:AUTHORITY};
  return {...outcome,evidenceSha:digest(outcome)};
}

// This path independently checks complete three-pair and crash-recovery
// evidence with the already pinned TELOS evaluator. It never issues a decision.
export async function verifyControlledInvestigation({manifestFile,expectedScopeSha,expectedManifestSha,telosRoot=process.env.OPHANIM_TELOS_ROOT}={}) {
  assert.ok(SHA.test(expectedScopeSha??'')&&SHA.test(expectedManifestSha??''),'Exact external scope and evidence digests required');
  const {value:manifest,sha}=read(manifestFile),evidenceRoot=path.dirname(manifestFile);
  assert.equal(manifestFile,path.join(evidenceRoot,'manifest.json'),'Canonical replay manifest required');
  assert.equal(sha,expectedManifestSha,'Replay manifest digest differs');
  assert.equal(manifest.scopeSha,expectedScopeSha,'Experiment applies to a different scope');
  const {identity}=await createGovernance({root:directory(manifest.original.stateRoot),readOnly:true,fixtureOnly:true,...telosRoot?{telosRoot}:{}});
  const policy={
    schema:'ophanim.scheduler-policy/v1',scopeSha:expectedScopeSha,baselineSlots:1,slots:3,baselineRelease:'baseline',
    workerArtifactSha:manifest.workerArtifactSha,policySha:manifest.configuration.policySha,stateSchema:'ophanim.runtime/v1',
    maxQualifiedConvergences:20,evidenceSha:sha,originalResultSha:manifest.original.resultSha,
  };
  const verification=await evaluateEfficiency({policy,evidenceRoot,telosRoot,governanceContractSha:identity.governanceContractSha});
  assert.equal(read(manifestFile).sha,sha,'Replay manifest changed during verification');
  return {schema:'ophanim.investigation-controlled-evidence/v1',scopeSha:expectedScopeSha,evidenceSha:sha,verification,
    outcome:verification.eligible?'qualified-for-authorization':'no_change',authority:AUTHORITY};
}
