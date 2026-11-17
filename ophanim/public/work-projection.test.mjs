// The public projection of work ownership and progress: each item's issue shows, from a constructed work ledger,
// its gate and reason, current stage, team (model seats as text, never assignees), claim and lease, budget and
// usage (unknown stays unknown), blocker, and the evidence of the chain the gate reuses. No network, no provider.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {openWorkLedger, outputsDigest} from '../operate/work-ledger.mjs';
import {tick} from '../operate/scheduler.mjs';
import {readStatusRecord, plan, MARKER_RE} from './record.mjs';
import {readWorkRecord} from './work.mjs';
import {apply} from './github.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-work-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });

const PLANNER = {role: 'planner', vendor: 'anthropic', model: 'claude-opus-5-5', lab: 'anthropic'};
const REVIEWERS = [{role: 'reviewer', vendor: 'openai', model: 'gpt-6', lab: 'openai'}, {role: 'reviewer', vendor: 'xai', served_model: 'grok-5', lab: 'xai'}];
const result = (over) => ({status: 'passed', outputs: {}, team: [], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: null, why: 'ok'}, ...over});

/** A repository with three items and a work ledger built by the real scheduler over scripted executors. */
async function constructed() {
  const repo = tmp();
  const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
  fs.mkdirSync(path.join(repo, 'tickets'), {recursive: true});
  const S = openStatusLedger({root: statusRoot});
  const base = {checked: '2026-11-17'};
  S.set({...base, item: 'alpha', title: 'Alpha', state: 'In progress', basis: 'the requirement of alpha', owner_role: 'impl@build'});
  S.set({...base, item: 'gamma', title: 'Gamma', state: 'On Hold', basis: 'needs a decision', waiting_on: 'decision'});
  const executors = {
    plan: async () => result({outputs: {deps: {}, evidence: [], approach: 'a'}, team: [PLANNER], usage: {provider_calls: 3}, next: {stage: 'implement', why: 'approved'}}),
    implement: async () => result({outputs: {commit: 'c0ffee1234567890'}, team: [{role: 'implementer', vendor: 'anthropic', model: 'claude-opus-5-5', lab: 'anthropic'}],
      usage: {provider_calls: null}, next: {stage: 'review', why: 'implemented'}}),
    review: async () => result({status: 'blocked', outputs: {cycle: 'sha256:' + 'c'.repeat(64)}, team: REVIEWERS, usage: {provider_calls: 2},
      blocker: {what: 'the third review lab has no credential', role: 'lead@orch', resume_when: 'a credential for a third lab is supplied'}, next: null}),
  };
  await tick({repo, statusRoot, workRoot, executors, limits: {total_provider_calls: 1000, stage_provider_calls: 10}});
  // beta: added after the tick, claimed and not released (a fixed, far lease: the projection reads no clock).
  S.set({...base, item: 'beta', title: 'Beta', state: 'Ready', basis: 'the requirement of beta'});
  const w = openWorkLedger({root: workRoot});
  w.claim({item: 'beta', stage: 'plan', attempt: 1, inputs: {x: 1}, holder: 'controller', budget: {provider_calls: 40, iterations: 1, elapsed_ms: 3600000, retries: 3},
    lease_ms: 600000, at: '2099-01-01T00:00:00.000Z'});
  return {repo, statusRoot, workRoot, S};
}

test('each issue shows stage, gate, team, claim and lease, budget, usage, blocker and evidence from the work ledger', async () => {
  const f = await constructed();
  const work = readWorkRecord(f);
  assert.equal(work.ledger.state, 'verified');
  const record = readStatusRecord({root: f.statusRoot});
  const p = plan(record, {work, ownerLogin: 'the-owner'});
  const by = new Map(p.issues.map(i => [i.item, i]));

  const a = by.get('alpha').body;
  assert.match(a, new RegExp(`verified in full against its anchor \`${work.ledger.anchor}\``));
  assert.match(a, /\*\*Earliest unmet gate:\*\* `blocked`: review is blocked: the third review lab has no credential/);
  assert.match(a, /\*\*Current stage:\*\* `review`, attempt 1, `blocked`; record `sha256:[0-9a-f]{64}`/);
  assert.match(a, /\*\*Claim:\*\* none held; the last claim \(`review`, attempt 1, `controller`\) was released `blocked`/);
  assert.match(a, /\*\*Budget:\*\* 10 provider calls, 1 iteration\(s\), 3 retries/);
  assert.match(a, /\*\*Usage so far:\*\* 5 provider call\(s\) recorded on 2 stage record\(s\); usage \*\*unknown\*\* on 1 stage record\(s\) \(unknown, not zero\)/);
  assert.match(a, /\*\*Blocker:\*\* the third review lab has no credential; responsible role `lead@orch`; resumes when a credential for a third lab is supplied/);
  assert.match(a, /\| reviewer \| openai \| gpt-6 \| openai \|/);
  assert.match(a, /\| reviewer \| xai \| grok-5 \| xai \|/);
  assert.match(a, /Model seats, shown as text: none is a GitHub user, so none is ever an assignee or a reviewer/);
  const w = openWorkLedger({root: f.workRoot, create: false});
  const [planRec, implRec] = w.stages('alpha');
  assert.match(a, new RegExp(`Stage records: plan \`${planRec.hash}\`, implement \`${implRec.hash}\``));
  assert.ok(a.includes(`outputs digest \`${outputsDigest(planRec.outputs)}\``), 'the plan digest');
  assert.match(a, /- Commit: `c0ffee1234567890`/);
  assert.match(a, /\| 2 \| implement \| 1 \| passed \| implementer \| unknown \|/, 'unknown usage is shown as unknown in the stage table');
  assert.match(a, /- Validation verdict: not recorded/);
  assert.match(a, /- Review cycle: `sha256:c{64}`; close not recorded; outcome not recorded \(from the latest `review` attempt, `blocked`, not part of the reused chain\)/);

  const b = by.get('beta').body;
  assert.match(b, /\*\*Earliest unmet gate:\*\* `claimed`: claimed: plan, attempt 1 \(lease\)/);
  assert.match(b, /held by `controller` for `plan` \(attempt 1\), leased 2099-01-01T00:00:00.000Z, lease until \*\*2099-01-01T00:10:00.000Z\*\*; not released/);
  assert.match(b, /\*\*Budget:\*\* 40 provider calls/);
  assert.match(b, /\*\*Usage so far:\*\* none recorded/);

  const g = by.get('gamma').body;
  assert.match(g, /\*\*Earliest unmet gate:\*\* `blocked`: waiting on decision: needs a decision/);
  assert.match(g, /responsible role `decision-authority`; resumes when the decision is supplied and the owner records the item Ready/);
  assert.match(g, /none recorded on the work ledger for this item yet/);

  // Seats never become GitHub identities: only the configured person, only on the decision-authority item.
  assert.deepEqual(by.get('alpha').assignees, []);
  assert.deepEqual(by.get('beta').assignees, []);
  assert.deepEqual(by.get('gamma').assignees, ['the-owner']);
  for (const i of p.issues) {
    for (const s of [...REVIEWERS, PLANNER]) assert.ok(!i.assignees.includes(s.model) && !i.assignees.includes(s.vendor) && !i.assignees.includes(s.role));
    assert.match(i.body, /### Agent provenance/, 'the provenance notice is kept');
    assert.equal(MARKER_RE.exec(i.body)[1], i.item, 'the marker is kept');
  }
  // The work section changes bodies only: labels, state and assignees are as without it.
  const without = plan(record, {ownerLogin: 'the-owner'});
  assert.deepEqual(without.issues.map(i => [i.item, i.labels, i.state, i.assignees]), p.issues.map(i => [i.item, i.labels, i.state, i.assignees]));
  assert.match(without.issues[0].body, /The work ledger was not read for this projection/);
  // Deterministic: the same ledgers project the same bodies, whatever the time.
  assert.deepEqual(plan(readStatusRecord({root: f.statusRoot}), {work: readWorkRecord(f), ownerLogin: 'the-owner'}).issues.map(i => i.body), p.issues.map(i => i.body));

  // apply carries the section to GitHub and never assigns a seat.
  const posted = [];
  const fetchImpl = async (url, {method, body}) => {
    const b2 = body ? JSON.parse(body) : undefined;
    if (method !== 'GET') posted.push({method, url, body: b2});
    const res = method === 'GET' ? [] : method === 'POST' && /\/issues$/.test(url) ? {number: posted.length, node_id: 'I', ...b2, labels: b2.labels.map(name => ({name})), assignees: (b2.assignees ?? []).map(login => ({login}))} : b2;
    return {status: 200, headers: new Headers(), text: async () => JSON.stringify(res)};
  };
  await apply({record, work, repo: 'o/r', token: 't', fetchImpl, writePause: 0, log: () => {}, ownerLogin: 'the-owner'});
  const created = posted.filter(c => c.method === 'POST' && /\/issues$/.test(c.url)).map(c => c.body);
  assert.equal(created.length, 3);
  assert.ok(created.every(c => c.body.includes('## Work')));
  assert.ok(posted.every(c => !(c.body?.assignees ?? []).some(x => x !== 'the-owner')));
});

test('an absent work ledger is said so; one that does not verify is said so and nothing from it is shown', async () => {
  const repo = tmp();
  const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
  fs.mkdirSync(path.join(repo, 'tickets'));
  openStatusLedger({root: statusRoot}).set({checked: '2026-11-17', item: 'solo', title: 'Solo', state: 'Ready', basis: 'b'});
  const absent = readWorkRecord({repo, statusRoot, workRoot});
  assert.equal(absent.ledger.state, 'absent');
  assert.equal(fs.existsSync(workRoot), false, 'reading never creates a work ledger');
  const body = plan(readStatusRecord({root: statusRoot}), {work: absent}).issues[0].body;
  assert.match(body, /There is no work ledger at `status\/work` yet/);
  assert.match(body, /\*\*Earliest unmet gate:\*\* `plan` \(mode `author`\)/);
  // Pinned to another anchor: not verified, nothing shown from it.
  openWorkLedger({root: workRoot});
  const wrong = readWorkRecord({repo, statusRoot, workRoot, anchor: 'sha256:' + '0'.repeat(64)});
  assert.equal(wrong.ledger.state, 'unverified');
  assert.match(plan(readStatusRecord({root: statusRoot}), {work: wrong}).issues[0].body, /\*\*did not verify\*\*/);
});

test('the committed repository projects a Work section for every item', () => {
  const repo = path.resolve(new URL('../..', import.meta.url).pathname);
  const work = readWorkRecord({repo, statusRoot: path.join(repo, 'status', 'ledger'), workRoot: path.join(repo, 'status', 'work')});
  const record = readStatusRecord();
  const p = plan(record, {work});
  assert.equal(work.items.size, record.items.length);
  for (const i of p.issues) assert.match(i.body, /## Work\n\n(From the work ledger|There is no work ledger)/);
});
