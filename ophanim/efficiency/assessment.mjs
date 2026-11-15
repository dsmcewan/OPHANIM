// The runtime records a convergence before considering a scheduler change.
// The assessment may propose one bounded setting. Only the separate authority admits it.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {withSeatLock} from '../../pantheon/src/seat/lock.mjs';
import {canonical,digest,readRuntimeSnapshot,STATE_SCHEMA} from '../board.mjs';
import {writeJson} from '../fixtures.mjs';
import {analyzeTrace,applicabilityFingerprint} from './analyze.mjs';

const REPLAY_BUDGET_MS=30000;
const MAX_QUALIFIED_CONVERGENCES=20;
const MAX_OBLIGATIONS=18;
const VERSION='ophanim.efficiency/v1';
const SHAPE=['check-artifact.mjs','check-contract.mjs','check-release.mjs','check-efficiency.mjs','check-efficiency-artifact.mjs'];
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const exists=fs.existsSync;
const shaFile=url=>digest(fs.readFileSync(url,'utf8'));
const now=()=>Math.round(performance.timeOrigin+performance.now());

export function efficiencyScope({obligations,planning,workerArtifactSha,registry,request,slots}) {
  const graph=obligations.map(spec=>({id:spec.id,kind:spec.kind,scope:spec.scope,dependsOn:spec.dependsOn,specSha:digest(spec)}));
  const policy={schema:VERSION,stateSchema:STATE_SCHEMA,planningPolicySha:digest(planning.policy),
    runtimeSha:shaFile(new URL('../runtime.mjs',import.meta.url)),
    verifierSources:Object.fromEntries(['../governance.mjs',...SHAPE.map(file=>'../governance/'+file)].map(file=>[file,shaFile(new URL(file,import.meta.url))])),
    maxQualifiedConvergences:MAX_QUALIFIED_CONVERGENCES,replayBudgetMs:REPLAY_BUDGET_MS};
  const configuration={slots,workerRegistry:registry,workerArtifactSha,policySha:digest(policy),inputRevision:digest(request)};
  return {scopeSha:applicabilityFingerprint({obligations:graph,configuration}),graph,configuration,policy};
}

function put(file,value) {
  if(exists(file)){
    if(canonical(read(file))!==canonical(value))throw Error(`Immutable efficiency evidence differs: ${path.basename(file)}`);
    return;
  }
  writeJson(file,value);
}
function directory(root) {
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(fs.realpathSync(root)!==root||!fs.lstatSync(root).isDirectory())throw Error('Canonical efficiency evidence directory required');
  return root;
}
function registryDir(root,scopeSha) {return directory(path.join(root,'scopes',scopeSha));}
function usesDir(scopeDir) {return directory(path.join(scopeDir,'uses'));}
const effectSummary=effects=>effects.map(({key,payload})=>({key,payload})).sort((a,b)=>a.key.localeCompare(b.key));
function acceptedGraph(state,scope) {
  const base=new Map(scope.graph.map(row=>[row.id,row]));
  return Object.values(state.obligations).map(row=>{
    const spec=row.spec;
    const acceptedEvent=state.events.findLast(event=>event.type==='work.accepted'&&event.id===spec.id&&event.attempt===row.accepted?.attempt);
    return {...(base.get(spec.id)??{id:spec.id,kind:spec.kind,scope:spec.scope,dependsOn:spec.dependsOn,specSha:digest(spec)}),
      specSha:digest(spec),status:row.status,
      ...(row.accepted?{acceptedAttempt:row.accepted.attempt}:{ }),
      ...(Number.isFinite(acceptedEvent?.atMs)?{acceptedAt:acceptedEvent.atMs}:{ })};
  }).sort((a,b)=>a.id.localeCompare(b.id));
}
function acceptanceEvidence(state) {
  return Object.values(state.obligations).filter(row=>row.status==='accepted').map(row=>({
    id:row.spec.id,specSha:digest(row.spec),outputSha:row.accepted.sha256,planRef:row.accepted.planRef,
    evidenceRefs:row.accepted.verification?.evidenceRefs??[],publication:row.candidate.published,
  })).sort((a,b)=>a.id.localeCompare(b.id));
}

// A shared, explicitly selected evidence root allows reuse across fresh states with
// identical inputs. The signed decision is checked under its original fixture authority.
export async function chooseEfficiencySlots({root,scope,stateDir,baselineSlots,hasRuntime,telosRoot}) {
  if(baselineSlots!==1)return {slots:baselineSlots};
  const scopeDir=registryDir(directory(root),scope.scopeSha);
  return withSeatLock('efficiency',async()=>{
    const use=path.join(usesDir(scopeDir),`${digest(stateDir)}.json`);
    const decisionFile=path.join(scopeDir,'promotion.json');
    if(!exists(decisionFile))return {slots:baselineSlots};
    if(hasRuntime&&!exists(use))return {slots:baselineSlots};
    const record=read(decisionFile);
    if(record.expected.scopeSha!==scope.scopeSha||record.expected.fromSlots!==1||record.expected.toSlots!==3)throw Error('Efficiency policy scope differs');
    const {createGovernance}=await import('../governance.mjs');
    const authority=await createGovernance({root:record.authorityRoot,fixtureOnly:true,readOnly:true,...telosRoot?{telosRoot}:{}});
    const checked=await authority.verifyEfficiencyDecision({decision:record.decision,expected:record.expected});
    if(checked?.ok!==true)throw Error('Efficiency policy authorization refused');
    const intent={schema:VERSION,stateDir,decisionId:checked.decisionId,scopeSha:scope.scopeSha};
    if(!exists(use)&&fs.readdirSync(usesDir(scopeDir)).filter(name=>name.endsWith('.json')&&!name.endsWith('.result.json')).length>=MAX_QUALIFIED_CONVERGENCES)return {slots:baselineSlots};
    put(use,intent);
    return {slots:3,use,promotion:record};
  },{dir:scopeDir,timeoutMs:60000});
}

function eligible({state,trace,output,scope,request,priorRuntime,analysis}) {
  if(output.convergence==='blocked')return 'unsettled-obligations';
  if(output.convergence==='no_change'||!output.dispatches)return 'no-new-dispatch';
  if(state.activeRelease!=='baseline')return 'release-outside-fixture-replay-contract';
  if(output.slots!==1)return 'slot-policy-outside-admitted-experiment';
  if(priorRuntime||request.fault)return 'requires-fresh-uninterrupted-baseline';
  if(trace.scopeSha!==scope.scopeSha)return 'scope-differs-from-fresh-request';
  if(trace.obligations.length>MAX_OBLIGATIONS)return 'fixture-replay-size-budget';
  if(trace.obligations.filter(row=>row.dependsOn.length===0).length<2)return 'no-independent-ready-work';
  // This experiment changes only slot width. A cheap screen uses the observed
  // worker time outside the critical chain as its opportunity signal.
  const parallelWorkMs=analysis.scheduling.workerMs-analysis.criticalPath.workMs;
  if(parallelWorkMs<Math.max(100,output.durationMs*0.1))return 'insufficient-observed-parallel-work';
  return null;
}

function recordValue(use,output,trace,assessmentCostMs) {
  const efficiency=use.promotion.efficiency;
  const resultFile=use.use.replace(/\.json$/,'.result.json');
  if(output.convergence==='accepted_change'&&!exists(resultFile))put(resultFile,{
    traceSha:digest(trace),executionMs:output.durationMs,assessmentCostMs,
    observedSavingMs:efficiency.baselineConservativeMs-output.durationMs-assessmentCostMs,
  });
  const realized=fs.readdirSync(path.dirname(use.use)).filter(name=>name.endsWith('.result.json')).map(name=>read(path.join(path.dirname(use.use),name)));
  return {qualifiedConvergences:realized.length,originalOptimizationCostMs:efficiency.totalAssessmentCostMs,
    measuredNetMs:realized.reduce((sum,row)=>sum+row.observedSavingMs,-efficiency.totalAssessmentCostMs)};
}

export async function assessConvergence({root,stateDir,scope,state,boardCommit,output,request,replayRequest,priorRuntime,attempts,verifications,events,governance,use}) {
  const startedAt=now(),cpuStart=process.cpuUsage();
  const reportDir=directory(path.join(stateDir,'efficiency','convergences',boardCommit.replace(':','-')));
  const verifiedState=readRuntimeSnapshot(stateDir,boardCommit).state;
  if(!verifiedState||digest(verifiedState)!==digest(state))throw Error('Accepted snapshot differs from the Pantheon board');
  const obligations=acceptedGraph(verifiedState,scope);
  const trace={schema:'ophanim.efficiency.trace/v1',boardCommit,stateSha:digest(verifiedState),
    scopeSha:applicabilityFingerprint({obligations,configuration:scope.configuration}),
    configuration:scope.configuration,policy:scope.policy,release:verifiedState.releases[verifiedState.activeRelease],authority:governance.identity,
    obligations,accepted:acceptanceEvidence(verifiedState),events,attempts,verifications,
    window:{startedAt:output.startedAt,endedAt:output.endedAt},
    original:{convergence:output.convergence,slots:output.slots,outputSha:digest(output.outputs),effectSha:digest(effectSummary(output.effects)),
      durationMs:output.durationMs,measurements:output.measurements,modelCalls:output.limits.modelCalls}};
  put(path.join(reportDir,'trace.json'),trace);
  const traceSha=digest(trace);
  const analysis=analyzeTrace(trace);
  const reason=eligible({state,trace,output,scope,request,priorRuntime,analysis});
  const scopeDir=registryDir(directory(root),trace.scopeSha);
  const finish=(fields={})=>{
    const wallMs=Math.max(0,now()-startedAt),cpu=process.cpuUsage(cpuStart);
    const report={schema:VERSION,scopeSha:trace.scopeSha,traceSha,analysis,outcome:'no_change',...fields,
      cost:{wallMs,controllerCpuMicros:cpu.user+cpu.system,replayBudgetMs:REPLAY_BUDGET_MS,modelCalls:0,providerSpend:0},
      measuredValue:use?.promotion?recordValue(use,output,trace,wallMs):{
        qualifiedConvergences:0,originalOptimizationCostMs:wallMs,measuredNetMs:-wallMs,
      }};
    put(path.join(reportDir,'assessment.json'),report);
    return {outcome:report.outcome,reason:report.reason,traceSha,scopeSha:trace.scopeSha,boardCommit,reportFile:path.join(reportDir,'assessment.json')};
  };
  if(reason)return finish({reason});
  return withSeatLock('efficiency',async()=>{
    const marker=path.join(scopeDir,'experiment.json');
    if(exists(marker))return finish({reason:'exact-scope-experiment-already-recorded',prior:read(marker)});
    const evidenceRoot=directory(path.join(reportDir,'experiment'));
    put(marker,{schema:VERSION,traceSha,evidenceRoot,fromSlots:1,toSlots:3});
    const alternative={schema:'ophanim.scheduler-policy/v1',scopeSha:trace.scopeSha,baselineSlots:1,slots:3,baselineRelease:'baseline',
      workerArtifactSha:scope.configuration.workerArtifactSha,policySha:scope.configuration.policySha,
      stateSchema:STATE_SCHEMA,maxQualifiedConvergences:MAX_QUALIFIED_CONVERGENCES};
    try {
      const {evaluateScheduler}=await import('./replay.mjs');
      const replay=await evaluateScheduler({outputDir:evidenceRoot,request:replayRequest,baselineSlots:1,candidateSlots:3,
        repeats:3,budgetMs:REPLAY_BUDGET_MS,originalResult:output,originalStateDir:stateDir,scopeSha:trace.scopeSha,trace});
      const experiment={manifestFile:replay?.manifestFile??null,evidenceSha:replay?.evidenceSha??null,measurements:replay?.measurements??null};
      if(!replay||replay.ok!==true)return finish({reason:replay?.reason??'replay-incomplete',alternative,evidenceRoot,experiment});
      const candidate={...alternative,evidenceSha:replay.evidenceSha,originalResultSha:replay.originalResultSha};
      const checked=await governance.verifyEfficiencyCandidate({candidate,evidenceRoot});
      if(checked?.ok!==true)return finish({reason:checked?.reason??'independent-qualification-refused',alternative,evidenceRoot,experiment,qualification:checked?.efficiency??null});
      const expected={planRef:checked.planRef,policy:candidate,scopeSha:trace.scopeSha,fromSlots:1,toSlots:3,release:'baseline',evidenceRefs:checked.evidenceRefs};
      const decision=await governance.issueEfficiencyDecision(expected);
      const authorization=await governance.verifyEfficiencyDecision({decision,expected});
      if(authorization?.ok!==true)throw Error('Efficiency activation authorization refused');
      const totalAssessmentCostMs=Math.max(0,now()-startedAt);
      const forecastNetSavedMs=checked.efficiency.forecastGrossSavedMs-totalAssessmentCostMs;
      if(forecastNetSavedMs<=0)return finish({reason:'nonpositive-forecast-after-full-assessment-cost',alternative,evidenceRoot,experiment,qualification:checked.efficiency});
      const efficiency={...checked.efficiency,totalAssessmentCostMs,forecastNetSavedMs,realizedNetSavedMs:-totalAssessmentCostMs};
      put(path.join(scopeDir,'promotion.json'),{schema:VERSION,authorityRoot:stateDir,expected,decision,efficiency});
      return finish({outcome:'promoted',reason:'independently-authorized-slot-policy',alternative,evidenceRoot,experiment,efficiency,decisionId:authorization.decisionId,authorization:{expected,decision}});
    }catch(error){
      return finish({reason:'experiment-held',detail:String(error.message).slice(0,500),alternative,evidenceRoot});
    }
  },{dir:scopeDir,timeoutMs:60000});
}

export function verifyEfficiencyRecord({stateDir,record,output}) {
  const reportFile=path.resolve(record.reportFile);
  const expected=path.join(stateDir,'efficiency','convergences',record.boardCommit.replace(':','-'),'assessment.json');
  if(reportFile!==expected||fs.realpathSync(reportFile)!==expected)throw Error('Efficiency report path differs');
  const assessment=read(reportFile),trace=read(path.join(path.dirname(reportFile),'trace.json'));
  const snapshot=readRuntimeSnapshot(stateDir,record.boardCommit).state;
  if(digest(trace)!==record.traceSha||assessment.traceSha!==record.traceSha||trace.stateSha!==digest(snapshot)||
      trace.scopeSha!==record.scopeSha||assessment.scopeSha!==record.scopeSha||assessment.outcome!==record.outcome||
      canonical(trace.accepted)!==canonical(acceptanceEvidence(snapshot)))throw Error('Efficiency evidence differs from the accepted board');
  if(output&&(trace.original.outputSha!==digest(output.outputs)||trace.original.effectSha!==digest(effectSummary(output.effects))||
      trace.original.durationMs!==output.durationMs||trace.original.convergence!==output.convergence||trace.original.slots!==output.slots))throw Error('Efficiency observation differs from the runtime result');
  if(canonical(assessment.analysis)!==canonical(analyzeTrace(trace)))throw Error('Efficiency analysis differs from retained trace');
  if(assessment.experiment?.manifestFile){
    const manifest=path.join(path.dirname(reportFile),'experiment','manifest.json');
    if(assessment.experiment.manifestFile!==manifest||fs.realpathSync(manifest)!==manifest||
      createHash('sha256').update(fs.readFileSync(manifest)).digest('hex')!==assessment.experiment.evidenceSha)throw Error('Efficiency replay manifest differs');
  }
  return assessment;
}
