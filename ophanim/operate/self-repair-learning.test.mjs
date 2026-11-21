// LEARNING (owner, 2026-11-20: "Recursive"). The lane learns from its own rounds: a round's Diagnose is handed what the
// lane tried before on that defect or its files; a defect that is back after a landed repair, or that failed to be
// repaired twice, is RECURRING, and the lane routes the owner a lesson candidate (a lessons class with a mechanical
// detector) while it still repairs the instance. It never writes the lessons registry. Fixture repositories with fresh
// synthetic owner keys; no provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tick} from './scheduler.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {plannerPrompt} from './stages.mjs';
import {laneHistory, recurrenceOf, select} from './self-repair.mjs';
import {laneRepo, gateRecord, scriptedRound, addsPlan, commitOn, LIMITS, g} from './fixtures/self-repair-fixture.mjs';

const WAIT = {status: 'pending', outputs: {}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, next: {stage: 'plan', why: 'a scripted transient wait'}};
const LINE = 'refs/heads/ophanim/self-repair';
const ADDS = {id: 'test:test/calc.test.mjs::adds', kind: 'regression', title: 'failing test adds in test/calc.test.mjs', site: ['test/calc.test.mjs'], reproduction: {kind: 'test', file: 'test/calc.test.mjs', name: 'adds'}};
const round = (n, {defect = ADDS, kind = 'repair', outcome = null, landed = null, culprit = null} = {}) =>
  ({n, item: `self-repair.r${n}`, open: {kind, defect, ...(culprit ? {culprit} : {})}, close: outcome ? {outcome, why: `scripted ${outcome}`} : null, land: landed ? {commit: landed} : null});
const C1 = 'a'.repeat(40);

test('learning: the history is the earlier rounds on the same defect or an overlapping site, with how each ended and its rollback', () => {
  const other = {id: 'register:KG-90', kind: 'register', site: ['lib/strings.mjs']}, near = {id: 'test:test/calc.test.mjs::muls', kind: 'regression', site: ['test/calc.test.mjs']};
  const rounds = [round(1, {outcome: 'landed', landed: C1}), round(2, {defect: other, outcome: 'failed'}), round(3, {defect: near, outcome: 'blocked'}),
    round(4, {kind: 'rollback', defect: ADDS, outcome: 'landed', culprit: {round: 1, commit: C1}})];
  const h = laneHistory(rounds, ADDS);
  assert.deepEqual(h.map(x => [x.round, x.same_defect, x.outcome, x.landed]), [[1, true, 'landed', C1], [3, false, 'blocked', null]], 'the unrelated defect and the rollback round itself are not repairs of it');
  assert.deepEqual(h[0].reverted_by, {round: 4, outcome: 'landed'}, 'a rollback that reverted the repair is part of its history');
});

test('learning: recurrence is a defect back after a LANDED repair, or one that failed to be repaired twice; once failing is not', () => {
  assert.equal(recurrenceOf([]), null);
  assert.deepEqual(recurrenceOf(laneHistory([round(1, {outcome: 'landed', landed: C1})], ADDS)).kind, 'returned');
  assert.equal(recurrenceOf(laneHistory([round(1, {outcome: 'failed'})], ADDS)), null);
  const twice = recurrenceOf(laneHistory([round(1, {outcome: 'failed'}), round(2, {outcome: 'blocked'})], ADDS));
  assert.deepEqual([twice.kind, twice.rounds], ['unrepaired', [1, 2]]);
  assert.equal(recurrenceOf(laneHistory([round(1, {defect: {...ADDS, id: 'test:test/calc.test.mjs::muls'}, outcome: 'landed', landed: C1})], ADDS)), null,
    'a repair of a DIFFERENT defect on the same file is history, not recurrence');
});

test('learning: a defect back after its repair landed opens a round that carries the history, and routes the owner a lesson candidate', async t => {
  const f = laneRepo(t, {register: []});
  // Round 1 repaired the defect and landed (a commit that leaves the calculator broken: the defect is back).
  const fixed = commitOn(f.repo, f.base, {'lib/note.mjs': '// round 1\n'}, 'self-repair round 1');
  g(f.repo, 'update-ref', LINE, fixed);
  const work = openWorkLedger({root: f.workRoot});
  work.recordRepair({event: 'open', round: 1, kind: 'repair', defect: ADDS, paths: ['test/calc.test.mjs'], base: f.base, line: LINE, queue: [], skipped: []});
  work.recordRepair({event: 'land', round: 1, line: LINE, commit: fixed, parent: f.base, revert: `git revert --no-edit ${fixed}`});
  work.recordRepair({event: 'close', round: 1, outcome: 'landed', why: 'landed on the line'});
  gateRecord(f, fixed, [['test/calc.test.mjs', 'adds']]);
  const r = await tick({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, limits: LIMITS, executors: scriptedRound(f, {plan: addsPlan, fix: () => ({}), onPlan: () => WAIT})});
  assert.equal(r.self_repair.opened?.round, 2, JSON.stringify(r.self_repair));
  assert.equal(r.self_repair.lessons.length, 1);
  assert.equal(r.self_repair.lessons[0].kind, 'returned');
  const cand = JSON.parse(fs.readFileSync(path.join(f.stateDir, r.self_repair.lessons[0].candidate), 'utf8'));
  assert.deepEqual([cand.kind, cand.executable, cand.classification, cand.defect.id], ['self-repair-lesson', false, 'candidate', ADDS.id]);
  assert.match(cand.why, /RECURRING: repaired in round\(s\) 1/);
  const open2 = openWorkLedger({root: f.workRoot}).repairs().find(e => e.event === 'open' && e.round === 2);
  assert.deepEqual(open2.history.map(h => [h.round, h.same_defect, h.landed]), [[1, true, fixed]], 'the open event records what was tried before');
  assert.equal(open2.recurrence.kind, 'returned');
  assert.ok(!fs.existsSync(path.join(f.repo, 'ophanim/lessons')), 'the lessons registry is never written');
});

test('learning: Diagnose is shown the lane\'s history and, when it recurs, told to find the mechanism; without history the prompt is as before', () => {
  const base = {mode: 'plan', requirement: 'r', deps: [], ticket: null, previous: null, findings: [], refusals: [], dossier: {item: 'self-repair.r2', head: null, entries: [], omissions: []},
    limits: {rounds: 1, requests_per_round: 1, result_bytes: 1000, total_bytes: 1000}};
  const plain = plannerPrompt({...base, selfRepair: {defect: ADDS, history: [], recurrence: null}});
  assert.doesNotMatch(plain, /What the lane tried before/);
  const h = laneHistory([round(1, {outcome: 'landed', landed: C1})], ADDS);
  const told = plannerPrompt({...base, selfRepair: {defect: ADDS, history: h, recurrence: recurrenceOf(h)}});
  assert.match(told, /### What the lane tried before on this defect or its files/);
  assert.ok(told.includes(JSON.stringify(h[0])), 'each earlier round is shown as recorded');
  assert.match(told, /This defect is RECURRING: repaired in round\(s\) 1 .* Find the MECHANISM/);
});

test('learning: a failing test measured at a commit that CONTAINS its landed repair is back and eligible; a register entry, or evidence from before the landing, still waits for the owner', () => {
  const L1 = 'b'.repeat(40), AFTER = 'c'.repeat(40), BEFORE = 'd'.repeat(40);
  const rounds = [{...round(1, {outcome: 'landed', landed: L1}), land: {commit: L1}}];
  const after = (a, b) => a === L1 && b === AFTER;
  const regression = at => ({...ADDS, keys: [], evidence: {commit: at}});
  const pick = d => select({defects: [d], rounds, board: {items: []}, after});
  assert.equal(pick(regression(AFTER)).selected?.id, ADDS.id, 'measured after the landing: the repair did not hold');
  assert.deepEqual(pick(regression(BEFORE)).skipped.map(s => s.route), ['landed'], 'measured before the landing: it awaits the merge');
  const reg = {id: 'register:KG-90', kind: 'register', title: 'r', site: ['lib/strings.mjs'], keys: ['KG-90'], evidence: {commit: AFTER}};
  const regRounds = [{n: 1, item: 'self-repair.r1', open: {kind: 'repair', defect: reg}, close: {outcome: 'landed', why: 'x'}, land: {commit: L1}}];
  assert.deepEqual(select({defects: [reg], rounds: regRounds, board: {items: []}, after}).skipped.map(s => s.route), ['landed'], 'a register entry waits for the owner to update it');
});
