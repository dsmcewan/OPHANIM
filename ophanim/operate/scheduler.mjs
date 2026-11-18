// The deterministic controller's scheduler: it selects ready work, assembles the team each stage needs (through the
// stage executors, which seat by capability through Pantheon's selector), and moves every eligible item through the
// governed lifecycle. No person selects tickets: `tick` dispatches whatever reconciliation finds ready, and
// `watch` runs a tick whenever the inputs change (the status ledger head, the work ledger head, the tickets, the
// published issues), so new work and dependency changes reach dispatch on their own.
//
// Bounds, declared before dispatch and enforced across the whole tick: total provider calls (recorded usage;
// a stage whose usage is unknown counts at its claim's budget, never as zero), iterations (stage attempts),
// elapsed time, retries per item and stage, and concurrency. A duplicate claim is refused by the work ledger
// itself. An interrupted claim (lease expired) is released as `expired` and the next tick resumes from the last
// recorded stage, reusing every stage that is still valid: nothing completed is repeated, no lineage is lost.
//
// A stage executor receives the VERIFIED handoff and returns its record. Executors are injected (stages.mjs builds
// the real ones over Pantheon; tests pass scripted ones). Missing authority (no controller key) or a missing
// executor produces a recorded block or a refusal, never a skipped verification.
import {openWorkLedger, outputsDigest, STAGES} from './work-ledger.mjs';
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

/** Provider calls already spent by the work ledger's stage records; unknown usage counts at its claim's budget. */
export function spent(work) {
  const claims = new Map(work.claims().map(c => [c.hash, c]));
  let calls = 0, unknown = 0;
  for (const s of work.stages()) {
    const c = s.usage?.provider_calls;
    if (Number.isInteger(c)) calls += c;
    else { const claim = claims.get(s.derived_from.find(h => claims.has(h))); calls += claim?.budget.provider_calls ?? 0; unknown++; }
  }
  return {calls, unknown_counted_at_budget: unknown};
}

/** The receiving stage's check of its handoff: the record exists, is the same work, and is a valid start. */
export function verifyHandoff(work, gate) {
  if (!gate.from) {
    if (gate.gate !== 'plan') fail(`${gate.item}: ${gate.gate} has no handoff to start from`, 'HANDOFF');
    return null;
  }
  const rec = work.stages(gate.item).find(s => s.hash === gate.from);
  if (!rec) fail(`${gate.item}: the handoff ${String(gate.from).slice(0, 19)} is not a stage record of this item`, 'HANDOFF');
  const wanted = STAGES[STAGES.indexOf(gate.gate) - 1];
  if (rec.stage !== wanted) fail(`${gate.item}: ${gate.gate} receives from ${wanted}, not ${rec.stage}`, 'HANDOFF');
  if (rec.status !== 'passed') fail(`${gate.item}: the ${rec.stage} handoff is ${rec.status}, not passed`, 'HANDOFF');
  return rec;
}

/** The signature of everything that can make new work ready or wake a waiting item. */
export function inputSignature({repo, statusRoot, workRoot, issues = null}) {
  const head = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').at(-1) ?? '' : '');
  const tdir = path.join(repo, 'tickets');
  const tickets = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter(f => f.endsWith('.json')).sort().map(f => [f, fs.readFileSync(path.join(tdir, f), 'utf8')]) : [];
  return 'sha256:' + digest({status: head(path.join(statusRoot, 'chain.jsonl')), work: head(path.join(workRoot, 'chain.jsonl')), tickets,
    issues: (issues ?? []).map(i => [i.number, i.state, i.body ?? '']).sort((a, b) => a[0] - b[0])});
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
  const log = {dispatched: [], released_expired: [], intake: [], recovery: [], blocked: [], skipped: [], stopped: null};
  // Interrupted work: a claim past its lease is released as expired; its item resumes from its last valid stage.
  for (const c of work.expiredClaims(clock())) {
    work.release({claim: c.hash, item: c.item, stage: c.stage, outcome: 'expired', why: 'the lease expired without a recorded result: interrupted'});
    log.released_expired.push({item: c.item, stage: c.stage, attempt: c.attempt});
  }
  let rec = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now: clock()});
  // Intake: every source of work is recorded once (by ref); candidates are recorded and never executed.
  const known = new Set(work.intakes().map(i => i.ref));
  for (const i of rec.items) if (!known.has(`status:${i.item}`)) { work.intake({source: 'status', ref: `status:${i.item}`, item: i.item, classification: 'item', why: 'a status ledger item' }); log.intake.push(`status:${i.item}`); }
  for (const c of rec.candidates) if (!known.has(`issue:${c.number}`)) { work.intake({source: 'issue', ref: `issue:${c.number}`, item: null, classification: 'candidate', why: c.why}); log.intake.push(`issue:${c.number}`); }
  // Evidence recovery: each item Resolved without completion evidence is searched for applicable retained evidence once
  // per status entry and set of sources (evidence-recovery.mjs). What applies becomes an UNSIGNED proposal for the
  // owner; nothing is recorded on the status ledger. No provider is called.
  let searches = 0;
  for (const i of rec.items.filter(x => x.gate.gate === 'evidence-gap')) {
    if (searches >= L.recoveries) { log.recovery.push({item: i.item, outcome: 'deferred', why: `recovery limit ${L.recoveries} per tick reached`}); continue; }
    const sources = sourcesDigest({repo, item: i.item, bundles: bundlesOf({item: i.item, bundlesDir, work})});
    if (work.recoveries(i.item).some(r => r.status_entry === i.entry && r.sources === sources)) continue;
    searches++;
    const r = recoverEvidence({repo, statusRoot, item: i.item, bundlesDir, work, outDir: path.join(path.dirname(workRoot), 'operate', 'recovery'), now: clock()});
    work.recordRecovery({item: r.item, status_entry: r.status_entry, sources: r.sources, outcome: r.outcome, searched: r.searched,
      ...(r.proposal ? {proposal: {digest: r.proposal.digest, commit: r.proposal.commit, in_head: r.proposal.in_head}} : {}), at: new Date(clock()).toISOString()});
    log.recovery.push({item: r.item, outcome: r.outcome, ...(r.proposal ? {proposal: r.proposal.file, digest: r.proposal.digest} : {}), searched: r.searched.length});
  }
  if (searches) rec = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now: clock()});
  const order = dependencyOrder(rec.items);
  let iterations = 0;
  const budgetLeft = () => L.total_provider_calls - spent(work).calls;
  const runItem = async item => {
    for (;;) {
      if (iterations >= L.iterations) { log.stopped ??= `iterations limit ${L.iterations} reached`; return; }
      if (clock() - started > L.elapsed_ms) { log.stopped ??= `elapsed limit ${L.elapsed_ms} ms reached`; return; }
      rec = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now: clock()});
      const gate = rec.items.find(i => i.item === item).gate;
      if (!STAGES.includes(gate.gate)) { if (gate.blocker) log.blocked.push({item, gate: gate.gate, blocker: gate.blocker}); return; }
      // The inputs of this attempt: what it received, the requirement, and -- for a revision -- the stage that returned
      // the work (so a revision is new work, while a re-run on identical inputs is refused as already done).
      const upstreamRec = gate.from ? work.stages(item).find(x => x.hash === gate.from) : null;
      const inputs = {upstream: upstreamRec ? outputsDigest(upstreamRec.outputs) : null, requirement: gate.requirement ? 'sha256:' + digest(gate.requirement) : null,
        ...(gate.returned_by ? {returned_by: gate.returned_by} : {}),
        // A re-review after a reassessment is new work on the same inputs: it is named by the reassessment it answers.
        ...(gate.rereview ? {rereview: gate.rereview.reassessment} : {})};
      const attempts = work.stages(item).filter(s => s.stage === gate.gate && (s.inputs?.upstream ?? null) === inputs.upstream
        && (s.inputs?.requirement ?? null) === inputs.requirement && (s.inputs?.returned_by ?? null) === (inputs.returned_by ?? null)
        && (s.inputs?.rereview ?? null) === (inputs.rereview ?? null)).length;
      if (attempts >= L.stage_attempts) {
        log.blocked.push({item, gate: gate.gate, blocker: {what: `${attempts} attempts of ${gate.gate} on the same inputs`, role: 'lead@orch', resume_when: 'an input changes, or the owner raises the retry limit'}});
        return;
      }
      if (budgetLeft() < L.stage_provider_calls) { log.stopped ??= `provider-call budget: ${budgetLeft()} left of ${L.total_provider_calls}, a stage needs up to ${L.stage_provider_calls}`; return; }
      const exec = executors[gate.gate];
      if (typeof exec !== 'function') { log.skipped.push({item, gate: gate.gate, why: `no executor for ${gate.gate}`}); return; }
      const upstream = verifyHandoff(work, gate);
      const budget = {provider_calls: L.stage_provider_calls, iterations: 1, elapsed_ms: L.elapsed_ms, retries: L.stage_attempts};
      const attempt = attempts + 1;
      let claim;
      try { claim = work.claim({item, stage: gate.gate, attempt, inputs, holder, budget, lease_ms: L.lease_ms, at: new Date(clock()).toISOString()}); }
      // Missing authority is a block on the whole tick, never a quiet skip of one item.
      catch (e) { if (e.code === 'NO_AUTHORITY') throw e; log.skipped.push({item, gate: gate.gate, why: e.message}); return; }
      iterations++;
      progress({event: 'dispatch', item, stage: gate.gate, attempt, mode: gate.mode ?? null});
      let result;
      try { result = await exec({item, gate, upstream, attempt, budget, repo, work, reuse: gate.reuse ?? {}, issues, bundlesDir}); }
      catch (e) {
        result = {status: 'failed', outputs: {error: String(e.message).slice(0, 300)}, team: [], contributions: [], findings: [], usage: {provider_calls: e.provider_calls ?? null},
          next: {stage: gate.gate, why: `the ${gate.gate} executor failed: ${String(e.message).slice(0, 200)}`}};
      }
      const identity = {item, requirement: 'sha256:' + digest({item: gate.requirement.item, title: gate.requirement.title, basis: gate.requirement.basis}),
        ...(result.identity?.ticket ?? upstream?.identity.ticket ? {ticket: result.identity?.ticket ?? upstream.identity.ticket} : {})};
      const stageHash = work.recordStage({claim, from: upstream?.hash ?? null, stage: gate.gate, attempt, status: result.status, identity,
        inputs: {...inputs, ...(result.inputs ?? {})}, outputs: result.outputs ?? {}, team: result.team ?? [], contributions: result.contributions ?? [],
        findings: result.findings ?? [], usage: result.usage ?? {provider_calls: null}, next: result.next ?? null,
        // A transient pending (an unavailable reviewer) is retried when due, bounded by stage_attempts on the same inputs;
        // a structural one (capacity, a missing prerequisite) waits for a change of inputs.
        ...(result.blocker ? {blocker: result.blocker.transient && result.status === 'pending'
          ? {...result.blocker, retry_at: new Date(clock() + L.retry_after_ms).toISOString()} : result.blocker} : {})});
      const outcome = {passed: 'completed', returned: 'returned', failed: 'failed', pending: 'blocked', blocked: 'blocked'}[result.status];
      work.release({claim, item, stage: gate.gate, outcome, why: result.next?.why ?? result.status});
      log.dispatched.push({item, stage: gate.gate, attempt, status: result.status, record: stageHash, next: result.next?.stage ?? null,
        provider_calls: result.usage?.provider_calls ?? null});
      progress({event: 'stage', item, stage: gate.gate, status: result.status});
      if (result.status === 'failed') return;
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
  return {...log, spent: spent(work), limits: L, reconcile: {counts: rec.counts, ledger: rec.ledger}};
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
    const sig = inputSignature({repo, statusRoot, workRoot, issues});
    // A tick runs when an input changed, or when a transient pending's retry is due (time is not an input).
    const now = (rest.clock ?? Date.now)();
    if (sig !== state.last || (state.due !== null && state.due !== undefined && now >= state.due)) {
      const t = await tick({repo, statusRoot, workRoot, issues, ...rest});
      ticks.push(t);
      state.last = inputSignature({repo, statusRoot, workRoot, issues});
      const dues = t.blocked.map(b => Date.parse(b.blocker?.retry_at ?? '')).filter(Number.isFinite);
      state.due = dues.length ? Math.min(...dues) : null;
    }
    if (once || signal?.aborted) return ticks;
    await new Promise(r => setTimeout(r, interval_ms));
    if (signal?.aborted) return ticks;
  }
}
