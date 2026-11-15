import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {canonical, digest, readRuntimeSnapshot} from '../../board.mjs';
import {createPlanning, createWorkers, makeFixtures} from '../../fixtures.mjs';
import {efficiencyScope} from '../assessment.mjs';
import {planInvestigation} from './controller.mjs';
import {openLatencyModelEvidence} from './verify.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const effectProjection=effects=>effects.map(({key,payload})=>({key,payload})).sort((a,b)=>a.key.localeCompare(b.key));
const metadata=workers=>workers.map(({id,version,kinds,scopes})=>({id,version,kinds,scopes})).sort((a,b)=>a.id.localeCompare(b.id));
const eventValue=({sequence,...event})=>event;

function exactResult({source,files}) {
  const file=source.resultFile;
  const stat=fs.lstatSync(file);
  assert.ok(stat.isFile()&&stat.size<=8*1024*1024&&fs.realpathSync(file)===file,'Bounded canonical paired result required');
  const bytes=fs.readFileSync(file);
  assert.equal(hash(bytes),files.resultSha,'Paired result changed after independent verification');
  return JSON.parse(bytes);
}

function reconstructScope(probe) {
  const [baseline]=probe.rows,{batches,maxDispatches,workerOptions:overrides}=probe.request;
  const fixtures=batches.map(makeFixtures);
  const workerOptions={department:fixtures[0].department,departments:[...new Set(fixtures.map(fixture=>fixture.department))].sort(),
    version:'synthetic-v1',delayMs:15,...overrides};
  const registry=metadata(createWorkers(workerOptions));
  const artifact={schema:'ophanim.synthetic-worker-artifact/v1',sourceSha:hash(fs.readFileSync(new URL('../../fixtures.mjs',import.meta.url))),
    options:workerOptions,workers:registry};
  const request={batches,maxDispatches,workerOptions};
  const scope=efficiencyScope({obligations:fixtures.flatMap(fixture=>fixture.obligations),planning:createPlanning({batches}),
    workerArtifactSha:digest(artifact),registry,request,slots:baseline.slots});
  assert.equal(scope.scopeSha,probe.scopeSha,'Reconstructed fixture scope differs from the verified pair');
  assert.equal(scope.configuration.policySha,baseline.policySha,'Reconstructed pinned policy differs');
  assert.equal(scope.configuration.workerArtifactSha,baseline.workerArtifactSha,'Reconstructed worker artifact differs');
  return scope;
}

function reconstructTrace(probe) {
  const [baseline]=probe.rows;
  assert.equal(baseline.slots,1);
  const result=exactResult(baseline),scope=reconstructScope(probe);
  const {state,commit}=readRuntimeSnapshot(baseline.source.stateDir,baseline.boardCommit);
  assert.equal(digest(state),baseline.stateSha,'Paired snapshot changed after independent verification');
  assert.equal(digest(result.outputs),baseline.outputSha);
  assert.equal(digest(effectProjection(result.effects)),baseline.effectSha);
  const rows=new Map(baseline.stages.map(row=>[row.id,row]));
  const obligations=scope.graph.map(row=>{
    const stage=rows.get(row.id),stored=state.obligations[row.id];
    assert.ok(stage&&stored&&stored.status==='accepted'&&stored.accepted.attempt===stage.attempt);
    assert.equal(digest(stored.spec),row.specSha);
    return {...row,status:stored.status,acceptedAt:stage.acceptedAt,acceptedAttempt:stage.attempt};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const accepted=obligations.map(row=>{
    const stored=state.obligations[row.id];
    return {id:row.id,specSha:row.specSha,outputSha:stored.accepted.sha256,planRef:stored.accepted.planRef,
      evidenceRefs:stored.accepted.verification?.evidenceRefs??[],publication:stored.candidate.published};
  });
  const attempts=obligations.map(row=>{
    const stage=rows.get(row.id),{expected,...obligation}=state.obligations[row.id].spec;
    const dependencies=Object.fromEntries(row.dependsOn.map(id=>{
      const value=state.obligations[id].accepted;
      return [id,{output:value.output,sha256:value.sha256}];
    }));
    const inputs={...obligation.inputs,dependencies};
    return {id:row.id,attempt:stage.attempt,startedAt:stage.startedAt,endedAt:stage.persistedAt,status:'produced',
      inputSha:digest(inputs),inputBytes:Buffer.byteLength(canonical(inputs)),
      contextBytes:Buffer.byteLength(canonical({obligation,inputs,priorAttempts:stage.attempt-1}))};
  });
  assert.equal(attempts.reduce((sum,row)=>sum+row.contextBytes,0),baseline.contextBytes,'Reconstructed context differs from verified input bytes');
  return {schema:'ophanim.efficiency.trace/v1',boardCommit:commit,stateSha:baseline.stateSha,scopeSha:scope.scopeSha,
    configuration:scope.configuration,policy:scope.policy,release:state.releases.baseline,obligations,accepted,attempts,
    events:state.events.map(eventValue),verifications:[],window:{startedAt:result.startedAt,endedAt:result.endedAt},
    original:{convergence:result.convergence,slots:baseline.slots,outputSha:baseline.outputSha,effectSha:baseline.effectSha,
      durationMs:baseline.durationMs,modelCalls:0,measurements:{stageP95Ms:baseline.stageP95Ms,acceptedStageSamples:baseline.stages.length,
        workerContextBytes:baseline.contextBytes,verificationCalls:{verifyCandidate:baseline.verificationCalls}}},
    historicalEvidence:{pairEvidenceSha:probe.evidenceSha,governanceContractSha:baseline.governanceContractSha,
      qualification:'TELOS accepted every node in both isolated runs',workerTiming:'Committed dispatch-to-persistence envelope',
      verificationCalls:'Independently checked',exactVerifierIntervals:'unavailable',recoveryTime:'unavailable'},
  };
}

export async function investigateHistoricalLatency({reportFile,expectedReportSha,telosRoot}={}) {
  const {checked,findings,referencesFor,verifyObservation}=await openLatencyModelEvidence({reportFile,expectedReportSha,telosRoot});
  const probes=checked.probes.map(probe=>{
    const baselineTrace=reconstructTrace(probe);
    const verifiedObservations=referencesFor(probe.scopeSha).filter(reference=>reference.receiptSha===probe.evidenceSha);
    const {models,decision}=planInvestigation({trace:baselineTrace,economics:{},
      findings:findings.filter(finding=>finding.scopeSha===probe.scopeSha&&finding.evidenceSha===probe.evidenceSha),
      verifiedObservations,verifyObservation});
    assert.notEqual(decision.outcome,'blocked',decision.detail??decision.reason);
    assert.equal(decision.selected,null,'Historical paired measurements alone do not establish an economic forecast');
    return {scopeSha:probe.scopeSha,evidenceSha:probe.evidenceSha,baselineTrace,modelSha:models.modelSha,modelBinding:models.evidenceBinding,
      observations:verifiedObservations.map(verifyObservation),selection:decision,
      measurements:{throughputSavedMs:probe.throughputSavedMs,stageP95:probe.stageP95,pairedRows:probe.rows,
        outcomes:probe.outcomes,matchedStageDeltas:probe.matchedStageDeltas,verifiedNodes:probe.verifiedNodes},limitations:probe.unresolved};
  });
  const receipt={schema:'ophanim.historical-latency-investigation/v1',sourceReportSha:checked.sourceReportSha,
    verifiedEvidenceSha:checked.evidenceSha,probes,
    authority:{execution:false,policyActivation:false,modelCalls:0,runtimeDispatches:0,replays:0,effects:0},
  };
  return {...receipt,receiptSha:digest(receipt)};
}
