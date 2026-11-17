#!/usr/bin/env node
// What the scheduler actually dispatches on the real backlog, without a provider.
//
//   node docs/reviews/2026-11-17-orchestration/dispatch-demo.mjs --issues FILE [--issues-label TEXT] [--out DIR]
//
// It clones this checkout's HEAD (the real status ledger and tickets) into a temporary directory and, there only:
//   A. `cli.mjs tick` with no work ledger: refused, nothing created.
//   B. `cli.mjs tick --init` at the default limits (total provider calls 0): the work ledger and a controller key are
//      created in the clone, intake is recorded, nothing that may call a provider is dispatched.
//   C. `tick` with a declared budget and RECORDING executors: the scheduler selects ready work in dependency order,
//      verifies each handoff, claims, and calls the stage executor. The recording executor calls no provider and
//      produces nothing: it records what it received and returns a block naming itself. The real executors
//      (stages.mjs) are exercised end to end over scripted providers in ophanim/operate/stages.test.mjs.
//   D. The same tick again: nothing is dispatched twice.
//   E. The controller key removed: `cli.mjs tick` stops with NO_AUTHORITY (exit 3), nothing recorded.
// Writes DISPATCH.md and DISPATCH.json to --out (default: this directory). Paths in the output are repo-relative.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const issuesFile = arg('issues');
if (!issuesFile) { console.error('--issues FILE is required (a snapshot of the published issues)'); process.exit(2); }
const label = arg('issues-label') ?? 'issues snapshot';
const out = path.resolve(arg('out') ?? HERE);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-dispatch-'));
const clone = path.join(tmp, 'repo');
execFileSync('git', ['clone', '-q', '--no-hardlinks', REPO, clone]);
const head = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
fs.copyFileSync(path.resolve(issuesFile), path.join(tmp, 'issues.json'));
const cli = (...a) => {
  const r = spawnSync(process.execPath, [path.join(clone, 'ophanim/operate/cli.mjs'), ...a, '--repo', clone, '--issues', path.join(tmp, 'issues.json'), '--issues-label', label, '--json'],
    {encoding: 'utf8', cwd: clone});
  const scrub = s => s.split(tmp + path.sep + 'repo' + path.sep).join('').split(tmp).join('<tmp>');
  return {exit: r.status, stdout: scrub(r.stdout), stderr: scrub(r.stderr)};
};
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

const {tick} = await import(pathToFileURL(path.join(clone, 'ophanim/operate/scheduler.mjs')));
const {openWorkLedger} = await import(pathToFileURL(path.join(clone, 'ophanim/operate/work-ledger.mjs')));
const {readIssuesFile} = await import(pathToFileURL(path.join(clone, 'ophanim/operate/issues.mjs')));
const issues = readIssuesFile(path.join(tmp, 'issues.json'));
const statusRoot = path.join(clone, 'status/ledger'), workRoot = path.join(clone, 'status/work');

const report = {schema: 'ophanim.dispatch-demo/v1', head, issues_source: label, provider_calls: 0, phases: {}};

// A. No work ledger.
const a = cli('tick', '--total-provider-calls', '200');
report.phases.A = {what: 'tick with no work ledger', exit: a.exit, refusal: (a.stderr || a.stdout).trim().split('\n')[0],
  work_ledger_created: fs.existsSync(path.join(workRoot, 'ANCHOR'))};

// B. --init at the default limits.
const b = cli('tick', '--init');
const bj = parse(b.stdout);
report.phases.B = {what: 'tick --init at the default limits (total provider calls 0)', exit: b.exit,
  dispatched: bj?.tick?.dispatched ?? bj?.dispatched ?? null, intake: (x => (Array.isArray(x) ? x.length : x ?? 0))(bj?.intake),
  recovery: (bj?.recovery ?? []).map(x => ({item: x.item, outcome: x.outcome, searched: x.searched})),
  stopped: bj?.tick?.stopped ?? bj?.stopped ?? null, note: bj?.note ?? null, refusal: b.exit ? (b.stderr || b.stdout).trim().split('\n')[0] : null};

// C. A declared budget, recording executors.
const received = [];
const recording = stage => async ({item, gate, upstream, attempt, budget, reuse}) => {
  received.push({item, stage, mode: gate.mode ?? null, attempt, budget, upstream: upstream?.hash ?? null, reuse: Object.keys(reuse ?? {}), reason: gate.reason});
  return {status: 'blocked', usage: {provider_calls: 0}, outputs: {scripted: true},
    blocker: {what: `DEMONSTRATION: a recording ${stage} executor; no provider was called and nothing was produced`, role: 'lead@orch',
      resume_when: 'the stage runs with the real executors (stages.mjs) where the provider and controller keys are'}};
};
const executors = Object.fromEntries(['plan', 'implement', 'review', 'validate', 'outcome'].map(s => [s, recording(s)]));
const limits = {total_provider_calls: 200, stage_provider_calls: 40, iterations: 20};
const c = await tick({repo: clone, statusRoot, workRoot, issues, executors, limits});
report.phases.C = {what: 'tick with a declared budget and recording executors', limits,
  dispatched: c.dispatched.map(d => ({item: d.item, stage: d.stage, attempt: d.attempt, status: d.status})), received,
  blocked: c.blocked.length, blocked_by_gate: Object.entries(c.blocked.reduce((m, x) => (m[x.gate] = (m[x.gate] ?? 0) + 1, m), {})).sort(),
  intake: c.intake.length, skipped: c.skipped, stopped: c.stopped};

// D. Again: nothing twice.
const d = await tick({repo: clone, statusRoot, workRoot, issues, executors, limits});
report.phases.D = {what: 'the same tick again', dispatched: d.dispatched.length, intake: d.intake.length, stopped: d.stopped};

// E. The controller key removed.
fs.renameSync(path.join(workRoot, 'keys'), path.join(tmp, 'keys-removed'));
const before = openWorkLedger({root: workRoot}).verify();
const e = cli('tick', '--total-provider-calls', '200');
const after = openWorkLedger({root: workRoot}).verify();
report.phases.E = {what: 'tick without the controller key', exit: e.exit, block: (parse(e.stdout)?.blocked ?? null) ?? (e.stderr || e.stdout).trim().split('\n')[0],
  entries_before: before.entries, entries_after: after.entries, verified: after.ok};
report.work_ledger = {entries: after.entries, verified: after.ok};

fs.writeFileSync(path.join(out, 'DISPATCH.json'), JSON.stringify(report, null, 2) + '\n');
const L = ['# What the scheduler dispatched (demonstration)', '',
  `Generated by \`node docs/reviews/2026-11-17-orchestration/dispatch-demo.mjs\` over a clone of \`${head.slice(0, 12)}\` (the real status ledger and tickets) and the ${label}. Generated, not edited.`, '',
  '**What this is and is not.** The CLI, reconciliation, gates, scheduler, claims, handoff verification and work ledger are the real code. The stage executors in phase C are RECORDING executors: they call no provider, produce nothing, and return a block that names them. No provider was called. The real stage executors are exercised end to end over scripted (synthetic) providers in `ophanim/operate/stages.test.mjs`. Nothing here is a live demonstration.', '',
  '## A. No work ledger', '', `Exit ${report.phases.A.exit}: ${report.phases.A.refusal}. Work ledger created: ${report.phases.A.work_ledger_created}.`, '',
  '## B. `tick --init` at the default limits', '', `Exit ${report.phases.B.exit}${report.phases.B.refusal ? ` (${report.phases.B.refusal})` : ''}. The real stage executors (stages.mjs) were seated (the clone has no installed vendor SDKs, so its live seats refuse when used); none was used. Intake recorded: ${report.phases.B.intake}. Dispatched: ${JSON.stringify(report.phases.B.dispatched)}. Stopped: ${report.phases.B.stopped ?? '—'}.`, '',
  '### Evidence recovery in that tick (no provider call)', '',
  (() => {
    const r = report.phases.B.recovery ?? [];
    const by = r.reduce((m, x) => (m[x.outcome] = (m[x.outcome] ?? 0) + 1, m), {});
    return `${r.length} item(s) Resolved without completion evidence were searched: ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}. `
      + 'The clone has no retained-runs directory (the owner\'s board runs are not in this repository) and no outcome on its new work ledger, so nothing could be recovered here; '
      + 'each search is recorded on the work ledger with what was searched, and is repeated only when the item\'s sources change.';
  })(), '',
  `## C. A declared budget (${JSON.stringify(limits)}), recording executors`, '',
  `Dispatched ${c.dispatched.length} stage(s); ${report.phases.C.blocked} item(s) reported blocked (${report.phases.C.blocked_by_gate.map(([g, n]) => `${g} ${n}`).join(', ')}); stopped: ${c.stopped ?? '—'}.`, '',
  '| # | Item | Stage | Mode | Attempt | Handoff from | Budget (provider calls) | Why it was ready |', '|---|---|---|---|---|---|---|---|',
  ...received.map((r, i) => `| ${i + 1} | \`${r.item}\` | ${r.stage} | ${r.mode ?? '—'} | ${r.attempt} | ${r.upstream ? `\`${r.upstream.slice(0, 19)}…\`` : 'none (first stage)'} | ${r.budget.provider_calls} | ${String(r.reason ?? '').replace(/\|/g, '\\|')} |`), '',
  '## D. The same tick again', '', `Dispatched: ${report.phases.D.dispatched}. Intake recorded: ${report.phases.D.intake}. A recorded block is not dispatched again until its inputs change.`, '',
  '## E. Without the controller key', '', `Exit ${report.phases.E.exit}: ${typeof report.phases.E.block === 'string' ? report.phases.E.block : JSON.stringify(report.phases.E.block)}. Work ledger entries before ${report.phases.E.entries_before}, after ${report.phases.E.entries_after}; verified: ${report.phases.E.verified}.`, ''];
fs.writeFileSync(path.join(out, 'DISPATCH.md'), L.join('\n'));
fs.rmSync(tmp, {recursive: true, force: true});
console.log(JSON.stringify({head, dispatched: c.dispatched.length, provider_calls: 0}, null, 2));
