// The public record: GitHub issues and labels as a projection of the status ledger, PR provenance and
// cycle reports from a review-cycle ledger. No network: apply runs against an in-memory fake of the
// GitHub REST API, and the review cycle against scripted reviewers.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStatusLedger, STATES} from '../../packages/ledger/status.mjs';
import {readStatusRecord, plan, MARKER_RE, OWNED} from './record.mjs';
import {apply, syncProject, verifyItem} from './github.mjs';
import {openLedgerReadOnly, listCycles, prProvenance, cycleReport, writeCycleReports, cycleRecord} from './provenance.mjs';
import {suiteCounts, summary} from './ci-summary.mjs';
import {openPantheonLedger} from '../../pantheon/src/ledger/system.mjs';
import {reviewCycle} from '../../pantheon/src/ledger/review-cycle.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-public-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
const committed = () => readStatusRecord();
const CHAIRS = ['impl@build', 'check@review', 'lead@orch', 'scout@opt', 'arbiter@judge'];

test('plan from the committed status ledger: one issue per item, labels and state from the ledger', () => {
  const rec = committed(), p = plan(rec);
  assert.equal(p.issues.length, rec.items.length);
  assert.equal(new Set(p.issues.map(i => MARKER_RE.exec(i.body)[1])).size, rec.items.length, 'one marker per item');
  const labels = new Set(p.labels.map(l => l.name));
  assert.equal(p.labels.length, 15);
  for (const l of p.labels) { assert.ok(l.description.startsWith(OWNED)); assert.ok(l.description.length <= 100); }
  const byId = new Map(rec.items.map(i => [i.item, i]));
  for (const i of p.issues) {
    const it = byId.get(i.item);
    assert.equal(MARKER_RE.exec(i.body)[1], i.item);
    assert.ok(i.labels.every(l => labels.has(l)), `${i.item}: every label is in the catalog`);
    assert.ok(i.labels.includes(`state:${it.state.toLowerCase().replace(/ /g, '-')}`));
    assert.equal(i.state, it.state === 'Resolved' ? 'closed' : 'open');
    assert.equal(i.state_reason, it.state === 'Resolved' ? 'completed' : null);
    if (it.waiting_on) assert.ok(i.labels.includes(`waiting:${it.waiting_on}`));
    else assert.ok(!i.labels.some(l => l.startsWith('waiting:')));
    assert.equal(i.labels.includes('decision-authority'), it.waiting_on === 'decision');
    assert.ok(i.body.includes(it.entry) && i.body.includes(rec.anchor), 'the verify section names the entry and the anchor');
    assert.ok(i.body.includes('node packages/ledger/status.mjs verify'));
  }
  assert.ok(STATES.every(s => labels.has(`state:${s.toLowerCase().replace(/ /g, '-')}`)));
  // Deterministic: the same ledger plans the same bodies.
  assert.deepEqual(plan(committed()).issues.map(i => i.body), p.issues.map(i => i.body));
});

test('every body carries the agent provenance notice; agent roles are never assignees', () => {
  const p = plan(committed());
  for (const i of p.issues) {
    assert.match(i.body, /### Agent provenance/);
    assert.match(i.body, /one account/);
    assert.match(i.body, /model seats operated under that account, not independent developers/);
    assert.match(i.body, /no independence is claimed here/);
    assert.deepEqual(i.assignees, [], 'nobody is assigned by default');
  }
  // With an owner login configured, only decision-authority items get the person; a chair never does.
  const root = path.join(tmp(), 'ledger'), S = openStatusLedger({root});
  const base = {checked: '2026-11-17'};
  S.set({...base, item: 'build-x', title: 'Build X', state: 'In progress', basis: 'started', owner_role: 'impl@build'});
  S.set({...base, item: 'review-x', title: 'Review X', state: 'Ready', basis: 'converged', owner_role: 'check@review', depends_on: ['build-x']});
  S.set({...base, item: 'custody', title: 'Signer custody', state: 'On Hold', basis: 'custody', waiting_on: 'decision'});
  const q = plan(readStatusRecord({root}), {ownerLogin: 'the-owner'});
  const by = new Map(q.issues.map(i => [i.item, i]));
  assert.deepEqual(by.get('custody').assignees, ['the-owner']);
  assert.ok(by.get('custody').labels.includes('decision-authority'));
  assert.deepEqual(by.get('build-x').assignees, []);
  assert.ok(by.get('build-x').labels.includes('role:impl@build'));
  assert.match(by.get('build-x').body, /`impl@build` is a chair \(a model seat\), not a person; it is a label, never an assignee/);
  for (const i of q.issues) for (const a of i.assignees) assert.ok(!CHAIRS.includes(a) && !a.includes('@'));
});

test('dependencies link both ways, by issue number once known; the history lists every change with its entry', () => {
  const rec = committed();
  const p = plan(rec), by = new Map(p.issues.map(i => [i.item, i]));
  assert.match(by.get('p8-p9-admission').body, /\*\*Depends on:\*\* `k6`/);
  assert.match(by.get('k6').body, /\*\*Depended on by:\*\* `p8-p9-admission`, `q7-adjustment`, `signed-transitions`/);
  const numbered = plan(rec, {numbers: new Map([['k6', 7], ['p8-p9-admission', 9]])}).issues.find(i => i.item === 'p8-p9-admission');
  assert.match(numbered.body, /\*\*Depends on:\*\* #7 \(`k6`\)/);
  // Dependencies come before their dependents, so a first apply links them at creation.
  const order = p.issues.map(i => i.item);
  assert.ok(order.indexOf('k6') < order.indexOf('p8-p9-admission'));
  const item = rec.items.find(i => i.history.length > 2);
  assert.ok(item, 'the committed ledger has an item with several changes');
  for (const h of item.history) assert.ok(by.get(item.item).body.includes(`\`${h.entry}\` (seq ${h.seq})`));
  // verify-item: the latest entry is ok, an earlier one is reported superseded, a stranger is refused.
  assert.equal(verifyItem({record: rec, item: item.item, entry: item.entry}).ok, true);
  assert.match(verifyItem({record: rec, item: item.item, entry: item.history[0].entry}).why, /superseded/);
  assert.match(verifyItem({record: rec, item: item.item, entry: 'sha256:' + '0'.repeat(64)}).why, /not a status entry/);
});

/** An in-memory GitHub: labels and issues of one repository, with Link pagination. */
function fakeGitHub({issues = [], labels = []} = {}) {
  const state = {issues: issues.map(i => ({assignees: [], labels: [], state: 'open', state_reason: null, ...i})), labels: [...labels], calls: []};
  let next = Math.max(0, ...state.issues.map(i => i.number)) + 1;
  const json = (status, body, headers = {}) => ({status, headers: new Headers(headers), text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body});
  const page = (rows, url) => {
    const u = new URL(url), per = Number(u.searchParams.get('per_page') ?? 30), n = Number(u.searchParams.get('page') ?? 1);
    const slice = rows.slice((n - 1) * per, n * per);
    if (n * per >= rows.length) return json(200, slice);
    u.searchParams.set('page', String(n + 1));
    return json(200, slice, {link: `<${u}>; rel="next"`});
  };
  const fetchImpl = async (url, {method, body}) => {
    const b = body ? JSON.parse(body) : undefined;
    state.calls.push({method, url, body: b});
    const p = new URL(url).pathname.replace(/^\/repos\/o\/r/, '');
    if (method === 'GET' && p === '/labels') return page(state.labels, url);
    if (method === 'POST' && p === '/labels') { state.labels.push({...b}); return json(201, b); }
    let m;
    if (method === 'PATCH' && (m = /^\/labels\/(.+)$/.exec(p))) { const l = state.labels.find(x => x.name === decodeURIComponent(m[1])); Object.assign(l, {color: b.color, description: b.description}); return json(200, l); }
    if (method === 'GET' && p === '/issues') return page(state.issues, url);
    if (method === 'POST' && p === '/issues') {
      const i = {number: next++, node_id: `I_${next}`, title: b.title, body: b.body, labels: b.labels.map(name => ({name})), assignees: (b.assignees ?? []).map(login => ({login})), state: 'open', state_reason: null};
      state.issues.push(i);
      return json(201, i);
    }
    if (method === 'PATCH' && (m = /^\/issues\/(\d+)$/.exec(p))) {
      const i = state.issues.find(x => x.number === Number(m[1]));
      Object.assign(i, b, b.labels ? {labels: b.labels.map(name => ({name}))} : {});
      return json(200, i);
    }
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/assignees$/.exec(p))) {
      const i = state.issues.find(x => x.number === Number(m[1]));
      i.assignees.push(...b.assignees.map(login => ({login})));
      return json(201, i);
    }
    return json(404, {message: 'Not Found'});
  };
  return {state, fetchImpl, writes: () => state.calls.filter(c => c.method !== 'GET')};
}
const run = (record, gh, extra = {}) => apply({record, repo: 'o/r', token: 't', fetchImpl: gh.fetchImpl, writePause: 0, log: () => {}, ...extra});

test('apply is idempotent: a second run writes nothing, and unowned issues and labels are never touched', async () => {
  const rec = committed();
  const unowned = {number: 1, node_id: 'I_1', title: 'A person\'s issue', body: 'mentions ophanim:item but carries no marker', labels: [{name: 'bug'}]};
  const pr = {number: 2, node_id: 'PR_2', title: 'A pull request', body: '<!-- ophanim:item=k6 -->', pull_request: {url: 'x'}};
  const foreign = {name: 'state:ready', color: '000000', description: 'someone else\'s label'};
  const gh = fakeGitHub({issues: [unowned, pr], labels: [foreign]});
  const first = await run(rec, gh);
  assert.equal(first.issues.created.length, rec.items.length);
  assert.equal(first.labels.created.length, 14);
  assert.deepEqual(first.labels.foreign, ['state:ready'], 'a same-named label without the prefix is left as is');
  assert.equal(gh.state.labels.find(l => l.name === 'state:ready').description, 'someone else\'s label');
  for (const c of gh.writes()) assert.ok(!/\/issues\/(1|2)(\/|$)/.test(new URL(c.url).pathname), `never writes to an unowned issue: ${c.method} ${c.url}`);
  assert.deepEqual(gh.state.issues.find(i => i.number === 1), {...unowned, assignees: [], state: 'open', state_reason: null});
  // Every owned issue's final body links its dependencies by number; resolved items are closed as completed.
  const num = first.numbers;
  const p8 = gh.state.issues.find(i => i.number === num['p8-p9-admission']);
  assert.match(p8.body, new RegExp(`\\*\\*Depends on:\\*\\* #${num.k6} \\(\`k6\`\\)`));
  assert.ok(gh.state.issues.filter(i => MARKER_RE.test(i.body ?? '') && !i.pull_request).every(i => (i.state === 'closed') === i.labels.some(l => l.name === 'state:resolved')));
  assert.ok(gh.state.issues.filter(i => i.state === 'closed').every(i => i.state_reason === 'completed'));
  assert.ok(gh.state.issues.every(i => i.assignees.length === 0), 'nobody is assigned');

  // A person adds a label to an owned issue; the second run keeps it and writes nothing.
  gh.state.issues.find(i => i.number === num.k6).labels.push({name: 'good first issue'});
  const before = gh.writes().length;
  const second = await run(rec, gh);
  assert.equal(gh.writes().length, before, 'second run: no writes');
  assert.equal(second.issues.created.length, 0);
  assert.equal(second.issues.unchanged.length, rec.items.length);
  assert.equal(second.labels.unchanged.length, 14);
  assert.ok(gh.state.issues.find(i => i.number === num.k6).labels.some(l => l.name === 'good first issue'));
});

test('apply updates only the issues whose ledger record changed', async () => {
  const root = path.join(tmp(), 'ledger'), S = openStatusLedger({root});
  const base = {checked: '2026-11-17'};
  S.set({...base, item: 'a', title: 'A', state: 'Ready', basis: 'converged'});
  S.set({...base, item: 'b', title: 'B', state: 'On Hold', basis: 'needs a credential', waiting_on: 'credential'});
  S.set({...base, item: 'c', title: 'C', state: 'On Hold', basis: 'needs b', depends_on: ['b']});
  const gh = fakeGitHub();
  await run(readStatusRecord({root}), gh, {ownerLogin: 'the-owner'});
  const n = gh.writes().length;
  S.set({...base, checked: '2026-11-18', item: 'a', title: 'A', state: 'Resolved', basis: 'merged'});
  const s = await run(readStatusRecord({root}), gh, {ownerLogin: 'the-owner'});
  assert.deepEqual(s.issues.updated, ['a']);
  const writes = gh.writes().slice(n);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
  assert.equal(writes[0].body.state, 'closed');
  assert.equal(writes[0].body.state_reason, 'completed');
  assert.match(writes[0].body.body, /\| 2 \| 2026-11-18 \| Resolved \|/, 'the new change is in the history');
  // A held decision item gets the configured person, added once; a later decision hold too.
  S.set({...base, item: 'd', title: 'D', state: 'On Hold', basis: 'custody', waiting_on: 'decision'});
  await run(readStatusRecord({root}), gh, {ownerLogin: 'the-owner'});
  assert.deepEqual(gh.state.issues.find(i => i.title === 'D [d]').assignees, [{login: 'the-owner'}]);
  assert.ok(gh.state.issues.filter(i => i.title !== 'D [d]').every(i => i.assignees.length === 0));
});

test('apply fails loudly on a non-2xx response, and needs a token and a repository', async () => {
  const rec = committed();
  const failing = async () => ({status: 422, headers: new Headers(), text: async () => '{"message":"Validation Failed"}'});
  await assert.rejects(apply({record: rec, repo: 'o/r', token: 't', fetchImpl: failing, writePause: 0, log: () => {}}), /-> 422: .*Validation Failed/);
  await assert.rejects(apply({record: rec, repo: 'o/r', token: '', fetchImpl: failing}), /GITHUB_TOKEN is required/);
  await assert.rejects(apply({record: rec, repo: '', token: 't', fetchImpl: failing}), /GITHUB_REPOSITORY/);
});

test('Projects sync is skipped cleanly without a project or a project token, and adds items when configured', async () => {
  const logs = [], never = async () => { throw new Error('no network'); };
  const a = await syncProject({env: {}, issues: [{node_id: 'I_1', state: 'Ready'}], fetchImpl: never, log: m => logs.push(m)});
  assert.match(a.skipped, /no PROJECT_URL or PROJECT_ID/);
  const b = await syncProject({env: {PROJECT_URL: 'https://github.com/users/o/projects/1', GITHUB_TOKEN: 't'}, issues: [], fetchImpl: never, log: m => logs.push(m)});
  assert.match(b.skipped, /no OPHANIM_PROJECT_TOKEN/);
  assert.equal(logs.length, 2);
  // Configured: resolves the project, adds each issue and sets Status where an option matches.
  const calls = [];
  const gql = async (url, {body}) => {
    const {query} = JSON.parse(body);
    calls.push(query);
    const data = /projectV2\(number/.test(query) ? {user: {projectV2: {id: 'P_1'}}}
      : /field\(name/.test(query) ? {node: {field: {id: 'F_1', options: [{id: 'O_1', name: 'Ready'}, {id: 'O_2', name: 'Resolved'}]}}}
      : /addProjectV2ItemById/.test(query) ? {addProjectV2ItemById: {item: {id: 'PI_1'}}} : {updateProjectV2ItemFieldValue: {projectV2Item: {id: 'PI_1'}}};
    return {status: 200, json: async () => ({data})};
  };
  const c = await syncProject({env: {PROJECT_URL: 'https://github.com/users/o/projects/1', OPHANIM_PROJECT_TOKEN: 'pat'},
    issues: [{node_id: 'I_1', state: 'Ready'}, {node_id: 'I_2', state: 'On Hold'}], fetchImpl: gql, log: () => {}});
  assert.deepEqual(c, {project: 'P_1', added: 2, status_set: 1});
});

// A review-cycle ledger with scripted reviewers, as pantheon/tests/ledger-review-cycle.test.mjs builds one.
const C = n => String(n).repeat(40).slice(0, 40);
const DIFF = 'diff --git a/src/x.mjs b/src/x.mjs\n--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 2;\n';
const answer = (verdict, findings = []) => '```json\n' + JSON.stringify({verdict, findings}) + '\n```';
const scripted = replies => {
  let n = 0;
  return async ({vendor, model}) => {
    const r = replies[vendor] ?? answer('approve');
    const o = typeof r === 'string' ? {text: r} : r;
    return {text: o.text, response_id: `resp_${vendor}_${++n}`, served_model: o.served_model === undefined ? model : o.served_model};
  };
};
async function fixtureCycleLedger() {
  const root = path.join(tmp(), 'cycles');
  const sys = openPantheonLedger({root}), rec = sys.recorder();
  const author = rec.recordTurn({seat: {seat_id: 'anthropic-work@claude-opus', vendor: 'anthropic', mode: 'work', occupancy_gen: 1},
    requested_model: 'claude-opus-4-1', served_model: 'claude-opus-4-1', response_id: 'resp_author', reply: 'the change'});
  const r = await reviewCycle({ledger: rec, change: {scope: 'ophanim', base: C('a'), head: C('b'), diff: DIFF, files: ['src/x.mjs'], author_labs: ['anthropic'], author_turns: [author]},
    turn: scripted({
      xai: answer('request_changes', [{severity: 'major', file: 'src/x.mjs', line: 1, claim: 'x changed without a test', reproduction: {kind: 'test', run: 'node --test tests/x.test.mjs'}}]),
      openai: {text: answer('request_changes', [{severity: 'minor', file: null, line: null, claim: 'the doc still says 1', reproduction: null}]), served_model: null},
    })});
  assert.equal(r.complete, true, JSON.stringify(r.failed));
  const fx = r.reviews.find(x => x.lab === 'xai').findings[0], fo = r.reviews.find(x => x.lab === 'openai').findings[0];
  rec.fixFinding({finding: fx.hash, commit: C('c'), test: 'node --test tests/x.test.mjs', before: {commit: C('b'), exit: 1}, after: {commit: C('c'), exit: 0}});
  rec.deferFinding({finding: fo.hash, reason: 'docs pass scheduled next cycle'});
  const closed = rec.closeCycle(r.cycle);
  // A second cycle, still open.
  const r2 = await reviewCycle({ledger: rec, change: {scope: 'ophanim', head: C('d'), diff: DIFF, files: ['src/x.mjs'], author_labs: ['anthropic']}, turn: scripted({})});
  fs.rmSync(path.join(root, 'keys'), {recursive: true, force: true});       // a reader holds no keys
  return {root, cycle: r.cycle, open: r2.cycle, author, closed};
}

test('PR provenance from a review-cycle ledger: seats, independence evidence and limits, findings, outcome', async () => {
  const fx = await fixtureCycleLedger();
  const opened = openLedgerReadOnly({root: fx.root});
  assert.deepEqual(listCycles(opened.view).map(c => [c.scope, c.ordinal]), [['ophanim', 1], ['ophanim', 2]]);
  const md = prProvenance(opened.view, fx.cycle, {anchor: opened.anchor});
  assert.match(md, new RegExp(`<!-- ophanim:provenance cycle=${fx.cycle} -->`));
  assert.match(md, /## Provenance/);
  // Produced by: the author's turn, with its seat key and entry.
  assert.match(md, /impl@build \(work\) \| `anthropic` \| `claude-opus-4-1` \| `claude-opus-4-1` \| `anthropic` \| `seat:anthropic-work@claude-opus#1` \|/);
  assert.ok(md.includes(fx.author));
  // Reviewed by: three labs, each with seat key id, served model (or "not reported") and entry.
  const rec = cycleRecord(opened.view, fx.cycle);
  assert.equal(rec.reviews.length, 3);
  for (const r of rec.reviews) { assert.ok(md.includes(r.entry)); assert.ok(md.includes(`\`${r.key_id}\``)); assert.match(r.key_id, /^seat:/); }
  assert.match(md, /not reported/);
  assert.match(md, /\*\*Distinct labs:\*\* yes \(`google`, `openai`, `xai`\)/);
  assert.match(md, /\*\*Author lab excluded:\*\* yes; author lab\(s\) `anthropic` did not review/);
  assert.match(md, /\*\*Cold-review check:\*\* passed/);
  assert.match(md, /\*\*Served model reported:\*\* 2 of 3 reviews/);
  assert.match(md, /\*\*Limits\.\*\*/);
  assert.match(md, /one operator and one GitHub account/);
  // Findings and their resolution.
  assert.match(md, /x changed without a test \| test: `node --test tests\/x\.test\.mjs` \| fixed in `cccccccccccc`; `node --test tests\/x\.test\.mjs` exited 1 on `bbbbbbbbbbbb` \(fail before\) and 0 on `cccccccccccc` \(pass after\)/);
  assert.match(md, /the doc still says 1 \| \*\*unreproduced\*\* \| deferred: docs pass scheduled next cycle/);
  assert.match(md, /Closed \*\*unverified\*\*.*2 finding\(s\), 1 fixed, 1 deferred, 1 unreproduced/);
  assert.match(md, /### Agent provenance/);
  assert.match(md, /never used for these seats/);
  // The open cycle says so, with what it would close as.
  assert.match(prProvenance(opened.view, fx.open, {anchor: opened.anchor}), /Not closed yet; its entries would close it \*\*verified\*\*/);
});

test('cycle reports: docs/cycles/<cycle>.md and index.md, generated from the ledger; an empty index without one', async () => {
  const fx = await fixtureCycleLedger();
  const opened = openLedgerReadOnly({root: fx.root});
  const report = cycleReport(opened.view, fx.cycle, {anchor: opened.anchor, slug: 'ophanim-001'});
  for (const h of ['## What was', '## What is', '## What could be better', '## What the system concluded', '### Agent provenance']) assert.ok(report.includes(h), h);
  assert.match(report, /Deferred \(minor\) the doc still says 1: docs pass scheduled next cycle/);
  assert.match(report, /openai did not report the served model/);
  assert.match(report, /Closed \*\*unverified\*\*/);
  const out = path.join(tmp(), 'cycles');
  const files = writeCycleReports({opened, out}).map(f => path.basename(f));
  assert.deepEqual(files, ['ophanim-001.md', 'ophanim-002.md', 'index.md']);
  const index = fs.readFileSync(path.join(out, 'index.md'), 'utf8');
  assert.match(index, /\| \[ophanim-001\]\(ophanim-001\.md\) \| `aaaaaaaaaaaa\.\.bbbbbbbbbbbb` \| .* \| unverified \|/);
  assert.match(index, /\| \[ophanim-002\]\(ophanim-002\.md\) \| `bbbbbbbbbbbb\.\.dddddddddddd` \| .* \| open \|/);
  // Deterministic: regenerating writes the same bytes.
  const again = path.join(tmp(), 'again');
  writeCycleReports({opened, out: again});
  for (const f of files) assert.equal(fs.readFileSync(path.join(again, f), 'utf8'), fs.readFileSync(path.join(out, f), 'utf8'));
  // No ledger: an index that says so.
  const empty = path.join(tmp(), 'empty');
  writeCycleReports({opened: null, out: empty});
  assert.match(fs.readFileSync(path.join(empty, 'index.md'), 'utf8'), /No review cycle is recorded/);
  // A tampered ledger is refused, not projected.
  const objects = path.join(fx.root, 'objects');
  const obj = fs.readdirSync(objects).map(f => path.join(objects, f)).find(f => fs.readFileSync(f, 'utf8').includes('docs pass scheduled next cycle'));
  fs.writeFileSync(obj, fs.readFileSync(obj, 'utf8').replace('docs pass scheduled next cycle', 'nothing to see'));
  assert.throws(() => openLedgerReadOnly({root: fx.root}), /does not verify/);
});

test('the public-record workflow runs only on push to main and dispatch, with issues: write', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/public-record.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(wf, /pull_request/);
  assert.match(wf, /push:\s*\n\s*branches: \[main\]/);
  assert.match(wf, /workflow_dispatch/);
  assert.match(wf, /issues: write/);
  assert.match(wf, /contents: read/);
  assert.match(wf, /ophanim\/public\/github\.mjs apply/);
  // The qualification workflow keeps its suites and writes the verification summary.
  const q = fs.readFileSync(new URL('../../.github/workflows/qualification.yml', import.meta.url), 'utf8');
  assert.match(q, /npm test 2>&1 \| tee/);
  assert.match(q, /npm run test:proof 2>&1 \| tee/);
  assert.match(q, /ci-summary\.mjs[\s\S]*GITHUB_STEP_SUMMARY/);
});

test('the CI verification summary counts each suite from TAP or spec output, and reports a missing log', () => {
  const tap = ['> @argo/ledger@0.1.0 test', '# tests 23', '# suites 0', '# pass 23', '# fail 0', '# skipped 0', '# todo 0',
    '> pantheon@0.0.0 test', '# tests 848', '# pass 847', '# fail 1', '# skipped 0'].join('\n');
  const d = tmp(), a = path.join(d, 'a.log'), b = path.join(d, 'b.log');
  fs.writeFileSync(a, tap);
  fs.writeFileSync(b, 'ℹ tests 160\nℹ suites 0\nℹ pass 160\nℹ fail 0\n');
  assert.deepEqual(suiteCounts(tap, 'npm test').map(r => [r.suite, r.tests, r.pass, r.fail]),
    [['npm test: @argo/ledger test', 23, 23, 0], ['npm test: pantheon test', 848, 847, 1]]);
  const md = summary([{label: 'npm test', file: a}, {label: 'test:proof', file: b}, {label: 'other', file: path.join(d, 'none.log')}], {statusVerify: 'ok: 41 items'});
  assert.match(md, /\| npm test: pantheon test \| 848 \| 847 \| 1 \| 0 \| 0 \|/);
  assert.match(md, /\| test:proof \| 160 \| 160 \| 0 \| 0 \| 0 \|/);
  assert.match(md, /\| other \| no result/);
  assert.match(md, /ok: 41 items/);
});
