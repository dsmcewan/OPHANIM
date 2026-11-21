#!/usr/bin/env node
// MUTATION RUNNER for federation (Slice E: packages/graph/federation.mjs), kept SEPARATE from graph.mutate.mjs (Slice
// A's). Every mutation re-introduces a plausible regression of a property Slice E states -- an internal node exported
// with its details, a restricted node exported, a withheld value leaking through a digest or an attribute, the anchor
// not checked, a stale import shown as current, the central writing into a department, catch-up duplicating or losing
// an update, propagation dropping its provenance, a department depending on the hub, a forged or foreign export
// accepted -- on a DISPOSABLE COPY of this tree (never the tree itself). Only the tests that decide it run there
// (`tests`: each [file, --test-name-pattern]), and the copy is thrown away.
//
//   node packages/graph/tests/federation.mutate.mjs [--only E1,E7] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does
// not occur exactly once (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1): its
// deciding tests stay green with it. Synthetic keys and synthetic departments only; no test reaches a provider.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TEST = 'packages/graph/tests/federation.test.mjs';
const SUITES = [TEST, 'ophanim/ledger/layering.test.mjs'];
const FED = 'packages/graph/federation.mjs';
const one = (from, to, file = FED) => ({file, from, to});
const t = pattern => [TEST, pattern];

export const MUTATIONS = [
  // ---- the access policy (KE3, register KG-3) ---------------------------------------------------------------------------
  {id: 'E1', what: 'an internal node is exported with its details', tests: [t('^withheld:'), t('^demonstration 10:')],
    edits: [one("        ...(n.treatment === 'details' ? {details: detailsOf(n.records)} : {})});", "        ...(n.treatment !== 'withhold' ? {details: detailsOf(n.records)} : {})});")]},
  {id: 'E2', what: 'a restricted node is exported (as a reference)', tests: [t('^withheld:')],
    edits: [one('      const item = {access, treatment: policy.access[access], records, est, version: versionOfSupport(est)};',
      "      const item = {access, treatment: policy.access[access === 'restricted' ? 'internal' : access], records, est, version: versionOfSupport(est)};")]},
  {id: 'E3', what: 'a withheld value leaks through a digest: the placeholder is a plain digest of the restricted node id', tests: [t('^withheld:')],
    edits: [one("  const placeholderOf = node => 'placeholder:' + createHmac('sha256', Buffer.from(secret)).update(canonical({instance: me.instance, anchor: me.anchor, node})).digest('hex');",
      "  const placeholderOf = node => 'placeholder:' + digest(node);")]},
  {id: 'E4', what: 'a withheld value leaks through a digest: a node\'s version is its assertion id (a digest over its withheld attributes)', tests: [t('^withheld:')],
    edits: [one('    const versionOfSupport = est => hashAt.get(Math.max(...est.map(a => a.admitted)));', '    const versionOfSupport = est => est.map(a => a.id).sort(byString)[0];')]},
  {id: 'E5', what: 'a withheld value leaks through an attribute: public details naming a restricted node are not scrubbed', tests: [t('^withheld:'), t('^demonstration 10:')],
    edits: [one("      if (typeof value === 'string') return needles.some(x => value.includes(x)) ? WITHHELD : value;", "      if (typeof value === 'string') return value;")]},
  // ---- identity and references (KE2) ------------------------------------------------------------------------------------
  {id: 'E6', what: 'the anchor is not checked: a reference to, or an export from, a replaced ledger is taken as the instance', tests: [t('^references:')],
    edits: [one('  if (claimed.anchor !== pinned.anchor) return', '  if (false) return')]},
  {id: 'E7', what: 'a reference to a node at a version it no longer has resolves (the version not checked)', tests: [t('^references:')],
    edits: [one("    if (f.attributes.version !== ref.version) return {resolved: false, reason: 'stale-version',", "    if (false) return {resolved: false, reason: 'stale-version',")]},
  // ---- freshness and disconnection (KE5) --------------------------------------------------------------------------------
  {id: 'E8', what: 'a stale import is shown as current: an export older than its bound is not marked', tests: [t('^freshness:')],
    edits: [one('      if (age !== null && age > bound) reasons.push(', '      if (false) reasons.push(')]},
  {id: 'E9', what: 'a stale import is shown as current: an instance that cannot be reached is not marked', tests: [t('^freshness:'), t('^demonstration 10:')],
    edits: [one("        if (s.state === 'unavailable') reasons.push(", '        if (false) reasons.push('),
      one("      if (r && !r.ok && s?.state !== 'unavailable') reasons.push(", '      if (false) reasons.push(')]},
  {id: 'E10', what: 'a department\'s operation depends on the hub: publishing first asks the hub', tests: [t('^independence:')],
    edits: [one('      const head = box.head();', '      const head = (transport.notices(me), box.head());')]},
  {id: 'E11', what: 'catch-up skips to the latest export of a department (an intermediate update lost)', tests: [t('^independence:')],
    edits: [one('        const e = inbox.next(inst, at) ?? inbox.get(inst, at);', '        const e = inbox.chain(inst).at(-1) ?? inbox.get(inst, at);')]},
  {id: 'E12', what: 'catch-up duplicates: a notice\'s id includes its issue time, so each catch-up issues it again', tests: [t('^independence:')],
    edits: [one('          const id = H(body), notice = {...body, id, issued_at, signature: signOf({...body, id, issued_at}, signer)};',
      '          const id = H({...body, issued_at}), notice = {...body, id, issued_at, signature: signOf({...body, id, issued_at}, signer)};')]},
  {id: 'E13', what: 'catch-up duplicates: a link carries the time it was derived, so each catch-up derives it again', tests: [t('^independence:')],
    edits: [one('    attributes: {reference: ref.to, from_instance: instanceOf(node), to_instance: ref.to.instance}});',
      '    attributes: {reference: ref.to, from_instance: instanceOf(node), to_instance: ref.to.instance, linked_at: observed_at}});')]},
  // ---- authority and ownership (KE1, KE4) -------------------------------------------------------------------------------
  {id: 'E14', what: 'the central writes into a department: its write boundary admits a department\'s namespace and ownership', tests: [t('^authority:')],
    edits: [one("  const centralRefusal = r => {\n    if (r.kind === 'retraction') return null;", "  const centralRefusal = r => {\n    return null;")]},
  {id: 'E15', what: 'a department records as its own what it does not own (its write boundary removed)', tests: [t('^authority:')],
    edits: [one("  const ownRefusal = r => {\n    if (r.kind === 'retraction') return null;", "  const ownRefusal = r => {\n    return null;")]},
  {id: 'E16', what: 'a department\'s export presents another instance\'s node as its own', tests: [t('^authority:')],
    edits: [one('      if (foreign) fail(', '      if (false) fail(')]},
  {id: 'E17', what: 'the central imports an export listing another instance\'s node as the exporter\'s', tests: [t('^authority:')],
    edits: [one('    if (instanceOf(n.node) !== pinned.instance) return no(', '    if (false) return no(')]},
  {id: 'E18', what: 'the central accepts an export not signed by a key pinned for its instance', tests: [t('^authority:')],
    edits: [one('  if (!signatureValid({...body, id}, signature, pinned.keys)) return no(', '  if (false) return no(')]},
  // ---- propagation (KE6) ------------------------------------------------------------------------------------------------
  {id: 'E19', what: 'propagation drops its provenance: a notice names the hub as its origin', tests: [t('^propagation:')],
    edits: [one('            origin: {instance: inst, anchor: exp.anchor, export: exp.id, version: exp.version, seq: exp.seq, changes},',
      '            origin: {instance: me.instance, anchor: me.anchor, export: exp.id, version: exp.version, seq: exp.seq, changes},')]},
  {id: 'E20', what: 'propagation drops its provenance: a notice\'s changes lose the ledger entries they happened at', tests: [t('^propagation:')],
    edits: [one('.map(c => ({change: c.change, because: c.because, at: c.at,', '.map(c => ({change: c.change, because: c.because, at: null,')]},
  {id: 'E21', what: 'a department records a notice addressed to another instance', tests: [t('^propagation:')],
    edits: [one('    const to = identityRefusal(me, body.to);', '    const to = null;')]},
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
const copyRoot = path.resolve(arg('--copy-root', os.tmpdir()));
const logDir = path.resolve(arg('--log', path.join(copyRoot, `federation-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'federation-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, path.join(logDir, 'baseline.log'), SUITES);
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !(baseline.tests > 0)) {
    console.error('the unmutated suites are not green: no mutation result would mean anything');
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
