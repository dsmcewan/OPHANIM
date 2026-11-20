// The earliest unmet gate of one work item: what the item needs next, which earlier stage results are still valid
// (reused, never paid for twice), which are stale (and why), and, for a genuinely blocked item, the blocker, the
// responsible role and the condition for resuming. Pure: every input is passed in.
//
// The lifecycle (work-ledger.mjs STAGES): plan -> implement -> review -> validate -> outcome.
//   plan       an item with no ticket is planned from its requirement (mode `author`); an item with a ticket has
//              that ticket's assumptions, scope, dependencies and acceptance re-checked (mode `revalidate`).
//   implement  consumes the approved plan.        review    the coordinated three-lab cycle review of the change.
//   validate   the exact change against the original requirement and the approved acceptance criteria.
//   outcome    the unsigned status transition for the owner, who alone signs the status ledger.
// A stage result is valid only while the chain it rests on holds: a passed stage is reused only if its handoff
// reaches back, stage by stage, to a plan that is still valid for the current requirement, dependencies, ticket
// bytes and evidence bytes. A change to any of those makes the plan stale and everything after it with it.
//
// Must never: treat a published issue, a ticket, a green CI run or a Resolved label as evidence that a stage ran;
// read issue text as authority; or route a blocked item to execution.
import {STAGES, outputsDigest} from './work-ledger.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';
import {idRefusal, parseId, endpointAllowed} from '../../packages/graph/index.mjs';

// ---- TYPED GRAPH REQUIREMENTS OF A PLAN (knowledge graphs, Slice D part 2, KD2-3; docs/knowledge-graph/slice-d2.md) ----
// A plan (ophanim.plan/v1) MAY state `requires`: [{id, version, why, implements?}], each a graph entity id (a capability,
// feature, runtime, tool, component, service, api, interface, contract or module a work item can require) with the
// VERSION of it the graph stated when the plan was made (graph-loop.mjs requirementState: GRAPH_ABSENT when no source
// states that it exists). `implements: true` declares that this plan builds the prerequisite itself. The free-text
// `capabilities` field stays. The graph informs the plan; it never constrains it (directive section 8).
/** The version of a requirement no source other than the plans that name it states: a missing prerequisite. */
export const GRAPH_ABSENT = 'absent';
const plainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The typed requirements a plan document states, each with the line that states it ([] when none or malformed). */
export function graphRequiresOf(doc) {
  if (!plainObj(doc) || !Array.isArray(doc.requires)) return [];
  return doc.requires.map((r, i) => (plainObj(r) && typeof r.id === 'string' ? {id: r.id, version: typeof r.version === 'string' ? r.version : null, why: typeof r.why === 'string' ? r.why : null,
    implements: r.implements === true, line: `requires[${i}]`, statement: JSON.stringify(r).slice(0, 300)} : null)).filter(Boolean);
}
/**
 * THE BOUND typed requirements of a plan RECORD (KD2-3): the requirements its document states, each with the line that
 * states it, and each VERSION taken from the binding the plan stage recorded (outputs.graph.requires: the version the
 * graph stated when the plan was made, GRAPH_ABSENT for a missing prerequisite; stages.mjs). The document's own `version`
 * is optional in the planner's answer, so it is read only for a record that predates the binding (no
 * outputs.graph.requires) or a requirement the binding does not name. Every consumer of a plan's typed requirements reads
 * them here: planValidity (the re-check), graph-loop.mjs analyzePlan (the block and the unlock), its reassessment filter
 * and the requirements it reports. (D2 fixes, outside-lab review: the binding was recorded and never read.)
 */
export function boundRequiresOf(rec) {
  const stated = graphRequiresOf(rec?.outputs?.plan), binding = rec?.outputs?.graph?.requires;
  if (!Array.isArray(binding)) return stated;
  const bound = new Map();
  for (const b of binding) if (plainObj(b) && typeof b.id === 'string' && !bound.has(b.id)) bound.set(b.id, typeof b.version === 'string' ? b.version : null);
  return stated.map(r => (bound.has(r.id) ? {...r, version: bound.get(r.id)} : r));
}
/** Whether a plan may require `id` (a typed requirement the work graph admits as requires-capability or depends-on). */
export function requirableRefusal(id) {
  const bad = typeof id === 'string' ? idRefusal(id) : 'not a string';
  if (bad) return `is not a graph entity id (${bad})`;
  const to = parseId(id), from = {domain: 'work', type: 'plan'};
  return endpointAllowed('requires-capability', from, to) || endpointAllowed('depends-on', from, to) ? null : `${to.domain}/${to.type} is not something a work item can require`;
}
/**
 * Why a plan's `requires` is not acceptable (a list; empty when it is). `stateOf(id)` (the graph, graph-loop.mjs
 * requirementState) returns {version}; without it no typed requirement can be bound to a version, and one is refused.
 */
export function requiresRefusal(requires, {stateOf = null} = {}) {
  if (requires === undefined) return [];
  if (!Array.isArray(requires)) return ['requires is a list of typed graph requirements [{id, why, version?, implements?}]'];
  if (requires.length && typeof stateOf !== 'function') return ['requires names graph entities, but no knowledge graph is supplied to this run: drop requires (keep the free-text capabilities) or run with the graph'];
  const why = [], seen = new Set();
  requires.forEach((r, i) => {
    if (!plainObj(r) || typeof r.id !== 'string' || typeof r.why !== 'string' || r.why.trim().length < 10) { why.push(`requires[${i}] is {id: <graph entity id>, why: <a sentence>, version?, implements?}`); return; }
    if (r.implements !== undefined && typeof r.implements !== 'boolean') why.push(`requires[${i}].implements is true or false`);
    const bad = requirableRefusal(r.id);
    if (bad) { why.push(`requires[${i}] ${r.id} ${bad}`); return; }
    if (seen.has(r.id)) why.push(`requires[${i}] names ${r.id} twice`);
    seen.add(r.id);
    if (r.version !== undefined) {
      const now = stateOf(r.id)?.version;
      if (typeof r.version !== 'string' || r.version !== now) why.push(`requires[${i}] cites version ${String(r.version).slice(0, 24)} of ${r.id}; the graph states ${String(now).slice(0, 24)}: retrieve it ({"op":"graph","query":"node","subject":"${r.id}"}) or drop the version`);
    }
  });
  return why;
}

/** The original requirement of an item: its id and title with the basis of its latest Ready status (else latest). */
export function requirementOf(history) {
  if (!history?.length) return null;
  const ready = [...history].reverse().find(s => s.state === 'Ready') ?? history.at(-1);
  return {item: ready.item, title: ready.title, basis: ready.basis, entry: ready.entry};
}
export const requirementDigest = req => 'sha256:' + digest({item: req.item, title: req.title, basis: req.basis});

/** Is the cited completion evidence on a Resolved status applicable: bound to a ticket, a commit and a 3-lab close? */
export function completionEvidence(status) {
  const ev = status?.evidence ?? null;
  if (!ev) return {ok: false, why: 'Resolved without recorded completion evidence (an attested basis only)'};
  const labs = new Set((ev.review?.reviewers ?? []).map(r => r.lab));
  if (!ev.ticket) return {ok: false, why: 'the completion evidence names no ticket'};
  if (!ev.commit) return {ok: false, why: 'the completion evidence names no commit'};
  if (!ev.review?.close_entry || ev.review.outcome !== 'verified') return {ok: false, why: 'the completion evidence has no verified review close'};
  if (labs.size < 3) return {ok: false, why: `the completion evidence names ${labs.size} review lab(s); three are required`};
  return {ok: true};
}

/**
 * Validity of a passed plan record against the present: requirement, dependency statuses, ticket bytes and the
 * bytes of the evidence the plan rests on. `bytesOf(path)` returns the current sha256 of a repository path or null.
 */
// The evidence a plan rests on (plan.outputs.evidence): every FILE it cites -- in `evidence`, in an examined
// investigation's `sources`, and the `copy` files the work reads -- with the digest of the bytes the planner was
// GIVEN (or, for a copy file it was not given, the bytes at approval); and every other cited VIEW (an issue, a status
// history, a grep, a view the dossier derived) with the version delivered and the request that names it.
// `versionOf(request, {plan})` re-reads such a view now: null when it is gone, undefined when it cannot be read here --
// which makes the plan stale, never valid by default (a work-ledger view alone is not judged).
// (independent review, assignment 1, Google gemini-4-carbon, 09d490f, questions 1 and 5)
// `observed` names, for every check that failed, WHAT IT SAW NOW (the present requirement digest, dependency entry,
// ticket digest, file bytes or view version; "unreadable" when it could not be read): the routing basis of the re-plan
// the staleness causes (earliestGate `route`). Two stalenesses on the same present state are the same work; a change
// of that state is new work (self-audit round 3, assignment 1 (sealed 323361a), question 1).
// `graph` (optional; KD2-3): the graph-derived input of the item (graph-loop.mjs gateInput): `version(id)` the present
// version of a typed requirement and `reassessed(record)` the recorded reassessment sets (ophanim/graph/reassess.mjs) a
// record is a member of. A requirement the plan cited as EXISTING whose version changed, and a plan a reassessment reached,
// make it stale: it is re-planned, never executed on stale validity. A requirement cited as ABSENT is the gate's block
// and unlock (graph-loop.mjs analyzePlan), not a staleness. A plan with typed requirements and no graph here cannot be
// re-checked, and is stale (never presumed unchanged). The version a requirement was cited at is the BOUND one
// (boundRequiresOf: the record's binding, not the document's optional version).
export function planValidity(plan, {requirement, deps, ticket, bytesOf = () => null, versionOf = null, graph = null}) {
  const why = [], observed = {};
  const typed = boundRequiresOf(plan);
  if (typed.length && !graph) { why.push('the plan cites graph facts, and no knowledge graph is supplied here to re-check them'); observed.graph = 'unreadable'; }
  if (graph) {
    for (const r of typed) {
      if (r.version === null || r.version === GRAPH_ABSENT) continue;
      const now = graph.version(r.id);
      if (now !== r.version) { why.push(`graph fact ${r.id} changed (cited ${r.version.slice(0, 19)}, now ${String(now).slice(0, 19)})`); observed[`graph:${r.id}`] = now; }
    }
    for (const x of graph.reassessed(plan.hash)) { why.push(`reassessed: ${x.why}`); observed[`reassess:${x.key}`] = x.event; }
  }
  if (plan.identity.requirement !== requirementDigest(requirement)) { why.push('the original requirement changed'); observed.requirement = requirementDigest(requirement); }
  for (const [d, entry] of Object.entries(plan.outputs.deps ?? {})) if ((deps[d]?.entry ?? null) !== entry) { why.push(`dependency ${d} changed`); observed[`dep:${d}`] = deps[d]?.entry ?? null; }
  for (const d of Object.keys(deps)) if (!(d in (plan.outputs.deps ?? {}))) { why.push(`dependency ${d} was added`); observed[`dep:${d}`] = deps[d]?.entry ?? null; }
  const planned = plan.outputs.ticket ?? null;
  if (planned && ticket && planned.digest !== ticket.digest) { why.push('the ticket was changed after the plan approved it'); observed.ticket = ticket.digest; }
  if (planned && !ticket) { why.push('the ticket the plan wrote is missing'); observed.ticket = null; }
  for (const ev of plan.outputs.evidence ?? []) {
    const r = evidenceCheck(ev, {bytesOf, versionOf, rec: plan});
    if (r) { why.push(r.why); observed[r.key] = r.now; }
  }
  return {valid: why.length === 0, why, observed};
}

/**
 * One cited source against the present: null when it is unchanged (or not a checkable citation), else {why, key, now}.
 * A FILE is compared by its present identity as the retriever's file op would serve it (reconcile.mjs bytesOfRepo: the
 * digest of its bytes, qualified when the op would now refuse them); any other VIEW is re-read with
 * `versionOf(request, {plan: rec})` (reconcile.mjs), whose version is the digest of the view's body (context.mjs, THE
 * VERSION CONTRACT, register L-504 invariant 1). The item's OWN work-ledger view and a stage's own stored test output are
 * never "changed evidence": recording an attempt, and the outputs the stage itself produced, are consequences, not
 * evidence. ANOTHER item's work view is evidence like any other view, re-read and compared (L-504: it was exempted too,
 * so a plan resting on another item's records was reused after those records changed).
 */
export function evidenceCheck(ev, {bytesOf = () => null, versionOf = null, rec = null}) {
  if (ev.path) {
    if (!ev.sha256) return null;
    const now = bytesOf(ev.path);
    return now !== ev.sha256 ? {why: `evidence ${ev.path} changed`, key: `file:${ev.path}`, now} : null;
  }
  if (!ev.request || ev.version === undefined) return null;
  // The item's own work-ledger view is never "changed evidence": recording an attempt is not new evidence (context.mjs
  // `stable`). Without the citing record the item is unknown, and the view is not judged (as before).
  if (ev.request.op === 'work' && (rec?.identity?.item === undefined || ev.request.item === rec.identity.item)) return null;
  if (ev.request.op === 'output') return null;
  // A cited view whose present version cannot be established here (no re-reader, a derived dossier view that cannot
  // be rebuilt, an issue with no snapshot) is NOT presumed unchanged: the record is stale until it can be re-checked
  // (independent review round 2, assignment 1, OpenAI gpt-6.1-sol, 77480d6, questions 1 and 5).
  const now = typeof versionOf === 'function' ? versionOf(ev.request, {plan: rec}) : undefined;
  const name = ev.source ?? ev.ref;
  if (now === undefined) return {why: `evidence ${name} cannot be re-read here to confirm it is unchanged`, key: name, now: 'unreadable'};
  return now !== ev.version ? {why: `evidence ${name} changed`, key: name, now} : null;
}

/**
 * The evidence a passed VALIDATION relied on (the sources its validator cited and was given, bound to the version it
 * was given) against the present: {why: [...], observed} (empty when it still holds). A validation recorded before
 * its sources carried versions binds nothing and is reused as before. (Self-audit round 3, assignment 1 (sealed
 * 323361a), question 5: only the plan's citations were bound and re-checked.)
 */
// `graph` (optional; KD2-3): a validation a recorded reassessment set reached (a qualification resting on a changed input)
// is not reused: it is validated again.
export function validationEvidence(rec, {bytesOf = () => null, versionOf = null, graph = null} = {}) {
  const why = [], observed = {};
  for (const x of graph ? graph.reassessed(rec?.hash) : []) { why.push(`reassessed: ${x.why}`); observed[`reassess:${x.key}`] = x.event; }
  for (const s of rec?.outputs?.sources ?? []) {
    if (!s?.delivered || s.version === undefined || s.version === null) continue;
    const file = typeof s.source === 'string' && s.source.startsWith('file:') ? s.source.slice(5) : null;
    const r = evidenceCheck(file ? {path: file, sha256: s.version} : {source: s.source, ref: s.ref, version: s.version, request: s.request ?? null}, {bytesOf, versionOf, rec});
    if (r) { why.push(r.why); observed[r.key] = r.now; }
  }
  return {why, observed};
}

/**
 * THE ATTEMPT IDENTITY (versioned: ATTEMPT_IDENTITY). The inputs a stage attempt is claimed with, from its gate: what it
 * received (upstream), the requirement, the stage that returned the work, the reassessment it answers, the status
 * entry it runs against and -- since version 2 -- `route`, the digest of WHAT MADE THE GATE ROUTE IT (earliestGate
 * below: the present ticket, dependencies, status entry, the evidence that made an earlier record stale, a wake
 * condition). The work ledger's idempotency key (work-ledger.mjs workKey) is the digest of these inputs, so a gate that
 * correctly routes a stage again because something it reads changed is NEW work, while a re-run on an unchanged routing
 * basis is still refused as already done. Version 1 inputs (no route, no status_entry) are what older ledgers recorded;
 * they keep verifying (a claim's key is compared, never re-derived from its inputs). (Self-audit round 3, assignment 1
 * (sealed 323361a), question 1: the identity omitted evidence, ticket, dependencies, status and capacity, and every
 * re-route the gate made was refused as "already completed".)
 */
export const ATTEMPT_IDENTITY = 2;
export function attemptInputs(gate, stages = []) {
  const up = gate.from ? stages.find(s => s.hash === gate.from) : null;
  return {upstream: up ? outputsDigest(up.outputs) : null, requirement: gate.requirement ? 'sha256:' + digest(gate.requirement) : null,
    ...(gate.returned_by ? {returned_by: gate.returned_by} : {}),
    // A re-review after a reassessment is new work on the same inputs: it is named by the reassessment it answers.
    ...(gate.rereview ? {rereview: gate.rereview.reassessment} : {}),
    ...(gate.route ? {route: gate.route} : {}),
    // THE GRAPH-DERIVED INPUT (KD2-2): the basis of the item's typed requirements as the graph states them now (each one's
    // existence and version, graph-loop.mjs analyzePlan), so an attempt after an unlock is new work. Absent for an item
    // whose plan states no typed requirement: its identity is exactly as before.
    ...(gate.graph?.basis ? {graph: gate.graph.basis} : {}),
    ...(gate.entry ? {status_entry: gate.entry} : {})};
}
/** The fields of a stage record's inputs that are its attempt identity (a stage adds others, e.g. the plan's mode). */
export const IDENTITY_FIELDS = Object.freeze(['upstream', 'requirement', 'returned_by', 'rereview', 'route', 'status_entry']);
/** The graph-derived field of the attempt identity (KD2-2; attemptInputs above), compared with the others. */
export const GRAPH_IDENTITY_FIELD = 'graph';
const ATTEMPT_FIELDS = Object.freeze([...IDENTITY_FIELDS, GRAPH_IDENTITY_FIELD]);
export const sameAttempt = (a, b) => ATTEMPT_FIELDS.every(k => (a?.[k] ?? null) === (b?.[k] ?? null));
/** A blocker the gate can observe the end of: review capacity (a reviewer pool signature recorded on the blocker). */
export const isCapacityBlock = b => b?.code === 'REVIEW_CAPACITY_PENDING' || /^REVIEW_CAPACITY_PENDING/.test(String(b?.what ?? ''));

/**
 * The attempt that DECIDES among attempts handed off from one record: the latest one that did not fail (a failed
 * attempt is retried on the same inputs and decides nothing), else the latest. A passed attempt that a later attempt
 * returned, blocked or left pending is superseded: it is never resurrected (independent review, assignment 1,
 * Google gemini-4-carbon, 09d490f, question 1).
 */
const decisive = attempts => attempts.filter(s => s.status !== 'failed').at(-1) ?? attempts.at(-1) ?? null;
/** The chain of passed stages that rests on `plan`, in order, following handoffs (each must be the next stage). */
function chainFrom(plan, stages, usable = () => true) {
  const chain = [plan];
  for (;;) {
    const last = chain.at(-1);
    const nextName = STAGES[STAGES.indexOf(last.stage) + 1];
    if (!nextName) break;
    // Route by the latest attempt: the chain continues only through the attempt that decides, when it passed.
    const latest = decisive(stages.filter(s => s.handoff?.from === last.hash && s.stage === nextName));
    if (!(latest?.status === 'passed' && latest.inputs.upstream === outputsDigest(last.outputs) && usable(latest))) break;
    chain.push(latest);
  }
  return chain;
}

/**
 * The earliest unmet gate. `item` is the latest status (with `entry`, `evidence`); `history` its statuses in order;
 * `depStatus(id)` the latest status of a dependency or null; `ticket` the readTicket result ({spec, digest, path}
 * or {why}) or null; `stages` this item's work.stage records in ledger order; `activeClaim` the live claim or null.
 */
// `capacity(stage)` (optional): the signature of the reviewer pool the stage executors would seat from NOW
// (stages.mjs capacityOf), so a stage pending on review capacity is re-dispatched when the pool changed. Without it
// (a caller with no executors: a status view) such a stage stays blocked.
// `outcomeRecheck(record)` (optional): why a passed outcome's proposal would now be refused at apply, or null.
// `graph` (optional; knowledge graphs, Slice D part 2, KD2-2 and KD2-3): the item's GRAPH-DERIVED INPUT (graph-loop.mjs
// gateInput): {version(id), reassessed(record), plan(record)}. It re-checks the typed requirements and reassessments of the
// plan and validation the gate would reuse (planValidity, validationEvidence), and a stage after the plan whose plan
// requires a prerequisite the graph shows MISSING is BLOCKED, with the prerequisite's id and the plan line that states it
// (withGraph below). Only an established requirement blocks; a hypothetical one is advisory. Without it the gate is
// exactly as before.
export function earliestGate(args) {
  return withGraph(gateOf(args), args.graph ?? null);
}
/**
 * The graph-derived block and unlock of a gate (KD2-2). A stage after the plan (implement, review, validate, outcome) the
 * gate routes is held when the plan it rests on requires a prerequisite the graph shows missing (and the plan does not
 * implement it), or is part of a prerequisite cycle, or when the graph has not observed the plan's requirements: the gate
 * is `blocked`, its blocker naming the prerequisite, the plan line and who implements it, and what it routed. Otherwise
 * the gate carries the graph report: the basis (attemptInputs `graph`) and what was UNLOCKED since the plan was made.
 * An item whose plan states no typed requirement is returned exactly as it was.
 */
function withGraph(g, graph) {
  if (!graph || typeof graph.plan !== 'function' || !STAGES.includes(g.gate) || g.gate === 'plan' || !g.reuse?.plan) return g;
  const a = graph.plan(g.reuse.plan);
  if (!a?.basis) return a?.advisory?.length ? {...g, graph: {advisory: a.advisory}} : g;
  if (a.block) {
    return {item: g.item, state: g.state, ...(g.entry ? {entry: g.entry} : {}), gate: 'blocked', stage: g.gate, requirement: g.requirement, reuse: g.reuse, ...(g.from ? {from: g.from} : {}),
      stale: g.stale ?? [], routed: {gate: g.gate, mode: g.mode ?? null, reason: g.reason ?? null, route: g.route ?? null}, graph: a.report, blocker: a.block, reason: a.block.what};
  }
  return {...g, graph: a.report};
}
function gateOf({item, history, depStatus, ticket = null, stages = [], activeClaim = null, bytesOf, versionOf = null, now = Date.now(), recovery = null, recoverySources = null,
  evidenceStable = null, reassessments = [], capacity = null, outcomeRecheck = null, graph = null}) {
  const base = {item: item.item, state: item.state, ...(item.entry ? {entry: item.entry} : {})};
  // THE ROUTING BASIS of the gate returned (see attemptInputs): the present state it read, never a record hash, so a
  // re-route on the same present state is the same work (refused as done) and a change of that state is new work.
  const routeOf = basis => 'sha256:' + digest({v: ATTEMPT_IDENTITY, entry: item.entry ?? null, ...basis});
  // A STRUCTURAL pending or blocked attempt waits for a change it can observe (self-audit round 3, assignment 1 (sealed
  // 323361a), question 1: every structural block had an unreachable resume):
  //   - review capacity: the reviewer pool's signature now differs from the one recorded on the blocker;
  //   - any structural block: the owner recorded a new status entry of the item since the attempt (its signed resume).
  // A transient one is retried when due (below); an evidence wait when the evidence changed.
  const wakeOf = att => {
    if (!att || att.blocker?.transient) return null;
    const cap = isCapacityBlock(att.blocker) && typeof capacity === 'function' ? capacity(att.stage) : null;
    if (cap && cap !== (att.blocker.capacity ?? null)) {
      return {wake: 'capacity', basis: {wake: 'capacity', capacity: cap}, why: `review capacity changed since the attempt (reviewer pool ${String(att.blocker.capacity ?? 'unrecorded').slice(0, 19)} -> ${cap.slice(0, 19)})`};
    }
    const at = att.inputs?.status_entry ?? null;
    if (at && item.entry && at !== item.entry) return {wake: 'status', basis: {wake: 'status'}, why: `the owner recorded a new status entry (${item.entry.slice(0, 19)}) since the attempt (${at.slice(0, 19)})`};
    return null;
  };
  // REASSESSMENT (work.reassessment): a later identity policy found that a recorded review of a cycle would not
  // qualify. That is evidence against reusing the approval: a stage whose approval came from such a cycle, and every
  // stage resting on it, is not reused. Nothing recorded is changed; the cycle still verifies under its own policy.
  const disqualified = new Map(reassessments.filter(r => (r.findings ?? []).length).map(r => [r.cycle, r]));
  const cyclesOf = s => (s.stage === 'plan' ? [s.outputs?.plan_review?.cycle] : s.stage === 'review' ? [s.outputs?.cycle] : []).filter(Boolean);
  const hit = s => cyclesOf(s).map(c => disqualified.get(c)).find(Boolean) ?? null;
  // A retry of an attempt made to answer a reassessment answers it too: the re-review (its corrected policy, its own
  // ledger, its replaced record) is carried through a pending or blocked attempt, never dropped (question 9).
  const byHash = new Map(reassessments.map(r => [r.hash, r]));
  const rereviewOf = s => {
    const r = s?.inputs?.rereview ? byHash.get(s.inputs.rereview) : null;
    return r ? {rereview: {stage: s.stage, cycle: r.cycle, reassessment: r.hash, policy_rules: r.policy_rules ?? null,
      ...(s.outputs?.rereview_of?.replaces ? {replaces: s.outputs.rereview_of.replaces} : {})}} : {};
  };
  if (activeClaim) return {...base, gate: 'claimed', reason: `claimed: ${activeClaim.stage}, attempt ${activeClaim.attempt} (lease)`, claim: activeClaim.hash};
  if (item.state === 'Resolved') {
    const ev = completionEvidence(item);
    // A Resolved item whose completion evidence rests on a disqualified review NEEDS RE-VERIFICATION. The owner's signed
    // status is not rewritten and the item is not reopened: the need is recorded here, for the owner.
    // That review is the change review the evidence cites, or the PLAN review of the plan the change rests on (by the
    // recorded handoffs from the cited cycle's review stage back to its plan; question 9).
    const reviewed = stages.find(s => s.stage === 'review' && s.status === 'passed' && s.outputs?.cycle && s.outputs.cycle === item.evidence?.review?.cycle) ?? null;
    let planRec = reviewed;
    while (planRec && planRec.stage !== 'plan') planRec = stages.find(s => s.hash === planRec.handoff?.from) ?? null;
    const again = ev.ok ? disqualified.get(item.evidence?.review?.cycle) ?? (planRec ? hit(planRec) : null) : null;
    if (again) {
      const what = `the review this Resolved status rests on was disqualified by a reassessment (${again.hash.slice(0, 19)}): ${again.findings.map(x => x.why).join('; ')}`;
      return {...base, gate: 'reverification-needed', reason: what, reassessment: again.hash,
        blocker: {what, role: 'decision-authority', resume_when: 'the owner records the item Ready to re-verify it through the lifecycle, or records why the status stands'}};
    }
    if (ev.ok) return {...base, gate: 'complete', reason: 'Resolved with completion evidence bound to its ticket, commit and a three-lab verified review'};
    // Evidence recovery (evidence-recovery.mjs) for THIS status entry: recovered evidence waits for the owner's
    // signature; a search that found none says what it searched. The status itself is never changed here.
    // A recovered proposal stands only while what it was re-checked against is unchanged: when its sources changed
    // since (cited bytes, the ticket, the ledgers, a reassessment), the item is searched again (question 5).
    const recoveredStale = recovery?.outcome === 'recovered' && recoverySources !== null && recovery.sources !== recoverySources;
    if (recovery?.outcome === 'recovered' && !recoveredStale) {
      return {...base, gate: 'awaiting-owner', reason: `${ev.why}; completion evidence was recovered from a retained run (proposal ${recovery.proposal.digest.slice(0, 19)})`,
        recovery: {outcome: recovery.outcome, record: recovery.hash, proposal: recovery.proposal.digest},
        blocker: {what: 'an unsigned proposal re-recording Resolved with recovered, structurally re-checked completion evidence', role: 'decision-authority',
          resume_when: 'the owner applies the proposal (node packages/ledger/status.mjs apply <file>) or declines it'}};
    }
    const searched = recoveredStale ? `; the evidence recovered earlier (proposal ${recovery.proposal.digest.slice(0, 19)}) rests on sources that changed since: it is searched again`
      : recovery ? `; evidence recovery searched ${recovery.searched.length} source(s) and none applies (${recovery.searched.map(x => `${x.ref}: ${x.result}`).join('; ')})`
      : '; evidence recovery has not searched yet';
    return {...base, gate: 'evidence-gap', reason: ev.why + searched, ...(recovery ? {recovery: {outcome: recovery.outcome, record: recovery.hash}} : {}),
      blocker: {what: ev.why + searched, role: 'decision-authority',
        resume_when: 'applicable retained evidence appears (searched again automatically when the item\'s sources change), or the owner records the item Ready to re-verify it through the lifecycle'}};
  }
  if (item.state === 'On Hold') {
    const what = item.waiting_on ? `waiting on ${item.waiting_on}: ${item.basis}` : `held: ${item.basis}`;
    return {...base, gate: 'blocked', reason: what, blocker: {what, role: item.owner_role ?? 'decision-authority',
      resume_when: item.waiting_on ? `the ${item.waiting_on} is supplied and the owner records the item Ready` : 'the owner records the item Ready'}};
  }
  const deps = Object.fromEntries((item.depends_on ?? []).map(d => [d, depStatus(d)]));
  const open = Object.entries(deps).filter(([, s]) => s?.state !== 'Resolved').map(([d]) => d);
  if (open.length) {
    return {...base, gate: 'blocked', reason: `depends on ${open.join(', ')}`, blocker: {what: `unresolved dependencies: ${open.join(', ')}`,
      role: 'lead@orch', resume_when: `${open.join(', ')} Resolved`}};
  }
  const requirement = requirementOf(history);
  const t = ticket && !ticket.why ? ticket : null;
  const stale = [];
  // A plan attempt that is pending or blocked on the present requirement decides, as a later attempt does after a
  // valid chain below: a structural block waits (it is not re-dispatched on identical inputs), and a transient one is
  // retried once due. A changed requirement makes it stale and the item is planned again.
  const lastPlan = stages.filter(s => s.stage === 'plan').at(-1) ?? null;
  if (lastPlan && (lastPlan.status === 'pending' || lastPlan.status === 'blocked') && lastPlan.identity?.requirement === requirementDigest(requirement)) {
    const returnedBy = lastPlan.inputs?.returned_by ?? null;
    // A RETRY of the same attempt keeps that attempt's routing basis (its recorded route), so retries stay bounded by
    // the scheduler's stage_attempts on the same inputs.
    if (lastPlan.status === 'pending' && lastPlan.blocker?.transient && Date.parse(lastPlan.blocker.retry_at ?? '') <= now) {
      return {...base, gate: 'plan', mode: lastPlan.outputs?.mode ?? (t ? 'revalidate' : 'author'), requirement, retry_of: lastPlan.hash, stale, route: lastPlan.inputs?.route ?? null,
        ...(returnedBy ? {returned_by: returnedBy, findings: stages.find(x => x.hash === returnedBy)?.findings ?? []} : {}), ...rereviewOf(lastPlan),
        reason: `plan was pending on a transient failure (${lastPlan.blocker.what}); its retry is due`};
    }
    // A plan that waited for evidence is planned again when the evidence changed (the dossier's stable digest), within
    // the scheduler's attempt bound ON THAT EVIDENCE (the stable digest is its routing basis); unchanged evidence is not
    // paid for twice.
    if (lastPlan.blocker?.code === 'EVIDENCE_INSUFFICIENT' && evidenceStable && evidenceStable !== lastPlan.outputs?.context?.dossier?.stable) {
      return {...base, gate: 'plan', mode: lastPlan.outputs?.mode ?? (t ? 'revalidate' : 'author'), requirement, retry_of: lastPlan.hash, stale,
        route: routeOf({gate: 'plan', wake: 'evidence', stable: evidenceStable}),
        ...(returnedBy ? {returned_by: returnedBy, findings: stages.find(x => x.hash === returnedBy)?.findings ?? []} : {}), ...rereviewOf(lastPlan),
        reason: 'the plan waited for evidence, and the evidence available to it has changed'};
    }
    const wake = wakeOf(lastPlan);
    if (wake) {
      return {...base, gate: 'plan', mode: lastPlan.outputs?.mode ?? (t ? 'revalidate' : 'author'), requirement, retry_of: lastPlan.hash, stale, wake: wake.wake,
        route: routeOf({gate: 'plan', ...wake.basis}),
        ...(returnedBy ? {returned_by: returnedBy, findings: stages.find(x => x.hash === returnedBy)?.findings ?? []} : {}), ...rereviewOf(lastPlan),
        reason: `plan was ${lastPlan.status} (${lastPlan.blocker?.what ?? ''}); ${wake.why}: it is dispatched again`};
    }
    return {...base, gate: 'blocked', stage: 'plan', requirement, blocker: lastPlan.blocker, stale,
      reason: `plan is ${lastPlan.status}: ${lastPlan.blocker?.what ?? lastPlan.next?.why ?? ''}`};
  }
  const passedPlans = stages.filter(s => s.stage === 'plan' && s.status === 'passed');
  let valid = null, planReassessed = null;
  const observed = {};
  for (const p of [...passedPlans].reverse()) {
    const v = planValidity(p, {requirement, deps: Object.fromEntries(Object.entries(deps).map(([d, s]) => [d, s ? {entry: s.entry} : null])), ticket: t, bytesOf, versionOf, graph});
    const bad = hit(p);
    if (bad) { planReassessed ??= bad; stale.push({stage: 'plan', record: p.hash, why: [`its plan review was disqualified by reassessment ${bad.hash.slice(0, 19)}`]}); continue; }
    if (v.valid) { valid = p; break; }
    stale.push({stage: 'plan', record: p.hash, why: v.why});
    Object.assign(observed, v.observed);
  }
  if (!valid) {
    // The routing basis of a (re-)plan: the mode, the present ticket and dependencies, and what the stale plans' checks
    // saw now. Not the stale records themselves: a plan stale again on the same present state is the same work.
    const route = routeOf({gate: 'plan', mode: t ? 'revalidate' : 'author', ticket: ticket?.digest ?? (ticket?.why ? `invalid: ${ticket.why}` : null),
      deps: Object.fromEntries(Object.entries(deps).map(([d, s]) => [d, s?.entry ?? null])), stale: [...new Set(stale.flatMap(x => x.why))].sort(), observed});
    return {...base, gate: 'plan', mode: t ? 'revalidate' : 'author', requirement, stale, route,
      ...(planReassessed ? {rereview: {stage: 'plan', cycle: planReassessed.cycle, reassessment: planReassessed.hash, policy_rules: planReassessed.policy_rules ?? null}} : {}),
      reason: planReassessed ? 'the plan\'s review was disqualified by a reassessment: the plan is re-checked and reviewed again'
        : t ? 'a ticket exists; its assumptions, scope, dependencies and acceptance criteria need re-checking' : 'no approved plan and no ticket: evaluation and planning'};
  }
  // A passed validation is reused only while the evidence its validator relied on is unchanged (validationEvidence).
  const evidenceOf = s => (s.stage === 'validate' ? validationEvidence(s, {bytesOf, versionOf, graph}) : {why: [], observed: {}});
  const chain = chainFrom(valid, stages, s => !hit(s) && !evidenceOf(s).why.length);
  const reuse = Object.fromEntries(chain.map(s => [s.stage, s.hash]));
  const last = chain.at(-1);
  // A passed outcome awaits the owner only while its proposal would still be accepted at apply (the same structural
  // re-check the outcome stage ran, now): otherwise it is produced again, and a refusal is recorded as its block
  // (self-audit round 3, assignment 1 (sealed 323361a), question 10: it was reused without a re-check).
  if (last.stage === 'outcome' && typeof outcomeRecheck === 'function') {
    const why = outcomeRecheck(last);
    if (why) {
      const from = chain.at(-2);
      return {...base, gate: 'outcome', requirement, reuse: Object.fromEntries(chain.slice(0, -1).map(s => [s.stage, s.hash])), from: from.hash,
        stale: [...stale, {stage: 'outcome', record: last.hash, why: [why]}], route: routeOf({gate: 'outcome', from: from.hash, recheck: why}),
        reason: `the outcome's proposal would now be refused at apply (${why}): it is produced again`};
    }
  }
  // A later attempt of the next stage that returned work to an earlier stage, or is pending/blocked, decides.
  const nextName = STAGES[STAGES.indexOf(last.stage) + 1] ?? null;
  // Follow the explicit handoff only: a record with equal output bytes from another chain is not this attempt.
  const tried = stages.filter(s => s.handoff?.from === last.hash);
  const latestTry = decisive(tried);
  // The stage after `last` passed, but on a review that a reassessment disqualified: it is done again, in its own
  // bounded re-review, and validation and the outcome that rested on it are not reused.
  const voided = latestTry?.status === 'passed' ? hit(latestTry) : null;
  if (voided) {
    return {...base, gate: latestTry.stage, mode: 'rereview', requirement, reuse, from: last.hash, stale: [...stale, {stage: latestTry.stage, record: latestTry.hash, why: [`disqualified by reassessment ${voided.hash.slice(0, 19)}`]}],
      route: routeOf({gate: latestTry.stage, from: last.hash, rereview: voided.hash}),
      rereview: {stage: latestTry.stage, cycle: voided.cycle, reassessment: voided.hash, policy_rules: voided.policy_rules ?? null, replaces: latestTry.hash},
      reason: `the ${latestTry.stage} of this work was disqualified by a reassessment (${voided.findings.map(x => x.why).join('; ')}): it is reviewed again`};
  }
  if (latestTry?.status === 'returned') {
    const to = latestTry.next.stage;
    const back = chain.find(s => s.stage === STAGES[STAGES.indexOf(to) - 1]) ?? null;
    return {...base, gate: to, mode: 'revise', requirement, reuse: Object.fromEntries(chain.filter(s => STAGES.indexOf(s.stage) < STAGES.indexOf(to)).map(s => [s.stage, s.hash])),
      from: back?.hash ?? null, findings: latestTry.findings, returned_by: latestTry.hash, stale, ...(to === 'plan' ? {revises: chain[0].hash} : {}), route: routeOf({gate: to, returned_by: latestTry.hash}),
      reason: `${latestTry.stage} returned the work to ${to}: ${latestTry.next.why}`};
  }
  // A transient pending whose retry is due goes back to its stage (the executor resumes its open cycle; the scheduler
  // bounds the retries on the same inputs). Before it is due, or for a structural pending, the item is blocked.
  if (latestTry?.status === 'pending' && latestTry.blocker?.transient && Date.parse(latestTry.blocker.retry_at ?? '') <= now) {
    return {...base, gate: latestTry.stage, mode: 'resume', requirement, reuse, from: last.hash, retry_of: latestTry.hash, stale, route: latestTry.inputs?.route ?? null, ...rereviewOf(latestTry),
      reason: `${latestTry.stage} was pending on a transient failure (${latestTry.blocker.what}); its retry is due`};
  }
  const wakeTry = latestTry && (latestTry.status === 'pending' || latestTry.status === 'blocked') ? wakeOf(latestTry) : null;
  if (wakeTry) {
    return {...base, gate: latestTry.stage, mode: 'resume', requirement, reuse, from: last.hash, retry_of: latestTry.hash, stale, wake: wakeTry.wake,
      route: routeOf({gate: latestTry.stage, from: last.hash, ...wakeTry.basis}), ...rereviewOf(latestTry),
      reason: `${latestTry.stage} was ${latestTry.status} (${latestTry.blocker?.what ?? ''}); ${wakeTry.why}: it is dispatched again`};
  }
  if (latestTry && (latestTry.status === 'pending' || latestTry.status === 'blocked')) {
    return {...base, gate: 'blocked', stage: latestTry.stage, requirement, reuse, from: last.hash, blocker: latestTry.blocker, stale,
      reason: `${latestTry.stage} is ${latestTry.status}: ${latestTry.blocker?.what ?? latestTry.next?.why ?? ''}`};
  }
  if (!nextName) return {...base, gate: 'awaiting-owner', requirement, reuse, stale, reason: 'the outcome is recorded; the owner signs the status transition',
    blocker: {what: 'an unsigned status transition', role: 'decision-authority', resume_when: 'the owner applies (or declines) the proposal'}};
  // A passed validation whose relied-on evidence changed is not reused: validation runs again on the present evidence.
  const revalidate = latestTry?.status === 'passed' && latestTry.stage === 'validate' ? evidenceOf(latestTry) : null;
  if (revalidate?.why.length) {
    return {...base, gate: nextName, requirement, reuse, from: last.hash, stale: [...stale, {stage: 'validate', record: latestTry.hash, why: revalidate.why}],
      route: routeOf({gate: nextName, from: last.hash, stale: [...revalidate.why].sort(), observed: revalidate.observed}),
      reason: `the evidence the validation relied on changed (${revalidate.why.join('; ')}): it is validated again`};
  }
  return {...base, gate: nextName, requirement, reuse, from: last.hash, stale, route: routeOf({gate: nextName, from: last.hash}), reason: `${last.stage} passed and is reused; ${nextName} is next`};
}
