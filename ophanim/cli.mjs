#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeFixtures,createPlanning,createWorkers,createSyntheticDestination,canonical,digest,writeJson,outputProjection,intervalSummary} from './fixtures.mjs';
import {runRuntime,loadRuntime,activateRelease,rollbackRelease} from './runtime.mjs';
import {readRuntimeSnapshot,verifyRuntimeChain} from './board.mjs';
import {withSeatLock} from '../pantheon/src/seat/lock.mjs';
import {assessConvergence,chooseEfficiencySlots,efficiencyScope,reusedEfficiencyRecord,verifyEfficiencyRecord} from './efficiency/assessment.mjs';
import {recoverInterruptedAssessment} from './efficiency/recovery.mjs';

const FIXTURES=fileURLToPath(new URL('./fixtures.mjs',import.meta.url));
const metadata=workers=>workers.map(({id,version,kinds,scopes})=>({id,version,kinds,scopes})).sort((a,b)=>a.id.localeCompare(b.id));
function workerArtifact(options,workers) {
  return {schema:'ophanim.synthetic-worker-artifact/v1',sourceSha:digest(fs.readFileSync(FIXTURES,'utf8')),options,workers:metadata(workers)};
}

// The ledger is ON BY DEFAULT: efficiency records go to the ledger at OPHANIM_LEDGER or, unset, at
// <stateDir>/ledger (ophanim/ledger/system.mjs). `opts.ledger: false` turns it off; a recorder passed in
// is used as is. It carries signing keys, so it never comes from a request file, and replays get none.
export async function executeRequest(request,opts={}) {
  let ledger=opts.ledger===false?null:(opts.ledger??null);
  if(opts.ledger===undefined&&request&&path.isAbsolute(request.stateDir??'')){
    const {openSystemLedger}=await import('./ledger/system.mjs');
    ledger=openSystemLedger({root:process.env.OPHANIM_LEDGER??path.join(path.resolve(request.stateDir),'ledger')}).recorder();
  }
  return execute(request,false,{ledger});
}

async function execute(request,replay,opts={}) {
  if(!request || !path.isAbsolute(request.stateDir??''))throw Error('Absolute private synthetic stateDir required');
  if(Object.hasOwn(request,'expectedQualifiedConvergences')&&
      (!Number.isInteger(request.expectedQualifiedConvergences)||request.expectedQualifiedConvergences<1||request.expectedQualifiedConvergences>20))
    throw Error('Expected exact-scope convergences must be an integer from 1 to 20');
  const stateDir=path.resolve(request.stateDir);
  fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
  if(fs.realpathSync(stateDir)!==stateDir)throw Error('Canonical synthetic state directory required');
  return withSeatLock('synthetic-driver',()=>runRequest({...request,stateDir},replay,replay?{}:opts),{dir:path.join(stateDir,'locks'),timeoutMs:60000});
}

async function runRequest(request,replay,{ledger=null}={}) {
  const stateDir=request.stateDir;
  const intervals=[],startedAt=Date.now();
  const dispatchStarts=new Map(),acceptedLatencies=[];
  const priorRuntime=loadRuntime(stateDir);
  const alreadyAccepted=new Set(Object.values(priorRuntime?.obligations??{}).filter(row=>row.status==='accepted').map(row=>row.spec.id));
  const attempts=new Map(),verifications=[],events=[];
  const verificationCalls={verifyCandidate:0,verifyPlan:0};
  let workerContextBytes=0;
  const onEvent=event=>{
    const attempt=JSON.stringify([event.id,event.attempt]);
    if(event.type==='work.started'){
      dispatchStarts.set(attempt,performance.now());
      attempts.set(attempt,{id:event.id,attempt:event.attempt,startedAt:event.atMs});
    }
    if(event.type==='work.accepted')alreadyAccepted.add(event.id);
    if(['work.persisted','work.failed'].includes(event.type)&&attempts.has(attempt)){
      const row=attempts.get(attempt);
      row.endedAt=event.atMs;
      row.status=event.type==='work.persisted'?'produced':'failed';
    }
    if(event.type==='work.accepted'&&dispatchStarts.has(attempt)) {
      acceptedLatencies.push(performance.now()-dispatchStarts.get(attempt));
      dispatchStarts.delete(attempt);
    }
    if(!replay&&events.length<25000)events.push(event);
    if(process.connected)process.send({type:'event',event});
  };
  const heartbeat=setInterval(()=>{if(process.connected)process.send({type:'heartbeat',at:Date.now()});},50);
  if(process.connected)process.send({type:'heartbeat',at:Date.now()});
  try {
    const {createGovernance}=await import('./governance.mjs');
    const telosRoot=request.telosRoot??process.env.OPHANIM_TELOS_ROOT;
    const authority=await createGovernance({root:stateDir,fixtureOnly:true,...telosRoot?{telosRoot}:{}});
    const governance={...authority};
    governance.verifyPlan=(...args)=>{verificationCalls.verifyPlan++;return authority.verifyPlan(...args);};
    governance.verifyCandidate=async input=>{
      verificationCalls.verifyCandidate++;
      const begin=Date.now(),id=input.obligation.id,purpose=alreadyAccepted.has(id)?'replay':'accept';
      let result;
      try{return result=await authority.verifyCandidate(input);}
      finally{
        if(!replay&&input.obligation.kind!=='synthetic-release')verifications.push({id,
          attempt:input.evidence.totalAttempt??input.evidence.attempt,startedAt:begin,endedAt:Date.now(),purpose,
          candidateSha:input.candidate.sha256,ok:result?.ok===true});
      }
    };
    const batches=request.batches??[request.fixture??{}];
    const fixtures=batches.map(makeFixtures),planning=createPlanning({batches});
    const workerOptions={department:fixtures[0]?.department??'operations',departments:[...new Set(fixtures.map(f=>f.department))].sort(),version:'synthetic-v1',delayMs:15,...request.workerOptions};
    const workers=createWorkers({...workerOptions,onInterval:interval=>{intervals.push(interval);}}).map(worker=>({
      ...worker,
      run:input=>{
        const bytes=Buffer.byteLength(canonical(input));
        workerContextBytes+=bytes;
        const row=attempts.get(JSON.stringify([input.obligation.id,input.priorAttempts+1]));
        if(row)Object.assign(row,{inputSha:digest(input.inputs),inputBytes:Buffer.byteLength(canonical(input.inputs)),contextBytes:bytes});
        return worker.run(input);
      },
    }));
    const artifact=workerArtifact(workerOptions,workers);
    const initialRelease=priorRuntime?.activeRelease??null;
    const baselineSlots=request.slots??1;
    // Non-default policies are part of the request identity; defaults are omitted
    // so existing scopes and replays are unchanged.
    const policies={...request.schedule&&request.schedule!=='wave'?{schedule:request.schedule}:{},
      ...request.handoffVerification&&request.handoffVerification!=='full'?{handoffVerification:request.handoffVerification}:{}};
    const replayRequest={batches,maxDispatches:request.maxDispatches??1000,workerOptions,...policies,...telosRoot?{telosRoot}:{}};
    const scope=efficiencyScope({obligations:fixtures.flatMap(f=>f.obligations),planning,
      workerArtifactSha:digest(artifact),registry:metadata(workers),request:{batches,maxDispatches:replayRequest.maxDispatches,workerOptions,...policies},slots:baselineSlots});
    const recoveredEfficiency=replay?null:await recoverInterruptedAssessment({stateDir,priorRuntime,scope,governance:authority});
    const efficiencyRoot=path.resolve(request.efficiencyRoot??path.join(stateDir,'efficiency'));
    const use=replay||request.operation||request.fault||initialRelease&&initialRelease!=='baseline'||!request.efficiencyRoot
      ?{slots:baselineSlots}:await chooseEfficiencySlots({root:efficiencyRoot,scope,stateDir,baselineSlots,hasRuntime:!!priorRuntime,telosRoot,ledger});
    const slots=use.slots;
    scope.configuration.slots=slots;
    const efficiencyContext=replay?null:{scopeSha:scope.scopeSha,configuration:scope.configuration,policy:scope.policy};
    const destination=createSyntheticDestination(path.join(stateDir,'destination'));
    const fault=async(event,payload)=>{
      if(event!==request.fault?.event)return;
      const id=payload.id??payload.obligationId??payload.release??null;
      if(request.fault.id&&request.fault.id!==id)return;
      const marker=path.join(stateDir,`fault-${digest(request.fault).slice(0,16)}.json`);
      if(fs.existsSync(marker))return;
      writeJson(marker,{event,payload,at:Date.now(),pid:process.pid,mode:request.fault.mode??'crash'});
      if(process.connected)process.send({type:'event',event:{type:'fixture.fault',event,id}});
      if(request.fault.mode==='stall'){for(;;){/* The separate watchdog must terminate this process. */}}
      process.kill(process.pid,'SIGKILL');
      await new Promise(()=>{});
    };
    let result;
    if(request.operation==='activate') {
      if(!loadRuntime(stateDir))await runRuntime({stateDir,obligations:[],workers,governance,effectAdapter:destination,slots:1});
      const release={id:request.releaseId??workerOptions.version,artifactSha:digest(artifact),stateSchema:'ophanim.runtime/v1',workers:metadata(workers)};
      const obligation={id:`release:${release.id}`,kind:'synthetic-release',scope:'fixture-release',inputs:{artifact},dependsOn:[],outputKey:`release:${release.id}`,expected:release,maxAttempts:1};
      const candidate={id:`release:${release.id}:1`,sha256:digest(release),output:release,checks:[]};
      const worker={id:'fixture-release-builder',version:'1',kinds:['synthetic-release'],scopes:['fixture-release']};
      const accepted=await governance.verifyCandidate({candidate,obligation,worker,evidence:{attempt:1,dependencyVersions:[],stateSchema:'ophanim.runtime/v1'}});
      if(accepted?.ok!==true)throw Error('Synthetic release manifest failed TELOS acceptance');
      release.planRef=accepted.planRef;release.evidenceRefs=accepted.evidenceRefs??[];
      writeJson(path.join(stateDir,`artifact-${release.id}.json`),artifact);
      result={state:await activateRelease({stateDir,release,governance,fault}),release};
    } else if(request.operation==='rollback') {
      result={state:await rollbackRelease({stateDir,toRelease:request.toRelease,governance,fault})};
    } else {
      const {fault:ignoredFault,resultFile:ignoredResult,operation:ignoredOperation,...resumeRequest}=request;
      writeJson(path.join(stateDir,'driver-request.json'),resumeRequest);
      const prior=loadRuntime(stateDir),active=prior?.pendingRelease?.release??prior?.releases?.[prior.activeRelease];
      if(active&&active.id!=='baseline'&&active.artifactSha!==digest(artifact))throw Error('Fixture worker implementation/config differs from accepted release artifact');
      result=await runRuntime({stateDir,planning,workers,slots,governance,effectAdapter:destination,fault,maxDispatches:request.maxDispatches??1000,onEvent,efficiencyContext,
        ...policies.schedule?{schedule:policies.schedule}:{},...policies.handoffVerification?{handoffVerification:policies.handoffVerification}:{}});
    }
    const convergence=result.convergence??(initialRelease!==result.state.activeRelease?'accepted_change':'no_change');
    const endedAt=Date.now();
    const output={schema:'ophanim.synthetic-run/v1',synthetic:true,operation:request.operation??'run',startedAt,endedAt,durationMs:endedAt-startedAt,slots,convergence,blockers:result.blockers??result.held??[],complete:result.complete??null,accepted:result.accepted??[],held:result.held??[],dispatches:result.dispatches??0,activeRelease:result.state.activeRelease,outputs:outputProjection(result.state),effects:destination.list(),destinationInvocations:destination.invocations(),intervals,intervalSummary:intervalSummary(intervals),stateRevision:result.state.revision,limits:{modelCalls:0,servicesStarted:0,businessSystemsConnected:0,syntheticWorkerDelayMs:workerOptions.delayMs}};
    acceptedLatencies.sort((a,b)=>a-b);
    output.measurements={
      acceptedStageSamples:acceptedLatencies.length,
      p95StageAcceptanceMs:acceptedLatencies.length?Math.round(acceptedLatencies[Math.ceil(acceptedLatencies.length*0.95)-1]):null,
      workerContextBytes,
      verificationCalls,
      ...result.handoff?.mode==='frontier'?{handoff:{mode:result.handoff.mode,verified:result.handoff.verified.length,skipped:result.handoff.skipped}}:{},
    };
    // A reused convergence wrote nothing; its head already carries an assessment.
    if(result.reused)output.reusedConvergence={boardCommit:result.boardCommit};
    if(!replay&&result.reused)output.efficiency=reusedEfficiencyRecord({stateDir,boardCommit:result.boardCommit,output,ledger});
    else if(!replay){
      const record=await assessConvergence({root:efficiencyRoot,stateDir,scope,state:result.state,
        boardCommit:result.boardCommit??readRuntimeSnapshot(stateDir).commit,output,request,replayRequest,priorRuntime,
        attempts:[...attempts.values()],verifications,events,governance:authority,use,interrupted:recoveredEfficiency,ledger});
      // A fresh assessment is re-derived from its retained trace and the accepted board before it is used or
      // written, as a reused one is (reusedEfficiencyRecord). A record that does not re-derive stops the run.
      verifyEfficiencyRecord({stateDir,record,output});
      output.efficiency=record;
    }
    if(recoveredEfficiency)output.recoveredEfficiency=recoveredEfficiency;
    writeJson(request.resultFile??path.join(stateDir,'result.json'),output);
    return output;
  } finally {clearInterval(heartbeat);}
}

function options(args) {
  const out={};
  for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||args[i+1]===undefined)throw Error('Flags require values');out[args[i].slice(2)]=args[i+1];}
  return out;
}
function writeNewReport(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=fs.mkdtempSync(path.join(path.dirname(file),'.ophanim-report-'));
  const prepared=path.join(temporary,'receipt.json');
  try {
    writeJson(prepared,value);
    fs.linkSync(prepared,file);
  } finally {
    if(fs.existsSync(prepared))fs.unlinkSync(prepared);
    fs.rmdirSync(temporary);
  }
}
async function main() {
  const command=process.argv[2]??'help',opts=options(process.argv.slice(3));
  if(command==='replay-worker') {
    if(!process.connected||!opts.request||!opts.root)throw Error('The watchdog must launch an isolated replay worker');
    const root=fs.realpathSync(opts.root),file=fs.realpathSync(opts.request);
    const inside=value=>typeof value==='string'&&path.isAbsolute(value)&&path.resolve(value).startsWith(root+path.sep);
    if(!inside(file))throw Error('Replay request is outside its evidence directory');
    const request=JSON.parse(fs.readFileSync(file,'utf8'));
    if(request.operation||request.efficiencyRoot||!inside(request.stateDir)||!inside(request.resultFile))throw Error('Replay requires disposable synthetic state and output');
    await execute(request,true);
    return;
  }
  if(command==='worker') {
    if(!opts.request)throw Error('worker requires --request');
    const result=await executeRequest(JSON.parse(fs.readFileSync(opts.request,'utf8')));
    process.stdout.write(JSON.stringify({convergence:result.convergence,blockers:result.blockers,complete:result.complete,accepted:result.accepted.length,held:result.held.length,dispatches:result.dispatches,efficiency:result.efficiency})+'\n');return;
  }
  if(command==='proof'||command==='prove') {
    const {runQualification}=await import('./proof.mjs');
    const report=await runQualification({outputDir:opts.output?path.resolve(opts.output):undefined,onProgress:value=>process.stdout.write(JSON.stringify(value)+'\n')});
    process.stdout.write(JSON.stringify({status:report.status,convergence:report.convergence,blockers:report.blockers,report:report.reportFile})+'\n');return;
  }
  if(command==='verify') {
    if(!opts.output)throw Error('verify requires --output /absolute/proof-directory');
    const {verifyProof}=await import('./proof.mjs');
    const result=await verifyProof({outputDir:path.resolve(opts.output)});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');return;
  }
  if(command==='resume') {
    if(!opts.state)throw Error('resume requires --state /absolute/state');
    const stateDir=path.resolve(opts.state),request=JSON.parse(fs.readFileSync(path.join(stateDir,'driver-request.json'),'utf8'));
    if(request.stateDir!==stateDir)throw Error('Saved synthetic resume identity differs');
    const result=await executeRequest({...request,resultFile:path.join(stateDir,'result.json')});
    process.stdout.write(JSON.stringify({convergence:result.convergence,blockers:result.blockers,complete:result.complete,accepted:result.accepted.length,held:result.held.length,dispatches:result.dispatches,activeRelease:result.activeRelease,efficiency:result.efficiency})+'\n');return;
  }
  if(command==='demo') {
    if(!opts.state)throw Error('demo requires --state /absolute/new-state');
    let investigationEstimate;
    if(opts['investigation-estimate']){
      const file=path.resolve(opts['investigation-estimate']),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.size>8192||fs.realpathSync(file)!==file)throw Error('Bounded canonical investigation estimate file required');
      investigationEstimate=JSON.parse(fs.readFileSync(file,'utf8'));
    }
    const result=await executeRequest({stateDir:path.resolve(opts.state),fixture:{count:Number(opts.cases??3)},slots:Number(opts.slots??1),
      ...opts['efficiency-root']?{efficiencyRoot:path.resolve(opts['efficiency-root'])}:{},
      ...investigationEstimate!==undefined?{investigationEstimate}:{},
      ...opts.schedule?{schedule:opts.schedule}:{},...opts['handoff-verification']?{handoffVerification:opts['handoff-verification']}:{},
      ...Object.hasOwn(opts,'expected-convergences')?{expectedQualifiedConvergences:Number(opts['expected-convergences'])}:{}});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');return;
  }
  if(command==='status') {
    if(!opts.state)throw Error('status requires --state');
    const state=loadRuntime(path.resolve(opts.state));
    let chain;
    try{chain=verifyRuntimeChain(path.resolve(opts.state));}catch(error){chain={ok:false,reason:String(error.message).slice(0,500)};}
    process.stdout.write(JSON.stringify(state?{schema:state.schema,revision:state.revision,chain,activeRelease:state.activeRelease,obligations:Object.fromEntries(Object.entries(state.obligations).map(([id,row])=>[id,{status:row.status,attempt:row.attempt,reason:row.reason}])),effects:state.effects}:null,null,2)+'\n');return;
  }
  if(command==='investigate') {
    if(opts['historical-report']){
      const {investigateHistoricalLatency}=await import('./efficiency/investigation/historical.mjs');
      if(opts.output && fs.existsSync(path.resolve(opts.output)))throw Error('Fresh investigation report path required');
      const retained=opts['verify-receipt']?JSON.parse(fs.readFileSync(path.resolve(opts['verify-receipt']),'utf8')):null;
      const report=await investigateHistoricalLatency({reportFile:path.resolve(opts['historical-report']),expectedReportSha:retained?.sourceReportSha,
        telosRoot:process.env.OPHANIM_TELOS_ROOT});
      if(retained){
        if(canonical(report)!==canonical(retained))throw Error('Historical investigation differs from independently reopened evidence');
        process.stdout.write(JSON.stringify({ok:true,receiptSha:report.receiptSha})+'\n');return;
      }
      if(opts.output)writeNewReport(path.resolve(opts.output),report);
      else process.stdout.write(JSON.stringify(report,null,2)+'\n');
      return;
    }
    if(!opts.state)throw Error('investigate requires --state or --historical-report');
    const stateDir=path.resolve(opts.state);
    const output=JSON.parse(fs.readFileSync(path.join(stateDir,'result.json'),'utf8'));
    const {verifyEfficiencyRecord}=await import('./efficiency/assessment.mjs');
    const report=verifyEfficiencyRecord({stateDir,record:output.efficiency,output});
    if(!report.investigation)throw Error('No investigation receipt in this assessment version');
    const {buildFunctionalModels}=await import('./efficiency/investigation/models.mjs');
    const trace=JSON.parse(fs.readFileSync(path.join(path.dirname(output.efficiency.reportFile),'trace.json'),'utf8'));
    if(digest(trace)!==output.efficiency.traceSha)throw Error('Investigation trace changed after verification');
    const models=buildFunctionalModels({trace,registry:report.contributionRegistry,variables:report.variables});
    process.stdout.write(JSON.stringify({models,receipt:report.investigation},null,2)+'\n');return;
  }
  if(command==='fixtures') {process.stdout.write(JSON.stringify(makeFixtures({count:Number(opts.cases??3)}),null,2)+'\n');return;}
  if(command!=='help')throw Error(`Unknown command: ${command}`);
  process.stdout.write('Ophanim synthetic local qualification\n  node ophanim/cli.mjs prove --output /absolute/new-proof\n  node ophanim/cli.mjs resume --state /absolute/state\n  node ophanim/cli.mjs verify --output /absolute/proof\n  node ophanim/cli.mjs demo --state /absolute/new-state --cases 3 --slots 1 [--schedule wave|refill] [--handoff-verification full|frontier] [--expected-convergences 1] [--investigation-estimate /absolute/forecast.json]\n  node ophanim/cli.mjs status --state /absolute/state\n  node ophanim/cli.mjs investigate --state /absolute/state\n  node ophanim/cli.mjs investigate --historical-report /absolute/report.json [--output /absolute/new-result.json | --verify-receipt /absolute/result.json]\n  node ophanim/cli.mjs fixtures --cases 3\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
