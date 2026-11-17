// The earliest unmet gate of one work item: what the item needs next, which earlier stage results are still valid
// (reused, never paid for twice), which are stale (and why), and, for a genuinely blocked item, the blocker, the
// responsible role and the condition for resuming. Pure: every input is passed in.
//
// The lifecycle (work-ledger.mjs STAGES): plan -> implement -> review -> validate -> outcome.
//   plan       an item with no ticket is planned from its requirement (mode `author`); an item with a ticket has
//              that ticket's assumptions, scope, dependencies and acceptance re-checked (mode `revalidate`).
//   implement  consumes the approved plan.        review    the coordinated three-lab cycle review of the change.
//   validate   the exact change against the original requirement and the approved acceptance criteria.
//   outcome    the unsigned status transition for the owner, who alone signs the status ledger.
// A stage result is valid only while the chain it rests on holds: a passed stage is reused only if its handoff
// reaches back, stage by stage, to a plan that is still valid for the current requirement, dependencies, ticket
// bytes and evidence bytes. A change to any of those makes the plan stale and everything after it with it.
//
// Must never: treat a published issue, a ticket, a green CI run or a Resolved label as evidence that a stage ran;
// read issue text as authority; or route a blocked item to execution.
import {STAGES, outputsDigest} from './work-ledger.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';

/** The original requirement of an item: its id and title with the basis of its latest Ready status (else latest). */
export function requirementOf(history) {
  if (!history?.length) return null;
  const ready = [...history].reverse().find(s => s.state === 'Ready') ?? history.at(-1);
  return {item: ready.item, title: ready.title, basis: ready.basis, entry: ready.entry};
}
export const requirementDigest = req => 'sha256:' + digest({item: req.item, title: req.title, basis: req.basis});

/** Is the cited completion evidence on a Resolved status applicable: bound to a ticket, a commit and a 3-lab close? */
export function completionEvidence(status) {
  const ev = status?.evidence ?? null;
  if (!ev) return {ok: false, why: 'Resolved without recorded completion evidence (an attested basis only)'};
  const labs = new Set((ev.review?.reviewers ?? []).map(r => r.lab));
  if (!ev.ticket) return {ok: false, why: 'the completion evidence names no ticket'};
  if (!ev.commit) return {ok: false, why: 'the completion evidence names no commit'};
  if (!ev.review?.close_entry || ev.review.outcome !== 'verified') return {ok: false, why: 'the completion evidence has no verified review close'};
  if (labs.size < 3) return {ok: false, why: `the completion evidence names ${labs.size} review lab(s); three are required`};
  return {ok: true};
}

/**
 * Validity of a passed plan record against the present: requirement, dependency statuses, ticket bytes and the
 * bytes of the evidence the plan rests on. `bytesOf(path)` returns the current sha256 of a repository path or null.
 */
export function planValidity(plan, {requirement, deps, ticket, bytesOf = () => null}) {
  const why = [];
  if (plan.identity.requirement !== requirementDigest(requirement)) why.push('the original requirement changed');
  for (const [d, entry] of Object.entries(plan.outputs.deps ?? {})) if ((deps[d]?.entry ?? null) !== entry) why.push(`dependency ${d} changed`);
  for (const d of Object.keys(deps)) if (!(d in (plan.outputs.deps ?? {}))) why.push(`dependency ${d} was added`);
  const planned = plan.outputs.ticket ?? null;
  if (planned && ticket && planned.digest !== ticket.digest) why.push('the ticket was changed after the plan approved it');
  if (planned && !ticket) why.push('the ticket the plan wrote is missing');
  for (const ev of plan.outputs.evidence ?? []) if (ev.path && ev.sha256 && bytesOf(ev.path) !== ev.sha256) why.push(`evidence ${ev.path} changed`);
  return {valid: why.length === 0, why};
}

/** The chain of passed stages that rests on `plan`, in order, following handoffs (each must be the next stage). */
function chainFrom(plan, stages) {
  const chain = [plan];
  for (;;) {
    const last = chain.at(-1);
    const nextName = STAGES[STAGES.indexOf(last.stage) + 1];
    if (!nextName) break;
    const after = stages.filter(s => s.handoff?.from === last.hash && s.stage === nextName);
    const passed = after.filter(s => s.status === 'passed' && s.inputs.upstream === outputsDigest(last.outputs)).at(-1);
    if (!passed) break;
    chain.push(passed);
  }
  return chain;
}

/**
 * The earliest unmet gate. `item` is the latest status (with `entry`, `evidence`); `history` its statuses in order;
 * `depStatus(id)` the latest status of a dependency or null; `ticket` the readTicket result ({spec, digest, path}
 * or {why}) or null; `stages` this item's work.stage records in ledger order; `activeClaim` the live claim or null.
 */
export function earliestGate({item, history, depStatus, ticket = null, stages = [], activeClaim = null, bytesOf, now = Date.now(), recovery = null}) {
  const base = {item: item.item, state: item.state};
  if (activeClaim) return {...base, gate: 'claimed', reason: `claimed: ${activeClaim.stage}, attempt ${activeClaim.attempt} (lease)`, claim: activeClaim.hash};
  if (item.state === 'Resolved') {
    const ev = completionEvidence(item);
    if (ev.ok) return {...base, gate: 'complete', reason: 'Resolved with completion evidence bound to its ticket, commit and a three-lab verified review'};
    // Evidence recovery (evidence-recovery.mjs) for THIS status entry: recovered evidence waits for the owner's
    // signature; a search that found none says what it searched. The status itself is never changed here.
    if (recovery?.outcome === 'recovered') {
      return {...base, gate: 'awaiting-owner', reason: `${ev.why}; completion evidence was recovered from a retained run (proposal ${recovery.proposal.digest.slice(0, 19)})`,
        recovery: {outcome: recovery.outcome, record: recovery.hash, proposal: recovery.proposal.digest},
        blocker: {what: 'an unsigned proposal re-recording Resolved with recovered, structurally re-checked completion evidence', role: 'decision-authority',
          resume_when: 'the owner applies the proposal (node packages/ledger/status.mjs apply <file>) or declines it'}};
    }
    const searched = recovery ? `; evidence recovery searched ${recovery.searched.length} source(s) and none applies (${recovery.searched.map(x => `${x.ref}: ${x.result}`).join('; ')})`
      : '; evidence recovery has not searched yet';
    return {...base, gate: 'evidence-gap', reason: ev.why + searched, ...(recovery ? {recovery: {outcome: recovery.outcome, record: recovery.hash}} : {}),
      blocker: {what: ev.why + searched, role: 'decision-authority',
        resume_when: 'applicable retained evidence appears (searched again automatically when the item\'s sources change), or the owner records the item Ready to re-verify it through the lifecycle'}};
  }
  if (item.state === 'On Hold') {
    const what = item.waiting_on ? `waiting on ${item.waiting_on}: ${item.basis}` : `held: ${item.basis}`;
    return {...base, gate: 'blocked', reason: what, blocker: {what, role: item.owner_role ?? 'decision-authority',
      resume_when: item.waiting_on ? `the ${item.waiting_on} is supplied and the owner records the item Ready` : 'the owner records the item Ready'}};
  }
  const deps = Object.fromEntries((item.depends_on ?? []).map(d => [d, depStatus(d)]));
  const open = Object.entries(deps).filter(([, s]) => s?.state !== 'Resolved').map(([d]) => d);
  if (open.length) {
    return {...base, gate: 'blocked', reason: `depends on ${open.join(', ')}`, blocker: {what: `unresolved dependencies: ${open.join(', ')}`,
      role: 'lead@orch', resume_when: `${open.join(', ')} Resolved`}};
  }
  const requirement = requirementOf(history);
  const t = ticket && !ticket.why ? ticket : null;
  const stale = [];
  // A plan attempt that is pending or blocked on the present requirement decides, as a later attempt does after a
  // valid chain below: a structural block waits (it is not re-dispatched on identical inputs), and a transient one is
  // retried once due. A changed requirement makes it stale and the item is planned again.
  const lastPlan = stages.filter(s => s.stage === 'plan').at(-1) ?? null;
  if (lastPlan && (lastPlan.status === 'pending' || lastPlan.status === 'blocked') && lastPlan.identity?.requirement === requirementDigest(requirement)) {
    const returnedBy = lastPlan.inputs?.returned_by ?? null;
    if (lastPlan.status === 'pending' && lastPlan.blocker?.transient && Date.parse(lastPlan.blocker.retry_at ?? '') <= now) {
      return {...base, gate: 'plan', mode: lastPlan.outputs?.mode ?? (t ? 'revalidate' : 'author'), requirement, retry_of: lastPlan.hash, stale,
        ...(returnedBy ? {returned_by: returnedBy, findings: stages.find(x => x.hash === returnedBy)?.findings ?? []} : {}),
        reason: `plan was pending on a transient failure (${lastPlan.blocker.what}); its retry is due`};
    }
    return {...base, gate: 'blocked', stage: 'plan', requirement, blocker: lastPlan.blocker, stale,
      reason: `plan is ${lastPlan.status}: ${lastPlan.blocker?.what ?? lastPlan.next?.why ?? ''}`};
  }
  const passedPlans = stages.filter(s => s.stage === 'plan' && s.status === 'passed');
  let valid = null;
  for (const p of [...passedPlans].reverse()) {
    const v = planValidity(p, {requirement, deps: Object.fromEntries(Object.entries(deps).map(([d, s]) => [d, s ? {entry: s.entry} : null])), ticket: t, bytesOf});
    if (v.valid) { valid = p; break; }
    stale.push({stage: 'plan', record: p.hash, why: v.why});
  }
  if (!valid) {
    return {...base, gate: 'plan', mode: t ? 'revalidate' : 'author', requirement, stale,
      reason: t ? 'a ticket exists; its assumptions, scope, dependencies and acceptance criteria need re-checking' : 'no approved plan and no ticket: evaluation and planning'};
  }
  const chain = chainFrom(valid, stages);
  const reuse = Object.fromEntries(chain.map(s => [s.stage, s.hash]));
  const last = chain.at(-1);
  // A later attempt of the next stage that returned work to an earlier stage, or is pending/blocked, decides.
  const nextName = STAGES[STAGES.indexOf(last.stage) + 1] ?? null;
  // Follow the explicit handoff only: a record with equal output bytes from another chain is not this attempt.
  const tried = stages.filter(s => s.handoff?.from === last.hash);
  const latestTry = tried.at(-1) ?? null;
  if (latestTry?.status === 'returned') {
    const to = latestTry.next.stage;
    const back = chain.find(s => s.stage === STAGES[STAGES.indexOf(to) - 1]) ?? null;
    return {...base, gate: to, mode: 'revise', requirement, reuse: Object.fromEntries(chain.filter(s => STAGES.indexOf(s.stage) < STAGES.indexOf(to)).map(s => [s.stage, s.hash])),
      from: back?.hash ?? null, findings: latestTry.findings, returned_by: latestTry.hash, stale, reason: `${latestTry.stage} returned the work to ${to}: ${latestTry.next.why}`};
  }
  // A transient pending whose retry is due goes back to its stage (the executor resumes its open cycle; the scheduler
  // bounds the retries on the same inputs). Before it is due, or for a structural pending, the item is blocked.
  if (latestTry?.status === 'pending' && latestTry.blocker?.transient && Date.parse(latestTry.blocker.retry_at ?? '') <= now) {
    return {...base, gate: latestTry.stage, mode: 'resume', requirement, reuse, from: last.hash, retry_of: latestTry.hash, stale,
      reason: `${latestTry.stage} was pending on a transient failure (${latestTry.blocker.what}); its retry is due`};
  }
  if (latestTry && (latestTry.status === 'pending' || latestTry.status === 'blocked')) {
    return {...base, gate: 'blocked', stage: latestTry.stage, requirement, reuse, from: last.hash, blocker: latestTry.blocker, stale,
      reason: `${latestTry.stage} is ${latestTry.status}: ${latestTry.blocker?.what ?? latestTry.next?.why ?? ''}`};
  }
  if (!nextName) return {...base, gate: 'awaiting-owner', requirement, reuse, stale, reason: 'the outcome is recorded; the owner signs the status transition',
    blocker: {what: 'an unsigned status transition', role: 'decision-authority', resume_when: 'the owner applies (or declines) the proposal'}};
  return {...base, gate: nextName, requirement, reuse, from: last.hash, stale, reason: `${last.stage} passed and is reused; ${nextName} is next`};
}
