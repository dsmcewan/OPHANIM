import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonical, digest, readRuntimeSnapshot} from '../board.mjs';
import {assessEfficiency} from '../governance/check-efficiency.mjs';
import {baselineEvidenceSha, optimizationRecipeSha} from './admission.mjs';

const MAX_BYTES = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function requireThat(condition, message) {
  if (!condition) throw Error(message);
}
function readBounded(file, expectedSha) {
  const stat = fs.lstatSync(file);
  requireThat(stat.isFile() && stat.size <= MAX_BYTES && fs.realpathSync(file) === file, 'Canonical bounded prior evidence required');
  const bytes = fs.readFileSync(file);
  requireThat(bytes.length <= MAX_BYTES && (!expectedSha || hash(bytes) === expectedSha), 'Prior evidence bytes differ');
  return JSON.parse(bytes);
}

// Prior evidence can suppress an experiment. It confers no authorization and
// never reruns the verifier or a worker on the admission path.
export function readRetainedExperiment(markerFile, trace) {
  return retainedExperimentFrom({marker: readBounded(markerFile), trace,
    prior: reportDir => readBounded(path.join(reportDir, 'trace.json')),
    report: reportDir => readBounded(path.join(reportDir, 'assessment.json')),
    state: (stateDir, boardCommit) => readRuntimeSnapshot(stateDir, boardCommit).state});
}

// The computation behind readRetainedExperiment, with the prior trace, its assessment report and its
// board state supplied by the caller: from files (above), or from ledger entries (K5b, the
// `efficiency.retained` kind in ophanim/ledger/efficiency-kinds.mjs). Each source is a function of the
// paths the marker names, so both readers bind the same marker to the same evidence. The replay manifest
// and trial verifications stay content-addressed files, read here by the hashes the report names.
export function retainedExperimentFrom({marker, trace, prior: priorOf, report: reportOf, state: stateOf}) {
  requireThat(marker && typeof marker === 'object' && marker.schema === 'ophanim.efficiency/v1' && hex(marker.traceSha) && marker.fromSlots === 1 && marker.toSlots === 3 &&
    path.isAbsolute(marker.evidenceRoot), 'Exact prior experiment marker required');
  const experiment = marker.evidenceRoot;
  const reportDir = path.dirname(experiment);
  const stateDir = path.resolve(reportDir, '../../..');
  const commit = path.basename(reportDir);
  requireThat(/^commit-[a-f0-9]{64}$/.test(commit) && experiment === path.join(stateDir, 'efficiency', 'convergences', commit, 'experiment'), 'Prior experiment path differs');
  const prior = priorOf(reportDir);
  const boardCommit = commit.replace('commit-', 'commit:');
  requireThat(digest(prior) === marker.traceSha && prior.boardCommit === boardCommit && prior.scopeSha === trace.scopeSha &&
    baselineEvidenceSha(prior) === baselineEvidenceSha(trace) && canonical(prior.policy) === canonical(trace.policy), 'Prior trace binding differs');
  const snapshot = stateOf(stateDir, boardCommit);
  requireThat(digest(snapshot) === prior.stateSha && snapshot.events.at(-1)?.convergence === 'accepted_change', 'Prior accepted board differs');
  const report = reportOf(reportDir);
  const qualification = report.qualification ?? report.efficiency;
  const manifestFile = path.join(experiment, 'manifest.json');
  const evidenceSha = report.experiment?.evidenceSha;
  requireThat(report.traceSha === marker.traceSha && report.scopeSha === trace.scopeSha && ['no_change','promoted'].includes(report.outcome) &&
    qualification?.schema === 'ophanim.efficiency-verification/v1' && qualification.readOnly === true &&
    qualification.scopeSha === trace.scopeSha && qualification.evidenceSha === evidenceSha && hex(evidenceSha) &&
    report.experiment.manifestFile === manifestFile, 'Completed independent evaluation evidence required');
  const manifest = readBounded(manifestFile, evidenceSha);
  requireThat(manifest.status === 'completed' && manifest.scopeSha === trace.scopeSha && manifest.original.boardCommit === boardCommit &&
    manifest.original.stateSha === prior.stateSha && manifest.original.outputSha === prior.original.outputSha &&
    manifest.original.effectSha === prior.original.effectSha && canonical(manifest.policy) === canonical(trace.policy) &&
    manifest.trials.length === 8, 'Prior manifest applicability differs');

  const clean = slots => manifest.trials.filter(trial => trial.kind === 'clean' && trial.slots === slots);
  const recovery = slots => manifest.trials.find(trial => trial.kind === 'recovery' && trial.slots === slots)?.metrics.recoveryMs;
  const p95 = ({id,verificationFile}) => {
    requireThat(/^0[1-6]-clean-[13]$/.test(id) && verificationFile === `trials/${id}/verification.json` && hex(manifest.files[verificationFile]), 'Prior trial verification binding differs');
    return readBounded(path.join(experiment, verificationFile), manifest.files[verificationFile]).derivedStageP95Ms;
  };
  const baseline = clean(1), candidate = clean(3);
  const measured = assessEfficiency({baselineMs:baseline.map(t => t.metrics.runDurationMs), candidateMs:candidate.map(t => t.metrics.runDurationMs),
    baselineP95Ms:baseline.map(p95), candidateP95Ms:candidate.map(p95), baselineRecoveryMs:recovery(1), candidateRecoveryMs:recovery(3),
    trialCostMs:manifest.measurements.benchmarkWallMs});
  const adjustedValueFields = report.outcome === 'promoted' ? ['forecastNetSavedMs','realizedNetSavedMs'] : [];
  requireThat(Object.keys(measured).every(key => adjustedValueFields.includes(key) ||
    canonical(measured[key]) === canonical(qualification[key])) && Number.isFinite(report.cost.wallMs) &&
    report.cost.wallMs >= measured.trialCostMs, 'Prior independent evaluation does not reconcile');
  return {verified:true, scopeSha:trace.scopeSha, recipeSha:optimizationRecipeSha(), baselineEvidenceSha:baselineEvidenceSha(trace), evidenceSha,
    outcome:report.outcome, blockers:measured.blockers, measured:{baselineConservativeMs:measured.baselineConservativeMs,
      candidateConservativeMs:measured.candidateConservativeMs, conservativeSavedMs:measured.conservativeSavedMs,
      forecastGrossSavedMs:measured.forecastGrossSavedMs, forecastNetSavedMs:measured.forecastNetSavedMs,
      trialCostMs:measured.trialCostMs, assessmentCostMs:report.cost.wallMs}};
}
