// Automatic evidence recovery for items Resolved on an attested basis only (evidence-recovery.mjs), through the real
// scheduler and the real stage executors over SCRIPTED providers, with a SYNTHETIC fifth reviewer lab so that a run
// can reach a closed three-lab review (test-fixtures.mjs). The status ledger is changed only by the owner's
// applyProposal, as on the owner's machine; the controller never signs it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openStatusLedger, applyProposal, proposalRefusal} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {tickWithPrimary as tick} from './test-fixtures.mjs';   // every tick declares primary Gemini execution: the fit implementer is an SDK session
import {reconcile} from './reconcile.mjs';
import {makeExecutors} from './stages.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, LIMITS, FIVE, stagesOf} from './test-fixtures.mjs';

const gateOf = (f, repo, item) => reconcile({repo, statusRoot: f.statusRoot, workLedger: openWorkLedger({root: f.workRoot})}).items.find(i => i.item === item).gate;
// The owner records an item Resolved on an attested basis only: no completion evidence on the status.
const attest = (f, item) => f.S.set({item, title: `Alpha for ${item}`, state: 'Resolved', basis: 'done (attested)', checked: '2026-11-17'});

test('recovery: a retained run\'s verified evidence becomes an unsigned proposal for the current Resolved status; the owner applies it; nothing is searched twice', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'ran'}, {item: 'never-ran'}]);
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, ...FIVE});
    // Both go through the lifecycle; neither outcome proposal is applied.
    const r1 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.ok(stagesOf(r1).filter(x => x === 'outcome:passed').length === 2, JSON.stringify(r1.dispatched));
    // The owner instead records both Resolved on an attested basis only: two evidence gaps.
    attest(f, 'ran'); attest(f, 'never-ran');
    for (const i of ['ran', 'never-ran']) assert.match(gateOf(f, repo, i).reason, /attested basis only.*recovery has not searched/);
    // `never-ran` is made a Resolved item with no retained run: its outcome bundle is removed.
    const w0 = openWorkLedger({root: f.workRoot});
    const lost = w0.stages('never-ran').find(s => s.stage === 'outcome').outputs.bundle;
    fs.rmSync(lost, {recursive: true, force: true});
    const statusBefore = openStatusLedger({root: f.statusRoot, create: false}).board().entries;

    const r2 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.deepEqual(r2.dispatched, [], 'recovery dispatches no stage and calls no provider');
    const byItem = Object.fromEntries(r2.recovery.map(x => [x.item, x]));
    assert.equal(byItem.ran.outcome, 'recovered');
    assert.equal(byItem['never-ran'].outcome, 'not-found');
    assert.equal(openStatusLedger({root: f.statusRoot, create: false}).board().entries, statusBefore, 'the controller recorded no status');
    // The proposal: unsigned, against the CURRENT Resolved entry, carrying the run's verified three-lab evidence.
    const p = JSON.parse(fs.readFileSync(byItem.ran.proposal, 'utf8'));
    const ranNow = openStatusLedger({root: f.statusRoot, create: false}).board().items.find(i => i.item === 'ran');
    assert.equal(p.from.entry, ranNow.entry);
    assert.equal(p.to.state, 'Resolved');
    assert.equal(proposalRefusal(p), null);
    assert.equal(p.signature, undefined);
    assert.equal(new Set(p.evidence.review.reviewers.map(x => x.lab)).size, 3);
    assert.equal(p.evidence.ticket.path, 'tickets/ran.json');
    const w = openWorkLedger({root: f.workRoot});
    assert.equal(w.verify().ok, true);
    const [rec] = w.recoveries('ran');
    assert.equal(rec.proposal.digest, byItem.ran.digest);
    assert.ok(rec.searched.some(x => x.source === 'work' && x.result === 'recovered'));
    assert.equal(gateOf(f, repo, 'ran').gate, 'awaiting-owner');
    const gap = gateOf(f, repo, 'never-ran');
    assert.equal(gap.gate, 'evidence-gap');
    assert.match(gap.blocker.what, /recovery searched .* none applies/);
    assert.match(gap.blocker.resume_when, /records the item Ready to re-verify/);

    // Nothing changed: the next tick searches nothing again.
    const r3 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.deepEqual(r3.recovery, []);
    assert.equal(openWorkLedger({root: f.workRoot}).recoveries().length, 2);

    // The owner applies it with their keys: the status now carries structurally checked evidence, and the gap is closed.
    const applied = applyProposal({root: f.statusRoot, proposal: p});
    assert.equal(applied.checked.checked, 'structural');
    assert.equal(gateOf(f, repo, 'ran').gate, 'complete');
  });
});

test('recovery refuses evidence that does not re-check, searches again when the cited bytes change, and treats a changed requirement as stale', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'tampered'}, {item: 'moved'}]);
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, ...FIVE});
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    const runJson = JSON.parse(fs.readFileSync(w.stages('tampered').find(s => s.stage === 'outcome').outputs.proposal_path, 'utf8')).locations.run_json;
    const original = fs.readFileSync(runJson);
    fs.writeFileSync(runJson, Buffer.concat([original, Buffer.from(' ')]));
    // `moved`: the owner restates its requirement (a new Ready basis) and then records it Resolved by attestation.
    f.S.set({item: 'moved', title: 'Alpha for moved', state: 'Ready', basis: 'a different requirement than the one run', checked: '2026-11-17'});
    attest(f, 'tampered'); attest(f, 'moved');

    const r1 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const out = Object.fromEntries(r1.recovery.map(x => [x.item, x]));
    assert.equal(out.tampered.outcome, 'not-found');
    assert.equal(out.moved.outcome, 'not-found');
    const recs = item => openWorkLedger({root: f.workRoot}).recoveries(item);
    assert.match(recs('tampered')[0].searched.find(x => x.source === 'work').why, /run\.json is not the one the proposal cites/);
    assert.equal(recs('moved')[0].searched.find(x => x.source === 'work').result, 'stale');

    // The cited bytes are restored: the sources changed, so the item is searched again, and now recovered.
    fs.writeFileSync(runJson, original);
    const r2 = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    assert.deepEqual(r2.recovery.map(x => [x.item, x.outcome]), [['tampered', 'recovered']], 'only the item whose sources changed');
    assert.equal(recs('tampered').length, 2);
    assert.equal(gateOf(f, repo, 'tampered').gate, 'awaiting-owner');
  });
});
