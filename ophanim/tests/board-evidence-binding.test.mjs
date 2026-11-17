// Completion evidence is bound to the item it completes (review of 86ce18a, defect 1). A valid three-lab
// proposal for item A must not resolve an unrelated item B by changing only `item` and `from`: the ticket,
// the cycle's scope and head, and the run.json's key all name A. And a change to Resolved whose evidence
// cannot be checked where apply runs is refused: completion evidence is verifiable at apply, or not applied.
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
import {digest} from '../../packages/ledger/canonical.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'});
const PRACTICE = {outcome: 'insufficient_evidence', question: 'binding fixture: no routing or coordination comparison exists'};
const ticket = (item, file) => ({
  schema: 'ophanim.ticket/v1', item, slice: `the whole ${item}: ${file} exports ok = true`,
  proposes: {state: 'Resolved', basis: `${file} exports ok = true (fixture)`},
  title: `${file} exports ok = true`, goal: `Make ${file} export \`ok\` as true.`, question: 'binding fixture',
  repo_root: '.', slot: 'alpha', path: file, copy: [file, 'verify.mjs'], acceptance_cmd: 'node verify.mjs', difficulty: 'easy',
});
let replies = 0;
const approve = async ({vendor, model}) => ({text: '```json\n{"verdict": "approve", "findings": []}\n```', response_id: `bind_${vendor}_${++replies}`, served_model: model});

function setUp(repo) {
  fs.writeFileSync(path.join(repo, 'alpha.mjs'), 'export const ok = false;\n');
  fs.writeFileSync(path.join(repo, 'beta.mjs'), 'export const ok = false;\n');
  fs.writeFileSync(path.join(repo, 'verify.mjs'), 'import assert from "node:assert/strict"; import {ok} from "./alpha.mjs"; assert.equal(ok, true);\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'outputs/\ncooldowns/\nboard/\n');
  fs.mkdirSync(path.join(repo, 'tickets'));
  fs.writeFileSync(path.join(repo, 'tickets', 'item-a.json'), JSON.stringify(ticket('item-a', 'alpha.mjs'), null, 2) + '\n');
  fs.writeFileSync(path.join(repo, 'tickets', 'item-b.json'), JSON.stringify(ticket('item-b', 'beta.mjs'), null, 2) + '\n');
  const statusRoot = path.join(repo, 'status', 'ledger');
  openStatusLedger({root: statusRoot});
  const ownerKeys = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-owner-keys-'));
  for (const f of fs.readdirSync(path.join(statusRoot, 'keys'))) fs.renameSync(path.join(statusRoot, 'keys', f), path.join(ownerKeys, f));
  fs.rmSync(path.join(statusRoot, 'keys'), {recursive: true});
  const S = openStatusLedger({root: statusRoot, keys: ownerKeys});
  S.set({item: 'item-a', title: 'Item A', state: 'Ready', basis: 'nothing external awaited', checked: '2026-11-17'});
  S.set({item: 'item-b', title: 'Item B (unrelated)', state: 'Ready', basis: 'nothing external awaited', checked: '2026-11-17'});
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture Owner');
  git(repo, 'config', 'user.email', 'owner@example.invalid');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture base');
  return {statusRoot, ownerKeys};
}

test('a three-lab proposal for item A cannot resolve unrelated item B, and Resolved evidence must be checkable at apply', async () => {
  await withPipeline(async ({repo, opts, implement}) => {
    const {statusRoot, ownerKeys} = setUp(repo);
    implement(() => 'export const ok = true;\n');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-binding-'));
    try {
      const seatOverrides = {...opts.seatOverrides, implementer: {...opts.seatOverrides.implementer, vendor: 'anthropic', model: modelId('anthropic', 'fable'), pool: 'anthropic'}};
      const r = await runBoardItem({repo, item: 'item-a', statusRoot, makeClientFor: opts.makeClientFor, turn: approve,
        dir: path.join(work, 'board'), out: path.join(work, 'bundle'), checked: '2026-11-18',
        runOpts: {scouts: opts.scouts, revisions: opts.revisions, seatOverrides}, practice: PRACTICE});
      assert.ok(r.proposal, r.why);
      assert.equal(r.proposal.to.state, 'Resolved');
      const board = () => openStatusLedger({root: statusRoot, create: false}).board();
      const b = board().items.find(i => i.item === 'item-b');

      // 1. The replay: A's proposal with only `item` and `from` changed.
      const replay = {...structuredClone(r.proposal), item: 'item-b', from: {state: b.state, entry: b.entry}};
      assert.throws(() => applyProposal({root: statusRoot, proposal: replay, keys: ownerKeys}), /not the ticket of "item-b" \(tickets\/item-b\.json\)/,
        'a proposal for item-b citing item-a\'s ticket is refused');
      // 2. The replay with B's ticket named in its place (path, digest, slice, and the ticket file itself).
      const bTicket = JSON.parse(fs.readFileSync(path.join(repo, 'tickets', 'item-b.json'), 'utf8'));
      const swapped = structuredClone(replay);
      swapped.evidence.ticket = {path: 'tickets/item-b.json', digest: 'sha256:' + digest(bTicket), slice: bTicket.slice};
      swapped.locations.ticket = path.join(repo, 'tickets', 'item-b.json');
      assert.throws(() => applyProposal({root: statusRoot, proposal: swapped, keys: ownerKeys}), /run\.json ran the ticket key "item-a", not "item-b"/,
        'the run is item-a\'s, whatever ticket the proposal names');
      const noRunJson = structuredClone(swapped);
      noRunJson.locations.run_json = null;
      assert.throws(() => applyProposal({root: statusRoot, proposal: noRunJson, keys: ownerKeys}), /scope is board\/item-a\/[0-9a-f]{12}, not the board scope of "item-b"/,
        'the review cycle is item-a\'s');
      const otherCommit = structuredClone(r.proposal);
      otherCommit.evidence.commit = 'c'.repeat(40);
      assert.throws(() => applyProposal({root: statusRoot, proposal: otherCommit, keys: ownerKeys}), /not the cited commit/,
        'the cycle reviewed the cited commit, and no other');
      // 3. Item A's own proposal, with nothing on this machine to check it against: refused for Resolved.
      const {locations, ...unchecked} = structuredClone(r.proposal);
      assert.throws(() => applyProposal({root: statusRoot, proposal: unchecked, keys: ownerKeys}), /verifiable at apply|not available/);
      assert.equal(board().items.find(i => i.item === 'item-b').state, 'Ready', 'item-b is unchanged');
      assert.equal(board().items.find(i => i.item === 'item-a').state, 'Ready', 'item-a is unchanged by the refusals');

      // 4. The genuine proposal applies, structurally checked.
      const applied = applyProposal({root: statusRoot, proposal: r.proposal, keys: ownerKeys});
      assert.equal(applied.state, 'Resolved');
      assert.equal(applied.checked.checked, 'structural');
      assert.equal(board().items.find(i => i.item === 'item-b').state, 'Ready');
    } finally { fs.rmSync(work, {recursive: true, force: true}); fs.rmSync(ownerKeys, {recursive: true, force: true}); }
  });
});
