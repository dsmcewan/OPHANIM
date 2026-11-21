// Independent review 2026-11-16, WF4: machine-specific paths (48 occurrences of one developer's home
// directory in 12 files, three of them tests) made results depend on the machine, and one sandbox
// assertion named a path that existed only on the original machine, so it passed vacuously elsewhere.
// No source, test, script or agent card may name a real /home/<user> path again. Tests that need a
// home-shaped path use a synthetic fixture name from FIXTURE_USERS, or os.homedir() for the real one.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP_DIRS = new Set(['.git', 'node_modules']);
// Source, tests, scripts and configuration. Prose (Markdown) is history and may quote a path; agent
// cards under .claude/ and .agents/ are instructions a seat acts on, so they are scanned too.
const SOURCE = /\.(mjs|cjs|js|ts|py|sh|json|ya?ml|toml)$/;
const FIXTURE_USERS = new Set(['u', 'x', 'fixture']);
// Recorded review runs (docs/reviews/<date>/findings-*/) are verbatim evidence of where a review ran,
// covered by their own SHA256SUMS; like Markdown, they are history, not code a machine depends on.
const RECORDED = /^docs\/reviews\/[^/]+\/findings-[^/]+\//;
const HOME = /(?<![\w.-])\/home\/([A-Za-z0-9._-]+)/g;

// The repository's own files: those git tracks (and not, say, an ignored agent worktree checked out
// under .claude/worktrees, which is a copy of some other commit). Falls back to a walk outside git.
function* files(dir, rel = '') {
  let tracked = null;
  try { tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean); } catch {}
  if (tracked) {
    for (const r of tracked) if (!RECORDED.test(r) && (SOURCE.test(r) || /(^|\/)\.(claude|agents)\//.test(r)) && fs.existsSync(path.join(root, r))) yield r;
    return;
  }
  for (const d of fs.readdirSync(dir, {withFileTypes: true})) {
    if (SKIP_DIRS.has(d.name)) continue;
    const r2 = rel ? `${rel}/${d.name}` : d.name;
    if (RECORDED.test(r2 + '/')) continue;
    if (d.isDirectory()) yield* files(path.join(dir, d.name), r2);
    else if (d.isFile() && (SOURCE.test(d.name) || /(^|\/)\.(claude|agents)\//.test(r2))) yield r2;
  }
}

export function machinePaths(text) {
  return [...text.matchAll(HOME)].filter(m => !FIXTURE_USERS.has(m[1])).map(m => m[0]);
}

test('WF4: no source, test, script or agent card names a real /home/<user> path', () => {
  const found = [];
  let scanned = 0;
  for (const rel of files(root)) {
    scanned++;
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    text.split('\n').forEach((line, i) => { for (const p of machinePaths(line)) found.push(`${rel}:${i + 1}: ${p}`); });
  }
  assert.ok(scanned > 300, `the scan reached the repository (${scanned} files)`);
  assert.deepEqual(found, []);
});

test('WF4: the scan catches a home path and passes the synthetic fixtures', () => {
  const user = ['col', 'chis'].join('');                // assembled, so this file stays clean itself
  assert.deepEqual(machinePaths(`const REPO = "/home/${user}/Projects/pantheon";`), [`/home/${user}`]);
  assert.deepEqual(machinePaths('cwd: "/home/x/my repo", home: "/home/u", p: "/home/fixture/a"'), []);
  assert.ok(RECORDED.test('docs/reviews/2026-11-18-independent-review/findings-2-openai-09d490f/run-summary.json'));
  assert.ok(!RECORDED.test('docs/reviews/2026-11-18-independent-review/HARNESS.md') && !RECORDED.test('pantheon/src/findings-x/a.mjs'));
  assert.deepEqual(machinePaths('url: "https://example.org/home/page"'), [], 'only a path that starts at /home');
});
