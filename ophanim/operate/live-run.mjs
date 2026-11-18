#!/usr/bin/env node
// ONE LIVE `fit` LIFECYCLE ITEM, scoped and budget-declared: the launcher the owner runs on their own machine.
//
//   node ophanim/operate/live-run.mjs --manifest FILE [--dry-run]                         (the default: the plan, no spend)
//   node ophanim/operate/live-run.mjs --manifest FILE --confirm-spend "<item>@<first 7 of candidate_commit>"
//   [--repo DIR]  the checkout (default: this one)
//
// THE MANIFEST (schema ophanim.live-run/v1; ophanim/operate/live-run.example.json) is filled in by the owner. Every
// field is required unless marked, unknown keys are refused, and no limit has a default: a null is refused.
//   item                 the status item id                candidate_commit   40-hex; must be HEAD, tracked files clean
//   profile: "fit"       independence: "model"             (anything else is refused by this launcher)
//   limits               {total_provider_calls, stage_provider_calls, revisions, stage_attempts, elapsed_ms,
//                         pipeline: {max_provider_calls, max_revisions, max_concurrent_units, verify_timeout_ms}}:
//                         positive integers; stage_provider_calls <= total_provider_calls and
//                         pipeline.max_provider_calls <= stage_provider_calls (a pipeline runs inside one stage)
//   billing              {scope: owner text, metered_gemini_failover: true|false, note}. false DISABLES the metered
//                         Gemini API failover of every Antigravity lane in the run (pipeline turns and single-turn
//                         seats): a proven quota refusal is not answered by the API; the pipeline unit ends blocked
//   require_subagent     (optional) {role, model: grok-4.6|grok-4.7, min_calls >= 1}: the run is NOT accepted unless
//                         that many ANSWERED subagent calls of that role, served by that model, are recorded
//   ledgers              {status_root: opened READ-ONLY, never written (its files are digested before and after),
//                         work_root: EMPTY or absent: a separately anchored, single-item work ledger this launcher
//                         creates (--init semantics: the controller key is generated there), or one it created
//                         earlier for THIS item (LIVE-RUN.json marker) to resume}
//   credentials          {required: [ANTHROPIC_API_KEY | anthropic-oauth, OPENAI_API_KEY, XAI_API_KEY, agy-login],
//                         gemini_api_key: "required" | "not-used"} -- PRESENCE only, never a value; agy-login is the
//                         zero-spend in-jail /usage of the preflight. gemini_api_key is "required" exactly when
//                         billing.metered_gemini_failover is true; "not-used" withholds GEMINI_API_KEY/GOOGLE_API_KEY
//                         from this process
//   out_dir              outside the repository: run.json, the stage state (operate/), the pipeline runs
//
// ALWAYS (dry run and confirmed): validate the manifest; verify the status ledger (read-only) and record its head and
// the digest of its files; check candidate_commit is HEAD and the tracked tree clean; check credential presence; run
// the zero-spend agy preflight (runAgyPreflight: card tools, in-jail /usage auth, the lane quota) and probeQuota for the
// matrix implementer lane of each difficulty; reconcile and show the item's gate; predict the seats per stage from the
// fit matrix (planner from the ticket's tier; dispatcher, implementer ladder, subagent and pinned reviewer per
// difficulty); record the policy hashes (selectionPolicy('fit'), the identity policy digest, the escalation rules).
// The dry run prints ONE JSON plan (ophanim.live-run-plan/v1) and makes no provider call.
//
// CONFIRMED (--confirm-spend exactly "<item>@<first 7 of candidate_commit>"): tick with `only: item` (scheduler.mjs),
// repeatedly, on the isolated work ledger, with live seats (pantheon/src/sdk/live.mjs) and the manifest's limits,
// until the item reaches its outcome or a stop or blocker; bounded by total_provider_calls (the work ledger's own
// spend, which counts a resumed run's earlier stages too) and elapsed_ms. NOTE: the provider-call counters bound
// CALLS, not dollars; inside the native agy CLI a call is a whole multi-turn worker session on the subscription.
// It writes <out_dir>/run.json (ophanim.live-run-record/v1): the manifest digest, the plan, every tick's dispatch log,
// every stage record (hash, inputs, outputs digest, findings, evidence, usage, next, blocker), budget stops, served
// identities (stage teams and the pipeline records), the subagent receipt check, the pipeline.json paths, the final
// gate, and a FRESH verification: the work ledger and the run ledgers re-opened read-only and verified, the status
// ledger re-verified and its files compared. The outcome proposal stays UNSIGNED; the launcher prints the exact
// `packages/ledger/status.mjs apply` command the owner would run and never runs it.
//
// Exit codes: 0 plan ok, or the run reached its outcome with every acceptance criterion met; 1 refused (manifest,
// commit, credentials, preflight, ledgers, confirm string); 2 usage; 3 the run stopped without acceptance (budget,
// blocker, a missing required subagent call, a failed verification), with the reason recorded.
//
// Must never: make a provider call without the confirm string; write to status_root; sign or apply a status; print a
// credential; reuse a work ledger that holds another item's history.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {openWorkLedger, outputsDigest, STAGES} from './work-ledger.mjs';
import {tick, spent} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {openWorkReadOnly} from './cli.mjs';
import {makeExecutors, implementerPath} from './stages.mjs';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {openLedger, defineKinds} from '../../packages/ledger/chain.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';
import {readTicket} from '../../pantheon/src/board/operate.mjs';
import {selectSeat, readPools, selectionPolicy} from '../../pantheon/src/route/frontier.mjs';
import {fitMatrix, IMPLEMENTER_LADDERS, REVIEWER_ESCALATION, pinnedReviewer, FIT_DIFFICULTIES, FIT_MATRIX_BODY} from '../../pantheon/src/route/fit-matrix.mjs';
import {taskProfile} from '../../pantheon/src/route/task-profile.mjs';
import {currentPolicy, policyDigest, resolveModel, IDENTITY_POLICY_SCHEMA} from '../../pantheon/src/review/identity.mjs';
import {PROTOCOL_V2} from '../../pantheon/src/route/protocol.mjs';
import {runAgyPreflight} from '../../pantheon/src/board/agy-cli.mjs';
import {probeQuota} from '../../pantheon/src/agy/quota.mjs';
import {sandboxAvailable} from '../../pantheon/src/agy/sandbox.mjs';
import {prepareWorkerWorkspace} from '../../pantheon/src/agy/workspace.mjs';
import {spawnPromise} from '../../pantheon/src/board/spawn.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');
export const LIVE_RUN_SCHEMA = 'ophanim.live-run/v1';
export const PLAN_SCHEMA = 'ophanim.live-run-plan/v1';
export const RECORD_SCHEMA = 'ophanim.live-run-record/v1';
export const WORK_MARKER_SCHEMA = 'ophanim.live-run-work/v1';
export const WORK_MARKER = 'LIVE-RUN.json';
export const SUBAGENT_MODELS = Object.freeze(['grok-4.6', 'grok-4.7']);
export const ANTHROPIC_CREDENTIALS = Object.freeze(['ANTHROPIC_API_KEY', 'anthropic-oauth']);
export const OTHER_CREDENTIALS = Object.freeze(['OPENAI_API_KEY', 'XAI_API_KEY', 'agy-login']);
export const LIMIT_KEYS = Object.freeze(['total_provider_calls', 'stage_provider_calls', 'revisions', 'stage_attempts', 'elapsed_ms']);
export const PIPELINE_LIMIT_KEYS = Object.freeze(['max_provider_calls', 'max_revisions', 'max_concurrent_units', 'verify_timeout_ms']);
const TOP_KEYS = ['_fill_in', 'schema', 'item', 'candidate_commit', 'profile', 'independence', 'limits', 'billing', 'require_subagent', 'ledgers', 'credentials', 'out_dir'];
const OPTIONAL_TOP = new Set(['_fill_in', 'require_subagent']);
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = v => typeof v === 'string' && v.trim() !== '';
const posInt = v => Number.isInteger(v) && v > 0;
const sha256 = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
const refuse = (why, code = 'REFUSED') => { throw Object.assign(new Error(Array.isArray(why) ? why.join('; ') : why), {code, reasons: Array.isArray(why) ? why : [why]}); };
const usage = why => { throw Object.assign(new Error(why), {usage: true}); };
const inside = (root, p) => { const r = path.relative(root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
/** The real path of `p`, or of its deepest existing ancestor joined with the rest (for a path not created yet). */
const realish = p => { let at = path.resolve(p), rest = []; while (!fs.existsSync(at) && path.dirname(at) !== at) { rest.unshift(path.basename(at)); at = path.dirname(at); } return path.join(fs.realpathSync(at), ...rest); };

/** The confirm string a confirmed run requires: "<item>@<first 7 of candidate_commit>". */
export const confirmString = m => `${m.item}@${m.candidate_commit.slice(0, 7)}`;

// ---- the manifest --------------------------------------------------------------------------------------------
/**
 * Validate a parsed manifest strictly. Returns the manifest with its paths resolved against `baseDir`; throws a
 * refusal (code MANIFEST) naming EVERY problem found. Nothing is defaulted for the owner.
 */
export function validateManifest(m, {baseDir = process.cwd()} = {}) {
  const why = [];
  const keys = (o, where, allowed, optional = new Set()) => {
    if (!plain(o)) { why.push(`${where} is an object`); return false; }
    for (const k of Object.keys(o)) if (!allowed.includes(k)) why.push(`${where}: unknown key "${k}"`);
    for (const k of allowed) if (!optional.has(k) && !Object.hasOwn(o, k)) why.push(`${where}.${k} is required`);
    return true;
  };
  const chosen = (v, where) => {
    if (v === null) { why.push(`${where} is null: the owner must choose it (no default is filled in)`); return false; }
    if (!posInt(v)) { why.push(`${where} is a positive integer`); return false; }
    return true;
  };
  if (!keys(m, 'manifest', TOP_KEYS, OPTIONAL_TOP)) refuse(why, 'MANIFEST');
  if (m._fill_in !== undefined && typeof m._fill_in !== 'string') why.push('_fill_in is a comment (a string)');
  if (m.schema !== LIVE_RUN_SCHEMA) why.push(`schema is "${LIVE_RUN_SCHEMA}"`);
  if (!ID.test(m.item ?? '')) why.push('item is a status item id');
  if (!COMMIT.test(m.candidate_commit ?? '')) why.push('candidate_commit is a full 40-hex commit');
  if (m.profile !== 'fit') why.push(`profile is "fit" (this launcher runs the fit lifecycle only), not ${JSON.stringify(m.profile)}`);
  if (m.independence !== 'model') why.push(`independence is "model" (the fit lifecycle's rule), not ${JSON.stringify(m.independence)}`);
  if (keys(m.limits, 'limits', [...LIMIT_KEYS, 'pipeline'])) {
    for (const k of LIMIT_KEYS) if (Object.hasOwn(m.limits, k)) chosen(m.limits[k], `limits.${k}`);
    if (keys(m.limits.pipeline, 'limits.pipeline', PIPELINE_LIMIT_KEYS)) for (const k of PIPELINE_LIMIT_KEYS) if (Object.hasOwn(m.limits.pipeline, k)) chosen(m.limits.pipeline[k], `limits.pipeline.${k}`);
    const L = m.limits;
    if (posInt(L.total_provider_calls) && posInt(L.stage_provider_calls) && L.stage_provider_calls > L.total_provider_calls) why.push('limits.stage_provider_calls is at most limits.total_provider_calls');
    if (posInt(L.stage_provider_calls) && posInt(L.pipeline?.max_provider_calls) && L.pipeline.max_provider_calls > L.stage_provider_calls) {
      why.push('limits.pipeline.max_provider_calls is at most limits.stage_provider_calls (the pipeline runs inside the implement stage, whose budget bounds it)');
    }
  }
  if (keys(m.billing, 'billing', ['scope', 'metered_gemini_failover', 'note'])) {
    if (!str(m.billing.scope)) why.push('billing.scope is the owner\'s text naming what may be billed');
    if (typeof m.billing.metered_gemini_failover !== 'boolean') why.push('billing.metered_gemini_failover is true or false: whether a quota refusal of an Antigravity lane may be answered by the metered Gemini API');
    if (typeof m.billing.note !== 'string') why.push('billing.note is a string (empty when there is nothing to add)');
  }
  if (m.require_subagent !== undefined && keys(m.require_subagent, 'require_subagent', ['role', 'model', 'min_calls'])) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(m.require_subagent.role ?? '')) why.push('require_subagent.role is a subagent role id (e.g. api-designer)');
    if (!SUBAGENT_MODELS.includes(m.require_subagent.model)) why.push(`require_subagent.model is one of ${SUBAGENT_MODELS.join(', ')}`);
    if (!posInt(m.require_subagent.min_calls)) why.push('require_subagent.min_calls is a positive integer');
  }
  if (keys(m.ledgers, 'ledgers', ['status_root', 'work_root'])) for (const k of ['status_root', 'work_root']) if (!str(m.ledgers[k])) why.push(`ledgers.${k} is a path`);
  if (keys(m.credentials, 'credentials', ['required', 'gemini_api_key'])) {
    const r = m.credentials.required;
    if (!Array.isArray(r) || !r.every(x => typeof x === 'string')) why.push('credentials.required is a list of credential names');
    else {
      for (const x of r) if (![...ANTHROPIC_CREDENTIALS, ...OTHER_CREDENTIALS].includes(x)) why.push(`credentials.required: unknown credential "${x}"`);
      if (new Set(r).size !== r.length) why.push('credentials.required names each credential once');
      if (r.filter(x => ANTHROPIC_CREDENTIALS.includes(x)).length !== 1) why.push(`credentials.required names exactly one Anthropic credential: ${ANTHROPIC_CREDENTIALS.join(' or ')}`);
      for (const x of OTHER_CREDENTIALS) if (!r.includes(x)) why.push(`credentials.required includes ${x}`);
    }
    if (!['required', 'not-used'].includes(m.credentials.gemini_api_key)) why.push('credentials.gemini_api_key is "required" or "not-used"');
    else if (typeof m.billing?.metered_gemini_failover === 'boolean' && (m.credentials.gemini_api_key === 'required') !== m.billing.metered_gemini_failover) {
      why.push('credentials.gemini_api_key is "required" exactly when billing.metered_gemini_failover is true (the key is used for nothing else in a fit run)');
    }
  }
  if (!str(m.out_dir)) why.push('out_dir is a path outside the repository');
  if (why.length) refuse(why, 'MANIFEST');
  const abs = p => path.resolve(baseDir, p);
  return {...m, ledgers: {status_root: abs(m.ledgers.status_root), work_root: abs(m.ledgers.work_root)}, out_dir: abs(m.out_dir)};
}

/** Read, parse and validate a manifest file. Returns {manifest, digest, file}. */
export function readManifest(file) {
  let bytes, raw;
  try { bytes = fs.readFileSync(file); } catch (e) { refuse(`the manifest ${file} cannot be read: ${e.code ?? e.message}`, 'MANIFEST'); }
  try { raw = JSON.parse(bytes.toString('utf8')); } catch (e) { refuse(`the manifest ${file} is not JSON: ${e.message}`, 'MANIFEST'); }
  return {manifest: validateManifest(raw, {baseDir: path.dirname(path.resolve(file))}), digest: sha256(bytes), file: path.resolve(file)};
}

/** Where the paths sit: out_dir outside the repository, neither ledger inside the other, nothing inside status_root. */
export function pathRefusals(m, repo) {
  const why = [], R = realish(repo), S = realish(m.ledgers.status_root), W = realish(m.ledgers.work_root), O = realish(m.out_dir);
  if (inside(R, O)) why.push(`out_dir ${m.out_dir} is inside the repository: it must be outside it`);
  if (inside(S, O)) why.push('out_dir is inside status_root');
  if (inside(S, W) || inside(W, S)) why.push('work_root and status_root are separate directories: neither inside the other');
  return why;
}

// ---- the status ledger, read-only ----------------------------------------------------------------------------
/** A digest of every file under `root` (its `keys/` directory excluded: never read), by relative path. */
export function treeDigest(root) {
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name === 'keys') continue;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) files.push([r, sha256(fs.readFileSync(path.join(d, e.name)))]);
      else files.push([r, 'other']);
    }
  };
  walk(root, '');
  return {digest: 'sha256:' + digest(files), files: files.length};
}
/** Verify the status ledger without creating or writing anything. */
export function statusLedgerState(root) {
  if (!fs.existsSync(path.join(root, 'ANCHOR'))) refuse(`no status ledger at ${root} (no ANCHOR)`, 'LEDGER');
  const before = treeDigest(root);
  const S = openStatusLedger({root, create: false});
  const v = S.ledger.verify();
  if (!v.ok) refuse(`the status ledger does not verify: ${v.why}`, 'LEDGER');
  const board = S.board();
  return {root, read_only: true, anchor: fs.readFileSync(path.join(root, 'ANCHOR'), 'utf8').trim(), head: board.head, entries: board.entries, items: board.items.length,
    files: before, item: (id => board.items.find(i => i.item === id) ?? null)};
}

// ---- the isolated work ledger ----------------------------------------------------------------------------------
/**
 * What is at work_root: absent, empty, or a work ledger this launcher created for THIS item (resumable). Anything
 * else is refused: another item's history, or a directory this launcher did not create. Writes nothing.
 */
export function inspectWorkRoot(root, item) {
  if (!fs.existsSync(root)) return {state: 'absent', root};
  if (!fs.statSync(root).isDirectory()) refuse(`work_root ${root} is not a directory`, 'WORK_ROOT');
  if (!fs.readdirSync(root).length) return {state: 'empty', root};
  const markerFile = path.join(root, WORK_MARKER);
  if (!fs.existsSync(markerFile)) refuse(`work_root ${root} is not empty and was not created by this launcher (no ${WORK_MARKER}): use an empty or absent directory`, 'WORK_ROOT');
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { refuse(`${markerFile} is not JSON`, 'WORK_ROOT'); }
  if (marker?.schema !== WORK_MARKER_SCHEMA) refuse(`${markerFile} is not a ${WORK_MARKER_SCHEMA} marker`, 'WORK_ROOT');
  if (marker.item !== item) refuse(`work_root ${root} was created by this launcher for item "${marker.item}", not "${item}": it holds another item's history`, 'WORK_ROOT');
  const anchor = fs.existsSync(path.join(root, 'ANCHOR')) ? fs.readFileSync(path.join(root, 'ANCHOR'), 'utf8').trim() : null;
  if (anchor !== marker.anchor) refuse(`work_root ${root}: its ANCHOR is not the one the launcher recorded in ${WORK_MARKER}`, 'WORK_ROOT');
  const {work, ledger} = openWorkReadOnly(root);
  const foreign = [...new Set([...work.claims(), ...work.stages()].map(x => x.item ?? x.identity?.item).filter(i => i !== item))];
  if (foreign.length) refuse(`work_root ${root} holds claims or stages of other items (${foreign.join(', ')}): it is not a single-item ledger`, 'WORK_ROOT');
  const keys = path.join(root, 'keys');
  if (!fs.existsSync(path.join(keys, 'controller.json')) || !fs.existsSync(path.join(keys, 'work-orderer.json'))) refuse(`work_root ${root}: the controller key it was created with is not there`, 'WORK_ROOT');
  return {state: 'resumable', root, anchor: ledger.anchor, head: ledger.head, entries: ledger.entries, spent: spent(work), marker, work};
}
/** Create the isolated, separately anchored work ledger (--init semantics) and its marker. */
function createWorkRoot(root, {item, manifestDigest}) {
  const w = openWorkLedger({root});
  fs.writeFileSync(path.join(root, WORK_MARKER), JSON.stringify({schema: WORK_MARKER_SCHEMA, item, anchor: w.anchor, created_at: new Date().toISOString(),
    created_by: 'ophanim/operate/live-run.mjs', manifest_digest: manifestDigest}, null, 2) + '\n');
  return w;
}

// ---- the checkout and the credentials ------------------------------------------------------------------------
export async function checkoutState(repo, commit) {
  const run = async args => { const r = await spawnPromise('git', ['-C', repo, ...args], {env: {...process.env, GIT_TERMINAL_PROMPT: '0'}, timeout: 60_000}); return {code: r.status, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim()}; };
  const head = await run(['rev-parse', 'HEAD']);
  const status = await run(['status', '--porcelain', '--untracked-files=no']);
  const why = [];
  if (head.code !== 0) why.push(`git rev-parse HEAD failed: ${head.err.slice(0, 200)}`);
  else if (head.out !== commit) why.push(`HEAD is ${head.out}, not the manifest's candidate_commit ${commit}`);
  if (status.code !== 0) why.push(`git status failed: ${status.err.slice(0, 200)}`);
  else if (status.out) why.push(`the tree has uncommitted changes in tracked files: ${status.out.split('\n').slice(0, 10).join(', ')}`);
  return {head: head.code === 0 ? head.out : null, clean: status.code === 0 && !status.out, ok: !why.length, why};
}
/** Presence of each required credential: never a value. agy-login is the preflight's in-jail /usage (filled later). */
export function credentialPresence(m, env, {home = env.HOME ?? os.homedir()} = {}) {
  const nonEmpty = k => typeof env[k] === 'string' && env[k].trim() !== '';
  const rows = m.credentials.required.filter(c => c !== 'agy-login').map(name => {
    if (name !== 'anthropic-oauth') return {name, present: nonEmpty(name), source: `env ${name}`};
    if (nonEmpty('CLAUDE_CODE_OAUTH_TOKEN')) return {name, present: true, source: 'env CLAUDE_CODE_OAUTH_TOKEN'};
    let present = false;
    try { const t = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'))?.claudeAiOauth?.accessToken; present = typeof t === 'string' && t.length > 0; } catch { /* absent */ }
    return {name, present, source: '~/.claude/.credentials.json (claudeAiOauth.accessToken)'};
  });
  const gemini = m.credentials.gemini_api_key === 'required'
    ? {name: 'GEMINI_API_KEY', required: true, present: nonEmpty('GEMINI_API_KEY'), source: 'env GEMINI_API_KEY'}
    : {name: 'GEMINI_API_KEY', required: false, present: nonEmpty('GEMINI_API_KEY') || nonEmpty('GOOGLE_API_KEY'), withheld: true, source: 'not used: withheld from this process for the run'};
  return {rows, gemini};
}

// ---- the zero-spend agy preflight ------------------------------------------------------------------------------
const onPath = (name, PATH) => String(PATH ?? '').split(':').filter(Boolean).map(d => path.join(d, name)).find(p => fs.existsSync(p)) ?? null;
/** The matrix implementer lane each difficulty starts on. */
export const matrixLanes = () => FIT_DIFFICULTIES.map(d => ({difficulty: d, lane: IMPLEMENTER_LADDERS[d][0].model}));
/**
 * runAgyPreflight (card tools, in-jail /usage auth, agents, the lane quota, the log scan) in a disposable control dir
 * and worktree, then probeQuota for the matrix implementer lane of every difficulty. No model turn.
 */
export async function agyPreflight({env, home = env.HOME ?? os.homedir()}) {
  const cli = env.PANTHEON_AGY_CLI ?? onPath('agy', env.PATH) ?? (fs.existsSync(path.join(home, '.local', 'bin', 'agy')) ? path.join(home, '.local', 'bin', 'agy') : null);
  const lanes = matrixLanes();
  if (!cli || !fs.existsSync(cli)) return {ok: false, cli: cli ?? null, failed: ['cli'], why: 'the agy CLI was not found ($PANTHEON_AGY_CLI, $PATH, ~/.local/bin/agy)', lanes};
  const box = await sandboxAvailable('bwrap');
  if (!box.ok) return {ok: false, cli, failed: ['sandbox'], why: `the bwrap sandbox is unavailable (${box.why}): the worker never runs unjailed`, lanes};
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-live-run-preflight-')));
  try {
    const ctl = path.join(root, 'control'), wt = path.join(root, 'worktree');
    fs.mkdirSync(wt);
    await prepareWorkerWorkspace({control_dir: ctl, worktree: wt, unit_id: 'live-run-preflight', owned_paths: ['preflight/**'], verify_cmd: 'node -e "process.exit(0)"'});
    let pf;
    try { pf = await runAgyPreflight({cli, control_dir: ctl, worktree: wt, model: lanes.find(l => l.difficulty === 'medium').lane, env: {HOME: home}, sandbox: {home}}); }
    catch (e) { return {ok: false, cli, failed: ['preflight'], why: `the preflight could not run: ${e.code ?? ''} ${String(e.message ?? e).slice(0, 300)}`, lanes}; }
    const quota = [];
    for (const l of lanes) {
      const q = await probeQuota({cli, model: l.lane, env: {HOME: home}});
      quota.push({...l, state: q.state, groups: [...new Set((q.buckets ?? []).map(b => b.group ?? null).filter(Boolean))], exit_code: q.exit_code ?? null, spent: q.spent ?? null, ...(q.error ? {error: q.error} : {})});
    }
    const exhausted = quota.filter(q => q.state === 'exhausted');
    const c = pf.checks;
    return {ok: pf.ok && !exhausted.length, cli, failed: [...pf.failed, ...exhausted.map(q => `lane_quota:${q.lane}`)], warnings: [...pf.warnings, ...quota.filter(q => q.state === 'unknown').map(q => `lane_quota:${q.lane} unknown (not blocking)`)],
      checks: {card_tools: {ok: c.card_tools?.ok ?? null, why: c.card_tools?.why ?? null}, auth: {ok: c.auth?.ok ?? null, why: c.auth?.why ?? null, groups: c.auth?.groups ?? null, num_turns: c.auth?.num_turns ?? null, total_tokens: c.auth?.total_tokens ?? null},
        lane_quota: {ok: c.lane_quota?.ok ?? null, model: c.lane_quota?.model ?? null, state: c.lane_quota?.quota_scope?.state ?? null}, agents: {ok: c.agents?.ok ?? null, why: c.agents?.why ?? null},
        mcp_list: {ok: c.mcp_list?.ok ?? null, why: c.mcp_list?.why ?? null}, log_scan: {ok: c.log_scan?.ok ?? null, why: c.log_scan?.why ?? null}},
      lanes: quota, why: pf.ok ? (exhausted.length ? `lane quota exhausted: ${exhausted.map(q => q.lane).join(', ')}` : null) : `preflight failed: ${pf.failed.map(k => `${k} (${c[k]?.why})`).join('; ')}`};
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

// ---- what the plan predicts ------------------------------------------------------------------------------------
const seatRow = s => ({vendor: s.vendor, model: s.model});
/** The seats per stage, from the fit matrix: the planner from the ticket's tier, the rest per unit difficulty. */
export function predictedSeats({repo, item}) {
  const t = fs.existsSync(path.join(repo, 'tickets', `${item}.json`)) ? readTicket({repo, item}) : null;
  const ticket = t && !t.why ? t : null;
  const declared = Object.fromEntries(['difficulty', 'stakes', 'ambiguity', 'depth'].filter(k => ticket?.spec?.[k] !== undefined).map(k => [k, ticket.spec[k]]));
  let task; try { task = taskProfile(declared); } catch { task = taskProfile({}); }
  const planner = selectSeat('planner', {profile: 'fit', difficulty: declared.difficulty ?? 'medium', task, needsContext: 1, pools: readPools()}).seat;
  const per = Object.fromEntries(FIT_DIFFICULTIES.map(d => {
    const dispatcher = fitMatrix('dispatcher', d);
    return [d, {dispatcher: seatRow(dispatcher), implementer: {start: seatRow(IMPLEMENTER_LADDERS[d][0]), ladder: implementerPath(d).map(seatRow)},
      subagent: seatRow(fitMatrix('subagent', d)), reviewer: {pinned: seatRow(pinnedReviewer(dispatcher)),
        escalation: REVIEWER_ESCALATION.slice(REVIEWER_ESCALATION.findIndex(x => x.model === dispatcher.model)).map(seatRow)}}];
  }));
  return {planner: {...seatRow(planner), tier: declared.difficulty ?? 'medium', source: ticket ? (Object.keys(declared).length ? 'ticket' : 'ticket declares none: medium') : (t?.why ? `ticket invalid (${t.why}): medium` : 'no ticket: medium'), declared},
    by_difficulty: per, unit_difficulty: 'decided by the plan\'s work units (and the dispatcher may raise it): every difficulty is shown',
    post_pipeline: 'the coordinated three-lab change review, the validator and the plan reviewers are seated at run time from the recorded contributions (model independence: no contributing model reviews)'};
}
/** The policies the run is bound to, by hash. */
export function policyHashes() {
  const sel = selectionPolicy('fit');
  return {selection: {policy: sel.policy, profile: sel.profile, hash: sel.hash}, identity: {schema: IDENTITY_POLICY_SCHEMA, digest: policyDigest(currentPolicy())},
    escalation: {fit_matrix: {schema: FIT_MATRIX_BODY.schema, digest: 'sha256:' + digest(FIT_MATRIX_BODY)},
      implementer: 'the matrix ladder of the unit difficulty: the next thinking level of the same base model first, then the next rung (stages.mjs implementerPath)',
      reviewer: 'pinned to the unit\'s dispatcher model; escalates inside OpenAI only (REVIEWER_ESCALATION)', run_item_protocol: PROTOCOL_V2,
      run_item_note: 'the per-file runOpenItem path (escalation protocol v2) is used only for a plan without work units; a fit plan carries them'},
    independence: 'model'};
}

// ---- the plan ---------------------------------------------------------------------------------------------------
/**
 * Everything the launcher checks before spending, as one plan. Never creates the work ledger or out_dir and never
 * calls a provider. Returns {plan, refusals, status, work}.
 */
export async function buildPlan({manifest: m, digest: manifestDigest, file}, {repo, env, mode}) {
  const refusals = [...pathRefusals(m, repo)];
  const add = (why, more = []) => { if (why) refusals.push(why); refusals.push(...more); };
  let status = null, work = null, gate = null, seats = null;
  try { status = statusLedgerState(m.ledgers.status_root); } catch (e) { add(e.message); }
  try { work = inspectWorkRoot(m.ledgers.work_root, m.item); } catch (e) { add(e.message); }
  const checkout = await checkoutState(repo, m.candidate_commit);
  add(null, checkout.why);
  const creds = credentialPresence(m, env);
  for (const c of creds.rows) if (!c.present) add(`credential ${c.name} is not present (${c.source}); load it locally and run again`);
  if (creds.gemini.required && !creds.gemini.present) add('credential GEMINI_API_KEY is not present, and the manifest requires it (metered_gemini_failover: true)');
  const preflight = await agyPreflight({env});
  if (!preflight.ok) add(`agy preflight: ${preflight.why}`);
  const agyLogin = {name: 'agy-login', present: preflight.checks?.auth?.ok === true, source: 'the preflight\'s in-jail agy --print /usage (zero spend)'};
  if (status) {
    const it = status.item(m.item);
    if (!it) add(`item "${m.item}" is not on the status ledger at ${m.ledgers.status_root}`);
    else {
      try {
        const rec = reconcile({repo, statusRoot: m.ledgers.status_root, workLedger: work?.work ?? null, issues: null});
        const g = rec.items.find(i => i.item === m.item).gate;
        gate = {gate: g.gate, reason: g.reason ?? null, mode: g.mode ?? null, status: it.state, blocker: g.blocker ?? null, runnable: STAGES.includes(g.gate)};
        if (!gate.runnable) add(`item "${m.item}" is at gate "${g.gate}" (${g.reason ?? 'no reason given'}): nothing to dispatch`);
      } catch (e) { add(`reconcile failed: ${e.message}`); }
      try { seats = predictedSeats({repo, item: m.item}); } catch (e) { add(`the seats could not be predicted: ${e.message}`); }
    }
  }
  const L = m.limits;
  const plan = {schema: PLAN_SCHEMA, mode, ok: !refusals.length, refusals, at: new Date().toISOString(),
    manifest: {file, digest: manifestDigest, schema: m.schema}, item: m.item, candidate_commit: m.candidate_commit, confirm_spend: confirmString(m), repo,
    checkout: {head: checkout.head, clean: checkout.clean, ok: checkout.ok},
    status_ledger: status ? {root: status.root, read_only: true, anchor: status.anchor, head: status.head, entries: status.entries, items: status.items, files_digest: status.files.digest, files: status.files.files, keys: 'not read'} : null,
    work_ledger: work ? {root: work.root, state: work.state, ...(work.state === 'resumable' ? {anchor: work.anchor, head: work.head, entries: work.entries, spent: work.spent} : {will_create: 'a separately anchored single-item work ledger, its controller key generated there (--init semantics)'})} : null,
    out_dir: m.out_dir,
    credentials: {required: [...creds.rows, agyLogin], gemini_api_key: creds.gemini, values: 'never read into the record: presence only'},
    preflight, gate, seats, policy: policyHashes(), profile: 'fit', independence: 'model',
    limits: L, billing: m.billing, metered_gemini_failover: m.billing.metered_gemini_failover
      ? 'ALLOWED: a proven quota refusal of an Antigravity lane may be answered by the metered Gemini API of the same base model'
      : 'DISABLED: a quota refusal of an Antigravity lane is not answered by the metered Gemini API; the unit steps down its subscription ladder and is blocked when it is spent',
    require_subagent: m.require_subagent ?? null,
    notes: ['The provider-call limits bound CALLS, not dollars. Inside the native agy CLI one call is a whole multi-turn worker session on the Antigravity subscription; its cost is not metered here.',
      'The total counts every stage on the isolated work ledger: a resumed run continues against the same total.'],
    provider_calls: 0,
    next: mode === 'dry-run' ? `node ophanim/operate/live-run.mjs --manifest ${file} --confirm-spend "${confirmString(m)}"` : null};
  return {plan, refusals, status, work};
}

// ---- the run record ---------------------------------------------------------------------------------------------
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
/** Every pipeline record an implement stage names. */
const pipelinesOf = stages => stages.filter(s => s.stage === 'implement' && s.outputs?.run?.kind === 'pipeline')
  .map(s => ({stage_record: s.hash, attempt: s.attempt, status: s.status, dir: s.outputs.run.dir, record: s.outputs.run.record, run_json: s.outputs.run.run_json ?? null, ledger: s.outputs.run.ledger ?? null}));
/** The served identities: every stage team row, and every seat of every pipeline record, with what served it. */
export function servedIdentities(stages) {
  const out = [];
  for (const s of stages) {
    for (const t of s.team ?? []) if (t.vendor || t.model) out.push({stage: s.stage, attempt: s.attempt, record: s.hash, source: 'stage team', ...pick(t, ['role', 'vendor', 'model', 'lab', 'served_model', 'requested_model', 'standing', 'authored', 'shared_lab'])});
    for (const k of ['planner', 'validator']) if (s.outputs?.[k]?.model) out.push({stage: s.stage, attempt: s.attempt, record: s.hash, source: `outputs.${k}`, role: k, ...pick(s.outputs[k], ['vendor', 'model', 'lab', 'served_model'])});
  }
  for (const p of pipelinesOf(stages)) {
    const r = readJson(p.record);
    for (const u of Object.values(r?.units ?? {})) {
      const row = (role, x) => ({stage: 'implement', record: p.stage_record, source: 'pipeline.json', unit: u.unit_id, role, vendor: x.vendor ?? null, model: x.model ?? null,
        served_model: x.served_model ?? null, served_model_source: x.served_model_source ?? null, ...(x.status ? {status: x.status} : {})});
      if (u.dispatch) out.push(row('dispatcher', u.dispatch));
      for (const a of u.attempts ?? []) out.push({...row('implementer', a), ...(a.quota_failover ? {quota_failover: a.quota_failover} : {})});
      for (const v of u.reviews ?? []) out.push(row('unit-reviewer', v));
      for (const c of u.a2a?.calls ?? []) out.push({...row('subagent', c), subagent_role: c.role});
    }
  }
  return out;
}
const sameModel = (a, b) => { const x = resolveModel('xai', a), y = resolveModel('xai', b); return x?.known && y?.known ? x.id === y.id : a === b; };
/** The required subagent receipt: answered calls of the role, asked of AND served by the model, in the accepted implement record. */
export function subagentReceipt(stages, req) {
  if (!req) return {required: false, met: true};
  const impls = stages.filter(s => s.stage === 'implement' && s.status === 'passed');
  const accepted = impls.at(-1) ?? null;
  const callsOf = s => {
    const r = s?.outputs?.run?.record ? readJson(s.outputs.run.record) : null;
    return Object.values(r?.units ?? {}).flatMap(u => (u.a2a?.calls ?? []).map(c => ({unit: u.unit_id, role: c.role, status: c.status, model: c.model, served_model: c.served_model ?? null, answer_digest: c.answer_digest ?? null})));
  };
  const all = pipelinesOf(stages).flatMap(p => callsOf(stages.find(s => s.hash === p.stage_record)));
  const counted = callsOf(accepted).filter(c => c.status === 'answered' && c.role === req.role && c.model === req.model && c.served_model && sameModel(c.served_model, req.model));
  return {required: true, role: req.role, model: req.model, min_calls: req.min_calls, counted: counted.length, met: counted.length >= req.min_calls,
    from: accepted ? {stage_record: accepted.hash, record: accepted.outputs?.run?.record ?? null} : null, calls: counted, all_calls_recorded: all,
    why: counted.length >= req.min_calls ? null : `${counted.length} answered ${req.role} call(s) served by ${req.model} in the accepted implement record; ${req.min_calls} required`};
}
/** A stage record as the run record shows it. */
const stageRow = s => ({hash: s.hash, stage: s.stage, attempt: s.attempt, status: s.status, identity: s.identity, inputs: s.inputs, outputs_digest: outputsDigest(s.outputs),
  outputs_keys: Object.keys(s.outputs ?? {}).sort(), evidence: pick(s.outputs ?? {}, ['context', 'dossier', 'evidence', 'tests', 'acceptance', 'checks', 'regression', 'verdict', 'criteria', 'review_scope', 'labs', 'cycle']),
  findings: (s.findings ?? []).map(f => pick(f, ['id', 'severity', 'cause', 'unit', 'code', 'text', 'vendor', 'model', 'lab'])), usage: s.usage, next: s.next, blocker: s.blocker ?? null,
  team: s.team ?? [], contributions: s.contributions ?? []});
/** Budget stops: what a tick, a stage or a pipeline run recorded as a limit reached. */
function budgetStops(ticks, stages, launcher) {
  const out = [...launcher];
  for (const [n, t] of ticks.entries()) if (t.stopped) out.push({source: 'tick', tick: n, why: t.stopped});
  for (const s of stages) {
    if (/PROVIDER_CALL_LIMIT|provider-call budget|budget/i.test(s.next?.why ?? '')) out.push({source: 'stage', stage: s.stage, attempt: s.attempt, record: s.hash, why: s.next.why});
    if (s.outputs?.run?.provider_calls?.refused_at_limit > 0) out.push({source: 'pipeline', stage: s.stage, record: s.hash, why: `${s.outputs.run.provider_calls.refused_at_limit} pipeline turn(s) refused at the provider-call limit`});
  }
  return out;
}
/** Re-open every ledger read-only, as a fresh reader, and verify it. */
export function freshVerification({workRoot, stages, statusRoot, statusBefore}) {
  const out = {work: null, run_ledgers: [], status: null};
  try { const w = openWorkLedger({root: workRoot, create: false}); const v = w.verify(); out.work = {root: workRoot, anchor: w.anchor, ok: v.ok, head: v.head ?? null, entries: v.entries ?? null, ...(v.ok ? {} : {why: v.why})}; }
  catch (e) { out.work = {root: workRoot, ok: false, why: e.message}; }
  const seen = new Set();
  const cite = (stage, role, dir, anchor) => { if (!dir || !anchor || seen.has(dir)) return; seen.add(dir); out.run_ledgers.push({stage, role, dir, anchor}); };
  for (const s of stages) {
    const o = s.outputs ?? {};
    cite(s.stage, 'plan review ledger', o.plan_ledger, o.plan_review?.ledger_anchor);
    cite(s.stage, 'run ledger', o.run?.ledger, o.run_ledger_anchor ?? o.run?.ledger_anchor);
    cite(s.stage, 'review cycle ledger', o.cycle_ledger, o.cycle_ledger_anchor);
  }
  out.run_ledgers = out.run_ledgers.map(r => {
    if (!fs.existsSync(path.join(r.dir, 'chain.jsonl'))) return {...r, ok: false, why: 'no chain.jsonl'};
    try { const v = openLedger({dir: r.dir, kinds: defineKinds({}), anchor: r.anchor}).verify(); return {...r, ok: v.ok, check: 'structural (genesis, signatures, links, payloads)', head: v.head ?? null, entries: v.entries ?? null, ...(v.ok ? {} : {why: v.why})}; }
    catch (e) { return {...r, ok: false, why: e.message}; }
  });
  try {
    const st = statusLedgerState(statusRoot);
    out.status = {root: statusRoot, ok: true, head: st.head, entries: st.entries, files_digest: st.files.digest, unchanged: st.files.digest === statusBefore.files.digest && st.head === statusBefore.head};
  } catch (e) { out.status = {root: statusRoot, ok: false, why: e.message, unchanged: false}; }
  out.ok = Boolean(out.work?.ok && out.run_ledgers.every(r => r.ok) && out.status?.ok && out.status.unchanged);
  return out;
}

// ---- the confirmed run ------------------------------------------------------------------------------------------
async function liveSeats({meteredFailover}) {
  const live = await import(pathToFileURL(path.join(REPO_ROOT, 'pantheon/src/sdk/live.mjs')).href);
  return {turn: await live.liveTurn({label: 'live-run', meteredFailover}), makeClientFor: await live.liveClients()};
}
const tickRow = t => ({dispatched: t.dispatched, skipped: t.skipped, blocked: t.blocked, intake: t.intake.length, recovery: t.recovery, released_expired: t.released_expired,
  stopped: t.stopped, spent: t.spent, scope: t.scope ?? null});

export async function runConfirmed({manifest: m, digest: manifestDigest, file}, plan, status, workInfo, {repo, seats = null, progress = () => {}, makeExecutorsImpl = makeExecutors}) {
  const L = m.limits, started = Date.now(), deadline = started + L.elapsed_ms;
  fs.mkdirSync(m.out_dir, {recursive: true});
  const work = workInfo.state === 'resumable' ? openWorkLedger({root: m.ledgers.work_root, create: false}) : createWorkRoot(m.ledgers.work_root, {item: m.item, manifestDigest});
  const progressFile = path.join(m.out_dir, 'progress.jsonl');
  const note = e => { fs.appendFileSync(progressFile, JSON.stringify({at: new Date().toISOString(), ...e}) + '\n'); progress(e); };
  if (m.credentials.gemini_api_key === 'not-used' && !seats) { delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY; }
  const s = seats ?? await liveSeats({meteredFailover: m.billing.metered_gemini_failover});
  const executors = await makeExecutorsImpl({repo, makeClientFor: s.makeClientFor, turn: s.turn, statusRoot: m.ledgers.status_root, stateDir: path.join(m.out_dir, 'operate'),
    profile: 'fit', independence: 'model', revisions: L.revisions, pipelineLimits: {...L.pipeline}, meteredFailover: m.billing.metered_gemini_failover, progress: note});
  const limits = {total_provider_calls: L.total_provider_calls, stage_provider_calls: L.stage_provider_calls, stage_attempts: L.stage_attempts, concurrency: 1, lease_ms: L.elapsed_ms};
  const ticks = [], launcherStops = [];
  const maxTicks = STAGES.length * L.stage_attempts * 2;
  const gateOf = () => reconcile({repo, statusRoot: m.ledgers.status_root, workLedger: work, issues: null}).items.find(i => i.item === m.item).gate;
  let gate = gateOf();
  for (let n = 0; n < maxTicks && STAGES.includes(gate.gate); n++) {
    const left = deadline - Date.now();
    if (left <= 0) { launcherStops.push({source: 'launcher', why: `elapsed limit ${L.elapsed_ms} ms reached`}); break; }
    const spentNow = spent(work).calls;
    if (L.total_provider_calls - spentNow < L.stage_provider_calls) {
      launcherStops.push({source: 'launcher', why: `provider-call budget: ${L.total_provider_calls - spentNow} left of ${L.total_provider_calls}, a stage needs up to ${L.stage_provider_calls}`});
      break;
    }
    note({event: 'tick', n, gate: gate.gate});
    const t = await tick({repo, statusRoot: m.ledgers.status_root, workRoot: m.ledgers.work_root, executors, limits: {...limits, elapsed_ms: left}, holder: 'live-run', only: m.item, progress: note});
    ticks.push(tickRow(t));
    gate = gateOf();
    if (!t.dispatched.length) break;
  }
  if (STAGES.includes(gate.gate) && ticks.length >= maxTicks) launcherStops.push({source: 'launcher', why: `tick limit ${maxTicks} reached`});
  const stages = work.stages(m.item);
  const outcome = [...stages].reverse().find(x => x.stage === 'outcome' && x.status === 'passed') ?? null;
  const receipt = subagentReceipt(stages, m.require_subagent);
  const verification = freshVerification({workRoot: m.ledgers.work_root, stages, statusRoot: m.ledgers.status_root, statusBefore: status});
  const reasons = [];
  if (gate.gate !== 'awaiting-owner' || !outcome) reasons.push(`the item did not reach its outcome: gate "${gate.gate}"${gate.reason ? ` (${gate.reason})` : ''}`);
  if (!receipt.met) reasons.push(`require_subagent not met: ${receipt.why}`);
  if (!verification.ok) reasons.push('the fresh verification did not pass (see verification)');
  const proposal = outcome ? {path: outcome.outputs.proposal_path, digest: outcome.outputs.proposal_digest, file_sha256: outcome.outputs.proposal_file_sha256, to: outcome.outputs.to, signed: false,
    apply_command: `OPHANIM_STATUS_LEDGER='${m.ledgers.status_root}' node packages/ledger/status.mjs apply '${outcome.outputs.proposal_path}' --keys "$OPHANIM_STATUS_KEYS"`,
    note: 'UNSIGNED. The launcher never applies it: the owner runs the command above, with the owner\'s status keys, after checking the record.'} : null;
  const blockers = [...ticks.flatMap(t => t.blocked.filter(b => b.item === m.item).map(b => ({source: 'tick', ...b}))), ...stages.filter(x => x.blocker).map(x => ({source: 'stage', stage: x.stage, attempt: x.attempt, record: x.hash, blocker: x.blocker}))];
  const record = {schema: RECORD_SCHEMA, at: new Date().toISOString(), started_at: new Date(started).toISOString(), elapsed_ms: Date.now() - started,
    manifest: {file, digest: manifestDigest}, item: m.item, candidate_commit: m.candidate_commit, plan,
    work_ledger: {root: m.ledgers.work_root, anchor: work.anchor, created: workInfo.state !== 'resumable', marker: path.join(m.ledgers.work_root, WORK_MARKER)},
    limits: L, billing: m.billing, spent: spent(work), ticks, stages: stages.map(stageRow), budget_stops: budgetStops(ticks, stages, launcherStops), blockers,
    served_identities: servedIdentities(stages), subagent_receipt: receipt, pipelines: pipelinesOf(stages),
    final_gate: {gate: gate.gate, reason: gate.reason ?? null, blocker: gate.blocker ?? null}, verification, proposal,
    acceptance: {met: !reasons.length, reasons}, progress: progressFile};
  const runFile = path.join(m.out_dir, 'run.json');
  if (fs.existsSync(runFile)) fs.renameSync(runFile, path.join(m.out_dir, `run.${fs.statSync(runFile).mtimeMs.toFixed(0)}.json`));
  fs.writeFileSync(runFile, JSON.stringify(record, null, 2) + '\n');
  return {record, file: runFile, code: reasons.length ? 3 : 0};
}

// ---- the command line ------------------------------------------------------------------------------------------
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (['--manifest', '--confirm-spend', '--repo'].includes(a)) { if (i + 1 >= argv.length) usage(`${a} needs a value`); opts[a.slice(2)] = argv[++i]; }
    else usage(`unknown argument: ${a}`);
  }
  if (!opts.manifest) usage('--manifest FILE is required');
  if (opts.dryRun && opts['confirm-spend'] !== undefined) usage('--dry-run and --confirm-spend are exclusive');
  return opts;
}

/**
 * The launcher. `seats` ({turn, makeClientFor}) replaces the live seats (tests only: the command line always uses the
 * live ones). Returns the exit code.
 */
export async function main(argv = process.argv.slice(2), {log = console.log, err = console.error, env = process.env, seats = null, makeExecutorsImpl} = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { err(`${e.message}\nusage: live-run.mjs --manifest FILE [--dry-run] [--confirm-spend "<item>@<commit7>"] [--repo DIR]`); return 2; }
  const repo = path.resolve(opts.repo ?? REPO_ROOT);
  let loaded;
  try { loaded = readManifest(opts.manifest); }
  catch (e) { log(JSON.stringify({schema: PLAN_SCHEMA, ok: false, refused: 'manifest', refusals: e.reasons ?? [e.message], provider_calls: 0}, null, 2)); return 1; }
  const mode = opts['confirm-spend'] === undefined ? 'dry-run' : 'confirmed';
  if (mode === 'confirmed' && opts['confirm-spend'] !== confirmString(loaded.manifest)) {
    log(JSON.stringify({schema: PLAN_SCHEMA, ok: false, refused: 'confirm-spend', refusals: [`--confirm-spend must be exactly "${confirmString(loaded.manifest)}" (<item>@<first 7 of candidate_commit>); nothing was run`], provider_calls: 0}, null, 2));
    return 1;
  }
  let built;
  try { built = await buildPlan(loaded, {repo, env, mode}); }
  catch (e) { log(JSON.stringify({schema: PLAN_SCHEMA, ok: false, refused: 'plan', refusals: [e.message], provider_calls: 0}, null, 2)); return 1; }
  if (mode === 'dry-run' || built.refusals.length) { log(JSON.stringify(built.plan, null, 2)); return built.refusals.length ? 1 : 0; }
  const r = await runConfirmed(loaded, built.plan, built.status, built.work, {repo, seats, makeExecutorsImpl, progress: e => err(JSON.stringify(e))});
  log(JSON.stringify({schema: RECORD_SCHEMA, run: r.file, code: r.code, acceptance: r.record.acceptance, final_gate: r.record.final_gate, spent: r.record.spent,
    budget_stops: r.record.budget_stops, verification_ok: r.record.verification.ok,
    proposal: r.record.proposal ? {path: r.record.proposal.path, signed: false, apply_command: r.record.proposal.apply_command} : null}, null, 2));
  return r.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
