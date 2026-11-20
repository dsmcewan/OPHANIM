// T3 manifest-reach's own tests (scripts/test-gates/manifest-reach.mjs; TOOLKIT.md), on a synthetic repository and
// synthetic manifests in the format docs/execution/check-ownership.mjs checks: a manifest that omits a test its agent's
// changes reach FAILS naming it (the lessons class brief-manifest-disagree); granting it, or declaring it held, PASSES.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {main} from './manifest-reach.mjs';
import {tempRepo, runnerText} from './fixtures/toolkit-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, 'manifest-reach.mjs');
const REPO = {
  'src/m.mjs': 'export const m = 1;\n', 'src/n.mjs': 'export const n = 1;\n',
  'src/m.test.mjs': "import {m} from './m.mjs';\n",
  'tests/reached.test.mjs': "import {m} from '../src/m.mjs';\n",
  'tests/other.test.mjs': "import {n} from '../src/n.mjs';\n",
  'tests/edits-m.mutate.mjs': runnerText({id: 'E1', target: 'src/m.mjs', test: 'tests/other.test.mjs'}),
  'tests/decided.mutate.mjs': runnerText({id: 'D1', target: 'src/n.mjs', test: 'tests/reached.test.mjs'}),
};
const OWN = ['src/m.mjs', 'src/m.test.mjs'];
const manifest = ({files = OWN, held, dependencies = ['no concurrent agent'], base, extra = {}} = {}) => ({
  schema: 'ophanim.wave-ownership/v1', coordinator_only: ['docs/execution/**'], wave: 'synthetic', base_commit: base, dependencies,
  subwaves: {S1: {'agent-one': {branch: 'x', base_commit: base, findings: [], files, new_files: [], region_limits: {}, ...(held ? {held} : {})}, ...extra}},
});
function judge(t, repo, m, ...args) {
  const file = path.join(repo.dir, `manifest-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(m));
  let text = '';
  const code = main([file, '--root', repo.dir, '--json', ...args], {out: s => { text += s; }});
  return {code, rec: JSON.parse(text).results[0]};
}
const missing = r => r.agents.flatMap(a => a.missing.map(x => x.file)).sort();

test('manifest reach: a manifest missing a reached test or runner FAILS, naming each', t => {
  const repo = tempRepo(t, REPO);
  const {code, rec} = judge(t, repo, manifest({base: repo.base}));
  assert.equal(code, 1);
  assert.equal(rec.verdict, 'FAIL');
  assert.deepEqual(missing(rec), ['tests/edits-m.mutate.mjs', 'tests/reached.test.mjs'], 'the test importing src/m.mjs and the runner editing it');
  const a = rec.agents[0];
  assert.equal(a.changeable, 1, 'src/m.mjs only: its own test is not a module it changes');
  assert.match(a.missing.find(x => x.file === 'tests/reached.test.mjs').why, /imports src\/m\.mjs/);
  assert.match(a.missing.find(x => x.file === 'tests/edits-m.mutate.mjs').why, /edits src\/m\.mjs/);
});

test('manifest reach: the reached test granted, or held (an agent field or a dependencies entry, or a sibling\'s grant), PASSES', t => {
  const repo = tempRepo(t, REPO);
  const others = r => r.agents[0].required.filter(x => x.file !== 'src/m.test.mjs').map(x => [x.file, x.status, x.by ?? null]);
  const granted = judge(t, repo, manifest({base: repo.base, files: [...OWN, 'tests/reached.test.mjs', 'tests/*.mutate.mjs']}));
  assert.equal(granted.code, 0, JSON.stringify(granted.rec.agents[0].missing));
  assert.deepEqual(granted.rec.agents[0].required.map(x => [x.file, x.status]),
    [['src/m.test.mjs', 'granted'], ['tests/reached.test.mjs', 'granted'], ['tests/edits-m.mutate.mjs', 'granted']]);
  const field = judge(t, repo, manifest({base: repo.base, held: ['tests/edits-m.mutate.mjs', {path: 'tests/reached.*', by: 'agent-two'}]}));
  assert.equal(field.code, 0, JSON.stringify(field.rec.agents[0].missing));
  assert.deepEqual(others(field.rec), [['tests/reached.test.mjs', 'held', 'agent-two'], ['tests/edits-m.mutate.mjs', 'held', null]]);
  const dep = judge(t, repo, manifest({base: repo.base, dependencies: ['prose', {held: ['tests/reached.test.mjs', 'tests/edits-m.mutate.mjs'], by: 'the jail agent'}]}));
  assert.equal(dep.code, 0, JSON.stringify(dep.rec.agents[0].missing));
  assert.deepEqual(others(dep.rec), [['tests/reached.test.mjs', 'held', 'the jail agent'], ['tests/edits-m.mutate.mjs', 'held', 'the jail agent']]);
  const sibling = judge(t, repo, manifest({base: repo.base, extra: {'agent-two': {files: ['tests/reached.test.mjs', 'tests/edits-m.mutate.mjs']}}}), '--agent', 'agent-one');
  assert.equal(sibling.code, 0, JSON.stringify(sibling.rec.agents[0].missing));
  assert.deepEqual(others(sibling.rec), [['tests/reached.test.mjs', 'held', 'agent-two'], ['tests/edits-m.mutate.mjs', 'held', 'agent-two']]);
});

test('manifest reach: a runner only decided by a reached test is advisory; a transitive test is advisory unless --transitive', t => {
  const repo = tempRepo(t, {...REPO, 'src/uses-m.mjs': "export {m} from './m.mjs';\n", 'tests/far.test.mjs': "import {m} from '../src/uses-m.mjs';\n"});
  const files = [...OWN, 'tests/reached.test.mjs', 'tests/edits-m.mutate.mjs'];
  const plain = judge(t, repo, manifest({base: repo.base, files}));
  assert.equal(plain.code, 0, JSON.stringify(plain.rec.agents[0].missing));
  assert.deepEqual(plain.rec.agents[0].rerun, [{file: 'tests/decided.mutate.mjs', decides: ['tests/reached.test.mjs']}]);
  assert.deepEqual(plain.rec.agents[0].transitive.map(x => [x.file, x.level]), [['tests/far.test.mjs', 2]]);
  const strict = judge(t, repo, manifest({base: repo.base, files}), '--transitive');
  assert.equal(strict.code, 1);
  assert.deepEqual(missing(strict.rec), ['tests/far.test.mjs']);
});

test('manifest reach: a hold named only in prose still FAILS, and says so', t => {
  const repo = tempRepo(t, REPO);
  const {code, rec} = judge(t, repo, manifest({base: repo.base, files: [...OWN, 'tests/*.mutate.mjs'], dependencies: ["reached tests held by the other agent: ['tests/reached.test.mjs']"]}));
  assert.equal(code, 1);
  assert.deepEqual(missing(rec), ['tests/reached.test.mjs']);
  assert.match(rec.agents[0].missing[0].note, /named in prose only/);
});

test('manifest reach: the base commit is read, not the working tree; the CLI exits 1 on a missing test and 2 on a bad manifest', t => {
  const repo = tempRepo(t, REPO);
  const files = [...OWN, 'tests/reached.test.mjs', 'tests/*.mutate.mjs'];
  repo.commit({'tests/later.test.mjs': "import {m} from '../src/m.mjs';\n"});
  const atBase = judge(t, repo, manifest({base: repo.base, files}));
  assert.equal(atBase.code, 0, 'a test added after the base is not one the brief could have listed');
  const atHead = judge(t, repo, manifest({base: repo.base, files}), '--ref', 'HEAD');
  assert.deepEqual(missing(atHead.rec), ['tests/later.test.mjs']);
  const file = path.join(repo.dir, 'cli.json');
  fs.writeFileSync(file, JSON.stringify(manifest({base: repo.base})));
  const cli = spawnSync(process.execPath, [TOOL, file, '--root', repo.dir], {encoding: 'utf8'});
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stdout, /MISSING test tests\/reached\.test\.mjs  \[imports src\/m\.mjs\]/);
  assert.match(cli.stdout, /: FAIL/);
  fs.writeFileSync(file, '{"schema": "not a manifest"}');
  assert.equal(spawnSync(process.execPath, [TOOL, file, '--root', repo.dir], {encoding: 'utf8'}).status, 2);
});
