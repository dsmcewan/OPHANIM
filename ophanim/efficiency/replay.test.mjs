import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {alternatingOrder,evaluateScheduler,verifyReplayTrial} from './replay.mjs';
import {writeJson} from '../fixtures.mjs';
import {readRuntimeSnapshot,digest} from '../board.mjs';

const watchdog=fileURLToPath(new URL('../watchdog.mjs',import.meta.url));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function baseline(root,request) {
  const requestFile=path.join(root,'request.json'),resultFile=path.join(root,'result.json'),stateDir=path.join(root,'state');
  const reportFile=path.join(root,'watchdog.json'),guardFile=path.join(root,'watchdog-request.json');
  writeJson(requestFile,{...request,stateDir,resultFile,slots:1});
  writeJson(guardFile,{requestFile,reportFile,timeoutMs:30000,stallMs:10000,replay:true,replayRoot:root});
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[watchdog,'--request',guardFile],{stdio:['ignore','pipe','pipe','ipc']});
    let stderr='';child.stderr.on('data',data=>{stderr+=data;});
    child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(stderr||JSON.stringify(read(reportFile)))));
  });
  return {stateDir,resultFile,result:read(resultFile)};
}

test('controlled repeats alternate and reject an unbounded repeat request',()=>{
  assert.deepEqual(alternatingOrder(),[{pair:0,slots:1},{pair:0,slots:3},{pair:1,slots:3},{pair:1,slots:1},{pair:2,slots:1},{pair:2,slots:3}]);
  assert.throws(()=>alternatingOrder(2),/Three or four/);
  assert.throws(()=>alternatingOrder(1000),/Three or four/);
});

test('isolated actual runtime replay preserves signed outputs and exactly one effect through both recovery widths', {timeout:180000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-efficiency-replay-'));
  const request={batches:[{count:2,namespace:'efficiency'}],maxDispatches:1000,workerOptions:{version:'synthetic-v1',delayMs:15}};
  const original=await baseline(path.join(root,'original'),request),snapshot=readRuntimeSnapshot(original.stateDir);
  const outputDir=path.join(root,'experiment');
  const result=await evaluateScheduler({outputDir,request,originalResult:original.result,originalStateDir:original.stateDir,budgetMs:120000});
  assert.equal(result.ok,true,result.reason);assert.equal(result.status,'completed');
  assert.equal(result.evidenceSha,sha(result.manifestFile));assert.equal(result.originalResultSha,sha(path.join(outputDir,'original-result.json')));
  const manifest=read(result.manifestFile);
  assert.equal(manifest.trials.length,8);
  assert.deepEqual(manifest.trials.filter(t=>t.kind==='clean').map(t=>t.slots),[1,3,3,1,1,3]);
  assert.deepEqual(manifest.trials.filter(t=>t.kind==='recovery').map(t=>t.slots),[3,1]);
  assert.equal(manifest.original.boardCommit,snapshot.commit);
  assert.equal(manifest.original.stateSha,digest(snapshot.state));
  assert.equal(readRuntimeSnapshot(original.stateDir).commit,snapshot.commit,'Evaluation modified original state');
  assert.ok(manifest.measurements.benchmarkWallMs>manifest.measurements.childWallMs);
  assert.ok(manifest.measurements.verificationWallMs>0);
  assert.equal(manifest.measurements.realizedInitialNetSavedMs,-manifest.measurements.benchmarkWallMs);
  assert.equal(manifest.boundaries.policyActivation,0);assert.equal(manifest.boundaries.models,0);
  for(const trial of manifest.trials){
    const proof=read(path.join(outputDir,trial.verificationFile)),observed=read(path.join(outputDir,trial.resultFile));
    assert.equal(proof.runtimeDispatches,0);assert.equal(proof.modelCalls,0);assert.match(proof.deterministicSemanticChecks,/replayed/);
    assert.equal(proof.accepted,6);assert.equal(proof.effects,2);
    assert.equal(trial.outputSha,manifest.original.outputSha);assert.equal(trial.effectSha,manifest.original.effectSha);
    assert.equal(observed.destinationInvocations.length,2);assert.ok(observed.effects.every(e=>e.writeCount===1));
    assert.equal(observed.activeRelease,'baseline');
    if(trial.kind==='clean')assert.equal(observed.dispatches,6);
    else assert.ok(observed.dispatches>=0&&observed.dispatches<=6);
    assert.ok(Object.keys(manifest.files).includes(trial.stateDir+'/pantheon/refs/board/ophanim'));
    if(trial.kind==='recovery'){
      assert.equal(trial.segments.length,2);assert.equal(trial.metrics.workerContextBytes,null);
      const crash=read(path.join(outputDir,trial.segments[0].watchdogFile));assert.equal(crash.signal,'SIGKILL');
      const previous=readRuntimeSnapshot(path.join(outputDir,trial.stateDir),trial.metrics.beforeRecovery.boardCommit);
      assert.equal(digest(previous.state),trial.metrics.beforeRecovery.stateSha);
      assert.ok(Object.values(previous.state.effects).some(e=>e.status==='intent'));
    }
  }
  for(const [relative,hash]of Object.entries(manifest.files))assert.equal(sha(path.join(outputDir,relative)),hash,relative);
  await assert.rejects(evaluateScheduler({outputDir:path.join(root,'wrong-scope'),request,originalResult:original.result,originalStateDir:original.stateDir,scopeSha:'0'.repeat(64)}),/scope differs/);
  const limited=await evaluateScheduler({outputDir:path.join(root,'budget'),request,originalResult:original.result,originalStateDir:original.stateDir,budgetMs:1000});
  assert.equal(limited.ok,false);assert.equal(limited.status,'budget_exhausted');
  assert.ok(limited.measurements.benchmarkWallMs<=1500,'Budget excludes a substantial unbounded overrun');
  const altered=structuredClone(request);altered.workerOptions.version='synthetic-v2';
  await assert.rejects(verifyReplayTrial({stateDir:original.stateDir,resultFile:original.resultFile,request:altered}),/baseline worker version/);
  process.stdout.write(`# Controlled efficiency replay evidence: ${result.manifestFile}\n`);
  process.stdout.write(`# Controlled replay cost: ${JSON.stringify(manifest.measurements)}\n`);
});
