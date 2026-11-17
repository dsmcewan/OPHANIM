// A cycle's practice assessment from the existing chair investigation ranking (audit C3; docs/reviews/
// 2026-11-16-routing-coordination/CYCLE_CONTRACT.md step 2-3). Not a second assessment system: the
// question and the bounded next step are what rankChairQuestions (investigation/chairs.mjs, over Pantheon's
// board-derived chair-contribution projection) already decides, mapped onto the practice record's outcomes
// (pantheon/src/ledger/practice-kinds.mjs) so the cycle can close with it and a later dispatch can load it.
//
//   investigation outcome        practice assessment
//   proposed                     propose_measurement   (a discriminating measurement is worth its cost)
//   insufficient_evidence        insufficient_evidence (no forecast, or no discriminating method)
//   blocked                      insufficient_evidence (the record must be verified first; the reason says so)
//   no_change                    retain                (a retained applicable decision, or no positive value)
//
// The result is the input to recordDisposition: unmeasured (the ranking executes nothing and spends no
// model call), so provisional; its evidence is the decision's digest, the projection it ranked, and, when
// given, the ledger `contribution` entry that projection was recorded as. It authorizes nothing: a policy
// proposal and its promotion stay separate, independently decided records.
import {digest} from '../board.mjs';
import {rankChairQuestions} from './investigation/chairs.mjs';

export const PRACTICE_OUTCOME_OF = Object.freeze({proposed: 'propose_measurement', insufficient_evidence: 'insufficient_evidence',
  blocked: 'insufficient_evidence', no_change: 'retain'});
const LEDGER_ENTRY = /^sha256:[0-9a-f]{64}$/;

/**
 * The practice assessment the chair investigation ranking gives for `projection` (a
 * pantheon.chair-contributions/v1 projection). `contribution` is the ledger entry hash of the recorded
 * projection, when there is one. Returns {outcome, question, measured, provisional, evidence, provenance,
 * investigation: {outcome, reason, selected}}; pass all but `investigation` to recordDisposition.
 */
export function practiceAssessment(projection, {economics = null, history = [], contribution = null, role = 'lead@orch'} = {}) {
  if (contribution !== null && !LEDGER_ENTRY.test(contribution)) throw Error('Practice assessment: a contribution is a ledger entry hash');
  const {decision} = rankChairQuestions(projection, {economics, history});
  const outcome = PRACTICE_OUTCOME_OF[decision.outcome];
  if (!outcome) throw Error(`Practice assessment: unknown investigation outcome ${decision.outcome}`);
  const top = decision.selected ?? decision.candidates[0] ?? null;
  const question = top?.question
    ?? (decision.outcome === 'blocked' ? `Can the chair record be trusted? ranking stopped: ${decision.reason}` : 'Which chair practice question does this board\'s evidence raise? none was found');
  return {
    outcome, question, measured: false, provisional: true,
    evidence: [{kind: 'digest', schema: decision.schema, sha: digest(decision)},
      {kind: 'digest', schema: projection.schema, sha: projection.projectionSha},
      ...(contribution ? [{kind: 'ledger', hash: contribution}] : [])],
    provenance: {by: {role}, method: `chair investigation ranking (ophanim/efficiency/investigation/chairs.mjs): ${decision.outcome}, ${decision.reason}`},
    investigation: {outcome: decision.outcome, reason: decision.reason, selected: decision.selected?.id ?? null},
  };
}
