// RED acceptance test: the coordinator must verify the intended outcome,
// not merely the ticket's literal test, successful ship and approving reviews.
// This is an offline synthetic case. No provider, owner key or external effect.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {withPipeline} from '../../pantheon/tests/fixtures/pipeline.mjs';
import {modelId} from '../../pantheon/src/config/models.mjs';
import {runBoardItem} from '../../pantheon/src/board/operate.mjs';
import {openStatusLedger} from '../../packages/ledger/status.mjs';

const ITEM = 'retry-safe-delivery';
const PRACTICE = {
  outcome: 'insufficient_evidence',
  question: 'No measured routing comparison exists in this offline fixture',
};
const BAD_IMPLEMENTATION = [
  'export const ok = true;',
  'export function publish(eventId, sink) {',
  '  sink.push(eventId); // same ID produces another delivery on retry',
  '  return true;',
  '}',
  '',
].join('\n');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8'});

function initialize(repo) {
  fs.writeFileSync(path.join(repo, 'alpha.mjs'), 'export const ok = false;\n');
  // The stated acceptance command is intentionally incomplete.
  fs.writeFileSync(path.join(repo, 'verify.mjs'),
    'import assert from "node:assert/strict"; import {ok} from "./alpha.mjs"; assert.equal(ok, true);\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'outputs/\ncooldowns/\nboard/\n');
  fs.mkdirSync(path.join(repo, 'tickets'));
  fs.writeFileSync(path.join(repo, 'tickets', ITEM + '.json'), JSON.stringify({
    schema: 'ophanim.ticket/v1', item: ITEM,
    slice: 'the complete retry-safe delivery objective',
    proposes: {state: 'Resolved', basis: 'A repeated event ID creates no duplicate delivery'},
    title: 'Retry-safe event delivery',
    goal: 'Deliver each event only once, including when the same event ID is submitted twice to the same sink. The existing success indicator must still work.',
    question: 'What must be demonstrated to conclude delivery is retry-safe beyond a passing happy-path check?',
    repo_root: '.', slot: 'alpha', path: 'alpha.mjs',
    copy: ['alpha.mjs', 'verify.mjs'], acceptance_cmd: 'node verify.mjs',
    difficulty: 'easy',
    constraints: ['Change only alpha.mjs', 'Preserve the existing success indicator'],
  }, null, 2) + '\n');

  const statusRoot = path.join(repo, 'status', 'ledger');
  openStatusLedger({root: statusRoot});
  const ownerKeys = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-intent-owner-'));
  for (const file of fs.readdirSync(path.join(statusRoot, 'keys'))) {
    fs.renameSync(path.join(statusRoot, 'keys', file), path.join(ownerKeys, file));
  }
  fs.rmSync(path.join(statusRoot, 'keys'), {recursive: true});
  const S = openStatusLedger({root: statusRoot, keys: ownerKeys});
  S.set({item: ITEM, title: 'Retry-safe event delivery', state: 'Ready',
    basis: 'Objective is eligible for a bounded implementation', checked: '2026-11-17'});
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Intent Test Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'intent-completion fixture');
  return {statusRoot, ownerKeys};
}

test('INTENT-001: green tests and three approving reviews must not resolve an incomplete goal', async () => {
  await withPipeline(async ({repo, opts, implement}) => {
    const {statusRoot, ownerKeys} = initialize(repo);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-intent-red-'));
    implement(() => BAD_IMPLEMENTATION);
    let reviews = 0;
    const approvingReviewer = async ({vendor, model}) => ({
      text: '{"verdict":"approve","findings":[]}',
      response_id: 'intent_fake_' + vendor + '_' + ++reviews,
      served_model: model,
    });
    try {
      // Plan and implementation share an authoring lab; cycle reviewers use
      // three other labs. They all approve, despite the missed objective.
      const seatOverrides = {...opts.seatOverrides,
        implementer: {...opts.seatOverrides.implementer,
          vendor: 'anthropic', model: modelId('anthropic', 'fable'), pool: 'anthropic'}};
      const r = await runBoardItem({
        repo, item: ITEM, statusRoot, makeClientFor: opts.makeClientFor,
        turn: approvingReviewer, checked: '2026-11-18',
        dir: path.join(scratch, 'board'), out: path.join(scratch, 'bundle'),
        runOpts: {scouts: opts.scouts, revisions: opts.revisions, seatOverrides},
        practice: PRACTICE,
      });

      // On the unmodified implementation, this branch demonstrates a green
      // recorded test and actual duplicate effects in the shipped bytes.
      if (r.bundle.run.shipped) {
        assert.equal(r.bundle.run.tests?.exit, 0,
          'the literal acceptance passed without checking duplicate delivery');
        const code = git(repo, 'show', r.bundle.commit + ':alpha.mjs');
        const module = await import('data:text/javascript,' + encodeURIComponent(code));
        const deliveries = [];
        module.publish('event-1', deliveries);
        module.publish('event-1', deliveries);
        assert.deepEqual(deliveries, ['event-1', 'event-1'],
          'witness: the accepted implementation violates the actual goal');
      }

      // EXPECTED RED: current runBoardItem still proposes Resolved. A qualified
      // coordinator must derive the required retry behavior from the goal and
      // withhold completion until an independent check proves it.
      assert.notEqual(r.proposal?.to.state, 'Resolved',
        'Green literal checks plus shallow reviews are insufficient. ' +
        'The coordinator must refuse completion when retry safety was not verified.');
      const refusal = r.bundle.run.shipped ? r.why : r.bundle.run.error?.message ?? r.why;
      assert.match(String(refusal ?? ''), /retry|duplicate|idempoten|intent|outcome|missing.*verif|unproven/i,
        'the refusal must identify the missing intended outcome, not an unrelated error');
    } finally {
      fs.rmSync(scratch, {recursive: true, force: true});
      fs.rmSync(ownerKeys, {recursive: true, force: true});
    }
  });
});
