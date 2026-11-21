#!/usr/bin/env node
// T3 MANIFEST REACH (scripts/test-gates/TOOLKIT.md): FAILS an ownership manifest that cannot contain its slice's
// changes (lessons class brief-manifest-disagree, five instances: a manifest omitted tests the slice's own changes
// reached, so those tests broke outside what the agent was allowed to edit).
//
//   node scripts/test-gates/manifest-reach.mjs <manifest.json>... [--subwave ID] [--agent NAME]
//                                              [--ref COMMIT | --worktree] [--transitive[=N]] [--json] [--root DIR]
//
// Reads the manifest format docs/execution/check-ownership.mjs checks (ophanim.wave-ownership/v1; that file is
// coordinator-only and is not changed). For each agent, the modules it may CHANGE are the tracked files its `files`
// globs match, minus its tests and runners. Every test that imports one of them, and every runner that imports or
// edits one (reach.mjs, direct importers), must be
//   GRANTED   matched by the agent's own `files` globs (or `allowed_extra`), or
//   HELD      held by another agent, declared in one of two machine-readable forms:
//               - on the agent: "held": ["<path or glob>", {"path": "<path or glob>", "by": "<holder>", "why": "..."}]
//               - for every agent of the manifest: an OBJECT entry in "dependencies":
//                 {"held": ["<path or glob>", ...], "by": "<holder>", "why": "..."}
//             or granted to another agent of the same manifest (`held by sibling`).
// Anything else is MISSING and fails the manifest. A missing path that a dependency's PROSE names is still missing
// (prose is not a declaration), and is reported as "named in prose only" so the fix is a one-line restatement.
// Advisory, never failing: runners reached only through a deciding test (`decides`: re-run them in full, T2's job), and
// tests reached only transitively (2..TRANSITIVE_BOUND levels) that are neither granted nor held. --transitive[=N]
// makes transitive tests required.
// The tree read is the agent's base_commit (else the manifest's): the slice starts there, and a test added later is
// not one its brief could have listed. --ref COMMIT or --worktree reads another tree instead.
//
// Inputs:  the manifest(s); git's object store at the base commit (or the working tree's tracked files).
// Outputs: a report per agent (text, or JSON with --json). Exit 1 when any agent has a missing test or runner; 0
//          otherwise; 2 on a usage error or an unreadable manifest or base commit.
// Must never: change a manifest; list or read a withheld path (`findings-*`); import a runner.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT, TRANSITIVE_BOUND, snapshot, importGraph, reach, isTest, isRunner, parseDepth} from './reach.mjs';

export const SCHEMA = 'ophanim.toolkit.manifest-reach/v1';
const globsOf = a => (a.files ?? []).map(g => g.split(' ')[0]);
const matches = (f, globs) => globs.some(g => f === g || path.matchesGlob(f, g));
const entry = h => (typeof h === 'string' ? {path: h, by: null} : {path: h?.path, by: h?.by ?? null, why: h?.why ?? null});

/** Every hold the manifest declares for `agent`: [{path (glob), by, where}]. */
export function holdsOf(manifest, agent) {
  const out = [];
  for (const h of agent.held ?? []) out.push({...entry(h), where: 'agent held'});
  for (const d of manifest.dependencies ?? []) {
    if (d && typeof d === 'object' && Array.isArray(d.held)) for (const h of d.held) out.push({...entry(h), by: entry(h).by ?? d.by ?? null, where: 'dependencies held'});
  }
  return out.filter(h => typeof h.path === 'string' && h.path);
}

/**
 * Judge one agent of a manifest against a snapshot of its base tree.
 * Returns {agent, subwave, ref, changeable, required: [{file, kind, why, status, by?}], missing, rerun, transitive}.
 */
export function judgeAgent({manifest, subwave, name, snap, graph = importGraph(snap), depth = 1, advisoryDepth = TRANSITIVE_BOUND}) {
  const agent = manifest.subwaves[subwave][name];
  const globs = globsOf(agent), extra = agent.allowed_extra ?? [];
  const granted = f => matches(f, globs) || extra.includes(f);
  const holds = holdsOf(manifest, agent);
  const siblings = Object.entries(manifest.subwaves).flatMap(([s, as]) => Object.entries(as).filter(([n]) => !(s === subwave && n === name)).map(([n, a]) => ({name: n, globs: globsOf(a)})));
  const prose = (manifest.dependencies ?? []).filter(d => typeof d === 'string');
  const changeable = snap.paths.filter(f => matches(f, globs) && !isTest(f) && !isRunner(f));
  const r = reach(snap, changeable, {depth, graph});
  const status = file => {
    if (granted(file)) return {status: 'granted'};
    const h = holds.find(x => matches(file, [x.path]));
    if (h) return {status: 'held', by: h.by, where: h.where};
    const sib = siblings.find(s => matches(file, s.globs));
    if (sib) return {status: 'held', by: sib.name, where: 'granted to a sibling agent'};
    return {status: 'missing', ...(prose.some(d => d.includes(file)) ? {note: 'named in prose only: a dependency string names it, which is not a declaration; restate it as a held entry'} : {})};
  };
  const required = [
    ...r.tests.map(t => ({file: t.file, kind: 'test', why: t.level > 1 ? `level ${t.level}: ${t.via.join(' -> ')}` : `imports ${t.modules.join(', ')}`})),
    ...r.runners.filter(x => x.basis.includes('import') || x.basis.includes('target')).map(x => ({file: x.file, kind: 'runner',
      why: [x.basis.includes('target') ? `edits ${x.targets.join(', ')}` : null, x.basis.includes('import') ? 'imports a changeable module' : null].filter(Boolean).join('; ')})),
  ].map(x => ({...x, ...status(x.file)}));
  const rerun = r.runners.filter(x => !x.basis.includes('import') && !x.basis.includes('target')).map(x => ({file: x.file, decides: x.decides}));
  let transitive = [];
  if (depth < advisoryDepth) {
    const far = reach(snap, changeable, {depth: advisoryDepth, graph});
    const near = new Set(r.tests.map(t => t.file));
    transitive = far.tests.filter(t => !near.has(t.file)).map(t => ({file: t.file, level: t.level, via: t.via, ...status(t.file)})).filter(t => t.status === 'missing')
      .map(({file, level, via}) => ({file, level, via}));
  }
  return {subwave, agent: name, ref: snap.ref, changeable: changeable.length, required, missing: required.filter(x => x.status === 'missing'),
    rerun, transitive, opaque: r.opaque.map(o => o.file), unread: r.unread};
}

function render(results) {
  const L = [];
  for (const m of results) {
    L.push(`${m.manifest}: ${m.verdict}`);
    for (const a of m.agents) {
      const by = s => a.required.filter(x => x.status === s).length;
      L.push(`  ${a.subwave} / ${a.agent} at ${a.ref}: ${a.changeable} changeable module(s); ${a.required.length} reached test/runner file(s): ${by('granted')} granted, ${by('held')} held, ${a.missing.length} MISSING`);
      for (const x of a.missing) L.push(`    MISSING ${x.kind} ${x.file}  [${x.why}]${x.note ? `  (${x.note})` : ''}`);
      for (const x of a.required.filter(y => y.status === 'held')) L.push(`    held    ${x.kind} ${x.file}  [by ${x.by ?? 'an unnamed holder'}; ${x.where}]`);
      if (a.rerun.length) L.push(`    advisory: ${a.rerun.length} runner(s) decided by a reached test (re-run in full; scripts/test-gates/affected-runners.mjs): ${a.rerun.map(x => x.file).join(', ')}`);
      if (a.transitive.length) L.push(`    advisory: ${a.transitive.length} test file(s) reached only transitively, neither granted nor held (--transitive to require them; --json lists them)`);
      if (a.opaque.length) L.push(`    advisory: ${a.opaque.length} test/runner file(s) with a dynamic import this reader cannot resolve (--json lists them)`);
      if (a.unread.length) L.push(`    advisory: ${a.unread.length} runner mutation(s) whose target or deciding test the text reader could not read`);
    }
  }
  return L.join('\n');
}

export function main(argv, {out = s => console.log(s)} = {}) {
  let root = ROOT, ref = null, worktree = false, depth = 1, json = false, sub = null, only = null;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref') ref = argv[++i];
    else if (a === '--worktree') worktree = true;
    else if (a === '--root') root = path.resolve(argv[++i]);
    else if (a === '--subwave') sub = argv[++i];
    else if (a === '--agent') only = argv[++i];
    else if (a === '--json') json = true;
    else if (a === '--transitive' || a.startsWith('--transitive=')) depth = parseDepth(a);
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else files.push(a);
  }
  if (!files.length || (ref && worktree)) throw new Error('usage: manifest-reach.mjs <manifest.json>... [--subwave ID] [--agent NAME] [--ref COMMIT | --worktree] [--transitive[=N]] [--json] [--root DIR]');
  const snaps = new Map();
  const at = r => {
    const key = r ?? '\0worktree';
    if (!snaps.has(key)) { const snap = snapshot({root, ref: r}); snaps.set(key, {snap, graph: importGraph(snap)}); }
    return snaps.get(key);
  };
  const results = [];
  for (const file of files) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!manifest.subwaves || typeof manifest.subwaves !== 'object') throw new Error(`${file}: no subwaves (not an ownership manifest)`);
    const agents = [];
    for (const [s, as] of Object.entries(manifest.subwaves)) {
      if (sub && s !== sub) continue;
      for (const [name, agent] of Object.entries(as)) {
        if (only && name !== only) continue;
        const base = worktree ? null : ref ?? agent.base_commit ?? manifest.base_commit;
        if (!worktree && !base) throw new Error(`${file}: ${name} has no base_commit (pass --ref or --worktree)`);
        const {snap, graph} = at(base);
        agents.push(judgeAgent({manifest, subwave: s, name, snap, graph, depth}));
      }
    }
    if (!agents.length) throw new Error(`${file}: no agent selected`);
    results.push({manifest: file, verdict: agents.some(a => a.missing.length) ? 'FAIL' : 'PASS', agents});
  }
  out(json ? JSON.stringify({schema: SCHEMA, depth, results}, null, 2) : render(results));
  return results.some(r => r.verdict === 'FAIL') ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`manifest-reach: ${e.message}`); process.exitCode = 2; }
}
