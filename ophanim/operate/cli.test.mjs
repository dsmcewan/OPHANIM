// The controller's CLI: reconcile on the real repository (read-only, nothing dispatched), issues with and without
// markers, the NO_AUTHORITY block, the refusal without stage executors, bounded dispatch with scripted executors,
// the read-only issues intake, and the operating workflow (triggers, permissions, no provider path).
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {readStatusRecord, plan} from '../public/record.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {main, REPO_ROOT, reconcileView, backlogMarkdown, limitsOf} from './cli.mjs';
import {fetchIssues, normalizeIssues} from './issues.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'operate-cli-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
/** Run the CLI in-process; returns {code, out, err}. */
async function cli(argv, extra = {}) {
  const out = [], err = [];
  const code = await main(argv, {log: s => out.push(s), err: s => err.push(s), env: {}, ...extra});
  return {code, out: out.join('\n'), err: err.join('\n')};
}
function fixture(items) {
  const repo = tmp();
  const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
  const S = openStatusLedger({root: statusRoot});
  for (const i of items) S.set({checked: '2026-11-17', basis: `the requirement of ${i.item}`, ...i});
  fs.mkdirSync(path.join(repo, 'tickets'));
  return {repo, statusRoot, workRoot, S};
}
const at = (f, ...more) => ['--repo', f.repo, '--status-ledger', f.statusRoot, '--work-ledger', f.workRoot, ...more];

test('reconcile on the real repository: every item has its earliest unmet gate; nothing is created, called or dispatched', async () => {
  const workRoot = path.join(REPO_ROOT, 'status', 'work');
  const existed = fs.existsSync(workRoot);
  const r = await cli(['reconcile', '--json']);
  assert.equal(r.code, 0, r.err);
  const v = JSON.parse(r.out);
  const board = readStatusRecord();
  assert.equal(v.counts.items, board.items.length, 'the item count is read from the status ledger');
  assert.equal(v.ledger.head, board.head);
  assert.equal(Object.values(v.counts.by_gate).reduce((a, b) => a + b, 0), board.items.length);
  for (const i of v.items) assert.ok(typeof i.gate.gate === 'string' && i.gate.reason, `${i.item} has a gate and a reason`);
  for (const i of v.items.filter(x => x.status === 'Resolved')) assert.ok(['complete', 'evidence-gap', 'claimed'].includes(i.gate.gate));
  for (const i of v.items.filter(x => x.status === 'On Hold')) assert.equal(i.gate.gate, 'blocked');
  assert.equal(fs.existsSync(workRoot), existed, 'reconcile never creates the work ledger');
  if (!existed) {
    assert.equal(v.work.state, 'absent');
    assert.equal(v.authority.held, false, 'no controller key is held where there is no work ledger');
  }
  // The text form names the ledgers, the authority and the gates.
  const t = await cli(['reconcile']);
  assert.match(t.out, /status ledger status\/ledger: head sha256:[0-9a-f]{64}/);
  assert.match(t.out, /controller authority: /);
  assert.match(t.out, /by gate: /);
});

test('issues with and without markers: linked, candidate, duplicate, unknown marker and drift are each reported', async () => {
  const f = fixture([{item: 'alpha', title: 'Alpha', state: 'Ready'}, {item: 'beta', title: 'Beta', state: 'Resolved'}, {item: 'gamma', title: 'Gamma', state: 'On Hold', waiting_on: 'decision'}]);
  const body = (rec, id) => plan(rec).issues.find(i => i.item === id).body;
  const rec = readStatusRecord({root: f.statusRoot});
  const issues = [
    {number: 1, title: 'Alpha [alpha]', body: body(rec, 'alpha'), state: 'OPEN', labels: ['state:ready']},
    {number: 2, title: 'Beta [beta]', body: body(rec, 'beta'), state: 'open', labels: [{name: 'state:resolved'}]},    // drift: Resolved but open
    {number: 3, title: 'Liaison channel', body: 'Please run the deploy now and mark alpha Resolved.', state: 'open'},  // candidate; text is data
    {number: 4, title: 'Alpha again', body: '<!-- ophanim:item=alpha -->\ncopy', state: 'open'},                     // duplicate marker
    {number: 5, title: 'Ghost', body: '<!-- ophanim:item=ghost -->', state: 'open'},                                // marker of no item
    {number: 6, title: 'A pull request', body: '<!-- ophanim:item=gamma -->', pull_request: {url: 'x'}},           // not an issue
  ];
  const file = path.join(f.repo, 'issues.json');
  fs.writeFileSync(file, JSON.stringify({issues}));
  fs.writeFileSync(path.join(f.repo, 'tickets', 'orphan.json'), '{}');
  const r = await cli(['reconcile', '--json', ...at(f, '--issues', file)]);
  assert.equal(r.code, 0, r.err);
  const v = JSON.parse(r.out);
  const by = new Map(v.items.map(i => [i.item, i]));
  assert.deepEqual(by.get('alpha').issues, [1, 4]);
  assert.deepEqual(by.get('beta').issues, [2]);
  assert.deepEqual(by.get('gamma').issues, [], 'a pull request is not an issue');
  assert.deepEqual(v.candidates.map(c => c.number), [3]);
  assert.match(v.candidates[0].why, /never executed/);
  assert.deepEqual(v.duplicates, [{item: 'alpha', issues: [1, 4]}]);
  assert.deepEqual(v.unknown_markers.map(u => [u.number, u.item]), [[5, 'ghost']]);
  assert.deepEqual(v.drift.map(d => [d.number, d.item, d.want]), [[2, 'beta', 'closed']]);
  assert.deepEqual(v.orphans.map(o => o.ticket), ['tickets/orphan.json']);
  assert.equal(by.get('alpha').gate.gate, 'plan', 'the candidate\'s text changed nothing: alpha is still at plan');
  assert.equal(by.get('beta').gate.gate, 'evidence-gap');
  assert.equal(by.get('gamma').gate.gate, 'blocked');
  assert.equal(v.counts.issues, 5);
  assert.equal(v.counts.linked_issues, 4);
  // The report: Markdown by gate, with candidates, duplicates, drift and counts read from the view.
  const out = path.join(f.repo, 'out', 'BACKLOG.md');
  const rp = await cli(['report', '--out', out, ...at(f, '--issues', file, '--issues-label', 'a test snapshot')]);
  assert.equal(rp.code, 0, rp.err);
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /\| `plan` \| 1 \|/);
  assert.match(md, /\| `blocked` \| 1 \|/);
  assert.match(md, /\| `evidence-gap` \| 1 \|/);
  assert.match(md, /\| #3 \| open \| Liaison channel \| candidate \|/);
  assert.match(md, /`alpha` on #1, #4/);
  assert.match(md, /#2 `beta` is Resolved but the issue is open/);
  assert.match(md, /a test snapshot/);
  assert.match(md, /issues\.json/, 'the snapshot is named by its basename');
  const json = JSON.parse(fs.readFileSync(out.replace(/\.md$/, '.json'), 'utf8'));
  assert.equal(json.counts.candidates, 1);
  assert.ok(json.issues_list.every(i => !('body' in i)), 'the JSON carries no issue bodies');
});

test('tick without the controller key: the work ledger is verified, then a NO_AUTHORITY block; nothing is recorded', async () => {
  const f = fixture([{item: 'alpha', title: 'Alpha', state: 'Ready'}]);
  const w = openWorkLedger({root: f.workRoot});
  const before = w.verify().entries;
  fs.rmSync(path.join(f.workRoot, 'keys'), {recursive: true});
  const stagesFile = path.join(f.repo, 'stages.mjs');
  fs.writeFileSync(stagesFile, 'export const makeExecutors = () => { throw new Error("must not be reached"); };');
  const r = await cli(['tick', '--total-provider-calls', '100', ...at(f)], {stagesFile});
  assert.equal(r.code, 3);
  const b = JSON.parse(r.out);
  assert.equal(b.blocked, 'NO_AUTHORITY');
  assert.match(b.what, /no controller key is held/);
  assert.equal(b.role, 'decision-authority');
  assert.match(b.resume_when, /controller key/);
  assert.equal(b.verified.entries, before, 'verification ran before the block');
  assert.equal(openWorkLedger({root: f.workRoot, create: false}).verify().entries, before, 'nothing recorded');
  // A work ledger that does not verify is refused, never projected or dispatched from.
  fs.appendFileSync(path.join(f.workRoot, 'chain.jsonl'), '{"forged": true}\n');
  const bad = await cli(['tick', ...at(f)], {stagesFile});
  assert.equal(bad.code, 1);
  assert.match(bad.err, /refused: /);
  const rec = await cli(['reconcile', ...at(f)]);
  assert.equal(rec.code, 1, 'reconcile refuses a work ledger that does not verify');
});

test('tick refuses clearly without ophanim/operate/stages.mjs, and creates no work ledger for a run that cannot dispatch', async () => {
  const f = fixture([{item: 'alpha', title: 'Alpha', state: 'Ready'}]);
  const missing = path.join(f.repo, 'no-stages.mjs');
  const r = await cli(['tick', '--init', ...at(f)], {stagesFile: missing});
  assert.equal(r.code, 1);
  assert.match(r.err, /stage executors are not in this checkout: .*makeExecutors/);
  assert.equal(fs.existsSync(f.workRoot), false, 'no ledger or key was created');
  const noInit = await cli(['tick', ...at(f)], {stagesFile: missing});
  assert.match(noInit.err, /no work ledger at .*--init/);
});

test('tick and watch dispatch through makeExecutors only within the declared provider-call budget', async () => {
  const f = fixture([{item: 'alpha', title: 'Alpha', state: 'Ready'}]);
  const stagesFile = path.join(f.repo, 'stages.mjs');
  // Scripted executors: each stage passes with 2 provider calls; makeExecutors records the context it was given.
  fs.writeFileSync(stagesFile, `
    export const seen = [];
    export function makeExecutors(ctx) {
      seen.push({repo: ctx.repo, limits: ctx.limits});
      const pass = stage => async x => ({status: 'passed', outputs: {[stage]: true}, team: [{role: stage}], contributions: [], findings: [],
        usage: {provider_calls: 2}, next: {stage: null, why: 'ok'}});
      return Object.fromEntries(['plan', 'implement', 'review', 'validate', 'outcome'].map(s => [s, pass(s)]));
    }`);
  const none = await cli(['tick', '--init', ...at(f)], {stagesFile});
  assert.equal(none.code, 0, none.err);
  const t0 = JSON.parse(none.out);
  assert.deepEqual(t0.dispatched, [], 'no declared total: nothing that may call a provider is dispatched');
  assert.match(t0.note, /no --total-provider-calls declared/);
  assert.match(t0.stopped, /provider-call budget/);
  assert.ok(t0.intake >= 1, 'intake is still recorded');
  const two = await cli(['tick', '--total-provider-calls', '4', '--stage-provider-calls', '2', ...at(f)], {stagesFile});
  const t1 = JSON.parse(two.out);
  assert.deepEqual(t1.dispatched.map(d => d.stage), ['plan', 'implement'], 'the total bounds the run');
  assert.equal(t1.spent.calls, 4);
  const w = await cli(['watch', '--once', '--total-provider-calls', '100', '--stage-provider-calls', '2', '--iterations', '1', ...at(f)], {stagesFile});
  assert.equal(w.code, 0, w.err);
  assert.deepEqual(JSON.parse(w.out).ticks[0].dispatched.map(d => d.stage), ['review'], 'iterations bound it; plan and implement are reused');
  const mod = await import(new URL(`file://${stagesFile}`).href);
  assert.ok(mod.seen.every(s => s.repo === f.repo && s.limits.total_provider_calls >= 0));
  assert.equal((await cli(['tick', '--iterations', 'x', ...at(f)], {stagesFile})).code, 2, 'a bad limit is a usage error');
  assert.equal(limitsOf({}).total_provider_calls, 0);
});

test('tick and watch --item ID dispatch only that item; the other runnable items are skipped "outside the --item scope"', async () => {
  const f = fixture(['one', 'two', 'three'].map(item => ({item, title: item, state: 'Ready'})));
  const stagesFile = path.join(f.repo, 'stages.mjs');
  fs.writeFileSync(stagesFile, `
    export function makeExecutors(ctx) {
      const pass = stage => async x => ({status: 'passed', outputs: {[stage]: x.item}, team: [{role: stage}], contributions: [], findings: [],
        usage: {provider_calls: 1}, next: {stage: null, why: 'ok'}});
      return Object.fromEntries(['plan', 'implement', 'review', 'validate', 'outcome'].map(s => [s, pass(s)]));
    }`);
  const r = await cli(['tick', '--init', '--item', 'three', '--total-provider-calls', '100', '--stage-provider-calls', '1', '--iterations', '2', ...at(f)], {stagesFile});
  assert.equal(r.code, 0, r.err);
  const t = JSON.parse(r.out);
  assert.deepEqual(t.dispatched.map(d => `${d.item}:${d.stage}`), ['three:plan', 'three:implement']);
  assert.deepEqual(t.skipped.map(s => [s.item, s.why]), [['one', 'outside the --item scope'], ['two', 'outside the --item scope']]);
  assert.deepEqual(t.scope, {only: 'three', on_ledger: true, gate: 'plan', runnable: true});
  const w = await cli(['watch', '--once', '--item', 'three', '--total-provider-calls', '100', '--stage-provider-calls', '1', ...at(f)], {stagesFile});
  assert.deepEqual(JSON.parse(w.out).ticks[0].dispatched.map(d => d.item), ['three', 'three', 'three']);
  const work = openWorkLedger({root: f.workRoot});
  assert.deepEqual([work.claims('one').length, work.claims('two').length, work.stages('three').length], [0, 0, 5]);
  assert.equal((await cli(['tick', '--item', 'Not An Id', ...at(f)], {stagesFile})).code, 2);
});

test('the issues intake reads through the public record\'s REST client, GET only, pages followed, pull requests dropped', async () => {
  const calls = [];
  const pages = {
    1: [{number: 9, title: 'Nine', body: '<!-- ophanim:item=k1 -->', state: 'closed', labels: [{name: 'state:resolved'}]}, {number: 8, title: 'PR', body: '', pull_request: {}}],
    2: [{number: 3, title: 'Three', body: null, state: 'open', labels: []}],
  };
  const fetchImpl = async (url, {method}) => {
    calls.push({method, url});
    const n = Number(new URL(url).searchParams.get('page') ?? 1);
    const headers = new Headers(n === 1 ? {link: `<${url}&page=2>; rel="next"`} : {});
    return {status: 200, headers, text: async () => JSON.stringify(pages[n])};
  };
  const issues = await fetchIssues({repo: 'o/r', token: 't', fetchImpl});
  assert.deepEqual(issues, [{number: 3, title: 'Three', body: '', state: 'open', labels: []},
    {number: 9, title: 'Nine', body: '<!-- ophanim:item=k1 -->', state: 'closed', labels: ['state:resolved']}]);
  assert.ok(calls.every(c => c.method === 'GET'), 'read-only');
  assert.match(calls[0].url, /\/repos\/o\/r\/issues\?state=all&per_page=100/);
  await assert.rejects(fetchIssues({repo: 'o/r', token: '', fetchImpl}), /GITHUB_TOKEN is required/);
  assert.throws(() => normalizeIssues({nope: 1}), /array of issues/);
  // --github without a token is a refusal, not an empty snapshot.
  const r = await cli(['reconcile', '--github'], {env: {GITHUB_REPOSITORY: 'o/r'}});
  assert.equal(r.code, 1);
  assert.match(r.err, /GITHUB_TOKEN is required/);
});

test('the operating workflow: triggers, minimal permissions, reconcile --github and the projection; no provider path', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/operate.yml', import.meta.url), 'utf8');
  // YAML-ish: the top-level keys and the trigger block, by indentation.
  const top = wf.split('\n').filter(l => /^[a-z_]+:/.test(l)).map(l => l.split(':')[0]);
  assert.deepEqual(top, ['name', 'on', 'permissions', 'concurrency', 'jobs']);
  const block = key => { const m = new RegExp(`^${key}:\\n((?:[ \\t]+.*\\n|\\n)*)`, 'm').exec(wf); return m ? m[1] : ''; };
  const on = block('on');
  assert.match(on, /^ {2}push:\n {4}branches: \[main\]/m);
  assert.match(on, /^ {2}issues:\n {4}types: \[opened, edited, labeled, closed\]/m);
  assert.match(on, /^ {2}schedule:\n {4}- cron: '\d+ \* \* \* \*'/m, 'hourly');
  assert.doesNotMatch(wf, /pull_request/);
  const perms = block('permissions').trim().split('\n').map(l => l.trim()).sort();
  assert.deepEqual(perms, ['contents: read', 'issues: write']);
  // Commands, not comments: the header names `watch` as the owner's dispatching trigger, which CI never runs.
  const code = wf.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  const runs = [...code.matchAll(/node ([^\n|>]+)/g)].map(m => m[1].trim());
  assert.ok(runs.includes('ophanim/operate/cli.mjs reconcile --github'));
  assert.ok(runs.includes('ophanim/public/github.mjs apply'));
  assert.ok(runs.every(r => !/cli\.mjs (tick|watch)|review-cycle|pantheon\/bin|--total-provider-calls/.test(r)), 'no dispatch and no model execution in CI');
  const secrets = [...wf.matchAll(/secrets\.([A-Z_]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(secrets)].sort(), ['GITHUB_TOKEN', 'OPHANIM_PROJECT_TOKEN'], 'no provider key is given to CI');
  assert.doesNotMatch(wf, /ANTHROPIC|OPENAI|XAI|GEMINI|GOOGLE_API/);
});

test('the backlog markdown is generated from the view alone (no hardcoded counts)', () => {
  const f = fixture([{item: 'one', title: 'One', state: 'Ready'}, {item: 'two', title: 'Two', state: 'Ready', depends_on: ['one']}]);
  const v = {...reconcileView({repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot}), issues_list: null, bundles: null};
  const md = backlogMarkdown(v, {at: '2026-11-17T00:00:00.000Z'});
  assert.match(md, /\| `plan` \| 1 \|/);
  assert.match(md, /\| `blocked` \| 1 \|/);
  assert.match(md, /\| \*\*total\*\* \| \*\*2\*\* \|/);
  assert.match(md, /unresolved dependencies: one \| `lead@orch` \| one Resolved \|/);
  assert.match(md, /Work ledger\*\* \(`status\/work`\): absent/);
  assert.match(md, /not checked \(no issues read\)/);
});

test('the CLI seats the REAL stage executors (stages.mjs): live seats by default, or --turn and --clients modules', async () => {
  const f = fixture([{item: 'alpha', title: 'Alpha', state: 'Ready'}]);
  // No stagesFile override: the checkout's own stages.mjs. Before, makeExecutors refused for want of a turn.
  const live = await cli(['tick', '--init', ...at(f)]);
  assert.equal(live.code, 0, live.err);
  assert.deepEqual(JSON.parse(live.out).dispatched, [], 'the default total of 0 dispatches nothing, live seats or not');
  const mods = path.join(f.repo, 'seats');
  fs.mkdirSync(mods);
  fs.writeFileSync(path.join(mods, 'turn.mjs'), 'export default async () => { throw new Error("scripted turn: no provider"); };');
  fs.writeFileSync(path.join(mods, 'clients.mjs'), 'export default () => { throw new Error("scripted clients: no provider"); };');
  const scripted = await cli(['tick', '--turn', path.join(mods, 'turn.mjs'), '--clients', path.join(mods, 'clients.mjs'), ...at(f)]);
  assert.equal(scripted.code, 0, scripted.err);
  fs.writeFileSync(path.join(mods, 'bad.mjs'), 'export default 1;');
  assert.equal((await cli(['tick', '--turn', path.join(mods, 'bad.mjs'), ...at(f)])).code, 2);
});

test('serve: the execution service from the command line; a config is required, and missing authority is exit 3 with nothing recorded', async () => {
  const f = fixture([{item: 'alpha', title: 'Alpha', state: 'Ready'}]);
  assert.equal((await cli(['serve', '--repo', f.repo])).code, 2, 'no --config is a usage error');
  // A work ledger whose controller key is not held here.
  openWorkLedger({root: f.workRoot});
  fs.rmSync(path.join(f.workRoot, 'keys'), {recursive: true, force: true});
  const file = path.join(f.repo, 'operate.json');
  fs.writeFileSync(file, JSON.stringify({schema: 'ophanim.operate-service/v1', repo: '.', interval_s: 10, issues: {source: 'none'}, limits: {total_provider_calls: 10}}));
  const r = await cli(['serve', '--config', file, '--max-ticks', '1', '--repo', f.repo]);
  assert.equal(r.code, 3, r.err);
  assert.equal(JSON.parse(r.out).blocked.blocked, 'NO_AUTHORITY');
  fs.writeFileSync(file, JSON.stringify({schema: 'ophanim.operate-service/v1', interval_s: 10, limits: {}}));
  assert.equal((await cli(['serve', '--config', file, '--repo', f.repo])).code, 1, 'an undeclared cap is refused');
});
