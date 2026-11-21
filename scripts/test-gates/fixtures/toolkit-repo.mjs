// SYNTHETIC REPOSITORIES for the integration toolkit's tests (scripts/test-gates/toolkit-*.test.mjs): a disposable git
// repository in the system temporary directory, with known files and commits, removed when the test ends. Not a test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

/** {dir, git(...args), put(files), commit(files, message) -> commit id, base}. A file whose text is null is deleted. */
export function tempRepo(t, files = null) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-repo-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=toolkit-test', '-c', 'user.email=toolkit-test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('init', '-q');
  const put = fs2 => {
    for (const [rel, text] of Object.entries(fs2)) {
      const abs = path.join(dir, rel);
      if (text === null) { fs.rmSync(abs, {force: true}); continue; }
      fs.mkdirSync(path.dirname(abs), {recursive: true});
      fs.writeFileSync(abs, text);
    }
  };
  const commit = (fs2, message = 'change') => { put(fs2); git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  return {dir, git, put, commit, base: files ? commit(files, 'base') : null};
}

/** A synthetic mutation runner's text, in the shape mutationTable reads: one mutation editing `target`, decided by `test`. */
export function runnerText({id = 'M1', target, test, envExit = 'TOOLKIT_RUNNER_EXIT', record = 'TOOLKIT_RUNNER_RECORD'}) {
  return [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    `const TARGET = '${target}', SUITE = '${test}';`,
    'const one = (file, from, to) => ({file, from, to});',
    'export const MUTATIONS = [',
    `  {id: '${id}', what: 'a synthetic mutation', tests: [[SUITE, '^synthetic']], edits: [one(TARGET, 'x', 'y')]},`,
    '];',
    "if (process.argv.includes('--check')) { console.log('1 mutation(s)'); process.exit(0); }",
    `if (process.env.${record}) fs.writeFileSync(path.join(process.env.${record}, '${id}.json'), JSON.stringify(process.argv.slice(2)));`,
    `process.exit(Number(process.env.${envExit}_${id} ?? 0));`,
    '',
  ].join('\n');
}
