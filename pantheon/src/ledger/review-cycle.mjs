// The review layer at a cycle boundary: N independent reviewers on distinct labs read the cycle's change
// with a fixed brief, and every turn, review and finding is a ledger entry (cycle-kinds.mjs). The
// controller then fixes or defers each finding and closes the cycle; the close re-derives or is refused.
//
// `turn` is injected, as `makeClientFor` is for runOpenItem: this module never imports a vendor SDK, so
// tests run it with scripted reviewers and the CLI (bin/pantheon-review-cycle.mjs) passes a live one.
import {SEATING, candidatesFor} from '../role/seating.mjs';
import {labOf} from './lineage-kinds.mjs';
import {REVIEW_BRIEF, reviewPrompt, parseReview} from './cycle-kinds.mjs';
import {promptSha} from '../context/chain.mjs';

/**
 * Reviewer seats on `n` distinct labs, none of them in `avoidLabs` (the labs that authored the change).
 * The reviewer table first, in its own order; then the other roles' tables, for a lab the reviewer table
 * does not hold (with an Anthropic author, the reviewer table has two other labs and the third comes from
 * another chair). Throws when the seating table has fewer than `n` labs left.
 */
export function reviewSeats({n = 3, avoidLabs = [], seating = SEATING} = {}) {
  const out = [], taken = new Set(avoidLabs);
  for (const role of ['reviewer', ...Object.keys(seating).filter(r => r !== 'reviewer')]) {
    for (const c of candidatesFor(role, {seating})) {
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
 * Open a cycle on the ledger and review it.
 *   ledger  a recorder with the lineage and cycle methods (openPantheonLedger(...).recorder())
 *   change  {scope, base?, head, diff, files, author_labs?, author_turns?}; without `base`, the cycle
 *           starts where the previous cycle of the scope ended
 *   seats   [{vendor, model}], default reviewSeats({n, avoidLabs: author_labs})
 *   turn    async ({vendor, model, prompt, seat}) -> {text, response_id, served_model}
 * Returns the cycle, each recorded review with its findings, and the seats that failed (a failed seat
 * leaves the cycle unable to close until it is re-run in a new cycle of the same range).
 */
export async function reviewCycle({ledger, change, seats = null, turn, n = 3, brief = REVIEW_BRIEF, opened_at}) {
  if (typeof turn !== 'function') throw new Error('reviewCycle: pass turn({vendor, model, prompt, seat}) -> {text, response_id, served_model}');
  const {scope, head, diff, files = [], author_labs = [], author_turns = []} = change ?? {};
  if (typeof diff !== 'string' || diff === '') throw new Error('reviewCycle: the change carries its diff text');
  const base = change.base ?? ledger.lastCycle(scope)?.head;
  if (!base) throw new Error(`reviewCycle: no base given and no earlier cycle of "${scope}" on the ledger`);
  const chosen = (seats ?? reviewSeats({n, avoidLabs: author_labs})).map(s => ({...s, lab: labOf(s.vendor, s.model)}));
  const labs = chosen.map(s => s.lab);
  if (new Set(labs).size !== labs.length) throw Object.assign(new Error(`reviewCycle: reviewers share a lab (${labs.join(', ')})`), {code: 'SAME_LAB'});
  const authored = labs.find(l => author_labs.includes(l));
  if (authored) throw Object.assign(new Error(`reviewCycle: the ${authored} lab authored the change and may not review it`), {code: 'SAME_LAB'});

  const prompt = reviewPrompt({brief, base, head, files, diff});
  const cycle = ledger.openCycle({scope, base, head, diff, files, prompt, brief, reviewers: chosen.length, author_labs, author_turns, opened_at});
  const answers = await Promise.allSettled(chosen.map(s => turn({vendor: s.vendor, model: s.model, prompt, seat: s})));
  const reviews = [], failed = [];
  for (const [i, s] of chosen.entries()) {
    if (answers[i].status === 'rejected') { failed.push({vendor: s.vendor, model: s.model, why: String(answers[i].reason?.message ?? answers[i].reason)}); continue; }
    const r = answers[i].value ?? {};
    const seat = {seat_id: `${s.vendor}-cycle-review@${s.model}`, vendor: s.vendor, mode: 'cycle-review', occupancy_gen: 1};
    const served_model = r.served_model ?? null, response_id = r.response_id ?? null, reply = r.text ?? '';
    try {
      const t = ledger.recordTurn({seat, requested_model: s.model, served_model, response_id, reply, purpose: 'cycle-review', prompt, cites: [cycle]});
      const parsed = parseReview(reply);
      const review = ledger.recordReview({seat, model: s.model, served_model, response_id, verdict: parsed.verdict,
        findings: parsed.findings.map(f => `[${f.severity}] ${f.file ?? '-'}${f.line ? `:${f.line}` : ''} ${f.claim}`).join('\n'),
        targets: [cycle, ...author_turns], turn: t});
      const findings = parsed.findings.map((finding, index) => ({hash: ledger.recordFinding({review, index, finding}), ...finding}));
      reviews.push({vendor: s.vendor, model: s.model, served_model, lab: labOf(s.vendor, served_model ?? s.model), turn: t, review, verdict: parsed.verdict, parsed: parsed.parsed, findings});
    } catch (err) { failed.push({vendor: s.vendor, model: s.model, why: err.message}); }
  }
  return {cycle, scope, base, head, prompt_sha: promptSha(prompt), reviews, failed, complete: failed.length === 0};
}
