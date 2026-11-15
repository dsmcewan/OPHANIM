#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeFixtures,createPlanning,createWorkers,createSyntheticDestination,canonical,digest,writeJson,outputProjection,intervalSummary} from './fixtures.mjs';
import {runRuntime,loadRuntime,activateRelease,rollbackRelease} from './runtime.mjs';

const FIXTURES=fileURLToPath(new URL('./fixtures.mjs',import.meta.url));
const metadata=workers=>workers.map(({id,version,kinds,scopes})=>({id,version,kinds,scopes})).sort((a,b)=>a.id.localeCompare(b.id));
function workerArtifact(options,workers) {
  return {schema:'ophanim.synthetic-worker-artifact/v1',sourceSha:digest(fs.readFileSync(FIXTURES,'utf8')),options,workers:metadata(workers)};
}

export async function executeRequest(request) {
  if(!request || !path.isAbsolute(request.stateDir??''))throw Error('Absolute private synthetic stateDir required');
  const stateDir=request.stateDir;
  fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
  const intervals=[],startedAt=Date.now();
  const dispatchStarts=new Map(),acceptedLatencies=[];
  const verificationCalls={verifyCandidate:0,verifyPlan:0};
  let workerContextBytes=0;
  const onEvent=event=>{
    const attempt=JSON.stringify([event.id,event.attempt]);
    if(event.type==='work.started')dispatchStarts.set(attempt,performance.now());
    if(event.type==='work.accepted'&&dispatchStarts.has(attempt)) {
      acceptedLatencies.push(performance.now()-dispatchStarts.get(attempt));
      dispatchStarts.delete(attempt);
    }
    if(process.connected)process.send({type:'event',event});
  };
  const heartbeat=setInterval(()=>{if(process.connected)process.send({type:'heartbeat',at:Date.now()});},50);
  if(process.connected)process.send({type:'heartbeat',at:Date.now()});
  try {
    const {createGovernance}=await import('./governance.mjs');
    const telosRoot=request.telosRoot??process.env.OPHANIM_TELOS_ROOT;
    const authority=await createGovernance({root:stateDir,fixtureOnly:true,...telosRoot?{telosRoot}:{}});
    const governance={...authority};
    for(const method of Object.keys(verificationCalls))governance[method]=(...args)=>{
      verificationCalls[method]++;
      return authority[method](...args);
    };
    const batches=request.batches??[request.fixture??{}];
    const fixtures=batches.map(makeFixtures),planning=createPlanning({batches});
    const workerOptions={department:fixtures[0]?.department??'operations',departments:[...new Set(fixtures.map(f=>f.department))].sort(),version:'synthetic-v1',delayMs:15,...request.workerOptions};
    const workers=createWorkers({...workerOptions,onInterval:interval=>{intervals.push(interval);}}).map(worker=>({
      ...worker,
      run:input=>{
        workerContextBytes+=Buffer.byteLength(canonical(input));
        return worker.run(input);
      },
    }));
    const artifact=workerArtifact(workerOptions,workers);
    const initialRelease=loadRuntime(stateDir)?.activeRelease??null;
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
      result=await runRuntime({stateDir,planning,workers,slots:request.slots??1,governance,effectAdapter:destination,fault,maxDispatches:request.maxDispatches??1000,onEvent});
    }
    const convergence=result.convergence??(initialRelease!==result.state.activeRelease?'accepted_change':'no_change');
    const output={schema:'ophanim.synthetic-run/v1',synthetic:true,operation:request.operation??'run',startedAt,endedAt:Date.now(),durationMs:Date.now()-startedAt,slots:request.slots??1,convergence,blockers:result.blockers??result.held??[],complete:result.complete??null,accepted:result.accepted??[],held:result.held??[],dispatches:result.dispatches??0,activeRelease:result.state.activeRelease,outputs:outputProjection(result.state),effects:destination.list(),destinationInvocations:destination.invocations(),intervals,intervalSummary:intervalSummary(intervals),stateRevision:result.state.revision,limits:{modelCalls:0,servicesStarted:0,businessSystemsConnected:0,syntheticWorkerDelayMs:workerOptions.delayMs}};
    acceptedLatencies.sort((a,b)=>a-b);
    output.measurements={
      acceptedStageSamples:acceptedLatencies.length,
      p95StageAcceptanceMs:acceptedLatencies.length?Math.round(acceptedLatencies[Math.ceil(acceptedLatencies.length*0.95)-1]):null,
      workerContextBytes,
      verificationCalls,
    };
    writeJson(request.resultFile??path.join(stateDir,'result.json'),output);
    return output;
  } finally {clearInterval(heartbeat);}
}

function options(args) {
  const out={};
  for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||args[i+1]===undefined)throw Error('Flags require values');out[args[i].slice(2)]=args[i+1];}
  return out;
}
async function main() {
  const command=process.argv[2]??'help',opts=options(process.argv.slice(3));
  if(command==='worker') {
    if(!opts.request)throw Error('worker requires --request');
    const result=await executeRequest(JSON.parse(fs.readFileSync(opts.request,'utf8')));
    process.stdout.write(JSON.stringify({convergence:result.convergence,blockers:result.blockers,complete:result.complete,accepted:result.accepted.length,held:result.held.length,dispatches:result.dispatches})+'\n');return;
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
    process.stdout.write(JSON.stringify({convergence:result.convergence,blockers:result.blockers,complete:result.complete,accepted:result.accepted.length,held:result.held.length,dispatches:result.dispatches,activeRelease:result.activeRelease})+'\n');return;
  }
  if(command==='demo') {
    if(!opts.state)throw Error('demo requires --state /absolute/new-state');
    const result=await executeRequest({stateDir:path.resolve(opts.state),fixture:{count:Number(opts.cases??3)},slots:Number(opts.slots??1)});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');return;
  }
  if(command==='status') {
    if(!opts.state)throw Error('status requires --state');
    const state=loadRuntime(path.resolve(opts.state));
    process.stdout.write(JSON.stringify(state?{schema:state.schema,revision:state.revision,activeRelease:state.activeRelease,obligations:Object.fromEntries(Object.entries(state.obligations).map(([id,row])=>[id,{status:row.status,attempt:row.attempt,reason:row.reason}])),effects:state.effects}:null,null,2)+'\n');return;
  }
  if(command==='fixtures') {process.stdout.write(JSON.stringify(makeFixtures({count:Number(opts.cases??3)}),null,2)+'\n');return;}
  if(command!=='help')throw Error(`Unknown command: ${command}`);
  process.stdout.write('Ophanim synthetic local qualification\n  node ophanim/cli.mjs prove --output /absolute/new-proof\n  node ophanim/cli.mjs resume --state /absolute/state\n  node ophanim/cli.mjs verify --output /absolute/proof\n  node ophanim/cli.mjs demo --state /absolute/new-state --cases 3 --slots 3\n  node ophanim/cli.mjs status --state /absolute/state\n  node ophanim/cli.mjs fixtures --cases 3\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
