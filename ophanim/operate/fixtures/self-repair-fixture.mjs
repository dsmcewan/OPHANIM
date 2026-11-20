// FIXTURES of the self-repair lane's tests (self-repair.test.mjs, pentest/g-self-repair.test.mjs): a small git repository
// shaped like OPHANIM where it matters to the lane -- a module with a test, a mutation runner over it (read as text by T1
// and T2, run in full by validate), a pentest runner, a test lint, a stress tool and a register -- with a status ledger
// whose operator and orderer keys are FRESH SYNTHETIC keys made here (never the owner's), and scripted stage executors that
// stand in for the providers. Nothing here reaches a provider or the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {openStatusLedger} from '../../../packages/ledger/status.mjs';
import {writeRecord, recordsDirOf, LANE_ITEM} from '../self-repair.mjs';

export const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture Owner', '-c', 'user.email=owner@example.invalid', '-c', 'commit.gpgsign=false', ...a], {encoding: 'utf8'}).trim();

export const CALC_OK = 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\nexport const sep = \',\';\n';
export const CALC_BROKEN = 'export const add = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\nexport const sep = \',\';\n';
export const CALC_TEST = [
  "import {test} from 'node:test';", "import assert from 'node:assert/strict';", "import {add, mul} from '../lib/calc.mjs';",
  'const X = 3;',
  "test('adds', () => { assert.equal(add(X, X), X + X); });",
  "test('muls', () => { assert.equal(mul(X, X), X * X); });", ''].join('\n');
// A test that runs the CLI as a separate PROCESS: T1 (imports only) does not reach it, so a change it catches can land.
const CLI = "import {sep} from './calc.mjs';\nconsole.log(['a', 'b'].join(sep));\n";
const CLI_TEST = [
  "import {test} from 'node:test';", "import assert from 'node:assert/strict';", "import {execFileSync} from 'node:child_process';",
  "import {fileURLToPath} from 'node:url';",
  "test('prints', () => { assert.equal(execFileSync(process.execPath, [fileURLToPath(new URL('../lib/cli.mjs', import.meta.url))], {encoding: 'utf8'}).trim(), 'a,b'); });", ''].join('\n');
const STRINGS = "export const trim = s => s;\n";
// The mutation runner: the shape every committed runner has (MUTATIONS, --check), read as text by T1 and T2.
const RUNNER = `// The fixture's mutation runner: each mutation edits its target in place (the checkout is disposable), runs its
// deciding test, and is KILLED when that test fails. Exits 1 when any mutation survives.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const CALC = 'lib/calc.mjs';
const TEST = 'test/calc.test.mjs';
const SUITES = [TEST];
const one = (file, from, to) => ({file, from, to});
export const MUTATIONS = [
  {id: 'M1', what: 'mul divides', tests: [[TEST, '^muls$']], edits: [one(CALC, 'a * b', 'a / b')]},
];
if (process.argv.includes('--check')) { console.log(MUTATIONS.length + ' mutation(s), every target occurring exactly once'); process.exit(0); }
let exit = 0;
for (const m of MUTATIONS) {
  const keep = new Map();
  for (const e of m.edits) { const t = fs.readFileSync(e.file, 'utf8'); keep.set(e.file, t); fs.writeFileSync(e.file, t.replace(e.from, e.to)); }
  const r = spawnSync(process.execPath, ['--test', ...m.tests.map(([, p]) => '--test-name-pattern=' + p), ...new Set(m.tests.map(([f]) => f))], {encoding: 'utf8'});
  for (const [f, t] of keep) fs.writeFileSync(f, t);
  const killed = r.status !== 0;
  console.log(m.id + (killed ? ' KILLED   ' : ' SURVIVED ') + m.what);
  if (!killed) exit = 1;
}
process.exit(exit);
`;
// The pentest runner stub: a NEW hole whenever the tree carries a HOLE marker file (a repair that opens one).
const PENTEST = `import fs from 'node:fs';
console.log('=== OPHANIM PENETRATION-TEST REPORT ===');
const hole = fs.existsSync('HOLE');
if (hole) console.log('  X1-fixture-hole        NEW HOLE     the fixture hole is open');
console.log('--- summary ---');
console.log('attacks recorded: 1  (REFUSED ' + (hole ? 0 : 1) + '; registered holes 0; new holes ' + (hole ? 1 : 0) + '; known-holes-now-fixed 0)');
process.exit(hole ? 1 : 0);
`;
// The test lint stub: fails when the tree carries a LINT_FAIL marker.
const LINT = "import fs from 'node:fs';\nif (fs.existsSync('LINT_FAIL')) { console.log('1 unsuppressed finding'); process.exit(1); }\nconsole.log('0 findings');\n";
// The stress stub (the T4 interface the lane calls): runs the file N times and writes its record.
const STRESS = `import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const a = process.argv.slice(2), opt = k => a[a.indexOf(k) + 1];
const file = opt('--files'), repeat = Number(opt('--repeat')), json = opt('--json');
const rounds = [];
for (let i = 1; i <= repeat; i++) if (spawnSync(process.execPath, ['--test', file]).status !== 0) rounds.push(i);
fs.writeFileSync(json, JSON.stringify({schema: 'ophanim.toolkit.stress/v1', verdict: rounds.length ? 'FAIL' : 'PASS', repeat, byTest: rounds.length ? [{file, name: '(the file: see its problems)', rounds, pattern: rounds.length === repeat ? 'every round' : 'intermittent'}] : []}));
process.exit(rounds.length ? 1 : 0);
`;
export const REGISTER_TEXT = (rows = []) => ['# Open limitations register', '', '## Open, planned or active', '', '### The fixture', '',
  '| ID | Item | Consequence | Status |', '|---|---|---|---|', ...rows, ''].join('\n');
export const REG = {
  strings: '| KG-90 | `lib/strings.mjs` trim returns its input untrimmed. | Whitespace leaks. | open |',
  pentest: '| KG-91 | `scripts/pentest/run.mjs` reports nothing about the fixture. | A hole goes unreported. | open |',
  owner: '| KG-92 | `lib/strings.mjs` needs a policy only the owner sets. | Undecided. | pending owner |',
  nowhere: '| KG-93 | The fixture has no path for this one. | None. | open |',
};

/**
 * A fixture repository with the lane's switch as asked: `lane` is the self-repair item's state (null: no item), `items`
 * other owner-signed items. Returns {repo, statusRoot, workRoot, stateDir, records, base, S, d}.
 */
export function laneRepo(t, {lane = 'In progress', items = [], calc = CALC_BROKEN, register = [REG.strings]} = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'self-repair-'));
  t.after(() => fs.rmSync(d, {recursive: true, force: true}));
  const repo = path.join(d, 'repo');
  const files = {'lib/calc.mjs': calc, 'lib/cli.mjs': CLI, 'lib/strings.mjs': STRINGS, 'test/calc.test.mjs': CALC_TEST, 'test/cli.test.mjs': CLI_TEST, 'lib/calc.mutate.mjs': RUNNER,
    'scripts/pentest/run.mjs': PENTEST, 'scripts/test-gates/stress.mjs': STRESS, 'lint.mjs': LINT, 'docs/OPEN-LIMITATIONS.md': REGISTER_TEXT(register),
    'package.json': JSON.stringify({name: 'self-repair-fixture', private: true, type: 'module', scripts: {'test:lint': 'node lint.mjs'}}, null, 2) + '\n', '.gitignore': 'status/\n'};
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), {recursive: true}); fs.writeFileSync(path.join(repo, f), text); }
  const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work'), stateDir = path.join(repo, 'status', 'operate');
  // FRESH SYNTHETIC owner keys: openStatusLedger generates them under the fixture's own status/ledger/keys.
  const S = openStatusLedger({root: statusRoot});
  if (lane) S.set({item: LANE_ITEM, title: 'Self-repair lane', state: lane, basis: 'the owner switches the self-repair lane on (fixture)', checked: '2026-11-20'});
  for (const i of items) S.set({checked: '2026-11-20', state: 'Ready', basis: `the requirement of ${i.item}`, title: `Item ${i.item}`, ...i});
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'fixture base');
  return {d, repo, statusRoot, workRoot, stateDir, records: recordsDirOf(stateDir), base: g(repo, 'rev-parse', 'HEAD'), S};
}
/** A gate record (check.mjs --json's shape) naming `commit`, with the failing tests given as [file, name]. */
export function gateRecord(f, commit, fails, at = new Date().toISOString()) {
  return writeRecord({dir: f.records, kind: 'gate', commit, at, record: {schema: 'ophanim.test-gate/v2', verdict: fails.length ? 'FAIL' : 'PASS',
    results: [{suite: 'test', verdict: fails.length ? 'FAIL' : 'PASS', problems: fails.length ? [`fail ${fails.length} in ${fails.map(x => x[0]).join(', ')}`] : [],
      notes: fails.map(([file, name], i) => `fail: ${name} at ${file}:${4 + i} -- testCodeFailure: Expected values to be strictly equal`)}]}});
}
/** A commit on `onto` that writes `files` ({path: text | null to delete}), on no ref. */
export function commitOn(repo, onto, files, message = 'a change') {
  const index = path.join(os.tmpdir(), `sr-fixture-index-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const env = {...process.env, GIT_INDEX_FILE: index};
  try {
    execFileSync('git', ['-C', repo, 'read-tree', onto], {env});
    for (const [p, text] of Object.entries(files)) {
      if (text === null) { execFileSync('git', ['-C', repo, 'update-index', '--force-remove', p], {env}); continue; }
      const blob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], {input: text, encoding: 'utf8'}).trim();
      execFileSync('git', ['-C', repo, 'update-index', '--add', '--cacheinfo', `100644,${blob},${p}`], {env});
    }
    const tree = execFileSync('git', ['-C', repo, 'write-tree'], {env, encoding: 'utf8'}).trim();
    return g(repo, 'commit-tree', tree, '-p', onto, '-m', message);
  } finally { fs.rmSync(index, {force: true}); }
}

/**
 * SCRIPTED stage executors for a round (they stand in for the providers): the plan states the repair `plan(ctx)` gives;
 * implement writes `fix(ctx)` ({path: text}) as one commit on the round's base, on the work branch pantheon/<item>.
 * Every scripted stage reports that it passed: what the tests assert is what the LANE did with it (its reproduction
 * check, its mechanical verification, its landing), which no fixture chooses.
 */
export function scriptedRound(f, {plan, fix, onPlan = null} = {}) {
  const done = x => ({status: 'passed', outputs: {}, team: [], contributions: [], findings: [], usage: {provider_calls: 0}, ...x});
  const calls = [];
  return {
    calls,
    plan: async ctx => {
      calls.push(['plan', ctx.item]);
      if (onPlan) { const r = await onPlan(ctx); if (r) return r; }
      return done({outputs: {plan: plan(ctx)}, next: {stage: 'implement', why: 'scripted plan'}});
    },
    implement: async ctx => {
      calls.push(['implement', ctx.item]);
      const base = ctx.selfRepair.base;
      const commit = commitOn(f.repo, base, fix(ctx), `${ctx.item}: the scripted repair`);
      g(f.repo, 'update-ref', `refs/heads/pantheon/${ctx.item}`, commit);
      return done({outputs: {commit, base, branch: `pantheon/${ctx.item}`}, next: {stage: 'review', why: 'scripted implement'}});
    },
    review: async ctx => { calls.push(['review', ctx.item]); return done({outputs: {commit: ctx.upstream.outputs.commit, base: ctx.upstream.outputs.base, outcome: 'verified'}, next: {stage: 'validate', why: 'scripted review'}}); },
    validate: async ctx => { calls.push(['validate', ctx.item]); return done({outputs: {commit: ctx.upstream.outputs.commit, verdict: 'accept'}, next: {stage: 'outcome', why: 'scripted validator'}}); },
    outcome: async ctx => { calls.push(['outcome', ctx.item]); return done({outputs: {commit: ctx.upstream.outputs.commit, signed: false}, next: {stage: null, why: 'scripted outcome'}}); },
  };
}
/** The repair plan of the fixture's `adds` regression. */
export const addsPlan = ctx => ({repair: {defect: ctx.selfRepair.defect.id, root_cause: 'add subtracts its second argument where it must add it',
  reproduction: {kind: 'test', file: 'test/calc.test.mjs', name: 'adds'}}, slices: [{id: 's1', title: 'fix add', slot: 'calc', path: 'lib/calc.mjs'}]});
export const LIMITS = {total_provider_calls: 1000, stage_provider_calls: 40};
