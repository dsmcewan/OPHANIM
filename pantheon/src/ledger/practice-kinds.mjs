// The practice assessment and disposition of a review cycle, on the ledger (independent review
// 2026-11-16, C3; docs/reviews/2026-11-16-routing-coordination/CYCLE_CONTRACT.md steps 1, 3, 7 and 8).
// Two complete cycles closed `verified` with no routing/coordination assessment and no decision a later
// dispatch consumed. This kind is that record, and the cycle contract that requires it:
//
//   practice.disposition  {schema: pantheon.practice/v1, scope, stage, policy, question, outcome, measured,
//                          provisional, evidence, provenance, candidate, proposer, by, conditions, at}
//     stage `assessment`  the cycle's bounded next step (step 3): `retain`, `insufficient_evidence`,
//                         `propose_measurement`, or `propose_policy` (which names its candidate policy and
//                         the seat that proposed it)
//     stage `candidate`   the disposition of a qualified candidate (step 7): `promote`, `retain` or
//                         `reject`, citing the `propose_policy` entry it decides. It is decided BY a seat
//                         ({vendor, model, lab}, the lab re-derived with labOf), and a promote by a seat of
//                         the proposer's lab is refused: a learning component, or the author of a candidate,
//                         cannot record its own promotion. A promote is measured, cites ledger evidence, and
//                         states its applicability, rollback and re-evaluation conditions.
//   Every disposition names the selection policy in effect (`pantheon.selection/v1` and the hash
//   selectionPolicy(profile, {pools}) gives, route/frontier.mjs): the cycle's own. Unmeasured judgment is
//   labelled provisional. Evidence is {kind: ledger, hash} (an earlier entry, also cited), {kind: digest,
//   schema, sha} or {kind: document, path, sha}: a document is evidence at most, never a decision.
//
// The cycle contract (cycle-kinds.mjs): a cycle records the contract it opened under. `pantheon.cycle/v2`
// (the default for a new cycle) names the policy in effect, the practice scope and the admitted decision
// it loaded at open (`prior`, cited), and cannot close without at least one assessment-stage disposition;
// its close lists the cycle's dispositions. A cycle with no `contract` field opened under the old contract
// and keeps its meaning: it closes, and its historical hashes verify, exactly as before. A scope that has
// opened a v2 cycle does not return to the old contract.
//
// What a later dispatch loads (admittedPractice, loadPractice): the latest `promote` or `retain` for the
// scope and profile among the dispositions a CLOSED cycle's close lists (a disposition its cycle's review
// gates have not carried is not admitted), else the named provisional default, the current selection
// policy. The dispatcher records the entry hash it loaded on every turn's selection (run-item.mjs); only
// a ledger entry changes it.
//
// SYNTHETIC EVIDENCE (CYCLE_CONTRACT acceptance: "A synthetic matched comparison verifies the mechanics; a
// scoped live comparison is needed before claiming measured provider cost/quality improvement"). A matched
// comparison record (pantheon/src/practice/compare.mjs, schema COMPARE_SCHEMA) is cited as {kind: digest,
// schema: COMPARE_SCHEMA, sha, synthetic}, and such a digest must say whether it is synthetic. A
// disposition whose comparison evidence is only synthetic (a synthetic digest, or a disposition resting on
// one) may propose a measurement, but a promote resting on it is refused: a promote that cites synthetic
// evidence also cites a live (synthetic: false) comparison. Additive: an entry with no comparison digest,
// as every entry written before this rule, re-derives exactly as it did. The flag is what the record
// declares; whether a live record really was live is for the independent reviewer of the evidence.
//
// What this does NOT do: run a comparison, read provider usage, or make the dispatcher execute a promoted
// candidate's tables. A promoted policy whose hash is not the one this dispatcher implements is loaded and
// recorded with `applies: false` and the reason; nothing pretends it ran.
import {createHash} from 'node:crypto';
import {canonical} from '../../../packages/ledger/canonical.mjs';
import {labOf} from '../config/models.mjs';
import {selectionPolicy} from '../route/frontier.mjs';

export const PRACTICE = 'practice.disposition';
/** A retained, finalized comparison record (#131): the whole record, so a promote binds to bytes, not to a declared flag. */
export const COMPARISON = 'practice.comparison';
const COMPARISON_MAX_BYTES = 1024 * 1024;
export const PRACTICE_SCHEMA = 'pantheon.practice/v1';
export const CYCLE_CONTRACT = 'pantheon.cycle/v2';
// v3 is v2 with MODEL-level review independence (cycle-kinds.mjs): everything a v2 cycle carries and requires holds
// for a v3 cycle. A cycle opens under v3 only when its caller asks for it; v2 stays the default.
export const CYCLE_CONTRACT_V3 = 'pantheon.cycle/v3';
/** Does a cycle opened under `contract` carry a practice decision (v2 and later)? */
export const carriesPractice = contract => contract === CYCLE_CONTRACT || contract === CYCLE_CONTRACT_V3;
/** The contract a cycle without a `contract` field opened under. Never written: an old cycle's payload is unchanged. */
export const CYCLE_CONTRACT_V1 = 'pantheon.cycle/v1';
export const DEFAULT_PRACTICE_SCOPE = 'routing-coordination';
/** A matched-comparison record's schema (pantheon/src/practice/compare.mjs), as a digest citation names it. */
export const COMPARE_SCHEMA = 'pantheon.compare/v1';
/** A continuous-evaluation record's schema (pantheon/src/practice/evaluate.mjs); cited like a comparison, with its synthetic flag. */
export const EVALUATION_SCHEMA = 'pantheon.evaluation/v1';
const FLAGGED = new Set([COMPARE_SCHEMA, EVALUATION_SCHEMA]);
export const ASSESSMENT_OUTCOMES = Object.freeze(['retain', 'insufficient_evidence', 'propose_measurement', 'propose_policy']);
export const CANDIDATE_OUTCOMES = Object.freeze(['promote', 'retain', 'reject']);
const ADMITTING = ['promote', 'retain'];
const CYCLE = 'cycle', CLOSE = 'cycle.close';
const ENTRY = /^sha256:[0-9a-f]{64}$/;
const SHA = /^(sha256:)?[0-9a-f]{64}$/;
const str = (v, max = 2000) => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const ISO = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A selection policy identity: {version, hash, profile}. */
export const validPolicy = p => plain(p) && str(p.version, 200) && ENTRY.test(p.hash ?? '') && str(p.profile, 64);
/** The policy this code implements for `profile`, as a disposition names it. */
export function currentPolicy(profile = 'argo', {pools = []} = {}) {
  const id = selectionPolicy(profile, {pools});
  return {version: id.policy, hash: id.hash, profile};
}
const validSeat = s => plain(s) && str(s.vendor, 64) && str(s.model, 200) && str(s.lab, 64);
const seatLab = s => (labOf(s.vendor, s.model) === s.lab ? null : `the ${s.vendor}/${s.model} seat's lab is ${labOf(s.vendor, s.model)}, not ${s.lab}`);
const validEvidence = e => plain(e) && (e.kind === 'ledger' ? ENTRY.test(e.hash ?? '')
  : e.kind === 'digest' ? str(e.schema, 200) && SHA.test(e.sha ?? '')
    && (!FLAGGED.has(e.schema) || typeof e.synthetic === 'boolean')
  : e.kind === 'document' ? str(e.path, 500) && SHA.test(e.sha ?? '') : false);
const validCandidate = c => plain(c) && str(c.id, 120) && validPolicy(c.policy) && str(c.change);
const validConditions = c => plain(c) && ['applicability', 'rollback', 'reevaluate'].every(k => str(c[k]));

// The digest compare.mjs gives a record: sha256 over its canonical form without the digest field.
const recordDigest = r => { const {digest: _, ...rest} = r; return 'sha256:' + createHash('sha256').update(canonical(rest)).digest('hex'); };

function validateComparison(r) {
  if (!plain(r) || r.schema !== COMPARE_SCHEMA) return `a retained comparison is a ${COMPARE_SCHEMA} record`;
  if (typeof r.synthetic !== 'boolean' || !SHA.test(r.digest ?? '')) return 'a retained comparison carries its synthetic flag and digest';
  let size;
  try { size = Buffer.byteLength(canonical(r)); } catch (e) { return `a retained comparison is not canonical JSON: ${e.message}`; }
  if (size > COMPARISON_MAX_BYTES) return `a retained comparison is at most ${COMPARISON_MAX_BYTES} bytes`;
  if (recordDigest(r) !== r.digest) return 'a retained comparison is the finalized record: its digest re-derives from its content';
  return null;
}

/**
 * May this retained comparison carry a promote? Re-derived from the record's own content, never from a summary,
 * label or citation: the digest re-derives; it is live (synthetic false, providers declared live); it is an arms
 * record whose budget is valid; every run that was admitted is charged its RAW attempts (basis raw, counted equal
 * to raw, no overrun) and the charges add up to the recorded spend within the total; and at least one pair decided.
 * A record that fails is still retained (a preserved receipt); it just cannot qualify a decision.
 */
export function qualifyComparison(r) {
  const why = validateComparison(r);
  if (why) return {ok: false, why};
  if (r.synthetic !== false || r.providers?.kind !== 'live') return {ok: false, why: 'a synthetic comparison verifies the mechanics only'};
  if (r.kind !== 'arms') return {ok: false, why: 'only a budget-accounted (arms) comparison can qualify a promote'};
  if (!plain(r.budget) || r.budget.valid !== true || (r.budget.overruns ?? []).length) return {ok: false, why: 'the comparison is budget-invalid: a run overran what its admission reserved'};
  // Recount from the retained raw projection and replay the admission rule, in the order the runs were admitted:
  // the derived scalars (raw, counted, basis, before, spent, budget) are the producer's claims about these lists.
  const bound = r.bounds?.maxProviderCalls, total = r.total_provider_calls;
  if (!Number.isSafeInteger(bound) || bound < 1 || !Number.isSafeInteger(total) || total < 1) return {ok: false, why: 'the record does not state its per-run bound and total'};
  if (!Array.isArray(r.results) || !r.results.length || !Array.isArray(r.tickets) || r.tickets.length !== r.results.length) {
    return {ok: false, why: 'the record has no complete outcome rows: one result row per ticket is required'};
  }
  const ATTEMPT_KEYS = 'outcome,purpose';
  const attemptOk = x => plain(x) && Object.keys(x).sort().join() === ATTEMPT_KEYS && [x.purpose, x.outcome].every(v => v === null || typeof v === 'string');
  let spent = 0, decided = 0;
  for (const [i, row] of r.results.entries()) {
    if (!plain(row) || typeof row.ticket !== 'string' || row.ticket !== r.tickets[i]?.key) return {ok: false, why: `result row ${i} is not the outcome row of ticket ${r.tickets[i]?.key}`};
    if (!Array.isArray(row?.order) || row.order.length !== 2 || new Set(row.order).size !== 2 || !row.order.every(k => k === 'baseline' || k === 'candidate')) {
      return {ok: false, why: `ticket ${row?.ticket}: the admission order is not recorded`};
    }
    for (const arm of row.order) {
      const a = row[arm];
      if (!plain(a)) return {ok: false, why: `ticket ${row.ticket}: the ${arm} arm is missing`};
      if (a.status === 'not_run') {
        if (a.provider_calls_counted !== 0) return {ok: false, why: `ticket ${row.ticket}: an unrun ${arm} arm is charged`};
        if (a.provider_calls_evidence !== null && a.provider_calls_evidence !== undefined) return {ok: false, why: `ticket ${row.ticket}: an unrun ${arm} arm records attempt evidence`};
        if (spent + bound <= total) return {ok: false, why: `ticket ${row.ticket}: the ${arm} arm was not run although ${spent} + ${bound} fit the total ${total}`};
        continue;
      }
      const ev = a.provider_calls_evidence;
      if (!plain(ev) || ev.truncated !== false || !Array.isArray(ev.attempts)) return {ok: false, why: `ticket ${row.ticket}: the ${arm} arm retains no complete raw attempt evidence`};
      if (!ev.attempts.every(attemptOk)) return {ok: false, why: `ticket ${row.ticket}: the ${arm} arm's attempt evidence has an entry that is not a recorded attempt {purpose, outcome}`};
      const raw = ev.attempts.length;
      if (spent + bound > total) return {ok: false, why: `ticket ${row.ticket}: the ${arm} arm was admitted at ${spent} spent, but ${spent} + ${bound} exceeds the total ${total}`};
      if (raw > bound) return {ok: false, why: `ticket ${row.ticket}: the ${arm} arm made ${raw} recorded attempts against a per-run bound of ${bound}`};
      if (a.provider_calls_basis !== 'raw' || a.provider_calls_raw !== raw || a.provider_calls_counted !== raw || a.provider_calls_before !== spent || a.provider_calls_overrun !== false) {
        return {ok: false, why: `ticket ${row.ticket}: the ${arm} arm's derived accounting ${JSON.stringify([a.provider_calls_basis, a.provider_calls_raw, a.provider_calls_counted, a.provider_calls_before])} contradicts its ${raw} retained attempts at ${spent} spent`};
      }
      spent += raw;
    }
    // A pair is decided only when both arms ran and each says accepted true or false.
    if (['baseline', 'candidate'].every(k => row[k].status !== 'not_run' && typeof row[k].accepted === 'boolean')) decided++;
  }
  if (spent !== r.spent_provider_calls) return {ok: false, why: `the recorded spend ${r.spent_provider_calls} is not the recounted ${spent}`};
  if (decided < 1) return {ok: false, why: 'no pair was decided in the outcome rows'};
  if (r.paired?.pairs !== decided) return {ok: false, why: `the summary says ${JSON.stringify(r.paired?.pairs)} decided pairs; the outcome rows decide ${decided}`};
  return {ok: true, digest: r.digest};
}

/** The compare digests a disposition's evidence rests on, directly or through the dispositions it cites. */
function comparisonDigests(view, evidence, seen = new Set(), out = []) {
  for (const e of evidence ?? []) {
    if (e?.kind === 'digest' && e.schema === COMPARE_SCHEMA) out.push(e);
    else if (e?.kind === 'ledger' && !seen.has(e.hash) && view.entry(e.hash)?.kind === PRACTICE) {
      seen.add(e.hash);
      comparisonDigests(view, view.payload(e.hash)?.evidence, seen, out);
    }
  }
  return out;
}

function validate(p) {
  if (!plain(p) || p.schema !== PRACTICE_SCHEMA) return `a practice disposition is ${PRACTICE_SCHEMA}`;
  if (!str(p.scope, 120)) return 'a practice disposition names its practice scope';
  if (!['assessment', 'candidate'].includes(p.stage)) return 'a practice disposition is an assessment or a candidate disposition';
  const outcomes = p.stage === 'assessment' ? ASSESSMENT_OUTCOMES : CANDIDATE_OUTCOMES;
  if (!outcomes.includes(p.outcome)) return `an ${p.stage === 'assessment' ? 'assessment outcome' : 'candidate outcome'} is one of ${outcomes.join(', ')}`;
  if (!validPolicy(p.policy)) return 'a practice disposition names the policy in effect {version, hash, profile}';
  if (!str(p.question)) return 'a practice disposition names the question it assessed';
  if (typeof p.measured !== 'boolean' || typeof p.provisional !== 'boolean') return 'a practice disposition says whether it was measured and whether it is provisional';
  if (!p.measured && !p.provisional) return 'unmeasured judgment is labelled provisional';
  if (!Array.isArray(p.evidence) || p.evidence.length > 32 || !p.evidence.every(validEvidence)) return `evidence is a list of {kind: ledger, hash} | {kind: digest, schema, sha} | {kind: document, path, sha}; a ${COMPARE_SCHEMA} or ${EVALUATION_SCHEMA} digest says whether it is synthetic (synthetic: true|false)`;
  if (!plain(p.provenance) || !plain(p.provenance.by) || !str(p.provenance.by.role ?? p.provenance.by.vendor, 120) || !str(p.provenance.method)) {
    return 'provenance names who assessed (by) and how (method)';
  }
  if (!ISO(p.at)) return 'a practice disposition names when it was recorded';
  const proposing = p.stage === 'candidate' || p.outcome === 'propose_policy';
  if (proposing ? !validCandidate(p.candidate) || !validSeat(p.proposer) : p.candidate !== null || p.proposer !== null) {
    return proposing ? 'a policy proposal and its disposition name the candidate {id, policy, change} and its proposer {vendor, model, lab}'
      : 'only a policy proposal or its disposition names a candidate';
  }
  if (proposing && p.candidate.policy.hash === p.policy.hash) return 'a candidate is a policy other than the one in effect';
  if (p.stage === 'candidate' ? !validSeat(p.by) : p.by !== null) return 'a candidate disposition is decided by a seat {vendor, model, lab}; an assessment names none';
  if (p.outcome === 'promote') {
    if (!p.measured) return 'a promote rests on measured evidence';
    if (!p.evidence.some(e => e.kind === 'ledger')) return 'a promote cites the retained comparison on the ledger';
    if (!validConditions(p.conditions)) return 'a promote states its applicability, rollback and re-evaluation (reevaluate) conditions';
  } else if (p.conditions !== null && !validConditions(p.conditions)) return 'conditions are {applicability, rollback, reevaluate}';
  return null;
}

const closedAt = (view, cycle) => view.entries().find(h => view.entry(h)?.kind === CLOSE && view.entry(h).derived_from.includes(cycle)) ?? null;

function rederive(e, view) {
  const p = e.payload, [cycle, ...rest] = e.derived_from;
  if (view.entry(cycle)?.kind !== CYCLE) return 'a practice disposition cites its cycle first';
  const c = view.payload(cycle);
  if (!carriesPractice(c.contract)) return `a practice disposition belongs to a cycle opened under ${CYCLE_CONTRACT}`;
  if (closedAt(view, cycle)) return 'the cycle is closed';
  if (p.scope !== c.practice_scope) return `the cycle's practice scope is ${c.practice_scope}, not ${p.scope}`;
  if (canonical(p.policy) !== canonical(c.policy)) return 'the policy in effect is the one the cycle opened under';
  let cited = rest;
  if (p.stage === 'candidate') {
    const [proposal, ...more] = rest;
    cited = more;
    const q = view.entry(proposal)?.kind === PRACTICE ? view.payload(proposal) : null;
    if (!q || q.stage !== 'assessment' || q.outcome !== 'propose_policy') return 'a candidate disposition cites the policy proposal it decides, after its cycle';
    if (q.scope !== p.scope) return 'the proposal is of another practice scope';
    if (canonical(q.candidate) !== canonical(p.candidate) || canonical(q.proposer) !== canonical(p.proposer)) return 'the candidate is not the one the proposal names';
    const why = seatLab(p.by);
    if (why) return why;
    if (p.outcome === 'promote' && p.by.lab === q.proposer.lab) {
      return `the ${p.by.lab} lab proposed this candidate and may not record its own promotion: a promote is decided by a seat of another lab than the proposer's lab`;
    }
  }
  if (p.proposer) { const why = seatLab(p.proposer); if (why) return why; }
  if (p.outcome === 'promote' && evidenceBasis(view, p.evidence) === 'synthetic') {
    return 'a promote may not rest on synthetic evidence: a synthetic comparison verifies the mechanics only; cite a live (synthetic: false) comparison';
  }
  // #131: a promote resting on comparison evidence binds every live comparison it rests on to a retained,
  // finalized record that qualifies -- a declared `synthetic: false` is a claim, the retained record is the proof.
  if (p.outcome === 'promote') {
    const retained = new Map();
    for (const x of p.evidence) if (x.kind === 'ledger' && view.entry(x.hash)?.kind === COMPARISON) retained.set(view.payload(x.hash)?.digest, view.payload(x.hash));
    const live = comparisonDigests(view, p.evidence).filter(d => d.synthetic === false);
    for (const d of live) {
      const r = retained.get(d.sha);
      if (!r) return `a promote resting on the live comparison ${d.sha.slice(0, 19)} cites its retained record (${COMPARISON}) on the ledger; a declared digest alone is not proof`;
      if (r.synthetic !== d.synthetic) return 'the cited comparison digest says live; the retained record is synthetic';
      const q = qualifyComparison(r);
      if (!q.ok) return `the retained comparison ${d.sha.slice(0, 19)} cannot qualify a promote: ${q.why}`;
      // The comparison must be OF this decision: its baseline arm ran the policy in effect, its candidate arm the candidate.
      if (canonical(r.arms?.baseline?.policy ?? null) !== canonical(p.policy) || canonical(r.arms?.candidate?.policy ?? null) !== canonical(p.candidate.policy)) {
        return `the retained comparison ${d.sha.slice(0, 19)} compared other policies than this promote decides (baseline ${r.arms?.baseline?.policy?.hash?.slice(0, 19)}, candidate ${r.arms?.candidate?.policy?.hash?.slice(0, 19)})`;
      }
    }
    for (const [sha] of retained) if (!live.some(d => d.sha === sha)) return 'a promote cites a retained comparison it does not rest on: cite its digest too';
  }
  const ledgerRefs = p.evidence.filter(x => x.kind === 'ledger').map(x => x.hash);
  if (new Set(ledgerRefs).size !== ledgerRefs.length || canonical(cited) !== canonical(ledgerRefs)) {
    return 'a practice disposition cites its cycle, the proposal it decides, and exactly its ledger evidence, in that order';
  }
  return null;
}

/**
 * What a disposition's evidence rests on, as far as comparisons go: `synthetic` when it cites synthetic
 * comparison evidence and no live comparison, `live` when it cites a live comparison, `none` otherwise.
 * A digest declares its own flag; a cited practice disposition contributes what its own evidence rests on;
 * any other entry or document is neither. Pure over the view.
 */
export function evidenceBasis(view, evidence, seen = new Set()) {
  let synthetic = false, live = false;
  for (const e of evidence ?? []) {
    if (e?.kind === 'digest' && typeof e.synthetic === 'boolean') { if (e.synthetic) synthetic = true; else live = true; }
    else if (e?.kind === 'ledger' && !seen.has(e.hash) && view.entry(e.hash)?.kind === PRACTICE) {
      seen.add(e.hash);
      const b = evidenceBasis(view, view.payload(e.hash)?.evidence, seen);
      if (b === 'synthetic') synthetic = true; else if (b === 'live') live = true;
    }
  }
  return live ? 'live' : synthetic ? 'synthetic' : 'none';
}

/** Kind spec. `authors` decides who records dispositions (the controller, which signs what the seats decided). */
export function practiceKinds({authors = () => true} = {}) {
  return {[PRACTICE]: {authors, validate, rederive},
    // A retained comparison stands alone: its content is its proof (validateComparison), whatever it shows.
    [COMPARISON]: {authors, validate: validateComparison, rederive: () => null}};
}

/** The practice dispositions of one cycle, in chain order. */
export const dispositionsOf = (view, cycle) => view.entries().filter(h => view.entry(h)?.kind === PRACTICE && view.entry(h).derived_from[0] === cycle);

/**
 * The admitted practice decision for `scope` (and `profile`, when given) as of `view`, or null: the latest
 * `promote` or `retain` among the dispositions that a cycle's close lists. Pure over the view.
 * Returns {disposition, outcome, stage, policy, provisional, question, cycle}; a promote admits the
 * candidate's policy, a retain the policy it retained.
 */
export function admittedPractice(view, {scope = DEFAULT_PRACTICE_SCOPE, profile = null} = {}) {
  const hs = view.entries(), admitted = new Set();
  for (const h of hs) if (view.entry(h)?.kind === CLOSE) for (const d of view.payload(h)?.practice ?? []) admitted.add(d);
  for (let i = hs.length - 1; i >= 0; i--) {
    const h = hs[i];
    if (!admitted.has(h) || view.entry(h)?.kind !== PRACTICE) continue;
    const p = view.payload(h);
    if (p.scope !== scope || !ADMITTING.includes(p.outcome)) continue;
    const policy = p.outcome === 'promote' ? p.candidate.policy : p.policy;
    if (profile !== null && policy.profile !== profile) continue;
    return {disposition: h, outcome: p.outcome, stage: p.stage, policy, provisional: p.provisional, question: p.question, cycle: view.entry(h).derived_from[0]};
  }
  return null;
}

const viewOf = ledger => {
  const byHash = new Map(ledger.read().map(e => [ledger.hashOf(e), e]));
  return {entry: h => byHash.get(h) ?? null, payload: h => (byHash.has(h) ? ledger.payloadOf(byHash.get(h)) : null), entries: () => [...byHash.keys()]};
};

/**
 * What a dispatch loads: the admitted practice decision on `ledger` (a chain: openPantheonLedger(...).ledger)
 * for `scope` and `profile`, else the named provisional default (this code's selection policy). Returns
 * the reference a turn's selection records: {schema, scope, disposition (entry hash or null), outcome,
 * policy, provisional, applies, reason}. `applies` says whether the loaded policy is the one this
 * dispatcher implements (selectionPolicy(profile, {pools})).
 */
export function loadPractice({ledger = null, scope = DEFAULT_PRACTICE_SCOPE, profile = 'argo', pools = []} = {}) {
  const current = currentPolicy(profile, {pools});
  const base = {schema: PRACTICE_SCHEMA, scope};
  const provisional = why => ({...base, disposition: null, outcome: null, policy: current, provisional: true, applies: true,
    reason: `${why}; the named provisional default ${current.version} (${current.profile}) applies`});
  if (!ledger || typeof ledger.read !== 'function') return provisional('no ledger is open for this dispatch');
  const a = admittedPractice(viewOf(ledger), {scope, profile});
  if (!a) return provisional(`no admitted practice disposition for ${scope} (${profile}) is on the ledger`);
  const applies = a.policy.hash === current.hash;
  return {...base, disposition: a.disposition, outcome: a.outcome, policy: a.policy, provisional: a.provisional, applies,
    reason: applies ? `loaded the admitted ${a.outcome} ${a.disposition.slice(0, 19)}; it is the policy this dispatcher runs`
      : `loaded the admitted ${a.outcome} ${a.disposition.slice(0, 19)}, whose policy ${a.policy.hash.slice(0, 19)} is not the one this dispatcher implements (${current.hash.slice(0, 19)}); the dispatch ran ${current.version} and records the difference`};
}

/** A selection (selectSeat's result) with the practice reference it was made under, on it and on every candidate. */
export function withPractice(choice, practice) {
  if (!choice || !practice) return choice;
  const tag = c => ({...c, selection: {...c.selection, practice}});
  const candidates = (choice.candidates ?? []).map(tag);
  // The seat stays the first candidate (the same object), as selectSeat returns it.
  const seat = choice.seat && (choice.seat === choice.candidates?.[0] ? candidates[0] : tag(choice.seat));
  return {...choice, selection: {...choice.selection, practice}, seat, candidates};
}

/** Records practice dispositions (the controller signs). Policy and scope are the cycle's own. */
export function practiceRecorder({ledger, controller, order}) {
  const by = {author: {key_id: controller.key_id}, signer: controller, order};
  return {
    /**
     * Record a practice assessment (stage `assessment`) or a candidate's disposition (stage `candidate`,
     * citing `proposal`, decided `by` a seat). Refused by the ledger when it does not re-derive.
     */
    recordDisposition({cycle, stage = 'assessment', outcome, question, measured = false, provisional = !measured, evidence = [], provenance,
      candidate = null, proposer = null, proposal = null, by: seat = null, conditions = null, at = new Date().toISOString()}) {
      const view = viewOf(ledger), c = view.payload(cycle);
      if (!c) throw Object.assign(new Error(`recordDisposition: ${cycle} is not on the ledger`), {code: 'NO_CYCLE'});
      let cand = candidate, prop = proposer;
      if (stage === 'candidate' && proposal) { const q = view.payload(proposal); cand ??= q?.candidate ?? null; prop ??= q?.proposer ?? null; }
      const payload = {schema: PRACTICE_SCHEMA, scope: c.practice_scope ?? DEFAULT_PRACTICE_SCOPE, stage, policy: c.policy ?? null, question, outcome,
        measured, provisional, evidence, provenance, candidate: cand, proposer: prop, by: seat, conditions, at};
      const refs = evidence.filter(x => x?.kind === 'ledger').map(x => x.hash);
      return ledger.append({kind: PRACTICE, payload, derivedFrom: [cycle, ...(stage === 'candidate' && proposal ? [proposal] : []), ...refs], ...by}).hash;
    },
    /** Retain a finalized comparison record (the whole record) so a promote can bind to it. Returns the entry hash. */
    recordComparison(record) {
      return ledger.append({kind: COMPARISON, payload: record, derivedFrom: [], ...by}).hash;
    },
    /** The admitted practice decision on this ledger (admittedPractice). */
    admittedPractice: (opts = {}) => admittedPractice(viewOf(ledger), opts),
  };
}
