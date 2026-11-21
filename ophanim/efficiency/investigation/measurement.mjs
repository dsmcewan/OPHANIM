// ophanim/efficiency/investigation/measurement.mjs -- admitting, running and re-verifying a measurement.
//
// Purpose: run the phase-boundary measurement that measurement-plan.mjs proposes, once, under a seat
//   lock and a wall allowance, and retain every step so it can be re-verified later.
//   previewMeasurement only derives the plan. qualifyMeasurement admits the plan, claims the attempt,
//   re-verifies the signed source through the CLI (`investigate --verify-receipt`), runs the
//   synthetic probe, verifies its packet independently and writes the qualification report.
//   verifyMeasurementQualification re-derives all of that from the retained files.
// Inputs:  options: historyFile and expectedSha (the historical receipt), probeIndex, an optional
//   forecast, stateRoot, admissionProofFile, telosRoot, and for verification reportFile and
//   expectedReportSha. Also runnable as `node measurement.mjs plan|qualify|verify --flag value ...`.
// Outputs: evidence under <stateRoot>/scopes/<scopeSha>/measurements/<plan identity>/:
//   admission-<n>.json (each admitted decision, at most MAX_HISTORY), attempt.json (the claim),
//   samples.json (the raw probe packet), qualification.json (the report) or failure.json.
//   Return values report the outcome and always the ZERO counters (no replays, model calls,
//   destination effects or policy authorizations).
// Invariants: every evidence file is a bounded regular file at its canonical absolute path and is
//   published once by hard link (never overwritten); retained admissions must re-derive to exactly
//   the same plan; an existing claim without a report blocks any new attempt (interrupted or failed
//   attempts are retained, not retried); the probe runs only when the plan proposes the
//   phase-boundary method with a calibration, and only within the admitted wall allowance.
// Must never: run a worker outside the frozen synthetic calibration, propose or accept a policy,
//   attribute a historical latency, or overwrite retained evidence.
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {canonical,digest} from '../../board.mjs';
import {makeFixtures} from '../../fixtures.mjs';
import {withSeatLock} from '../../../pantheon/src/seat/lock.mjs';
import {buildFunctionalModels} from './models.mjs';
import {checkHistoricalReceipt,PHASE_METHOD,planMeasurement} from './measurement-plan.mjs';

const REPORT='ophanim.measurement-qualification/v1';
const DECISION='ophanim.measurement-admission/v1';
const ATTEMPT='ophanim.measurement-attempt/v1';
const FAILURE='ophanim.measurement-failure/v1';
// At most this many retained admission decisions per measurement identity (admission-0..7.json).
const MAX_HISTORY=8;
const MAX_BYTES=4*1024*1024;
// Resource counters every outcome reports; a measurement never spends any of them.
const ZERO={replays:0,modelCalls:0,destinationEffects:0,policyAuthorizations:0};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const invoke=promisify(execFile);
const cli=fileURLToPath(new URL('../../cli.mjs',import.meta.url));
const same=(a,b)=>canonical(a)===canonical(b);

function must(condition,message){if(!condition)throw Error(message);}
// Read a JSON evidence file: canonical absolute path, regular file (no symbolic link), within
// `maximum` bytes. Returns the parsed value and the SHA-256 of its raw bytes.
function read(file,maximum=MAX_BYTES){
  must(typeof file==='string'&&path.isAbsolute(file)&&path.resolve(file)===file,
    'Canonical absolute evidence path required');
  const stat=fs.lstatSync(file);
  must(stat.isFile()&&stat.size<=maximum&&fs.realpathSync(file)===file,'Bounded regular evidence file required');
  const bytes=fs.readFileSync(file);
  must(bytes.length<=maximum,'Evidence byte budget exceeded');
  return {value:JSON.parse(bytes),sha:hash(bytes)};
}

// Create (if needed) the private evidence directory and require it to be a real directory at its
// canonical path.
function directory(dir){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  must(fs.lstatSync(dir).isDirectory()&&fs.realpathSync(dir)===dir,'Canonical measurement evidence directory required');
  return dir;
}

// Publish canonical JSON at `file` exactly once: write and fsync a spool file in a private temporary
// directory, hard-link it into place (linkSync fails if `file` already exists), fsync the parent,
// and always remove the spool and temporary directory.
function publish(file,value){
  const dir=path.dirname(file),bytes=canonical(value)+'\n';
  must(Buffer.byteLength(bytes)<=MAX_BYTES,'Measurement receipt exceeds evidence budget');
  const tmp=fs.mkdtempSync(path.join(dir,'.measurement-'));
  const spool=path.join(tmp,'receipt');
  try{
    const fd=fs.openSync(spool,'wx',0o600);
    try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.linkSync(spool,file);
    const parent=fs.openSync(dir,'r');
    try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
  }finally{
    if(fs.existsSync(spool))fs.unlinkSync(spool);
    fs.rmdirSync(tmp);
  }
}

// The historical receipt, checked against its expected digest.
function source(options){
  const {historyFile,expectedSha}=options;
  return checkHistoricalReceipt(read(historyFile).value,expectedSha);
}

// The plan for this receipt and probe given the admission history so far (and a forecast, which
// defaults to the caller's).
function derive(options,receipt,history=[],forecast=options.forecast??null){
  return planMeasurement({receipt,expectedSha:options.expectedSha,probeIndex:options.probeIndex??0,forecast,history});
}

// Replay the retained admissions in order: each must be present without gaps and must re-derive, from
// the history before it and its own recorded forecast, to exactly the plan it recorded. Returns the
// accumulated history entries and the retained admission records.
function decisions(dir,options,receipt){
  const names=fs.readdirSync(dir).filter(name=>/^admission-[0-7]\.json$/.test(name)).sort();
  const history=[],entries=[];
  for(const [index,name] of names.entries()){
    must(name===`admission-${index}.json`,'Measurement admission history is incomplete');
    const entry=read(path.join(dir,name)).value;
    const plan=derive(options,receipt,history,entry.plan.forecast);
    must(entry.schema===DECISION&&same(plan,entry.plan),'Retained measurement decision differs from source evidence');
    history.push(...plan.decision.historyEntries);
    entries.push(entry);
  }
  return {history,entries};
}

// The identity the probe packet must carry: the retained probe's scope and evidence, the exact
// one-slot fixture request it ran, the calibration obligation, and that obligation's accepted output
// and effect digests (both checked against the frozen fixture definition).
function expectedProbe(receipt,plan){
  const retained=receipt.probes[plan.probeIndex];
  const row=retained.measurements.pairedRows[0];
  const request=read(row.source.requestFile,32768);
  must(row.files.requestSha===request.sha&&request.value.slots===1&&request.value.batches?.length===1,
    'Exact accepted one-slot fixture request required');
  const fixture=request.value.batches[0];
  const obligationId=plan.calibration.obligationId;
  const spec=makeFixtures(fixture).obligations.find(value=>value.id===obligationId);
  const accepted=retained.baselineTrace.accepted.find(value=>value.id===obligationId);
  must(spec&&accepted&&accepted.specSha===digest(spec)&&accepted.outputSha===digest(spec.expected),
    'Calibration obligation differs from signed fixture output');
  const acceptedEffects=spec.effectKey?[{key:spec.effectKey,payload:spec.expected}]:[];
  return {scopeSha:retained.scopeSha,sourceSha:retained.evidenceSha,recipeId:plan.identity,methods:[PHASE_METHOD],
    fixture,obligationId,repeats:plan.calibration.repeats,maxWallMs:plan.calibration.maxWallMs,
    acceptedOutputSha:accepted.outputSha,acceptedEffectSha:digest(acceptedEffects)};
}

// Independent source verification: a separate CLI process re-verifies the historical receipt
// against the admission-proof report (with TELOS), within `timeout` ms (at most 30 s).
async function authenticate(options,receipt,timeout){
  must(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=30000,'Read-only verification budget exhausted');
  const {stdout}=await invoke(process.execPath,[cli,'investigate','--historical-report',options.admissionProofFile,
    '--verify-receipt',options.historyFile],
  {timeout,maxBuffer:4096,env:{...process.env,...options.telosRoot?{OPHANIM_TELOS_ROOT:options.telosRoot}:{}}});
  const verification=JSON.parse(stdout);
  must(verification.ok===true&&verification.receiptSha===receipt.receiptSha,
    'Independent TELOS source verification differs');
  return verification;
}

// Fold the verified calibration observations into the functional models of the retained baseline
// trace, keep only the functions they concern, and state what remains unknown. Downstream and
// future-optimization fields record that nothing is proposed from a calibration alone.
function applyObservations(receipt,plan,verification){
  const retained=receipt.probes[plan.probeIndex];
  const observations=verification.observations;
  const resolve=({receiptSha,observationId})=>
    observations.find(value=>value.receiptSha===receiptSha&&value.id===observationId);
  const refs=observations.map(({receiptSha,id})=>({receiptSha,observationId:id}));
  const model=buildFunctionalModels({trace:retained.baselineTrace,verifiedObservations:refs,verifyObservation:resolve});
  const functions=model.functions.filter(fn=>observations.some(observation=>observation.componentId===fn.id));
  return {modelSha:model.modelSha,functions,scope:'isolated synthetic matched interventions',
    historicalAttribution:'unresolved',hypotheses:verification.hypotheses,
    remainingUncertainty:['Historical timer-resume and transformation contributions',
      'Transfer to overlapping workflow dispatch','Future applicable workload and decision-loss estimate'],
    downstream:{historicalStageP95:retained.measurements.stageP95,
      historicalThroughputSavedMs:retained.measurements.throughputSavedMs,
      historicalDependencyPaths:retained.measurements.pairedRows.map(row=>row.dependencyPath),
      calibrationStageP95:null,calibrationRecoveryMs:null},
    futureOptimization:{proposed:false,
      requires:['Natural-run phase evidence in the applicable scope','A supported forecast of downstream value',
        'Independent TELOS acceptance and recovery checks']}};
}

export function previewMeasurement(options){return derive(options,source(options));}

// This entry point runs only the separately requested, frozen synthetic
// calibration. A plan is advisory and never invokes a worker by itself.
export async function qualifyMeasurement(options){
  const started=performance.now(),receipt=source(options),preflight=derive(options,receipt);
  const {stateRoot}=options;
  must(path.isAbsolute(stateRoot)&&path.resolve(stateRoot)===stateRoot,
    'Absolute canonical measurement evidence root required');
  const dir=directory(path.join(stateRoot,'scopes',preflight.applicability.scopeSha,'measurements',preflight.identity));
  return withSeatLock('measurement',async()=>{
    const finalFile=path.join(dir,'qualification.json'),claimFile=path.join(dir,'attempt.json');
    const failureFile=path.join(dir,'failure.json');
    // A finished qualification is returned as retained, never run again.
    if(fs.existsSync(finalFile)){
      const retained=read(finalFile);
      must(retained.value.schema===REPORT&&retained.value.identity===preflight.identity,
        'Retained measurement identity differs');
      return {schema:REPORT,outcome:'retained',reportFile:finalFile,reportSha:retained.sha,executed:false,...ZERO};
    }
    // A claim without a report is an interrupted or failed attempt; it stays for inspection.
    if(fs.existsSync(claimFile)){
      const failed=fs.existsSync(failureFile);
      return {schema:REPORT,outcome:'blocked',
        reason:failed?'measurement-failure-retained':'interrupted-measurement-retained',
        attemptFile:claimFile,...failed?{failureFile}:{},executed:false,...ZERO};
    }
    const {history,entries}=decisions(dir,options,receipt);
    // A proposed admission with no claim means the previous call stopped between the two writes.
    if(entries.at(-1)?.plan.decision.outcome==='proposed'){
      return {schema:REPORT,outcome:'blocked',reason:'interrupted-admission-retained',
        admissionFile:path.join(dir,`admission-${entries.length-1}.json`),executed:false,...ZERO};
    }
    const plan=derive(options,receipt,history);
    const canSample=plan.decision.outcome==='proposed'&&plan.calibration&&
      plan.decision.selected?.design?.method.id===PHASE_METHOD;
    const admissionMs=performance.now()-started;
    // Not admitted: retain the decision (if it adds history and there is room) and stop.
    if(!canSample){
      if(plan.decision.historyEntries.length&&entries.length<MAX_HISTORY)
        publish(path.join(dir,`admission-${entries.length}.json`),{schema:DECISION,plan});
      return {schema:REPORT,outcome:plan.decision.outcome,plan,admissionMs,executed:false,...ZERO};
    }
    if(entries.length>=MAX_HISTORY)
      return {schema:REPORT,outcome:'blocked',reason:'measurement-history-capacity',executed:false,...ZERO};
    // Admit, then claim the attempt (bound to the admission's bytes) before any work starts.
    const admissionFile=path.join(dir,`admission-${entries.length}.json`);
    publish(admissionFile,{schema:DECISION,plan});
    const claim={schema:ATTEMPT,identity:plan.identity,admissionSha:read(admissionFile).sha,
      priorAdmissions:entries.length};
    publish(claimFile,claim);

    // The forecast's investigation estimate is the wall allowance for everything that follows.
    const workStarted=performance.now(),budgetMs=plan.forecast.estimatedInvestigationMs;
    const remaining=()=>Math.floor(budgetMs-(performance.now()-workStarted));
    let phase='signed-source-verification';
    try{
      // Source verification may use the allowance minus what the probe needs.
      const authenticated=await authenticate(options,receipt,remaining()-plan.calibration.maxWallMs);
      const sourceVerificationMs=performance.now()-workStarted;
      const expected=expectedProbe(receipt,plan);
      const {runMeasurementProbe}=await import('./measurement-probe.mjs');
      const {verifyMeasurementProbe}=await import('./measurement-verify.mjs');
      must(remaining()>=plan.calibration.maxWallMs,'Insufficient admitted wall allowance for calibration');
      phase='isolated-calibration';
      const probeStarted=performance.now();
      const packet=await runMeasurementProbe(expected);
      const probeMs=performance.now()-probeStarted;
      const packetFile=path.join(dir,'samples.json');
      publish(packetFile,packet);
      phase='independent-evaluation';
      const verifyStarted=performance.now();
      // Verify the retained bytes, not the in-memory packet.
      const verification=verifyMeasurementProbe({packet:read(packetFile).value,expected:{...expected,
        packetSha:digest(packet)}});
      const model=applyObservations(receipt,plan,verification);
      const independentEvaluationMs=performance.now()-verifyStarted;
      const workMs=performance.now()-workStarted;
      must(workMs<=budgetMs,'Investigation exceeded admitted wall allowance');
      const totalMs=performance.now()-started;
      const {costs,grossInformationValueMs}=plan.decision.selected.value;
      const report={schema:REPORT,identity:plan.identity,outcome:verification.outcome,claim,plan,authenticated,
        packetFile,packetSha:read(packetFile).sha,verification,model,
        cost:{admissionMs,sourceVerificationMs,probeMs,independentEvaluationMs,workMs,totalMs,budgetMs,
          // Forecast information value net of what this investigation and any rollout would cost.
          conditionalNetInformationValueMs:grossInformationValueMs-totalMs-costs.rolloutMs-costs.regressionMs-
            costs.opportunityMs},
        scopeLimit:
          'Forecast applies to the declared qualification scenario only. Historical value remains unquantified.',
        policy:{proposed:[],accepted:[],historicalWideSetting:'refused-stage-p95'},...ZERO};
      publish(finalFile,report);
      return {...report,reportFile:finalFile,reportSha:read(finalFile).sha,executed:true};
    }catch(error){
      // Retain where and why the attempt stopped; the claim then blocks further attempts.
      publish(failureFile,{schema:FAILURE,claim,phase,elapsedMs:performance.now()-workStarted,
        detail:String(error.message).slice(0,256),...ZERO});
      throw error;
    }
  },{dir,timeoutMs:35000});
}

// Re-verify a retained qualification from its files: the report digest, the admission history and
// the claim binding it to exactly one proposed phase-boundary admission, a fresh independent source
// verification, the retained packet bytes, a fresh probe verification and model, and the cost and
// policy accounting. Reads only.
export async function verifyMeasurementQualification(options){
  const receipt=source(options);
  const {value:report,sha:receiptSha}=read(options.reportFile);
  must(sha(options.expectedReportSha)&&options.expectedReportSha===receiptSha,
    'Exact retained qualification digest required');
  must(report.schema===REPORT&&sha(report.identity)&&report.plan?.identity===report.identity,
    'Invalid measurement qualification');
  const dir=path.dirname(options.reportFile),anchored={...options,probeIndex:report.plan.probeIndex};
  const {entries}=decisions(dir,anchored,receipt);
  const claim=read(path.join(dir,'attempt.json')).value;
  const entry=entries[claim.priorAdmissions];
  // The claim must name the last retained admission, which must be the report's proposed plan.
  must(same(claim,report.claim)&&claim.schema===ATTEMPT&&claim.identity===report.identity&&entry&&
    entries.length===claim.priorAdmissions+1&&
    claim.admissionSha===read(path.join(dir,`admission-${claim.priorAdmissions}.json`)).sha&&
    same(entry.plan,report.plan)&&
    entry.plan.decision.outcome==='proposed'&&entry.plan.decision.selected.design.method.id===PHASE_METHOD,
  'Qualification without an exact admitted design');
  const authenticated=await authenticate(options,receipt,30000);
  must(same(authenticated,report.authenticated),'Signed source verification differs');
  const packetFile=path.join(dir,'samples.json');
  const packet=read(packetFile);
  must(report.packetFile===packetFile&&packet.sha===report.packetSha,'Retained measurement bytes differ');
  const expected=expectedProbe(receipt,entry.plan);
  const {verifyMeasurementProbe}=await import('./measurement-verify.mjs');
  const verification=verifyMeasurementProbe({packet:packet.value,expected:{...expected,
    packetSha:digest(packet.value)}});
  const model=applyObservations(receipt,entry.plan,verification);
  must(same(verification,report.verification)&&same(model,report.model)&&verification.outcome===report.outcome,
    'Independent measurement evaluation differs');
  const {costs,grossInformationValueMs}=entry.plan.decision.selected.value;
  const {admissionMs,sourceVerificationMs,probeMs,independentEvaluationMs,workMs,totalMs,budgetMs,
    conditionalNetInformationValueMs}=report.cost;
  // Timings must be non-negative and nest (total >= work + admission, work >= its three phases),
  // work must fit the admitted allowance, and nothing may have been spent or proposed.
  must([admissionMs,sourceVerificationMs,probeMs,independentEvaluationMs,workMs,totalMs]
    .every(value=>Number.isFinite(value)&&value>=0)&&
    budgetMs===entry.plan.forecast.estimatedInvestigationMs&&totalMs>=workMs+admissionMs&&workMs<=budgetMs&&
    workMs>=sourceVerificationMs+probeMs+independentEvaluationMs&&
    conditionalNetInformationValueMs===
      grossInformationValueMs-totalMs-costs.rolloutMs-costs.regressionMs-costs.opportunityMs&&
    Object.entries(ZERO).every(([key,value])=>report[key]===value)&&
    same(report.policy,{proposed:[],accepted:[],historicalWideSetting:'refused-stage-p95'}),
  'Measurement resource or policy boundary differs');
  return {ok:true,receiptSha,identity:report.identity,outcome:verification.outcome,independentSource:authenticated,
    verification,modelSha:model.modelSha,...ZERO};
}

// Command line: plan | qualify | verify, with --history, --receipt-sha, --probe, --forecast,
// --state, --admission-proof, --report and --qualification-sha. Prints the result as JSON.
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [mode,...args]=process.argv.slice(2),flags={};
    for(let i=0;i<args.length;i+=2){
      must(args[i]?.startsWith('--')&&args[i+1]!==undefined,'Measurement flags require values');
      flags[args[i].slice(2)]=args[i+1];
    }
    const options={historyFile:flags.history,expectedSha:flags['receipt-sha'],probeIndex:Number(flags.probe??0),
      forecast:flags.forecast?read(flags.forecast,8192).value:null,stateRoot:flags.state,
        admissionProofFile:flags['admission-proof'],
      reportFile:flags.report,expectedReportSha:flags['qualification-sha']};
    const result=mode==='plan'?previewMeasurement(options)
      :mode==='qualify'?await qualifyMeasurement(options)
        :mode==='verify'?await verifyMeasurementQualification(options)
          :null;
    must(result,'Use measurement.mjs plan, qualify, or verify');
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }catch(error){process.stderr.write(error.stack+'\n');process.exitCode=1;}
}
