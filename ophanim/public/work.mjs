// The work projection: who is working on each status item, at which stage and gate, under which claim and budget,
// with what usage, blocker and evidence -- read from the work ledger (ophanim/operate/work-ledger.mjs) and shaped
// for the public record's issue bodies (record.mjs workSection). The work ledger is the controller's record; the
// status ledger stays authoritative for an item's status.
//
// Inputs: repo (tickets and evidence bytes for the gate), the status ledger root, the work ledger root, and an
//   optional pinned work-ledger anchor. Outputs: {ledger: {state: verified|absent|unverified, path, anchor?, why?},
//   items: Map(item -> view)}. A view holds the earliest unmet gate (operate/gates.mjs, via reconcile), the latest
//   stage record, the latest claim and its release, the budget, the usage (unknown kept unknown), the blocker, the
//   team of the latest stage record (model seats: text, never GitHub identities) and the evidence of the valid chain.
// Invariants: read-only (the work ledger is opened with create:false and is never appended to; no key is needed);
//   deterministic in the two ledgers and the checkout: no clock is read. An unreleased claim is shown as held with
//   its lease end, whatever the time; the controller releases an expired lease as `expired` on its next tick, which
//   changes the ledger and so the projection.
// Must never: create a work ledger or a key, append, call a provider, or treat an issue as evidence.
import fs from 'node:fs';
import path from 'node:path';
import {openWorkLedger, outputsDigest, STAGES} from '../operate/work-ledger.mjs';
import {reconcile} from '../operate/reconcile.mjs';

const rel = (repo, p) => path.relative(repo, p) || p;

/** The first of `keys` present (not null/undefined) on `o`, else null. */
const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] != null) return o[k]; return null; };

/** One item's view, from its gate (reconcile) and its work ledger records (or none). */
export function itemView(work, entry) {
  const stages = work ? work.stages(entry.item) : [];
  const claims = work ? work.claims(entry.item) : [];
  const lastClaim = claims.at(-1) ?? null;
  const release = lastClaim ? work.released(lastClaim.hash) : null;
  const known = stages.filter(s => Number.isInteger(s.usage?.provider_calls));
  const usage = {
    provider_calls: known.reduce((n, s) => n + s.usage.provider_calls, 0),
    tokens: stages.some(s => Number.isInteger(s.usage?.tokens)) ? stages.reduce((n, s) => n + (Number.isInteger(s.usage?.tokens) ? s.usage.tokens : 0), 0) : null,
    known_records: known.length, unknown_records: stages.length - known.length,
  };
  const latest = stages.at(-1) ?? null;
  // The valid chain the gate reuses (plan .. last passed stage), in lifecycle order.
  const byHash = new Map(stages.map(s => [s.hash, s]));
  const chain = STAGES.map(s => entry.gate.reuse?.[s]).filter(Boolean).map(h => byHash.get(h)).filter(Boolean);
  // The latest attempt handed the chain's last record (returned, pending or blocked): its evidence is shown too, marked
  // as not (yet) part of the reused chain.
  const tried = chain.length ? stages.filter(s => s.handoff?.from === chain.at(-1).hash).at(-1) ?? null : null;
  const at = name => chain.find(s => s.stage === name) ?? (tried?.stage === name ? tried : null);
  const plan = at('plan'), impl = at('implement'), review = at('review'), validate = at('validate'), outcome = at('outcome');
  const reviewOut = review?.outputs ?? null;
  return {
    item: entry.item,
    gate: {gate: entry.gate.gate, reason: entry.gate.reason ?? null, mode: entry.gate.mode ?? null, stage: entry.gate.stage ?? null},
    blocker: entry.gate.blocker ?? null,
    latest: latest && {hash: latest.hash, stage: latest.stage, attempt: latest.attempt, status: latest.status, next: latest.next ?? null},
    claim: lastClaim && {hash: lastClaim.hash, stage: lastClaim.stage, attempt: lastClaim.attempt, holder: lastClaim.holder, leased_at: lastClaim.leased_at,
      until: new Date(Date.parse(lastClaim.leased_at) + lastClaim.lease_ms).toISOString(), budget: lastClaim.budget,
      released: release && {outcome: release.outcome, why: release.why, at: release.at}},
    usage,
    team: latest?.team ?? [],
    evidence: {
      chain: chain.map(s => ({stage: s.stage, hash: s.hash})),
      attempt: tried && {stage: tried.stage, status: tried.status, hash: tried.hash},
      plan: plan && {record: plan.hash, outputs: outputsDigest(plan.outputs), ticket: plan.outputs?.ticket ?? null},
      commit: pick(impl?.outputs, 'commit', 'head'),
      review: reviewOut && {cycle: pick(reviewOut, 'cycle') ?? pick(reviewOut.review, 'cycle'), close: pick(reviewOut, 'close_entry', 'close') ?? pick(reviewOut.review, 'close_entry'),
        outcome: pick(reviewOut, 'outcome') ?? pick(reviewOut.review, 'outcome')},
      verdict: pick(validate?.outputs, 'verdict'),
      proposal: pick(outcome?.outputs, 'proposal'),
    },
    stages: stages.map(s => ({hash: s.hash, stage: s.stage, attempt: s.attempt, status: s.status, team: s.team, provider_calls: s.usage?.provider_calls ?? null,
      next: s.next ?? null})),
  };
}

/**
 * Read the work ledger (verified against its ANCHOR, or `anchor` when pinned) and compute every status item's view.
 * A missing work ledger is reported as absent (the gates are still computed, from the status ledger alone); one
 * that does not verify is reported as unverified and nothing from it is used.
 */
export function readWorkRecord({repo, statusRoot, workRoot, anchor = null}) {
  const where = rel(repo, workRoot);
  let work = null, ledger;
  if (!fs.existsSync(path.join(workRoot, 'ANCHOR'))) ledger = {state: 'absent', path: where, why: `no work ledger at \`${where}\``};
  else {
    try {
      work = openWorkLedger({root: workRoot, create: false, anchor});
      ledger = {state: 'verified', path: where, anchor: work.anchor};
    } catch (e) { ledger = {state: 'unverified', path: where, why: e.message}; }
  }
  // now = 0: every unreleased claim counts as held (deterministic; see the header).
  const rec = reconcile({repo, statusRoot, workLedger: work, issues: null, now: 0});
  return {ledger, items: new Map(rec.items.map(i => [i.item, itemView(work, i)]))};
}
