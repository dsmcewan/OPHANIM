#!/usr/bin/env node
// MUTATION RUNNER for the python SDK seat's bubble (knowledge graphs, Slice C2; register L-155 and KG-6;
// docs/knowledge-graph/slice-c2.md). Every mutation re-introduces a plausible regression of a property the slice states --
// the jail dropped at either spawn point, the controller's processes or HOME visible from the jail, an unjailed fallback when
// bwrap is missing, the seat's HOME kept after the timeout or after the direct launch, the environment inherited instead of
// allowlisted, a credential-named variable dropped instead of refusing the seat, the hidden locations or the host writable,
// the SDK bubble recorded as holding without its quotes found, the attempt's transport recorded as the ambiguous `agy`; and
// (register KG-11, F1-F11) the descriptor closer removed at each spawn point (the verify launcher, the CLI worker's jail,
// the SDK seat's board spawn and direct launcher), its refusal replaced by an unprotected run, a gate's check of it dropped,
// it closing only what a POSIX shell can name, its single-thread check dropped (the race-prone closer), the command handed
// python's own environment, or SIGPIPE left ignored -- on a DISPOSABLE COPY of this tree (never the tree itself). Only the tests that decide it run there (`tests`: each [file,
// --test-name-pattern]); the copy is thrown away.
//
//   node pantheon/tests/agy-sdk-jail.mutate.mjs [--only J1,J7] [--log DIR] [--copy-root DIR] [--check]
//
// The copy goes under /var/tmp by default, NOT /tmp: the CLI worker's jail replaces /tmp with a fresh tmpfs, so a copy under
// /tmp hides its own source tree (the jail hook, the descriptor probe) from the CLI worker suites (jail-fds, the isolation
// test), and their baseline fails (observed: 30/32, exit 3, with the copy under /tmp).
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does
// not occur exactly once (2), when the unmutated suites are not green -- a skip included: the jail cells skip where bwrap
// does not work, and such a host proves nothing (3) -- or when any mutation SURVIVES (1): its deciding tests stay green with
// it. Synthetic keys only; the relay's upstream is a local fake; no test reaches a provider.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JAIL = 'pantheon/tests/agy-sdk-jail.test.mjs', GRAPHT = 'pantheon/tests/capability-graph.test.mjs';
const JFDS = 'pantheon/tests/jail-fds.test.mjs', ISO = 'pantheon/tests/verify-jail-credential-isolation.test.mjs';
const SUITES = [JAIL, GRAPHT, JFDS, ISO];
const SB = 'pantheon/src/agy/sandbox.mjs', RI = 'pantheon/src/board/run-item.mjs', LA = 'pantheon/bin/agy-seat.mjs', GRAPH = 'pantheon/src/capability/graph.mjs';
const VJ = 'pantheon/src/agy/verify-jail.mjs', CLI = 'pantheon/src/board/agy-cli.mjs', FDX = 'pantheon/src/agy/fd-exec.mjs';
const one = (file, from, to) => ({file, from, to});
const jail = pattern => [JAIL, pattern];
const graph = pattern => [GRAPHT, pattern];
const fds = pattern => [JFDS, pattern];
const iso = pattern => [ISO, pattern];
const PREFIX = 'const prefix = [bwrap, "--die-with-parent", "--unshare-pid", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];';

export const MUTATIONS = [
  // ---- the jail at both spawn points (KS1) -----------------------------------------------------------------------------
  {id: 'J1', what: 'the jail dropped at the board\'s spawn point (run-item.mjs spawns the seat unjailed)', tests: [jail('^board: the SDK seat'), graph('^the bubble: each profile')],
    edits: [one(RI, 'const [cmd, ...argv] = [...jail.prefix, python, ...args];', 'const [cmd, ...argv] = [python, ...args];')]},
  {id: 'J2', what: 'the jail dropped at the direct launcher (bin/agy-seat.mjs spawns the seat unjailed)', tests: [jail('^launcher: the governed'), graph('^the bubble: each profile')],
    edits: [one(LA, 'const [cmd, ...argv] = [...jail.prefix, python, SEAT, ...args];', 'const [cmd, ...argv] = [python, SEAT, ...args];')]},
  {id: 'J3', what: '--unshare-pid removed: the controller\'s processes and their environment visible in the jail', tests: [jail('^the builder'), jail('^board: the SDK seat'), jail('^launcher: the governed')],
    edits: [one(SB, PREFIX, 'const prefix = [bwrap, "--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];')]},
  {id: 'J4', what: 'the fresh /proc removed: the host\'s /proc (every controller process) visible in the jail', tests: [jail('^the builder'), jail('^board: the SDK seat'), jail('^launcher: the governed')],
    edits: [one(SB, PREFIX, 'const prefix = [bwrap, "--die-with-parent", "--unshare-pid", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--tmpfs", "/tmp"];')]},
  {id: 'J5', what: 'the controller\'s HOME not hidden (its ADC file and Antigravity login readable from the jail)', tests: [jail('^the builder'), jail('^board: the SDK seat'), jail('^launcher: the governed')],
    edits: [one(SB, 'for (const h of homes) add(h, ', 'for (const h of []) add(h, ')]},
  {id: 'J6', what: 'an unjailed fallback when bwrap is missing (the gate builds an empty prefix instead of refusing)', tests: [jail('^board without bwrap'), jail('^launcher without bwrap')],
    edits: [one(SB, 'if (!probe.ok) throw jailError("SANDBOX_UNAVAILABLE",',
      'if (!probe.ok) return { bwrap, build: spec => ({ ...sdkSeatJail({ ...spec, bwrap }), prefix: [] }) };\n  if (false) throw jailError("SANDBOX_UNAVAILABLE",')]},
  {id: 'J14', what: 'the host bound writable (--bind / / instead of --ro-bind / /)', tests: [jail('^the builder'), jail('^board: the SDK seat'), jail('^launcher: the governed')],
    edits: [one(SB, PREFIX, 'const prefix = [bwrap, "--die-with-parent", "--unshare-pid", "--new-session", "--bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];')]},
  {id: 'J11', what: 'the hidden locations left writable (no --remount-ro: a write there lands, unseen, in a tmpfs)', tests: [jail('^the builder'), jail('^board: the SDK seat'), jail('^launcher: the governed')],
    edits: [one(SB, '  for (const h of hidden) if (h.kind === "dir") prefix.push("--remount-ro", h.path);\n', '')]},
  // ---- the environment (KS1) -------------------------------------------------------------------------------------------
  {id: 'J8', what: 'the environment inherited instead of allowlisted (the controller\'s whole environment in the jail)', tests: [jail('^the builder'), jail('^board: the SDK seat'), jail('^launcher: the governed')],
    edits: [one(SB, 'const { env: jailEnv, dropped } = sdkSeatEnv(env, { pass: base?.PANTHEON_AGY_ENV_PASS ?? "" });', 'const { env: jailEnv, dropped } = { env: { ...base, ...env }, dropped: [] };')]},
  {id: 'J12', what: 'the jail\'s re-check of the withholding gone (a credential-named variable silently dropped, the seat run)', tests: [jail('^the builder')],
    edits: [one(SB, 'if (SDK_JAIL_ENV_REFUSED.test(k)) refused.push(k);', 'if (SDK_JAIL_ENV_REFUSED.test(k)) dropped.push(k);')]},
  // ---- the single-assignment lifetime (KS1) ----------------------------------------------------------------------------
  {id: 'J7', what: 'the seat\'s HOME not removed on the timeout path (the board)', tests: [jail('^board timeout path')],
    edits: [one(RI, 'const teardown = await dropSdkSeatScratch(jail ?? { home });', 'const teardown = sdkRun?.killedFor === "timeout" ? null : await dropSdkSeatScratch(jail ?? { home });')]},
  {id: 'J13', what: 'the direct launcher keeps the seat\'s HOME after the assignment', tests: [jail('^launcher: the governed'), jail('^launcher kill path')],
    edits: [one(LA, 'const teardown = await dropSdkSeatScratch(jail);', 'const teardown = null;')]},
  // ---- the graph (KS3) -------------------------------------------------------------------------------------------------
  {id: 'J9', what: 'the SDK bubble recorded as holding without its quotes found (a quote the code does not contain counted as found)', tests: [graph('^the bubble: the SDK seat\'s jail is its evidence')],
    edits: [one(GRAPH, "  return (list ?? []).map(e => ({file: e.file, quote: e.quote, found: typeof texts?.[e.file] === 'string' && texts[e.file].includes(e.quote)}));",
      "  return (list ?? []).map(e => ({file: e.file, quote: e.quote, found: true}));")]},
  // ---- the transport on each attempt (KS4, KG-6) -----------------------------------------------------------------------
  {id: 'J10', what: 'the attempt\'s transport recorded as agy (agyTurn\'s resolved transport not reported)', tests: [jail('^board: the SDK seat'), jail('^KG-6:')],
    edits: [one(RI, 'onTransport(AGY_TRANSPORT_OF[transport] ?? null);', 'onTransport(null);')]},
  {id: 'J15', what: 'the turn\'s transport recorded as agy (the attempt says agy-cli or agy-sdk, the run\'s turns row does not)', tests: [jail('^board: the SDK seat'), jail('^KG-6:')],
    edits: [one(RI, 'transport: ran ?? settings.transport, purpose, ms, chars: r.text.length,', 'transport: transport ?? "agy", purpose, ms, chars: r.text.length,')]},
  // ---- no descriptor beyond 0, 1 and 2 at any spawn point (register KG-11; src/agy/fd-exec.mjs) -------------------------
  {id: 'F1', what: 'the descriptor closer removed at the verify launcher (bwrap spawned directly: what the launcher inherited reaches the verify_cmd)',
    tests: [fds('^CLI worker:'), iso('^credential isolation, WORKER path'), iso('^credential isolation, CONTROLLER path')],
    edits: [one(VJ, 'try { const [closer, ...argv] = fdExecArgv([file, ...args]); child = spawn(closer, argv, { cwd, env, stdio: "inherit" }); }',
      'try { child = spawn(file, args, { cwd, env, stdio: "inherit" }); }')]},
  {id: 'F2', what: 'the descriptor closer dropped at the SDK seat\'s board spawn (the jail\'s bwrap argv used without the closer in front of it)', tests: [fds('^SDK board:')],
    edits: [one(RI, 'const [cmd, ...argv] = [...jail.prefix, python, ...args];', 'const [cmd, ...argv] = [...jail.prefix.slice(jail.fds.argv.length), python, ...args];')]},
  {id: 'F3', what: 'the descriptor closer dropped at the SDK seat\'s direct launcher (bin/agy-seat.mjs)', tests: [fds('^SDK launcher:')],
    edits: [one(LA, 'const [cmd, ...argv] = [...jail.prefix, python, SEAT, ...args];', 'const [cmd, ...argv] = [...jail.prefix.slice(jail.fds.argv.length), python, SEAT, ...args];')]},
  {id: 'F4', what: 'the descriptor closer removed from the CLI worker\'s jail (prepareWorkerJail: the agy CLI inherits what the controller holds)', tests: [fds('^CLI worker:')],
    edits: [one(CLI, 'return { prefix: fdExecArgv(b.argv, { closerPython }), gstate,', 'return { prefix: b.argv, gstate,')]},
  {id: 'F5', what: 'the closer\'s refusal replaced by an unprotected run (no /proc, a descriptor still open, another thread: it execs the command anyway)', tests: [fds('^closer fails closed')],
    edits: [one(FDX, '    say("refused: %s; the jail was not started" % why)\n    os._exit(125)', '    say("refused: %s; the jail was not started" % why)\n    os.execvp(sys.argv[1], sys.argv[1:])')]},
  {id: 'F6', what: 'the SDK seat\'s gate stops checking the descriptor closer (a closer that does not work here is not refused at the gate)', tests: [fds('^gates fail closed')],
    edits: [one(SB, '      if (!fds.ok) return { ok: false, why: `no descriptor beyond 0, 1 and 2 can be guaranteed: ${fds.why}` };\n', '')]},
  {id: 'F7', what: 'the CLI worker\'s gate stops checking the descriptor closer', tests: [fds('^gates fail closed')],
    edits: [one(CLI, 'const probe = !box.ok ? box : fds.ok ? { ok: true } : { ok: false, why: `no descriptor beyond 0, 1 and 2 can be guaranteed: ${fds.why}` };', 'const probe = box;')]},
  {id: 'F8', what: 'the closer closes only the descriptors a POSIX shell can name (3 to 9): fd 20 survives',
    tests: [fds('^closer:'), fds('^closer on the host'), fds('^CLI worker:'), fds('^SDK board:'), fds('^SDK launcher:')],
    edits: [one(FDX, '    os.closerange(3, max(fds + [2]) + 1)', '    os.closerange(3, 10)')]},
  {id: 'F9', what: 'the closer\'s single-thread check dropped (the race-prone closer: another thread of its process could open a descriptor between its check and its exec, as a node closer\'s can)',
    tests: [fds('^closer fails closed')],
    edits: [one(FDX, '    if len(threads) != 1: refuse(', '    if False: refuse(')]},
  {id: 'F10', what: 'the closer hands the command python\'s own environment (LC_CTYPE coerced under the C locale) instead of the one it was given', tests: [fds('^closer fidelity')],
    edits: [one(FDX, 'try: os.execve(path, sys.argv[1:], env)', 'try: os.execve(path, sys.argv[1:], os.environb)')]},
  {id: 'F11', what: 'SIGPIPE left ignored across the exec (python ignores it at its startup): the jailed command inherits it ignored', tests: [fds('^closer fidelity')],
    edits: [one(FDX, '_signal.signal(_signal.SIGPIPE, _signal.SIG_DFL)\n', '')]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
function copyTree(dest) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], {encoding: 'utf8', maxBuffer: 1 << 28}).split('\0').filter(Boolean);
  for (const f of files) {
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), {recursive: true});
    if (fs.lstatSync(from).isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(from), path.join(dest, f)); continue; }
    fs.copyFileSync(from, path.join(dest, f));
    fs.chmodSync(path.join(dest, f), fs.statSync(from).mode);
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules', 'packages/graph/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
}
const runSuites = (dir, logFile, files, patterns = []) => {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=600000', ...patterns.map(p => `--test-name-pattern=${p}`), ...files],
    {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}});
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
    failed: [...new Set(out.split('\n').filter(l => /^\s*✖ /.test(l) && !/failing tests/.test(l)).map(l => l.trim().replace(/ \(\d+(\.\d+)?ms\)$/, '')))]};
};

const only = arg('--only')?.split(',') ?? null;
const chosen = MUTATIONS.filter(m => !only || only.includes(m.id));
if (only && chosen.length !== only.length) { console.error(`unknown mutation id(s): ${only.filter(id => !MUTATIONS.some(m => m.id === id)).join(', ')}`); process.exit(2); }
if (new Set(MUTATIONS.map(m => m.id)).size !== MUTATIONS.length) { console.error('mutation ids are not unique'); process.exit(2); }
// Every edit must apply EXACTLY ONCE on this tree, and every deciding test file must be a suite, before anything runs.
const bad = chosen.flatMap(m => m.edits.map(e => ({m, e, n: fs.readFileSync(path.join(ROOT, e.file), 'utf8').split(e.from).length - 1}))).filter(x => x.n !== 1);
const strays = chosen.flatMap(m => m.tests.filter(([f]) => !SUITES.includes(f)).map(([f]) => `${m.id}: ${f}`));
if (bad.length || strays.length) {
  for (const {m, e, n} of bad) console.error(`${m.id}: the target occurs ${n} time(s) in ${e.file}; a mutation applies exactly once`);
  for (const s of strays) console.error(`${s} is not one of the runner's suites`);
  process.exit(2);
}
if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation(s), every target occurring exactly once`); process.exit(0); }
const copyRoot = path.resolve(arg('--copy-root', fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir()));
const logDir = path.resolve(arg('--log', path.join(copyRoot, `agy-sdk-jail-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'agy-sdk-jail-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, path.join(logDir, 'baseline.log'), SUITES);
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !(baseline.tests > 0)) {
    console.error('the unmutated suites are not green (a skipped jail cell included: bwrap must work here): no mutation result would mean anything');
    exit = 3;
  } else {
    for (const m of chosen) {
      const originals = new Map();
      for (const e of m.edits) {
        const file = path.join(copy, e.file);
        if (!originals.has(file)) originals.set(file, fs.readFileSync(file, 'utf8'));
        const before = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, before.replace(e.from, () => e.to));
        if (fs.readFileSync(file, 'utf8') === before) { console.error(`${m.id}: EDIT DID NOT APPLY in ${e.file}`); exit = 2; }
      }
      const files = [...new Set(m.tests.map(([f]) => f))], patterns = [...new Set(m.tests.map(([, p]) => p))];
      const r = runSuites(copy, path.join(logDir, `${m.id}.log`), files, patterns);
      for (const [file, text] of originals) fs.writeFileSync(file, text);
      const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0) && r.tests > 0;
      summary.push({id: m.id, what: m.what, tests: m.tests, files: [...new Set(m.edits.map(e => e.file))], killed, ran: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
      console.log(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  ${m.what}`);
      for (const f of r.failed.slice(0, 3)) console.log(`    ${f.slice(0, 200)}`);
      if (!killed) exit = exit || 1;
    }
  }
} finally {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({suites: SUITES, mutations: summary}, null, 2) + '\n');
  fs.rmSync(copy, {recursive: true, force: true});
}
console.log(`logs: ${logDir}`);
process.exit(exit);
