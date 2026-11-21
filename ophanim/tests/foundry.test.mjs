// The foundry (ophanim/foundry/foundry.mjs, setups.mjs, graph.mjs): one request from observation to an operated,
// measured product, with the capability graph choosing the setups and keeping what they measured. SYNTHETIC: the model
// seats are the stand-in at ophanim/foundry/fixtures/fake-claude.mjs (no model, no network, no key); the pipeline, the
// jail and the graph are the real ones.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {claudeCliClients} from '../foundry/claude-cli.mjs';
import {runFoundry, readTrials, chooseArms, STAGES} from '../foundry/foundry.mjs';
import {candidateSetups, rankSetups, CRITERION} from '../foundry/setups.mjs';
import {foundryGraph, measuredSetups, FOUNDRY_TOOL} from '../foundry/graph.mjs';
import {capabilitySnapshot, currentRegistries, E} from '../../pantheon/src/capability/graph.mjs';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const FAKE = here('../foundry/fixtures/fake-claude.mjs'), ADDER = here('../foundry/fixtures/adder/request.json');
const SONNET = 'claude-sonnet-5', HAIKU = 'claude-haiku-4-5-20251001', OPUS = 'claude-opus-5-5';
const GOOD = 'export const add = (a, b) => a + b;\n', WRONG = 'export const add = (a, b) => a - b;\n';
const SNAP = capabilitySnapshot(currentRegistries());
const anthropicOnly = s => s.vendor === 'anthropic' && s.profile === 'api';
const idOf = (impl, rev = OPUS) => `${impl}>${impl}>${rev}`;
const world = (t, script) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'script.json'), set = s => fs.writeFileSync(file, JSON.stringify(s));
  set(script);
  const make = claudeCliClients({cli: FAKE, env: {...process.env, FAKE_CLAUDE_SCRIPT: file}, maxUsd: 100});
  const run = (over = {}) => runFoundry({requestFile: ADDER, state: path.join(dir, 'state'), makeClients: () => make, reachable: anthropicOnly, implementers: [SONNET, HAIKU], reviewer: OPUS, observed_at: '2026-11-20T12:00:00.000Z', ...over});
  return {dir, state: path.join(dir, 'state'), run, set};
};

test('SETUPS COME FROM THE CAPABILITY GRAPH: one per eligible, reachable implementer; the reviewer is of another lab when one is reachable, and otherwise another model of the same lab, said to be not independent', () => {
  const one = candidateSetups({snapshot: SNAP, reachable: anthropicOnly});
  assert.ok(one.setups.length >= 3 && one.setups.every(s => s.implementer.vendor === 'anthropic' && s.reviewer.vendor === 'anthropic' && s.reviewer.model !== s.implementer.model));
  assert.deepEqual([...new Set(one.setups.map(s => s.review_independent))], [false]);
  assert.match(one.setups[0].review_note, /no capability of a lab other than anthropic is reachable here: the reviewer is another model of the same lab, which is not an independent review/);
  assert.deepEqual(Object.keys(one.decisions).sort(), ['implementer', 'planner', 'reviewer']);
  assert.ok(one.decisions.implementer.eligible > one.setups.length && one.unreachable.length > 0 && /^sha256:[0-9a-f]{64}$/.test(one.decisions.implementer.digest), 'what the graph admits and this environment cannot reach is listed');
  const two = candidateSetups({snapshot: SNAP, reachable: s => s.profile === 'api' && ['anthropic', 'xai'].includes(s.vendor), implementers: [SONNET]});
  assert.deepEqual([two.setups.length, two.setups[0].reviewer.lab !== 'anthropic', two.setups[0].review_independent, two.setups[0].review_note], [1, true, true, null]);
  assert.throws(() => candidateSetups({snapshot: SNAP, reachable: anthropicOnly, implementers: ['gpt-6-sol']}), /gpt-6-sol is not an eligible, reachable implementer in the capability graph/);
  assert.deepEqual(candidateSetups({snapshot: SNAP, reachable: anthropicOnly, implementers: [SONNET], efforts: ['low', 'high']}).setups.map(s => s.id.replace(/^.*@/, '@')), ['@low', '@high']);
});

test('THE CRITERION orders by the share accepted, then the operation score, then the median time of the accepted trials, then cost; fewer than three accepted trials a setup is said to be not established', () => {
  const t = (id, accepted, ms, cost, score = 100) => ({setup: {id}, accepted, ms, cost_usd: cost, operation: accepted ? {score} : null, tokens: {input: 10, output: 5}});
  const r = rankSetups([t('slow', true, 900, 0.01), t('fast', true, 300, 0.05), t('fast', true, 500, 0.05), t('broken', false, 100, 0.001), t('half', true, 100, 0.001), t('half', false, 100, 0.001), t('better', true, 2000, 1, 200)]);
  assert.deepEqual(r.ranked.map(x => [x.setup, x.trials, x.accepted, x.median_ms]), [['better', 1, 1, 2000], ['fast', 2, 2, 400], ['slow', 1, 1, 900], ['half', 2, 1, 100], ['broken', 1, 0, null]]);
  assert.deepEqual([r.winner, r.sufficient, r.criterion], ['better', false, CRITERION]);
  assert.match(r.why, /fewer than 3 accepted trials for at least one setup: the order is what was measured so far, not an established difference/);
  const enough = rankSetups([1, 2, 3].flatMap(i => [t('a', true, 100 * i, 0.01), t('b', true, 50 * i, 0.01)]));
  assert.deepEqual([enough.winner, enough.sufficient], ['b', true]);
  assert.deepEqual([rankSetups([t('x', false, 1, 1)]).winner, rankSetups([]).why], [null, 'no trial is recorded']);
});

test('ONE REQUEST THROUGH EVERY STAGE, two setups against each other: both are built, verified in the jail and operated; the faster accepted one wins; what each measured is on the graph, joined to the implementer\'s capability', async t => {
  // The stand-in answers the sonnet seat 1.2 s late on every turn, so the haiku setup's trial is the faster by seconds, not by noise.
  const w = world(t, {files: {'*': {'add.mjs': GOOD}}, delay_ms: {[SONNET]: 1200}, cost_usd: {[SONNET]: 0.02, [HAIKU]: 0.001, [OPUS]: 0.05}});
  const r = await w.run();
  assert.deepEqual([...new Set(r.stages.map(s => s.stage))], STAGES);
  const stage = name => r.stages.filter(s => s.stage === name);
  assert.deepEqual(stage('plan')[0].arms, [SONNET, HAIKU].map(m => ({setup: idOf(m), basis: 'not yet measured for this class of task', review_independent: false})));
  assert.deepEqual([stage('investigate')[0].measured, stage('investigate')[0].capability_snapshot, stage('observe')[0].earlier_trials], [[], SNAP.digest, 0]);
  assert.deepEqual(stage('verify').map(s => [s.trial, s.verified, s.isolation, s.review, s.shipped, s.dependencies.ok]), [[1, true, 'bwrap-v1', 'approve', false, true], [2, true, 'bwrap-v1', 'approve', false, true]]);
  assert.deepEqual(stage('operate').map(s => [s.trial, s.ok, s.score]), [[1, true, 100], [2, true, 100]]);
  const learn = stage('learn')[0];
  assert.deepEqual([learn.winner, learn.sufficient, learn.ranking.map(x => [x.setup, x.trials, x.accepted]), r.winner], [idOf(HAIKU), false, [[idOf(HAIKU), 1, 1], [idOf(SONNET), 1, 1]], idOf(HAIKU)]);
  assert.ok(learn.ranking[0].median_ms < learn.ranking[1].median_ms && learn.ranking[0].median_cost_usd < learn.ranking[1].median_cost_usd);
  assert.deepEqual(learn.stated_on_graph.map(m => [m.setup, m.measures, m.trials, m.accepted, /^SYNTHETIC: 1 of 1 trial\(s\) were not served by a live model$/.test(m.uncertainty)]),
    [[idOf(HAIKU), [E('capability', `api/anthropic/${HAIKU}`)], 1, 1, true], [idOf(SONNET), [E('capability', `api/anthropic/${SONNET}`)], 1, 1, true]]);
  // The product is the winner's, written out with what stands behind it; it is accepted, not shipped, and its review was not independent.
  const p = JSON.parse(fs.readFileSync(path.join(r.product.dir, 'PRODUCT.json'), 'utf8'));
  assert.deepEqual([p.trial, p.setup, p.accepted, p.shipped, p.review_independent, p.live, p.verified_by, fs.readFileSync(path.join(r.product.dir, 'add.mjs'), 'utf8')],
    [2, idOf(HAIKU), true, false, false, false, 'node seed/check.mjs exited 0 in bwrap-v1', GOOD]);
  assert.match(p.ship_why, /the maker's own lab/);
  assert.deepEqual([r.trials, readTrials(w.state).map(x => x.n), r.spent_usd, fs.existsSync(path.join(w.state, 'runs', '0001.json'))], [[1, 2], [1, 2], 0.142, true]);

  // THE NEXT RUN STARTS FROM WHAT WAS MEASURED: with one arm, the graph's best setup for this class is the one tried.
  const again = await w.run({arms: 1});
  const inv = again.stages.find(s => s.stage === 'investigate'), plan = again.stages.find(s => s.stage === 'plan');
  assert.deepEqual([inv.measured.map(m => [m.setup, m.trials, m.accepted]), plan.arms], [[[idOf(HAIKU), 1, 1], [idOf(SONNET), 1, 1]],
    [{setup: idOf(HAIKU), basis: 'the best setup measured so far for this class of task', review_independent: false}]]);
  assert.deepEqual([again.n, again.trials, again.stages.find(s => s.stage === 'learn').ranking.map(x => [x.setup, x.trials])], [2, [3], [[idOf(HAIKU), 2], [idOf(SONNET), 1]]]);
});

test('A SETUP WHOSE PRODUCT FAILS loses to one whose product is accepted, however fast it failed; with no accepted product there is no winner and no product', async t => {
  const w = world(t, {files: {[HAIKU]: {'add.mjs': WRONG}, '*': {'add.mjs': GOOD}}, delay_ms: {[SONNET]: 600}});
  const r = await w.run();
  const learn = r.stages.find(s => s.stage === 'learn');
  assert.deepEqual([learn.winner, learn.ranking.map(x => [x.setup, x.accepted]), r.product.setup], [idOf(SONNET), [[idOf(SONNET), 1], [idOf(HAIKU), 0]], idOf(SONNET)]);
  assert.deepEqual(r.stages.filter(s => s.stage === 'operate').map(s => [s.trial, s.operated]), [[1, true], [2, false]]);
  const none = world(t, {files: {'*': {'add.mjs': WRONG}}});
  const n = await none.run({arms: 1});
  assert.deepEqual([n.winner, n.product, n.stages.find(s => s.stage === 'learn').next], [null, null, 'no setup has an accepted product for this class yet']);
});

test('REWORK: an accepted product whose reviewer requested changes is built again by the same setup with the previous revision and the review in hand; the rework is recorded against its parent and never ranked with first builds; the product is the approved revision', async t => {
  const BETTER = 'export const add = (a, b) => Number(a) + Number(b);\n';
  const w = world(t, {files: {'*': {'add.mjs': GOOD}}, files_rework: {'*': {'add.mjs': BETTER}}, findings: {'*': 'add("1", 2) returns "12".'}, verdict: {'*': 'request_changes'}, verdict_if: [{contains: 'Number(a) + Number(b)', verdict: 'approve'}]});
  const r = await w.run({arms: 1, implementers: [SONNET], rework: 2});
  const learn = r.stages.find(s => s.stage === 'learn'), trials = readTrials(w.state);
  assert.deepEqual(trials.map(x => [x.n, x.rework_of, x.accepted, x.review]), [[1, null, true, 'request_changes'], [2, 1, true, 'approve']], 'one rework round was enough: the second is not run');
  assert.deepEqual(learn.rework, [{trial: 2, of: 1, accepted: true, review: 'approve', score: 100, before: {review: 'request_changes', score: 100}}]);
  assert.deepEqual([learn.ranking.map(x => [x.setup, x.trials]), r.product.trial, r.product.review, r.product.rework_of, fs.readFileSync(path.join(r.product.dir, 'add.mjs'), 'utf8')], [[[idOf(SONNET), 1]], 2, 'approve', 1, BETTER]);
  const none = world(t, {files: {'*': {'add.mjs': GOOD}}, verdict: {'*': 'request_changes'}});
  const kept = await none.run({arms: 1, implementers: [SONNET]});
  assert.deepEqual([kept.trials, kept.product.review, kept.product.accepted], [[1], 'request_changes', true], 'with no rework asked for, the product is written out with its reviewer\'s verdict as it stands');
});

test('a trial whose served model was not the one asked for is recorded and left out of the ranking and of the graph', async t => {
  const w = world(t, {files: {'*': {'add.mjs': GOOD}}, served: {[SONNET]: HAIKU}});
  const r = await w.run({implementers: [SONNET], arms: 1});
  const learn = r.stages.find(s => s.stage === 'learn');
  assert.deepEqual([learn.ranking, learn.left_out, learn.stated_on_graph, r.winner, readTrials(w.state).length], [[], [{trial: 1, why: 'the served model was not the one asked for'}], [], null, 1]);
});

test('chooseArms: the best measured setup with an accepted product leads, setups not yet measured come next, and a measured setup that never produced one is last', () => {
  const s = id => ({id}), m = (setup, accepted, ms) => ({setup, accepted, accepted_rate: accepted ? 1 : 0, median_ms: ms, median_cost_usd: 0, operation_score: null});
  const arms = chooseArms([s('a'), s('b'), s('c'), s('d')], [m('a', 1, 900), m('b', 1, 300), m('d', 0, null)], 4);
  assert.deepEqual(arms.map(a => [a.setup.id, a.basis]), [['b', 'the best setup measured so far for this class of task'], ['c', 'not yet measured for this class of task'], ['a', 'measured before, tried again'], ['d', 'measured before, tried again']]);
  assert.deepEqual(chooseArms([s('a'), s('b')], [], 1).map(a => a.setup.id), ['a']);
});

test('the graph is re-derived from the trial records: Pantheon\'s own capability metrics and the foundry\'s setup observations are written by their registered tools, and nothing qualifies anything', async t => {
  const w = world(t, {files: {'*': {'add.mjs': GOOD}}});
  await w.run({arms: 1, implementers: [SONNET]});
  const g = foundryGraph({trials: readTrials(w.state), observed_at: '2026-11-20T12:00:00.000Z'});
  t.after(g.close);
  const v = g.view(), cap = E('capability', `api/anthropic/${SONNET}`), measuring = v.edgesOf(cap, {types: ['measures']}).map(e => v.assertion(e.assertions[0]).origin).sort();
  assert.deepEqual(measuring, [FOUNDRY_TOOL, 'pantheon.capability.metrics']);
  assert.deepEqual([g.metrics.capabilities[`api/anthropic/${SONNET}`].latency_ms.n, g.metrics.coverage.synthetic_runs, g.metrics.coverage.live_runs], [2, 1, 0]);
  assert.deepEqual([measuredSetups(v, 'build/module').length, measuredSetups(v, 'build/other')], [1, []]);
  assert.deepEqual(v.edgesOf(E('role', 'implementer'), {types: ['qualified-for']}), []);
});

test('the command line: build prints the run record and exits 0 with a product; status re-derives what is measured and spends nothing; a refused request exits 1 with the reason; a malformed command exits 2', async t => {
  const {main} = await import('../foundry/cli.mjs');
  const w = world(t, {files: {'*': {'add.mjs': GOOD}}, cost_usd: {'*': 0.01}});
  const make = claudeCliClients({cli: FAKE, env: {...process.env, FAKE_CLAUDE_SCRIPT: path.join(w.dir, 'script.json')}, maxUsd: 100});
  const call = async (...argv) => { let out = '', err = ''; const code = await main(argv, {out: s => { out += s; }, err: s => { err += s; }, clients: () => make, live: false}); return {code, out, err}; };
  const built = await call('build', '--request', ADDER, '--state', w.state, '--arms', '1', '--implementers', SONNET, '--reviewer', OPUS);
  assert.deepEqual([built.code, JSON.parse(built.out).winner, JSON.parse(built.out).spent_usd], [0, idOf(SONNET), 0.03]);
  const before = make.spent().usd, status = await call('status', '--state', w.state);
  const s = JSON.parse(status.out);
  assert.deepEqual([status.code, s.trials, s.live_trials, s.spent_usd, s.classes.map(c => [c.class, c.ranking.winner, c.on_graph.length]), make.spent().usd === before], [0, 1, 0, 0.03, [['build/module', idOf(SONNET), 1]], true]);
  const bad = path.join(w.dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({schema: 'ophanim.foundry.request/v1', key: 'x'}));
  const refused = await call('build', '--request', bad, '--state', path.join(w.dir, 'other'));
  assert.deepEqual([refused.code, JSON.parse(refused.out).error], [1, 'FOUNDRY_REFUSED']);
  const usage = await call('build', '--state', w.state);
  assert.deepEqual([usage.code, usage.out, /^usage: node ophanim\/foundry\/cli\.mjs build /.test(usage.err), (await call('build', '--request', ADDER, '--state', w.state, '--arms', 'two')).code], [2, '', true, 2]);
});

test('--seats all drives the build through the composed multi-lab provider: a reachable lab builds, an unreachable one is admitted by the graph but never served; --seats bogus is a usage error', async t => {
  const {main} = await import('../foundry/cli.mjs');
  const w = world(t, {files: {'*': {'add.mjs': GOOD}}, cost_usd: {'*': 0.01}});
  const make = claudeCliClients({cli: FAKE, env: {...process.env, FAKE_CLAUDE_SCRIPT: path.join(w.dir, 'script.json')}, maxUsd: 100});
  // Two transports: the Claude seat reachable, the API seat present but not reachable here (no SDK/key). composeSeats
  // must build only through the reachable one; the openai/xai setups the graph admits are left unserved.
  const transports = [
    {id: 'claude-cli', vendors: ['anthropic'], live: false, reachable: () => true, make: () => make},
    {id: 'live-api', vendors: ['openai', 'xai'], live: true, reachable: () => false, make: () => { throw new Error('the API seat must not be built when unreachable'); }},
  ];
  const call = async (...argv) => { let out = '', err = ''; const code = await main(argv, {out: s => { out += s; }, err: s => { err += s; }, transports, live: false, progress: () => {}}); return {code, out, err}; };
  const built = await call('build', '--seats', 'all', '--request', ADDER, '--state', w.state, '--arms', '1', '--implementers', SONNET, '--reviewer', OPUS);
  assert.deepEqual([built.code, JSON.parse(built.out).winner], [0, idOf(SONNET)], 'the composed provider built the product through the one reachable lab');
  const bogus = await call('build', '--seats', 'bogus', '--request', ADDER, '--state', path.join(w.dir, 'o2'));
  assert.deepEqual([bogus.code, /^usage:/.test(bogus.err)], [2, true]);
});
