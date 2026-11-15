// Cheap pure screening for a bounded experiment, never scheduler authority.
// The caller verifies any retained prior proof before passing priorOutcome.
// No filesystem, provider, clock, worker, or replay operation occurs here.
import {createHash} from 'node:crypto';
import {analyzeTrace} from './analyze.mjs';

const MAX_CONVERGENCES=20,REPLAY_BUDGET_MS=30000,UNCERTAINTY_FLOOR=0.25;
const ROLLOUT_RESERVE_MS=500;
const RECIPE=Object.freeze({fromSlots:1,toSlots:3});
const compare=(a,b)=>a<b?-1:a>b?1:0;
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const requireThat=(condition,message)=>{if(!condition)throw Error(message);};
function canonical(value){
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort(compare).map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  throw Error('Finite JSON admission evidence required');
}
export const admissionDigest=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function optimizationRecipeSha(recipe=RECIPE){
  requireThat(canonical(recipe)===canonical(RECIPE),'Only the slot-width 1 to 3 recipe is screened');
  return admissionDigest(recipe);
}
export const baselineEvidenceSha=trace=>{
  requireThat(hex(trace?.original?.outputSha)&&hex(trace?.original?.effectSha),'Exact accepted output and effect hashes required');
  return admissionDigest({outputSha:trace.original.outputSha,effectSha:trace.original.effectSha});
};
const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*0.95)-1];
const sum=values=>values.reduce((total,value)=>total+value,0);
const limits=Object.freeze({replays:0,modelCalls:0,policyAuthorization:false,providerBenefitEstimate:false,monetaryGainEstimate:false,forecastOnly:true,maxQualifiedConvergences:MAX_CONVERGENCES,replayBudgetMs:REPLAY_BUDGET_MS});

function acceptedMeasurements(trace,analysis){
  requireThat(analysis.applicability.complete&&analysis.applicability.fingerprint===trace.scopeSha,'Exact complete applicability binding required');
  requireThat(trace.release?.id==='baseline'&&trace.original?.convergence==='accepted_change'&&trace.original.slots===1&&trace.original.modelCalls===0&&analysis.configuration.slots===1,'Fresh accepted local baseline at width one required');
  requireThat(analysis.obligations.total>=2&&analysis.obligations.total<=18&&analysis.obligations.unaccepted===0&&analysis.criticalPath.status==='observed'&&analysis.criticalPath.missing.length===0&&analysis.scheduling.unmeasuredWaits.length===0,'Complete bounded accepted worker timings required');
  requireThat(analysis.retries.observedRetryAttempts===0&&trace.attempts.length===analysis.obligations.total&&trace.verifications.every(v=>v.ok===true)&&analysis.verification.acceptCalls===analysis.obligations.total&&analysis.verification.replayCalls===0,'Uninterrupted baseline with all independent checks measured required');
  requireThat(finite(trace.original.durationMs)&&Math.abs(trace.original.durationMs-analysis.window.durationMs)<=2,'Baseline wall-clock observation differs');
  requireThat(trace.policy?.replayBudgetMs===REPLAY_BUDGET_MS&&trace.policy.maxQualifiedConvergences===MAX_CONVERGENCES&&admissionDigest(trace.policy)===trace.configuration.policySha,'Fixed experiment authority limits and policy required');
  const byId=new Map(trace.obligations.map(row=>[row.id,row])),work=new Map(),checks=new Map(),paths=new Map(),stage=[];
  for(const attempt of trace.attempts){
    const row=byId.get(attempt.id);
    requireThat(row.acceptedAttempt===attempt.attempt&&finite(row.acceptedAt)&&row.acceptedAt>=attempt.endedAt,'Exact accepted worker attempt required');
    work.set(attempt.id,attempt.endedAt-attempt.startedAt);
    stage.push(row.acceptedAt-attempt.startedAt);
  }
  for(const check of trace.verifications)checks.set(check.id,(checks.get(check.id)??0)+check.endedAt-check.startedAt);
  function longest(id){
    if(paths.has(id))return paths.get(id);
    const value=work.get(id)+Math.max(0,...byId.get(id).dependsOn.map(longest));paths.set(id,value);return value;
  }
  const workerMs=sum([...work.values()]),workerCriticalPathMs=Math.max(...byId.keys().map(longest));
  const baselineWallMs=trace.original.durationMs,requiredVerificationMs=analysis.verification.totalMs;
  requireThat(workerMs<=baselineWallMs+2&&analysis.scheduling.maxConcurrentWorkers<=1,'Single-slot measured worker work exceeds baseline window');
  const parallelWorkerLowerBoundMs=Math.max(workerCriticalPathMs,workerMs/3);
  return {baselineWallMs,workerMs,workerCriticalPathMs,parallelWorkerLowerBoundMs,
    upperOpportunityMs:Math.max(0,Math.min(workerMs-parallelWorkerLowerBoundMs,baselineWallMs)),
    observedNonWorkerMs:Math.max(0,baselineWallMs-workerMs),requiredVerificationMs,
    baselineP95Ms:p95(stage),maximumAcceptanceCheckMs:Math.max(...checks.values()),acceptedObligations:analysis.obligations.total,
    interpretation:'Observed worker durations, checks and accepted dependency paths. The opportunity is an upper bound, not measured scheduler savings.'};
}

function priorFor(prior,scopeSha,recipeSha,baselineSha){
  if(prior===null||prior===undefined)return {applicable:false};
  requireThat(prior.verified===true&&hex(prior.scopeSha)&&hex(prior.recipeSha)&&hex(prior.baselineEvidenceSha)&&hex(prior.evidenceSha),'Externally verified retained prior binding required');
  if(prior.scopeSha!==scopeSha||prior.recipeSha!==recipeSha||prior.baselineEvidenceSha!==baselineSha)return {applicable:false,ignoredReason:'prior-scope-recipe-or-accepted-baseline-differs'};
  requireThat(prior.outcome==='no_change'||prior.outcome==='promoted','Known retained outcome required');
  requireThat(Array.isArray(prior.blockers)&&prior.blockers.every(x=>typeof x==='string'&&x.length<=1024),'Bounded retained blockers required');
  const measured=prior.measured;
  for(const key of ['baselineConservativeMs','candidateConservativeMs','trialCostMs','assessmentCostMs'])requireThat(finite(measured?.[key]),'Finite retained measurement required: '+key);
  for(const key of ['conservativeSavedMs','forecastGrossSavedMs','forecastNetSavedMs'])requireThat(typeof measured[key]==='number'&&Number.isFinite(measured[key]),'Finite retained value required: '+key);
  requireThat(Math.abs(measured.conservativeSavedMs-(measured.baselineConservativeMs-measured.candidateConservativeMs))<=2&&Math.abs(measured.forecastGrossSavedMs-measured.conservativeSavedMs*20)<=2&&Math.abs(measured.forecastNetSavedMs-(measured.forecastGrossSavedMs-measured.trialCostMs))<=2,'Retained forecast does not reconcile to measurements');
  return {applicable:true,prior};
}

function hasMaterialNewCondition({evidence,prior,trace,recipeSha,baselineSha,measurements,predictedSavingMs}){
  if(!evidence)return false;
  requireThat(evidence.verified===true&&hex(evidence.evidenceSha)&&evidence.evidenceSha!==prior.evidenceSha&&evidence.scopeSha===trace.scopeSha&&evidence.recipeSha===recipeSha&&evidence.baselineEvidenceSha===baselineSha&&evidence.traceSha===admissionDigest(trace),'New condition needs externally verified exact applicable trace evidence');
  const condition=evidence.condition;
  requireThat(condition?.kind==='execution-environment'&&hex(condition.previousSha)&&hex(condition.currentSha)&&condition.previousSha!==condition.currentSha,'A changed execution condition is required; timing noise alone is insufficient');
  // A changed host label alone is also insufficient. Require a material new
  // opportunity after uncertainty, beyond the old measured opportunity.
  const improvement=predictedSavingMs-Math.max(0,prior.measured.conservativeSavedMs);
  return improvement>=Math.max(100,prior.measured.baselineConservativeMs*0.25)&&measurements.upperOpportunityMs>=measurements.baselineWallMs*0.1;
}

export function assessOptimizationAdmission(input={}){
  const base={schema:'ophanim.optimization-admission/v1',admitted:false,outcome:'no_change',...limits};
  try{
    const {trace,analysis:suppliedAnalysis,recipe=RECIPE,expectedQualifiedConvergences=1,estimates={},priorOutcome=null,newEvidence=null}=input;
    const recipeSha=optimizationRecipeSha(recipe);
    requireThat(Number.isInteger(expectedQualifiedConvergences)&&expectedQualifiedConvergences>=1&&expectedQualifiedConvergences<=MAX_CONVERGENCES,'Expected exact-scope workload must be an explicit integer from one to twenty');
    requireThat(estimates&&typeof estimates==='object'&&!Array.isArray(estimates)&&Object.keys(estimates).every(key=>['trialAndVerificationMs','approvalAndRolloutMs','relativeUncertainty','regressionAllowanceMs','processStartupMs','source'].includes(key)),'Unknown optimization estimate or authority control');
    for(const [key,value]of Object.entries(estimates))if(key!=='source')requireThat(finite(value),'Finite nonnegative estimate required: '+key);
    if(estimates.source!==undefined)requireThat(typeof estimates.source==='string'&&estimates.source.length>0&&estimates.source.length<=256,'Bounded estimate source tag required');
    if(estimates.relativeUncertainty!==undefined)requireThat(estimates.relativeUncertainty>=UNCERTAINTY_FLOOR&&estimates.relativeUncertainty<=0.75,'Uncertainty cannot weaken the fixed conservative floor');
    const analysis=analyzeTrace(trace);
    if(suppliedAnalysis!==undefined)requireThat(canonical(suppliedAnalysis)===canonical(analysis),'Supplied analysis differs from measured trace');
    const measurements=acceptedMeasurements(trace,analysis),baselineSha=baselineEvidenceSha(trace);
    const retained=priorFor(priorOutcome,trace.scopeSha,recipeSha,baselineSha);
    const uncertainty=estimates.relativeUncertainty??UNCERTAINTY_FLOOR;
    const regressionAllowanceMs=Math.max(25,measurements.requiredVerificationMs*0.1,estimates.regressionAllowanceMs??0);
    const predictedSavingMs=Math.max(0,measurements.upperOpportunityMs*(1-uncertainty)-regressionAllowanceMs);
    const predictedCandidateMs=measurements.baselineWallMs-predictedSavingMs;
    const processStartupMs=Math.max(1900,estimates.processStartupMs??0); // ten worker segments + nine verifier processes
    const trialModelMs=4.5*(measurements.baselineWallMs+predictedCandidateMs)+9*measurements.requiredVerificationMs+processStartupMs;
    const priorTrialMs=retained.applicable?retained.prior.measured.trialCostMs:0;
    const priorApprovalMs=retained.applicable?Math.max(0,retained.prior.measured.assessmentCostMs-priorTrialMs):0;
    const trialAndVerificationMs=Math.max(trialModelMs,priorTrialMs,estimates.trialAndVerificationMs??0);
    // Post-replay verification can recheck the original and eight trials in
    // multiple TELOS phases. Charge this forecast up front and use the
    // observed phase cost once those checks have completed.
    const postReplayFloorMs=Math.max(ROLLOUT_RESERVE_MS+27*measurements.requiredVerificationMs,priorApprovalMs);
    const approvalAndRolloutMs=Math.max(postReplayFloorMs,estimates.approvalAndRolloutMs??0);
    const rolloutReserveMs=ROLLOUT_RESERVE_MS+approvalAndRolloutMs-postReplayFloorMs;
    const totalCostMs=trialAndVerificationMs+approvalAndRolloutMs;
    const predictedP95Ms=measurements.baselineP95Ms+2*measurements.maximumAcceptanceCheckMs+regressionAllowanceMs/measurements.acceptedObligations;
    const p95CeilingMs=measurements.baselineP95Ms*1.25+25;
    const forecastGrossSavedMs=expectedQualifiedConvergences*predictedSavingMs,forecastNetSavedMs=forecastGrossSavedMs-totalCostMs;
    const blockers=[];
    if(predictedSavingMs<100||predictedSavingMs<measurements.baselineWallMs*0.1)blockers.push('insufficient-conservative-parallel-opportunity');
    if(predictedP95Ms>p95CeilingMs)blockers.push('estimated-stage-regression-exceeds-final-gate-allowance');
    if(trialAndVerificationMs>REPLAY_BUDGET_MS)blockers.push('controlled-replay-estimate-exceeds-fixed-budget');
    if(forecastNetSavedMs<=0)blockers.push('forecast-does-not-cover-trial-and-approval-cost');
    if(retained.applicable){
      if(retained.prior.outcome==='promoted')blockers.push('reuse-existing-authority-without-another-experiment');
      else if(!hasMaterialNewCondition({evidence:newEvidence,prior:retained.prior,trace,recipeSha,baselineSha,measurements,predictedSavingMs}))blockers.push('retained-outcome-has-no-materially-new-applicable-condition');
    }else if(newEvidence)blockers.push('new-condition-without-matching-verified-prior');
    const estimated={relativeUncertainty:uncertainty,regressionAllowanceMs,predictedSavingMs,predictedCandidateMs,predictedP95Ms,p95CeilingMs,processStartupMs,trialModelMs,trialAndVerificationMs,approvalAndRolloutMs,rolloutReserveMs,totalCostMs,
      sources:{timing:'retained-baseline-trace',uncertainty:'fixed-floor-or-more-conservative-caller-estimate',trialCost:priorTrialMs?'maximum-of-fixed-model-and-verified-prior-cost':'fixed-three-pair-recovery-and-verification-model',caller:estimates.source??null},
      interpretation:'Cheap estimates only. Required checks and observed non-worker time remain; this does not predict a verified performance result.'};
    return {...base,admitted:blockers.length===0,outcome:blockers.length?'no_change':'admit',reason:blockers[0]??'plausible-bounded-experiment',blockers,scopeSha:trace.scopeSha,recipeSha,baselineEvidenceSha:baselineSha,traceSha:admissionDigest(trace),measurements,estimates:estimated,
      forecast:{expectedQualifiedConvergences,workloadSource:Object.hasOwn(input,'expectedQualifiedConvergences')?'explicit-caller-exact-scope-estimate':'default-single-convergence',grossSavedMs:forecastGrossSavedMs,netSavedMs:forecastNetSavedMs,realizedSavedMs:0,conditional:true},
      prior:retained.applicable?{applicable:true,evidenceSha:retained.prior.evidenceSha,outcome:retained.prior.outcome,retainedBlockers:retained.prior.blockers,measured:retained.prior.measured}:{applicable:false,...retained.ignoredReason?{ignoredReason:retained.ignoredReason}:{}},
    };
  }catch(error){return {...base,reason:'invalid-or-incomplete-admission-evidence',blockers:[String(error.message)]};}
}
