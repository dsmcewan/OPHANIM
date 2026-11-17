// Review every cycle, on the ledger (docs/cycle-review.md items 2 and 5-6; docs/STATUS.md
// `review-every-cycle`). A cycle checked only by its author shipped a regression; the layered review
// found it. So the review is not a pass someone remembers to run: it is a chain of entries, and a cycle
// does not close until they re-derive.
//
//   cycle               {scope, base, head, diff_sha, files, prompt_sha, brief_sha, reviewers, author_labs,
//                        opened_at}. The change under review: two commit ids of the repository and the
//                       digest of the diff between them. Opened by the controller. Cycles of one scope
//                       form a contiguous chain: a cycle's base is the previous cycle's head, and it cites
//                       that cycle's close, so no range of commits goes unreviewed and no cycle opens
//                       while the previous one is still open. It may cite the author's turns.
//   review (lineage)    each reviewer's verdict, signed by the reviewing seat and citing the cycle (and so,
//                       through it, the author turns): cold review applies (lineage-kinds.mjs). It names
//                       the turn that answered, which must have been given exactly the cycle's prompt.
//                       One review per lab per cycle, and never the lab that authored the change.
//   finding             {review, index, severity, file, line, claim, reproduction}: one structured
//                       finding, re-derived from the reviewer's signed reply (it must be finding `index`
//                       of that reply, as parseReview reads it), so the controller can neither invent
//                       nor reword one. `reproduction` is a command or test, or null when the reviewer
//                       gave none.
//   finding.resolution  {status: fixed, fix: {commit, test, before: {commit, exit}, after: {commit, exit}}}
//                       or {status: deferred, reason}. A fix names a later commit and a test that exited
//                       non-zero on the reviewed head and zero on the fix.
//   cycle.close         {outcome, reviews, labs, findings: {total, fixed, deferred, unreproduced}}: the
//                       close is a CLAIM the ledger re-derives from the cycle's entries. It holds only if
//                       every review is recorded on distinct labs, every finding a reviewer reported is
//                       recorded, and every finding is fixed or deferred. The outcome is not chosen:
//                       `verified` when every finding carries a reproduction, `unverified` otherwise.
//
// What re-derivation does NOT do: run the tests or the reproductions, or check that the fix commit is a
// descendant of the head. The fail-before / pass-after exits are recorded data (signed by the
// controller, like the gate's lease rows were), checked for presence and consistency only.
import {createHash} from 'node:crypto';
import {canonical} from '../../../packages/ledger/canonical.mjs';
import {labOf} from './lineage-kinds.mjs';
import {promptSha} from '../context/chain.mjs';

export const CYCLE = 'cycle', FINDING = 'finding', RESOLUTION = 'finding.resolution', CLOSE = 'cycle.close';
export const SEVERITIES = ['block', 'major', 'minor', 'note'];
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;            // a git object id (sha1 or sha256)
const SHA = /^sha256:[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]{64}$/;
const ISO = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const str = v => typeof v === 'string' && v.trim() !== '';
export const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');

/** The fixed brief every reviewer of a cycle is given, before the change. */
export const REVIEW_BRIEF = [
  'You are an independent reviewer of one change to this repository. You did not write it.',
  'Read the diff below and look for defects: wrong behaviour, regressions, broken invariants, missing',
  'or vacuous tests, security problems, and claims in docs or comments the code does not support.',
  'For each finding give a reproduction: a shell command or a test that fails on this change. A finding',
  'you cannot reproduce may still be reported, with "reproduction": null; it will be recorded as such.',
  'Answer with ONE JSON object and nothing else, in a ```json block:',
  '{"verdict": "approve" | "request_changes",',
  ' "findings": [{"severity": "block" | "major" | "minor" | "note", "file": "<path in the diff> or null",',
  '   "line": <number> or null, "claim": "<what is wrong>",',
  '   "reproduction": {"kind": "command" | "test", "run": "<command or test name>"} or null}]}',
].join('\n');

/** The prompt a cycle's reviewers are given: the brief, then the change. Its digest is on the cycle. */
export function reviewPrompt({brief = REVIEW_BRIEF, base, head, files = [], diff}) {
  return `${brief}\n\n## Change ${base}..${head}\n\nFiles:\n${files.map(f => `- ${f}`).join('\n')}\n\n\`\`\`diff\n${diff}\n\`\`\`\n`;
}

const UNANSWERED = {severity: 'block', file: null, line: null, claim: 'the review did not answer in the required form', reproduction: null};
const NO_FINDING = {severity: 'block', file: null, line: null, claim: 'changes were requested without a finding', reproduction: null};
function normalFinding(f) {
  if (!f || typeof f !== 'object' || !SEVERITIES.includes(f.severity) || !str(f.claim)) return null;
  const file = f.file ?? null, line = f.line ?? null;
  if (file !== null && !str(file)) return null;
  if (line !== null && !(Number.isInteger(line) && line > 0)) return null;
  let reproduction = f.reproduction ?? null;
  if (typeof reproduction === 'string') reproduction = str(reproduction) ? {kind: 'command', run: reproduction} : null;
  if (reproduction !== null && !(['command', 'test'].includes(reproduction.kind) && str(reproduction.run))) return null;
  return {severity: f.severity, file, line, claim: f.claim, reproduction: reproduction && {kind: reproduction.kind, run: reproduction.run}};
}
/**
 * A reviewer's reply, read deterministically: {verdict, findings, parsed}. A reply that is not the
 * required JSON fails closed (request_changes, one unreproduced blocking finding), and so does a request
 * for changes with no finding. The ledger re-runs this on the signed reply to re-derive each finding.
 */
export function parseReview(reply) {
  const fenced = /```json\s*([\s\S]*?)```/.exec(reply ?? '');
  const raw = fenced ? fenced[1] : (reply ?? '').slice((reply ?? '').indexOf('{'), (reply ?? '').lastIndexOf('}') + 1);
  let j = null;
  try { j = JSON.parse(raw); } catch { j = null; }
  const findings = Array.isArray(j?.findings) ? j.findings.map(normalFinding) : null;
  if (!j || !['approve', 'request_changes'].includes(j.verdict) || !findings || findings.includes(null)) {
    return {verdict: 'request_changes', findings: [UNANSWERED], parsed: false};
  }
  if (j.verdict === 'request_changes' && !findings.length) return {verdict: 'request_changes', findings: [NO_FINDING], parsed: true};
  return {verdict: j.verdict, findings, parsed: true};
}

const findingOf = p => ({severity: p.severity, file: p.file, line: p.line, claim: p.claim, reproduction: p.reproduction});
const cites = (view, e, kind) => e.derived_from.filter(h => view.entry(h)?.kind === kind);

/** The cycle a review cites, or null. */
const cycleOfReview = (view, review) => cites(view, view.entry(review), CYCLE)[0] ?? null;

/**
 * Everything the ledger holds for one cycle, as of the view: the cycle, its reviews (with each one's
 * lab and the findings its reply reports), the recorded findings and their resolutions, and its close.
 */
export function deriveCycle(view, cycle) {
  const c = view.payload(cycle);
  const out = {hash: cycle, cycle: c, reviews: [], findings: [], resolutions: new Map(), close: null};
  const reviews = new Set(), findings = new Set();
  for (const h of view.entries()) {
    const e = view.entry(h);
    if (e.kind === 'review' && e.derived_from.includes(cycle)) {
      const p = view.payload(h);
      const answer = view.payload(p.turn);
      out.reviews.push({hash: h, seat: p.seat, lab: labOf(p.seat.vendor, p.served_model ?? p.model), verdict: p.verdict,
        reported: parseReview(answer?.reply ?? '')});
      reviews.add(h);
    } else if (e.kind === FINDING && e.derived_from.some(x => reviews.has(x))) {
      out.findings.push({hash: h, review: e.derived_from.find(x => reviews.has(x)), payload: view.payload(h)});
      findings.add(h);
    } else if (e.kind === RESOLUTION && e.derived_from.some(x => findings.has(x))) {
      out.resolutions.set(e.derived_from.find(x => findings.has(x)), {hash: h, payload: view.payload(h)});
    } else if (e.kind === CLOSE && e.derived_from.includes(cycle)) out.close = h;
  }
  return out;
}

/** The close a cycle's entries derive, or {why} when it cannot close yet. */
export function closeClaim(state) {
  const {cycle: c, reviews, findings, resolutions} = state;
  if (reviews.length !== c.reviewers) return {why: `${reviews.length} of ${c.reviewers} reviews are recorded`};
  const labs = reviews.map(r => r.lab);
  if (new Set(labs).size !== labs.length) return {why: 'two reviews of this cycle share a lab'};
  const authored = labs.find(l => c.author_labs.includes(l));
  if (authored) return {why: `the ${authored} lab authored the change and reviewed it`};
  for (const r of reviews) {
    const recorded = findings.filter(f => f.review === r.hash).length;
    if (recorded !== r.reported.findings.length) return {why: `a review reported ${r.reported.findings.length} finding(s) and ${recorded} are recorded`};
  }
  let fixed = 0, deferred = 0, unreproduced = 0;
  for (const f of findings) {
    const res = resolutions.get(f.hash);
    if (!res) return {why: `finding ${f.hash.slice(0, 19)} is neither fixed nor deferred`};
    if (res.payload.status === 'fixed') fixed++; else deferred++;
    if (f.payload.reproduction === null) unreproduced++;
  }
  return {claim: {outcome: unreproduced ? 'unverified' : 'verified', reviews: reviews.map(r => r.hash).sort(), labs: [...labs].sort(),
    findings: {total: findings.length, fixed, deferred, unreproduced}}};
}

/** The latest cycle of a scope before the entry being checked, or null. */
function latestCycle(view, scope) {
  const hs = view.entries();
  for (let i = hs.length - 1; i >= 0; i--) if (view.entry(hs[i])?.kind === CYCLE && view.payload(hs[i])?.scope === scope) return hs[i];
  return null;
}
const closedAt = (view, cycle) => view.entries().find(h => view.entry(h)?.kind === CLOSE && view.entry(h).derived_from.includes(cycle)) ?? null;

/** Kind specs. `authors` decides who may open, record findings for, resolve and close a cycle (the controller). */
export function cycleKinds({authors = () => true} = {}) {
  return {
    [CYCLE]: {
      authors,
      validate: p => (str(p?.scope) && COMMIT.test(p.base ?? '') && COMMIT.test(p.head ?? '') && SHA.test(p.diff_sha ?? '') && SHA.test(p.brief_sha ?? '')
        && HEX.test(p.prompt_sha ?? '') && Array.isArray(p.files) && p.files.every(str) && Number.isInteger(p.reviewers) && p.reviewers >= 1
        && Array.isArray(p.author_labs) && p.author_labs.every(str) && ISO(p.opened_at)
        ? null : 'a cycle names {scope, base, head, diff_sha, files, prompt_sha, brief_sha, reviewers, author_labs, opened_at}'),
      rederive: (e, view) => {
        const p = e.payload;
        if (p.base === p.head) return 'a cycle reviews a change: its base and head differ';
        if (e.derived_from.some(h => ![CLOSE, 'turn'].includes(view.entry(h)?.kind))) return 'a cycle cites only the author\'s turns and the previous cycle\'s close';
        const prev = latestCycle(view, p.scope), closes = cites(view, e, CLOSE);
        if (!prev) return closes.length ? 'the first cycle of a scope cites no close' : null;
        const close = closedAt(view, prev);
        if (!close) return 'the previous cycle of this scope is not closed';
        if (closes.length !== 1 || closes[0] !== close) return 'a cycle cites the close of the previous cycle of its scope';
        if (view.payload(prev).head !== p.base) return `the base is not where the previous cycle ended (${view.payload(prev).head.slice(0, 12)}): a range would go unreviewed`;
        return null;
      },
    },
    [FINDING]: {
      authors,
      validate: p => (Number.isInteger(p?.index) && p.index >= 0 && SEVERITIES.includes(p.severity) && str(p.claim)
        && (p.file === null || str(p.file)) && (p.line === null || (Number.isInteger(p.line) && p.line > 0))
        && (p.reproduction === null || (['command', 'test'].includes(p.reproduction?.kind) && str(p.reproduction.run)))
        ? null : 'a finding names {index, severity, file, line, claim, reproduction}'),
      rederive: (e, view) => {
        const reviews = cites(view, e, 'review');
        if (reviews.length !== 1 || e.derived_from.length !== 1) return 'a finding cites exactly the review that reported it';
        const cycle = cycleOfReview(view, reviews[0]);
        if (!cycle) return 'a finding belongs to a cycle review';
        if (closedAt(view, cycle)) return 'the cycle is closed';
        const r = view.payload(reviews[0]);
        const reported = parseReview(view.payload(r.turn)?.reply ?? '').findings[e.payload.index];
        if (!reported || canonical(reported) !== canonical(findingOf(e.payload))) return 'the finding is not the one the reviewer\'s reply reports at that index';
        const c = view.payload(cycle);
        if (e.payload.file !== null && !c.files.includes(e.payload.file)) return `${e.payload.file} is not in the change under review`;
        for (const h of view.entries()) {
          const x = view.entry(h);
          if (x.kind === FINDING && x.derived_from[0] === reviews[0] && view.payload(h).index === e.payload.index) return 'that finding is already recorded';
        }
        return null;
      },
    },
    [RESOLUTION]: {
      authors,
      validate: p => (p?.status === 'fixed'
        ? (p.fix && COMMIT.test(p.fix.commit ?? '') && str(p.fix.test) && COMMIT.test(p.fix.before?.commit ?? '') && COMMIT.test(p.fix.after?.commit ?? '')
          && Number.isInteger(p.fix.before.exit) && Number.isInteger(p.fix.after.exit) ? null : 'a fix names {commit, test, before: {commit, exit}, after: {commit, exit}}')
        : p?.status === 'deferred' ? (str(p.reason) ? null : 'a deferral gives its reason') : 'a resolution is fixed or deferred'),
      rederive: (e, view) => {
        const fs = cites(view, e, FINDING);
        if (fs.length !== 1 || e.derived_from.length !== 1) return 'a resolution cites exactly the finding it resolves';
        const review = view.entry(fs[0]).derived_from[0], cycle = cycleOfReview(view, review);
        if (closedAt(view, cycle)) return 'the cycle is closed';
        for (const h of view.entries()) if (view.entry(h)?.kind === RESOLUTION && view.entry(h).derived_from[0] === fs[0]) return 'the finding is already resolved';
        if (e.payload.status === 'deferred') return null;
        const c = view.payload(cycle), fix = e.payload.fix;
        if (fix.commit === c.head || fix.commit === c.base) return 'a fix names a commit after the reviewed change';
        if (fix.before.commit !== c.head) return 'the test is shown failing on the reviewed head';
        if (fix.after.commit !== fix.commit) return 'the test is shown passing on the fix commit';
        if (fix.before.exit === 0) return 'the test did not fail before the fix';
        if (fix.after.exit !== 0) return 'the test did not pass after the fix';
        return null;
      },
    },
    [CLOSE]: {
      authors,
      validate: p => (['verified', 'unverified'].includes(p?.outcome) && Array.isArray(p.reviews) && Array.isArray(p.labs) && p.findings && typeof p.findings === 'object'
        ? null : 'a close names {outcome, reviews, labs, findings}'),
      rederive: (e, view) => {
        const cs = cites(view, e, CYCLE);
        if (cs.length !== 1 || e.derived_from.length !== 1) return 'a close cites exactly its cycle';
        if (closedAt(view, cs[0])) return 'the cycle is already closed';
        const derived = closeClaim(deriveCycle(view, cs[0]));
        if (derived.why) return `the cycle cannot close: ${derived.why}`;
        if (e.payload.outcome === 'verified' && derived.claim.outcome !== 'verified') return 'a finding without a reproduction keeps the cycle from closing as verified';
        return canonical(derived.claim) === canonical(e.payload) ? null : 'the close is not the one the cycle\'s entries derive';
      },
    },
  };
}

/** A view over a ledger that verifies, as kinds see it. */
export function ledgerView(ledger) {
  const byHash = new Map(ledger.read().map(e => [ledger.hashOf(e), e]));
  return {entry: h => byHash.get(h) ?? null, payload: h => (byHash.has(h) ? ledger.payloadOf(byHash.get(h)) : null), entries: () => [...byHash.keys()]};
}

/** Records a cycle's controller entries: open, findings, resolutions, close. Seat entries go through lineageRecorder. */
export function cycleRecorder({ledger, controller, order}) {
  const by = {author: {key_id: controller.key_id}, signer: controller, order};
  const append = (kind, payload, derivedFrom) => ledger.append({kind, payload, derivedFrom, ...by}).hash;
  /** Where the previous cycle of `scope` ended, and its close, if any (the next cycle's base). */
  const lastCycle = scope => {
    const view = ledgerView(ledger), h = latestCycle(view, scope);
    return h ? {hash: h, head: view.payload(h).head, close: closedAt(view, h)} : null;
  };
  return {
    lastCycle,
    openCycle({scope, base, head, diff, files, prompt, brief = REVIEW_BRIEF, reviewers = 3, author_labs = [], author_turns = [], opened_at = new Date().toISOString()}) {
      const prev = lastCycle(scope);
      const payload = {scope, base, head, diff_sha: sha(diff), files: [...files], prompt_sha: promptSha(prompt),
        brief_sha: sha(brief), reviewers, author_labs: [...author_labs], opened_at};
      return append(CYCLE, payload, [...(prev?.close ? [prev.close] : []), ...author_turns]);
    },
    recordFinding({review, index, finding}) { return append(FINDING, {index, ...findingOf(normalFinding(finding) ?? finding)}, [review]); },
    fixFinding({finding, commit, test, before, after}) { return append(RESOLUTION, {status: 'fixed', fix: {commit, test, before, after}}, [finding]); },
    deferFinding({finding, reason}) { return append(RESOLUTION, {status: 'deferred', reason}, [finding]); },
    cycleState: cycle => deriveCycle(ledgerView(ledger), cycle),
    /** Close the cycle with the claim its entries derive; throws with the reason when it cannot close. */
    closeCycle(cycle) {
      const derived = closeClaim(deriveCycle(ledgerView(ledger), cycle));
      if (derived.why) throw Object.assign(new Error(`the cycle cannot close: ${derived.why}`), {code: 'CYCLE_OPEN'});
      return {hash: append(CLOSE, derived.claim, [cycle]), ...derived.claim};
    },
  };
}
