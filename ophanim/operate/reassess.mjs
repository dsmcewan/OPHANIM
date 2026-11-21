// REASSESSMENT of an item's recorded reviews under a later identity policy (pantheon review/identity.mjs `reassess`).
//
// A pantheon.cycle/v3 cycle is verified, always, under the identity policy it recorded. When the rules are later
// corrected (an alias found, a lab mapping fixed), an already recorded review may turn out to have been given by a
// model that contributed. That is NEW EVIDENCE: this module finds it and records it on the work ledger
// (work.reassessment), with the corrected policy itself. Recording it changes nothing in the cycle's ledger and
// nothing on the status ledger. What it changes is forward progress (gates.mjs): a disqualified approval, and the
// validation and outcome resting on it, are not reused; active work is routed to a bounded re-review; a Resolved
// item is marked as needing re-verification, for the owner.
//
// Inputs: the work ledger, an item, and the policy to reassess under (default: the current one). Returns what it
// recorded. Must never: write to a review ledger or the status ledger, or record the same reassessment twice.
import {openPantheonLedger} from '../../pantheon/src/ledger/system.mjs';
import {reassess, currentPolicy, policyDigest} from '../../pantheon/src/review/identity.mjs';

/** The review cycles an item's passed stages rest on: [{stage, record, cycle, ledger, anchor}]. */
export function cyclesOf(work, item) {
  const out = [];
  for (const s of work.stages(item)) {
    if (s.status !== 'passed') continue;
    if (s.stage === 'plan' && s.outputs?.plan_review?.cycle) out.push({stage: 'plan', record: s.hash, cycle: s.outputs.plan_review.cycle, ledger: s.outputs.plan_ledger ?? null, anchor: s.outputs.plan_review.ledger_anchor ?? null});
    if (s.stage === 'review' && s.outputs?.cycle) out.push({stage: 'review', record: s.hash, cycle: s.outputs.cycle, ledger: s.outputs.cycle_ledger ?? null, anchor: s.outputs.cycle_ledger_anchor ?? null});
  }
  return out;
}

/**
 * Reassess every model-rule cycle of `item` under `policy` and record each one that has findings (once per cycle
 * and policy). Cycles opened under the lab rule carry no identity policy and are not reassessed.
 */
export function reassessItem({work, item, policy = currentPolicy(), at = new Date().toISOString()}) {
  const digest = policyDigest(policy), done = new Set(work.reassessments(item).map(r => `${r.cycle}|${r.policy}`));
  const recorded = [], skipped = [];
  for (const c of cyclesOf(work, item)) {
    if (!c.ledger) { skipped.push({...c, why: 'the stage record does not say where its review ledger is'}); continue; }
    const sys = openPantheonLedger({root: c.ledger, anchor: c.anchor});
    const state = sys.recorder().cycleState(c.cycle);
    if (state.cycle.contract !== 'pantheon.cycle/v3') { skipped.push({...c, why: 'opened under the lab rule: no identity policy to reassess'}); continue; }
    const r = reassess({cycle: state.cycle, reviews: state.reviews, policy});
    if (!r.changed || !r.findings.length) { skipped.push({...c, why: r.changed ? 'no recorded review is disqualified under this policy' : 'this is the policy the cycle recorded'}); continue; }
    if (done.has(`${c.cycle}|${digest}`)) { skipped.push({...c, why: 'already recorded'}); continue; }
    const hash = work.recordReassessment({item, cycle: c.cycle, recorded_policy: r.recorded, policy: digest, findings: r.findings, policy_rules: policy, at});
    recorded.push({...c, reassessment: hash, findings: r.findings});
  }
  return {item, policy: digest, recorded, skipped};
}
