#!/usr/bin/env node
// ONE SUPERVISED PAID RESEARCH-SEAT TEST (owner authorization relayed 2026-11-22: "supervised paid research on Carbon",
// one cycle; authored offline, run ONCE by the supervising tester on LEXI). It runs OPHANIM's own research path,
// ophanim/operate/research.mjs runResearch, with its REAL default SDK transport (pantheon/src/antigravity/turn.mjs
// runAntigravitySdkTurn), the normal work ledger and the normal Gemini billing policy, on a scratch private state
// outside the repository. It adds nothing to the product: every bound below is an argument the product already takes.
//
//   node scripts/research/carbon-inspection-probe.mjs --repo <clean checkout at 4e5cdd2> --state <scratch dir outside it>
//        [--dry-run | --confirm-spend]
//
// THE BOUNDS (each enforced by the product, or by this driver before a request is sent):
//   commit      the repository must be a CLEAN checkout at PINNED_COMMIT (refused otherwise, nothing sent)
//   seat        role explorer (trigger reflection), coordinator gemini-4-carbon / high only: researchSeat's qualified
//               guard refuses any other candidate, and the admit guard refuses any request for another model BEFORE it
//               is sent (the subordinate, gemini-4-hydrogen, can never be billed)
//   delegation  none: max_depth 1 (the coordinator is level 1; a level-2 delegation is RESEARCH_DEPTH_EXCEEDED)
//   requests    max_requests 6 (the team's bound) AND gemini_api_primary {enabled, budget 6} on a usage ledger in
//               <state> (spendGemini, persisted before each send: a re-run with the same --state shares the 6)
//   failover    metered_gemini_failover absent (off)
//   time        a hard 5-minute abort signal on the whole run; per node 240 s, 6 model calls, 30 tool calls; 2 rounds
//   scope       read-only research tools on exactly ophanim/operate/self-repair-inspect.mjs and
//               ophanim/operate/self-repair.mjs (the transport's RESEARCH_SCOPE refuses any other read); the work ledger
//               and <state> are outside the repository and hidden as well
//   context     a bounded graph view at PINNED_COMMIT: ophanim/graph/cli.mjs `dependents` of each scoped file, depth 1,
//               at most 20 nodes and 40 edges each, cut at 6,000 bytes; its digest is recorded
//   spend gate  without --confirm-spend nothing is sent; --dry-run prints the plan and the context and sends nothing
//
// WHAT IT KEEPS, in <state>/probe-result.json: the requested seat and its selection, each node's provider-served model
// and its source, the requests charged (the billing ledger's rows) and the team's own count, the usage each node
// reported (unknown where none was reported), the examined paths, the outcome and stop reason, the findings text, the
// context digest, and the known limitations. The work ledger and the team's evidence files stay in <state>.
//
// A FAILED SESSION KEEPS WHAT ITS GATEWAY SAW. The transport attaches its gateway record to the error it throws
// (turn.mjs carry); the team runner keeps only an error's own served_model and usage (antigravity/research.mjs settle),
// which the transport sets on success only. So this driver wraps the default transport: it records each session's
// gateway observation (the provider's names for the requested model, answers that named none, the usage the provider
// reported) and, on a failure, puts the provider's name and usage on the error before the team settles it -- only when
// the provider named exactly ONE model; distinct names stay raw, unlifted, and the run is not verified. Nothing is
// filled in: no answer means no name and unknown usage.
//
// EXIT STATUS: 0 only for a verified conclusion (satisfied, concluded, every coordinator session answered by
// gemini-4-carbon alone per the provider) or a passed --dry-run preflight; 3 for a run that sent and ended without one;
// 1 for a refusal or an error; 2 for a usage error. The verdict and its reasons are in the result.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

export const PINNED_COMMIT = '4e5cdd2a8cc7ae0cd665f3c6c481e42c79f5340c';
export const MODEL = 'gemini-4-carbon';
export const SCOPE = Object.freeze(['ophanim/operate/self-repair-inspect.mjs', 'ophanim/operate/self-repair.mjs']);
export const ITEM = 'carbon-inspection-probe';
export const TRIGGER = 'reflection';
export const QUESTION = 'At this commit, which records distinguish an inspection that fully acquired its evidence and found a failing test from an '
  + 'interrupted inspection of the same commit; what does the next idle tick do in each case; and what one observable test would '
  + 'distinguish the two? Cite file and line for each claim, and say what you could not establish.';
export const LIMITS = Object.freeze({max_depth: 1, max_nodes: 1, max_requests: 6, node_model_calls: 6, node_tool_calls: 30, node_timeout_s: 240,
  coordinator_rounds: 2, finding_bytes: 4000, min_question_chars: 24});
export const BUDGET = 6;
export const DEADLINE_MS = 5 * 60_000;
export const CONTEXT_BYTES = 6000;

const sha = b => createHash('sha256').update(b).digest('hex');
const git = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], {encoding: 'utf8'}).trim();

/** Refuses unless `repo` is a clean checkout at PINNED_COMMIT and `state` is outside it. */
export function preconditions({repo, state}) {
  const why = [];
  if (!path.isAbsolute(repo) || !path.isAbsolute(state)) why.push('--repo and --state must be absolute paths');
  else {
    let head = null;
    try { head = git(repo, 'rev-parse', 'HEAD'); } catch { why.push(`${repo} is not a git checkout`); }
    if (head && head !== PINNED_COMMIT) why.push(`${repo} is at ${head}, not ${PINNED_COMMIT}`);
    if (head && git(repo, 'status', '--porcelain', '--untracked-files=all') !== '') why.push(`${repo} has uncommitted or untracked changes`);
    const rel = path.relative(fs.realpathSync(repo), path.resolve(state));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) why.push(`--state ${state} is inside the repository; it must be outside it`);
  }
  return why;
}

/** The bounded graph context: `dependents` of each scoped file at the pinned commit, cut at CONTEXT_BYTES. */
export function graphContext(repo) {
  const parts = SCOPE.map(f => {
    let out;
    try { out = execFileSync(process.execPath, [path.join(repo, 'ophanim/graph/cli.mjs'), 'dependents', f, '--commit', PINNED_COMMIT, '--depth', '1', '--max-nodes', '20', '--max-edges', '40'],
      {cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}); }
    catch (e) { out = JSON.stringify({error: 'GRAPH_UNAVAILABLE', why: String(e.message).slice(0, 300)}); }
    let j; try { j = JSON.parse(out); } catch { j = {raw: out.slice(0, 2000)}; }
    const {graph, ...answer} = j;   // the per-source manifest is long and not about the question
    return `## Knowledge graph: dependents of ${f} at ${PINNED_COMMIT} (derived view, NOT evidence: read the files it names)\n${JSON.stringify(answer)}`;
  });
  let text = parts.join('\n\n');
  if (Buffer.byteLength(text) > CONTEXT_BYTES) text = Buffer.from(text).subarray(0, CONTEXT_BYTES).toString('utf8') + '\n(graph context cut at ' + CONTEXT_BYTES + ' bytes)';
  return {text, sha256: sha(text), bytes: Buffer.byteLength(text)};
}

const plainObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
/** What one session's gateway record shows about who answered and what the provider reported it used. */
export function gatewayObservation(x, model) {
  const g = plainObj(x?.gateway) ? x.gateway : null;
  const names = Array.isArray(g?.served_models?.[model]) ? [...new Set(g.served_models[model].filter(n => typeof n === 'string' && n))] : [];
  let usage = null;
  for (const s of Array.isArray(g?.sessions) ? g.sessions : []) if (plainObj(s?.usage)) for (const [k, v] of Object.entries(s.usage)) if (Number.isFinite(v)) (usage ??= {})[k] = (usage[k] ?? 0) + v;
  return {gateway: !!g, forwarded: Number.isFinite(g?.totals?.forwarded) ? g.totals.forwarded : null, served_names: names,
    unnamed_answers: Number.isFinite(g?.unnamed?.[model]) ? g.unnamed[model] : 0, provider_usage: usage};
}

/**
 * The transport as the team sees it: `base` (the real default) with each session's gateway observation recorded in
 * `log`, and, on a failure, the provider's ONE name for the requested model and its reported usage put on the error
 * (served_model_source "provider") where the error carries none of its own. Distinct names are not lifted.
 */
export function observingTransport(base, log) {
  return async opts => {
    const entry = {node: opts?.unit?.unit_id ?? null, requested: opts?.seat?.model ?? null};
    try {
      const r = await base(opts);
      log.push({...entry, ended: 'returned', error_code: null, ...gatewayObservation(r, entry.requested),
        returned: {served_model: r?.served_model ?? null, served_model_source: r?.served_model_source ?? null, usage: plainObj(r?.usage) ? r.usage : null}});
      return r;
    } catch (e) {
      const o = {...entry, ended: 'threw', error_code: e?.code ?? null, error_message: String(e?.message ?? e).slice(0, 300), ...gatewayObservation(e, entry.requested), lifted: {served_model: false, usage: false}};
      if (plainObj(e) || e instanceof Error) {
        if (e.served_model == null && o.served_names.length === 1) { Object.assign(e, {served_model: o.served_names[0], served_model_source: 'provider'}); o.lifted.served_model = true; }
        if (e.usage == null && o.provider_usage) { e.usage = {...o.provider_usage}; o.lifted.usage = true; }
      }
      log.push(o);
      throw e;
    }
  };
}

/** Success is a verified conclusion; anything else says why not. */
export function verdictOf(result) {
  const why = [];
  if (result.outcome !== 'satisfied') why.push(`outcome is ${result.outcome}, not satisfied`);
  if (result.concluded !== true) why.push('the run recorded no conclusion');
  if (!result.findings_text) why.push('no findings were recorded');
  const coord = (result.served ?? []).filter(x => x.kind === 'coordinator');
  if (!coord.some(x => x.state === 'finished')) why.push('no coordinator session finished');
  for (const x of coord) if (x.served_model !== MODEL || x.served_model_source !== 'provider') why.push(`node ${x.node} (${x.state}) is recorded as served by ${x.served_model ?? 'no model'} (${x.served_model_source ?? 'no source'}), not ${MODEL} per the provider`);
  for (const o of result.transport_observations ?? []) {
    if (o.served_names.length > 1) why.push(`node ${o.node}: the provider answered under distinct names ${o.served_names.join(', ')}`);
    else if (o.served_names.length === 1 && o.served_names[0] !== MODEL) why.push(`node ${o.node}: the provider answered as ${o.served_names[0]}`);
    if (o.unnamed_answers) why.push(`node ${o.node}: ${o.unnamed_answers} answer(s) named no model`);
  }
  return {success: why.length === 0, why};
}

/** The command's exit status for a result (see the header). */
export function exitCodeOf(out) {
  if (out.outcome === 'dry-run') return 0;
  if (['refused', 'error'].includes(out.outcome)) return 1;
  return out.verdict?.success === true ? 0 : 3;
}

/**
 * The run. deps: {sdk, antigravity, deadlineMs} for tests ONLY (the live path passes none: runResearch gets the real
 * default SDK, wrapped by observingTransport, with no transport options, under DEADLINE_MS).
 * Returns the result record (also written to <state>/probe-result.json unless dry).
 */
export async function run({repo, state, dryRun = false, confirmSpend = false}, deps = {}) {
  const refused = preconditions({repo, state});
  if (refused.length) return {outcome: 'refused', why: refused};
  const context = graphContext(repo);
  const plan = {pinned_commit: PINNED_COMMIT, model: MODEL, effort: 'high', item: ITEM, trigger: TRIGGER, question: QUESTION, scope: SCOPE, limits: LIMITS,
    billing: {gemini_api_primary: {enabled: true, budget: BUDGET}, metered_gemini_failover: 'off'}, deadline_ms: DEADLINE_MS, context: {sha256: context.sha256, bytes: context.bytes}};
  if (dryRun || !confirmSpend) return {outcome: dryRun ? 'dry-run' : 'refused', why: dryRun ? [] : ['--confirm-spend was not given: nothing is sent'], plan, context_text: context.text};

  const [{openWorkLedger}, {requestResearch, researchOf, runResearch, researchTransportRefusal}, billingMod] = await Promise.all([
    import(path.join(repo, 'ophanim/operate/work-ledger.mjs')), import(path.join(repo, 'ophanim/operate/research.mjs')), import(path.join(repo, 'pantheon/src/route/gemini-billing.mjs'))]);
  // The transport's own preflight (the SDK's python and GEMINI_API_KEY): refused here, nothing is sent.
  if (!deps.sdk) { const no = researchTransportRefusal(deps.antigravity ?? {}); if (no) return {outcome: 'refused', why: [`transport preflight: ${no.code}: ${no.message}`], plan}; }

  fs.mkdirSync(state, {recursive: true, mode: 0o700});
  const workRoot = path.join(state, 'work'), teamDir = path.join(state, 'research'), usageFile = path.join(state, 'gemini-usage.jsonl');
  const work = openWorkLedger({root: workRoot});
  const policy = billingMod.resolveGeminiBilling({primary: {enabled: true, budget: BUDGET, source: 'carbon-inspection-probe: one supervised paid cycle (owner authorization relayed by the supervising tester)'}});
  const billing = billingMod.geminiBilling({policy, ledger: billingMod.geminiUsageFile(usageFile)});
  // One request per state: a re-run with the same --state resumes the same team, under the same 6-request budget.
  const open = researchOf(work, ITEM).requests.find(r => r.question === QUESTION);
  const requestHash = open?.hash ?? requestResearch({work, item: ITEM, trigger: TRIGGER, question: QUESTION, scope: [...SCOPE], by: 'carbon-inspection-probe'});
  const request = researchOf(work, ITEM).requests.find(r => r.hash === requestHash);

  const guard = [];
  const admitRequest = ({model}) => {                       // before each send (spendGemini's order)
    guard.push({model, at: new Date().toISOString()});
    if (model !== MODEL) throw Object.assign(new Error(`model guard: a request for ${model} is refused; only ${MODEL} may be sent`), {code: 'MODEL_GUARD'});
  };
  const signal = AbortSignal.timeout(deps.deadlineMs ?? DEADLINE_MS);
  const observed = [];
  const sdk = observingTransport(deps.sdk ?? (await import(path.join(repo, 'pantheon/src/antigravity/turn.mjs'))).runAntigravitySdkTurn, observed);
  const started = new Date();
  let r, error = null;
  try {
    r = await runResearch({work, item: ITEM, request, repo, dir: teamDir, billing, admitRequest, context: context.text, head: PINNED_COMMIT, limits: {...LIMITS},
      signal, qualified: m => (m === MODEL ? null : `only ${MODEL} is qualified for this probe`), hide: [workRoot, state], controlRoot: state,
      sdk, ...(deps.antigravity ? {antigravity: {...deps.antigravity}} : {})});
  } catch (e) { error = {code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 500)}; }
  const rows = work.research(ITEM);
  const nodes = rows.filter(x => x.phase === 'node');
  const result = {
    schema: 'ophanim.carbon-inspection-probe/v1', outcome: error ? 'error' : r.status, stop_reason: error ? error.code : r.stop_reason, concluded: !!r?.concluded, error,
    started_at: started.toISOString(), ended_at: new Date().toISOString(), plan,
    requested: {model: MODEL, effort: 'high', selection: rows.find(x => x.phase === 'team')?.selection ?? null},
    served: nodes.filter(x => x.state !== 'admitted').map(x => {
      // The usage the provider reported for this node's session(s), from their gateway records; the ledger's own
      // count is kept beside it (it writes 0 where nothing was reported, so 0 there is not evidence of none).
      const mine = observed.filter(o => o.node === x.node);
      const reported = mine.map(o => o.provider_usage ?? o.returned?.usage ?? null).filter(Boolean);
      return {node: x.node, kind: x.kind, state: x.state, requested: x.seat?.model ?? null, served_model: x.served_model ?? null, served_model_source: x.served_model_source ?? null,
        usage: reported.length ? reported : 'unknown (none reported)', ledger_usage: x.usage ?? null, error: x.error ?? null};
    }),
    transport_observations: observed,
    requests: {billed_this_run: billing.rows.length, billed_all_attempts: billing.ledger.used('primary'), budget: BUDGET, billing_usage_file: path.basename(usageFile), guard_checked: guard.length, guard_models: [...new Set(guard.map(g => g.model))], team_telemetry: r?.result?.telemetry?.requests ?? null},
    examined: (r?.result?.nodes ?? []).flatMap(n => (n.examined ?? []).map(e => ({node: n.id, path: e.path ?? e.ref ?? null, bytes: e.bytes ?? null, sha256: e.sha256 ?? e.version ?? null}))),
    refusals: rows.filter(x => x.phase === 'refusal').map(x => ({code: x.code, reason: x.reason})),
    findings_text: rows.find(x => x.phase === 'conclusion')?.findings_text ?? null,
    limitations: [
      'one cycle; a single answer from one model is not a review and is not evidence of the mechanism beyond what it cites',
      'served_model is the provider\'s statement as the gateway saw it (served_model_source "provider"); its absence is recorded, never filled in',
      'billed usage is what the provider reported per node; where none was reported it stays unknown',
      'the graph context is a derived view at the pinned commit, cut at 6,000 bytes; the coordinator was told it is not evidence',
    ],
  };
  result.verdict = verdictOf(result);
  fs.writeFileSync(path.join(state, 'probe-result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

/** The command: parses argv, runs, prints the result, returns the exit status. `deps` is for the offline check only. */
export async function main(argv, deps = {}) {
  let v;
  try { ({values: v} = parseArgs({args: argv, options: {repo: {type: 'string'}, state: {type: 'string'}, 'dry-run': {type: 'boolean'}, 'confirm-spend': {type: 'boolean'}}})); } catch { v = {}; }
  if (!v.repo || !v.state) { console.error('usage: carbon-inspection-probe.mjs --repo <clean checkout at 4e5cdd2> --state <scratch dir outside it> [--dry-run | --confirm-spend]'); return 2; }
  const out = await run({repo: path.resolve(v.repo), state: path.resolve(v.state), dryRun: !!v['dry-run'], confirmSpend: !!v['confirm-spend']}, deps);
  console.log(JSON.stringify(out, null, 2));
  return exitCodeOf(out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
