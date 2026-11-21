// THE LANE'S ROUNDS IN THE LEARNING GRAPH (owner, 2026-11-20: "wire the rounds into the learning graph"). The self-repair
// lane's work.repair events, read from the work ledger through its own reader, become learning facts that learningReuse
// joins on the file like a review finding: a Diagnose touching that file sees what the lane tried there, what landed, and
// what a rollback reverted. A synthetic work ledger (fresh keys); no provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openWorkLedger} from '../operate/work-ledger.mjs';
import {learningReuse, laneLearningFacts, LANE_LEARNING_SOURCE} from './learning.mjs';
import {readWorkLedgerOnly} from './work.mjs';
import {D1_SOURCES} from './d1-sources.mjs';
import {d1Graph} from './fixtures/d1-graph.mjs';
import {fileId} from './extract/repo.mjs';
import {entityId} from '../../packages/graph/index.mjs';

const Lid = (type, key) => entityId({domain: 'learning', type, key});

const LINE = 'refs/heads/ophanim/self-repair', FILE = 'test/calc.test.mjs';
const C = ch => ch.repeat(40);
const ADDS = {id: `test:${FILE}::adds`, kind: 'regression', title: 'failing test adds', site: [FILE], reproduction: {kind: 'test', file: FILE, name: 'adds'}};
/** A work ledger with three lane rounds on FILE: r1 landed (later reverted by r3, a rollback); r2 failed. */
function laneLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-learning-')), root = path.join(dir, 'work');
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const w = openWorkLedger({root});
  const open = (round, extra = {}) => w.recordRepair({event: 'open', round, kind: 'repair', defect: ADDS, paths: [FILE], base: C('0'), line: LINE, queue: [], skipped: [], ...extra});
  open(1);
  w.recordRepair({event: 'land', round: 1, line: LINE, commit: C('1'), parent: C('0'), revert: `git revert --no-edit ${C('1')}`});
  w.recordRepair({event: 'close', round: 1, outcome: 'landed', why: 'landed'});
  open(2, {defect: {...ADDS, id: `test:${FILE}::muls`, reproduction: {kind: 'test', file: FILE, name: 'muls'}}, recurrence: null});
  w.recordRepair({event: 'close', round: 2, outcome: 'failed', why: 'validate refused it'});
  w.recordRepair({event: 'open', round: 3, kind: 'rollback', defect: ADDS, culprit: {round: 1, commit: C('1'), parent: C('0'), defect: ADDS.id}, paths: [FILE], base: C('1'), line: LINE, queue: [], skipped: []});
  return {root, anchor: w.anchor};
}

test('lane learning: the source is registered with the other D1 sources and composed whenever the work ledger is', () => {
  assert.ok(D1_SOURCES.includes(LANE_LEARNING_SOURCE));
});

test('lane learning: each repair round is a finding on its file with its reproduction; a landed round adds its repair, commit and test; a rollback marks what it reverted', t => {
  const w = laneLedger(t);
  const W = readWorkLedgerOnly(w), facts = laneLearningFacts(W, W.verify().head);
  const ent = id => facts.find(f => f.entity === id);
  const f1 = ent(Lid('finding', 'lane/1')), f2 = ent(Lid('finding', 'lane/2'));
  assert.deepEqual([f1.attributes.file, f1.attributes.outcome, f1.attributes.reverted_by_round], [FILE, 'landed', 3]);
  assert.deepEqual([f2.attributes.outcome, f2.attributes.reverted_by_round], ['failed', null]);
  assert.equal(ent(Lid('finding', 'lane/3')), undefined, 'a rollback round is not a finding of its own: it marks the repair it reverted');
  const r1 = ent(Lid('repair', 'lane/1'));
  assert.deepEqual([r1.attributes.commit, r1.attributes.test, r1.attributes.reverted_by_round], [C('1'), FILE, 3]);
  assert.equal(ent(Lid('repair', 'lane/2')), undefined, 'nothing landed in round 2: no repair');
  const rel = (type, from, to) => facts.some(x => x.type === type && x.from === from && x.to === to);
  assert.ok(rel('introduced-because-of', Lid('repair', 'lane/1'), Lid('finding', 'lane/1')));
  assert.ok(rel('verified-by', Lid('repair', 'lane/1'), fileId(FILE)));
  assert.ok(rel('derived-from', Lid('reproduction', 'lane/1'), Lid('finding', 'lane/1')));
  assert.ok(facts.every(x => /^status\/work#sha256:/.test(x.ref)), 'every fact cites the work-ledger entry it comes from');
});

test('lane learning: through the graph, learningReuse on the file shows the lane\'s rounds there -- the landed-then-reverted repair and the failed round', t => {
  const w = laneLedger(t);
  const g = d1Graph({work: w, lessons: false, only: [LANE_LEARNING_SOURCE]});
  const reuse = learningReuse(g.graph.view(), {component: FILE});
  const lane = reuse.established.findings.filter(f => f.lane);
  assert.deepEqual(lane.map(f => [f.lane.lane_round, f.lane.outcome, f.lane.reverted_by_round]).sort(), [[1, 'landed', 3], [2, 'failed', null]]);
  const one = lane.find(f => f.lane.lane_round === 1);
  assert.deepEqual(one.repairs.map(r => [r.commit, r.test]), [[C('1'), FILE]]);
  assert.ok(one.sources.every(s => s.source === LANE_LEARNING_SOURCE), 'labelled as the lane\'s own learning');
  assert.ok(reuse.sources.includes(LANE_LEARNING_SOURCE));
});
