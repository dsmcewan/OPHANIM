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
//   cycle.attempt       {seat: {vendor, model, lab}, attempt, max_attempts, outcome, why, resumed, at}: one
//                       reviewer seat's try at the cycle (independent review 2026-11-16, C2). A failed try
//                       (a 503, a refused review) is recorded with its reason, and the cycle can be RESUMED:
//                       only the seats that have no review are tried again, under the same prompt, and the
//                       reviews already recorded stand. Attempts of one lab are numbered 1, 2, ... and never
//                       pass the cycle's max_attempts (the same on every attempt of the cycle); a lab whose
//                       attempt was `reviewed` is not tried again. Additive: a cycle opened before this kind
//                       existed has no attempts, and its close re-derives exactly as before.
//
//   practice.disposition  (practice-kinds.mjs; independent review 2026-11-16, C3) the cycle's practice
//                       assessment and any candidate's disposition. The CONTRACT a cycle opened under is on
//                       the cycle: `contract: pantheon.cycle/v2` (the default for a new cycle) also names the
//                       selection policy in effect {version, hash, profile}, the practice scope, and `prior`,
//                       the admitted practice decision it loaded at open (cited; null for none). Such a cycle
//                       closes only with at least one assessment-stage disposition, and its close lists them
//                       (`practice`). A cycle with no `contract` field opened under the old contract: it
//                       re-derives, closes and hashes exactly as before. A scope does not return from v2 to
//                       the old contract.
//
//   required_reviewers  (optional on a cycle; 86ce18a review, defect 2) the independent labs the cycle's review
//                       requires, recorded when it opens (board runs and the review-cycle CLI: REQUIRED_REVIEW_LABS,
//                       3). Such a cycle names at least that many reviewers, never fewer than REQUIRED_REVIEW_LABS,
//                       and closes (verified or not) only on that many distinct labs. A cycle without the field
//                       (every v1 and v2 cycle opened before it existed) validates, closes and hashes exactly as before.
//
// What re-derivation does NOT do: run the tests or the reproductions, or check that the fix commit is a
// descendant of the head. The fail-before / pass-after exits are recorded data (signed by the
// controller, like the gate's lease rows were), checked for presence and consistency only.
import {createHash} from 'node:crypto';
import {canonical} from '../../../packages/ledger/canonical.mjs';
import {labOf, labRuleLab} from './lineage-kinds.mjs';
import {promptSha} from '../context/chain.mjs';
import {PRACTICE, CYCLE_CONTRACT, CYCLE_CONTRACT_V1, CYCLE_CONTRACT_V3, carriesPractice, DEFAULT_PRACTICE_SCOPE, validPolicy, currentPolicy, admittedPractice} from './practice-kinds.mjs';
import {reviewerRefusal, reviewerIdentity, candidateRefusal, candidateIdentity, resolveModel, policyRefusal, policyDigest, contributorKeys, servedSourceRefusal} from '../review/identity.mjs';

export {CYCLE_CONTRACT, CYCLE_CONTRACT_V1, CYCLE_CONTRACT_V3};

// REVIEW INDEPENDENCE, by contract (owner direction 2026-11-17). Two rules were one; v3 separates them.
//   every contract   three distinct labs on a qualifying panel: one review per lab per cycle, and required_reviewers.
//   v1, v2           no reviewer from a LAB that authored the change (`author_labs`). Unchanged: a cycle opened
//                    under v1 or v2 re-derives, closes and hashes exactly as before, now and always.
//   v3               no reviewer that IS a contributing MODEL (`author_models`, by identity: review/identity.mjs, so an
//                    effort level, alias, snapshot, session or route does not make a contributor eligible), and none
//                    from `excluded_labs` (labs of contributions that name a lab and no model). A reviewer from a lab
//                    that contributed is allowed, and the close records it (`shared_labs`).
//   v3 IDENTITY      a v3 cycle carries `identity_policy: {digest, rules}`: the WHOLE policy that resolves a model
//                    name to its identity and lab (review/identity.mjs), and `contributors`, the raw names it was
//                    opened with. Every check of the cycle -- who may review, which lab a review counts for, the
//                    seat's lab, the close -- uses those recorded rules, never the current configuration, so a later
//                    alias correction cannot change this cycle's validity. A reviewer whose asked-for or answering
//                    model the policy cannot resolve, or whose two names are of different labs, does not qualify.
//   v3 LINEAGE       (independent review, assignment 2, questions 2 and 5) the exclusions are RE-DERIVED from the
//                    recorded `contributors` under the recorded policy, never taken on the controller's word: every
//                    contributor must resolve (an unresolved one means no panel can qualify, so the cycle is not
//                    opened), `author_models` must be exactly the identities they resolve to, `excluded_labs` must hold
//                    every lab a lab-only contribution names, and `author_labs` every contributing lab. A cycle whose
//                    exclusion arrays are narrower than its contributors is refused. (Wider `excluded_labs` only
//                    excludes more; v3 cycles opened before lab-only contributors were recorded carry exactly that.)
/**
 * Why a v3 contributor row's stated identity is not a consistent statement, or null (wave 3, L-504 invariant 2). Rows
 * recorded before it state none and are checked as recorded. A row that states it names its requested model (a name),
 * its served model (a name, or null: none was named) and a marker of the vocabulary consistent with them, and its
 * `model` is one of those names.
 */
export function contributorIdentityRefusal(x) {
  const stated = x.requested_model !== undefined || x.served_model !== undefined || x.served_model_source !== undefined;
  if (!stated) return null;
  if (!str(x.model)) return 'a contributor row that states an identity names its model';
  if (!str(x.requested_model) || !(x.served_model === null || str(x.served_model))) return 'a contributor row states {requested_model, served_model}: the name asked and the name that answered (or null)';
  if (x.served_model_source === null) return 'a contributor row\'s served_model_source is omitted or one of the vocabulary';
  const why = servedSourceRefusal(x);
  if (why) return `a contributor row: ${why}`;
  return [x.requested_model, x.served_model].includes(x.model) ? null : `a contributor row names ${x.model}, which is neither the name it was asked as (${x.requested_model}) nor the name that answered (${x.served_model})`;
}
/** Why a v3 cycle payload's exclusions are not the ones its recorded contributors derive, or null. */
export function v3LineageRefusal(p) {
  for (const x of p.contributors) { const why = contributorIdentityRefusal(x); if (why) return `a ${CYCLE_CONTRACT_V3} cycle's ${why}`; }
  const keys = contributorKeys(p.contributors, p.identity_policy.rules);
  if (keys.unresolved.length) {
    return `a ${CYCLE_CONTRACT_V3} cycle's contributor identity is unresolved (${keys.unresolved.map(u => `${u.vendor ?? '?'}/${u.model ?? '-'}`).join(', ')}): no reviewer can be shown not to be it, so no panel can qualify`;
  }
  if (canonical([...p.author_models].sort()) !== canonical(keys.models)) {
    return `a ${CYCLE_CONTRACT_V3} cycle's author_models (${[...p.author_models].sort().join(', ') || 'none'}) are not the identities its contributors resolve to (${keys.models.join(', ') || 'none'})`;
  }
  const lab = keys.labs.find(l => !p.excluded_labs.includes(l));
  if (lab) return `a ${CYCLE_CONTRACT_V3} cycle's contributors exclude the ${lab} lab (a contribution names no model) and its excluded_labs do not`;
  const authored = [...keys.contributing_labs, ...p.excluded_labs].find(l => !p.author_labs.includes(l));
  if (authored) return `a ${CYCLE_CONTRACT_V3} cycle's author_labs omit ${authored}, a lab its contributors name`;
  return null;
}
/** Why a reviewer seat may not review cycle `c`, or null. `seat` is {vendor, model, served_model?, lab}. */
export function independenceRefusal(c, seat, {answer = false} = {}) {
  if (c.contract !== CYCLE_CONTRACT_V3) return c.author_labs.includes(seat.lab) ? `the ${seat.lab} lab authored the change and may not review it` : null;
  // Two different questions (review/identity.mjs): may this seat be ASKED (only the model asked for is known), and
  // may this ANSWER count (the model that answered must be named and admissible).
  const keys = {models: c.author_models, labs: c.excluded_labs};
  return answer ? reviewerRefusal(seat, keys, c.identity_policy.rules) : candidateRefusal(seat, keys, c.identity_policy.rules);
}
/**
 * The lab a review of cycle `c` counts for: under v3 the reviewer's resolved lab (recorded policy); under the lab rule
 * with a pinned `lab_identity` the lab resolved under it (null when unresolved: it counts for no lab); else labOf.
 */
export function reviewLab(c, {vendor, model, served_model = null}) {
  if (c?.contract !== CYCLE_CONTRACT_V3) return labRuleLab(c, {vendor, model, served_model}).lab ?? null;
  return reviewerIdentity({vendor, model, served_model}, c.identity_policy.rules).lab ?? null;
}
/** The lab a SEAT of cycle `c` is asked as (before any answer): resolved under the cycle's pinned rules when it has them. */
export function seatLab(c, {vendor, model}) {
  if (c?.contract === CYCLE_CONTRACT_V3) return resolveModel(vendor, model, c.identity_policy.rules)?.lab ?? null;
  if (c?.lab_identity) { const who = candidateIdentity({vendor, model}, c.lab_identity.rules); return who.lab ?? null; }
  return labOf(vendor, model);
}
/**
 * Why an ANSWER (asked of `seat`, answered by `answer.served_model`) may not count toward cycle `c`, or null: the same
 * admission the ledger applies to the review and to each of its retrieval rounds (self-audit round 3, assignment 2
 * (sealed 449ca42), L-201). The answer counts for the seat's lab only.
 */
export function answerRefusal(c, seat, answer) {
  const a = {vendor: seat.vendor, model: seat.model, served_model: answer?.served_model ?? null};
  if (c.contract === CYCLE_CONTRACT_V3) {
    const who = reviewerIdentity(a, c.identity_policy.rules);
    if (who.why) return who.why;
    if (who.lab !== seat.lab) return `${seat.vendor}/${seat.model} was asked for the ${seat.lab} lab and the ${who.lab} lab answered`;
    return independenceRefusal(c, {...a, lab: who.lab}, {answer: true});
  }
  const got = labRuleLab(c, a);
  if (got.why) return got.why;
  if (got.lab !== seat.lab) return `${seat.vendor}/${seat.model} was asked for the ${seat.lab} lab and the ${got.lab} lab answered`;
  return c.author_labs.includes(got.lab) ? `the ${got.lab} lab authored the change and answered (${a.served_model ?? a.model})` : null;
}

export const CYCLE = 'cycle', FINDING = 'finding', RESOLUTION = 'finding.resolution', CLOSE = 'cycle.close', ATTEMPT = 'cycle.attempt';
export const ATTEMPT_OUTCOMES = ['reviewed', 'failed'];
export const SEVERITIES = ['block', 'major', 'minor', 'note'];
/** The independent labs a coordinated cycle review requires when its cycle records the requirement (defect 2, 86ce18a). */
export const REQUIRED_REVIEW_LABS = 3;
const requirementRefusal = p => (p.required_reviewers === undefined ? null
  : !Number.isInteger(p.required_reviewers) || p.required_reviewers < REQUIRED_REVIEW_LABS
    ? `a cycle that records its required reviewers requires at least ${REQUIRED_REVIEW_LABS}; a caller cannot lower it`
    : p.reviewers < p.required_reviewers ? `the cycle requires ${p.required_reviewers} independent reviewers and names ${p.reviewers}` : null);
/**
 * A LAB-RULE CYCLE THAT PINS ITS LAB IDENTITY (self-audit round 3, assignment 2 (sealed 449ca42), L-1/L-2/L-204; additive
 * on pantheon.cycle/v2): `lab_identity: {digest, rules}` is the identity policy every lab of the cycle is resolved under
 * (reviewer, answer, retrieval round, attempt seat, lineage), so no lab is taken from a route or a vendor. Such a cycle
 * also records `required_reviewers` (the three-lab floor, enforced here by the kind and not only by the recorder).
 * A cycle without the field (every lab-rule cycle recorded before it) validates, closes and hashes exactly as before.
 */
const labIdentityRefusal = p => (p.lab_identity === undefined ? null
  : SHA.test(p.lab_identity?.digest ?? '') && policyRefusal(p.lab_identity?.rules) === null && policyDigest(p.lab_identity.rules) === p.lab_identity.digest
    ? (Number.isInteger(p.required_reviewers) ? null : 'a cycle that pins its lab identity records required_reviewers (the three-lab floor)')
    : 'a lab-rule cycle\'s lab_identity is {digest, rules}: an identity policy and the digest of those rules');
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
/**
 * The evidence each finding of a reply cites, by finding index (register L-107): its structured `sources` list, and the
 * [source: ...] tag inside its claim. Read from the signed reply; not part of the recorded finding (whose shape is fixed).
 */
export function citedSources(reply) {
  const fenced = /```json\s*([\s\S]*?)```/.exec(reply ?? '');
  const raw = fenced ? fenced[1] : (reply ?? '').slice((reply ?? '').indexOf('{'), (reply ?? '').lastIndexOf('}') + 1);
  let j = null;
  try { j = JSON.parse(raw); } catch { j = null; }
  return (Array.isArray(j?.findings) ? j.findings : []).map(f => {
    const listed = Array.isArray(f?.sources) ? f.sources.filter(str).map(x => x.trim().slice(0, 512)) : [];
    const tag = typeof f?.claim === 'string' ? /\[source:\s*([^\]]+?)\s*\]/.exec(f.claim)?.[1] ?? null : null;
    return [...new Set([...listed, ...(tag ? [tag] : [])])].slice(0, 32);
  });
}
const cites = (view, e, kind) => e.derived_from.filter(h => view.entry(h)?.kind === kind);

/** The cycle a review cites, or null. */
const cycleOfReview = (view, review) => cites(view, view.entry(review), CYCLE)[0] ?? null;

/**
 * Everything the ledger holds for one cycle, as of the view: the cycle, its reviews (with each one's
 * lab and the findings its reply reports), the recorded findings and their resolutions, and its close.
 */
export function deriveCycle(view, cycle) {
  const c = view.payload(cycle);
  const out = {hash: cycle, cycle: c, author_turns: (view.entry(cycle)?.derived_from ?? []).filter(h => view.entry(h)?.kind === 'turn'),
    reviews: [], findings: [], resolutions: new Map(), close: null, attempts: [], dispositions: []};
  const reviews = new Set(), findings = new Set();
  for (const h of view.entries()) {
    const e = view.entry(h);
    if (e.kind === 'review' && e.derived_from.includes(cycle)) {
      const p = view.payload(h);
      const answer = view.payload(p.turn);
      out.reviews.push({hash: h, seat: p.seat, lab: reviewLab(c, {vendor: p.seat.vendor, model: p.model, served_model: p.served_model ?? null}), verdict: p.verdict,
        model: p.model, served_model: p.served_model ?? null, ...(answer?.served_model_source ? {served_model_source: answer.served_model_source} : {}),
        turn: p.turn ?? null, reported: parseReview(answer?.reply ?? ''), cited: citedSources(answer?.reply ?? '')});
      reviews.add(h);
    } else if (e.kind === FINDING && e.derived_from.some(x => reviews.has(x))) {
      out.findings.push({hash: h, review: e.derived_from.find(x => reviews.has(x)), payload: view.payload(h)});
      findings.add(h);
    } else if (e.kind === RESOLUTION && e.derived_from.some(x => findings.has(x))) {
      out.resolutions.set(e.derived_from.find(x => findings.has(x)), {hash: h, payload: view.payload(h)});
    } else if (e.kind === CLOSE && e.derived_from.includes(cycle)) out.close = h;
    else if (e.kind === ATTEMPT && e.derived_from[0] === cycle) out.attempts.push({hash: h, ...view.payload(h)});
    else if (e.kind === PRACTICE && e.derived_from[0] === cycle) out.dispositions.push({hash: h, payload: view.payload(h)});
  }
  return out;
}

/** The close a cycle's entries derive, or {why} when it cannot close yet. */
export function closeClaim(state) {
  const {cycle: c, reviews, findings, resolutions} = state;
  if (reviews.length !== c.reviewers) return {why: `${reviews.length} of ${c.reviewers} reviews are recorded`};
  const labs = reviews.map(r => r.lab);
  if (labs.some(l => !l)) return {why: 'a review of this cycle counts for no resolved lab'};
  if (new Set(labs).size !== labs.length) return {why: 'two reviews of this cycle share a lab'};
  if (c.required_reviewers !== undefined && new Set(labs).size < Math.max(c.required_reviewers, REQUIRED_REVIEW_LABS)) {
    return {why: `the cycle requires ${Math.max(c.required_reviewers, REQUIRED_REVIEW_LABS)} independent labs and ${new Set(labs).size} reviewed`};
  }
  if (c.contract === CYCLE_CONTRACT_V3) {
    for (const r of reviews) { const why = independenceRefusal(c, {vendor: r.seat.vendor, model: r.model, served_model: r.served_model, lab: r.lab}, {answer: true}); if (why) return {why}; }
  } else {
    const authored = labs.find(l => c.author_labs.includes(l));
    if (authored) return {why: `the ${authored} lab authored the change and reviewed it`};
  }
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
  const claim = {outcome: unreproduced ? 'unverified' : 'verified', reviews: reviews.map(r => r.hash).sort(), labs: [...labs].sort(),
    findings: {total: findings.length, fixed, deferred, unreproduced}};
  // The old contract's close is exactly what it was. Under v2 the cycle also carries its practice decision.
  if (!carriesPractice(c.contract)) return {claim};
  // v3: the reviewers that share a lab with a contributor are named in the close (the relationship is on the record).
  if (c.contract === CYCLE_CONTRACT_V3) claim.shared_labs = [...new Set(labs.filter(l => c.author_labs.includes(l)))].sort();
  const dispositions = state.dispositions ?? [];
  if (!dispositions.some(d => d.payload.stage === 'assessment')) {
    return {why: `no practice assessment/disposition is recorded for this cycle (${CYCLE_CONTRACT} requires one; an explicit insufficient_evidence or retain is enough)`};
  }
  return {claim: {...claim, practice: dispositions.map(d => d.hash).sort()}};
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
        ? requirementRefusal(p) ?? (p.contract === undefined ? null
          : carriesPractice(p.contract) && validPolicy(p.policy) && str(p.practice_scope) && (p.prior === null || SHA.test(p.prior ?? ''))
            ? (p.contract !== CYCLE_CONTRACT_V3 ? (p.author_models === undefined && p.excluded_labs === undefined && p.independence === undefined ? labIdentityRefusal(p)
                : `only a ${CYCLE_CONTRACT_V3} cycle names author_models, excluded_labs and independence`)
              : p.independence === 'model' && Array.isArray(p.author_models) && p.author_models.every(str) && Array.isArray(p.excluded_labs) && p.excluded_labs.every(str)
                && Array.isArray(p.contributors) && p.contributors.every(x => x && (x.vendor === null || str(x.vendor)) && (x.model === null || str(x.model)) && (x.lab === undefined || str(x.lab)))
                && SHA.test(p.identity_policy?.digest ?? '') && policyRefusal(p.identity_policy?.rules) === null && policyDigest(p.identity_policy.rules) === p.identity_policy.digest
                && Number.isInteger(p.required_reviewers) && p.lab_identity === undefined ? v3LineageRefusal(p)
                : `a ${CYCLE_CONTRACT_V3} cycle names {independence: "model", author_models, excluded_labs, contributors, identity_policy: {digest, rules}} (the digest is of the rules it carries) and records required_reviewers`)
            : `a ${CYCLE_CONTRACT} cycle also names {policy: {version, hash, profile}, practice_scope, prior}; a cycle without a contract field is the old contract`)
        : 'a cycle names {scope, base, head, diff_sha, files, prompt_sha, brief_sha, reviewers, author_labs, opened_at}'),
      rederive: (e, view) => {
        const p = e.payload;
        if (p.base === p.head) return 'a cycle reviews a change: its base and head differ';
        const v2 = carriesPractice(p.contract);
        if (e.derived_from.some(h => ![CLOSE, 'turn', ...(v2 ? [PRACTICE] : [])].includes(view.entry(h)?.kind))) {
          return v2 ? 'a cycle cites only the author\'s turns, the previous cycle\'s close and the practice decision it loaded'
            : 'a cycle cites only the author\'s turns and the previous cycle\'s close';
        }
        const prev = latestCycle(view, p.scope), closes = cites(view, e, CLOSE);
        if (v2) {
          // The admitted decision it loaded is the one the ledger admits as of this entry, and it is cited.
          const admitted = admittedPractice(view, {scope: p.practice_scope, profile: p.policy.profile})?.disposition ?? null;
          if (p.prior !== admitted) return `the cycle's prior practice decision is ${admitted ?? 'none'} on this ledger, not ${p.prior ?? 'none'}`;
          if (canonical(cites(view, e, PRACTICE)) !== canonical(admitted ? [admitted] : [])) return 'a cycle cites the prior practice decision it loaded, and no other';
        } else if (prev && carriesPractice(view.payload(prev).contract)) {
          return `the previous cycle of this scope opened under ${CYCLE_CONTRACT}: the scope may not return to the old contract`;
        }

        if (!prev) return closes.length ? 'the first cycle of a scope cites no close' : null;
        const close = closedAt(view, prev);
        if (!close) return 'the previous cycle of this scope is not closed';
        if (closes.length !== 1 || closes[0] !== close) return 'a cycle cites the close of the previous cycle of its scope';
        if (view.payload(prev).head !== p.base) return `the base is not where the previous cycle ended (${view.payload(prev).head.slice(0, 12)}): a range would go unreviewed`;
        // VERSIONED, NEVER BACKWARDS (L-204): once a scope recorded the three-lab floor, or a pinned lab identity, a later
        // cycle of that scope records it too. A scope recorded entirely before them verifies as recorded.
        if (view.payload(prev).required_reviewers !== undefined && p.required_reviewers === undefined) return 'the previous cycle of this scope records its required reviewers: a later one may not drop the three-lab floor';
        if (view.payload(prev).lab_identity !== undefined && p.lab_identity === undefined && p.contract !== CYCLE_CONTRACT_V3) return 'the previous cycle of this scope pins its lab identity: a later lab-rule cycle may not drop it';
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
    [ATTEMPT]: {
      authors,
      validate: p => (p?.seat && str(p.seat.vendor) && str(p.seat.model) && str(p.seat.lab) && Number.isInteger(p.attempt) && p.attempt >= 1
        && Number.isInteger(p.max_attempts) && p.max_attempts >= 1 && ATTEMPT_OUTCOMES.includes(p.outcome)
        && (p.outcome === 'failed' ? str(p.why) : p.why === null) && typeof p.resumed === 'boolean' && ISO(p.at)
        ? null : 'an attempt names {seat: {vendor, model, lab}, attempt, max_attempts, outcome, why, resumed, at}'),
      rederive: (e, view) => {
        const p = e.payload, [cycle, review, ...rest] = e.derived_from;
        if (view.entry(cycle)?.kind !== CYCLE || rest.length) return 'an attempt cites its cycle, and the review it produced when it reviewed';
        if (p.outcome === 'reviewed' ? view.entry(review)?.kind !== 'review' : review !== undefined) return 'an attempt cites its cycle, and the review it produced when it reviewed';
        if (closedAt(view, cycle)) return 'the cycle is closed';
        const c = view.payload(cycle);
        const asked = seatLab(c, p.seat);
        if (asked !== p.seat.lab) return `the seat's lab is ${asked ?? 'unresolved'}, not ${p.seat.lab}`;
        const refused = independenceRefusal(c, {vendor: p.seat.vendor, model: p.seat.model, lab: p.seat.lab});
        if (refused) return refused;
        let tried = 0;
        for (const h of view.entries()) {
          const x = view.entry(h);
          if (x?.kind !== ATTEMPT || x.derived_from[0] !== cycle) continue;
          const q = view.payload(h);
          if (q.max_attempts !== p.max_attempts) return `the cycle's attempt limit is ${q.max_attempts}`;
          if (q.seat.lab !== p.seat.lab) continue;
          tried++;
          if (q.outcome === 'reviewed') return `the ${p.seat.lab} lab has already reviewed this cycle`;
        }
        if (p.attempt !== tried + 1) return `this is attempt ${tried + 1} of the ${p.seat.lab} seat, not ${p.attempt}`;
        if (p.attempt > p.max_attempts) return `the ${p.seat.lab} seat has used its ${p.max_attempts} attempt(s)`;
        if (p.outcome === 'reviewed') {
          const r = view.payload(review);
          if (!view.entry(review).derived_from.includes(cycle)) return 'the review is not of this cycle';
          if (r.seat.vendor !== p.seat.vendor || r.model !== p.seat.model) return 'the review is not by the attempting seat';
        }
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

/**
 * Records a cycle's controller entries: open, findings, resolutions, close. Seat entries go through lineageRecorder.
 * `historical: true` writes a cycle in the shape recorded BEFORE the three-lab floor existed (no required_reviewers,
 * any reviewer count): only for reproducing such a ledger (tests, migrations). The recorder a ledger system hands out
 * (system.mjs recorder()) never sets it.
 */
export function cycleRecorder({ledger, controller, order, historical = false}) {
  const by = {author: {key_id: controller.key_id}, signer: controller, order};
  const append = (kind, payload, derivedFrom) => ledger.append({kind, payload, derivedFrom, ...by}).hash;
  /** Where the previous cycle of `scope` ended, and its close, if any (the next cycle's base). */
  const lastCycle = scope => {
    const view = ledgerView(ledger), h = latestCycle(view, scope);
    return h ? {hash: h, head: view.payload(h).head, close: closedAt(view, h)} : null;
  };
  return {
    lastCycle,
    /**
     * Open a cycle. `contract` is CYCLE_CONTRACT by default: the cycle names `policy` (the selection policy
     * in effect, default this code's ARGO policy with no pools) and `practice_scope`, and loads and cites
     * the admitted practice decision (`prior`). CYCLE_CONTRACT_V1 writes the old payload, byte for byte.
     */
    openCycle({scope, base, head, diff, files, prompt, brief = REVIEW_BRIEF, reviewers = 3, author_labs = [], author_turns = [], opened_at = new Date().toISOString(),
      contract = CYCLE_CONTRACT, policy = null, practice_scope = DEFAULT_PRACTICE_SCOPE, required_reviewers = undefined, author_models = undefined, excluded_labs = undefined,
      identity_policy = undefined, contributors = undefined, lab_identity = undefined}) {
      if (![CYCLE_CONTRACT, CYCLE_CONTRACT_V1, CYCLE_CONTRACT_V3].includes(contract)) throw new Error(`openCycle: the contract is ${CYCLE_CONTRACT}, ${CYCLE_CONTRACT_V3} or ${CYCLE_CONTRACT_V1}`);
      // THE FLOOR, ON EVERY NEWLY OPENED CYCLE (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6),
      // question 5): a v2 or v3 cycle opened without required_reviewers records REQUIRED_REVIEW_LABS, so the ledger
      // refuses fewer reviewers at open and fewer labs at close; a v1 cycle keeps its old payload byte for byte, so its
      // floor is enforced here, before it opens. Cycles already on a ledger (written without the field) still verify
      // as recorded: the kind's rules are unchanged, only what a new cycle may be opened with.
      if (!historical) {
        if (contract === CYCLE_CONTRACT_V1) {
          if (!(Number.isInteger(reviewers) && reviewers >= REQUIRED_REVIEW_LABS)) {
            throw Object.assign(new Error(`openCycle: a new cycle requires ${REQUIRED_REVIEW_LABS} independent reviewers and names ${reviewers}`), {code: 'REVIEW_LABS_BELOW_REQUIRED'});
          }
        } else required_reviewers ??= REQUIRED_REVIEW_LABS;
      }
      const prev = lastCycle(scope);
      const payload = {scope, base, head, diff_sha: sha(diff), files: [...files], prompt_sha: promptSha(prompt),
        brief_sha: sha(brief), reviewers, author_labs: [...author_labs], opened_at, ...(required_reviewers !== undefined ? {required_reviewers} : {})};
      if (contract === CYCLE_CONTRACT_V1) return append(CYCLE, payload, [...(prev?.close ? [prev.close] : []), ...author_turns]);
      const inEffect = policy ?? currentPolicy('argo');
      const prior = admittedPractice(ledgerView(ledger), {scope: practice_scope, profile: inEffect.profile})?.disposition ?? null;
      const model = contract === CYCLE_CONTRACT_V3 ? {independence: 'model', author_models: [...(author_models ?? [])].sort(), excluded_labs: [...(excluded_labs ?? [])].sort(),
        // A contribution that names a lab and no model is recorded with its lab, so the excluded lab re-derives from it.
        // A name row keeps the identity of its contribution as review-cycle.mjs contributorRows states it (which name was
        // asked, which answered, the marker): wave 3, L-504 invariant 2. Rows identical in every field are one row.
        contributors: [...new Map((contributors ?? []).map(x => {
          const row = {vendor: x.vendor ?? null, model: x.model ?? null, ...(!x.model && x.lab ? {lab: x.lab} : {}),
            ...(x.model && x.requested_model !== undefined ? {requested_model: x.requested_model ?? null} : {}), ...(x.model && x.served_model !== undefined ? {served_model: x.served_model ?? null} : {}),
            ...(x.model && x.served_model_source ? {served_model_source: x.served_model_source} : {})};
          return [canonical(row), row];
        })).values()],
        // The identity policy travels WITH the cycle: its rules and their digest.
        ...(identity_policy ? {identity_policy: {digest: policyDigest(identity_policy), rules: identity_policy}} : {})} : {};
      // A lab-rule (v2) cycle may pin the identity its labs are resolved under (L-204).
      const labPinned = contract === CYCLE_CONTRACT && lab_identity ? {lab_identity: {digest: policyDigest(lab_identity), rules: lab_identity}} : {};
      return append(CYCLE, {...payload, contract, policy: inEffect, practice_scope, prior, ...model, ...labPinned},
        [...(prev?.close ? [prev.close] : []), ...(prior ? [prior] : []), ...author_turns]);
    },
    recordFinding({review, index, finding}) { return append(FINDING, {index, ...findingOf(normalFinding(finding) ?? finding)}, [review]); },
    fixFinding({finding, commit, test, before, after}) { return append(RESOLUTION, {status: 'fixed', fix: {commit, test, before, after}}, [finding]); },
    deferFinding({finding, reason}) { return append(RESOLUTION, {status: 'deferred', reason}, [finding]); },
    /** One reviewer seat's try at a cycle: `reviewed` (citing its review) or `failed` (with the reason). */
    recordAttempt({cycle, seat, attempt, max_attempts, outcome, why = null, review = null, resumed = false, at = new Date().toISOString()}) {
      return append(ATTEMPT, {seat: {vendor: seat.vendor, model: seat.model, lab: seat.lab}, attempt, max_attempts, outcome,
        why: outcome === 'failed' ? String(why || 'the seat failed') : null, resumed, at}, outcome === 'reviewed' ? [cycle, review] : [cycle]);
    },
    cycleState: cycle => deriveCycle(ledgerView(ledger), cycle),
    /** Close the cycle with the claim its entries derive; throws with the reason when it cannot close. */
    closeCycle(cycle) {
      const derived = closeClaim(deriveCycle(ledgerView(ledger), cycle));
      if (derived.why) throw Object.assign(new Error(`the cycle cannot close: ${derived.why}`), {code: 'CYCLE_OPEN'});
      return {hash: append(CLOSE, derived.claim, [cycle]), ...derived.claim};
    },
  };
}
