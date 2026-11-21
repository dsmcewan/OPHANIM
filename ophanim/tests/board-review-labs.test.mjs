// A board run's coordinated cycle review needs three independent labs, and a caller cannot lower it (review of
// 86ce18a, defect 2). runBoardItem passed `n` through, the cycle kind accepted one reviewer, and apply never
// counted them: `runBoardItem({n: 1})` closed its cycle `verified` on one lab and the proposal resolved the item.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {withPipeline} from '../../pantheon/tests/fixtures/pipeline.mjs';
import {modelId} from '../../pantheon/src/config/models.mjs';
import {runBoardItem} from '../../pantheon/src/board/operate.mjs';
import {openStatusLedger, applyProposal} from '../../packages/ledger/status.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'});
const ITEM = 'labs-item';
const TICKET = {
  schema: 'ophanim.ticket/v1', item: ITEM, slice: 'the whole item: alpha.mjs exports ok = true',
  proposes: {state: 'Resolved', basis: 'alpha.mjs exports ok = true (fixture)'},
  title: 'alpha.mjs exports ok = true', goal: 'Make alpha.mjs export `ok` as true.', question: 'review-labs fixture',
  repo_root: '.', slot: 'alpha', path: 'alpha.mjs', copy: ['alpha.mjs', 'verify.mjs'], acceptance_cmd: 'node verify.mjs', difficulty: 'easy',
};
let replies = 0;
const approve = async ({vendor, model}) => ({text: '```json\n{"verdict": "approve", "findings": []}\n```', response_id: `labs_${vendor}_${++replies}`, served_model: model});

function setUp(repo) {
  fs.writeFileSync(path.join(repo, 'alpha.mjs'), 'export const ok = false;\n');
  fs.writeFileSync(path.join(repo, 'verify.mjs'), 'import assert from "node:assert/strict"; import {ok} from "./alpha.mjs"; assert.equal(ok, true);\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'outputs/\ncooldowns/\nboard/\n');
  fs.mkdirSync(path.join(repo, 'tickets'));
  fs.writeFileSync(path.join(repo, 'tickets', `${ITEM}.json`), JSON.stringify(TICKET, null, 2) + '\n');
  const statusRoot = path.join(repo, 'status', 'ledger');
  openStatusLedger({root: statusRoot});
  const ownerKeys = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-owner-keys-'));
  for (const f of fs.readdirSync(path.join(statusRoot, 'keys'))) fs.renameSync(path.join(statusRoot, 'keys', f), path.join(ownerKeys, f));
  fs.rmSync(path.join(statusRoot, 'keys'), {recursive: true});
  openStatusLedger({root: statusRoot, keys: ownerKeys}).set({item: ITEM, title: 'Labs item', state: 'Ready', basis: 'nothing external awaited', checked: '2026-11-17'});
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture Owner');
  git(repo, 'config', 'user.email', 'owner@example.invalid');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture base');
  return {statusRoot, ownerKeys};
}

test('a board run with n below three is refused before any work; it never closes verified on one lab and resolves its item', async () => {
  await withPipeline(async ({repo, opts, implement, calls}) => {
    const {statusRoot, ownerKeys} = setUp(repo);
    implement(() => 'export const ok = true;\n');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-labs-'));
    try {
      const seatOverrides = {...opts.seatOverrides, implementer: {...opts.seatOverrides.implementer, vendor: 'anthropic', model: modelId('anthropic', 'fable'), pool: 'anthropic'}};
      for (const n of [1, 2]) {
        let r = null, err = null;
        try {
          r = await runBoardItem({repo, item: ITEM, statusRoot, makeClientFor: opts.makeClientFor, turn: approve, n,
            dir: path.join(work, `board-${n}`), out: path.join(work, `bundle-${n}`), branch: `pantheon/${ITEM}-${n}`, checked: '2026-11-18',
            runOpts: {scouts: opts.scouts, revisions: opts.revisions, seatOverrides},
            practice: {outcome: 'insufficient_evidence', question: 'review-labs fixture'}});
        } catch (e) { err = e; }
        if (!err) {
          // What 86ce18a did: describe it, and show whether the proposal applies.
          let applied = 'no proposal';
          if (r?.proposal) { try { applied = applyProposal({root: statusRoot, proposal: r.proposal, keys: ownerKeys}).state; } catch (e) { applied = `refused (${e.message})`; } }
          assert.fail(`n=${n} was not refused: shipped=${r?.bundle?.run?.shipped}, the cycle closed ${r?.bundle?.review?.outcome} with ` +
            `${r?.bundle?.review?.reviews?.length} review(s) on ${r?.bundle?.review?.reviews?.map(x => x.lab).join(', ')}, proposal -> ${r?.proposal?.to?.state}, apply -> ${applied}`);
        }
        assert.equal(err.code, 'REVIEW_LABS_BELOW_REQUIRED', err.message);
        assert.match(err.message, /3 independent labs/);
      }
      assert.equal(calls.length, 0, 'refused before any provider call');
      assert.equal(openStatusLedger({root: statusRoot, create: false}).board().items[0].state, 'Ready');
    } finally { fs.rmSync(work, {recursive: true, force: true}); fs.rmSync(ownerKeys, {recursive: true, force: true}); }
  });
});
