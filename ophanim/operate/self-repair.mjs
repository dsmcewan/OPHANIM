// THE SELF-REPAIR LANE: the INNER wheel (docs/self-repair.md). While the owner's switch is on, every scheduler tick opens
// one round whose work is to Detect -> Diagnose -> Repair -> Verify a defect in OPHANIM itself; the rounds run
// continuously, unattended, and everything they land is reversible by construction.
//
// THE WHEELS. The OUTER wheels govern this lane and are outside its reach: review independence and the three-lab floor
// (stages.mjs, unchanged), authorization and keys (the status ledger: this lane never writes it and never holds a key),
// the global billing policy (pantheon/src/route; unchanged, no lane-specific cap), the jails, the gates and mutation
// runners, the pentest, the lessons registry, the register, and the lane itself. They are the PROTECTED SURFACES below,
// enforced twice: Detect never selects a defect on one, and validate refuses a diff that touches one.
//
// THE OWNER'S AMENDMENT (2026-11-20, "Quit binding shit, on something that keeps going"). The owner-signed status item
// `self-repair` in state `In progress` is only the ON switch: nothing is bound to it. There is no lane config digest, no
// cap on open rounds, no backoff count and no lane-specific budget. One new round opens per tick and any number may be
// open; two rounds never edit overlapping paths at the same time (the round's open event, and every claim of a round,
// carry its paths; the work ledger refuses an overlap under its append lock); a defect whose round ended blocked or failed
// goes to the back of the queue (rotation), so one hard defect never stalls the lane; a round whose base moved because
// another round landed first is re-validated on the new line head before it lands.
//
// THE ROUND. Detect -> select -> open (work.repair `open`, with the selection's evidence and the routing of every
// skipped defect) -> the existing stages under the round's own work identity (`self-repair.r<N>`: the work ledger's item
// grammar has no `/`) -> land -> close. Diagnose is the plan stage: the plan names the defect, its root cause and a
// REPRODUCTION, which must FAIL on the round's base (a test) or be a stress record with failures (a flake); a plan without
// one is not accepted. Verify is review (unchanged) and validate, where this lane's MECHANICAL checks run on the diff and
// the runs before the validator is asked: the reproduction passes (a flake: a stress run of R rounds with no failure);
// every test T1 reaches passes; every runner T2 lists passes in full; the pentest reports no new hole; the test lint
// passes with --enforce; and the ANTI-CHEATING refusals: an assertion removed or weakened, a skip/todo/only added, a test
// file's test count lowered, a runner's kill count lowered, a protected path touched.
//
// LANDING. A verified repair lands as ONE commit on the line (default refs/heads/ophanim/self-repair, started from the
// base ref), and on no other ref: a fast-forward (git update-ref with the expected old head). The landing record holds the
// commit, its parent and the exact revert. ROLLBACK: a later Detect that finds a regression failing at a landed repair and
// passing at its parent (a bisect bounded to the landed repairs) runs a rollback round: a revert of that repair on the
// line, verified by the same mechanical validate, landed, and the reverted defect routed to the owner.
//
// DETECT reads only OPHANIM's own machine records: the latest gate record (check.mjs --json, wrapped with the commit it
// ran on; used only when it names the commit under repair), stress records (stress.mjs --json), the register's open
// entries through the graph's records extractor, and the pentest report. Never issue text, comments or any other
// external input: a stranger cannot steer a loop that changes code (Detect takes no issue argument at all).
//
// Inputs: the repository, the status ledger (read only), the work ledger (the lane's records), the records directory.
// Outputs: rounds on the work ledger; landings on the line; unsigned owner candidates under the state directory.
// Must never: write the status ledger or read a key; land on any ref but the line; select or accept a protected surface;
// read a withheld path (`findings-*`); call a provider (Detect, select, land and rollback are deterministic).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {digest} from '../../packages/ledger/canonical.mjs';
import {matchesOwned, pathsOverlap} from '../../pantheon/src/pipeline/paths.mjs';
import {parseId, decodeKey} from '../../packages/graph/identity.mjs';
import {recordsFacts, REGISTER} from '../graph/extract/records.mjs';
import {CANDIDATE_SCHEMA, CANDIDATE_STATE} from './graph-loop.mjs';
import {openStatusLedger} from '../../packages/ledger/status.mjs';

export const LANE_ITEM = 'self-repair';
export const RECORD_SCHEMA = 'ophanim.self-repair.record/v1';
export const VERIFY_SCHEMA = 'ophanim.self-repair.verification/v1';
export const LANE_PROPOSAL_SCHEMA = 'ophanim.self-repair.proposal/v1';
export const ROUND_RE = /^self-repair\.r([1-9][0-9]{0,6})$/;
export const roundId = n => `self-repair.r${n}`;
export const roundOf = item => { const m = ROUND_RE.exec(String(item ?? '')); return m ? Number(m[1]) : null; };
export const isRound = item => roundOf(item) !== null;
/** Ranking (decision 3): a regression first, then a measured flake, then register entries. */
export const RANK = Object.freeze({regression: 0, pentest: 0, flake: 1, register: 2});
export const RECORD_KINDS = Object.freeze(['gate', 'stress', 'pentest']);
const WITHHELD = /(^|\/)findings-[^/]*(\/|$)/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const fail = (why, code) => { throw Object.assign(new Error(why), {code}); };
const cut = (s, n = 300) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const sha256 = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
/** Plain JSON (no undefined, no NaN): what a ledger entry and the canonical digest accept. */
const clean = x => JSON.parse(JSON.stringify(x ?? null));

// ---- the protected surfaces (decision 9): the outer wheels ------------------------------------------------------------
// The brief's defaults, and two the lane ADDS (allowed: the list may only grow): scheduler.mjs and work-ledger.mjs carry
// the lane's own wiring (the round claims' path fence, the work.repair rules, the validate wrapper's dispatch), so a
// repair that edited them would be the lane editing itself.
export const PROTECTED_DEFAULTS = Object.freeze([
  'packages/ledger/**', 'ophanim/ledger/**', 'ophanim/operate/reconcile.mjs', 'ophanim/operate/gates.mjs',
  'pantheon/src/pipeline/record.mjs', 'pantheon/src/pipeline/checkpoint.mjs', 'pantheon/src/capability/eligibility.mjs',
  'pantheon/src/route/**', 'pantheon/src/agy/**', 'pantheon/src/board/agy-cli.mjs', 'pantheon/src/review-runner/sandbox.mjs',
  'packages/graph/federation*',
  'scripts/test-gates/**', 'scripts/pentest/**', '**/pentest/**', '**/*.mutate.mjs',
  'ophanim/lessons/**', 'docs/OPEN-LIMITATIONS.md', 'docs/execution/**',
  '.github/**', 'package.json', 'package-lock.json',
  'ophanim/operate/self-repair*', 'ophanim/operate/scheduler.mjs', 'ophanim/operate/work-ledger.mjs',
]);
/**
 * The lane's settings. Nothing here is bound to the owner's switch (amendment): these are the lane's defaults, kept on a
 * protected path. A caller may ADD protected surfaces (`protected_extra`), never remove one.
 *   line       the only ref a repair lands on      base_ref   where the line starts (once, when the first round opens)
 *   flake_rounds  R: a flake's reproduction passes only after R stress rounds with no failure
 *   commands   the pentest, lint and stress commands run in the checkout (argv; `{file}`, `{rounds}`, `{json}` filled in)
 *   jail       run every verification command in the verify jail (pantheon/src/agy/verify-jail.mjs)
 */
export const DEFAULT_CONFIG = Object.freeze({
  line: 'refs/heads/ophanim/self-repair', base_ref: 'HEAD', protected: PROTECTED_DEFAULTS, flake_rounds: 20,
  commands: Object.freeze({
    pentest: Object.freeze(['node', 'scripts/pentest/run.mjs']),
    lint: Object.freeze(['npm', 'run', 'test:lint', '--', '--enforce']),
    // --no-self-repair-records: Verify's own stress run is evidence for THIS round, not a record for Detect to read.
    stress: Object.freeze(['node', 'scripts/test-gates/stress.mjs', '--files', '{file}', '--repeat', '{rounds}', '--json', '{json}', '--no-self-repair-records']),
  }),
  // THE RECURSIVE LOOP (self-inspection; self-repair-inspect.mjs): what the idle lane runs on a clean checkout of the line
  // head, beside the tickets, at a lower CPU priority. Each writes a record the lane feeds to the next Detect itself.
  inspect: Object.freeze({
    gates: Object.freeze(['node', 'scripts/test-gates/check.mjs', 'run', '--json', '{json}', '--no-self-repair-records']),
    stress: Object.freeze(['node', 'scripts/test-gates/stress.mjs', '--files', '{files}', '--repeat', '{rounds}', '--json', '{json}', '--no-self-repair-records']),
    pentest: Object.freeze(['node', 'scripts/pentest/run.mjs']),
    rounds: 5, nice: 10, timeout_ms: 90 * 60_000,
    // An INCOMPLETE inspection of the head (a step whose report or process evidence is missing) is retried, after
    // first_ms, doubling per attempt, at most max_ms apart. Each attempt's steps are bounded by timeout_ms.
    retry: Object.freeze({first_ms: 15 * 60_000, max_ms: 6 * 60 * 60_000}),
  }),
  jail: true, timeout_ms: 30 * 60_000, checkout_root: null,
});
export function laneConfig(over = {}) {
  if (over.protected !== undefined) fail('laneConfig: the protected surfaces may only be added to (protected_extra), never replaced', 'CONFIG_REFUSED');
  const extra = over.protected_extra ?? [];
  if (!Array.isArray(extra) || !extra.every(p => typeof p === 'string' && p)) fail('laneConfig: protected_extra is a list of paths or globs', 'CONFIG_REFUSED');
  const line = over.line ?? DEFAULT_CONFIG.line;
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(line)) fail(`laneConfig: the line is a branch ref (refs/heads/...), not ${line}`, 'CONFIG_REFUSED');
  return Object.freeze({...DEFAULT_CONFIG, ...over, line, protected: Object.freeze([...PROTECTED_DEFAULTS, ...extra.filter(p => !PROTECTED_DEFAULTS.includes(p))]),
    commands: Object.freeze({...DEFAULT_CONFIG.commands, ...(over.commands ?? {})})});
}
/** Is a repository path on a protected surface? Case-folded (conservative on a case-insensitive filesystem). */
export const isProtected = (p, config = DEFAULT_CONFIG) => matchesOwned(String(p).toLowerCase(), config.protected.map(x => x.toLowerCase()));

// ---- the switch (decision 1, as amended) ------------------------------------------------------------------------------
/** The lane is ON only while the owner-signed board carries `self-repair` in state In progress. Nothing is bound to it. */
export function laneSwitch(board) {
  const s = (board?.items ?? []).find(i => i.item === LANE_ITEM);
  if (!s) return {on: false, present: false, why: `no owner-signed "${LANE_ITEM}" item on the status board: the lane is dormant`};
  if (s.state !== 'In progress') return {on: false, present: true, state: s.state, entry: s.entry, why: `the owner-signed "${LANE_ITEM}" item is ${s.state}, not In progress: the lane is dormant`};
  return {on: true, present: true, state: s.state, entry: s.entry, title: s.title};
}

// ---- the rounds, read from the work ledger (work.repair) ----------------------------------------------------------------
/** Every round with its events: [{n, item, open, close, land, revalidations}], in round order. */
export function roundsOf(work) {
  const by = new Map();
  for (const e of (typeof work?.repairs === 'function' ? work.repairs() : [])) {
    if (!Number.isInteger(e.round)) continue;
    const r = by.get(e.round) ?? by.set(e.round, {n: e.round, item: roundId(e.round), open: null, close: null, land: null, revalidations: []}).get(e.round);
    if (e.event === 'open') r.open = e; else if (e.event === 'close') r.close = e; else if (e.event === 'land') r.land = e; else if (e.event === 'revalidate') r.revalidations.push(e);
  }
  return [...by.values()].filter(r => r.open).sort((a, b) => a.n - b.n);
}
/** The status row a round is reconciled as (reconcile.mjs): its own work identity, under the lane, never on the status ledger. */
export function roundRow(r) {
  const d = r.open.defect;
  return {item: r.item, title: cut(`Self-repair round ${r.n} (${r.open.kind}): ${d.title ?? d.id}`, 200), state: 'In progress',
    basis: cut(`self-repair round ${r.n}: ${r.open.kind} of ${d.id}; base ${r.open.base}; selected ${r.open.at}`, 600),
    checked: String(r.open.at).slice(0, 10), entry: r.open.hash, round: r.n};
}
/** The paths a round claims: its defect's site, and once planned the plan's slices, units and reproduction. */
export function roundPaths(r, stages = []) {
  const out = new Set(r.open.paths ?? []);
  const plan = [...stages].reverse().find(s => s.stage === 'plan' && s.status === 'passed')?.outputs?.plan ?? null;
  for (const s of plan?.slices ?? []) if (typeof s?.path === 'string') out.add(s.path);
  for (const u of plan?.work_units ?? []) for (const p of u?.owned_paths ?? []) if (typeof p === 'string') out.add(p);
  if (typeof plan?.repair?.reproduction?.file === 'string') out.add(plan.repair.reproduction.file);
  return [...out].sort();
}

// ---- git -------------------------------------------------------------------------------------------------------------
const git = (repo, args, opts = {}) => execFileSync('git', ['-C', repo, '-c', 'user.name=ophanim-self-repair', '-c', 'user.email=self-repair@ophanim.invalid', '-c', 'commit.gpgsign=false', ...args],
  {encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'], ...opts});
/** Whether commit `a` is `b` or an ancestor of it. */
export const isAncestor = (repo, a, b) => { try { git(repo, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
export const revOf = (repo, ref) => { try { return git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim() || null; } catch { return null; } };
const parentOf = (repo, c) => revOf(repo, `${c}^`);
/** The files a commit range changes (renames as a delete and an add), withheld paths never listed. */
export function changedFiles(repo, base, head) {
  const out = git(repo, ['diff', '--name-status', '--no-renames', '-z', base, head, '--', '.', ':(exclude,glob)**/findings-*/**']).split('\0').filter(Boolean);
  const rows = [];
  for (let i = 0; i + 1 < out.length; i += 2) if (!WITHHELD.test(out[i + 1])) rows.push({status: out[i][0], path: out[i + 1]});
  return rows;
}
const showAt = (repo, commit, file) => { try { return git(repo, ['show', `${commit}:${file}`]); } catch { return null; } };
/**
 * A new commit on `onto` carrying `commit`'s patch (or its reverse), built with a private index (no working tree is
 * touched). Null when the patch does not apply. Used for the rebase onto a moved line head and for the rollback's revert.
 */
export function applyPatchOnto(repo, {commit, onto, reverse = false, message}) {
  const patch = git(repo, ['diff', '--binary', '--no-renames', `${commit}^`, commit]);
  const index = path.join(os.tmpdir(), `self-repair-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const env = {...process.env, GIT_INDEX_FILE: index};
  try {
    git(repo, ['read-tree', onto], {env});
    if (patch.trim()) {
      try { git(repo, ['apply', '--cached', '--binary', ...(reverse ? ['-R'] : []), '-'], {env, input: patch}); } catch { return null; }
    }
    const tree = git(repo, ['write-tree'], {env}).trim();
    return git(repo, ['commit-tree', tree, '-p', onto, '-F', '-'], {input: message}).trim();
  } finally { fs.rmSync(index, {force: true}); }
}
/** The stable patch id of a commit's own diff: two commits with the same id carry the same change. */
export function patchIdOf(repo, commit) {
  const diff = git(repo, ['diff', '--no-renames', `${commit}^`, commit]);
  if (!diff.trim()) return null;
  return git(repo, ['patch-id', '--stable'], {input: diff}).trim().split(/\s+/)[0] ?? null;
}
/** The exact revert of a landed commit, as recorded with every landing. */
export const revertOf = commit => `git revert --no-edit ${commit}`;
/** Decision 7, G6: a repair lands on the line and on no other ref. */
export function landingRefusal({ref, config = DEFAULT_CONFIG}) {
  return ref === config.line ? null : `LANDING_REF: a repair lands only on the line ${config.line}, never on ${ref}`;
}

// ---- records (Detect's only inputs) -------------------------------------------------------------------------------------
export const recordsDirOf = stateDir => path.join(stateDir, 'self-repair', 'records');
/** Wrap one of OPHANIM's own machine records with the commit it ran on (the `self-repair record` CLI verb). */
export function writeRecord({dir, kind, commit, record, at = new Date().toISOString()}) {
  if (!RECORD_KINDS.includes(kind)) fail(`a record is one of ${RECORD_KINDS.join(', ')}`, 'USAGE');
  if (!SHA.test(commit ?? '')) fail('a record names the full commit it ran on', 'USAGE');
  const body = {schema: RECORD_SCHEMA, kind, commit, at, record};
  const d = path.join(dir, kind);
  fs.mkdirSync(d, {recursive: true});
  const f = path.join(d, `${at.replace(/[^0-9TZ]/g, '')}-${digest(body).slice(0, 12)}.json`);
  fs.writeFileSync(f, JSON.stringify(body, null, 2) + '\n');
  return f;
}
/** Every record under `dir`, by kind; an unreadable one is listed, never dropped silently. */
export function readRecords(dir) {
  const out = {gate: [], stress: [], pentest: [], unreadable: []};
  for (const kind of RECORD_KINDS) {
    const d = path.join(dir ?? '', kind);
    if (!dir || !fs.existsSync(d)) continue;
    for (const n of fs.readdirSync(d).filter(x => x.endsWith('.json')).sort()) {
      const f = path.join(d, n);
      try {
        const r = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (r?.schema !== RECORD_SCHEMA || r.kind !== kind || !SHA.test(r.commit ?? '') || typeof r.at !== 'string') throw new Error(`not an ${RECORD_SCHEMA} ${kind} record`);
        out[kind].push({file: path.relative(dir, f), digest: 'sha256:' + digest(r), commit: r.commit, at: r.at, record: r.record});
      } catch (e) { out.unreadable.push({file: path.relative(dir, f), why: cut(e.message, 200)}); }
    }
    out[kind].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.file < b.file ? -1 : 1));
  }
  return out;
}
/** Where the lane reads its records for `repo`, found as its CLI finds them: beside the work ledger (OPHANIM_WORK_LEDGER,
 *  default status/work), under operate/self-repair/records. git-ignored (status/operate/). */
export const laneRecordsDir = ({repo, env = process.env}) =>
  recordsDirOf(path.join(path.dirname(path.resolve(env.OPHANIM_WORK_LEDGER ?? path.join(repo, 'status', 'work'))), 'operate'));
/**
 * FEED DETECT. The gates (scripts/test-gates/check.mjs) and the stress tool (stress.mjs) call this after each run, so a
 * regression or a measured flake reaches Detect without a hand-made `self-repair record`. It wraps the run's record with
 * the commit it ran on, into the lane's records directory:
 *   - only while the lane is ON (the owner-signed switch on this repository's board), or into `dir` when one is given;
 *   - only when the working tree IS that commit: a tree with changes or untracked files would attribute its results to a
 *     commit that did not produce them, and the lane would chase a defect the commit does not have.
 * A skip is returned, never thrown: {written, commit} or {skipped: why}. The caller's verdict never depends on the lane.
 */
export function feedRecord({repo, kind, record, env = process.env, dir = null}) {
  if (!RECORD_KINDS.includes(kind)) fail(`a record is one of ${RECORD_KINDS.join(', ')}`, 'USAGE');
  let target = dir;
  if (!target) {
    let sw;
    try { sw = laneSwitch(openStatusLedger({root: path.resolve(env.OPHANIM_STATUS_LEDGER ?? path.join(repo, 'status', 'ledger')), create: false}).board()); }
    catch (e) { return {skipped: `the status board could not be read (${cut(e.message, 160)}), so the lane's switch is unknown`}; }
    if (!sw.on) return {skipped: sw.why};
    target = laneRecordsDir({repo, env});
  }
  let commit, changes;
  try { commit = git(repo, ['rev-parse', 'HEAD']).trim(); changes = git(repo, ['status', '--porcelain']).split('\n').filter(Boolean); }
  catch (e) { return {skipped: `not a git checkout with a commit (${cut(e.message, 120)})`}; }
  if (changes.length) return {skipped: `the working tree differs from ${commit.slice(0, 12)} (${changes.length} path(s) changed or untracked): its results are not that commit's`};
  return {written: writeRecord({dir: target, kind, commit, record}), commit};
}

// ---- Detect (decision 3) ---------------------------------------------------------------------------------------------
const testDefect = ({file, name, kind, evidence, reproduction}) => ({id: `test:${file}::${name ?? '*'}`, kind, rank: RANK[kind], title: `${kind === 'flake' ? 'flaky' : 'failing'} test ${name ?? '(the file)'} in ${file}`,
  site: [file], keys: [file], reproduction, evidence});
/**
 * A gate record's suite rows that Detect can read, and why each other row is skipped (a partial or malformed historical
 * record: a row that is not an object, or whose notes or problems are not lists of text). A readable row's findings are
 * used whatever its neighbours are.
 */
export function gateRows(rec) {
  const results = rec?.record?.results, rows = [], skipped = [];
  if (!Array.isArray(results)) return {rows, skipped: results === undefined ? [] : ['results is not a list']};
  const texts = v => v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string'));
  results.forEach((r, i) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) skipped.push(`results[${i}] is not a suite row`);
    else if (!texts(r.notes) || !texts(r.problems)) skipped.push(`results[${i}] (${typeof r.suite === 'string' ? r.suite : 'no suite'}): its notes or problems are not lists of text`);
    else rows.push(r);
  });
  return {rows, skipped};
}
/** The failing tests a gate record names (check.mjs: per-suite notes `fail: NAME at FILE:LINE -- ...` and its problems). */
export function gateDefects(rec) {
  const out = [], seen = new Set();
  for (const r of gateRows(rec).rows) {
    for (const note of r.notes ?? []) {
      const m = /^(fail|cancelled): (.+) at ([^\s]+?):(\d+|\?) -- /.exec(note);
      if (!m || WITHHELD.test(m[3])) continue;
      const id = `${m[3]}::${m[2]}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(testDefect({file: m[3], name: m[2], kind: 'regression', reproduction: {kind: 'test', file: m[3], name: m[2]},
        evidence: {source: 'gate', record: rec.file, digest: rec.digest, commit: rec.commit, suite: r.suite ?? null, status: m[1], line: m[4], note: cut(note, 400)}}));
    }
    for (const p of r.problems ?? []) {
      const m = /^(?:hung: (\S+) did not finish|no result for (\S+?):)/.exec(p);
      const file = m?.[1] ?? m?.[2];
      if (!file || WITHHELD.test(file) || out.some(d => d.site[0] === file)) continue;
      out.push(testDefect({file, name: null, kind: 'regression', reproduction: {kind: 'test', file, name: null},
        evidence: {source: 'gate', record: rec.file, digest: rec.digest, commit: rec.commit, suite: r.suite ?? null, problem: cut(p, 400)}}));
    }
  }
  return out;
}
/** A stress record's failing tests: intermittent ones are measured flakes (with their failure rate). */
export function stressDefects(rec, commit) {
  const out = [], repeat = rec.record?.repeat;
  for (const t of rec.record?.byTest ?? []) {
    if (typeof t?.file !== 'string' || WITHHELD.test(t.file) || !Array.isArray(t.rounds) || !Number.isInteger(repeat) || repeat < 1) continue;
    const name = t.name === '(the file: see its problems)' ? null : t.name ?? null;
    const rate = {failed: new Set(t.rounds).size, rounds: repeat};
    const evidence = {source: 'stress', record: rec.file, digest: rec.digest, commit: rec.commit, rounds: [...new Set(t.rounds)].sort((a, b) => a - b), failure_rate: rate};
    if (t.pattern === 'intermittent') out.push(testDefect({file: t.file, name, kind: 'flake', reproduction: {kind: 'stress', file: t.file, name, record: rec.digest, failure_rate: rate}, evidence}));
    else if (rec.commit === commit) out.push(testDefect({file: t.file, name, kind: 'regression', reproduction: {kind: 'test', file: t.file, name}, evidence}));
  }
  return out;
}
/**
 * The register's OPEN entries at `commit`, through the graph's records extractor (recordsFacts). An entry's SITE is the
 * tree paths it names, in the order its item text names them; its SUBJECT, the first, is where the defect is located (the
 * register names the item first: rule 2). `pending owner` entries are the owner's to decide.
 */
export function registerDefects(repo, commit, {register = REGISTER} = {}) {
  const drafts = recordsFacts(repo, commit, {register});
  const entries = drafts.filter(d => d.entity && !d.status && d.attributes?.register === register);
  const named = new Map();
  for (const d of drafts) {
    if (d.type !== 'mentions' || d.attributes?.basis !== 'the entry names this path') continue;
    let p = null;
    try { const x = parseId(d.to); p = decodeKey(x.key); } catch { p = null; }
    if (!p || WITHHELD.test(p)) continue;
    (named.get(d.from) ?? named.set(d.from, []).get(d.from)).push(p);
  }
  const out = [];
  for (const e of entries) {
    const status = String(e.attributes.status ?? '').trim();
    const open = /^open\b/i.test(status), pending = /^pending owner\b/i.test(status);
    if (!open && !pending) continue;
    const text = String(e.attributes.item ?? '');
    const at = p => { const i = text.indexOf(p); return i < 0 ? Infinity : i; };
    const site = [...(named.get(e.entity) ?? [])].sort((a, b) => at(a) - at(b) || (a < b ? -1 : 1));
    out.push({id: `register:${e.attributes.id}`, kind: 'register', rank: RANK.register, ref: e.attributes.id, title: `${e.attributes.id}: ${cut(text, 160)}`, site, keys: [e.attributes.id],
      status: cut(status, 120), pending_owner: pending, reproduction: null,
      evidence: {source: 'register', register, commit, entry: e.attributes.id, section: e.attributes.section ?? null, status: cut(status, 120)}});
  }
  return out;
}
/** The pentest report (scripts/pentest/run.mjs's text): a NEW hole, a known hole that looks fixed, or a failing file. */
export function pentestDefects(rec) {
  const out = [], text = String(rec.record?.report ?? rec.record ?? '');
  for (const line of text.split('\n')) {
    const m = /^ {2}(\S+)\s+(NEW HOLE|KNOWN_HOLE_FIXED)\s*(.*)$/.exec(line);
    if (m) out.push({id: `pentest:${m[1]}`, kind: 'pentest', rank: RANK.pentest, title: `pentest ${m[1]}: ${m[2]}`, site: ['**/pentest/**'], keys: [m[1]], reproduction: null,
      evidence: {source: 'pentest', record: rec.file, digest: rec.digest, commit: rec.commit, verdict: m[2], evidence: cut(m[3], 300)}});
    const f = /^ran: node --test (\S+)\s+exit (\S+)$/.exec(line.trim());
    if (f && f[2] !== '0' && !WITHHELD.test(f[1])) out.push({id: `pentest-file:${f[1]}`, kind: 'pentest', rank: RANK.pentest, title: `pentest file ${f[1]} exited ${f[2]}`, site: [f[1]], keys: [f[1]], reproduction: null,
      evidence: {source: 'pentest', record: rec.file, digest: rec.digest, commit: rec.commit, exit: f[2]}});
  }
  return out;
}
/**
 * DETECT. Deterministic, no provider call, only OPHANIM's own records (there is no issue argument). Returns the defects
 * ranked (regression, flake, register; source order within a rank), the records it ignored and why, and a digest.
 */
export function detect({repo, commit, records, register = REGISTER}) {
  const defects = [], ignored = [...(records.unreadable ?? []).map(u => ({source: u.file, why: u.why}))];
  const gate = records.gate.at(-1) ?? null;
  if (gate && gate.commit !== commit) ignored.push({source: gate.file, why: `the latest gate record names ${gate.commit.slice(0, 12)}, not the commit under repair ${String(commit).slice(0, 12)}: not used`});
  else if (gate) {
    defects.push(...gateDefects(gate));
    for (const why of gateRows(gate).skipped) ignored.push({source: gate.file, why: `a gate row is not readable: ${why}`});
  }
  for (const s of records.stress) defects.push(...stressDefects(s, commit));
  let reg = [];
  try { reg = registerDefects(repo, commit, {register}); } catch (e) { ignored.push({source: register, why: `the register could not be read at ${String(commit).slice(0, 12)}: ${cut(e.message, 200)}`}); }
  defects.push(...reg);
  const pen = records.pentest.at(-1) ?? null;
  if (pen) defects.push(...pentestDefects(pen));
  // One defect per id, at its best rank, in a stable order.
  const by = new Map();
  defects.forEach((d, i) => { const was = by.get(d.id); if (!was || d.rank < was.d.rank) by.set(d.id, {d, i: was?.i ?? i}); });
  const ranked = [...by.values()].sort((a, b) => a.d.rank - b.d.rank || a.i - b.i).map(x => x.d);
  return {commit, defects: ranked, ignored, digest: 'sha256:' + digest({commit, defects: ranked.map(d => [d.id, d.rank, d.evidence])}),
    sources: {gate: gate?.file ?? null, stress: records.stress.map(s => s.file), pentest: pen?.file ?? null, register}};
}

// ---- selection: dedupe, protection, rotation (decisions 3 and 9, as amended) ---------------------------------------------
const keyNamed = (text, key) => new RegExp(`(^|[^\\w./-])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`).test(text);
/** Where the defect is located, and whether that is a protected surface (decision 9: never selected). */
export function protectedSite(d, config = DEFAULT_CONFIG) {
  const subject = d.site[0] ?? null;
  if (!subject) return null;
  return isProtected(subject, config) ? subject : null;
}
/**
 * The round's selection. Every defect is either SELECTED (at most one), QUEUED behind it, or SKIPPED with its routing:
 *   owner     on a protected surface, or reverted by a rollback: an unsigned owner candidate, never selected;
 *   owner-decision  the register says it is pending the owner;     unlocated  it names no path of the tree;
 *   deduped   an open round or an owner-signed item already has it; landed  a landed repair awaits the owner's merge;
 *   waiting   its site overlaps the paths of an open round (two rounds never edit overlapping paths at once).
 * ROTATION: a defect whose round ended blocked or failed goes to the back of the queue, oldest attempt first.
 */
export function select({defects, rounds, board, config = DEFAULT_CONFIG, stagesOf = () => [], routed = new Map(), after = () => false}) {
  const skipped = [], eligible = [];
  const open = rounds.filter(r => !r.close);
  const reverted = new Set(rounds.filter(r => r.open.kind === 'rollback' && r.close?.outcome === 'landed').map(r => r.open.culprit?.defect).filter(Boolean));
  const landed = new Map(rounds.filter(r => r.open.kind === 'repair' && r.close?.outcome === 'landed').map(r => [r.open.defect.id, {n: r.n, commit: r.land?.commit ?? null}]));
  // BACK AFTER ITS REPAIR (learning, 2026-11-20): a failing test or a measured flake whose evidence was taken at a commit that
  // CONTAINS the landed repair is not awaiting the owner's merge: the repair did not hold, and it is eligible again (its
  // round carries the recurrence). A register entry stays as it was until the owner updates it. `after(a, b)`: commit a
  // is b or an ancestor of it.
  const back = (d, l) => ['regression', 'flake'].includes(d.kind) && Boolean(l.commit && d.evidence?.commit) && after(l.commit, d.evidence.commit);
  const lastTry = new Map();
  for (const r of rounds) if (r.open.kind === 'repair' && r.close && r.close.outcome !== 'landed') lastTry.set(r.open.defect.id, r.n);
  const items = (board?.items ?? []).filter(i => i.item !== LANE_ITEM);
  const claimed = open.map(r => ({n: r.n, paths: roundPaths(r, stagesOf(r.item))}));
  for (const d of defects) {
    const prot = protectedSite(d, config);
    const owner = items.find(i => d.keys.some(k => keyNamed(`${i.title} ${i.basis}`, k)));
    const overlap = claimed.find(c => d.site.some(p => c.paths.some(q => pathsOverlap(p, q))));
    const skip = prot ? {route: 'owner', why: `PROTECTED: its subject ${prot} is a protected surface (an outer wheel): an owner candidate, never selected`}
      : reverted.has(d.id) ? {route: 'owner', why: 'a rollback round reverted the repair of this defect: routed to the owner'}
      : routed.has(d.id) ? {route: 'owner', why: `routed to the owner earlier: ${routed.get(d.id)}`}
      : d.pending_owner ? {route: 'owner-decision', why: `the register says: ${d.status}`}
      : !d.site.length ? {route: 'unlocated', why: 'the entry names no path of the tree, so it cannot be located on an unprotected surface'}
      : open.some(r => r.open.defect.id === d.id) ? {route: 'deduped', why: `round ${open.find(r => r.open.defect.id === d.id).n} is open for it`}
      : landed.has(d.id) && !back(d, landed.get(d.id)) ? {route: 'landed', why: `round ${landed.get(d.id).n} landed its repair on the line; it awaits the owner's merge`}
      : owner ? {route: 'deduped', why: `the owner-signed item "${owner.item}" names it`}
      : overlap ? {route: 'waiting', why: `its site overlaps the paths of open round ${overlap.n}: two rounds never edit overlapping paths at once`}
      : null;
    if (skip) skipped.push({id: d.id, kind: d.kind, ...skip}); else eligible.push(d);
  }
  // ROTATION (amendment): never-attempted defects first, in rank order; then the attempted ones, the longest-waiting first.
  const fresh = eligible.filter(d => !lastTry.has(d.id)), tried = eligible.filter(d => lastTry.has(d.id)).sort((a, b) => lastTry.get(a.id) - lastTry.get(b.id));
  const queue = [...fresh, ...tried];
  return {selected: queue[0] ?? null, queue: queue.slice(1).map(d => ({id: d.id, kind: d.kind, ...(lastTry.has(d.id) ? {last_round: lastTry.get(d.id)} : {})})), skipped};
}

// ---- runs: a checkout of a commit, commands in the verify jail -----------------------------------------------------------
/** A disposable clone of `repo` at `commit`; its sparse checkout never materializes a withheld path. */
export function checkoutAt(repo, commit, {root = null} = {}) {
  const dir = fs.mkdtempSync(path.join(root ?? os.tmpdir(), 'self-repair-co-'));
  const dest = path.join(dir, 'tree');
  execFileSync('git', ['clone', '-q', '--no-checkout', '--no-hardlinks', repo, dest], {stdio: 'ignore'});
  git(dest, ['fetch', '-q', repo, commit]);
  git(dest, ['sparse-checkout', 'set', '--no-cone', '/*', '!findings-*/', '!findings-*']);
  git(dest, ['checkout', '-q', '--detach', commit]);
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules', 'packages/graph/node_modules']) {
    if (fs.existsSync(path.join(repo, nm)) && !fs.existsSync(path.join(dest, nm))) fs.symlinkSync(fs.realpathSync(path.join(repo, nm)), path.join(dest, nm), 'dir');
  }
  return {dir: dest, done: () => fs.rmSync(dir, {recursive: true, force: true})};
}
export const spawnRun = (cmd, args, {cwd, env, timeout}) => new Promise(resolve => {
  const t0 = Date.now();
  let out = '', err = '', killed = null;
  let child;
  try { child = spawn(cmd, args, {cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true}); } catch (e) { resolve({exit: null, stdout: '', stderr: String(e.message), ms: 0, killed: 'spawn'}); return; }
  child.stdout.on('data', d => { if (out.length < (16 << 20)) out += d; });
  child.stderr.on('data', d => { if (err.length < (16 << 20)) err += d; });
  const timer = setTimeout(() => { killed = 'timeout'; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeout);
  child.on('error', e => { clearTimeout(timer); resolve({exit: null, stdout: out, stderr: `${err}${e.message}`, ms: Date.now() - t0, killed: killed ?? 'spawn'}); });
  child.on('close', code => { clearTimeout(timer); resolve({exit: killed ? null : code, stdout: out, stderr: err, ms: Date.now() - t0, killed}); });
});
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
/**
 * Run argv in the checkout. Worker-written code runs here (the repair commit), so under `config.jail` it runs ONLY in the
 * verify jail (a clean environment, no home, no network; the work ledger and the state directory hidden), as the
 * validate stage's own commands do. Without the jail (a test's choice) the environment is still an allowlist.
 */
async function runIn(co, argv, {cwd = co, config, hide = [], timeout = config.timeout_ms}) {
  const cmd = argv.join(' ');
  if (config.jail) {
    const {VERIFY_JAIL_MODULE, VERIFY_JAIL_SCHEMA, launcherEnv} = await import('../../pantheon/src/agy/verify-jail.mjs');
    const extra = ['node_modules'].map(n => path.join(co, n)).filter(p => fs.existsSync(p)).map(p => fs.realpathSync(p));
    const policy = {schema: VERIFY_JAIL_SCHEMA, worktree: co, cwd, script: argv.map(shq).join(' '), hide: hide.filter(h => typeof h === 'string' && path.isAbsolute(h)), ...(extra.length ? {extra_ro: extra} : {})};
    const r = await spawnRun(process.execPath, [VERIFY_JAIL_MODULE, '--inline', JSON.stringify(policy)], {cwd, env: launcherEnv(process.env), timeout});
    return {cmd, ...r};
  }
  const env = Object.fromEntries(['PATH', 'LANG', 'TZ'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  return {cmd, ...(await spawnRun(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), {cwd, env: {...env, HOME: co, TMPDIR: os.tmpdir()}, timeout}))};
}
const countOf = (text, k) => Number(new RegExp(`^[ℹ#] ${k} (\\d+)`, 'm').exec(text)?.[1] ?? NaN);
/** The cwd and flags a test file runs with: those of the suite that runs it (scripts/test-gates/suites.mjs), else the root. */
async function placeOf(co, file) {
  try {
    const {suites} = await import('../../scripts/test-gates/suites.mjs');
    const s = suites(co).find(x => x.files.includes(path.join(co, file)));
    if (s) return {cwd: s.cwd, flags: s.flags.filter(f => !/^--test-(concurrency|reporter|only)\b/.test(f))};
  } catch { /* a repository without the gate's suites: the root, no flags */ }
  return {cwd: co, flags: []};
}
const namePattern = name => `^${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
/** One test file (one named test when `name` is given) in the checkout: {pass, exit, tests, passed, failed, skipped}. */
async function runTest(co, {file, name = null}, ctx) {
  const {cwd, flags} = await placeOf(co, file);
  const r = await runIn(co, ['node', '--test', ...flags, ...(name ? [`--test-name-pattern=${namePattern(name)}`] : []), path.join(co, file)], {cwd, ...ctx});
  const text = `${r.stdout}\n${r.stderr}`;
  const tests = countOf(text, 'tests'), passed = countOf(text, 'pass'), failed = countOf(text, 'fail'), skipped = countOf(text, 'skipped'), cancelled = countOf(text, 'cancelled');
  return {kind: 'test', file, name, cmd: r.cmd, exit: r.exit, ms: r.ms, tests, passed, failed, skipped, cancelled, killed: r.killed ?? null,
    pass: r.exit === 0 && passed >= 1 && !(failed > 0) && !(cancelled > 0), fails: r.exit !== 0 && (failed >= 1 || cancelled >= 1), tail: cut(text.slice(-1200), 1200)};
}

// ---- the anti-cheating checks (decision 6), mechanical, on the diff ------------------------------------------------------
const isTestFile = p => /\.test\.(mjs|js|cjs)$/.test(p);
const norm = s => s.trim().replace(/\s+/g, ' ');
const ASSERTION = /\bassert(?:\.\w+)?\s*\(|\bt\.assert\.\w+\s*\(|\bexpect\s*\(/;
const SKIPPING = /\.(?:skip|todo|only)\s*\(|\b(?:skip|todo|only)\s*:\s*(?:true\b|['"`])|--test-only\b/g;
const TEST_CALL = /(?:^|[^\w.$])(?:test|it)\s*\(\s*['"`]|\bt\.test\s*\(|\b(?:test|it)\.(?:skip|todo|only)\s*\(/g;
/**
 * The facts of one test file's text the anti-cheating checks compare: its ASSERTIONS (each assertion call to the end of
 * its line, whitespace normalized: what sits before it on the line, such as the test's own options, is not the
 * assertion), its skip/todo/only markers and its test count.
 */
export function testFacts(text) {
  const lines = String(text ?? '').split('\n');
  const assertions = [];
  for (const l of lines) {
    if (/^\s*\/\//.test(l)) continue;
    const m = ASSERTION.exec(l);
    if (m) assertions.push(norm(l.slice(m.index)));
  }
  return {assertions, skips: (String(text ?? '').match(SKIPPING) ?? []).length, tests: (String(text ?? '').match(TEST_CALL) ?? []).length};
}
/** Refusals of the diff from `cheatBase` to `commit` over its test files (empty: none). */
export function cheatRefusals(repo, {cheatBase, commit, files}) {
  const out = [];
  for (const f of files.filter(x => isTestFile(x.path))) {
    const before = showAt(repo, cheatBase, f.path), after = f.status === 'D' ? null : showAt(repo, commit, f.path);
    if (before === null) continue;
    if (after === null) { out.push({code: 'TEST_COUNT_LOWERED', file: f.path, what: `TEST_COUNT_LOWERED: the repair deletes the test file ${f.path}`}); continue; }
    const a = testFacts(before), b = testFacts(after);
    const left = new Map();
    for (const l of b.assertions) left.set(l, (left.get(l) ?? 0) + 1);
    const removed = [];
    for (const l of a.assertions) { const n = left.get(l) ?? 0; if (n > 0) left.set(l, n - 1); else removed.push(l); }
    if (removed.length) out.push({code: 'ASSERTION_REMOVED', file: f.path, removed: removed.slice(0, 8).map(x => cut(x, 200)),
      what: `ASSERTION_REMOVED: ${removed.length} assertion(s) of ${f.path} are removed or weakened (changed): ${cut(removed[0], 160)}`});
    if (b.skips > a.skips) out.push({code: 'SKIP_ADDED', file: f.path, what: `SKIP_ADDED: ${f.path} gains ${b.skips - a.skips} skip/todo/only marker(s)`});
    if (b.tests < a.tests) out.push({code: 'TEST_COUNT_LOWERED', file: f.path, what: `TEST_COUNT_LOWERED: ${f.path} goes from ${a.tests} to ${b.tests} test(s)`});
  }
  return out;
}
const killsOf = text => (String(text).match(/^\S+ KILLED\b/gm) ?? []).length;
const newHolesOf = text => [...String(text).matchAll(/^ {2}(\S+)\s+NEW HOLE\b/gm)].map(m => m[1]).sort();
const failingFilesOf = text => [...String(text).matchAll(/^ran: node --test (\S+)\s+exit (\S+)$/gm)].filter(m => m[2] !== '0').map(m => m[1]).sort();

/** The plan's repair block, by shape (stages.mjs planRefusal calls this for a round's plan; empty: acceptable). */
export function repairPlanRefusal(repair, defect) {
  if (!defect) return [];
  const r = repair, why = [];
  if (!r || typeof r !== 'object') return [`a self-repair round's plan states repair: {defect: "${defect.id}", root_cause, reproduction} (decision 4)`];
  if (r.defect !== defect.id) why.push(`repair.defect names ${cut(r.defect, 80)}, not this round's defect ${defect.id}`);
  if (typeof r.root_cause !== 'string' || r.root_cause.trim().length < 20) why.push('repair.root_cause states the root cause in a sentence (at least 20 characters)');
  const p = r.reproduction;
  if (!p || !['test', 'stress'].includes(p.kind) || typeof p.file !== 'string' || !isTestFile(p.file) || path.isAbsolute(p.file) || p.file.split('/').includes('..'))
    why.push('repair.reproduction is {kind: "test" | "stress", file: <a repository test file>, name?, source?, record?, failure_rate?}');
  else if (p.kind === 'stress' && !(typeof p.record === 'string' && p.failure_rate && Number.isInteger(p.failure_rate.failed) && p.failure_rate.failed >= 1))
    why.push('a flake\'s reproduction names its stress record and failure rate (failed >= 1)');
  return why;
}

/**
 * DIAGNOSE (decision 4): the plan's reproduction must FAIL on the round's base. A test: run there (a new test file the plan
 * writes in `source` is added to the base checkout first; it may not exist there already). A flake: the cited stress
 * record exists and shows the named test failing. Returns {ok, refusals, run}.
 */
export async function reproductionRefusal({repo, base, repair, defect, records = null, config = DEFAULT_CONFIG, hide = []}) {
  const shape = repairPlanRefusal(repair, defect);
  if (shape.length) return {ok: false, refusals: shape.map(what => ({code: 'REPRODUCTION_SHAPE', what}))};
  const p = repair.reproduction;
  if (p.kind === 'stress') {
    const rec = (records?.stress ?? []).find(s => s.digest === p.record);
    const t = rec?.record?.byTest?.find(x => x.file === p.file && (p.name == null || x.name === p.name));
    if (!t || !(t.rounds?.length >= 1)) return {ok: false, refusals: [{code: 'REPRODUCTION_DOES_NOT_FAIL', what: `REPRODUCTION_DOES_NOT_FAIL: the stress record ${cut(p.record, 30)} shows no failure of ${p.file} ${p.name ?? ''}`}]};
    return {ok: true, refusals: [], run: {kind: 'stress-record', record: p.record, failure_rate: {failed: new Set(t.rounds).size, rounds: rec.record.repeat}}};
  }
  const co = checkoutAt(repo, base, {root: config.checkout_root});
  try {
    if (typeof p.source === 'string') {
      if (fs.existsSync(path.join(co.dir, p.file))) return {ok: false, refusals: [{code: 'REPRODUCTION_SHAPE', what: `the reproduction's source would replace the existing ${p.file}; a new reproduction is a new file`}]};
      fs.mkdirSync(path.dirname(path.join(co.dir, p.file)), {recursive: true});
      fs.writeFileSync(path.join(co.dir, p.file), p.source);
    }
    const run = await runTest(co.dir, {file: p.file, name: p.name ?? null}, {config, hide});
    if (!run.fails) return {ok: false, refusals: [{code: 'REPRODUCTION_DOES_NOT_FAIL', what: `REPRODUCTION_DOES_NOT_FAIL: ${p.file}${p.name ? ` "${p.name}"` : ''} does not fail on the base ${base.slice(0, 12)} (exit ${run.exit}, ${run.failed} failed)`}], run};
    return {ok: true, refusals: [], run};
  } finally { co.done(); }
}

/**
 * VERIFY (decisions 5, 6 and 9): the mechanical half of validate, on the diff base..commit and the runs in a checkout of
 * the commit. Every refusal is named; `ok` only when there is none. `cheatBase` is the tree the anti-cheating checks
 * compare against (the base; for a rollback, the reverted repair's parent). `paths` (a round's claimed paths): the diff
 * must stay inside them. `tolerate` (a rollback only: the reverted repair's parent): a reached test, runner or lint that
 * fails at the commit is tolerated when it fails there too -- a revert returns the line to that state, the reverted
 * defect included, and may make nothing worse than it was; the runs are compared against it instead of the base.
 */
export async function verifyRepair({repo, base, commit, reproduction, paths = null, cheatBase = base, tolerate = null, config = DEFAULT_CONFIG, hide = []}) {
  const refusals = [], runs = [];
  const files = changedFiles(repo, base, commit);
  const ctx = {config, hide};
  if (parentOf(repo, commit) !== base) refusals.push({code: 'ONE_COMMIT', what: `ONE_COMMIT: ${commit.slice(0, 12)} is not one commit on its base ${base.slice(0, 12)}`});
  if (!files.length) refusals.push({code: 'EMPTY_REPAIR', what: 'EMPTY_REPAIR: the repair changes nothing'});
  // Decision 9, the second enforcement: a diff that touches a protected surface is refused.
  for (const f of files) if (isProtected(f.path, config)) refusals.push({code: 'PROTECTED_PATH', file: f.path, what: `PROTECTED_PATH: the repair touches ${f.path}, a protected surface (an outer wheel)`});
  if (Array.isArray(paths) && paths.length) for (const f of files) if (!matchesOwned(f.path, paths)) refusals.push({code: 'OUTSIDE_CLAIMED_PATHS', file: f.path, what: `OUTSIDE_CLAIMED_PATHS: ${f.path} is outside the round's claimed paths`});
  refusals.push(...cheatRefusals(repo, {cheatBase, commit, files}));
  const rep = reproduction ?? null;
  if (rep?.source !== undefined && showAt(repo, commit, rep.file) !== rep.source) refusals.push({code: 'REPRODUCTION_CHANGED', what: `REPRODUCTION_CHANGED: ${rep.file} at the repair is not the reproduction that failed on the base`});
  // The static refusals end it: nothing a refused diff would run is run.
  if (refusals.length) return verdict({repo, base, commit, files, refusals, runs, cheatBase});
  const co = checkoutAt(repo, commit, {root: config.checkout_root});
  let baseCo = null;
  // What a failing run is compared against: the base, or for a rollback the state it returns to.
  const compareAt = tolerate ?? base;
  const atBase = () => (baseCo ??= checkoutAt(repo, compareAt, {root: config.checkout_root}));
  const tolerated = [];
  try {
    // 1. The reproduction passes; a flake: R stress rounds with no failure.
    if (rep?.kind === 'test') {
      const r = await runTest(co.dir, rep, ctx);
      runs.push({check: 'reproduction', ...r});
      if (!r.pass) refusals.push({code: 'REPRODUCTION_STILL_FAILS', what: `REPRODUCTION_STILL_FAILS: ${rep.file}${rep.name ? ` "${rep.name}"` : ''} does not pass at the repair (exit ${r.exit})`});
    } else if (rep?.kind === 'stress') {
      const out = path.join(co.dir, '.self-repair-stress.json');
      const argv = config.commands.stress.map(a => a.replace('{file}', rep.file).replace('{rounds}', String(config.flake_rounds)).replace('{json}', out));
      const r = await runIn(co.dir, argv, ctx);
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { rec = null; }
      const failures = rec ? (rec.byTest ?? []).filter(t => t.file === rep.file).length : null;
      runs.push({check: 'reproduction', kind: 'stress', cmd: r.cmd, exit: r.exit, rounds: config.flake_rounds, failures, verdict: rec?.verdict ?? null});
      if (r.exit !== 0 || failures !== 0) refusals.push({code: 'REPRODUCTION_STILL_FAILS', what: `REPRODUCTION_STILL_FAILS: the stress run of ${config.flake_rounds} round(s) of ${rep.file} did not pass with no failure (exit ${r.exit}, failures ${failures})`});
    } else refusals.push({code: 'REPRODUCTION_MISSING', what: 'REPRODUCTION_MISSING: no reproduction to pass'});
    // 2. T1: every test in the repair's reach passes (the changed test files, and every test importing a changed module).
    const {snapshot, expandModules, reach} = await import('../../scripts/test-gates/reach.mjs');
    const snap = snapshot({root: repo, ref: commit});
    const live = files.filter(f => f.status !== 'D').map(f => f.path);
    const {modules} = expandModules(snap, live.filter(p => /\.(mjs|js|cjs)$/.test(p)));
    const reached = modules.length ? reach(snap, modules) : {tests: []};
    const tests = [...new Set([...live.filter(isTestFile), ...reached.tests.map(t => t.file)])].sort();
    for (const file of tests) {
      const r = await runTest(co.dir, {file}, ctx);
      runs.push({check: 'reach', ...r});
      if (r.exit === 0) continue;
      if (tolerate && (await runTest(atBase().dir, {file}, ctx)).exit !== 0) { tolerated.push({check: 'reach', file, why: `fails at ${tolerate.slice(0, 12)} too: the state the revert returns to`}); continue; }
      refusals.push({code: 'REACH_TEST_FAILED', file, what: `REACH_TEST_FAILED: ${file} (in T1's reach of the repair) exits ${r.exit}`});
    }
    // 3. T2: every runner the diff affects passes IN FULL, and no runner's kill count is lower than at the base.
    const {affected} = await import('../../scripts/test-gates/affected-runners.mjs');
    const aff = affected({root: repo, base, head: commit});
    for (const x of aff.runners) {
      const r = await runIn(co.dir, ['node', x.file], ctx);
      const killed = killsOf(r.stdout);
      const row = {check: 'runner', file: x.file, reasons: x.reasons, cmd: r.cmd, exit: r.exit, killed, ms: r.ms};
      if (r.exit !== 0) {
        const b = await runIn(atBase().dir, ['node', x.file], ctx);
        row.killed_at_base = killsOf(b.stdout);
        row.exit_at_base = b.exit;
        if (tolerate && b.exit !== 0 && killed >= row.killed_at_base) tolerated.push({check: 'runner', file: x.file, why: `exits ${b.exit} at ${tolerate.slice(0, 12)} too`});
        else refusals.push({code: 'RUNNER_FAILED', file: x.file, what: `RUNNER_FAILED: ${x.file} (listed by T2: ${x.reasons.map(y => y?.kind ?? y).join(', ')}) exits ${r.exit} in full`});
        // The kill count is compared whatever the exit: a repair may never leave a runner killing fewer mutations.
        if (killed < row.killed_at_base) refusals.push({code: 'KILL_COUNT_LOWERED', file: x.file, what: `KILL_COUNT_LOWERED: ${x.file} kills ${killed} mutation(s) at the repair, ${row.killed_at_base} at ${compareAt.slice(0, 12)}`});
      }
      runs.push(row);
    }
    // 4. The pentest reports no NEW hole (a hole the base already shows is not new).
    const pen = await runIn(co.dir, [...config.commands.pentest], ctx);
    const holes = newHolesOf(pen.stdout), failing = failingFilesOf(pen.stdout);
    const penRow = {check: 'pentest', cmd: pen.cmd, exit: pen.exit, new_holes: holes, failing_files: failing};
    if (pen.exit !== 0) {
      const b = await runIn(atBase().dir, [...config.commands.pentest], ctx);
      const before = new Set(newHolesOf(b.stdout)), failedBefore = new Set(failingFilesOf(b.stdout));
      penRow.base_exit = b.exit;
      const fresh = holes.filter(h => !before.has(h)), freshFiles = failing.filter(f => !failedBefore.has(f));
      if (fresh.length || freshFiles.length || b.exit === 0) refusals.push({code: 'PENTEST_NEW_HOLE', what: `PENTEST_NEW_HOLE: the pentest at the repair exits ${pen.exit}${fresh.length ? `; new hole(s) ${fresh.join(', ')}` : ''}${freshFiles.length ? `; newly failing ${freshFiles.join(', ')}` : ''} (at ${compareAt.slice(0, 12)}: exit ${b.exit})`});
    }
    runs.push(penRow);
    // 5. The test lint, enforced.
    const lint = await runIn(co.dir, [...config.commands.lint], ctx);
    runs.push({check: 'lint', cmd: lint.cmd, exit: lint.exit, tail: cut(`${lint.stdout}${lint.stderr}`.slice(-600), 600)});
    if (lint.exit !== 0) {
      if (tolerate && (await runIn(atBase().dir, [...config.commands.lint], ctx)).exit !== 0) tolerated.push({check: 'lint', why: `fails at ${tolerate.slice(0, 12)} too`});
      else refusals.push({code: 'LINT_FAILED', what: `LINT_FAILED: ${lint.cmd} exits ${lint.exit}`});
    }
  } finally { co.done(); baseCo?.done(); }
  return verdict({repo, base, commit, files, refusals, runs, cheatBase, tolerated, tolerate});
}
function verdict({base, commit, files, refusals, runs, cheatBase, tolerated = [], tolerate = null}) {
  return clean({schema: VERIFY_SCHEMA, ok: refusals.length === 0, base, commit, cheat_base: cheatBase, files: files.map(f => `${f.status} ${f.path}`), refusals,
    runs: runs.map(r => ({...r, tail: r.tail ? cut(r.tail, 600) : undefined})), ...(tolerate ? {tolerate, tolerated} : {})});
}

// ---- the rollback bisect (decision 8) ---------------------------------------------------------------------------------
/**
 * Which LANDED repair a regression comes from, bounded to the landings on the line (oldest first, each landing's parent
 * the previous landing): the earliest landing at which the test fails while it passes at that landing's parent. Null when
 * the test fails before the first landing (not caused by a landed repair) or passes at the last. `fails(commit)` runs it.
 */
export async function bisectLanded({landings, fails}) {
  if (!landings.length) return {culprit: null, why: 'no repair has landed on the line', runs: []};
  const seq = [landings[0].parent, ...landings.map(l => l.commit)], runs = [];
  const at = async i => { const f = await fails(seq[i]); runs.push({commit: seq[i], fails: f}); return f; };
  if (!(await at(seq.length - 1))) return {culprit: null, why: 'the test passes at the newest landing', runs};
  if (await at(0)) return {culprit: null, why: 'the test already fails before the first landed repair: not caused by one', runs};
  let lo = 0, hi = seq.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await at(mid)) hi = mid; else lo = mid; }
  return {culprit: landings[hi - 1], fails_at: seq[hi], passes_at: seq[lo], runs};
}

// ---- the lane in a tick ---------------------------------------------------------------------------------------------
/** The unsigned candidate for the owner (the graph loop's candidate record shape, graph-loop.mjs): never executed. */
function writeCandidate(stateDir, {defect, why, lane}) {
  const d = path.join(stateDir, 'self-repair', 'candidates'), f = path.join(d, `${digest(defect.id).slice(0, 32)}.json`);
  if (fs.existsSync(f)) return null;
  fs.mkdirSync(d, {recursive: true});
  const body = {schema: CANDIDATE_SCHEMA, classification: 'candidate', state: CANDIDATE_STATE.open, executable: false, ref: `self-repair:${defect.id}`, kind: 'self-repair-defect',
    defect: {id: defect.id, kind: defect.kind, title: defect.title, site: defect.site, evidence: defect.evidence ?? null}, why,
    authority: 'none: a candidate is never executed; the owner adds an item with a signed status entry (node packages/ledger/status.mjs set ...) or declines it',
    lane: {item: LANE_ITEM, entry: lane.entry ?? null}};
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  fs.renameSync(tmp, f);
  return f;
}
/** The defects the lane routed to the owner (work.repair `route`), with why. */
export const routedOf = work => new Map((typeof work?.repairs === 'function' ? work.repairs() : []).filter(e => e.event === 'route').map(e => [e.defect.id, e.why]));
/** The landings on the line, in LEDGER order (rounds may land out of round order), each with its round and kind. */
export function lineLandings(work, line) {
  const rounds = roundsOf(work), by = new Map(rounds.map(r => [r.n, r]));
  return work.repairs().filter(e => e.event === 'land' && e.line === line && by.has(e.round)).map(e => {
    const r = by.get(e.round);
    return {round: r.n, kind: r.open.kind, commit: e.commit, parent: e.parent, defect: r.open.defect.id,
      reverted_by: rounds.find(x => x.open.kind === 'rollback' && x.open.culprit?.round === r.n && x.land)?.n ?? null};
  });
}

// ---- LEARNING: the lane's own history and recurrence (owner, 2026-11-20: "Recursive") ----------------------------------
/**
 * The lane's earlier rounds on a defect: the same defect id, or a site overlapping it, each with how it ended (landed,
 * blocked, failed, or still open), the commit it landed and the rollback that reverted it, if any. A round's Diagnose is
 * handed this (ctx.selfRepair.history, and the planner prompt), so it starts from what was tried before instead of
 * patching blind; the open event records it.
 */
export function laneHistory(rounds, defect) {
  const reverted = new Map(rounds.filter(r => r.open.kind === 'rollback').map(r => [r.open.culprit?.round, {round: r.n, outcome: r.close?.outcome ?? 'open'}]));
  return rounds.filter(r => r.open.kind === 'repair' && (r.open.defect?.id === defect.id || (r.open.defect?.site ?? []).some(a => (defect.site ?? []).some(b => pathsOverlap(a, b)))))
    .map(r => ({round: r.n, defect: r.open.defect.id, same_defect: r.open.defect.id === defect.id, outcome: r.close?.outcome ?? 'open', why: r.close?.why ? cut(r.close.why, 200) : null,
      landed: r.land?.commit ?? null, reverted_by: reverted.get(r.n) ?? null}));
}
/**
 * RECURRENCE: the defect is back after a repair of it LANDED, or it has failed to be repaired twice or more. Patching it
 * once more treats the instance, not the mechanism. The lane still repairs the instance, and routes the owner a LESSON
 * candidate: a lessons class with a mechanical detector is needed. It never writes the lessons registry (an outer wheel).
 */
export function recurrenceOf(history) {
  const same = history.filter(h => h.same_defect);
  const returned = same.filter(h => h.landed), failed = same.filter(h => h.outcome === 'blocked' || h.outcome === 'failed');
  if (returned.length) return {kind: 'returned', rounds: returned.map(h => h.round), why: `repaired in round(s) ${returned.map(h => h.round).join(', ')} (landed ${returned.map(h => h.landed.slice(0, 12)).join(', ')}) and back again`};
  if (failed.length >= 2) return {kind: 'unrepaired', rounds: failed.map(h => h.round), why: `not repaired in ${failed.length} earlier rounds (${failed.map(h => `r${h.round} ${h.outcome}`).join(', ')})`};
  return null;
}
/** The owner's lesson candidate for a recurring defect (never executed; one per defect and set of rounds). */
export function writeLessonCandidate(stateDir, {defect, recurrence, lane}) {
  const d = path.join(stateDir, 'self-repair', 'candidates'), f = path.join(d, `lesson-${digest(`${defect.id}|${recurrence.rounds.join(',')}`).slice(0, 32)}.json`);
  if (fs.existsSync(f)) return null;
  writeJsonAtomic(f, {schema: CANDIDATE_SCHEMA, classification: 'candidate', state: CANDIDATE_STATE.open, executable: false, ref: `self-repair-lesson:${defect.id}`, kind: 'self-repair-lesson',
    defect: {id: defect.id, kind: defect.kind, title: defect.title, site: defect.site}, recurrence,
    why: `RECURRING: ${recurrence.why}. Repairing the instance again treats the symptom; the mechanism needs a lessons class with a mechanical detector (ophanim/lessons/corrections.json), which only the owner or the coordinator writes.`,
    authority: 'none: a candidate is never executed; the lessons registry is an outer wheel the lane never edits',
    lane: {item: LANE_ITEM, entry: lane?.entry ?? null}});
  return f;
}

// ---- THE RECURSIVE LOOP: self-inspection (owner, 2026-11-20) ---------------------------------------------------------
// "If it needs repairs it fixes itself; if not, it does a recursive loop ... in parallel with the ticket." When Detect
// finds nothing to select and no round is open, the idle lane inspects itself: a whole gate run, a stress run of the
// test files changed since the last inspection, and the pentest, on a clean checkout of the line head, in a background
// process beside the tickets (self-repair-inspect.mjs). Each writes a record naming that commit, so the NEXT round's
// Detect sees whatever they found and repairs it. It runs the outer wheels and never edits them. A commit is inspected
// once COMPLETELY: a new inspection starts when the line moves (inspecting identical code again adds nothing), and one
// runs at a time. Its state is under <stateDir>/self-repair/inspection/ (git-ignored): running.json while one runs,
// last.json after each attempt, complete.json after the last COMPLETE one.
//
// COMPLETE is derived, never taken from a flag: every required step (the gate run; the stress run unless it was
// skipped for a stated reason; the pentest) finished on its own (an exit code, not killed) and left a report of its kind
// in the records directory, naming the inspected commit (inspectionCompleteness). A gate run whose tests FAIL is
// complete: its findings are the point. An attempt that is not complete (a tool that wrote no report, a timeout, a
// checkout that failed, an inspector that died) is retried when due (config.inspect.retry), and the comparison base of
// the stress run stays the last COMPLETE commit. A last.json written before this rule (no attempt field) is judged by
// the same evidence: what it cannot establish is incomplete, so that commit is inspected again.
export const INSPECTION_SCHEMA = 'ophanim.self-repair.inspection/v1';
export const inspectionDirOf = state => path.join(state, 'self-repair', 'inspection');
const readJsonOr = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export const writeJsonAtomic = (f, v) => {
  fs.mkdirSync(path.dirname(f), {recursive: true});
  const t = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(t, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(t, f);
};
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export const inspectionState = state => ({running: readJsonOr(path.join(inspectionDirOf(state), 'running.json')), last: readJsonOr(path.join(inspectionDirOf(state), 'last.json')),
  complete: readJsonOr(path.join(inspectionDirOf(state), 'complete.json'))});
const REPORT_VERDICTS = Object.freeze(['PASS', 'FAIL', 'UNVERIFIED']);
// The exit codes the tools give each verdict (scripts/test-gates/check.mjs: PASS 0, FAIL 1, UNVERIFIED 2, or 0 when
// unverified is allowed; stress.mjs: PASS 0, FAIL 1, otherwise 2). A report whose verdict the exit contradicts is not
// the tool's finished answer.
const VERDICT_EXITS = Object.freeze({gate: {PASS: [0], FAIL: [1], UNVERIFIED: [2, 0]}, stress: {PASS: [0], FAIL: [1], UNVERIFIED: [2]}});
const isRow = r => r !== null && typeof r === 'object' && !Array.isArray(r);
const isTexts = v => v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string'));
/**
 * Why a report body is not a finished report of its kind, or null. With `exit` (the tool's exit code), the verdict must
 * be the one that exit gives. A gate report has at least one usable suite row (a suite name, a verdict, notes and
 * problems as lists of text) and no row that is not; a stress report's byTest rows name a file and their rounds.
 */
export function reportRefusal(kind, body, exit = null) {
  const exitBad = () => (exit !== null && !(VERDICT_EXITS[kind][body.verdict] ?? []).includes(exit) ? `the ${body.verdict} report came with exit ${exit}` : null);
  if (kind === 'gate') {
    if (body?.schema !== 'ophanim.test-gate/v2' || !REPORT_VERDICTS.includes(body.verdict) || !Array.isArray(body.results)) return 'not a finished test-gate/v2 report (schema, verdict, results)';
    if (!body.results.length) return 'the gate report has no suite results';
    const bad = body.results.findIndex(r => !isRow(r) || typeof r.suite !== 'string' || !r.suite || !REPORT_VERDICTS.includes(r.verdict) || !isTexts(r.notes) || !isTexts(r.problems));
    if (bad >= 0) return `the gate report's results[${bad}] is not a usable suite row`;
    if (body.results.every(r => r.suite === '(none)')) return 'the gate report ran no suite';
    if (body.verdict === 'PASS' && body.results.some(r => r.verdict !== 'PASS')) return 'the gate report says PASS over a suite that did not pass';
    if (body.verdict !== 'FAIL' && body.results.some(r => r.verdict === 'FAIL')) return `the gate report says ${body.verdict} over a failing suite`;
    return exitBad();
  }
  if (kind === 'stress') {
    if (body?.schema !== 'ophanim.toolkit.stress/v1' || !REPORT_VERDICTS.includes(body.verdict) || !Array.isArray(body.byTest)) return 'not a finished toolkit.stress/v1 report (schema, verdict, byTest)';
    if (!Number.isInteger(body.repeat) || body.repeat < 1) return 'the stress report names no round count';
    const bad = body.byTest.findIndex(t => !isRow(t) || typeof t.file !== 'string' || !t.file || !Array.isArray(t.rounds) || !t.rounds.every(n => Number.isInteger(n)));
    if (bad >= 0) return `the stress report's byTest[${bad}] is not a usable row`;
    return exitBad();
  }
  if (kind === 'pentest') {
    const text = typeof body?.report === 'string' ? body.report : '';
    if (!text.includes('--- summary ---')) return 'the pentest report has no summary';
    const end = /\n(OK|FAIL): [^\n]*\s*$/.exec(text)?.[1] ?? null;
    if (!end) return 'the pentest report has no final OK or FAIL line';
    if (exit !== null && (end === 'OK') !== (exit === 0)) return `the pentest report ends ${end} but the run exited ${exit}`;
    return null;
  }
  return `no report kind ${kind}`;
}
const STEP_KIND = Object.freeze({gates: 'gate', stress: 'stress', pentest: 'pentest'});
/**
 * Was an inspection attempt (a last.json or complete.json body) COMPLETE, by its evidence? {complete, why: [...]}.
 * Each required step: an exit code, not killed, and a report of its kind in `records` naming the attempt's commit; the
 * stress step may instead be skipped. Anything else (a missing step, an error, an unreadable report) is incomplete.
 */
export function inspectionCompleteness(attempt, records) {
  if (!attempt || typeof attempt !== 'object') return {complete: false, why: ['no inspection attempt is recorded']};
  if (!SHA.test(attempt.commit ?? '')) return {complete: false, why: ['the attempt names no full commit']};
  const steps = Array.isArray(attempt.steps) ? attempt.steps : [], why = [];
  for (const s of steps) if (s?.name === 'inspection' && s.error) why.push(`the inspection stopped: ${cut(s.error, 200)}`);
  for (const [name, kind] of Object.entries(STEP_KIND)) {
    const at = steps.filter(s => s?.name === name);
    if (at.length !== 1) { why.push(at.length ? `${name}: recorded ${at.length} times` : `${name}: no result`); continue; }
    const s = at[0];
    if (name === 'stress' && typeof s.skipped === 'string' && s.skipped) continue;
    if (s.error) { why.push(`${name}: ${cut(s.error, 200)}`); continue; }
    if (!Number.isInteger(s.exit) || s.killed) { why.push(`${name}: the run did not finish on its own (exit ${s.exit ?? 'none'}${s.killed ? `, killed: ${s.killed}` : ''})`); continue; }
    if (typeof s.record !== 'string' || !s.record || !records) { why.push(`${name}: no report is named`); continue; }
    const f = path.resolve(records, s.record);
    if (path.relative(path.resolve(records), f).startsWith('..')) { why.push(`${name}: the report is outside the records`); continue; }
    const r = readJsonOr(f);
    if (r?.schema !== RECORD_SCHEMA || r.kind !== kind || r.commit !== attempt.commit) { why.push(`${name}: the report ${s.record} is absent or is not a ${kind} record of ${attempt.commit.slice(0, 12)}`); continue; }
    const bad = reportRefusal(kind, r.record, s.exit);
    if (bad) why.push(`${name}: ${bad}`);
  }
  return {complete: why.length === 0, why};
}
/** The delay before attempt `n + 1` of an incomplete inspection. */
export const inspectionRetryMs = (n, retry = DEFAULT_CONFIG.inspect.retry) => Math.min(retry.max_ms, retry.first_ms * 2 ** Math.max(0, n - 1));
const INSPECTOR = path.join(path.dirname(new URL(import.meta.url).pathname), 'self-repair-inspect.mjs');
/** The inspector's argv after node: the script, its plan and the attempt's token (the identity witness, #100). */
export const inspectorArgv = (planFile, token) => [INSPECTOR, '--plan', planFile, '--token', token];
/** How long an attempt can legitimately run: its three bounded steps, plus ten minutes of grace. */
export const attemptEnvelopeMs = (inspect = DEFAULT_CONFIG.inspect) => 3 * (inspect?.timeout_ms ?? DEFAULT_CONFIG.inspect.timeout_ms) + 10 * 60_000;
/**
 * WHO HOLDS THE PID (#100). A live pid alone is not the recorded inspector: pids are reused. On Linux the process's own
 * argv is read from /proc and must carry the inspector, its plan and the attempt's token. Returns {identity, why}:
 *   verified    the recorded inspector, still running
 *   mismatch    a live process that is not it (pid reuse, or the record names an unrelated process)
 *   dead        no such process (its /proc entry is absent)
 *   unreadable  the process exists but its argv cannot be read: the evidence is unavailable, not negative --
 *               trusted within the attempt envelope, with the read error as its reason
 *   unverified  live, but the identity cannot be read (no token: a record from before this rule; or no process
 *               table, as on macOS and Windows) -- trusted only within the attempt envelope
 *   expired     unverified and older than the envelope (or with no start time to bound it)
 * Nothing is signalled: the process table is read, and only where there is none is kill(pid, 0) asked.
 */
export function inspectorIdentity(running, {state, inspect, now, procfs = '/proc'}) {
  const pid = running?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return {identity: 'dead', why: 'the record names no process'};
  const envelope = () => {
    const started = Date.parse(running.started_at ?? '');
    return Number.isFinite(started) && Date.parse(now) - started <= attemptEnvelopeMs(inspect);
  };
  if (fs.existsSync(procfs)) {
    // DEAD only when the process entry is absent; a read that fails while it exists is unavailable evidence.
    if (!fs.existsSync(path.join(procfs, String(pid)))) return {identity: 'dead', why: `no process ${pid}`};
    let raw;
    try { raw = fs.readFileSync(path.join(procfs, String(pid), 'cmdline')); }
    catch (e) {
      return envelope() ? {identity: 'unreadable', why: `the argv of process ${pid} cannot be read (${e?.code ?? 'error'}); trusted within the attempt envelope`}
        : {identity: 'expired', why: `the argv of process ${pid} cannot be read (${e?.code ?? 'error'}) and the attempt is older than its envelope`};
    }
    if (typeof running.token !== 'string') {
      return envelope() ? {identity: 'unverified', why: 'the record has no identity token (written before the identity rule); trusted within the attempt envelope'}
        : {identity: 'expired', why: 'a record with no identity token, older than the attempt envelope'};
    }
    // Compared as BYTES: the argv the kernel holds against the expected argv encoded as UTF-8 (no decoding can make or
    // hide a difference, so a non-ASCII path such as a state directory état-λ compares exactly).
    const argv = [];
    for (let i = 0, j; i < raw.length; i = j + 1) { j = raw.indexOf(0, i); if (j < 0) j = raw.length; argv.push(raw.subarray(i, j)); }
    const want = inspectorArgv(path.join(inspectionDirOf(state), 'plan.json'), running.token).map(w => Buffer.from(w, 'utf8'));
    const at = argv.findIndex((a, i) => i > 0 && a.equals(want[0]));
    const ok = at > 0 && want.every((w, i) => argv[at + i]?.equals(w));
    return ok ? {identity: 'verified', why: 'the process argv carries the inspector, its plan and the attempt token'}
      : {identity: 'mismatch', why: `process ${pid} is not this attempt's inspector (its argv does not carry the recorded token)`};
  }
  if (!alive(pid)) return {identity: 'dead', why: `no process ${pid}`};
  return envelope() ? {identity: 'unverified', why: 'the process table cannot be read here (no /proc): a live pid is trusted within the attempt envelope'}
    : {identity: 'expired', why: 'the process table cannot be read here and the attempt is older than its envelope'};
}
/** Start the inspector as a detached background process (its output in inspection.log); returns its pid. */
export function spawnInspection(plan, {state}) {
  const d = inspectionDirOf(state);
  fs.mkdirSync(d, {recursive: true});
  const planFile = path.join(d, 'plan.json');
  writeJsonAtomic(planFile, plan);
  const fd = fs.openSync(path.join(d, 'inspection.log'), 'a');
  try {
    const child = spawn(process.execPath, inspectorArgv(planFile, plan.token), {cwd: plan.repo, detached: true, stdio: ['ignore', fd, fd], env: process.env});
    child.unref();
    return child.pid;
  } finally { fs.closeSync(fd); }
}
/**
 * An inspector that is gone without its result (running.json names a dead pid): its attempt is recorded in last.json as
 * interrupted (incomplete), unless it did write that attempt's result, and running.json is removed. Returns what it did.
 */
function recoverInspection(state, running, last, at, id = null) {
  const d = inspectionDirOf(state);
  // The attempt's own result is written when last.json carries its token (or, for a record without one, the same
  // commit and start): a very fast finish then leaves a stale running.json behind, never an interrupted result.
  const finished = typeof running.token === 'string' ? last?.token === running.token : last?.commit === running.commit && last?.started_at === running.started_at;
  const out = {pid: running.pid ?? null, commit: running.commit ?? null, started_at: running.started_at ?? null, result: finished ? 'its result was written' : 'interrupted',
    ...(id ? {identity: id.identity, why: id.why} : {})};
  let wrote = last;
  if (!finished && SHA.test(running.commit ?? '')) {
    wrote = {schema: INSPECTION_SCHEMA, commit: running.commit, since: running.since ?? null, attempt: Number.isInteger(running.attempt) ? running.attempt : 1, ...(typeof running.token === 'string' ? {token: running.token} : {}), started_at: running.started_at ?? null,
      finished_at: null, recovered_at: at, steps: [{name: 'inspection', error: id && id.identity !== 'dead' ? `interrupted: ${id.why}` : `interrupted: the inspector (pid ${running.pid ?? 'unknown'}) ended without writing its result`}]};
    wrote.complete = false; wrote.incomplete = inspectionCompleteness(wrote, null).why;
    writeJsonAtomic(path.join(d, 'last.json'), wrote);
  }
  fs.rmSync(path.join(d, 'running.json'), {force: true});
  return {recovered: out, last: wrote};
}
/**
 * The idle lane's decision: running, already inspected (completely), waiting to retry an incomplete attempt, skipped
 * (nothing to inspect with), started or retrying. Never throws.
 */
export function inspectIdle({repo, state, head, config = DEFAULT_CONFIG, records, start = spawnInspection, at = () => new Date().toISOString(), procfs = '/proc'}) {
  try {
    const now = at();
    let {running, last, complete} = inspectionState(state), recovered = null;
    // ONE AT A TIME: the recorded inspector, while it runs (verified, or unverifiable within its envelope), is never
    // started beside. Any other process in the record is not it: the attempt is recovered (nothing is signalled).
    const id = running ? inspectorIdentity(running, {state, inspect: config.inspect, now, procfs}) : null;
    if (running && ['verified', 'unverified', 'unreadable'].includes(id.identity)) return {state: 'running', commit: running.commit, pid: running.pid, started_at: running.started_at, identity: id.identity, identity_why: id.why};
    if (running) ({recovered, last} = recoverInspection(state, running, last, now, id));
    const judged = [complete, last].filter(x => x?.commit).map(x => ({x, c: inspectionCompleteness(x, records)}));
    const done = judged.find(j => j.x.commit === head && j.c.complete);
    if (done) return {state: 'already-inspected', commit: head, finished_at: done.x.finished_at, why: 'this commit was inspected completely; a new inspection starts when the line moves', ...(recovered ? {recovered} : {})};
    if (!config.inspect) return {state: 'skipped', commit: head, why: 'no inspection is configured'};
    if (showAt(repo, head, 'scripts/test-gates/check.mjs') === null) return {state: 'skipped', commit: head, why: 'the commit has no scripts/test-gates/check.mjs to inspect it with'};
    // AN INCOMPLETE ATTEMPT OF THIS HEAD is retried when due.
    const prior = last?.commit === head ? judged.find(j => j.x === last) : null;
    const attempts = prior ? (Number.isInteger(last.attempt) ? last.attempt : 1) : 0;
    if (prior) {
      const ended = Date.parse(last.finished_at ?? last.recovered_at ?? '') || 0;
      const due = new Date(ended + inspectionRetryMs(attempts, config.inspect.retry ?? DEFAULT_CONFIG.inspect.retry)).toISOString();
      if (Date.parse(now) < Date.parse(due)) return {state: 'retry-wait', commit: head, attempt: attempts, next_at: due, incomplete: prior.c.why, ...(recovered ? {recovered} : {})};
    }
    // THE COMPARISON BASE is the last COMPLETE inspection of another commit.
    const base = judged.find(j => j.x.commit !== head && j.c.complete)?.x.commit ?? null;
    const plan = {schema: INSPECTION_SCHEMA, repo, commit: head, since: base, attempt: attempts + 1, token: randomUUID(), records, state, inspect: config.inspect, at: now};
    const runningFile = path.join(inspectionDirOf(state), 'running.json');
    const record = pid => ({schema: INSPECTION_SCHEMA, commit: head, pid, token: plan.token, started_at: plan.at, since: plan.since, attempt: plan.attempt});
    // Recorded before the launch (no pid yet), then with its pid -- unless the inspector already finished: its result
    // names the token, and a running.json written after it would be stale.
    writeJsonAtomic(runningFile, record(null));
    const pid = start(plan, {state});
    if (inspectionState(state).last?.token !== plan.token) writeJsonAtomic(runningFile, record(pid));
    return {state: prior ? 'retrying' : 'started', commit: head, pid, since: plan.since, attempt: plan.attempt, token: plan.token, ...(prior ? {incomplete: prior.c.why} : {}), ...(recovered ? {recovered} : {})};
  } catch (e) { return {state: 'failed', commit: head, why: cut(e.message, 300)}; }
}

/**
 * The lane, for one tick (scheduler.mjs). `begin()` settles what an earlier tick left (a passed outcome not yet landed),
 * runs Detect, routes and opens at most ONE new round (a rollback round runs to its end here); the scheduler then runs
 * the rounds' stages with `wrap` and `claimPaths`; `end()` lands every round whose outcome passed and closes the rounds
 * that ended. Dormant (nothing read beyond the board, nothing recorded) unless the switch is on.
 */
export function createLane({repo, statusRoot, workRoot, work, board = null, config: given = null, stateDir = null, clock = () => Date.now(), records = null, register = REGISTER, startInspection = spawnInspection}) {
  const config = given ?? DEFAULT_CONFIG;
  const state = stateDir ?? path.join(path.dirname(workRoot), 'operate');
  const recordsDir = records ?? recordsDirOf(state);
  const hide = [workRoot, state];
  const at = () => new Date(clock()).toISOString();
  const recordEvent = x => work.recordRepair(clean(x));
  const log = {state: 'dormant', opened: null, landed: [], closed: [], routed: [], revalidated: [], rollback: null, refused: [], lessons: []};
  let sw = null;
  const readBoard = () => board ?? openStatusLedger({root: statusRoot, create: false}).board();
  const rounds = () => roundsOf(work);
  const roundBy = item => rounds().find(r => r.item === item) ?? null;
  const lineHead = () => revOf(repo, config.line);
  const ensureLine = () => {
    const h = lineHead();
    if (h) return h;
    const start = revOf(repo, config.base_ref);
    if (!start) fail(`the base ref ${config.base_ref} does not name a commit: the line cannot start`, 'NO_BASE');
    git(repo, ['update-ref', config.line, start, '0'.repeat(start.length)]);
    return start;
  };
  const route = (defect, why) => {
    const done = work.repairs().some(e => e.event === 'route' && e.defect?.id === defect.id);
    if (done) return;
    const file = writeCandidate(state, {defect, why, lane: sw});
    recordEvent({event: 'route', round: null, defect: {id: defect.id, kind: defect.kind, title: cut(defect.title, 200), site: defect.site}, route: 'owner', why: cut(why, 400),
      candidate: file ? path.relative(state, file) : null, at: at()});
    log.routed.push({id: defect.id, why: cut(why, 200)});
  };
  // The landing of one round (decision 7; the amendment's re-validation when its base moved).
  async function land(r) {
    const st = work.stages(r.item);
    const out = [...st].reverse().find(s => s.stage === 'outcome' && s.status === 'passed');
    const val = out ? st.find(s => s.hash === out.handoff?.from) : null;
    const v = val?.outputs?.self_repair;
    if (!out || !val || !v?.ok || v.commit !== val.outputs.commit) {
      log.refused.push({round: r.n, code: 'NOT_VERIFIED', why: 'the outcome passed without a passing mechanical verification of its commit: not landed'});
      return closeRound(r, 'blocked', 'NOT_VERIFIED: the outcome passed without the lane\'s passing verification of its commit; nothing landed');
    }
    const commit = val.outputs.commit, head = lineHead();
    if (!head) return closeRound(r, 'blocked', `the line ${config.line} is gone: nothing landed`);
    let landing = commit;
    if (parentOf(repo, commit) !== head) {
      // THE BASE MOVED (another round landed first): the same patch onto the new head, re-validated there, before it lands.
      const plan = [...st].reverse().find(s => s.stage === 'plan' && s.status === 'passed')?.outputs?.plan;
      const rebased = applyPatchOnto(repo, {commit, onto: head, message: git(repo, ['log', '-1', '--format=%B', commit]).trim() + `\n\nSelf-repair round ${r.n}: re-applied on the moved line head ${head}.\n`});
      const same = rebased && patchIdOf(repo, rebased) === patchIdOf(repo, commit);
      const verification = same ? await verifyRepair({repo, base: head, commit: rebased, reproduction: plan?.repair?.reproduction ?? r.open.defect.reproduction, paths: roundPaths(r, st), config, hide})
        : {ok: false, refusals: [{code: 'REBASE_CONFLICT', what: rebased ? 'REBASE_CONFLICT: re-applied on the new head, the change is not the reviewed patch' : 'REBASE_CONFLICT: the reviewed patch does not apply on the new line head'}]};
      recordEvent({event: 'revalidate', round: r.n, from: commit, commit: rebased ?? commit, parent: head, ok: verification.ok,
        refusals: (verification.refusals ?? []).map(x => ({code: x.code, what: cut(x.what, 300)})), verification: verification.ok ? {schema: VERIFY_SCHEMA, runs: verification.runs.length} : null, at: at()});
      log.revalidated.push({round: r.n, from: commit, commit: rebased, ok: verification.ok});
      if (!verification.ok) return closeRound(r, 'blocked', `the base moved and the re-validation on the new head ${head.slice(0, 12)} refused it: ${verification.refusals.map(x => x.code).join(', ')}`);
      landing = rebased;
    }
    return landOn(r, {commit: landing, parent: head});
  }
  function landOn(r, {commit, parent, ref = config.line}) {
    const why = landingRefusal({ref, config});
    if (why) fail(why, 'LANDING_REF');
    if (parentOf(repo, commit) !== parent) fail(`LANDING_NOT_FAST_FORWARD: ${commit.slice(0, 12)} is not one commit on the line head ${parent.slice(0, 12)}`, 'LANDING_REFUSED');
    // The ledger first (it refuses a landing that is not a fast-forward of the line, or a moved base without re-validation),
    // then the ref, compare-and-swap on the head it was checked against.
    const rec = recordEvent({event: 'land', round: r.n, line: ref, commit, parent, revert: revertOf(commit), at: at()});
    git(repo, ['update-ref', ref, commit, parent]);
    log.landed.push({round: r.n, commit, parent, revert: revertOf(commit), record: rec});
    return closeRound(r, 'landed', `landed ${commit.slice(0, 12)} on ${ref} (parent ${parent.slice(0, 12)}); revert: ${revertOf(commit)}`);
  }
  function closeRound(r, outcome, why, extra = {}) {
    recordEvent({event: 'close', round: r.n, outcome, why: cut(why, 600), ...extra, at: at()});
    log.closed.push({round: r.n, outcome, why: cut(why, 200)});
    return outcome;
  }
  // A rollback round, run to its end here: the revert, the same mechanical validate, the landing, the owner routing.
  async function rollback(culprit, defect, bis) {
    const head = lineHead();
    const n = 1 + Math.max(0, ...rounds().map(x => x.n));
    const revert = applyPatchOnto(repo, {commit: culprit.commit, onto: head, reverse: true, message: `Revert self-repair round ${culprit.round} (${culprit.commit})\n\nSelf-repair rollback round ${n}: ${defect.id} fails at ${culprit.commit} and passes at its parent ${culprit.parent}.\n`});
    const files = revert ? changedFiles(repo, head, revert).map(f => f.path) : [];
    recordEvent({event: 'open', round: n, kind: 'rollback', defect: {id: defect.id, kind: defect.kind, title: cut(`rollback of round ${culprit.round}: ${defect.title}`, 200), site: defect.site, reproduction: defect.reproduction},
      culprit: {round: culprit.round, commit: culprit.commit, parent: culprit.parent, defect: culprit.defect}, evidence: {bisect: bis.runs, fails_at: bis.fails_at, passes_at: bis.passes_at, regression: defect.evidence ?? null},
      paths: files, base: head, line: config.line, lane_entry: sw.entry, queue: [], skipped: [], at: at()});
    const r = roundsOf(work).find(x => x.n === n);
    log.rollback = {round: n, culprit: culprit.round, commit: culprit.commit};
    // A rollback that cannot land leaves a regression a landed repair caused: that is the owner's, and it is not retried.
    if (!revert) { route(defect, `rollback round ${n}: the revert of round ${culprit.round} (${culprit.commit.slice(0, 12)}) does not apply on the line head`); return closeRound(r, 'blocked', 'the revert of the landed repair does not apply on the line head'); }
    const v = await verifyRepair({repo, base: head, commit: revert, reproduction: defect.reproduction, cheatBase: culprit.parent, tolerate: culprit.parent, config, hide});
    recordEvent({event: 'revalidate', round: n, from: revert, commit: revert, parent: head, ok: v.ok, refusals: v.refusals.map(x => ({code: x.code, what: cut(x.what, 300)})), verification: v.ok ? {schema: VERIFY_SCHEMA, runs: v.runs.length} : null, at: at()});
    if (!v.ok) { route(defect, `rollback round ${n} of round ${culprit.round} did not verify: ${v.refusals.map(x => x.code).join(', ')}`); return closeRound(r, 'failed', `the rollback did not verify: ${v.refusals.map(x => x.code).join(', ')}`); }
    const landed = landOn(r, {commit: revert, parent: head});
    // Decision 8: the reverted defect is routed to the owner (never selected again).
    route({id: culprit.defect, kind: 'reverted', title: `reverted by rollback round ${n}: ${culprit.defect}`, site: defect.site}, `rollback round ${n} reverted round ${culprit.round} (${culprit.commit.slice(0, 12)}): ${defect.id} fails there and passes at its parent`);
    return landed;
  }
  const bisectCache = path.join(state, 'self-repair', 'bisect');
  async function culpritOf(defect, landings) {
    const live = landings.filter(l => l.kind === 'repair' && !l.reverted_by);
    if (!live.length || defect.reproduction?.kind !== 'test') return null;
    const key = digest({defect: defect.id, landings: landings.map(l => l.commit)});
    const f = path.join(bisectCache, `${key.slice(0, 32)}.json`);
    let bis = null;
    try { bis = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { bis = null; }
    if (!bis) {
      bis = await bisectLanded({landings, fails: async c => { const co = checkoutAt(repo, c, {root: config.checkout_root}); try { return !(await runTest(co.dir, defect.reproduction, {config, hide})).pass; } finally { co.done(); } }});
      fs.mkdirSync(bisectCache, {recursive: true});
      fs.writeFileSync(f, JSON.stringify(bis) + '\n');
    }
    // A culprit whose rollback already ended without landing is the owner's (routed then): it is not rolled back again.
    const tried = rounds().some(x => x.open.kind === 'rollback' && x.open.culprit?.round === bis.culprit?.round && x.close && x.close.outcome !== 'landed');
    return bis.culprit && bis.culprit.kind === 'repair' && !bis.culprit.reverted_by && !tried ? bis : null;
  }
  return {
    config, log,
    get on() { return Boolean(sw?.on); },
    /**
     * SYNCHRONOUS while dormant: the switch is read and, when it is off, null is returned and the caller awaits nothing,
     * so a dormant lane adds no turn of the event loop to a tick (the bookkeeping before its first await is as before).
     * While the switch is on, the promise of the round's opening.
     */
    begin() {
      sw = laneSwitch(readBoard());
      if (!sw.on) { log.state = 'dormant'; log.why = sw.why; log.present = sw.present; return null; }
      log.state = 'active';
      return this.open();
    },
    async open() {
      // What an earlier tick left: a round whose outcome passed and that has not landed.
      for (const r of rounds().filter(x => !x.close && x.open.kind === 'repair')) if (work.stages(r.item).some(s => s.stage === 'outcome' && s.status === 'passed')) await land(r);
      const head = lineHead() ?? revOf(repo, config.base_ref);
      if (!head) { log.refused.push({code: 'NO_BASE', why: `neither ${config.line} nor ${config.base_ref} names a commit`}); return log; }
      const recs = readRecords(recordsDir);
      const det = detect({repo, commit: head, records: recs, register});
      log.detect = {commit: head, defects: det.defects.length, ignored: det.ignored, digest: det.digest};
      // ROLLBACK first: a regression at the line's head that a landed repair caused.
      const landings = lineLandings(work, config.line);
      for (const d of det.defects.filter(x => x.kind === 'regression')) {
        const bis = lineHead() ? await culpritOf(d, landings) : null;
        if (bis) { await rollback(bis.culprit, d, bis); return log; }
      }
      const b = readBoard();
      const sel = select({defects: det.defects, rounds: rounds(), board: b, config, stagesOf: i => work.stages(i), routed: routedOf(work), after: (a, c) => isAncestor(repo, a, c)});
      for (const s of sel.skipped.filter(x => x.route === 'owner')) route(det.defects.find(d => d.id === s.id), s.why);
      log.selection = {selected: sel.selected?.id ?? null, queue: sel.queue.length, skipped: sel.skipped.length};
      if (!sel.selected) {
        // THE RECURSIVE LOOP: nothing needs repair and no round is open, so the idle lane inspects itself (inspectIdle).
        // While a round is open the lane is repairing, not idle.
        if (!rounds().some(r => !r.close)) log.inspection = inspectIdle({repo, state, head, config, records: recordsDir, start: startInspection, at});
        return log;
      }
      const d = sel.selected, base = ensureLine();
      const n = 1 + Math.max(0, ...rounds().map(x => x.n));
      // LEARNING: what the lane tried before on this defect or its files, and whether it is recurring (a lesson candidate).
      const history = laneHistory(rounds(), d), recurrence = recurrenceOf(history);
      if (recurrence) { const c = writeLessonCandidate(state, {defect: d, recurrence, lane: sw}); log.lessons.push({defect: d.id, ...recurrence, candidate: c ? path.relative(state, c) : null}); }
      const ev = recordEvent({event: 'open', round: n, kind: 'repair', defect: {id: d.id, kind: d.kind, title: cut(d.title, 200), site: d.site, reproduction: d.reproduction ?? null},
        evidence: {detect: det.digest, commit: head, defect: d.evidence ?? null, ignored: det.ignored.slice(0, 20)}, history: history.slice(-20), recurrence, paths: d.site, base, line: config.line, lane_entry: sw.entry,
        queue: sel.queue.slice(0, 200).map(q => q.id), skipped: sel.skipped.slice(0, 200).map(s => ({id: s.id, route: s.route, why: cut(s.why, 200)})), at: at()});
      log.opened = {round: n, item: roundId(n), defect: d.id, base, record: ev};
      return log;
    },
    /** The round's context for its stages (ctx.selfRepair): its defect, base, line and claimed paths. */
    ctxOf(item) {
      const r = roundBy(item);
      return r ? {round: r.n, item: r.item, kind: r.open.kind, defect: r.open.defect, base: r.open.base, line: r.open.line, paths: roundPaths(r, work.stages(item)), lane_entry: r.open.lane_entry,
        history: r.open.history ?? [], recurrence: r.open.recurrence ?? null} : null;
    },
    claimPaths(item) { const r = roundBy(item); return r ? roundPaths(r, work.stages(item)) : null; },
    /** The stage executor of a round: the plan's reproduction check (decision 4) and validate's mechanical checks (5, 6, 9). */
    wrap(stage, exec) {
      if (typeof exec !== 'function') return exec;
      if (stage === 'plan') {
        return Object.assign(async ctx => {
          const res = await exec(ctx);
          if (res?.status !== 'passed') return res;
          const r = roundBy(ctx.item);
          const check = await reproductionRefusal({repo, base: r.open.base, repair: res.outputs?.plan?.repair, defect: r.open.defect, records: readRecords(recordsDir), config, hide});
          if (check.ok) return {...res, outputs: {...res.outputs, self_repair: clean({accepted: true, reproduction: check.run ? {kind: check.run.kind, exit: check.run.exit ?? null, failed: check.run.failed ?? null, failure_rate: check.run.failure_rate ?? null} : null})}};
          const why = `REPRODUCTION_REFUSED: ${check.refusals.map(x => x.what).join('; ')}`;
          return {...res, status: 'failed', blocker: undefined, outputs: {...res.outputs, self_repair: clean({accepted: false, refusals: check.refusals})}, next: {stage: 'plan', why: cut(why, 300)}};
        }, {capacity: exec.capacity});
      }
      if (stage === 'validate') {
        return Object.assign(async ctx => {
          const r = roundBy(ctx.item), st = work.stages(ctx.item);
          const impl = st.find(s => s.hash === ctx.upstream?.handoff?.from);
          const plan = impl ? st.find(s => s.hash === impl.handoff?.from) : null;
          const commit = impl?.outputs?.commit, base = impl?.outputs?.base;
          let v;
          if (!commit || base !== r.open.base) v = {ok: false, refusals: [{code: 'WRONG_BASE', what: `WRONG_BASE: the repair was made on ${String(base).slice(0, 12)}, not the round's base ${r.open.base.slice(0, 12)} (the line head when it opened)`}], runs: [], commit: commit ?? null};
          else v = await verifyRepair({repo, base, commit, reproduction: plan?.outputs?.plan?.repair?.reproduction ?? null, paths: roundPaths(r, st), config, hide});
          if (!v.ok) {
            const findings = v.refusals.map((x, i) => ({id: `self-repair-${i + 1}`, severity: 'block', cause: 'self-repair-refused', code: x.code, text: x.what}));
            return {status: 'returned', outputs: {commit: commit ?? null, self_repair: v}, team: [], contributions: [], findings, usage: {provider_calls: 0},
              next: {stage: 'implement', why: cut(`the lane's mechanical verification refused the repair: ${v.refusals.map(x => x.code).join(', ')}`, 300)}};
          }
          const res = await exec(ctx);
          return {...res, outputs: {commit, ...(res?.outputs ?? {}), self_repair: v}};
        }, {capacity: exec.capacity});
      }
      return exec;
    },
    /** The end of the tick: land what passed its outcome, close what ended (blocked or out of attempts). */
    async end({rec = null, blocked = []} = {}) {
      if (!sw?.on) return log;
      for (const r of rounds().filter(x => !x.close && x.open.kind === 'repair')) {
        const st = work.stages(r.item);
        if (st.some(s => s.stage === 'outcome' && s.status === 'passed')) { await land(r); continue; }
        const gate = rec?.items?.find(i => i.item === r.item)?.gate ?? null;
        const b = blocked.find(x => x.item === r.item);
        if (b && /attempts of \w+ on the same inputs/.test(String(b.blocker?.what ?? ''))) { closeRound(r, 'failed', b.blocker.what); continue; }
        if (gate?.gate === 'blocked' && gate.blocker && !gate.blocker.transient && gate.blocker.code !== 'REVIEW_CAPACITY_PENDING' && !/^REVIEW_CAPACITY_PENDING/.test(String(gate.blocker.what ?? ''))) {
          closeRound(r, 'blocked', `${gate.blocker.code ?? 'BLOCKED'}: ${gate.blocker.what}`);
        }
      }
      return log;
    },
  };
}

/**
 * THE LANE PROPOSAL (decision 7): the outcome stage's UNSIGNED proposal for a round (stages.mjs). A round is not on the
 * status ledger, so its proposal names the lane's switch entry and what landing will do; merging the line anywhere else
 * is the owner's act, outside the lane.
 */
export function laneProposal({bundle, round, line = DEFAULT_CONFIG.line}) {
  return {schema: LANE_PROPOSAL_SCHEMA, item: bundle.item, lane: {item: LANE_ITEM, entry: round?.lane_entry ?? null}, signed: false, commit: bundle.commit, base: bundle.base,
    to: `landed on ${line} by the lane after this outcome; the owner merges the line (or reverts it)`, revert: revertOf(bundle.commit),
    evidence: {run: {ledger_anchor: bundle.run?.ledger_anchor ?? null, ledger_head: bundle.run?.ledger_head ?? null, run_json_digest: bundle.run?.run_json_digest ?? null, shipped: Boolean(bundle.run?.shipped)},
      review: {cycle: bundle.review?.cycle ?? null, close: bundle.review?.close ?? null, outcome: bundle.review?.outcome ?? null}, validation: bundle.validation ?? null, ticket: bundle.ticket ? {path: bundle.ticket.path, digest: bundle.ticket.digest} : null},
    authority: 'none: an unsigned record; the lane writes no status entry'};
}

/**
 * THE VIEW (cli.mjs `self-repair`): the lane's state, what the next round would select and what it would route to the
 * owner. A DRY RUN: Detect and the selection only, nothing written (no ledger entry, no candidate, no ref), no provider.
 */
export function laneView({repo, board, work = null, stateDir, config = DEFAULT_CONFIG, records = null, register = REGISTER}) {
  const sw = laneSwitch(board);
  const rs = work ? roundsOf(work) : [];
  const head = revOf(repo, config.line), commit = head ?? revOf(repo, config.base_ref);
  const recs = readRecords(records ?? recordsDirOf(stateDir));
  const det = commit ? detect({repo, commit, records: recs, register}) : {defects: [], ignored: [{source: config.base_ref, why: 'names no commit'}], digest: null};
  const sel = select({defects: det.defects, rounds: rs, board, config, stagesOf: i => (work ? work.stages(i) : []), routed: work ? routedOf(work) : new Map()});
  const byId = new Map(det.defects.map(d => [d.id, d]));
  const row = s => ({id: s.id, kind: s.kind, title: byId.get(s.id)?.title ?? null, subject: byId.get(s.id)?.site?.[0] ?? null, why: s.why});
  return {lane: {on: sw.on, why: sw.why ?? null, entry: sw.entry ?? null}, line: {ref: config.line, exists: Boolean(head), head, base_ref: config.base_ref}, commit,
    rounds: {open: rs.filter(r => !r.close).map(r => ({round: r.n, defect: r.open.defect.id, kind: r.open.kind})), closed: rs.filter(r => r.close).map(r => ({round: r.n, outcome: r.close.outcome, defect: r.open.defect.id}))},
    records: {gate: recs.gate.length, stress: recs.stress.length, pentest: recs.pentest.length, unreadable: recs.unreadable.length},
    detect: {defects: det.defects.length, by_kind: det.defects.reduce((o, d) => ({...o, [d.kind]: (o[d.kind] ?? 0) + 1}), {}), ignored: det.ignored},
    next: sel.selected ? {id: sel.selected.id, kind: sel.selected.kind, title: sel.selected.title, site: sel.selected.site, reproduction: sel.selected.reproduction ?? null} : null,
    owner: sel.skipped.filter(s => s.route === 'owner').map(row), owner_decision: sel.skipped.filter(s => s.route === 'owner-decision').map(row),
    unlocated: sel.skipped.filter(s => s.route === 'unlocated').map(s => s.id), other: sel.skipped.filter(s => !['owner', 'owner-decision', 'unlocated'].includes(s.route)).map(row),
    queue: sel.queue.map(q => q.id), written: 'nothing'};
}
