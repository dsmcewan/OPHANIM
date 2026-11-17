// The work ledger: the controller's signed record of who is working on what, at which stage, with which inputs
// and outputs. The status ledger (packages/ledger/status.mjs) stays authoritative for an item's status and only
// the owner signs it; this ledger records the governed lifecycle that produces the evidence a status proposal
// cites. Every receiving stage re-derives its handoff from this ledger before it proceeds.
//
// Kinds (schema ophanim.work/v1), each re-derived on append and on every verify:
//   work.intake   a source of work seen by reconciliation: a status item, a published issue, a ticket. An issue
//                 with no ledger item is a CANDIDATE: it is recorded, never executed, until the owner adds an item.
//   work.claim    the controller takes one stage of one item: attempt, idempotency key, lease, budget. Refused
//                 while another unreleased, unexpired claim on the same item exists (no duplicate execution), and
//                 refused when the same idempotency key already completed (no paying twice for the same inputs).
//   work.release  the claim ends: completed, returned, failed, blocked, interrupted or expired. Cites its claim.
//   work.stage    the stage's result, citing its claim. Its handoff is verified on append: the identity (item,
//                 ticket, requirement) matches the previous stage's, and the inputs it names are exactly the
//                 previous stage's outputs (by digest). Team, contributions, findings, usage, next stage and any
//                 blocker are part of the record.
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
    'work.intake': {
      authors: byController,
      validate: p => p?.schema === WORK_SCHEMA && INTAKE_SOURCES.includes(p.source) && str(p.ref) && INTAKE_CLASSES.includes(p.classification)
        && (p.item === null || ID.test(p.item ?? '')) && str(p.why) && ISO(p.at) ? null
        : 'an intake names {source, ref, item|null, classification, why, at}',
      rederive: e => (e.payload.classification === 'item') !== (e.payload.item !== null)
        ? 'only an intake classified as an item names one; a candidate or coordination issue is never an item until the owner adds it' : null,
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
        // The handoff: the stage it received from, if any, is the same work, and what this stage consumed is exactly
        // what that stage produced.
        const from = p.handoff?.from ?? null;
        if (from !== null) {
          if (!e.derived_from.includes(from) || view.entry(from)?.kind !== 'work.stage') return 'a handoff cites the stage record it received';
          const prev = view.payload(from);
          if (prev.identity.item !== p.identity.item || prev.identity.requirement !== p.identity.requirement) {
            return 'a handoff keeps the item and the original requirement';
          }
          if (prev.status !== 'passed' && !(prev.status === 'returned' && prev.next?.stage === p.stage)) return `a handoff starts from a passed stage, or one that returned to this stage (it was ${prev.status})`;
          if (p.inputs.upstream !== outputsDigest(prev.outputs)) return 'the stage\'s inputs are not the outputs of the stage it received from';
        }
        return null;
      },
    },
  };
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

  return {
    ledger: L, anchor: pinned, root,
    verify: () => L.verify(),
    intake: ({source, ref, item = null, classification, why, at = new Date().toISOString()}) => append('work.intake', {source, ref, item, classification, why, at}),
    /** Claim one stage of one item. Throws (code WORK_REFUSED) on a duplicate or an already-completed key. */
    claim: ({item, stage, attempt, inputs, holder, budget, lease_ms = 30 * 60_000, at = new Date().toISOString()}) =>
      append('work.claim', {item, stage, attempt, key: workKey({item, stage, inputs}), holder, leased_at: at, lease_ms, budget}),
    release: ({claim, item, stage, outcome, why, at = new Date().toISOString()}) => append('work.release', {item, stage, outcome, why, at}, [claim]),
    /** Record a stage's result under its claim; `from` is the stage record it received (verified on append). */
    recordStage: ({claim, from = null, ...rec}) => append('work.stage', {...rec, handoff: {from}}, [claim, ...(from ? [from] : [])]),
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
