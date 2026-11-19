#!/usr/bin/env node
// MUTATION RUNNER for the identity code of wave 2 (self-audit round 3, assignment 2 (sealed 449ca42), L-205: five identity
// mutations survived the suites, M1, M2, M5, M9 and M10). The reviewer's mutate.sh, adapted: every mutation is made on a
// DISPOSABLE COPY of this tree (never on the tree itself), the identity suites run there, and the mutation is undone.
//
//   node ophanim/operate/wave2-identity.mutate.mjs [--only M1,M2] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its file, the EXACT text it replaces and the replacement. The runner EXITS NON-ZERO when a target
// does not occur exactly once (the mutation would not apply, or would apply ambiguously), when the unmutated suites are
// not green, or when any mutation SURVIVES (every suite still green). Every mutation is recorded in the log directory
// (one file per mutation, plus summary.json). M1-M10 are the self-audit's mutations re-targeted at this code; M11-M22 are
// the code this wave added.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OP = ['ophanim/operate/wave2-identity.test.mjs', 'ophanim/operate/fit-lifecycle.test.mjs', 'ophanim/operate/independence.test.mjs',
  'ophanim/operate/independence-r2-a2.test.mjs', 'ophanim/operate/validator-identity.test.mjs', 'ophanim/operate/plan-lineage.test.mjs'];
const PAN = ['pantheon/tests/ledger-wave2-identity.test.mjs', 'pantheon/tests/pipeline-stage5-wave2.test.mjs', 'pantheon/tests/pipeline-stage5-confined.test.mjs',
  'pantheon/tests/independence-r2-a2.test.mjs', 'pantheon/tests/pipeline-dispatch.test.mjs', 'pantheon/tests/review-model-independence.test.mjs',
  'pantheon/tests/review-identity-policy.test.mjs', 'pantheon/tests/review-admission.test.mjs', 'pantheon/tests/ledger-review-cycle.test.mjs'];
const IDENTITY = [...OP, ...PAN];

export const MUTATIONS = [
  {id: 'M1', what: 'the fit projection of an authored row drops requested_model (round-2 Q6 fix)', file: 'ophanim/operate/stages.mjs',
    from: 'const row = {purpose: c.kind, vendor: c.vendor, model, ...(c.served_model && c.model && c.served_model !== c.model ? {requested_model: c.model} : {}),',
    to: 'const row = {purpose: c.kind, vendor: c.vendor, model,'},
  {id: 'M2', what: 'withServed returns {} (the served model of plan, change and validator finders)', file: 'ophanim/operate/stages.mjs',
    from: "const withServed = f => ({...(f.served_model && f.served_model !== f.model ? {served_model: f.served_model} : {}), ...(f.served_model_source ? {served_model_source: f.served_model_source} : {})});",
    to: 'const withServed = f => ({});'},
  {id: 'M3', what: 'Decision 6 arbiter rows removed from the implement stage\'s contributions', file: 'ophanim/operate/stages.mjs',
    from: 'const all = dedupe([...contributions, ...work, ...arbiterRows]);', to: 'const all = dedupe([...contributions, ...work]);'},
  {id: 'M4', what: 'the arbiter row drops its requested_model', file: 'ophanim/operate/stages.mjs',
    from: 'const row = {purpose: \'arbiter\', vendor: a.vendor, model, ...(a.served_model && a.model && a.served_model !== a.model ? {requested_model: a.model} : {}),',
    to: 'const row = {purpose: \'arbiter\', vendor: a.vendor, model,'},
  {id: 'M5', what: 'Stage 5 drops the PREDICTED seat of other units\' dispatchers', file: 'pantheon/src/pipeline/index.mjs',
    from: '      if (s?.vendor && s?.model) rows.push({ vendor: s.vendor, model: s.model });\n', to: ''},
  {id: 'M6', what: 'the validator\'s served-model admission returns null under the model rule', file: 'ophanim/operate/stages.mjs',
    from: 'if (byModel) return reviewerRefusal({vendor: seat.vendor, model: seat.model, served_model: served}, contributorKeys(excludes));', to: 'if (byModel) return null;'},
  {id: 'M7', what: 'agySingleTurn admits an undeclared model name', file: 'pantheon/src/sdk/agy-turn.mjs',
    from: 'if (!made?.known || made.lab !== "google") {', to: 'if (made?.known && made.lab !== "google") {', tests: ['pantheon/tests/agy-single-turn.test.mjs', ...IDENTITY]},
  {id: 'M8', what: 'pipeline single() labels an unmarked served name "provider"', file: 'pantheon/src/pipeline/turns.mjs',
    from: 'served_model_source: r?.served_model_source ?? (named ? "unknown" : null), response_id: r?.response_id ?? null };', to: 'served_model_source: r?.served_model_source ?? (named ? "provider" : null), response_id: r?.response_id ?? null };',
    tests: ['pantheon/tests/pipeline-turns.test.mjs', ...IDENTITY]},
  {id: 'M9', what: 'contributorRows records the asked name only', file: 'pantheon/src/ledger/review-cycle.mjs',
    from: 'const names = [...new Set([c.model, c.served_model, c.requested_model].filter(Boolean))];', to: 'const names = [...new Set([c.requested_model ?? c.model].filter(Boolean))];'},
  {id: 'M10', what: 'the planner\'s served models (answer and retrieval rounds) are no longer recorded as contributors', file: 'ophanim/operate/stages.mjs',
    from: '          for (const x of served) {\n', to: '          for (const x of []) {\n'},
  {id: 'M11', what: 'investigate() no longer admits earlier retrieval rounds', file: 'ophanim/operate/context.mjs',
    from: "    if (typeof admit === 'function') {", to: '    if (false) {'},
  {id: 'M12', what: 'a reviewer\'s admitted retrieval rounds are not recorded on the cycle ledger', file: 'pantheon/src/ledger/review-cycle.mjs',
    from: 'for (const x of Array.isArray(r.rounds) ? r.rounds : []) {', to: 'for (const x of []) {'},
  {id: 'M13', what: 'the ledger no longer admits a review\'s retrieval rounds', file: 'pantheon/src/ledger/lineage-kinds.mjs',
    from: '    const why = roundRefusal(c, r.payload, lab);\n    if (why) return why;\n', to: ''},
  {id: 'M14', what: 'the validator no longer excludes the passing change review\'s reviewers (L-002)', file: 'ophanim/operate/stages.mjs',
    from: 'const excludes = byModel ? [...allContribs, ...reviewerRows] : allContribs;', to: 'const excludes = allContribs;'},
  {id: 'M15', what: 'the returned unit\'s finding carries no lab (L-001; register L-114)', file: 'ophanim/operate/stages.mjs',
    from: '              lab: d.vendor && served ? labOf(d.vendor, served) : null};', to: '              lab: null};'},
  {id: 'M16', what: 'the ledger accepts any served_model_source (L-204)', file: 'pantheon/src/ledger/lineage-kinds.mjs',
    from: "        ? servedSourceRefusal(p) : 'a turn names its seat, requested and served model, and reply'),", to: "        ? null : 'a turn names its seat, requested and served model, and reply'),"},
  {id: 'M17', what: 'a lab-rule cycle\'s pinned lab identity is ignored: the lab comes from the vendor again (L-204)', file: 'pantheon/src/ledger/lineage-kinds.mjs',
    from: '  if (!c?.lab_identity) return {lab: labOf(vendor, served_model ?? model)};', to: '  return {lab: labOf(vendor, served_model ?? model)};'},
  {id: 'M18', what: 'the planner need not justify a revision answering an advisory return (L-001)', file: 'ophanim/operate/stages.mjs',
    from: '    for (const f of findings.filter(isAdvisory)) {', to: '    for (const f of findings.filter(() => false)) {'},
  {id: 'M19', what: 'a v1 dispatch record\'s free text reaches the work-ledger evidence again (L-001)', file: 'ophanim/operate/context.mjs',
    from: "    return m ? `${m[1]}[dispatcher free text withheld: ${m[2].length} chars, ${sha(m[2])}]` : value;", to: '    return value;'},
  {id: 'M20', what: 'the planner is shown an advisory finding\'s recorded text instead of its validated fields (L-001)', file: 'ophanim/operate/stages.mjs',
    from: "const findingLine = f => `- ${f.id} [${f.severity}${f.cause ? `, ${f.cause}` : ''}] ${isAdvisory(f) ? advisoryText(f) : f.text}`;",
    to: "const findingLine = f => `- ${f.id} [${f.severity}${f.cause ? `, ${f.cause}` : ''}] ${f.text}${isAdvisory(f) ? ' ' + JSON.stringify(f) : ''}`;"},
  {id: 'M21', what: 'a judge\'s work-ledger evidence shows an advisory finding\'s recorded text instead of its validated fields (L-001)', file: 'ophanim/operate/context.mjs',
    from: "      if (advisory && k === 'text') { out.text = advisoryText(value); continue; }", to: ''},
  {id: 'M22', what: 'a review finding\'s citations are no longer bound to the versions its reviewer was given (L-107)', file: 'ophanim/operate/stages.mjs',
    from: "    ...(bind && r ? {sources: bind(r, cited)} : {})};", to: '  };'},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
function copyTree(dest) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], {encoding: 'utf8', maxBuffer: 1 << 28}).split('\0').filter(Boolean);
  for (const f of files) {
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), {recursive: true});
    fs.copyFileSync(from, path.join(dest, f));
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
  // A repository of its own (some suites read the repository they run in); nothing here touches this tree's git.
  const g = (...a) => execFileSync('git', ['-C', dest, ...a], {stdio: 'ignore'});
  g('init', '-q', '-b', 'main'); g('-c', 'user.name=mutation', '-c', 'user.email=mutation@example.invalid', 'add', '-A');
  g('-c', 'user.name=mutation', '-c', 'user.email=mutation@example.invalid', 'commit', '-q', '-m', 'mutation copy');
}
const runSuites = (dir, tests, logFile) => {
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=6', ...tests], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}});
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'),
    failed: [...new Set(out.split('\n').filter(l => /^✖ /.test(l) && !/failing tests/.test(l)).map(l => l.replace(/ \(\d+(\.\d+)?ms\)$/, '')))]};
};

const only = arg('--only')?.split(',') ?? null;
const logDir = path.resolve(arg('--log', path.join(os.tmpdir(), `wave2-identity-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const chosen = MUTATIONS.filter(m => !only || only.includes(m.id));
// Every target must apply EXACTLY ONCE on this tree, before anything is run.
const bad = chosen.map(m => ({m, n: fs.readFileSync(path.join(ROOT, m.file), 'utf8').split(m.from).length - 1})).filter(x => x.n !== 1);
if (bad.length) {
  for (const {m, n} of bad) console.error(`${m.id}: the target occurs ${n} time(s) in ${m.file}; a mutation applies exactly once`);
  process.exit(2);
}
if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation target(s), each occurring exactly once`); process.exit(0); }
// NOT under /tmp: the agy worker jail mounts a fresh tmpfs there, so a tree copied under /tmp cannot run its own fake CLI.
const copyRoot = path.resolve(arg('--copy-root', os.homedir()));
const copy = fs.mkdtempSync(path.join(copyRoot, 'wave2-identity-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, [...new Set([...IDENTITY, ...chosen.flatMap(m => m.tests ?? [])])], path.join(logDir, 'baseline.log'));
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled) { console.error('the unmutated suites are not green: no mutation result would mean anything'); process.exit(3); }
  for (const m of chosen) {
    const file = path.join(copy, m.file), orig = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, orig.replace(m.from, () => m.to));
    if (fs.readFileSync(file, 'utf8') === orig) { console.error(`${m.id}: MUTATION DID NOT APPLY`); exit = 2; continue; }
    const r = runSuites(copy, m.tests ?? IDENTITY, path.join(logDir, `${m.id}.log`));
    fs.writeFileSync(file, orig);
    const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0 || !Number.isFinite(r.tests));
    summary.push({id: m.id, what: m.what, file: m.file, killed, tests: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
    console.log(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  (${m.what})`);
    for (const f of r.failed.slice(0, 4)) console.log(`    ${f.slice(0, 200)}`);
    if (!killed) exit = 1;
  }
} finally {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({root: ROOT, mutations: summary}, null, 2) + '\n');
  fs.rmSync(copy, {recursive: true, force: true});
}
console.log(`${summary.filter(x => x.killed).length}/${summary.length} killed; logs in ${logDir}`);
process.exit(exit);
