#!/usr/bin/env node
// MUTATION RUNNER for the knowledge-graph foundation (packages/graph, contract ophanim.graph/v1) and its one source
// adapter (ophanim/graph/lessons.mjs). Every mutation re-introduces a plausible regression of a property the contract
// states -- an unregistered type or a wrong endpoint accepted, an invalid id accepted, a hypothetical overwriting what is
// established, a contradiction resolved by dropping a side, the timestamp inside the assertion id, an as-of view that
// ignores its cursor, a digest that depends on the order a source yields its facts, a traversal without its bounds, a
// closure that follows a non-impact type, an unregistered origin admitted, a duplicate appended twice, the append lock
// removed, a broken reference admitted, the cursor rule removed, recovery repairing a broken ledger in place -- on a
// DISPOSABLE COPY of this tree (never the tree itself). Only the tests that decide it run there (`tests`: each
// [file, --test-name-pattern]), and the copy is thrown away.
//
//   node packages/graph/tests/graph.mutate.mjs [--only G1,G7] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does
// not occur exactly once (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1): its
// deciding tests stay green with it. Synthetic keys only; no test reaches a provider.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const T = 'packages/graph/tests/';
const SUITES = [`${T}schema.test.mjs`, `${T}ledger.test.mjs`, `${T}replay.test.mjs`, `${T}traverse.test.mjs`, `${T}events.test.mjs`, `${T}concurrency.test.mjs`,
  'ophanim/graph/lessons.test.mjs', 'ophanim/ledger/layering.test.mjs'];
const SCHEMA = 'packages/graph/schema.mjs', IDENTITY = 'packages/graph/identity.mjs', PROJ = 'packages/graph/projection.mjs', TRAV = 'packages/graph/traverse.mjs',
  EVENTS = 'packages/graph/events.mjs', KINDS = 'packages/graph/kinds.mjs', CHAIN = 'packages/ledger/chain.mjs', LESSONS = 'ophanim/graph/lessons.mjs';
const one = (file, from, to) => ({file, from, to});
const t = (file, pattern) => [`${T}${file}.test.mjs`, pattern];
const lessons = pattern => ['ophanim/graph/lessons.test.mjs', pattern];

export const MUTATIONS = [
  // ---- validation (KD3, KD4, KD6; demonstration 12) --------------------------------------------------------------------
  {id: 'G1', what: 'an unregistered relationship type is accepted (passed through unchecked)', tests: [t('schema', '^refusals \\(static\\)'), t('ledger', '^refusals:')],
    edits: [one(SCHEMA, '    if (!rel) return `relationship type "${r.type}" is not registered`;', '    if (!rel) return null;')]},
  {id: 'G2', what: 'a relationship whose endpoint types its registry entry does not allow is accepted', tests: [t('schema', '^refusals \\(static\\)'), t('ledger', '^refusals:')],
    edits: [one(SCHEMA, '    if (!endpointAllowed(r.type, from, to)) return `relationship ${r.type} does not join ${from.domain}/${from.type} to ${to.domain}/${to.type}`;\n', '')]},
  {id: 'G3', what: 'an invalid id (bad grammar, unregistered domain or type) is accepted', tests: [t('schema', '^identity:'), t('ledger', '^refusals:')],
    edits: [one(SCHEMA, 'export function idRefusal(id) {\n  const why = grammarRefusal(id);', 'export function idRefusal(id) {\n  return null;\n  const why = grammarRefusal(id);')]},
  {id: 'G14', what: 'a broken reference (an edge to an entity the graph does not hold) is admitted', tests: [t('ledger', '^refusals:')],
    edits: [one(PROJ, '      if (!sim.present(end)) return `GRAPH_REFERENCE broken reference: ${end} is not in the graph`;\n', '')]},
  // ---- admission and the hypothetical (KD5, KD6; demonstration 6) ------------------------------------------------------
  {id: 'G4', what: 'a hypothetical assertion overwrites (supersedes, invalidates) an established one', tests: [t('ledger', '^hypothetical:')],
    edits: [one(SCHEMA, "export const overrides = (byClass, targetClass) => !(byClass === 'hypothetical' && targetClass !== 'hypothetical');", 'export const overrides = () => true;')]},
  {id: 'G15', what: 'a hypothetical assertion is returned as established', tests: [t('ledger', '^hypothetical:'), t('ledger', '^bases:')],
    edits: [one(PROJ, "      ok = r.classification !== 'hypothetical' && r.status !== 'unresolved'", "      ok = r.status !== 'unresolved'")]},
  {id: 'G5', what: 'a contradiction is resolved by dropping one side (the target of contradicts is retired)', tests: [t('ledger', '^contradictions:')],
    edits: [one(PROJ, "        for (const t of r.invalidates) retire(t, seq, 'invalidated', r.id);\n",
      "        for (const t of r.invalidates) retire(t, seq, 'invalidated', r.id);\n        if (r.type === 'contradicts' && r.classification !== 'hypothetical') for (const x of st.bySubject.get(r.to) ?? []) retire(x, seq, 'superseded', r.id);\n")]},
  {id: 'G11', what: 'an unregistered origin admits an authoritative assertion (unknown origins passed through, at both checks)',
    tests: [t('ledger', '^unregistered origin'), t('ledger', '^refusals:'), t('schema', '^refusals \\(static\\)')],
    edits: [one(SCHEMA, '  if (!o) return `origin "${r.origin}" is not registered`;', '  if (!o) return null;'),
      one(PROJ, '    if (!o) return `origin "${originId}" is not registered`;', '    if (!o) return null;'),
      one(PROJ, "    if (!o || o.kind !== 'extractor' || !o.sources.includes(sourceId)) return {", "    if (o && (o.kind !== 'extractor' || !o.sources.includes(sourceId))) return {")]},
  {id: 'G20', what: 'a relationship is admitted from any basis: depends-on from textual similarity', tests: [t('ledger', '^bases:'), t('schema', '^registry: every relationship')],
    edits: [one(SCHEMA, '  return allowed === ANY || Boolean(allowed?.includes(basis));', '  return allowed !== undefined;')]},
  {id: 'G19', what: 'a derived assertion stays established after its input is retracted', tests: [t('ledger', '^derived:')],
    edits: [one(PROJ, "\n        && (r.classification !== 'derived' || r.inputs.every(established));", ';')]},
  // ---- idempotency and history (KD4, KD7, KD8) -------------------------------------------------------------------------
  {id: 'G6', what: 'the assertion id includes the observation timestamp: the same assertion observed later is a new one', tests: [t('ledger', '^idempotency:')],
    edits: [one(IDENTITY, "const TIMESTAMPS = ['observed_at', 'effective_at'];", "const TIMESTAMPS = ['effective_at'];")]},
  {id: 'G12', what: 'a duplicate is appended again (no duplicate check at the writer or in re-derivation): a second edge', tests: [t('ledger', '^idempotency:'), t('concurrency', '^concurrency:')],
    edits: [one(KINDS, '      const fresh = items.filter(x => !projection.knows(x.id)), duplicates = items.filter(x => projection.knows(x.id)).map(x => x.id);', '      const fresh = items, duplicates = [];'),
      one(PROJ, '      if (sim.known(r.id)) return `GRAPH_DUPLICATE assertion ${r.id} is already recorded`;\n', '')]},
  {id: 'G7', what: 'an as-of view ignores its cursor (every view is the latest)', tests: [t('ledger', '^history:'), t('events', '^impact:')],
    edits: [one(PROJ, '    return makeView(st, c, origins);', '    return makeView(st, st.seq, origins);')]},
  {id: 'G8', what: 'the projection digest follows insertion order (the order a source yields its facts), not ledger order and ids', tests: [t('replay', 'the digest is the same whatever order')],
    edits: [one(PROJ, '      rows.sort((x, y) => byString(x[0], y[0]));\n', '')]},
  {id: 'G16', what: 'a replay that cannot read a source claims its facts were applied (invented currency)', tests: [t('replay', 'a source that cannot be read at replay'), lessons('unreadable registry')],
    edits: [one(PROJ, "      if (!d.ok) { replay = d.unavailable ? 'unavailable' : 'invalid'; st.gap.add(s); }", "      if (!d.ok) { replay = 'applied'; }")]},
  {id: 'G24', what: 'recovery repairs a ledger that does not verify in place (drops the torn tail) instead of setting it aside', tests: [t('replay', '^recovery:')],
    edits: [one(KINDS, '    fs.renameSync(dir, set_aside);',
      "    { const f = path.join(dir, 'chain.jsonl'), x = fs.readFileSync(f, 'utf8'); fs.writeFileSync(f, x.slice(0, x.lastIndexOf('\\n') + 1)); return {graph: openGraph({dir, anchor, ...opts}), rebuilt: false, set_aside: null, anchor}; }")]},
  // ---- traversal (KD9) -------------------------------------------------------------------------------------------------
  {id: 'G9', what: 'a traversal without its node and edge bounds', tests: [t('traverse', '^bounds:')],
    edits: [one(TRAV, "        if (pageSteps >= b.maxEdges) { limit = 'edges'; break outer; }\n        if (!visited.has(s.next) && pageNodes >= b.maxNodes) { limit = 'nodes'; break outer; }\n", '')]},
  {id: 'G22', what: 'a continuation resumes one step late (a node is lost between pages)', tests: [t('traverse', '^bounds: the defaults')],
    edits: [one(TRAV, "  if (limit === 'nodes' || limit === 'edges') continuation = encode({v: 1, op, seeds: start, params, seq: view.seq, skip: steps});",
      "  if (limit === 'nodes' || limit === 'edges') continuation = encode({v: 1, op, seeds: start, params, seq: view.seq, skip: steps + 1});")]},
  {id: 'G10', what: 'impact closure follows a non-impact type (mentions, contradicts) in both directions', tests: [t('traverse', '^impact: closure')],
    edits: [one(TRAV, '  const b = boundsOf(params), mode = modeOf(params.mode), types = typesOf(params.types, IMPACT_TYPES);', '  const b = boundsOf(params), mode = modeOf(params.mode), types = typesOf(params.types);'),
      one(TRAV, '    if (!impact) return [];', "    if (!impact) return view.nodeIn(e.from === u ? e.to : e.from, mode) ? [{next: e.from === u ? e.to : e.from, edge: e, toward: e.from === u ? 'out' : 'in'}] : [];")]},
  {id: 'G23', what: 'a result node carries no explained path', tests: [t('traverse', '^explained paths'), t('events', '^impact:')],
    edits: [one(TRAV, '    return out.reverse();', '    return [];')]},
  // ---- events, the cursor rule, freshness (KD10) -----------------------------------------------------------------------
  {id: 'G17', what: 'a changed source invalidates globally (every node of the graph is a seed) instead of its neighbourhood', tests: [t('events', '^impact:'), lessons('a change to the registry')],
    edits: [one(EVENTS, '  const seeds = new Set(changed);', "  const seeds = new Set([...changed, ...after.subjects().filter(x => !x.includes('('))]);")]},
  {id: 'G18', what: 'a repeated observation of the same version records a new event', tests: [t('events', '^events:'), t('ledger', '^idempotency:'), lessons('the real registry')],
    edits: [one(EVENTS, '  if (was && was.state === \'current\' && was.version === live.version) return {none: `${sourceId}@${live.version} is already observed`};\n', ''),
      one(PROJ, "    if (prev && prev.attributes.state === 'current' && prev.source.version === r.source.version) return `GRAPH_DUPLICATE ${s}@${r.source.version} is already observed`;\n", '')]},
  {id: 'G21', what: 'the cursor rule removed: an observation computed on an older state lands after a newer one', tests: [t('events', '^cursor rule')],
    edits: [one(PROJ, '    if (r.attributes.from_version !== at || r.supersedes.length !== (prev ? 1 : 0) || (prev && r.supersedes[0] !== prev.id)) {', '    if (false) {')]},
  {id: 'G26', what: 'freshness reports a moved, unreadable or unprojectable source as current', tests: [t('events', '^freshness:')],
    edits: [one(EVENTS, ": r.state !== 'current' || r.replay !== 'applied' || r.version !== live ? 'stale' : 'current';", ": 'current';")]},
  // ---- concurrency (KD11; demonstration 8) -----------------------------------------------------------------------------
  {id: 'G13', what: 'the ledger append lock removed: two processes append on the same head (lost or forked updates)', tests: [t('concurrency', '^concurrency:')],
    edits: [one(CHAIN, '    return locked(() => {', '    return (fn => fn())(() => {')]},
  // ---- the source adapter (KD12) ---------------------------------------------------------------------------------------
  {id: 'G25', what: 'the lessons adapter keys a failure class by its position in the file, not its id', tests: [lessons('a change to the registry'), lessons('the real registry')],
    edits: [one(LESSONS, "    const fc = entityId({domain: 'learning', type: 'failure-class', key: c.id});", "    const fc = entityId({domain: 'learning', type: 'failure-class', key: String(reg.classes.indexOf(c))});")]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
function copyTree(dest) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], {encoding: 'utf8', maxBuffer: 1 << 28}).split('\0').filter(Boolean);
  for (const f of files) {
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory() || fs.lstatSync(from).isSymbolicLink()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), {recursive: true});
    fs.copyFileSync(from, path.join(dest, f));
    fs.chmodSync(path.join(dest, f), fs.statSync(from).mode);
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules', 'packages/graph/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
  // The suites read git history (the lessons adapter re-derives versions from git's object store): a repository there.
  execFileSync('git', ['-C', dest, 'init', '-q'], {stdio: 'ignore'});
  execFileSync('git', ['-C', dest, '-c', 'user.name=mutation-runner', '-c', 'user.email=mutation-runner@example.invalid', 'add', '-A'], {stdio: 'ignore'});
  execFileSync('git', ['-C', dest, '-c', 'user.name=mutation-runner', '-c', 'user.email=mutation-runner@example.invalid', 'commit', '-q', '-m', 'copy'], {stdio: 'ignore'});
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
const logDir = path.resolve(arg('--log', path.join(copyRoot, `graph-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'graph-mutate-'));
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
