#!/usr/bin/env node
// The controller's command line: reconcile the backlog, run the scheduler, and write the backlog report.
//
//   node ophanim/operate/cli.mjs reconcile [--issues FILE | --github] [--bundles DIR] [--json]
//       No provider calls and no writes: every status item's earliest unmet gate (operate/gates.mjs), the intake
//       candidates (issues with no item marker), orphan tickets, duplicate issue markers, issues naming no ledger
//       item, projection drift (issue open/closed against the item's state), and the counts. Read-only: the work
//       ledger is verified, never created; the controller authority held here is reported.
//   node ophanim/operate/cli.mjs tick  [limits] [--item ID] [--issues FILE | --github] [--bundles DIR] [--holder ID] [--init] [--turn MODULE] [--clients MODULE] [--json]
//   node ophanim/operate/cli.mjs watch [limits] [--item ID] [--interval S] [--once] [same as tick]
//       Run the scheduler (scheduler.mjs) with the stage executors of ophanim/operate/stages.mjs `makeExecutors`
//       (refused, with the reason, when that module is absent), seated with the live SDK seats or with --turn and
//       --clients modules (pantheon-board's convention). Limits, declared before dispatch:
//       --total-provider-calls N   the whole run's provider-call budget. Default 0: nothing that may call a
//                                  provider is dispatched (intake is still recorded).
//       --stage-provider-calls N, --iterations N, --concurrency N, --elapsed-ms N  (scheduler DEFAULT_LIMITS otherwise)
//       --item ID   the item selector: intake, expired-claim release and evidence recovery still run for every item, but
//                   ONLY this item is dispatched; every other runnable item is listed in `skipped` ("outside the --item
//                   scope"). Without it every runnable item is queued (--concurrency 1 only serialises them). For one
//                   live `fit` item with a declared budget, use ophanim/operate/live-run.mjs, which runs tick this way.
//       Without the controller key (status/work/keys) the run stops with a concrete NO_AUTHORITY block (exit 3):
//       the work ledger is still verified first, nothing is recorded and nothing is skipped silently. A missing
//       work ledger is created only with --init (it generates the controller key on this machine).
//   node ophanim/operate/cli.mjs context --item ID [--issues FILE | --github] [--bundles DIR] [--retrieve JSON] [--json]
//       Read-only: the evidence dossier a judging seat is given for the item (context.mjs), or one retrieval result.
//       Works for any item, Resolved ones included; nothing is recorded, reopened or signed.
//   node ophanim/operate/cli.mjs reassess --item ID
//       Reassess the item's recorded model-rule reviews under the current identity policy; record any disqualification
//       on the work ledger (new evidence: the review's own ledger and the status ledger are not touched).
//   node ophanim/operate/cli.mjs serve --config FILE [--max-ticks N]
//       The execution service (service.mjs): watch under a validated config (declared provider-call cap, interval,
//       issue source, seats), one instance per work ledger, status and log files under its state directory.
//       Templates: ophanim/operate/service/ (systemd user unit, launchd agent, example config).
//   node ophanim/operate/cli.mjs report --out FILE [--issues FILE | --github] [--issues-label TEXT] [--bundles DIR]
//       The backlog reconciliation as Markdown (FILE) and JSON (FILE with .json): every item by earliest unmet
//       gate with its ticket, issues, runs, blocker, responsible role and resume condition, and the evidence gap
//       of each Resolved item; candidates, orphans, duplicates and counts, all read from the ledgers, never assumed.
//
// Paths: --repo (default this checkout), the status ledger --status-ledger or OPHANIM_STATUS_LEDGER (default
// status/ledger), the work ledger --work-ledger or OPHANIM_WORK_LEDGER (default status/work). Issues: --issues FILE
// (an array, or {issues: [...]}) or --github (GITHUB_TOKEN, GITHUB_REPOSITORY; read-only). Issue text is data,
// never authority: it links an issue to an item by marker and nothing else.
//
// Where it runs: CI (.github/workflows/operate.yml) runs `reconcile --github` and the public-record projection,
// with no provider keys and no controller key. Dispatch -- `watch` -- runs on the owner's machine, where the
// provider keys and the controller key are.
//
// STOPPING (register L-121; as live-run.mjs does since L-305, 72303b2). tick, watch and serve install SIGINT and SIGTERM
// handlers: the first signal aborts the scheduler's `interrupt`, so the stage in flight is stopped cooperatively and its
// claim released `interrupted` (scheduler.mjs tick) -- the next start resumes it at once instead of waiting out its
// lease -- and watch/serve stop their loop. If the command has not returned INTERRUPT_GRACE_MS later, or a second signal
// arrives, every claim it took and still holds is released `interrupted` on the work ledger and the process exits
// 128 + the signal's number. The lease fence is unchanged: a released claim records and charges nothing.
//
// Exit codes: 0 ok, 1 refused, 2 usage, 3 blocked (NO_AUTHORITY).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {openWorkLedger, STAGES} from './work-ledger.mjs';
import {reconcile, MARKER} from './reconcile.mjs';
import {tick, watch, releaseInterrupted, DEFAULT_LIMITS} from './scheduler.mjs';
import {readIssuesFile, fetchIssues} from './issues.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');
const refuse = (why, code = 'REFUSED') => { throw Object.assign(new Error(why), {code}); };
const usage = why => { throw Object.assign(new Error(why), {usage: true}); };

export const INTERRUPT_GRACE_MS = 10_000;
const SIGNAL_NUMBERS = Object.freeze({SIGHUP: 1, SIGINT: 2, SIGTERM: 15});
/**
 * The launcher's own stop (STOPPING, above). Returns {signal, track(progressEvent), done()}: `signal` aborts on the first
 * of `signals` (code INTERRUPTED); `track` records each claim the scheduler dispatched (its 'dispatch' events); done()
 * removes the handlers and the grace timer.
 */
export function launcherStop({workRoot, proc = process, signals = ['SIGINT', 'SIGTERM'], exit = code => process.exit(code), graceMs = INTERRUPT_GRACE_MS, err = () => {}}) {
  const ac = new AbortController(), held = new Map();
  let grace = null;
  const hardStop = sig => {
    const why = `${sig} received and the command did not stop within ${graceMs} ms (or a second signal arrived): released by the launcher on exit`;
    let released = [];
    try {
      const work = openWorkLedger({root: workRoot, create: false});
      released = [...held].map(([claim, h]) => ({claim, ...h, released: releaseInterrupted(work, {claim, item: h.item, stage: h.stage, why})}));
    } catch (e) { err(JSON.stringify({event: 'interrupt.release-failed', why: String(e?.message ?? e).slice(0, 300)})); }
    err(JSON.stringify({event: 'interrupt.exit', signal: sig, released}));
    exit(128 + (SIGNAL_NUMBERS[sig] ?? 0));
  };
  const onSignal = sig => {
    if (ac.signal.aborted) { clearTimeout(grace); hardStop(sig); return; }
    ac.abort(Object.assign(new Error(`${sig} received: the launcher was stopped`), {code: 'INTERRUPTED', signal: sig}));
    grace = setTimeout(() => hardStop(sig), graceMs);   // NOT unref'd: a command that does not stop must still reach the hard stop
  };
  const handlers = signals.map(sig => [sig, () => onSignal(sig)]);
  for (const [sig, h] of handlers) proc.on(sig, h);
  return {
    signal: ac.signal,
    track: e => {
      if (e?.event === 'dispatch' && e.claim) held.set(e.claim, {item: e.item, stage: e.stage});
      if (e?.event === 'interrupted' && e.claim) held.delete(e.claim);
    },
    done: () => { clearTimeout(grace); for (const [sig, h] of handlers) proc.off(sig, h); },
  };
}

const BOOLEAN = new Set(['json', 'github', 'once', 'init']);
export function parseArgs(argv) {
  const [first, ...rest] = argv;
  if (!first || first.startsWith('--')) usage('a verb is required: reconcile, tick, watch, serve, context, reassess or report');
  const opts = {}, pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) { pos.push(rest[i]); continue; }
    const k = rest[i].slice(2);
    if (BOOLEAN.has(k)) opts[k] = true;
    else if (i + 1 >= rest.length) usage(`--${k} needs a value`);
    else opts[k] = rest[++i];
  }
  return {verb: first, opts, pos};
}

export function pathsOf({opts = {}, env = process.env} = {}) {
  const repo = path.resolve(opts.repo ?? REPO_ROOT);
  return {
    repo,
    statusRoot: path.resolve(opts['status-ledger'] ?? env.OPHANIM_STATUS_LEDGER ?? path.join(repo, 'status', 'ledger')),
    workRoot: path.resolve(opts['work-ledger'] ?? env.OPHANIM_WORK_LEDGER ?? path.join(repo, 'status', 'work')),
    bundlesDir: opts.bundles ? path.resolve(opts.bundles) : null,
  };
}

/** The work ledger, verified against its ANCHOR, or null when there is none. Never creates one. */
export function openWorkReadOnly(workRoot) {
  if (!fs.existsSync(path.join(workRoot, 'ANCHOR'))) return {work: null, ledger: {state: 'absent', root: workRoot}};
  const work = openWorkLedger({root: workRoot, create: false});      // throws unless it verifies in full
  const v = work.verify();
  return {work, ledger: {state: 'verified', root: workRoot, anchor: work.anchor, head: v.head, entries: v.entries}};
}

/** Whether this machine holds the controller's keys (an operator and the orderer of the work ledger). */
// `keys` is reported relative to the repository (`shown`), so a report or projection never carries a machine path.
export function authorityOf(work, workRoot, repo = null) {
  const keys = path.join(workRoot, 'keys');
  const shown = repo ? (path.relative(repo, keys) || keys) : keys;
  if (!work) return {held: false, keys: shown, why: 'there is no work ledger here'};
  const auth = work.ledger.verify().authority;
  const has = id => fs.existsSync(path.join(keys, encodeURIComponent(id) + '.json'));
  const op = auth.operators.find(has);
  if (!op || !has(auth.orderer)) {
    return {held: false, keys: shown, why: `no controller key is held at ${shown} (operator ${auth.operators.join('|')}, orderer ${auth.orderer}): the work ledger can be verified, not changed`};
  }
  return {held: true, keys: shown, operator: op};
}

/** The NO_AUTHORITY block: what is missing, who supplies it, and when the run resumes. */
export const noAuthority = (auth, ledger) => ({
  blocked: 'NO_AUTHORITY', what: auth.why, role: 'decision-authority',
  resume_when: 'run on the machine that holds the controller key (status/work/keys), or the owner provisions one there',
  verified: ledger.state === 'verified' ? {anchor: ledger.anchor, head: ledger.head, entries: ledger.entries} : ledger.state,
  recorded: 'nothing', dispatched: 'nothing',
});

/** Issues from --issues FILE or --github, with a label naming where they came from; null with neither. */
export async function loadIssues(opts, {fetchImpl, env = process.env} = {}) {
  if (opts.issues && opts.github) usage('pass --issues FILE or --github, not both');
  if (opts.issues) return {issues: readIssuesFile(path.resolve(opts.issues)), source: opts['issues-label'] ?? `snapshot file ${opts.issues}`};
  if (opts.github) {
    return {issues: await fetchIssues({repo: env.GITHUB_REPOSITORY ?? null, token: env.GITHUB_TOKEN ?? null, fetchImpl}),
      source: opts['issues-label'] ?? `GitHub issues of ${env.GITHUB_REPOSITORY}, read at run time`};
  }
  return {issues: null, source: 'not read (pass --issues FILE or --github)'};
}

/**
 * The full reconciliation view, read-only: the core's reconcile plus what only the issue snapshot shows (markers
 * naming no ledger item, open/closed drift), the work ledger's state and the authority held here.
 */
export function reconcileView({repo, statusRoot, workRoot, bundlesDir = null, issues = null, issuesSource = null, now = Date.now()}) {
  const {work, ledger} = openWorkReadOnly(workRoot);
  const rec = reconcile({repo, statusRoot, workLedger: work, issues, bundlesDir, now});
  const onBoard = new Map(rec.items.map(i => [i.item, i]));
  const unknownMarkers = [], drift = [];
  for (const issue of issues ?? []) {
    const id = MARKER.exec(issue.body ?? '')?.[1];
    if (!id) continue;
    const it = onBoard.get(id);
    if (!it) { unknownMarkers.push({number: issue.number, item: id, why: 'the issue carries the marker of an item that is not on the status ledger'}); continue; }
    const want = it.status === 'Resolved' ? 'closed' : 'open';
    if (issue.state !== want) drift.push({number: issue.number, item: id, status: it.status, issue_state: issue.state, want});
  }
  const byStatus = {};
  for (const i of rec.items) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
  return {...rec, work: {...ledger, root: path.relative(repo, workRoot) || workRoot}, authority: authorityOf(work, workRoot, repo),
    status: {root: path.relative(repo, statusRoot) || statusRoot}, issues_source: issuesSource, unknown_markers: unknownMarkers, drift,
    counts: {...rec.counts, duplicates: rec.duplicates.length, unknown_markers: unknownMarkers.length, drift: drift.length, by_status: byStatus}};
}

// Gates in lifecycle order, then the waiting and terminal ones; with what each means.
export const GATE_ORDER = ['claimed', ...STAGES, 'awaiting-owner', 'blocked', 'reverification-needed', 'evidence-gap', 'complete'];
const GATE_MEANS = {
  claimed: 'a stage is claimed under a live lease: in progress, not dispatched twice',
  plan: 'evaluation and planning: author a ticket from the requirement, or re-check the existing one',
  implement: 'the approved plan is reused; implementation is next',
  review: 'implementation passed; the coordinated three-lab cycle review is next',
  validate: 'review passed; validation against the original requirement is next',
  outcome: 'validation passed; the unsigned status transition is next',
  'awaiting-owner': 'the outcome is recorded; only the owner signs the status transition',
  blocked: 'waits on something outside the work or on an unresolved dependency; never dispatched',
  'evidence-gap': 'Resolved on the ledger without completion evidence bound to a ticket, a commit and a three-lab verified review',
  'reverification-needed': 'Resolved with evidence, but a reassessment disqualified the review it rests on: the owner decides; the status is not changed',
  complete: 'Resolved with completion evidence',
};
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const issueRefs = (nums, byNumber) => (nums.length ? nums.map(n => `#${n}${byNumber.get(n) ? ` (${byNumber.get(n).state})` : ''}`).join(', ') : '—');
const gatesPresent = counts => [...GATE_ORDER, ...Object.keys(counts).filter(g => !GATE_ORDER.includes(g)).sort()].filter(g => counts[g]);

/** The reconciliation as plain text (the `reconcile` verb). */
export function reconcileText(v) {
  const out = [];
  out.push(`status ledger ${v.status.root}: head ${v.ledger.head}, ${v.ledger.entries} entries, ${v.counts.items} items (verified)`);
  out.push(v.work.state === 'verified' ? `work ledger ${v.work.root}: anchor ${v.work.anchor}, ${v.work.entries} entries (verified)` : `work ledger ${v.work.root}: absent`);
  out.push(v.authority.held ? `controller authority: held (${v.authority.operator})` : `controller authority: NO_AUTHORITY -- ${v.authority.why} (reconcile needs none)`);
  out.push(`issues: ${v.issues_source ?? 'not read'}${v.counts.issues ? ` (${v.counts.issues})` : ''}`);
  out.push(`by gate: ${gatesPresent(v.counts.by_gate).map(g => `${g} ${v.counts.by_gate[g]}`).join(', ')}`);
  out.push(`counts: ${Object.entries(v.counts).filter(([, n]) => typeof n === 'number').map(([k, n]) => `${k} ${n}`).join(', ')}`);
  for (const g of gatesPresent(v.counts.by_gate)) {
    out.push('', `[${g}] ${GATE_MEANS[g] ?? ''}`);
    for (const i of v.items.filter(x => x.gate.gate === g)) {
      const b = i.gate.blocker;
      out.push(`  ${i.item} (${i.status})${i.issues.length ? ` issues ${i.issues.map(n => `#${n}`).join(',')}` : ''}${i.ticket ? ` ticket ${i.ticket.path ?? 'INVALID'}` : ''}: ${i.gate.reason ?? ''}`
        + (b && g !== 'evidence-gap' ? ` | role ${b.role}; resumes when ${b.resume_when}` : ''));
    }
  }
  if (v.candidates.length) out.push('', '[intake candidates] recorded, never executed', ...v.candidates.map(c => `  #${c.number} (${c.state}) ${c.title}`));
  if (v.orphans.length) out.push('', '[orphans]', ...v.orphans.map(o => `  ${o.ticket}: ${o.why}`));
  if (v.duplicates.length) out.push('', '[duplicate markers]', ...v.duplicates.map(d => `  ${d.item}: issues ${d.issues.map(n => `#${n}`).join(', ')}`));
  if (v.unknown_markers.length) out.push('', '[markers naming no ledger item]', ...v.unknown_markers.map(u => `  #${u.number}: ${u.item}`));
  if (v.drift.length) out.push('', '[projection drift]', ...v.drift.map(d => `  #${d.number} ${d.item}: ${d.status} on the ledger, issue ${d.issue_state}`));
  return out.join('\n');
}

/** The backlog reconciliation as Markdown (the `report` verb). Everything in it is read from the view. */
export function backlogMarkdown(v, {command = 'node ophanim/operate/cli.mjs report', at = v.at} = {}) {
  const byNumber = new Map((v.issues_list ?? []).map(i => [i.number, i]));
  const L = [];
  L.push('# Backlog reconciliation', '');
  L.push(`Generated by \`${command}\` at ${at}. Generated, not edited: regenerate it. Every count below is read from the ledgers, the tickets and the issue snapshot named here; none is assumed.`, '');
  L.push('## Sources', '');
  L.push(`- **Status ledger** (\`${v.status.root}\`, authoritative): verified in full; head \`${v.ledger.head}\`, ${v.ledger.entries} entries, ${v.counts.items} items.`);
  L.push(v.work.state === 'verified'
    ? `- **Work ledger** (\`${v.work.root}\`): verified against its anchor \`${v.work.anchor}\`; ${v.work.entries} entries.`
    : `- **Work ledger** (\`${v.work.root}\`): absent. No stage has been claimed, run or paid for; every gate below is computed from the status ledger, the tickets and the evidence bytes alone.`);
  L.push(v.authority.held ? `- **Controller authority:** held here (\`${v.authority.operator}\`).`
    : `- **Controller authority:** NO_AUTHORITY here (${cell(v.authority.why)}). Reconciliation needs none; dispatch (\`tick\`/\`watch\`) stops with this block until it runs where the controller key is.`);
  L.push(`- **Issues:** ${cell(v.issues_source ?? 'not read')}; ${v.counts.issues} issue(s), ${v.counts.linked_issues} linked to an item by marker, ${v.counts.candidates} candidate(s). Issue text is data, never authority.`);
  L.push(`- **Tickets:** ${v.counts.tickets} under \`tickets/\`. **Retained runs:** ${v.bundles ? `evidence bundles under \`${v.bundles}\`` : 'no bundles directory given'}; ${v.counts.items_with_runs} item(s) with runs.`);
  L.push('');
  L.push('## Counts', '', '| Earliest unmet gate | Items | Meaning |', '|---|---|---|');
  for (const g of gatesPresent(v.counts.by_gate)) L.push(`| \`${g}\` | ${v.counts.by_gate[g]} | ${GATE_MEANS[g] ?? ''} |`);
  L.push(`| **total** | **${v.counts.items}** | |`, '');
  L.push(`By status on the ledger: ${Object.entries(v.counts.by_status).sort().map(([s, n]) => `${s} ${n}`).join(', ')}.`, '');
  L.push('| Count | Value |', '|---|---|');
  for (const k of ['items', 'issues', 'linked_issues', 'candidates', 'tickets', 'orphans', 'duplicates', 'unknown_markers', 'drift', 'items_with_runs']) L.push(`| ${k} | ${v.counts[k]} |`);
  L.push('');
  L.push('## Items by earliest unmet gate', '');
  for (const g of gatesPresent(v.counts.by_gate)) {
    const items = v.items.filter(i => i.gate.gate === g);
    L.push(`### \`${g}\` (${items.length})`, '', GATE_MEANS[g] ?? '', '');
    if (g === 'evidence-gap') {
      L.push('| Item | Ticket | Issue(s) | Runs | Evidence gap | Responsible role | Resumes when |', '|---|---|---|---|---|---|---|');
    } else L.push('| Item | Status | Ticket | Issue(s) | Runs | Reason | Blocker | Responsible role | Resumes when |', '|---|---|---|---|---|---|---|---|---|');
    for (const i of items) {
      const b = i.gate.blocker ?? null;
      const ticket = i.ticket ? (i.ticket.path ? `\`${i.ticket.path}\`` : `invalid: ${cell(i.ticket.invalid)}`) : 'none';
      const runs = i.runs.length ? `${i.runs.length} (${i.runs.map(r => `${r.shipped ? 'shipped' : 'not shipped'}${r.review ? `, review ${r.review.outcome ?? r.review.status}` : ''}`).join('; ')})` : 'none';
      const reason = `${cell(i.gate.reason)}${i.gate.mode ? ` (mode \`${i.gate.mode}\`)` : ''}`;
      if (g === 'evidence-gap') L.push(`| \`${i.item}\` ${cell(i.title)} | ${ticket} | ${issueRefs(i.issues, byNumber)} | ${runs} | ${cell(b?.what ?? i.gate.reason)} | \`${cell(b?.role ?? '')}\` | ${cell(b?.resume_when ?? '')} |`);
      else L.push(`| \`${i.item}\` ${cell(i.title)} | ${i.status} | ${ticket} | ${issueRefs(i.issues, byNumber)} | ${runs} | ${reason} | ${b ? (b.what === i.gate.reason ? 'as the reason' : cell(b.what)) : '—'} | ${b ? `\`${cell(b.role)}\`` : '—'} | ${b ? cell(b.resume_when) : '—'} |`);
    }
    L.push('');
  }
  L.push('## Intake candidates', '');
  if (!v.candidates.length) L.push('None.', '');
  else {
    L.push('Issues that carry no item marker. Each is recorded by the scheduler as `work.intake` with classification `candidate` and is never executed; only the owner turns one into a status item (or classifies it as coordination). What the issue says is not read as an instruction.', '');
    L.push('| Issue | State | Title | Classification | Why |', '|---|---|---|---|---|');
    for (const c of v.candidates) L.push(`| #${c.number} | ${c.state} | ${cell(c.title)} | candidate | ${cell(c.why)} |`);
    L.push('');
  }
  L.push('## Orphans, duplicates and drift', '');
  L.push(`- **Orphan tickets** (a ticket for an item not on the status ledger): ${v.orphans.length ? v.orphans.map(o => `\`${o.ticket}\``).join(', ') : 'none'}.`);
  L.push(`- **Duplicate markers** (two issues for one item): ${v.duplicates.length ? v.duplicates.map(d => `\`${d.item}\` on ${d.issues.map(n => `#${n}`).join(', ')}`).join('; ') : 'none'}.`);
  L.push(`- **Markers naming no ledger item:** ${v.unknown_markers.length ? v.unknown_markers.map(u => `#${u.number} (\`${u.item}\`)`).join(', ') : 'none'}.`);
  L.push(`- **Projection drift** (issue open/closed against the item's state): ${v.drift.length ? v.drift.map(d => `#${d.number} \`${d.item}\` is ${d.status} but the issue is ${d.issue_state}`).join('; ') : 'none'}.`);
  L.push(`- **Items with no linked issue:** ${v.issues_list ? (v.items.filter(i => !i.issues.length).map(i => `\`${i.item}\``).join(', ') || 'none') : 'not checked (no issues read)'}.`);
  L.push('');
  L.push('## What this does not show', '');
  L.push('- A gate is what the ledgers and the checkout support today, not a judgement of the work: an `evidence-gap` item may well be done; the ledger does not carry the completion evidence (ticket, commit, three-lab verified review) that would show it.');
  L.push('- No provider was called and nothing was dispatched or recorded to produce this report.');
  L.push('- Issue state and text come from the snapshot named under Sources; issues opened or edited since are not in it.');
  L.push('');
  return L.join('\n');
}

/** Scheduler limits from flags; --total-provider-calls defaults to 0 (nothing that may call a provider runs). */
export function limitsOf(opts) {
  const flags = {'total-provider-calls': 'total_provider_calls', 'stage-provider-calls': 'stage_provider_calls', iterations: 'iterations',
    concurrency: 'concurrency', 'elapsed-ms': 'elapsed_ms', 'lease-ms': 'lease_ms', 'stage-attempts': 'stage_attempts'};
  const out = {total_provider_calls: 0};
  for (const [flag, key] of Object.entries(flags)) {
    if (opts[flag] === undefined) continue;
    if (!/^\d+$/.test(opts[flag])) usage(`--${flag} is a non-negative integer`);
    out[key] = Number(opts[flag]);
  }
  if (out.concurrency === 0) usage('--concurrency is at least 1');
  return {...DEFAULT_LIMITS, ...out};
}

/** The stage executors from ophanim/operate/stages.mjs makeExecutors, or a refusal naming what is missing. */
export async function loadExecutors(ctx, {stagesFile = path.join(HERE, 'stages.mjs')} = {}) {
  if (!fs.existsSync(stagesFile)) {
    refuse(`the stage executors are not in this checkout: ${path.relative(REPO_ROOT, stagesFile) || stagesFile} (makeExecutors) is required for tick and watch; reconcile and report need none`, 'NO_EXECUTORS');
  }
  const mod = await import(pathToFileURL(stagesFile).href);
  if (typeof mod.makeExecutors !== 'function') refuse(`${path.relative(REPO_ROOT, stagesFile)} exports no makeExecutors`, 'NO_EXECUTORS');
  const ex = await mod.makeExecutors(ctx);
  if (!ex || typeof ex !== 'object') refuse('makeExecutors returned no executors', 'NO_EXECUTORS');
  return ex;
}

/**
 * The provider seats the stage executors use: `--clients MODULE` (default export makeClientFor(vendor)) for the work
 * seats and `--turn MODULE` (default export turn({vendor, model, prompt})) for the planner, reviewers and validator;
 * by default the live SDK seats (pantheon/src/sdk/live.mjs), which call nothing until a stage runs. The provider-call
 * budget, not this choice, decides whether anything may call a provider.
 */
export async function seatsOf(opts) {
  const load = async f => (await import(pathToFileURL(path.resolve(f)).href)).default;
  const live = () => import(pathToFileURL(path.join(REPO_ROOT, 'pantheon/src/sdk/live.mjs')).href);
  // Without the vendor SDKs installed, the live seats are a refusal when a stage uses one -- recorded on that stage --
  // not a failure to start: a tick within a zero budget, or one that dispatches nothing, needs no SDK.
  const unavailable = e => { const f = () => { throw Object.assign(new Error(`the live provider SDKs are not available here: ${e.message}`), {code: 'NO_PROVIDER_SDK'}); }; return f; };
  const orUnavailable = async build => { try { return await build(); } catch (e) { return unavailable(e); } };
  const makeClientFor = opts.clients ? await load(opts.clients) : await orUnavailable(async () => (await live()).liveClients());
  const turn = opts.turn ? await load(opts.turn) : await orUnavailable(async () => (await live()).liveTurn({label: 'operate'}));
  if (typeof makeClientFor !== 'function' || typeof turn !== 'function') usage('--clients and --turn name modules whose default export is a function');
  return {makeClientFor, turn};
}

/**
 * Prepare a dispatching run (tick or watch): the work ledger verified (created only with `init`), the controller
 * authority checked (a NO_AUTHORITY block, never a skip), then the executors. Returns {blocked} or {executors, ...}.
 */
export async function prepareDispatch({paths, opts, limits, stagesFile, progress = () => {}}) {
  if (!fs.existsSync(path.join(paths.workRoot, 'ANCHOR'))) {
    if (!opts.init) refuse(`no work ledger at ${paths.workRoot}: pass --init to create it here (it generates the controller key on this machine)`);
    // Nothing is created for a run that could not dispatch anyway.
    if (!fs.existsSync(stagesFile ?? path.join(HERE, 'stages.mjs'))) await loadExecutors({}, {stagesFile: stagesFile ?? path.join(HERE, 'stages.mjs')});
    openWorkLedger({root: paths.workRoot});
  }
  const opened = openWorkReadOnly(paths.workRoot);
  const auth = authorityOf(opened.work, paths.workRoot);
  if (!auth.held) return {blocked: noAuthority(auth, opened.ledger)};
  const executors = await loadExecutors({repo: paths.repo, statusRoot: paths.statusRoot, workRoot: paths.workRoot, limits, env: process.env, progress,
    ...(await seatsOf(opts))}, {stagesFile});
  return {executors, ledger: opened.ledger, authority: auth};
}

export const tickSummary = (t, limits) => ({
  dispatched: t.dispatched, released_expired: t.released_expired, intake: t.intake.length, recovery: t.recovery ?? [], blocked: t.blocked.length,
  // What is blocked and why, not only how many (an attempt-identity collision or a structural block is named here).
  blockers: t.blocked.map(b => ({item: b.item, gate: b.gate, code: b.blocker?.code ?? null, what: String(b.blocker?.what ?? '').slice(0, 300)})), skipped: t.skipped,
  stopped: t.stopped, spent: t.spent, by_gate: t.reconcile.counts.by_gate, ...(t.scope ? {scope: t.scope} : {}),
  ...(limits.total_provider_calls === 0 ? {note: 'no --total-provider-calls declared: nothing that may call a provider was dispatched'} : {}),
});

export async function main(argv = process.argv.slice(2), {log = console.log, err = console.error, env = process.env, fetchImpl, stagesFile, proc = process, exit, graceMs} = {}) {
  const stopOpts = {proc, err, ...(exit ? {exit} : {}), ...(graceMs !== undefined ? {graceMs} : {})};
  try {
    const {verb, opts} = parseArgs(argv);
    const paths = pathsOf({opts, env});
    if (verb === 'reconcile' || verb === 'report') {
      if (verb === 'report' && !opts.out) usage('report needs --out FILE');
      const {issues, source} = await loadIssues(opts, {fetchImpl, env});
      const v = {...reconcileView({...paths, issues, issuesSource: source}), issues_list: issues, bundles: paths.bundlesDir ? path.relative(paths.repo, paths.bundlesDir) : null};
      if (verb === 'reconcile') { log(opts.json ? JSON.stringify(v, null, 2) : reconcileText(v)); return 0; }
      const out = path.resolve(opts.out), json = out.replace(/\.md$/, '') + '.json';
      fs.mkdirSync(path.dirname(out), {recursive: true});
      // The command as run, with the issues file named by its basename (a local path means nothing to a reader).
      const shown = argv.map((a, i) => (argv[i - 1] === '--issues' ? path.basename(a) : argv[i - 1] === '--out' ? path.relative(paths.repo, out) : a));
      fs.writeFileSync(out, backlogMarkdown(v, {command: `node ophanim/operate/cli.mjs ${shown.map(a => (/\s/.test(a) ? `'${a}'` : a)).join(' ')}`}));
      // The JSON keeps each issue's number, title, state and labels, not its body (the body is data, and large).
      fs.writeFileSync(json, JSON.stringify({...v, issues_list: issues?.map(({body, ...rest}) => rest) ?? null}, null, 2) + '\n');
      log(`${path.relative(process.cwd(), out)}\n${path.relative(process.cwd(), json)}`);
      return 0;
    }
    if (verb === 'tick' || verb === 'watch') {
      const limits = limitsOf(opts);
      let stop = null;
      const progress = e => { stop?.track(e); err(JSON.stringify(e)); };
      const prep = await prepareDispatch({paths, opts, limits, stagesFile, progress});
      if (prep.blocked) { log(JSON.stringify(prep.blocked, null, 2)); return 3; }
      const holder = opts.holder ?? 'controller';
      if (opts.item !== undefined && !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(opts.item)) usage('--item names one status item id');
      const common = {repo: paths.repo, statusRoot: paths.statusRoot, workRoot: paths.workRoot, bundlesDir: paths.bundlesDir, executors: prep.executors, limits, holder, progress,
        ...(opts.item !== undefined ? {only: opts.item} : {})};
      if (verb === 'tick') {
        const {issues} = await loadIssues(opts, {fetchImpl, env});
        stop = launcherStop({workRoot: paths.workRoot, ...stopOpts});
        let t;
        try { t = await tick({...common, issues, interrupt: stop.signal}); } finally { stop.done(); }
        log(JSON.stringify(tickSummary(t, limits), null, 2));
        return 0;
      }
      if (opts.interval !== undefined && !/^\d+$/.test(opts.interval)) usage('--interval is a whole number of seconds');
      const fetchIssuesNow = async () => (await loadIssues(opts, {fetchImpl, env})).issues;
      stop = launcherStop({workRoot: paths.workRoot, ...stopOpts});
      let ticks;
      // The same signal stops the loop (`signal`) and the stage in flight (`interrupt`, passed on to tick).
      try { ticks = await watch({...common, fetchIssues: fetchIssuesNow, interval_ms: Number(opts.interval ?? 60) * 1000, once: !!opts.once, signal: stop.signal, interrupt: stop.signal}); }
      finally { stop.done(); }
      log(JSON.stringify({ticks: ticks.map(t => tickSummary(t, limits))}, null, 2));
      return 0;
    }
    if (verb === 'context') {
      // Read-only investigation of ANY item, a Resolved one included: the dossier a judging seat would be given, and
      // optionally one retrieval. Nothing is recorded, claimed, reopened or signed.
      const item = opts.item ?? usage('context needs --item ID');
      const {buildDossier, renderDossier, makeRetriever} = await import('./context.mjs');
      const {issues} = await loadIssues(opts, {fetchImpl, env});
      const {work} = openWorkReadOnly(paths.workRoot);
      const d = buildDossier({repo: paths.repo, statusRoot: paths.statusRoot, item, work, issues, bundlesDir: paths.bundlesDir});
      if (opts.retrieve) {
        let req; try { req = JSON.parse(opts.retrieve); } catch { usage('--retrieve is one JSON request, e.g. {"op":"file","path":"x"}'); }
        log(JSON.stringify(makeRetriever({repo: paths.repo, statusRoot: paths.statusRoot, work, issues}).run(req), null, 2));
        return 0;
      }
      log(opts.json ? JSON.stringify(d, null, 2) : renderDossier(d));
      return 0;
    }
    if (verb === 'reassess') {
      // Reassess an item's recorded model-rule reviews under the CURRENT identity policy and record what is found
      // (reassess.mjs). It writes only to the work ledger, with the controller key; no review ledger or status changes.
      const item = opts.item ?? usage('reassess needs --item ID');
      const opened = openWorkReadOnly(paths.workRoot);
      const auth = authorityOf(opened.work, paths.workRoot);
      if (!auth.held) { log(JSON.stringify(noAuthority(auth, opened.ledger), null, 2)); return 3; }
      const {reassessItem} = await import('./reassess.mjs');
      const r = reassessItem({work: openWorkLedger({root: paths.workRoot}), item});
      log(JSON.stringify({item: r.item, policy: r.policy, recorded: r.recorded.map(x => ({stage: x.stage, cycle: x.cycle, reassessment: x.reassessment, findings: x.findings})),
        skipped: r.skipped.map(x => ({stage: x.stage, cycle: x.cycle, why: x.why}))}, null, 2));
      return 0;
    }
    if (verb === 'serve') {
      // The execution service (service.mjs): watch, with a config, a single-instance lock, status and log files.
      if (!opts.config) usage('serve needs --config FILE (see ophanim/operate/service/service.example.json)');
      const {readServiceConfig, runService} = await import('./service.mjs');
      const config = readServiceConfig(opts.config);
      const stop = launcherStop({workRoot: config.workRoot, ...stopOpts});
      let r;
      // runService passes its signal on to every tick as the interrupt (service.mjs): the stage in flight stops too.
      try { r = await runService({config, signal: stop.signal, onProgress: stop.track, fetchImpl, env, ...(opts['max-ticks'] ? {maxTicks: Number(opts['max-ticks'])} : {})}); }
      finally { stop.done(); }
      log(JSON.stringify({code: r.code, stopped: r.stopped ?? null, refused: r.refused ?? null, blocked: r.blocked ?? null, ticks: r.ticks.length,
        status: path.relative(paths.repo, path.join(config.stateDir, 'service-status.json'))}, null, 2));
      return r.code;
    }
    usage(`unknown verb: ${verb}`);
  } catch (e) {
    err(e.usage ? `${e.message}\nusage: cli.mjs reconcile|tick|watch|report ... (see the header of ophanim/operate/cli.mjs)` : `refused: ${e.message}`);
    return e.usage ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
