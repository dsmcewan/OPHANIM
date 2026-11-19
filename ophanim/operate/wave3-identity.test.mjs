// WAVE 3, register L-504 invariant 2, THROUGH THE LIFECYCLE: a model's identity -- the model requested, the model served,
// where the served name came from (served_model_source) and the lab -- is kept by every projection the lifecycle makes,
// from the producer record to its consumer, and the consumers that decide exclusion read the served identity:
//   plan stage   the planner's served identities (stages.mjs plan), the plan-review finders, a resumed plan cycle's
//                lineage (restored from the cycle's recorded contributors), a dispatcher's advisory return inherited by
//                the revised plan (dedupe), and the run carrying it out (stage5_excluded);
//   implement    the five-stage pipeline's authored rows, arbiter rows, unit findings and team (stages.mjs implementUnits),
//                including an implementer answer that named no serving model (the metered Gemini failover);
//   review       the change cycle's recorded contributors on the run ledger, its team;
//   validate     the validator's record and the change reviewers it excludes;
//   outcome      the unsigned status proposal's evidence (board/operate.mjs proposeFromBundle) and its re-check
//                (packages/ledger/status.mjs checkEvidenceLedgers);
//   live run     servedIdentities and subagentReceipt (live-run.mjs);
//   public       the cycle's provenance (public/provenance.mjs cycleRecord), the evidence and work sections (record.mjs).
// The scheduler's tick runs the real stage executors; Pantheon's pipeline runs with the fixture's fake agy CLI writing
// the files (pantheon/tests/fixtures/dispatch.mjs); every single-turn seat is scripted and SERVED under a name other
// than the one asked (a dated snapshot), or marked as the stamped input, or by another model, per the table below. No
// provider is called. The pipeline-level projections are in pantheon/tests/wave3-identity.test.mjs; the mutations that
// prove the paths the base already held are in wave3-identity.mutate.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {makeExecutors, implementerPath} from './stages.mjs';
import {servedIdentities, subagentReceipt} from './live-run.mjs';
import {resolveModel, contributorKeys} from '../../pantheon/src/review/identity.mjs';
import {openPantheonLedger} from '../../pantheon/src/ledger/system.mjs';
import {deriveCycle, ledgerView} from '../../pantheon/src/ledger/cycle-kinds.mjs';
import {proposalRefusal, checkEvidenceLedgers} from '../../packages/ledger/status.mjs';
import {openLedgerReadOnly, cycleRecord} from '../public/provenance.mjs';
import {evidenceSection, workSection} from '../public/record.mjs';
import {readWorkRecord} from '../public/work.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {fixture, scriptedTurn, planFor, json, UNIT, APPROVE, LIMITS, unitApprove, unitReject} from './test-fixtures.mjs';

const L504 = 'wave 3, L-504 invariant 2';
const DONE = ['plan:passed', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed'];
const seq = (w, item) => w.stages(item).map(s => `${s.stage}:${s.status}`);
/**
 * THE TEST'S OWN READER of the two documented row shapes (review/identity.mjs identityOf states the same rule; it is not
 * imported, so the oracle does not rest on the code under test). An ANSWER row (a pipeline record, a finder, a reviewer,
 * a team row) names the model asked as `model` and the model that answered as `served_model` (null: none was named;
 * omitted on a finder row when it is the asked name). A CONTRIBUTION row names the model that answered as `model` (the
 * asked one, marked "unnamed", when none was named) and the model asked as `requested_model` when it differs.
 */
const who = r => ({requested_model: r.requested_model ?? r.model ?? null,
  served_model: Object.hasOwn(r, 'served_model') ? r.served_model ?? null : r.served_model_source === 'unnamed' ? null : r.model ?? null,
  served_model_source: r.served_model_source ?? null});
const id = (requested_model, served_model, served_model_source) => ({requested_model, served_model, served_model_source});
const set = list => [...list].map(x => JSON.stringify(x)).sort().map(x => JSON.parse(x));
const ledgerOf = root => { const L = openPantheonLedger({root}).ledger; return {L, view: ledgerView(L)}; };
const ticks = async (opts, max = 8) => {
  const all = [];
  for (let i = 0; i < max; i++) { const r = await tick({...opts, limits: {...opts.limits, retry_after_ms: 0}}); all.push(...r.dispatched); if (!r.dispatched.length) break; }
  return {dispatched: all};
};
const why = r => JSON.stringify(r.dispatched.map(d => [d.stage, d.status, d.next?.why]));

// THE SOURCES. Every judging seat (planner, plan and change reviewers, validator, dispatcher, unit reviewer) answers under
// another NAME of the model asked (a dated snapshot: the same identity, so it is admitted) with the marker, or -- "input"
// -- as the stamped requested name. The hard unit's subagent is asked twice: both answers are served by SUB (another
// model, except under "input", where the served name is the asked one) under two different markers.
const MODES = [
  {source: 'provider', other: 'unknown', judge: m => `${m}-20261101`, sub: 'grok-4.6'},
  {source: 'unknown', other: 'provider', judge: m => `${m}-20261101`, sub: 'grok-4.6'},
  {source: 'input', other: 'provider', judge: m => m, sub: 'grok-4.7'},
];
const GAMMA = UNIT('c', {owned_paths: ['gamma/**'], difficulty: 'hard', verify_cmd: 'node gamma/gamma.test.mjs', invariants: ['gamma/gamma.mjs exports g === 3 and its test proves it'], allowed_subagents: ['api-designer']});
const TWO = {work_units: [UNIT('alpha'), GAMMA], slices: [{id: 's1', title: 'alpha.mjs exports ok = true', slot: 'alpha', path: 'alpha.mjs'}, {id: 's3', title: 'gamma.mjs', slot: 'gamma', path: 'gamma/gamma.mjs'}]};
const WORKER = `case "$unit" in
  alpha) printf 'export const ok = true;\\n' > "$dir/alpha.mjs" ;;
  c) agy_ask api-designer "what should g be?" >/dev/null || exit 1; agy_ask api-designer "and its test?" >/dev/null || exit 1
     mkdir -p "$dir/gamma"; printf 'export const g = 3;\\n' > "$dir/gamma/gamma.mjs"; printf 'import {g} from "./gamma.mjs"; if (g !== 3) process.exit(1);\\n' > "$dir/gamma/gamma.test.mjs" ;;
esac
`;

for (const M of MODES) {
  test(`${L504}, source "${M.source}": every projection of the lifecycle keeps requested, served and marker, and every exclusion reads the served identity`, {timeout: 300_000}, async t => {
    await withDispatch(async ctx => {
      const {dir: repo, makeClientFor} = ctx;
      ctx.agyWorker(WORKER);
      const item = `ident-${M.source}`;
      const f = fixture(repo, [{item}]);
      let subCalls = 0, found = 0, judged = 0;
      const serve = ({kind, model}) => (kind === 'subagent' ? {served_model: M.sub, served_model_source: ++subCalls === 1 ? M.source : M.other}
        : {served_model: M.judge(model), served_model_source: M.source});
      const turn = scriptedTurn({
        planner: ({prompt}) => json(planFor(prompt, TWO)),
        // One plan-review finding from the xAI seat (a finder row), then approvals.
        'plan-review': ({vendor}) => (vendor === 'xai' && ++found === 1
          ? json({verdict: 'request_changes', findings: [{severity: 'major', file: null, line: null, claim: '[source: verify.mjs] the plan names no regression check', sources: ['verify.mjs'], reproduction: null}]}) : APPROVE),
        // Unit alpha's pinned Stage 5 reviewer rejects once (its finding feeds a revision: a critique row and a unit finding).
        'unit-review': ({rubric, passed, unit_id}) => JSON.stringify(unit_id === 'alpha' && ++judged === 1 || !passed ? unitReject(rubric, ['say why ok is exported']) : unitApprove(rubric)),
      }, {serve});
      const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir});
      const r = await ticks({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
      const w = openWorkLedger({root: f.workRoot});
      assert.deepEqual(seq(w, item).filter(x => !x.startsWith('review:pending')), DONE, why(r));
      const stages = w.stages(item);
      const last = s => stages.filter(x => x.stage === s && x.status === 'passed').at(-1);
      const [plan, impl, rev, val, out] = ['plan', 'implement', 'review', 'validate', 'outcome'].map(last);
      const rec = JSON.parse(fs.readFileSync(impl.outputs.run.record, 'utf8'));
      const U = rec.units;
      const disp = u => U[u].dispatch.model;
      const J = m => id(m, M.judge(m), M.source);

      await t.test('S11 the planner\'s served identity: the served row names the model asked and the marker (or the seat row carries the marker)', () => {
        const rows = plan.contributions.filter(c => c.purpose === 'plan').map(who);
        assert.ok(rows.some(x => JSON.stringify(x) === JSON.stringify(J(plan.outputs.planner.model))), `the planner's served identity is not on the plan's contributions: ${JSON.stringify(rows)}`);
      });
      await t.test('S12/S16 the plan-review finder row: asked and served name, marker', () => {
        const fr = plan.contributions.filter(c => c.purpose === 'plan-review');
        assert.equal(fr.length, 1);
        assert.deepEqual(who(fr[0]), J('grok-4.7'));
      });
      await t.test('S1 the implement stage\'s authored rows: work (stamped input), both subagent answers (two markers), the critique', () => {
        const rows = p => impl.contributions.filter(c => c.purpose === p).map(who);
        assert.deepEqual(set(rows('work')), set(Object.values(U).flatMap(u => u.attempts.map(a => id(a.model, a.model, 'input')))));
        assert.deepEqual(set(rows('subtask')), set([id('grok-4.7', M.sub, M.source), id('grok-4.7', M.sub, M.other)]), 'a subagent answer\'s identity was dropped');
        assert.deepEqual(rows('critique'), [J(disp('alpha'))]);
      });
      await t.test('S2 the arbiter rows: every dispatcher by asked and served name, with the marker', () => {
        assert.deepEqual(set(impl.contributions.filter(c => c.purpose === 'arbiter').map(who)), set(['alpha', 'c'].map(u => J(disp(u)))));
      });
      await t.test('S6 the unit finding names its Stage 5 reviewer by asked and served name, with the marker', () => {
        const fr = impl.findings.filter(x => x.cause === 'in-run-review');
        assert.ok(fr.length >= 1 && fr.every(x => x.unit === 'alpha'), JSON.stringify(fr));
        for (const x of fr) assert.deepEqual(who(x), J(disp('alpha')), 'the unit finding dropped its reviewer\'s served identity');
      });
      await t.test('S4 the implement stage\'s team: each dispatcher, implementer, subagent and unit reviewer as it was asked AND served', () => {
        const producers = Object.values(U).flatMap(u => [{...u.dispatch, role: 'dispatcher'}, ...u.attempts.map(a => ({...a, role: 'implementer'})),
          ...u.a2a.calls.map(c => ({...c, role: 'subagent'})), ...u.reviews.map(x => ({...x, role: 'unit-reviewer'}))]);
        const team = impl.team.map(x => ({role: x.role, ...who(x)}));
        for (const p of producers) assert.ok(team.some(x => JSON.stringify(x) === JSON.stringify({role: p.role, ...who(p)})), `${p.role} ${p.model}: ${JSON.stringify(who(p))} is not on the team ${JSON.stringify(team)}`);
      });
      await t.test('G1/G2 the change cycle records each contributor name with its contribution\'s identity; the cycle excludes every name', () => {
        const st = deriveCycle(ledgerOf(rev.outputs.cycle_ledger).view, rev.outputs.cycle);
        const xai = st.cycle.contributors.filter(c => c.vendor === 'xai');
        // Each name of each subagent contribution is a row of the cycle that states that contribution's identity.
        for (const want of [id('grok-4.7', M.sub, M.source), id('grok-4.7', M.sub, M.other)]) {
          for (const name of new Set([want.requested_model, want.served_model])) {
            assert.ok(xai.some(x => x.model === name && JSON.stringify(who(x)) === JSON.stringify(want)), `the cycle lost ${name} as ${JSON.stringify(want)}: ${JSON.stringify(xai)}`);
          }
        }
        for (const m of ['grok-4.7', M.sub, disp('alpha'), disp('c')]) assert.ok(st.cycle.author_models.includes(resolveModel(null, m).id), m);
      });
      await t.test('S18 the change review\'s team keeps each reviewer\'s served name and marker', () => {
        for (const x of rev.team.filter(y => y.role === 'cycle-reviewer')) assert.deepEqual(who(x), J(x.model));
      });
      await t.test('S20/S21 the validator\'s record and the change reviewers it excludes keep served name and marker; the exclusion reads the served identity', () => {
        const v = val.outputs.validator;
        assert.deepEqual(who(v), J(v.model));
        for (const x of v.independence.change_reviewers) assert.deepEqual(who(x), J(x.model));
        const keys = contributorKeys(impl.contributions);
        assert.ok(!keys.models.includes(resolveModel(v.vendor, v.served_model).id), 'the validator was served by a contributor');
      });
      await t.test('V1/V2 servedIdentities: every stage team row and the validator\'s record keep the marker', () => {
        const rows = servedIdentities(stages);
        const teamRows = rows.filter(x => x.source === 'stage team' && x.served_model);
        assert.ok(teamRows.length > 0);
        for (const x of teamRows.filter(y => ['cycle-reviewer', 'unit-reviewer', 'dispatcher'].includes(y.role))) assert.equal(x.served_model_source, M.source, `${x.stage} ${x.role} ${x.model}: the live record dropped its marker`);
        const v = rows.find(x => x.source === 'outputs.validator');
        assert.deepEqual(who(v), J(v.model), 'the live record dropped the validator\'s marker');
      });
      await t.test('V4 subagentReceipt: every recorded call by vendor, asked and served name and marker; it counts a call only when the required model SERVED it', () => {
        const receipt = subagentReceipt(stages, {role: 'api-designer', model: 'grok-4.7', min_calls: 1});
        assert.deepEqual(set(receipt.all_calls_recorded.map(c => ({vendor: c.vendor, ...who(c)}))), set([{vendor: 'xai', ...id('grok-4.7', M.sub, M.source)}, {vendor: 'xai', ...id('grok-4.7', M.sub, M.other)}]));
        assert.equal(receipt.counted, M.sub === 'grok-4.7' ? 2 : 0, 'the receipt counted a call the required model did not serve');
      });
      const proposal = JSON.parse(fs.readFileSync(out.outputs.proposal_path, 'utf8'));
      await t.test('B3/T1 the unsigned status proposal names each reviewer\'s served name and marker; its evidence is well formed', () => {
        const reviewers = proposal.evidence.review.reviewers;
        assert.equal(reviewers.length, 3);
        for (const x of reviewers) assert.deepEqual(who(x), J(x.model), 'the proposal\'s evidence dropped a reviewer\'s marker');
        assert.equal(proposalRefusal(proposal), null);
      });
      await t.test('T2 the evidence re-check refuses a reviewer marker that is not the one its review\'s answering turn recorded', () => {
        const flipped = {...proposal, evidence: {...proposal.evidence, review: {...proposal.evidence.review,
          reviewers: proposal.evidence.review.reviewers.map((x, i) => (i === 0 ? {...x, served_model_source: M.source === 'provider' ? 'unknown' : 'provider'} : x))}}};
        assert.throws(() => checkEvidenceLedgers(flipped), /served-model marker/);
        assert.doesNotThrow(() => checkEvidenceLedgers(proposal));
      });
      await t.test('U1 the public provenance of the change cycle: the marker on every review, and an input-stamped name is not counted as reported by its provider', () => {
        const o = openLedgerReadOnly({root: rev.outputs.cycle_ledger, anchor: rev.outputs.cycle_ledger_anchor});
        const cr = cycleRecord(o.view, rev.outputs.cycle);
        for (const x of cr.reviews) assert.deepEqual([x.requested_model, x.served_model, x.served_model_source], [x.requested_model, M.judge(x.requested_model), M.source]);
        assert.equal(cr.independence.served_reported, M.source === 'input' ? 0 : 3, 'an input-stamped served name was counted as reported by the provider');
      });
      await t.test('U2/U3 the public record\'s evidence and work sections show the served name with its marker (and the name asked when it differs)', () => {
        const md = evidenceSection({...proposal.evidence, proposal: 'sha256:' + '0'.repeat(64), checked: 'structural'}).join('\n');
        for (const x of proposal.evidence.review.reviewers) assert.ok(md.includes(`| ${x.served_model} (${M.source}) |`), `the evidence section dropped ${x.vendor}'s marker`);
        const rw = readWorkRecord({repo, statusRoot: f.statusRoot, workRoot: f.workRoot});
        const ws = workSection({ledger: rw.ledger, item: {...rw.items.get(item), team: impl.team}}).join('\n');
        const sub = impl.team.find(x => x.role === 'subagent');
        const cellOf = x => (x.served_model !== x.model ? `${x.served_model} (asked ${x.model}; ${x.served_model_source})` : `${x.served_model} (${x.served_model_source})`);
        assert.ok(ws.includes(`| subagent | xai | ${cellOf(sub)} |`), `the work section dropped the subagent's identity:\n${ws}`);
      });
    });
  });
}

test(`${L504}: an implementer answer that named NO serving model (the metered Gemini failover) is carried as unknown, never as the model asked, through the implement stage, the change cycle, the live record and the public work view`, {timeout: 300_000}, async t => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    const lane = implementerPath('easy')[0].model;
    // The lane is refused for quota; the metered API answers the files and its response names no model.
    ctx.agyQuota([lane]);
    ctx.implement(() => JSON.stringify({files: [{path: 'alpha.mjs', content: 'export const ok = true;\n'}]}));
    const f = fixture(repo, [{item: 'unnamed'}]);
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir});
    const r = await ticks({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    assert.deepEqual(seq(w, 'unnamed'), DONE, why(r));
    const stages = w.stages('unnamed');
    const [, impl, rev] = stages;
    const rec = JSON.parse(fs.readFileSync(impl.outputs.run.record, 'utf8'));
    const a = rec.units.alpha.attempts.find(x => x.status === 'written');
    const UNNAMED = id(lane, null, 'unnamed');

    await t.test('the producer: the attempt was written by the metered failover and names no served model', () => {
      assert.deepEqual([a.model, a.served_model, a.quota_failover?.used], [lane, null, true]);
    });
    await t.test('S1 the authored work row says the served model is unknown ("unnamed"), not the model asked', () => {
      assert.deepEqual(impl.contributions.filter(c => c.purpose === 'work').map(who), [UNNAMED], 'the work row replaced the unknown served model with the model asked');
      assert.equal(impl.contributions.find(c => c.purpose === 'work').lab, 'google');
    });
    await t.test('S4 the implementer\'s team row says the same', () => {
      assert.deepEqual(impl.team.filter(x => x.role === 'implementer').map(who), [UNNAMED]);
    });
    await t.test('G1/G2 the change cycle records the lane name with an unknown served model; the asked identity is excluded', () => {
      const st = deriveCycle(ledgerOf(rev.outputs.cycle_ledger).view, rev.outputs.cycle);
      const row = st.cycle.contributors.find(c => c.model === lane);
      assert.deepEqual(who(row), UNNAMED, 'the cycle recorded the lane name as if it had served');
      assert.ok(st.cycle.author_models.includes(resolveModel('agy_google', lane).id));
    });
    await t.test('V1 the live record keeps the unknown served model and its marker', () => {
      const rows = servedIdentities(stages);
      assert.deepEqual(who(rows.find(x => x.source === 'stage team' && x.role === 'implementer')), UNNAMED);
      assert.deepEqual(who(rows.find(x => x.source === 'pipeline.json' && x.role === 'implementer' && x.status === 'written')), id(lane, null, null));
    });
    await t.test('U3 the public work view names the lane and says no served model was named', () => {
      const rw = readWorkRecord({repo, statusRoot: f.statusRoot, workRoot: f.workRoot});
      const ws = workSection({ledger: rw.ledger, item: {...rw.items.get('unnamed'), team: impl.team}}).join('\n');
      assert.ok(ws.includes(`| implementer | agy_google | ${lane} (unnamed) | google |`), ws);
    });
  });
});

test(`${L504}: two advisory returns by one dispatcher model, served under two names, both reach the revised plan, the change and the next run's Stage 5 (dedupe keeps the served identity)`, {timeout: 300_000}, async t => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    ctx.agyWorker(`case "$unit" in
  alpha) printf 'export const ok = true;\\n' > "$dir/alpha.mjs" ;;
  beta) printf 'export const b = 1;\\n' > "$dir/beta.mjs" ;;
esac
`);
    const f = fixture(repo, [{item: 'twice'}]);
    const BETA = UNIT('beta', {owned_paths: ['beta.mjs'], verify_cmd: 'node -e "process.exit(0)"', invariants: ['beta.mjs exists']});
    const plan1 = {work_units: [UNIT('alpha'), BETA], slices: [{id: 's1', title: 'alpha.mjs exports ok = true', slot: 'alpha', path: 'alpha.mjs'}, {id: 's2', title: 'beta.mjs', slot: 'beta', path: 'beta.mjs'}]};
    // Both units are easy: one dispatcher model. It returns both, unit alpha's answer served under a dated name of it.
    const turn = scriptedTurn({
      planner: ({prompt}) => json(/dispatcher-return/.test(prompt) ? planFor(prompt) : planFor(prompt, plan1)),
      // Only the first plan's two dispatches return (k: the dispatcher's call count); the revised plan's unit is dispatched.
      dispatcher: ({unit, model, k}) => {
        const ans = JSON.stringify({unit_id: unit.unit_id, cohesive: k > 2, specialist_role: unit.specialist_role, difficulty: unit.difficulty, rubric: ['the verify command passes'], notes: '',
          ...(k > 2 ? {} : {return: {reason: 'COUPLED_FILE_ELSEWHERE', moves: [{path: unit.owned_paths[0], to_unit: 'new'}]}})});
        return unit.unit_id === 'alpha' ? {text: ans, served_model: `${model}-20261101`, served_model_source: 'provider'} : {text: ans, served_model: model, served_model_source: 'unknown'};
      },
    });
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir});
    const r = await ticks({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    const s = seq(w, 'twice');
    assert.deepEqual(s.filter(x => !x.startsWith('review:pending')), ['plan:passed', 'implement:returned', ...DONE], why(r));
    const [, back, plan2] = w.stages('twice');
    const D = back.findings.map(x => x.model);
    assert.equal(new Set(D).size, 1, 'one dispatcher model returned both units');
    const want = [id(D[0], `${D[0]}-20261101`, 'provider'), id(D[0], D[0], 'unknown')];
    await t.test('the returned findings name the dispatcher by asked and served name, with the marker', () => {
      assert.deepEqual(set(back.findings.map(who)), set(want));
    });
    await t.test('S3/S14 the revised plan inherits BOTH as contributors (one asked model, two served identities)', () => {
      assert.deepEqual(set(plan2.contributions.filter(c => c.purpose === 'dispatcher-return').map(who)), set(want), 'dedupe dropped a served identity of the returning dispatcher');
    });
    await t.test('S9 the run that carries out the revised plan excludes both from every other unit\'s Stage 5, with the marker', () => {
      const impl2 = w.stages('twice').find(x => x.stage === 'implement' && x.handoff?.from === plan2.hash);
      assert.ok(impl2, JSON.stringify(s));
      const rec = JSON.parse(fs.readFileSync(impl2.outputs.run.record, 'utf8'));
      assert.deepEqual(set(rec.stage5_excluded.map(who)), set(want), 'the run\'s Stage 5 exclusions lost an identity or a marker');
      assert.deepEqual(set(impl2.contributions.filter(c => c.purpose === 'dispatcher-return').map(who)), set(want));
    });
  });
});

test(`${L504}: a RESUMED plan cycle restores each contributor from the cycle's recorded rows with which name was asked, which answered and the marker`, {timeout: 300_000}, async t => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    const f = fixture(repo, [{item: 'resumed'}]);
    let failed = 0;
    // The planner answers under a dated name (provider-named). The xAI plan reviewer fails once: the cycle stays open, and
    // the next tick resumes it.
    const turn = scriptedTurn({
      planner: ({prompt, model}) => ({text: json(planFor(prompt)), served_model: `${model}-20261101`, served_model_source: 'provider'}),
      'plan-review': ({vendor}) => { if (vendor === 'xai' && ++failed === 1) throw new Error('503 from the provider'); return APPROVE; },
    });
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir});
    const r = await ticks({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    assert.deepEqual(seq(w, 'resumed'), ['plan:pending', ...DONE], why(r));
    const [, plan] = w.stages('resumed');
    const X = plan.outputs.planner.model, want = id(X, `${X}-20261101`, 'provider');
    await t.test('the plan cycle records the planner\'s served name with the name asked and the marker', () => {
      const st = deriveCycle(ledgerOf(plan.outputs.plan_ledger).view, plan.outputs.plan_review.cycle);
      assert.ok(st.cycle.contributors.some(c => c.model === `${X}-20261101` && JSON.stringify(who(c)) === JSON.stringify(want)), JSON.stringify(st.cycle.contributors));
    });
    await t.test('S15 the resumed plan\'s lineage rows restored from the cycle keep that identity', () => {
      const lineage = plan.contributions.filter(c => c.purpose === 'plan-lineage');
      assert.ok(lineage.length > 0);
      const dated = lineage.filter(c => c.model === `${X}-20261101`);
      assert.deepEqual(dated.map(who), [want], 'a lineage row restored from the cycle lost which name was asked, or the marker');
      assert.ok(contributorKeys(plan.contributions).models.includes(resolveModel('anthropic', X).id));
    });
  });
});

test(`${L504}: a change-review finding fed to a revision carries its reviewer's asked and served name and marker into the implement stage's critique row, the next panel's exclusions and the validator's`, {timeout: 300_000}, async t => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    const f = fixture(repo, [{item: 'critique'}]);
    let found = 0;
    // The xAI change reviewer requests changes once, served under a dated name of the model asked; then it approves.
    const turn = scriptedTurn({review: ({vendor, model}) => (vendor === 'xai' && ++found === 1
      ? {text: json({verdict: 'request_changes', findings: [{severity: 'major', file: 'alpha.mjs', line: 1, claim: 'the export is not documented', reproduction: {kind: 'command', run: 'node verify.mjs'}}]}),
        served_model: `${model}-20261101`, served_model_source: 'provider'} : APPROVE)});
    const ex = makeExecutors({repo, makeClientFor, turn, stateDir: f.stateDir});
    const r = await ticks({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    assert.deepEqual(seq(w, 'critique').filter(x => !x.startsWith('review:pending')), ['plan:passed', 'implement:passed', 'review:returned', 'implement:passed', 'review:passed', 'validate:passed', 'outcome:passed'], why(r));
    const stages = w.stages('critique');
    const back = stages.find(s => s.stage === 'review' && s.status === 'returned');
    const impl2 = stages.filter(s => s.stage === 'implement').at(-1), rev2 = stages.filter(s => s.stage === 'review').at(-1), val = stages.find(s => s.stage === 'validate');
    const want = id('grok-4.7', 'grok-4.7-20261101', 'provider');
    await t.test('S16 the returned change-review finding names its reviewer by asked and served name, with the marker', () => {
      assert.deepEqual(back.findings.map(who), [want]);
    });
    await t.test('S13 the revision\'s critique row keeps that identity', () => {
      assert.deepEqual(impl2.contributions.filter(c => c.purpose === 'critique').map(who), [want]);
    });
    await t.test('the next change panel and the validator exclude the critique\'s requested and served identity', () => {
      assert.ok(rev2.outputs.author_models.includes('xai/grok-4.7'));
      for (const x of rev2.team.filter(y => y.role === 'cycle-reviewer')) assert.notEqual(resolveModel(x.vendor, x.served_model ?? x.model).id, 'xai/grok-4.7');
      assert.notEqual(resolveModel(val.outputs.validator.vendor, val.outputs.validator.served_model).id, 'xai/grok-4.7');
    });
  });
});

test(`${L504}: the per-file (argo) implement stage's contributions and team keep every run turn's asked and served name and marker; an unnamed answer is "unnamed"`, {timeout: 300_000}, async t => {
  await withDispatch(async ctx => {
    const {dir: repo, makeClientFor} = ctx;
    // The scripted API providers name NO served model, except xAI (the in-run reviewer, whose answer must name one to be
    // admitted), which names a dated snapshot of the model asked.
    ctx.serve((vendor, model) => (vendor === 'xai' ? `${model}-20261101` : null));
    const f = fixture(repo, [{item: 'perfile'}]);
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, independence: 'model', profile: 'argo'});
    const r = await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: ex, limits: LIMITS});
    const w = openWorkLedger({root: f.workRoot});
    const impl = w.stages('perfile').find(s => s.stage === 'implement');
    assert.equal(impl?.status, 'passed', why(r));
    const run = JSON.parse(fs.readFileSync(path.join(impl.outputs.run.board, 'run.json'), 'utf8'));
    const turnId = x => id(x.model, x.served_model ?? null, x.served_model ? x.served_model_source ?? null : x.served_model_source ?? 'unnamed');
    const contributing = (run.turns ?? []).filter(x => ['plan', 'work'].includes(x.purpose));
    // The falsifier's shape: a contributing turn that named no served model, and a turn served under another name.
    assert.ok(contributing.some(x => !x.served_model), JSON.stringify(run.turns));
    assert.ok((run.turns ?? []).some(x => x.served_model && x.served_model !== x.model), JSON.stringify(run.turns));
    await t.test('S17 every contributing run turn is a contribution row with its asked and served name and marker', () => {
      const rows = impl.contributions.filter(c => ['plan', 'work'].includes(c.purpose)).map(c => ({purpose: c.purpose, ...who(c)}));
      for (const x of contributing) assert.ok(rows.some(y => JSON.stringify(y) === JSON.stringify({purpose: x.purpose, ...turnId(x)})), `${x.purpose} ${x.vendor}/${x.model}: ${JSON.stringify(turnId(x))} not in ${JSON.stringify(rows)}`);
    });
    await t.test('S5 every run turn is a team row with its asked and served name and marker', () => {
      const team = impl.team.map(x => ({role: x.role, ...who(x)}));
      for (const x of run.turns ?? []) assert.ok(team.some(y => JSON.stringify(y) === JSON.stringify({role: x.purpose, ...turnId(x)})), `${x.purpose} ${x.vendor}/${x.model}: ${JSON.stringify(turnId(x))} not in ${JSON.stringify(team)}`);
    });
  });
});
