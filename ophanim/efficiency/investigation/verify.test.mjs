import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest,readRuntimeSnapshot} from '../../board.mjs';
import {runPairedProbe} from '../admission-proof.mjs';
import {openLatencyModelEvidence,latencyInvestigationFindings,verifyLatencyEvidence,verifyPairedInvestigation,verifyControlledInvestigation} from './verify.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('paired investigation verifies actual retained stages and TELOS evidence without replay', {timeout:60000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-investigation-pair-'));
  const probeRoot=path.join(root,'probe');
  const probe=await runPairedProbe({outputDir:probeRoot,count:2,delayMs:15,telosRoot:process.env.OPHANIM_TELOS_ROOT});
  const reportFile=path.join(root,'report.json');
  const report={schema:'ophanim.admission-proof/v1',probes:[probe]};
  write(reportFile,report);
  const expectedReportSha=sha(reportFile);
  const modelEvidence=await openLatencyModelEvidence({reportFile,expectedReportSha});
  const historical=modelEvidence.checked;
  const initially=historical.probes[0];
  assert.equal(initially.verifiedNodes,12);
  assert.equal(initially.rows[0].outputSha,initially.rows[1].outputSha);
  assert.equal(initially.rows[0].effectSha,initially.rows[1].effectSha);
  assert.equal(initially.outcomes.recovery,'unmeasured');
  assert.equal(initially.authority.execution,false);
  assert.equal(initially.authority.policyActivation,false);
  assert.equal(initially.assessment,initially.stageP95.passed?'inconclusive':'hard-constraint-violated');
  assert.equal(initially.rows[0].stages.length,6);
  assert.equal(initially.rows[0].dependencyPath.ids.length,3);
  assert.equal(initially.stageP95.limitMs,initially.stageP95.baselineMs*1.25+25);
  const modelReferences=modelEvidence.referencesFor(initially.scopeSha);
  assert.equal(modelReferences.length,4);
  assert.deepEqual(modelEvidence.referencesFor('a'.repeat(64)),[]);
  const callback=modelEvidence.verifyObservation(modelReferences.find(row=>row.observationId==='paired-worker-callback-max-delta'));
  assert.equal(callback.scopeSha,initially.scopeSha);
  assert.equal(callback.value,Math.max(...initially.matchedStageDeltas.map(row=>row.workerCallbackMs)));
  assert.equal(modelEvidence.verifyObservation({receiptSha:'a'.repeat(64),observationId:callback.id}),null);
  for(const row of initially.rows) {
    assert.equal(readRuntimeSnapshot(row.source.stateDir).commit,row.boardCommit);
    assert.equal(sha(row.source.resultFile),row.files.resultSha);
    for(const stage of row.stages) {
      assert.equal(stage.stageMs,stage.startToPersistMs+stage.persistToGateMs+stage.gateToAcceptedMs);
      assert.equal(stage.startToPersistMs,stage.workerCallbackMs+stage.nonCallbackBeforePersistMs);
    }
  }
  assert.equal(sha(reportFile),expectedReportSha);
  assert.deepEqual(await verifyPairedInvestigation({root:probeRoot}),initially);
  const findings=latencyInvestigationFindings(historical);
  if(!initially.stageP95.passed&&initially.throughputSavedMs>0) {
    assert.equal(findings.length,1);
    assert.equal(findings[0].scopeSha,initially.scopeSha);
    assert.notDeepEqual(findings[0].hypotheses[0].predictions,findings[0].hypotheses[1].predictions);
  }else assert.equal(findings.length,0);

  await t.test('report summaries cannot replace committed timing or bind a different scope',async()=>{
    const rewritten=structuredClone(report);rewritten.probes[0].rows[0].stageP95Ms+=500;
    write(reportFile,rewritten);
    await assert.rejects(verifyLatencyEvidence({reportFile,expectedReportSha}),/Retained report digest differs/);
    await assert.rejects(verifyLatencyEvidence({reportFile}),/stageP95Ms differs/);
    write(reportFile,report);
    const copied=structuredClone(historical);copied.probes[0].scopeSha='f'.repeat(64);
    assert.throws(()=>latencyInvestigationFindings(copied),/Exact independently reconstructed latency evidence/);
  });

  await t.test('an altered callback span cannot escape its committed work envelope',async()=>{
    const file=initially.rows[1].source.resultFile,original=fs.readFileSync(file),tampered=JSON.parse(original);
    tampered.intervals[0].endedAt=tampered.endedAt+1;
    write(file,tampered);
    try {await assert.rejects(verifyPairedInvestigation({root:probeRoot}),/callback interval differs/);}
    finally {fs.writeFileSync(file,original);}
  });

  await t.test('watchdog forgery or changed acceptance byte is rejected from raw evidence',async()=>{
    const metricsFile=initially.rows[1].source.watchdogFile,originalWatchdog=fs.readFileSync(metricsFile);
    const fake=JSON.parse(originalWatchdog);fake.events.find(event=>event.type==='work.started').atMs++;
    write(metricsFile,fake);
    try {await assert.rejects(verifyPairedInvestigation({root:probeRoot}),/Watchdog events differ/);}
    finally {fs.writeFileSync(metricsFile,originalWatchdog);}
    const resultFile=initially.rows[1].source.resultFile,originalResult=fs.readFileSync(resultFile),changed=read(resultFile);
    changed.outputs[Object.keys(changed.outputs)[0]].summary='changed output';
    write(resultFile,changed);
    try {await assert.rejects(verifyPairedInvestigation({root:probeRoot}),/Replay changed accepted output bytes/);}
    finally {fs.writeFileSync(resultFile,originalResult);}
  });
  assert.equal(sha(reportFile),expectedReportSha);
});

test('controlled investigation requires an independently bound manifest and exact scope before TELOS work',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-investigation-identity-'));
  const manifestFile=path.join(root,'manifest.json');
  const scopeSha=digest('test scope');
  write(manifestFile,{scopeSha});
  await assert.rejects(verifyControlledInvestigation({manifestFile}),/Exact external scope and evidence digests/);
  await assert.rejects(verifyControlledInvestigation({manifestFile,expectedScopeSha:scopeSha,expectedManifestSha:'a'.repeat(64)}),/Replay manifest digest differs/);
  await assert.rejects(verifyControlledInvestigation({manifestFile,expectedScopeSha:'b'.repeat(64),expectedManifestSha:sha(manifestFile)}),/different scope/);
});
