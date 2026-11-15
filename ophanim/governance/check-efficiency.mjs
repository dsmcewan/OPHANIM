// Retained, controlled synthetic replay verifier. No candidate-supplied command
// or success flag grants scheduler authority. Timing is local fixture evidence,
// not remote attestation, provider economics, or a realized future saving.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {canonical, hash, rawHash} from './check-contract.mjs';
import {FIXTURE_SOURCE_SHA} from './check-release.mjs';

const fail = message => {throw Error(message);};
const requireThat = (condition,message) => {if(!condition)fail(message);};
const hex = value => typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const same = (a,b) => canonicalLarge(a)===canonicalLarge(b);
const finite = value => Number.isFinite(value)&&value>=0;
function canonicalLarge(value) {
  const walk=(v,depth=0)=>{
    if(depth>60)fail('Efficiency JSON nesting bound');
    if(v===null||['string','boolean'].includes(typeof v))return v;
    if(typeof v==='number'&&Number.isFinite(v)&&!Object.is(v,-0))return v;
    if(Array.isArray(v))return v.map(x=>walk(x,depth+1));
    if(v&&Object.getPrototypeOf(v)===Object.prototype)return Object.fromEntries(Object.keys(v).sort().map(k=>{
      if(['__proto__','constructor','prototype'].includes(k))fail('Unsafe efficiency JSON key');
      return [k,walk(v[k],depth+1)];
    }));
    fail('Plain finite efficiency JSON required');
  };
  const text=JSON.stringify(walk(value));
  requireThat(Buffer.byteLength(text)<=8*1024*1024,'Efficiency JSON byte bound');
  return text;
}
const digest = value => rawHash(canonicalLarge(value));
const metadata = workers => workers.map(({id,version,kinds,scopes})=>({id,version,kinds,scopes})).sort((a,b)=>a.id.localeCompare(b.id));
const effectProjection = effects => effects.map(({key,payload})=>({key,payload})).sort((a,b)=>a.key.localeCompare(b.key));
const VERIFIER_FILES=['../governance.mjs',...['check-artifact.mjs','check-contract.mjs','check-release.mjs','check-efficiency.mjs','check-efficiency-artifact.mjs'].map(file=>'../governance/'+file)];
const sourceDigest=relative=>digest(fs.readFileSync(new URL(relative,import.meta.url),'utf8'));

export function verifyEfficiencySources(descriptor) {
  requireThat(descriptor?.schema==='ophanim.efficiency/v1'&&descriptor.stateSchema==='ophanim.runtime/v1'&&descriptor.maxQualifiedConvergences===20&&descriptor.replayBudgetMs===30000&&descriptor.runtimeSha===sourceDigest('../runtime.mjs')&&same(descriptor.verifierSources,Object.fromEntries(VERIFIER_FILES.map(file=>[file,sourceDigest(file)]))),'Scheduler authority source policy changed');
  const source=fileURLToPath(new URL('../fixtures.mjs',import.meta.url));
  requireThat(fs.realpathSync(source)===source&&rawHash(fs.readFileSync(source))===FIXTURE_SOURCE_SHA,'Pinned synthetic fixture source differs');
  return true;
}

export function validateEfficiencyPolicy(policy) {
  requireThat(same(Object.keys(policy??{}).sort(),['baselineRelease','baselineSlots','evidenceSha','maxQualifiedConvergences','originalResultSha','policySha','schema','scopeSha','slots','stateSchema','workerArtifactSha']),'Closed scheduler policy required');
  requireThat(policy.schema==='ophanim.scheduler-policy/v1'&&policy.baselineRelease==='baseline'&&policy.baselineSlots===1&&policy.slots===3&&policy.maxQualifiedConvergences===20&&policy.stateSchema==='ophanim.runtime/v1','Only baseline scheduler slots 1 to 3 are eligible');
  for(const key of ['scopeSha','workerArtifactSha','policySha','evidenceSha','originalResultSha'])requireThat(hex(policy[key]),'Exact scheduler policy digest required: '+key);
  return policy;
}

export function validateEfficiencyRequest(request) {
  canonical(request);
  const {candidate,obligation,worker,evidence}=request;
  validateEfficiencyPolicy(candidate?.output);
  const id='efficiency:'+hash(candidate.output);
  requireThat(candidate.id===id+':1'&&candidate.sha256===hash(candidate.output)&&same(obligation.expected,candidate.output),'Exact scheduler candidate identity required');
  requireThat(obligation.id===id&&obligation.kind==='synthetic-efficiency'&&obligation.scope==='fixture-scheduler'&&obligation.outputKey===id&&obligation.maxAttempts===1&&same(obligation.dependsOn,[])&&same(Object.keys(obligation.inputs).sort(),['evidenceRoot','governanceContractSha','telosRoot'])&&hex(obligation.inputs.governanceContractSha)&&path.isAbsolute(obligation.inputs.evidenceRoot)&&path.isAbsolute(obligation.inputs.telosRoot),'Fixed scheduler verification obligation required');
  requireThat(same(worker,{id:'fixture-scheduler-proposer',version:'1',kinds:['synthetic-efficiency'],scopes:['fixture-scheduler']})&&same(evidence,{attempt:1,dependencyVersions:[],stateSchema:'ophanim.runtime/v1'}),'Fixed scheduler proposer and evidence required');
  return {ok:true,fixtureOnly:true};
}

export function assessEfficiency({baselineMs,candidateMs,baselineP95Ms,candidateP95Ms,baselineRecoveryMs,candidateRecoveryMs,trialCostMs}) {
  requireThat([baselineMs,candidateMs,baselineP95Ms,candidateP95Ms].every(values=>Array.isArray(values)&&values.length===3&&values.every(finite))&&[baselineRecoveryMs,candidateRecoveryMs,trialCostMs].every(finite),'Complete finite controlled measurements required');
  const baselineConservativeMs=Math.min(...baselineMs),candidateConservativeMs=Math.max(...candidateMs);
  const conservativeSavedMs=baselineConservativeMs-candidateConservativeMs,forecastGrossSavedMs=20*conservativeSavedMs;
  const blockers=[];
  if(conservativeSavedMs<100||candidateConservativeMs>baselineConservativeMs*0.9)blockers.push('Material improvement not established across all three controlled pairs');
  if(Math.max(...candidateP95Ms)>Math.min(...baselineP95Ms)*1.25+25)blockers.push('Stage p95 latency materially regressed');
  if(candidateRecoveryMs>baselineRecoveryMs*1.25+100)blockers.push('Recovery latency materially regressed');
  if(forecastGrossSavedMs<=trialCostMs)blockers.push('Measured trial cost exceeds conservative twenty-convergence forecast saving');
  return {eligible:blockers.length===0,convergence:blockers.length?'no_change':'accepted_change',blockers,benefitKind:'local-wall-clock-only',forecastConvergences:20,baselineConservativeMs,candidateConservativeMs,conservativeSavedMs,trialCostMs,forecastGrossSavedMs,forecastNetSavedMs:forecastGrossSavedMs-trialCostMs,realizedNetSavedMs:-trialCostMs,modelCalls:0,forecast:true};
}

export async function evaluateEfficiency({policy,evidenceRoot,telosRoot,governanceContractSha}) {
  validateEfficiencyPolicy(policy);
  requireThat(path.isAbsolute(evidenceRoot??'')&&fs.realpathSync(evidenceRoot)===evidenceRoot,'Canonical absolute replay root required');
  const root=evidenceRoot;
  function inside(relative) {
    requireThat(typeof relative==='string'&&!path.isAbsolute(relative)&&relative.split('/').every(x=>x&&!['.','..'].includes(x))&&!relative.includes('\\'),'Safe relative replay evidence path required');
    const file=path.join(root,relative);
    requireThat(fs.realpathSync(file)===file&&file.startsWith(root+path.sep),'Replay evidence symlink or escape refused');
    return file;
  }
  function raw(relative,max=8*1024*1024) {
    const file=inside(relative),stat=fs.lstatSync(file);
    requireThat(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=max,'Bounded regular replay evidence required');
    return fs.readFileSync(file);
  }
  const manifestBytes=raw('manifest.json');
  requireThat(rawHash(manifestBytes)===policy.evidenceSha,'Replay manifest digest differs');
  const manifest=JSON.parse(manifestBytes);
  requireThat(manifest.schema==='ophanim.scheduler-replay/v1'&&manifest.fixtureOnly===true&&manifest.status==='completed','Completed synthetic replay evidence required');
  const entries=Object.entries(manifest.files??{});
  requireThat(entries.length>20&&entries.length<=30000,'Bounded nonempty replay file manifest required');
  let totalBytes=0;
  for(const [relative,sha]of entries){const bytes=raw(relative);totalBytes+=bytes.length;requireThat(totalBytes<=512*1024*1024&&hex(sha)&&rawHash(bytes)===sha,'Retained replay file changed: '+relative);}
  const read=relative=>{requireThat(Object.hasOwn(manifest.files,relative),'Unmanifested replay evidence: '+relative);return JSON.parse(raw(relative));};
  const source=fileURLToPath(new URL('../fixtures.mjs',import.meta.url));
  requireThat(fs.realpathSync(source)===source&&rawHash(fs.readFileSync(source))===FIXTURE_SOURCE_SHA,'Pinned synthetic fixture source differs');
  const {makeFixtures,createWorkers,createPlanning}=await import(new URL('../fixtures.mjs',import.meta.url).href);
  const request=manifest.request;
  requireThat(request&&same(Object.keys(request).sort(),['batches','maxDispatches','workerOptions'])&&Array.isArray(request.batches)&&request.batches.length>=1&&request.batches.length<=4&&Number.isInteger(request.maxDispatches)&&request.maxDispatches>0&&request.maxDispatches<=1000,'Closed controlled replay request required');
  const fixtures=request.batches.map(makeFixtures),specs=fixtures.flatMap(f=>f.obligations);
  requireThat(specs.length>=6&&specs.length<=120&&new Set(specs.map(s=>s.id)).size===specs.length,'Bounded parallel synthetic workload required');
  requireThat(Object.keys(request.workerOptions).every(k=>['department','departments','version','delayMs','routingAliases'].includes(k))&&request.workerOptions.version==='synthetic-v1'&&same(request.workerOptions.routingAliases??{},{}),'Replay cannot change worker behavior or inject faults');
  const workers=metadata(createWorkers(request.workerOptions)),artifact={schema:'ophanim.synthetic-worker-artifact/v1',sourceSha:FIXTURE_SOURCE_SHA,options:request.workerOptions,workers};
  const authorityPolicy={schema:'ophanim.efficiency/v1',stateSchema:'ophanim.runtime/v1',planningPolicySha:digest(createPlanning({batches:request.batches}).policy),runtimeSha:sourceDigest('../runtime.mjs'),verifierSources:Object.fromEntries(VERIFIER_FILES.map(file=>[file,sourceDigest(file)])),maxQualifiedConvergences:20,replayBudgetMs:30000};
  const expectedPolicySha=digest(authorityPolicy);
  const applicability={schema:'ophanim.efficiency.applicability/v1',obligations:specs.map(s=>({id:s.id,kind:s.kind,scope:s.scope,dependsOn:[...s.dependsOn].sort(),specSha:digest(s)})).sort((a,b)=>a.id.localeCompare(b.id)),workers:workers.map(w=>({...w,kinds:[...w.kinds].sort(),scopes:[...w.scopes].sort()})),workerArtifactSha:digest(artifact),policySha:expectedPolicySha,inputRevision:digest(request)};
  requireThat(hex(governanceContractSha)&&same(manifest.policy,authorityPolicy)&&policy.policySha===expectedPolicySha&&same(manifest.applicability,applicability)&&manifest.scopeSha===digest(applicability)&&policy.scopeSha===manifest.scopeSha&&manifest.requestSha===digest(request)&&manifest.workerArtifactSha===digest(artifact)&&policy.workerArtifactSha===digest(artifact),'Replay applicability, artifact or policy differs');
  const outputs=Object.fromEntries(specs.map(s=>[s.id,s.expected])),effects=effectProjection(fixtures.flatMap(f=>f.expectedEffects));
  const original=read(manifest.original?.resultFile);
  requireThat(manifest.original.resultSha===policy.originalResultSha&&rawHash(raw(manifest.original.resultFile))===policy.originalResultSha&&original.complete===true&&original.slots===1&&original.activeRelease==='baseline'&&same(original.outputs,outputs)&&same(effectProjection(original.effects),effects),'Original accepted baseline differs');
  requireThat(manifest.original.outputSha===digest(outputs)&&manifest.original.effectSha===digest(effects),'Original accepted baseline hashes differ');
  const settings=manifest.settings;
  requireThat(settings?.baselineSlots===1&&settings.candidateSlots===3&&settings.repeats===3&&settings.recoveryEvent==='after-effect-written'&&Number.isInteger(settings.budgetMs)&&settings.budgetMs>0&&settings.budgetMs<=30000&&Number.isInteger(settings.trialTimeoutMs)&&settings.trialTimeoutMs>=1000&&settings.trialTimeoutMs<=300000,'Controlled replay settings differ');
  requireThat(Array.isArray(manifest.trials)&&manifest.trials.length===8&&new Set(manifest.trials.map(t=>t.id)).size===8,'Three controlled pairs and two recovery trials required');
  const clean=manifest.trials.filter(t=>t.kind==='clean'),recovery=manifest.trials.filter(t=>t.kind==='recovery');
  requireThat(clean.length===6&&recovery.length===2&&[1,3].every(slots=>clean.filter(t=>t.slots===slots).length===3&&recovery.filter(t=>t.slots===slots).length===1),'Exact replay width coverage required');
  for(let pair=0;pair<3;pair++){const group=clean.filter(t=>t.pair===pair).sort((a,b)=>a.orderIndex-b.orderIndex);requireThat(group.length===2&&same(group.map(t=>t.slots),pair%2?[3,1]:[1,3]),'Controlled pairs must alternate execution order');}
  const {createGovernance}=await import(new URL('../governance.mjs',import.meta.url).href);
  // The original accepted run stays in its original absolute location because
  // existing TELOS plans bind that workspace. Recheck its CAS and signed nodes;
  // a copied verification report alone is not an authority credential.
  const originalRoot=manifest.original.stateRoot;
  requireThat(path.isAbsolute(originalRoot??'')&&fs.realpathSync(originalRoot)===originalRoot,'Original accepted state root required');
  const originalRaw=relative=>{
    const file=path.join(originalRoot,relative);
    requireThat(file.startsWith(originalRoot+path.sep)&&fs.realpathSync(file)===file&&fs.lstatSync(file).isFile()&&fs.statSync(file).size<=8*1024*1024,'Original evidence path differs');
    return fs.readFileSync(file);
  };
  const originalCAS=cid=>{
    requireThat(typeof cid==='string'&&/^(blob|entry|tree|commit):[a-f0-9]{64}$/.test(cid),'Original board identity differs');
    const [codec,sha]=cid.split(':'),bytes=originalRaw('pantheon/objects/'+codec+'/'+sha.slice(0,2)+'/'+sha.slice(2));
    const value=codec==='blob'?bytes:JSON.parse(bytes),encoded=codec==='blob'?bytes:Buffer.from(canonicalLarge(value));
    requireThat(crypto.createHash('sha256').update(codec+'\n').update(encoded).digest('hex')===sha,'Original board digest differs');
    return value;
  };
  const originalHead=originalRaw('pantheon/refs/board/ophanim').toString().trim();
  requireThat(originalHead===manifest.original.boardCommit,'Original accepted board head changed');
  const originalCommit=originalCAS(originalHead),originalTraces=originalCommit.records.map(originalCAS).filter(e=>e.kind==='trace'&&e.payload.test==='ophanim-state');
  requireThat(originalCommit.author.vendor==='controller'&&originalTraces.length===1&&originalTraces[0].author.vendor==='controller','Original controller state required');
  const originalState=JSON.parse(originalCAS(originalTraces[0].links.log));
  requireThat(digest(originalState)===manifest.original.stateSha&&originalState.activeRelease==='baseline'&&originalState.releaseHistory.length===0&&Object.keys(originalState.obligations).length===specs.length,'Original accepted state changed');
  const originalGovernance=await createGovernance({root:originalRoot,readOnly:true,fixtureOnly:true,...telosRoot?{telosRoot}:{}});
  const originalProofs=[];
  for(const spec of specs){
    const row=originalState.obligations[spec.id];
    requireThat(row?.status==='accepted'&&same(row.spec,spec)&&same(row.accepted?.output,spec.expected)&&same(row.candidate?.candidate?.output,spec.expected)&&row.accepted.sha256===digest(spec.expected)&&row.candidate.candidate.sha256===row.accepted.sha256,'Original accepted obligation differs');
    const proof=await originalGovernance.verifyPlan({planRef:row.accepted.planRef});
    requireThat(proof.ok&&proof.obligationId===spec.id&&proof.obligationSha===digest(spec)&&proof.candidateSha===row.accepted.sha256,'Original TELOS acceptance refused');
    originalProofs.push({id:spec.id,planRef:row.accepted.planRef,candidateSha:row.accepted.sha256,obligationSha:digest(spec)});
    if(spec.effectKey){const observed=JSON.parse(originalRaw('destination/'+rawHash(spec.effectKey)+'.json'));requireThat(observed.writeCount===1&&same(observed.payload,spec.expected)&&originalState.effects[spec.effectKey]?.status==='confirmed','Original effect differs');}
  }
  requireThat(same([...manifest.original.proofs].sort((a,b)=>a.id.localeCompare(b.id)),originalProofs.sort((a,b)=>a.id.localeCompare(b.id))),'Original accepted proof references differ');
  const originalInvocations=originalRaw('destination/apply-events.jsonl').toString().trim().split('\n').map(JSON.parse);
  requireThat(originalInvocations.length===effects.length&&effects.every(e=>originalInvocations.filter(v=>v.key===e.key&&v.payloadSha===digest(e.payload)).length===1),'Original effect invocation differs');
  let segmentWall=0,verifiedNodes=0;
  const observedP95=new Map();
  for(const trial of manifest.trials) {
    requireThat([1,3].includes(trial.slots)&&typeof trial.stateDir==='string'&&trial.governanceContractSha===governanceContractSha,'Replay trial configuration changed');
    const result=read(trial.resultFile),stateDir=inside(trial.stateDir);
    requireThat(result.complete===true&&result.convergence==='accepted_change'&&result.activeRelease==='baseline'&&result.slots===trial.slots&&result.held.length===0&&result.blockers.length===0&&result.limits.modelCalls===0&&result.limits.businessSystemsConnected===0&&result.limits.servicesStarted===0&&same(result.outputs,outputs)&&same(effectProjection(result.effects),effects),'Replay quality or containment failed');
    requireThat(trial.outputSha===digest(outputs)&&trial.effectSha===digest(effects)&&finite(result.durationMs)&&Math.abs(result.durationMs-(result.endedAt-result.startedAt))<=2&&trial.metrics.runDurationMs===result.durationMs&&trial.metrics.p95StageAcceptanceMs===result.measurements.p95StageAcceptanceMs,'Replay result measurements differ');
    const readCAS=cid=>{
      requireThat(typeof cid==='string'&&/^(blob|entry|tree|commit):[a-f0-9]{64}$/.test(cid),'Invalid retained board identity');
      const [codec,sha]=cid.split(':'),relative=trial.stateDir+'/pantheon/objects/'+codec+'/'+sha.slice(0,2)+'/'+sha.slice(2),bytes=raw(relative);
      requireThat(Object.hasOwn(manifest.files,relative),'Unmanifested retained board object');
      const value=codec==='blob'?bytes:JSON.parse(bytes),encoded=codec==='blob'?bytes:Buffer.from(canonicalLarge(value));
      requireThat(crypto.createHash('sha256').update(codec+'\n').update(encoded).digest('hex')===sha,'Retained board object digest differs');
      return value;
    };
    const ref=trial.stateDir+'/pantheon/refs/board/ophanim';requireThat(Object.hasOwn(manifest.files,ref),'Retained runtime ref is not manifested');
    const commit=readCAS(raw(ref).toString().trim()),traces=commit.records.map(readCAS).filter(x=>x.kind==='trace'&&x.payload.test==='ophanim-state');
    requireThat(commit.author.vendor==='controller'&&traces.length===1&&traces[0].author.vendor==='controller','Controller state trace required');
    const state=JSON.parse(readCAS(traces[0].links.log));
    requireThat(digest(state)===trial.stateSha&&state.schema==='ophanim.runtime/v1'&&state.activeRelease==='baseline'&&!state.pendingRelease&&state.releaseHistory.length===0&&same(state.releases.baseline.workers,workers)&&Object.keys(state.obligations).length===specs.length,'Replay runtime state differs');
    const starts=new Map(),latencies=[];let contextBytes=0;
    for(const event of state.events){
      if(event.atMs<result.startedAt||event.atMs>result.endedAt)continue;
      const key=JSON.stringify([event.id,event.attempt]);
      if(event.type==='work.started'){
        starts.set(key,event.atMs);
        const spec=state.obligations[event.id]?.spec;requireThat(spec,'Unknown replay worker context');
        const {expected,...brief}=spec;
        const dependencies=Object.fromEntries(spec.dependsOn.map(id=>[id,{output:state.obligations[id].accepted.output,sha256:state.obligations[id].accepted.sha256}]));
        contextBytes+=Buffer.byteLength(canonicalLarge({obligation:brief,inputs:{...spec.inputs,dependencies},priorAttempts:event.attempt-1}));
      }
      if(event.type==='work.accepted'&&starts.has(key)){latencies.push(event.atMs-starts.get(key));starts.delete(key);}
    }
    latencies.sort((a,b)=>a-b);
    requireThat(latencies.length===result.measurements.acceptedStageSamples&&latencies.length>0&&contextBytes===result.measurements.workerContextBytes,'Worker samples or context differ from retained controller events');
    observedP95.set(trial.id,latencies[Math.ceil(latencies.length*0.95)-1]);
    const gov=await createGovernance({root:stateDir,readOnly:true,fixtureOnly:true,...telosRoot?{telosRoot}:{}});
    for(const spec of specs) {
      const row=state.obligations[spec.id],accepted=row?.accepted,candidate=row?.candidate?.candidate;
      requireThat(row?.status==='accepted'&&same(row.spec,spec)&&same(accepted?.output,spec.expected)&&same(candidate?.output,spec.expected)&&candidate.sha256===digest(spec.expected)&&accepted.sha256===candidate.sha256,'Exact accepted obligation or candidate differs');
      const proof=await gov.verifyPlan({planRef:accepted.planRef});
      requireThat(proof.ok&&proof.obligationId===spec.id&&proof.obligationSha===digest(spec)&&proof.candidateSha===accepted.sha256,'Independent TELOS replay verification refused');verifiedNodes++;
      const published=row.candidate.published,publication=readCAS(published.commit),entry=readCAS(published.entry);
      requireThat(publication.records.includes(published.entry)&&entry.links.log===published.blob&&readCAS(published.blob).toString()===canonicalLarge({candidate:row.candidate.candidate,worker:row.candidate.worker,evidence:row.candidate.evidence,effects:row.candidate.effects}),'Retained worker publication differs');
      requireThat(spec.dependsOn.every(id=>row.candidate.evidence.dependencyVersions.some(v=>v.id===id&&v.sha256===state.obligations[id].accepted.sha256)),'Replay dependency versions differ');
      if(spec.effectKey){const observed=read(trial.stateDir+'/destination/'+rawHash(spec.effectKey)+'.json');requireThat(observed.writeCount===1&&same(observed.payload,spec.expected)&&state.effects[spec.effectKey]?.status==='confirmed','Replay effect is unknown, duplicated or substituted');}
    }
    const apply=trial.stateDir+'/destination/apply-events.jsonl';requireThat(Object.hasOwn(manifest.files,apply),'Destination invocation evidence required');
    const invocations=raw(apply).toString().trim().split('\n').map(JSON.parse);
    requireThat(invocations.length===effects.length&&effects.every(e=>invocations.filter(v=>v.key===e.key&&v.payloadSha===digest(e.payload)).length===1),'Replay repeated or altered an external fixture effect');
    requireThat(Array.isArray(trial.segments)&&trial.segments.length===(trial.kind==='clean'?1:2),'Replay segment coverage differs');
    let duration=0;
    for(let index=0;index<trial.segments.length;index++) {
      const segment=trial.segments[index],segmentRequest=read(segment.requestFile),watchdogRequest=read(segment.watchdogRequestFile),watchdog=read(segment.watchdogFile),processResult=read(segment.processFile);
      requireThat(segmentRequest.stateDir===stateDir&&segmentRequest.slots===trial.slots&&same(segmentRequest.batches,request.batches)&&same(segmentRequest.workerOptions,request.workerOptions)&&segmentRequest.maxDispatches===request.maxDispatches,'Replay inputs changed between widths');
      requireThat(watchdogRequest.replay===true&&watchdogRequest.replayRoot===root&&watchdogRequest.requestFile===inside(segment.requestFile)&&watchdogRequest.reportFile===inside(segment.watchdogFile),'Independent controlled watchdog boundary differs');
      requireThat(watchdog.schema==='ophanim.watchdog/v1'&&finite(watchdog.durationMs)&&watchdog.durationMs<=settings.trialTimeoutMs&&Math.abs(watchdog.durationMs-(watchdog.endedAt-watchdog.startedAt))<=2&&watchdog.reason==='worker-exited','Watchdog timing or completion refused');
      const crash=trial.kind==='recovery'&&index===0;
      requireThat(crash?watchdog.signal==='SIGKILL'&&segmentRequest.fault?.event==='after-effect-written'&&watchdog.events.some(e=>e.type==='fixture.fault'&&e.event==='after-effect-written'):watchdog.signal===null&&watchdog.exitCode===0&&processResult.exitCode===0,'Replay recovery/process evidence differs');
      if(!crash)requireThat(segment.resultFile===trial.resultFile,'Final replay result binding differs');
      duration+=watchdog.durationMs;
    }
    requireThat(finite(trial.metrics.wallMs)&&trial.metrics.wallMs+20>=duration,'Parent wall time cannot exclude child execution');
    if(trial.kind==='recovery')requireThat(finite(trial.metrics.recoveryMs)&&trial.metrics.recoveryMs>=result.durationMs,'Recovery time omits resumed work');
    segmentWall+=duration;
  }
  const cost=manifest.measurements?.benchmarkWallMs;
  requireThat(new Set(clean.map(t=>t.metrics.workerContextBytes)).size===1&&new Set(clean.map(t=>canonicalLarge(t.metrics.verificationCalls))).size===1,'Scheduler trials changed worker context or verification work');
  requireThat(finite(cost)&&cost>=segmentWall&&cost<=settings.budgetMs&&finite(manifest.measurements.verificationWallMs)&&cost>=segmentWall+manifest.measurements.verificationWallMs-50,'Optimizer trial cost omits measured work or exceeds budget');
  const values=(slots,key)=>clean.filter(t=>t.slots===slots).map(t=>key==='p95StageAcceptanceMs'?observedP95.get(t.id):t.metrics[key]);
  const assessment=assessEfficiency({baselineMs:values(1,'runDurationMs'),candidateMs:values(3,'runDurationMs'),baselineP95Ms:values(1,'p95StageAcceptanceMs'),candidateP95Ms:values(3,'p95StageAcceptanceMs'),baselineRecoveryMs:recovery.find(t=>t.slots===1).metrics.recoveryMs,candidateRecoveryMs:recovery.find(t=>t.slots===3).metrics.recoveryMs,trialCostMs:cost});
  return {...assessment,schema:'ophanim.efficiency-verification/v1',fixtureOnly:true,scopeSha:policy.scopeSha,baselineSlots:1,slots:3,baselineRelease:'baseline',workerArtifactSha:policy.workerArtifactSha,policySha:expectedPolicySha,evidenceSha:policy.evidenceSha,originalResultSha:policy.originalResultSha,verifiedNodes,readOnly:true};
}
