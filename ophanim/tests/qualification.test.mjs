import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runQualification,verifyProof} from '../proof.mjs';

test('real TELOS, process interruption, independent watchdog, repair, composition and bounded scale qualification', {timeout:300000},async()=>{
  const outputDir=fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-qualification-test-'));
  const report=await runQualification({outputDir});
  assert.equal(report.status,'passed');
  assert.ok(report.checks.length>=40);
  assert.ok(report.checks.every(check=>check.passed));
  assert.equal(report.boundaries.modelCalls,0);
  const verified=await verifyProof({outputDir});
  assert.equal(verified.ok,true);assert.equal(verified.runtimeDispatches,0);assert.match(verified.deterministicSemanticChecks,/replayed/);
  const evidenceFile=report.scenarios.find(s=>s.resultFile).resultFile;
  const original=fs.readFileSync(evidenceFile);
  try{fs.appendFileSync(evidenceFile,'\n');await assert.rejects(verifyProof({outputDir}),/Evidence bytes changed/);}
  finally{fs.writeFileSync(evidenceFile,original);}
  // Retain qualification receipts for diagnosis and independent inspection.
  process.stdout.write(`# Ophanim qualification evidence: ${report.reportFile}\n`);
});
