// Owner-requested extra reviewer. Imports the pinned runner without modifying it.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';

const root = '/mnt/c/users/dsmce/documents/codex/2026-11-16/he';
const state = JSON.parse(await readFile(join(root, 'work/review-09d490f-state.json'), 'utf8'));
const manifest = JSON.parse(await readFile(state.manifest, 'utf8'));
const extra = manifest.extra_assignments.find(a => a.n === 3 && a.model === 'gpt-6-astra');
const repoRoot = extra.checkout;
const moduleUrl = name => pathToFileURL(join(repoRoot, 'pantheon/src/review-runner', name)).href;
const { loadBrief, listedTests, SEPARATOR, sha256, REVIEW_DIR } = await import(moduleUrl('brief.mjs'));
const { permissionsFor, CAPS } = await import(moduleUrl('tools.mjs'));
const { WITHHELD } = await import(moduleUrl('sandbox.mjs'));
const { subscriptionMain } = await import(moduleUrl('subscription.mjs'));
const { codexSdkInfo } = await import(moduleUrl('codex.mjs'));
const run = promisify(execFile);
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION/i.test(name)) delete env[name];
}
delete env.CODEX_HOME;
delete env.GROK_HOME;
env.HOME = extra.home;
env.PATH = manifest.node_bin + ':/home/colchis/.local/bin:/usr/local/bin:/usr/bin:/bin';
env.LANG = 'C.UTF-8';
const git = args => run('git', ['-C', repoRoot, ...args], { env, maxBuffer: 16 * 1024 * 1024 });
if ((await git(['rev-parse', 'HEAD'])).stdout.trim() !== manifest.commit) throw Error('Wrong review commit');
await git(['diff', '--quiet', 'HEAD', '--']);
const files = (await git(['ls-tree', '-r', '--name-only', '-z', manifest.commit])).stdout.split('\0').filter(Boolean);
const b = await loadBrief({ repoRoot, n: 3, commit: manifest.commit, harnessValues: {
  MAX_TURNS: 'n/a', MAX_TOOL_CALLS: 'n/a', MAX_OUTPUT_TOKENS: 'n/a', TIMEOUT_S: 'n/a',
  READ_CAP: CAPS.READ_BYTES, GREP_CAP: CAPS.GREP_MATCHES, OUTPUT_CAP: CAPS.OUTPUT_BYTES,
} });
const originalBriefHash = sha256(b.brief);
const originalRow = { ...b.row };
const note = 'Owner-requested ADDITIONAL independent review: perform assignment 3 using OpenAI gpt-6-astra through the Codex SDK. For this extra run only, the README table\'s xAI/Grok reviewer seat is replaced by OpenAI/gpt-6-astra. Keep assignment 3\'s scope, testing permissions, and findings format. The README and assignment text below are otherwise verbatim from the reviewed commit. This is a fresh review: do not read or use any other reviewer\'s findings, transcripts, reproduction files, or session history, anywhere on this machine. All docs/reviews/*/findings-* files and folders are withheld. DO NOT look at Git history for those paths: no git show, log, diff, restore, checkout, object lookup, or any other means of retrieving their historical content, including c964307 and 7997657. Do not reconstruct or recover deleted findings. Their absence is intentional. Base the review on the code and assignment brief at the specified commit.';
b.brief = note + SEPARATOR + b.brief;
const row = { ...originalRow, lab: 'OpenAI', vendor: 'openai', model: 'gpt-6-astra', model_cell: 'OpenAI, `gpt-6-astra`' };
const listed = listedTests(b.assignmentText, files);
const permissions = permissionsFor(row.testing, listed.files);
if (!permissions?.write_test) throw Error('Assignment 3 test permissions changed');
const a = { files, b, row, listed, permissions, withheld: files.filter(p => WITHHELD.some(re => re.test(p))) };
const receipt = { owner_request: extra.owner_requested_override, extra_review: true, assignment: 3, commit: manifest.commit,
  original_row: originalRow, effective_row: row, original_brief_sha256: originalBriefHash, effective_brief_sha256: sha256(b.brief),
  override_note: note, override_note_sha256: sha256(note), readme_sha256: sha256(b.readme), assignment_sha256: sha256(b.assignmentText),
  wrapper: import.meta.url, wrapper_sha256: sha256(await readFile(new URL(import.meta.url))),
  reviewed_source_modified: false, earlier_review_history_supplied: false, max_wall_s: 3600, telos_root: manifest.telos_root };
await writeFile(join(manifest.outputs, 'extra-gpt-assignment-3-owner-override.json'), JSON.stringify(receipt, null, 2) + '\n');
const continueIndex = process.argv.indexOf('--continue');
const opts = { via: 'subscription', n: 3, commit: manifest.commit, limits: { max_wall_s: 3600 },
  notes: ['Owner-requested additional gpt-6-astra review of assignment 3; only this invocation changes reviewer identity'], ignoredCaps: [],
  out: null, dryRun: process.argv.includes('--dry-run'), keep: false, force: false, telosRoot: manifest.telos_root,
  allowApiKeyInCli: false, skipModelCheck: false, grokStateDir: null, codexCli: null, grokCli: null, agyCli: null,
  continue: continueIndex >= 0 ? process.argv[continueIndex + 1] : null };
const sdkInfo = codexSdkInfo();
if (!sdkInfo.ok || sdkInfo.version !== '0.170.0') throw Error('Unexpected Codex SDK package');
const { Codex: NativeCodex } = await import(pathToFileURL(sdkInfo.entry).href);
class CleanReviewCodex extends NativeCodex {
  startThread(options) {
    const worktree = realpathSync(options.workingDirectory);
    if (!/^\/tmp\/ophanim-review-[^/]+\/worktree$/.test(worktree)) throw Error('Unexpected review worktree');
    const reviews = join(worktree, 'docs/reviews');
    const removed = [];
    for (const dir of readdirSync(reviews, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const entry of readdirSync(join(reviews, dir.name), { withFileTypes: true })) {
        if (!entry.name.startsWith('findings-')) continue;
        const relative = join('docs/reviews', dir.name, entry.name);
        rmSync(join(worktree, relative), { recursive: true, force: true });
        removed.push(relative);
      }
    }
    const remaining = [];
    for (const dir of readdirSync(reviews, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const entry of readdirSync(join(reviews, dir.name))) {
        if (entry.startsWith('findings-')) remaining.push(join('docs/reviews', dir.name, entry));
      }
    }
    if (remaining.length) throw Error('Findings paths remain in review worktree');
    writeFileSync(join(manifest.outputs, 'extra-gpt-assignment-3-withholding.json'), JSON.stringify({
      at: new Date().toISOString(), commit: manifest.commit, worktree,
      normal_runner_withholding_applied: true, additionally_removed_empty_findings_directories: removed,
      findings_paths_remaining_before_model_start: remaining,
      git_history_access_explicitly_prohibited: true, override_note_sha256: sha256(note),
    }, null, 2) + '\n');
    return super.startThread(options);
  }
}
process.exitCode = await subscriptionMain({ opts, a, repoRoot, env, deps: { cwd: repoRoot, CodexSDK: CleanReviewCodex },
  out: text => process.stdout.write(text), err: text => process.stderr.write(text), EXIT: { complete: 0, refused: 1, usage: 2, incomplete: 3 },
  outPaths: { findings: join(repoRoot, REVIEW_DIR, 'findings-3-openai.md'), transcript: join(repoRoot, REVIEW_DIR, 'findings-3-openai.transcript.json') } });
