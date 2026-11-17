// The status board: a projection of a ledger, with the standing rule enforced when a status is recorded.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStatusLedger, renderBoard} from '../status.mjs';

const withRoot = fn => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-status-')); try { return fn(path.join(d, 'ledger')); } finally { fs.rmSync(d, {recursive: true, force: true}); } };
const base = {checked: '2026-11-17'};

test('statuses chain per item and the board is the latest of each', () => withRoot(root => {
  const S = openStatusLedger({root});
  S.set({...base, item: 'k1', title: 'Chain core', state: 'In progress', basis: 'started'});
  S.set({...base, item: 'k1', title: 'Chain core', state: 'Resolved', basis: 'merged'});
  S.set({...base, item: 'k6', title: 'TELOS reviewers', state: 'On Hold', basis: 'pinned verifier', waiting_on: 'governance'});
  const b = S.board();
  assert.deepEqual(b.items.map(i => [i.item, i.state]).sort(), [['k1', 'Resolved'], ['k6', 'On Hold']]);
  const md = renderBoard(b);
  assert.match(md, /Generated from the status ledger/);
  assert.ok(md.indexOf('k6') < md.indexOf('k1'), 'holds first');
  // Reopened from disk, the same board.
  assert.deepEqual(openStatusLedger({root}).board().items.length, 2);
}));

test('the standing rule: a hold names something outside the work, or an unresolved dependency', () => withRoot(root => {
  const S = openStatusLedger({root});
  assert.throws(() => S.set({...base, item: 'pkg', title: 'Shared package', state: 'On Hold', basis: 'not started', waiting_on: 'work'}), /it is Ready, not On Hold/);
  assert.throws(() => S.set({...base, item: 'pkg', title: 'Shared package', state: 'On Hold', basis: 'later'}), /Ready, not On Hold/);
  S.set({...base, item: 'pkg', title: 'Shared package', state: 'Ready', basis: 'dependencies converged'});
  S.set({...base, item: 'k6', title: 'TELOS reviewers', state: 'On Hold', basis: 'pinned verifier', waiting_on: 'governance'});
  // Held on an item that is itself held: allowed. Held on a resolved item: refused.
  S.set({...base, item: 'p8', title: 'P8 admission', state: 'On Hold', basis: 'needs K6', depends_on: ['k6']});
  S.set({...base, item: 'k1', title: 'Chain core', state: 'Resolved', basis: 'merged'});
  assert.throws(() => S.set({...base, item: 'x', title: 'X', state: 'On Hold', basis: 'needs k1', depends_on: ['k1']}), /Ready, not On Hold/);
  assert.throws(() => S.set({...base, item: 'pkg', title: 'Shared package', state: 'Resolved', basis: 'done', waiting_on: 'governance'}), /only a hold waits/);
  assert.throws(() => S.set({...base, item: 'bad', title: 'B', state: 'Blocked', basis: 'x'}), /state must be one of/);
}));

test('the board can be verified by anyone and changed only by a key holder; edits are caught', () => withRoot(root => {
  const S = openStatusLedger({root});
  S.set({...base, item: 'k1', title: 'Chain core', state: 'Resolved', basis: 'merged'});
  fs.rmSync(path.join(root, 'keys'), {recursive: true});
  const reader = openStatusLedger({root});
  assert.equal(reader.board().items.length, 1, 'verifiable without keys');
  assert.throws(() => reader.set({...base, item: 'k2', title: 'Genesis', state: 'Resolved', basis: 'x'}), /can be verified, not changed/);
  // The basis lives in a content-addressed payload object: editing it is caught.
  const objects = path.join(root, 'objects');
  const obj = fs.readdirSync(objects).map(f => path.join(objects, f)).find(f => fs.readFileSync(f, 'utf8').includes('"merged"'));
  fs.writeFileSync(obj, fs.readFileSync(obj, 'utf8').replace('"merged"', '"forged"'));
  assert.throws(() => openStatusLedger({root}), /does not verify/);
}));

test('owner_role is optional, and when present names a chair or decision-authority', () => withRoot(root => {
  const S = openStatusLedger({root});
  S.set({...base, item: 'k1', title: 'Chain core', state: 'Ready', basis: 'converged'});
  S.set({...base, item: 'k2', title: 'Genesis', state: 'In progress', basis: 'started', owner_role: 'impl@build'});
  S.set({...base, item: 'signer', title: 'Signer', state: 'On Hold', basis: 'custody', waiting_on: 'decision', owner_role: 'decision-authority'});
  assert.throws(() => S.set({...base, item: 'k3', title: 'X', state: 'Ready', basis: 'x', owner_role: 'octocat'}), /owner_role must be one of/);
  const items = new Map(openStatusLedger({root}).board().items.map(i => [i.item, i]));
  assert.equal(items.get('k1').owner_role, undefined, 'absent when not given');
  assert.equal(items.get('k2').owner_role, 'impl@build');
  assert.equal(items.get('signer').owner_role, 'decision-authority');
}));
