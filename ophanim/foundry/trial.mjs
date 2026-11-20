// ONE TRIAL: one request built once by one setup through Pantheon's pipeline, then checked, operated and measured.
//
// Purpose   The foundry's unit of construction and of measurement. A trial hands the request to Pantheon's board
//           pipeline (pantheon/src/board/run-item.mjs runOpenItem) with the setup's planner, implementer and reviewer
//           seated; the pipeline plans, builds each file, runs the acceptance command in its jail and has the product
//           reviewed. The trial then reads what the product DEPENDS ON (ophanim/graph/deps/parse.mjs) and refuses what
//           the request did not allow, operates an accepted product with the request's operate command in the same
//           jail, and records what happened and what it cost.
// Inputs    a request (request.mjs), a setup (setups.mjs), a new directory for the trial, and makeClientFor (the model
//           clients; the Claude command-line seat or a test's stand-in).
// Outputs   runTrial() -> an `ophanim.foundry.trial/v1` record (below). dependencyGate() -> {ok, needs, refused}.
// Record    setup; request key, class and digest; the wall time of the build; whether it was BUILT (every file
//           produced), VERIFIED (the acceptance command exited 0 in the jail on the final revision), what it DEPENDS
//           ON and whether the request allows it, the reviewer's verdict, whether Pantheon SHIPPED it and the gate's
//           reason when it did not, the OPERATION's exit and report, and ACCEPTED = verified, dependencies allowed and
//           (when the request has an operate command) operated with exit 0. Provider calls, tokens, the served model
//           of each turn against the one asked for, the cost the clients reported, and each product file's sha256.
// Invariants  Nothing is accepted that the jail did not run. A pipeline error is a trial that was not accepted, with
//           the stage and the message; it is never retried here. `shipped` is Pantheon's own gate decision: a product
//           reviewed only inside its maker's lab is not shipped, and the record says so.
// Must never  Run the product, the acceptance command or the operate command outside the jail; write the request's
//           seed; count a trial whose served model differs from the one asked for as a measurement of the one asked for
//           (identity_ok is false, and the foundry leaves it out of the ranking).
// Limits    The dependency gate reads the product's source. A program or path argument that is computed is counted by
//           the reader as unresolved, and the gate refuses a product that has any; an import whose specifier is computed
//           is not seen at all. What actually contains the product is the jail, which has no network.
import fs from 'node:fs';
import path from 'node:path';
import {builtinModules} from 'node:module';
import {createHash} from 'node:crypto';
import {runOpenItem} from '../../pantheon/src/board/run-item.mjs';
import {runAcceptance} from '../../pantheon/src/board/acceptance.mjs';
import {openCooldownStore} from '../../packages/model-client/index.mjs';
import {readCode} from '../graph/deps/parse.mjs';

export const TRIAL_SCHEMA = 'ophanim.foundry.trial/v1';
const sha = b => createHash('sha256').update(b).digest('hex');
const CODE = /\.(mjs|cjs|js|ts|mts|cts)$/;
const BUILTINS = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));

/** What the product's files need, and what of it the request does not allow. `files`: [{path, text}]. */
export function dependencyGate(files, allowed = {}) {
  const a = {builtins: [], packages: [], env: [], hosts: false, programs: false, reads: false, writes: false, ...allowed};
  const builtins = new Set(a.builtins.flatMap(b => [b.replace(/^node:/, ''), `node:${b.replace(/^node:/, '')}`]));
  const needs = {relative: [], builtins: [], packages: [], env: [], hosts: [], programs: [], reads: [], writes: [], unresolved: 0}, refused = [];
  const add = (list, v) => { if (!list.includes(v)) list.push(v); };
  const no = (file, line, kind, name) => refused.push({file, line: line ?? null, kind, name});
  for (const f of files.filter(x => CODE.test(x.path))) {
    const r = readCode(f.text, {file: f.path});
    if (!r.ok) { no(f.path, null, 'unparseable', 'the parser rejected this file, so what it needs cannot be read'); continue; }
    for (const i of r.imports) {
      const s = i.specifier;
      if (s.startsWith('.')) add(needs.relative, s);
      else if (BUILTINS.has(s)) { add(needs.builtins, s.replace(/^node:/, '')); if (!builtins.has(s)) no(f.path, i.line, 'builtin', s); }
      else { add(needs.packages, s); if (!a.packages.includes(s)) no(f.path, i.line, 'package', s); }
    }
    for (const e of r.env) { add(needs.env, e.name); if (!a.env.includes(e.name)) no(f.path, e.line, 'environment variable', e.name); }
    for (const h of r.hosts) { add(needs.hosts, h.host); if (!a.hosts) no(f.path, h.line, 'host', h.host); }
    for (const p of r.programs) { add(needs.programs, p.name ?? p.program ?? 'a program'); if (!a.programs) no(f.path, p.line, 'program', p.name ?? p.program ?? 'a program'); }
    for (const p of r.reads) { add(needs.reads, p.path); if (!a.reads) no(f.path, p.line, 'file read', p.path); }
    for (const p of r.writes) { add(needs.writes, p.path); if (!a.writes) no(f.path, p.line, 'file write', p.path); }
    const computed = (r.unresolved?.programs?.length ?? 0) + (r.unresolved?.reads?.length ?? 0);
    needs.unresolved += computed;
    if (computed) no(f.path, null, 'computed dependency', `${computed} program or path argument(s) that are computed, not written out`);
  }
  for (const k of Object.keys(needs)) if (Array.isArray(needs[k])) needs[k].sort();
  return {ok: refused.length === 0, needs, refused};
}

const seat = (s, why) => ({vendor: s.vendor, model: s.model, pool: s.vendor, rank: 0, basis: 'OPERATOR', why});
const lastJson = out => { for (const line of String(out).trim().split('\n').reverse()) { try { const v = JSON.parse(line); if (v && typeof v === 'object') return v; } catch { /* not this line */ } } return null; };

/** Build `request` once with `setup` in the new directory `dir`. Returns the trial record; writes nothing outside `dir`. */
export async function runTrial({request, seed, requestSha, setup, dir, makeClientFor, n = 1, revisions = 2, maxProviderCalls = 16, clock = () => Date.now()}) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`runTrial: ${dir} is not empty`);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, {recursive: true});
  fs.cpSync(seed, path.join(repo, 'seed'), {recursive: true});
  const spentBefore = makeClientFor.spent?.().usd ?? null, started = clock();
  const spec = {key: request.key, repo_root: repo, title: request.title, goal: request.goal, question: request.question, copy: ['seed'], acceptance_cmd: request.acceptance_cmd,
    ...(request.tests_file ? {tests_file: request.tests_file} : {}), ...(request.difficulty ? {difficulty: request.difficulty} : {}),
    ...(request.files.length === 1 ? {slot: request.files[0].slot, path: request.files[0].path} : {slots: request.files.map(f => ({slot: f.slot, path: f.path, goal: f.goal ?? request.goal}))})};
  const why = `foundry trial ${n} of setup ${setup.id}`;
  let result = null, error = null;
  try {
    result = await runOpenItem(spec, {dir: path.join(dir, 'board'), makeClientFor, scouts: [], revisions, independence: 'model', maxProviderCalls, cooldown: openCooldownStore(path.join(dir, 'cooldowns')),
      seatOverrides: {planner: seat(setup.planner, why), implementer: seat(setup.implementer, why), reviewer: seat(setup.reviewer, why)}});
    if (result.error) error = {stage: result.error.stage, message: String(result.error.message).slice(0, 600)};
  } catch (e) { error = {stage: 'pipeline', message: String(e.message).slice(0, 600)}; }
  const ms = clock() - started, out = result?.outDir ?? path.join(repo, 'outputs', 'open-items', request.key);
  let run = null;
  try { run = JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8')); } catch { /* no run record: reported below */ }
  const product = request.files.map(f => { const p = path.join(out, 'artifact-latest', f.path); return fs.existsSync(p) ? {path: f.path, text: fs.readFileSync(p, 'utf8')} : null; });
  const built = product.every(Boolean), verified = built && run?.acceptance?.exit === 0;
  const dependencies = built ? dependencyGate(product, request.allowed) : null;
  let operation = null;
  if (verified && dependencies.ok && request.operate) {
    const where = path.join(dir, 'operate');
    fs.cpSync(seed, path.join(where, 'seed'), {recursive: true});
    for (const f of product) { fs.mkdirSync(path.dirname(path.join(where, f.path)), {recursive: true}); fs.writeFileSync(path.join(where, f.path), f.text); }
    const t0 = clock();
    try {
      const r = await runAcceptance({worktree: where, cmd: request.operate.cmd, timeout: request.operate.timeout_ms ?? 120000});
      const report = lastJson(r.out), score = request.operate.score && typeof report?.[request.operate.score] === 'number' ? report[request.operate.score] : null;
      operation = {ok: r.exit === 0 && (!request.operate.score || score !== null), exit: r.exit, isolation: r.isolation, ms: clock() - t0, report, score,
        why: r.exit !== 0 ? `the operate command exited ${r.exit}` : request.operate.score && score === null ? `the operation report has no numeric "${request.operate.score}"` : null};
    } catch (e) { operation = {ok: false, exit: null, isolation: null, ms: clock() - t0, report: null, score: null, why: String(e.message).slice(0, 300)}; }
  }
  const turns = (run?.turns ?? []).map(t => ({purpose: t.purpose, requested: t.model, served: t.served_model ?? null, ms: t.ms ?? null}));
  const spentAfter = makeClientFor.spent?.().usd ?? null;
  return {schema: TRIAL_SCHEMA, n, setup, request: {key: request.key, class: request.class, sha256: requestSha}, transport: makeClientFor.providers?.transport ?? 'undeclared', live: makeClientFor.providers?.kind === 'live',
    started_at: new Date(started).toISOString(), ms, built, verified, dependencies, operation,
    accepted: verified && dependencies.ok && (!request.operate || operation?.ok === true),
    review: run?.review?.verdict ?? null, shipped: run?.shipped === true, ship_why: run?.shipped === true ? null : run?.ship_why ?? null, isolation: run?.acceptance?.isolation ?? null,
    revisions: run?.acceptance?.revisions ?? null, provider_calls: run?.resources?.provider_calls ?? null,
    tokens: run?.resources ? {input: run.resources.reported_input_tokens ?? null, output: run.resources.reported_output_tokens ?? null, complete: run.resources.usage_complete === true} : null,
    cost_usd: spentBefore === null || spentAfter === null ? null : Number((spentAfter - spentBefore).toFixed(6)),
    turns, identity_ok: turns.length > 0 && turns.every(t => t.served === t.requested),
    product: product.filter(Boolean).map(f => ({path: f.path, sha256: sha(f.text), bytes: Buffer.byteLength(f.text)})),
    run_json: run ? path.join(out, 'run.json') : null, error};
}
