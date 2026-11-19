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
//              UNDER THE `fit` PROFILE, with a plan that carries `work_units`: the five-stage specialist pipeline
//              (pantheon/src/pipeline runPipeline: dispatcher -> implementer in a per-unit worktree -> subagents ->
//              pinned reviewer -> integration), its integrated tree committed on pantheon/<item> the same way.
//              `argo` and `legacy` keep the per-file runOpenItem path, unchanged.
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
// tests inject a synthetic pool with both), pipelineLimits (overrides of the pipeline's DEFAULT_LIMITS under `fit`; the
// provider-call bound is the stage budget, or a lower max_provider_calls given here), meteredFailover (default true; false:
// a Gemini lane's quota refusal in the pipeline is never answered by the metered Gemini API, pipeline/turns.mjs)}. Every stage
// stays within ctx.budget.provider_calls; a failed or refused call is counted. Vendor SDKs stay at the edge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {spawnPromise} from '../../pantheon/src/board/spawn.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';
import {boardScopeOf, checkEvidenceLedgers} from '../../packages/ledger/status.mjs';
import {handoffRefusal} from './work-ledger.mjs';
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
import {fitMatrix, IMPLEMENTER_LADDERS, REVIEWER_ESCALATION, pinnedReviewer, implementerEscalation} from '../../pantheon/src/route/fit-matrix.mjs';
import {runPipeline, contributionsOf, arbitersOf, validateWorkUnits, PLANNER_PROMPT, liveOwner, recoverOrphanWorktrees} from '../../pantheon/src/pipeline/index.mjs';
import {pipelineTurns} from '../../pantheon/src/pipeline/turns.mjs';
import {matchesOwned} from '../../pantheon/src/pipeline/paths.mjs';
import {git as gitAsync} from '../../pantheon/src/pipeline/git.mjs';
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
// The stage's call meter. With the scheduler's ctx ({charge, signal}), every call is CHARGED on the work ledger
// before it is made (a call that leaves the process is counted even if the process dies), and no call is admitted
// once the stage's elapsed budget is spent (the cooperative stop). A refused charge is a refused call.
// The turn is given the stage's `signal` (a live adapter aborts its in-flight request or process with it) and a
// `charge()` for a SECOND provider call made inside the turn -- the metered Gemini API failover after a lane's quota
// refusal -- which is admitted, bounded and charged like any other call before it is made, or refused (it throws) and
// not made (independent review, assignment 3 (xAI grok-4.7, 09d490f), question 9; (OpenAI gpt-6-astra extra review,
// 09d490f), questions 1 and 9).
function meter(turn, limit, ctx = {}) {
  const m = {made: 0, refused: 0, limit};
  const admit = () => {
    if (ctx.signal?.aborted) { m.refused++; throw Object.assign(new Error(`STAGE_ELAPSED: ${ctx.signal.reason?.message ?? 'the stage was stopped'}`), {code: 'STAGE_ELAPSED'}); }
    if (m.made >= m.limit) { m.refused++; throw Object.assign(new Error(`PROVIDER_CALL_LIMIT: ${m.made} of ${m.limit} stage provider call(s) used`), {code: 'PROVIDER_CALL_LIMIT'}); }
    if (typeof ctx.charge === 'function') { try { ctx.charge(1); } catch (e) { m.refused++; throw e; } }
    m.made++;
  };
  m.turn = args => {
    try { admit(); } catch (e) { return Promise.reject(e); }
    return Promise.resolve().then(() => turn({...args, ...(ctx.signal ? {signal: ctx.signal} : {}), charge: admit}));
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
export function planRefusal(j, {shown = [], delivered = null, depends_on = [], mode = 'author', ticket = null, findings = [], repo = null, item = null, workUnits = 'optional'} = {}) {
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
  // WORK UNITS (pantheon/src/pipeline/work-units.mjs): required under the `fit` profile, whose implement stage is the
  // five-stage pipeline over them; when another profile's plan carries them they must still be well-formed. Nothing
  // is repaired: every broken rule is one named reason, like any other malformed plan.
  if (j.work_units === undefined) {
    if (workUnits === 'required') why.push('work_units is required: [{unit_id, depends_on, owned_paths, difficulty, specialist_role, allowed_subagents, verify_cmd, invariants}], cohesive multi-file units (coupled types, implementation and tests in ONE unit)');
  } else {
    const v = validateWorkUnits({work_units: j.work_units});
    if (!v.ok) for (const r of v.refusals) why.push(`work_units: ${r.message}`);
    // The ticket's slices are what the item ships; under fit every one of them must be owned by a unit, or no
    // implementer could write it.
    else if (workUnits === 'required') for (const sl of slices) if (plain(sl) && str(sl.path) && !v.units.some(u => matchesOwned(sl.path, u.owned_paths))) why.push(`slice ${sl.id ?? sl.path} writes ${sl.path}, which no work unit owns`);
  }
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

// The work-unit rules, in the pipeline's own words (PLANNER_PROMPT), so the lifecycle's planner and a stand-alone
// Stage 1 planner are told the same thing.
const UNIT_RULES = (() => { const t = PLANNER_PROMPT({task: '-'}); return t.slice(t.indexOf('WHAT A WORK UNIT IS'), t.indexOf('OUTPUT:')).trim(); })();

function plannerPrompt({mode, requirement, deps, ticket, previous, findings, refusals, dossier, limits, units = false}) {
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
    ...(units ? ['', '## Work units (required: the implement stage runs them as a supervised pipeline)',
      'You are Stage 1 of that pipeline, a READ-ONLY specialist: you decompose the change into work_units; you write no code, edit no file and run no command.',
      UNIT_RULES,
      'Paths are relative to the repository root. Every slice path must be owned by one of the units. Unknown keys in a unit are refused.'] : []),
    '', `## Answer`, `When the evidence supports a plan, answer with ONE JSON object in a \`\`\`json block (schema ${PLAN_SCHEMA}): {problem: {statement, justification, symptom?, trigger?, mechanism?, alternatives?: [..]},`,
    ' context: {sufficient: true, gaps: [what you could not see], uncertainty: [what remains unproven]},',
    ' investigation: {historical_cause, operational_position, change_impact, success_adequacy}: each {examined: true, finding, sources: [refs]} or {examined: false, why},',
    ' relevance?: [{ref, decision: "used" | "dismissed", why}], scope: [..], exclusions: [..],',
    ' dependencies: [item ids], capabilities: [..], acceptance: [{id, criterion, test: {cmd}}], regression: {cmd} | null,',
    ' slices: [{id, title, slot, path}], copy: [repo paths the work reads], difficulty?: easy|medium|hard, proposes: {state, basis},',
    ...(units ? [' work_units: [{unit_id, depends_on: [unit ids], owned_paths: [path or glob], difficulty: easy|medium|hard, specialist_role, allowed_subagents: [role ids], verify_cmd, invariants: [..]}],'] : []),
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
// The key keeps every identity a row names: a turn asked as one model and served by another (`requested_model`) is a
// different row from a turn asked and served as the served model, so the asked identity is never dropped (independent
// review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 6).
export const dedupe = rows => [...new Map(rows.map(r => [`${r.purpose}|${r.vendor}|${r.model}|${r.requested_model ?? ''}|${r.lab}`, r])).values()];
const labsOfContribs = rows => [...new Set(rows.map(r => r.lab).filter(Boolean))].sort();
/**
 * DECISION 6 (owner, 2026-11-19; docs/review-independence.md). The rows that exclude a run's dispatchers (record.mjs
 * arbitersOf) from later independent judgment: one per distinct identity, `purpose: 'arbiter'`, the served model as
 * `model` and the asked one as `requested_model` when they differ, so contributorKeys counts both. The dispatcher is
 * not reclassified as an author: these rows are exclusions, and contributionsOf still omits it.
 */
export function arbiterExclusions(arbiters = []) {
  const rows = new Map();
  for (const a of arbiters) {
    const model = a.served_model ?? a.model;
    const row = {purpose: 'arbiter', vendor: a.vendor, model, ...(a.served_model && a.model && a.served_model !== a.model ? {requested_model: a.model} : {}),
      ...(a.served_model_source ? {served_model_source: a.served_model_source} : {}), lab: labOf(a.vendor, model)};
    const k = JSON.stringify(row);
    rows.set(k, {row, units: [...new Set([...(rows.get(k)?.units ?? []), a.unit_id])]});
  }
  return [...rows.values()].map(({row, units}) => ({...row, via: `pipeline dispatcher, unit(s) ${units.join(', ')}: its rubric governed the unit (a non-authoring arbiter, excluded from later independent judgment: Decision 6)`}));
}
/** The change scope plus every other recorded contribution: never narrowed to make a panel possible. */
function fullScope(base, contributions) {
  const all = dedupe([...(base?.contributions ?? []), ...contributions]);
  return {...(base ?? {kind: 'change'}), contributions: all, author_labs: labsOfContribs(all)};
}
const pendingCapacity = (why, extra = {}) => ({what: `REVIEW_CAPACITY_PENDING: ${why}`, role: 'check@review', resume_when: 'a reviewer lab outside the contributors becomes available', ...extra});
const result = (status, rest) => ({status, outputs: {}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, ...rest});
/**
 * A REVIEW LEFT INCOMPLETE BY THE STAGE'S OWN PROVIDER-CALL BUDGET is a budget stop, recorded with its own code
 * (STAGE_PROVIDER_CALLS), not REVIEW_PENDING: a reviewer seat refused at the meter (PROVIDER_CALL_LIMIT), or one whose
 * investigation ended on the stage's provider-call budget, read as a transient reviewer failure (independent review
 * round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 2.3). `whys` are the failed seats' reasons.
 */
const BUDGET_STOP = /PROVIDER_CALL_LIMIT|the stage's provider-call budget/;
const budgetStopOf = (m, whys, {stage, kept}) => {
  // Only when THIS attempt's budget is what ran out: its meter refused a call, or it has (almost) nothing left.
  const hit = whys.filter(w => BUDGET_STOP.test(w ?? ''));
  if (!hit.length || !(m.refused > 0 || m.left() <= 1)) return null;
  const what = `STAGE_PROVIDER_CALLS: the ${stage} stage's provider-call budget of ${m.limit} was spent (${m.made} made, ${m.refused} refused) before every review was recorded (${hit.join('; ')}); ${kept}`;
  return {blocker: {code: 'STAGE_PROVIDER_CALLS', what, role: 'lead@orch', resume_when: 'the stage is retried, within its attempt bound, with a fresh stage budget; the open cycle is resumed, never reopened', transient: true},
    why: `the ${stage} stage's provider-call budget was spent before its review was complete`};
};
/**
 * THE LEASE FENCE, BEFORE A SHARED SIDE EFFECT (independent review round 2, assignment 3 (Google gemini-4-carbon, manual,
 * 77480d6), finding 4). The work ledger refuses a stale holder's stage record, but a stale plan holder had already
 * closed its cycle on the shared plan ledger and overwritten tickets/<item>.json, invalidating the plan its successor
 * approved; a stale implement or review holder wrote branches and closed the run ledger's cycle. `ctx.fence()` (the
 * scheduler's) throws LEASE_FENCED once the claim is released or past its lease; it is called before each such write.
 */
const fenceOf = ctx => { if (typeof ctx?.fence === 'function') ctx.fence(); };

/**
 * The dirty-copy check: uncommitted changes under the ticket's copy paths, EXCEPT the lifecycle's own ticket files
 * (tickets/<item>.json). The plan stage writes an item's ticket into the checkout uncommitted, by design, and an
 * implement stage checks its own ticket by digest; so with a copy path covering tickets/ (or `.`) ANY item's ticket --
 * another item's plan running concurrently, or this item's own -- failed the check as "uncommitted changes"
 * (independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 3.3). Untracked files
 * are listed one by one (-uall), so an untracked tickets/ directory is not one opaque entry that hides other files.
 */
const dirtyArgs = (top, t, repo) => {
  const tickets = path.relative(top, path.join(repo, 'tickets'));
  return ['status', '--porcelain', '--untracked-files=all', '--', ...t.spec.copy.map(c => path.relative(top, path.join(t.spec.repo_root, c)) || '.'),
    `:(exclude,glob)${tickets}/*.json`];
};

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

/**
 * The implementer's REJECTION path at a difficulty, as the fit matrix states it: the lane's next thinking level first
 * (same base model), and only at its top the next rung of the difficulty's ladder. The pipeline raises the implementer
 * one step along this list per rejection. (hard: carbon-high -> hydrogen-xhigh -> argon-high.)
 */
export function implementerPath(difficulty) {
  const ladder = IMPLEMENTER_LADDERS[difficulty].map(x => x.model), out = [{...IMPLEMENTER_LADDERS[difficulty][0]}];
  for (let next; (next = implementerEscalation(out.at(-1), ladder)) && !out.some(x => x.model === next.model);) out.push({vendor: next.vendor, model: next.model});
  return out;
}

// REVIEW INDEPENDENCE in force for the lifecycle. 'lab' (the rule every recorded cycle was opened under): no reviewer
// from a lab that contributed. 'model' (pantheon.cycle/v3; owner direction 2026-11-17): no reviewer that IS a contributing
// model, three distinct labs still required, a shared lab recorded. 'model' is implemented and tested but NOT ACTIVE:
// it is switched on here, by the owner, after the independent review of the rule change (docs/review-independence.md).
// The service and the CLI take no option for it.
export const REVIEW_INDEPENDENCE = 'lab';
/**
 * The independence rule a lifecycle runs under when the caller names none. Owner direction 2026-11-18: ON (model) for
 * the `fit` profile, whose four-lab pipeline would otherwise leave the post-pipeline three-lab panel short under the lab
 * rule. Other profiles keep REVIEW_INDEPENDENCE. Stage 5, the three-lab change review and the validator are unchanged.
 * The model rule has not yet had the independent review the owner asked for earlier; this is the owner's activation.
 */
export const independenceFor = profile => (profile === 'fit' ? 'model' : REVIEW_INDEPENDENCE);
/**
 * The contributions a run made to the change, as later stages carry them. A turn that asked for one model and was
 * served by another keeps BOTH names (`requested_model`): under model-level independence each is a contributor.
 */
export const workContributions = run => changeScope(run).contributions.map(c => ({purpose: c.purpose, vendor: c.vendor, model: c.model,
  ...(c.requested_model ? {requested_model: c.requested_model} : {}), lab: c.lab, via: c.via}));
const withServed = f => (f.served_model && f.served_model !== f.model ? {served_model: f.served_model} : {});

// --- the executors -------------------------------------------------------------------------------------------
// `profile` defaults to `fit` (owner direction 2026-11-17): the lifecycle routes by the fit matrix
// (pantheon/src/route/fit-matrix.mjs) unless a caller names another profile. Only this default changed; Pantheon's own
// selectSeat and runOpenItem still default to `argo` when called without one.
export function makeExecutors({repo, makeClientFor, turn, n = COORDINATED_LABS, statusRoot = null, stateDir = null, scouts = ['xai'], revisions = undefined,
  seating = undefined, facts = undefined, profile = 'fit', checked = null, progress = () => {}, investigation = {}, bundlesDir = null, independence = undefined,
  pipelineLimits = {}, meteredFailover = true} = {}) {
  independence ??= independenceFor(profile);
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
  // `policy` is given only for a re-review after a reassessment: the corrected identity policy that reassessment used.
  const panel = (contributions, k = n, policy = null) => (byModel ? reviewSeatsByModel({n: k, contributions, ...(policy ? {policy} : {}), ...pool}) : reviewSeats({n: k, avoidLabs: labsOfContribs(contributions), ...pool}));
  /** What a cycle's `change` carries so the ledger opens it under the matching contract. */
  const independenceOf = (contributions, policy = null) => (byModel ? {independence: 'model', contributions, ...(policy ? {identity_policy: policy} : {})} : {});
  const reviewerRow = (role, s) => ({role, ...seatOf(s), ...(s.shared_lab ? {shared_lab: true, shared_with: s.shared_with} : {})});
  const today = () => checked ?? new Date().toISOString().slice(0, 10);
  // The `fit` profile's implement stage is the five-stage pipeline: its plan must carry work units.
  const needsUnits = profile === 'fit';
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
  /**
   * The dossier a bound brief was made with, bound beside it the first time: a resumed cycle's seats were shown THAT
   * dossier, so it is what the record names and what their delivery is counted against, never a rebuilt one
   * (independent review, assignment 1, Google gemini-4-carbon, 09d490f, question 5). Without text: the views, their
   * versions, coverage and requests.
   */
  const boundDossier = (ctx, key, dossier) => {
    const f = path.join(dirOf(ctx, 'briefs'), `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.dossier.json`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({...dossier, entries: dossier.entries.map(({text: _t, ...e}) => e)}) + '\n');
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dossier; }
  };
  /**
   * THE AUTHOR STATE of a plan version under review, bound beside its brief when its cycle opens: the accepted planner's
   * investigation (author_log), the contributions, and the refused tries and earlier versions of the attempt. A stage
   * record carries the same, but an attempt killed mid-cycle leaves none, and its resume lost them (author delivery
   * unknown, earlier contributors and versions dropped) (independent review round 2, assignment 3 (Google
   * gemini-4-carbon, manual, 77480d6), finding 8.3). Written once; read only for the same plan version (by digest).
   */
  const authorFile = (ctx, key) => path.join(dirOf(ctx, 'briefs'), `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.author.json`);
  const bindAuthor = (ctx, key, state) => { const f = authorFile(ctx, key); if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(state) + '\n'); };
  const readBoundAuthor = (ctx, key, planDigest) => {
    try { const a = JSON.parse(fs.readFileSync(authorFile(ctx, key), 'utf8')); return a?.plan_digest === planDigest ? a : null; } catch { return null; }
  };
  /** The dossier bound beside a brief, or null when none was bound (a resume never binds a rebuilt one). */
  const readBoundDossier = (ctx, key) => {
    const f = path.join(dirOf(ctx, 'briefs'), `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.dossier.json`);
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  };
  /**
   * The receiving executor's own check of its handoff (the scheduler checks it before dispatch; a direct caller is
   * checked here): `ctx.upstream` is a record of THIS item on the work ledger and the whole chain under it re-derives
   * (work-ledger.mjs handoffRefusal; question 2). Throws HANDOFF.
   */
  const checkUpstream = (ctx, stage) => {
    const up = ctx.upstream;
    const why = !up ? `${ctx.item}: ${stage} was given no upstream record`
      : up.identity?.item !== ctx.item ? `${ctx.item}: ${stage} was given a record of "${up.identity?.item}"`
      : handoffRefusal(ctx.work, {item: ctx.item, stage, from: up.hash, requirement: ctx.gate?.requirement ? 'sha256:' + digest({item: ctx.gate.requirement.item, title: ctx.gate.requirement.title, basis: ctx.gate.requirement.basis}) : null});
    if (why) throw Object.assign(new Error(`HANDOFF: ${why}`), {code: 'HANDOFF'});
  };

  // ---- plan ----
  async function plan(ctx) {
    const t0 = Date.now(), item = ctx.item, gate = ctx.gate, mode = gate.mode ?? 'author';
    const m = meter(turn, ctx.budget.provider_calls, ctx);
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
    // (Under `fit` this is Stage 1 of the pipeline. It is seated BEFORE any work unit — and so any unit difficulty —
    // exists: the matrix's planner at the default difficulty, not a per-unit seat.)
    // Stage 1 is seated from the ITEM's own declared difficulty and stakes (owner direction 2026-11-18): an existing
    // ticket's `difficulty`/`stakes`/`ambiguity`; an item without a ticket declares none, so it plans at medium, and the
    // record says so. Under `fit` a stakes or ambiguity floor can raise the seat (e.g. critical -> the hard planner),
    // never lower it. Other profiles ignore the task profile.
    const declared = Object.fromEntries(['difficulty', 'stakes', 'ambiguity', 'depth'].filter(k => ticket?.spec?.[k] !== undefined).map(k => [k, ticket.spec[k]]));
    let planTask;
    try { planTask = taskProfile(declared); } catch { planTask = taskProfile({}); }
    const pick = selectSeat('planner', {profile, difficulty: declared.difficulty ?? 'medium', task: planTask, needsContext: 1, pools: readPools()}).seat;
    const plannerTier = {declared, source: ticket ? (Object.keys(declared).length ? 'ticket' : 'ticket declares none: medium') : 'no ticket: medium'};
    const planner = {...seatOf(pick), selection: {source: pick.selection?.source ?? null, reason: pick.selection?.reason ?? 'the policy\'s first planner candidate', tier: plannerTier}};
    // The tier the planner was seated at, and why, is on the record (question 4): seatOf keeps only the identity.
    const plannerOut = {...seatOf(planner), selection: planner.selection};
    const team = [{role: 'planner', ...seatOf(planner), tier: plannerTier}];
    // Review capacity BEFORE work: the plan needs n reviewer labs outside the planner's.
    // Independence follows contributions (review/scope.mjs): a revision consumes the plan it revises and the findings
    // it answers, so the labs behind those may not review it. A revised plan keeps the lineage of what it revises,
    // the previous planner included: the revision consumes its plan (independent review, assignment 2, question 6).
    const inherited = mode === 'revise' ? [...(prevRec?.contributions ?? []),
      ...(gate.findings ?? []).filter(f => f.lab).map(f => ({purpose: 'critique', vendor: f.vendor ?? null, model: f.model ?? null, ...withServed(f), lab: f.lab, via: `finding ${String(f.id).slice(0, 19)} returned to planning reached the revised plan`}))] : [];
    let planSeats;
    const corrected = gate.rereview?.policy_rules ?? null;
    try { planSeats = panel([{purpose: 'plan', ...seatOf(planner)}, ...inherited], n, corrected); } catch (e) {
      if (e.code !== 'NO_SEATS') throw e;
      return result('pending', {outputs: {mode, planner: plannerOut, stage: 'before-work'}, team, usage: {provider_calls: 0, elapsed_ms: Date.now() - t0},
        blocker: pendingCapacity(`the configured reviewer pool offers fewer than ${n} labs outside the planner's (${planner.lab}); nothing was planned`, {stage: 'plan'}),
        next: {stage: 'plan', why: 'plan review capacity is short'}});
    }
    // `built` is the dossier a planner answering in THIS attempt is shown. `dossier` is the one the version under review
    // was made and reviewed with: `built` for a version planned now, and for a resumed cycle the dossier bound with its
    // brief when it opened (independent review, assignment 1, Google gemini-4-carbon, 09d490f, question 5).
    const {dossier: built, retriever} = evidenceFor(ctx);
    let dossier = built;
    const investigations = Object.assign([], {dossier});
    // What the planner was given only in part stays an unresolved gap on the record, with the request that continues it.
    // It is what the planner that wrote the CURRENT version was given: that answer's own investigation, never the
    // retrievals of a refused try or an earlier version, whose prompts the author of this one never saw (question 6).
    // A resumed cycle restores it from the attempt that opened the cycle; when that record does not have it, what the
    // author was given beyond the dossier is unknown, and the record says so instead of counting the dossier alone.
    let authorLog = null, authorUnknown = null;
    const plannerGot = () => deliveryOf(dossier, authorLog ?? {requests: []});
    const ctxOut = () => ({dossier: dossierRecord(dossier), investigations: [...investigations], unresolved: gapsOf(plannerGot()),
      ...(authorLog ? {author_log: authorLog} : {}),
      ...(authorUnknown ? {author_delivery: {known: false, complete: false, why: authorUnknown}} : {})});
    // The cause of a finding as far as the record can tell: with the author's own investigation unknown, a source the
    // dossier did not deliver in full may have been retrieved, so the record cannot say it was not delivered.
    const authorCause = (file, got, doc) => {
      const c = causeOf(file, got, doc);
      return authorUnknown && ['evidence-not-delivered', 'evidence-partly-delivered'].includes(c.cause)
        ? {cause: 'undetermined', why: `${c.why}, as far as the record shows; what the accepted planner was given is not fully on record (${authorUnknown})`} : c;
    };
    // The plan ledger is the REQUIREMENT's: an open cycle is resumed only for the requirement it was opened for. A changed
    // requirement is planned afresh on its own ledger, never finished on the old plan (question 1).
    const planLedger = dirOf(ctx, `plan-ledger-${digest({item, title: gate.requirement?.title ?? null, basis: gate.requirement?.basis ?? null}).slice(0, 16)}`);
    const sys = openPantheonLedger({root: planLedger});
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
      // The lineage of the plan under review is what the attempt that opened this cycle recorded: earlier plan-review
      // finders and a served-model override are not re-derivable from a fresh planner seat (independent review,
      // assignment 1, question 3). Restored from that attempt's stage record, and from the cycle's own contributors.
      const opened = [...ctx.work.stages(item)].reverse().find(s => s.stage === 'plan' && s.outputs?.cycle === open.hash);
      contributions.push(...(opened?.contributions ?? []), ...(st.cycle.contributors ?? []).map(c => ({purpose: 'plan-lineage', vendor: c.vendor, model: c.model,
        lab: c.model ? labOf(c.vendor, c.model) : c.lab ?? null, via: `recorded on the open plan cycle ${open.hash.slice(0, 19)}`})));
      contributions.splice(0, contributions.length, ...dedupe(contributions));
      // The evidence of the version under review is what ITS reviewers and author were given (questions 5 and 6): the
      // dossier bound with the cycle's brief (else the one the opening attempt recorded), and the accepted planner's own
      // investigation as that attempt recorded it.
      const sameDoc = opened?.outputs?.plan_digest === 'sha256:' + digest(resume.doc);
      const recordedDossier = sameDoc && plain(opened.outputs.context?.dossier) ? {...opened.outputs.context.dossier,
        entries: (opened.outputs.context.dossier.entries ?? []).map(e => ({id: e.id, kind: e.kind, source: e.source, version: e.version, coverage: {complete: e.complete !== false}}))} : null;
      const servedDossier = readBoundDossier(ctx, `plan|${resume.base}|${resume.head}`) ?? recordedDossier;
      if (servedDossier) dossier = servedDossier;
      const recorded = sameDoc ? opened.outputs.context ?? {} : {};
      const lastPlanner = (recorded.investigations ?? []).filter(x => x.role === 'planner').at(-1);
      authorLog = recorded.author_log ?? (lastPlanner ? {requests: lastPlanner.requests ?? []} : null);
      // No record of the opening attempt (it was killed before its stage record): the author state bound when the cycle
      // opened restores what that record would have carried (finding 8.3, above).
      const bound = sameDoc ? null : readBoundAuthor(ctx, `plan|${resume.base}|${resume.head}`, 'sha256:' + digest(resume.doc));
      if (bound) {
        authorLog = bound.author_log ?? authorLog;
        contributions.push(...(bound.contributions ?? []));
        contributions.splice(0, contributions.length, ...dedupe(contributions));
        refused.push(...(bound.refused ?? []));
        versions.push(...(bound.versions ?? []));
      }
      if (!authorLog) authorUnknown = !opened ? `no stage record of the attempt that opened plan cycle ${open.hash.slice(0, 19)}`
        : !sameDoc ? `the record of the attempt that opened plan cycle ${open.hash.slice(0, 19)} is of another plan version`
        : `the record of the attempt that opened plan cycle ${open.hash.slice(0, 19)} does not carry the planner's investigation`;
      if (!servedDossier) authorUnknown ??= `no dossier is bound to plan cycle ${open.hash.slice(0, 19)}; the dossier recorded is rebuilt`;
      investigations.dossier = dossier;
    }
    for (let v = 1; v <= PLAN_VERSIONS; v++) {
      // 1. The planner writes the plan; a malformed answer is refused and retried within budget.
      let doc = resume?.doc ?? null, turnHash = null;
      if (resume && m.left() < n) return stop(`stage budget: ${m.left()} provider call(s) left, the plan review needs up to ${n}`);
      for (let k = 0; k < PLANNER_TRIES && !doc; k++) {
        if (m.left() < 1 + n) return stop(`stage budget: ${m.left()} provider call(s) left, a plan and its review need ${1 + n}`);
        const first = plannerPrompt({mode, requirement: gate.requirement, deps, ticket: ticket?.ticket ?? null, previous: prevDoc, findings,
          refusals: refused.filter(r => r.version === v).flatMap(r => r.why), dossier: built, limits: INV, units: needsUnits});
        let reply, prompt = first, inv = null;
        try {
          // The planner investigates before it answers: each retrieval round is a counted call, and the review's calls are kept in reserve.
          const r = await investigate({prompt: first, retriever, canAsk: () => m.left() > n + 1, ask: p => m.turn({vendor: planner.vendor, model: planner.model, prompt: p, seat: {...planner, role: 'planner'}})});
          reply = r.reply; prompt = r.prompt; inv = r.log;
          investigations.push({role: 'planner', ...seatOf(planner), version: v, try: k + 1, ...r.log, unresolved: gapsOf(deliveryOf(built, r.log))});
          // The model that actually answered is a contributor too, when it is not the one asked for.
          if (reply?.served_model && reply.served_model !== planner.model && !contributions.some(c => c.purpose === 'plan' && c.model === reply.served_model)) {
            contributions.push({purpose: 'plan', vendor: planner.vendor, model: reply.served_model, ...(reply.served_model_source ? {served_model_source: reply.served_model_source} : {}), lab: labOf(planner.vendor, reply.served_model), via: 'served the planner\'s turn'});
          }
        } catch (e) { refused.push({version: v, try: k + 1, why: [`the planner call failed: ${e.message}`]}); continue; }
        if (!reply) { refused.push({version: v, try: k + 1, why: [`no plan within the investigation bounds (${inv.limit_reached})`]}); continue; }
        const text = reply?.text ?? '';
        const j = jsonOf(text);
        // The planner judged the evidence insufficient: no plan is forced. Its gaps are kept and the item waits.
        if (plain(j?.insufficient)) {
          const gaps = (Array.isArray(j.insufficient.gaps) ? j.insufficient.gaps : []).map(String), needed = (Array.isArray(j.insufficient.needed) ? j.insufficient.needed : []).map(String);
          return result('blocked', {outputs: {mode, insufficient: {gaps, needed}, refused, versions, context: ctxOut(), planner: plannerOut}, team, contributions, usage: usage(),
            findings: gaps.map((g, i) => ({id: `gap-${i + 1}`, severity: 'block', cause: 'missing-evidence', text: g, lab: planner.lab})),
            blocker: {code: 'EVIDENCE_INSUFFICIENT', what: `EVIDENCE_INSUFFICIENT: the planner could not establish the problem from the evidence it was given or could retrieve (${gaps.join('; ') || 'no gap named'})`,
              role: 'lead@orch', resume_when: `the evidence changes (${needed.join('; ') || 'the missing records become retrievable'}), or the owner raises the investigation limits`},
            next: {stage: 'plan', why: 'the evidence does not yet support a plan'}});
        }
        const delivered = deliveryOf(built, inv);
        const why = planRefusal(j, {delivered, depends_on: Object.keys(deps), mode, ticket: ticket?.ticket ?? null, findings, repo, item, workUnits: needsUnits ? 'required' : 'optional'});
        progress({event: 'plan.answer', item, version: v, try: k + 1, refused: why.length});
        if (why.length) { refused.push({version: v, try: k + 1, why}); continue; }
        turnHash = rec.recordTurn({seat: {seat_id: `${planner.vendor}-plan@${planner.model}`, vendor: planner.vendor, mode: 'operate-plan', occupancy_gen: 1},
          requested_model: planner.model, served_model: reply.served_model ?? null, served_model_source: reply.served_model_source ?? null, response_id: reply.response_id ?? null, reply: text, purpose: 'plan', prompt});
        const bytesOf = bytesOfRepo(repo);
        // This version's author and reviewers are given `built`: it is the dossier on the record from here on.
        authorLog = inv; authorUnknown = null; dossier = built; investigations.dossier = built;
        // Every source the plan rests on, bound to the bytes the planner was GIVEN (got.version, the digest of the
        // delivered view), not to the disk after the turn: the cited evidence, the sources of each examined
        // investigation, the relevance it used, and the copy files the work reads (a copy file never delivered is
        // bound to its bytes at this answer). The item's own ticket is bound by its digest instead (questions 1 and 5).
        const bindRef = (r, why) => {
          const ref = refOf(r), got = delivered.get(ref);
          const file = got ? (got.source?.startsWith('file:') ? got.source.slice(5) : null) : ref.startsWith('file:') ? ref.slice(5) : null;
          if (file === `tickets/${item}.json`) return null;
          if (!got) return file ? {path: file, sha256: bytesOf(file), why, via: 'not-delivered'} : null;
          return file ? {path: file, sha256: got.version ?? null, why, via: got.via, complete: got.complete}
            : {ref, source: got.source, version: got.version ?? null, ...(got.request ? {request: got.request} : {}), why, via: got.via, complete: got.complete};
        };
        const bound = [...Object.entries(plain(j.investigation) ? j.investigation : {}).flatMap(([q, a]) => (a?.examined && Array.isArray(a.sources) ? a.sources.map(x => bindRef(x, `investigation.${q}`)) : [])),
          ...(Array.isArray(j.relevance) ? j.relevance.filter(x => x?.decision === 'used').map(x => bindRef(x.ref, 'relevance: used')) : []),
          ...(Array.isArray(j.copy) ? j.copy.map(c => bindRef(c, 'copy: read by the work')) : [])].filter(Boolean);
        doc = {schema: PLAN_SCHEMA, item, mode, requirement: gate.requirement, ...j,
          // Each citation with how it reached the planner (supplied, retrieved) and its version: a citation of
          // something never delivered was refused above.
          evidence: j.evidence.map(e => {
            const ref = refOf(e.ref ?? e.path), got = delivered.get(ref);
            const file = got.source?.startsWith('file:') ? got.source.slice(5) : null;
            // Which bytes of which version reached the planner: a partly delivered source stays partial on the record.
            const part = {via: got.via, complete: got.complete, portions: got.portions, total: got.total};
            return file ? {path: file, sha256: got.version ?? null, why: e.why, ...part}
              : {ref, source: got.source, version: got.version ?? null, ...(got.request ? {request: got.request} : {}), why: e.why, ...part};
          }),
          bound_sources: [...new Map(bound.map(x => [x.path ? `file:${x.path}` : x.source, x])).values()],
          version: {n: versions.length + 1, previous: prevDigest},
          // A plan made again because a reassessment disqualified its earlier review names that reassessment.
          ...(gate.rereview ? {rereview_of: gate.rereview.reassessment} : {})};
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
      // The dossier the brief is made with is bound beside it, so a resumed cycle records what its seats were shown.
      if (!resume) {
        boundDossier(ctx, `plan|${base}|${head}`, built);
        bindAuthor(ctx, `plan|${base}|${head}`, {plan_digest: planDigest, author_log: authorLog, contributions: dedupe(contributions), refused, versions});
      }
      const r = await reviewCycle({ledger: rec, resume: Boolean(resume), change: {scope, base, head, diff, files: [file], author_labs: resume?.author_labs ?? labsOfContribs(contributions),
        author_turns: resume?.author_turns ?? [turnHash], ...(resume ? {} : independenceOf(dedupe(contributions), corrected))}, seats: planSeats, n,
        // The reviewers get the evidence itself, not only the planner's account of it, and may retrieve more.
        turn: investigatingTurn(m, retriever, investigations, 'plan-reviewer'),
        brief: boundBrief(ctx, `plan|${base}|${head}`, () => [PLAN_BRIEF, '', renderDossier(built), '',
          `## What the planner retrieved beyond the dossier: ${(authorLog?.requests ?? []).map(q => `${JSON.stringify(q.request)} -> ${q.ok ? 'delivered' : `FAILED ${q.error}`}`).join('; ') || '(nothing)'}`,
          '', RETRIEVAL_HELP(INV)].join('\n'))});
      resume = null;
      const state = rec.cycleState(r.cycle);
      const version = {n: doc.version.n, digest: planDigest, commit: head, cycle: r.cycle, reviews: state.reviews.map(x => ({lab: x.lab, verdict: x.verdict}))};
      versions.push(version);
      if (state.reviews.length < n) {
        const stopped = budgetStopOf(m, r.failed.map(f => f.why), {stage: 'plan', kept: 'the plan and its open cycle are kept'});
        return result('pending', {outputs: {mode, plan: doc, plan_digest: planDigest, refused, versions, cycle: r.cycle, plan_ledger: sys.root ?? planLedger, plan_ledger_anchor: sys.anchor, context: ctxOut()},
          team: [...team, ...planSeats.map(s => reviewerRow('plan-reviewer', s))], contributions, usage: usage(),
          blocker: stopped?.blocker ?? {what: `REVIEW_PENDING: ${r.failed.length} plan reviewer seat(s) failed (${r.failed.map(f => `${f.lab}: ${f.why}`).join('; ')}); the plan and its open cycle are kept`,
            role: 'check@review', resume_when: 'the reviewer is available; the open plan cycle is resumed, never reopened', transient: true},
          next: {stage: 'plan', why: stopped?.why ?? 'plan review incomplete'}});
      }
      // Each finding with what the record shows about its cause: did the source it is about ever reach the planner?
      const authorGot = plannerGot();
      const rows = findingRows(state).map(f => ({...f, ...authorCause(f.file, authorGot, doc)}));
      const blocking = rows.filter(f => BLOCKING.has(f.severity));
      const changes = state.reviews.some(x => x.verdict === 'request_changes');
      if (!blocking.length && !changes) {
        // Approved: non-blocking findings are deferred on the record and carried as unresolved.
        fenceOf(ctx);   // the lease still holds before the shared ledger and the ticket are written (finding 4)
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
        // What the plan rests on, for planValidity (gates.mjs): every file it cites or reads, by the digest of the bytes
        // the planner was given, and every other cited view with its version and the request that re-reads it.
        const evidence = [...new Map([...doc.evidence, ...(doc.bound_sources ?? [])].filter(e => e.path !== `tickets/${item}.json`)
          .map(e => (e.path ? {path: e.path, sha256: e.sha256} : {ref: e.ref, source: e.source, version: e.version, ...(e.request ? {request: e.request} : {})}))
          .map(e => [e.path ? `file:${e.path}` : e.source, e])).values()];
        return result('passed', {identity: {ticket: {path: tk.path, digest: tk.digest}}, inputs: {mode, plan_previous: prevDigest},
          outputs: {plan: doc, plan_digest: planDigest, plan_commit: head, plan_ledger: sys.root ?? planLedger, plan_review: {cycle: r.cycle, labs: closed.labs, close: closed.close, outcome: closed.outcome,
            unresolved: rows, ledger_anchor: sys.anchor, independence, shared_labs: planSeats.filter(x => x.shared_lab).map(x => x.lab).sort()}, ticket: {path: tk.path, digest: tk.digest}, ...(ticketRevision ? {ticket_revision: ticketRevision} : {}),
            ...(mode === 'revalidate' ? {ticket_kept: ticketRevision === null && Boolean(ticket)} : {}), deps, evidence, refused, versions, planner: plannerOut,
            context: ctxOut(), carry: carryForward(doc, planDigest)},
          team: [...team, ...planSeats.map(s => reviewerRow('plan-reviewer', s))], contributions: dedupe(contributions), findings: rows, usage: usage(),
          next: {stage: 'implement', why: `plan v${doc.version.n} approved by ${closed.labs.join(', ')}`}});
      }
      // 4. Findings: the version is not approved. Its findings are answered by a revision, re-reviewed in its own cycle.
      fenceOf(ctx);   // finding 4
      for (const f of state.findings) rec.deferFinding({finding: f.hash, reason: `answered by a revision of plan ${planDigest.slice(0, 19)}; the revision is re-reviewed in its own cycle`});
      const closed = closeWith(rec, r.cycle, `plan review of ${item}`);
      if (closed.why) return stop(`the plan cycle cannot close: ${closed.why}`);
      for (const f of rows) contributions.push({purpose: 'plan-review', vendor: f.vendor, model: f.model, ...withServed(f), lab: f.lab, via: `plan finding ${f.id.slice(0, 19)} reached the revised plan`});
      findings = rows.map(f => ({id: f.id, severity: f.severity, text: f.text, lab: f.lab, cause: f.cause}));
      prevDoc = doc; prevDigest = planDigest;
      progress({event: 'plan.revise', item, version: v, findings: rows.length});
      // The revision will carry these findings: its reviewers must be outside the labs that made them. Checked BEFORE
      // the revision is paid for; a short pool keeps the reviewed version and its findings, and waits.
      try { planSeats = panel(dedupe(contributions), n, corrected); } catch (e) {
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
    checkUpstream(ctx, 'implement');
    const t0 = Date.now(), item = ctx.item, planRec = ctx.upstream;
    const usage = calls => ({provider_calls: calls, elapsed_ms: Date.now() - t0});
    const t = readTicket({repo, item});
    if (t.why || t.digest !== planRec.outputs.ticket?.digest) {
      return result('returned', {outputs: {why: t.why ?? 'ticket changed'}, next: {stage: 'plan', why: `the approved ticket is ${t.why ? `invalid (${t.why})` : 'not the bytes the plan approved'}`}});
    }
    const critiques = ctx.gate.mode === 'revise' ? (ctx.gate.findings ?? []) : [];
    const contributions = dedupe([...(planRec.contributions ?? []),
      ...critiques.filter(f => f.lab).map(f => ({purpose: 'critique', vendor: f.vendor ?? null, model: f.model ?? null, ...withServed(f), lab: f.lab, via: `finding ${String(f.id).slice(0, 19)} was fed to this revision`}))]);
    // `fit` with a plan that carries work units: the five-stage pipeline. (A plan record without them — one approved
    // before the plan carried units, or under another profile — keeps the per-file path below.)
    if (needsUnits && Array.isArray(planRec.outputs.plan?.work_units)) return implementUnits(ctx, {t, t0, critiques, contributions});
    // Review capacity BEFORE work: the change will need n labs outside every contributor, the predicted workers included.
    const predicted = seatTeam({pools: readPools(), spec: t.spec, profile, planTitle: 'ticket'});
    const predictedWork = [...new Map(predicted.implementers.map(l => [l[0].lab, {purpose: 'work', vendor: l[0].vendor, model: l[0].model, lab: l[0].lab}])).values()];
    const cap = cycleReviewers({scope: fullScope(null, [...contributions, ...predictedWork]), n, ...pool, independence});
    if (cap.pending) {
      return result('pending', {outputs: {stage: 'before-work', predicted_contributors: cap.scope.contributions, ticket: {path: t.path, digest: t.digest}}, contributions,
        usage: usage(0), blocker: pendingCapacity(cap.pending.why, {stage: 'implement'}), next: {stage: 'implement', why: 'review capacity is short; no work was launched'}});
    }
    const top = git(repo)(['rev-parse', '--show-toplevel']).trim(), G = git(top);
    const dirty = G(dirtyArgs(top, t, repo)).trim();
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
      // The bound is THIS ATTEMPT'S stage budget: on a resume runOpenItem counts an operator-given bound from the resume
      // (basis "operator", counted_from = the attempts already recorded), so callsBefore + budget let one attempt make
      // callsBefore + budget NEW calls; and every call is charged on the work ledger before it is made (independent review
      // round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 1.3).
      res = await runOpenItem(spec, {dir: boardDir, makeClientFor, planTitle: 'ticket', maxProviderCalls: ctx.budget.provider_calls, scouts, profile,
        ...(typeof ctx.charge === 'function' ? {onCharge: () => ctx.charge(1)} : {}),
        // The run's metered-failover switch reaches runOpenItem's walks too (finding 6).
        meteredFailover,
        // A checker's rejection at the top of the worker's dial is a revision by the same seat, not a stop (protocol v2).
        escalation: 'pantheon.escalation/v2',
        // The in-run checker follows the same independence rule as the rest of the lifecycle.
        ...(byModel ? {independence: 'model'} : {}),
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
      // THE REJECTED WORK AND ITS FINDINGS ARE KEPT. The board (the bytes, the reviewers' findings, the escalation
      // decisions) stays where it is, and the record names every in-run finding met so far on this plan, with the
      // reviewer that made it: earlier attempts' and this one's.
      const pend = (run?.files ?? []).map(x => x.escalation?.pending).filter(x => x?.reason === 'review');
      const keyOf = x => `${x.vendor}|${x.model}|${x.text}`;
      const before = [...new Map(ctx.work.stages(item).filter(x => x.stage === 'implement' && x.handoff?.from === planRec.hash).flatMap(x => x.findings ?? [])
        .filter(x => x.cause === 'in-run-review').map(x => [keyOf(x), x])).values()];
      const seen = new Set(before.map(keyOf));
      const fresh = pend.flatMap(x => (x.reviewers?.length ? x.reviewers : [{vendor: null, model: null}]).map(r => ({text: x.findings, vendor: r.vendor ?? null, model: r.model ?? null, lab: r.vendor ? labOf(r.vendor, r.model) : null})))
        .filter(x => !seen.has(`${x.vendor}|${x.model}|${x.text}`));
      const findings = [...before.map(({id, ...x}) => x), ...fresh.map(x => ({severity: 'block', cause: 'in-run-review', ...x}))].map((x, i) => ({id: `inrun-${i + 1}`, ...x}));
      const outputs = {board: boardDir, shipped: false, ...(resumable ? {resumed: true, resumed_from: prior.hash} : {}), pending_revision: pend.length > 0, error: res.error ?? null,
        escalations: (run?.escalations ?? []).filter(e => e.decision).map(e => ({protocol: e.schema, action: e.decision.action, steps: e.steps})),
        tests: run?.acceptance ? {cmd: run.acceptance.cmd, exit: run.acceptance.exit} : null};
      // No further revision is possible in this run: every slot is stopped (the escalation or revision budget is spent),
      // or no reviewer is left that may judge the revised bytes. That is a BLOCK with the findings unresolved -- not a
      // failure to retry from scratch, which would repeat the work and drop the feedback.
      const message = String(res.error?.message ?? '');
      const noReviewer = /no clean reviewer|no reviewer model is left|REVIEW_LABS_UNAVAILABLE|REVIEW_NOT_ADMITTED/.test(message);
      const stopped = (run?.files ?? []).filter(x => x.escalation?.stopped).map(x => `${x.slot}: ${x.escalation.stopped.why}`);
      if ((noReviewer || stopped.length) && !pend.length) {
        const why = noReviewer ? `no in-run reviewer is eligible for the revised work (${message.slice(0, 200)})` : `the run stopped (${stopped.join('; ').slice(0, 200)})`;
        return result('blocked', {outputs, team, contributions, findings, usage: usage(calls),
          blocker: {code: 'IN_RUN_REVIEW_UNRESOLVED', what: `IN_RUN_REVIEW_UNRESOLVED: ${why}; ${findings.length} in-run finding(s) are unresolved; the run and its work are kept`,
            role: 'lead@orch', resume_when: 'a reviewer that did not contribute becomes eligible, or the owner lifts the stop with a stated reason or reseats the work'},
          next: {stage: 'implement', why}});
      }
      return result('failed', {outputs, findings,
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
    fenceOf(ctx);   // the lease still holds before the shipped branch is written (finding 4)
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

  // ---- implement, under `fit`: the five-stage specialist pipeline over the plan's work units ----
  //
  //   Stage 1  plan        the plan stage above (Claude, read-only): `work_units`, reviewed by three labs with the plan
  //   Stage 2  dispatch    an OpenAI dispatcher per unit (matrix: by the unit's difficulty) + the deterministic controller
  //   Stage 3  implement   an Antigravity lane per unit, in the unit's own worktree, behind the write jail
  //   Stage 4  subagents   Grok, one stateless question at a time, over the unit's A2A shim
  //   Stage 5  review      the dispatcher's exact model, pinned; escalates only inside OpenAI
  //   then                 the integrated tree is committed on pantheon/<item> and handed to the SAME coordinated
  //                        three-lab change review, validator and outcome as every other implement stage.
  //
  // ============================================================================================================
  // OWNER GOVERNANCE DECISION 2026-11-17 — FLAGGED FOR INDEPENDENT REVIEW.
  // Stage 2 (the dispatcher) is a NON-AUTHORING ARBITER. It writes the acceptance rubric of a unit and none of the
  // work, and it is recorded in `outputs.arbiters` and in `team` (role `dispatcher`, `authored: false`) — NOT in
  // `contributions`. The reason is the pin: Stage 5 is the SAME OpenAI model as Stage 2, and under model-level review
  // independence a contributing model may not review. If the dispatcher were a contributor, its pinned reviewer
  // would be barred from the unit it must review. This is the owner's decision, not a consequence of the code; a
  // reader who holds that writing the criteria a change is judged by IS a contribution will disagree, and
  // `[...contributions, ...outputs.arbiters]` is the stricter list to evaluate that position against.
  // What is NOT relaxed: a Stage 5 reviewer whose FINDING was fed to an implementer revision IS a `critique`
  // contributor (the existing rule of this repository) and is excluded from the later three-lab review and from
  // validating; a Stage 5 reviewer that only approved is not a contributor.
  // DECISION 6 (owner, 2026-11-19; docs/review-independence.md): the exception is SCOPED to the pinned Stage 5 review of
  // the dispatcher's own unit, with that unit's bounded revision sequence. The dispatcher stays a non-authoring arbiter
  // (still absent from contributionsOf), but its requested and serving identities are EXCLUDED from the later three-lab
  // change review and from the validator whenever its rubric governed a unit of the change: `purpose: 'arbiter'` rows
  // (arbiterExclusions) ride with this stage's contributions, are recorded as the cycle's contributors, and are checked
  // at seat selection and at answer admission. A Stage 5 reviewer that is the dispatcher's model and only approved is
  // therefore excluded later too. A different model of the same lab stays eligible; no capacity is pending, never a
  // fallback. "Permission to judge whether one's own rubric was followed does not grant independence to judge whether
  // that rubric was sufficient."
  // ============================================================================================================
  //
  // Stage 5 is the IN-RUN reviewer. It replaces neither the coordinated three-lab change review nor the validator:
  // both run after this stage, unchanged, on the commit it hands over.
  async function implementUnits(ctx, {t, t0, critiques, contributions}) {
    const item = ctx.item, planRec = ctx.upstream, planDoc = planRec.outputs.plan;
    const usage = calls => ({provider_calls: calls, elapsed_ms: Date.now() - t0});
    const ticketOut = {path: t.path, digest: t.digest};
    const toPlan = (why, findings = [], extra = {}) => result('returned', {outputs: {why, ...extra}, findings, contributions, usage: usage(extra.calls ?? 0), next: {stage: 'plan', why}});
    const v = validateWorkUnits({work_units: planDoc.work_units});
    if (!v.ok) return toPlan(`the plan's work units are refused: ${v.refusals.map(r => r.message).join('; ')}`.slice(0, 600),
      v.refusals.map((r, i) => ({id: `units-${i + 1}`, severity: 'block', cause: 'inadequate-plan', text: `[${r.code}] ${r.message}`})));
    // Review capacity BEFORE work. The predicted contributors are the matrix's: each unit's implementer (the lane the
    // matrix starts it on; its base model is what counts) and, where the unit allows subagents, its subagent model.
    // The dispatcher is an arbiter and is not predicted as a contributor (the decision above).
    // The dispatcher is not a contributor, but it IS excluded from the later review and the validator (Decision 6,
    // owner 2026-11-19), so the capacity check predicts it as an arbiter.
    const predicted = dedupe(v.units.flatMap(u => [{purpose: 'work', ...seatOf(IMPLEMENTER_LADDERS[u.difficulty][0])},
      ...(u.allowed_subagents.length ? [{purpose: 'subtask', ...seatOf(fitMatrix('subagent', u.difficulty))}] : []),
      {purpose: 'arbiter', ...seatOf(fitMatrix('dispatcher', u.difficulty))}]));
    const cap = cycleReviewers({scope: fullScope(null, [...contributions, ...predicted]), n, ...pool, independence});
    if (cap.pending) {
      return result('pending', {outputs: {stage: 'before-work', predicted_contributors: cap.scope.contributions, ticket: ticketOut}, contributions,
        usage: usage(0), blocker: pendingCapacity(cap.pending.why, {stage: 'implement'}), next: {stage: 'implement', why: 'review capacity is short; no work was launched'}});
    }
    const top = (await gitAsync(repo, ['rev-parse', '--show-toplevel'])).trim();
    // A unit's owned paths and verify_cmd are relative to the root of the git repository the worktrees are made from.
    if (fs.realpathSync(repo) !== fs.realpathSync(top)) return result('failed', {outputs: {repo, top}, contributions, next: {stage: 'implement', why: `work units are relative to the repository root (${top}); the lifecycle's repository is a subdirectory of it`}});
    const dirty = (await gitAsync(top, dirtyArgs(top, t, repo))).trim();
    if (dirty) return result('failed', {outputs: {dirty}, next: {stage: 'implement', why: 'the ticket\'s copy paths have uncommitted changes'}});
    const base = (await gitAsync(top, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    // What the reviewed plan excludes, and the findings a revision must answer, reach every stage of the pipeline the
    // only way a unit carries a constraint: as invariants (the dispatcher's rubric must cover each; the implementer and
    // the reviewer are shown them). The planned units are unchanged on the plan record; what ran is in the run record.
    const carried = [...(planDoc.exclusions ?? []).map(x => `Out of scope in the reviewed plan: ${x}`),
      ...critiques.map(f => `Fix ${String(f.id).slice(0, 19)} [${f.severity}${f.cause ? `, ${f.cause}` : ''}]: ${f.text}`)];
    const units = v.units.map(u => ({...u, invariants: [...u.invariants, ...carried.filter(c => !u.invariants.includes(c))]}));
    const dir = dirOf(ctx, `pipeline-${ctx.attempt}-${Date.now()}`);
    const recordFile = path.join(dir, 'pipeline.json');
    // ACROSS ATTEMPTS (independent review, assignment 3, question 8). Approved units persist in ONE checkpoint directory
    // per item, so a later attempt (a restart after a kill, a retry) resumes them instead of paying for them again;
    // the pipeline re-verifies each checkpoint (patch, tree, verify_cmd) before it trusts it. And the in-run findings
    // of an INTERRUPTED attempt on this plan (a pipeline directory no implement record names: its process died before
    // its stage record) are carried into this attempt's record, marked with the run they came from, not dropped.
    const checkpointDir = dirOf(ctx, 'checkpoints');
    fs.writeFileSync(path.join(dir, 'attempt.json'), JSON.stringify({item, attempt: ctx.attempt, plan_record: planRec.hash, claim: ctx.claim ?? null}) + '\n');
    const recordedRuns = new Set(ctx.work.stages(item).filter(x => x.stage === 'implement').flatMap(x => [x.outputs?.run?.dir, ...(x.outputs?.carried_runs ?? []).map(r => r.dir)]).filter(Boolean));
    const itemDir = path.dirname(dir), carriedRuns = [], carriedFindings = [], recovered = [];
    for (const name of fs.readdirSync(itemDir).filter(x => /^pipeline-/.test(x)).sort()) {
      const d = path.join(itemDir, name);
      if (d === dir) continue;
      // An earlier attempt's run that no live process holds: the worktrees its process left registered (it was
      // killed before its `finally`) are removed, so they neither pile up nor interfere (independent review,
      // assignment 3 (xAI grok-4.7, 09d490f), question 8).
      if (!liveOwner(d)) recovered.push(...await recoverOrphanWorktrees({repo: top, root: path.join(d, 'worktrees')}));
      if (recordedRuns.has(d)) continue;
      let marker, rec;
      try { marker = JSON.parse(fs.readFileSync(path.join(d, 'attempt.json'), 'utf8')); rec = JSON.parse(fs.readFileSync(path.join(d, 'pipeline.json'), 'utf8')); } catch { continue; }
      if (marker.plan_record !== planRec.hash) continue;
      // A Stage 5 review that did not approve carries its feedback even when the kill came before that feedback was
      // copied into the unit's findings (a record written before the two were saved together): it is read from the
      // review itself, unless the findings already hold that attempt's (independent review, assignment 3 (xAI
      // grok-4.7, 09d490f), question 8).
      const reviewRows = u => (u.reviews ?? []).filter(r => r && ['request_changes', 'approve_refused'].includes(r.status) && Array.isArray(r.feedback) && r.feedback.length
        && !(u.findings ?? []).some(f => f.attempt === (r.n ?? null) && f.code === r.status))
        .map(r => ({attempt: r.n ?? null, source: r.status === 'request_changes' ? 'reviewer' : 'controller', code: r.status, vendor: r.vendor ?? null, model: r.model ?? null, findings: r.feedback}));
      const rows = Object.values(rec.units ?? {}).flatMap(u => [...(u.findings ?? []), ...reviewRows(u)].flatMap(f => (f.findings ?? []).map(text => ({severity: 'block', cause: f.source === 'reviewer' ? 'in-run-review' : 'in-run-controller',
        unit: u.unit_id, attempt: f.attempt, code: f.code ?? null, text, vendor: f.source === 'reviewer' ? f.vendor ?? null : null, model: f.source === 'reviewer' ? f.model ?? null : null,
        lab: f.source === 'reviewer' && f.vendor ? labOf(f.vendor, f.model) : null, carried_from: {run_id: rec.run_id ?? null, record: path.join(d, 'pipeline.json'), attempt: marker.attempt}}))));
      carriedRuns.push({dir: d, run_id: rec.run_id ?? null, attempt: marker.attempt, status: rec.status ?? null, findings: rows.length});
      carriedFindings.push(...rows);
    }
    // ...and the findings an EARLIER attempt on this plan carried from such a run stay carried. That attempt's record
    // names the killed run in carried_runs (so the scan above skips it); when that attempt did not pass, its carried
    // findings were dropped by the next one (independent review round 2, assignment 3 (Google gemini-4-carbon, manual,
    // 77480d6), finding 8.2). They are taken from the record, once each.
    {
      const keyOf = f => JSON.stringify([f.carried_from?.record ?? null, f.unit ?? null, f.attempt ?? null, f.code ?? null, f.text]);
      const have = new Set(carriedFindings.map(keyOf));
      for (const x of ctx.work.stages(item).filter(s => s.stage === 'implement' && s.status !== 'passed' && (s.handoff?.from ?? null) === planRec.hash)) {
        for (const {id, ...f} of x.findings ?? []) {
          if (!f.carried_from || have.has(keyOf(f))) continue;
          have.add(keyOf(f)); carriedFindings.push(f);
        }
      }
    }
    const seats = {
      dispatcher: u => fitMatrix('dispatcher', u.difficulty),
      // Called with the unit AS DISPATCHED: a difficulty the dispatcher raised moves the implementer and its ladder.
      // The ladder is the matrix's rejection path (thinking level first, then the next rung).
      implementer: u => ({seat: {...IMPLEMENTER_LADDERS[u.difficulty][0]}, ladder: implementerPath(u.difficulty)}),
      subagent: u => fitMatrix('subagent', u.difficulty),
      // Rung 0 is the dispatcher's exact model (the pin); the rungs above it are the rest of the OpenAI-only path.
      reviewerLadder: d => [pinnedReviewer(d), ...REVIEWER_ESCALATION.slice(REVIEWER_ESCALATION.findIndex(x => x.vendor === d.vendor && x.model === d.model) + 1).map(x => ({...x}))],
    };
    // "The model asked for answered": the same model identity under the identity policy (a dated snapshot of the
    // model is that model; another model of the same lab is not).
    const sameModel = (asked, served) => { const a = resolveModel(null, asked), b = resolveModel(null, served); return Boolean(a?.known && b?.known && a.id === b.id); };
    // A run that THROWS (a record it cannot write, a git failure outside its own handling) is charged the calls it
    // admitted, not the whole stage budget: a throw after 0 calls charged every stage_provider_calls (independent review
    // round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 1.2).
    let run, admitted = 0;
    try {
      run = await runPipeline({repo: top, base, plan: {work_units: units}, seats, turns: pipelineTurns({makeClientFor, turn, agy: {meteredFailover}}), dir, sameModel,
        // Checkpoints are sealed under a key held beside the work ledger (outside the item's state directory), and a
        // checkpoint whose seal, review or rubric does not re-derive is not resumed (independent review, assignment 3
        // (OpenAI gpt-6-astra extra review, 09d490f), question 7).
        checkpoints: {dir: checkpointDir, ...(ctx.work?.root ? {keyFile: path.join(ctx.work.root, 'checkpoint-seal.key')} : {})},
        // Every pipeline call is charged on the work ledger before it is made; the stage's elapsed budget stops the run
        // admitting calls (the scheduler's cooperative stop).
        // Every admitted call is counted here too, so a run that throws is charged what it made (finding 1.2, below).
        onCharge: () => { if (typeof ctx.charge === 'function') ctx.charge(1); admitted += 1; }, ...(ctx.signal ? {signal: ctx.signal} : {}),
        planner: {vendor: planRec.outputs.planner.vendor, model: planRec.outputs.planner.model},
        // The stage's provider-call budget bounds every turn of every role in the run; a caller cannot raise it here
        // (a lower pipelineLimits.max_provider_calls is kept: the stricter bound wins).
        limits: {...pipelineLimits, max_provider_calls: Math.min(ctx.budget.provider_calls, pipelineLimits.max_provider_calls ?? Infinity)}});
    } catch (e) {
      return result('failed', {outputs: {run: {kind: 'pipeline', dir, record: recordFile, record_digest: fs.existsSync(recordFile) && fs.statSync(recordFile).isFile() ? sha256(fs.readFileSync(recordFile)) : null}, error: String(e?.message ?? e).slice(0, 300), ...(carriedRuns.length ? {carried_runs: carriedRuns} : {})},
        contributions, findings: carriedFindings.map((f, i) => ({id: `unit-${i + 1}`, ...f})), usage: usage(admitted),
        next: {stage: 'implement', why: `the pipeline run failed: ${String(e?.message ?? e).slice(0, 200)}`}});
    }
    const calls = run.provider_calls.total;
    const unitsOut = Object.values(run.units);
    // CONTRIBUTIONS: the plan record's, the critiques fed to this revision, and what the run AUTHORED (record.mjs
    // contributionsOf): every implementer attempt that reached a worktree, every subagent answer returned to an
    // implementer, and every Stage 5 reviewer whose finding was fed to a revision. The run's own `plan` row is the
    // planner already carried from the plan record. The dispatcher is not here: see the decision above.
    const authored = new Map();
    for (const c of contributionsOf(run).filter(c => c.kind !== 'plan')) {
      const model = c.served_model ?? c.model;
      const row = {purpose: c.kind, vendor: c.vendor, model, ...(c.served_model && c.model && c.served_model !== c.model ? {requested_model: c.model} : {}),
        ...(c.served_model_source ? {served_model_source: c.served_model_source} : {}), lab: labOf(c.vendor, model)};
      const k = JSON.stringify(row);
      authored.set(k, {row, role: c.role, units: [...new Set([...(authored.get(k)?.units ?? []), c.unit_id])]});
    }
    const VIA = {work: 'wrote in the unit\'s worktree', subtask: 'answered the implementer as a subagent', critique: 'its Stage 5 finding was fed to an implementer revision'};
    const work = [...authored.values()].map(a => ({...a.row, via: `pipeline ${a.role}, unit(s) ${a.units.join(', ')}: ${VIA[a.row.purpose] ?? a.row.purpose}`}));
    const arbiters = arbitersOf(run);
    // DECISION 6 (owner, 2026-11-19): the dispatcher exception is confined to the pinned Stage 5 review of its own unit.
    // Every dispatcher whose rubric governed a unit of this change is EXCLUDED, by its requested and its serving
    // identity, from the coordinated three-lab change review and from the validator: these rows ride with the stage's
    // contributions (purpose 'arbiter', not authored work) into the review scope, the cycle's recorded contributors and
    // the validator's exclusion set, where they are checked at seat selection and again at answer admission.
    const arbiterRows = arbiterExclusions(arbiters);
    const all = dedupe([...contributions, ...work, ...arbiterRows]);
    const team = [...new Map([
      // Non-authoring: on the team, not among the contributions.
      ...arbiters.map(a => ({role: 'dispatcher', vendor: a.vendor, model: a.served_model ?? a.model, lab: labOf(a.vendor, a.model), standing: 'arbiter', authored: false})),
      ...unitsOut.flatMap(u => [
        ...(u.attempts ?? []).map(a => ({role: 'implementer', vendor: a.vendor, model: a.model, lab: labOf(a.vendor, a.model), authored: a.status === 'written'})),
        ...(u.a2a?.calls ?? []).filter(c => c.vendor && c.model).map(c => ({role: 'subagent', vendor: c.vendor, model: c.model, lab: labOf(c.vendor, c.model), authored: c.status === 'answered'})),
        ...(u.reviews ?? []).map(r => ({role: 'unit-reviewer', vendor: r.vendor, model: r.model, lab: labOf(r.vendor, r.model), pinned_to_dispatcher: r.pinned_to_dispatcher, authored: false, fed_revision: Boolean(r.fed_revision)})),
      ]),
    ].map(r => [`${r.role}|${r.vendor}|${r.model}|${r.authored}|${r.fed_revision ?? ''}`, r])).values()];
    const branchOf = run.integration?.branch ?? null;
    // The pipeline record is named BY DIGEST on every stage record that cites it, so a fresh verifier can check that what
    // run.json's served identities and subagent receipt are read from is the record this stage saw (finding 10.1).
    const recordDigestOf = () => (fs.existsSync(recordFile) ? sha256(fs.readFileSync(recordFile)) : null);
    const runOut = {kind: 'pipeline', schema: run.schema, run_id: run.run_id, dir, record: recordFile, record_digest: recordDigestOf(), status: run.status, reason: run.reason, waves: run.waves, provider_calls: run.provider_calls,
      units: Object.fromEntries(unitsOut.map(u => [u.unit_id, {status: u.status, reason: u.reason, wave: u.wave, merged: u.merged, difficulty: u.dispatch?.difficulty ?? null, attempts: (u.attempts ?? []).length, reviews: (u.reviews ?? []).length}]))};
    const common = {run: runOut, arbiters, ticket: ticketOut, carried: {plan: planRec.outputs.plan_digest, lines: carried.length, via: 'appended to every unit\'s invariants'},
      ...(carriedRuns.length ? {carried_runs: carriedRuns} : {}), ...(recovered.length ? {recovered_worktrees: recovered} : {})};
    // Every finding the run kept (the Stage 5 reviewers' and the controller's own: write jail, ground truth), by unit.
    const findings = [...carriedFindings, ...unitsOut.flatMap(u => (u.findings ?? []).flatMap(f => f.findings.map(text => ({severity: 'block', cause: f.source === 'reviewer' ? 'in-run-review' : 'in-run-controller', unit: u.unit_id, attempt: f.attempt, code: f.code ?? null,
      text, vendor: f.source === 'reviewer' ? f.vendor ?? null : null, model: f.source === 'reviewer' ? f.model ?? null : null, lab: f.source === 'reviewer' && f.vendor ? labOf(f.vendor, f.model) : null}))))]
      .map((f, i) => ({id: `unit-${i + 1}`, ...f}));

    if (run.status !== 'completed') {
      const kept = {...common, shipped: false, ...(branchOf ? {integration: {...run.integration, kept: true}} : {})};
      // The plan (or the run's inputs) was refused before any turn. A plan error goes back to the planner, who
      // revises the work units; anything else is a failure of this attempt.
      if (run.status === 'refused') {
        const planErrors = run.refusals.filter(r => !['INPUT', 'BASE'].includes(r.code));
        if (!planErrors.length) return result('failed', {outputs: kept, team, contributions: all, usage: usage(calls), next: {stage: 'implement', why: `the pipeline refused its inputs: ${run.reason}`}});
        return result('returned', {outputs: {...kept, why: run.reason}, team, contributions: all, usage: usage(calls),
          findings: planErrors.map((r, i) => ({id: `units-${i + 1}`, severity: 'block', cause: 'inadequate-plan', text: `[${r.code}] ${r.message}`})),
          next: {stage: 'plan', why: `the controller refused the plan's work units: ${String(run.reason).slice(0, 300)}`}});
      }
      // The stage's provider-call budget ran out: the existing "did not ship" failure, with the bound named.
      // The bound named is the one that stopped the run (a lower pipeline max_provider_calls wins), with the calls made:
      // it read "the stage's 20 provider call(s) were used" after 1 call (independent review round 2, assignment 3
      // (Google gemini-4-carbon, manual, 77480d6), finding 2.2).
      if (run.provider_calls.refused_at_limit > 0) {
        // DETERMINISTIC when the run's bound is the pipeline's own lower max_provider_calls (not this attempt's stage
        // budget) and the attempt approved no unit of its own: a retry starts from the same checkpoints under the same
        // bound and stops at the same place. A launcher does not retry it (live-run.mjs runConfirmed; independent review
        // round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 2.2).
        const bound = run.limits?.max_provider_calls ?? ctx.budget.provider_calls;
        const progressed = unitsOut.filter(u => u.status === 'approved' && !u.resumed).length;
        const budgetStop = {code: 'PIPELINE_PROVIDER_CALLS', bound, stage_budget: ctx.budget.provider_calls, made: calls, refused: run.provider_calls.refused_at_limit,
          units_approved_now: progressed, deterministic: bound < ctx.budget.provider_calls && progressed === 0};
        return result('failed', {outputs: {...kept, budget_stop: budgetStop}, team, contributions: all, findings, usage: usage(calls),
          next: {stage: 'implement', why: `the run did not ship: PROVIDER_CALL_LIMIT: the run's bound of ${run.limits?.max_provider_calls ?? ctx.budget.provider_calls} provider call(s) was reached (${calls} made, ${run.provider_calls.refused_at_limit} more refused; the stage budget is ${ctx.budget.provider_calls})`}});
      }
      // A unit the dispatcher judged not cohesive goes back to the planner.
      const back = unitsOut.filter(u => u.status === 'returned');
      if (back.length) {
        return result('returned', {outputs: kept, team, contributions: all, usage: usage(calls),
          findings: back.map((u, i) => ({id: `units-${i + 1}`, severity: 'block', cause: 'inadequate-plan', unit: u.unit_id, text: `unit ${u.unit_id}: ${u.reason}`})),
          next: {stage: 'plan', why: `the dispatcher returned unit(s) ${back.map(u => u.unit_id).join(', ')} to the planner as not cohesive`}});
      }
      // Units that ended blocked or refused: the work, the run record and every finding are kept; nothing is retried
      // from scratch, which would repeat the work and drop the findings.
      const stuck = unitsOut.filter(u => ['blocked', 'refused'].includes(u.status));
      if (stuck.length) {
        const names = stuck.map(u => `${u.unit_id} (${u.status}: ${String(u.reason).slice(0, 160)})`).join('; ');
        return result('blocked', {outputs: kept, team, contributions: all, findings, usage: usage(calls),
          blocker: {code: 'PIPELINE_UNITS_UNRESOLVED', what: `PIPELINE_UNITS_UNRESOLVED: unit(s) ${names}; ${findings.length} finding(s) are unresolved; the run record and its work are kept (${recordFile})`,
            role: 'lead@orch', resume_when: 'the owner lifts the stop with a stated reason, reseats the work, or returns the item to planning'},
          next: {stage: 'implement', why: `unit(s) ${stuck.map(u => u.unit_id).join(', ')} did not reach approval`}});
      }
      return result('failed', {outputs: kept, team, contributions: all, findings, usage: usage(calls),
        next: {stage: 'implement', why: `the run did not ship: ${run.reason ?? unitsOut.filter(u => u.status !== 'approved').map(u => `${u.unit_id} ${u.status}: ${u.reason}`).join('; ').slice(0, 300)}`}});
    }

    // COMPLETED: every unit was approved against a passing verify_cmd and merged on pantheon/pipeline/<run_id>. The
    // integrated TREE is handed on exactly as the per-file path hands its shipped bytes: one commit on pantheon/<item>
    // whose parent is the base the run started from (so the reviewed diff is base..commit). The integration branch is
    // then deleted; its per-unit patches stay in the run directory, by digest in the run record.
    const head = run.integration.head;
    const files = (await gitAsync(top, ['diff', '--name-only', '--no-renames', base, head])).split('\n').filter(Boolean);
    if (!files.length) return result('failed', {outputs: {...common, shipped: false}, team, contributions: all, usage: usage(calls), next: {stage: 'implement', why: 'the run did not ship: every unit was approved and the integrated tree is the base unchanged'}});
    const exists = async ref => (await gitAsync(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], {allowFail: true})).code === 0;
    let branch = `pantheon/${item}`;
    for (let k = 2; await exists(branch); k++) branch = `pantheon/${item}-r${k}`;
    const tree = (await gitAsync(top, ['rev-parse', `${head}^{tree}`])).trim();
    const commit = (await gitAsync(top, ['commit-tree', tree, '-p', base, '-F', '-'], {input: [`${item}: ${t.spec.title}`, '', `Slice: ${t.ticket.slice}`, '',
      `Produced by an Ophanim operate implement stage (Pantheon five-stage pipeline, run ${run.run_id}); every work unit was approved against its verify command and merged.`, '',
      `Pantheon-Ticket: ${t.digest}`, `Ophanim-Plan: ${planRec.outputs.plan_digest}`, `Pantheon-Pipeline-Integration: ${head}`, ''].join('\n')})).trim();
    fenceOf(ctx);   // the lease still holds before the shipped branch is written (finding 4)
    await gitAsync(top, ['update-ref', `refs/heads/${branch}`, commit, '0'.repeat(commit.length)]);
    await gitAsync(top, ['update-ref', '-d', `refs/heads/${branchOf}`, head]);
    // The evidence the later stages bind to. The run record is pipeline.json (by digest). The run's ledger is opened
    // here, empty of work entries: the coordinated review records its cycle on it, as it does on a board run's ledger.
    // (There is no acceptance gate entry: the ground truth is each unit's verify_cmd, in the run record.)
    const boardDir = path.join(dir, 'board');
    fs.mkdirSync(boardDir, {recursive: true});
    const sys = openPantheonLedger({root: path.join(dir, 'ledger'), board: openBoard(boardDir)});
    const lv = sys.recorder().verify();
    if (!lv.ok) throw new Error(`the run ledger does not verify: ${lv.why}`);
    // A unit resumed from its checkpoint has no review in this run: its ground truth is the verify_cmd re-run on resume.
    const verifies = unitsOut.map(u => u.reviews.at(-1)?.verify ?? u.resume_verify);
    const tests = {cmd: [...new Set(verifies.map(x => x.cmd))].join(' && '), exit: verifies.every(x => x.exit_code === 0) ? 0 : 1};
    const board = readBoard({statusRoot: statusAt});
    // run.json: the run as the status ledger's evidence check reads it (packages/ledger/status.mjs: the ticket key the
    // run ran under, by the file's digest). It binds the pipeline's own record, pipeline.json, by digest, and names
    // what was handed on; it restates nothing the record does not hold.
    const runFile = path.join(dir, 'run.json');
    fs.writeFileSync(runFile, JSON.stringify({schema: 'ophanim.pipeline-run/v1', key: t.spec.key, item, ticket: t.digest, plan: planRec.outputs.plan_digest,
      pipeline: {schema: run.schema, run_id: run.run_id, record: recordFile, record_digest: sha256(fs.readFileSync(recordFile)), status: run.status},
      base, commit, branch, integration: {branch: branchOf, head, tree}, files, acceptance: tests, contributions: all, arbiters}, null, 2) + '\n');
    return result('passed', {
      outputs: {commit, branch, base, files, run_json_digest: sha256(fs.readFileSync(runFile)), run_ledger_anchor: sys.anchor,
        run: {...runOut, board: boardDir, ledger: path.join(dir, 'ledger'), ledger_anchor: sys.anchor, ledger_head: lv.head, run_json: runFile, gate_entry: null, tests},
        integration: {branch: branchOf, head, tree, merged: run.integration.merged, deleted: true}, arbiters,
        ticket: {path: t.path, digest: t.digest, slice: t.ticket.slice, proposes: t.ticket.proposes, key: t.spec.key},
        made_against: board.items.find(i => i.item === item)?.entry ?? null, contributions: all, carried: common.carried, ...(carriedRuns.length ? {carried_runs: carriedRuns} : {}),
        ...(critiques.length ? {answers: critiques.map(f => f.id)} : {})},
      team, contributions: all, findings, usage: usage(calls), next: {stage: 'review', why: `integrated ${run.integration.merged.length} unit(s) as ${commit.slice(0, 12)} on ${branch}`}});
  }

  // ---- review ----
  async function review(ctx) {
    checkUpstream(ctx, 'review');
    const t0 = Date.now(), item = ctx.item, impl = ctx.upstream, o = impl.outputs;
    const m = meter(turn, ctx.budget.provider_calls, ctx);
    const usage = () => ({provider_calls: m.made, elapsed_ms: Date.now() - t0});
    if (!fs.existsSync(o.run.run_json) || sha256(fs.readFileSync(o.run.run_json)) !== o.run_json_digest) {
      return result('failed', {next: {stage: 'implement', why: 'the run.json the implement stage recorded is missing or changed'}});
    }
    const run = JSON.parse(fs.readFileSync(o.run.run_json, 'utf8'));
    const scope = fullScope(changeScope(run), o.contributions ?? []);
    // A RE-REVIEW after a reassessment disqualified this change's earlier review (gates.mjs): a new cycle of the same
    // change, on its own ledger (the earlier cycle stays closed and verifiable on the run ledger), with its panel chosen
    // under the corrected identity policy, so the model the correction identified as a contributor is not seated.
    const rr = ctx.gate?.rereview?.stage === 'review' ? ctx.gate.rereview : null;
    const corrected = rr?.policy_rules ?? null;
    const chosen = cycleReviewers({scope, n, ...pool, independence, ...(corrected ? {policy: corrected} : {})});
    const outputs = {commit: o.commit, base: o.base, review_scope: chosen.scope, author_labs: chosen.author_labs, independence,
      ...(rr ? {rereview_of: {cycle: rr.cycle, reassessment: rr.reassessment, replaces: rr.replaces}} : {}),
      ...(byModel ? {author_models: chosen.author_models, shared_labs: chosen.shared_labs ?? []} : {})};
    if (chosen.pending) {
      return result('pending', {outputs, usage: usage(), blocker: pendingCapacity(chosen.pending.why), next: {stage: 'review', why: 'review capacity is short; the commit is kept'}});
    }
    const cycleLedger = rr ? dirOf(ctx, `rereview-${rr.reassessment.slice(7, 19)}-ledger`) : o.run.ledger;
    const sys = rr ? openPantheonLedger({root: cycleLedger}) : openPantheonLedger({root: o.run.ledger, anchor: o.run.ledger_anchor, board: openBoard(o.run.board)});
    const rec = sys.recorder();
    const top = git(repo)(['rev-parse', '--show-toplevel']).trim(), G = git(top);
    // The board scope the status ledger binds completion evidence to (status.mjs checkReview): one cycle per run ledger,
    // and each implement attempt has its own run ledger, so the scope is this attempt's change.
    const cscope = boardScopeOf(item, o.base);
    const diff = G(['diff', '--no-color', o.base, o.commit]);
    const files = G(['diff', '--name-only', o.base, o.commit]).split('\n').filter(Boolean);
    // (The author's turns are on the run ledger; a re-review's own ledger cannot cite them. Its independence rests on the cycle's recorded contributors.)
    const authorTurns = rr ? [] : sys.ledger.read().filter(e => e.kind === 'turn' && ['plan', 'work'].includes(sys.ledger.payloadOf(e).purpose)).map(e => sys.ledger.hashOf(e));
    const last = rec.lastCycle(cscope);
    const planDoc = chainOf(ctx.work, impl).plan?.outputs.plan ?? null;
    const {dossier: built, retriever} = evidenceFor(ctx);
    const briefKey = `change|${o.base}|${o.commit}|${rr?.reassessment ?? ''}`;
    // A resumed cycle's reviewers are shown the brief bound when it opened, with ITS dossier: that is the one recorded.
    const dossier = boundDossier(ctx, briefKey, built);
    const investigations = Object.assign([], {dossier});
    let cycle = last?.hash ?? null;
    if (!last?.close) {
      // An open cycle of this exact change is resumed (its recorded reviews kept), never reopened.
      const r = await reviewCycle({ledger: rec, resume: Boolean(last), change: {scope: cscope, base: o.base, head: o.commit, diff, files, author_labs: chosen.author_labs, author_turns: authorTurns, ...(last ? {} : independenceOf(chosen.contributions ?? [], corrected))},
        seats: chosen.seats, n, policy: runPolicy(run),
        // The change reviewers judge the diff against the requirement and the approved plan, with the evidence itself
        // and their own retrieval -- not the diff alone.
        turn: investigatingTurn(m, retriever, investigations, 'cycle-reviewer'),
        brief: boundBrief(ctx, briefKey, () => [REVIEW_BRIEF,
          'Judge the change against the ORIGINAL requirement and the approved plan below, not only for defects in the diff: does it do what was required, does it keep',
          'the plan\'s exclusions and the obligations of what consumes the changed files, and does it hold on a retry, a partial completion and a later revision?',
          'You have your own access to the evidence (the dossier and retrieval). Name the evidence a finding rests on inside its claim, as [source: <path or ref>].',
          '', '## Original requirement (authoritative)', JSON.stringify(planDoc?.requirement ?? null),
          '', '## Approved plan (reviewed by three labs)', JSON.stringify(planDoc ? {problem: planDoc.problem, scope: planDoc.scope, exclusions: planDoc.exclusions, acceptance: planDoc.acceptance,
            investigation: planDoc.investigation, uncertainty: planDoc.context?.uncertainty ?? [], unresolved: planDoc.unresolved} : null, null, 1),
          '', renderDossier(built), '', RETRIEVAL_HELP(INV)].join('\n'))});
      cycle = r.cycle;
    }
    const state = rec.cycleState(cycle);
    const team = state.reviews.map(x => ({role: 'cycle-reviewer', vendor: x.seat.vendor, model: x.model, lab: x.lab}));
    Object.assign(outputs, {cycle, cycle_ledger: cycleLedger, cycle_ledger_anchor: sys.anchor, scope: cscope, labs: state.reviews.map(x => x.lab).sort(), context: {dossier: dossierRecord(dossier), investigations: [...investigations]}});
    if (state.reviews.length < state.cycle.reviewers) {
      const failed = state.attempts.filter(a => a.outcome === 'failed').map(a => `${a.seat.lab}: ${a.why}`);
      const stopped = budgetStopOf(m, failed, {stage: 'review', kept: 'the commit and the open cycle are kept'});
      return result('pending', {outputs, team, usage: usage(),
        blocker: stopped?.blocker ?? {what: `REVIEW_PENDING: ${state.reviews.length} of ${state.cycle.reviewers} reviews recorded (${failed.join('; ') || 'reviewer unavailable'}); the commit and the open cycle are kept`,
          role: 'check@review', resume_when: 'the reviewer is available; the open cycle is resumed with its recorded reviews kept', transient: true},
        next: {stage: 'review', why: stopped?.why ?? 'a reviewer seat failed'}});
    }
    // Findings with no resolution (fixed, or deferred under the existing review-cycle rules) return the change.
    const open = findingRows(state, {only: f => !state.resolutions.get(f.hash)});
    if (open.length) {
      return result('returned', {outputs, team, findings: open, usage: usage(), next: {stage: 'implement', why: `${open.length} review finding(s) to fix`}});
    }
    fenceOf(ctx);   // the lease still holds before the shared run ledger's cycle is closed (finding 4)
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
    checkUpstream(ctx, 'validate');
    const t0 = Date.now(), item = ctx.item, rv = ctx.upstream;
    const chain = chainOf(ctx.work, rv);
    const impl = chain.implement, planRec = chain.plan, planDoc = planRec.outputs.plan;
    const m = meter(turn, ctx.budget.provider_calls, ctx);
    const usage = () => ({provider_calls: m.made, elapsed_ms: Date.now() - t0});
    const commit = rv.outputs.commit;
    if (commit !== impl.outputs.commit) return result('failed', {next: {stage: 'review', why: 'the reviewed commit is not the implemented one'}});
    // 1. A CLEAN checkout of the exact commit (git archive: no working-tree bytes reach it).
    const top = git(repo)(['rev-parse', '--show-toplevel']).trim(), G = git(top);
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'operate-validate-'));
    const tests = [];
    const outputsDir = dirOf(ctx, `validate-${ctx.attempt}-outputs`);
    // ASYNCHRONOUS AND BOUNDED (independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6),
    // findings 3.3 and 9): the checkout and every test run in child processes the event loop waits on (execFileSync held
    // the whole process, every sibling item's timers and leases included, for up to 10 minutes per command), each bounded
    // by what is left of the stage's elapsed budget (and at most 10 minutes) and stopped by the stage's signal.
    const leftMs = () => Math.max(0, Math.min(10 * 60_000, (ctx.budget?.elapsed_ms ?? Infinity) - (Date.now() - t0)));
    const proc = async (cmd, args, opts = {}) => {
      const r = await spawnPromise(cmd, args, {timeout: leftMs(), maxBuffer: 64 << 20, ...(ctx.signal ? {signal: ctx.signal} : {}), ...opts});
      return {...r, exit: r.killedFor ? null : r.status};
    };
    try {
      const tarFile = path.join(clean, '.archive.tar');
      const arc = await proc('git', ['-C', top, 'archive', '--format=tar', '-o', tarFile, commit]);
      if (arc.exit !== 0) throw new Error(`git archive of ${commit} failed${arc.killedFor ? ` (${arc.killedFor})` : ''}: ${String(arc.stderr).slice(0, 300)}`);
      const ext = await proc('tar', ['-x', '-C', clean, '-f', tarFile]);
      fs.rmSync(tarFile, {force: true});
      if (ext.exit !== 0) throw new Error(`the checkout of ${commit} could not be extracted${ext.killedFor ? ` (${ext.killedFor})` : ''}: ${String(ext.stderr).slice(0, 300)}`);
      const cwd = path.join(clean, path.relative(top, repo));
      const run = async (kind, id, cmd) => {
        let exit = 0, out, stopped = null;
        if (ctx.signal?.aborted || leftMs() <= 0) { exit = 1; out = ''; stopped = 'not run: the stage\'s elapsed budget was spent before this command started'; }
        else {
          let r;
          try { r = await proc('sh', ['-c', cmd], {cwd}); } catch (e) { r = {exit: null, stdout: '', stderr: String(e?.message ?? e), killedFor: 'spawn'}; }
          exit = r.exit === null ? 1 : r.exit;
          out = r.exit === 0 ? r.stdout : `${r.stdout ?? ''}${r.stderr ?? ''}`;
          if (r.killedFor) stopped = `stopped (${r.killedFor})`;
        }
        // The whole output is kept and retrievable ({"op":"output","id":...}); the prompt shows its tail and says so.
        const full = String(out ?? ''), oid = `${kind}-${String(id).replace(/[^\w.-]/g, '_')}.txt`;
        fs.writeFileSync(path.join(outputsDir, oid), full);
        const tail = full.slice(-2000), total = Buffer.byteLength(full, 'utf8');
        tests.push({kind, id, cmd, exit, output_digest: sha256(full), output: {id: oid, chars: full.length, shown: Math.min(2000, full.length), complete: full.length <= 2000,
          bytes: {from: total - Buffer.byteLength(tail, 'utf8'), to: total, total}}, tail, ...(stopped ? {stopped} : {})});
      };
      for (const a of planDoc.acceptance) await run('acceptance', a.id, a.test.cmd);
      const pkg = fs.existsSync(path.join(cwd, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) : null;
      const regression = planDoc.regression?.cmd ?? (pkg?.scripts?.test ? 'npm test' : null);
      if (regression) await run('regression', 'regression', regression);
      else tests.push({kind: 'regression', id: 'regression', cmd: null, exit: null, output_digest: null, tail: 'no regression command: neither the plan nor the repository names one'});
    } finally { fs.rmSync(clean, {recursive: true, force: true}); }
    const green = tests.every(x => x.exit === 0 || x.cmd === null);
    // 2. The validator: a lab that contributed to neither plan, implementation nor review findings, when the pool allows.
    const finderRows = ctx.work.stages(item).filter(s => s.stage === 'review' && s.findings?.length).flatMap(s => s.findings).filter(f => f.lab)
      .map(f => ({purpose: 'critique', vendor: f.vendor ?? null, model: f.model ?? null, ...withServed(f), lab: f.lab}));
    // The validator contributed to nothing it judges: under the lab rule its lab did not, under the model rule it did not.
    // `barred` are seats already tried whose answer could not be accepted (see below): they are not asked again.
    // THE FULL CONTRIBUTION HISTORY, always: the plan, the work, and every finding that reached a revision. It is used
    // to choose the seat and again to admit the answer. There is no weaker fallback: when no eligible validator is
    // left, the work waits on capacity; it is not validated by a contributor.
    const allContribs = [...(impl.outputs.contributions ?? []), ...finderRows];
    const pickValidator = barred => {
      const extra = barred.flatMap(x => [{purpose: 'barred', vendor: x.vendor, model: x.model, lab: x.lab}, ...(x.served_model ? [{purpose: 'barred', vendor: x.vendor, model: x.served_model, lab: x.lab}] : [])]);
      try {
        return (byModel ? reviewSeatsByModel({n: 1, contributions: [...allContribs, ...extra.filter(e => resolveModel(e.vendor, e.model)?.known)], ...pool})
          : reviewSeats({n: 1, avoidLabs: [...new Set([...labsOfContribs(allContribs), ...barred.map(x => x.lab)])], ...pool}))[0];
      } catch (e) { if (e.code !== 'NO_SEATS') throw e; return null; }
    };
    /**
     * ADMISSION of an answer, after the call: by the model that ANSWERED. A missing or blank serving model does not
     * qualify (the model asked for is not evidence of which model answered); nor does an unresolved one, or a contributor.
     */
    const servedRefusal = (seat, served) => {
      if (byModel) return reviewerRefusal({vendor: seat.vendor, model: seat.model, served_model: served}, contributorKeys(allContribs));
      if (typeof served !== 'string' || !served.trim()) return `the answer names no serving model: ${seat.vendor}/${seat.model} was asked, and that is not evidence of which model answered`;
      const lab = labOf(seat.vendor, served);
      return labsOfContribs(allContribs).includes(lab) ? `the ${lab} lab contributed to the work and its model answered (${served})` : null;
    };
    const noValidator = (why, extra = {}) => result('pending', {outputs: {commit, tests, green, ...extra}, usage: usage(),
      blocker: pendingCapacity(`no eligible validator: ${why}. The validated commit, its tests and every answer received are kept; nothing was accepted from a contributor`, {stage: 'validate'}),
      next: {stage: 'validate', why: 'no validator is eligible'}});
    let seat = pickValidator([]);
    if (!seat) return noValidator(byModel ? 'every model that could be asked contributed to the work' : `every lab contributed to the work (${labsOfContribs(allContribs).join(', ')})`);
    const independent = true;
    const team = [{role: 'validator', ...seatOf(seat)}];
    const diff = G(['diff', '--no-color', impl.outputs.base, commit]);
    const {dossier: built, retriever} = evidenceFor(ctx, {outputsDir});
    // What the validator is shown is the dossier AND the tails of the test outputs: a tail is a view of the stored
    // output delivered in part, an unresolved gap until it is retrieved (question 6).
    const dossier = {...built, entries: [...built.entries, ...tests.filter(x => x.output).map(x => ({id: `T:${x.output.id}`, kind: 'observation', source: `output:${x.output.id}`,
      version: x.output_digest, coverage: {complete: x.output.complete, unit: 'bytes', ...x.output.bytes}, request: {op: 'output', id: x.output.id}}))]};
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
      '', renderDossier(built), '', RETRIEVAL_HELP(INV),
      '', 'Answer with ONE JSON object in a ```json block: {"verdict": "accept" | "implementation_defect" | "plan_defect" | "diagnosis_defect" | "missing_evidence", "reasons": ["..."],',
      ' "criteria": [{"id": "<acceptance id>", "met": true | false, "why": "..."}], "sources": ["<refs you checked yourself>"]}.',
      'implementation_defect: the code is wrong for a sound plan. plan_defect: a criterion or the scope does not cover the requirement or a consequence. diagnosis_defect: the plan\'s',
      'stated cause is wrong or unsupported. missing_evidence: you cannot judge because evidence is missing or unretrievable (say which). Keep these apart.'].join('\n');
    let judged = null;
    const refusedJ = [], rejected = [], meteredOff = [];
    let exhausted = false;
    for (let k = 0; k < 3 && !judged; k++) {
      if (m.left() < 1) break;
      let reply, tryLog = null;
      try {
        const r = await investigate({prompt, retriever, canAsk: () => m.left() > 1, ask: p => m.turn({vendor: seat.vendor, model: seat.model, prompt: p, seat: {...seat, role: 'validator'}})});
        investigations.push({role: 'validator', ...seatOf(seat), try: k + 1, ...r.log, unresolved: gapsOf(deliveryOf(dossier, r.log))});
        reply = r.reply; tryLog = r.log;
        if (!reply) { refusedJ.push(`no judgment within the investigation bounds (${r.log.limit_reached})`); continue; }
      } catch (e) {
        refusedJ.push(`the validator call failed: ${e.message}`);
        // A refusal BY THE RUN'S OWN SWITCH: the lane was refused for quota (or the seat has no lane) and the metered
        // Gemini failover is off. It is a wait on capacity, not a defect of the validation (finding 6, below).
        if (e?.quota_failover?.disabled === true || e?.code === 'AGY_NO_LANE') meteredOff.push({vendor: seat.vendor, model: seat.model, code: e.code ?? null, why: String(e.message ?? e).slice(0, 300)});
        continue;
      }
      const j = jsonOf(reply?.text);
      // WHO ANSWERED is checked before the judgment is read as one. The seat was chosen by the model asked for; the
      // model that served the turn must be eligible too: resolved, and not a contributor. An answer that fails this
      // is kept on the record (requested and served names, the reason, the reply's digest) and is not a validation.
      const served = reply.served_model ?? null;
      const why = servedRefusal(seat, served);
      if (why) {
        rejected.push({vendor: seat.vendor, model: seat.model, served_model: served, lab: seat.lab, why, verdict: j?.verdict ?? null, reply_sha: sha256(reply.text ?? '')});
        refusedJ.push(`the answer of ${seat.vendor}/${seat.model} (served by ${served ?? 'an unnamed model'}) is not accepted: ${why}`);
        const nextSeat = pickValidator(rejected);
        if (!nextSeat) { exhausted = true; break; }
        seat = nextSeat;
        team.push({role: 'validator', ...seatOf(seat)});
        continue;
      }
      const ids = planDoc.acceptance.map(a => a.id);
      if (!j || !VERDICTS.includes(j.verdict) || !strs(j.reasons) || !Array.isArray(j.criteria) || !ids.every(id => j.criteria.some(c => c?.id === id && typeof c.met === 'boolean'))) {
        refusedJ.push('the validator did not answer {verdict, reasons, criteria for every acceptance id}'); continue;
      }
      // What it says it checked, against what THIS answer was actually given: its own investigation, never what a
      // rejected seat or an earlier try retrieved (question 6). A source it never received is not "checked".
      const got = deliveryOf(dossier, tryLog);
      const sources = (Array.isArray(j.sources) ? j.sources : []).filter(x => typeof x === 'string').map(x => ({ref: refOf(x), delivered: got.has(refOf(x)), ...(got.has(refOf(x)) ? {complete: got.get(refOf(x)).complete} : {})}));
      judged = {...j, sources, vendor: seat.vendor, model: seat.model, served_model: served, lab: seat.lab};
    }
    const outputs = {commit, checkout: {commit, tree: G(['rev-parse', `${commit}^{tree}`]).trim(), method: 'git archive'}, tests, green,
      // The accepted validator, by the model asked for AND the model that answered; answers that were not accepted stay on the record.
      validator: {...seatOf(seat), served_model: judged?.served_model ?? null, independent,
        ...(byModel && judged ? {identity: resolveModel(seat.vendor, seat.model)?.id ?? null, served_identity: resolveModel(seat.vendor, judged.served_model ?? seat.model)?.id ?? null} : {})},
      refused: refusedJ, rejected_answers: rejected, context: {dossier: dossierRecord(dossier), investigations}};
    // No judgment is a defect of the validation itself, kept apart from a defect of the change.
    // Every eligible seat was asked and none gave an admissible answer: a capacity block, with the answers kept.
    if (!judged && exhausted) return noValidator('no seat is left whose answer could be admitted', {rejected_answers: rejected, refused: refusedJ, context: outputs.context});
    // With the metered failover OFF, a validator refused for quota (or with no lane) is recorded as that block, with its
    // own code, pending until the lane's quota resets: it was recorded failed with no blocker (independent review round
    // 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 6).
    if (!judged && meteredOff.length) {
      const what = `METERED_FAILOVER_DISABLED: the validator seat was refused for quota (or has no Antigravity lane) and the metered Gemini API failover is off for this run (${meteredOff.map(x => `${x.vendor}/${x.model}: ${x.why}`).join('; ')}); the validated commit and its tests are kept`;
      return result('pending', {outputs: {...outputs, cause: 'metered-failover-disabled', metered_failover_refusals: meteredOff}, team, usage: usage(),
        blocker: {code: 'METERED_FAILOVER_DISABLED', what, role: 'lead@orch', resume_when: 'the lane\'s quota resets, or the owner allows the metered Gemini failover', transient: true},
        next: {stage: 'validate', why: 'the validator was refused for quota with the metered failover off'}});
    }
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
    checkUpstream(ctx, 'outcome');
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
      review: {ledger: rv.outputs.cycle_ledger ?? o.run.ledger, ledger_anchor: rv.outputs.cycle_ledger_anchor, scope: rv.outputs.scope, review_scope: rv.outputs.review_scope, cycle: rv.outputs.cycle,
        author_labs: rv.outputs.author_labs, close: rv.outputs.close, outcome: rv.outputs.outcome},
      validation: {verdict: val.outputs.verdict, record: val.hash, tests: val.outputs.tests.map(x => ({kind: x.kind, cmd: x.cmd, exit: x.exit, output_digest: x.output_digest})), validator: val.outputs.validator},
      plan: {digest: chain.plan.outputs.plan_digest, cycle: chain.plan.outputs.plan_review.cycle}, proposal: null};
    fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(bundle, null, 2) + '\n');
    const p = proposeFromBundle({dir, statusRoot: statusAt});
    if (!p.proposal) return result('blocked', {outputs: {bundle: dir}, usage: {provider_calls: 0, elapsed_ms: Date.now() - t0},
      blocker: {what: p.why, role: 'decision-authority', resume_when: 'the item is re-dispatched against its current status'}, next: {stage: 'outcome', why: p.why}});
    // The proposal's evidence is re-checked here exactly as `status.mjs apply` will (checkEvidenceLedgers: the run ledger
    // and its head and gate entry, the review cycle's scope and head, run.json, the ticket). An outcome whose proposal
    // apply would refuse is not passed (independent review, assignment 1, Google gemini-4-carbon, 09d490f, question 10).
    let checks;
    try { checks = checkEvidenceLedgers(p.proposal); } catch (e) { checks = {checked: 'refused', why: e.message}; }
    if (checks.checked !== 'structural') {
      const why = checks.why ?? `not everything the proposal cites can be re-checked (${Object.entries(checks).filter(([k, v]) => k !== 'checked' && !v).map(([k]) => k).join(', ')})`;
      fs.renameSync(path.join(dir, 'proposal.json'), path.join(dir, 'proposal.refused.json'));
      return result('blocked', {outputs: {bundle: dir, refused_proposal: path.join(dir, 'proposal.refused.json'), check: checks}, usage: {provider_calls: 0, elapsed_ms: Date.now() - t0},
        blocker: {code: 'OUTCOME_EVIDENCE_REFUSED', what: `OUTCOME_EVIDENCE_REFUSED: the proposal's evidence does not re-check as apply would: ${why}`.slice(0, 600), role: 'lead@orch',
          resume_when: 'the cited evidence is restored, or the item is returned to implementation'}, next: {stage: 'outcome', why: `the proposal would be refused at apply: ${why}`.slice(0, 300)}});
    }
    const bytes = fs.readFileSync(path.join(dir, 'proposal.json'));
    return result('passed', {outputs: {proposal_path: path.join(dir, 'proposal.json'), proposal_digest: p.bundle.proposal.digest, proposal_file_sha256: sha256(bytes),
      to: p.proposal.to.state, item, ticket: o.ticket.digest, commit, bundle: dir, signed: false}, usage: {provider_calls: 0, elapsed_ms: Date.now() - t0},
      next: {stage: null, why: 'the unsigned status proposal awaits the owner'}});
  }

  return {plan, implement, review, validate, outcome};
}
