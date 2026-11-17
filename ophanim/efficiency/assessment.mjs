// ophanim/efficiency/assessment.mjs -- the efficiency assessment the runtime runs after each convergence.
//
// The runtime records a convergence before considering a scheduler change.
// The assessment may propose one bounded setting. Only the separate authority admits it.
//
// Purpose: after a convergence, retain a trace of what happened (bound to the accepted board snapshot),
//   analyse it, decide whether a 1 -> 3 slot scheduler experiment is worth running and, if admitted, run
//   the controlled replay, have the governance authority qualify it and sign a promotion. Later runs ask
//   chooseEfficiencySlots whether a verified promotion lets them use 3 slots. Every retained record can
//   be re-derived (verifyEfficiencyRecord / rederiveAssessment) from the trace and the board snapshot.
// Inputs:  efficiencyScope: the obligations, planning, worker registry and request of one run.
//   assessConvergence: the evidence root, state directory, scope, accepted state and board commit, the
//   runtime output, attempts/verifications/events, the governance authority, the use it ran under and an
//   optional efficiency ledger (ophanim/ledger/efficiency-kinds.mjs efficiencyRecorder).
// Outputs: write-once JSON under <stateDir>/efficiency/convergences/<commit>/ (trace.json,
//   assessment.json, experiment/) and under <root>/scopes/<scopeSha>/ (experiment.json marker,
//   promotion.json, uses/*.json, uses/*.result.json, uses/assessment-costs/); with a ledger, the matching
//   ledger entries. assessConvergence returns a small record naming the report, trace and outcome.
// Invariants: evidence files are write-once (put/once refuse a different value at an existing path);
//   the slot count only ever moves from 1 to 3 and only for the scope a signed decision names; a
//   promotion is used at most MAX_QUALIFIED_CONVERGENCES times; measured value counts only results bound
//   to a recorded use; a ledger is verified before anything in it is relied on.
// Must never: authorize a scheduler change itself (the governance authority signs and verifies it),
//   rewrite a retained record, count an unbound result, or call a model or provider.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {withSeatLock} from '../../pantheon/src/seat/lock.mjs';
import {canonical,digest,readRuntimeSnapshot,STATE_SCHEMA} from '../board.mjs';
import {writeJson} from '../fixtures.mjs';
import {analyzeTrace,applicabilityFingerprint} from './analyze.mjs';
import {assessOptimizationAdmission} from './admission.mjs';
import {buildContributionRegistry,discoverVariables} from './contributions.mjs';
import {readRetainedExperiment} from './prior.mjs';
import {verifyAdmissionTrace} from './trace-binding.mjs';
import {investigationWithoutEvidence,recordInvestigation,
  verifyInvestigationReceipt} from './investigation/controller.mjs';

const REPLAY_BUDGET_MS=30000;
const MAX_QUALIFIED_CONVERGENCES=20;
const MAX_OBLIGATIONS=18;
const VERSION='ophanim.efficiency/v1';
const ADMISSION_SCHEMA='ophanim.efficiency-assessment/v2';
const REPORT_SCHEMA='ophanim.efficiency-assessment/v3';
// The governance verifier sources whose bytes are hashed into the policy (see efficiencyScope).
const SHAPE=[
  'check-artifact.mjs','check-contract.mjs','check-release.mjs','check-efficiency.mjs','check-efficiency-artifact.mjs'];
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const exists=fs.existsSync;
const shaFile=url=>digest(fs.readFileSync(url,'utf8'));
const now=()=>Math.round(performance.timeOrigin+performance.now());

// The applicability scope of one run: the obligation graph (spec hashes, not specs), the configuration
// (slots, worker registry and artifact, policy hash, request hash) and the policy, which hashes the
// runtime and the governance verifier sources so that any change to them yields a different scope.
export function efficiencyScope({obligations,planning,workerArtifactSha,registry,request,slots}) {
  const graph=obligations.map(
    spec=>({id:spec.id,kind:spec.kind,scope:spec.scope,dependsOn:spec.dependsOn,specSha:digest(spec)}));
  const policy={schema:VERSION,stateSchema:STATE_SCHEMA,planningPolicySha:digest(planning.policy),
    runtimeSha:shaFile(new URL('../runtime.mjs',import.meta.url)),
    verifierSources:Object.fromEntries(
      ['../governance.mjs',...SHAPE.map(file=>'../governance/'+file)].map(
        file=>[file,shaFile(new URL(file,import.meta.url))])),
    maxQualifiedConvergences:MAX_QUALIFIED_CONVERGENCES,replayBudgetMs:REPLAY_BUDGET_MS};
  const configuration={
    slots,workerRegistry:registry,workerArtifactSha,policySha:digest(policy),inputRevision:digest(request)};
  return {scopeSha:applicabilityFingerprint({obligations:graph,configuration}),graph,configuration,policy};
}

// Write-once: an existing file must already hold exactly `value`.
function put(file,value) {
  if(exists(file)){
    if(canonical(read(file))!==canonical(value))
      throw Error(`Immutable efficiency evidence differs: ${path.basename(file)}`);
    return;
  }
  writeJson(file,value);
}
// Create (if needed) and return a directory that must be canonical: no symbolic link on its path.
function directory(root) {
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(fs.realpathSync(root)!==root||!fs.lstatSync(root).isDirectory())
    throw Error('Canonical efficiency evidence directory required');
  return root;
}
function registryDir(root,scopeSha) {return directory(path.join(root,'scopes',scopeSha));}
function usesDir(scopeDir) {return directory(path.join(scopeDir,'uses'));}
// Effects reduced to key and payload, ordered by key, so their hash ignores emission order.
const effectSummary=effects=>effects.map(({key,payload})=>({key,payload})).sort((a,b)=>a.key.localeCompare(b.key));
// The obligation graph as the board ended: each scope row (or one rebuilt from the spec), with its final
// status, the accepted attempt and the time of the matching work.accepted event; ordered by id.
function acceptedGraph(state,scope) {
  const base=new Map(scope.graph.map(row=>[row.id,row]));
  return Object.values(state.obligations).map(row=>{
    const spec=row.spec;
    const acceptedEvent=state.events.findLast(
      event=>event.type==='work.accepted'&&event.id===spec.id&&event.attempt===row.accepted?.attempt);
    return {
      ...(base.get(spec.id)??
        {id:spec.id,kind:spec.kind,scope:spec.scope,dependsOn:spec.dependsOn,specSha:digest(spec)}),
      specSha:digest(spec),status:row.status,
      ...(row.accepted?{acceptedAttempt:row.accepted.attempt}:{ }),
      ...(Number.isFinite(acceptedEvent?.atMs)?{acceptedAt:acceptedEvent.atMs}:{ })};
  }).sort((a,b)=>a.id.localeCompare(b.id));
}
// What the board accepted, per obligation: spec hash, output hash, plan reference, evidence references
// and publication. Bound into the trace and re-derived from the snapshot on verification.
function acceptanceEvidence(state) {
  return Object.values(state.obligations).filter(row=>row.status==='accepted').map(row=>({
    id:row.spec.id,specSha:digest(row.spec),outputSha:row.accepted.sha256,planRef:row.accepted.planRef,
    evidenceRefs:row.accepted.verification?.evidenceRefs??[],publication:row.candidate.published,
  })).sort((a,b)=>a.id.localeCompare(b.id));
}

// A shared, explicitly selected evidence root allows reuse across fresh states with
// identical inputs. The signed decision is checked under its original fixture authority.
// K5: an optional `ledger` (ophanim/ledger/efficiency-kinds.mjs efficiencyRecorder) is verified before
// anything is relied on, and records the promotion, each use, result and debit as entries that re-derive.
// Without one, the file-based records below are kept, as before.
function verifiedLedger(ledger) {
  if(!ledger)return;
  const verified=ledger.verify();
  if(!verified.ok)throw Error(`Efficiency ledger does not verify, refusing to rely on it: ${verified.why}`);
}

// The slot count a run may use. Only a width-1 baseline is ever widened, and only to 3: a promotion for
// exactly this scope must exist, its signed decision must verify under the authority that issued it,
// and a use must be available (a run that already has runtime state keeps the width its recorded use
// gave it). Runs under the seat lock, so two runs cannot both take the last use.
export async function chooseEfficiencySlots({root,scope,stateDir,baselineSlots,hasRuntime,telosRoot,ledger=null}) {
  verifiedLedger(ledger);
  if(baselineSlots!==1)return {slots:baselineSlots};
  const scopeDir=registryDir(directory(root),scope.scopeSha);
  return withSeatLock('efficiency',async()=>{
    const use=path.join(usesDir(scopeDir),`${digest(stateDir)}.json`);
    const decisionFile=path.join(scopeDir,'promotion.json');
    if(!exists(decisionFile))return {slots:baselineSlots};
    if(hasRuntime&&!exists(use))return {slots:baselineSlots};
    const record=read(decisionFile);
    if(record.expected.scopeSha!==scope.scopeSha||record.expected.fromSlots!==1||record.expected.toSlots!==3)
      throw Error('Efficiency policy scope differs');
    const {createGovernance}=await import('../governance.mjs');
    const authority=await createGovernance(
      {root:record.authorityRoot,fixtureOnly:true,readOnly:true,...telosRoot?{telosRoot}:{}});
    const checked=await authority.verifyEfficiencyDecision({decision:record.decision,expected:record.expected});
    if(checked?.ok!==true)throw Error('Efficiency policy authorization refused');
    const intent={schema:VERSION,stateDir,decisionId:checked.decisionId,scopeSha:scope.scopeSha};
    if(ledger){
      // The ledger counts the promotion's uses from its own earlier entries; a spent promotion is refused there.
      const granted=ledger.use(
        {scopeSha:scope.scopeSha,decisionId:checked.decisionId,stateDir,efficiency:record.efficiency});
      if(!granted)return {slots:baselineSlots};
      put(use,intent);
      return {slots:3,use,promotion:record,ledger:granted};
    }
    // File-based use count: one <digest(stateDir)>.json per use (results excluded); the cap is a hard stop.
    if(!exists(use)&&
      fs.readdirSync(usesDir(scopeDir)).filter(
        name=>name.endsWith('.json')&&!name.endsWith('.result.json')).length>=MAX_QUALIFIED_CONVERGENCES)
      return {slots:baselineSlots};
    put(use,intent);
    return {slots:3,use,promotion:record};
  },{dir:scopeDir,timeoutMs:60000});
}

// The first reason this convergence cannot be screened for the experiment, or null. Only a fresh,
// uninterrupted, accepted width-1 baseline run with wave scheduling and full handoff, at most
// MAX_OBLIGATIONS obligations and at least two with no dependencies, is a candidate.
function ineligible({state,trace,output,scope,request,priorRuntime}) {
  if(output.convergence==='blocked')return 'unsettled-obligations';
  if(output.convergence==='no_change'||!output.dispatches)return 'no-new-dispatch';
  if(state.activeRelease!=='baseline')return 'release-outside-fixture-replay-contract';
  if(output.slots!==1)return 'slot-policy-outside-admitted-experiment';
  // The admitted experiment compares wave scheduling with full handoff only.
  if((request.schedule??'wave')!=='wave'||(request.handoffVerification??'full')!=='full')
    return 'policy-outside-admitted-experiment';
  if(priorRuntime||request.fault)return 'requires-fresh-uninterrupted-baseline';
  if(trace.scopeSha!==scope.scopeSha)return 'scope-differs-from-fresh-request';
  if(trace.obligations.length>MAX_OBLIGATIONS)return 'fixture-replay-size-budget';
  if(trace.obligations.filter(row=>row.dependsOn.length===0).length<2)return 'no-independent-ready-work';
  return null;
}

// The admission decision for `inputs`: a blocker becomes a fixed no_change record; otherwise the pure
// screening in admission.mjs decides. rederiveAssessment re-runs exactly this.
function screen({trace,analysis,inputs}) {
  if (inputs.blocker) return {schema:'ophanim.optimization-admission/v1',admitted:false,outcome:'no_change',
    reason:inputs.blocker,replays:0,modelCalls:0,policyAuthorization:false};
  return assessOptimizationAdmission({trace,analysis,priorOutcome:inputs.priorOutcome,
    ...Object.hasOwn(inputs,'expectedQualifiedConvergences')?{
      expectedQualifiedConvergences:inputs.expectedQualifiedConvergences}:{}});
}

// Whether the trace is an accepted change whose admission binding to the snapshot is complete; never throws.
function boundAcceptedTrace(trace,snapshot) {
  if(trace.original.convergence!=='accepted_change')return false;
  try{return verifyAdmissionTrace(trace,snapshot).complete;}
  catch{return false;}
}

// Each assessment leaves one write-once debit keyed by its trace, and each
// interrupted assessment one marker keyed by the interrupted trace. Totals are
// derived by reading them; no ledger file is ever rewritten.
const DEBIT_SCHEMA='ophanim.efficiency-debit/v1';
const INTERRUPTION_SCHEMA='ophanim.efficiency-interruption/v1';
// Write-once by hard link from a private temporary file: the first writer wins atomically, and every
// caller (including one that lost the race) returns what is actually on disk.
function once(file,value) {
  if(exists(file))return read(file);
  const temporary=`${file}.${process.pid}.debit.tmp`;
  const fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,canonical(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.linkSync(temporary,file);}
  catch(error){if(error.code!=='EEXIST')throw error;}
  finally{fs.unlinkSync(temporary);}
  return read(file);
}
const SHA=/^[0-9a-f]{64}$/;
const count=value=>Number.isSafeInteger(value)&&value>=0;
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
// The earlier mutable ledger wrote one aggregate per use. It is read, never rewritten, and only in the
// shape that writer produced: two non-negative counters and its bookkeeping hashes. A negative, partial
// or invented aggregate would otherwise lower the measured cost, so it is refused.
const LEGACY_KEYS=['additionalAssessmentCostMs','unmeasuredAssessments','lastTraceSha','lastInterruptedTraceSha'];
function legacyAggregate(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||
      Object.keys(value).some(key=>!LEGACY_KEYS.includes(key))||
      !count(value.additionalAssessmentCostMs)||!count(value.unmeasuredAssessments)||
      ['lastTraceSha','lastInterruptedTraceSha'].some(key=>Object.hasOwn(value,key)&&!SHA.test(value[key])))
    throw Error('Legacy efficiency debit is not a non-negative aggregate');
  return value;
}
// A debit record in exactly its schema's shape, for this trace, with a non-negative cost.
const validDebit=(record,traceSha)=>exactKeys(record,['schema','traceSha','assessmentCostMs'])&&
  record.schema===DEBIT_SCHEMA&&record.traceSha===traceSha&&count(record.assessmentCostMs);
// Record one assessment's cost against a use: a debit file keyed by the trace (cost 0 when a realized
// result already deducts it, i.e. not `charged`), plus an interruption marker when the preceding run was
// interrupted. Both are write-once. Returns the debit path and the debit actually retained.
export function recordAssessmentDebit({usesDir,useFile,traceSha,assessmentCostMs,charged,interrupted}) {
  if(!SHA.test(traceSha)||!count(assessmentCostMs)||interrupted&&!SHA.test(interrupted.traceSha))
    throw Error('Efficiency debit must be a non-negative cost for one trace');
  const costs=directory(path.join(usesDir,'assessment-costs'));
  const dir=directory(path.join(costs,path.basename(useFile,'.json')));
  const debit=once(
    path.join(dir,`debit-${traceSha}.json`),{schema:DEBIT_SCHEMA,traceSha,assessmentCostMs:charged?assessmentCostMs:0});
  if(!validDebit(debit,traceSha))throw Error('Retained efficiency debit differs');
  if(interrupted)
    once(path.join(dir,`interrupted-${interrupted.traceSha}.json`),
      {schema:INTERRUPTION_SCHEMA,traceSha:interrupted.traceSha});
  return {file:path.join(dir,`debit-${traceSha}.json`),debit};
}
// Total additional assessment cost and unmeasured (interrupted) assessments across every use: legacy
// aggregates plus per-use debit and interruption records. A record in an unexpected shape, or under a
// name that does not match its trace, throws rather than being skipped.
export function readAssessmentDebits(usesDir) {
  const costs=path.join(usesDir,'assessment-costs');
  const totals={additionalAssessmentCostMs:0,unmeasuredAssessments:0};
  if(!exists(costs))return totals;
  for(const entry of fs.readdirSync(costs,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const file=path.join(costs,entry.name);
    if(entry.isFile()&&entry.name.endsWith('.json')){
      // Aggregate written by the earlier mutable ledger; read, never rewritten.
      const legacy=legacyAggregate(read(file));
      totals.additionalAssessmentCostMs+=legacy.additionalAssessmentCostMs;
      totals.unmeasuredAssessments+=legacy.unmeasuredAssessments;
    }else if(entry.isDirectory()){
      for(const name of fs.readdirSync(file).sort()){
        if(!name.endsWith('.json'))continue;
        const record=read(path.join(file,name));
        if(record?.schema===DEBIT_SCHEMA&&name===`debit-${record.traceSha}.json`&&
          validDebit(record,record.traceSha)&&SHA.test(record.traceSha))
          totals.additionalAssessmentCostMs+=record.assessmentCostMs;
        else if(exactKeys(record,['schema','traceSha'])&&record.schema===INTERRUPTION_SCHEMA&&
          SHA.test(record.traceSha)&&name===`interrupted-${record.traceSha}.json`)
          totals.unmeasuredAssessments++;
        else throw Error('Unexpected efficiency ledger record');
      }
    }
  }
  if(!count(totals.additionalAssessmentCostMs))throw Error('Efficiency debit total exceeds the safe integer range');
  return totals;
}

// A realized result counts only when it is bound to a recorded use: its use intent exists under the
// same name, names this promotion's scope and the state directory the name is derived from, and the
// result's trace is an accepted 3-slot convergence retained in that state directory whose duration is
// the result's execution time. Its saving must re-derive from the promotion's own figures. An unbound
// result is reported, never counted.
const RESULT_KEYS=['traceSha','executionMs','assessmentCostMs','observedSavingMs'];
// The retained trace in stateDir whose digest is traceSha, or null. Unreadable traces are skipped.
function boundTrace(stateDir,traceSha) {
  const convergences=path.join(stateDir,'efficiency','convergences');
  if(!exists(convergences))return null;
  for(const head of fs.readdirSync(convergences).sort()){
    const file=path.join(convergences,head,'trace.json');
    if(!exists(file))continue;
    let trace;try{trace=read(file);}catch{continue;}
    if(digest(trace)===traceSha)return trace;
  }
  return null;
}
export function resultBindsToUse({useFile,result,promotion}) {
  const efficiency=promotion?.efficiency,expected=promotion?.expected;
  // The result's own arithmetic: saving = the promotion's conservative baseline - execution - assessment cost.
  if(!exactKeys(result,RESULT_KEYS)||!SHA.test(result.traceSha)||!count(result.executionMs)||
    !count(result.assessmentCostMs)||
    !Number.isSafeInteger(result.observedSavingMs)||!count(efficiency?.baselineConservativeMs)||
    result.observedSavingMs!==efficiency.baselineConservativeMs-result.executionMs-result.assessmentCostMs)
    return false;
  if(!exists(useFile))return false;
  let intent;try{intent=read(useFile);}catch{return false;}
  // The use intent: exact shape, an absolute state directory whose digest names the file, this scope.
  if(!exactKeys(intent,['schema','stateDir','decisionId','scopeSha'])||intent.schema!==VERSION||
    typeof intent.stateDir!=='string'||
    !path.isAbsolute(intent.stateDir)||path.basename(useFile)!==`${digest(intent.stateDir)}.json`||
    intent.scopeSha!==expected?.scopeSha)return false;
  const trace=boundTrace(intent.stateDir,result.traceSha);
  return !!trace&&trace.original?.convergence==='accepted_change'&&trace.original.slots===expected.toSlots&&
    trace.original.durationMs===result.executionMs;
}
// Split every *.result.json in a uses directory into counted (bound to its use) and an unbound count.
export function readRealizedResults(usesDir,promotion) {
  const counted=[];let unbound=0;
  for(const name of fs.readdirSync(usesDir).filter(name=>name.endsWith('.result.json')).sort()){
    let result;try{result=read(path.join(usesDir,name));}catch{unbound++;continue;}
    const useFile=path.join(usesDir,name.replace(/\.result\.json$/,'.json'));
    if(resultBindsToUse({useFile,result,promotion}))counted.push(result);else unbound++;
  }
  return {counted,unbound};
}

// For a run made under a promotion: retain its realized result (once, and only for an accepted change),
// debit this assessment, and return the promotion's measured value so far -- qualified convergences,
// costs, and measuredNetMs = sum of observed savings minus every assessment cost. With a ledger the value
// is derived from the ledger instead (ledgerValue).
function recordValue(use,output,trace,assessmentCostMs,interrupted,ledger) {
  const efficiency=use.promotion.efficiency;
  const resultFile=use.use.replace(/\.json$/,'.result.json');
  const traceSha=digest(trace);
  if(output.convergence==='accepted_change'&&!exists(resultFile))put(resultFile,{
    traceSha,executionMs:output.durationMs,assessmentCostMs,
    observedSavingMs:efficiency.baselineConservativeMs-output.durationMs-assessmentCostMs,
  });
  const uses=path.dirname(use.use);
  // A realized result already deducts this trace's assessment cost.
  const charged=!exists(resultFile)||read(resultFile).traceSha!==traceSha;
  const {file}=recordAssessmentDebit({usesDir:uses,useFile:use.use,traceSha,assessmentCostMs,charged,interrupted});
  if(ledger)return ledgerValue({ledger,use,output,traceSha,assessmentCostMs,interrupted,resultFile,debitRecord:file});
  const {counted:realized,unbound}=readRealizedResults(uses,use.promotion);
  const {additionalAssessmentCostMs,unmeasuredAssessments}=readAssessmentDebits(uses);
  return {qualifiedConvergences:realized.length,originalOptimizationCostMs:efficiency.totalAssessmentCostMs,
    additionalAssessmentCostMs,unmeasuredAssessments,measuredNetIsUpperBound:unmeasuredAssessments>0,debitRecord:file,
    ...unbound?{unboundResults:unbound}:{},
    measuredNetMs:realized.reduce(
      (sum,row)=>sum+row.observedSavingMs,-efficiency.totalAssessmentCostMs-additionalAssessmentCostMs)};
}

// K5: with a ledger, the result and the debit are recorded as entries citing the use (which cites the
// promotion), and the measured value is derived from the verified ledger, not from the side files. The
// files are still written for display and for readers that predate the ledger.
function ledgerValue({ledger,use,output,traceSha,assessmentCostMs,interrupted,resultFile,debitRecord}) {
  if(!use.ledger?.use)throw Error('A ledger-recorded assessment needs the use entry it was granted under');
  const entries={use:use.ledger.use};
  if(output.convergence==='accepted_change'){
    const result=read(resultFile);
    // The file's result is the one this use realized; the ledger records it once, citing the use.
    entries.result=ledger.result({use:use.ledger.use,result});
  }
  // `charged` is re-derived on the chain from the results it holds, not taken from the file path.
  entries.debit=ledger.debit({use:use.ledger.use,traceSha,assessmentCostMs,interrupted:interrupted?.traceSha??null});
  const totals=ledger.totals(use.ledger.promotion);
  return {...totals,measuredNetIsUpperBound:totals.unmeasuredAssessments>0,debitRecord,
    ledger:{head:totals.head,...entries}};
}

// Assess one convergence (see the header). Order matters: the trace is retained first; the investigation
// is recorded whatever the outcome; admission is screened under the seat lock; an admitted experiment is
// marked (experiment.json) before it runs, so a later run reads it as a prior instead of repeating it.
// Every return goes through finish(), which writes the single assessment.json.
export async function assessConvergence(
  {root,stateDir,scope,state,boardCommit,output,request,replayRequest,priorRuntime,attempts,verifications,events,
    governance,use,interrupted,ledger=null}) {
  const startedAt=now(),cpuStart=process.cpuUsage();
  verifiedLedger(ledger);
  const reportDir=directory(path.join(stateDir,'efficiency','convergences',boardCommit.replace(':','-')));
  const snapshot=readRuntimeSnapshot(stateDir,boardCommit);
  const verifiedState=snapshot.state;
  if(!verifiedState||digest(verifiedState)!==digest(state))
    throw Error('Accepted snapshot differs from the Pantheon board');
  const obligations=acceptedGraph(verifiedState,scope);
  const trace={schema:'ophanim.efficiency.trace/v1',boardCommit,stateSha:digest(verifiedState),
    scopeSha:applicabilityFingerprint({obligations,configuration:scope.configuration}),
    configuration:scope.configuration,policy:scope.policy,
    release:verifiedState.releases[verifiedState.activeRelease],authority:governance.identity,
    obligations,accepted:acceptanceEvidence(verifiedState),events,attempts,verifications,
    investigationEstimateSha:digest(request.investigationEstimate??null),
    window:{startedAt:output.startedAt,endedAt:output.endedAt},
    original:{
      convergence:output.convergence,slots:output.slots,outputSha:digest(output.outputs),
      effectSha:digest(effectSummary(output.effects)),
      durationMs:output.durationMs,measurements:output.measurements,modelCalls:output.limits.modelCalls}};
  put(path.join(reportDir,'trace.json'),trace);
  const traceSha=digest(trace);
  // K5b: with a ledger the trace is an entry, and the assessment and any retained experiment cite it.
  const ledgerTrace=ledger?ledger.trace({stateDir,trace}):null;
  let retainedEntry=null,retainMarker=null;
  const analysis=analyzeTrace(trace);
  const contributionRegistry=buildContributionRegistry({trace,analysis});
  const variables=discoverVariables({trace,analysis,registry:contributionRegistry});
  const blocker=ineligible({state,trace,output,scope,request,priorRuntime});
  const admissionInputs=Object.hasOwn(request,'expectedQualifiedConvergences')
    ?{expectedQualifiedConvergences:request.expectedQualifiedConvergences}:{};
  let admission,binding=null;
  // Screen once; keep the inputs, decision, binding and the screening's own cost as the admission receipt.
  const admit=(inputs,started,startedCpu)=>{
    const decision=screen({trace,analysis,inputs});
    const cpu=process.cpuUsage(startedCpu);
    admission={inputs,decision,binding,cost:{wallMs:performance.now()-started,controllerCpuMicros:cpu.user+cpu.system}};
    return decision;
  };
  let investigation;
  // At most once per assessment; a failure becomes a held receipt (checked by verifyHeldInvestigation).
  const investigate=async()=>{
    if(investigation)return;
    try {
      investigation=await recordInvestigation({root,stateDir,trace,registry:contributionRegistry,variables,
        workload:request.expectedQualifiedConvergences??1,estimate:request.investigationEstimate??null,
        traceTrusted:binding?.complete||boundAcceptedTrace(trace,snapshot)});
    } catch(error) {
      investigation={
        schema:'ophanim.investigation-blocked/v1',scopeSha:trace.scopeSha,traceSha,boardCommit,
        reason:'investigation-evidence-unavailable',
        detail:String(error.message).slice(0,256)};
    }
  };
  // Write the report (with its cost and measured value) and, with a ledger, its entries; return the record.
  const finish=async(fields={})=>{
    await investigate();
    const wallMs=Math.max(0,now()-startedAt),cpu=process.cpuUsage(cpuStart);
    const report={
      schema:REPORT_SCHEMA,scopeSha:trace.scopeSha,traceSha,analysis,contributionRegistry,variables,admission,
      investigation,outcome:'no_change',...fields,
      cost:{
        wallMs,controllerCpuMicros:cpu.user+cpu.system,replayBudgetMs:REPLAY_BUDGET_MS,modelCalls:0,providerSpend:0},
      measuredValue:use?.promotion?recordValue(use,output,trace,wallMs,interrupted,ledger):{
        qualifiedConvergences:0,originalOptimizationCostMs:wallMs,measuredNetMs:-wallMs,
      }};
    put(path.join(reportDir,'assessment.json'),report);
    let entries=null;
    if(ledger){
      // The report is recorded only if it re-derives from the trace entry it cites (the ledger refuses it otherwise).
      const assessed=ledger.assessed(
        {trace:ledgerTrace,report,retained:retainedEntry,debit:report.measuredValue.ledger?.debit??null});
      const retained=retainMarker?ledger.retained({assessed,marker:retainMarker}):null;
      entries={trace:ledgerTrace,assessed,...retained?{retained}:{}};
    }
    return {
      schema:REPORT_SCHEMA,outcome:report.outcome,reason:report.reason,traceSha,scopeSha:trace.scopeSha,boardCommit,
      reportFile:path.join(reportDir,'assessment.json'),
      ...entries?{ledger:entries}:{}};
  };
  if(blocker){
    admit({...admissionInputs,blocker},performance.now(),process.cpuUsage());
    return finish({reason:blocker});
  }
  const scopeDir=registryDir(directory(root),trace.scopeSha);
  return withSeatLock('efficiency',async()=>{
    const gateStarted=performance.now(),gateCpu=process.cpuUsage();
    try {binding=verifyAdmissionTrace(trace,snapshot);}
    catch(error){
      const reason='admission-trace-held';
      admit({...admissionInputs,blocker:reason},gateStarted,gateCpu);
      return finish({reason,detail:String(error.message).slice(0,500)});
    }
    const marker=path.join(scopeDir,'experiment.json');
    if(exists(marker)){
      let priorOutcome;
      try {
        // With a ledger the prior experiment is read from its `efficiency.retained` entry, not the marker's files.
        if(ledger)({retained:retainedEntry,priorOutcome}=ledger.retainedFor({marker:read(marker),trace}));
        else priorOutcome=readRetainedExperiment(marker,trace);
      }
      catch(error){
        const reason='retained-experiment-held';
        admit({...admissionInputs,blocker:reason},gateStarted,gateCpu);
        return finish({reason,priorMarker:marker,detail:String(error.message).slice(0,500)});
      }
      const decision=admit({...admissionInputs,priorOutcome},gateStarted,gateCpu);
      return finish({reason:decision.reason,priorMarker:marker});
    }
    const decision=admit(admissionInputs,gateStarted,gateCpu);
    if(!decision.admitted)return finish({reason:decision.reason});
    await investigate();
    const evidenceRoot=directory(path.join(reportDir,'experiment'));
    retainMarker={schema:VERSION,traceSha,evidenceRoot,fromSlots:1,toSlots:3};
    put(marker,retainMarker);
    const alternative={
      schema:'ophanim.scheduler-policy/v1',scopeSha:trace.scopeSha,baselineSlots:1,slots:3,baselineRelease:'baseline',
      workerArtifactSha:scope.configuration.workerArtifactSha,policySha:scope.configuration.policySha,
      stateSchema:STATE_SCHEMA,maxQualifiedConvergences:MAX_QUALIFIED_CONVERGENCES};
    try {
      const {evaluateScheduler}=await import('./replay.mjs');
      const replay=await evaluateScheduler(
        {outputDir:evidenceRoot,request:replayRequest,baselineSlots:1,candidateSlots:3,
          repeats:3,budgetMs:REPLAY_BUDGET_MS,originalResult:output,originalStateDir:stateDir,
          scopeSha:trace.scopeSha,trace});
      const experiment={
        manifestFile:replay?.manifestFile??null,evidenceSha:replay?.evidenceSha??null,
        measurements:replay?.measurements??null};
      if(!replay||replay.ok!==true)
        return finish({reason:replay?.reason??'replay-incomplete',alternative,evidenceRoot,experiment});
      const candidate={...alternative,evidenceSha:replay.evidenceSha,originalResultSha:replay.originalResultSha};
      const checked=await governance.verifyEfficiencyCandidate({candidate,evidenceRoot});
      if(checked?.ok!==true)
        return finish(
          {reason:checked?.reason??'independent-qualification-refused',alternative,evidenceRoot,experiment,
          qualification:checked?.efficiency??null});
      // Forecast net saving = qualified saving per run x horizon - assessment cost so far - rollout reserve.
      // Checked before the decision is signed and again after it, with the full assessment cost.
      const horizon=decision.forecast.expectedQualifiedConvergences;
      const rolloutReserveMs=decision.estimates.rolloutReserveMs;
      const grossSavedMs=checked.efficiency.conservativeSavedMs*horizon;
      const economics=()=>{
        const assessmentCostMs=Math.max(0,now()-startedAt);
        return {
          horizon,rolloutReserveMs,grossSavedMs,assessmentCostMs,
          forecastNetSavedMs:grossSavedMs-assessmentCostMs-rolloutReserveMs};
      };
      const beforeAuthorization=economics();
      if(beforeAuthorization.forecastNetSavedMs<=0)
        return finish(
          {reason:'nonpositive-forecast-before-authorization',alternative,evidenceRoot,experiment,
          qualification:checked.efficiency,economics:beforeAuthorization});
      const expected={
        planRef:checked.planRef,policy:candidate,scopeSha:trace.scopeSha,fromSlots:1,toSlots:3,release:'baseline',
        evidenceRefs:checked.evidenceRefs};
      const signedDecision=await governance.issueEfficiencyDecision(expected);
      const authorization=await governance.verifyEfficiencyDecision({decision:signedDecision,expected});
      if(authorization?.ok!==true)throw Error('Efficiency activation authorization refused');
      const value=economics();
      if(value.forecastNetSavedMs<=0)
        return finish(
          {reason:'nonpositive-forecast-after-full-assessment-cost',alternative,evidenceRoot,experiment,
          qualification:checked.efficiency,economics:value});
      const totalAssessmentCostMs=value.assessmentCostMs;
      const efficiency={...checked.efficiency,totalAssessmentCostMs,realizedNetSavedMs:-totalAssessmentCostMs};
      // On the ledger first: a promotion the ledger refuses is not written as a file either.
      const ledgerPromotion=ledger?.promotion(
        {scopeSha:expected.scopeSha,decisionId:authorization.decisionId,efficiency});
      put(path.join(scopeDir,'promotion.json'),
        {schema:VERSION,authorityRoot:stateDir,expected,decision:signedDecision,efficiency,economics:value});
      return finish(
        {outcome:'promoted',reason:'independently-authorized-slot-policy',alternative,evidenceRoot,experiment,
          efficiency,economics:value,decisionId:authorization.decisionId,
          authorization:{expected,decision:signedDecision},
          ...ledgerPromotion?{ledgerPromotion}:{}});
    }catch(error){
      return finish({reason:'experiment-held',detail:String(error.message).slice(0,500),alternative,evidenceRoot});
    }
  },{dir:scopeDir,timeoutMs:60000});
}

// The assessment retained for an unchanged head is the assessment of this run.
export function reusedEfficiencyRecord({stateDir,boardCommit,output,ledger=null}) {
  const reportFile=path.join(stateDir,'efficiency','convergences',boardCommit.replace(':','-'),'assessment.json');
  if(!exists(reportFile))throw Error('Reused convergence has no retained efficiency assessment');
  const assessment=read(reportFile);
  const record={
    schema:assessment.schema,outcome:assessment.outcome,reason:assessment.reason,traceSha:assessment.traceSha,
    scopeSha:assessment.scopeSha,boardCommit,reportFile};
  verifyEfficiencyRecord({stateDir,record,output});
  // At equilibrium the reused record names the same ledger entries the fresh one did; it records nothing new.
  if(ledger){
    verifiedLedger(ledger);
    const entries=ledger.entriesFor?.(assessment.traceSha)??null;
    if(entries)record.ledger=entries;
  }
  return record;
}

// Verify a returned efficiency record against the files it names: the report must be at its canonical
// path, match the record's schema, trace and outcome, and re-derive (rederiveAssessment); a debit it
// names must be this trace's valid debit. Returns the assessment.
export function verifyEfficiencyRecord({stateDir,record,output}) {
  const reportFile=path.resolve(record.reportFile);
  const reportDir=path.join(stateDir,'efficiency','convergences',record.boardCommit.replace(':','-'));
  const expected=path.join(reportDir,'assessment.json');
  if(reportFile!==expected||fs.realpathSync(reportFile)!==expected)throw Error('Efficiency report path differs');
  const assessment=read(reportFile),trace=read(path.join(reportDir,'trace.json'));
  if(record.schema&&record.schema!==assessment.schema)throw Error('Efficiency assessment schema differs');
  if(digest(trace)!==record.traceSha||trace.scopeSha!==record.scopeSha||assessment.outcome!==record.outcome)
    throw Error('Efficiency evidence differs from the accepted board');
  rederiveAssessment(
    {assessment,trace,snapshot:readRuntimeSnapshot(stateDir,record.boardCommit),boardCommit:record.boardCommit,
      reportDir,output,
      priorOutcome:()=>readRetainedExperiment(assessment.priorMarker,trace)});
  const debitRecord=assessment.measuredValue?.debitRecord;
  if(debitRecord!==undefined){
    const debit=read(debitRecord);
    if(path.basename(debitRecord)!==`debit-${assessment.traceSha}.json`||!validDebit(debit,assessment.traceSha))
      throw Error('Efficiency debit differs from the assessment');
  }
  return assessment;
}

// The trace is bound to the accepted board snapshot it names: its state digest, acceptance evidence and
// scope fingerprint, and its analysis re-runs. Shared by the file verifier and the `efficiency.trace` kind.
export function traceBinding(trace,snapshot) {
  if(trace?.schema!=='ophanim.efficiency.trace/v1'||!snapshot?.state||trace.boardCommit!==snapshot.commit||
    trace.stateSha!==digest(snapshot.state)||
    canonical(trace.accepted)!==canonical(acceptanceEvidence(snapshot.state))||
    trace.scopeSha!==applicabilityFingerprint({obligations:trace.obligations,configuration:trace.configuration}))
    throw Error('Efficiency evidence differs from the accepted board');
  analyzeTrace(trace);
}

// A held investigation receipt is what assessConvergence records when recordInvestigation throws. It is
// accepted only bound to this trace, in the exact shape that catch writes, and only where the decision
// depends on retained evidence: a decision that needs none is a pure function of the trace, so a held
// receipt in its place is a substitution, not an outcome a run can produce.
const HELD='ophanim.investigation-blocked/v1';
function verifyHeldInvestigation({receipt,trace,registry,variables,workload,traceTrusted}) {
  if(!exactKeys(receipt,['schema','scopeSha','traceSha','boardCommit','reason','detail'])||
    receipt.scopeSha!==trace.scopeSha||
    receipt.traceSha!==digest(trace)||receipt.boardCommit!==trace.boardCommit||
    receipt.reason!=='investigation-evidence-unavailable'||
    typeof receipt.detail!=='string'||receipt.detail.length>256)
    throw Error('Held investigation receipt differs from the retained trace');
  let obtainable=false;
  try{obtainable=investigationWithoutEvidence({trace,registry,variables,workload,traceTrusted})!==null;}catch{}
  if(obtainable)throw Error('Held investigation receipt replaces a decision that needs no retained evidence');
}

/**
 * Re-derive an assessment report from its trace and the accepted board snapshot, without reading either
 * from a path: the computation verifyEfficiencyRecord runs on the retained files and the
 * `efficiency.assessed` ledger kind runs on the cited trace entry. `priorOutcome()` supplies the retained
 * experiment the admission read (from the marker file, or from the cited `efficiency.retained` entry).
 */
export function rederiveAssessment(
  {assessment,trace,snapshot,boardCommit=trace.boardCommit,reportDir,output,priorOutcome}) {
  if(![VERSION,ADMISSION_SCHEMA,REPORT_SCHEMA].includes(assessment?.schema))
    throw Error('Efficiency assessment schema differs');
  if(digest(trace)!==assessment.traceSha||trace.stateSha!==digest(snapshot.state)||
    trace.scopeSha!==assessment.scopeSha||
    canonical(trace.accepted)!==canonical(acceptanceEvidence(snapshot.state)))
    throw Error('Efficiency evidence differs from the accepted board');
  // Bind the trace to the runtime result it claims to describe.
  if(output?.reusedConvergence){
    // An equilibrium run binds to the head it found, not to a new observation.
    if(output.reusedConvergence.boardCommit!==boardCommit||output.dispatches!==0||
      !['no_change','blocked'].includes(output.convergence)||
      snapshot.state.events.at(-1)?.type!=='runtime.settled'||output.stateRevision!==snapshot.state.revision||
      trace.original.outputSha!==digest(output.outputs)||
      trace.original.effectSha!==digest(effectSummary(output.effects)))
      throw Error('Reused convergence differs from the accepted board');
  }else if(
    output&&(trace.original.outputSha!==digest(output.outputs)||
      trace.original.effectSha!==digest(effectSummary(output.effects))||
      trace.original.durationMs!==output.durationMs||trace.original.convergence!==output.convergence||
      trace.original.slots!==output.slots))throw Error('Efficiency observation differs from the runtime result');
  if(canonical(assessment.analysis)!==canonical(analyzeTrace(trace)))
    throw Error('Efficiency analysis differs from retained trace');
  if([ADMISSION_SCHEMA,REPORT_SCHEMA].includes(assessment.schema)){
    const analysis=assessment.analysis;
    const registry=buildContributionRegistry({trace,analysis});
    const variables=discoverVariables({trace,analysis,registry});
    const {inputs,decision,cost,binding}=assessment.admission??{};
    if(!inputs||!decision||!cost)throw Error('Optimization admission receipt required');
    if(Object.keys(inputs).some(key=>!['blocker','priorOutcome','expectedQualifiedConvergences'].includes(key)))
      throw Error('Unexpected optimization admission input');
    // The gate computed a binding whenever there was no blocker; a retained binding must re-derive.
    if((!inputs.blocker||binding)&&canonical(binding)!==canonical(verifyAdmissionTrace(trace,snapshot)))
      throw Error('Optimization trace binding differs');
    if(inputs.priorOutcome&&canonical(inputs.priorOutcome)!==canonical(priorOutcome()))
      throw Error('Retained optimization evidence differs');
    // Registry, variables and decision must re-derive; the cost must be a plausible measurement; and a
    // decision that did not admit must come with no experiment and the decision's own no_change reason.
    if(canonical(registry)!==canonical(assessment.contributionRegistry)||
      canonical(variables)!==canonical(assessment.variables)||
      canonical(decision)!==canonical(screen({trace,analysis,inputs}))||
      !Number.isFinite(cost.wallMs)||cost.wallMs<0||
      !Number.isInteger(cost.controllerCpuMicros)||cost.controllerCpuMicros<0||
      (!decision.admitted&&
        (assessment.experiment||assessment.evidenceRoot||assessment.outcome!=='no_change'||
          assessment.reason!==decision.reason)))
      throw Error('Optimization admission differs from retained trace');
    if(assessment.schema===REPORT_SCHEMA){
      const receipt=assessment.investigation;
      const workload=inputs.expectedQualifiedConvergences??1,
        traceTrusted=binding?.complete||boundAcceptedTrace(trace,snapshot);
      if(receipt?.schema===HELD)verifyHeldInvestigation({receipt,trace,registry,variables,workload,traceTrusted});
      else{
        if(receipt?.workload!==workload)throw Error('Investigation workload forecast differs');
        verifyInvestigationReceipt({receipt,trace,registry,variables,traceTrusted});
      }
    }
  }
  if(assessment.experiment?.manifestFile){
    const manifest=path.join(reportDir,'experiment','manifest.json');
    if(assessment.experiment.manifestFile!==manifest||fs.realpathSync(manifest)!==manifest||
      createHash('sha256').update(fs.readFileSync(manifest)).digest('hex')!==assessment.experiment.evidenceSha)
      throw Error('Efficiency replay manifest differs');
  }
  return assessment;
}
