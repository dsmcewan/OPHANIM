// FIXTURES for Slice B's tests: a temporary git repository with SYNTHETIC files and commits (its own history, never
// this checkout's), and the REAL graph of this checkout at its HEAD commit, built once per test process. Synthetic keys
// only (extract/index.mjs openSystemsGraph); no provider.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {systemsGraph, ROOT} from '../extract/index.mjs';

export const T0 = '2026-11-20T12:00:00.000Z';
export const at = minutes => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
export const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=graph-b-test', '-c', 'user.email=graph-b-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();

/** A new git repository in a temporary directory: write(files) to the working tree, commit(files, msg) -> commit id. */
export function tempRepo(t, prefix = 'ophanim-graph-b-repo-') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t?.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  git(repo, 'init', '-q');
  const write = files => { for (const [p, text] of Object.entries(files)) { const abs = path.join(repo, p); if (text === null) fs.rmSync(abs, {force: true}); else { fs.mkdirSync(path.dirname(abs), {recursive: true}); fs.writeFileSync(abs, text); } } };
  const commit = (files, msg = 'change') => { write(files); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '--allow-empty', '-m', msg); return git(repo, 'rev-parse', 'HEAD'); };
  return {repo, write, commit};
}

/** The package.json a synthetic repository needs for suites.mjs: one root suite over its tests. */
export const PACKAGE = JSON.stringify({name: 'fixture', private: true, type: 'module', scripts: {test: 'npm --prefix lib test', 'test:proof': 'node --test tests/*.test.mjs', 'test:gates:self': 'node --test gates/*.test.mjs'}}, null, 2);
export const LIB_PACKAGE = JSON.stringify({name: '@fixture/lib', private: true, type: 'module', scripts: {test: 'node --test tests/*.test.mjs'}}, null, 2);
export const WORKFLOW = 'name: q\non: push\njobs:\n  q:\n    timeout-minutes: 30\n    steps:\n      - run: npm test\n        timeout-minutes: 20\n      - run: npm run test:proof\n        timeout-minutes: 20\n';

let real = null;
/** The real graph of this checkout at HEAD (repository, verification, records, lessons, status), built once. */
export function realGraph() {
  real ??= systemsGraph({repo: ROOT, observed_at: T0});
  return real;
}
export function closeRealGraph() { if (real) { real.close(); real = null; } }
export {ROOT};
