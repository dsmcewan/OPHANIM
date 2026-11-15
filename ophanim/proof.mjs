import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeFixtures,createPlanning,createSyntheticDestination,canonical,digest,writeJson,outputProjection} from './fixtures.mjs';
import {loadRuntime} from './runtime.mjs';
import {openStore} from '../pantheon/src/board/cas.mjs';
import {verifyEfficiencyRecord} from './efficiency/assessment.mjs';

const WATCHDOG=fileURLToPath(new URL('./watchdog.mjs',import.meta.url));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const acceptedExpected=fixtures=>Object.fromEntries(fixtures.flatMap(f=>f.obligations).map(row=>[row.id,row.expected]));
const effectProjection=effects=>effects.map(({key,payload})=>({key,payload})).sort((a,b)=>a.key.localeCompare(b.key));

export function assertAcceptedBinding(row,proof) {
  assert.equal(proof.obligationId,row.spec.id,'Signed obligation identity differs');
  assert.equal(proof.obligationSha,digest(row.spec),'Signed obligation bytes differ');
  assert.equal(proof.candidateSha,row.accepted.sha256,'Signed accepted candidate differs');
  assert.equal(row.candidate.candidate.sha256,row.accepted.sha256,'Retained candidate hash differs from acceptance');
  assert.equal(digest(row.candidate.candidate.output),row.accepted.sha256,'Retained candidate bytes differ from acceptance');
  assert.equal(canonical(row.candidate.candidate.output),canonical(row.accepted.output),'Accepted output differs from retained candidate');
}

function child(args,timeoutMs=180000) {
  return new Promise((resolve,reject)=>{
    const processChild=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe','ipc']});
    let stdout='',stderr='';
    const timer=setTimeout(()=>{processChild.kill('SIGTERM');reject(Error('Qualification child exceeded bounded deadline'));},timeoutMs);
    processChild.stdout.setEncoding('utf8');processChild.stderr.setEncoding('utf8');
    processChild.stdout.on('data',s=>{stdout=(stdout+s).slice(-32768);});
    processChild.stderr.on('data',s=>{stderr=(stderr+s).slice(-32768);});
    processChild.on('error',error=>{clearTimeout(timer);reject(error);});
    processChild.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
  });
}

export async function runQualification({outputDir,onProgress=()=>{}}={}) {
  outputDir=outputDir?path.resolve(outputDir):fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-proof-'));
  fs.mkdirSync(outputDir,{recursive:true,mode:0o700});
  if(fs.readdirSync(outputDir).length)throw Error('Qualification requires a new empty output directory');
  const reportFile=path.join(outputDir,'proof.json');
  const report={schema:'ophanim.qualification/v2',synthetic:true,status:'running',convergence:null,blockers:[],startedAt:new Date().toISOString(),node:process.version,outputDir,reportFile,scenarios:[],checks:[],measurements:{},boundaries:{modelCalls:0,sourceDataRead:0,businessSystemsConnected:0,productionServicesChanged:0,publication:0,performance:'Synthetic worker delays and local TELOS verification; not department throughput or provider-cost evidence',release:'Fixture source/config manifests and worker registries; not production hot deployment'}};
  const save=()=>writeJson(reportFile,report);
  const check=(name,value,details={})=>{
    report.checks.push({name,passed:value===true,...details});save();assert.equal(value,true,name);
  };
  let serial=0;
  async function run(name,request,{allowFailure=false,stallMs=10000}={}) {
    onProgress({phase:name,status:'started'});
    const runDir=path.join(outputDir,'runs',`${String(++serial).padStart(2,'0')}-${name}`);
    fs.mkdirSync(runDir,{recursive:true});
    const requestFile=path.join(runDir,'worker-request.json'),resultFile=path.join(runDir,'worker-result.json'),watchdogFile=path.join(runDir,'watchdog.json');
    writeJson(requestFile,{...request,...process.env.OPHANIM_TELOS_ROOT?{telosRoot:process.env.OPHANIM_TELOS_ROOT}:{},resultFile});
    const guardRequest=path.join(runDir,'watchdog-request.json');
    writeJson(guardRequest,{requestFile,reportFile:watchdogFile,timeoutMs:120000,stallMs});
    const processResult=await child([WATCHDOG,'--request',guardRequest]);
    const watchdog=fs.existsSync(watchdogFile)?read(watchdogFile):null;
    const result=fs.existsSync(resultFile)?read(resultFile):null;
    if(result)assert.ok(result.efficiency?.reportFile,`Missing mandatory efficiency assessment for ${name}`);
    report.scenarios.push({name,stateDir:request.stateDir,requestFile,resultFile:result?resultFile:null,watchdogFile:watchdog?watchdogFile:null,process:processResult,durationMs:watchdog?.durationMs??null});save();
    if(!watchdog)throw Error(`Watchdog did not retain report for ${name}: ${processResult.stderr}`);
    if(!allowFailure&&processResult.code!==0)throw Error(`${name} refused: ${watchdog.stderr||processResult.stderr}`);
    onProgress({phase:name,status:processResult.code===0?'finished':'interrupted',durationMs:watchdog.durationMs});
    return {result,watchdog,process:processResult};
  }
  function verifyComplete(name,result,fixtureOptions,stateDir) {
    const fixtures=fixtureOptions.map(makeFixtures),expected=acceptedExpected(fixtures),state=loadRuntime(stateDir);
    check(`${name}: all expected outputs accepted`,result.complete===true&&canonical(result.outputs)===canonical(expected),{outputSha:digest(result.outputs),expectedSha:digest(expected)});
    const effects=effectProjection(fixtures.flatMap(f=>f.expectedEffects));
    check(`${name}: exact destination effects`,canonical(effectProjection(result.effects))===canonical(effects));
    check(`${name}: destination writes are unique`,result.destinationInvocations.length===effects.length&&result.effects.every(effect=>effect.writeCount===1));
    check(`${name}: dependencies bind accepted hashes`,Object.values(state.obligations).every(row=>row.spec.dependsOn.every(id=>row.candidate.evidence.dependencyVersions.some(dep=>dep.id===id&&dep.sha256===state.obligations[id].accepted.sha256))));
    check(`${name}: planning worker admitted bounded DAG`,Object.values(state.plans??{}).length>0&&state.events.some(event=>event.type==='plan.admitted'&&event.planner==='synthetic-intake-planner'));
    return state;
  }
  try {
    const unitDir=path.join(outputDir,'unit'),unitFixture={count:1,namespace:'unit'};
    const unit=await run('unit',{stateDir:unitDir,fixture:unitFixture,slots:1});
    verifyComplete('unit',unit.result,[unitFixture],unitDir);
    const correctionDir=path.join(outputDir,'correction'),correctionFixture={count:2,namespace:'correct'};
    const correction=await run('bounded-correction',{stateDir:correctionDir,fixture:correctionFixture,slots:3,workerOptions:{correctionCase:'correct-case-001'}});
    const correctedState=verifyComplete('bounded-correction',correction.result,[correctionFixture],correctionDir);
    const corrected=correctedState.obligations['correct-case-001:route'];
    check('incorrect generated owner rejected before bounded repair',corrected.attempt===2&&corrected.history.filter(row=>row.status==='gate-rejected').length===1&&corrected.history.at(-1).status==='accepted');

    const refusalDir=path.join(outputDir,'refusal'),refusalFixture={count:2,namespace:'refuse'};
    const refusal=await run('bounded-refusal',{stateDir:refusalDir,fixture:refusalFixture,slots:3,workerOptions:{permanentCase:'refuse-case-001'}});
    const refusedState=loadRuntime(refusalDir),refused=refusedState.obligations['refuse-case-001:route'];
    check('unrepairable obligation stops at two attempts',refused.status==='held'&&refused.attempt===2&&refused.history.filter(row=>row.status==='gate-rejected').length===2);
    check('blocked convergence names unresolved obligations',refusal.result.convergence==='blocked'&&refusal.result.blockers.some(row=>row.id==='refuse-case-001:route'));
    check('failed producer holds only dependent work',refusedState.obligations['refuse-case-001:draft'].status!=='accepted'&&refusedState.obligations['refuse-case-002:draft'].status==='accepted'&&refusal.result.effects.length===1&&refusal.result.effects[0].payload.caseId==='refuse-case-002');

    report.measurements.restart=[];
    for(const slots of [1,3])for(const event of ['after-work-persisted','after-effect-intent','after-effect-written']) {
      const name=event.replace('after-','')+(slots===1?'':'-3'),stateDir=path.join(outputDir,`restart-${name}`),fixture={count:1,namespace:'restart'};
      const interrupted=await run(`crash-${name}`,{stateDir,fixture,slots,fault:{event,mode:'crash'}},{allowFailure:true});
      check(`${name}: actual runtime process killed`,interrupted.watchdog.signal==='SIGKILL'&&interrupted.result===null);
      const prior=loadRuntime(stateDir),destination=createSyntheticDestination(path.join(stateDir,'destination')),beforeCalls=destination.invocations().length;
      check(`${name}: durable intermediate state retained`,Object.values(prior.obligations).some(row=>['gating','effect_pending'].includes(row.status)));
      if(event==='after-effect-written')check('destination effect exists before lost acknowledgement recovery',destination.list().length===1&&beforeCalls===1&&Object.values(prior.effects).some(effect=>effect.status==='intent'));
      const recovered=await run(`resume-${name}`,{stateDir,fixture,slots});
      report.measurements.restart.push({slots,fault:event,resumeToVerifiedCompletionMs:recovered.result.durationMs});
      verifyComplete(`resume-${name}`,recovered.result,[fixture],stateDir);
      check(`${name}: accepted attempts not reexecuted`,Object.values(loadRuntime(stateDir).obligations).every(row=>row.attempt===1));
      if(event==='after-effect-written')check('restart reconciles written effect without reapplying',recovered.result.destinationInvocations.length===beforeCalls);
    }

    const stallDir=path.join(outputDir,'watchdog-restart'),stallFixture={count:1,namespace:'watchdog'};
    const stalled=await run('watchdog-stall',{stateDir:stallDir,fixture:stallFixture,slots:1,fault:{event:'after-work-persisted',mode:'stall'}},{allowFailure:true,stallMs:1200});
    check('separate watchdog terminates a stalled runtime',stalled.watchdog.reason==='heartbeat-stalled'&&['SIGTERM','SIGKILL'].includes(stalled.watchdog.signal)&&stalled.watchdog.heartbeats>0);
    const unstalled=await run('watchdog-resume',{stateDir:stallDir,fixture:stallFixture,slots:1});
    verifyComplete('watchdog-resume',unstalled.result,[stallFixture],stallDir);

    for(const slots of [1,3]) {
      const suffix=slots===1?'':'-3';
      const releaseRun=(name,request,options)=>run(name+suffix,{...request,slots},options);
      const releaseDir=path.join(outputDir,'release'+suffix),releaseFixture={count:1,namespace:'release',routingAliasCase:'release-case-001'};
      const v1={version:'synthetic-v1',routingAliases:{}},v2={version:'synthetic-v2',routingAliases:{'office-support':'facilities'}};
      const first=await releaseRun('release-v1-activate',{operation:'activate',stateDir:releaseDir,fixture:releaseFixture,workerOptions:v1,releaseId:'release-v1'});
      check('first release has TELOS-bound activation',first.result.activeRelease==='release-v1');
      const broken=await releaseRun('release-v1-hold',{stateDir:releaseDir,fixture:releaseFixture,workerOptions:v1});
      check('old release retains failed case',broken.result.complete===false&&loadRuntime(releaseDir).obligations['release-case-001:route'].status==='held');
      const observedFailure=loadRuntime(releaseDir).obligations['release-case-001:route'];
      const repairProposal={schema:'ophanim.synthetic-repair-proposal/v1',id:'repair-office-support-alias',fromRelease:'release-v1',toRelease:'release-v2',obligationId:observedFailure.spec.id,historySha:digest(observedFailure.history),change:{routingAliases:{'office-support':'facilities'}},limit:{proposals:1,approvedRecipe:'office-support-alias/v1'},authority:'pre-authorized synthetic recipe; no model inference or self-granted authority'};
      writeJson(path.join(releaseDir,'repair-proposal.json'),repairProposal);
      check('bounded repair proposal derives from retained failure',observedFailure.attempt===2&&observedFailure.history.every(row=>row.status==='worker-failed')&&observedFailure.history.some(row=>row.reason.includes('Service has no confirmed owner')));
      const transition=await releaseRun('release-v2-interrupted',{operation:'activate',stateDir:releaseDir,fixture:releaseFixture,workerOptions:v2,releaseId:'release-v2',fault:{event:'after-release-intent',mode:'crash'}},{allowFailure:true});
      check('signed release intent survives actual interruption',transition.watchdog.signal==='SIGKILL'&&loadRuntime(releaseDir).pendingRelease?.release.id==='release-v2');
      const repaired=await releaseRun('release-v2-resume',{stateDir:releaseDir,fixture:releaseFixture,workerOptions:v2});
      const repairedState=verifyComplete('release-v2-resume',repaired.result,[releaseFixture],releaseDir);
      check('new release repairs held work and preserves history',repairedState.activeRelease==='release-v2'&&repairedState.obligations['release-case-001:route'].attempt===3&&repairedState.obligations['release-case-001:route'].history.filter(row=>row.status==='worker-failed').length===2);
      const beforeRollback=canonical(outputProjection(repairedState)),effectCalls=repaired.result.destinationInvocations.length;
      const unrelatedFixture={count:1,namespace:'unrelated'};
      const watchdogRollback=await releaseRun('release-v2-watchdog',{stateDir:releaseDir,batches:[releaseFixture,unrelatedFixture],workerOptions:v2,fault:{event:'after-work-persisted',id:'unrelated-case-001:normalize',mode:'stall'}},{allowFailure:true,stallMs:1200});
      check('watchdog failure supplies rollback trigger',watchdogRollback.watchdog.reason==='heartbeat-stalled'&&loadRuntime(releaseDir).activeRelease==='release-v2');
      const rolled=await releaseRun('signed-rollback',{operation:'rollback',stateDir:releaseDir,fixture:releaseFixture,workerOptions:v1,toRelease:'release-v1'});
      check('rollback retains accepted outputs and effects',rolled.result.activeRelease==='release-v1'&&canonical(rolled.result.outputs)===beforeRollback&&rolled.result.destinationInvocations.length===effectCalls);

      const continued=await releaseRun('rollback-unrelated-continues',{stateDir:releaseDir,batches:[releaseFixture,unrelatedFixture],workerOptions:v1,slots});
      verifyComplete('rollback-unrelated-continues',continued.result,[releaseFixture,unrelatedFixture],releaseDir);
      check('rollback completes unrelated work without repeating original effect',continued.result.destinationInvocations.filter(event=>event.key==='release:draft:release-case-001').length===1&&continued.result.outputs['unrelated-case-001:draft']?.status==='draft');
      check('successful repair emits accepted_change convergence',repaired.result.convergence==='accepted_change'&&repaired.result.blockers.length===0);
      const settled=await releaseRun('quiescent-replay',{stateDir:releaseDir,batches:[releaseFixture,unrelatedFixture],workerOptions:v1,slots});
      check('quiescent repeat explicitly reports no_change',settled.result.convergence==='no_change'&&settled.result.dispatches===0&&settled.result.blockers.length===0&&settled.result.destinationInvocations.length===continued.result.destinationInvocations.length);
    }

    const compositionDir=path.join(outputDir,'composition'),compositionFixture={count:3,namespace:'compose'};
    const composition=await run('composition',{stateDir:compositionDir,fixture:compositionFixture,slots:3});
    verifyComplete('composition',composition.result,[compositionFixture],compositionDir);
    check('separate watchdog process owns runtime child',composition.watchdog.watchdogPid!==composition.watchdog.workerPid&&composition.watchdog.watchdogPid!==process.pid&&composition.watchdog.heartbeats>0);

    const scaleFixture={count:3,namespace:'scale'},scaleRuns=[];
    for(const slots of [1,3]) {
      const stateDir=path.join(outputDir,`scale-${slots}`),observed=await run(`scale-${slots}`,{stateDir,fixture:scaleFixture,slots,workerOptions:{delayMs:35}});
      verifyComplete(`scale-${slots}`,observed.result,[scaleFixture],stateDir);scaleRuns.push(observed.result);
    }
    check('one and three slots produce identical accepted outputs',canonical(scaleRuns[0].outputs)===canonical(scaleRuns[1].outputs));
    check('one and three slots produce identical destination payloads',canonical(effectProjection(scaleRuns[0].effects))===canonical(effectProjection(scaleRuns[1].effects)));
    check('actual worker overlap respects slot caps',scaleRuns[0].intervalSummary.maxActive===1&&scaleRuns[1].intervalSummary.maxActive>=2&&scaleRuns[1].intervalSummary.maxActive<=3);
    report.measurements.scale=scaleRuns.map(result=>({
      slots:result.slots,durationMs:result.durationMs,accepted:result.accepted.length,
      confirmedDraftsPerSecond:Number((result.effects.length*1000/Math.max(result.durationMs,1)).toFixed(3)),
      outputSha:digest(result.outputs),...result.intervalSummary,...result.measurements,simulatedWorkerDelayMs:35,
    }));save();

    const replicaDir=path.join(outputDir,'replication'),replicas=[{count:1,namespace:'east',department:'operations'},{count:1,namespace:'west',department:'facilities'}];
    const replica=await run('replication',{stateDir:replicaDir,batches:replicas,slots:3});
    verifyComplete('replication',replica.result,replicas,replicaDir);
    check('replicas keep department records separate',replica.result.effects.length===2&&new Set(replica.result.effects.map(effect=>effect.payload.department)).size===2&&new Set(replica.result.effects.map(effect=>effect.key)).size===2);

    const files=report.scenarios.flatMap(s=>{
      const result=s.resultFile?read(s.resultFile):null;
      const assessments=result?[result.efficiency,result.recoveredEfficiency].filter(Boolean):[];
      return [s.requestFile,s.resultFile,s.watchdogFile,...assessments.flatMap(record=>[record.reportFile,path.join(path.dirname(record.reportFile),'trace.json')])];
    });
    report.evidenceFiles=Object.fromEntries(files.filter(Boolean).sort().map(file=>[path.relative(outputDir,file),digest(fs.readFileSync(file,'utf8'))]));
    report.finalStates=Object.fromEntries([...new Set(report.scenarios.map(s=>s.stateDir))].sort().map(stateDir=>[path.relative(outputDir,stateDir),{stateSha:digest(loadRuntime(stateDir)),outputSha:digest(outputProjection(loadRuntime(stateDir)))}]));

    report.status='passed';report.convergence='accepted_change';report.blockers=[];report.finishedAt=new Date().toISOString();report.durationMs=Date.parse(report.finishedAt)-Date.parse(report.startedAt);save();
    onProgress({phase:'qualification',status:'passed',checks:report.checks.length,reportFile});return report;
  } catch(error) {
    report.status='failed';report.convergence='blocked';report.blockers=[{reason:error.message}];report.finishedAt=new Date().toISOString();report.failure={message:error.message,stack:error.stack};save();
    onProgress({phase:'qualification',status:'failed',reportFile,error:error.message});throw error;
  }
}

// This verifier reopens retained bytes and calls TELOS's actual verifier. It
// dispatches no runtime work and accepts no candidates. Fixed deterministic
// semantic checks replay transformations; passed flags are never sufficient.
export async function verifyProof({outputDir,telosRoot=process.env.OPHANIM_TELOS_ROOT}={}) {
  outputDir=path.resolve(outputDir??'');
  const report=read(path.join(outputDir,'proof.json'));
  assert.ok(['ophanim.qualification/v1','ophanim.qualification/v2'].includes(report.schema));assert.equal(report.status,'passed');assert.equal(report.convergence,'accepted_change');
  assert.ok(Array.isArray(report.scenarios)&&report.scenarios.length>=20);
  const inside=relative=>{
    const file=path.resolve(outputDir,relative);
    if(!file.startsWith(outputDir+path.sep)||fs.realpathSync(file)!==file)throw Error('Evidence path escapes qualification root');
    return file;
  };
  let files=0;
  for(const [relative,expected] of Object.entries(report.evidenceFiles??{})){
    assert.equal(digest(fs.readFileSync(inside(relative),'utf8')),expected,`Evidence bytes changed: ${relative}`);files++;
  }
  let efficiencyAssessments=0;
  const {createGovernance}=await import('./governance.mjs');
  for(const scenario of report.scenarios){
    for(const field of ['requestFile','resultFile','watchdogFile'])if(scenario[field]){
      const relative=path.relative(outputDir,scenario[field]);inside(relative);assert.ok(Object.hasOwn(report.evidenceFiles,relative),'Scenario must reference manifested evidence');
    }
    if(scenario.resultFile&&report.schema==='ophanim.qualification/v2'){
      const output=read(scenario.resultFile);
      assert.ok(output.efficiency?.reportFile,'A completed run requires an efficiency assessment');
      for(const record of [output.efficiency,output.recoveredEfficiency].filter(Boolean)){
        for(const file of [record.reportFile,path.join(path.dirname(record.reportFile),'trace.json')]){
          const relative=path.relative(outputDir,file);inside(relative);
          assert.ok(Object.hasOwn(report.evidenceFiles,relative),'Efficiency assessment must reference manifested evidence');
        }
        const assessment=verifyEfficiencyRecord({stateDir:scenario.stateDir,record,...record===output.efficiency?{output}:{}});
        if(assessment.outcome==='promoted'){
          const authority=await createGovernance({root:scenario.stateDir,fixtureOnly:true,readOnly:true,...telosRoot?{telosRoot}:{}});
          const decision=await authority.verifyEfficiencyDecision({...assessment.authorization,replayEvidence:true});
          assert.equal(decision.ok,true,`Efficiency policy authorization refused: ${decision.reason}`);
        }
        efficiencyAssessments++;
      }
    }
  }
  assert.ok(files>40,'Nonempty detailed evidence manifest required');
  let states=0,accepted=0,decisions=0,effects=0;
  for(const [relative,summary] of Object.entries(report.finalStates??{})) {
    const stateDir=inside(relative),state=loadRuntime(stateDir);
    assert.equal(digest(state),summary.stateSha,`Runtime state changed: ${relative}`);
    assert.equal(digest(outputProjection(state)),summary.outputSha);
    const governance=await createGovernance({root:stateDir,fixtureOnly:true,readOnly:true,...telosRoot?{telosRoot}:{}});
    const destinationRoot=path.join(stateDir,'destination');
    assert.ok(fs.statSync(destinationRoot).isDirectory());
    const destination={inspect:key=>read(path.join(destinationRoot,`${digest(key)}.json`)),invocations:()=>{const file=path.join(destinationRoot,'apply-events.jsonl');return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];}};
    const store=openStore(path.join(stateDir,'pantheon'),{readOnly:true});
    const rows=Object.values(state.obligations);
    for(const row of rows.filter(value=>value.status==='accepted')) {
      const proof=await governance.verifyPlan({planRef:row.accepted.planRef});
      assert.equal(proof.ok,true,`TELOS rejected ${row.spec.id}: ${proof.reason}`);
      assertAcceptedBinding(row,proof);
      const published=row.candidate.published,commit=store.get(published.commit),entry=store.get(published.entry);
      assert.ok(commit.records.includes(published.entry));assert.equal(entry.links.log,published.blob);
      assert.equal(store.get(published.blob).toString('utf8'),canonical({candidate:row.candidate.candidate,worker:row.candidate.worker,evidence:row.candidate.evidence,effects:row.candidate.effects}));
      assert.equal(digest(row.accepted.output),row.accepted.sha256);
      assert.equal(canonical(row.accepted.output),canonical(row.spec.expected));
      for(const dep of row.spec.dependsOn)assert.ok(row.candidate.evidence.dependencyVersions.some(value=>value.id===dep&&value.sha256===state.obligations[dep]?.accepted?.sha256));
      if(row.spec.effectKey) {
        const observed=await destination.inspect(row.spec.effectKey);
        assert.equal(observed?.writeCount,1);assert.equal(canonical(observed.payload),canonical(row.accepted.output));
        assert.equal(destination.invocations().filter(value=>value.key===row.spec.effectKey).length,1);
        assert.equal(state.effects[row.spec.effectKey]?.status,'confirmed');effects++;
      }
      accepted++;
    }
    for(const transition of state.releaseHistory) {
      const release=state.releases[transition.toRelease];
      const verified=await governance.verifyActivationDecision({decision:transition.decision,expected:{kind:transition.kind,fromRelease:transition.fromRelease,toRelease:transition.toRelease,artifactSha:release.artifactSha,stateSchema:release.stateSchema,planRef:release.planRef,workers:release.workers}});
      assert.equal(verified.ok,true,`Release decision refused: ${verified.reason}`);decisions++;
    }
    assert.ok(Object.keys(state.plans??{}).length>0);states++;
  }
  assert.ok(states>=10&&accepted>0&&decisions>=3&&effects>0);
  const one=read(report.scenarios.find(s=>s.name==='scale-1').resultFile),three=read(report.scenarios.find(s=>s.name==='scale-3').resultFile);
  assert.equal(canonical(one.outputs),canonical(three.outputs));assert.equal(canonical(effectProjection(one.effects)),canonical(effectProjection(three.effects)));
  assert.equal(one.intervalSummary.maxActive,1);assert.ok(three.intervalSummary.maxActive>=2&&three.intervalSummary.maxActive<=3);
  for(const scenario of report.scenarios.filter(s=>s.name.startsWith('crash-')))assert.equal(read(scenario.watchdogFile).signal,'SIGKILL');
  for(const name of ['watchdog-stall','release-v2-watchdog','release-v2-watchdog-3'])assert.equal(read(report.scenarios.find(s=>s.name===name).watchdogFile).reason,'heartbeat-stalled');
  for(const name of ['quiescent-replay','quiescent-replay-3']) {
    const quiescent=read(report.scenarios.find(s=>s.name===name).resultFile);
    assert.equal(quiescent.convergence,'no_change');assert.equal(quiescent.dispatches,0);assert.equal(quiescent.blockers.length,0);
  }
  return {schema:'ophanim.independent-verification/v1',ok:true,synthetic:true,files,states,accepted,effects,decisions,efficiencyAssessments,modelCalls:0,runtimeDispatches:0,deterministicSemanticChecks:'replayed, including fixed synthetic worker transformations',readOnly:true,limits:'Revalidates retained local fixture authority and TELOS evidence; does not establish production authorization, shared-drive integration or a live productivity gain.'};
}
