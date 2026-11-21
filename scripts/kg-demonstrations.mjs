#!/usr/bin/env node
// THE DIRECTIVE'S TWELVE DEMONSTRATIONS, RUN (docs/knowledge-graph/directive-2026-11-20.md section 11; the operational
// report, docs/knowledge-graph/operational-report.md).
//
//   node scripts/kg-demonstrations.mjs [--json FILE]
//
// For each demonstration: the test cells that carry it (a file and the names of its tests), a run of exactly those tests
// at the checkout's HEAD, and the committed mutations each cell decides -- read from every runner's table AS TEXT
// (ophanim/graph/extract/verification.mjs mutationTable), never by importing a runner. A cell whose names say SYNTHETIC
// is synthetic; no cell is live operational evidence. Exit 1 when any cell fails, is missing, or runs no test.
// Needs OPHANIM_TELOS_ROOT for the cells that read the pinned TELOS checkout.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync, execFileSync} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = process.argv.indexOf('--json'), out = at > 0 ? process.argv[at + 1] : null;
const {mutationTable} = await import(pathToFileURL(path.join(repo, 'ophanim/graph/extract/verification.mjs')).href);
const git = (...a) => execFileSync('git', ['-C', repo, ...a], {encoding: 'utf8'}).trim();

// Each demonstration: the cells that carry it, as [file, exact-name regex]. SYNTHETIC unless the cell reads the real repository.
const DEMOS = [
  {n: 1, title: 'Shared dependency discovery', cells: [['ophanim/graph/graph-d1-work.test.mjs', /demonstration 1/], ['ophanim/operate/graph-d2-concurrency.test.mjs', /./]]},
  {n: 2, title: 'Impact propagation', cells: [['ophanim/graph/graph-d1-reassess.test.mjs', /demonstrations? 2/], ['ophanim/graph/impact.test.mjs', /^impact/]]},
  {n: 3, title: 'Historical traceability', cells: [['ophanim/graph/impact.test.mjs', /^trace:/], ['ophanim/graph/graph-d1-why.test.mjs', /^why it exists/]]},
  {n: 4, title: 'Capability-based routing', cells: [['pantheon/tests/capability-eligibility.test.mjs', /./], ['pantheon/tests/capability-sdk-bridge.test.mjs', /./]]},
  {n: 5, title: 'Learning reuse', cells: [['ophanim/graph/graph-d1-learning.test.mjs', /./], ['ophanim/graph/graph-lane-learning.test.mjs', /./]]},
  {n: 6, title: 'Contradictory evidence', cells: [['packages/graph/tests/ledger.test.mjs', /^contradictions|^hypothetical/], ['ophanim/graph/graph-context.test.mjs', /demonstration 6/]]},
  {n: 7, title: 'Source invalidation', cells: [['ophanim/graph/graph-d1-reassess.test.mjs', /demonstrations? 7|2 and 7/]]},
  {n: 8, title: 'Concurrency', cells: [['ophanim/graph/graph-d1-concurrency.test.mjs', /demonstration 8/], ['ophanim/operate/graph-d2-concurrency.test.mjs', /./], ['packages/graph/tests/concurrency.test.mjs', /./]]},
  {n: 9, title: 'Restart and replay', cells: [['ophanim/graph/graph-d1-concurrency.test.mjs', /demonstration 9/], ['packages/graph/tests/replay.test.mjs', /./], ['packages/graph/tests/checkpoint.test.mjs', /./]]},
  {n: 10, title: 'Federation', cells: [['packages/graph/tests/federation.test.mjs', /./]]},
  {n: 11, title: 'Actual lifecycle integration', cells: [['ophanim/operate/graph-d2-demo11.test.mjs', /./]]},
  {n: 12, title: 'Negative cases', cells: [['ophanim/graph/extract.test.mjs', /demonstration 12/], ['ophanim/graph/graph-d1-why.test.mjs', /demonstration 12/], ['ophanim/graph/graph-d1-reassess.test.mjs', /demonstration 12/], ['packages/graph/tests/schema.test.mjs', /./], ['ophanim/graph/pentest/f-graph-integrity.test.mjs', /./]]},
];

// The test names of a file, read from its text (top-level test('...') calls).
const namesOf = file => {
  const t = fs.readFileSync(path.join(repo, file), 'utf8');
  return [...t.matchAll(/^test\((['"`])((?:\\.|(?!\1).)*)\1/gm)].map(m => m[2].replace(/\\(.)/g, '$1'));
};
// Every committed runner's mutations with their deciding [file, pattern] pairs, read as text.
const runners = git('ls-files', '*.mutate.mjs').split('\n').filter(Boolean);
const decisions = [];
for (const r of runners) {
  const src = git('show', `HEAD:${r}`);
  for (const m of mutationTable(src).mutations) decisions.push({runner: r, id: m.id, what: m.what, files: m.tests, patterns: m.patterns ?? []});
}
const head = git('rev-parse', 'HEAD');
const result = {head, at: new Date().toISOString(), node: process.version, demos: []};
for (const d of DEMOS) {
  const cells = [];
  for (const [file, re] of d.cells) {
    if (!fs.existsSync(path.join(repo, file))) { cells.push({file, missing: true}); continue; }
    const names = namesOf(file).filter(n => re.test(n));
    // The mutations a cell decides: a runner mutation that names this file and a pattern matching one of these names
    // (a mutation naming the file with no pattern runs the whole file, so it decides every cell of it).
    const deciding = decisions.filter(m => m.files.includes(file) && (m.patterns.length === 0 || m.patterns.some(p => { try { return names.some(n => new RegExp(p).test(n)); } catch { return false; } })))
      .map(m => `${path.basename(m.runner, '.mutate.mjs')}:${m.id}`);
    const pattern = names.map(n => `^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).join('|');
    const run = names.length ? spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, file], {cwd: repo, encoding: 'utf8', timeout: 600_000, env: process.env}) : null;
    const count = k => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(run?.stdout ?? '')?.[1] ?? NaN);
    cells.push({file, names, deciding: [...new Set(deciding)].sort(), run: run ? {status: run.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped')} : null,
      synthetic: names.map(n => /SYNTHETIC/i.test(n)).some(Boolean)});
  }
  result.demos.push({...d, cells: cells.map(c => ({...c})), title: d.title});
  const s = cells.map(c => `${c.file.split('/').pop()} ${c.run ? `${c.run.pass}/${c.run.tests}` : 'n/a'} [${(c.deciding ?? []).length} mut]`).join('; ');
  console.log(`${d.n}. ${d.title}: ${s}`);
}
if (out) fs.writeFileSync(out, JSON.stringify(result, (k, v) => (v instanceof RegExp ? String(v) : v), 1) + '\n');
const bad = result.demos.flatMap(d => d.cells.filter(c => c.missing || !c.run || c.run.status !== 0 || !(c.run.tests > 0)).map(c => `${d.n}: ${c.file}`));
if (bad.length) { console.error(`not demonstrated: ${bad.join('; ')}`); process.exit(1); }
