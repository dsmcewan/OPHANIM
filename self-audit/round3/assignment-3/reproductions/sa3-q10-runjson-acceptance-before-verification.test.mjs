// SELF-AUDIT A3 Q8/Q10 (af0dc30). PASSING = DEFECT PRESENT.
// CRASH POINT: live-run.mjs runConfirmed writes run.json FIRST (line 676) with acceptance {met: true, reasons: []}
// computed BEFORE the fresh verification, and verification: null; only after the child verifier returns (up to
// verifyTimeout, 120 s) is it rewritten (line 682). A launcher killed in that window leaves on disk a run.json that
// asserts the run was ACCEPTED while nothing verified it. The test captures the first write (what a kill at that
// moment leaves) by observing fs.writeFileSync.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {main, LIVE_RUN_SCHEMA} from '../ophanim/operate/live-run.mjs';
import {sandboxAvailable} from '../pantheon/src/agy/sandbox.mjs';
import {withDispatch} from '../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, git} from '../ophanim/operate/test-fixtures.mjs';

const box = await sandboxAvailable('bwrap');
const USAGE = JSON.stringify({conversation_id: '', status: 'SUCCESS', response: '', num_turns: 0, usage: {total_tokens: 0}, command: {name: 'usage', data: {groups: [
  {name: 'Gemini Models', description: 'Models within this group: Gemini 4 Hydrogen, Gemini 4 Carbon, Gemini 3.8 Flash', buckets: [{id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.7}]},
  {name: 'Claude and GPT models', description: 'Models within this group: Claude Opus 5.5', buckets: [{id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1}]}]}}});
const LIMITS = {total_provider_calls: 400, stage_provider_calls: 40, revisions: 2, stage_attempts: 2, elapsed_ms: 600_000,
  pipeline: {max_provider_calls: 40, max_revisions: 2, max_concurrent_units: 2, verify_timeout_ms: 60_000}};

test('Q10: the run.json a kill during the fresh verification leaves says acceptance met, verification null', {skip: box.ok ? false : box.why, timeout: 300_000}, async () => {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = fixture(repo, ['one', 'two'].map(item => ({item})));
    ctx.agyWorker('printf \'export const ok = true;\\n\' > "$dir/alpha.mjs"\n');
    fs.writeFileSync(path.join(repo, 'quota-report.txt'), USAGE);
    fs.writeFileSync(path.join(repo, 'quota-exit'), '0');
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa3-home-')));
    const g = path.join(home, '.gemini'), c = path.join(g, 'antigravity-cli');
    fs.mkdirSync(path.join(c, 'log'), {recursive: true}); fs.mkdirSync(path.join(g, 'config', 'projects'), {recursive: true});
    fs.writeFileSync(path.join(c, 'antigravity-oauth-token'), 'fake-token'); fs.writeFileSync(path.join(g, 'config', 'projects', 'default-cli-project.json'), '{}');
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa3-out-')));
    const before = process.env.HOME; process.env.HOME = home;
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const manifest = {schema: LIVE_RUN_SCHEMA, item: 'two', candidate_commit: head, profile: 'fit', independence: 'model', limits: structuredClone(LIMITS),
      billing: {scope: 'fixture', metered_gemini_failover: false, note: ''}, ledgers: {status_root: f.statusRoot, work_root: path.join(outside, 'run', 'work')},
      credentials: {required: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'agy-login'], gemini_api_key: 'not-used'}, out_dir: path.join(outside, 'run')};
    const file = path.join(outside, 'manifest.json'); fs.writeFileSync(file, JSON.stringify(manifest));
    const runFile = path.join(manifest.out_dir, 'run.json');
    const writes = [];
    const orig = fs.writeFileSync;
    fs.writeFileSync = function (p, data, ...rest) { if (String(p) === runFile) writes.push(JSON.parse(String(data))); return orig.call(this, p, data, ...rest); };
    try {
      const code = await main(['--manifest', file, '--confirm-spend', `two@${head.slice(0, 7)}`, '--repo', repo],
        {log: () => {}, err: () => {}, env: {...process.env, ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', XAI_API_KEY: 'x'}, seats: {turn: scriptedTurn(), makeClientFor: ctx.makeClientFor}});
      assert.equal(code, 0, 'the fixture run is accepted in the end');
      assert.equal(writes.length, 2, 'run.json is written twice: before and after the fresh verification');
      // What is on disk between the two writes (a kill during the child verifier):
      assert.equal(writes[0].verification, null);
      assert.deepEqual(writes[0].acceptance, {met: true, reasons: []}, 'the interim record claims acceptance before any verification ran');
    } finally {
      fs.writeFileSync = orig;
      if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
      fs.rmSync(home, {recursive: true, force: true}); fs.rmSync(outside, {recursive: true, force: true});
    }
  });
});
