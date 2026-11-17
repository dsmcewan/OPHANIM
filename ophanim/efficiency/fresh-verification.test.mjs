// K5b: a fresh assessment is verified before it is used or written (cli.mjs), and the verifier accepts
// every receipt a normal run produces, including a held investigation, while still refusing forged ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeRequest} from '../cli.mjs';
import {verifyEfficiencyRecord} from './assessment.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const base = {fixture: {count: 2, namespace: 'fresh-verification'}, slots: 1, workerOptions: {delayMs: 15}};
// An operator forecast kept from another scope: a normal request, and recordInvestigation refuses it, so the
// assessment records a held investigation receipt.
const staleForecast = {schema: 'ophanim.investigation-estimate/v1', scopeSha: '0'.repeat(64), basis: 'Forecast kept from an earlier scope',
  estimates: {applicability: 0.5}};

async function withRoot(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-fresh-verification-')));
  try { return await fn(root); } finally { fs.rmSync(root, {recursive: true, force: true}); }
}
test('a normal run whose investigation is held is verified before its result is written', {timeout: 120000}, () => withRoot(async root => {
  const stateDir = path.join(root, 'state');
  const output = await executeRequest({...base, stateDir, investigationEstimate: staleForecast});
  assert.equal(output.convergence, 'accepted_change');
  const report = read(output.efficiency.reportFile);
  assert.equal(report.investigation.schema, 'ophanim.investigation-blocked/v1');
  assert.equal(report.investigation.detail, 'Exact scoped investigation forecast required');
  // Before K5b this threw "Held investigation evidence does not qualify for independent verification", so
  // the cli could not verify a fresh assessment without failing normal runs.
  assert.equal(verifyEfficiencyRecord({stateDir, record: output.efficiency, output}).traceSha, output.efficiency.traceSha);
  assert.deepEqual(read(path.join(stateDir, 'result.json')).efficiency, output.efficiency);
}));

test('a forged fresh assessment is refused', {timeout: 180000}, () => withRoot(async root => {
  const run = async (name, request) => {
    const stateDir = path.join(root, name);
    const output = await executeRequest({...base, ...request, stateDir});
    const verify = () => verifyEfficiencyRecord({stateDir, record: output.efficiency, output});
    const file = output.efficiency.reportFile, original = fs.readFileSync(file);
    const refused = (change, why) => {
      const report = read(file);
      change(report);
      fs.writeFileSync(file, JSON.stringify(report));
      try { assert.throws(verify, why); } finally { fs.writeFileSync(file, original); }
    };
    verify();
    return {output, report: read(file), refused};
  };

  // A held receipt is bound to its trace, in the exact shape the assessment writes.
  const held = await run('held', {investigationEstimate: staleForecast});
  held.refused(r => { r.investigation.traceSha = '1'.repeat(64); }, /Held investigation receipt differs/);
  held.refused(r => { r.investigation.reason = 'skipped'; }, /Held investigation receipt differs/);
  held.refused(r => { r.investigation.detail = {why: 'x'}; }, /Held investigation receipt differs/);
  held.refused(r => { r.investigation.decision = {outcome: 'proposed'}; }, /Held investigation receipt differs/);

  // Where the investigation needs no retained evidence (here a release activation, whose trace cannot
  // initiate research), its decision is a pure function of the trace: a held receipt in its place is forged.
  const activated = await run('activate', {operation: 'activate', releaseId: 'v2'});
  assert.equal(activated.report.investigation.schema, 'ophanim.investigation-receipt/v1');
  const t = activated.report;
  activated.refused(r => {
    r.investigation = {schema: 'ophanim.investigation-blocked/v1', scopeSha: t.scopeSha, traceSha: t.traceSha,
      boardCommit: activated.output.efficiency.boardCommit, reason: 'investigation-evidence-unavailable', detail: 'lock timeout'};
  }, /replaces a decision that needs no retained evidence/);

  // The rest of a fresh report still re-derives from the trace and the board.
  held.refused(r => { r.admission.decision.admitted = true; }, /Optimization admission differs/);
  held.refused(r => { r.analysis.criticalPathMs = 1; }, /analysis differs/);
  held.refused(r => { r.outcome = 'promoted'; }, /Efficiency evidence differs/);
}));
