#!/usr/bin/env node
// MUTATION RUNNER for wave 2, sub-wave 2b (self-audit round 3, assignment 3 (sealed bb1287a): L-303 the cross-process
// repository lock, L-304 a dead attempt's integration branch, L-301 per-request charging, L-308 budget stops by code,
// L-121 the CLI's and the service's stop). Built like wave2-identity.mutate.mjs: every mutation is made on a DISPOSABLE
// COPY of this tree (never on the tree itself), the suites run there, and the mutation is undone.
//
//   node ophanim/operate/reliability-wave2b.mutate.mjs [--only K1,C2] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its file, the EXACT text it replaces and the replacement. The runner EXITS NON-ZERO when a target
// does not occur exactly once, when the unmutated suites are not green, or when any mutation SURVIVES (every suite
// still green). Every mutation is recorded in the log directory (one log per mutation, plus summary.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OP = ['ophanim/operate/reliability-wave2b.test.mjs', 'ophanim/operate/cli-stop-wave2b.test.mjs', 'ophanim/operate/exec-reliability-a3.test.mjs',
  'ophanim/operate/exec-reliability.test.mjs', 'ophanim/operate/reliability-r3-a3.test.mjs', 'ophanim/operate/scheduler.test.mjs', 'ophanim/operate/service.test.mjs',
  'ophanim/operate/cli.test.mjs', 'ophanim/operate/stages.test.mjs'];
const PAN = ['pantheon/tests/pipeline-repo-lock.test.mjs', 'pantheon/tests/pipeline-dead-branch.test.mjs', 'pantheon/tests/pipeline-charge-per-request.test.mjs',
  'pantheon/tests/pipeline-ladder.test.mjs', 'pantheon/tests/pipeline-exec-reliability.test.mjs', 'pantheon/tests/pipeline-exec-reliability-a3.test.mjs',
  'pantheon/tests/reliability-r2-a3.test.mjs', 'pantheon/tests/reliability-r2-a3-rest.test.mjs', 'pantheon/tests/pipeline-run.test.mjs', 'pantheon/tests/pipeline-resume.test.mjs'];
const SUITES = [...OP, ...PAN];
const GIT = 'pantheon/src/pipeline/git.mjs', IDX = 'pantheon/src/pipeline/index.mjs', DSP = 'pantheon/src/pipeline/dispatch.mjs', STG = 'ophanim/operate/stages.mjs';

export const MUTATIONS = [
  // ---- L-303: the cross-process lock
  {id: 'K1', what: 'repoMutex no longer takes the cross-process file lock (in-process only, as at 58c02d3)', file: GIT,
    from: '      return withFileLock(f, fn, { timeout_ms });', to: '      return fn();'},
  {id: 'K2', what: 'a held lock is taken anyway (link EEXIST reads as acquired)', file: GIT,
    from: 'catch (e) { if (e?.code === "EEXIST") return false; throw e; }', to: 'catch (e) { if (e?.code === "EEXIST") return true; throw e; }'},
  {id: 'K3', what: 'a reused pid (another start time) is judged live', file: GIT,
    from: '  if (now !== null && now !== h.start) return `pid ${h.pid} now belongs to another process (start ${now}, not ${h.start})`;', to: ''},
  {id: 'K4', what: 'another host\'s holder is judged from here (dead pid -> stale)', file: GIT,
    from: '  if (h.host !== HOST) return null;                                   // another host\'s: never judged from here', to: ''},
  {id: 'K5', what: 'breaking a stale lock removes whatever lock is there (no re-read of its token)', file: GIT,
    from: '    if (now !== undefined && (now === null ? seen === null : now.token === seen?.token)) unlinkSync(file);', to: '    if (now !== undefined) unlinkSync(file);'},
  {id: 'K6', what: 'a holder releases the lock even when it is no longer its own', file: GIT,
    from: '  finally { try { if (readLock(file)?.token === me.token) unlinkSync(file); } catch { /* gone */ } }', to: '  finally { try { unlinkSync(file); } catch { /* gone */ } }'},
  {id: 'K7', what: 'bindWorktree\'s default lock is no lock (58c02d3)', file: DSP,
    from: 'export async function bindWorktree({ repo, base, path, upstream = [], lock = repoMutex(repo) }) {', to: 'export async function bindWorktree({ repo, base, path, upstream = [], lock = fn => fn() }) {'},
  {id: 'K8', what: 'releaseWorktree\'s default lock is no lock (58c02d3)', file: DSP,
    from: 'export async function releaseWorktree({ repo, path, lock = repoMutex(repo) }) {', to: 'export async function releaseWorktree({ repo, path, lock = fn => fn() }) {'},
  {id: 'K9', what: 'orphan recovery\'s default lock is no lock', file: IDX,
    from: 'export async function recoverOrphanWorktrees({ repo, root, lock = repoMutex(repo) }) {', to: 'export async function recoverOrphanWorktrees({ repo, root, lock = fn => fn() }) {'},
  {id: 'K10', what: 'the integration worktree is added outside the lock', file: IDX,
    from: '    await lock(() => git(repo, ["worktree", "add", "-q", "-b", branch, integrationPath, run.base.commit]));', to: '    await git(repo, ["worktree", "add", "-q", "-b", branch, integrationPath, run.base.commit]);'},
  // ---- L-304: a dead attempt's integration branch
  {id: 'B1', what: 'a FINISHED run\'s branch is deleted too', file: IDX,
    from: '  if (rec && rec.status !== "running") return { branch: rec.integration?.branch ?? null, deleted: false, why: `the run ended ${rec.status}: its branch is kept` };', to: ''},
  {id: 'B2', what: 'a LIVE run\'s branch is deleted too', file: IDX,
    from: '    if (holder) return { branch, deleted: false, why: `held by a live run (pid ${holder.pid} on ${holder.host})` };', to: ''},
  {id: 'B3', what: 'any run_id names the branch (a "/" reaches another ref)', file: IDX,
    from: 'if (typeof run_id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(run_id))', to: 'if (typeof run_id !== "string")'},
  {id: 'B4', what: 'the implement stage\'s recovery no longer deletes a dead attempt\'s branch (58c02d3)', file: STG,
    from: '        const b = await recoverDeadRunBranch({repo: top, dir: d});', to: '        const b = {deleted: false};'},
  // ---- L-301: the pipeline's admission
  {id: 'C1', what: 'a turn that admitted nothing is not charged on return (a scripted or older seat\'s call is dropped)', file: IDX,
    from: '    if (admitted === 0) late(role);', to: ''},
  {id: 'C2', what: 'turns in flight do not hold the bound (no reservation)', file: IDX,
    from: '    if (run.provider_calls.total + reserved >= lim.max_provider_calls) {', to: '    if (run.provider_calls.total >= lim.max_provider_calls) {'},
  {id: 'C3', what: 'the first call is charged up front again (58c02d3), then admitted at spend too', file: IDX,
    from: '    const admitRequest = ({ kind } = {}) => take(', to: '    admit(role); admitted += 1; const admitRequest = ({ kind } = {}) => take('},
  {id: 'C4', what: 'a metered failover is counted as the seat\'s own role', file: IDX,
    from: 'kind === "failover" ? "metered_failover" : kind === "subagent"', to: 'kind === "subagent"'},
  {id: 'C5', what: 'the older charge() no longer admits the turn\'s own first call', file: IDX,
    from: 'const charge = what => { if (admitted === 0) take(role); take(', to: 'const charge = what => { take('},
  // ---- L-301 / L-308: the stage meter
  {id: 'S1', what: 'the stage meter does not charge a reply that admitted nothing', file: STG,
    from: '        if (admitted === 0) {', to: '        if (false) {'},
  {id: 'S2', what: 'the stage meter charges the first call up front (58c02d3)', file: STG,
    from: '    try { closed(who); } catch (e) { return Promise.reject(e); }', to: '    try { admit(who); } catch (e) { return Promise.reject(e); }'},
  {id: 'S3', what: 'the stage meter\'s turns in flight do not hold the budget', file: STG,
    from: '    if (m.made + reserved >= m.limit) {', to: '    if (m.made >= m.limit) {'},
  {id: 'S4', what: 'an investigation stopped by "may I ask again" records no budget stop', file: STG,
    from: "if (!ok) stop(who, 'PROVIDER_CALL_LIMIT');", to: ''},
  {id: 'S5', what: 'budget stops are classified by the words of the reason again (58c02d3)', file: STG,
    from: 'const hit = rows.filter(w => BUDGET_STOP.has(w?.code)).map(w => w.why);', to: "const hit = rows.filter(w => /PROVIDER_CALL_LIMIT|the stage's provider-call budget/.test(w?.why ?? '')).map(w => w.why);"},
  {id: 'S6', what: 'a validator out of budget is a validation defect again (58c02d3)', file: STG,
    from: '    if (!judged && vHit.length && (m.refused > 0 || m.left() <= 1)) {', to: '    if (false) {'},
  {id: 'S7', what: 'the older charge() no longer admits the turn\'s own first call (stage meter)', file: STG,
    from: 'const charge = () => { if (admitted === 0) take(); take(); };', to: 'const charge = () => { take(); };'},
  {id: 'S8', what: 'the review investigation\'s budget is no longer tied to the seat (canAsk without the meter\'s record)', file: STG,
    from: 'canAsk: () => m.canAsk(reserve, {vendor, model})', to: 'canAsk: () => m.left() > reserve'},
  // ---- L-121: the stop
  {id: 'T1', what: '`tick` is not given the interrupt (58c02d3)', file: 'ophanim/operate/cli.mjs',
    from: 'try { t = await tick({...common, issues, interrupt: stop.signal}); }', to: 'try { t = await tick({...common, issues}); }'},
  {id: 'T2', what: '`watch` passes no interrupt to its ticks (58c02d3)', file: 'ophanim/operate/cli.mjs',
    from: 'once: !!opts.once, signal: stop.signal, interrupt: stop.signal}); }', to: 'once: !!opts.once, signal: stop.signal}); }'},
  {id: 'T3', what: 'the service passes no interrupt to its ticks (58c02d3)', file: 'ophanim/operate/service.mjs',
    from: '...(signal ? {interrupt: signal} : {}),', to: ''},
  {id: 'T4', what: 'the hard stop releases no claim', file: 'ophanim/operate/cli.mjs',
    from: '      released = [...held].map(([claim, h]) => ({claim, ...h, released: releaseInterrupted(work, {claim, item: h.item, stage: h.stage, why})}));', to: '      released = [];'},
  {id: 'T5', what: 'serve does not tell the hard stop which claims it took', file: 'ophanim/operate/cli.mjs',
    from: 'onProgress: stop.track, ', to: ''},
  {id: 'T6', what: 'watch sleeps out its interval after a stop (58c02d3)', file: 'ophanim/operate/scheduler.mjs',
    from: "    await new Promise(r => { const t = setTimeout(done, interval_ms); function done() { clearTimeout(t); signal?.removeEventListener('abort', done); r(); } signal?.addEventListener('abort', done, {once: true}); });",
    to: '    await new Promise(r => setTimeout(r, interval_ms));'},
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
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...tests], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}});
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'),
    failed: [...new Set(out.split('\n').filter(l => /^✖ /.test(l) && !/failing tests/.test(l)).map(l => l.replace(/ \(\d+(\.\d+)?ms\)$/, '')))]};
};

const only = arg('--only')?.split(',') ?? null;
const logDir = path.resolve(arg('--log', path.join(os.tmpdir(), `wave2b-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const chosen = MUTATIONS.filter(m => !only || only.includes(m.id));
// Every target must apply EXACTLY ONCE on this tree, before anything is run.
const bad = chosen.map(m => ({m, n: fs.readFileSync(path.join(ROOT, m.file), 'utf8').split(m.from).length - 1})).filter(x => x.n !== 1);
if (bad.length) {
  for (const {m, n} of bad) console.error(`${m.id}: the target occurs ${n} time(s) in ${m.file}; a mutation applies exactly once`);
  process.exit(2);
}
if (only && chosen.length !== only.length) { console.error(`unknown mutation id(s): ${only.filter(id => !MUTATIONS.some(m => m.id === id)).join(', ')}`); process.exit(2); }
if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation target(s), each occurring exactly once`); process.exit(0); }
// NOT under /tmp: the agy worker jail mounts a fresh tmpfs there, so a tree copied under /tmp cannot run its own fake CLI.
const copyRoot = path.resolve(arg('--copy-root', os.homedir()));
const copy = fs.mkdtempSync(path.join(copyRoot, 'wave2b-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, SUITES, path.join(logDir, 'baseline.log'));
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled) { console.error('the unmutated suites are not green: no mutation result would mean anything'); process.exit(3); }
  for (const m of chosen) {
    const file = path.join(copy, m.file), orig = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, orig.replace(m.from, () => m.to));
    if (fs.readFileSync(file, 'utf8') === orig) { console.error(`${m.id}: MUTATION DID NOT APPLY`); exit = 2; continue; }
    const r = runSuites(copy, m.tests ?? SUITES, path.join(logDir, `${m.id}.log`));
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
