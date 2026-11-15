// Controlled synthetic experiments. This module can spend only its bounded
// local process-time allowance; it cannot activate a scheduler policy.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {canonical,digest,clone,readRuntimeSnapshot} from '../board.mjs';
import {makeFixtures,createPlanning,createWorkers,writeJson} from '../fixtures.mjs';
import {openStore} from '../../pantheon/src/board/cas.mjs';
import {applicabilityPayload} from './analyze.mjs';
import {efficiencyScope} from './assessment.mjs';

const HERE=fileURLToPath(import.meta.url),ROOT=fileURLToPath(new URL('../../',import.meta.url));
const WATCHDOG=fileURLToPath(new URL('../watchdog.mjs',import.meta.url));
const rawSha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const elapsed=start=>Math.max(0,Math.round(performance.now()-start));
const effectProjection=values=>values.map(({key,payload})=>({key,payload})).sort((a,b)=>a.key.localeCompare(b.key));
const metadata=workers=>workers.map(({id,version,kinds,scopes})=>({id,version,kinds,scopes})).sort((a,b)=>a.id.localeCompare(b.id));
const same=(a,b,message)=>assert.equal(canonical(a),canonical(b),message);
class BudgetExpired extends Error {}

export function alternatingOrder(repeats=3) {
  assert.ok(Number.isInteger(repeats)&&repeats>=3&&repeats<=4,'Three or four bounded clean pairs required');
  return Array.from({length:repeats},(_,pair)=>(pair%2?[3,1]:[1,3]).map(slots=>({pair,slots}))).flat();
}

function derive(request,slots=1) {
  assert.ok(request&&typeof request==='object'&&!Array.isArray(request));
  assert.ok(Object.keys(request).every(key=>['batches','workerOptions','maxDispatches','telosRoot'].includes(key)),'Replay accepts only normalized synthetic inputs');
  assert.ok(Array.isArray(request.batches)&&request.batches.length>=1&&request.batches.length<=4,'Bounded explicit fixture batches required');
  const fixtures=request.batches.map(makeFixtures),obligations=fixtures.flatMap(value=>value.obligations);
  assert.ok(obligations.length>0&&obligations.length<=36,'Replay fixture size bound exceeded');
  const workerOptions={department:fixtures[0].department,departments:[...new Set(fixtures.map(f=>f.department))].sort(),version:'synthetic-v1',delayMs:15,...request.workerOptions};
  assert.ok(Object.keys(workerOptions).every(key=>['department','departments','version','delayMs','routingAliases'].includes(key)),'Fault-injected or extended worker policy outside replay contract');
  assert.equal(workerOptions.version,'synthetic-v1','Only the original baseline worker version is eligible');
  assert.ok(!workerOptions.routingAliases||Object.keys(workerOptions.routingAliases).length===0,'Altered routing release outside replay contract');
  const maxDispatches=request.maxDispatches??1000;
  assert.ok(Number.isSafeInteger(maxDispatches)&&maxDispatches>=obligations.length&&maxDispatches<=1000);
  const normalized={batches:clone(request.batches),workerOptions,maxDispatches};
  const workers=createWorkers(workerOptions),registry=metadata(workers),planning=createPlanning({batches:request.batches});
  const artifact={schema:'ophanim.synthetic-worker-artifact/v1',sourceSha:rawSha(fs.readFileSync(new URL('../fixtures.mjs',import.meta.url))),options:workerOptions,workers:registry};
  const scope=efficiencyScope({obligations,planning,workerArtifactSha:digest(artifact),registry,request:normalized,slots});
  return {request:normalized,fixtures,obligations,registry,artifact,scope,applicability:applicabilityPayload({obligations:scope.graph,configuration:scope.configuration})};
}

function assertOutputs(result,derived,reference) {
  assert.equal(result.schema,'ophanim.synthetic-run/v1');assert.equal(result.synthetic,true);
  assert.equal(result.complete,true);assert.equal(result.activeRelease,'baseline');
  assert.equal(result.limits?.modelCalls,0);assert.equal(result.limits?.businessSystemsConnected,0);
  assert.equal(result.held.length,0);assert.equal(result.blockers.length,0);
  const expected=Object.fromEntries(derived.obligations.map(row=>[row.id,row.expected]));
  same(result.outputs,expected,'Replay changed accepted output bytes');
  same(result.accepted,[...Object.keys(expected)].sort(),'Replay accepted a different obligation set');
  const effects=effectProjection(result.effects);
  same(effects,effectProjection(derived.fixtures.flatMap(value=>value.expectedEffects)),'Replay changed destination payloads');
  assert.ok(result.effects.every(value=>value.writeCount===1),'A destination effect was written repeatedly');
  assert.equal(result.destinationInvocations.length,effects.length,'A destination operation was reapplied');
  assert.equal(new Set(result.destinationInvocations.map(value=>value.key)).size,effects.length);
  if(reference){same(result.outputs,reference.outputs,'Trial differs from original accepted output');same(effects,effectProjection(reference.effects),'Trial differs from original accepted effects');}
}

// Executed in a separately bounded verification process. Fixed TELOS semantic
// checks replay transformations, but no runtime or destination action dispatches.
export async function verifyReplayTrial({stateDir,resultFile,request,boardCommit,telosRoot}={}) {
  const started=performance.now(),cpu=process.cpuUsage(),derived=derive(request),result=read(resultFile);
  assertOutputs(result,derived);
  const snapshot=readRuntimeSnapshot(stateDir,boardCommit),state=snapshot.state;
  assert.equal(state.activeRelease,'baseline');assert.equal(state.pendingRelease,null);assert.equal(state.releaseHistory.length,0);
  same(state.releases.baseline.workers,derived.registry,'Worker registry changed across trials');
  same(Object.keys(state.obligations).sort(),derived.obligations.map(row=>row.id).sort());
  const {createGovernance}=await import('../governance.mjs');
  const governance=await createGovernance({root:stateDir,fixtureOnly:true,readOnly:true,...telosRoot?{telosRoot}:{}});
  const store=openStore(path.join(stateDir,'pantheon'),{readOnly:true}),proofs=[];
  const destination=path.join(stateDir,'destination');
  const applyFile=path.join(destination,'apply-events.jsonl');
  const invocations=fs.existsSync(applyFile)?fs.readFileSync(applyFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  same(invocations,result.destinationInvocations,'Destination invocation evidence changed');
  for(const spec of derived.obligations) {
    const row=state.obligations[spec.id];same(row.spec,spec,'Original workflow contract changed');assert.equal(row.status,'accepted');
    const proof=await governance.verifyPlan({planRef:row.accepted.planRef});
    assert.equal(proof.ok,true,proof.reason);assert.equal(proof.obligationId,spec.id);assert.equal(proof.obligationSha,digest(spec));
    assert.equal(proof.candidateSha,row.accepted.sha256);assert.equal(row.accepted.sha256,digest(row.accepted.output));
    same(row.accepted.output,spec.expected);same(row.candidate.candidate.output,row.accepted.output);assert.equal(row.candidate.candidate.sha256,row.accepted.sha256);
    const publication=row.candidate.published,commit=store.get(publication.commit),entry=store.get(publication.entry);
    assert.ok(commit.records.includes(publication.entry));assert.equal(entry.links.log,publication.blob);
    assert.equal(store.get(publication.blob).toString('utf8'),canonical({candidate:row.candidate.candidate,worker:row.candidate.worker,evidence:row.candidate.evidence,effects:row.candidate.effects}));
    same(row.candidate.evidence.dependencyVersions,spec.dependsOn.map(id=>({id,sha256:state.obligations[id].accepted.sha256})));
    if(spec.effectKey) {
      const receipt=read(path.join(destination,`${rawSha(spec.effectKey)}.json`));
      assert.equal(receipt.key,spec.effectKey);same(receipt.payload,spec.expected);assert.equal(receipt.writeCount,1);
      assert.equal(invocations.filter(value=>value.key===spec.effectKey).length,1);
      assert.equal(state.effects[spec.effectKey].status,'confirmed');same(state.effects[spec.effectKey].payload,spec.expected);
    }
    proofs.push({id:spec.id,planRef:proof.planRef,candidateSha:proof.candidateSha,obligationSha:proof.obligationSha});
  }
  // Readiness/timing measurements are separately retained, not accepted merely
  // because candidate bytes passed. Recoveries can lack crashed-turn counters.
  const starts=new Map(),latencies=[];let contextBytes=0,dispatches=0;
  for(const event of state.events.filter(value=>value.atMs>=result.startedAt&&value.atMs<=result.endedAt)) {
    const key=JSON.stringify([event.id,event.attempt]);
    if(event.type==='work.started'){
      starts.set(key,event.atMs);dispatches++;
      const {expected,...obligation}=state.obligations[event.id].spec;
      const dependencies=Object.fromEntries(obligation.dependsOn.map(id=>[id,{output:state.obligations[id].accepted.output,sha256:state.obligations[id].accepted.sha256}]));
      contextBytes+=Buffer.byteLength(canonical({obligation,inputs:{...obligation.inputs,dependencies},priorAttempts:event.attempt-1}));
    }
    if(event.type==='work.accepted'&&starts.has(key)){latencies.push(event.atMs-starts.get(key));starts.delete(key);}
  }
  latencies.sort((a,b)=>a-b);
  assert.equal(result.measurements.workerContextBytes,contextBytes,'Reported context size differs from actual typed work');
  assert.equal(result.dispatches,dispatches,'Reported dispatch count differs from retained events');
  assert.equal(result.measurements.acceptedStageSamples,latencies.length);
  const processCpu=process.cpuUsage(cpu);
  return {schema:'ophanim.scheduler-replay-verification/v1',ok:true,fixtureOnly:true,boardCommit:snapshot.commit,stateSha:digest(state),proofs,
    outputSha:digest(result.outputs),effectSha:digest(effectProjection(result.effects)),workerArtifactSha:derived.scope.configuration.workerArtifactSha,
    governanceContractSha:governance.identity.governanceContractSha,
    policySha:derived.scope.configuration.policySha,scopeSha:derived.scope.scopeSha,
    accepted:proofs.length,effects:invocations.length,verificationCalls:proofs.length,
    derivedStageP95Ms:latencies.length?latencies[Math.ceil(latencies.length*.95)-1]:null,
    measuredStageSamples:latencies.length,derivedWorkerContextBytes:contextBytes,durationMs:elapsed(started),processCpuMicros:processCpu.user+processCpu.system,
    runtimeDispatches:0,modelCalls:0,deterministicSemanticChecks:'replayed by the fixed TELOS verifier'};
}

function sources() {
  const files=[
    'cli.mjs','runtime.mjs','board.mjs','fixtures.mjs','watchdog.mjs','governance.mjs',
    ...['contract','artifact','release','efficiency'].map(name=>`governance/check-${name}.mjs`),
    ...['analyze','assessment','admission','contributions','prior','trace-binding','replay'].map(name=>`efficiency/${name}.mjs`),
  ];
  return Object.fromEntries(files.map(file=>{
    const relative=path.join('ophanim',file);
    return [relative,rawSha(fs.readFileSync(path.join(ROOT,relative)))];
  }));
}

function runBounded(args,{timeoutMs,guarded=false}={}) {
  return new Promise((resolve,reject)=>{
    const started=performance.now(),child=spawn(process.execPath,args,{detached:true,stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,LANG:'C.UTF-8',...process.env.OPHANIM_TELOS_ROOT?{OPHANIM_TELOS_ROOT:process.env.OPHANIM_TELOS_ROOT}:{}}});
    let stdout='',stderr='',reason=null,killTimer;
    const terminate=why=>{
      if(reason)return;reason=why;
      try{process.kill(-child.pid,'SIGTERM');}catch{}
      killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},guarded?500:100);
    };
    const timer=setTimeout(()=>terminate('deadline'),timeoutMs);
    const capture=(current,chunk)=>{const next=current+chunk;if(Buffer.byteLength(next)>262144){terminate('output-limit');return next.slice(-131072);}return next;};
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout=capture(stdout,chunk);});child.stderr.on('data',chunk=>{stderr=capture(stderr,chunk);});
    child.on('error',error=>{clearTimeout(timer);clearTimeout(killTimer);reject(error);});
    child.on('close',(exitCode,signal)=>{clearTimeout(timer);clearTimeout(killTimer);resolve({pid:child.pid,exitCode,signal,reason,durationMs:elapsed(started),stdout,stderr});});
  });
}

export async function evaluateScheduler({outputDir,request,originalResult,originalStateDir,scopeSha,trace,baselineSlots=1,candidateSlots=3,repeats=3,budgetMs=120000,trialTimeoutMs=30000,recoveryEvent='after-effect-written',onProgress=()=>{}}={}) {
  const started=performance.now(),startedAt=Date.now(),cpu=process.cpuUsage();
  assert.ok(path.isAbsolute(outputDir??'')&&path.isAbsolute(originalStateDir??''),'Absolute experiment and original state roots required');
  assert.equal(baselineSlots,1);assert.equal(candidateSlots,3);assert.equal(recoveryEvent,'after-effect-written');
  assert.ok(Number.isSafeInteger(budgetMs)&&budgetMs>=1000&&budgetMs<=300000);
  assert.ok(Number.isSafeInteger(trialTimeoutMs)&&trialTimeoutMs>=1000&&trialTimeoutMs<=120000);
  const order=alternatingOrder(repeats),derived=derive(request),transport=request.telosRoot??process.env.OPHANIM_TELOS_ROOT;
  assert.equal(originalResult?.slots,1);assertOutputs(originalResult,derived);
  if(scopeSha)assert.equal(scopeSha,derived.scope.scopeSha,'Original applicability scope differs');
  if(trace){assert.equal(trace.scopeSha,derived.scope.scopeSha);same(trace.configuration.workerRegistry,derived.registry);}
  fs.mkdirSync(outputDir,{recursive:true,mode:0o700});assert.equal(fs.realpathSync(outputDir),outputDir);
  assert.equal(fs.readdirSync(outputDir).length,0,'Experiments require a fresh empty directory');
  const manifestFile=path.join(outputDir,'manifest.json'),files={},implementation=sources();
  let childWallMs=0,verificationWallMs=0,verificationCpuMicros=0;
  const manifest={schema:'ophanim.scheduler-replay/v1',fixtureOnly:true,status:'running',request:derived.request,requestSha:digest(derived.request),
    applicability:derived.applicability,scopeSha:derived.scope.scopeSha,workerArtifactSha:derived.scope.configuration.workerArtifactSha,
    configuration:derived.scope.configuration,policy:derived.scope.policy,implementation,
    settings:{baselineSlots,candidateSlots,repeats,budgetMs,trialTimeoutMs,recoveryEvent,order},startedAt,
    original:null,trials:[],files,measurements:{},boundaries:{models:0,businessConnections:0,publication:0,policyActivation:0,processTimeIsWallClock:true,processCpuCoverage:'Evaluator and verifier-process CPU only; runtime/checker descendant CPU is not inferred'}};
  const remember=file=>{files[path.relative(outputDir,file)]=rawSha(fs.readFileSync(file));return path.relative(outputDir,file);};
  const rememberTree=directory=>{
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      assert.ok(!entry.isSymbolicLink(),'Replay evidence cannot contain symbolic links');
      if(entry.isDirectory())rememberTree(file);
      else {assert.ok(entry.isFile(),'Regular replay evidence files required');remember(file);}
    }
  };
  const save=()=>writeJson(manifestFile,manifest);
  const remaining=()=>budgetMs-elapsed(started);
  const deadline=()=>{if(remaining()<750)throw new BudgetExpired('Optimizer wall-clock allowance exhausted');return Math.min(trialTimeoutMs,remaining()-500);};
  const checkSources=()=>{
    const current=sources(),changed=Object.keys(implementation).filter(file=>current[file]!==implementation[file]);
    assert.equal(changed.length,0,`Implementation changed during controlled replay: ${changed.join(', ')}`);
  };
  const updateMeasurements=()=>{
    const wallMs=elapsed(started),usage=process.cpuUsage(cpu);
    manifest.measurements={benchmarkWallMs:wallMs,childWallMs,verificationWallMs,parentOverheadMs:Math.max(0,wallMs-childWallMs-verificationWallMs),evaluatorCpuMicros:usage.user+usage.system,verificationCpuMicros,deadlineAt:startedAt+budgetMs,budgetMs,remainingMs:Math.max(0,budgetMs-wallMs),realizedInitialNetSavedMs:-wallMs};
  };
  async function verify(name,stateDir,resultFile,boardCommit) {
    checkSources();const timeout=deadline(),dir=path.join(outputDir,name);fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,'verification.json'),requestFile=path.join(dir,'verification-request.json');
    writeJson(requestFile,{stateDir,resultFile,request:derived.request,boardCommit,...transport?{telosRoot:transport}:{},outputFile:file});remember(requestFile);
    const processResult=await runBounded([HERE,'--verify-trial',requestFile],{timeoutMs:timeout});verificationWallMs+=processResult.durationMs;
    const processFile=path.join(dir,'verification-process.json');writeJson(processFile,processResult);remember(processFile);
    if(processResult.reason==='deadline'||remaining()<0)throw new BudgetExpired('Independent verification exceeded optimizer allowance');
    assert.equal(processResult.exitCode,0,processResult.stderr||'Independent replay verification failed');
    const proof=read(file);remember(file);assert.equal(proof.ok,true);verificationCpuMicros+=proof.processCpuMicros;
    checkSources();return {proof,file:path.relative(outputDir,file),elapsedMs:processResult.durationMs};
  }
  async function segment(trial,phase,fault) {
    checkSources();const timeout=deadline(),dir=path.join(outputDir,'trials',trial.id,phase);fs.mkdirSync(dir,{recursive:true});
    const stateDir=path.join(outputDir,trial.stateDir),requestFile=path.join(dir,'request.json'),resultFile=path.join(dir,'result.json'),watchdogFile=path.join(dir,'watchdog.json'),guardFile=path.join(dir,'watchdog-request.json');
    writeJson(requestFile,{...derived.request,stateDir,resultFile,slots:trial.slots,...transport?{telosRoot:transport}:{},...fault?{fault}:{}});remember(requestFile);
    writeJson(guardFile,{requestFile,reportFile:watchdogFile,replay:true,replayRoot:outputDir,timeoutMs:Math.max(100,Math.floor(timeout-150)),stallMs:Math.max(100,Math.min(10000,Math.floor(timeout-150)))});remember(guardFile);
    onProgress({trial:trial.id,phase,slots:trial.slots,status:'started',remainingMs:remaining()});
    const processResult=await runBounded([WATCHDOG,'--request',guardFile],{timeoutMs:timeout,guarded:true});childWallMs+=processResult.durationMs;
    const processFile=path.join(dir,'process.json');writeJson(processFile,processResult);remember(processFile);
    const watchdog=fs.existsSync(watchdogFile)?read(watchdogFile):null;
    const result=fs.existsSync(resultFile)?read(resultFile):null;
    const entry={phase,requestFile:path.relative(outputDir,requestFile),watchdogRequestFile:path.relative(outputDir,guardFile),watchdogFile:watchdog?remember(watchdogFile):null,resultFile:result?remember(resultFile):null,processFile:path.relative(outputDir,processFile),wallMs:processResult.durationMs};
    trial.segments.push(entry);updateMeasurements();save();
    if(processResult.reason==='deadline'||watchdog?.reason==='deadline'||remaining()<0)throw new BudgetExpired('Replay child exceeded optimizer allowance');
    assert.ok(watchdog,'Watchdog receipt missing');
    if(fault){assert.equal(watchdog.signal,'SIGKILL');assert.equal(result,null);}
    else{assert.equal(processResult.exitCode,0,watchdog.stderr||processResult.stderr);assert.ok(result);assertOutputs(result,derived,originalResult);}
    checkSources();onProgress({trial:trial.id,phase,status:fault?'interrupted':'completed',elapsedMs:processResult.durationMs});
    return {result,watchdog,entry};
  }
  async function trial(kind,pair,slots) {
    const id=`${String(manifest.trials.length+1).padStart(2,'0')}-${kind}-${slots}`,row={id,kind,pair,slots,orderIndex:manifest.trials.length,stateDir:`trials/${id}/state`,segments:[]};manifest.trials.push(row);save();
    let final,before=null;
    if(kind==='recovery'){
      await segment(row,'crash',{event:recoveryEvent,mode:'crash'});
      const snapshot=readRuntimeSnapshot(path.join(outputDir,row.stateDir)),state=snapshot.state;
      before={boardCommit:snapshot.commit,stateSha:digest(state),effects:clone(state.effects)};
      assert.ok(Object.values(state.effects).some(effect=>effect.status==='intent'),'Fault did not retain a pending effect intent');
      final=await segment(row,'resume');
    }else final=await segment(row,'run');
    const verified=await verify(`trials/${id}`,path.join(outputDir,row.stateDir),path.join(outputDir,final.entry.resultFile));
    rememberTree(path.join(outputDir,row.stateDir));
    assert.equal(verified.proof.scopeSha,manifest.scopeSha);
    assert.equal(verified.proof.workerArtifactSha,manifest.workerArtifactSha);
    assert.equal(verified.proof.governanceContractSha,manifest.original.governanceContractSha);
    Object.assign(row,{resultFile:final.entry.resultFile,verificationFile:verified.file,stateSha:verified.proof.stateSha,boardCommit:verified.proof.boardCommit,
      outputSha:verified.proof.outputSha,effectSha:verified.proof.effectSha,governanceContractSha:verified.proof.governanceContractSha,
      metrics:{wallMs:row.segments.reduce((sum,value)=>sum+value.wallMs,0),runDurationMs:final.result.durationMs,
        workerContextBytes:kind==='clean'?final.result.measurements.workerContextBytes:null,
        p95StageAcceptanceMs:final.result.measurements.p95StageAcceptanceMs,
        retainedEventStageP95Ms:verified.proof.derivedStageP95Ms,
        verificationCalls:kind==='clean'?final.result.measurements.verificationCalls:null,verificationMs:verified.elapsedMs,
        recoveryMs:kind==='recovery'?final.result.durationMs:null,
        ...(kind==='recovery'?{resumeWorkerContextBytes:final.result.measurements.workerContextBytes,resumeVerificationCalls:final.result.measurements.verificationCalls,crashedTurnCounters:'unavailable',beforeRecovery:before}:{})}});
    same(row.outputSha,manifest.original.outputSha);same(row.effectSha,manifest.original.effectSha);updateMeasurements();save();
  }
  try {
    const originalFile=path.join(outputDir,'original-result.json');writeJson(originalFile,originalResult);remember(originalFile);
    const originalSnapshot=readRuntimeSnapshot(originalStateDir,trace?.boardCommit);
    assert.equal(readRuntimeSnapshot(originalStateDir).commit,originalSnapshot.commit,'Original accepted board head changed');
    const originalVerification=await verify('original',originalStateDir,originalFile,originalSnapshot.commit);
    manifest.original={stateRoot:originalStateDir,stateSha:originalVerification.proof.stateSha,boardCommit:originalVerification.proof.boardCommit,proofs:originalVerification.proof.proofs,
      resultFile:path.relative(outputDir,originalFile),resultSha:rawSha(fs.readFileSync(originalFile)),verificationFile:originalVerification.file,
      outputSha:originalVerification.proof.outputSha,effectSha:originalVerification.proof.effectSha,governanceContractSha:originalVerification.proof.governanceContractSha};save();
    for(const item of order)await trial('clean',item.pair,item.slots);
    for(const slots of [3,1])await trial('recovery',null,slots);
    same(digest(readRuntimeSnapshot(originalStateDir,manifest.original.boardCommit).state),manifest.original.stateSha,'Original accepted snapshot changed');
    assert.equal(readRuntimeSnapshot(originalStateDir).commit,manifest.original.boardCommit,'Original accepted board head changed');
    checkSources();deadline();manifest.status='completed';updateMeasurements();
    const baseline=manifest.trials.filter(row=>row.kind==='clean'&&row.slots===1).map(row=>row.metrics.runDurationMs),candidate=manifest.trials.filter(row=>row.kind==='clean'&&row.slots===3).map(row=>row.metrics.runDurationMs);
    const conservativeSavedMs=Math.min(...baseline)-Math.max(...candidate);
    manifest.comparison={baselineMs:baseline,candidateMs:candidate,conservativeSavedMs,conservativeFraction:conservativeSavedMs/Math.min(...baseline),forecastConvergences:20,forecastGrossSavedMs:conservativeSavedMs*20,forecastNetSavedMs:conservativeSavedMs*20-manifest.measurements.benchmarkWallMs,interpretation:'Measured synthetic workload; forecast reuse is conditional, and policy authority must independently recheck every claim.'};
    save();return {ok:true,status:manifest.status,evidenceRoot:outputDir,manifestFile,evidenceSha:rawSha(fs.readFileSync(manifestFile)),originalResultSha:manifest.original.resultSha,scopeSha:manifest.scopeSha,workerArtifactSha:manifest.workerArtifactSha,measurements:manifest.measurements};
  }catch(error){
    manifest.status=error instanceof BudgetExpired?'budget_exhausted':'failed';manifest.reason=error.message;updateMeasurements();save();
    return {ok:false,status:manifest.status,reason:manifest.reason,evidenceRoot:outputDir,manifestFile,evidenceSha:rawSha(fs.readFileSync(manifestFile)),scopeSha:manifest.scopeSha,measurements:manifest.measurements};
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===HERE) {
  try {
    assert.equal(process.argv[2],'--verify-trial');assert.equal(process.argv.length,4);assert.ok(process.connected,'Verification child requires a supervising parent');
    const request=read(process.argv[3]);const result=await verifyReplayTrial(request);writeJson(request.outputFile,result);
    process.stdout.write(JSON.stringify({ok:true,accepted:result.accepted,effects:result.effects})+'\n');
  }catch(error){process.stderr.write(error.stack+'\n');process.exitCode=1;}
}
