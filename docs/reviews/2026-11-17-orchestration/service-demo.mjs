#!/usr/bin/env node
// A bounded demonstration of the execution service (ophanim/operate/service.mjs) over SCRIPTED providers.
//
//   node docs/reviews/2026-11-17-orchestration/service-demo.mjs [--out DIR]
//
// It builds a fixture repository with a status ledger and a published-issue snapshot holding:
//   #101  a published Ready item with NO ticket       (issue-item)
//   #102  a published Ready item with an EXISTING ticket (ticket-item)
//   #103  an issue with no item marker                 (an intake candidate: recorded, never executed)
// and runs the REAL service loop, scheduler, gates, work ledger and stage executors (stages.mjs). The seats are
// scripted: Pantheon's scripted work clients and a scripted planner, reviewer and validator (test-fixtures.mjs).
// No provider is called.
//
// Run A: the four configured labs. Run B: the same, with a SYNTHETIC fifth reviewer lab injected into the reviewer
// pool only. Run B's proposals are then applied with the FIXTURE's own status keys, standing in for the owner.
// Writes SERVICE-DEMO.md and SERVICE-DEMO.json to --out (default: this directory). The output holds no machine paths.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {withDispatch} from '../../../pantheon/tests/fixtures/dispatch.mjs';
import {openWorkLedger} from '../../../ophanim/operate/work-ledger.mjs';
import {makeExecutors} from '../../../ophanim/operate/stages.mjs';
import {readServiceConfig, runService, SERVICE_CONFIG_SCHEMA} from '../../../ophanim/operate/service.mjs';
import {reconcile} from '../../../ophanim/operate/reconcile.mjs';
import {applyProposal, openStatusLedger} from '../../../packages/ledger/status.mjs';
import {fixture, scriptedTurn, FIVE} from '../../../ophanim/operate/test-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf('--out');
const out = path.resolve(i > 0 ? process.argv[i + 1] : HERE);
const LIMITS = {total_provider_calls: 120, stage_provider_calls: 40, iterations: 12, concurrency: 1, stage_attempts: 3};
const ISSUES = [
  {number: 101, title: 'Alpha for issue-item', state: 'open', labels: ['state:ready'], body: 'Make alpha.mjs export ok = true.\n\n<!-- ophanim:item=issue-item -->'},
  {number: 102, title: 'Alpha for ticket-item', state: 'open', labels: ['state:ready'], body: 'Ticketed.\n\n<!-- ophanim:item=ticket-item -->'},
  {number: 103, title: 'A coordination question', state: 'open', labels: [], body: 'Should the board also track X? (no item marker)'},
];

async function run(label, extra) {
  return withDispatch(async ({dir: repo, makeClientFor, calls}) => {
    const f = fixture(repo, [{item: 'issue-item'}, {item: 'ticket-item'}], {tickets: ['ticket-item']});
    const ticketBefore = fs.readFileSync(path.join(repo, 'tickets', 'ticket-item.json'));
    fs.writeFileSync(path.join(repo, 'issues.json'), JSON.stringify(ISSUES));
    openWorkLedger({root: f.workRoot});
    fs.writeFileSync(path.join(repo, 'operate.json'), JSON.stringify({schema: SERVICE_CONFIG_SCHEMA, repo: '.', issues: {source: 'file', path: 'issues.json'},
      interval_s: 10, limits: LIMITS, state_dir: 'status/operate/service'}));
    const config = readServiceConfig(path.join(repo, 'operate.json'));
    const turn = scriptedTurn();
    const executors = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, ...extra});
    const r = await runService({config, executors, maxTicks: 3, sleep: async () => {}});
    // A restart: nothing that is done is done again.
    const again = await runService({config, executors, maxTicks: 2, sleep: async () => {}});
    const w = openWorkLedger({root: f.workRoot});
    const rel = p => path.relative(repo, p);
    const stages = item => w.stages(item).map(s => ({stage: s.stage, attempt: s.attempt, status: s.status, mode: s.outputs?.plan?.mode ?? null,
      team: (s.team ?? []).map(t => `${t.role}:${t.lab ?? t.vendor ?? '-'}`), provider_calls: s.usage?.provider_calls ?? null,
      blocker: s.blocker?.what ?? null, next: s.next?.stage ?? null}));
    const rec = reconcile({repo, statusRoot: f.statusRoot, workLedger: w, issues: ISSUES});
    const status = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'service-status.json'), 'utf8'));
    const events = fs.readFileSync(path.join(config.stateDir, 'service.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).map(e => e.event);
    const result = {label, service: {code: r.code, stopped: r.stopped, ticks: r.ticks.length, restart_ticks: again.ticks.length,
        restart_dispatched: again.ticks.reduce((n, t) => n + t.dispatched.length, 0), status: {state: status.state}, events: [...new Set(events)]},
      spend: {cap: LIMITS.total_provider_calls, scripted_turns: turn.log.length, scripted_work_calls: calls.length,
        recorded: w.stages().reduce((n, s) => n + (s.usage?.provider_calls ?? 0), 0)},
      intake: w.intakes().map(x => `${x.ref} (${x.classification})`),
      items: Object.fromEntries(['issue-item', 'ticket-item'].map(it => [it, {stages: stages(it), gate: rec.items.find(x => x.item === it).gate.gate}])),
      ticket_item_ticket_kept: fs.readFileSync(path.join(repo, 'tickets', 'ticket-item.json')).equals(ticketBefore),
      issue_item_ticket_written: fs.existsSync(path.join(repo, 'tickets', 'issue-item.json')),
      candidate_executed: w.stages().some(s => s.identity?.item == null)};
    // Run B only: the fixture owner applies the unsigned proposals.
    const proposals = w.stages().filter(s => s.stage === 'outcome' && s.status === 'passed');
    if (proposals.length) {
      result.applied = proposals.map(s => {
        const a = applyProposal({root: f.statusRoot, proposal: JSON.parse(fs.readFileSync(s.outputs.proposal_path, 'utf8'))});
        return {item: a.item, state: a.state, checked: a.checked.checked};
      });
      const after = reconcile({repo, statusRoot: f.statusRoot, workLedger: openWorkLedger({root: f.workRoot})});
      result.after_apply = Object.fromEntries(after.items.map(x => [x.item, x.gate.gate]));
      result.status_entries = openStatusLedger({root: f.statusRoot, create: false}).board().entries;
    }
    void rel;
    return result;
  });
}

const A = await run('A: the four configured labs', {});
const B = await run('B: with a SYNTHETIC fifth reviewer lab (test-only; not configured)', FIVE);
const report = {schema: 'ophanim.service-demo/v1', providers: 'scripted (no provider called)', limits: LIMITS, issues: ISSUES.map(x => ({number: x.number, title: x.title})), runs: [A, B]};
fs.writeFileSync(path.join(out, 'SERVICE-DEMO.json'), JSON.stringify(report, null, 2) + '\n');

const row = s => `| ${s.stage} | ${s.attempt} | ${s.status} | ${s.mode ?? '—'} | ${s.team.join(', ') || '—'} | ${s.provider_calls ?? '?'} | ${(s.blocker ?? '—').replace(/\|/g, '\\|').slice(0, 160)} |`;
const section = r => [`## ${r.label}`, '',
  `Service: exit ${r.service.code}, stopped by ${r.service.stopped} after ${r.service.ticks} tick(s); events ${r.service.events.join(', ')}. Restart: ${r.service.restart_ticks} tick(s), ${r.service.restart_dispatched} stage(s) dispatched.`,
  `Spend: ${r.spend.recorded} provider call(s) recorded on the work ledger against a cap of ${r.spend.cap} (scripted: ${r.spend.scripted_turns} single turns, ${r.spend.scripted_work_calls} work calls).`,
  `Intake: ${r.intake.join('; ')}. The candidate was executed: ${r.candidate_executed}.`,
  `issue-item's ticket was written by planning: ${r.issue_item_ticket_written}. ticket-item's existing ticket was kept byte-identical: ${r.ticket_item_ticket_kept}.`, '',
  ...Object.entries(r.items).flatMap(([it, x]) => [`### ${it} (earliest unmet gate now: \`${x.gate}\`)`, '',
    '| Stage | Attempt | Status | Plan mode | Team (role:lab) | Provider calls | Blocker |', '|---|---|---|---|---|---|---|', ...x.stages.map(row), '']),
  ...(r.applied ? ['### Applied by the fixture owner (standing in for the owner\'s keys)', '',
    ...r.applied.map(a => `- ${a.item}: ${a.state}, evidence checked \`${a.checked}\``), '', `Gates after apply: ${Object.entries(r.after_apply).map(([k, v]) => `${k} \`${v}\``).join(', ')}.`, ''] : [])];
const md = ['# Execution service: bounded demonstration', '',
  'Generated by `node docs/reviews/2026-11-17-orchestration/service-demo.mjs`. Generated, not edited.', '',
  '**What this is.** The real service loop (`ophanim/operate/service.mjs`) runs the real scheduler, gates, work ledger and stage executors (`stages.mjs`) over a fixture repository. Every seat is SCRIPTED: Pantheon\'s scripted work clients, plus a scripted planner, reviewers and validator. No provider was called, so nothing here is live or qualifies any model or lab.',
  'Run B adds a synthetic fifth reviewer lab to the reviewer pool to show the lifecycle past the coordinated review. That lab is not configured anywhere. In the configured four-lab pool, Run A is what happens.', '',
  `Limits (declared before dispatch): \`${JSON.stringify(LIMITS)}\`. Published issues: #101 (Ready item, no ticket), #102 (Ready item, existing ticket), #103 (no item marker).`, '',
  ...section(A), ...section(B)];
fs.writeFileSync(path.join(out, 'SERVICE-DEMO.md'), md.join('\n') + '\n');
console.log(JSON.stringify({A: Object.fromEntries(Object.entries(A.items).map(([k, v]) => [k, v.gate])), B: B.after_apply}, null, 2));
