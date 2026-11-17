// The real stage executors of the governed lifecycle (scheduler.mjs calls them): plan -> implement -> review ->
// validate -> outcome, each over Pantheon's existing machinery rather than a rebuilt copy of it.
//
//   plan       evaluation and planning. A planner seat (selectSeat role planner) writes a SUBSTANTIVE plan
//              document (ophanim.plan/v1), checked deterministically (a one-line title is refused); the plan is
//              committed on its own ref and reviewed by a coordinated three-lab cycle (reviewCycle) on labs that did
//              not write it; blocking findings are answered by a revision that is re-reviewed. Only an exact,
//              approved plan version writes (or, re-validated, keeps byte-identical) tickets/<item>.json.
//   implement  the approved ticket through runOpenItem (acceptance and in-run review), the shipped bytes committed
//              on pantheon/<item> (commitShipped). Review capacity is checked before any work call.
//   review     the coordinated three-lab cycle review of base..commit (reviewCycle), independent of every recorded
//              contribution (changeScope plus the plan's and the critiques'). n is 3 and is never lowered; a short
//              pool or a failed reviewer is `pending`, the work and the open cycle kept (resumed, never reopened).
//   validate   the plan's acceptance commands and a regression command in a CLEAN checkout of the exact commit, then
//              an independent validator's judgment against the ORIGINAL requirement: accept, implementation_defect
//              (returned to implement) or plan_defect (returned to plan). Green tests alone never pass.
//   outcome    the UNSIGNED status proposal (proposeFromBundle) bound to the item, ticket and reviewed, validated
//              commit. Never signed: the owner applies it.
//
// Inputs: {repo, makeClientFor (the work seats), turn (single-turn seats: planner, reviewers, validator), n = 3,
// statusRoot, stateDir, scouts, revisions, seating (the configured reviewer pool, default Pantheon's), facts (its seat facts;
// tests inject a synthetic pool with both)}. Every stage
// stays within ctx.budget.provider_calls; a failed or refused call is counted. Vendor SDKs stay at the edge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {digest} from '../../packages/ledger/canonical.mjs';
import {boardScopeOf} from '../../packages/ledger/status.mjs';
import {readTicket, readBoard, commitShipped, changeScope, cycleReviewers, seatTeam, proposeFromBundle, BUNDLE_SCHEMA, TICKET_SCHEMA}
  from '../../pantheon/src/board/operate.mjs';
import {runOpenItem, providerCallsOf} from '../../pantheon/src/board/run-item.mjs';
import {certifiedArtifacts} from '../../pantheon/src/board/artifacts.mjs';
import {cidOf} from '../../pantheon/src/board/canon.mjs';
import {openBoard} from '../../pantheon/src/board/index.mjs';
import {ticketRuntimeRefusal, ticketContainmentRefusal, normalizeSlots} from '../../pantheon/src/board/ticket-safety.mjs';
import {reviewCycle, reviewSeats, reviewSeatsByModel} from '../../pantheon/src/ledger/review-cycle.mjs';
import {resolveModel, reviewerRefusal, contributorKeys} from '../../pantheon/src/review/identity.mjs';
import {CYCLE_CONTRACT_V3} from '../../pantheon/src/ledger/practice-kinds.mjs';
import {REVIEW_BRIEF} from '../../pantheon/src/ledger/cycle-kinds.mjs';
import {openPantheonLedger} from '../../pantheon/src/ledger/system.mjs';
import {selectSeat, readPools} from '../../pantheon/src/route/frontier.mjs';
import {taskProfile} from '../../pantheon/src/route/task-profile.mjs';
import {labOf} from '../../pantheon/src/config/models.mjs';
import {bytesOfRepo} from './reconcile.mjs';
import {buildDossier, renderDossier, makeRetriever, investigate, deliveryOf, gapsOf, refOf, RETRIEVAL_HELP, DEFAULT_INVESTIGATION} from './context.mjs';

export const PLAN_SCHEMA = 'ophanim.plan/v1';
export const VERDICTS = Object.freeze(['accept', 'implementation_defect', 'plan_defect', 'diagnosis_defect', 'missing_evidence']);
// Where a non-accepting validation goes, and the cause recorded with it (the causes are kept apart, never merged).
export const VERDICT_ROUTE = Object.freeze({
  implementation_defect: {stage: 'implement', cause: 'implementation-defect'},
  plan_defect: {stage: 'plan', cause: 'inadequate-plan'},
  diagnosis_defect: {stage: 'plan', cause: 'incorrect-diagnosis'},
  missing_evidence: {stage: 'plan', cause: 'missing-evidence'},
});
export const QUESTIONS = Object.freeze({
  historical_cause: 'Where did the behaviour originate? Separate symptom, trigger and proposed mechanism; consider alternatives; chronology alone is not causation.',
  operational_position: 'Where does it sit in operation: what supplies it, consumes it or constrains it (dependencies, contracts, shared state, limits)?',
  change_impact: 'What would the change affect directly or indirectly; which assumptions, interfaces, plans or qualifications could it invalidate; recovery and reversibility?',
  success_adequacy: 'Do the acceptance criteria cover the original requirement and the consequences found above, including retries, partial completion, restarts and later revisions?',
});
const COORDINATED_LABS = 3;            // the coordinated review's lab count: a floor, never lowered by a caller
const PLANNER_TRIES = 3;               // planner answers per plan version (a refused shape is retried within budget)
const PLAN_VERSIONS = 3;               // plan versions per stage attempt (review findings -> revision -> re-review)
const BLOCKING = new Set(['block', 'major']);
const ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const SLOT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const str = (v, min = 1) => typeof v === 'string' && v.trim().length >= min;
const strs = (v, min = 1) => Array.isArray(v) && v.length >= min && v.every(x => str(x));
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
const git = top => (args, opts = {}) => execFileSync('git', ['-C', top, ...args], {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts});
const seatOf = s => ({vendor: s.vendor, model: s.model, lab: s.lab ?? labOf(s.vendor, s.model)});

export const PLAN_BRIEF = [
  'You are an independent reviewer of a PLAN for one work item of this repository. You did not write it.',
  'Judge the plan document below against the original requirement it quotes: is the problem justified by the cited',
  'evidence, is the scope right and bounded, are the exclusions and dependencies honest, does every acceptance',
  'criterion test the requirement (and would its command fail on a wrong implementation), are the slices, limits,',
  'stopping conditions, recovery and rollback adequate. A plan that is a title, or whose tests are vacuous, is defective.',
  'Challenge the DIAGNOSIS (is the stated cause supported, or only plausible; what else would explain it), the EVIDENCE',
  'SELECTION (what was dismissed or never looked at; does older or contradictory evidence change it), OMISSIONS (consumers,',
  'dependencies, earlier attempts) and the COMPLETENESS of the success criteria (the requirement and every consequence found).',
  'You have your own access to the evidence: the dossier below and retrieval. Do not rely on the planner\'s account of it.',
  'A citation is not support: check that a cited source says what the plan claims. "file" is a path in the diff or null (the cycle ledger',
  'accepts no other); name the evidence a finding rests on inside its claim, as [source: <path or ref>].',
  'Answer with ONE JSON object and nothing else, in a ```json block:',
  '{"verdict": "approve" | "request_changes",',
  ' "findings": [{"severity": "block" | "major" | "minor" | "note", "file": "<path in the diff> or null",',
  '   "line": <number> or null, "claim": "<what is wrong>",',
  '   "reproduction": {"kind": "command" | "test", "run": "<command or test name>"} or null}]}',
].join('\n');

// --- bounded provider calls ------------------------------------------------------------------------------------
/** A metered `turn`: every call (failed ones included) counts; a call past the limit is refused, not made. */
function meter(turn, limit) {
  const m = {made: 0, refused: 0, limit};
  m.turn = args => {
    if (m.made >= m.limit) { m.refused++; return Promise.reject(Object.assign(new Error(`PROVIDER_CALL_LIMIT: ${m.made} of ${m.limit} stage provider call(s) used`), {code: 'PROVIDER_CALL_LIMIT'})); }
    m.made++;
    return Promise.resolve().then(() => turn(args));
  };
  m.left = () => m.limit - m.made;
  return m;
}
const jsonOf = text => {
  const fenced = /```json\s*([\s\S]*?)```/.exec(text ?? '');
  const raw = fenced ? fenced[1] : (text ?? '').slice((text ?? '').indexOf('{'), (text ?? '').lastIndexOf('}') + 1);
  try { const j = JSON.parse(raw); return plain(j) ? j : null; } catch { return null; }
};

// --- the plan document -----------------------------------------------------------------------------------------
/**
 * Why the planner's answer is not a plan (a list; empty when it is one). Deterministic: shape, substance and
 * consistency with the repository, the requirement's dependencies, the mode and the ticket it would write.
 */
export function planRefusal(j, {shown = [], delivered = null, depends_on = [], mode = 'author', ticket = null, findings = [], repo = null, item = null} = {}) {
  if (!plain(j)) return ['the answer is not one JSON plan object (a title or prose is not a plan)'];
  const why = [];
  // What the planner was actually given (dossier entries and retrieved records). A citation of anything else is refused.
  const given = delivered ?? new Map(shown.map(f => [`file:${f}`, {via: 'supplied'}]));
  const has = r => typeof r === 'string' && given.has(refOf(r));
  if (!plain(j.problem) || !str(j.problem.statement, 30) || !str(j.problem.justification, 30)) why.push('problem names a statement and its justification from the evidence (each at least a sentence)');
  if (!strs(j.scope)) why.push('scope lists what the change covers');
  if (!strs(j.exclusions)) why.push('exclusions lists what it does not cover');
  if (!Array.isArray(j.dependencies) || !j.dependencies.every(d => str(d))) why.push('dependencies is a list (empty when there are none)');
  else for (const d of depends_on) if (!j.dependencies.includes(d)) why.push(`dependency ${d} of the requirement is not in the plan's dependencies`);
  if (!strs(j.capabilities)) why.push('capabilities lists what the work requires');
  const acc = Array.isArray(j.acceptance) ? j.acceptance : [];
  if (!acc.length || !acc.every(a => plain(a) && str(a.id) && str(a.criterion, 10) && plain(a.test) && str(a.test.cmd))) why.push('acceptance lists criteria {id, criterion, test: {cmd}}, each tested by a command');
  else if (new Set(acc.map(a => a.id)).size !== acc.length) why.push('acceptance criterion ids are unique');
  if (j.regression !== null && j.regression !== undefined && !(plain(j.regression) && str(j.regression.cmd))) why.push('regression is {cmd} or null');
  const slices = Array.isArray(j.slices) ? j.slices : [];
  if (!slices.length || !slices.every(s => plain(s) && str(s.id) && str(s.title) && SLOT.test(s.slot ?? '') && str(s.path))) why.push('slices lists the work {id, title, slot, path}');
  else if (new Set(slices.map(s => s.path)).size !== slices.length) why.push('two slices write the same path');
  if (!Array.isArray(j.copy) || !j.copy.every(c => str(c))) why.push('copy lists the repository files the work reads');
  else if (repo) for (const c of j.copy) if (!fs.existsSync(path.join(repo, c))) why.push(`copy names ${c}, which is not in the repository`);
  if (!plain(j.proposes) || !['Resolved', 'Ready', 'In progress'].includes(j.proposes.state) || !str(j.proposes.basis)) why.push('proposes names {state: Resolved | Ready | In progress, basis}');
  const L = j.limits;
  if (!plain(L) || !(Number.isInteger(L.provider_calls) && L.provider_calls > 0) || !(Number.isInteger(L.revisions) && L.revisions >= 1 && L.revisions <= 5)
    || !(Number.isInteger(L.elapsed_ms) && L.elapsed_ms > 0)) why.push('limits names {provider_calls > 0, revisions 1..5, elapsed_ms > 0}');
  if (!strs(j.stopping)) why.push('stopping lists the conditions on which the work stops');
  if (!str(j.recovery, 10)) why.push('recovery says how an interrupted or failed slice is recovered');
  if (!str(j.rollback, 10)) why.push('rollback says how the change is undone');
  if (!Array.isArray(j.unresolved) || !j.unresolved.every(u => str(u))) why.push('unresolved lists open findings (empty when none)');
  const ev = Array.isArray(j.evidence) ? j.evidence : [];
  if (!ev.length || !ev.every(e => plain(e) && str(e.ref ?? e.path) && str(e.why))) why.push('evidence lists the sources relied on [{ref: <dossier id, source or path>, why}]');
  else for (const e of ev) if (!has(e.ref ?? e.path)) why.push(`evidence ${e.ref ?? e.path} was never delivered to the planner (not in the dossier and not retrieved): retrieve it or drop it`);
  // Sufficiency: a plan is given only when the planner judges the evidence enough; what stays uncertain is recorded.
  const cx = j.context;
  if (!plain(cx) || cx.sufficient !== true || !Array.isArray(cx.gaps) || !Array.isArray(cx.uncertainty)) {
    why.push('context states {sufficient: true, gaps: [..], uncertainty: [..]}; when the evidence does not support a plan, answer {"insufficient": {gaps, needed}} instead of a plan');
  }
  // The four questions guide the investigation; none is forced. One examined names its finding and delivered sources;
  // one not examined says why it did not need it.
  const inv = j.investigation;
  if (!plain(inv)) why.push(`investigation answers ${Object.keys(QUESTIONS).join(', ')}: each {examined: true, finding, sources: [..]} or {examined: false, why}`);
  else for (const q of Object.keys(QUESTIONS)) {
    const a = inv[q];
    if (!plain(a) || typeof a.examined !== 'boolean') why.push(`investigation.${q} is {examined: true, finding, sources} or {examined: false, why}`);
    else if (!a.examined) { if (!str(a.why, 10)) why.push(`investigation.${q} was not examined: say why it did not need to be`); }
    else if (!str(a.finding, 10) || !strs(a.sources)) why.push(`investigation.${q} names its finding and the sources it rests on`);
    else for (const src of a.sources) if (!has(src)) why.push(`investigation.${q} cites ${src}, which was never delivered to the planner: retrieve it or drop the claim`);
  }
  if (j.relevance !== undefined) {
    if (!Array.isArray(j.relevance) || !j.relevance.every(r => plain(r) && str(r.ref) && ['used', 'dismissed'].includes(r.decision) && str(r.why))) why.push('relevance lists consequential decisions [{ref, decision: used | dismissed, why}]');
    else for (const r of j.relevance) if (!has(r.ref)) why.push(`relevance names ${r.ref}, which was never delivered to the planner`);
  }
  if (j.difficulty !== undefined && !['easy', 'medium', 'hard'].includes(j.difficulty)) why.push('difficulty is easy, medium or hard');
  if (mode === 'revalidate') {
    const a = j.ticket_assessment;
    if (!plain(a) || typeof a.still_valid !== 'boolean' || !strs(a.reasons)) why.push('a re-validation states ticket_assessment {still_valid, reasons}');
    else if (a.still_valid && ticket && !acc.some(x => x.test?.cmd === ticket.acceptance_cmd)) why.push('a plan that keeps the ticket tests the ticket\'s acceptance command');
  }
  if (findings.length) {
    const answered = new Set((Array.isArray(j.answers) ? j.answers : []).filter(a => plain(a) && str(a.finding) && str(a.response)).map(a => a.finding));
    for (const f of findings) if (!answered.has(f.id)) why.push(`finding ${f.id} is not answered (answers: [{finding, response}])`);
  }
  if (!why.length && repo && item && !(mode === 'revalidate' && j.ticket_assessment.still_valid)) {
    const t = ticketOf({plan: j, item, requirement: {title: 'x', basis: 'x'}});
    const spec = {...t, key: item, repo_root: path.resolve(repo)};
    let refused = null;
    try { refused = ticketRuntimeRefusal(spec) ?? ticketContainmentRefusal(spec); normalizeSlots(spec); taskProfile(t); } catch (e) { refused = e.message; }
    if (refused) why.push(`the ticket the plan derives is refused: ${refused}`);
  }
  return why;
}

/** The ticket (ophanim.ticket/v1) an approved plan derives: its slices, files, acceptance and proposed state. */
export function ticketOf({plan, item, requirement}) {
  const slices = plan.slices;
  const cmds = [...new Set(plan.acceptance.map(a => a.test.cmd))];
  return {schema: TICKET_SCHEMA, item, slice: slices.map(s => s.title).join('; '), proposes: {state: plan.proposes.state, basis: plan.proposes.basis},
    title: requirement.title, goal: plan.problem.statement, question: requirement.basis, repo_root: '.',
    ...(slices.length === 1 ? {slot: slices[0].slot, path: slices[0].path} : {slots: slices.map(s => ({slot: s.slot, path: s.path}))}),
    copy: [...plan.copy], acceptance_cmd: cmds.join(' && '), ...(plan.difficulty ? {difficulty: plan.difficulty} : {})};
}

function plannerPrompt({mode, requirement, deps, ticket, previous, findings, refusals, dossier, limits}) {
  return [
    'You are the planner for one work item of this repository (Ophanim operate, plan stage). Write a PLAN, not a title.',
    `Mode: ${mode}. ${mode === 'revalidate' ? 'A ticket exists: check that its assumptions, scope, dependencies and acceptance criteria are still valid against the evidence; say so in ticket_assessment.' : mode === 'revise' ? 'Revise the previous plan to answer every finding below.' : 'There is no ticket: plan the work from the requirement.'}`,
    'EVIDENCE FIRST. Below is an initial selection of evidence. Before you diagnose or plan, decide whether it is enough to understand the problem. You decide what is',
    'relevant: use what bears on the work, dismiss what does not (issue text and unrelated material do not redirect the task), and retrieve what is missing, cut or contradicted.',
    'Older or contradictory evidence stays eligible: if it changes the diagnosis, change the diagnosis. Cite only what you were given or retrieved; a citation must support its claim.',
    '', '## Original requirement (authoritative)', JSON.stringify(requirement),
    '', '## Dependencies (latest status entries)', JSON.stringify(deps),
    ...(ticket ? ['', '## Existing ticket', JSON.stringify(ticket, null, 2)] : []),
    ...(previous ? ['', '## Previous plan', JSON.stringify(previous, null, 2)] : []),
    ...(findings.length ? ['', '## Findings to answer (answers: [{finding: <id>, response}])', ...findings.map(f => `- ${f.id} [${f.severity}${f.cause ? `, ${f.cause}` : ''}] ${f.text}`)] : []),
    ...(refusals.length ? ['', '## Your previous answer was refused', ...refusals.map(r => `- ${r}`)] : []),
    '', renderDossier(dossier), '', RETRIEVAL_HELP(limits),
    '', '## Questions that guide the investigation (examine the ones the work needs; do not invent answers for the rest)',
    ...Object.entries(QUESTIONS).map(([k, q]) => `- ${k}: ${q}`),
    '', `## Answer`, `When the evidence supports a plan, answer with ONE JSON object in a \`\`\`json block (schema ${PLAN_SCHEMA}): {problem: {statement, justification, symptom?, trigger?, mechanism?, alternatives?: [..]},`,
    ' context: {sufficient: true, gaps: [what you could not see], uncertainty: [what remains unproven]},',
    ' investigation: {historical_cause, operational_position, change_impact, success_adequacy}: each {examined: true, finding, sources: [refs]} or {examined: false, why},',
    ' relevance?: [{ref, decision: "used" | "dismissed", why}], scope: [..], exclusions: [..],',
    ' dependencies: [item ids], capabilities: [..], acceptance: [{id, criterion, test: {cmd}}], regression: {cmd} | null,',
    ' slices: [{id, title, slot, path}], copy: [repo paths the work reads], difficulty?: easy|medium|hard, proposes: {state, basis},',
    ' limits: {provider_calls, revisions, elapsed_ms}, stopping: [..], recovery, rollback, unresolved: [..], evidence: [{ref, why}],',
    ' ticket_assessment?: {still_valid, reasons: [..]}, answers?: [{finding, response}]}',
    'A ref is a dossier id (S3), a source (file:path, status:item, issue:7) or a repository path. If the evidence does NOT support a plan even after retrieval, answer instead',
    'with {"insufficient": {"gaps": [what is missing], "needed": [what would settle it]}}: the item waits with your findings kept; do not guess.',
  ].join('\n');
}

/** What the implementer must keep from the reviewed plan: the rationale, the constraints and where they come from. */
export function carryForward(doc, digestOfPlan) {
  const inv = doc.investigation ?? {};
  const q = k => (inv[k]?.examined ? [`${k.replace(/_/g, ' ')}: ${inv[k].finding} (sources: ${inv[k].sources.join(', ')})`] : []);
  return [`From the reviewed plan ${String(digestOfPlan).slice(0, 19)} (v${doc.version?.n ?? '?'}). Problem: ${doc.problem.statement} Because: ${doc.problem.justification}`,
    ...doc.exclusions.map(x => `Out of scope: ${x}`),
    ...q('operational_position'), ...q('change_impact'), ...q('historical_cause'),
    ...doc.acceptance.map(a => `Acceptance ${a.id}: ${a.criterion} (tested by: ${a.test.cmd})`),
    ...(doc.context?.uncertainty ?? []).map(u => `Unproven, do not rely on it: ${u}`),
    ...(doc.unresolved ?? []).map(u => `Unresolved finding carried with the plan: ${u}`),
    'If what you find contradicts this plan, do not work around it: say so; the item returns to planning.'];
}

// --- shared helpers ----------------------------------------------------------------------------------------
/** The passed stage records this stage rests on, by handoff, newest first: {plan, implement, review, validate}. */
function chainOf(work, rec) {
  const out = {};
  for (let r = rec; r; r = r.handoff?.from ? work.stages(r.identity.item).find(s => s.hash === r.handoff.from) : null) out[r.stage] ??= r;
  return out;
}
const dedupe = rows => [...new Map(rows.map(r => [`${r.purpose}|${r.vendor}|${r.model}|${r.lab}`, r])).values()];
const labsOfContribs = rows => [...new Set(rows.map(r => r.lab).filter(Boolean))].sort();
/** The change scope plus every other recorded contribution: never narrowed to make a panel possible. */
function fullScope(base, contributions) {
  const all = dedupe([...(base?.contributions ?? []), ...contributions]);
  return {...(base ?? {kind: 'change'}), contributions: all, author_labs: labsOfContribs(all)};
}
const pendingCapacity = (why, extra = {}) => ({what: `REVIEW_CAPACITY_PENDING: ${why}`, role: 'check@review', resume_when: 'a reviewer lab outside the contributors becomes available', ...extra});
const result = (status, rest) => ({status, outputs: {}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, ...rest});

/** Record the practice assessment a v2 cycle needs (explicit, unmeasured), then close it; {close, outcome} or {why}. */
function closeWith(rec, cycle, question) {
  const state = rec.cycleState(cycle);
  if (state.close) {
    const p = rec.ledger.payloadOf(rec.ledger.read().find(e => rec.ledger.hashOf(e) === state.close));
    return {close: state.close, outcome: p.outcome, labs: p.labs};
  }
  if (state.cycle.contract && !state.dispositions.some(d => d.payload.stage === 'assessment')) {
    try {
      rec.recordDisposition({cycle, outcome: 'insufficient_evidence', question, evidence: [], measured: false,
        provenance: {by: {role: 'controller'}, method: 'operate stage: no practice comparison is run here; recorded explicitly as insufficient evidence (unmeasured, provisional)'}});
    } catch (e) { return {why: e.message}; }
  }
  try { const c = rec.closeCycle(cycle); return {close: c.hash, outcome: c.outcome, labs: c.labs}; }
  catch (e) { if (e.code !== 'CYCLE_OPEN') throw e; return {why: e.message}; }
}
const findingRows = (state, {only = null} = {}) => state.findings.filter(f => !only || only(f)).map(f => {
  const r = state.reviews.find(x => x.hash === f.review);
  return {id: f.hash, severity: f.payload.severity, text: `${f.payload.file ?? '-'}${f.payload.line ? `:${f.payload.line}` : ''} ${f.payload.claim}`,
    // The evidence the finding rests on: the reviewer's [source: ...] tag in the claim, else the file it names.
    file: /\[source:\s*([^\]]+?)\s*\]/.exec(f.payload.claim)?.[1] ?? f.payload.file ?? null, vendor: r?.seat.vendor ?? null, model: r?.model ?? null,
    ...(r?.served_model && r.served_model !== r.model ? {served_model: r.served_model} : {}), lab: r?.lab ?? null};
});
/**
 * Why an author may have got something wrong, as far as the record can tell (docs/context-and-evidence.md):
 * the source a finding is about never reached the author; it reached the author and was dismissed; or it reached the
 * author and the record cannot separate a misreading from an unsupported inference. Never a guess beyond that.
 */
export function causeOf(file, delivered, doc = null) {
  if (!file) return {cause: 'undetermined', why: 'the finding names no source'};
  const ref = refOf(file), got = delivered.get(ref);
  if (!got) return {cause: 'evidence-not-delivered', why: `${ref} never reached the author (not supplied, not retrieved)`};
  if (!got.complete) return {cause: 'evidence-partly-delivered', why: `${got.source} (version ${String(got.version).slice(0, 19)}) reached the author only in part: bytes ${got.portions.map(p => p.join('-')).join(', ')} of ${got.total}`};
  const dismissed = (doc?.relevance ?? []).find(r => refOf(r.ref) === ref && r.decision === 'dismissed');
  if (dismissed) return {cause: 'evidence-dismissed', why: `the author was given ${ref} and dismissed it: ${dismissed.why}`};
  return {cause: 'evidence-delivered', why: `${ref} reached the author in full: a misreading or an unsupported inference (the record cannot separate them)`};
}
const runPolicy = run => {
  const s = (run?.turns ?? []).map(t => t.selection).find(x => x?.policy && x?.policy_hash && x?.profile);
  return s ? {version: s.policy, hash: s.policy_hash, profile: s.profile} : undefined;
};

// REVIEW INDEPENDENCE in force for the lifecycle. 'lab' (the rule every recorded cycle was opened under): no reviewer
// from a lab that contributed. 'model' (pantheon.cycle/v3; owner direction 2026-11-17): no reviewer that IS a contributing
// model, three distinct labs still required, a shared lab recorded. 'model' is implemented and tested but NOT ACTIVE:
// it is switched on here, by the owner, after the independent review of the rule change (docs/review-independence.md).
// The service and the CLI take no option for it.
export const REVIEW_INDEPENDENCE = 'lab';
/**
 * The contributions a run made to the change, as later stages carry them. A turn that asked for one model and was
 * served by another keeps BOTH names (`requested_model`): under model-level independence each is a contributor.
 */
export const workContributions = run => changeScope(run).contributions.map(c => ({purpose: c.purpose, vendor: c.vendor, model: c.model,
  ...(c.requested_model ? {requested_model: c.requested_model} : {}), lab: c.lab, via: c.via}));
const withServed = f => (f.served_model && f.served_model !== f.model ? {served_model: f.served_model} : {});

// --- the executors -------------------------------------------------------------------------------------------
export function makeExecutors({repo, makeClientFor, turn, n = COORDINATED_LABS, statusRoot = null, stateDir = null, scouts = ['xai'], revisions = undefined,
  seating = undefined, facts = undefined, profile = 'argo', checked = null, progress = () => {}, investigation = {}, bundlesDir = null, independence = REVIEW_INDEPENDENCE} = {}) {
  if (!repo) throw new Error('makeExecutors: pass the repository');
  if (typeof turn !== 'function') throw new Error('makeExecutors: pass turn({vendor, model, prompt, seat}) for the planner, reviewers and validator');
  if (typeof makeClientFor !== 'function') throw new Error('makeExecutors: pass makeClientFor(vendor) for the work seats');
  // The coordinated review is three labs. A caller may not lower it (and a higher n is the caller's stricter choice).
  if (!(Number.isInteger(n) && n >= COORDINATED_LABS)) throw Object.assign(new Error(`the coordinated review needs ${COORDINATED_LABS} labs; n = ${n} would lower it`), {code: 'REVIEW_FLOOR'});
  const statusAt = statusRoot ?? path.join(repo, 'status', 'ledger');
  const dirOf = (ctx, ...p) => { const d = path.join(stateDir ?? path.join(path.dirname(ctx.work.root), 'operate'), ctx.item, ...p); fs.mkdirSync(d, {recursive: true}); return d; };
  if (!['lab', 'model'].includes(independence)) throw new Error(`makeExecutors: independence is "lab" or "model", got ${independence}`);
  const byModel = independence === 'model';
  const pool = {...(seating ? {seating} : {}), ...(facts ? {facts} : {})};
  /** A panel of `k` distinct labs for work with these contributions, under the independence in force. Throws NO_SEATS. */
  const panel = (contributions, k = n) => (byModel ? reviewSeatsByModel({n: k, contributions, ...pool}) : reviewSeats({n: k, avoidLabs: labsOfContribs(contributions), ...pool}));
  /** What a cycle's `change` carries so the ledger opens it under the matching contract. */
  const independenceOf = contributions => (byModel ? {independence: 'model', contributions} : {});
  const reviewerRow = (role, s) => ({role, ...seatOf(s), ...(s.shared_lab ? {shared_lab: true, shared_with: s.shared_with} : {})});
  const today = () => checked ?? new Date().toISOString().slice(0, 10);
  // Evidence for every judging seat (context.mjs): the dossier of the item, and bounded read-only retrieval.
  const INV = {...DEFAULT_INVESTIGATION, ...investigation};
  const evidenceFor = (ctx, extra = {}) => {
    const dossier = buildDossier({repo, statusRoot: statusAt, item: ctx.item, work: ctx.work, issues: ctx.issues ?? null, bundlesDir: ctx.bundlesDir ?? bundlesDir, limits: INV});
    return {dossier, retriever: makeRetriever({repo, statusRoot: statusAt, work: ctx.work, issues: ctx.issues ?? null, limits: INV, ...extra})};
  };
  const dossierRecord = d => ({digest: d.digest, stable: d.stable, head: d.head, entries: d.entries.map(e => ({id: e.id, kind: e.kind, source: e.source, version: e.version, complete: e.coverage?.complete !== false})), omissions: d.omissions});
  /**
   * A `turn` for a review cycle whose seats may retrieve before they answer. The cycle's prompt is the first prompt
   * each seat is given; the retrieval rounds are logged here (the cycle ledger records the review itself).
   */
  const investigatingTurn = (m, retriever, logs, role, reserve = 0) => async ({vendor, model, prompt, seat}) => {
    const r = await investigate({prompt, retriever, canAsk: () => m.left() > reserve, ask: p => m.turn({vendor, model, prompt: p, seat})});
    logs.push({role, vendor, model, lab: seat?.lab ?? labOf(vendor, model), ...r.log, unresolved: gapsOf(deliveryOf(logs.dossier, r.log))});
    if (!r.reply) throw new Error(`no review within the investigation bounds (${r.log.limit_reached})`);
    return r.reply;
  };
  /** A cycle's brief is bound when the cycle opens: a resumed cycle is given the same bytes, not a rebuilt dossier. */
  const boundBrief = (ctx, key, make) => {
    const f = path.join(dirOf(ctx, 'briefs'), `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.txt`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, make());
    return fs.readFileSync(f, 'utf8');
  };

  // ---- plan ----
  async function plan(ctx) {
    const t0 = Date.now(), item = ctx.item, gate = ctx.gate, mode = gate.mode ?? 'author';
    const m = meter(turn, ctx.budget.provider_calls);
    const board = readBoard({statusRoot: statusAt});
    const status = board.items.find(i => i.item === item);
    const deps = Object.fromEntries((status?.depends_on ?? []).map(d => [d, board.items.find(i => i.item === d)?.entry ?? null]));
    const existing = fs.existsSync(path.join(repo, 'tickets', `${item}.json`)) ? readTicket({repo, item}) : null;
    const ticket = existing && !existing.why ? existing : null;
    const prevRec = [...ctx.work.stages(item)].reverse().find(s => s.stage === 'plan' && s.status === 'passed') ?? null;
    const previous = prevRec?.outputs.plan ?? null;
    // The planner seat: the policy's first planner, chosen on its own merits. It is NOT moved into the implementer's
    // lab to leave the coordinated review its pool (owner direction 2026-11-17: never force planner and implementer
    // onto one lab to manufacture reviewer availability); a short pool later is a recorded capacity pending.
    const pick = selectSeat('planner', {profile, needsContext: 1, pools: readPools()}).seat;
    const planner = {...seatOf(pick), selection: {source: pick.selection?.source ?? null, reason: pick.selection?.reason ?? 'the policy\'s first planner candidate'}};
    const team = [{role: 'planner', ...seatOf(planner)}];
    // Review capacity BEFORE work: the plan needs n reviewer labs outside the planner's.
    // Independence follows contributions (review/scope.mjs): a revision consumes the plan it revises and the findings
    // it answers, so the labs behind those may not review it. A revised plan keeps the lineage of what it revises.
    const inherited = mode === 'revise' ? [...(prevRec?.contributions ?? []).filter(c => c.purpose !== 'plan'),
      ...(gate.findings ?? []).filter(f => f.lab).map(f => ({purpose: 'critique', vendor: f.vendor ?? null, model: f.model ?? null, ...withServed(f), lab: f.lab, via: `finding ${String(f.id).slice(0, 19)} returned to planning reached the revised plan`}))] : [];
    let planSeats;
    try { planSeats = panel([{purpose: 'plan', ...seatOf(planner)}, ...inherited]); } catch (e) {
      if (e.code !== 'NO_SEATS') throw e;
      return result('pending', {outputs: {mode, planner: seatOf(planner), stage: 'before-work'}, team, usage: {provider_calls: 0, elapsed_ms: Date.now() - t0},
        blocker: pendingCapacity(`the configured reviewer pool offers fewer than ${n} labs outside the planner's (${planner.lab}); nothing was planned`, {stage: 'plan'}),
        next: {stage: 'plan', why: 'plan review capacity is short'}});
    }
    const {dossier, retriever} = evidenceFor(ctx);
    const investigations = Object.assign([], {dossier});
    // What the planner was given only in part stays an unresolved gap on the record, with the request that continues it.
    const plannerGot = () => deliveryOf(dossier, {requests: investigations.filter(x => x.role === 'planner').flatMap(x => x.requests)});
    const ctxOut = () => ({dossier: dossierRecord(dossier), investigations: [...investigations], unresolved: gapsOf(plannerGot())});
    const sys = openPantheonLedger({root: dirOf(ctx, 'plan-ledger')});
    const rec = sys.recorder();
    const top = git(repo)(['rev-parse', '--show-toplevel']).trim();
    const G = git(top);
    const scope = `plan/${item}`, file = `plans/${item}.json`;
    const refused = [], versions = [], contributions = dedupe([{purpose: 'plan', ...seatOf(planner), via: 'the planner wrote the plan the ticket derives from'}, ...inherited]);
    let findings = mode === 'revise' ? (gate.findings ?? []).map(f => ({id: f.id, severity: f.severity, text: f.text, lab: f.lab ?? null})) : [];
    let prevDoc = mode === 'revise' ? previous : null, prevDigest = prevDoc ? 'sha256:' + digest(prevDoc) : null;
    const usage = () => ({provider_calls: m.made, elapsed_ms: Date.now() - t0});
    const stop = (why, extra = {}) => result('failed', {outputs: {mode, refused, versions, context: ctxOut(), ...extra}, team, contributions, usage: usage(), next: {stage: 'plan', why}});

    // An open plan cycle (a reviewer was unavailable) is resumed with its plan version, never re-planned or reopened.
    const open = rec.lastCycle(scope);
    let resume = null;
    if (open && !open.close) {
      const st = rec.cycleState(open.hash);
      resume = {doc: JSON.parse(G(['show', `${st.cycle.head}:${file}`])), base: st.cycle.base, head: st.cycle.head, author_turns: st.author_turns, author_labs: st.cycle.author_labs};
      // The open cycle's own contract says who may finish it.
      planSeats = st.cycle.contract === CYCLE_CONTRACT_V3
        ? reviewSeatsByModel({n, excluded: {models: st.cycle.author_models, labs: st.cycle.excluded_labs, contributing_labs: st.cycle.author_labs}, policy: st.cycle.identity_policy.rules, ...pool})
        : reviewSeats({n, avoidLabs: st.cycle.author_labs, ...pool});
    }
    for (let v = 1; v <= PLAN_VERSIONS; v++) {
      // 1. The planner writes the plan; a malformed answer is refused and retried within budget.
      let doc = resume?.doc ?? null, turnHash = null;
      if (resume && m.left() < n) return stop(`stage budget: ${m.left()} provider call(s) left, the plan review needs up to ${n}`);
      for (let k = 0; k < PLANNER_TRIES && !doc; k++) {
        if (m.left() < 1 + n) return stop(`stage budget: ${m.left()} provider call(s) left, a plan and its review need ${1 + n}`);
        const first = plannerPrompt({mode, requirement: gate.requirement, deps, ticket: ticket?.ticket ?? null, previous: prevDoc, findings,
          refusals: refused.filter(r => r.version === v).flatMap(r => r.why), dossier, limits: INV});
        let reply, prompt = first, inv = null;
        try {
          // The planner investigates before it answers: each retrieval round is a counted call, and the review's calls are kept in reserve.
          const r = await investigate({prompt: first, retriever, canAsk: () => m.left() > n + 1, ask: p => m.turn({vendor: planner.vendor, model: planner.model, prompt: p, seat: {...planner, role: 'planner'}})});
          reply = r.reply; prompt = r.prompt; inv = r.log;
          investigations.push({role: 'planner', ...seatOf(planner), version: v, try: k + 1, ...r.log, unresolved: gapsOf(deliveryOf(dossier, r.log))});
          // The model that actually answered is a contributor too, when it is not the one asked for.
          if (reply?.served_model && reply.served_model !== planner.model && !contributions.some(c => c.purpose === 'plan' && c.model === reply.served_model)) {
            contributions.push({purpose: 'plan', vendor: planner.vendor, model: reply.served_model, lab: labOf(planner.vendor, reply.served_model), via: 'served the planner\'s turn'});
          }
        } catch (e) { refused.push({version: v, try: k + 1, why: [`the planner call failed: ${e.message}`]}); continue; }
        if (!reply) { refused.push({version: v, try: k + 1, why: [`no plan within the investigation bounds (${inv.limit_reached})`]}); continue; }
        const text = reply?.text ?? '';
        const j = jsonOf(text);
        // The planner judged the evidence insufficient: no plan is forced. Its gaps are kept and the item waits.
        if (plain(j?.insufficient)) {
          const gaps = (Array.isArray(j.insufficient.gaps) ? j.insufficient.gaps : []).map(String), needed = (Array.isArray(j.insufficient.needed) ? j.insufficient.needed : []).map(String);
          return result('blocked', {outputs: {mode, insufficient: {gaps, needed}, refused, versions, context: ctxOut(), planner: seatOf(planner)}, team, contributions, usage: usage(),
            findings: gaps.map((g, i) => ({id: `gap-${i + 1}`, severity: 'block', cause: 'missing-evidence', text: g, lab: planner.lab})),
            blocker: {code: 'EVIDENCE_INSUFFICIENT', what: `EVIDENCE_INSUFFICIENT: the planner could not establish the problem from the evidence it was given or could retrieve (${gaps.join('; ') || 'no gap named'})`,
              role: 'lead@orch', resume_when: `the evidence changes (${needed.join('; ') || 'the missing records become retrievable'}), or the owner raises the investigation limits`},
            next: {stage: 'plan', why: 'the evidence does not yet support a plan'}});
        }
        const delivered = deliveryOf(dossier, inv);
        const why = planRefusal(j, {delivered, depends_on: Object.keys(deps), mode, ticket: ticket?.ticket ?? null, findings, repo, item});
        progress({event: 'plan.answer', item, version: v, try: k + 1, refused: why.length});
        if (why.length) { refused.push({version: v, try: k + 1, why}); continue; }
        turnHash = rec.recordTurn({seat: {seat_id: `${planner.vendor}-plan@${planner.model}`, vendor: planner.vendor, mode: 'operate-plan', occupancy_gen: 1},
          requested_model: planner.model, served_model: reply.served_model ?? null, response_id: reply.response_id ?? null, reply: text, purpose: 'plan', prompt});
        const bytesOf = bytesOfRepo(repo);
        doc = {schema: PLAN_SCHEMA, item, mode, requirement: gate.requirement, ...j,
          // Each citation with how it reached the planner (supplied, retrieved) and its version: a citation of
          // something never delivered was refused above.
          evidence: j.evidence.map(e => {
            const ref = refOf(e.ref ?? e.path), got = delivered.get(ref);
            const file = got.source?.startsWith('file:') ? got.source.slice(5) : null;
            // Which bytes of which version reached the planner: a partly delivered source stays partial on the record.
            const part = {via: got.via, complete: got.complete, portions: got.portions, total: got.total};
            return file ? {path: file, sha256: bytesOf(file), why: e.why, ...part} : {ref, source: got.source, version: got.version ?? null, why: e.why, ...part};
          }),
          version: {n: versions.length + 1, previous: prevDigest}};
      }
      if (!doc) return stop(`no well-formed plan after ${PLANNER_TRIES} planner answer(s): ${refused.at(-1)?.why.join('; ')}`);
      const planDigest = 'sha256:' + digest(doc);
      // 2. The exact plan version, committed on its own ref (the cycle reviews a commit range), then reviewed.
      let base, head;
      if (resume) ({base, head} = resume);
      else {
        const last = rec.lastCycle(scope);
        base = last?.head ?? G(['rev-parse', 'HEAD^{commit}']).trim();
        let at = null;
        try { at = execFileSync('git', ['-C', top, 'show', `${base}:${file}`], {maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore']}); } catch { at = null; }
        const bytes = JSON.stringify(doc, null, 2) + '\n';
        const branch = `pantheon-plan/${item}/${base.slice(0, 12)}-${planDigest.slice(7, 19)}`;
        try { head = G(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]).trim(); } catch { head = null; }
        head ||= commitShipped({repo: top, base, files: [{path: file, contents: bytes, baseline: {exists: at !== null, bytes: at ? cidOf('blob', at) : null}}],
          branch, message: `plan ${item} v${doc.version.n} (${planDigest})\n\nOphanim-Plan: ${planDigest}\n`});
      }
      const diff = G(['diff', '--no-color', base, head]);
      const r = await reviewCycle({ledger: rec, resume: Boolean(resume), change: {scope, base, head, diff, files: [file], author_labs: resume?.author_labs ?? labsOfContribs(contributions),
        author_turns: resume?.author_turns ?? [turnHash], ...(resume ? {} : independenceOf(dedupe(contributions)))}, seats: planSeats, n,
        // The reviewers get the evidence itself, not only the planner's account of it, and may retrieve more.
        turn: investigatingTurn(m, retriever, investigations, 'plan-reviewer'),
        brief: boundBrief(ctx, `plan|${base}|${head}`, () => [PLAN_BRIEF, '', renderDossier(dossier), '',
          `## What the planner retrieved beyond the dossier: ${investigations.filter(x => x.role === 'planner').flatMap(x => x.requests).map(q => `${JSON.stringify(q.request)} -> ${q.ok ? 'delivered' : `FAILED ${q.error}`}`).join('; ') || '(nothing)'}`,
          '', RETRIEVAL_HELP(INV)].join('\n'))});
      resume = null;
      const state = rec.cycleState(r.cycle);
      const version = {n: doc.version.n, digest: planDigest, commit: head, cycle: r.cycle, reviews: state.reviews.map(x => ({lab: x.lab, verdict: x.verdict}))};
      versions.push(version);
      if (state.reviews.length < n) {
        return result('pending', {outputs: {mode, plan: doc, plan_digest: planDigest, refused, versions, cycle: r.cycle, plan_ledger_anchor: sys.anchor, context: ctxOut()},
          team: [...team, ...planSeats.map(s => reviewerRow('plan-reviewer', s))], contributions, usage: usage(),
          blocker: {what: `REVIEW_PENDING: ${r.failed.length} plan reviewer seat(s) failed (${r.failed.map(f => `${f.lab}: ${f.why}`).join('; ')}); the plan and its open cycle are kept`,
            role: 'check@review', resume_when: 'the reviewer is available; the open plan cycle is resumed, never reopened', transient: true},
          next: {stage: 'plan', why: 'plan review incomplete'}});
      }
      // Each finding with what the record shows about its cause: did the source it is about ever reach the planner?
      const authorGot = plannerGot();
      const rows = findingRows(state).map(f => ({...f, ...causeOf(f.file, authorGot, doc)}));
      const blocking = rows.filter(f => BLOCKING.has(f.severity));
      const changes = state.reviews.some(x => x.verdict === 'request_changes');
      if (!blocking.length && !changes) {
        // Approved: non-blocking findings are deferred on the record and carried as unresolved.
        for (const f of state.findings) rec.deferFinding({finding: f.hash, reason: 'non-blocking plan finding: carried as unresolved with the approved plan version'});
        const closed = closeWith(rec, r.cycle, `plan review of ${item}`);
        if (closed.why) return stop(`the plan cycle cannot close: ${closed.why}`);
        // 3. The ticket: kept byte-identical when re-validated as still valid; otherwise derived from the plan and written.
        let tk, ticketRevision = null;
        if (mode === 'revalidate' && doc.ticket_assessment.still_valid && ticket) tk = ticket;
        else {
          const tfile = path.join(repo, 'tickets', `${item}.json`);
          const prior = fs.existsSync(tfile) ? fs.readFileSync(tfile) : null;
          fs.mkdirSync(path.dirname(tfile), {recursive: true});
          fs.writeFileSync(tfile, JSON.stringify(ticketOf({plan: doc, item, requirement: gate.requirement}), null, 2) + '\n');
          tk = readTicket({repo, item});
          if (tk.why) { if (prior) fs.writeFileSync(tfile, prior); else fs.rmSync(tfile); return stop(`the derived ticket is refused: ${tk.why}`); }
          if (prior) ticketRevision = {previous_digest: existing?.digest ?? sha256(prior), reasons: doc.ticket_assessment?.reasons ?? ['the plan was revised: the ticket is re-derived from the approved version']};
        }
        const evidence = doc.evidence.filter(e => e.path).map(e => ({path: e.path, sha256: e.sha256}));
        return result('passed', {identity: {ticket: {path: tk.path, digest: tk.digest}}, inputs: {mode, plan_previous: prevDigest},
          outputs: {plan: doc, plan_digest: planDigest, plan_commit: head, plan_review: {cycle: r.cycle, labs: closed.labs, close: closed.close, outcome: closed.outcome,
            unresolved: rows, ledger_anchor: sys.anchor, independence, shared_labs: planSeats.filter(x => x.shared_lab).map(x => x.lab).sort()}, ticket: {path: tk.path, digest: tk.digest}, ...(ticketRevision ? {ticket_revision: ticketRevision} : {}),
            ...(mode === 'revalidate' ? {ticket_kept: ticketRevision === null && Boolean(ticket)} : {}), deps, evidence, refused, versions, planner: seatOf(planner),
            context: ctxOut(), carry: carryForward(doc, planDigest)},
          team: [...team, ...planSeats.map(s => reviewerRow('plan-reviewer', s))], contributions: dedupe(contributions), findings: rows, usage: usage(),
          next: {stage: 'implement', why: `plan v${doc.version.n} approved by ${closed.labs.join(', ')}`}});
      }
      // 4. Findings: the version is not approved. Its findings are answered by a revision, re-reviewed in its own cycle.
      for (const f of state.findings) rec.deferFinding({finding: f.hash, reason: `answered by a revision of plan ${planDigest.slice(0, 19)}; the revision is re-reviewed in its own cycle`});
      const closed = closeWith(rec, r.cycle, `plan review of ${item}`);
      if (closed.why) return stop(`the plan cycle cannot close: ${closed.why}`);
      for (const f of rows) contributions.push({purpose: 'plan-review', vendor: f.vendor, model: f.model, ...withServed(f), lab: f.lab, via: `plan finding ${f.id.slice(0, 19)} reached the revised plan`});
      findings = rows.map(f => ({id: f.id, severity: f.severity, text: f.text, lab: f.lab, cause: f.cause}));
      prevDoc = doc; prevDigest = planDigest;
      progress({event: 'plan.revise', item, version: v, findings: rows.length});
      // The revision will carry these findings: its reviewers must be outside the labs that made them. Checked BEFORE
      // the revision is paid for; a short pool keeps the reviewed version and its findings, and waits.
      try { planSeats = panel(dedupe(contributions)); } catch (e) {
        if (e.code !== 'NO_SEATS') throw e;
        return result('pending', {outputs: {mode, plan: doc, plan_digest: planDigest, refused, versions, context: ctxOut(), stage: 'before-revision'},
          team, contributions: dedupe(contributions), findings: rows, usage: usage(),
          blocker: pendingCapacity(`the revised plan would answer findings from ${[...new Set(rows.map(f => f.lab))].join(', ')}; the configured reviewer pool offers fewer than ${n} labs ${byModel ? 'with a model that did not contribute' : `outside ${labsOfContribs(contributions).join(', ')}`}. Plan v${doc.version.n} and its findings are kept`, {stage: 'plan'}),
          next: {stage: 'plan', why: 'plan review capacity is short for the revision'}});
      }
    }
    return stop(`no plan version approved in ${PLAN_VERSIONS} version(s)`);
  }

  // ---- implement ----
  async function implement(ctx) {
    const t0 = Date.now(), item = ctx.item, planRec = ctx.upstream;
    const usage = calls => ({provider_calls: calls, elapsed_ms: Date.now() - t0});
    const t = readTicket({repo, item});
    if (t.why || t.digest !== planRec.outputs.ticket?.digest) {
      return result('returned', {outputs: {why: t.why ?? 'ticket changed'}, next: {stage: 'plan', why: `the approved ticket is ${t.why ? `invalid (${t.why})` : 'not the bytes the plan approved'}`}});
    }
    const critiques = ctx.gate.mode === 'revise' ? (ctx.gate.findings ?? []) : [];
    const contributions = dedupe([...(planRec.contributions ?? []),
      ...critiques.filter(f => f.lab).map(f => ({purpose: 'critique', vendor: f.vendor ?? null, model: f.model ?? null, ...withServed(f), lab: f.lab, via: `finding ${String(f.id).slice(0, 19)} was fed to this revision`}))]);
    // Review capacity BEFORE work: the change will need n labs outside every contributor, the predicted workers included.
    const predicted = seatTeam({pools: readPools(), spec: t.spec, profile, planTitle: 'ticket'});
    const predictedWork = [...new Map(predicted.implementers.map(l => [l[0].lab, {purpose: 'work', vendor: l[0].vendor, model: l[0].model, lab: l[0].lab}])).values()];
    const cap = cycleReviewers({scope: fullScope(null, [...contributions, ...predictedWork]), n, ...pool, independence});
    if (cap.pending) {
      return result('pending', {outputs: {stage: 'before-work', predicted_contributors: cap.scope.contributions, ticket: {path: t.path, digest: t.digest}}, contributions,
        usage: usage(0), blocker: pendingCapacity(cap.pending.why, {stage: 'implement'}), next: {stage: 'implement', why: 'review capacity is short; no work was launched'}});
    }
    const top = git(repo)(['rev-parse', '--show-toplevel']).trim(), G = git(top);
    const dirty = G(['status', '--porcelain', '--', ...t.spec.copy.map(c => path.relative(top, path.join(t.spec.repo_root, c)) || '.')]).trim();
    if (dirty) return result('failed', {outputs: {dirty}, next: {stage: 'implement', why: 'the ticket\'s copy paths have uncommitted changes'}});
    const base = G(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    // What the worker is actually GIVEN is the goal (run-item.mjs promptFor implementer: `ticket: goal`); a ticket's
    // `constraints` are stored on the board and never reach its prompt. So the reviewed plan's rationale, exclusions,
    // consequences, criteria and uncertainty, and the findings a revision must answer, are delivered in the goal of
    // this run (the ticket file is not changed), and recorded as constraints as well.
    const carried = [...(planRec.outputs.carry ?? []), ...critiques.map(f => `Fix ${String(f.id).slice(0, 19)} [${f.severity}${f.cause ? `, ${f.cause}` : ''}]: ${f.text}`)];
    const spec = {...t.spec, constraints: [...(t.spec.constraints ?? []), ...carried],
      ...(carried.length ? {goal: `${t.spec.goal}\n\nCarried from planning and review (keep to these):\n${carried.map(c => `- ${c}`).join('\n')}`} : {})};
    // A REVISION, not a restart. When the previous attempt on this same plan stopped because the in-run review
    // requested changes of passing work, its board holds that finding as a pending revision. That run is RESUMED: the
    // worker revises with the finding in its prompt (so the reviewer becomes a contributor), and the revised bytes are
    // reviewed in-run again. Starting a fresh run would repeat the work and drop the finding.
    const prior = [...ctx.work.stages(item)].reverse().find(x => x.stage === 'implement' && x.handoff?.from === planRec.hash && x.status === 'failed' && x.outputs?.board);
    const priorRun = prior && fs.existsSync(path.join(prior.outputs.board, 'run.json')) ? JSON.parse(fs.readFileSync(path.join(prior.outputs.board, 'run.json'), 'utf8')) : null;
    const resumable = priorRun && (priorRun.files ?? []).some(x => x.escalation?.pending?.reason === 'review') ? prior.outputs.board : null;
    const callsBefore = resumable ? providerCallsOf(priorRun.attempts ?? []) : 0;
    const boardDir = resumable ?? dirOf(ctx, `implement-${ctx.attempt}-${Date.now()}`);
    let res;
    try {
      res = await runOpenItem(spec, {dir: boardDir, makeClientFor, planTitle: 'ticket', maxProviderCalls: callsBefore + ctx.budget.provider_calls, scouts, profile,
        ...(resumable ? {resume: resumable} : {}), ...(revisions ? {revisions} : {}), progress: ev => progress({...ev, from: 'pipeline'})});
    } catch (e) {
      const runFile = path.join(boardDir, 'run.json');
      const made = Math.max(0, (fs.existsSync(runFile) ? providerCallsOf(JSON.parse(fs.readFileSync(runFile, 'utf8')).attempts ?? []) : 0) - callsBefore);
      // The ticket the plan wrote cannot be run as written: a plan defect.
      return result('returned', {outputs: {error: String(e.message).slice(0, 300)}, usage: usage(made), next: {stage: 'plan', why: `the planned ticket cannot be run: ${String(e.message).slice(0, 200)}`}});
    }
    const runFile = path.join(boardDir, 'run.json');
    const run = fs.existsSync(runFile) ? JSON.parse(fs.readFileSync(runFile, 'utf8')) : null;
    // This attempt's own calls: a resumed run's record also holds the calls of the attempt it resumes.
    const calls = Math.max(0, providerCallsOf(run?.attempts ?? []) - callsBefore);
    const team = [...new Map((run?.turns ?? []).map(x => [`${x.purpose}|${x.vendor}|${x.model}`, {role: x.purpose, vendor: x.vendor, model: x.served_model ?? x.model, lab: labOf(x.vendor, x.served_model ?? x.model)}])).values()];
    if (!res.shipped) {
      return result('failed', {outputs: {board: boardDir, shipped: false, ...(resumable ? {resumed: true} : {}),
        pending_revision: (run?.files ?? []).some(x => x.escalation?.pending?.reason === 'review'), error: res.error ?? null, tests: run?.acceptance ? {cmd: run.acceptance.cmd, exit: run.acceptance.exit} : null},
        team, contributions, usage: usage(calls), next: {stage: 'implement', why: `the run did not ship: ${res.error?.message ?? 'acceptance or review refused it'}`}});
    }
    const files = certifiedArtifacts(run, {repoRoot: t.spec.repo_root, outDir: res.outDir}).map(f => ({...f, path: path.relative(top, path.join(t.spec.repo_root, f.path))}));
    // A change outside the plan's slices would change the plan materially: returned to planning, not committed.
    const planned = new Set(normalizeSlots(t.spec).map(s => path.relative(top, path.join(t.spec.repo_root, s.path))));
    const outside = files.filter(f => !planned.has(f.path)).map(f => f.path);
    if (outside.length) {
      return result('returned', {outputs: {board: boardDir, outside}, team, contributions, usage: usage(calls),
        next: {stage: 'plan', why: `the implementation writes outside the planned scope (${outside.join(', ')})`}});
    }
    let branch = `pantheon/${item}`;
    for (let k = 2; (() => { try { G(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch { return false; } })(); k++) branch = `pantheon/${item}-r${k}`;
    const commit = commitShipped({repo: top, base, files, branch, message: [`${item}: ${t.spec.title}`, '', `Slice: ${t.ticket.slice}`, '',
      'Produced by an Ophanim operate implement stage (Pantheon runOpenItem); shipped after acceptance and in-run review.', '',
      `Pantheon-Ticket: ${t.digest}`, `Ophanim-Plan: ${planRec.outputs.plan_digest}`, ''].join('\n')});
    const sys = openPantheonLedger({root: path.join(boardDir, 'ledger'), board: openBoard(boardDir)});
    const v = sys.recorder().verify();
    if (!v.ok) throw new Error(`the run ledger does not verify: ${v.why}`);
    const work = workContributions(run);
    const board = readBoard({statusRoot: statusAt});
    return result('passed', {
      outputs: {commit, branch, base, files: files.map(f => f.path), run_json_digest: sha256(fs.readFileSync(runFile)), run_ledger_anchor: sys.anchor,
        run: {board: boardDir, ledger: path.join(boardDir, 'ledger'), ledger_anchor: sys.anchor, ledger_head: v.head, run_json: runFile,
          gate_entry: run?.ledger?.gate ?? null, tests: run?.acceptance ? {cmd: run.acceptance.cmd, exit: run.acceptance.exit} : null},
        ticket: {path: t.path, digest: t.digest, slice: t.ticket.slice, proposes: t.ticket.proposes, key: t.spec.key},
        made_against: board.items.find(i => i.item === item)?.entry ?? null, contributions: dedupe([...contributions, ...work]),
        ...(resumable ? {resumed_from: prior.hash} : {}),
        carried: {plan: planRec.outputs.plan_digest, lines: carried.length, via: 'the goal of the run (delivered to the worker)'},
        ...(critiques.length ? {answers: critiques.map(f => f.id)} : {})},
      team, contributions: dedupe([...contributions, ...work]), usage: usage(calls), next: {stage: 'review', why: `shipped as ${commit.slice(0, 12)} on ${branch}`}});
  }

  // ---- review ----
  async function review(ctx) {
    const t0 = Date.now(), item = ctx.item, impl = ctx.upstream, o = impl.outputs;
    const m = meter(turn, ctx.budget.provider_calls);
    const usage = () => ({provider_calls: m.made, elapsed_ms: Date.now() - t0});
    if (!fs.existsSync(o.run.run_json) || sha256(fs.readFileSync(o.run.run_json)) !== o.run_json_digest) {
      return result('failed', {next: {stage: 'implement', why: 'the run.json the implement stage recorded is missing or changed'}});
    }
    const run = JSON.parse(fs.readFileSync(o.run.run_json, 'utf8'));
    const scope = fullScope(changeScope(run), o.contributions ?? []);
    const chosen = cycleReviewers({scope, n, ...pool, independence});
    const outputs = {commit: o.commit, base: o.base, review_scope: chosen.scope, author_labs: chosen.author_labs, independence,
      ...(byModel ? {author_models: chosen.author_models, shared_labs: chosen.shared_labs ?? []} : {})};
    if (chosen.pending) {
      return result('pending', {outputs, usage: usage(), blocker: pendingCapacity(chosen.pending.why), next: {stage: 'review', why: 'review capacity is short; the commit is kept'}});
    }
    const sys = openPantheonLedger({root: o.run.ledger, anchor: o.run.ledger_anchor, board: openBoard(o.run.board)});
    const rec = sys.recorder();
    const top = git(repo)(['rev-parse', '--show-toplevel']).trim(), G = git(top);
    // The board scope the status ledger binds completion evidence to (status.mjs checkReview): one cycle per run ledger,
    // and each implement attempt has its own run ledger, so the scope is this attempt's change.
    const cscope = boardScopeOf(item, o.base);
    const diff = G(['diff', '--no-color', o.base, o.commit]);
    const files = G(['diff', '--name-only', o.base, o.commit]).split('\n').filter(Boolean);
    const authorTurns = sys.ledger.read().filter(e => e.kind === 'turn' && ['plan', 'work'].includes(sys.ledger.payloadOf(e).purpose)).map(e => sys.ledger.hashOf(e));
    const last = rec.lastCycle(cscope);
    const planDoc = chainOf(ctx.work, impl).plan?.outputs.plan ?? null;
    const {dossier, retriever} = evidenceFor(ctx);
    const investigations = Object.assign([], {dossier});
    let cycle = last?.hash ?? null;
    if (!last?.close) {
      // An open cycle of this exact change is resumed (its recorded reviews kept), never reopened.
      const r = await reviewCycle({ledger: rec, resume: Boolean(last), change: {scope: cscope, base: o.base, head: o.commit, diff, files, author_labs: chosen.author_labs, author_turns: authorTurns, ...(last ? {} : independenceOf(chosen.contributions ?? []))},
        seats: chosen.seats, n, policy: runPolicy(run),
        // The change reviewers judge the diff against the requirement and the approved plan, with the evidence itself
        // and their own retrieval -- not the diff alone.
        turn: investigatingTurn(m, retriever, investigations, 'cycle-reviewer'),
        brief: boundBrief(ctx, `change|${o.base}|${o.commit}`, () => [REVIEW_BRIEF,
          'Judge the change against the ORIGINAL requirement and the approved plan below, not only for defects in the diff: does it do what was required, does it keep',
          'the plan\'s exclusions and the obligations of what consumes the changed files, and does it hold on a retry, a partial completion and a later revision?',
          'You have your own access to the evidence (the dossier and retrieval). Name the evidence a finding rests on inside its claim, as [source: <path or ref>].',
          '', '## Original requirement (authoritative)', JSON.stringify(planDoc?.requirement ?? null),
          '', '## Approved plan (reviewed by three labs)', JSON.stringify(planDoc ? {problem: planDoc.problem, scope: planDoc.scope, exclusions: planDoc.exclusions, acceptance: planDoc.acceptance,
            investigation: planDoc.investigation, uncertainty: planDoc.context?.uncertainty ?? [], unresolved: planDoc.unresolved} : null, null, 1),
          '', renderDossier(dossier), '', RETRIEVAL_HELP(INV)].join('\n'))});
      cycle = r.cycle;
    }
    const state = rec.cycleState(cycle);
    const team = state.reviews.map(x => ({role: 'cycle-reviewer', vendor: x.seat.vendor, model: x.model, lab: x.lab}));
    Object.assign(outputs, {cycle, cycle_ledger_anchor: sys.anchor, scope: cscope, labs: state.reviews.map(x => x.lab).sort(), context: {dossier: dossierRecord(dossier), investigations: [...investigations]}});
    if (state.reviews.length < state.cycle.reviewers) {
      const failed = state.attempts.filter(a => a.outcome === 'failed').map(a => `${a.seat.lab}: ${a.why}`);
      return result('pending', {outputs, team, usage: usage(),
        blocker: {what: `REVIEW_PENDING: ${state.reviews.length} of ${state.cycle.reviewers} reviews recorded (${failed.join('; ') || 'reviewer unavailable'}); the commit and the open cycle are kept`,
          role: 'check@review', resume_when: 'the reviewer is available; the open cycle is resumed with its recorded reviews kept', transient: true},
        next: {stage: 'review', why: 'a reviewer seat failed'}});
    }
    // Findings with no resolution (fixed, or deferred under the existing review-cycle rules) return the change.
    const open = findingRows(state, {only: f => !state.resolutions.get(f.hash)});
    if (open.length) {
      return result('returned', {outputs, team, findings: open, usage: usage(), next: {stage: 'implement', why: `${open.length} review finding(s) to fix`}});
    }
    const closed = closeWith(rec, cycle, `coordinated review of ${item}`);
    if (closed.why) return result('pending', {outputs, team, usage: usage(), blocker: {what: closed.why, role: 'check@review', resume_when: 'the cycle can close'}, next: {stage: 'review', why: closed.why}});
    if (closed.outcome !== 'verified') {
      return result('pending', {outputs: {...outputs, close: closed.close, outcome: closed.outcome}, team, usage: usage(),
        blocker: {what: `the cycle closed ${closed.outcome}`, role: 'decision-authority', resume_when: 'the owner accepts the unverified close with a stated reason, or the findings are reproduced'},
        next: {stage: 'review', why: `closed ${closed.outcome}`}});
    }
    return result('passed', {outputs: {...outputs, close: closed.close, outcome: closed.outcome, labs: closed.labs}, team, usage: usage(),
      next: {stage: 'validate', why: `closed verified by ${closed.labs.join(', ')}`}});
  }

  // ---- validate ----
  async function validate(ctx) {
    const t0 = Date.now(), item = ctx.item, rv = ctx.upstream;
    const chain = chainOf(ctx.work, rv);
    const impl = chain.implement, planRec = chain.plan, planDoc = planRec.outputs.plan;
    const m = meter(turn, ctx.budget.provider_calls);
    const usage = () => ({provider_calls: m.made, elapsed_ms: Date.now() - t0});
    const commit = rv.outputs.commit;
    if (commit !== impl.outputs.commit) return result('failed', {next: {stage: 'review', why: 'the reviewed commit is not the implemented one'}});
    // 1. A CLEAN checkout of the exact commit (git archive: no working-tree bytes reach it).
    const top = git(repo)(['rev-parse', '--show-toplevel']).trim(), G = git(top);
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'operate-validate-'));
    const tests = [];
    const outputsDir = dirOf(ctx, `validate-${ctx.attempt}-outputs`);
    try {
      execFileSync('tar', ['-x', '-C', clean], {input: execFileSync('git', ['-C', top, 'archive', '--format=tar', commit], {maxBuffer: 512 << 20})});
      const cwd = path.join(clean, path.relative(top, repo));
      const run = (kind, id, cmd) => {
        let exit = 0, out;
        try { out = execFileSync('sh', ['-c', cmd], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000, maxBuffer: 64 << 20}); }
        catch (e) { exit = Number.isInteger(e.status) ? e.status : 1; out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
        // The whole output is kept and retrievable ({"op":"output","id":...}); the prompt shows its tail and says so.
        const full = String(out ?? ''), oid = `${kind}-${String(id).replace(/[^\w.-]/g, '_')}.txt`;
        fs.writeFileSync(path.join(outputsDir, oid), full);
        tests.push({kind, id, cmd, exit, output_digest: sha256(full), output: {id: oid, chars: full.length, shown: Math.min(2000, full.length), complete: full.length <= 2000}, tail: full.slice(-2000)});
      };
      for (const a of planDoc.acceptance) run('acceptance', a.id, a.test.cmd);
      const pkg = fs.existsSync(path.join(cwd, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) : null;
      const regression = planDoc.regression?.cmd ?? (pkg?.scripts?.test ? 'npm test' : null);
      if (regression) run('regression', 'regression', regression);
      else tests.push({kind: 'regression', id: 'regression', cmd: null, exit: null, output_digest: null, tail: 'no regression command: neither the plan nor the repository names one'});
    } finally { fs.rmSync(clean, {recursive: true, force: true}); }
    const green = tests.every(x => x.exit === 0 || x.cmd === null);
    // 2. The validator: a lab that contributed to neither plan, implementation nor review findings, when the pool allows.
    const finderRows = ctx.work.stages(item).filter(s => s.stage === 'review' && s.findings?.length).flatMap(s => s.findings).filter(f => f.lab)
      .map(f => ({purpose: 'critique', vendor: f.vendor ?? null, model: f.model ?? null, ...withServed(f), lab: f.lab}));
    // The validator contributed to nothing it judges: under the lab rule its lab did not, under the model rule it did not.
    // `barred` are seats already tried whose answer could not be accepted (see below): they are not asked again.
    const allContribs = [...(impl.outputs.contributions ?? []), ...finderRows];
    const authorsOnly = allContribs.filter(c => ['plan', 'work'].includes(c.purpose));
    const pickValidator = barred => {
      const extra = barred.flatMap(x => [{purpose: 'barred', vendor: x.vendor, model: x.model, lab: x.lab}, ...(x.served_model ? [{purpose: 'barred', vendor: x.vendor, model: x.served_model, lab: x.lab}] : [])]);
      const seatFor = rows => (byModel ? reviewSeatsByModel({n: 1, contributions: [...rows, ...extra.filter(e => resolveModel(e.vendor, e.model)?.known)], ...pool})
        : reviewSeats({n: 1, avoidLabs: [...new Set([...labsOfContribs(rows), ...barred.map(x => x.lab)])], ...pool}))[0];
      try { return {seat: seatFor(allContribs), independent: true, against: allContribs}; }
      catch { try { return {seat: seatFor(authorsOnly), independent: false, against: authorsOnly}; } catch { return null; } }
    };
    /** Why the model that ANSWERED may not be this item's validator, or null. Asked-for and answering model both count. */
    const servedRefusal = (seat, served, against) => {
      if (byModel) return reviewerRefusal({vendor: seat.vendor, model: seat.model, served_model: served}, contributorKeys(against));
      const lab = labOf(seat.vendor, served ?? seat.model);
      return labsOfContribs(against).includes(lab) ? `the ${lab} lab contributed to the work and its model answered (${served})` : null;
    };
    let picked = pickValidator([]);
    if (!picked) return result('failed', {outputs: {commit, tests, cause: 'validation-defect'}, usage: usage(), next: {stage: 'validate', why: 'no validator seat is available that did not write the plan or the code'}});
    let {seat, independent} = picked;
    const team = [{role: 'validator', ...seatOf(seat)}];
    const diff = G(['diff', '--no-color', impl.outputs.base, commit]);
    const {dossier, retriever} = evidenceFor(ctx, {outputsDir});
    const investigations = [];
    const prompt = ['You are the independent validator of one implemented change (Ophanim operate, validate stage). You did not plan, write or review it.',
      'Judge whether the change meets the ORIGINAL requirement and every approved acceptance criterion. Tests passing is evidence, not proof.',
      'You have your own access to the evidence: the dossier below and retrieval. Do not rely on the plan\'s or the implementer\'s account of it.',
      'Check the obligations of what consumes the changed files, the earlier findings on this item (were they really answered?), and whether the result holds on a retry,',
      'a partial completion, a restart and a later revision. A test output shown as a tail is PARTIAL: retrieve it before relying on what is cut.',
      '', '## Original requirement (authoritative)', JSON.stringify(planDoc.requirement), '', '## Approved acceptance criteria', JSON.stringify(planDoc.acceptance, null, 2),
      '', '## The reviewed plan\'s rationale', JSON.stringify({problem: planDoc.problem, scope: planDoc.scope, exclusions: planDoc.exclusions, investigation: planDoc.investigation ?? null,
        uncertainty: planDoc.context?.uncertainty ?? [], gaps: planDoc.context?.gaps ?? [], evidence: planDoc.evidence}, null, 1),
      '', '## Test results in a clean checkout of the commit', JSON.stringify(tests.map(x => ({kind: x.kind, id: x.id, cmd: x.cmd, exit: x.exit,
        output: x.output ? `${x.output.complete ? 'complete' : `PARTIAL: the last ${x.output.shown} of ${x.output.chars} chars`}; retrieve with {"op":"output","id":"${x.output.id}"}` : null, tail: x.tail})), null, 2),
      '', `## Change ${impl.outputs.base}..${commit}`, '```diff', diff, '```',
      '', renderDossier(dossier), '', RETRIEVAL_HELP(INV),
      '', 'Answer with ONE JSON object in a ```json block: {"verdict": "accept" | "implementation_defect" | "plan_defect" | "diagnosis_defect" | "missing_evidence", "reasons": ["..."],',
      ' "criteria": [{"id": "<acceptance id>", "met": true | false, "why": "..."}], "sources": ["<refs you checked yourself>"]}.',
      'implementation_defect: the code is wrong for a sound plan. plan_defect: a criterion or the scope does not cover the requirement or a consequence. diagnosis_defect: the plan\'s',
      'stated cause is wrong or unsupported. missing_evidence: you cannot judge because evidence is missing or unretrievable (say which). Keep these apart.'].join('\n');
    let judged = null;
    const refusedJ = [], rejected = [];
    for (let k = 0; k < 3 && !judged; k++) {
      if (m.left() < 1) break;
      let reply;
      try {
        const r = await investigate({prompt, retriever, canAsk: () => m.left() > 1, ask: p => m.turn({vendor: seat.vendor, model: seat.model, prompt: p, seat: {...seat, role: 'validator'}})});
        investigations.push({role: 'validator', ...seatOf(seat), try: k + 1, ...r.log, unresolved: gapsOf(deliveryOf(dossier, r.log))});
        reply = r.reply;
        if (!reply) { refusedJ.push(`no judgment within the investigation bounds (${r.log.limit_reached})`); continue; }
      } catch (e) { refusedJ.push(`the validator call failed: ${e.message}`); continue; }
      const j = jsonOf(reply?.text);
      // WHO ANSWERED is checked before the judgment is read as one. The seat was chosen by the model asked for; the
      // model that served the turn must be eligible too: resolved, and not a contributor. An answer that fails this
      // is kept on the record (requested and served names, the reason, the reply's digest) and is not a validation.
      const served = reply.served_model ?? null;
      const why = servedRefusal(seat, served, picked.against);
      if (why) {
        rejected.push({vendor: seat.vendor, model: seat.model, served_model: served, lab: seat.lab, why, verdict: j?.verdict ?? null, reply_sha: sha256(reply.text ?? '')});
        refusedJ.push(`the answer of ${seat.vendor}/${seat.model} (served by ${served ?? 'an unnamed model'}) is not accepted: ${why}`);
        picked = pickValidator(rejected);
        if (!picked) break;
        ({seat, independent} = picked);
        team.push({role: 'validator', ...seatOf(seat)});
        continue;
      }
      const ids = planDoc.acceptance.map(a => a.id);
      if (!j || !VERDICTS.includes(j.verdict) || !strs(j.reasons) || !Array.isArray(j.criteria) || !ids.every(id => j.criteria.some(c => c?.id === id && typeof c.met === 'boolean'))) {
        refusedJ.push('the validator did not answer {verdict, reasons, criteria for every acceptance id}'); continue;
      }
      // What it says it checked, against what it was actually given: a source it never received is not "checked".
      const got = deliveryOf(dossier, {requests: investigations.filter(x => x.role === 'validator').flatMap(x => x.requests)});
      const sources = (Array.isArray(j.sources) ? j.sources : []).filter(x => typeof x === 'string').map(x => ({ref: refOf(x), delivered: got.has(refOf(x)), ...(got.has(refOf(x)) ? {complete: got.get(refOf(x)).complete} : {})}));
      judged = {...j, sources, vendor: seat.vendor, model: seat.model, served_model: served, lab: seat.lab};
    }
    const outputs = {commit, checkout: {commit, tree: G(['rev-parse', `${commit}^{tree}`]).trim(), method: 'git archive'}, tests, green,
      // The accepted validator, by the model asked for AND the model that answered; answers that were not accepted stay on the record.
      validator: {...seatOf(seat), served_model: judged?.served_model ?? null, independent,
        ...(byModel && judged ? {identity: resolveModel(seat.vendor, seat.model)?.id ?? null, served_identity: resolveModel(seat.vendor, judged.served_model ?? seat.model)?.id ?? null} : {})},
      refused: refusedJ, rejected_answers: rejected, context: {dossier: dossierRecord(dossier), investigations}};
    // No judgment is a defect of the validation itself, kept apart from a defect of the change.
    if (!judged) return result('failed', {outputs: {...outputs, cause: 'validation-defect'}, team, usage: usage(), next: {stage: 'validate', why: `no well-formed validator judgment (${refusedJ.join('; ')})`}});
    // A red test cannot be accepted, and a green test alone cannot pass: the judgment is required.
    let verdict = judged.verdict;
    const reasons = [...judged.reasons];
    if (verdict === 'accept' && !green) { verdict = 'implementation_defect'; reasons.push('the controller: an acceptance or regression command failed in the clean checkout'); }
    if (verdict === 'accept' && judged.criteria.some(c => !c.met)) { verdict = 'implementation_defect'; reasons.push('the controller: the validator marked a criterion unmet'); }
    const route = VERDICT_ROUTE[verdict] ?? null;
    Object.assign(outputs, {verdict, reasons, criteria: judged.criteria, sources: judged.sources, ...(route ? {cause: route.cause} : {})});
    const findings = verdict === 'accept' ? [] : reasons.map((text, i) => ({id: `validate-${i + 1}`, severity: 'block', cause: route.cause, text, vendor: judged.vendor, model: judged.model, ...withServed(judged), lab: judged.lab}));
    if (verdict === 'accept') return result('passed', {outputs, team, usage: usage(), next: {stage: 'outcome', why: 'accepted against the original requirement and the approved criteria'}});
    return result('returned', {outputs, team, findings, usage: usage(), next: {stage: route.stage, why: `${verdict} (${route.cause}): ${reasons[0]}`}});
  }

  // ---- outcome ----
  async function outcome(ctx) {
    const t0 = Date.now(), item = ctx.item, val = ctx.upstream;
    const chain = chainOf(ctx.work, val);
    const {review: rv, implement: impl} = chain;
    const commit = val.outputs.commit;
    if (!(rv && impl && rv.outputs.commit === commit && impl.outputs.commit === commit)) return result('failed', {next: {stage: 'validate', why: 'the validated, reviewed and implemented commits differ'}});
    const t = readTicket({repo, item});
    if (t.why || t.digest !== impl.outputs.ticket.digest) return result('returned', {next: {stage: 'plan', why: 'the ticket is no longer the one implemented'}});
    const o = impl.outputs;
    const dir = dirOf(ctx, `outcome-${commit.slice(0, 12)}`);
    const bundle = {schema: BUNDLE_SCHEMA, item, title: ctx.gate.requirement.title, made_against: o.made_against, checked: today(),
      // The ticket file, so the owner's apply re-checks its bytes (status.mjs checkEvidenceLedgers: locations.ticket).
      ticket: {...o.ticket, file: path.resolve(repo, o.ticket.path)}, board: o.run.board, base: o.base, branch: o.branch, commit,
      run: {ledger: o.run.ledger, ledger_anchor: o.run.ledger_anchor, ledger_head: o.run.ledger_head, run_json: o.run.run_json, run_json_digest: o.run_json_digest,
        shipped: true, gate_entry: o.run.gate_entry, tests: o.run.tests},
      review: {ledger: o.run.ledger, ledger_anchor: rv.outputs.cycle_ledger_anchor, scope: rv.outputs.scope, review_scope: rv.outputs.review_scope, cycle: rv.outputs.cycle,
        author_labs: rv.outputs.author_labs, close: rv.outputs.close, outcome: rv.outputs.outcome},
      validation: {verdict: val.outputs.verdict, record: val.hash, tests: val.outputs.tests.map(x => ({kind: x.kind, cmd: x.cmd, exit: x.exit, output_digest: x.output_digest})), validator: val.outputs.validator},
      plan: {digest: chain.plan.outputs.plan_digest, cycle: chain.plan.outputs.plan_review.cycle}, proposal: null};
    fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(bundle, null, 2) + '\n');
    const p = proposeFromBundle({dir, statusRoot: statusAt});
    if (!p.proposal) return result('blocked', {outputs: {bundle: dir}, usage: {provider_calls: 0, elapsed_ms: Date.now() - t0},
      blocker: {what: p.why, role: 'decision-authority', resume_when: 'the item is re-dispatched against its current status'}, next: {stage: 'outcome', why: p.why}});
    const bytes = fs.readFileSync(path.join(dir, 'proposal.json'));
    return result('passed', {outputs: {proposal_path: path.join(dir, 'proposal.json'), proposal_digest: p.bundle.proposal.digest, proposal_file_sha256: sha256(bytes),
      to: p.proposal.to.state, item, ticket: o.ticket.digest, commit, bundle: dir, signed: false}, usage: {provider_calls: 0, elapsed_ms: Date.now() - t0},
      next: {stage: null, why: 'the unsigned status proposal awaits the owner'}});
  }

  return {plan, implement, review, validate, outcome};
}
