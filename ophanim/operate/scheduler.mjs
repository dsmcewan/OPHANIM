// The deterministic controller's scheduler: it selects ready work, assembles the team each stage needs (through the
// stage executors, which seat by capability through Pantheon's selector), and moves every eligible item through the
// governed lifecycle. No person selects tickets: `tick` dispatches whatever reconciliation finds ready, and
// `watch` runs a tick whenever the inputs change (the status ledger head, the work ledger head, the tickets, the
// published issues), so new work and dependency changes reach dispatch on their own.
//
// Bounds, declared before dispatch and enforced across the whole tick: total provider calls (recorded usage; a stage that
// throws is recorded with what it was charged (L-302); a stage whose usage is unknown counts at its claim's budget, never
// as zero; calls CHARGED on the ledger before they
// were made, work.spend, count even when their stage never recorded; a live claim RESERVES the rest of its stage
// budget, so concurrent stages cannot both start on one remainder), iterations (stage attempts),
// elapsed time, retries per item and stage, and concurrency. A duplicate claim is refused by the work ledger
// itself. An interrupted claim (lease expired) is released as `expired` and the next tick resumes from the last
// recorded stage, reusing every stage that is still valid: nothing completed is repeated, no lineage is lost.
//
// A stage executor receives the VERIFIED handoff and returns its record. Executors are injected (stages.mjs builds
// the real ones over Pantheon; tests pass scripted ones). Missing authority (no controller key) or a missing
// executor produces a recorded block or a refusal, never a skipped verification.
import {openWorkLedger, handoffRefusal, STAGES} from './work-ledger.mjs';
import {requirementDigest, attemptInputs, sameAttempt} from './gates.mjs';
import {GEMINI_BILLING_OFF, GEMINI_BILLING_SCHEMA, GEMINI_KINDS, SETTING_OF, geminiBilling, policyRecord} from '../../pantheon/src/route/gemini-billing.mjs';
import {pathsOverlap} from '../../pantheon/src/pipeline/paths.mjs';
import {reconcile} from './reconcile.mjs';
import {createLane, isRound} from './self-repair.mjs';
import {recoverEvidence, bundlesOf, sourcesDigest} from './evidence-recovery.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LIMITS = Object.freeze({
  total_provider_calls: 0,          // no provider spend unless the caller declares a total
  stage_provider_calls: 40,         // per claimed stage
  iterations: 20,                   // stage attempts per tick
  stage_attempts: 3,                // retries of one stage of one item (failed attempts count)
  elapsed_ms: 60 * 60_000,
  concurrency: 1,
  lease_ms: 30 * 60_000,
  retry_after_ms: 15 * 60_000,
  recoveries: 50,                   // evidence-recovery searches per tick (no provider calls; reads and re-checks only)      // a TRANSIENT pending (a reviewer seat failed) is retried after this, within stage_attempts
});
const fail = (why, code) => { throw Object.assign(new Error(why), {code}); };

/**
 * Provider calls spent according to the work ledger, per claim:
 *   - a claim with a stage record: the larger of the record's usage (unknown usage counts at the claim's budget) and
 *     what was charged under it (work.spend);
 *   - a claim with no stage record (released, expired or interrupted): what was charged under it, so calls that left a
 *     process which then died are still counted (independent review, assignment 3, question 8);
 *   - a claim still live at `now` with no stage record: its charges so far, plus the REST OF ITS BUDGET as `reserved`
 *     (an in-flight reservation: a concurrent stage cannot spend what this one may still use; questions 1-3).
 * The budget check is total - calls - reserved.
 */
export function spent(work, {now = Date.now()} = {}) {
  const charged = new Map();
  for (const x of work.spends()) { const h = x.derived_from[0]; charged.set(h, Math.max(charged.get(h) ?? 0, x.provider_calls)); }
  const byClaim = new Map();
  for (const s of work.stages()) byClaim.set(s.derived_from[0], s);
  const released = new Set(work.releases().map(r => r.derived_from[0]));
  let calls = 0, unknown = 0, reserved = 0, chargedTotal = 0;
  for (const c of work.claims()) {
    const ch = charged.get(c.hash) ?? 0, s = byClaim.get(c.hash);
    chargedTotal += ch;
    if (s) {
      const u = s.usage?.provider_calls;
      if (Number.isInteger(u)) calls += Math.max(u, ch);
      else { calls += Math.max(c.budget.provider_calls, ch); unknown++; }
      continue;
    }
    calls += ch;
    if (!released.has(c.hash) && Date.parse(c.leased_at) + c.lease_ms > now) reserved += Math.max(0, c.budget.provider_calls - ch);
  }
  return {calls, unknown_counted_at_budget: unknown, reserved, charged: chargedTotal};
}

/**
 * The receiving stage's check of its handoff, BEFORE anything is spent: the record exists, is the same work, is a
 * valid start, and the whole chain under it re-derives back to its plan (work-ledger.mjs handoffRefusal) for the
 * requirement the gate asks for.
 */
export function verifyHandoff(work, gate) {
  const why = handoffRefusal(work, {item: gate.item, stage: gate.gate, from: gate.from ?? null, requirement: gate.requirement ? requirementDigest(gate.requirement) : null});
  if (why) fail(why, 'HANDOFF');
  return gate.from ? work.stages(gate.item).find(s => s.hash === gate.from) : null;
}

/**
 * The signature of everything that can make new work ready or wake a waiting item: the ledger heads, the tickets, the
 * published issues, AND the routing reconciliation derives from the evidence -- each item's gate, which already
 * re-reads exactly what can wake it: the dossier of a plan waiting for evidence, the cited evidence of an approved plan
 * (files and views), and the sources of an evidence recovery. Ordinary evidence files and retained runs were left out,
 * so a plan blocked on missing evidence was never woken when it appeared (independent review round 2, assignment 1,
 * OpenAI gpt-6.1-sol, 77480d6, question 5). Bounded as a tick's own reconciliation is: nothing is read that a tick would
 * not read, and nothing is dispatched or recorded.
 */
// `capacity` (optional): the stage executors' reviewer-pool signature (capacityOf below), so a change of the pool wakes a
// capacity-pending item as it wakes a tick.
// `graph` (optional; knowledge graphs, Slice D part 2, KD2-1): the graph loop (graph-loop.mjs createGraphLoop). Its CURSOR
// -- the graph ledger's head and every source's observed version -- is part of the signature, so a change in the graph
// (a new implemented-by, a newly established capability, a reassessment) wakes a tick as a ledger or ticket change does;
// an unchanged graph does not. The routing is read through the graph's gate inputs, read only (nothing is recorded).
export function inputSignature({repo, statusRoot, workRoot, issues = null, bundlesDir = null, now = Date.now(), capacity = null, graph = null}) {
  const head = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').at(-1) ?? '' : '');
  const tdir = path.join(repo, 'tickets');
  const tickets = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter(f => f.endsWith('.json')).sort().map(f => [f, fs.readFileSync(path.join(tdir, f), 'utf8')]) : [];
  // THE GRAPH CURSOR (KD2-1), read FIRST: it brings the loop's graph to the graph ledger's head, so the routing below is
  // reconciled on the graph as it is now.
  let cursor = null;
  if (graph) { try { cursor = graph.cursor(); } catch (e) { cursor = {unreadable: String(e.message).slice(0, 200)}; } }
  let routing = null;
  try {
    const work = openWorkLedger({root: workRoot, create: false});
    const rec = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now, capacity, ...(graph ? {graph: graph.context({write: false})} : {})});
    routing = rec.items.map(i => ({item: i.item, gate: i.gate.gate, mode: i.gate.mode ?? null, from: i.gate.from ?? null, retry_of: i.gate.retry_of ?? null,
      claim: i.gate.claim ?? null, recovery: i.gate.recovery ?? null, stale: (i.gate.stale ?? []).map(x => [x.record, x.why]),
      // The routing basis (gates.mjs attemptInputs) and a block's code: a re-route on new state, or a collision, is a change.
      route: i.gate.route ?? null, code: i.gate.blocker?.code ?? null,
      // An item with an evidence gap is searched again when its recovery sources change (tick, below): the same digest.
      ...(i.gate.gate === 'evidence-gap' ? {sources: sourcesDigest({repo, item: i.item, bundles: bundlesOf({item: i.item, bundlesDir, work}), work})} : {})}));
  } catch { routing = null; }   // no work ledger yet (the first tick makes it) or an unreadable status ledger: the heads decide
  // The cursor rides with the routing it decides: absent without a graph, so the signature is as before.
  if (graph) routing = {routing, graph: cursor};
  return 'sha256:' + digest({status: head(path.join(statusRoot, 'chain.jsonl')), work: head(path.join(workRoot, 'chain.jsonl')), tickets,
    issues: (issues ?? []).map(i => [i.number, i.state, i.title ?? '', i.body ?? '']).sort((a, b) => a[0] - b[0]), routing});
}

/**
 * One tick. Returns what it dispatched, what it reused, refused or blocked, and why it stopped.
 * executors: {plan, implement, review, validate, outcome}: async (ctx) => stage result.
 */
// `only` (an item id, optional): the ITEM SELECTOR. Intake, expired-claim release and evidence recovery still run for
// every item (bookkeeping, no provider call), but only that item is dispatched; every other runnable item is listed in
// `skipped` with why "outside the --item scope". Without it every runnable item is queued, as before.
// `interrupt` (an AbortSignal, optional): THE LAUNCHER'S OWN STOP (a SIGINT/SIGTERM/SIGHUP of the process that runs the
// tick; self-audit round 3, assignment 3 (sealed bb1287a), L-305). When it fires, the stage in flight is stopped (its
// signal aborts, code INTERRUPTED) and, when the executor returns, its claim is RELEASED as `interrupted` with no stage
// record: the late result is not a handoff, the charges made under it stay counted (spent()), and the item resumes from
// its last recorded stage at the next start instead of waiting out the whole lease. No further stage is dispatched. The
// claim in flight is announced on `progress` ({event: 'dispatch', claim, lease_until}), so a launcher whose executor does
// not return can release it itself (releaseInterrupted). Fencing is unchanged: a released claim records and charges nothing.
// THE STOP IS STRUCTURED (L-308): `stopped` (text, as before) is accompanied by `stop` {code, why}, code one of STOP_CODES.
export const STOP_CODES = Object.freeze({ITERATIONS: 'ITERATIONS_LIMIT', ELAPSED: 'ELAPSED_LIMIT', BUDGET: 'PROVIDER_CALL_BUDGET', STAGE_ELAPSED: 'STAGE_ELAPSED', INTERRUPTED: 'INTERRUPTED'});

// ---- THE GEMINI BILLING POLICY OF A TICK (register L-136; pantheon/src/route/gemini-billing.mjs, docs/billing-policy.md) ----
// `billing` (tick, watch) is the RESOLVED policy the launcher declared (cli.mjs flags, service.mjs config, live-run.mjs
// manifest; absent: both kinds off). Every claimed stage is handed a billing context over the WORK LEDGER under its claim
// (ctx.billing): consumption is counted from the ledger's work.billing entries -- all of them, every item and attempt --
// and every admitted billed request is recorded there, under the claim, before it is sent. So a restart, a resumed attempt
// or a later service tick applies the declared policy to the budget already consumed, never to a fresh one.
// A STAGE REFUSED BY THE POLICY is recorded pending on a transient blocker carrying the policy it was refused under
// (stages.mjs): it is retried when due under the same policy (and refused again while the policy is unchanged), and it is
// WOKEN at once when the launcher's policy changed the refused kind's setting; refusals under another policy do not count
// against the attempt bound of the policy now in force.
/** The billing ledger of one claim: the work ledger, read and written under that claim. */
export const workBillingLedger = (work, claim, clock = Date.now) => Object.freeze({
  where: `the work ledger ${work.root} (work.billing)`,
  used: kind => work.billings(kind).length,
  record: row => work.recordBilling({...row, claim, at: new Date(clock()).toISOString()}),
});
const isPolicy = p => p && typeof p === 'object' && p.schema === GEMINI_BILLING_SCHEMA && typeof p.digest === 'string';
/** The settings of the refused kinds changed since the attempt was refused: the owner's policy change wakes it. */
export function billingChanged(blocker, policy) {
  const b = blocker?.billing;
  if (!b || !b.settings || typeof b.settings !== 'object') return false;
  return Object.entries(b.settings).some(([kind, was]) => {
    const now = policy[SETTING_OF[kind]];
    return GEMINI_KINDS.includes(kind) && now && (now.enabled !== was?.enabled || now.budget !== was?.budget);
  });
}
/** The policy and what the work ledger records against it (for the tick's summary and the service status). */
export const billingStatus = (work, policy) => ({...policyRecord(policy), used: Object.fromEntries(GEMINI_KINDS.map(k => [SETTING_OF[k], work.billings(k).length]))});
/** Release `claim` as `interrupted` (the launcher was stopped), unless already released. Returns true when this call released it. */
export function releaseInterrupted(work, {claim, item, stage, why, at = new Date().toISOString()}) {
  if (work.released(claim)) return false;
  try { work.release({claim, item, stage, outcome: 'interrupted', why: `INTERRUPTED: ${why}`.slice(0, 600), at}); return true; }
  catch (e) { if (e?.code === 'LEDGER_REFUSED' && /that claim is already released/.test(String(e.message))) return false; throw e; }
}
// `graph` (optional; knowledge graphs, Slice D part 2, KD2-1 to KD2-6): the graph loop (graph-loop.mjs createGraphLoop).
// The tick opens it ONCE, from its signed snapshot; observes the sources it is configured to observe at the start, and
// the work source after every append (the write-back, idempotent); reconciles through its gate inputs (a stage after the
// plan is blocked while a required prerequisite is MISSING, and unlocked when it is established); hands the stage
// executors its handle (ctx.graph: the planner's graph and learning views, the team proposals); records discoveries only
// as candidates and proposals; and writes a snapshot at the end. It reports the queue: eligible, blocked (with the
// reason), runnable concurrently, unlocked, and the shared prerequisites (never merged). Without it the tick is as before.
// THE SELF-REPAIR LANE (ophanim/operate/self-repair.mjs; docs/self-repair.md). Every tick consults the lane: DORMANT -- nothing
// read beyond the status board, nothing recorded, the tick exactly as before -- unless the owner-signed board carries the
// `self-repair` item In progress (the switch; nothing is bound to it). While it is on, the tick opens at most ONE new round
// before reconciling (Detect over OPHANIM's own records, never `issues`), dispatches every open round as an item of its own
// with its stage executors wrapped by the lane (the plan's failing reproduction; validate's mechanical checks), each claim
// of a round carrying its paths (the work ledger refuses a claim while another item's live claim holds overlapping paths),
// and at the end lands every round whose outcome passed (one commit on the line, re-validated first when its base moved)
// and closes the rounds that ended. The global limits and billing policy apply to rounds unchanged. `selfRepair` (optional):
// the lane's options ({config, stateDir, records, register}), or false to leave the lane out of this tick.
export async function tick({repo, statusRoot, workRoot, issues = null, bundlesDir = null, executors = {}, limits = {}, holder = 'controller',
  clock = () => Date.now(), progress = () => {}, only = null, interrupt = null, billing = GEMINI_BILLING_OFF, graph = null, selfRepair = {}}) {
  if (only !== null && (typeof only !== 'string' || !only)) fail('tick: `only` names one status item id', 'USAGE');
  if (graph !== null && (typeof graph?.open !== 'function' || typeof graph?.context !== 'function')) fail('tick: `graph` is the graph loop (ophanim/operate/graph-loop.mjs createGraphLoop)', 'USAGE');
  if (!isPolicy(billing)) fail('tick: `billing` is the resolved Gemini billing policy (pantheon/src/route/gemini-billing.mjs resolveGeminiBilling)', 'USAGE');
  const L = {...DEFAULT_LIMITS, ...limits};
  const started = clock();
  const work = openWorkLedger({root: workRoot});
  const capacity = capacityOf(executors);
  const log = {dispatched: [], released_expired: [], intake: [], recovery: [], blocked: [], skipped: [], stopped: null, stop: null, interrupted: []};
  // THE GRAPH OF THIS TICK (KD2-1, KD2-6): one open, from the snapshot; the configured sources and the work source observed.
  const loop = graph;
  if (loop) { loop.open(); loop.observeStart(); loop.observeWork(); }
  const gctx = loop ? {graph: loop.context({write: true})} : {};
  const stopWith = (code, why) => { if (log.stopped === null) { log.stopped = why; log.stop = {code, why}; } };
  // Interrupted work: a claim past its lease is released as expired; its item resumes from its last valid stage.
  // BOOKKEEPING UNDER A RACE (independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6),
  // finding 3.2b). Each of these entries is unique on the work ledger, checked under its append lock (one release per
  // claim, one intake per source, one recovery per item, status entry and sources). Another scheduler process can record
  // the same entry between this tick's read and its append; the ledger then refuses this one, and that refusal means
  // the work is already recorded, not that the tick failed (it crashed tick() with LEDGER_REFUSED). Only that refusal is
  // absorbed: any other error is thrown as before.
  const raced = (fn, already) => {
    try { return {done: true, value: fn()}; }
    catch (e) { if (e?.code === 'LEDGER_REFUSED' && already.test(String(e.message))) return {done: false, why: String(e.message).slice(0, 300)}; throw e; }
  };
  for (const c of work.expiredClaims(clock())) {
    const r = raced(() => work.release({claim: c.hash, item: c.item, stage: c.stage, outcome: 'expired', why: 'the lease expired without a recorded result: interrupted', at: new Date(clock()).toISOString()}), /that claim is already released/);
    log.released_expired.push({item: c.item, stage: c.stage, attempt: c.attempt, ...(r.done ? {} : {by_another: true})});
  }
  // THE LANE (see the header): settle, Detect, open at most one round -- or nothing at all while it is dormant.
  const lane = selfRepair === false ? null : createLane({repo, statusRoot, workRoot, work, clock, ...(selfRepair ?? {})});
  // Dormant, begin() is synchronous and returns null: nothing is awaited, the tick's bookkeeping is exactly as before.
  const opening = lane ? lane.begin() : null;
  if (opening) await opening;
  let rec = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now: clock(), capacity, ...gctx});
  // Intake: every source of work is recorded once (by source and ref): status items, published issues (linked to an
  // item by its marker, or candidates), and tickets (an item's, or an orphan). Candidates and orphans are recorded and
  // never executed. (Independent review, assignment 1, Google gemini-4-carbon, 09d490f, question 7.)
  const known = new Set(work.intakes().map(i => `${i.source}|${i.ref}`));
  const intake = x => {
    if (known.has(`${x.source}|${x.ref}`)) return;
    known.add(`${x.source}|${x.ref}`);
    if (raced(() => work.intake(x), /intake is recorded once per source/).done) log.intake.push(x.ref);
  };
  for (const i of rec.items) {
    // A self-repair round is recorded by its own open event (work.repair), not as a status item it is not.
    if (isRound(i.item)) continue;
    intake({source: 'status', ref: `status:${i.item}`, item: i.item, classification: 'item', why: 'a status ledger item'});
    if (i.ticket) intake({source: 'ticket', ref: `ticket:${i.item}`, item: i.item, classification: 'item', why: i.ticket.invalid ? `the ticket of a status ledger item (invalid: ${String(i.ticket.invalid).slice(0, 200)})` : 'the ticket of a status ledger item'});
    for (const n of i.issues ?? []) intake({source: 'issue', ref: `issue:${n}`, item: i.item, classification: 'item', why: 'a published issue carrying the item\'s marker (issue text is data, never authority)'});
  }
  for (const o of rec.orphans ?? []) intake({source: 'ticket', ref: `ticket:${path.basename(o.ticket, '.json')}`, item: null, classification: 'candidate', why: o.why});
  for (const c of rec.candidates) intake({source: 'issue', ref: `issue:${c.number}`, item: null, classification: 'candidate', why: c.why});
  // Evidence recovery: each item Resolved without completion evidence is searched for applicable retained evidence once
  // per status entry and set of sources (evidence-recovery.mjs). What applies becomes an UNSIGNED proposal for the
  // owner; nothing is recorded on the status ledger. No provider is called.
  let searches = 0;
  for (const i of rec.items.filter(x => x.gate.gate === 'evidence-gap')) {
    if (searches >= L.recoveries) { log.recovery.push({item: i.item, outcome: 'deferred', why: `recovery limit ${L.recoveries} per tick reached`}); continue; }
    const sources = sourcesDigest({repo, item: i.item, bundles: bundlesOf({item: i.item, bundlesDir, work}), work});
    if (work.recoveries(i.item).some(r => r.status_entry === i.entry && r.sources === sources)) continue;
    searches++;
    const r = recoverEvidence({repo, statusRoot, item: i.item, bundlesDir, work, outDir: path.join(path.dirname(workRoot), 'operate', 'recovery'), now: clock()});
    const recorded = raced(() => work.recordRecovery({item: r.item, status_entry: r.status_entry, sources: r.sources, outcome: r.outcome, searched: r.searched,
      ...(r.proposal ? {proposal: {digest: r.proposal.digest, commit: r.proposal.commit, in_head: r.proposal.in_head}} : {}), at: new Date(clock()).toISOString()}), /against these sources and this status is already recorded/);
    log.recovery.push({item: r.item, outcome: r.outcome, ...(r.proposal ? {proposal: r.proposal.file, digest: r.proposal.digest} : {}), searched: r.searched.length, ...(recorded.done ? {} : {by_another: true})});
  }
  if (searches) rec = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now: clock(), capacity, ...gctx});
  // The intake and recovery entries just appended are observed into the work graph (the write-back, idempotent).
  if (loop && loop.observeWork().some(o => o.recorded)) rec = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now: clock(), capacity, ...gctx});
  if (loop) log.graph = {};
  const order = dependencyOrder(rec.items);
  let iterations = 0;
  // THE BILLING WAKE (see the header): a stage pending on a billing refusal whose refused kind's setting the launcher has
  // since changed is dispatched again now, not when its retry falls due: the gate is read as of that retry (the transient
  // pending's own retry route, gates.mjs), and the attempt bound counts only refusals under the settings now in force.
  const billingWake = gate => {
    if (gate?.gate !== 'blocked' || !gate.blocker?.transient || !billingChanged(gate.blocker, billing)) return gate;
    const due = Date.parse(gate.blocker.retry_at ?? '');
    if (!Number.isFinite(due)) return gate;
    const woken = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now: Math.max(clock(), due), capacity, ...gctx}).items.find(i => i.item === gate.item)?.gate;
    return woken && STAGES.includes(woken.gate) ? {...woken, billing_wake: {refused_under: gate.blocker.billing.policy, now: billing.digest}} : gate;
  };
  // THE STAGE'S BILLING RECORD (see the header): the policy in force and every billed request and refusal of the stage, on
  // its usage; and a stage the policy refused a billed request in that did not pass or return is PENDING on a transient
  // billing blocker -- its outputs (the work so far) kept, the blocker carrying the settings it was refused under.
  const withBilling = (result, ctx, stage) => {
    const pick = r => ({kind: r.kind, vendor: r.vendor, model: r.model, purpose: r.purpose ?? null, role: r.role ?? null, transport: r.transport, ...(r.code ? {code: r.code, provider_requests: 0} : {request: r.request, used_before: r.used_before})});
    const gemini = {policy: policyRecord(billing), billed: Object.fromEntries(GEMINI_KINDS.map(k => [SETTING_OF[k], ctx.rows.filter(r => r.kind === k).length])),
      rows: ctx.rows.map(pick), refusals: ctx.refusals.map(pick)};
    let out = {...result, usage: {...(result.usage ?? {provider_calls: null}), gemini}};
    if (!ctx.refusals.length || ['passed', 'returned'].includes(out.status)) return out;
    const kinds = [...new Set(ctx.refusals.map(r => r.kind))], codes = [...new Set(ctx.refusals.map(r => r.code))];
    const tag = {policy: billing.digest, codes, settings: Object.fromEntries(kinds.map(k => [k, {enabled: billing[SETTING_OF[k]].enabled, budget: billing[SETTING_OF[k]].budget}]))};
    const what = `${codes.join(', ')}: the Gemini billing policy refused ${ctx.refusals.length} billed request(s) of this ${stage} stage (${kinds.map(k => `${SETTING_OF[k]} ${billing[SETTING_OF[k]].enabled ? `enabled, budget ${billing[SETTING_OF[k]].budget}` : 'off'} (${billing[SETTING_OF[k]].source})`).join('; ')}); nothing billed was sent, and the work so far is kept`;
    const refused = {status_reported: out.status, ...(out.blocker ? {blocker_reported: out.blocker} : {}), refusals: gemini.refusals};
    // A transient pending the executor already named (the validator's METERED_FAILOVER_DISABLED, a seat pending its retry)
    // keeps its code and gains the billing tag; anything else that did not complete becomes the billing pending.
    if (out.status === 'pending' && out.blocker?.transient) return {...out, outputs: {...(out.outputs ?? {}), billing_refused: refused}, blocker: {...out.blocker, billing: tag}};
    return {...out, status: 'pending', outputs: {...(out.outputs ?? {}), billing_refused: refused},
      blocker: {code: codes[0], what, role: 'decision-authority', transient: true, billing: tag,
        resume_when: 'the owner changes the Gemini billing policy (enables the refused kind with a budget, or raises its budget), or the refused lane\'s quota resets (a failover is then not needed)'},
      next: {stage, why: what.slice(0, 300)}};
  };
  // Recorded and charged calls, and the in-flight reservation of every live claim (spent() above).
  const budgetLeft = () => { const sp = spent(work, {now: clock()}); return L.total_provider_calls - sp.calls - sp.reserved; };
  const runItem = async item => {
    let collided = null;
    for (;;) {
      if (interrupt?.aborted) { stopWith(STOP_CODES.INTERRUPTED, `interrupted: ${interrupt.reason?.message ?? 'the launcher was stopped'}`); return; }
      if (iterations >= L.iterations) { stopWith(STOP_CODES.ITERATIONS, `iterations limit ${L.iterations} reached`); return; }
      if (clock() - started > L.elapsed_ms) { stopWith(STOP_CODES.ELAPSED, `elapsed limit ${L.elapsed_ms} ms reached`); return; }
      rec = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now: clock(), capacity, ...gctx});
      const gate = billingWake(rec.items.find(i => i.item === item).gate);
      if (!STAGES.includes(gate.gate)) { if (gate.blocker) log.blocked.push({item, gate: gate.gate, blocker: gate.blocker}); return; }
      // The inputs of this attempt, its ATTEMPT IDENTITY (gates.mjs attemptInputs): what it received, the requirement, the
      // stage that returned the work, the reassessment it answers, the status entry, and the routing basis -- what made
      // the gate route it (the present ticket, dependencies, the evidence that staled a record, a wake). So a re-route on
      // changed state is new work, while a re-run on an identical routing basis is refused as already done.
      const inputs = attemptInputs(gate, work.stages(item));
      const same = work.stages(item).filter(s => s.stage === gate.gate && sameAttempt(s.inputs, inputs));
      // An attempt the billing policy refused under OTHER settings of the refused kind does not count against the bound
      // of the policy now in force (the owner changed it); one refused under the same settings does.
      const attempts = same.filter(s => !billingChanged(s.blocker, billing)).length;
      if (attempts >= L.stage_attempts) {
        log.blocked.push({item, gate: gate.gate, blocker: {what: `${attempts} attempts of ${gate.gate} on the same inputs`, role: 'lead@orch', resume_when: 'an input changes, or the owner raises the retry limit'}});
        return;
      }
      if (budgetLeft() < L.stage_provider_calls) { stopWith(STOP_CODES.BUDGET, `provider-call budget: ${budgetLeft()} left of ${L.total_provider_calls}, a stage needs up to ${L.stage_provider_calls}`); return; }
      // A round's stage executor is the lane's wrapper of it (the plan's reproduction, validate's mechanical checks).
      const exec = isRound(item) && lane?.on ? lane.wrap(gate.gate, executors[gate.gate]) : executors[gate.gate];
      if (typeof exec !== 'function') { log.skipped.push({item, gate: gate.gate, why: `no executor for ${gate.gate}`}); return; }
      const upstream = verifyHandoff(work, gate);
      // The stage's elapsed budget: what is left of the tick's, and never past the lease (a result recorded after the
      // lease is refused by the work ledger's fence), less a grace for recording it.
      const grace = Math.min(60_000, Math.floor(L.lease_ms / 10));
      const stageMs = Math.floor(Math.max(1, Math.min(L.elapsed_ms - (clock() - started), L.lease_ms - grace, 2 ** 31 - 1)));
      const budget = {provider_calls: L.stage_provider_calls, iterations: 1, elapsed_ms: stageMs, retries: L.stage_attempts};
      const attempt = same.length + 1;
      let claim;
      // The claim RESERVES its stage budget against the total ATOMICALLY: the work ledger refuses it, under its append
      // lock, when the total less every other claim's spend and live reservation cannot cover it, so two scheduler
      // processes that both passed the check above cannot both start (independent review, assignment 3 (OpenAI
      // gpt-6-astra extra review, 09d490f), questions 1 and 3).
      // A round's claim carries its paths: refused while another item's live claim holds overlapping ones (work-ledger.mjs).
      const round = isRound(item) && lane?.on ? lane.ctxOf(item) : null;
      try { claim = work.claim({item, stage: gate.gate, attempt, inputs, holder, budget, lease_ms: L.lease_ms, at: new Date(clock()).toISOString(), total_provider_calls: L.total_provider_calls,
        ...(round ? {paths: lane.claimPaths(item)} : {})}); }
      // Missing authority is a block on the whole tick, never a quiet skip of one item.
      catch (e) {
        if (e.code === 'NO_AUTHORITY') throw e;
        if (e.code === 'PROVIDER_CALL_BUDGET') { stopWith(STOP_CODES.BUDGET, `provider-call budget: ${e.message.slice(0, 300)}`); return; }
        if (e.code === 'PATHS_CLAIMED') { log.skipped.push({item, gate: gate.gate, code: 'PATHS_CLAIMED', why: e.message.slice(0, 600)}); return; }
        // "Already completed for these exact inputs": another holder completed this very attempt between this tick's read
        // and its claim (reconciliation reports a standing collision as a block before any claim). Read again once; the
        // same refusal twice is reported as a block with its reason, never a silent skip (self-audit round 3,
        // assignment 1 (sealed 323361a), question 1).
        if (/already completed for these exact inputs/.test(e.message)) {
          const key = JSON.stringify(inputs) + gate.gate;
          if (collided !== key) { collided = key; continue; }
          log.blocked.push({item, gate: gate.gate, blocker: {code: 'ATTEMPT_IDENTITY_COLLISION', what: `ATTEMPT_IDENTITY_COLLISION: ${e.message}`.slice(0, 600), role: 'lead@orch',
            resume_when: 'something the gate reads changes, or the owner records a new status entry of the item'}});
          return;
        }
        log.skipped.push({item, gate: gate.gate, why: e.message}); return;
      }
      iterations++;
      progress({event: 'dispatch', item, stage: gate.gate, attempt, mode: gate.mode ?? null, claim, lease_until: new Date(clock() + L.lease_ms).toISOString()});
      // CHARGE BEFORE THE CALL: an executor calls ctx.charge(n) before it makes n provider calls. The charge is signed
      // onto the work ledger (work.spend) first, so a call that leaves the process is counted even if the process dies
      // before the stage record. A charge over the stage budget, after the stage's deadline, or under a claim that
      // was released or expired (the lease fence) throws, and the call is not made.
      // THE COOPERATIVE STOP (question 9): ctx.signal aborts at the stage's elapsed budget; an executor passes it on
      // (to the pipeline, the review cycles) and stops admitting provider calls. The stop is recorded on the stage.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(Object.assign(new Error(`STAGE_ELAPSED: the stage's elapsed budget of ${budget.elapsed_ms} ms is spent`), {code: 'STAGE_ELAPSED'})), budget.elapsed_ms);
      timer.unref?.();
      const onInterrupt = () => ac.abort(Object.assign(new Error(`INTERRUPTED: ${interrupt.reason?.message ?? 'the launcher was stopped'}`), {code: 'INTERRUPTED'}));
      if (interrupt?.aborted) onInterrupt(); else interrupt?.addEventListener('abort', onInterrupt, {once: true});
      let charged = 0, refusedCharges = 0;
      const charge = (n = 1) => {
        if (!(Number.isInteger(n) && n >= 1)) fail('charge(n): n is a positive integer', 'USAGE');
        const why = ac.signal.aborted ? ac.signal.reason.message
          : charged + n > budget.provider_calls ? `PROVIDER_CALL_LIMIT: ${charged} of ${budget.provider_calls} stage provider call(s) charged, ${n} more refused` : null;
        if (why) { refusedCharges += n; fail(why, ac.signal.aborted ? 'STAGE_ELAPSED' : 'PROVIDER_CALL_LIMIT'); }
        work.recordSpend({claim, provider_calls: charged + n, at: new Date(clock()).toISOString()});
        charged += n;
        return charged;
      };
      let result;
      // fence(): throws LEASE_FENCED once this claim is released or past its lease; an executor calls it before a shared
      // side effect (a ticket, a shared ledger's close, a branch), so a stale holder writes none (finding 4, stages.mjs).
      const fence = () => { const why = work.leaseRefusal(claim, new Date(clock()).toISOString()); if (why) fail(why, 'LEASE_FENCED'); };
      // THE STAGE'S BILLING CONTEXT (see the header): the declared policy over the work ledger under this claim.
      const stageBilling = geminiBilling({policy: billing, ledger: workBillingLedger(work, claim, clock)});
      try { result = await exec({item, gate, upstream, attempt, budget, repo, work, reuse: gate.reuse ?? {}, issues, bundlesDir, charge, fence, signal: ac.signal, ...(loop ? {graph: loop.executor()} : {}), claim, billing: stageBilling,
        ...(round ? {selfRepair: round} : {})}); }
      catch (e) {
        // THE ACTUAL SPEND (self-audit round 3, assignment 3 (sealed bb1287a), L-302): every provider call is charged on the
        // work ledger before it is made (the executor contract above), so `charged` IS what this attempt spent, 0 included;
        // an executor that reports more (e.provider_calls) is believed. Unknown (null, then counted at the claim's whole
        // budget by spent()) only when the executor says it cannot know (e.provider_calls_unknown: calls made outside charge).
        const reported = Number.isInteger(e?.provider_calls) && e.provider_calls >= 0 ? e.provider_calls : null;
        const calls = e?.provider_calls_unknown === true ? null : Math.max(reported ?? 0, charged);
        result = {status: 'failed', outputs: {error: String(e.message).slice(0, 300)}, team: [], contributions: [], findings: [],
          usage: {provider_calls: calls, basis: calls === null ? 'unknown: the executor made calls outside the charge' : reported !== null && reported > charged ? 'reported by the executor' : 'charged on the work ledger before each call'},
          next: {stage: gate.gate, why: `the ${gate.gate} executor failed: ${String(e.message).slice(0, 200)}`}};
      } finally { clearTimeout(timer); interrupt?.removeEventListener('abort', onInterrupt); }
      // THE LAUNCHER WAS STOPPED (L-305): no stage record, the claim released as `interrupted` (see the header).
      if (ac.signal.aborted && ac.signal.reason?.code === 'INTERRUPTED') {
        const at = new Date(clock()).toISOString();
        const released = releaseInterrupted(work, {claim, item, stage: gate.gate, at,
          why: `${ac.signal.reason.message.replace(/^INTERRUPTED: /, '')}; the ${gate.gate} stage (attempt ${attempt}) was stopped before its result was recorded (it reported ${result.status}); ${charged} provider call(s) charged under it stay counted`});
        log.interrupted.push({item, stage: gate.gate, attempt, claim, charged, status_reported: result.status, released, at});
        stopWith(STOP_CODES.INTERRUPTED, `interrupted: ${ac.signal.reason.message}`);
        progress({event: 'interrupted', item, stage: gate.gate, claim, released});
        return;
      }
      result = withBilling(result, stageBilling, gate.gate);
      // THE BUDGET, STRUCTURALLY (L-308): a stage that was charged its whole provider-call budget ran out of it (every call
      // is charged before it is made, and a meter refuses the call past the budget), whatever words its result uses. The
      // record says so in `usage.budget_exhausted` (with what was charged), for a reader that classifies stops by code.
      if (charged >= budget.provider_calls) result = {...result, usage: {...(result.usage ?? {provider_calls: null}), budget_exhausted: {code: 'STAGE_PROVIDER_CALLS', charged, budget: budget.provider_calls, refused_charges: refusedCharges}}};
      // A result that reports more calls than its stage budget is not a pass: recorded failed, with the reason named.
      const reported = result.usage?.provider_calls;
      if (Number.isInteger(reported) && reported > budget.provider_calls) {
        result = {...result, status: 'failed', blocker: undefined, outputs: {...(result.outputs ?? {}), over_budget: {reported, budget: budget.provider_calls, status_reported: result.status}},
          next: {stage: gate.gate, why: `STAGE_BUDGET_EXCEEDED: the ${gate.gate} result reports ${reported} provider call(s), over its stage budget of ${budget.provider_calls}`}};
      }
      // THE ELAPSED STOP IS NOT A HANDOFF (independent review, assignment 3 (xAI grok-4.7, 09d490f), questions 2 and 9;
      // (OpenAI gpt-6-astra extra review, 09d490f), questions 2 and 9). A result that arrives after the stage's signal
      // aborted is recorded with the stop; one that would hand the work on (passed, or returned to an earlier stage) is
      // recorded PENDING on a transient STAGE_ELAPSED blocker instead, with the status it reported: reconciliation never
      // reuses it, it is retried within the stage's attempt bound, and no further stage of the item starts in this tick.
      // A stopped stage of ANY other status is the same transient stop: a `blocked` or `failed` that the abort itself
      // caused (a fit pipeline aborted mid-wave finishes its units blocked, PIPELINE_UNITS_UNRESOLVED) was recorded as a
      // structural block and wedged the item (independent review round 2, assignment 3 (Google gemini-4-carbon, manual,
      // 77480d6), finding 2.1). Its outputs (the work kept so far) stay on the record; only a result over its stage
      // budget stays failed, since that is a violation and not a stop.
      const stopped = ac.signal.aborted;
      if (stopped) {
        const late = !result.outputs?.over_budget;
        const why = `STAGE_ELAPSED: the ${gate.gate} stage's elapsed budget of ${budget.elapsed_ms} ms was spent before it returned${late ? ` (it reported ${result.status}); the late result is not a handoff` : ''}`;
        result = {...result, outputs: {...(result.outputs ?? {}), stopped: {code: 'STAGE_ELAPSED', elapsed_ms: budget.elapsed_ms, charged, refused_charges: refusedCharges, ...(late ? {status_reported: result.status} : {}),
          ...(late && result.blocker ? {blocker_reported: result.blocker} : {})}}};
        if (late) {
          result = {...result, status: 'pending', next: {stage: gate.gate, why},
            blocker: {code: 'STAGE_ELAPSED', transient: true, what: why, role: 'lead@orch', resume_when: 'the stage is retried, within its attempt bound, by a tick with elapsed budget left'}};
        }
        stopWith(STOP_CODES.STAGE_ELAPSED, `stage elapsed limit ${budget.elapsed_ms} ms reached (${item} ${gate.gate})`);
      }
      const identity = {item, requirement: 'sha256:' + digest({item: gate.requirement.item, title: gate.requirement.title, basis: gate.requirement.basis}),
        ...(result.identity?.ticket ?? upstream?.identity.ticket ? {ticket: result.identity?.ticket ?? upstream.identity.ticket} : {})};
      const stageAt = new Date(clock()).toISOString();
      let stageHash;
      try { stageHash = work.recordStage({claim, from: upstream?.hash ?? null, at: stageAt, stage: gate.gate, attempt, status: result.status, identity,
        // THE UNLOCK, RECORDED (KD2-2): a prerequisite the plan cited as missing that the graph now shows established.
        inputs: {...inputs, ...(gate.graph?.unlocked?.length ? {graph_unlocked: gate.graph.unlocked.map(u => ({prerequisite: u.prerequisite, line: u.line, basis: u.basis, established_at: u.established_at}))} : {}),
          ...(result.inputs ?? {})}, outputs: result.outputs ?? {}, team: result.team ?? [], contributions: result.contributions ?? [],
        findings: result.findings ?? [], usage: result.usage ?? {provider_calls: null}, next: result.next ?? null,
        // A transient pending (an unavailable reviewer) is retried when due, bounded by stage_attempts on the same inputs;
        // a structural one (capacity, a missing prerequisite) waits for a change of inputs.
        ...(result.blocker ? {blocker: result.blocker.transient && result.status === 'pending'
          ? {...result.blocker, retry_at: new Date(clock() + L.retry_after_ms).toISOString()} : result.blocker} : {})}); }
      catch (e) {
        if (e.code !== 'LEASE_FENCED') throw e;
        // The lease fence refused the result: this holder outlived its claim. Nothing it produced becomes the handoff;
        // the charges it made stay counted. The claim is released as expired if nobody has done so yet.
        if (!work.released(claim)) raced(() => work.release({claim, item, stage: gate.gate, outcome: 'expired', why: `the result arrived after the lease: ${e.message}`.slice(0, 300), at: stageAt}), /that claim is already released/);
        log.skipped.push({item, gate: gate.gate, why: e.message});
        progress({event: 'fenced', item, stage: gate.gate, why: e.message});
        return;
      }
      const outcome = {passed: 'completed', returned: 'returned', failed: 'failed', pending: 'blocked', blocked: 'blocked'}[result.status];
      // Another process may have released the claim as expired between the record and this release (finding 3.2b).
      raced(() => work.release({claim, item, stage: gate.gate, outcome, why: result.next?.why ?? result.status, at: stageAt}), /that claim is already released/);
      // THE WRITE-BACK (KD2-5): the record is observed into the work graph; a finding the learning graph relates to an
      // established failure class becomes a proposal to the coordinator.
      if (loop) { const wb = loop.writeBack(work.stages(item).find(x => x.hash === stageHash) ?? null); if (wb.proposals.length) (log.graph.proposals ??= []).push(...wb.proposals.map(x => x.file)); }
      log.dispatched.push({item, stage: gate.gate, attempt, status: result.status, record: stageHash, next: result.next?.stage ?? null,
        provider_calls: result.usage?.provider_calls ?? null, ...(gate.graph?.unlocked?.length ? {unlocked: gate.graph.unlocked.map(u => u.prerequisite)} : {})});
      progress({event: 'stage', item, stage: gate.gate, status: result.status});
      if (result.status === 'failed' || stopped) return;
    }
  };
  // Concurrency: up to L.concurrency items at once; the work ledger's claims keep them from colliding. An item pending on a
  // billing refusal whose refused kind's setting changed is runnable too (the billing wake).
  const runnable = i => STAGES.includes(i.gate.gate) || STAGES.includes(billingWake(i.gate).gate);
  let queue = order.filter(runnable).map(i => i.item);
  if (only !== null) {
    for (const i of order) if (i.item !== only && runnable(i)) log.skipped.push({item: i.item, gate: i.gate.gate, why: 'outside the --item scope'});
    const found = rec.items.find(i => i.item === only);
    log.scope = {only, on_ledger: Boolean(found), gate: found?.gate.gate ?? null, runnable: queue.includes(only)};
    queue = queue.filter(i => i === only);
  }
  for (const i of rec.items) if (!runnable(i) && i.gate.blocker) log.blocked.push({item: i.item, gate: i.gate.gate, blocker: i.gate.blocker});
  // THE QUEUE, AS THE GRAPH SEES IT (Graph E's operational use; KD2-2): eligible, blocked with the reason, runnable
  // concurrently (disjoint claimed paths), unlocked, and the shared prerequisites (reported, never merged).
  if (loop) log.queue = queueReport(rec, order, queue, runnable);
  const workers = Array.from({length: Math.max(1, L.concurrency)}, async () => { for (let it = queue.shift(); it; it = queue.shift()) await runItem(it); });
  await Promise.all(workers);
  // THE END OF THE TICK, WITH THE GRAPH (KD2-1, KD2-5): the last appends observed; a missing prerequisite that no item's plan
  // implements, now that every item had its turn to plan, is an intake CANDIDATE, recorded unsigned and never executed;
  // the snapshot the next tick opens from.
  if (loop) {
    loop.observeWork();
    const fin = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now: clock(), capacity, ...gctx});
    const candidates = loop.recordCandidates(fin.graph?.candidates ?? []);
    log.graph = {...log.graph, candidates: (fin.graph?.candidates ?? []).map(c => ({ref: c.ref, prerequisite: c.prerequisite, required_by: c.items})), recorded_candidates: candidates,
      snapshot: loop.checkpoint(), stats: loop.stats()};
  }
  // THE LANE'S END (see the header): land what passed its outcome; close what ended. Reported only when the switch exists.
  if (lane?.on) {
    const fin = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now: clock(), capacity, ...gctx});
    await lane.end({rec: fin, blocked: log.blocked});
  }
  if (lane && (lane.on || lane.log.present)) log.self_repair = lane.log;
  return {...log, spent: spent(work, {now: clock()}), limits: L, reconcile: {counts: rec.counts, ledger: rec.ledger}, billing: billingStatus(work, billing)};
}

/**
 * The reviewer-pool signature of the stage executors, by stage (stages.mjs attaches `capacity()` to each executor it
 * makes), or null when the executors carry none (scripted executors): the gate then cannot observe a capacity change.
 */
export function capacityOf(executors) {
  return stage => { try { const f = executors?.[stage]?.capacity; return typeof f === 'function' ? f() ?? null : null; } catch { return null; } };
}

/**
 * THE QUEUE REPORT of a tick with the graph (KD2-2): what is eligible (dispatched in this order), blocked (with the gate's
 * code, the prerequisite and the plan line), runnable concurrently (groups of eligible items whose claimed paths are
 * disjoint, as the work ledger's per-item claims allow), unlocked, and the shared prerequisites. Two items sharing a
 * prerequisite stay two entries: nothing is merged, each keeps its own claims and ownership.
 * Two claimed paths clash when they could name a common path: the owned-path grammar's one overlap function
 * (pantheon/src/pipeline/paths.mjs pathsOverlap: globs, `**`, a path inside a directory, case; conservative when unsure),
 * never exact equality (D2 fixes, outside-lab review: `src/a/*` and `src/a/b.mjs` were reported as runnable together).
 */
export function queueReport(rec, order, queue, runnable = i => STAGES.includes(i.gate.gate)) {
  const eligible = [...queue];
  const blocked = rec.items.filter(i => !runnable(i) && i.gate.blocker).map(i => ({item: i.item, gate: i.gate.gate, stage: i.gate.stage ?? null, code: i.gate.blocker.code ?? null,
    ...(i.gate.blocker.prerequisite ? {prerequisite: i.gate.blocker.prerequisite, line: i.gate.blocker.line, implementers: i.gate.blocker.implementers ?? []} : {}),
    ...(i.gate.blocker.cycle ? {cycle: i.gate.blocker.cycle} : {}), why: String(i.gate.blocker.what ?? '').slice(0, 300)}));
  const unlocked = rec.items.filter(i => i.gate.graph?.unlocked?.length).map(i => ({item: i.item, gate: i.gate.gate, unlocked: i.gate.graph.unlocked.map(u => u.prerequisite)}));
  const paths = new Map(rec.items.map(i => [i.item, i.claimed_paths ?? []]));
  const clash = (a, b) => (paths.get(a) ?? []).some(x => (paths.get(b) ?? []).some(y => pathsOverlap(x, y)));
  const concurrent = [];
  for (const it of eligible) { const g = concurrent.find(grp => grp.every(o => !clash(o, it))); if (g) g.push(it); else concurrent.push([it]); }
  return {eligible, blocked, concurrent, unlocked, order: order.map(i => i.item), shared: rec.graph?.shared ?? [], cycles: rec.graph?.cycles ?? [],
    candidates: (rec.graph?.candidates ?? []).map(c => c.ref)};
}

/**
 * Items in dependency order (a dependency before its dependents), then by id. An item that waits for another because that
 * one IMPLEMENTS a prerequisite it requires (reconcile.mjs `graph_depends_on`, KD2-2) is ordered after it, as a status
 * dependency is.
 */
export function dependencyOrder(items) {
  const by = new Map(items.map(i => [i.item, i])), out = [], seen = new Set();
  const visit = i => { if (seen.has(i.item)) return; seen.add(i.item); for (const d of [...(i.depends_on ?? []), ...(i.graph_depends_on ?? [])]) if (by.has(d)) visit(by.get(d)); out.push(i); };
  for (const i of [...items].sort((a, b) => a.item.localeCompare(b.item))) visit(i);
  return out;
}

/**
 * The trigger: tick whenever the input signature changes. `once` runs a single check (for tests and cron);
 * otherwise it polls every `interval_ms` until `signal` aborts. Returns the ticks it ran.
 */
export async function watch({repo, statusRoot, workRoot, fetchIssues = async () => null, interval_ms = 60_000, once = false, signal = null, state = {last: null}, ...rest}) {
  const ticks = [];
  for (;;) {
    const issues = await fetchIssues();
    const sigOf = () => inputSignature({repo, statusRoot, workRoot, issues, bundlesDir: rest.bundlesDir ?? null, now: (rest.clock ?? Date.now)(), capacity: capacityOf(rest.executors), graph: rest.graph ?? null});
    const sig = sigOf();
    // A tick runs when an input changed, or when a transient pending's retry is due (time is not an input).
    const now = (rest.clock ?? Date.now)();
    if (sig !== state.last || (state.due !== null && state.due !== undefined && now >= state.due)) {
      const t = await tick({repo, statusRoot, workRoot, issues, ...rest});
      ticks.push(t);
      state.last = sigOf();
      const dues = t.blocked.map(b => Date.parse(b.blocker?.retry_at ?? '')).filter(Number.isFinite);
      state.due = dues.length ? Math.min(...dues) : null;
    }
    if (once || signal?.aborted) return ticks;
    // The wait between polls ends on the stop (L-121): a stopped watch does not sleep out its interval first.
    await new Promise(r => { const t = setTimeout(done, interval_ms); function done() { clearTimeout(t); signal?.removeEventListener('abort', done); r(); } signal?.addEventListener('abort', done, {once: true}); });
    if (signal?.aborted) return ticks;
  }
}
