import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {digest} from '../../board.mjs';
import {executeRequest} from '../../cli.mjs';
import {verifyEfficiencyRecord} from '../assessment.mjs';
import {recordInvestigation, verifyInvestigationReceipt} from './controller.mjs';

const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const fixture = {count:2, namespace:'investigation-proof'};
const runOptions = {fixture, slots:1, workerOptions:{delayMs:15}};

function load(stateDir, output) {
  const report = verifyEfficiencyRecord({stateDir, record:output.efficiency, output});
  const traceFile = path.join(path.dirname(output.efficiency.reportFile),'trace.json');
  const trace = read(traceFile);
  const receipt = report.investigation;
  assert.equal(receipt.schema,'ophanim.investigation-receipt/v1',receipt.detail);
  return {report, trace, traceFile, receipt, verification:{receipt, trace,
    registry:report.contributionRegistry, variables:report.variables, traceTrusted:true}};
}

test('governed convergence persists a bounded decision, suppresses noise, and reconsiders a material workload change', {timeout:90000}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-investigation-proof-'));
  const seed = await executeRequest({...runOptions,stateDir:path.join(root,'seed')});
  const seedEvidence = load(path.join(root,'seed'),seed);
  assert.equal(seedEvidence.receipt.decision.outcome,'insufficient_evidence');
  const scopeSha = seed.efficiency.scopeSha;
  // Declared controlled economics for the proof. Runtime trace timings and
  // accepted quality still come from the real frozen synthetic workflow.
  const forecast = {schema:'ophanim.investigation-estimate/v1',scopeSha,basis:'Controlled workload forecast for this synthetic qualification',
    instrumentationCeilingMs:45,estimates:{applicability:0.9,confidence:0.8,decisionChangeProbability:0.8,
      avoidableLossMsPerConvergence:125,expectedCandidateGainMsPerConvergence:180,rolloutMs:60,regressionMs:20,opportunityCostMs:40}};
  const ledger = path.join(root,'shared-efficiency');
  async function runCase(name, expectedQualifiedConvergences) {
    const stateDir = path.join(root,name);
    const result = await executeRequest({...runOptions,stateDir,efficiencyRoot:ledger,expectedQualifiedConvergences,investigationEstimate:forecast});
    const loaded = load(stateDir,result);
    assert.equal(result.convergence,'accepted_change');
    assert.deepEqual(result.outputs,seed.outputs);
    assert.equal(result.destinationInvocations.length,fixture.count);
    assert.equal(loaded.receipt.decision.limits.executionAuthorized,false);
    assert.equal(loaded.receipt.decision.limits.promotionAuthorized,false);
    assert.equal(loaded.report.admission.decision.replays,0);
    assert.equal(loaded.report.experiment,undefined);
    assert.equal(loaded.receipt.decision.limits.modelCalls,0);
    return {stateDir,result,...loaded};
  }

  const low = await runCase('low',1);
  assert.equal(low.receipt.decision.outcome,'no_change');
  assert.ok(low.receipt.decision.candidates.some(row => row.reason === 'nonpositive-information-value'));
  const duplicate = await runCase('same-workload',1);
  assert.equal(duplicate.receipt.decision.reason,'retained-applicable-decision');
  assert.equal(duplicate.receipt.retained,null);
  const high = await runCase('changed-workload',20);
  assert.equal(high.receipt.decision.outcome,'proposed');
  assert.ok(high.receipt.decision.selected.value.netInformationValueMs>0);
  assert.notEqual(high.receipt.decision.selected.value.netInformationValueMs,high.receipt.decision.selected.value.expectedCandidateGrossGainMs);
  assert.equal(verifyInvestigationReceipt(high.verification).ok,true);

  const altered = structuredClone(high.verification);
  altered.receipt.decision.limits.promotionAuthorized=true;
  assert.throws(()=>verifyInvestigationReceipt(altered),/independently reconstructed evidence/);
  const priorFile=path.join(ledger,'scopes',scopeSha,'investigations',`${low.receipt.retained}.json`);
  const intact=fs.readFileSync(priorFile);
  fs.appendFileSync(priorFile,'\n{}');
  try { assert.throws(()=>verifyInvestigationReceipt(high.verification)); }
  finally { fs.writeFileSync(priorFile,intact); }

  const crashRoot=path.join(root,'crash-ledger');
  const args={root:crashRoot,stateDir:high.stateDir,trace:high.trace,registry:high.report.contributionRegistry,
    variables:high.report.variables,workload:20,estimate:forecast,traceTrusted:true};
  const controllerUrl=new URL('./controller.mjs',import.meta.url).href;
  const processCode=`import {recordInvestigation} from ${JSON.stringify(controllerUrl)};
    await recordInvestigation(JSON.parse(process.argv[1])); process.kill(process.pid,'SIGKILL');`;
  const crashed=spawnSync(process.execPath,['--input-type=module','-e',processCode,JSON.stringify(args)],{encoding:'utf8',timeout:10000});
  assert.equal(crashed.signal,'SIGKILL',crashed.stderr);
  const restarted=await recordInvestigation(args);
  assert.equal(restarted.decision.outcome,'proposed');
  assert.equal(verifyInvestigationReceipt({...high.verification,receipt:restarted}).ok,true);
  const journal=path.join(crashRoot,'scopes',scopeSha,'investigations');
  assert.deepEqual(fs.readdirSync(journal),[`${restarted.retained}.json`]);
  const forged=read(path.join(journal,`${restarted.retained}.json`));
  forged.entries[0].reason='invented-rejection';
  const forgedFile=path.join(journal,`${digest(forged)}.json`);
  fs.writeFileSync(forgedFile,JSON.stringify(forged),{mode:0o600});
  try { await assert.rejects(recordInvestigation(args),/history differs from source evidence/); }
  finally { fs.unlinkSync(forgedFile); }
  const convergences=path.join(high.stateDir,'efficiency','convergences');
  const assessedHeads=fs.readdirSync(convergences).sort();
  const journalBefore=fs.readdirSync(path.join(ledger,'scopes',scopeSha,'investigations')).sort();
  const resumed=await executeRequest({...runOptions,stateDir:high.stateDir,efficiencyRoot:ledger,
    expectedQualifiedConvergences:20,investigationEstimate:forecast});
  assert.equal(resumed.convergence,'no_change');
  assert.equal(resumed.dispatches,0);
  assert.deepEqual(resumed.destinationInvocations,high.result.destinationInvocations);
  // Equilibrium: the unchanged head is reused, so the run starts no new
  // research and records no new assessment or investigation history.
  assert.equal(resumed.reusedConvergence.boardCommit,high.result.efficiency.boardCommit);
  assert.deepEqual(JSON.parse(JSON.stringify(resumed.efficiency)),JSON.parse(JSON.stringify(high.result.efficiency)));
  const resumedEvidence=load(high.stateDir,resumed);
  assert.equal(resumedEvidence.receipt.traceSha,high.receipt.traceSha);
  assert.deepEqual(fs.readdirSync(convergences).sort(),assessedHeads);
  assert.deepEqual(fs.readdirSync(path.join(ledger,'scopes',scopeSha,'investigations')).sort(),journalBefore);
  console.log(`Ophanim investigation qualification evidence: ${root}`);
});
