// The launcher for ONE live `fit` lifecycle item (live-run.mjs): manifest refusals, the dry run's plan (no provider
// call), the confirm string, and confirmed runs over SCRIPTED single-turn seats and the fixture's FAKE agy CLI (a real
// child process inside the REAL bwrap jail), with a FAKE HOME and a temp git repository. Nothing here is live.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openWorkLedger} from './work-ledger.mjs';
import {main, validateManifest, readManifest, confirmString, LIVE_RUN_SCHEMA, PLAN_SCHEMA, RECORD_SCHEMA, WORK_MARKER} from './live-run.mjs';
import {implementerPath} from './stages.mjs';
import {selectionPolicy} from '../../pantheon/src/route/frontier.mjs';
import {currentPolicy, policyDigest} from '../../pantheon/src/review/identity.mjs';
import {sandboxAvailable} from '../../pantheon/src/agy/sandbox.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, planFor, json, git, UNIT} from './test-fixtures.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const box = await sandboxAvailable('bwrap');
const needBwrap = {skip: box.ok ? false : `bwrap unavailable: ${box.why}`, timeout: 300_000};
const SECRET = 'sk-THIS-VALUE-MUST-NEVER-BE-PRINTED-0123456789';
const USAGE = JSON.stringify({conversation_id: '', status: 'SUCCESS', response: '', num_turns: 0, usage: {total_tokens: 0}, command: {name: 'usage', data: {groups: [
  {name: 'Gemini Models', description: 'Models within this group: Gemini 4 Hydrogen, Gemini 4 Carbon, Gemini 3.8 Flash', buckets: [{id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.7}]},
  {name: 'Claude and GPT models', description: 'Models within this group: Claude Opus 5.5', buckets: [{id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1}]}]}}});
const LIMITS = {total_provider_calls: 400, stage_provider_calls: 40, revisions: 2, stage_attempts: 2, elapsed_ms: 600_000,
  pipeline: {max_provider_calls: 40, max_revisions: 2, max_concurrent_units: 2, verify_timeout_ms: 60_000}};
const ITEMS = ['one', 'two', 'three'];
const ITEM = 'two';

/** Every file under `root`, by relative path, with its bytes' digest (keys included): the byte-identical check. */
const tree = root => {
  const out = {};
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else out[r] = createHash('sha256').update(fs.readFileSync(path.join(d, e.name))).digest('hex'); } };
  walk(root, '');
  return out;
};
const lines = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);

/**
 * A temp repo with three Ready items, a fake HOME with an Antigravity login, the fake agy's /usage report, an out dir
 * and a manifest outside the repo. `fn` gets {repo, f, out, manifest (object), write(over) -> file, run(argv, env?)}.
 */
async function withLiveFixture(fn, {worker = 'printf \'export const ok = true;\\n\' > "$dir/alpha.mjs"\n', turn = scriptedTurn()} = {}) {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const f = fixture(repo, ITEMS.map(item => ({item})));
    ctx.agyWorker(worker);
    fs.writeFileSync(path.join(repo, 'quota-report.txt'), USAGE);
    fs.writeFileSync(path.join(repo, 'quota-exit'), '0');
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-run-home-')));
    const g = path.join(home, '.gemini'), c = path.join(g, 'antigravity-cli');
    fs.mkdirSync(path.join(c, 'log'), {recursive: true}); fs.mkdirSync(path.join(g, 'config', 'projects'), {recursive: true});
    fs.writeFileSync(path.join(c, 'antigravity-oauth-token'), 'fake-token'); fs.writeFileSync(path.join(g, 'config', 'projects', 'default-cli-project.json'), '{}');
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-run-out-')));
    const before = {HOME: process.env.HOME};
    process.env.HOME = home;
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const manifest = {schema: LIVE_RUN_SCHEMA, item: ITEM, candidate_commit: head, profile: 'fit', independence: 'model', limits: structuredClone(LIMITS),
      billing: {scope: 'fixture: scripted providers and the fake agy only', metered_gemini_failover: false, note: ''},
      ledgers: {status_root: f.statusRoot, work_root: path.join(outside, 'run', 'work')},
      credentials: {required: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'agy-login'], gemini_api_key: 'not-used'}, out_dir: path.join(outside, 'run')};
    let n = 0;
    const write = (over = {}) => { const file = path.join(outside, `manifest-${++n}.json`); fs.writeFileSync(file, JSON.stringify({...manifest, ...over}, null, 2)); return file; };
    const env = {...process.env, ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: SECRET, XAI_API_KEY: 'x'};
    const run = async (argv, extra = {}) => {
      const out = [], err = [];
      const code = await main([...argv, '--repo', repo], {log: s => out.push(s), err: s => err.push(s), env: extra.env ?? env, seats: {turn, makeClientFor: ctx.makeClientFor}});
      const text = out.join('\n');
      assert.ok(!text.includes(SECRET) && !err.join('\n').includes(SECRET), 'a credential value is never printed');
      return {code, out: text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), err: err.join('\n')};
    };
    try { await fn({repo, f, ctx, turn, home, outside, manifest, write, run, env, head}); }
    finally {
      if (before.HOME === undefined) delete process.env.HOME; else process.env.HOME = before.HOME;
      fs.rmSync(home, {recursive: true, force: true}); fs.rmSync(outside, {recursive: true, force: true});
    }
  });
}
const modelTurns = repo => lines(path.join(repo, 'agy.log'));

test('the manifest: every limit must be chosen (the example\'s nulls are refused), unknown keys, a wrong profile or independence and inconsistent billing are refused, each reason named', () => {
  const example = path.join(HERE, 'live-run.example.json');
  assert.throws(() => readManifest(example), e => e.code === 'MANIFEST' && e.reasons.length === 9 && e.reasons.every(r => /is null: the owner must choose it/.test(r)));
  const good = {schema: LIVE_RUN_SCHEMA, item: 'two', candidate_commit: 'a'.repeat(40), profile: 'fit', independence: 'model', limits: structuredClone(LIMITS),
    billing: {scope: 's', metered_gemini_failover: false, note: ''}, ledgers: {status_root: '/s', work_root: '/w'},
    credentials: {required: ['anthropic-oauth', 'OPENAI_API_KEY', 'XAI_API_KEY', 'agy-login'], gemini_api_key: 'not-used'}, out_dir: '/o'};
  assert.equal(validateManifest(good).item, 'two');
  assert.equal(confirmString(good), `two@${'a'.repeat(7)}`);
  const why = over => { try { validateManifest({...structuredClone(good), ...over}); return []; } catch (e) { assert.equal(e.code, 'MANIFEST'); return e.reasons; } };
  assert.deepEqual(why({surprise: 1}), ['manifest: unknown key "surprise"']);
  assert.deepEqual(why({limits: {...LIMITS, pipeline: {...LIMITS.pipeline, extra: 2}}}), ['limits.pipeline: unknown key "extra"']);
  assert.deepEqual(why({profile: 'argo'}), ['profile is "fit" (this launcher runs the fit lifecycle only), not "argo"']);
  assert.deepEqual(why({independence: 'lab'}), ['independence is "model" (the fit lifecycle\'s rule), not "lab"']);
  assert.deepEqual(why({limits: {...LIMITS, elapsed_ms: 0}}), ['limits.elapsed_ms is a positive integer']);
  assert.deepEqual(why({limits: {...LIMITS, stage_provider_calls: 500}}), ['limits.stage_provider_calls is at most limits.total_provider_calls']);
  assert.match(why({limits: {...LIMITS, pipeline: {...LIMITS.pipeline, max_provider_calls: 41}}})[0], /pipeline.max_provider_calls is at most limits.stage_provider_calls/);
  assert.match(why({credentials: {required: ['OPENAI_API_KEY', 'XAI_API_KEY', 'agy-login'], gemini_api_key: 'not-used'}})[0], /exactly one Anthropic credential/);
  assert.deepEqual(why({credentials: {required: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY'], gemini_api_key: 'not-used'}}), ['credentials.required includes agy-login']);
  assert.match(why({credentials: {...good.credentials, gemini_api_key: 'required'}})[0], /"required" exactly when billing.metered_gemini_failover is true/);
  assert.deepEqual(why({require_subagent: {role: 'api-designer', model: 'grok-4.5', min_calls: 0}}), ['require_subagent.model is one of grok-4.6, grok-4.7', 'require_subagent.min_calls is a positive integer']);
  const missing = {...structuredClone(good)}; delete missing.out_dir; delete missing.billing;
  assert.throws(() => validateManifest(missing), e => e.reasons.includes('manifest.billing is required') && e.reasons.includes('manifest.out_dir is required'));
  assert.deepEqual(why({candidate_commit: 'abc'}), ['candidate_commit is a full 40-hex commit']);
});

test('DRY RUN (the default): ONE plan, zero provider calls, nothing created; the refusals: commit mismatch, dirty tree, foreign work_root, out_dir inside the repo, a missing credential, a wrong confirm string', needBwrap, async () => {
  await withLiveFixture(async ({repo, f, turn, ctx, manifest, write, run, env, head}) => {
    const statusBefore = tree(f.statusRoot);
    const r = await run(['--manifest', write()]);
    assert.equal(r.code, 0, r.out);
    const p = r.json;
    assert.deepEqual([p.schema, p.mode, p.ok, p.refusals, p.provider_calls, p.confirm_spend], [PLAN_SCHEMA, 'dry-run', true, [], 0, `${ITEM}@${head.slice(0, 7)}`]);
    assert.deepEqual([turn.log.length, ctx.calls.length, modelTurns(repo).length], [0, 0, 0], 'no provider call and no agy model turn');
    assert.equal(fs.existsSync(manifest.ledgers.work_root) || fs.existsSync(manifest.out_dir), false, 'a dry run creates nothing');
    assert.deepEqual(tree(f.statusRoot), statusBefore);
    // What it checked.
    assert.deepEqual([p.checkout, p.status_ledger.read_only, p.status_ledger.items, p.work_ledger.state], [{head, clean: true, ok: true}, true, 3, 'absent']);
    assert.deepEqual(p.gate, {gate: 'plan', reason: p.gate.reason, mode: 'author', status: 'Ready', blocker: null, runnable: true});
    assert.deepEqual([p.preflight.ok, p.preflight.checks.auth.ok, p.preflight.checks.card_tools.ok, p.preflight.lanes.map(l => [l.difficulty, l.lane, l.state])],
      [true, true, true, [['easy', 'gemini-4-hydrogen-medium', 'available'], ['medium', 'gemini-4-hydrogen-high', 'available'], ['hard', 'gemini-4-carbon-high', 'available']]]);
    assert.deepEqual(p.credentials.required.map(c => [c.name, c.present]), [['ANTHROPIC_API_KEY', true], ['OPENAI_API_KEY', true], ['XAI_API_KEY', true], ['agy-login', true]]);
    assert.deepEqual([p.seats.planner.model, p.seats.planner.source], ['claude-opus-5-5', 'no ticket: medium']);
    assert.deepEqual(Object.entries(p.seats.by_difficulty).map(([d, s]) => [d, s.dispatcher.model, s.implementer.start.model, s.subagent.model, s.reviewer.pinned.model]),
      [['easy', 'gpt-6-luna', 'gemini-4-hydrogen-medium', 'grok-4.6', 'gpt-6-luna'], ['medium', 'gpt-6.1-sol', 'gemini-4-hydrogen-high', 'grok-4.6', 'gpt-6.1-sol'], ['hard', 'gpt-6-astra', 'gemini-4-carbon-high', 'grok-4.7', 'gpt-6-astra']]);
    assert.deepEqual(p.seats.by_difficulty.hard.implementer.ladder.map(s => s.model), implementerPath('hard').map(s => s.model));
    assert.deepEqual([p.policy.selection.hash, p.policy.identity.digest, p.policy.independence], [selectionPolicy('fit').hash, policyDigest(currentPolicy()), 'model']);
    assert.match(p.metered_gemini_failover, /^DISABLED/);
    assert.match(p.notes[0], /bound CALLS, not dollars/);

    const refused = async (file, re, extra) => { const x = await run(['--manifest', file], extra); assert.equal(x.code, 1, x.out); assert.ok(x.json.refusals.some(w => re.test(w)), JSON.stringify(x.json.refusals)); return x; };
    await refused(write({candidate_commit: 'f'.repeat(40)}), /HEAD is [0-9a-f]{40}, not the manifest's candidate_commit/);
    fs.writeFileSync(path.join(repo, 'alpha.mjs'), 'export const ok = "dirty";\n');
    await refused(write(), /uncommitted changes in tracked files: M alpha.mjs/);
    git(repo, 'checkout', '--', 'alpha.mjs');
    fs.mkdirSync(manifest.ledgers.work_root, {recursive: true});
    fs.writeFileSync(path.join(manifest.ledgers.work_root, 'chain.jsonl'), '');
    await refused(write(), /is not empty and was not created by this launcher/);
    fs.rmSync(manifest.out_dir, {recursive: true});
    await refused(write({out_dir: path.join(repo, 'out')}), /out_dir .* is inside the repository/);
    await refused(write({ledgers: {...manifest.ledgers, work_root: path.join(f.statusRoot, 'work')}}), /work_root and status_root are separate/);
    const noX = {...env}; delete noX.XAI_API_KEY;
    await refused(write(), /credential XAI_API_KEY is not present/, {env: noX});
    await refused(write({billing: {...manifest.billing, metered_gemini_failover: true}, credentials: {...manifest.credentials, gemini_api_key: 'required'}}), /GEMINI_API_KEY is not present/);
    await refused(write({item: 'nope'}), /item "nope" is not on the status ledger/);
    const m = await run(['--manifest', write({limits: {...LIMITS, total_provider_calls: null}})]);
    assert.deepEqual([m.code, m.json.refused, m.json.refusals], [1, 'manifest', ['limits.total_provider_calls is null: the owner must choose it (no default is filled in)']]);
    const c = await run(['--manifest', write(), '--confirm-spend', `${ITEM}@0000000`]);
    assert.deepEqual([c.code, c.json.refused], [1, 'confirm-spend']);
    assert.match(c.json.refusals[0], new RegExp(`exactly "${ITEM}@${head.slice(0, 7)}"`));
    assert.equal((await run(['--manifest', write(), '--dry-run', '--confirm-spend', 'x'])).code, 2);
    assert.equal((await run(['--bogus'])).code, 2);
    assert.deepEqual([turn.log.length, ctx.calls.length, modelTurns(repo).length], [0, 0, 0], 'no refusal made a provider call');
    assert.equal(fs.existsSync(manifest.ledgers.work_root) || fs.existsSync(manifest.out_dir), false);
  });
});

// Unit alpha (hard) may consult an api-designer subagent; the worker asks it once.
const SUBAGENT_PLAN = scriptedTurn({planner: ({prompt}) => json(planFor(prompt, {work_units: [UNIT('alpha', {difficulty: 'hard', allowed_subagents: ['api-designer']})]}))});
const ASKING = 'agy_ask api-designer "what should ok be?" >/dev/null || exit 1\nprintf \'export const ok = true;\\n\' > "$dir/alpha.mjs"\n';

test('CONFIRMED: only the selected item runs (two other runnable items present) to an UNSIGNED outcome; the required Grok subagent call is recorded; a fresh reader verifies the record; the status ledger is byte-identical', needBwrap, async () => {
  await withLiveFixture(async ({repo, f, turn, ctx, manifest, write, run, head}) => {
    const statusBefore = tree(f.statusRoot);
    const file = write({require_subagent: {role: 'api-designer', model: 'grok-4.7', min_calls: 1}});
    const r = await run(['--manifest', file, '--confirm-spend', `${ITEM}@${head.slice(0, 7)}`]);
    const rec = JSON.parse(fs.readFileSync(path.join(manifest.out_dir, 'run.json'), 'utf8'));
    assert.equal(r.code, 0, JSON.stringify({acceptance: rec.acceptance, gate: rec.final_gate, stages: rec.stages.map(s => [s.stage, s.status, s.next?.why])}));
    assert.deepEqual([rec.schema, rec.acceptance, rec.final_gate.gate], [RECORD_SCHEMA, {met: true, reasons: []}, 'awaiting-owner']);
    // ONLY the selected item: the others were recorded at intake and skipped, never claimed.
    assert.deepEqual(rec.ticks[0].skipped.map(s => [s.item, s.why]), [['one', 'outside the --item scope'], ['three', 'outside the --item scope']]);
    assert.ok(rec.ticks.every(t => t.dispatched.every(d => d.item === ITEM)));
    const w = openWorkLedger({root: manifest.ledgers.work_root, create: false});
    assert.deepEqual([w.claims('one').length, w.claims('three').length], [0, 0]);
    assert.deepEqual(rec.stages.map(s => `${s.stage}:${s.status}`), ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed']);
    assert.deepEqual(rec.stages.map(s => s.hash), w.stages(ITEM).map(s => s.hash), 'every stage record hash is in the record');
    // The work ledger is the isolated, separately anchored one this launcher created, with its marker.
    const marker = JSON.parse(fs.readFileSync(path.join(manifest.ledgers.work_root, WORK_MARKER), 'utf8'));
    assert.deepEqual([marker.item, marker.anchor, rec.work_ledger.created], [ITEM, w.anchor, true]);
    // The REQUIRED subagent call: answered, by grok-4.7, in the accepted implement record.
    assert.deepEqual([rec.subagent_receipt.met, rec.subagent_receipt.counted, rec.subagent_receipt.calls[0].served_model], [true, 1, 'grok-4.7']);
    assert.ok(turn.log.some(l => l.kind === 'subagent' && l.model === 'grok-4.7'));
    // Served identities: every pipeline seat with what served it, and the stage teams.
    const served = rec.served_identities;
    for (const role of ['dispatcher', 'implementer', 'unit-reviewer', 'subagent']) assert.ok(served.some(s => s.source === 'pipeline.json' && s.role === role && s.served_model), role);
    assert.ok(served.some(s => s.source === 'stage team' && s.role === 'cycle-reviewer'));
    assert.deepEqual(served.find(s => s.source === 'pipeline.json' && s.role === 'implementer').served_model_source, 'input');
    assert.deepEqual(rec.budget_stops, []);
    assert.equal(rec.pipelines.length, 1);
    assert.ok(fs.existsSync(rec.pipelines[0].record));
    assert.deepEqual(rec.manifest.digest, 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    assert.equal(rec.plan.ok, true);
    // FRESH VERIFICATION, in the record and again here, read-only.
    assert.equal(rec.verification.ok, true, JSON.stringify(rec.verification));
    assert.deepEqual(rec.verification.run_ledgers.map(l => [l.role, l.ok]).sort(), [['plan review ledger', true], ['run ledger', true]].sort());
    assert.equal(rec.verification.status.unchanged, true);
    // The recorded verdict is a CHILD process's (independent review, assignment 3 (xAI grok-4.7, 7997657), question 10:
    // a fresh reader in the same process is not a fresh process); the in-process check is kept beside it.
    assert.ok(Number.isInteger(rec.verification.process.pid) && rec.verification.process.pid !== process.pid, JSON.stringify(rec.verification.process));
    assert.deepEqual([rec.verification.process.exit_code, rec.verification.in_process.ok], [0, true]);
    assert.equal(openWorkLedger({root: manifest.ledgers.work_root, create: false}).verify().ok, true);
    // The outcome stays UNSIGNED; the apply command is printed, never run.
    assert.deepEqual([rec.proposal.signed, fs.existsSync(rec.proposal.path)], [false, true]);
    assert.equal(r.json.proposal.apply_command, `OPHANIM_STATUS_LEDGER='${f.statusRoot}' node packages/ledger/status.mjs apply '${rec.proposal.path}' --keys "$OPHANIM_STATUS_KEYS"`);
    assert.deepEqual(tree(f.statusRoot), statusBefore, 'the status ledger is byte-identical: nothing was written to status_root');
    assert.equal(ctx.calls.length, 0, 'the metered Gemini API was never called');
    // A second launch on the same work_root resumes it (same item) and finds nothing to dispatch; another item is refused.
    const again = await run(['--manifest', file]);
    assert.deepEqual([again.code, again.json.work_ledger.state, again.json.gate.gate], [1, 'resumable', 'awaiting-owner']);
    const other = await run(['--manifest', write({item: 'one'})]);
    assert.ok(other.json.refusals.some(w => /created by this launcher for item "two", not "one"/.test(w)));
  }, {worker: ASKING, turn: SUBAGENT_PLAN});
});

test('CONFIRMED: require_subagent unmet (the plan allowed no subagent) -> exit 3, the reason recorded, the outcome still unsigned', needBwrap, async () => {
  await withLiveFixture(async ({manifest, write, run, head}) => {
    const r = await run(['--manifest', write({require_subagent: {role: 'api-designer', model: 'grok-4.7', min_calls: 1}}), '--confirm-spend', `${ITEM}@${head.slice(0, 7)}`]);
    const rec = JSON.parse(fs.readFileSync(path.join(manifest.out_dir, 'run.json'), 'utf8'));
    assert.equal(r.code, 3);
    assert.equal(rec.final_gate.gate, 'awaiting-owner');
    assert.deepEqual([rec.subagent_receipt.met, rec.subagent_receipt.counted], [false, 0]);
    assert.deepEqual(rec.acceptance, {met: false, reasons: ['require_subagent not met: 0 answered api-designer call(s) served by grok-4.7 in the accepted implement record; 1 required']});
    assert.equal(rec.verification.ok, true);
  });
});

test('CONFIRMED with metered_gemini_failover: false: a quota refusal on every lane of the unit\'s ladder BLOCKS the unit; the metered Gemini API is never called -> exit 3', needBwrap, async () => {
  await withLiveFixture(async ({ctx, manifest, write, run, head, repo}) => {
    ctx.agyQuota(implementerPath('easy').map(s => s.model));
    const r = await run(['--manifest', write(), '--confirm-spend', `${ITEM}@${head.slice(0, 7)}`]);
    const rec = JSON.parse(fs.readFileSync(path.join(manifest.out_dir, 'run.json'), 'utf8'));
    assert.equal(r.code, 3, JSON.stringify(rec.acceptance));
    assert.equal(ctx.calls.length, 0, 'no metered API call');
    const impl = rec.stages.find(s => s.stage === 'implement');
    assert.equal(impl.status, 'blocked');
    assert.match(impl.blocker.what, /PIPELINE_UNITS_UNRESOLVED/);
    assert.ok(rec.blockers.some(b => b.blocker?.code === 'PIPELINE_UNITS_UNRESOLVED'));
    const attempts = rec.served_identities.filter(s => s.source === 'pipeline.json' && s.role === 'implementer');
    assert.ok(attempts.length && attempts.every(a => a.quota_failover?.used === false && a.quota_failover.disabled === true), JSON.stringify(attempts));
    // Each subscription BASE MODEL once, then blocked: after a quota refusal the same base model's other thinking levels
    // share its quota and are not launched (independent review round 2, assignment 3 (Google gemini-4-carbon, manual,
    // 77480d6), finding 5.1).
    const seenBase = new Set();
    const bases = implementerPath('easy').map(s => s.model).filter(m => { const b = m.replace(/-(low|medium|high|xhigh)$/, ''); return !seenBase.has(b) && seenBase.add(b); });
    assert.deepEqual(modelTurns(repo).map(l => l.split(' ')[1]), bases, 'each subscription base model once, then blocked');
    assert.match(rec.acceptance.reasons[0], /did not reach its outcome/);
    assert.equal(rec.verification.ok, true);
  });
});

test('CONFIRMED: the declared total stops the run when a stage could exceed it; the budget stop is recorded -> exit 3', needBwrap, async () => {
  await withLiveFixture(async ({manifest, write, run, head}) => {
    const r = await run(['--manifest', write({limits: {...LIMITS, total_provider_calls: 40}}), '--confirm-spend', `${ITEM}@${head.slice(0, 7)}`]);
    const rec = JSON.parse(fs.readFileSync(path.join(manifest.out_dir, 'run.json'), 'utf8'));
    assert.equal(r.code, 3);
    assert.deepEqual(rec.stages.map(s => `${s.stage}:${s.status}`), ['plan:passed']);
    assert.ok(rec.budget_stops.some(s => s.source === 'tick' && /provider-call budget: \d+ left of 40, a stage needs up to 40/.test(s.why)), JSON.stringify(rec.budget_stops));
    assert.ok(rec.spent.calls <= 40);
    assert.equal(rec.final_gate.gate, 'implement');
  });
});
