#!/usr/bin/env node
// The review layer at the end of every cycle (pantheon/src/ledger/review-cycle.mjs, cycle-kinds.mjs).
//
//   node pantheon/bin/pantheon-review-cycle.mjs [review] [--head HEAD] [--base X]   review the change
//   node pantheon/bin/pantheon-review-cycle.mjs resume [--max-attempts N]   retry the open cycle's failed seats
//   node pantheon/bin/pantheon-review-cycle.mjs fix --finding H --commit C --test CMD --before-exit N --after-exit 0
//   node pantheon/bin/pantheon-review-cycle.mjs defer --finding H --reason TEXT
//   node pantheon/bin/pantheon-review-cycle.mjs assess --outcome O --question TEXT [--by ROLE] [--method TEXT] [--evidence H]...
//   node pantheon/bin/pantheon-review-cycle.mjs close [--cycle H]
//   node pantheon/bin/pantheon-review-cycle.mjs practice [--profile P]
//   node pantheon/bin/pantheon-review-cycle.mjs status [--cycle H]
//
// Common options: --repo DIR (default: cwd), --ledger DIR (default: PANTHEON_CYCLE_LEDGER, else
// <git common dir>/pantheon-cycles, one ledger per repository shared by its worktrees), --scope NAME
// (default: the repository's directory name), --author-lab LAB (repeatable; default anthropic, the lab
// the loop's controller runs on), --n N (reviewers, default 3), --turn MODULE (a module whose default
// export is the reviewer turn; without it, live SDK turns are used, imported here at the edge).
//
// Without --base, a cycle starts where the previous cycle of the scope ended; the first cycle of a scope
// needs --base. A cycle cannot open while the previous one is open, so the review is not skippable: the
// next cycle's review refuses until this one is closed.
//
// A reviewer that failed (a 503, a refused review) leaves the cycle open. `resume` reopens the scope's
// open cycle (never a new one), re-reads its change from the repository at the cycle's own base and head,
// and asks again only the seats with no review, keeping the reviews already recorded. Each try is a
// recorded attempt; a seat stops at the cycle's attempt limit (--max-attempts on the first review, 3 by
// default).
//
// A cycle opens under the practice contract (pantheon.cycle/v2, audit C3): `review` records the selection
// policy in effect (--profile, default argo, with the pools PANTHEON_POOLS_FILE configures) and the admitted
// practice decision it loaded, and `close` refuses until `assess` has recorded the cycle's practice
// assessment: --outcome retain | insufficient_evidence | propose_measurement | propose_policy (the last with
// --candidate-id, --candidate-version, --candidate-hash, --candidate-change and --proposer vendor/model). A
// qualified candidate's disposition is `assess --proposal H --outcome promote|retain|reject --decided-by
// vendor/model` (a promote adds --measured true, --evidence H, --applicability, --rollback, --reevaluate),
// refused when the deciding seat is of the proposer's lab. `practice` prints what a dispatch would load.
// --evidence names ledger entries (repeatable); `--measured true` marks measured evidence, otherwise the
// assessment is recorded as provisional judgment.
//
// Exit codes: 0 done, 1 refused (a reviewer failed, the cycle cannot close, a ledger refusal), 2 usage.
import {execFileSync} from 'node:child_process';
import {basename, isAbsolute, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openPantheonLedger} from '../src/ledger/system.mjs';
import {reviewCycle} from '../src/ledger/review-cycle.mjs';
import {currentPolicy, loadPractice, DEFAULT_PRACTICE_SCOPE} from '../src/ledger/practice-kinds.mjs';
import {readPools} from '../src/route/frontier.mjs';
import {labOf} from '../src/config/models.mjs';

const [first, ...more] = process.argv.slice(2);
const verb = first && !first.startsWith('--') ? first : 'review';
const argv = first && !first.startsWith('--') ? more : process.argv.slice(2);
const opts = {}, multi = {'author-lab': [], evidence: []};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--') || i + 1 >= argv.length) usage(`unexpected argument: ${a}`);
  const k = a.slice(2), v = argv[++i];
  if (k in multi) multi[k].push(v); else opts[k] = v;
}
function usage(why) {
  console.error(`${why}\nusage: pantheon-review-cycle [review|resume|fix|defer|assess|close|status|practice] [--repo DIR] [--ledger DIR] [--scope NAME] ...`);
  process.exit(2);
}
const out = (value, code = 0) => { console.log(JSON.stringify(value, null, 2)); process.exit(code); };

const repo = resolve(opts.repo ?? process.cwd());
const git = (...args) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
const top = git('rev-parse', '--show-toplevel').trim();
const common = git('rev-parse', '--git-common-dir').trim();
const ledgerRoot = resolve(opts.ledger ?? process.env.PANTHEON_CYCLE_LEDGER ?? join(isAbsolute(common) ? common : join(repo, common), 'pantheon-cycles'));
const scope = opts.scope ?? basename(top);
const sys = openPantheonLedger({root: ledgerRoot, anchor: process.env.PANTHEON_CYCLE_LEDGER_ANCHOR ?? null});
const rec = sys.recorder();
const commit = ref => git('rev-parse', '--verify', `${ref}^{commit}`).trim();
const show = state => ({
  cycle: state.hash, scope: state.cycle.scope, base: state.cycle.base, head: state.cycle.head, reviewers: state.cycle.reviewers,
  reviews: state.reviews.map(r => ({review: r.hash, lab: r.lab, vendor: r.seat.vendor, verdict: r.verdict})),
  findings: state.findings.map(f => ({finding: f.hash, ...f.payload, resolution: state.resolutions.get(f.hash)?.payload ?? null})),
  contract: state.cycle.contract ?? 'pantheon.cycle/v1', prior: state.cycle.prior ?? null,
  practice: (state.dispositions ?? []).map(d => ({disposition: d.hash, stage: d.payload.stage, outcome: d.payload.outcome, provisional: d.payload.provisional})),
  closed: state.close,
  attempts: (state.attempts ?? []).map(a => ({attempt: a.hash, vendor: a.seat.vendor, model: a.seat.model, lab: a.seat.lab, n: a.attempt,
    max_attempts: a.max_attempts, outcome: a.outcome, why: a.why, resumed: a.resumed})),
});
const maxAttempts = opts['max-attempts'] === undefined ? undefined : Number(opts['max-attempts']);
const cycleOf = h => h ?? rec.lastCycle(scope)?.hash ?? usage(`no cycle of "${scope}" on the ledger at ${ledgerRoot}`);
const cycleOfFinding = f => {
  const e = sys.ledger.read().find(x => sys.ledger.hashOf(x) === f);
  if (e?.kind !== 'finding') usage(`${f} is not a finding on this ledger`);
  const review = sys.ledger.read().find(x => sys.ledger.hashOf(x) === e.derived_from[0]);
  return review.derived_from.find(h => sys.ledger.read().find(x => sys.ledger.hashOf(x) === h)?.kind === 'cycle');
};

async function liveTurn() {
  // The vendor SDKs are imported here, at the edge, as bin/pantheon-build.mjs does.
  const [{default: OpenAI}, {GoogleGenAI}, {default: Anthropic}, {makeClient, sendTurn}] = await Promise.all([
    import('openai'), import('@google/genai'), import('@anthropic-ai/sdk'), import('../src/sdk/adapter.mjs')]);
  const clients = new Map();
  return async ({vendor, model, prompt}) => {
    if (!clients.has(vendor)) clients.set(vendor, makeClient(vendor, {OpenAI, GoogleGenAI, Anthropic}));
    const r = await sendTurn({client: clients.get(vendor), vendor, model, prompt, label: `${vendor}-cycle-review`});
    if (r.complete === false) throw new Error(`${vendor}/${model}: the reply did not complete (${r.terminal_state ?? 'unknown'})`);
    return {text: r.text ?? '', response_id: r.response_id ?? null, served_model: r.served_model ?? null};
  };
}

try {
  if (verb === 'review') {
    const head = commit(opts.head ?? 'HEAD');
    const base = commit(opts.base ?? rec.lastCycle(scope)?.head ?? usage(`the first cycle of "${scope}" needs --base`));
    const diff = git('diff', '--no-color', base, head);
    if (!diff) out({refused: `no change between ${base} and ${head}`}, 1);
    const files = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
    const turn = opts.turn ? (await import(pathToFileURL(resolve(opts.turn)).href)).default : await liveTurn();
    const r = await reviewCycle({ledger: rec, change: {scope, base, head, diff, files, author_labs: multi['author-lab'].length ? multi['author-lab'] : ['anthropic']},
      turn, n: Number(opts.n ?? 3), max_attempts: maxAttempts, policy: currentPolicy(opts.profile ?? 'argo', {pools: readPools()}),
      practice_scope: opts['practice-scope'] ?? DEFAULT_PRACTICE_SCOPE});
    out({ledger: ledgerRoot, ...show(rec.cycleState(r.cycle)), failed: r.failed}, r.complete ? 0 : 1);
  }
  if (verb === 'resume') {
    // The change is the cycle's own: its base and head, re-read from the repository. reviewCycle checks
    // the diff, files and prompt against the digests the cycle bound and refuses a change that differs.
    const last = rec.lastCycle(scope);
    if (!last) out({refused: `no cycle of "${scope}" on the ledger at ${ledgerRoot}; there is nothing to resume`, code: 'NO_OPEN_CYCLE'}, 1);
    const c = rec.cycleState(last.hash).cycle;
    const diff = git('diff', '--no-color', c.base, c.head);
    const files = git('diff', '--name-only', c.base, c.head).split('\n').filter(Boolean);
    const turn = opts.turn ? (await import(pathToFileURL(resolve(opts.turn)).href)).default : await liveTurn();
    const r = await reviewCycle({ledger: rec, resume: true, turn, max_attempts: maxAttempts,
      change: {scope, base: c.base, head: c.head, diff, files, ...(multi['author-lab'].length ? {author_labs: multi['author-lab']} : {})}});
    out({ledger: ledgerRoot, ...show(rec.cycleState(r.cycle)), resumed: true, retained: r.retained, attempted: r.attempted, failed: r.failed}, r.complete ? 0 : 1);
  }
  if (verb === 'fix') {
    for (const k of ['finding', 'commit', 'test', 'before-exit', 'after-exit']) if (opts[k] === undefined) usage(`fix needs --${k}`);
    const state = rec.cycleState(cycleOfFinding(opts.finding));
    const fixed = commit(opts.commit);
    rec.fixFinding({finding: opts.finding, commit: fixed, test: opts.test,
      before: {commit: state.cycle.head, exit: Number(opts['before-exit'])}, after: {commit: fixed, exit: Number(opts['after-exit'])}});
    out(show(rec.cycleState(state.hash)));
  }
  if (verb === 'defer') {
    if (!opts.finding || !opts.reason) usage('defer needs --finding and --reason');
    const cycle = cycleOfFinding(opts.finding);
    rec.deferFinding({finding: opts.finding, reason: opts.reason});
    out(show(rec.cycleState(cycle)));
  }
  if (verb === 'assess') {
    if (!opts.outcome || !opts.question) usage('assess needs --outcome and --question');
    const seatOf = v => { const [vendor, ...m] = String(v).split('/'); return {vendor, model: m.join('/'), lab: labOf(vendor, m.join('/'))}; };
    const measured = opts.measured === 'true';
    const cycle = cycleOf(opts.cycle);
    const hash = rec.recordDisposition({cycle, stage: opts.proposal ? 'candidate' : 'assessment', outcome: opts.outcome, question: opts.question, measured,
      evidence: multi.evidence.map(h => ({kind: 'ledger', hash: h})),
      provenance: {by: {role: opts.by ?? 'lead@orch'}, method: opts.method ?? (measured ? 'measured comparison' : 'recorded judgment, unmeasured')},
      ...(opts.proposal ? {proposal: opts.proposal, by: seatOf(opts['decided-by'] ?? usage('a candidate disposition needs --decided-by vendor/model'))} : {}),
      ...(opts.outcome === 'propose_policy' ? {candidate: {id: opts['candidate-id'], change: opts['candidate-change'],
        policy: {version: opts['candidate-version'], hash: opts['candidate-hash'], profile: opts.profile ?? 'argo'}},
        proposer: seatOf(opts.proposer ?? usage('propose_policy needs --proposer vendor/model'))} : {}),
      ...(opts.applicability || opts.rollback || opts.reevaluate ? {conditions: {applicability: opts.applicability, rollback: opts.rollback, reevaluate: opts.reevaluate}} : {})});
    out({disposition: hash, ...show(rec.cycleState(cycle))});
  }
  if (verb === 'practice') out(loadPractice({ledger: sys.ledger, scope: opts['practice-scope'] ?? DEFAULT_PRACTICE_SCOPE, profile: opts.profile ?? 'argo', pools: readPools()}));
  if (verb === 'close') out({...rec.closeCycle(cycleOf(opts.cycle))});
  if (verb === 'status') out({ledger: ledgerRoot, verified: sys.ledger.verify().ok, ...show(rec.cycleState(cycleOf(opts.cycle)))});
  usage(`unknown verb: ${verb}`);
} catch (err) {
  out({refused: err.message, code: err.code ?? null}, 1);
}
