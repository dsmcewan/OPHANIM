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
import {reviewCycle, reviewSeats} from '../../pantheon/src/ledger/review-cycle.mjs';
import {openPantheonLedger} from '../../pantheon/src/ledger/system.mjs';
import {selectSeat, readPools} from '../../pantheon/src/route/frontier.mjs';
import {taskProfile} from '../../pantheon/src/route/task-profile.mjs';
import {labOf} from '../../pantheon/src/config/models.mjs';
import {bytesOfRepo} from './reconcile.mjs';

export const PLAN_SCHEMA = 'ophanim.plan/v1';
export const VERDICTS = Object.freeze(['accept', 'implementation_defect', 'plan_defect']);
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
export function planRefusal(j, {shown = [], depends_on = [], mode = 'author', ticket = null, findings = [], repo = null, item = null} = {}) {
  if (!plain(j)) return ['the answer is not one JSON plan object (a title or prose is not a plan)'];
  const why = [];
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
  if (!ev.length || !ev.every(e => plain(e) && str(e.path) && str(e.why))) why.push('evidence lists the repository files read {path, why}');
  else for (const e of ev) if (!shown.includes(e.path)) why.push(`evidence ${e.path} is not a file the planner was shown`);
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

/** The files the planner is shown: tracked, text, bounded. Each with its current sha256 (evidence is bytes). */
function repoContext(repo, {cap = 48_000, each = 12_000} = {}) {
  let files = [];
  try { files = git(repo)(['ls-files']).split('\n').filter(Boolean); } catch { files = []; }
  const shown = [], parts = [];
  let used = 0;
  for (const f of files.slice(0, 400)) {
    const p = path.join(repo, f);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    const b = fs.readFileSync(p);
    if (b.length > each || b.includes(0) || used + b.length > cap) continue;
    used += b.length; shown.push(f);
    parts.push(`--- ${f} (${sha256(b)})\n${b.toString('utf8')}`);
  }
  return {shown, listing: files.slice(0, 400), text: parts.join('\n')};
}

function plannerPrompt({mode, requirement, deps, ticket, previous, findings, refusals, ctxFiles}) {
  return [
    'You are the planner for one work item of this repository (Ophanim operate, plan stage). Write a PLAN, not a title.',
    `Mode: ${mode}. ${mode === 'revalidate' ? 'A ticket exists: check that its assumptions, scope, dependencies and acceptance criteria are still valid against the evidence; say so in ticket_assessment.' : mode === 'revise' ? 'Revise the previous plan to answer every finding below.' : 'There is no ticket: plan the work from the requirement.'}`,
    '', '## Original requirement', JSON.stringify(requirement),
    '', '## Dependencies (latest status entries)', JSON.stringify(deps),
    ...(ticket ? ['', '## Existing ticket', JSON.stringify(ticket, null, 2)] : []),
    ...(previous ? ['', '## Previous plan', JSON.stringify(previous, null, 2)] : []),
    ...(findings.length ? ['', '## Findings to answer (answers: [{finding: <id>, response}])', ...findings.map(f => `- ${f.id} [${f.severity}] ${f.text}`)] : []),
    ...(refusals.length ? ['', '## Your previous answer was refused', ...refusals.map(r => `- ${r}`)] : []),
    '', '## Repository files (tracked)', ctxFiles.listing.join('\n'), '', '## Contents', ctxFiles.text,
    '', `Answer with ONE JSON object in a \`\`\`json block (schema ${PLAN_SCHEMA}): {problem: {statement, justification}, scope: [..], exclusions: [..],`,
    ' dependencies: [item ids], capabilities: [..], acceptance: [{id, criterion, test: {cmd}}], regression: {cmd} | null,',
    ' slices: [{id, title, slot, path}], copy: [repo paths the work reads], difficulty?: easy|medium|hard, proposes: {state, basis},',
    ' limits: {provider_calls, revisions, elapsed_ms}, stopping: [..], recovery, rollback, unresolved: [..], evidence: [{path, why}],',
    ' ticket_assessment?: {still_valid, reasons: [..]}, answers?: [{finding, response}]}',
  ].join('\n');
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
    vendor: r?.seat.vendor ?? null, model: r?.model ?? null, lab: r?.lab ?? null};
});
const runPolicy = run => {
  const s = (run?.turns ?? []).map(t => t.selection).find(x => x?.policy && x?.policy_hash && x?.profile);
  return s ? {version: s.policy, hash: s.policy_hash, profile: s.profile} : undefined;
};

// --- the executors -------------------------------------------------------------------------------------------
export function makeExecutors({repo, makeClientFor, turn, n = COORDINATED_LABS, statusRoot = null, stateDir = null, scouts = ['xai'], revisions = undefined,
  seating = undefined, facts = undefined, profile = 'argo', checked = null, progress = () => {}} = {}) {
  if (!repo) throw new Error('makeExecutors: pass the repository');
  if (typeof turn !== 'function') throw new Error('makeExecutors: pass turn({vendor, model, prompt, seat}) for the planner, reviewers and validator');
  if (typeof makeClientFor !== 'function') throw new Error('makeExecutors: pass makeClientFor(vendor) for the work seats');
  // The coordinated review is three labs. A caller may not lower it (and a higher n is the caller's stricter choice).
  if (!(Number.isInteger(n) && n >= COORDINATED_LABS)) throw Object.assign(new Error(`the coordinated review needs ${COORDINATED_LABS} labs; n = ${n} would lower it`), {code: 'REVIEW_FLOOR'});
  const statusAt = statusRoot ?? path.join(repo, 'status', 'ledger');
  const dirOf = (ctx, ...p) => { const d = path.join(stateDir ?? path.join(path.dirname(ctx.work.root), 'operate'), ctx.item, ...p); fs.mkdirSync(d, {recursive: true}); return d; };
  const seatsFor = avoidLabs => reviewSeats({n, avoidLabs, ...(seating ? {seating} : {}), ...(facts ? {facts} : {})});
  const today = () => checked ?? new Date().toISOString().slice(0, 10);

  // ---- plan ----
  async function plan(ctx) {
    const t0 = Date.now(), item = ctx.item, gate = ctx.gate, mode = gate.mode ?? 'author';
    const m = meter(turn, ctx.budget.provider_calls);
    const board = readBoard({statusRoot: statusAt});
    const status = board.items.find(i => i.item === item);
    const deps = Object.fromEntries((status?.depends_on ?? []).map(d => [d, board.items.find(i => i.item === d)?.entry ?? null]));
    const existing = fs.existsSync(path.join(repo, 'tickets', `${item}.json`)) ? readTicket({repo, item}) : null;
    const ticket = existing && !existing.why ? existing : null;
    const previous = [...ctx.work.stages(item)].reverse().find(s => s.stage === 'plan' && s.status === 'passed')?.outputs.plan ?? null;
    // The planner seat: the policy's first planner, chosen on its own merits. It is NOT moved into the implementer's
    // lab to leave the coordinated review its pool (owner direction 2026-11-17: never force planner and implementer
    // onto one lab to manufacture reviewer availability); a short pool later is a recorded capacity pending.
    const pick = selectSeat('planner', {profile, needsContext: 1, pools: readPools()}).seat;
    const planner = {...seatOf(pick), selection: {source: pick.selection?.source ?? null, reason: pick.selection?.reason ?? 'the policy\'s first planner candidate'}};
    const team = [{role: 'planner', ...seatOf(planner)}];
    // Review capacity BEFORE work: the plan needs n reviewer labs outside the planner's.
    let planSeats;
    try { planSeats = seatsFor([planner.lab]); } catch (e) {
      if (e.code !== 'NO_SEATS') throw e;
      return result('pending', {outputs: {mode, planner: seatOf(planner), stage: 'before-work'}, team, usage: {provider_calls: 0, elapsed_ms: Date.now() - t0},
        blocker: pendingCapacity(`the configured reviewer pool offers fewer than ${n} labs outside the planner's (${planner.lab}); nothing was planned`, {stage: 'plan'}),
        next: {stage: 'plan', why: 'plan review capacity is short'}});
    }
    const ctxFiles = repoContext(repo);
    const sys = openPantheonLedger({root: dirOf(ctx, 'plan-ledger')});
    const rec = sys.recorder();
    const top = git(repo)(['rev-parse', '--show-toplevel']).trim();
    const G = git(top);
    const scope = `plan/${item}`, file = `plans/${item}.json`;
    const refused = [], versions = [], contributions = [{purpose: 'plan', ...seatOf(planner), via: 'the planner wrote the plan the ticket derives from'}];
    let findings = mode === 'revise' ? (gate.findings ?? []).map(f => ({id: f.id, severity: f.severity, text: f.text, lab: f.lab ?? null})) : [];
    for (const f of findings) if (f.lab) contributions.push({purpose: 'critique', vendor: null, model: null, lab: f.lab, via: `finding ${f.id} returned to planning reached the revised plan`});
    let prevDoc = mode === 'revise' ? previous : null, prevDigest = prevDoc ? 'sha256:' + digest(prevDoc) : null;
    const usage = () => ({provider_calls: m.made, elapsed_ms: Date.now() - t0});
    const stop = (why, extra = {}) => result('failed', {outputs: {mode, refused, versions, ...extra}, team, contributions, usage: usage(), next: {stage: 'plan', why}});

    // An open plan cycle (a reviewer was unavailable) is resumed with its plan version, never re-planned or reopened.
    const open = rec.lastCycle(scope);
    let resume = null;
    if (open && !open.close) {
      const st = rec.cycleState(open.hash);
      resume = {doc: JSON.parse(G(['show', `${st.cycle.head}:${file}`])), base: st.cycle.base, head: st.cycle.head, author_turns: st.author_turns, author_labs: st.cycle.author_labs};
    }
    for (let v = 1; v <= PLAN_VERSIONS; v++) {
      // 1. The planner writes the plan; a malformed answer is refused and retried within budget.
      let doc = resume?.doc ?? null, turnHash = null;
      if (resume && m.left() < n) return stop(`stage budget: ${m.left()} provider call(s) left, the plan review needs up to ${n}`);
      for (let k = 0; k < PLANNER_TRIES && !doc; k++) {
        if (m.left() < 1 + n) return stop(`stage budget: ${m.left()} provider call(s) left, a plan and its review need ${1 + n}`);
        const prompt = plannerPrompt({mode, requirement: gate.requirement, deps, ticket: ticket?.ticket ?? null, previous: prevDoc, findings,
          refusals: refused.filter(r => r.version === v).flatMap(r => r.why), ctxFiles});
        let reply;
        try { reply = await m.turn({vendor: planner.vendor, model: planner.model, prompt, seat: {...planner, role: 'planner'}}); }
        catch (e) { refused.push({version: v, try: k + 1, why: [`the planner call failed: ${e.message}`]}); continue; }
        const text = reply?.text ?? '';
        const j = jsonOf(text);
        const why = planRefusal(j, {shown: ctxFiles.shown, depends_on: Object.keys(deps), mode, ticket: ticket?.ticket ?? null, findings, repo, item});
        progress({event: 'plan.answer', item, version: v, try: k + 1, refused: why.length});
        if (why.length) { refused.push({version: v, try: k + 1, why}); continue; }
        turnHash = rec.recordTurn({seat: {seat_id: `${planner.vendor}-plan@${planner.model}`, vendor: planner.vendor, mode: 'operate-plan', occupancy_gen: 1},
          requested_model: planner.model, served_model: reply.served_model ?? null, response_id: reply.response_id ?? null, reply: text, purpose: 'plan', prompt});
        const bytesOf = bytesOfRepo(repo);
        doc = {schema: PLAN_SCHEMA, item, mode, requirement: gate.requirement, ...j,
          evidence: j.evidence.map(e => ({path: e.path, sha256: bytesOf(e.path), why: e.why})),
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
      const r = await reviewCycle({ledger: rec, resume: Boolean(resume), change: {scope, base, head, diff, files: [file], author_labs: resume?.author_labs ?? [planner.lab],
        author_turns: resume?.author_turns ?? [turnHash]}, seats: planSeats, turn: m.turn, n, brief: PLAN_BRIEF});
      resume = null;
      const state = rec.cycleState(r.cycle);
      const version = {n: doc.version.n, digest: planDigest, commit: head, cycle: r.cycle, reviews: state.reviews.map(x => ({lab: x.lab, verdict: x.verdict}))};
      versions.push(version);
      if (state.reviews.length < n) {
        return result('pending', {outputs: {mode, plan: doc, plan_digest: planDigest, refused, versions, cycle: r.cycle, plan_ledger_anchor: sys.anchor},
          team: [...team, ...planSeats.map(s => ({role: 'plan-reviewer', ...seatOf(s)}))], contributions, usage: usage(),
          blocker: {what: `REVIEW_PENDING: ${r.failed.length} plan reviewer seat(s) failed (${r.failed.map(f => `${f.lab}: ${f.why}`).join('; ')}); the plan and its open cycle are kept`,
            role: 'check@review', resume_when: 'the reviewer is available; the open plan cycle is resumed, never reopened', transient: true},
          next: {stage: 'plan', why: 'plan review incomplete'}});
      }
      const rows = findingRows(state);
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
        const evidence = doc.evidence.map(e => ({path: e.path, sha256: e.sha256}));
        return result('passed', {identity: {ticket: {path: tk.path, digest: tk.digest}}, inputs: {mode, plan_previous: prevDigest},
          outputs: {plan: doc, plan_digest: planDigest, plan_commit: head, plan_review: {cycle: r.cycle, labs: closed.labs, close: closed.close, outcome: closed.outcome,
            unresolved: rows, ledger_anchor: sys.anchor}, ticket: {path: tk.path, digest: tk.digest}, ...(ticketRevision ? {ticket_revision: ticketRevision} : {}),
            ...(mode === 'revalidate' ? {ticket_kept: ticketRevision === null && Boolean(ticket)} : {}), deps, evidence, refused, versions, planner: seatOf(planner)},
          team: [...team, ...planSeats.map(s => ({role: 'plan-reviewer', ...seatOf(s)}))], contributions: dedupe(contributions), findings: rows, usage: usage(),
          next: {stage: 'implement', why: `plan v${doc.version.n} approved by ${closed.labs.join(', ')}`}});
      }
      // 4. Findings: the version is not approved. Its findings are answered by a revision, re-reviewed in its own cycle.
      for (const f of state.findings) rec.deferFinding({finding: f.hash, reason: `answered by a revision of plan ${planDigest.slice(0, 19)}; the revision is re-reviewed in its own cycle`});
      const closed = closeWith(rec, r.cycle, `plan review of ${item}`);
      if (closed.why) return stop(`the plan cycle cannot close: ${closed.why}`);
      for (const f of rows) contributions.push({purpose: 'plan-review', vendor: f.vendor, model: f.model, lab: f.lab, via: `plan finding ${f.id.slice(0, 19)} reached the revised plan`});
      findings = rows.map(f => ({id: f.id, severity: f.severity, text: f.text, lab: f.lab}));
      prevDoc = doc; prevDigest = planDigest;
      progress({event: 'plan.revise', item, version: v, findings: rows.length});
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
      ...critiques.filter(f => f.lab).map(f => ({purpose: 'critique', vendor: f.vendor ?? null, model: f.model ?? null, lab: f.lab, via: `finding ${String(f.id).slice(0, 19)} was fed to this revision`}))]);
    // Review capacity BEFORE work: the change will need n labs outside every contributor, the predicted workers included.
    const predicted = seatTeam({pools: readPools(), spec: t.spec, profile, planTitle: 'ticket'});
    const predictedWork = [...new Map(predicted.implementers.map(l => [l[0].lab, {purpose: 'work', vendor: l[0].vendor, model: l[0].model, lab: l[0].lab}])).values()];
    const cap = cycleReviewers({scope: fullScope(null, [...contributions, ...predictedWork]), n, ...(seating ? {seating} : {}), ...(facts ? {facts} : {})});
    if (cap.pending) {
      return result('pending', {outputs: {stage: 'before-work', predicted_contributors: cap.scope.contributions, ticket: {path: t.path, digest: t.digest}}, contributions,
        usage: usage(0), blocker: pendingCapacity(cap.pending.why, {stage: 'implement'}), next: {stage: 'implement', why: 'review capacity is short; no work was launched'}});
    }
    const top = git(repo)(['rev-parse', '--show-toplevel']).trim(), G = git(top);
    const dirty = G(['status', '--porcelain', '--', ...t.spec.copy.map(c => path.relative(top, path.join(t.spec.repo_root, c)) || '.')]).trim();
    if (dirty) return result('failed', {outputs: {dirty}, next: {stage: 'implement', why: 'the ticket\'s copy paths have uncommitted changes'}});
    const base = G(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    const spec = critiques.length ? {...t.spec, constraints: [...(t.spec.constraints ?? []), ...critiques.map(f => `Fix ${String(f.id).slice(0, 19)} [${f.severity}]: ${f.text}`)]} : t.spec;
    const boardDir = dirOf(ctx, `implement-${ctx.attempt}-${Date.now()}`);
    let res;
    try {
      res = await runOpenItem(spec, {dir: boardDir, makeClientFor, planTitle: 'ticket', maxProviderCalls: ctx.budget.provider_calls, scouts, profile,
        ...(revisions ? {revisions} : {}), progress: ev => progress({...ev, from: 'pipeline'})});
    } catch (e) {
      const runFile = path.join(boardDir, 'run.json');
      const made = fs.existsSync(runFile) ? providerCallsOf(JSON.parse(fs.readFileSync(runFile, 'utf8')).attempts ?? []) : 0;
      // The ticket the plan wrote cannot be run as written: a plan defect.
      return result('returned', {outputs: {error: String(e.message).slice(0, 300)}, usage: usage(made), next: {stage: 'plan', why: `the planned ticket cannot be run: ${String(e.message).slice(0, 200)}`}});
    }
    const runFile = path.join(boardDir, 'run.json');
    const run = fs.existsSync(runFile) ? JSON.parse(fs.readFileSync(runFile, 'utf8')) : null;
    const calls = providerCallsOf(run?.attempts ?? []);
    const team = [...new Map((run?.turns ?? []).map(x => [`${x.purpose}|${x.vendor}|${x.model}`, {role: x.purpose, vendor: x.vendor, model: x.served_model ?? x.model, lab: labOf(x.vendor, x.served_model ?? x.model)}])).values()];
    if (!res.shipped) {
      return result('failed', {outputs: {board: boardDir, shipped: false, error: res.error ?? null, tests: run?.acceptance ? {cmd: run.acceptance.cmd, exit: run.acceptance.exit} : null},
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
    const work = changeScope(run).contributions.map(c => ({purpose: c.purpose, vendor: c.vendor, model: c.model, lab: c.lab, via: c.via}));
    const board = readBoard({statusRoot: statusAt});
    return result('passed', {
      outputs: {commit, branch, base, files: files.map(f => f.path), run_json_digest: sha256(fs.readFileSync(runFile)), run_ledger_anchor: sys.anchor,
        run: {board: boardDir, ledger: path.join(boardDir, 'ledger'), ledger_anchor: sys.anchor, ledger_head: v.head, run_json: runFile,
          gate_entry: run?.ledger?.gate ?? null, tests: run?.acceptance ? {cmd: run.acceptance.cmd, exit: run.acceptance.exit} : null},
        ticket: {path: t.path, digest: t.digest, slice: t.ticket.slice, proposes: t.ticket.proposes, key: t.spec.key},
        made_against: board.items.find(i => i.item === item)?.entry ?? null, contributions: dedupe([...contributions, ...work]),
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
    const chosen = cycleReviewers({scope, n, ...(seating ? {seating} : {}), ...(facts ? {facts} : {})});
    const outputs = {commit: o.commit, base: o.base, review_scope: chosen.scope, author_labs: chosen.author_labs};
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
    let cycle = last?.hash ?? null;
    if (!last?.close) {
      // An open cycle of this exact change is resumed (its recorded reviews kept), never reopened.
      const r = await reviewCycle({ledger: rec, resume: Boolean(last), change: {scope: cscope, base: o.base, head: o.commit, diff, files, author_labs: chosen.author_labs, author_turns: authorTurns},
        seats: chosen.seats, turn: m.turn, n, policy: runPolicy(run)});
      cycle = r.cycle;
    }
    const state = rec.cycleState(cycle);
    const team = state.reviews.map(x => ({role: 'cycle-reviewer', vendor: x.seat.vendor, model: x.model, lab: x.lab}));
    Object.assign(outputs, {cycle, cycle_ledger_anchor: sys.anchor, scope: cscope, labs: state.reviews.map(x => x.lab).sort()});
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
    try {
      execFileSync('tar', ['-x', '-C', clean], {input: execFileSync('git', ['-C', top, 'archive', '--format=tar', commit], {maxBuffer: 512 << 20})});
      const cwd = path.join(clean, path.relative(top, repo));
      const run = (kind, id, cmd) => {
        let exit = 0, out;
        try { out = execFileSync('sh', ['-c', cmd], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000, maxBuffer: 64 << 20}); }
        catch (e) { exit = Number.isInteger(e.status) ? e.status : 1; out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
        tests.push({kind, id, cmd, exit, output_digest: sha256(out ?? ''), tail: String(out ?? '').slice(-400)});
      };
      for (const a of planDoc.acceptance) run('acceptance', a.id, a.test.cmd);
      const pkg = fs.existsSync(path.join(cwd, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) : null;
      const regression = planDoc.regression?.cmd ?? (pkg?.scripts?.test ? 'npm test' : null);
      if (regression) run('regression', 'regression', regression);
      else tests.push({kind: 'regression', id: 'regression', cmd: null, exit: null, output_digest: null, tail: 'no regression command: neither the plan nor the repository names one'});
    } finally { fs.rmSync(clean, {recursive: true, force: true}); }
    const green = tests.every(x => x.exit === 0 || x.cmd === null);
    // 2. The validator: a lab that contributed to neither plan, implementation nor review findings, when the pool allows.
    const reviewFinders = ctx.work.stages(item).filter(s => s.stage === 'review' && s.findings?.length).flatMap(s => s.findings.map(f => f.lab)).filter(Boolean);
    const contributors = [...new Set([...labsOfContribs(impl.outputs.contributions ?? []), ...reviewFinders])];
    let seat, independent = true;
    try { [seat] = reviewSeats({n: 1, avoidLabs: contributors, ...(seating ? {seating} : {}), ...(facts ? {facts} : {})}); }
    catch { independent = false; [seat] = reviewSeats({n: 1, avoidLabs: labsOfContribs((impl.outputs.contributions ?? []).filter(c => ['plan', 'work'].includes(c.purpose))), ...(seating ? {seating} : {}), ...(facts ? {facts} : {})}); }
    const team = [{role: 'validator', ...seatOf(seat)}];
    const diff = G(['diff', '--no-color', impl.outputs.base, commit]);
    const prompt = ['You are the independent validator of one implemented change (Ophanim operate, validate stage). You did not plan, write or review it.',
      'Judge whether the change meets the ORIGINAL requirement and every approved acceptance criterion. Tests passing is evidence, not proof.',
      '', '## Original requirement', JSON.stringify(planDoc.requirement), '', '## Approved acceptance criteria', JSON.stringify(planDoc.acceptance, null, 2),
      '', '## Plan scope and exclusions', JSON.stringify({scope: planDoc.scope, exclusions: planDoc.exclusions}),
      '', '## Test results in a clean checkout of the commit', JSON.stringify(tests.map(x => ({kind: x.kind, id: x.id, cmd: x.cmd, exit: x.exit, tail: x.tail})), null, 2),
      '', `## Change ${impl.outputs.base}..${commit}`, '```diff', diff, '```',
      '', 'Answer with ONE JSON object in a ```json block: {"verdict": "accept" | "implementation_defect" | "plan_defect", "reasons": ["..."],',
      ' "criteria": [{"id": "<acceptance id>", "met": true | false, "why": "..."}]}. plan_defect: an assumption is invalid or a criterion does not test the requirement.'].join('\n');
    let judged = null;
    const refusedJ = [];
    for (let k = 0; k < 2 && !judged; k++) {
      if (m.left() < 1) break;
      let reply;
      try { reply = await m.turn({vendor: seat.vendor, model: seat.model, prompt, seat: {...seat, role: 'validator'}}); }
      catch (e) { refusedJ.push(`the validator call failed: ${e.message}`); continue; }
      const j = jsonOf(reply?.text);
      const ids = planDoc.acceptance.map(a => a.id);
      if (!j || !VERDICTS.includes(j.verdict) || !strs(j.reasons) || !Array.isArray(j.criteria) || !ids.every(id => j.criteria.some(c => c?.id === id && typeof c.met === 'boolean'))) {
        refusedJ.push('the validator did not answer {verdict, reasons, criteria for every acceptance id}'); continue;
      }
      judged = {...j, vendor: seat.vendor, model: seat.model, served_model: reply.served_model ?? null, lab: seat.lab};
    }
    const outputs = {commit, checkout: {commit, tree: G(['rev-parse', `${commit}^{tree}`]).trim(), method: 'git archive'}, tests, green,
      validator: {...seatOf(seat), independent}, refused: refusedJ};
    if (!judged) return result('failed', {outputs, team, usage: usage(), next: {stage: 'validate', why: `no well-formed validator judgment (${refusedJ.join('; ')})`}});
    // A red test cannot be accepted, and a green test alone cannot pass: the judgment is required.
    let verdict = judged.verdict;
    const reasons = [...judged.reasons];
    if (verdict === 'accept' && !green) { verdict = 'implementation_defect'; reasons.push('the controller: an acceptance or regression command failed in the clean checkout'); }
    if (verdict === 'accept' && judged.criteria.some(c => !c.met)) { verdict = 'implementation_defect'; reasons.push('the controller: the validator marked a criterion unmet'); }
    Object.assign(outputs, {verdict, reasons, criteria: judged.criteria});
    const findings = verdict === 'accept' ? [] : reasons.map((text, i) => ({id: `validate-${i + 1}`, severity: 'block', text, vendor: judged.vendor, model: judged.model, lab: judged.lab}));
    if (verdict === 'accept') return result('passed', {outputs, team, usage: usage(), next: {stage: 'outcome', why: 'accepted against the original requirement and the approved criteria'}});
    const to = verdict === 'plan_defect' ? 'plan' : 'implement';
    return result('returned', {outputs, team, findings, usage: usage(), next: {stage: to, why: `${verdict}: ${reasons[0]}`}});
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
