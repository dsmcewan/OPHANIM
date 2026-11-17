// Regression tests for the four defects reproduced at 22cbbb8 (owner review of PR #67):
//   1. file retrieval and the dossier followed symlinks out of the repository;
//   2. the requirement and its history shared one source, so a partial history counted as fully delivered;
//   3. a cut source (status history, a stage record, a one-line file) had no way to continue;
//   4. grep could exceed result_bytes, investigate could exceed total_bytes, and bytes were counted as characters.
// Each fails on 22cbbb8. Seats are scripted: these show delivery and accounting, not model judgment.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {makeExecutors, causeOf} from './stages.mjs';
import {buildDossier, renderDossier, makeRetriever, investigate, deliveryOf} from './context.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {git, fixture, APPROVE, json, planFor, scriptedTurn, LIMITS, stagesOf} from './test-fixtures.mjs';

const bytes = s => Buffer.byteLength(s ?? '', 'utf8');
const commit = (repo, files, msg) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), {recursive: true}); fs.writeFileSync(path.join(repo, f), c); } git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', msg); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-bounds-'));
/** Follow a result's continuation until there is none; returns the text and a log shaped like investigate's. */
function follow(R, first, max = 200) {
  const requests = [];
  let req = first, text = '';
  for (let i = 0; i < max && req; i++) {
    const r = R.run(req);
    requests.push({request: req, ok: r.ok, source: r.source, version: r.version, coverage: r.coverage});
    if (!r.ok) break;
    text += r.text;
    req = r.coverage?.next ? {...req, ...r.coverage.next} : null;
  }
  return {text, log: {requests}, ended: req === null};
}
/** An item whose status history is far longer than the initial view, with one decisive entry in the middle. */
function longHistory(f, item, {entries = 60, decisiveAt = 25} = {}) {
  for (let i = 0; i < entries; i++) {
    const note = i === decisiveAt ? 'DECISIVE: attempt 7 set ok = true and the importer failed because it needs ok frozen; reverted. ' : `routine note ${i}. `;
    f.S.set({item, title: `Alpha for ${item}`, state: i % 2 ? 'Ready' : 'In progress', checked: '2026-11-10', basis: note + 'x'.repeat(420)});
  }
  f.S.set({item, title: `Alpha for ${item}`, state: 'Ready', checked: '2026-11-17', basis: `the requirement of ${item}: alpha.mjs exports ok = true`});
}

test('1. containment is applied to the actual target: a link out of the repository is refused by retrieval and never read into the dossier', () => {
  const repo = tmp(), outside = tmp();
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE\n');
    const f = fixture(repo, [{item: 'link-item', basis: 'alpha.mjs exports ok = true; see leak.txt'}, {item: 'link-ticket'}], {tickets: ['link-ticket']});
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'leak.txt'));
    fs.symlinkSync(outside, path.join(repo, 'linkdir'));
    const t = JSON.parse(fs.readFileSync(path.join(repo, 'tickets', 'link-ticket.json'), 'utf8'));
    fs.writeFileSync(path.join(repo, 'tickets', 'link-ticket.json'), JSON.stringify({...t, copy: [...t.copy, 'leak.txt']}));
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'links');
    const R = makeRetriever({repo, statusRoot: f.statusRoot});
    for (const p of ['leak.txt', 'linkdir/secret.txt']) {
      const r = R.run({op: 'file', path: p});
      assert.equal(r.ok, false, `${p} must not be read`);
      assert.equal(r.error, 'REFUSED');
      assert.ok(!JSON.stringify(r).includes('TOP-SECRET'));
    }
    assert.equal(R.run({op: 'file', path: 'alpha.mjs'}).ok, true, 'a file inside is still read');
    // The initial view: named by the requirement (no ticket) and by a ticket's copy list.
    for (const item of ['link-item', 'link-ticket']) {
      const d = buildDossier({repo, statusRoot: f.statusRoot, item});
      assert.ok(!renderDossier(d).includes('TOP-SECRET'), `${item}: the dossier must not contain the target's bytes`);
      assert.ok(d.omissions.some(o => /leak\.txt.*outside the repository/.test(o)), `${item}: the refusal is listed, not silent`);
    }
  } finally { fs.rmSync(repo, {recursive: true, force: true}); fs.rmSync(outside, {recursive: true, force: true}); }
});

test('2. the requirement and its history are separate evidence: a partial history stays partial, and becomes complete only when the rest is retrieved', () => {
  const repo = tmp();
  try {
    const f = fixture(repo, [{item: 'long'}]);
    longHistory(f, 'long');
    const R = makeRetriever({repo, statusRoot: f.statusRoot});
    const d = buildDossier({repo, statusRoot: f.statusRoot, item: 'long'});
    const req = d.entries.find(e => e.kind === 'authoritative-requirement'), hist = d.entries.find(e => /^Status history/.test(e.title));
    assert.equal(req.coverage.complete !== false, true);
    assert.equal(hist.coverage.complete, false);
    assert.notEqual(hist.source, req.source, 'two views of the status ledger are two sources');
    const got = deliveryOf(d);
    assert.equal(causeOf(req.source, got).cause, 'evidence-delivered');
    assert.equal(causeOf(hist.source, got).cause, 'evidence-partly-delivered', 'a complete requirement does not make the history complete');
    assert.equal(causeOf(hist.id, got).cause, 'evidence-partly-delivered', 'nor by its dossier id');
    // One more window: more is delivered, still not all of it.
    const one = R.run({...hist.coverage.next});
    assert.equal(one.ok, true);
    const some = deliveryOf(d, {requests: [{request: hist.coverage.next, ok: true, source: one.source, version: one.version, coverage: one.coverage}]});
    assert.equal(some.get(hist.source).complete, false);
    assert.ok(some.get(hist.source).portions.length >= 1 && some.get(hist.source).next, 'what was delivered and how to continue are recorded');
    // Everything retrieved: now, and only now, it is complete.
    const all = follow(R, hist.coverage.next);
    assert.equal(all.ended, true);
    assert.equal(causeOf(hist.source, deliveryOf(d, all.log)).cause, 'evidence-delivered');
    // A different version of the same source does not complete the earlier one.
    f.S.set({item: 'long', title: 'Alpha for long', state: 'In progress', checked: '2026-11-18', basis: 'a later entry'});
    const later = R.run({...hist.coverage.next});
    const mixed = deliveryOf(d, {requests: [...all.log.requests.slice(0, 1), {request: hist.coverage.next, ok: true, source: later.source, version: later.version, coverage: later.coverage}]});
    assert.equal(mixed.get(hist.source).complete, false, 'portions of two versions are not one complete delivery');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('3. every cut source can be continued: status history, a selection of it, a stage record, and a file that is one oversized line', async () => {
  const repo = tmp();
  try {
    const f = fixture(repo, [{item: 'long'}]);
    longHistory(f, 'long');
    commit(repo, {'one.txt': 'a'.repeat(50_000) + 'END-MARK'}, 'one long line');
    // A stage record with large outputs, through the real scheduler.
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, limits: {total_provider_calls: 100, stage_provider_calls: 10, iterations: 1},
      executors: {plan: async () => ({status: 'failed', outputs: {blob: 'b'.repeat(40_000) + 'TAIL-MARK'}, usage: {provider_calls: 0}, next: {stage: 'plan', why: 'fixture'}})}});
    const work = openWorkLedger({root: f.workRoot});
    const R = makeRetriever({repo, statusRoot: f.statusRoot, work});
    const d = buildDossier({repo, statusRoot: f.statusRoot, item: 'long', work});
    const hist = d.entries.find(e => /^Status history/.test(e.title));
    assert.ok(!hist.text.includes('DECISIVE'), 'the decisive entry is beyond the initial excerpt');
    assert.ok(hist.coverage.next, 'the excerpt says how to continue');
    assert.match(renderDossier(d), /next: \{"op":"status"/);
    const h = follow(R, hist.coverage.next);
    assert.ok(h.ended && h.text.includes('DECISIVE: attempt 7'), 'the rest of the history is reachable');
    // A selection: only the entries that match, without paging through the rest.
    const sel = R.run({op: 'status', item: 'long', match: 'DECISIVE'});
    assert.ok(sel.ok && sel.text.includes('DECISIVE') && !sel.text.includes('routine note 3.'));
    assert.notEqual(sel.source, hist.source, 'a selection is its own view');
    const rec = follow(R, {op: 'record', hash: work.stages('long')[0].hash});
    assert.ok(rec.ended && rec.text.includes('TAIL-MARK'), 'a large stage record is reachable to its end');
    const one = follow(R, {op: 'file', path: 'one.txt'});
    assert.ok(one.ended && one.text.endsWith('END-MARK') && one.text.length === 50_008, 'a single oversized line is reachable to its end, with nothing repeated or lost');
    assert.ok(one.log.requests.length >= 4);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('4. budgets hold before anything enters a prompt: result_bytes per result and total_bytes per investigation, counted in bytes, with cuts and what remains recorded', async () => {
  const repo = tmp();
  try {
    const f = fixture(repo, [{item: 'b-item'}]);
    commit(repo, {'wide.txt': Array.from({length: 80}, (_, i) => `needle ${i} ${'w'.repeat(1000)}`).join('\n') + '\n', 'multi.txt': 'é'.repeat(20_000),
      ...Object.fromEntries(Array.from({length: 6}, (_, i) => [`z${i}.txt`, 'z'.repeat(12_000)]))}, 'wide files');
    const R = makeRetriever({repo, statusRoot: f.statusRoot});
    const cap = R.limits.result_bytes;
    const g = R.run({op: 'grep', pattern: 'needle', path: 'wide.txt'});
    assert.ok(bytes(g.text) <= cap, `grep returned ${bytes(g.text)} bytes; the limit is ${cap}`);
    assert.equal(g.coverage.complete, false);
    assert.ok(follow(R, {op: 'grep', pattern: 'needle', path: 'wide.txt'}).text.includes('needle 79'), 'and the rest is reachable');
    const m = R.run({op: 'file', path: 'multi.txt'});
    assert.ok(bytes(m.text) <= cap, `a multi-byte file returned ${bytes(m.text)} bytes; the limit is ${cap}`);
    assert.ok(!m.text.includes('�'), 'no character is split');
    assert.equal(follow(R, {op: 'file', path: 'multi.txt'}).text, 'é'.repeat(20_000));
    for (const req of [{op: 'list'}, {op: 'log'}, {op: 'status', item: 'b-item'}, {op: 'show', commit: git(repo, 'rev-parse', 'HEAD').trim()}]) assert.ok(bytes(R.run(req).text) <= cap);
    // The whole investigation: 6 requests of 12 KB each in one round, under a 20 KB total.
    const prompts = [];
    const total = 20_000;
    const r = await investigate({prompt: 'P', retriever: R, limits: {total_bytes: total, rounds: 2},
      ask: async p => { prompts.push(p); return prompts.length === 1 ? {text: json({requests: Array.from({length: 6}, (_, i) => ({op: 'file', path: `z${i}.txt`}))})} : {text: json({verdict: 'approve', findings: []})}; }});
    // The file bodies are runs of 'z': count those, not the letter in the request text.
    const delivered = (prompts.at(-1).match(/z{100,}/g) ?? []).reduce((n, run) => n + run.length, 0);
    assert.ok(delivered <= total, `${delivered} bytes of results entered the prompt; the total is ${total}`);
    assert.ok(r.log.bytes <= total && r.log.bytes === delivered, 'the log counts what was delivered');
    const cut = r.log.requests.filter(q => q.ok && q.coverage.complete === false), notRun = r.log.requests.filter(q => !q.ok);
    assert.ok(cut.length >= 1 && cut.every(q => q.coverage.next), 'a result cut by the total says how to continue');
    assert.ok(notRun.length >= 1 && notRun.every(q => q.error === 'OVER_TOTAL_BUDGET'), 'requests that did not fit are recorded as not run');
    assert.match(prompts.at(-1), /NOT RUN: the .*retrieval budget/);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('decisive history beyond the initial excerpt is retrieved and changes the diagnosis, and the partly delivered history stays partial in the self-evaluation (no ticket, and an existing ticket)', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    const f = fixture(repo, [{item: 'deep'}, {item: 'deep-ticket'}], {tickets: ['deep-ticket']});
    for (const item of ['deep', 'deep-ticket']) longHistory(f, item);
    const seen = {};
    const histOf = prompt => /### \[(S\d+)\] Status history[^\n]*\nkind: [^|]+\| source: (\S+) \|[^\n]*next: (\{[^\n]*\})/.exec(prompt);
    const turn = scriptedTurn({
      planner: ({prompt, item}) => { (seen[item] ??= []).push(prompt);
        const h = histOf(prompt);
        // It asks for the continuation the dossier offers, once; it does not page through the rest.
        if (!/DECISIVE/.test(prompt) && h && !/## Retrieved/.test(prompt)) return json({requests: [JSON.parse(h[3])]});
        const base = planFor(prompt);
        return json(/DECISIVE: attempt 7/.test(prompt) ? planFor(prompt, {
          problem: {statement: 'alpha.mjs exports ok = false; an earlier direct change to ok = true was reverted.', justification: 'The status history records attempt 7 failing the importer, which needs ok frozen.', mechanism: 'ok must be exported frozen'},
          evidence: [...base.evidence, {ref: h[2], why: 'attempt 7 and its revert'}],
          investigation: {...base.investigation, historical_cause: {examined: true, finding: 'attempt 7 was reverted: the importer needs ok frozen', sources: [h[2]]}},
          context: {sufficient: true, gaps: ['the status history after the second window was not read'], uncertainty: ['a later entry could change this']}}) : base); },
      // A reviewer whose finding rests on the history.
      'plan-review': ({vendor, prompt}) => (vendor === 'xai'
        ? json({verdict: 'request_changes', findings: [{severity: 'major', file: null, line: null, claim: `[source: ${histOf(prompt)[2]}] the plan does not say whether a later entry reversed attempt 7's conclusion`, reproduction: null}]}) : APPROVE),
    });
    const ex = {plan: makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir}).plan};
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    // Four configured labs: the revision that would answer xai's finding waits on review capacity (unchanged rule).
    assert.deepEqual(stagesOf(r), ['plan:pending', 'plan:pending']);
    for (const item of ['deep', 'deep-ticket']) {
      const p = openWorkLedger({root: f.workRoot}).stages(item)[0];
      assert.ok(!/DECISIVE/.test(seen[item][0]), 'not in the initial view');
      assert.match(seen[item][1], /## Retrieved \(round 1\)[\s\S]*DECISIVE: attempt 7/, 'retrieved through the offered continuation');
      assert.equal(p.outputs.plan.problem.mechanism, 'ok must be exported frozen', 'the diagnosis changed');
      assert.equal(p.outputs.plan.mode, item === 'deep-ticket' ? 'revalidate' : 'author');
      // Self-evaluation: the history reached the planner only in part, and the record says so everywhere it is used.
      const cited = p.outputs.plan.evidence.find(e => /^status:/.test(e.ref ?? ''));
      assert.equal(cited.complete, false);
      assert.equal(cited.via, 'supplied+retrieved');
      assert.ok(cited.portions.length >= 1);
      assert.equal(p.findings[0].cause, 'evidence-partly-delivered');
      const gap = p.outputs.context.unresolved.find(u => u.source === cited.source);
      assert.ok(gap && gap.next, 'the undelivered remainder is an unresolved gap with its continuation');
      assert.match(p.blocker.what, /^REVIEW_CAPACITY_PENDING/);
    }
  });
});
