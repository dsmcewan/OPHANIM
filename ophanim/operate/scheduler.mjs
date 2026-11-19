// The deterministic controller's scheduler: it selects ready work, assembles the team each stage needs (through the
// stage executors, which seat by capability through Pantheon's selector), and moves every eligible item through the
// governed lifecycle. No person selects tickets: `tick` dispatches whatever reconciliation finds ready, and
// `watch` runs a tick whenever the inputs change (the status ledger head, the work ledger head, the tickets, the
// published issues), so new work and dependency changes reach dispatch on their own.
//
// Bounds, declared before dispatch and enforced across the whole tick: total provider calls (recorded usage;
// a stage whose usage is unknown counts at its claim's budget, never as zero; calls CHARGED on the ledger before they
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
import {reconcile} from './reconcile.mjs';
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
export function inputSignature({repo, statusRoot, workRoot, issues = null, bundlesDir = null, now = Date.now(), capacity = null}) {
  const head = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').at(-1) ?? '' : '');
  const tdir = path.join(repo, 'tickets');
  const tickets = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter(f => f.endsWith('.json')).sort().map(f => [f, fs.readFileSync(path.join(tdir, f), 'utf8')]) : [];
  let routing = null;
  try {
    const work = openWorkLedger({root: workRoot, create: false});
    const rec = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now, capacity});
    routing = rec.items.map(i => ({item: i.item, gate: i.gate.gate, mode: i.gate.mode ?? null, from: i.gate.from ?? null, retry_of: i.gate.retry_of ?? null,
      claim: i.gate.claim ?? null, recovery: i.gate.recovery ?? null, stale: (i.gate.stale ?? []).map(x => [x.record, x.why]),
      // The routing basis (gates.mjs attemptInputs) and a block's code: a re-route on new state, or a collision, is a change.
      route: i.gate.route ?? null, code: i.gate.blocker?.code ?? null,
      // An item with an evidence gap is searched again when its recovery sources change (tick, below): the same digest.
      ...(i.gate.gate === 'evidence-gap' ? {sources: sourcesDigest({repo, item: i.item, bundles: bundlesOf({item: i.item, bundlesDir, work}), work})} : {})}));
  } catch { routing = null; }   // no work ledger yet (the first tick makes it) or an unreadable status ledger: the heads decide
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
export async function tick({repo, statusRoot, workRoot, issues = null, bundlesDir = null, executors = {}, limits = {}, holder = 'controller',
  clock = () => Date.now(), progress = () => {}, only = null}) {
  if (only !== null && (typeof only !== 'string' || !only)) fail('tick: `only` names one status item id', 'USAGE');
  const L = {...DEFAULT_LIMITS, ...limits};
  const started = clock();
  const work = openWorkLedger({root: workRoot});
  const capacity = capacityOf(executors);
  const log = {dispatched: [], released_expired: [], intake: [], recovery: [], blocked: [], skipped: [], stopped: null};
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
  let rec = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now: clock(), capacity});
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
  if (searches) rec = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now: clock(), capacity});
  const order = dependencyOrder(rec.items);
  let iterations = 0;
  // Recorded and charged calls, and the in-flight reservation of every live claim (spent() above).
  const budgetLeft = () => { const sp = spent(work, {now: clock()}); return L.total_provider_calls - sp.calls - sp.reserved; };
  const runItem = async item => {
    let collided = null;
    for (;;) {
      if (iterations >= L.iterations) { log.stopped ??= `iterations limit ${L.iterations} reached`; return; }
      if (clock() - started > L.elapsed_ms) { log.stopped ??= `elapsed limit ${L.elapsed_ms} ms reached`; return; }
      rec = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now: clock(), capacity});
      const gate = rec.items.find(i => i.item === item).gate;
      if (!STAGES.includes(gate.gate)) { if (gate.blocker) log.blocked.push({item, gate: gate.gate, blocker: gate.blocker}); return; }
      // The inputs of this attempt, its ATTEMPT IDENTITY (gates.mjs attemptInputs): what it received, the requirement, the
      // stage that returned the work, the reassessment it answers, the status entry, and the routing basis -- what made
      // the gate route it (the present ticket, dependencies, the evidence that staled a record, a wake). So a re-route on
      // changed state is new work, while a re-run on an identical routing basis is refused as already done.
      const inputs = attemptInputs(gate, work.stages(item));
      const attempts = work.stages(item).filter(s => s.stage === gate.gate && sameAttempt(s.inputs, inputs)).length;
      if (attempts >= L.stage_attempts) {
        log.blocked.push({item, gate: gate.gate, blocker: {what: `${attempts} attempts of ${gate.gate} on the same inputs`, role: 'lead@orch', resume_when: 'an input changes, or the owner raises the retry limit'}});
        return;
      }
      if (budgetLeft() < L.stage_provider_calls) { log.stopped ??= `provider-call budget: ${budgetLeft()} left of ${L.total_provider_calls}, a stage needs up to ${L.stage_provider_calls}`; return; }
      const exec = executors[gate.gate];
      if (typeof exec !== 'function') { log.skipped.push({item, gate: gate.gate, why: `no executor for ${gate.gate}`}); return; }
      const upstream = verifyHandoff(work, gate);
      // The stage's elapsed budget: what is left of the tick's, and never past the lease (a result recorded after the
      // lease is refused by the work ledger's fence), less a grace for recording it.
      const grace = Math.min(60_000, Math.floor(L.lease_ms / 10));
      const stageMs = Math.floor(Math.max(1, Math.min(L.elapsed_ms - (clock() - started), L.lease_ms - grace, 2 ** 31 - 1)));
      const budget = {provider_calls: L.stage_provider_calls, iterations: 1, elapsed_ms: stageMs, retries: L.stage_attempts};
      const attempt = attempts + 1;
      let claim;
      // The claim RESERVES its stage budget against the total ATOMICALLY: the work ledger refuses it, under its append
      // lock, when the total less every other claim's spend and live reservation cannot cover it, so two scheduler
      // processes that both passed the check above cannot both start (independent review, assignment 3 (OpenAI
      // gpt-6-astra extra review, 09d490f), questions 1 and 3).
      try { claim = work.claim({item, stage: gate.gate, attempt, inputs, holder, budget, lease_ms: L.lease_ms, at: new Date(clock()).toISOString(), total_provider_calls: L.total_provider_calls}); }
      // Missing authority is a block on the whole tick, never a quiet skip of one item.
      catch (e) {
        if (e.code === 'NO_AUTHORITY') throw e;
        if (/PROVIDER_CALL_BUDGET/.test(e.message)) { log.stopped ??= `provider-call budget: ${e.message.slice(0, 300)}`; return; }
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
      progress({event: 'dispatch', item, stage: gate.gate, attempt, mode: gate.mode ?? null});
      // CHARGE BEFORE THE CALL: an executor calls ctx.charge(n) before it makes n provider calls. The charge is signed
      // onto the work ledger (work.spend) first, so a call that leaves the process is counted even if the process dies
      // before the stage record. A charge over the stage budget, after the stage's deadline, or under a claim that
      // was released or expired (the lease fence) throws, and the call is not made.
      // THE COOPERATIVE STOP (question 9): ctx.signal aborts at the stage's elapsed budget; an executor passes it on
      // (to the pipeline, the review cycles) and stops admitting provider calls. The stop is recorded on the stage.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(Object.assign(new Error(`STAGE_ELAPSED: the stage's elapsed budget of ${budget.elapsed_ms} ms is spent`), {code: 'STAGE_ELAPSED'})), budget.elapsed_ms);
      timer.unref?.();
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
      try { result = await exec({item, gate, upstream, attempt, budget, repo, work, reuse: gate.reuse ?? {}, issues, bundlesDir, charge, fence, signal: ac.signal, claim}); }
      catch (e) {
        result = {status: 'failed', outputs: {error: String(e.message).slice(0, 300)}, team: [], contributions: [], findings: [], usage: {provider_calls: e.provider_calls ?? (charged || null)},
          next: {stage: gate.gate, why: `the ${gate.gate} executor failed: ${String(e.message).slice(0, 200)}`}};
      } finally { clearTimeout(timer); }
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
        log.stopped ??= `stage elapsed limit ${budget.elapsed_ms} ms reached (${item} ${gate.gate})`;
      }
      const identity = {item, requirement: 'sha256:' + digest({item: gate.requirement.item, title: gate.requirement.title, basis: gate.requirement.basis}),
        ...(result.identity?.ticket ?? upstream?.identity.ticket ? {ticket: result.identity?.ticket ?? upstream.identity.ticket} : {})};
      const stageAt = new Date(clock()).toISOString();
      let stageHash;
      try { stageHash = work.recordStage({claim, from: upstream?.hash ?? null, at: stageAt, stage: gate.gate, attempt, status: result.status, identity,
        inputs: {...inputs, ...(result.inputs ?? {})}, outputs: result.outputs ?? {}, team: result.team ?? [], contributions: result.contributions ?? [],
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
      log.dispatched.push({item, stage: gate.gate, attempt, status: result.status, record: stageHash, next: result.next?.stage ?? null,
        provider_calls: result.usage?.provider_calls ?? null});
      progress({event: 'stage', item, stage: gate.gate, status: result.status});
      if (result.status === 'failed' || stopped) return;
    }
  };
  // Concurrency: up to L.concurrency items at once; the work ledger's claims keep them from colliding.
  let queue = order.filter(i => STAGES.includes(i.gate.gate)).map(i => i.item);
  if (only !== null) {
    for (const i of order) if (i.item !== only && STAGES.includes(i.gate.gate)) log.skipped.push({item: i.item, gate: i.gate.gate, why: 'outside the --item scope'});
    const found = rec.items.find(i => i.item === only);
    log.scope = {only, on_ledger: Boolean(found), gate: found?.gate.gate ?? null, runnable: queue.includes(only)};
    queue = queue.filter(i => i === only);
  }
  for (const i of rec.items) if (!STAGES.includes(i.gate.gate) && i.gate.blocker) log.blocked.push({item: i.item, gate: i.gate.gate, blocker: i.gate.blocker});
  const workers = Array.from({length: Math.max(1, L.concurrency)}, async () => { for (let it = queue.shift(); it; it = queue.shift()) await runItem(it); });
  await Promise.all(workers);
  return {...log, spent: spent(work, {now: clock()}), limits: L, reconcile: {counts: rec.counts, ledger: rec.ledger}};
}

/**
 * The reviewer-pool signature of the stage executors, by stage (stages.mjs attaches `capacity()` to each executor it
 * makes), or null when the executors carry none (scripted executors): the gate then cannot observe a capacity change.
 */
export function capacityOf(executors) {
  return stage => { try { const f = executors?.[stage]?.capacity; return typeof f === 'function' ? f() ?? null : null; } catch { return null; } };
}

/** Items in dependency order (a dependency before its dependents), then by id. */
export function dependencyOrder(items) {
  const by = new Map(items.map(i => [i.item, i])), out = [], seen = new Set();
  const visit = i => { if (seen.has(i.item)) return; seen.add(i.item); for (const d of i.depends_on ?? []) if (by.has(d)) visit(by.get(d)); out.push(i); };
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
    const sigOf = () => inputSignature({repo, statusRoot, workRoot, issues, bundlesDir: rest.bundlesDir ?? null, now: (rest.clock ?? Date.now)(), capacity: capacityOf(rest.executors)});
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
    await new Promise(r => setTimeout(r, interval_ms));
    if (signal?.aborted) return ticks;
  }
}
