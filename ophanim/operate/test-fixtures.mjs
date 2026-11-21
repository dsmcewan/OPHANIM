// Shared fixtures for the operate tests and the bounded demonstration: a git repository with Ready items, and
// SCRIPTED providers for every seat (no network, no live model). Everything produced with them is synthetic.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {SEATING} from '../../pantheon/src/role/seating.mjs';
import {SEAT_FACTS} from '../../pantheon/src/route/router.mjs';
import {tick as schedulerTick} from './scheduler.mjs';
import {optInPolicy} from '../../pantheon/tests/fixtures/billing.mjs';


export const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], {encoding: 'utf8'});
export const TICKET = item => ({schema: 'ophanim.ticket/v1', item, slice: 'the whole item: alpha.mjs exports ok = true', proposes: {state: 'Resolved', basis: 'alpha.mjs exports ok = true'},
  title: 'alpha.mjs exports ok = true', goal: 'Make alpha.mjs export `ok` as true.', question: 'fixture', repo_root: '.', slot: 'alpha', path: 'alpha.mjs',
  copy: ['alpha.mjs', 'verify.mjs'], acceptance_cmd: 'node verify.mjs', difficulty: 'easy'});

/** A git repository with Ready items (no tickets unless asked), the status ledger and the work ledger roots. */
export function fixture(repo, items, {tickets = []} = {}) {
  fs.writeFileSync(path.join(repo, 'alpha.mjs'), 'export const ok = false;\n');
  fs.writeFileSync(path.join(repo, 'verify.mjs'), 'import assert from "node:assert/strict"; import {ok} from "./alpha.mjs"; assert.equal(ok, true);\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'outputs/\ncooldowns/\nstatus/\nagy.log\nfake-agy\n');
  fs.mkdirSync(path.join(repo, 'tickets'), {recursive: true});
  for (const t of tickets) fs.writeFileSync(path.join(repo, 'tickets', `${t}.json`), JSON.stringify(TICKET(t), null, 2) + '\n');
  const statusRoot = path.join(repo, 'status', 'ledger'), workRoot = path.join(repo, 'status', 'work');
  const S = openStatusLedger({root: statusRoot});
  for (const i of items) S.set({checked: '2026-11-17', basis: `the requirement of ${i.item}: alpha.mjs exports ok = true`, state: 'Ready', title: `Alpha for ${i.item}`, ...i});
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture Owner');
  git(repo, 'config', 'user.email', 'owner@example.invalid');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture base');
  return {statusRoot, workRoot, S, stateDir: path.join(repo, 'status', 'operate')};
}

/** A valid work unit of the alpha fixture (pantheon/src/pipeline/work-units.mjs): one file, verified by verify.mjs. */
export const UNIT = (unit_id, over = {}) => ({unit_id, depends_on: [], owned_paths: ['alpha.mjs'], difficulty: 'easy', specialist_role: 'node-esm-module-engineer',
  allowed_subagents: [], verify_cmd: 'node verify.mjs', invariants: ['alpha.mjs exports ok === true'], ...over});
export const APPROVE = '```json\n{"verdict": "approve", "findings": []}\n```';
export const json = o => '```json\n' + JSON.stringify(o) + '\n```';
/** A substantive plan for the alpha fixture; it answers every finding the prompt names and re-validates when asked. */
export function planFor(prompt, extra = {}) {
  const section = /## Findings to answer[^\n]*\n((?:- .*\n?)*)/.exec(prompt)?.[1] ?? '';
  const ids = [...section.matchAll(/^- (\S+) \[/gm)].map(m => m[1]);
  return {
    problem: {statement: 'alpha.mjs exports ok = false at HEAD, so verify.mjs fails; the requirement is that it exports ok = true.',
      justification: 'verify.mjs asserts ok === true against alpha.mjs, which exports false in the evidence read below.'},
    scope: ['alpha.mjs: export ok = true'], exclusions: ['verify.mjs is not changed'], dependencies: [], capabilities: ['edit one ES module'],
    acceptance: [{id: 'a1', criterion: 'alpha.mjs exports ok === true', test: {cmd: 'node verify.mjs'}}], regression: null,
    slices: [{id: 's1', title: 'alpha.mjs exports ok = true', slot: 'alpha', path: 'alpha.mjs'}], copy: ['alpha.mjs', 'verify.mjs'], difficulty: 'easy',
    proposes: {state: 'Resolved', basis: 'alpha.mjs exports ok = true'}, limits: {provider_calls: 20, revisions: 2, elapsed_ms: 600000},
    stopping: ['acceptance passes and the review closes', 'the stage budget is exhausted'], recovery: 'resume from the last recorded stage', rollback: 'delete the branch pantheon/<item>',
    unresolved: [], evidence: [{ref: 'alpha.mjs', why: 'the current export'}, {ref: 'verify.mjs', why: 'the acceptance check'}],
    context: {sufficient: true, gaps: [], uncertainty: []},
    investigation: {historical_cause: {examined: false, why: 'the file has one commit; nothing earlier to explain'},
      operational_position: {examined: true, finding: 'verify.mjs imports alpha.mjs and asserts ok === true; nothing else reads it', sources: ['verify.mjs']},
      change_impact: {examined: true, finding: 'only the exported value changes; verify.mjs is the one consumer', sources: ['alpha.mjs', 'verify.mjs']},
      success_adequacy: {examined: true, finding: 'node verify.mjs fails on the current export and passes on the required one', sources: ['verify.mjs']}},
    // The work units of the five-stage pipeline (required under the `fit` profile; ignored by `argo` and `legacy`).
    work_units: [UNIT('alpha')],
    ...(/Mode: revalidate/.test(prompt) ? {ticket_assessment: {still_valid: true, reasons: ['alpha.mjs still exports false; the ticket\'s command still tests the requirement']}} : {}),
    // A dispatcher's advisory return (owner decision L-001) is answered with the planner's own justification, on evidence it was given.
    ...(ids.length ? {answers: ids.map(id => ({finding: id, response: 'addressed in this version',
      ...(new RegExp(`^- ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\[[^\\]]*dispatcher-return`, 'm').test(prompt) ? {justification: {why: 'verify.mjs imports alpha.mjs directly, so the units are cut where the evidence shows the coupling', sources: ['verify.mjs']}} : {})}))} : {}),
    ...extra,
  };
}
export const ACCEPT = json({verdict: 'accept', reasons: ['alpha.mjs exports ok === true, as the requirement asks'], criteria: [{id: 'a1', met: true, why: 'verify.mjs passes and the diff sets ok = true'}]});
// The pipeline's judging seats answer with ONE strict JSON value (no fence): the controller refuses anything else.
const unitOf = prompt => JSON.parse(/THE UNIT\n([\s\S]*?)\n(?:THE OTHER UNITS|DECIDE)/.exec(prompt)[1]);
const rubricOf = prompt => [...(/FROZEN ACCEPTANCE RUBRIC[^\n]*\n([\s\S]*?)\nGROUND TRUTH/.exec(prompt)?.[1] ?? '').matchAll(/^\d+\. (.*)$/gm)].map(m => m[1]);
/** A Stage 2 dispatcher answer for `unit`: cohesive, the planned role and difficulty, one rubric line per invariant. */
export const dispatchOf = (unit, over = {}) => ({unit_id: unit.unit_id, cohesive: true, specialist_role: unit.specialist_role, difficulty: unit.difficulty,
  rubric: ['the verify command passes', ...unit.invariants.map(i => `holds: ${i}`)], notes: '', ...over});
/** Stage 5 answers against a frozen rubric. */
export const unitApprove = rubric => ({verdict: 'approve', criteria: rubric.map(criterion => ({criterion, met: true, evidence: 'the diff and the verify output'})), findings: []});
export const unitReject = (rubric, findings = ['the change is wrong: a case fails']) => ({verdict: 'request_changes', criteria: rubric.map((criterion, i) => ({criterion, met: i !== 0, evidence: 'see the finding'})), findings});
/**
 * SERVED IDENTITY MODES (self-audit round 3, assignment 2 (sealed 449ca42), L-205: the fixture always answered as the
 * model asked, unmarked, so no lifecycle test carried a served name that differs from the requested one through a
 * projection). A mode maps a call to the name that "served" it and the marker the transport would attach:
 *   SERVE.dated    every seat served under a dated snapshot of the model asked (`-20261101`): another NAME, the same
 *                  identity, named by the provider (no marker). Judging seats still pass the same-model check.
 *   SERVE.marked   every seat served as the requested name, marked `served_model_source: "input"` (the Antigravity way:
 *                  the transport names no model and records the required input; the marker vocabulary requires the
 *                  input name to BE the requested one).
 *   substitute({kind: {asked: served}}, base)  a named seat served by ANOTHER model (another identity), unmarked; other
 *                  calls follow `base` (default: as asked).
 * An override's own {served_model} still wins.
 */
export const SERVE = Object.freeze({
  dated: ({model}) => ({served_model: `${model}-20261101`}),
  marked: ({model}) => ({served_model: model, served_model_source: 'input'}),
  substitute: (map, base = null) => args => (map[args.kind]?.[args.model] ? {served_model: map[args.kind][args.model]} : base ? base(args) : {served_model: args.model}),
});
/**
 * The scripted single-turn seats: planner, plan reviewer, change reviewer, validator, and the pipeline's dispatcher
 * (Stage 2), unit reviewer (Stage 5) and subagent (Stage 4). Each call is logged. `serve` is a SERVE mode (above).
 */
export function scriptedTurn(over = {}, {serve = null} = {}) {
  const log = [];
  const kindOf = p => p.startsWith('You are the planner') ? 'planner' : p.startsWith('You are an independent reviewer of a PLAN') ? 'plan-review'
    : /^You are the (independent )?validator/.test(p) ? 'validator' : p.startsWith('ROLE: dispatcher for a supervised build pipeline') ? 'dispatcher'
    : p.startsWith('ROLE: acceptance reviewer of work unit') ? 'unit-review' : /^ROLE: .* a consulted specialist subagent/.test(p) ? 'subagent' : 'review';
  const defaults = {planner: ({prompt}) => json(planFor(prompt)), 'plan-review': () => APPROVE, review: () => APPROVE, validator: () => ACCEPT,
    dispatcher: ({unit}) => JSON.stringify(dispatchOf(unit)),
    // Ground truth decides: the default reviewer approves a unit whose verify_cmd exited 0 when the controller ran it.
    'unit-review': ({rubric, passed}) => JSON.stringify(passed ? unitApprove(rubric) : unitReject(rubric, ['the verify command failed'])),
    subagent: () => 'a scripted subagent answer'};
  const fn = async ({vendor, model, prompt, extra}) => {
    const kind = kindOf(prompt);
    const k = log.filter(l => l.kind === kind).length + 1;
    const unit = kind === 'dispatcher' ? unitOf(prompt) : null;
    const unit_id = unit?.unit_id ?? /^ROLE: acceptance reviewer of work unit "([^"]+)"/.exec(prompt)?.[1] ?? /work unit "([^"]+)" asks you/.exec(prompt)?.[1] ?? null;
    log.push({kind, vendor, model, ...(unit_id ? {unit: unit_id} : {}), ...(extra ? {extra} : {})});
    // An override may return text, or {text, served_model}: the model that "answered" when it is not the one asked for.
    // A served_model given as null or blank is passed on as given: the fixture never fills in the name asked for.
    const out = await (over[kind] ?? defaults[kind])({vendor, model, prompt, k, item: /"item":"([^"]+)"/.exec(prompt)?.[1] ?? null, unit, unit_id,
      ...(kind === 'unit-review' ? {rubric: rubricOf(prompt), passed: /\nRESULT: exited 0\n/.test(prompt)} : {})});
    const text = typeof out === 'string' ? out : out.text;
    // An override's served_model_source ("input": the transport recorded the requested model) is passed on as given.
    if (typeof out === 'object' && 'served_model' in out) {
      return {text, response_id: `t_${kind}_${log.length}`, served_model: out.served_model, ...(out.served_model_source ? {served_model_source: out.served_model_source} : {})};
    }
    const mode = serve ? serve({kind, vendor, model}) : {served_model: model};
    if (serve) log.at(-1).served = mode.served_model;
    return {text, response_id: `t_${kind}_${log.length}`, served_model: mode.served_model, ...(mode.served_model_source ? {served_model_source: mode.served_model_source} : {})};
  };
  fn.log = log;
  return fn;
}
export const LIMITS = {total_provider_calls: 1000, stage_provider_calls: 40};

// THE FIT IMPLEMENTER IS A PRIMARY GEMINI SEAT (register L-136; the Antigravity SDK transport). Primary Gemini execution is
// off unless the launcher declares it with a budget, so a lifecycle test that reaches the implement stage declares it on
// every tick, the way an operator does (`--gemini-api-primary N`). The failover stays off. A test that passes its own
// `billing` says otherwise, for that tick.
export const PRIMARY_DECLARED = optInPolicy({primary: 100000});
export const tickWithPrimary = args => schedulerTick({billing: PRIMARY_DECLARED, ...args});
// A SYNTHETIC fifth reviewer lab, injected only through the reviewer pool these tests pass. It exists nowhere in the
// configuration and qualifies nothing (no fifth lab is set up; owner 2026-11-17). It lets the full lifecycle run past
// the coordinated change review, which under the four configured labs is a recorded capacity pending once a model
// planner and an implementer from another lab have both contributed (see the first test).
export const SYNTH = {vendor: 'synthlab', model: 'synthetic-reviewer-1', band: 'medium', basis: 'SYNTHETIC', why: 'a test-only fifth lab; never configured'};
export const FIVE = {seating: {...SEATING, reviewer: [...SEATING.reviewer, SYNTH]}, facts: {...SEAT_FACTS, synthlab: {vendor: 'synthlab', quota_pool: 'synthlab', models: {}}}};
// A SECOND synthetic lab, for the `fit` pipeline under the LAB rule. Decision 6 (owner, 2026-11-19): the Stage 2
// dispatcher is excluded from later independent judgment, so under the lab rule its lab (OpenAI) is excluded from the
// change review too, and a fit run under the lab rule needs a second lab outside the configured four to finish.
export const SYNTH2 = {vendor: 'synthlab2', model: 'synthetic-reviewer-2', band: 'medium', basis: 'SYNTHETIC', why: 'a second test-only lab; never configured'};
export const SIX = {seating: {...FIVE.seating, reviewer: [...FIVE.seating.reviewer, SYNTH2]}, facts: {...FIVE.facts, synthlab2: {vendor: 'synthlab2', quota_pool: 'synthlab2', models: {}}}};
export const stagesOf = r => r.dispatched.map(d => `${d.stage}:${d.status}`);
