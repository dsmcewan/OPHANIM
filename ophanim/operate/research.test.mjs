// RESEARCH IN THE LIFECYCLE (owner direction 2026-11-20: the Carbon 4 research and exploration team): the work ledger's
// research records, the runner that connects a research team to read-only SDK sessions, the billing policy and the
// stage's call bound, the dossier, the plan gate and the review panel. Scripted sessions and scripted seats: nothing
// here reaches a provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openWorkLedger, openResearchRequests, RESEARCH_DEPTH_MAX} from './work-ledger.mjs';
import {RESEARCH_DEPTH_LIMIT} from '../../pantheon/src/antigravity/config.mjs';
import {createHash} from 'node:crypto';
import {requestResearch, researchOf, researchView, researchContributors, runResearch, teamIdOf, ROLE_OF_TRIGGER, RESEARCH_EVIDENCE_SCHEMA} from './research.mjs';
import {optIn} from '../../pantheon/tests/fixtures/billing.mjs';

const tmp = (t, name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };
const AT = '2026-11-20T00:00:00.000Z';
const CARBON = {vendor: 'agy_google', model: 'gemini-4-carbon', effort: 'high'}, HYDROGEN = {vendor: 'agy_google', model: 'gemini-4-hydrogen', effort: 'medium'};

test('THE WORK LEDGER\'S RESEARCH RECORDS: a request, a team, its nodes, a refusal and a conclusion; a node\'s level is at most 10 and a specialist\'s parent is a recorded node one level above it; a request is recorded once and a team concludes once', t => {
  const w = openWorkLedger({root: tmp(t, 'research-ledger')});
  const req = w.recordResearch({phase: 'request', item: 'two', trigger: 'review-finding', question: 'Does the retry path hold the claim across a restart?', by: 'check@review', once: 1, at: AT});
  assert.match(req, /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => w.recordResearch({phase: 'request', item: 'two', trigger: 'review-finding', question: 'Does the retry path hold the claim across a restart?', by: 'someone else', once: 1, at: AT}), /already requested/);
  assert.throws(() => w.recordResearch({phase: 'request', item: 'two', trigger: '', question: 'q', by: 'x', at: AT}), /a research request names/);
  assert.deepEqual(openResearchRequests(w.research('two')).map(r => r.hash), [req]);
  const team = {item: 'two', team: 'rt-0123456789abcdef'};
  const opened = {phase: 'team', ...team, request: req, trigger: 'review-finding', role: 'researcher', coordinator: CARBON, subordinate: HYDROGEN, selection: {role: 'researcher'}, limits: {max_depth: 10, max_active: 8}, root: 'rn-root000000000000', at: AT};
  w.recordResearch(opened);
  assert.throws(() => w.recordResearch(opened), /this research team is already recorded/);
  const node = (over = {}) => ({phase: 'node', ...team, node: 'rn-root000000000000', kind: 'coordinator', parent: null, depth: 1, round: 1, state: 'admitted', seat: CARBON, question: 'the team\'s question', at: AT, ...over});
  w.recordResearch(node());
  w.recordResearch(node({node: 'rn-a', kind: 'specialist', parent: 'rn-root000000000000', depth: 2, seat: HYDROGEN, round: 1}));
  w.recordResearch(node({node: 'rn-b', kind: 'specialist', parent: 'rn-a', depth: 3, seat: HYDROGEN, round: 2}));
  // THE LEVEL IS BOUNDED BY THE LEDGER TOO: an eleventh level is not a record this ledger takes.
  assert.equal(RESEARCH_DEPTH_MAX, RESEARCH_DEPTH_LIMIT);
  assert.throws(() => w.recordResearch(node({node: 'rn-deep', kind: 'specialist', parent: 'rn-b', depth: 11, seat: HYDROGEN})), /a research node names .* depth \(1 to 10\)/);
  assert.throws(() => w.recordResearch(node({node: 'rn-c', kind: 'specialist', parent: 'rn-nobody', depth: 3, seat: HYDROGEN})), /its parent rn-nobody is not a recorded node of this team one level above it/);
  assert.throws(() => w.recordResearch(node({node: 'rn-c', kind: 'specialist', parent: 'rn-root000000000000', depth: 3, seat: HYDROGEN})), /not a recorded node of this team one level above it/);
  assert.throws(() => w.recordResearch(node({node: 'rn-c', kind: 'specialist', parent: null, depth: 2, seat: HYDROGEN})), /a specialist has a parent/);
  assert.throws(() => w.recordResearch(node({node: 'rn-x', depth: 2})), /a coordinator is level 1 and has no parent/);
  assert.throws(() => w.recordResearch(node({team: 'rt-ffffffffffffffff', node: 'rn-y'})), /its team is not recorded for this item/);
  w.recordResearch({phase: 'refusal', ...team, code: 'RESEARCH_DEPTH_EXCEEDED', reason: 'level 11 was asked for', parent: 'rn-b', attempted_depth: 11, at: AT});
  const done = {phase: 'conclusion', ...team, request: req, status: 'satisfied', stop_reason: 'SATISFIED', satisfied: true, material: true, summary: 'the claim is released on restart',
    findings_text: 'o1: the claim is released [src/scheduler.mjs@sha256:1111]', findings: null, telemetry: {depth_reached: 3}, contributors: [], at: AT};
  w.recordResearch(done);
  assert.throws(() => w.recordResearch(done), /this research team has already concluded/);
  assert.deepEqual(openResearchRequests(w.research('two')), [], 'a conclusion that cites the request answers it');
  assert.deepEqual(w.research('two').map(r => r.phase), ['request', 'team', 'node', 'node', 'node', 'refusal', 'conclusion']);
  assert.deepEqual(w.research('other-item'), []);
  assert.equal(w.verify().ok, true, 'and the ledger re-derives every one of them');
});

// ---- the runner ---------------------------------------------------------------------------------------------------------
const digestOf = n => 'sha256:' + ''.padStart(64, String(n));
const examinedFile = (p, n = 1) => ({tool: 'view_file', path: p, kind: 'file', sha256: digestOf(n), bytes: 10});
const part = (question, p, text, open = null) => ({question, sources: [{ref: p}], observations: [{id: 'o1', text, sources: [p]}], hypotheses: [], dependencies: [{from: 'scheduler', to: 'work ledger', kind: 'calls', contract: 'the claim fence', sources: [p]}],
  unresolved: open ? [{id: open, question: `what about ${open}?`, why: 'not visible from here'}] : [], next: []});
const lead = (over = {}) => ({question: 'root', sources: [], observations: [], hypotheses: [], dependencies: [], unresolved: [{id: 'u1', question: 'which module releases the claim on restart?', why: 'needs a trace'}], next: [],
  delegations: [], satisfied: false, material: false, summary: 'not yet', ...over});
const ask = n => ({addresses: 'u1', question: `Trace, as reader ${n}, where the claim is released when a tick is restarted.`, specialty: 'execution-trace', scope: ['src'], expected_evidence: 'the functions on the path, with file and line', why: 'the review finding rests on it'});
/** A scripted research session in place of runAntigravitySdkTurn: one billed request, then the scripted answer. */
function scripted(script) {
  const calls = [];
  const sdk = async ({seat, prompt, worktree, control_dir, unit, admit, signal, research, budget, timeoutS}) => {
    const round = Number(/ROUND (\d+) of/.exec(prompt)?.[1] ?? 0), specialist = /^ROLE: research specialist/.test(prompt);
    calls.push({model: seat.model, unit: unit.unit_id, specialist, round, control_dir, worktree, system: research?.system ?? null, budget, timeoutS});
    admit({class: 'root', type: null, model: seat.model, n: 1});
    const out = await script({seat, prompt, specialist, round, signal});
    return {text: JSON.stringify(out.report), examined: out.examined ?? [], served_model: out.served_model ?? seat.model, served_model_source: 'provider', usage: {total_token_count: 10}};
  };
  return {sdk, calls};
}
const TWO_READERS = ({specialist, round, prompt}) => (specialist
  ? {report: part(/QUESTION: (.*)/.exec(prompt)[1], 'src/scheduler.mjs', 'The claim is released as interrupted when the tick is restarted.', 'u5'), examined: [examinedFile('src/scheduler.mjs')]}
  : {report: round === 1 ? lead({delegations: [ask(1), ask(2)]}) : lead({satisfied: true, material: true, unresolved: [], summary: 'the claim is released on restart, by the scheduler'})});
function setup(t) {
  const root = tmp(t, 'research-run'), repo = path.join(root, 'repo'), dir = path.join(root, 'state', 'two', 'research');
  fs.mkdirSync(repo, {recursive: true});
  const work = openWorkLedger({root: path.join(root, 'work')});
  const hash = requestResearch({work, item: 'two', trigger: 'review-finding', question: 'Does the retry path hold the claim across a restart of the tick?', by: 'check@review', at: AT});
  const request = () => researchOf(work, 'two').requests.find(r => r.hash === hash);
  return {root, repo, dir, work, hash, request};
}

test('A RESEARCH RUN: the role and its seat follow the trigger; every member is on the ledger before it runs and its full record is a file cited by digest; every billed request is put to the billing policy and then to the stage\'s bound before it is sent; the conclusion answers the request and enters the dossier view', async t => {
  const f = setup(t), {sdk, calls} = scripted(TWO_READERS), billing = optIn({primary: 50}), charged = [];
  const order = [];
  const r = await runResearch({work: f.work, item: 'two', request: f.request(), repo: f.repo, dir: path.join(f.dir, 'team'), billing, admitRequest: who => { order.push(['stage', billing.rows.length]); charged.push(who); }, context: 'the dossier text', head: 'c0ffee', sdk});
  assert.deepEqual([r.status, r.concluded, r.team, ROLE_OF_TRIGGER['review-finding']], ['satisfied', true, teamIdOf({item: 'two', request: f.hash}), 'researcher']);
  // WHO RAN, ON WHAT: Carbon coordinates, Hydrogen specialises; each session is the read-only research mode on the repository.
  assert.deepEqual(calls.map(c => [c.model, c.specialist, c.round]), [['gemini-4-carbon', false, 1], ['gemini-4-hydrogen', true, 0], ['gemini-4-hydrogen', true, 0], ['gemini-4-carbon', false, 2]]);
  assert.ok(calls.every(c => c.worktree === f.repo && /read-only research team/.test(c.system) && c.budget.max_model_calls > 0 && c.timeoutS > 0 && !c.control_dir.startsWith(f.repo)));
  // THE LEDGER: request, team, then each member admitted before its outcome, then the conclusion.
  const rec = f.work.research('two');
  assert.deepEqual(rec.map(x => `${x.phase}${x.state ? ':' + x.state : ''}${x.kind ? ':' + x.kind : ''}`), ['request', 'team', 'node:admitted:coordinator', 'node:finished:coordinator', 'node:admitted:specialist', 'node:admitted:specialist',
    'node:finished:specialist', 'node:finished:specialist', 'node:admitted:coordinator', 'node:finished:coordinator', 'conclusion']);
  const teamRec = rec.find(x => x.phase === 'team');
  assert.deepEqual([teamRec.role, teamRec.trigger, teamRec.coordinator.model, teamRec.subordinate.model, teamRec.selection.chosen.model, teamRec.limits.max_depth, teamRec.limits.max_active, teamRec.request], ['researcher', 'review-finding', 'gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-4-carbon', 10, 8, f.hash]);
  const members = rec.filter(x => x.phase === 'node' && x.state === 'finished');
  assert.deepEqual(members.map(x => [x.kind, x.depth, x.seat.model, x.served_model, x.parent === null]), [['coordinator', 1, 'gemini-4-carbon', 'gemini-4-carbon', true], ['specialist', 2, 'gemini-4-hydrogen', 'gemini-4-hydrogen', false],
    ['specialist', 2, 'gemini-4-hydrogen', 'gemini-4-hydrogen', false], ['coordinator', 1, 'gemini-4-carbon', 'gemini-4-carbon', true]]);
  for (const m of members) {
    const raw = fs.readFileSync(path.join(f.dir, 'team', m.evidence.file));
    assert.equal('sha256:' + createHash('sha256').update(raw).digest('hex'), m.evidence.sha256, 'the full record is the file the ledger cites');
    const full = JSON.parse(raw.toString('utf8'));
    assert.deepEqual([full.schema, full.node.id, typeof full.node.report.question], [RESEARCH_EVIDENCE_SCHEMA, m.node, 'string']);
  }
  const specialist = JSON.parse(fs.readFileSync(path.join(f.dir, 'team', members[1].evidence.file), 'utf8')).node;
  assert.deepEqual([specialist.report.sources, specialist.examined], [[{ref: 'src/scheduler.mjs', version: digestOf(1)}], [examinedFile('src/scheduler.mjs')]]);
  // SPEND: four sessions, four billed requests, each a row of the policy written after the policy and the stage admitted it.
  assert.deepEqual(billing.ledger.rows().map(x => [x.kind, x.model, x.purpose, x.role, x.transport, x.request]), [['primary', 'gemini-4-carbon', 'research', 'researcher', 'sdk', 1], ['primary', 'gemini-4-hydrogen', 'research', 'researcher', 'sdk', 2],
    ['primary', 'gemini-4-hydrogen', 'research', 'researcher', 'sdk', 3], ['primary', 'gemini-4-carbon', 'research', 'researcher', 'sdk', 4]]);
  assert.deepEqual([charged.map(c => c.model), order], [['gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-4-hydrogen', 'gemini-4-carbon'], [['stage', 0], ['stage', 1], ['stage', 2], ['stage', 3]]], 'the stage is charged for each request, before that request\'s row');
  // THE CONCLUSION answers the request, and the item's research is one view for the dossier.
  const done = rec.at(-1);
  assert.deepEqual([done.request, done.satisfied, done.material, done.telemetry.depth_reached, done.telemetry.active_peak <= 8, done.telemetry.nodes_created, done.telemetry.requests.total], [f.hash, true, true, 2, true, 2, 4]);
  assert.deepEqual(researchOf(f.work, 'two').open, []);
  const view = researchView(f.work, 'two');
  assert.match(view.text, /Research team rt-[0-9a-f]{16} \(researcher; trigger: review-finding\): satisfied; MATERIAL/);
  assert.match(view.text, /The claim is released as interrupted when the tick is restarted\. \[src\/scheduler\.mjs@sha256:1{12} \(examined by 2 members\)\]/);
  assert.match(view.text, /depends: scheduler -> work ledger \(calls\); contract: the claim fence/);
  assert.deepEqual(researchContributors(f.work, 'two').map(c => [c.kind, c.depth, c.requested_model, c.served_model]), [['coordinator', 1, 'gemini-4-carbon', 'gemini-4-carbon'], ['specialist', 2, 'gemini-4-hydrogen', 'gemini-4-hydrogen'], ['specialist', 2, 'gemini-4-hydrogen', 'gemini-4-hydrogen']]);
  assert.equal(f.work.verify().ok, true);
});

test('NO IMPLICIT AUTHORIZATION: with primary Gemini execution not declared the team is refused before anything is prepared; nothing is charged, no session starts, no team is recorded and the request stays open', async t => {
  for (const [name, billing] of [['nothing declared', optIn({})], ['only the failover declared', optIn({failover: 5})]]) {
    const f = setup(t), {sdk, calls} = scripted(TWO_READERS), charged = [];
    const r = await runResearch({work: f.work, item: 'two', request: f.request(), repo: f.repo, dir: path.join(f.dir, 'team'), billing, admitRequest: who => charged.push(who), sdk});
    assert.deepEqual([r.status, r.stop_reason, r.concluded, r.refused?.code, calls.length, charged.length, billing.rows.length], ['refused', 'GEMINI_PRIMARY_DISABLED', false, 'GEMINI_PRIMARY_DISABLED', 0, 0, 0], name);
    assert.deepEqual(billing.refusals.map(x => [x.code, x.kind, x.purpose]), [['GEMINI_PRIMARY_DISABLED', 'primary', 'research']], name);
    assert.deepEqual(f.work.research('two').map(x => x.phase), ['request'], name);
    assert.deepEqual(researchOf(f.work, 'two').open.map(x => x.hash), [f.hash], name);
    assert.equal(fs.existsSync(path.join(f.dir, 'team')), false, `${name}: nothing was prepared`);
  }
});

test('A BUDGET SPENT INSIDE A TEAM LEAVES IT OPEN AND RECOVERABLE: no conclusion is recorded, what was found stays on the ledger, and the next run with more budget does not run or pay for a finished member again; the spending is never reset', async t => {
  const f = setup(t), usage = path.join(f.root, 'usage.jsonl');
  const first = scripted(TWO_READERS);
  const r1 = await runResearch({work: f.work, item: 'two', request: f.request(), repo: f.repo, dir: path.join(f.dir, 'team'), billing: optIn({primary: 3, file: usage}), sdk: first.sdk});
  // Three requests fit: the coordinator's first round and the two specialists. The coordinator's second round is refused.
  assert.deepEqual([r1.status, r1.stop_reason, r1.concluded, first.calls.length], ['stopped', 'METERED_GEMINI_BUDGET_EXHAUSTED', false, 4]);
  assert.deepEqual(f.work.research('two').filter(x => x.phase === 'conclusion'), []);
  assert.deepEqual(researchOf(f.work, 'two').open.map(x => x.hash), [f.hash], 'the request is still open');
  assert.deepEqual(f.work.research('two').filter(x => x.phase === 'node' && x.state === 'finished').map(x => x.kind), ['coordinator', 'specialist', 'specialist']);
  const again = scripted(TWO_READERS), raised = optIn({primary: 10, file: usage});
  const r2 = await runResearch({work: f.work, item: 'two', request: f.request(), repo: f.repo, dir: path.join(f.dir, 'team'), billing: raised, sdk: again.sdk});
  assert.deepEqual([r2.status, r2.concluded, r2.team === r1.team, again.calls.map(c => [c.model, c.round]), r2.result.telemetry.reused], ['satisfied', true, true, [['gemini-4-carbon', 2]], 3]);
  assert.equal(raised.ledger.used('primary'), 4, 'three requests from the first run and one from the second: the count was not reset');
  assert.deepEqual(f.work.research('two').filter(x => x.phase === 'team').length, 1, 'one team, resumed, not a second one');
  assert.deepEqual(researchOf(f.work, 'two').open, []);
  // A member whose file no longer has the digest the ledger recorded is not reused.
  const g = setup(t), u2 = path.join(g.root, 'usage.jsonl');
  await runResearch({work: g.work, item: 'two', request: g.request(), repo: g.repo, dir: path.join(g.dir, 'team'), billing: optIn({primary: 3, file: u2}), sdk: scripted(TWO_READERS).sdk});
  const one = g.work.research('two').find(x => x.phase === 'node' && x.state === 'finished' && x.kind === 'specialist');
  fs.appendFileSync(path.join(g.dir, 'team', one.evidence.file), ' ');
  const third = scripted(TWO_READERS);
  const r3 = await runResearch({work: g.work, item: 'two', request: g.request(), repo: g.repo, dir: path.join(g.dir, 'team'), billing: optIn({primary: 10, file: u2}), sdk: third.sdk});
  assert.deepEqual([r3.status, third.calls.filter(c => c.specialist).length, r3.result.telemetry.reused], ['satisfied', 1, 2], 'the altered member was run again; the others were reused');
});

test('a research request names a known trigger and a real question; a request may name its role, and a trigger has a default one', t => {
  const w = openWorkLedger({root: tmp(t, 'research-request')});
  assert.throws(() => requestResearch({work: w, item: 'two', trigger: 'curiosity', question: 'How does the scheduler retry a pending stage?', by: 'owner'}), {code: 'RESEARCH_TRIGGER'});
  assert.throws(() => requestResearch({work: w, item: 'two', trigger: 'reflection', question: 'why?', by: 'owner'}), {code: 'RESEARCH_QUESTION'});
  assert.throws(() => requestResearch({work: w, item: 'two', trigger: 'reflection', question: 'How does the scheduler retry a pending stage?', role: 'implementer', by: 'owner'}), {code: 'RESEARCH_ROLE'});
  const h = requestResearch({work: w, item: 'two', trigger: 'reflection', question: 'How does the scheduler retry a pending stage?', role: 'scout', by: 'owner', at: AT});
  assert.deepEqual(researchOf(w, 'two').open.map(r => [r.hash, r.trigger, r.role, r.by, r.once]), [[h, 'reflection', 'scout', 'owner', 1]]);
  assert.deepEqual(Object.keys(ROLE_OF_TRIGGER).sort(), ['contradiction', 'insufficient-evidence', 'intake', 'invalidated-evidence', 'reflection', 'relationship', 'review-finding']);
  assert.match(researchView(w, 'two').text, /Research requested and not yet answered \(reflection, by owner\): How does the scheduler retry a pending stage\?/);
  assert.equal(researchView(w, 'other'), null);
});
