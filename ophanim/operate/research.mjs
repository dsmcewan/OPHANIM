// RESEARCH IN THE LIFECYCLE (owner direction 2026-11-20: the Carbon 4 research and exploration team).
//
// A research team (pantheon/src/antigravity/research.mjs) answers one question for an item, before or during its
// ordinary lifecycle. This module connects it to what already exists here; it adds no second store and no second
// scheduler:
//
//   ACTIVATION   A REQUEST on the work ledger (work.research, phase `request`) names the item, what triggered it
//                (RESEARCH_TRIGGERS: a new item that needs investigation before planning, insufficient evidence, a
//                contradiction, a newly found relationship, a review finding, invalidated evidence, a reflection) and the
//                question. Anyone the controller acts for may record one (requestResearch; `operate research`). An open
//                request makes the item's plan stale (gates.mjs), so the plan stage runs it BEFORE the planner is asked.
//   THE TEAM     runResearch seats the role's coordinator (fit-matrix.mjs researchSeat: gemini-4-carbon first, the choice
//                recorded) and runs the team. Each member is a READ-ONLY session of the Antigravity SDK transport on the
//                repository (turn.mjs, research mode): the Gemini API with GEMINI_API_KEY held by the controller's gateway,
//                no agy CLI, no subscription login.
//   SPEND        Every billed request of every member is put to the ONE Gemini billing policy (spendGemini, kind `primary`,
//                purpose `research`), then to the stage's provider-call bound (the caller's `admitRequest`), and its usage
//                row is persisted, all before the gateway forwards it. With primary execution not declared, or its budget
//                spent, the team is refused before anything is prepared and the request stays open.
//   SESSIONS     Each session's own directory (its runtime's state) is made OUTSIDE the repository it reads, wherever the
//                item's state is kept, and removed when the session ends; what is kept of a session is its record below.
//                A session is given its assignment's tools and scope, and the transport enforces both (turn.mjs).
//   EVIDENCE     Every member is on the work ledger before it runs and again with its outcome. A finished member's full
//                record (its report, what the controller saw it examine, with digests) is a file of the item's state
//                directory, cited by digest on the ledger. The conclusion carries the findings concisely, source-linked.
//   KNOWLEDGE    The findings enter the item's DOSSIER as one derived view (context.mjs): the planner is shown them, can
//                cite them, and a plan that rests on them is stale when they change, by the existing evidence check.
//   RECOVERY     A team's identity is a function of the item and its request. A run that was cancelled, failed or was
//                refused a charge records no conclusion: the request stays open, and the next run reuses every finished
//                member from the ledger and its file (re-checked by digest) and pays only for the rest. A member whose
//                file no longer matches is run again and recorded again, once. A team that spent ITS OWN bound of rounds
//                or requests does conclude, as stopped and not satisfied: resuming it could do nothing more, and the
//                requests of every run of the team count against the one bound.
//   HIDDEN       The session reads the live repository, which may hold the controller's own records: the work ledger
//                and its private key, the item's state, the owner's status keys. They are not research sources: the
//                transport is told to hide them (a tool decision refuses the read; the jail covers the paths).
//   INDEPENDENCE Every member that answered is a CONTRIBUTOR (researchContributors: the model asked and the model that
//                answered). The plan stage adds them to the plan's contributions, so the review panels exclude them like
//                any other contributor. Several Hydrogen members are one model of one lab, not several reviewers.
//
// Must never: run a team with no recorded request or trigger; send a billed request the policy did not admit; record a
// conclusion for a team that was cancelled, failed or refused a charge; let a research session write, run or delegate;
// or let one read the controller's keys or ledgers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {RESEARCH, RESEARCH_TRIGGERS, RESEARCH_ROLES} from '../../pantheon/src/antigravity/config.mjs';
import {researchSeat, researchSubordinate, researchLimits} from '../../pantheon/src/route/fit-matrix.mjs';
import {runResearchTeam} from '../../pantheon/src/antigravity/research.mjs';
import {runAntigravitySdkTurn, sdkPreflight} from '../../pantheon/src/antigravity/turn.mjs';
import {transportBlockerOf, TRANSPORT_BLOCKERS} from '../../pantheon/src/pipeline/implement.mjs';
import {geminiAdmission, spendGemini, isGeminiBillingRefusal} from '../../pantheon/src/route/quota-failover.mjs';
import {researchOf, researchView, researchContributors} from './research-view.mjs';
export {researchOf, researchView, researchContributors};

export const RESEARCH_EVIDENCE_SCHEMA = 'ophanim.research-evidence/v1';
/** The research role a trigger asks for, unless the request names one. */
export const ROLE_OF_TRIGGER = Object.freeze({intake: 'scout', 'insufficient-evidence': 'researcher', contradiction: 'explorer', relationship: 'explorer', 'review-finding': 'researcher',
  'invalidated-evidence': 'researcher', reflection: 'explorer'});
/** The stops after which a team has NOT concluded: its request stays open and it is resumed. */
const RESUMABLE = (status, reason) => status === 'cancelled' || status === 'failed' || (status === 'stopped' && !['ROUND_LIMIT', 'RESEARCH_REQUEST_BUDGET'].includes(reason));
const str = v => typeof v === 'string' && v.trim() !== '';
const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const SYSTEM = role => [
  `You are a member of a read-only research team (${role}). You investigate one question in one repository and report what the sources show.`,
  'Every tool call you make is decided by a controller before it runs. You can read files, list directories and search inside the repository. You cannot write, run a command or start another agent.',
  'Report facts with the path of the source each rests on. Say what you could not establish. Do not guess, and do not propose or make changes.',
].join(' ');

/**
 * Why the research transport cannot start a session here, told without starting one: {code, message} (a
 * TRANSPORT_BLOCKERS code: no key, no SDK), or null. `antigravity`: the transport's options, as runResearch is given them.
 */
export const researchTransportRefusal = (antigravity = {}) => sdkPreflight({...(Object.hasOwn(antigravity, 'apiKey') ? {apiKey: antigravity.apiKey} : {}), ...(antigravity.python ? {python: antigravity.python} : {}),
  ...(antigravity.bridge ? {bridge: antigravity.bridge} : {})});
/** Is this stop of a team a fault of the transport that no retry of the team can cure (not the billing policy's refusal)? */
export const isResearchTransportStop = code => TRANSPORT_BLOCKERS.includes(code) && !['GEMINI_PRIMARY_DISABLED', 'METERED_GEMINI_BUDGET_EXHAUSTED'].includes(code);

/** Record a request for research on an item. Returns its hash. Throws for an unknown trigger or role. */
export function requestResearch({work, item, trigger, question, scope = undefined, role = undefined, by, at = new Date().toISOString()}) {
  if (!RESEARCH_TRIGGERS.includes(trigger)) throw Object.assign(new Error(`"${trigger}" is not a research trigger (${RESEARCH_TRIGGERS.join(', ')})`), {code: 'RESEARCH_TRIGGER'});
  if (role !== undefined && !RESEARCH_ROLES.includes(role)) throw Object.assign(new Error(`"${role}" is not a research role (${RESEARCH_ROLES.join(', ')})`), {code: 'RESEARCH_ROLE'});
  if (!str(question) || question.trim().length < RESEARCH.bounds.min_question_chars) throw Object.assign(new Error(`a research request has a question of at least ${RESEARCH.bounds.min_question_chars} characters`), {code: 'RESEARCH_QUESTION'});
  return work.recordResearch({phase: 'request', item, trigger, question: question.trim(), by, once: 1, ...(scope ? {scope} : {}), ...(role ? {role} : {}), at});
}
/** The team a request (or, with none, a trigger and question) is answered by: one identity per item and request. */
export const teamIdOf = ({item, request = null, trigger, question}) => 'rt-' + createHash('sha256').update(JSON.stringify([item, request, request ? null : trigger, request ? null : question])).digest('hex').slice(0, 16);

/** The findings of a team's record, concise and source-linked, bounded in bytes; what does not fit is counted, never dropped silently. */
export function findingsText(result, bytes = 6000) {
  const v = s => (str(s) ? s.slice(0, 19) : 'unversioned');
  const rows = [
    ...result.knowledge.observations.map(o => `- ${o.text} [${o.evidence.map(e => `${e.ref}@${e.absent ? 'ABSENT' : v(e.version)}${e.nodes.length > 1 ? ` (examined by ${e.nodes.length} members)` : ''}`).join('; ')}]`),
    ...result.knowledge.hypotheses.map(h => `- hypothesis (${h.status ?? 'open'}, ${h.node}): ${h.text}`),
    ...result.knowledge.dependencies.map(d => `- depends: ${d.from} -> ${d.to}${d.kind ? ` (${d.kind})` : ''}${d.contract ? `; contract: ${d.contract}` : ''}`),
    ...result.knowledge.unresolved.map(u => `- unresolved (${u.node} ${u.id}): ${u.question}${u.why ? ` (${u.why})` : ''}`),
  ];
  const out = [];
  let used = 0;
  for (const r of rows) { const b = Buffer.byteLength(r, 'utf8') + 1; if (used + b > bytes) break; out.push(r); used += b; }
  if (out.length < rows.length) out.push(`(+${rows.length - out.length} more finding(s) in the stored record)`);
  return out.join('\n');
}

/**
 * Run (or resume) the research team that answers one request of an item.
 *   work, item     the work ledger and the item       claim   the stage claim the run is made under (lineage), or null
 *   request        the request record ({hash, trigger, question, scope?, role?}), or null with {trigger, question}
 *   repo           the repository the team reads      dir     the team's directory in the item's state (evidence, sessions)
 *   billing        the stage's Gemini billing context (ctx.billing)
 *   admitRequest   the stage's charge for one provider call ({vendor, model}) -> void | throws (its bound, its ledger charge)
 *   context        the controller's initial view, as text (the rendered dossier), shown to the coordinator
 *   sdk            runAntigravitySdkTurn, or a scripted one       antigravity   the transport's options
 *   controlRoot    where each session's own directory is made (default: the system's temporary directory); it must be
 *                  outside `repo`, and the transport refuses a session otherwise (CONTROL_IN_WORKTREE)
 * Returns {team, status, stop_reason, concluded, conclusion (hash | null), result (the team's record) | null, refused (the
 * billing policy's refusal before anything was prepared) | null}.
 */
export async function runResearch({work, item, claim = null, request = null, trigger = request?.trigger, question = request?.question, scope = request?.scope ?? ['.'], role = request?.role ?? ROLE_OF_TRIGGER[trigger], repo, dir, billing,
  admitRequest = () => {}, context = null, head = null, limits = {}, sdk = runAntigravitySdkTurn, antigravity = {}, controlRoot = os.tmpdir(), signal = null, qualified = undefined, hide = [], now = () => new Date().toISOString(), progress = () => {}}) {
  if (!RESEARCH_TRIGGERS.includes(trigger)) throw Object.assign(new Error(`"${trigger}" is not a research trigger (${RESEARCH_TRIGGERS.join(', ')})`), {code: 'RESEARCH_TRIGGER'});
  if (!RESEARCH_ROLES.includes(role)) throw Object.assign(new Error(`"${role}" is not a research role (${RESEARCH_ROLES.join(', ')})`), {code: 'RESEARCH_ROLE'});
  const coordinator = researchSeat(role, qualified ? {qualified} : {}), subordinate = researchSubordinate();
  const L = {...researchLimits(coordinator.seat.model), ...limits};
  const team = teamIdOf({item, request: request?.hash ?? null, trigger, question});
  const billed = (model, n) => ({kind: 'primary', vendor: coordinator.seat.vendor, model, purpose: 'research', role, transport: 'sdk', request: n});
  // THE POLICY IS ASKED BEFORE ANYTHING IS PREPARED: not declared, or spent, is a refusal with nothing made and nothing
  // charged; the request stays open.
  try { geminiAdmission(billing, billed(coordinator.seat.model, 1)); }
  catch (e) { if (isGeminiBillingRefusal(e)) return {team, status: 'refused', stop_reason: e.code, concluded: false, conclusion: null, result: null, refused: e}; throw e; }

  fs.mkdirSync(dir, {recursive: true});
  const mine = () => work.research(item).filter(r => r.team === team);
  // WHAT THE CONTROLLER KEEPS IN THE REPOSITORY IS HIDDEN FROM THE SESSION: always the work ledger (its private key is
  // under it) and this team's own directory; the caller adds the rest (the item's state, the owner's status keys).
  const hidden = [...new Set([work.root, dir, ...hide].filter(p => typeof p === 'string' && path.isAbsolute(p)))];
  const nodeRows = () => mine().filter(r => r.phase === 'node');
  // RESUME: a finished member recorded with its file is reused when the file still has the digest the ledger recorded
  // (its LAST finished record: a member run again is recorded again). One whose file is gone or changed is run again,
  // and its new outcome is recorded with its new file (independent review, lifecycle finding 5: it was paid for on
  // every resume and never recorded again).
  const resume = [], lastFinished = new Map();
  for (const n of nodeRows().filter(r => r.state === 'finished' && r.evidence)) lastFinished.set(`${n.node}|${n.round ?? ''}`, n);
  const recorded = new Set(nodeRows().filter(r => r.state === 'admitted').map(r => `${r.node}|${r.round ?? ''}|admitted`));
  for (const [key, n] of lastFinished) {
    let ok = false;
    try {
      const raw = fs.readFileSync(path.join(dir, n.evidence.file));
      if (sha(raw) === n.evidence.sha256) { const rec = JSON.parse(raw.toString('utf8')); if (rec?.schema === RESEARCH_EVIDENCE_SCHEMA && rec.node?.id === n.node) { resume.push(rec.node); ok = true; } }
    } catch { /* a missing or unreadable file: the member is run again */ }
    if (ok) recorded.add(`${key}|finished`);
  }
  // WHAT EARLIER RUNS OF THIS TEAM BILLED, from the ledger: the requests of every member's recorded outcome, finished or
  // not. They count against the team's one request bound (independent review, controller finding 3).
  const spent = nodeRows().filter(r => r.state !== 'admitted').reduce((a, r) => a + (Number.isInteger(r.usage?.requests) ? r.usage.requests : 0), 0);
  let n = 0;
  const record = async ev => {
    if (ev.event === 'team') {
      if (!mine().some(r => r.phase === 'team')) work.recordResearch({phase: 'team', item, team, claim, request: request?.hash ?? null, trigger, role, question, scope: ev.scope, coordinator: ev.coordinator, subordinate: ev.subordinate,
        selection: ev.selection, limits: ev.limits, root: ev.root, head, at: ev.at});
    } else if (ev.event === 'node') {
      const x = ev.node, key = `${x.id}|${x.round ?? ''}|${x.state}`;
      // An admission is recorded once. An outcome is recorded for every run of the member (a reused member has none).
      if (!['admitted', 'finished', 'failed', 'cancelled'].includes(x.state) || (recorded.has(key) && (x.state === 'admitted' || x.state === 'finished'))) return;
      recorded.add(key);
      let evidence = null;
      if (x.state === 'finished') {
        const file = `${x.id}${x.kind === 'coordinator' ? `.r${x.round}` : ''}.json`;
        const body = JSON.stringify({schema: RESEARCH_EVIDENCE_SCHEMA, item, team, node: x}, null, 1) + '\n';
        fs.writeFileSync(path.join(dir, file), body);
        evidence = {file, sha256: sha(body)};
      }
      work.recordResearch({phase: 'node', item, team, claim, node: x.id, kind: x.kind, parent: x.parent, depth: x.depth, round: x.round ?? null, state: x.state, specialty: x.specialty ?? null, seat: x.seat,
        served_model: x.served_model ?? null, served_model_source: x.served_model_source ?? null, question: x.question, addresses: x.addresses ?? null, scope: x.scope, usage: x.usage ?? null,
        ...(evidence ? {evidence} : {}), ...(x.error ? {error: {code: x.error.code}} : {}), at: ev.at});
      progress({event: 'research.node', item, team, node: x.id, kind: x.kind, depth: x.depth, state: x.state, model: x.seat.model});
    } else if (ev.event === 'refusal') {
      work.recordResearch({phase: 'refusal', item, team, claim, code: ev.refusal.code, reason: ev.refusal.reason, parent: ev.refusal.parent ?? null, ...(ev.refusal.attempted_depth ? {attempted_depth: ev.refusal.attempted_depth} : {}), at: ev.at});
      progress({event: 'research.refusal', item, team, code: ev.refusal.code});
    }
  };
  // ONE BILLED REQUEST: the billing policy, then the stage's own bound and ledger charge, then the usage row -- all before
  // the gateway forwards it (spendGemini's order). The team's shared bound was checked before this is called.
  const admit = info => { spendGemini(billing, billed(info.model, ++n), () => admitRequest({vendor: coordinator.seat.vendor, model: info.model})); };
  const runNode = async ({node, prompt, seat, signal: stop, admit: charge, bounds}) => {
    // THE SESSION'S OWN DIRECTORY IS OUTSIDE THE REPOSITORY IT READS (the item's state may be inside it), and is removed
    // when the session ends, however it ends: nothing of a session is left behind but its record.
    const control_dir = fs.mkdtempSync(path.join(controlRoot, `ophanim-research-${node.id}-`));
    try {
      const r = await sdk({seat, prompt, worktree: repo, control_dir, unit: {unit_id: node.id}, admit: charge, signal: stop,
        research: {system: SYSTEM(node.kind === 'coordinator' ? role : `${node.specialty} specialist`), tools: [...node.tools], scope: [...node.scope], ...(hidden.length ? {hide: hidden} : {})},
        budget: {max_model_calls: bounds.model_calls, max_tool_calls: bounds.tool_calls}, timeoutS: bounds.timeout_s, ...antigravity});
      return {text: r.text, structured_output: r.structured_output ?? null, examined: r.examined ?? [], served_model: r.served_model ?? null, served_model_source: r.served_model_source ?? null, usage: r.usage ?? null};
    } catch (e) {
      // A fault of the transport keeps the transport's name (implement.mjs transportBlockerOf): the caller tells it from a
      // failed investigation.
      const blocker = transportBlockerOf(e);
      throw blocker && e.code !== blocker ? Object.assign(e, {code: blocker}) : e;
    } finally { fs.rmSync(control_dir, {recursive: true, force: true}); }
  };
  const result = await runResearchTeam({team: {id: team, item, role, trigger, question, scope, head, ...(str(context) ? {context} : {})}, coordinator, subordinate, limits: L, runNode, admit, record, resume, spent, signal, now});
  const concluded = !RESUMABLE(result.status, result.stop_reason);
  let conclusion = null;
  if (concluded) {
    const body = JSON.stringify({schema: RESEARCH_EVIDENCE_SCHEMA, item, team, result}, null, 1) + '\n';
    fs.writeFileSync(path.join(dir, 'findings.json'), body);
    conclusion = work.recordResearch({phase: 'conclusion', item, team, claim, request: request?.hash ?? null, status: result.status, stop_reason: result.stop_reason, satisfied: result.satisfied, material: result.material, summary: result.summary,
      findings_text: findingsText(result), findings: {file: 'findings.json', sha256: sha(body)}, telemetry: result.telemetry, contributors: result.contributors, at: now()});
  }
  progress({event: 'research.end', item, team, status: result.status, stop_reason: result.stop_reason, concluded, depth: result.telemetry.depth_reached, nodes: result.telemetry.nodes_created});
  return {team, status: result.status, stop_reason: result.stop_reason, concluded, conclusion, result, refused: null};
}
