// The work ledger: the controller's signed record of who is working on what, at which stage, with which inputs
// and outputs. The status ledger (packages/ledger/status.mjs) stays authoritative for an item's status and only
// the owner signs it; this ledger records the governed lifecycle that produces the evidence a status proposal
// cites. Every receiving stage re-derives its handoff from this ledger before it proceeds.
//
// Kinds (schema ophanim.work/v1), each re-derived on append and on every verify:
//   work.intake   a source of work seen by reconciliation: a status item, a published issue, a ticket. An issue
//                 with no ledger item is a CANDIDATE: it is recorded, never executed, until the owner adds an item.
//                 ONCE PER SOURCE: an intake carrying `once: 1` (every intake this module writes since independent
//                 review, assignment 1, Google gemini-4-carbon, 09d490f, question 7) is refused when an intake of the
//                 same {source, ref} is already recorded. Older intakes carry no marker and keep verifying as written.
//   work.claim    the controller takes one stage of one item: attempt, idempotency key, lease, budget. Refused
//                 while another unreleased, unexpired claim on the same item exists (no duplicate execution), and
//                 refused when the same idempotency key already completed (no paying twice for the same inputs).
//                 A FENCED claim (payload `fence: 1`, every claim this module writes) is also refused while ANY earlier
//                 claim on the item is unreleased, expired or not: `claim()` first releases an expired one as `expired`,
//                 so two claims can never both lead to recorded stages (independent review, assignment 3, Q3/Q4).
//   work.release  the claim ends: completed, returned, failed, blocked, interrupted or expired. Cites its claim.
//   work.spend    provider calls CHARGED under a claim, recorded (signed) BEFORE the calls are made: {item, stage,
//                 attempt, provider_calls (cumulative for the claim), at}. A call that already left the process is
//                 therefore on the ledger even when the process dies before its stage record, and `spent()`
//                 (scheduler.mjs) counts it, so a restarted attempt cannot spend a full budget again. Refused once the
//                 claim is released or its lease has expired at `at`: a stale holder cannot charge (or make) new calls.
//   work.stage    the stage's result, citing its claim. THE LEASE FENCE: refused when its claim was already released
//                 (any outcome), and -- for a record carrying `at` (the recording time; every record this module writes
//                 since the fence; older records carry none and keep verifying as written) -- when the claim's lease had
//                 expired at `at` (leased_at + lease_ms <= at) or the claim already has a stage record. A holder that
//                 outlived its lease cannot make its late result the handoff. Its handoff is verified on append: the identity (item,
//                 ticket, requirement) matches the previous stage's, and the inputs it names are exactly the
//                 previous stage's outputs (by digest). Team, contributions, findings, usage, next stage and any
//                 blocker are part of the record.
//                 THE LINEAGE RULE (a record carrying `lineage: 1`, every record this module writes since independent
//                 review, assignment 1, Google gemini-4-carbon, 09d490f, question 2; older records keep verifying as
//                 written): only a plan starts without a handoff, and a handoff from a passed record is from the stage
//                 immediately before this one (no stage is skipped).
//   work.recovery an evidence-recovery attempt for an item Resolved without completion evidence: the status entry
//                 it was made against, the digest of the sources searched, every source with its result, and, when
//                 evidence was recovered, the digest of the UNSIGNED proposal written for the owner. Only the owner
//                 applies it to the status ledger (evidence-recovery.mjs).
//   work.reassessment  NEW EVIDENCE about a closed review cycle, never a change to it: under a later identity policy
//                 (an alias or lab correction), which of its recorded reviews would not qualify, and why. It names
//                 the cycle, the policy the cycle recorded and the policy it was reassessed under. The cycle's own
//                 ledger keeps verifying under its recorded policy; what follows from the evidence is the owner's.
//
// Inputs: an absolute root (default <repo>/status/work). Outputs: the API below. Must never: sign a status, read
// the owner's keys, or accept a stage whose handoff does not re-derive.
import fs from 'node:fs';
import path from 'node:path';
import {openLedger, createLedger, defineKinds, generateSigner} from '../../packages/ledger/chain.mjs';
import {keyStore} from '../../packages/ledger/home.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';

export const WORK_SCHEMA = 'ophanim.work/v1';
// The governed lifecycle, in order. `plan` is evaluation and planning (evidence, problem, plan, independent
// review, revision). `implement` is coding with checks and in-run review. `review` is the coordinated three-lab
// cycle review of the change. `validate` judges the exact implementation against the original requirement and
// the approved acceptance criteria. `outcome` records the unsigned status transition for the owner.
export const STAGES = Object.freeze(['plan', 'implement', 'review', 'validate', 'outcome']);
export const STAGE_STATUS = Object.freeze(['passed', 'returned', 'failed', 'pending', 'blocked']);
export const RELEASE_OUTCOMES = Object.freeze(['completed', 'returned', 'failed', 'blocked', 'interrupted', 'expired']);
export const INTAKE_SOURCES = Object.freeze(['status', 'issue', 'ticket']);
export const INTAKE_CLASSES = Object.freeze(['item', 'candidate', 'coordination']);
export const RECOVERY_OUTCOMES = Object.freeze(['recovered', 'not-found']);
/** Why a claim may no longer record a result or charge a call at `at` (ms), or null. Shared by append and re-derivation. */
export function fenceRefusal(claim, {released, at}) {
  if (released) return `the claim (${claim.stage}, attempt ${claim.attempt}) was already released (${released.outcome ?? 'released'}): LEASE_FENCED, a released claim records nothing`;
  const until = Date.parse(claim.leased_at) + claim.lease_ms;
  if (Number.isFinite(at) && until <= at) return `the claim's lease (${claim.stage}, attempt ${claim.attempt}) expired at ${new Date(until).toISOString()}, before ${new Date(at).toISOString()}: LEASE_FENCED, a holder past its lease records nothing`;
  return null;
}
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const ISO = s => typeof s === 'string' && !Number.isNaN(Date.parse(s));
const str = v => typeof v === 'string' && v.trim() !== '';
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonneg = v => Number.isInteger(v) && v >= 0;
const fail = (why, code = 'WORK_REFUSED') => { throw Object.assign(new Error(why), {code}); };

/** The digest the handoff compares: a stage's outputs, canonical. */
export const outputsDigest = outputs => 'sha256:' + digest(outputs ?? {});
/** The idempotency key of a stage attempt: the same item, stage and inputs are the same work. */
export const workKey = ({item, stage, inputs}) => 'sha256:' + digest({item, stage, inputs: inputs ?? {}});

const budgetRefusal = b => {
  if (!plain(b)) return 'a claim names its budget {provider_calls, iterations, elapsed_ms, retries}';
  for (const k of ['provider_calls', 'iterations', 'elapsed_ms', 'retries']) if (!(Number.isInteger(b[k]) && b[k] >= 0)) return `budget.${k} is a non-negative integer, declared before dispatch`;
  return null;
};
const identityRefusal = id => {
  if (!plain(id) || !ID.test(id.item ?? '') || !SHA.test(id.requirement ?? '')) return 'a stage names its identity {item, requirement, ticket?}';
  if (id.ticket != null && !(plain(id.ticket) && str(id.ticket.path) && SHA.test(id.ticket.digest ?? ''))) return 'identity.ticket is {path, digest}';
  return null;
};

function kinds({operators}) {
  const byController = a => operators.includes(a.key_id);
  const entriesOf = (view, kind) => view.entries().filter(h => view.entry(h)?.kind === kind);
  const releaseOf = (view, claim) => entriesOf(view, 'work.release').find(h => view.entry(h).derived_from.includes(claim)) ?? null;
  return {
    'work.recovery': {
      authors: byController,
      validate: p => {
        if (p?.schema !== WORK_SCHEMA || !ID.test(p.item ?? '') || !SHA.test(p.status_entry ?? '') || !SHA.test(p.sources ?? '') || !ISO(p.at)) {
          return 'a recovery names {item, status_entry, sources, outcome, searched, at}';
        }
        if (!RECOVERY_OUTCOMES.includes(p.outcome)) return `a recovery outcome is one of ${RECOVERY_OUTCOMES.join(', ')}`;
        if (!Array.isArray(p.searched) || !p.searched.every(x => plain(x) && str(x.source) && str(x.result) && str(x.why))) return 'a recovery lists every source searched {source, ref, result, why}';
        if (p.outcome === 'recovered' ? !(plain(p.proposal) && SHA.test(p.proposal.digest ?? '') && p.searched.some(x => x.result === 'recovered'))
          : p.proposal !== undefined) return 'a recovered outcome names the proposal digest it wrote, and only a recovered one does';
        return null;
      },
      // One attempt per item, status entry and set of sources: the same search is never recorded (or paid for) twice.
      rederive: (e, view) => entriesOf(view, 'work.recovery').some(h => {
        const q = view.payload(h);
        return q.item === e.payload.item && q.status_entry === e.payload.status_entry && q.sources === e.payload.sources;
      }) ? `a recovery of "${e.payload.item}" against these sources and this status is already recorded` : null,
    },
    'work.reassessment': {
      authors: byController,
      validate: p => (p?.schema === WORK_SCHEMA && ID.test(p.item ?? '') && SHA.test(p.cycle ?? '') && SHA.test(p.recorded_policy ?? '') && SHA.test(p.policy ?? '')
        && p.recorded_policy !== p.policy && Array.isArray(p.findings) && p.findings.every(x => plain(x) && (x.review === null || SHA.test(x.review ?? '')) && str(x.why)) && ISO(p.at)
        && (p.policy_rules === undefined || plain(p.policy_rules))
        ? null : 'a reassessment names {item, cycle, recorded_policy, policy (another one), findings: [{review, why}], policy_rules?, at}'),
      // One reassessment of a cycle per policy: the same evidence is not recorded twice.
      rederive: (e, view) => (entriesOf(view, 'work.reassessment').some(h => { const q = view.payload(h); return q.cycle === e.payload.cycle && q.policy === e.payload.policy; })
        ? 'this cycle is already reassessed under that policy' : null),
    },
    'work.intake': {
      authors: byController,
      validate: p => p?.schema === WORK_SCHEMA && INTAKE_SOURCES.includes(p.source) && str(p.ref) && INTAKE_CLASSES.includes(p.classification)
        && (p.item === null || ID.test(p.item ?? '')) && str(p.why) && ISO(p.at) ? null
        : 'an intake names {source, ref, item|null, classification, why, at}',
      rederive: (e, view) => {
        if ((e.payload.classification === 'item') !== (e.payload.item !== null)) return 'only an intake classified as an item names one; a candidate or coordination issue is never an item until the owner adds it';
        if (e.payload.once === 1 && entriesOf(view, 'work.intake').some(h => h !== e.hash && view.payload(h).source === e.payload.source && view.payload(h).ref === e.payload.ref)) {
          return `the ${e.payload.source} source ${e.payload.ref} is already recorded: intake is recorded once per source`;
        }
        return null;
      },
    },
    'work.claim': {
      authors: byController,
      validate: p => {
        if (p?.schema !== WORK_SCHEMA || !ID.test(p.item ?? '') || !STAGES.includes(p.stage)) return 'a claim names {item, stage}';
        if (!(Number.isInteger(p.attempt) && p.attempt >= 1) || !SHA.test(p.key ?? '') || !str(p.holder)) return 'a claim names {attempt >= 1, key, holder}';
        if (!ISO(p.leased_at) || !(Number.isInteger(p.lease_ms) && p.lease_ms > 0)) return 'a claim names its lease {leased_at, lease_ms}';
        return budgetRefusal(p.budget);
      },
      rederive: (e, view) => {
        const p = e.payload, at = Date.parse(p.leased_at);
        for (const h of entriesOf(view, 'work.claim')) {
          const c = view.payload(h);
          if (c.item !== p.item) continue;
          const rel = releaseOf(view, h);
          // A fenced claim waits for every earlier claim on the item to be released (an expired one as `expired`).
          if (!rel && p.fence === 1 && Date.parse(c.leased_at) + c.lease_ms <= at) return `"${p.item}" has an unreleased claim (${c.stage}, attempt ${c.attempt}) whose lease expired: release it as expired before claiming again`;
          if (!rel && Date.parse(c.leased_at) + c.lease_ms > at) return `"${p.item}" is already claimed (${c.stage}, attempt ${c.attempt}, lease until ${new Date(Date.parse(c.leased_at) + c.lease_ms).toISOString()}): no duplicate execution`;
          if (rel && c.key === p.key && view.payload(rel).outcome === 'completed') return `"${p.item}" ${p.stage} already completed for these exact inputs (${p.key.slice(0, 19)}): reuse it, do not pay twice`;
        }
        return null;
      },
    },
    'work.release': {
      authors: byController,
      validate: p => p?.schema === WORK_SCHEMA && ID.test(p.item ?? '') && STAGES.includes(p.stage) && RELEASE_OUTCOMES.includes(p.outcome) && ISO(p.at) && str(p.why)
        ? null : 'a release names {item, stage, outcome, why, at}',
      rederive: (e, view) => {
        const claims = e.derived_from.filter(h => view.entry(h)?.kind === 'work.claim');
        if (claims.length !== 1) return 'a release cites exactly one claim';
        const c = view.payload(claims[0]);
        if (c.item !== e.payload.item || c.stage !== e.payload.stage) return 'a release names its claim\'s item and stage';
        const other = entriesOf(view, 'work.release').find(h => h !== e.hash && view.entry(h).derived_from.includes(claims[0]));
        return other ? 'that claim is already released' : null;
      },
    },
    'work.spend': {
      authors: byController,
      validate: p => p?.schema === WORK_SCHEMA && ID.test(p.item ?? '') && STAGES.includes(p.stage) && Number.isInteger(p.attempt) && p.attempt >= 1
        && Number.isInteger(p.provider_calls) && p.provider_calls >= 1 && ISO(p.at) ? null
        : 'a spend names {item, stage, attempt, provider_calls >= 1 (cumulative under its claim), at}',
      rederive: (e, view) => {
        const claims = e.derived_from.filter(h => view.entry(h)?.kind === 'work.claim');
        if (claims.length !== 1) return 'a spend cites the claim it was charged under';
        const c = view.payload(claims[0]), p = e.payload;
        if (c.item !== p.item || c.stage !== p.stage || c.attempt !== p.attempt) return 'a spend matches its claim (item, stage, attempt)';
        const rel = releaseOf(view, claims[0]);
        const why = fenceRefusal(c, {released: rel ? view.payload(rel) : null, at: Date.parse(p.at)});
        if (why) return why;
        if (p.provider_calls > c.budget.provider_calls) return `a spend of ${p.provider_calls} is over its claim's budget of ${c.budget.provider_calls} provider call(s)`;
        const prev = entriesOf(view, 'work.spend').filter(h => h !== e.hash && view.entry(h).derived_from.includes(claims[0])).map(h => view.payload(h).provider_calls);
        return prev.some(n => n >= p.provider_calls) ? 'a spend is cumulative: it only grows under its claim' : null;
      },
    },
    'work.stage': {
      authors: byController,
      validate: p => {
        if (p?.schema !== WORK_SCHEMA || !STAGES.includes(p.stage) || !STAGE_STATUS.includes(p.status)) return 'a stage names {stage, status}';
        const why = identityRefusal(p.identity);
        if (why) return why;
        if (!(Number.isInteger(p.attempt) && p.attempt >= 1)) return 'a stage names its attempt';
        if (!plain(p.inputs) || !plain(p.outputs)) return 'a stage names its inputs and outputs';
        if (!Array.isArray(p.team) || !p.team.every(t => plain(t) && str(t.role))) return 'a stage names its team [{role, vendor?, model?, lab?}]';
        if (!Array.isArray(p.contributions) || !Array.isArray(p.findings)) return 'a stage names its contributions and findings';
        if (!plain(p.usage) || !(p.usage.provider_calls === null || nonneg(p.usage.provider_calls))) return 'a stage names its usage {provider_calls (null when unknown), tokens?, elapsed_ms?}';
        if (p.next !== null && !(plain(p.next) && (p.next.stage === null || STAGES.includes(p.next.stage)) && str(p.next.why))) return 'next is null or {stage|null, why}';
        if (p.status === 'blocked' && !(plain(p.blocker) && str(p.blocker.what) && str(p.blocker.role) && str(p.blocker.resume_when))) {
          return 'a blocked stage names its blocker {what, role, resume_when}';
        }
        if (p.status === 'returned' && !(p.next && STAGES.indexOf(p.next.stage) >= 0 && STAGES.indexOf(p.next.stage) <= STAGES.indexOf(p.stage))) {
          return 'a returned stage names the earlier (or same) stage it returns to';
        }
        return null;
      },
      rederive: (e, view) => {
        const p = e.payload;
        const claims = e.derived_from.filter(h => view.entry(h)?.kind === 'work.claim');
        if (claims.length !== 1) return 'a stage cites the claim it ran under';
        const c = view.payload(claims[0]);
        if (c.item !== p.identity.item || c.stage !== p.stage || c.attempt !== p.attempt) return 'a stage matches its claim (item, stage, attempt)';
        // THE LEASE FENCE (see the header). A released claim never records; a record that carries `at` is also refused
        // past the lease, and once its claim already has a result.
        const rel = releaseOf(view, claims[0]);
        if (p.at !== undefined && !ISO(p.at)) return 'a stage\'s `at` is its recording time (ISO)';
        const fenced = fenceRefusal(c, {released: rel ? view.payload(rel) : null, at: p.at === undefined ? NaN : Date.parse(p.at)});
        if (fenced) return fenced;
        if (p.at !== undefined && entriesOf(view, 'work.stage').some(h => h !== e.hash && view.entry(h).derived_from[0] === claims[0])) return 'that claim already has a stage record';
        // The handoff: the stage it received from, if any, is the same work, and what this stage consumed is exactly
        // what that stage produced.
        const from = p.handoff?.from ?? null;
        if (p.lineage === 1 && from === null && p.stage !== 'plan') return `a ${p.stage} stage starts from a handoff; only a plan starts without one`;
        if (from !== null) {
          if (!e.derived_from.includes(from) || view.entry(from)?.kind !== 'work.stage') return 'a handoff cites the stage record it received';
          const prev = view.payload(from);
          if (prev.identity.item !== p.identity.item || prev.identity.requirement !== p.identity.requirement) {
            return 'a handoff keeps the item and the original requirement';
          }
          if (prev.status !== 'passed' && !(prev.status === 'returned' && prev.next?.stage === p.stage)) return `a handoff starts from a passed stage, or one that returned to this stage (it was ${prev.status})`;
          if (p.lineage === 1 && prev.status === 'passed' && prev.stage !== STAGES[STAGES.indexOf(p.stage) - 1]) return `${p.stage} receives from ${STAGES[STAGES.indexOf(p.stage) - 1] ?? 'no stage'}, not ${prev.stage}: no stage is skipped`;
          if (p.inputs.upstream !== outputsDigest(prev.outputs)) return 'the stage\'s inputs are not the outputs of the stage it received from';
        }
        return null;
      },
    },
  };
}

/**
 * Why `from` is not a valid handoff for `stage` of `item`, or null. The WHOLE chain is re-derived, not one hop: from
 * `from` back to its plan, each record is this item's, passed, the stage immediately before the one it hands to, keeps
 * the original requirement (and, given `requirement`, the one the gate asks for), and its inputs are exactly the outputs
 * of the record it received. Only a plan starts the chain. (Independent review, assignment 1, Google gemini-4-carbon,
 * 09d490f, question 2: a stage consumed a record that started from nothing, or another item's.)
 */
export function handoffRefusal(work, {item, stage, from, requirement = null}) {
  if (!from) return stage === 'plan' ? null : `${item}: ${stage} has no handoff to start from`;
  const mine = work.stages(item);
  const byHash = new Map(mine.map(s => [s.hash, s]));
  let rec = byHash.get(from), want = stage;
  if (!rec) return `${item}: the handoff ${String(from).slice(0, 19)} is not a stage record of this item`;
  const head = rec;
  for (;;) {
    const wanted = STAGES[STAGES.indexOf(want) - 1];
    if (rec.stage !== wanted) return `${item}: ${want} receives from ${wanted}, not ${rec.stage}`;
    if (rec.status !== 'passed') return `${item}: the ${rec.stage} handoff is ${rec.status}, not passed`;
    if (rec.identity?.item !== item) return `${item}: the ${rec.stage} record is of "${rec.identity?.item}"`;
    if (rec.identity.requirement !== head.identity.requirement) return `${item}: the ${rec.stage} record was made for another requirement than the rest of its chain`;
    if (requirement && rec.identity.requirement !== requirement) return `${item}: the ${rec.stage} record was made for another requirement than the one the gate asks for`;
    const up = rec.handoff?.from ?? null;
    if (rec.stage === 'plan') return up === null ? null : `${item}: the plan record names a handoff`;
    if (!up) return `${item}: the ${rec.stage} record starts from no handoff; only a plan does`;
    const prev = byHash.get(up);
    if (!prev) return `${item}: the ${rec.stage} record's handoff is not a stage record of this item`;
    if (rec.inputs?.upstream !== outputsDigest(prev.outputs)) return `${item}: the ${rec.stage} record's inputs are not the outputs of the record it received`;
    want = rec.stage;
    rec = prev;
  }
}

/** Open (or create on first use) the work ledger at `root`. Keys for the controller live under <root>/keys. */
export function openWorkLedger({root, create = true, keys = null, anchor = null}) {
  if (!root || !path.isAbsolute(root)) fail('an absolute work ledger root is required');
  const anchorFile = path.join(root, 'ANCHOR');
  if (!create && !fs.existsSync(anchorFile)) fail(`no work ledger at ${root}`);
  fs.mkdirSync(root, {recursive: true});
  const keysDir = keys ?? path.join(root, 'keys');
  let pinned = fs.existsSync(anchorFile) ? fs.readFileSync(anchorFile, 'utf8').trim() : null;
  if (!pinned) {
    if (fs.existsSync(path.join(root, 'chain.jsonl'))) fail('a work ledger without its ANCHOR is not opened');
    const store = keyStore(keysDir);
    const op = store.put(generateSigner('controller')), order = store.put(generateSigner('work-orderer'));
    pinned = createLedger({dir: root, operator: op, order,
      authority: {keyring: {controller: op.publicJwk, 'work-orderer': order.publicJwk}, orderer: 'work-orderer', operators: ['controller']}});
    fs.writeFileSync(anchorFile, pinned + '\n');
  }
  if (anchor && anchor !== pinned) fail('this work ledger is not the one the caller pinned');
  let operators = ['controller'];
  const open = () => openLedger({dir: root, kinds: defineKinds(kinds({operators})), anchor: pinned});
  let L = open();
  const state = L.verify();
  if (!state.ok) fail(`work ledger does not verify: ${state.why}`);
  operators = state.authority.operators;
  L = open();

  const view = () => {
    const at = new Map(L.read().map(e => [L.hashOf(e), e]));
    return {entry: h => at.get(h) ?? null, payload: h => (at.has(h) ? L.payloadOf(at.get(h)) : null), entries: () => [...at.keys()]};
  };
  const signers = () => {
    // A reader without the controller's keys can verify and project, never record (a concrete block, not a skip).
    if (!fs.existsSync(keysDir)) fail('no controller key is held here: the work ledger can be verified, not changed', 'NO_AUTHORITY');
    const store = keyStore(keysDir);
    const op = operators.map(id => store.get(id)).find(Boolean), order = store.get(state.authority.orderer);
    if (!op || !order) fail('no controller key is held here: the work ledger can be verified, not changed', 'NO_AUTHORITY');
    return {op, order};
  };
  const append = (kind, payload, derivedFrom = []) => {
    const {op, order} = signers();
    return L.append({kind, payload: {schema: WORK_SCHEMA, ...payload}, author: {key_id: op.key_id}, signer: op, order, derivedFrom}).hash;
  };
  const of = (kind, pred = () => true) => { const v = view(); return v.entries().filter(h => v.entry(h).kind === kind).map(h => ({hash: h, ...v.payload(h), derived_from: v.entry(h).derived_from})).filter(pred); };
  const released = claimHash => of('work.release', r => r.derived_from.includes(claimHash))[0] ?? null;
  const fence = (claimHash, at) => {
    const c = of('work.claim', x => x.hash === claimHash)[0];
    if (!c) fail('no such claim');
    const why = fenceRefusal(c, {released: released(claimHash), at: Date.parse(at)});
    if (why) fail(why, 'LEASE_FENCED');
    return c;
  };

  return {
    ledger: L, anchor: pinned, root,
    verify: () => L.verify(),
    intake: ({source, ref, item = null, classification, why, at = new Date().toISOString()}) => append('work.intake', {source, ref, item, classification, why, at, once: 1}),
    /** Claim one stage of one item. Throws (code WORK_REFUSED) on a duplicate or an already-completed key. */
    // An unreleased claim on the item whose lease expired at `at` is first released as `expired` (a claim racing to
    // release it is fine: the ledger refuses the second release, and the fenced claim then re-derives).
    claim: ({item, stage, attempt, inputs, holder, budget, lease_ms = 30 * 60_000, at = new Date().toISOString()}) => {
      for (const c of of('work.claim', x => x.item === item && !released(x.hash) && Date.parse(x.leased_at) + x.lease_ms <= Date.parse(at))) {
        try { append('work.release', {item: c.item, stage: c.stage, outcome: 'expired', why: 'the lease expired without a recorded result: released before a new claim', at}, [c.hash]); }
        catch (e) { if (!/already released/.test(e.message)) throw e; }
      }
      return append('work.claim', {item, stage, attempt, key: workKey({item, stage, inputs}), holder, leased_at: at, lease_ms, budget, fence: 1});
    },
    release: ({claim, item, stage, outcome, why, at = new Date().toISOString()}) => append('work.release', {item, stage, outcome, why, at}, [claim]),
    /** Record a stage's result under its claim; `from` is the stage record it received (verified on append). */
    // Refused up front (code LEASE_FENCED) when the claim is released or its lease expired at `at`; the ledger's
    // re-derivation refuses the same, so the check cannot be skipped by appending directly.
    recordStage: ({claim, from = null, at = new Date().toISOString(), ...rec}) => {
      fence(claim, at);
      return append('work.stage', {...rec, at, handoff: {from}, lineage: 1}, [claim, ...(from ? [from] : [])]);
    },
    /** Charge provider calls under a live claim, BEFORE they are made: `provider_calls` is the claim's cumulative count. */
    recordSpend: ({claim, provider_calls, at = new Date().toISOString()}) => {
      const c = fence(claim, at);
      return append('work.spend', {item: c.item, stage: c.stage, attempt: c.attempt, provider_calls, at}, [claim]);
    },
    releases: () => of('work.release'),
    spends: claimHash => of('work.spend', s => claimHash === undefined || s.derived_from.includes(claimHash)),
    /** Record an evidence-recovery attempt (evidence-recovery.mjs). Writes nothing to the status ledger. */
    recordRecovery: ({item, status_entry, sources, outcome, searched, proposal = undefined, at = new Date().toISOString()}) =>
      append('work.recovery', {item, status_entry, sources, outcome, searched, ...(proposal !== undefined ? {proposal} : {}), at}),
    recoveries: item => of('work.recovery', r => item === undefined || r.item === item),
    /** Record what a later identity policy says about a closed cycle's reviews (pantheon review/identity.mjs `reassess`). */
    recordReassessment: ({item, cycle, recorded_policy, policy, findings, policy_rules = undefined, at = new Date().toISOString()}) =>
      append('work.reassessment', {item, cycle, recorded_policy, policy, findings, ...(policy_rules !== undefined ? {policy_rules} : {}), at}),
    reassessments: item => of('work.reassessment', r => item === undefined || r.item === item),
    intakes: () => of('work.intake'),
    claims: item => of('work.claim', c => item === undefined || c.item === item),
    stages: item => of('work.stage', s => item === undefined || s.identity.item === item),
    /** The claim on `item` that is unreleased and unexpired at `now`, or null. */
    activeClaim: (item, now = Date.now()) => of('work.claim', c => c.item === item).find(c => !released(c.hash) && Date.parse(c.leased_at) + c.lease_ms > now) ?? null,
    /** Claims left open past their lease: interrupted work, to release as expired before a bounded resume. */
    expiredClaims: (now = Date.now()) => of('work.claim', c => !released(c.hash) && Date.parse(c.leased_at) + c.lease_ms <= now),
    released,
  };
}
