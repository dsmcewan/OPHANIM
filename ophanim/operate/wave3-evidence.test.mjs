// Wave 3 (sub-wave 3B-1), register L-504, INVARIANT 1: a version equals the delivered bytes, across every retriever op.
//
// THE CLASS (context.mjs makeRetriever OPS, each a view whose body a result is a byte window of): file, list, grep, log,
// show, status, work, record, issue, output, dossier -- with their selections (a grep or log with no result, a status
// `match`, another item's work view, a show of a path). For each, the version the retriever records (the result header the
// seat is shown, the per-round log's `version` and `sha256`, the citation the stage binds) must identify exactly the bytes
// delivered (context.mjs, THE VERSION CONTRACT), so that the re-check the lifecycle makes before reusing a stage
// (reconcile.mjs -> gates.mjs evidenceCheck, through planValidity and validationEvidence) flags a later change of what the
// same request would deliver, and only that.
//
// Every row goes through the production path: a real git repository and status and work ledgers (test-fixtures.mjs), the
// real plan stage (stages.mjs, scripted seats only at the provider edge) driven by the scheduler's `tick`, whose planner
// asks for the view through `investigate` and cites it; the record the stage binds; and `reconcile`'s gate. Then the
// state is changed twice: once so the same request delivers the SAME bytes (the plan must stay reusable), once so it
// delivers OTHER bytes (the plan must be stale, naming that source). A row whose bytes no state change can alter (an
// immutable record, a blob) asserts the contract only. No provider is called.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {makeRetriever, investigate} from './context.mjs';
import {evidenceCheck} from './gates.mjs';
import {reconcile} from './reconcile.mjs';
import {tickWithPrimary as tick} from './test-fixtures.mjs';   // every tick declares primary Gemini execution: the fit implementer is an SDK session
import {openWorkLedger} from './work-ledger.mjs';
import {makeExecutors} from './stages.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, planFor, json, git, LIMITS, SIX, ACCEPT, stagesOf} from './test-fixtures.mjs';

const L504 = 'L-504 invariant 1';
const sha = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
const RETRIEVED = '\n\n## Retrieved (round 1)\n';
/** What a seat was given in its first retrieval round, read from the prompt it was asked next: the header and the bytes. */
function deliveredIn(prompt) {
  const at = prompt.lastIndexOf(RETRIEVED);
  assert.ok(at > 0, 'the seat was given a retrieval round');
  const lines = prompt.slice(at + RETRIEVED.length).split('\n');
  const m = /^source: (.*) \| version: (\S+) \| coverage: (.*)$/.exec(lines[1] ?? '');
  assert.ok(m, `a delivered result, not a failure: ${lines.slice(0, 2).join(' / ')}`);
  return {source: m[1], version: m[2], coverage: m[3], text: lines.slice(2).join('\n')};
}
const write = (repo, p, text) => { fs.mkdirSync(path.dirname(path.join(repo, p)), {recursive: true}); fs.writeFileSync(path.join(repo, p), text); };
const commit = (repo, msg, ...paths) => { git(repo, 'add', ...paths); git(repo, 'commit', '-qm', msg); };
// A structural block of the item `other` (it waits on its owner): a stage record of another item, made through tick.
const waits = async () => ({status: 'blocked', outputs: {waits: true}, team: [], contributions: [], findings: [], usage: {provider_calls: 0},
  next: {stage: 'plan', why: 'waits on the owner'}, blocker: {code: 'OWNER_INPUT', what: 'waits on the owner', role: 'decision-authority', resume_when: 'the owner records a new status entry'}});
const recordOther = async c => tick({repo: c.repo, statusRoot: c.f.statusRoot, workRoot: c.f.workRoot, executors: {plan: waits}, limits: LIMITS, only: 'other'});
// The owner records `item` Ready again: the same title, the given basis (default: unchanged) and checked date.
const reReady = (c, item, {basis = null, checked = '2026-11-19'} = {}) => {
  const s = c.f.S.board().items.find(i => i.item === item);
  c.f.S.set({item, title: s.title, basis: basis ?? s.basis, state: 'Ready', checked});
};

/**
 * THE ROWS: one per op and selection of the class.
 *   req(c)      the request the planner makes (c: {repo, f, issues, head, n})
 *   contract    'body': version = sha256(the delivered body); 'raw': version = sha256(the file's raw bytes)
 *   raw(c)      for 'raw': the raw bytes at retrieval
 *   same(c)     a change after which the same request delivers the same bytes -- the plan stays reusable
 *   moved(c)    a change after which it delivers other bytes -- the plan is stale, naming the source (null: no state change
 *               can alter these bytes); `policy` names a view the gate does not judge by design, asserted as such
 */
const ROWS = [
  {op: 'file', name: 'file: the bytes change', req: () => ({op: 'file', path: 'notes.md'}), contract: 'raw', raw: c => fs.readFileSync(path.join(c.repo, 'notes.md')),
    same: c => { write(c.repo, 'docs/other.md', 'unrelated, changed\n'); commit(c.repo, 'another file', 'docs/other.md'); fs.utimesSync(path.join(c.repo, 'notes.md'), new Date(), new Date(Date.now() + 5000)); },
    moved: c => fs.appendFileSync(path.join(c.repo, 'notes.md'), 'a third line\n')},
  {op: 'file', name: 'file: the same bytes, now excluded by .gitignore (the op would refuse them)', req: () => ({op: 'file', path: 'notes.md'}), contract: 'raw',
    raw: c => fs.readFileSync(path.join(c.repo, 'notes.md')),
    same: c => { write(c.repo, 'docs/other.md', 'unrelated, changed\n'); commit(c.repo, 'another file', 'docs/other.md'); },
    moved: c => { git(c.repo, 'rm', '-q', '--cached', 'notes.md'); fs.appendFileSync(path.join(c.repo, '.gitignore'), 'notes.md\n'); }},
  {op: 'file', name: 'file: the same bytes, now reached through a link out of the repository', req: () => ({op: 'file', path: 'notes.md'}), contract: 'raw',
    raw: c => fs.readFileSync(path.join(c.repo, 'notes.md')),
    same: c => { write(c.repo, 'docs/other.md', 'unrelated, changed\n'); commit(c.repo, 'another file', 'docs/other.md'); },
    moved: c => { const out = path.join(c.outside, 'notes.md'); fs.copyFileSync(path.join(c.repo, 'notes.md'), out); fs.rmSync(path.join(c.repo, 'notes.md')); fs.symlinkSync(out, path.join(c.repo, 'notes.md')); }},
  {op: 'list', name: 'list: a prefix of the index', req: () => ({op: 'list', prefix: 'docs'}), contract: 'body',
    same: c => fs.appendFileSync(path.join(c.repo, 'docs/a.md'), 'the content changes, the names do not\n'),
    moved: c => { write(c.repo, 'docs/b.md', 'a new tracked file\n'); git(c.repo, 'add', 'docs/b.md'); }},
  {op: 'grep', name: 'grep: rows found', req: () => ({op: 'grep', pattern: 'NEEDLE-W3', path: 'docs'}), contract: 'body',
    same: c => fs.appendFileSync(path.join(c.repo, 'docs/other.md'), 'still nothing to find here\n'),
    moved: c => fs.appendFileSync(path.join(c.repo, 'docs/a.md'), 'NEEDLE-W3 second\n')},
  {op: 'grep', name: 'grep: no row found (the placeholder is what is delivered)', req: () => ({op: 'grep', pattern: 'ABSENT-W3', path: 'docs'}), contract: 'body',
    same: c => fs.appendFileSync(path.join(c.repo, 'docs/a.md'), 'still not the absent word\n'),
    moved: c => fs.appendFileSync(path.join(c.repo, 'docs/a.md'), 'ABSENT-W3 appears\n')},
  {op: 'log', name: 'log: commits touching a path', req: () => ({op: 'log', path: 'docs/a.md'}), contract: 'body',
    same: c => { write(c.repo, 'docs/other.md', 'unrelated, changed\n'); commit(c.repo, 'another file', 'docs/other.md'); },
    moved: c => { fs.appendFileSync(path.join(c.repo, 'docs/a.md'), 'edited\n'); commit(c.repo, 'edit docs/a.md', 'docs/a.md'); }},
  {op: 'log', name: 'log: no commit found (the placeholder is what is delivered)', req: () => ({op: 'log', grep: 'W3-NO-SUCH-COMMIT'}), contract: 'body',
    same: c => { write(c.repo, 'docs/other.md', 'unrelated, changed\n'); commit(c.repo, 'another file', 'docs/other.md'); },
    moved: c => { write(c.repo, 'docs/other.md', 'changed again\n'); commit(c.repo, 'W3-NO-SUCH-COMMIT now exists', 'docs/other.md'); }},
  {op: 'show', name: 'show: a commit asked by a prefix (its rendering changes under the same id)', req: c => ({op: 'show', commit: c.head.slice(0, 7)}), contract: 'body',
    same: c => { write(c.repo, 'docs/other.md', 'unrelated, changed\n'); commit(c.repo, 'another file', 'docs/other.md'); },
    moved: c => git(c.repo, 'config', 'log.date', 'iso')},
  {op: 'show', name: 'show: a file at a commit (immutable bytes)', req: c => ({op: 'show', commit: c.head.slice(0, 7), path: 'notes.md'}), contract: 'body',
    same: c => { git(c.repo, 'config', 'log.date', 'iso'); fs.appendFileSync(path.join(c.repo, 'notes.md'), 'the working tree moves on\n'); }, moved: null},
  {op: 'status', name: 'status: the whole history', req: () => ({op: 'status', item: 'target'}), contract: 'body',
    same: c => reReady(c, 'other'),
    moved: c => reReady(c, 'target')},
  {op: 'status', name: 'status: a selection (match) the new entry is not in', req: () => ({op: 'status', item: 'target', match: '2026-11-17'}), contract: 'body',
    same: c => reReady(c, 'target', {checked: '2026-11-19'}),
    moved: c => reReady(c, 'target', {checked: '2026-11-17'})},
  {op: 'work', name: 'work: the item\'s own records (not judged, by policy)', req: () => ({op: 'work', item: 'target'}), contract: 'body', policy: true,
    same: c => reReady(c, 'other'),
    moved: async c => {
      const blocked = await tick({repo: c.repo, statusRoot: c.f.statusRoot, workRoot: c.f.workRoot, executors: {implement: waits}, limits: LIMITS, only: 'target'});
      assert.deepEqual(blocked.dispatched.map(d => d.stage), ['implement'], 'a later record of the item itself');
    }},
  {op: 'work', name: 'work: another item\'s records', req: () => ({op: 'work', item: 'other'}), contract: 'body', setup: recordOther,
    same: c => reReady(c, 'other'),
    moved: async c => assert.deepEqual((await recordOther(c)).dispatched.map(d => d.stage), ['plan'], 'the other item is woken by its new entry and records again')},
  {op: 'record', name: 'record: another item\'s stage record (immutable)', req: c => ({op: 'record', hash: c.otherRecord}), contract: 'body',
    setup: async c => { await recordOther(c); c.otherRecord = openWorkLedger({root: c.f.workRoot}).stages('other')[0].hash; },
    same: async c => { reReady(c, 'other'); assert.equal((await recordOther(c)).dispatched.length, 1, 'another record of that item'); }, moved: null},
  {op: 'issue', name: 'issue: the published issue', req: () => ({op: 'issue', number: 7}), contract: 'body',
    same: c => { c.issues[0].labels = ['relabelled']; c.issues[1].title = 'another issue, renamed'; },
    moved: c => { c.issues[0].state = 'closed'; }},
  {op: 'dossier', name: 'dossier: the derived requirement view', req: () => ({op: 'dossier', source: 'status:target#requirement'}), contract: 'body',
    same: c => reReady(c, 'target'),
    moved: c => reReady(c, 'target', {basis: 'the requirement of target: alpha.mjs exports ok = true, and says so'})},
];

for (const row of ROWS) {
  test(`${L504}, ${row.name}: the version identifies the delivered bytes; the gate flags a change of them, and only that`, async () => {
    await withDispatch(async ctx => {
      const repo = ctx.dir;
      write(repo, 'notes.md', 'the notes of the work\nline two\n');
      write(repo, 'docs/a.md', 'NEEDLE-W3 first\nplain line\n');
      write(repo, 'docs/other.md', 'unrelated\n');
      const f = fixture(repo, [{item: 'other', title: 'Other', basis: 'the requirement of other: a separate item'}, {item: 'target'}]);
      const c = {repo, f, head: git(repo, 'rev-parse', 'HEAD').trim(), outside: fs.mkdtempSync(path.join(os.tmpdir(), 'w3-outside-')),
        issues: [{number: 7, title: 'a published issue', state: 'open', body: 'what was reported', labels: []}, {number: 8, title: 'another issue', state: 'open', body: 'b', labels: []}]};
      try {
        if (row.setup) await row.setup(c);
        const req = row.req(c);
        let got = null;
        const turn = scriptedTurn({planner: ({prompt}) => {
          if (!prompt.includes(RETRIEVED)) return json({requests: [req]});
          got = deliveredIn(prompt);
          return json(planFor(prompt, {evidence: [{ref: got.source, why: 'the view under test'}]}));
        }});
        const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir});
        assert.deepEqual((await tick({repo, ...f, issues: c.issues, executors: {plan: ex.plan}, limits: LIMITS, only: 'target'})).dispatched.map(d => d.stage), ['plan']);
        const w = openWorkLedger({root: f.workRoot});
        const plan = w.stages('target').filter(s => s.stage === 'plan').at(-1);
        assert.ok(got, 'the planner was given the view');
        // 1. THE CONTRACT, on the record and on what the seat was shown.
        const logged = plan.outputs.context.author_log.requests.find(r => r.round === 1);
        assert.equal(logged.ok, true);
        assert.deepEqual([logged.source, logged.version], [got.source, got.version], 'the record names the view and version the seat was shown');
        assert.equal(logged.sha256, sha(got.text), 'the per-round digest is the digest of the bytes in the prompt');
        assert.equal(logged.coverage.complete, true, 'the whole body was delivered');
        const want = row.contract === 'raw' ? sha(row.raw(c)) : sha(got.text);
        assert.equal(got.version, want, row.contract === 'raw' ? 'version = sha256(the raw bytes)' : 'version = sha256(the delivered body)');
        const file = /^file:(.+)$/.exec(got.source)?.[1] ?? null;
        const cited = plan.outputs.evidence.find(e => (file ? e.path === file : e.source === got.source));
        assert.ok(cited, 'the stage bound the citation');
        assert.equal(file ? cited.sha256 : cited.version, got.version, 'bound to the version delivered');
        if (!file) assert.deepEqual(cited.request, req, 'with the request that re-reads it');
        // versionOf (the re-reader reconcile uses) agrees with what run() delivered, for every op it serves. The item's own
        // work view is read as the seat was given it: the records before the plan's own (the plan record is the first of
        // the later records that are its consequences -- the reason the gate does not judge that view).
        const before = w.stages('target').filter(s => s.hash !== plan.hash);
        const cut = {root: w.root, stages: i => (i === 'target' ? before : w.stages(i))};
        const present = makeRetriever({repo, statusRoot: f.statusRoot, work: w, issues: c.issues});
        const R = row.policy ? makeRetriever({repo, statusRoot: f.statusRoot, work: cut, issues: c.issues}) : present;
        if (row.policy) assert.notEqual(present.versionOf(req), got.version, 'the plan\'s own record is already a later record of the view');
        assert.equal(R.versionOf(req), ['dossier', 'output'].includes(req.op) ? undefined : got.version);
        // 2. THE GATE: reusable now; reusable after a change that leaves the bytes; stale after one that changes them.
        const gate = () => reconcile({repo, statusRoot: f.statusRoot, workLedger: openWorkLedger({root: f.workRoot}), issues: c.issues}).items.find(i => i.item === 'target').gate;
        const why = g => (g.stale ?? []).flatMap(s => s.why);
        const name = `evidence ${file ?? got.source} changed`;
        assert.deepEqual([gate().gate, why(gate())], ['implement', []], 'the plan is reusable as recorded');
        await row.same(c);
        assert.equal(R.versionOf(req), ['dossier', 'output'].includes(req.op) ? undefined : got.version, 'the same bytes: the same version');
        assert.deepEqual([gate().gate, why(gate())], ['implement', []], 'the same bytes delivered: the plan stays reusable');
        if (!row.moved) return;
        await row.moved(c);
        if (row.policy) {
          // The item's own work view: every later record is the stage's own consequence; the gate does not judge it, and
          // the records the seat was given are unchanged on the append-only ledger.
          assert.equal(R.versionOf(req), got.version, 'the view as given is unchanged');
          assert.notEqual(present.versionOf(req), got.version, 'the present view moved on');
          const g = gate();
          assert.equal(g.stage ?? g.gate, 'implement');
          assert.deepEqual(why(g), [], 'not stale: the item\'s own work view is not evidence (policy)');
          return;
        }
        const g = gate();
        assert.equal(g.gate, 'plan', `other bytes delivered: the plan is stale (${JSON.stringify(g.stale)})`);
        assert.ok(why(g).includes(name), `stale for this source: ${JSON.stringify(why(g))}`);
      } finally { fs.rmSync(c.outside, {recursive: true, force: true}); }
    });
  });
}

// ---- evidenceStable: the dossier's `stable` digest, the re-check of a plan waiting on evidence -------------------------
test(`${L504}, evidenceStable: a plan waiting on evidence is planned again when a view of its dossier delivers other bytes (same source, same length), and not when nothing it shows changed`, async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    write(repo, 'docs/other.md', 'unrelated\n');
    const f = fixture(repo, [{item: 'target'}]);
    const turn = scriptedTurn({planner: () => json({insufficient: {gaps: ['the cause is not visible'], needed: ['a trace']}})});
    const ex = makeExecutors({repo, makeClientFor: ctx.makeClientFor, turn, stateDir: f.stateDir});
    const run = async () => (await tick({repo, ...f, executors: {plan: ex.plan}, limits: LIMITS})).dispatched.map(d => d.stage);
    const planners = () => turn.log.filter(l => l.kind === 'planner').length;
    assert.deepEqual(await run(), ['plan']);
    const waiting = openWorkLedger({root: f.workRoot}).stages('target').at(-1);
    assert.equal(waiting.blocker.code, 'EVIDENCE_INSUFFICIENT');
    const shown = waiting.outputs.context.dossier.entries.find(e => e.source === 'file:verify.mjs');
    assert.ok(shown, 'verify.mjs (a consumer of the named file) is in the dossier');
    // A file the dossier does not show changes: the evidence available to the plan is the same.
    fs.appendFileSync(path.join(repo, 'docs/other.md'), 'changed, and not in the view\n');
    assert.deepEqual(await run(), [], 'nothing the dossier shows changed: not planned again');
    // A shown view delivers other bytes of the same length: only its version moves.
    const v = fs.readFileSync(path.join(repo, 'verify.mjs'), 'utf8');
    fs.writeFileSync(path.join(repo, 'verify.mjs'), v.replace('assert.equal(ok, true)', 'assert.equal(ok, TRUE)'));
    assert.equal(Buffer.byteLength(fs.readFileSync(path.join(repo, 'verify.mjs'))), Buffer.byteLength(v));
    assert.deepEqual(await run(), ['plan'], 'the evidence changed: planned again');
    assert.equal(planners(), 2);
    assert.notEqual(openWorkLedger({root: f.workRoot}).stages('target').at(-1).outputs.context.dossier.entries.find(e => e.source === 'file:verify.mjs').version, shown.version);
  });
});

// ---- the file contract: raw bytes, not the decoded body ------------------------------------------------------------
test(`${L504}, file: a file that is not valid UTF-8 is delivered decoded, versioned by its raw bytes, and every raw change is a change`, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-utf8-'));
  try {
    const f = fixture(repo, [{item: 'target'}]);
    const raw = Buffer.from([0x6f, 0x6b, 0xff, 0x0a]);
    fs.writeFileSync(path.join(repo, 'odd.txt'), raw);
    commit(repo, 'an undecodable byte', 'odd.txt');
    const R = makeRetriever({repo, statusRoot: f.statusRoot});
    let shown = null;
    const r = await investigate({retriever: R, prompt: 'judge', ask: async p => (p.includes(RETRIEVED) ? (shown = deliveredIn(p), {text: 'done'}) : {text: json({requests: [{op: 'file', path: 'odd.txt'}]})})});
    assert.equal(shown.text, 'ok�\n', 'delivered as its UTF-8 decoding');
    assert.equal(r.log.requests[0].sha256, sha(shown.text));
    assert.equal(shown.version, sha(raw), 'versioned by the raw bytes');
    // Another undecodable byte decodes to the same text: the raw bytes changed, so the version does (the safe direction).
    fs.writeFileSync(path.join(repo, 'odd.txt'), Buffer.from([0x6f, 0x6b, 0xfe, 0x0a]));
    assert.equal(R.run({op: 'file', path: 'odd.txt'}).text, shown.text);
    assert.notEqual(R.versionOf({op: 'file', path: 'odd.txt'}), shown.version);
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// ---- output: a validate stage's own stored test output -------------------------------------------------------------
test(`${L504}, output: a stored test output is versioned by its delivered bytes; the gate does not judge a stage's own output (policy)`, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-output-'));
  try {
    const f = fixture(repo, [{item: 'target'}]);
    const outputsDir = path.join(repo, 'status', 'operate', 'target', 'validate-1-outputs');
    fs.mkdirSync(outputsDir, {recursive: true});
    fs.writeFileSync(path.join(outputsDir, 'acceptance-a1.txt'), 'ok 1 - alpha exports true\n');
    const R = makeRetriever({repo, statusRoot: f.statusRoot, outputsDir});
    let shown = null;
    const r = await investigate({retriever: R, prompt: 'judge', ask: async p => (p.includes(RETRIEVED) ? (shown = deliveredIn(p), {text: 'done'}) : {text: json({requests: [{op: 'output', id: 'acceptance-a1.txt'}]})})});
    assert.equal(shown.version, sha(shown.text));
    assert.equal(r.log.requests[0].sha256, sha(shown.text));
    fs.appendFileSync(path.join(outputsDir, 'acceptance-a1.txt'), 'appended\n');
    assert.notEqual(R.run({op: 'output', id: 'acceptance-a1.txt'}).version, shown.version, 'other bytes, another version');
    assert.equal(evidenceCheck({source: shown.source, version: shown.version, request: {op: 'output', id: 'acceptance-a1.txt'}}, {versionOf: () => undefined, rec: {identity: {item: 'target'}}}), null,
      'a stage\'s own output is not judged by the gate (policy): it is bound by the record\'s output_digest');
  } finally { fs.rmSync(repo, {recursive: true, force: true}); }
});

// ---- the validate stage: the same contract through validationEvidence --------------------------------------------------
test(`${L504}, the validator's sources: a validation is reused while the views it was given deliver the same bytes, and validated again when one changes`, async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    write(repo, 'notes.md', 'the notes of the work\n');
    const f = fixture(repo, [{item: 'val'}]);
    const prefix = git(repo, 'rev-parse', 'HEAD').trim().slice(0, 7);
    const reqs = [{op: 'show', commit: prefix}, {op: 'status', item: 'val', match: '2026-11-17'}, {op: 'file', path: 'notes.md'}];
    const turn = scriptedTurn({validator: ({prompt}) => {
      if (!prompt.includes('## Retrieved')) return json({requests: reqs});
      const sources = [...prompt.matchAll(/^source: (\S+) \| version: /gm)].map(m => m[1]);
      return json({...JSON.parse(/```json\n([\s\S]*)\n```/.exec(ACCEPT)[1]), sources});
    }});
    const ex = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: f.stateDir, checked: '2026-11-17', ...SIX});
    const four = {plan: ex.plan, implement: ex.implement, review: ex.review, validate: ex.validate};
    assert.deepEqual(stagesOf(await tick({repo, ...f, executors: four, limits: LIMITS})).map(s => s.split(':')[0]), ['plan', 'implement', 'review', 'validate']);
    const w = openWorkLedger({root: f.workRoot});
    const val = w.stages('val').find(s => s.stage === 'validate');
    const log = val.outputs.context.investigations.at(-1).requests.filter(r => r.round === 1);
    assert.equal(log.length, 3);
    for (const r of log.filter(x => x.request.op !== 'file')) assert.equal(r.version, r.sha256, `${r.source}: version = sha256(the delivered body)`);
    for (const r of log) assert.ok(val.outputs.sources.some(s => s.source === r.source && s.version === r.version && s.delivered), `${r.source} is bound as delivered`);
    const gate = () => reconcile({repo, statusRoot: f.statusRoot, workLedger: w}).items.find(i => i.item === 'val').gate;
    const why = g => (g.stale ?? []).flatMap(s => s.why);
    assert.equal(gate().gate, 'outcome');
    // The same bytes: an unrelated commit and a status entry outside the selection.
    write(repo, 'docs/other.md', 'unrelated\n'); commit(repo, 'another file', 'docs/other.md');
    const s = f.S.board().items.find(i => i.item === 'val');
    f.S.set({item: 'val', title: s.title, basis: s.basis, state: 'Ready', checked: '2026-11-19'});
    assert.deepEqual([gate().gate, why(gate())], ['outcome', []], 'the views deliver the same bytes: the validation is reused');
    // Other bytes, one view at a time.
    git(repo, 'config', 'log.date', 'iso');
    let g = gate();
    assert.equal(g.gate, 'validate');
    assert.deepEqual(why(g), [`evidence show:${prefix} changed`]);
    git(repo, 'config', '--unset', 'log.date');
    assert.equal(gate().gate, 'outcome', 'the rendering restored: the same bytes again');
    git(repo, 'rm', '-q', '--cached', 'notes.md'); fs.appendFileSync(path.join(repo, '.gitignore'), 'notes.md\n');
    g = gate();
    assert.equal(g.gate, 'validate');
    assert.deepEqual(why(g), ['evidence notes.md changed'], 'the validator\'s file is no longer served: a change');
  });
});
