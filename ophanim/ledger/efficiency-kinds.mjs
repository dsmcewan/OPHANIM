// ophanim/ledger/efficiency-kinds.mjs -- the efficiency records as ledger kinds, and their recorder.
//
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
// K5b: the assessment itself.
//   efficiency.trace      the convergence trace, carried whole, and the state directory whose board holds the
//                         snapshot it names; it re-derives against that content-addressed board commit
//   efficiency.assessed   the assessment report; cites its trace (and the retained experiment its admission
//                         read, and the debit its measured value ends on); re-derived by rederiveAssessment,
//                         the computation verifyEfficiencyRecord runs on the files
//   efficiency.retained   a completed 1 -> 3 experiment kept as prior evidence for its scope; cites the
//                         assessment that ran it; re-derived by retainedExperimentFrom, the computation
//                         readRetainedExperiment runs on the marker file
//
// The side files these replace could be added, edited or negated by anyone with the directory (the
// "debit loophole"). Here every figure is signed by its author and re-derived from the entries it cites
// before it is written and on every replay, and totals are read only from a ledger that verifies.
//
// Purpose: define the seven efficiency.* kinds (validate = shape, rederive = meaning against the entries
//   they cite and the board snapshot) and the recorder ophanim/efficiency/assessment.mjs writes through.
// Inputs:  efficiencyKinds({authors, snapshot}): who may author promotions / other events, and how to read
//   a board commit's snapshot. efficiencyRecorder({ledger, controller, order, snapshot}): an open ledger
//   (packages/ledger), the signing controller and the append order. efficiencyTotals(ledger, promotion).
// Outputs: kind specs; ledger entries (via the recorder); totals for one promotion.
// Invariants: a rederive function returns null when the entry holds and a human-readable reason when it
//   does not, and never throws (attempt() turns a thrown check into a reason); every count is taken
//   from earlier entries on the chain; the recorder is idempotent on content (re-recording returns the
//   entry already there); totals are computed only after the whole ledger verifies.
// Must never: trust a figure from a side file or from the caller that the chain can re-derive (e.g.
//   `charged`), let a promotion exceed MAX_USES uses, or count a result or debit twice.
import path from 'node:path';
import {canonical, digest, readRuntimeSnapshot} from '../board.mjs';
import {rederiveAssessment, traceBinding} from '../efficiency/assessment.mjs';
import {retainedExperimentFrom} from '../efficiency/prior.mjs';

export const MAX_USES = 20;
export const PROMOTION = 'ophanim.efficiency-promotion/v1';
export const USE = 'ophanim.efficiency-use/v1';
export const RESULT = 'ophanim.efficiency-result/v1';
export const DEBIT = 'ophanim.efficiency-debit/v2';
export const TRACE = 'ophanim.efficiency-trace/v1';
export const ASSESSED = 'ophanim.efficiency-assessed/v1';
export const RETAINED = 'ophanim.efficiency-retained/v1';

const SHA = /^[0-9a-f]{64}$/;
const REF = /^sha256:[0-9a-f]{64}$/;
const count = v => Number.isSafeInteger(v) && v >= 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
// The hashes in `hashes` whose entry is of `kind`.
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
const TRACE_KEYS = ['schema', 'stateDir', 'traceSha', 'trace'];
const ASSESSED_KEYS = ['schema', 'traceSha', 'report'];
const RETAINED_KEYS = ['schema', 'marker'];
const TOTAL_KEYS = [
  'qualifiedConvergences', 'uses', 'originalOptimizationCostMs', 'additionalAssessmentCostMs',
  'unmeasuredAssessments', 'measuredNetMs'];
// The directory assessment.mjs keeps a convergence's files in (mirrors its own path rule).
const reportDirOf = (stateDir, boardCommit) => path.join(
  stateDir, 'efficiency', 'convergences', boardCommit.replace(':', '-'));
// Run a check that throws; its message becomes the rederive reason, null when it passes.
const attempt = fn => { try { fn(); return null; } catch (error) { return String(error.message); } };

// Totals for one promotion over a list of entries ({hash, kind, derived_from, payload}) in chain order.
function totalsOver(list, promotionHash) {
  const promotion = list.find(e => e.hash === promotionHash);
  if (promotion?.kind !== 'efficiency.promotion') throw Error('no such efficiency.promotion on this ledger');
  const efficiency = promotion.payload.efficiency;
  // Uses cite their promotion first; results and debits cite their use first.
  const uses = new Set(
    list.filter(e => e.kind === 'efficiency.use' && e.derived_from[0] === promotionHash).map(e => e.hash));
  const under = kind => list.filter(e => e.kind === kind && uses.has(e.derived_from[0])).map(
    e => ({use: e.derived_from[0], ...e.payload}));
  const results = under('efficiency.result'), debits = under('efficiency.debit');
  const additionalAssessmentCostMs = debits.reduce((s, d) => s + (d.charged ? d.assessmentCostMs : 0), 0);
  // Interrupted runs are counted once per (use, interrupted trace), however many debits name them.
  const unmeasuredAssessments = new Set(debits.filter(d => d.interrupted).map(d => `${d.use}:${d.interrupted}`)).size;
  return {
    qualifiedConvergences: results.length, uses: uses.size,
    originalOptimizationCostMs: efficiency.totalAssessmentCostMs,
    additionalAssessmentCostMs, unmeasuredAssessments,
    measuredNetMs: results.reduce(
      (s, r) => s + r.observedSavingMs, -efficiency.totalAssessmentCostMs - additionalAssessmentCostMs),
  };
}

// The prior outcome a retained marker gives for `trace`: the marker, the cited assessment's report and that
// assessment's trace entry, through the same computation readRetainedExperiment runs on the marker file.
function retainedOutcome(view, {marker, assessed}, trace, snapshot) {
  const traced = view.entry(assessed).derived_from[0];
  const {report} = view.payload(assessed), {stateDir, trace: prior} = view.payload(traced);
  return retainedExperimentFrom({marker, trace,
    prior: dir => {
      if (dir !== reportDirOf(stateDir, prior.boardCommit))
        throw Error('Prior experiment path differs from its trace entry'); return prior; },
    report: () => report,
    state: (dir, commit) => snapshot(dir, commit).state});
}
const retainedAt = (view, h) => ({marker: view.payload(h).marker, assessed: view.entry(h).derived_from[0]});

// The measured value an assessment carries. Without a use it is the assessment's own cost, unrecovered.
// Under a use it is the promotion's totals over the chain up to the head it names, which must end on the
// debit the assessment cites (and, for an accepted convergence, include the result realized under that use).
const LEDGER_KINDS = new Set(['efficiency.promotion', 'efficiency.use', 'efficiency.result', 'efficiency.debit']);
function measuredValueWhy(report, trace, debitHash, view) {
  const m = report.measuredValue;
  if (!m || typeof m !== 'object') return 'the assessment carries a measured value';
  if (!m.ledger) {
    if (debitHash) return 'the assessment cites a debit its measured value does not name';
    if (!exact(m, ['qualifiedConvergences', 'originalOptimizationCostMs', 'measuredNetMs']) ||
      m.qualifiedConvergences !== 0 ||
      m.originalOptimizationCostMs !== report.cost?.wallMs || m.measuredNetMs !== -m.originalOptimizationCostMs)
      return 'outside a use the measured value is the assessment cost, unrecovered (a use is measured on the ledger)';
    return null;
  }
  if (!debitHash || m.ledger.debit !== debitHash)
    return 'the measured value ends on a debit the assessment does not cite';
  const debit = view.payload(debitHash), use = view.entry(debitHash).derived_from[0];
  if (debit.traceSha !== report.traceSha || m.ledger.use !== use) return 'the cited debit is for another trace or use';
  const result = m.ledger.result;
  // A result is named exactly when the convergence was accepted, and it must be this use's result.
  if ((result !== undefined) !== (trace.original.convergence === 'accepted_change') ||
      result !== undefined &&
      !(view.entry(result)?.kind === 'efficiency.result' && view.entry(result).derived_from[0] === use))
    return 'an accepted convergence names the result realized under its use, and nothing else does';
  const order = view.entries(), at = order.indexOf(m.ledger.head);
  if (at < 0 || m.head !== m.ledger.head || order.indexOf(debitHash) > at)
    return 'the measured value names a head that is not on the chain after its debit';
  // Recompute the promotion's totals over the chain prefix ending at the named head.
  const list = order.slice(0, at + 1).filter(h => LEDGER_KINDS.has(view.entry(h).kind))
    .map(h => ({hash: h, kind: view.entry(h).kind, derived_from: view.entry(h).derived_from,
      payload: view.payload(h)}));
  const totals = totalsOver(list, view.entry(use).derived_from[0]);
  if (TOTAL_KEYS.some(k => m[k] !== totals[k]) || m.measuredNetIsUpperBound !== (totals.unmeasuredAssessments > 0))
    return 'the measured value does not re-derive from the ledger up to its head';
  return null;
}

// The use an entry cites (exactly one), and the promotion that use cites.
function useAndPromotion(e, view) {
  const uses = cited(view, e.derived_from, 'efficiency.use');
  if (uses.length !== 1 || e.derived_from.length !== 1)
    return {why: 'it cites exactly one efficiency.use and nothing else'};
  const use = view.entry(uses[0]);
  const promotion = use.derived_from[0];
  return {use: uses[0], promotion, promotionPayload: view.payload(promotion)};
}

/** Kind specs. `authors.promotion` may record promotions; `authors.events` uses, results and debits. */
export function efficiencyKinds({authors = {}, snapshot = readRuntimeSnapshot} = {}) {
  const promoters = authors.promotion ?? (() => true), events = authors.events ?? (() => true);
  return {
    'efficiency.promotion': {
      authors: promoters,
      validate: p => (
        exact(p, PROMOTION_KEYS) && p.schema === PROMOTION ? null : 'a promotion is an efficiency-promotion record'),
      rederive: e => {
        const p = e.payload, f = p.efficiency;
        if (e.derived_from.length)
          return 'a promotion cites nothing on this chain; its authority is the signed decision it names';
        if (!SHA.test(p.scopeSha) || !REF.test(p.decisionId)) return 'a promotion names its scope and decision by hash';
        if (p.fromSlots !== 1 || p.toSlots !== 3) return 'the admitted experiment is 1 -> 3 slots only';
        if (p.maxUses !== MAX_USES) return `a promotion is bounded to ${MAX_USES} qualified uses`;
        if (!exact(f, FIGURES) || !FIGURES.every(k => count(f[k])))
          return 'efficiency figures are non-negative integers';
        if (f.conservativeSavedMs !== f.baselineConservativeMs - f.candidateConservativeMs)
          return 'conservativeSavedMs is not baseline - candidate';
        return null;
      },
    },
    'efficiency.use': {
      authors: events,
      validate: p => (exact(p, USE_KEYS) && p.schema === USE ? null : 'a use is an efficiency-use record'),
      rederive: (e, view) => {
        const p = e.payload;
        const promotions = cited(view, e.derived_from, 'efficiency.promotion');
        if (promotions.length !== 1 || e.derived_from.length !== 1)
          return 'a use cites exactly one efficiency.promotion and nothing else';
        const promotion = view.payload(promotions[0]);
        if (typeof p.stateDir !== 'string' || !p.stateDir.startsWith('/') || p.useId !== digest(p.stateDir))
          return 'useId is the digest of the state directory';
        if (p.scopeSha !== promotion.scopeSha || p.decisionId !== promotion.decisionId)
          return 'the use names a different scope or decision than the promotion it cites';
        const earlier = citing(view, 'efficiency.use', promotions[0]);
        if (earlier.some(u => u.payload.useId === p.useId))
          return 'this state directory already has a use under this promotion';
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
        if (!SHA.test(p.traceSha) || !count(p.executionMs) || !count(p.assessmentCostMs) ||
          !Number.isSafeInteger(p.observedSavingMs)) return 'a result names its trace and non-negative integer times';
        const expected = at.promotionPayload.efficiency.baselineConservativeMs - p.executionMs - p.assessmentCostMs;
        if (p.observedSavingMs !== expected)
          return `observedSavingMs is ${p.observedSavingMs}, but the cited promotion's baseline gives ${expected}`;
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
        if (!SHA.test(p.traceSha) || !count(p.assessmentCostMs))
          return 'a debit is a non-negative integer cost for one trace';
        if (typeof p.charged !== 'boolean' || !(p.interrupted === null || SHA.test(p.interrupted)))
          return 'charged is a boolean and interrupted a trace hash or null';
        if (citing(view, 'efficiency.debit', at.use).some(d => d.payload.traceSha === p.traceSha))
          return 'this trace is already debited under this use';
        const deducted = citing(view, 'efficiency.result', at.use).some(r => r.payload.traceSha === p.traceSha);
        // `charged` must be exactly "no result for this trace under this use already deducts the cost".
        if (p.charged === deducted)
          return deducted ?
            'the realized result already deducts this cost; it is not charged twice'
            : 'an assessment with no realized result is charged';
        return null;
      },
    },
    'efficiency.trace': {
      authors: events,
      validate: p => (exact(p, TRACE_KEYS) && p.schema === TRACE ? null : 'a trace is an efficiency-trace record'),
      rederive: (e, view) => {
        const p = e.payload;
        if (e.derived_from.length) return 'a trace cites nothing on this chain; it names its board commit';
        if (typeof p.stateDir !== 'string' || !path.isAbsolute(p.stateDir) || path.resolve(p.stateDir) !== p.stateDir)
          return 'a trace names an absolute state directory';
        if (!SHA.test(p.traceSha) || digest(p.trace) !== p.traceSha) return 'traceSha is not the digest of the trace';
        if (view.entries().some(
          h => view.entry(h).kind === 'efficiency.trace' && view.payload(h).traceSha === p.traceSha))
          return 'this trace is already on the chain';
        const why = attempt(() => traceBinding(p.trace, snapshot(p.stateDir, p.trace.boardCommit)));
        return why && `the trace does not bind to its board: ${why}`;
      },
    },
    'efficiency.assessed': {
      authors: events,
      validate: p => (
        exact(p, ASSESSED_KEYS) && p.schema === ASSESSED && p.report &&
        typeof p.report === 'object' ? null : 'an assessment is an efficiency-assessed record'),
      rederive: (e, view) => {
        const p = e.payload, report = p.report;
        const traces = cited(view, e.derived_from, 'efficiency.trace'),
          retained = cited(view, e.derived_from, 'efficiency.retained');
        const debits = cited(view, e.derived_from, 'efficiency.debit');
        if (traces.length !== 1 || e.derived_from[0] !== traces[0] || retained.length > 1 || debits.length > 1 ||
            e.derived_from.length !== 1 + retained.length + debits.length)
          return 'an assessment cites its trace first, then at most one retained experiment and one debit';
        const {stateDir, traceSha, trace} = view.payload(traces[0]);
        if (p.traceSha !== traceSha || report.traceSha !== traceSha)
          return 'the assessment names a different trace than the one it cites';
        if (view.entries().some(
          h => view.entry(h).kind === 'efficiency.assessed' && view.payload(h).traceSha === traceSha))
          return 'this trace is already assessed on the chain';
        const prior = report.admission?.inputs?.priorOutcome;
        // A retained experiment is cited exactly when the admission read a prior outcome.
        if (!!prior !== (retained.length === 1))
          return prior ?
            'the admission read a retained experiment the assessment does not cite'
            : 'the assessment cites a retained experiment its admission did not read';
        // The same re-derivation verifyEfficiencyRecord runs on files, here on the cited entries.
        const why = attempt(
          () => rederiveAssessment({assessment: report, trace, snapshot: snapshot(stateDir, trace.boardCommit),
            reportDir: reportDirOf(stateDir, trace.boardCommit),
            priorOutcome: () => retainedOutcome(view, retainedAt(view, retained[0]), trace, snapshot)}));
        if (why) return `the report does not re-derive from its trace: ${why}`;
        return measuredValueWhy(report, trace, debits[0] ?? null, view);
      },
    },
    'efficiency.retained': {
      authors: events,
      validate: p => (exact(p, RETAINED_KEYS) &&
        p.schema === RETAINED ? null : 'a retained experiment is an efficiency-retained record'),
      rederive: (e, view) => {
        const p = e.payload;
        const assessed = cited(view, e.derived_from, 'efficiency.assessed');
        if (assessed.length !== 1 || e.derived_from.length !== 1)
          return 'a retained experiment cites exactly one efficiency.assessed and nothing else';
        if (view.payload(assessed[0]).traceSha !== p.marker?.traceSha)
          return 'the marker names a different trace than the assessment it cites';
        if (view.entries().some(
          h => view.entry(h).kind === 'efficiency.retained' &&
            view.payload(h).marker.traceSha === p.marker.traceSha)) return 'this experiment is already retained';
        const {trace} = view.payload(view.entry(assessed[0]).derived_from[0]);
        const why = attempt(() => retainedOutcome(view, {marker: p.marker, assessed: assessed[0]}, trace, snapshot));
        return why && `the experiment does not re-derive as retained evidence: ${why}`;
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
  const list = ledger.read().filter(e => LEDGER_KINDS.has(e.kind))
    .map(e => ({hash: ledger.hashOf(e), kind: e.kind, derived_from: e.derived_from, payload: ledger.payloadOf(e)}));
  return {...totalsOver(list, promotionHash), head: v.head};
}

/**
 * The recorder assessment.mjs takes as `ledger`. Every method is idempotent on content: recording the
 * same promotion, use, result or debit again returns the entry already on the chain, so a resumed run
 * does not double-count. `charged` is derived here from the chain, not taken from the caller.
 * K5b: the trace, the assessment and the retained experiment are recorded the same way. `snapshot` reads
 * a board commit, as the kinds do.
 */
export function efficiencyRecorder({ledger, controller, order, snapshot = readRuntimeSnapshot}) {
  const by = {author: {key_id: controller.key_id}, signer: controller, order};
  // A read-only view of the current chain, in the shape the kinds' rederive functions take.
  const viewOf = () => {
    const at = new Map(ledger.read().map(e => [ledger.hashOf(e), e]));
    return {
      entry: h => at.get(h) ?? null, payload: h => (at.has(h) ? ledger.payloadOf(at.get(h)) : null),
      entries: () => [...at.keys()]};
  };
  // The hash of the first entry of `kind` whose (entry, payload) matches, or null.
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
    /** The entries already recorded for a trace (an equilibrium reuse cites these, never new ones). */
    entriesFor(traceSha) {
      const trace = find('efficiency.trace', (e, x) => x.traceSha === traceSha);
      const assessed = trace && find('efficiency.assessed', (e, x) => x.traceSha === traceSha);
      const retained = assessed && find('efficiency.retained', e => e.derived_from.includes(assessed));
      return trace && assessed ? {trace, assessed, ...(retained ? {retained} : {})} : null;
    },
    /** The trace an assessment reads, carried whole and bound to the board commit it names. */
    trace({stateDir, trace}) {
      const traceSha = digest(trace);
      return find('efficiency.trace', (e, x) => x.traceSha === traceSha)
        ?? append('efficiency.trace', {schema: TRACE, stateDir, traceSha, trace}, []);
    },
    /** The assessment report, citing its trace, the retained experiment it read and the debit it ends on. */
    assessed({trace, report, retained = null, debit = null}) {
      const existing = find('efficiency.assessed', (e, x) => x.traceSha === report.traceSha);
      if (existing) {
        if (canonical(viewOf().payload(existing).report) !== canonical(report))
          throw Error('this trace already has a different assessment on the ledger');
        return existing;
      }
      return append('efficiency.assessed', {schema: ASSESSED, traceSha: report.traceSha, report},
        [trace, ...retained ? [retained] : [], ...debit ? [debit] : []]);
    },
    /**
     * Retain the experiment an assessment ran, when it completed as prior evidence. Returns null when it did
     * not (the marker is then held, as readRetainedExperiment holds it on the file path).
     */
    retained({assessed, marker}) {
      const existing = find('efficiency.retained', (e, x) => x.marker.traceSha === marker.traceSha);
      if (existing) return existing;
      const view = viewOf(), {trace} = view.payload(view.entry(assessed).derived_from[0]);
      try { retainedOutcome(view, {marker, assessed}, trace, snapshot); } catch { return null; }
      return append('efficiency.retained', {schema: RETAINED, marker}, [assessed]);
    },
    /** The retained entry for this marker and the prior outcome it gives for `trace`; throws when there is none. */
    retainedFor({marker, trace}) {
      const retained = find('efficiency.retained', (e, x) => canonical(x.marker) === canonical(marker));
      if (!retained) throw Error('No retained experiment on the ledger for this marker');
      const view = viewOf();
      return {retained, priorOutcome: retainedOutcome(view, retainedAt(view, retained), trace, snapshot)};
    },
    totals: promotionHash => efficiencyTotals(ledger, promotionHash),
  };
}
