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
    const mixed = deliveryOf(d, {requests: [all.log.requests[0], {request: hist.coverage.next, ok: true, source: later.source, version: later.version, coverage: later.coverage}]});
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
    // The LAB rule, pinned: this test's expected plan pending is the lab rule's capacity (fit defaults to the model rule).
    const ex = {plan: makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir, independence: 'lab'}).plan};
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

// ---- Gaps found on a recheck of c4c40c2 (each fails there) ---------------------------------------------------------
test('recheck: ignored files and git internals are never evidence (keys, .env, .git); an untracked, unignored working file still is', () => {
  const repo = tmp();
  try {
    const f = fixture(repo, [{item: 'sec'}]);
    fs.appendFileSync(path.join(repo, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(repo, '.env'), 'API_KEY=sk-live-123\n');
    fs.writeFileSync(path.join(repo, 'draft.md'), 'a working note\n');
    const R = makeRetriever({repo, statusRoot: f.statusRoot});
    const key = `status/ledger/keys/${fs.readdirSync(path.join(repo, 'status/ledger/keys'))[0]}`;
    for (const p of [key, '.env', '.git/config', '.git/HEAD']) {
      const r = R.run({op: 'file', path: p});
      assert.equal(r.ok, false, `${p} must not be read`);
      assert.equal(r.error, 'REFUSED');
      assert.ok(!/PRIVATE|sk-live|repositoryformat/.test(JSON.stringify(r)));
    }
    assert.equal(R.run({op: 'file', path: 'draft.md'}).ok, true);
    assert.equal(R.run({op: 'file', path: 'alpha.mjs'}).ok, true);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('recheck: a view\'s version identifies its body, a window always makes progress or is refused, and offsets are validated', async () => {
  const repo = tmp();
  try {
    const f = fixture(repo, [{item: 'v-item'}]);
    commit(repo, {'multi.txt': 'é'.repeat(20_000), 'lines.txt': Array.from({length: 3000}, (_, i) => `line ${i + 1}`).join('\n')}, 'files');
    const R = makeRetriever({repo, statusRoot: f.statusRoot});
    // The working tree changes under the same HEAD: the search result is another body, so another version.
    const g1 = R.run({op: 'grep', pattern: 'ok', path: 'alpha.mjs'});
    fs.appendFileSync(path.join(repo, 'alpha.mjs'), '// ok, changed\n');
    const g2 = R.run({op: 'grep', pattern: 'ok', path: 'alpha.mjs'});
    assert.notEqual(g1.version, g2.version);
    const halves = deliveryOf(null, {requests: [{ok: true, request: {op: 'grep'}, source: g1.source, version: g1.version, coverage: {...g1.coverage, to: 5, complete: false}},
      {ok: true, request: {op: 'grep'}, source: g2.source, version: g2.version, coverage: {...g2.coverage, from: 5, complete: false}}]});
    assert.equal(halves.get(g1.source).complete, false, 'halves of two bodies are not one complete delivery');
    // A cap smaller than one character delivers nothing: that is a refusal, not an empty "delivered" result.
    const tiny = R.run({op: 'file', path: 'multi.txt'}, {cap: 1});
    assert.equal(tiny.ok, false);
    assert.equal(tiny.error, 'CAP_TOO_SMALL');
    const prompts = [];
    const r = await investigate({prompt: 'P', retriever: R, limits: {total_bytes: 16_001, rounds: 2},
      ask: async p => { prompts.push(p); return prompts.length === 1 ? {text: json({requests: [{op: 'file', path: 'lines.txt'}, {op: 'file', path: 'multi.txt'}]})} : {text: json({verdict: 'approve', findings: []})}; }});
    assert.ok(!r.log.requests.some(q => q.ok && q.bytes === 0), 'no request is recorded as delivered with zero bytes');
    assert.equal(r.log.requests[1].ok, false);
    // Offsets: a numeric string is honoured; nonsense and past-the-end are errors the model can see.
    assert.equal(R.run({op: 'file', path: 'lines.txt', offset: '500'}).coverage.from, 500);
    assert.equal(R.run({op: 'file', path: 'lines.txt', offset: 'abc'}).error, 'BAD_REQUEST');
    assert.equal(R.run({op: 'file', path: 'lines.txt', offset: -3}).error, 'BAD_REQUEST');
    const past = R.run({op: 'file', path: 'lines.txt', offset: 10 ** 9});
    assert.equal(past.error, 'OUT_OF_RANGE');
    assert.match(past.why, /28892 bytes/);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

test('recheck: the gap\'s continuation starts at the first undelivered byte; the initial view is bounded as a whole and keeps the most recent history', () => {
  const repo = tmp();
  try {
    const f = fixture(repo, [{item: 'g-item', basis: 'alpha.mjs exports ok = true; see index.mjs'}]);
    commit(repo, {'big.mjs': `import {ok} from './alpha.mjs';\n${'// filler line\n'.repeat(900)}// end\n`, 'index.mjs': 'export {};\n',
      ...Object.fromEntries(Array.from({length: 400}, (_, i) => [`many/user${i}-with-a-long-descriptive-name.mjs`, 'import \'../index.mjs\';\nimport \'../alpha.mjs\';\n']))}, 'files');
    longHistory(f, 'g-item');
    const R = makeRetriever({repo, statusRoot: f.statusRoot});
    const issues = Array.from({length: 30}, (_, i) => ({number: i + 1, title: 't', state: 'open', labels: [], body: `${'y'.repeat(5000)}\n<!-- ophanim:item=g-item -->`}));
    const d = buildDossier({repo, statusRoot: f.statusRoot, item: 'g-item', issues});
    // The whole initial view is bounded, and what did not fit is listed with the request that retrieves it.
    const shown = d.entries.reduce((n, e) => n + bytes(e.text), 0);
    assert.ok(shown <= R.limits.dossier_bytes, `the initial view carries ${shown} bytes of evidence; its budget is ${R.limits.dossier_bytes}`);
    assert.ok(d.omissions.some(o => /issue.*NOT shown.*\{"op":"issue","number":\d+\}/.test(o)), 'an issue that did not fit is listed with its request');
    // The history excerpt keeps the most recent entries; the earlier ones are the gap, from byte 0.
    const hist = d.entries.find(e => /^Status history/.test(e.title));
    assert.ok(hist.text.includes('the requirement of g-item: alpha.mjs exports ok = true'), 'the newest entry is in the initial view');
    assert.ok(!hist.text.includes('routine note 0.'));
    assert.equal(hist.coverage.next.offset, 0);
    assert.ok(hist.text.startsWith('{"entry"'), 'the excerpt starts on a whole row');
    // The continuation of a gap is computed from what was delivered, not remembered from the first cut.
    const big = d.entries.find(e => e.source === 'file:big.mjs');
    const first = big.coverage.to;
    const range = R.run({op: 'file', path: 'big.mjs', start: 890, lines: 5});
    const step = R.run({op: 'file', path: 'big.mjs', offset: first}, {cap: 2000});
    const log = rs => ({requests: rs.map(([request, r]) => ({request, ok: true, source: r.source, version: r.version, coverage: r.coverage}))});
    assert.equal(deliveryOf(d, log([[{op: 'file', path: 'big.mjs', start: 890, lines: 5}, range]])).get('file:big.mjs').next.offset, first);
    assert.deepEqual(deliveryOf(d, log([[{op: 'file', path: 'big.mjs', offset: first}, step]])).get('file:big.mjs').next, {op: 'file', path: 'big.mjs', offset: first + 2000});
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});
