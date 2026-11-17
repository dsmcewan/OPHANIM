// The review layer at a cycle boundary: N independent reviewers on distinct labs read the cycle's change
// with a fixed brief, and every turn, review and finding is a ledger entry (cycle-kinds.mjs). The
// controller then fixes or defers each finding and closes the cycle; the close re-derives or is refused.
//
// `turn` is injected, as `makeClientFor` is for runOpenItem: this module never imports a vendor SDK, so
// tests run it with scripted reviewers and the CLI (bin/pantheon-review-cycle.mjs) passes a live one.
//
// A reviewer that fails (a 503, a refused review) leaves the cycle open with fewer reviews than it
// needs, and the next cycle of the scope cannot open until it closes. `resume: true` is the supported
// way on (independent review 2026-11-16, C2): it reopens THAT cycle, never a new one, and tries again
// only the seats with no review, under the cycle's own bound brief and change, keeping every review
// already recorded. Every try is a `cycle.attempt` entry, failures with their reason, and a seat stops
// at the cycle's attempt limit.
import {SEATING, candidatesFor} from '../role/seating.mjs';
import {labOf} from './lineage-kinds.mjs';
import {REVIEW_BRIEF, reviewPrompt, parseReview, sha, REQUIRED_REVIEW_LABS, CYCLE_CONTRACT_V3, independenceRefusal} from './cycle-kinds.mjs';
import {modelIdentity, contributorKeys, reviewerRefusal, IDENTITY_RULES_DIGEST} from '../review/identity.mjs';
import {promptSha} from '../context/chain.mjs';
import {canonical} from '../../../packages/ledger/canonical.mjs';

/** Tries per reviewer seat of one cycle, the first included, unless the caller names another limit. */
export const DEFAULT_MAX_ATTEMPTS = 3;
const refuse = (code, why) => Object.assign(new Error(why), {code});

/**
 * Reviewer seats on `n` distinct labs, none of them in `avoidLabs` (the labs that authored the change).
 * The reviewer table first, in its own order; then the other roles' tables, for a lab the reviewer table
 * does not hold (with an Anthropic author, the reviewer table has two other labs and the third comes from
 * another chair). Throws when the seating table has fewer than `n` labs left.
 */
export function reviewSeats({n = 3, avoidLabs = [], seating = SEATING, facts = undefined} = {}) {
  const out = [], taken = new Set(avoidLabs);
  for (const role of ['reviewer', ...Object.keys(seating).filter(r => r !== 'reviewer')]) {
    for (const c of candidatesFor(role, {seating, ...(facts ? {facts} : {})})) {
      const lab = labOf(c.vendor, c.model);
      if (taken.has(lab) || !c.model) continue;
      taken.add(lab);
      out.push({vendor: c.vendor, model: c.model, lab, role, why: c.why});
      if (out.length === n) return out;
    }
  }
  throw Object.assign(new Error(`reviewSeats: ${out.length} lab(s) left after avoiding ${avoidLabs.join(', ') || 'none'}; ${n} are required`), {code: 'NO_SEATS'});
}

/**
 * Reviewer seats on `n` distinct labs under MODEL-level independence (pantheon.cycle/v3; owner direction 2026-11-17).
 * A candidate is eligible unless it IS a contributing model (by identity: an effort level, alias, snapshot or route of
 * a contributor is that contributor) or its lab is excluded outright (a contribution with no identifiable model).
 * One seat per lab. Labs that did not contribute are filled first, in the tables' order; then, as needed, labs that
 * did contribute, each with its first eligible model. Such a seat is marked `shared_lab` with the contributing models
 * of its lab. There is no fixed limit on shared-lab seats. Throws NO_SEATS when fewer than `n` labs have an eligible model.
 *   contributions  rows {vendor, model, served_model?, lab} (review/scope.mjs), or
 *   excluded       {models: [identity ids], labs: [labs], contributing_labs: [labs]} (a cycle's own record)
 */
export function reviewSeatsByModel({n = 3, contributions = [], excluded = null, seating = SEATING, facts = undefined} = {}) {
  const keys = excluded ?? contributorKeys(contributions);
  const contributing = new Set(keys.contributing_labs ?? [...keys.labs, ...keys.models.map(m => m.split('/')[0])]);
  const byLab = new Map();
  for (const role of ['reviewer', ...Object.keys(seating).filter(r => r !== 'reviewer')]) {
    for (const c of candidatesFor(role, {seating, ...(facts ? {facts} : {})})) {
      if (!c.model || reviewerRefusal({vendor: c.vendor, model: c.model}, keys)) continue;
      const lab = labOf(c.vendor, c.model);
      if (!byLab.has(lab)) byLab.set(lab, {vendor: c.vendor, model: c.model, lab, role, why: c.why, identity: modelIdentity(c.vendor, c.model).id});
    }
  }
  const order = [...[...byLab.keys()].filter(l => !contributing.has(l)), ...[...byLab.keys()].filter(l => contributing.has(l))];
  const seats = order.slice(0, n).map(l => {
    const s = byLab.get(l), shared = contributing.has(l);
    return {...s, shared_lab: shared, ...(shared ? {shared_with: keys.models.filter(m => m.startsWith(`${l}/`))} : {})};
  });
  if (seats.length < n) {
    throw Object.assign(new Error(`reviewSeatsByModel: ${seats.length} lab(s) have a model that did not contribute (${order.join(', ') || 'none'}); ${n} distinct labs are required`),
      {code: 'NO_SEATS', eligible_labs: order});
  }
  return seats;
}

/**
 * Ask each seat for its review of an open cycle and record what came back: the turn, the review and its
 * findings, and one attempt per seat (`tried` holds the attempts each lab already made). Seats are asked
 * concurrently; a seat that throws, or whose review the ledger refuses, is a failed attempt.
 */
async function askSeats({ledger, cycle, seats, prompt, turn, author_turns, tried = new Map(), max_attempts, resumed, at}) {
  const answers = await Promise.allSettled(seats.map(s => turn({vendor: s.vendor, model: s.model, prompt, seat: s})));
  const reviews = [], failed = [];
  for (const [i, s] of seats.entries()) {
    const attempt = (tried.get(s.lab) ?? 0) + 1;
    const fail = why => {
      failed.push({vendor: s.vendor, model: s.model, lab: s.lab, attempt, why});
      ledger.recordAttempt({cycle, seat: s, attempt, max_attempts, outcome: 'failed', why, resumed, at: at ?? new Date().toISOString()});
    };
    if (answers[i].status === 'rejected') { fail(String(answers[i].reason?.message ?? answers[i].reason)); continue; }
    const r = answers[i].value ?? {};
    const seat = {seat_id: `${s.vendor}-cycle-review@${s.model}`, vendor: s.vendor, mode: 'cycle-review', occupancy_gen: 1};
    const served_model = r.served_model ?? null, response_id = r.response_id ?? null, reply = r.text ?? '';
    let review = null;
    try {
      const t = ledger.recordTurn({seat, requested_model: s.model, served_model, response_id, reply, purpose: 'cycle-review', prompt, cites: [cycle]});
      const parsed = parseReview(reply);
      review = ledger.recordReview({seat, model: s.model, served_model, response_id, verdict: parsed.verdict,
        findings: parsed.findings.map(f => `[${f.severity}] ${f.file ?? '-'}${f.line ? `:${f.line}` : ''} ${f.claim}`).join('\n'),
        targets: [cycle, ...author_turns], turn: t});
      ledger.recordAttempt({cycle, seat: s, attempt, max_attempts, outcome: 'reviewed', review, resumed, at: at ?? new Date().toISOString()});
      const findings = parsed.findings.map((finding, index) => ({hash: ledger.recordFinding({review, index, finding}), ...finding}));
      reviews.push({vendor: s.vendor, model: s.model, served_model, lab: labOf(s.vendor, served_model ?? s.model), turn: t, review, verdict: parsed.verdict, parsed: parsed.parsed, findings});
    } catch (err) {
      // A review that was recorded stands (resume completes its findings); only a seat with none failed.
      if (review) failed.push({vendor: s.vendor, model: s.model, lab: s.lab, attempt, why: err.message, review});
      else fail(err.message);
    }
  }
  return {reviews, failed};
}

/**
 * Open a cycle on the ledger and review it, or, with `resume: true`, resume the scope's open cycle.
 *   ledger  a recorder with the lineage and cycle methods (openPantheonLedger(...).recorder())
 *   change  {scope, base?, head, diff, files, author_labs?, author_turns?}; without `base`, the cycle
 *           starts where the previous cycle of the scope ended
 *   seats   [{vendor, model}], default reviewSeats({n, avoidLabs: author_labs})
 *   turn    async ({vendor, model, prompt, seat}) -> {text, response_id, served_model}
 *   max_attempts  tries per seat for the cycle, the first included (default DEFAULT_MAX_ATTEMPTS)
 *   contract, policy, practice_scope  the cycle contract it opens under (default pantheon.cycle/v2), the
 *           selection policy in effect and the practice scope (cycleRecorder.openCycle)
 *   required_reviewers  the independent labs the review requires, recorded on the cycle (at least
 *           REQUIRED_REVIEW_LABS; a board run and the CLI pass it). Fewer seats than that is refused before the
 *           cycle opens (REVIEW_LABS_BELOW_REQUIRED), and the cycle cannot close on fewer labs.
 * Returns the cycle, each recorded review with its findings, and the seats that failed. A failed seat
 * leaves the cycle unable to close; `resume: true` with the same change tries it again.
 */
export async function reviewCycle({ledger, change, seats = null, turn, n = 3, brief = REVIEW_BRIEF, opened_at, resume = false, max_attempts, at,
  contract, policy, practice_scope, required_reviewers}) {
  if (typeof turn !== 'function') throw new Error('reviewCycle: pass turn({vendor, model, prompt, seat}) -> {text, response_id, served_model}');
  if (resume) return resumeCycle({ledger, change, seats, turn, brief, max_attempts, at});
  const {scope, head, diff, files = [], author_labs = [], author_turns = []} = change ?? {};
  // Model-level independence is asked for explicitly (change.independence: 'model', with the contributions); it opens
  // the cycle under pantheon.cycle/v3. Without it the cycle opens as before, under the lab rule.
  const byModel = change?.independence === 'model';
  const keys = byModel ? contributorKeys(change.contributions ?? []) : null;
  if (byModel && required_reviewers === undefined) required_reviewers = Math.max(n, REQUIRED_REVIEW_LABS);
  if (typeof diff !== 'string' || diff === '') throw new Error('reviewCycle: the change carries its diff text');
  const last = ledger.lastCycle(scope);
  if (last && !last.close) {
    throw refuse('CYCLE_OPEN', `reviewCycle: the previous cycle of this scope is not closed (${last.hash.slice(0, 19)}): resume it (resume: true; pantheon-review-cycle resume) or close it first`);
  }
  const base = change.base ?? last?.head;
  if (!base) throw new Error(`reviewCycle: no base given and no earlier cycle of "${scope}" on the ledger`);
  const limit = max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('reviewCycle: max_attempts is a positive integer');
  const chosen = (seats ?? (byModel ? reviewSeatsByModel({n, excluded: keys}) : reviewSeats({n, avoidLabs: author_labs}))).map(s => ({...s, lab: labOf(s.vendor, s.model)}));
  const labs = chosen.map(s => s.lab);
  if (new Set(labs).size !== labs.length) throw Object.assign(new Error(`reviewCycle: reviewers share a lab (${labs.join(', ')})`), {code: 'SAME_LAB'});
  if (required_reviewers !== undefined && !(Number.isInteger(required_reviewers) && required_reviewers >= REQUIRED_REVIEW_LABS && chosen.length >= required_reviewers)) {
    throw refuse('REVIEW_LABS_BELOW_REQUIRED', `reviewCycle: the review requires ${Math.max(Number(required_reviewers) || 0, REQUIRED_REVIEW_LABS)} independent labs ` +
      `and ${chosen.length} reviewer seat(s) were given; a caller cannot lower it`);
  }
  if (byModel) {
    for (const s of chosen) { const why = reviewerRefusal(s, keys); if (why) throw Object.assign(new Error(`reviewCycle: ${why}`), {code: 'CONTRIBUTOR'}); }
  } else {
    const authored = labs.find(l => author_labs.includes(l));
    if (authored) throw Object.assign(new Error(`reviewCycle: the ${authored} lab authored the change and may not review it`), {code: 'SAME_LAB'});
  }

  const prompt = reviewPrompt({brief, base, head, files, diff});
  const cycle = ledger.openCycle({scope, base, head, diff, files, prompt, brief, reviewers: chosen.length, author_labs: byModel ? keys.contributing_labs : author_labs, author_turns, opened_at,
    contract: byModel ? CYCLE_CONTRACT_V3 : contract, policy, practice_scope, ...(required_reviewers !== undefined ? {required_reviewers} : {}),
    ...(byModel ? {author_models: keys.models, excluded_labs: keys.labs, identity_rules: IDENTITY_RULES_DIGEST} : {})});
  const {reviews, failed} = await askSeats({ledger, cycle, seats: chosen, prompt, turn, author_turns, max_attempts: limit, resumed: false, at});
  return {cycle, scope, base, head, prompt_sha: promptSha(prompt), reviews, failed, complete: failed.length === 0, max_attempts: limit};
}

/**
 * Resume the open cycle of `change.scope`. The change must be the one the cycle bound (its base, head,
 * diff, files, author labs and turns, and the brief: the prompt's digest is re-derived and compared), so
 * a resume cannot review a different change under the old cycle, and none opens a new cycle. Reviews
 * already recorded are kept, and a recorded review missing findings has them recorded from its own reply
 * (no new turn). The seats tried again are the cycle's failed seats with no review (from its attempts);
 * a cycle with no attempts on record (opened before they existed) is filled from `seats`, else from the
 * default seating, on labs that have not reviewed it.
 */
async function resumeCycle({ledger, change, seats, turn, brief, max_attempts, at}) {
  const scope = change?.scope;
  const last = ledger.lastCycle(scope);
  if (!last) throw refuse('NO_OPEN_CYCLE', `reviewCycle resume: no cycle of "${scope}" is on the ledger; there is nothing to resume`);
  if (last.close) throw refuse('NO_OPEN_CYCLE', `reviewCycle resume: the last cycle of "${scope}" (${last.hash.slice(0, 19)}) is closed; there is nothing to resume`);
  const cycle = last.hash;
  let state = ledger.cycleState(cycle);
  const c = state.cycle;
  const mismatch = why => refuse('RESUME_MISMATCH', `reviewCycle resume: ${why}; a resume reviews the change the open cycle ${cycle.slice(0, 19)} bound`);
  const {diff} = change;
  if (typeof diff !== 'string' || diff === '') throw new Error('reviewCycle: the change carries its diff text');
  if ((change.base ?? c.base) !== c.base) throw mismatch(`base ${change.base} is not the cycle's ${c.base}`);
  if ((change.head ?? c.head) !== c.head) throw mismatch(`head ${change.head} is not the cycle's ${c.head}`);
  if (sha(diff) !== c.diff_sha) throw mismatch('the diff is not the one the cycle names');
  if (change.files && canonical([...change.files]) !== canonical(c.files)) throw mismatch('the files are not the ones the cycle names');
  if (change.author_labs && canonical([...change.author_labs].sort()) !== canonical([...c.author_labs].sort())) throw mismatch('the author labs are not the cycle\'s');
  const author_turns = state.author_turns;
  if (change.author_turns && canonical([...change.author_turns].sort()) !== canonical([...author_turns].sort())) throw mismatch('the author turns are not the ones the cycle cites');
  if (sha(brief) !== c.brief_sha) throw mismatch('the brief is not the one the cycle was given');
  const prompt = reviewPrompt({brief, base: c.base, head: c.head, files: c.files, diff});
  if (promptSha(prompt) !== c.prompt_sha) throw mismatch('the prompt does not re-derive the cycle\'s');

  const recorded = [...new Set(state.attempts.map(a => a.max_attempts))];
  if (recorded.length && max_attempts !== undefined && max_attempts !== recorded[0]) throw mismatch(`the cycle's attempt limit is ${recorded[0]}, not ${max_attempts}`);
  const limit = recorded[0] ?? max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('reviewCycle: max_attempts is a positive integer');

  // Retained: a recorded review stands; any finding its reply reports and the ledger lacks is recorded now.
  const filled = [];
  for (const r of state.reviews) {
    const have = new Set(state.findings.filter(f => f.review === r.hash).map(f => f.payload.index));
    for (const [index, finding] of r.reported.findings.entries()) {
      if (!have.has(index)) filled.push(ledger.recordFinding({review: r.hash, index, finding}));
    }
  }
  if (filled.length) state = ledger.cycleState(cycle);

  const reviewed = new Set(state.reviews.map(r => r.lab));
  for (const a of state.attempts) if (a.outcome === 'reviewed') reviewed.add(a.seat.lab);
  const tried = new Map(), failedSeat = new Map();
  for (const a of state.attempts) {
    tried.set(a.seat.lab, (tried.get(a.seat.lab) ?? 0) + 1);
    if (a.outcome === 'failed' && !reviewed.has(a.seat.lab)) failedSeat.set(a.seat.lab, {vendor: a.seat.vendor, model: a.seat.model, lab: a.seat.lab});
  }
  const missing = c.reviewers - state.reviews.length;
  const retained = state.reviews.map(r => ({vendor: r.seat.vendor, model: r.model, served_model: r.served_model, lab: r.lab, turn: r.turn, review: r.hash,
    verdict: r.verdict, parsed: r.reported.parsed, retained: true,
    findings: state.findings.filter(f => f.review === r.hash).map(f => ({hash: f.hash, ...findingFields(f.payload)}))}));
  const result = extra => ({cycle, scope, base: c.base, head: c.head, prompt_sha: c.prompt_sha, resumed: true, max_attempts: limit,
    retained: retained.map(r => r.review), filled_findings: filled, ...extra});
  if (missing <= 0) return result({reviews: retained, failed: [], attempted: [], complete: true});

  let chosen;
  if (seats) {
    chosen = seats.map(s => ({...s, lab: labOf(s.vendor, s.model)}));
    const labs = chosen.map(s => s.lab);
    if (new Set(labs).size !== labs.length) throw refuse('SAME_LAB', `reviewCycle resume: reviewers share a lab (${labs.join(', ')})`);
    // The seats are the cycle's original list: those whose lab has reviewed are kept, not asked again.
    chosen = chosen.filter(s => !reviewed.has(s.lab));
    for (const s of chosen) {
      const f = failedSeat.get(s.lab);
      if (f && (f.vendor !== s.vendor || f.model !== s.model)) throw mismatch(`the ${s.lab} seat that failed was ${f.vendor}/${f.model}, not ${s.vendor}/${s.model}`);
    }
    if (state.attempts.length) {
      const extra = chosen.find(s => !failedSeat.has(s.lab));
      if (extra) throw mismatch(`${extra.vendor}/${extra.model} is not one of the cycle's failed seats (${[...failedSeat.values()].map(s => `${s.vendor}/${s.model}`).join(', ') || 'none'})`);
    }
  } else {
    chosen = [...failedSeat.values()];
    if (!state.attempts.length || chosen.length < missing) {
      // No attempts on record for some seats (a cycle opened before attempts were recorded): the
      // default seating, as the original review used it, on labs that have not reviewed.
      let defaults = [];
      try {
        defaults = c.contract === CYCLE_CONTRACT_V3 ? reviewSeatsByModel({n: c.reviewers, excluded: {models: c.author_models, labs: c.excluded_labs, contributing_labs: c.author_labs}})
          : reviewSeats({n: c.reviewers, avoidLabs: c.author_labs});
      } catch { defaults = []; }
      for (const s of defaults) if (!reviewed.has(s.lab) && !chosen.some(x => x.lab === s.lab)) chosen.push(s);
    }
  }
  // The cycle's own contract decides who may review it: its lab rule (v1, v2) or its contributing models (v3).
  for (const s of chosen) { const why = independenceRefusal(c, s); if (why) throw refuse(c.contract === CYCLE_CONTRACT_V3 ? 'CONTRIBUTOR' : 'SAME_LAB', `reviewCycle resume: ${why}`); }
  chosen = chosen.slice(0, missing);
  if (!chosen.length) throw refuse('NO_SEATS', `reviewCycle resume: ${missing} review(s) are missing and no seat is left to ask`);
  const exhausted = chosen.filter(s => (tried.get(s.lab) ?? 0) >= limit);
  const ask = chosen.filter(s => (tried.get(s.lab) ?? 0) < limit);
  if (!ask.length) {
    throw Object.assign(refuse('ATTEMPT_LIMIT', `reviewCycle resume: ${exhausted.map(s => `${s.vendor}/${s.model}`).join(', ')} used the cycle's ${limit} attempt(s); the cycle stays open`),
      {exhausted: exhausted.map(s => ({vendor: s.vendor, model: s.model, lab: s.lab, attempts: tried.get(s.lab) ?? 0}))});
  }
  const asked = await askSeats({ledger, cycle, seats: ask, prompt, turn, author_turns, tried, max_attempts: limit, resumed: true, at});
  const failed = [...asked.failed, ...exhausted.map(s => ({vendor: s.vendor, model: s.model, lab: s.lab, attempt: tried.get(s.lab) ?? 0,
    why: `the seat used the cycle's ${limit} attempt(s)`, exhausted: true}))];
  const now = ledger.cycleState(cycle);
  return result({reviews: [...retained, ...asked.reviews], failed, attempted: ask.map(s => ({vendor: s.vendor, model: s.model, lab: s.lab})),
    complete: failed.length === 0 && now.reviews.length === c.reviewers});
}

const findingFields = p => ({severity: p.severity, file: p.file, line: p.line, claim: p.claim, reproduction: p.reproduction});
