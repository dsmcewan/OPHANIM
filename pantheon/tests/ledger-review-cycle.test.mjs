// Review every cycle: cycle, review, finding, resolution and close entries, with scripted reviewers.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {openPantheonLedger, CONTROLLER} from '../src/ledger/system.mjs';
import {reviewCycle, reviewSeats} from '../src/ledger/review-cycle.mjs';
import {parseReview, reviewPrompt, CLOSE, FINDING} from '../src/ledger/cycle-kinds.mjs';
import {seatKeyId} from '../src/ledger/lineage-kinds.mjs';

const C = n => String(n).repeat(40).slice(0, 40);              // a commit id
const BASE = C('a'), HEAD = C('b'), FIX = C('c'), NEXT = C('d');
const DIFF = 'diff --git a/src/x.mjs b/src/x.mjs\n--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 2;\n';
const change = (over = {}) => ({scope: 'ophanim', base: BASE, head: HEAD, diff: DIFF, files: ['src/x.mjs'], author_labs: ['anthropic'], ...over});
const answer = (verdict, findings = []) => '```json\n' + JSON.stringify({verdict, findings}) + '\n```';
const APPROVE = answer('approve');
const PROMPT = reviewPrompt({base: BASE, head: HEAD, files: ['src/x.mjs'], diff: DIFF});

/** A scripted reviewer per vendor: {vendor: reply | {text, served_model}}. */
const scripted = (replies = {}) => {
  let n = 0;
  return async ({vendor, model}) => {
    const r = replies[vendor] ?? APPROVE;
    const o = typeof r === 'string' ? {text: r} : r;
    return {text: o.text, response_id: `resp_${vendor}_${++n}`, served_model: o.served_model ?? model};
  };
};

async function withLedger(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-review-cycle-'));
  try {
    const sys = openPantheonLedger({root: path.join(dir, 'ledger')});
    return await fn(sys, sys.recorder());
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
const ctl = sys => ({author: {key_id: CONTROLLER}, signer: sys.controller, order: sys.controller});

test('three reviewers on three labs are recorded, each citing the cycle, and the cycle closes verified', () => withLedger(async (sys, rec) => {
  const r = await reviewCycle({ledger: rec, change: change(), turn: scripted()});
  assert.equal(r.complete, true, JSON.stringify(r.failed));
  assert.deepEqual(r.reviews.map(x => x.lab).sort(), ['google', 'openai', 'xai'], 'the Anthropic-authored change is reviewed by the three other labs');
  const L = sys.ledger, byHash = new Map(L.read().map(e => [L.hashOf(e), e]));
  for (const x of r.reviews) {
    const e = byHash.get(x.review);
    assert.equal(e.kind, 'review');
    assert.ok(e.derived_from.includes(r.cycle), 'the review cites the cycle');
    assert.equal(e.author.key_id, byHash.get(x.turn).author.key_id, 'signed by the seat whose turn answered');
    assert.equal(L.payloadOf(byHash.get(x.turn)).prompt_sha, L.payloadOf(byHash.get(r.cycle)).prompt_sha, 'each reviewer was given the cycle\'s prompt');
  }
  const closed = rec.closeCycle(r.cycle);
  assert.equal(closed.outcome, 'verified');
  assert.deepEqual(closed.findings, {total: 0, fixed: 0, deferred: 0, unreproduced: 0});
  assert.equal(L.verify().ok, true);

  // The next cycle starts where this one ended; the default base is the previous head.
  const next = await reviewCycle({ledger: rec, change: change({base: undefined, head: NEXT}), turn: scripted()});
  assert.equal(next.base, HEAD);
  // No cycle opens while the previous one is open, and none skips a range.
  assert.throws(() => rec.openCycle({scope: 'ophanim', base: NEXT, head: C('e'), diff: DIFF, files: [], prompt: 'p'}), /previous cycle of this scope is not closed/);
  rec.closeCycle(next.cycle);
  assert.throws(() => rec.openCycle({scope: 'ophanim', base: C('e'), head: C('f'), diff: DIFF, files: [], prompt: 'p'}), /a range would go unreviewed/);
  assert.equal(L.verify().ok, true);
}));

test('a same-lab reviewer is refused: before the turn, by the served model, by a second review, and through the author lineage', () => withLedger(async (sys, rec) => {
  await assert.rejects(reviewCycle({ledger: rec, change: change(), turn: scripted(),
    seats: [{vendor: 'xai', model: 'grok-4.7'}, {vendor: 'xai', model: 'grok-4.6'}, {vendor: 'openai', model: 'gpt-6-sol'}]}), /share a lab/);
  await assert.rejects(reviewCycle({ledger: rec, change: change(), turn: scripted(), seats: [{vendor: 'anthropic', model: 'claude-sonnet-5'}]}), /authored the change/);

  // The agy seat asked for Gemini but was served a Claude model: the ledger judges the lab that answered.
  const r = await reviewCycle({ledger: rec, change: change(), turn: scripted({agy_google: {text: APPROVE, served_model: 'claude-sonnet-4-6'}})});
  assert.equal(r.reviews.length, 2);
  assert.match(r.failed[0].why, /anthropic lab authored the change under review/);
  assert.throws(() => rec.closeCycle(r.cycle), /2 of 3 reviews are recorded/);

  // A second review from a lab that already reviewed this cycle.
  const xai = r.reviews.find(x => x.lab === 'xai');
  const seat = {seat_id: 'xai-cycle-review@grok-4.6', vendor: 'xai', mode: 'cycle-review', occupancy_gen: 1};
  assert.ok(xai);
  const t = rec.recordTurn({seat, requested_model: 'grok-4.6', response_id: 'resp_x2', reply: APPROVE, prompt: PROMPT, cites: [r.cycle]});
  assert.throws(() => rec.recordReview({seat, model: 'grok-4.6', response_id: 'resp_x2', verdict: 'approve', targets: [r.cycle], turn: t}),
    /the xai lab has already reviewed this cycle/);
  // A review whose answering turn was given another prompt (not the cycle's change and brief).
  const other = {seat_id: 'openai-cycle-review@gpt-6-luna', vendor: 'openai', mode: 'cycle-review', occupancy_gen: 1};
  const t2 = rec.recordTurn({seat: other, requested_model: 'gpt-6-luna', response_id: 'resp_o2', reply: APPROVE, prompt: 'a different change', cites: [r.cycle]});
  assert.throws(() => rec.recordReview({seat: other, model: 'gpt-6-luna', response_id: 'resp_o2', verdict: 'approve', targets: [r.cycle], turn: t2}),
    /was not given the cycle's change and brief/);
  assert.equal(sys.ledger.verify().ok, true);
}));

test('cold review applies through the cycle: a lab with a turn in the author lineage may not review', () => withLedger(async (sys, rec) => {
  const author = rec.recordTurn({seat: {seat_id: 'openai-work@gpt-6-sol', vendor: 'openai', mode: 'work', occupancy_gen: 1},
    requested_model: 'gpt-6-sol', response_id: 'resp_author', reply: 'the change'});
  const r = await reviewCycle({ledger: rec, change: change({author_labs: [], author_turns: [author]}), turn: scripted(),
    seats: [{vendor: 'xai', model: 'grok-4.7'}, {vendor: 'openai', model: 'gpt-6-luna'}, {vendor: 'agy_google', model: 'gemini-3.6-flash'}]});
  assert.deepEqual(r.reviews.map(x => x.lab).sort(), ['google', 'xai']);
  assert.match(r.failed[0].why, /openai lab is in the lineage/);
}));

test('a finding without a reproduction keeps the cycle from closing as verified', () => withLedger(async (sys, rec) => {
  const r = await reviewCycle({ledger: rec, change: change(), turn: scripted({
    xai: answer('request_changes', [{severity: 'major', file: 'src/x.mjs', line: 1, claim: 'x changed without a test', reproduction: null}]),
  })});
  const f = r.reviews.find(x => x.lab === 'xai').findings[0];
  assert.equal(f.reproduction, null, 'recorded as unreproduced');
  assert.throws(() => rec.closeCycle(r.cycle), /neither fixed nor deferred/);
  rec.deferFinding({finding: f.hash, reason: 'the reviewer gave no reproduction; tracked for the next cycle'});
  // The controller may not claim verified.
  const forged = {outcome: 'verified', reviews: r.reviews.map(x => x.review).sort(), labs: ['google', 'openai', 'xai'],
    findings: {total: 1, fixed: 0, deferred: 1, unreproduced: 0}};
  assert.throws(() => sys.ledger.append({kind: CLOSE, payload: forged, derivedFrom: [r.cycle], ...ctl(sys)}), /without a reproduction keeps the cycle from closing as verified/);
  const closed = rec.closeCycle(r.cycle);
  assert.equal(closed.outcome, 'unverified');
  assert.deepEqual(closed.findings, {total: 1, fixed: 0, deferred: 1, unreproduced: 1});

  // An unparseable reply fails closed: one blocking finding with no reproduction.
  assert.deepEqual(parseReview('looks fine to me').findings.map(x => [x.severity, x.reproduction]), [['block', null]]);
}));

test('a fixed finding with fail-before and pass-after evidence lets the cycle close verified', () => withLedger(async (sys, rec) => {
  const r = await reviewCycle({ledger: rec, change: change(), turn: scripted({
    openai: answer('request_changes', [{severity: 'block', file: 'src/x.mjs', line: 1, claim: 'x must stay 1', reproduction: {kind: 'test', run: 'node --test tests/x.test.mjs'}}]),
  })});
  const f = r.reviews.find(x => x.lab === 'openai').findings[0].hash;
  const test = 'node --test tests/x.test.mjs';
  assert.throws(() => rec.fixFinding({finding: f, commit: FIX, test, before: {commit: HEAD, exit: 0}, after: {commit: FIX, exit: 0}}), /did not fail before the fix/);
  assert.throws(() => rec.fixFinding({finding: f, commit: FIX, test, before: {commit: BASE, exit: 1}, after: {commit: FIX, exit: 0}}), /failing on the reviewed head/);
  assert.throws(() => rec.fixFinding({finding: f, commit: FIX, test, before: {commit: HEAD, exit: 1}, after: {commit: FIX, exit: 1}}), /did not pass after the fix/);
  assert.throws(() => rec.fixFinding({finding: f, commit: HEAD, test, before: {commit: HEAD, exit: 1}, after: {commit: HEAD, exit: 0}}), /commit after the reviewed change/);
  rec.fixFinding({finding: f, commit: FIX, test, before: {commit: HEAD, exit: 1}, after: {commit: FIX, exit: 0}});
  assert.throws(() => rec.deferFinding({finding: f, reason: 'changed my mind'}), /already resolved/);
  const closed = rec.closeCycle(r.cycle);
  assert.equal(closed.outcome, 'verified');
  assert.deepEqual(closed.findings, {total: 1, fixed: 1, deferred: 0, unreproduced: 0});
  assert.equal(sys.ledger.verify().ok, true);
}));

test('a forged close, an invented or omitted finding, and a late entry are refused', () => withLedger(async (sys, rec) => {
  const reported = [{severity: 'minor', file: 'src/x.mjs', line: null, claim: 'one', reproduction: 'npm test'},
    {severity: 'note', file: null, line: null, claim: 'two', reproduction: 'npm test'}];
  const r = await reviewCycle({ledger: rec, change: change(), turn: scripted({xai: answer('request_changes', reported)})});
  const xai = r.reviews.find(x => x.lab === 'xai');
  // An invented finding, and a reworded one, do not re-derive from the reviewer's signed reply.
  assert.throws(() => rec.recordFinding({review: xai.review, index: 2, finding: {...reported[0], claim: 'three'}}), /not the one the reviewer's reply reports/);
  assert.throws(() => sys.ledger.append({kind: FINDING, payload: {index: 0, severity: 'minor', file: 'src/x.mjs', line: null, claim: 'reworded', reproduction: {kind: 'command', run: 'npm test'}},
    derivedFrom: [xai.review], ...ctl(sys)}), /not the one the reviewer's reply reports/);
  assert.throws(() => rec.recordFinding({review: xai.review, index: 0, finding: reported[0]}), /already recorded/);
  for (const f of xai.findings) rec.deferFinding({finding: f.hash, reason: 'out of scope for this cycle'});

  const claim = {outcome: 'verified', reviews: r.reviews.map(x => x.review).sort(), labs: ['google', 'openai', 'xai'], findings: {total: 2, fixed: 0, deferred: 2, unreproduced: 0}};
  // Tampered counts, a dropped review, a close by a seat key, a close citing more than its cycle.
  assert.throws(() => sys.ledger.append({kind: CLOSE, payload: {...claim, findings: {...claim.findings, fixed: 2, deferred: 0}}, derivedFrom: [r.cycle], ...ctl(sys)}), /not the one the cycle's entries derive/);
  assert.throws(() => sys.ledger.append({kind: CLOSE, payload: {...claim, reviews: claim.reviews.slice(1)}, derivedFrom: [r.cycle], ...ctl(sys)}), /not the one the cycle's entries derive/);
  assert.throws(() => sys.ledger.append({kind: CLOSE, payload: claim, derivedFrom: [r.cycle, xai.review], ...ctl(sys)}), /cites exactly its cycle/);
  const seat = {seat_id: 'xai-cycle-review@grok-4.7', vendor: 'xai', mode: 'cycle-review', occupancy_gen: 1};
  const seatKey = sys.keys.get(seatKeyId(seat));
  assert.ok(seatKey, 'the seat key is held');
  assert.throws(() => sys.ledger.append({kind: CLOSE, payload: claim, derivedFrom: [r.cycle], author: {key_id: seatKey.key_id}, signer: seatKey, order: sys.controller}), /may not author "cycle.close"/);
  sys.ledger.append({kind: CLOSE, payload: claim, derivedFrom: [r.cycle], ...ctl(sys)});
  assert.throws(() => rec.closeCycle(r.cycle), /already closed/);
  // Nothing is added to a closed cycle.
  const late = {seat_id: 'openai-cycle-review@gpt-6-luna', vendor: 'openai', mode: 'cycle-review', occupancy_gen: 1};
  const t = rec.recordTurn({seat: late, requested_model: 'gpt-6-luna', response_id: 'resp_late', reply: APPROVE, prompt: PROMPT, cites: [r.cycle]});
  assert.throws(() => rec.recordReview({seat: late, model: 'gpt-6-luna', response_id: 'resp_late', verdict: 'approve', targets: [r.cycle], turn: t}), /the cycle is closed/);
  assert.throws(() => rec.deferFinding({finding: xai.findings[0].hash, reason: 'again'}), /cycle is closed/);
  assert.equal(sys.ledger.verify().ok, true);
}));

test('an omitted finding keeps the cycle open', () => withLedger(async (sys, rec) => {
  const turn = scripted({xai: answer('request_changes', [{severity: 'minor', file: 'src/x.mjs', line: 1, claim: 'one', reproduction: 'npm test'}])});
  // A recorder that drops every finding: the reviews stand, the findings are missing.
  const dropping = {...rec, recordFinding: () => null};
  const r = await reviewCycle({ledger: dropping, change: change(), turn});
  assert.throws(() => rec.closeCycle(r.cycle), /reported 1 finding\(s\) and 0 are recorded/);
}));

test('seating offers three labs other than the author\'s, and refuses when there are not enough', () => {
  assert.deepEqual(reviewSeats({avoidLabs: ['anthropic']}).map(s => s.lab), ['xai', 'google', 'openai']);
  assert.throws(() => reviewSeats({n: 4, avoidLabs: ['anthropic']}), /3 lab\(s\) left/);
});

test('the CLI runs the review at a cycle boundary: review, fix, close, and the next cycle starts at the last head', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pantheon-review-cycle-cli-'));
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], {encoding: 'utf8'}).trim();
    git('init', '-q');
    const commitFile = (body, msg) => { fs.writeFileSync(path.join(repo, 'x.mjs'), body); git('add', 'x.mjs'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
    const base = commitFile('export const x = 1;\n', 'base');
    const head = commitFile('export const x = 2;\n', 'change');
    const cli = path.join(import.meta.dirname, '..', 'bin', 'pantheon-review-cycle.mjs');
    const turn = path.join(import.meta.dirname, 'fixtures', 'review-cycle-turn.mjs');
    const ledger = path.join(dir, 'ledger');
    const run = (...a) => {
      const env = {...process.env};
      delete env.PANTHEON_CYCLE_LEDGER_ANCHOR;
      const r = spawnSync(process.execPath, [cli, ...a, '--repo', repo, '--ledger', ledger], {encoding: 'utf8', env});
      return {code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr};
    };
    const r = run('review', '--base', base, '--turn', turn);
    assert.equal(r.code, 0, r.err + JSON.stringify(r.out));
    assert.deepEqual(r.out.reviews.map(x => x.lab).sort(), ['google', 'openai', 'xai']);
    assert.equal(r.out.head, head);
    const [f] = r.out.findings;
    assert.equal(f.file, 'x.mjs');
    assert.equal(run('close').code, 1, 'an unresolved finding keeps the cycle open');
    const fix = commitFile('export const x = 1;\n', 'fix');
    const fixed = run('fix', '--finding', f.finding, '--commit', fix, '--test', 'node --test', '--before-exit', '1', '--after-exit', '0');
    assert.equal(fixed.code, 0, JSON.stringify(fixed.out));
    const closed = run('close');
    assert.equal(closed.code, 0, JSON.stringify(closed.out));
    assert.equal(closed.out.outcome, 'verified');
    // The next cycle defaults its base to where this one ended, and is not skippable.
    const next = run('review', '--turn', turn);
    assert.deepEqual([next.out.base, next.out.head], [head, fix]);
    commitFile('export const x = 3;\n', 'more');
    const blocked = run('review', '--turn', turn);
    assert.equal(blocked.code, 1);
    assert.match(blocked.out.refused, /previous cycle of this scope is not closed/);
    assert.equal(run('status').out.verified, true);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
