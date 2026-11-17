// REHEARSAL of the operating cycle (docs/operating-workflow.md), with no network and no real provider:
// every seat and every cycle reviewer is scripted, the status ledger is a temporary one signed by test
// keys, and the repository is a temporary git repository. It proves the loop's mechanics end to end:
//
//   board (status ledger, verified) -> next -> run (plan, work, acceptance, in-run review, ship, commit,
//   review cycle on 3 labs, close) -> unsigned proposal -> check -> apply with the key holder's keys ->
//   Resolved with evidence -> the public record's issue body shows the evidence.
//
// and that the refusals hold: a stale proposal, a tampered one, an unverified close proposing Resolved
// without a reason, and an apply without the keys. It is NOT an operational cycle: no live model ran and
// the owner's keys signed nothing. The operational acceptance criteria are in docs/operating-workflow.md.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {withPipeline} from '../../pantheon/tests/fixtures/pipeline.mjs';
import {modelId} from '../../pantheon/src/config/models.mjs';
import {boardNext, runBoardItem, checkProposal, proposeFromBundle} from '../../pantheon/src/board/operate.mjs';
import {openStatusLedger, applyProposal, renderBoard} from '../../packages/ledger/status.mjs';
import {readStatusRecord, plan} from '../public/record.mjs';
import {openPantheonLedger} from '../../pantheon/src/ledger/system.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STATUS_CLI = path.join(REPO, 'packages/ledger/status.mjs');
const BOARD_CLI = path.join(REPO, 'pantheon/bin/pantheon-board.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'});
const ITEM = 'rehearsal-item';

// A ticket that covers its whole (rehearsal) item, so it proposes Resolved.
const TICKET = {
  schema: 'ophanim.ticket/v1', item: ITEM, slice: 'the whole rehearsal item: alpha.mjs exports ok = true',
  proposes: {state: 'Resolved', basis: 'alpha.mjs exports ok = true (rehearsal)'},
  title: 'alpha.mjs exports ok = true', goal: 'Make alpha.mjs export `ok` as true.', question: 'rehearsal fixture',
  repo_root: '.', slot: 'alpha', path: 'alpha.mjs', copy: ['alpha.mjs', 'verify.mjs'], acceptance_cmd: 'node verify.mjs', difficulty: 'easy',
  constraints: ['one file changes: alpha.mjs'],
};

// The cycle reviewers: one scripted answer per seat, approving with no findings, each reporting the
// model it was asked for as the served model.
let replies = 0;
const approve = async ({vendor, model}) => ({text: '```json\n{"verdict": "approve", "findings": []}\n```', response_id: `rehearsal_${vendor}_${++replies}`, served_model: model});

function setUp(repo) {
  fs.writeFileSync(path.join(repo, 'alpha.mjs'), 'export const ok = false;\n');
  fs.writeFileSync(path.join(repo, 'verify.mjs'), 'import assert from "node:assert/strict"; import {ok} from "./alpha.mjs"; assert.equal(ok, true);\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'outputs/\ncooldowns/\nboard/\n');
  fs.mkdirSync(path.join(repo, 'tickets'));
  fs.writeFileSync(path.join(repo, 'tickets', `${ITEM}.json`), JSON.stringify(TICKET, null, 2) + '\n');
  // The status ledger in the repository, as status/ledger is; its keys moved OUT of it, to a directory
  // standing in for the owner's machine (~/.local/share/ophanim/status-ledger/keys).
  const statusRoot = path.join(repo, 'status', 'ledger');
  openStatusLedger({root: statusRoot});
  const ownerKeys = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-owner-keys-'));
  fs.chmodSync(ownerKeys, 0o700);
  for (const f of fs.readdirSync(path.join(statusRoot, 'keys'))) fs.renameSync(path.join(statusRoot, 'keys', f), path.join(ownerKeys, f));
  fs.rmSync(path.join(statusRoot, 'keys'), {recursive: true});
  const S = openStatusLedger({root: statusRoot, keys: ownerKeys});
  S.set({item: 'rehearsal-dep', title: 'A dependency', state: 'Resolved', basis: 'done', checked: '2026-11-17'});
  S.set({item: ITEM, title: 'Rehearsal item', state: 'Ready', basis: 'nothing external awaited', checked: '2026-11-17', depends_on: ['rehearsal-dep']});
  S.set({item: 'rehearsal-hold', title: 'Held', state: 'On Hold', basis: 'a decision', checked: '2026-11-17', waiting_on: 'decision'});
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Rehearsal Owner');
  git(repo, 'config', 'user.email', 'owner@example.invalid');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'rehearsal base');
  return {statusRoot, ownerKeys};
}

test('REHEARSAL: one operating cycle, from the verified board to a Resolved status with evidence on the public record', async t => {
  await withPipeline(async ({repo, opts, implement}) => {
    const {statusRoot, ownerKeys} = setUp(repo);
    implement(() => 'export const ok = true;\n');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-rehearsal-'));
    try {
      // next: the verified board's dispatchable item, with its ticket and team.
      const next = boardNext({repo, statusRoot, pools: [], overrides: opts.seatOverrides});
      assert.deepEqual(next.items.map(i => i.item), [ITEM]);
      assert.equal(next.items[0].ticket.path, `tickets/${ITEM}.json`);
      assert.deepEqual(next.skipped, []);
      const team = next.items[0].team;
      assert.equal(new Set(team.cycle_reviewers.seats.map(s => s.lab)).size, 3);
      assert.ok(team.cycle_reviewers.seats.every(s => !team.cycle_reviewers.author_labs.includes(s.lab)));

      // run: scripted plan/work/review seats ship it; three reviewers on distinct labs review the commit.
      const seatOverrides = {...opts.seatOverrides, implementer: {...opts.seatOverrides.implementer, vendor: 'anthropic', model: modelId('anthropic', 'fable'), pool: 'anthropic'}};
      const base = git(repo, 'rev-parse', 'HEAD').trim();
      const r = await runBoardItem({repo, item: ITEM, statusRoot, makeClientFor: opts.makeClientFor, turn: approve,
        dir: path.join(work, 'board'), out: path.join(work, 'bundle'), checked: '2026-11-18',
        runOpts: {scouts: opts.scouts, revisions: opts.revisions, seatOverrides}});
      assert.equal(r.bundle.run.shipped, true, JSON.stringify(r.bundle.run.error));
      assert.ok(r.proposal, r.why);
      assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), base, 'the working branch is not moved');
      assert.equal(git(repo, 'show', `${r.bundle.commit}:alpha.mjs`), 'export const ok = true;\n');
      assert.equal(git(repo, 'rev-parse', `pantheon/${ITEM}`).trim(), r.bundle.commit);
      const labs = r.bundle.review.reviews.map(x => x.lab);
      assert.equal(new Set(labs).size, 3, 'three distinct labs reviewed');
      assert.ok(!labs.includes('anthropic'), 'the lab that planned and implemented did not review');
      assert.equal(r.bundle.review.planner_excluded, true);
      assert.ok(r.bundle.review.author_turns.length >= 1, 'the cycle cites the author turns (cold review over their lineage)');
      assert.equal(r.bundle.review.outcome, 'verified');
      assert.equal(r.proposal.schema, 'ophanim.status-proposal/v1');
      assert.equal(r.proposal.to.state, 'Resolved');
      assert.equal(r.proposal.from.entry, openStatusLedger({root: statusRoot, create: false}).board().items.find(i => i.item === ITEM).entry);
      assert.equal(fs.existsSync(path.join(statusRoot, 'keys')), false, 'the run held no status key');

      // check: the evidence re-derives with Pantheon's kinds, and the commit is the reviewed head.
      t.diagnostic(`next: ${next.items.map(i => i.item)}; run shipped ${r.bundle.commit.slice(0, 12)} on ${r.bundle.branch}; seats ${r.bundle.run.seats.map(s => `${s.purpose} ${s.vendor}/${s.model} (${s.lab})`).join(', ')}`);
      t.diagnostic(`cycle ${r.bundle.review.cycle.slice(0, 19)} closed ${r.bundle.review.outcome} by ${r.bundle.review.reviews.map(x => `${x.vendor}/${x.model} (${x.lab}) ${x.verdict}`).join(', ')}; proposal ${r.bundle.proposal.digest.slice(0, 19)} -> ${r.proposal.to.state}`);
      const checked = checkProposal({proposal: r.proposal, repo});
      assert.equal(checked.ok, true);

      // Refusals before the real apply: tampered evidence, an unverified close without a reason, no keys.
      const tampered = structuredClone(r.proposal);
      tampered.evidence.run.ledger_head = 'sha256:' + 'ab'.repeat(32);
      assert.throws(() => applyProposal({root: statusRoot, proposal: tampered, keys: ownerKeys}), /head the proposal cites is not in that ledger/);
      const forgedLab = structuredClone(r.proposal);
      forgedLab.evidence.review.reviewers[0].lab = 'anthropic';
      assert.throws(() => applyProposal({root: statusRoot, proposal: forgedLab, keys: ownerKeys}), /labs are not the ones the close names/);
      const unverified = structuredClone(r.proposal);
      unverified.evidence.review.outcome = 'unverified';
      assert.throws(() => applyProposal({root: statusRoot, proposal: unverified, keys: ownerKeys}), /accept_unverified_reason/);
      unverified.accept_unverified_reason = 'rehearsal';
      assert.throws(() => applyProposal({root: statusRoot, proposal: unverified, keys: ownerKeys}), /closed verified, not unverified/);
      assert.throws(() => applyProposal({root: statusRoot, proposal: r.proposal, keys: path.join(work, 'no-keys')}), /can be verified, not changed/);

      // apply, as the owner does: the CLI with OPHANIM_STATUS_KEYS; the board file is re-rendered.
      const boardFile = path.join(work, 'STATUS.md');
      const env = {...process.env, OPHANIM_STATUS_LEDGER: statusRoot, OPHANIM_STATUS_KEYS: ownerKeys, OPHANIM_STATUS_BOARD: boardFile};
      const proposalFile = path.join(work, 'bundle', 'proposal.json');
      const applied = JSON.parse(execFileSync(process.execPath, [STATUS_CLI, 'apply', proposalFile], {encoding: 'utf8', env}));
      t.diagnostic(`applied: ${applied.applied} -> ${applied.state}; cited ledgers ${applied.cited_ledgers}`);
      assert.equal(applied.state, 'Resolved');
      assert.equal(applied.cited_ledgers, 'structural');
      const latest = openStatusLedger({root: statusRoot, create: false}).board().items.find(i => i.item === ITEM);
      assert.equal(latest.entry, applied.applied);
      assert.equal(latest.state, 'Resolved');
      assert.equal(latest.evidence.commit, r.bundle.commit);
      assert.equal(latest.evidence.review.close_entry, r.bundle.review.close);
      assert.deepEqual(latest.depends_on, ['rehearsal-dep'], 'what the proposal does not change is carried');
      assert.ok(!JSON.stringify(latest.evidence).includes(os.tmpdir()), 'no machine path is recorded');
      assert.match(fs.readFileSync(boardFile, 'utf8'), /evidence: commit [0-9a-f]{12}; tests exit 0; review cycle [0-9a-f]{12} verified/);
      assert.equal(renderBoard(openStatusLedger({root: statusRoot, create: false}).board()), fs.readFileSync(boardFile, 'utf8'));

      // A stale proposal (the same one again, now that the item moved on) is refused by the CLI.
      let stale = null;
      try { execFileSync(process.execPath, [STATUS_CLI, 'apply', proposalFile], {encoding: 'utf8', env, stdio: 'pipe'}); }
      catch (e) { stale = e; }
      assert.equal(stale?.status, 1);
      assert.match(stale.stderr, /stale proposal/);
      // And re-proposing from the bundle now says so too.
      assert.match(proposeFromBundle({dir: path.join(work, 'bundle'), statusRoot}).why, /status changed since the run started/);

      // The board moves on: nothing left to dispatch (the held item is not Ready).
      const after = JSON.parse(execFileSync(process.execPath, [BOARD_CLI, 'next', '--json', '--repo', repo, '--status-ledger', statusRoot], {encoding: 'utf8'}));
      assert.deepEqual(after.items, []);

      // The public record: the issue body shows the evidence; no seat is an assignee.
      const issue = plan(readStatusRecord({root: statusRoot})).issues.find(i => i.item === ITEM);
      assert.equal(issue.state, 'closed');
      assert.deepEqual(issue.assignees, []);
      for (const s of ['## Evidence', r.bundle.commit, r.bundle.review.cycle, r.bundle.review.close, r.proposal.evidence.run.ledger_head,
        'outcome **verified**', '`node verify.mjs` exited 0', ...r.proposal.evidence.review.reviewers.map(x => `| ${x.vendor} | ${x.model} | ${x.served_model} | ${x.lab} |`)]) {
        assert.ok(issue.body.includes(s), `the issue body shows ${s}`);
      }
      assert.match(issue.body, /cites a review cycle that closed verified with reviews on distinct labs/);
    } finally { fs.rmSync(work, {recursive: true, force: true}); fs.rmSync(ownerKeys, {recursive: true, force: true}); }
  });
});

test('REHEARSAL: a finding without a reproduction is deferred; the unverified close proposes Resolved only with a stated reason', async () => {
  await withPipeline(async ({repo, opts, implement}) => {
    const {statusRoot, ownerKeys} = setUp(repo);
    implement(() => 'export const ok = true;\n');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-rehearsal-'));
    // The Google reviewer reports one finding it cannot reproduce; the others approve.
    const finding = '{"severity": "minor", "file": "alpha.mjs", "line": 1, "claim": "no comment says why ok is true", "reproduction": null}';
    const turn = async a => (a.vendor !== 'agy_google' ? approve(a)
      : {served_model: a.model, response_id: `rehearsal_finding_${++replies}`, text: '```json\n{"verdict": "request_changes", "findings": [' + finding + ']}\n```'});
    try {
      const seatOverrides = {...opts.seatOverrides, implementer: {...opts.seatOverrides.implementer, vendor: 'anthropic', model: modelId('anthropic', 'fable'), pool: 'anthropic'}};
      const bundleDir = path.join(work, 'bundle');
      const r = await runBoardItem({repo, item: ITEM, statusRoot, makeClientFor: opts.makeClientFor, turn,
        dir: path.join(work, 'board'), out: bundleDir, runOpts: {scouts: opts.scouts, revisions: opts.revisions, seatOverrides}});
      assert.equal(r.bundle.run.shipped, true, JSON.stringify(r.bundle.run.error));
      assert.equal(r.proposal, undefined);
      assert.match(r.why, /neither fixed nor deferred/);
      const recorded = r.bundle.review.reviews.find(x => x.lab === 'google').findings[0];
      assert.equal(recorded.reproduction, null);
      openPantheonLedger({root: r.bundle.run.ledger}).recorder().deferFinding({finding: recorded.finding, reason: 'style note; a later CO1 slice'});
      assert.throws(() => proposeFromBundle({dir: bundleDir, statusRoot}), /accept_unverified_reason/);
      const again = proposeFromBundle({dir: bundleDir, statusRoot, acceptUnverified: 'the only finding is a deferred style note'});
      assert.equal(again.proposal.evidence.review.outcome, 'unverified');
      const applied = applyProposal({root: statusRoot, proposal: again.proposal, keys: ownerKeys});
      const item = applied.board.items.find(i => i.item === ITEM);
      assert.equal(item.state, 'Resolved');
      assert.equal(item.evidence.accept_unverified_reason, 'the only finding is a deferred style note');
      const issue = plan(readStatusRecord({root: statusRoot})).issues.find(i => i.item === ITEM);
      assert.match(issue.body, /outcome \*\*unverified\*\*/);
      assert.match(issue.body, /Accepted although the review closed unverified:\*\* the only finding is a deferred style note/);
    } finally { fs.rmSync(work, {recursive: true, force: true}); fs.rmSync(ownerKeys, {recursive: true, force: true}); }
  });
});
