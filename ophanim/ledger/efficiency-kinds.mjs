// K5: OPHANIM's efficiency records as ledger kinds (docs/ledger-provenance-evaluation.md).
//
//   efficiency.promotion  an authorized 1 -> 3 slot policy and the figures it was qualified on
//   efficiency.use        one state directory running under that promotion; cites it; at most `maxUses`
//                         uses per promotion, counted from the earlier entries on the chain itself
//   efficiency.result     a qualified convergence realized under a use; cites the use; its saving must
//                         equal the promotion's baselineConservativeMs - executionMs - assessmentCostMs
//   efficiency.debit      one assessment's cost under a use; cites the use; non-negative; `charged` must
//                         be false exactly when a result for the same trace already deducts that cost
//
// The side files these replace could be added, edited or negated by anyone with the directory (the
// "debit loophole"). Here every figure is signed by its author and re-derived from the entries it cites
// before it is written and on every replay, and totals are read only from a ledger that verifies.
import {digest} from '../board.mjs';

export const MAX_USES = 20;
export const PROMOTION = 'ophanim.efficiency-promotion/v1';
export const USE = 'ophanim.efficiency-use/v1';
export const RESULT = 'ophanim.efficiency-result/v1';
export const DEBIT = 'ophanim.efficiency-debit/v2';

const SHA = /^[0-9a-f]{64}$/;
const REF = /^sha256:[0-9a-f]{64}$/;
const count = v => Number.isSafeInteger(v) && v >= 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const cited = (view, hashes, kind) => hashes.filter(h => view.entry(h)?.kind === kind);
// Earlier entries of `kind` that cite `hash`, with their payloads.
const citing = (view, kind, hash) => view.entries()
  .filter(h => view.entry(h).kind === kind && view.entry(h).derived_from.includes(hash))
  .map(h => ({hash: h, payload: view.payload(h)}));

const FIGURES = ['baselineConservativeMs', 'candidateConservativeMs', 'conservativeSavedMs', 'totalAssessmentCostMs'];
const PROMOTION_KEYS = ['schema', 'scopeSha', 'decisionId', 'fromSlots', 'toSlots', 'maxUses', 'efficiency'];
const USE_KEYS = ['schema', 'useId', 'stateDir', 'scopeSha', 'decisionId'];
const RESULT_KEYS = ['schema', 'traceSha', 'executionMs', 'assessmentCostMs', 'observedSavingMs'];
const DEBIT_KEYS = ['schema', 'traceSha', 'assessmentCostMs', 'charged', 'interrupted'];

// The use an entry cites (exactly one), and the promotion that use cites.
function useAndPromotion(e, view) {
  const uses = cited(view, e.derived_from, 'efficiency.use');
  if (uses.length !== 1 || e.derived_from.length !== 1) return {why: 'it cites exactly one efficiency.use and nothing else'};
  const use = view.entry(uses[0]);
  const promotion = use.derived_from[0];
  return {use: uses[0], promotion, promotionPayload: view.payload(promotion)};
}

/** Kind specs. `authors.promotion` may record promotions; `authors.events` uses, results and debits. */
export function efficiencyKinds({authors = {}} = {}) {
  const promoters = authors.promotion ?? (() => true), events = authors.events ?? (() => true);
  return {
    'efficiency.promotion': {
      authors: promoters,
      validate: p => (exact(p, PROMOTION_KEYS) && p.schema === PROMOTION ? null : 'a promotion is an efficiency-promotion record'),
      rederive: e => {
        const p = e.payload, f = p.efficiency;
        if (e.derived_from.length) return 'a promotion cites nothing on this chain; its authority is the signed decision it names';
        if (!SHA.test(p.scopeSha) || !REF.test(p.decisionId)) return 'a promotion names its scope and decision by hash';
        if (p.fromSlots !== 1 || p.toSlots !== 3) return 'the admitted experiment is 1 -> 3 slots only';
        if (p.maxUses !== MAX_USES) return `a promotion is bounded to ${MAX_USES} qualified uses`;
        if (!exact(f, FIGURES) || !FIGURES.every(k => count(f[k]))) return 'efficiency figures are non-negative integers';
        if (f.conservativeSavedMs !== f.baselineConservativeMs - f.candidateConservativeMs) return 'conservativeSavedMs is not baseline - candidate';
        return null;
      },
    },
    'efficiency.use': {
      authors: events,
      validate: p => (exact(p, USE_KEYS) && p.schema === USE ? null : 'a use is an efficiency-use record'),
      rederive: (e, view) => {
        const p = e.payload;
        const promotions = cited(view, e.derived_from, 'efficiency.promotion');
        if (promotions.length !== 1 || e.derived_from.length !== 1) return 'a use cites exactly one efficiency.promotion and nothing else';
        const promotion = view.payload(promotions[0]);
        if (typeof p.stateDir !== 'string' || !p.stateDir.startsWith('/') || p.useId !== digest(p.stateDir)) return 'useId is the digest of the state directory';
        if (p.scopeSha !== promotion.scopeSha || p.decisionId !== promotion.decisionId) return 'the use names a different scope or decision than the promotion it cites';
        const earlier = citing(view, 'efficiency.use', promotions[0]);
        if (earlier.some(u => u.payload.useId === p.useId)) return 'this state directory already has a use under this promotion';
        if (earlier.length >= promotion.maxUses) return `the promotion's ${promotion.maxUses} uses are spent`;
        return null;
      },
    },
    'efficiency.result': {
      authors: events,
      validate: p => (exact(p, RESULT_KEYS) && p.schema === RESULT ? null : 'a result is an efficiency-result record'),
      rederive: (e, view) => {
        const p = e.payload, at = useAndPromotion(e, view);
        if (at.why) return `a result: ${at.why}`;
        if (!SHA.test(p.traceSha) || !count(p.executionMs) || !count(p.assessmentCostMs) || !Number.isSafeInteger(p.observedSavingMs)) return 'a result names its trace and non-negative integer times';
        const expected = at.promotionPayload.efficiency.baselineConservativeMs - p.executionMs - p.assessmentCostMs;
        if (p.observedSavingMs !== expected) return `observedSavingMs is ${p.observedSavingMs}, but the cited promotion's baseline gives ${expected}`;
        if (citing(view, 'efficiency.result', at.use).length) return 'this use already realized its result';
        return null;
      },
    },
    'efficiency.debit': {
      authors: events,
      validate: p => (exact(p, DEBIT_KEYS) && p.schema === DEBIT ? null : 'a debit is an efficiency-debit record'),
      rederive: (e, view) => {
        const p = e.payload, at = useAndPromotion(e, view);
        if (at.why) return `a debit: ${at.why}`;
        if (!SHA.test(p.traceSha) || !count(p.assessmentCostMs)) return 'a debit is a non-negative integer cost for one trace';
        if (typeof p.charged !== 'boolean' || !(p.interrupted === null || SHA.test(p.interrupted))) return 'charged is a boolean and interrupted a trace hash or null';
        if (citing(view, 'efficiency.debit', at.use).some(d => d.payload.traceSha === p.traceSha)) return 'this trace is already debited under this use';
        const deducted = citing(view, 'efficiency.result', at.use).some(r => r.payload.traceSha === p.traceSha);
        if (p.charged === deducted) return deducted ? 'the realized result already deducts this cost; it is not charged twice' : 'an assessment with no realized result is charged';
        return null;
      },
    },
  };
}

/**
 * Totals for one promotion, read from a ledger that verifies. Nothing here trusts an entry the chain did
 * not re-derive.
 */
export function efficiencyTotals(ledger, promotionHash) {
  const v = ledger.verify();
  if (!v.ok) throw Object.assign(new Error(`efficiency ledger does not verify: ${v.why}`), {code: 'LEDGER_REFUSED'});
  const entries = ledger.read(), by = new Map(entries.map(e => [ledger.hashOf(e), e]));
  const promotion = by.get(promotionHash);
  if (promotion?.kind !== 'efficiency.promotion') throw Error('no such efficiency.promotion on this ledger');
  const efficiency = ledger.payloadOf(promotion).efficiency;
  const uses = new Set(entries.filter(e => e.kind === 'efficiency.use' && e.derived_from[0] === promotionHash).map(ledger.hashOf));
  const under = kind => entries.filter(e => e.kind === kind && uses.has(e.derived_from[0])).map(e => ({use: e.derived_from[0], ...ledger.payloadOf(e)}));
  const results = under('efficiency.result'), debits = under('efficiency.debit');
  const additionalAssessmentCostMs = debits.reduce((s, d) => s + (d.charged ? d.assessmentCostMs : 0), 0);
  const unmeasuredAssessments = new Set(debits.filter(d => d.interrupted).map(d => `${d.use}:${d.interrupted}`)).size;
  return {
    qualifiedConvergences: results.length, uses: uses.size, originalOptimizationCostMs: efficiency.totalAssessmentCostMs,
    additionalAssessmentCostMs, unmeasuredAssessments,
    measuredNetMs: results.reduce((s, r) => s + r.observedSavingMs, -efficiency.totalAssessmentCostMs - additionalAssessmentCostMs),
    head: v.head,
  };
}

/**
 * The recorder assessment.mjs takes as `ledger`. Every method is idempotent on content: recording the
 * same promotion, use, result or debit again returns the entry already on the chain, so a resumed run
 * does not double-count. `charged` is derived here from the chain, not taken from the caller.
 */
export function efficiencyRecorder({ledger, controller, order}) {
  const by = {author: {key_id: controller.key_id}, signer: controller, order};
  const find = (kind, match) => {
    const e = ledger.read().find(x => x.kind === kind && match(x, ledger.payloadOf(x)));
    return e ? ledger.hashOf(e) : null;
  };
  const append = (kind, payload, derivedFrom) => ledger.append({kind, payload, derivedFrom, ...by}).hash;
  function promotion({scopeSha, decisionId, efficiency}) {
    const payload = {schema: PROMOTION, scopeSha, decisionId, fromSlots: 1, toSlots: 3, maxUses: MAX_USES,
      efficiency: Object.fromEntries(FIGURES.map(k => [k, efficiency[k]]))};
    return find('efficiency.promotion', (e, p) => p.scopeSha === scopeSha && p.decisionId === decisionId)
      ?? append('efficiency.promotion', payload, []);
  }
  return {
    verify: () => ledger.verify(),
    promotion,
    /** A use for this state directory, or null when the promotion's uses are spent. */
    use({scopeSha, decisionId, stateDir, efficiency}) {
      const p = promotion({scopeSha, decisionId, efficiency});
      const useId = digest(stateDir);
      const existing = find('efficiency.use', (e, x) => e.derived_from[0] === p && x.useId === useId);
      if (existing) return {promotion: p, use: existing};
      const spent = ledger.read().filter(e => e.kind === 'efficiency.use' && e.derived_from[0] === p).length;
      if (spent >= MAX_USES) return null;
      return {promotion: p, use: append('efficiency.use', {schema: USE, useId, stateDir, scopeSha, decisionId}, [p])};
    },
    result({use, result}) {
      const payload = {schema: RESULT, traceSha: result.traceSha, executionMs: result.executionMs,
        assessmentCostMs: result.assessmentCostMs, observedSavingMs: result.observedSavingMs};
      const existing = find('efficiency.result', (e, x) => e.derived_from[0] === use);
      if (existing) {
        const x = ledger.payloadOf(ledger.read().find(e => ledger.hashOf(e) === existing));
        if (digest(x) !== digest(payload)) throw Error('this use already realized a different result on the ledger');
        return existing;
      }
      return append('efficiency.result', payload, [use]);
    },
    debit({use, traceSha, assessmentCostMs, interrupted = null}) {
      const existing = find('efficiency.debit', (e, x) => e.derived_from[0] === use && x.traceSha === traceSha);
      if (existing) return existing;
      const charged = !find('efficiency.result', (e, x) => e.derived_from[0] === use && x.traceSha === traceSha);
      return append('efficiency.debit', {schema: DEBIT, traceSha, assessmentCostMs, charged, interrupted}, [use]);
    },
    totals: promotionHash => efficiencyTotals(ledger, promotionHash),
  };
}
