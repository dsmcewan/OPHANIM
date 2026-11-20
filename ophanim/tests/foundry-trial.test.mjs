// One foundry trial (ophanim/foundry/trial.mjs): a request built by one setup through Pantheon's real pipeline and its
// real jail, then checked for what it depends on, operated and measured. SYNTHETIC: the model seats are the stand-in at
// ophanim/foundry/fixtures/fake-claude.mjs (no model, no network, no key); the request is the fixture `adder`.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {claudeCliClients} from '../foundry/claude-cli.mjs';
import {readRequest, requestRefusal} from '../foundry/request.mjs';
import {runTrial, dependencyGate} from '../foundry/trial.mjs';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const FAKE = here('../foundry/fixtures/fake-claude.mjs'), ADDER = here('../foundry/fixtures/adder/request.json');
const GOOD = 'export const add = (a, b) => a + b;\n', WRONG = 'export const add = (a, b) => a - b;\n';
const seatOf = model => ({capability: `api/anthropic/${model}`, profile: 'api', vendor: 'anthropic', model, lab: 'anthropic'});
const setupOf = (impl, rev = 'claude-opus-5-5') => ({id: `${impl}>${impl}>${rev}`, planner: seatOf(impl), implementer: seatOf(impl), reviewer: seatOf(rev), effort: null, review_independent: false});
const world = (t, script) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-trial-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script));
  const make = claudeCliClients({cli: FAKE, env: {...process.env, FAKE_CLAUDE_SCRIPT: path.join(dir, 'script.json'), FAKE_CLAUDE_LOG: path.join(dir, 'log.jsonl')}});
  const {request, seed, sha256} = readRequest(ADDER);
  return {dir, make, trial: (setup, n, over = {}) => runTrial({request: {...request, ...over}, seed, requestSha: sha256, setup, dir: path.join(dir, `trial-${n}`), makeClientFor: make, n})};
};

test('AN ACCEPTED TRIAL: built by the setup\'s implementer, verified in the jail, its dependencies allowed, operated in the jail and measured; one lab alone reviews it, so Pantheon does not ship it and the record says why', async t => {
  const w = world(t, {files: {'*': {'add.mjs': GOOD}}, cost_usd: {'claude-sonnet-5': 0.01, 'claude-opus-5-5': 0.05}});
  const r = await w.trial(setupOf('claude-sonnet-5'), 1);
  assert.deepEqual([r.schema, r.built, r.verified, r.dependencies.ok, r.accepted, r.review, r.isolation, r.error?.stage ?? null], ['ophanim.foundry.trial/v1', true, true, true, true, 'approve', 'bwrap-v1', 'ship']);
  assert.deepEqual([r.shipped, /the only approval of .* is from anthropic, the maker's own lab/.test(r.ship_why)], [false, true]);
  assert.deepEqual(r.operation, {ok: true, exit: 0, isolation: 'bwrap-v1', ms: r.operation.ms, report: {sums: 100}, score: 100, why: null});
  assert.deepEqual(r.turns.map(x => [x.purpose, x.requested, x.served]), [['plan', 'claude-sonnet-5', 'claude-sonnet-5'], ['work', 'claude-sonnet-5', 'claude-sonnet-5'], ['critique', 'claude-opus-5-5', 'claude-opus-5-5']]);
  assert.deepEqual([r.identity_ok, r.provider_calls, r.cost_usd, r.transport, r.live, r.tokens.complete, r.revisions], [true, 3, 0.07, 'claude-cli', false, true, 1]);
  assert.deepEqual(r.product, [{path: 'add.mjs', sha256: createHash('sha256').update(GOOD).digest('hex'), bytes: GOOD.length}]);
  assert.deepEqual([r.request.key, r.request.class, /^[0-9a-f]{64}$/.test(r.request.sha256), r.ms > 0, fs.existsSync(r.run_json)], ['adder', 'build/module', true, true, true]);
});

test('A PRODUCT THAT FAILS ITS ACCEPTANCE is not accepted and not operated, after the revisions the trial allows', async t => {
  const w = world(t, {files: {'*': {'add.mjs': WRONG}}});
  const r = await w.trial(setupOf('claude-haiku-4-5-20251001'), 1);
  assert.deepEqual([r.built, r.verified, r.accepted, r.operation, r.shipped], [true, false, false, null, false]);
  assert.ok(r.provider_calls >= 3 && r.error, 'the pipeline revised, then stopped with its own reason');
});

test('A PRODUCT THAT PASSES ITS ACCEPTANCE BUT NEEDS WHAT THE REQUEST DID NOT ALLOW is verified and still not accepted: each undeclared need is named with its line', async t => {
  const leaky = "import fs from 'node:fs';\nconst k = process.env.API_KEY;\nexport const add = (a, b) => a + b;\n";
  const w = world(t, {files: {'*': {'add.mjs': leaky}}});
  const r = await w.trial(setupOf('claude-sonnet-5'), 1);
  assert.deepEqual([r.verified, r.dependencies.ok, r.accepted, r.operation], [true, false, false, null]);
  assert.deepEqual(r.dependencies.refused, [{file: 'add.mjs', line: 1, kind: 'builtin', name: 'node:fs'}, {file: 'add.mjs', line: 2, kind: 'environment variable', name: 'API_KEY'}]);
  const allowed = await w.trial(setupOf('claude-sonnet-5'), 2, {allowed: {builtins: ['fs'], env: ['API_KEY']}});
  assert.deepEqual([allowed.dependencies.ok, allowed.dependencies.needs.builtins, allowed.dependencies.needs.env, allowed.accepted], [true, ['fs'], ['API_KEY'], true]);
});

test('A SERVED MODEL other than the one asked for is recorded as such; a failed operation is not an accepted product', async t => {
  const w = world(t, {files: {'*': {'add.mjs': GOOD}}, served: {'claude-sonnet-5': 'claude-haiku-4-5-20251001'}});
  const r = await w.trial(setupOf('claude-sonnet-5'), 1, {operate: {cmd: 'node seed/missing.mjs', score: 'sums'}});
  assert.deepEqual([r.identity_ok, r.turns.find(x => x.purpose === 'work').served, r.verified, r.operation.ok, r.accepted], [false, 'claude-haiku-4-5-20251001', true, false, false]);
  assert.match(r.operation.why, /the operate command exited 1/);
});

test('the dependency gate, by kind: a package, a host, a program, a file and a computed argument are each refused unless the request allows them; a relative import is the product\'s own', () => {
  const text = "import x from 'leftpad';\nimport {y} from './y.mjs';\nimport {spawnSync} from 'node:child_process';\nfetch('https://api.example.com/v1');\nspawnSync('git', ['status']);\nspawnSync(cmd);\n";
  const g = dependencyGate([{path: 'a.mjs', text}, {path: 'notes.md', text: 'import nothing'}], {});
  assert.deepEqual(g.refused.map(r => [r.line, r.kind, r.name]), [[1, 'package', 'leftpad'], [3, 'builtin', 'node:child_process'], [4, 'host', 'api.example.com'], [5, 'program', 'git'],
    [null, 'computed dependency', '1 program or path argument(s) that are computed, not written out']]);
  assert.deepEqual(g.needs.relative, ['./y.mjs']);
  assert.equal(dependencyGate([{path: 'a.mjs', text: 'export const = ;'}], {}).refused[0].kind, 'unparseable');
});

test('a request is refused for a field no stage reads, a path that leaves its directory, or a seed that is not there', () => {
  const ok = JSON.parse(fs.readFileSync(ADDER, 'utf8'));
  assert.equal(requestRefusal(ok), null);
  assert.match(requestRefusal({...ok, priority: 'high'}), /unknown field\(s\) priority/);
  assert.match(requestRefusal({...ok, files: [{slot: 'add', path: '../add.mjs'}]}), /a path inside the product/);
  assert.match(requestRefusal({...ok, files: [{slot: 'add', path: 'seed/check.mjs'}]}), /outside seed/);
  assert.match(requestRefusal({...ok, operate: {cmd: 'x', retries: 3}}), /operate is \{cmd, timeout_ms\?, score\?\}/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-request-'));
  try { fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify(ok)); assert.throws(() => readRequest(path.join(dir, 'r.json')), /its seed directory seed does not exist/); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
