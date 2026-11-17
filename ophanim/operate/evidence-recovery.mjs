// AUTOMATIC EVIDENCE RECOVERY for items the status ledger records as Resolved without completion evidence (an
// attested basis only: the `evidence-gap` gate). The status ledger stays the owner's: this module never signs, never
// appends to it, and never writes to a run or review-cycle ledger. What it does:
//
//   1. Finds every retained run of the item: evidence bundles (<board>/operating/evidence.json, as Pantheon's board
//      and this lifecycle's outcome stage write them) under the retained-runs directory, and the bundles the work
//      ledger's own outcome stages recorded.
//   2. For each, decides whether it is completion evidence for the item's CURRENT Resolved status:
//        - the bundle is the item's and carries a proposal (made when its three-lab review cycle closed);
//        - that proposal is well formed, proposes Resolved, and was made against a status of this item whose
//          requirement (title and Ready basis) is still the item's requirement;
//        - rebuilt against the current Resolved entry, it passes the status ledger's own proposal rules (bound to the
//          item's ticket, a verified close by three labs) and the STRUCTURAL check of everything it cites (run ledger,
//          review-cycle ledger, run.json, the ticket bytes), as `apply` will re-check them;
//        - its commit exists in this repository (whether it is reachable from HEAD is reported, not assumed).
//   3. Writes the first applicable one as an UNSIGNED proposal for the owner, and records the attempt -- every source
//      searched with its result -- on the work ledger (work.recovery). An item with nothing applicable is recorded as
//      `not-found`, with what was searched; it is searched again only when its sources or its status change.
//
// The owner applies a recovered proposal with `node packages/ledger/status.mjs apply <file>` (their keys); a
// Resolved item with nothing recoverable is re-verified only if the owner records it Ready again, which puts it
// through the lifecycle. Must never: treat a basis, a label, a green CI run or an open review as evidence; widen a
// proposal's claims; or record a status.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {propose, proposalRefusal, proposalDigest, checkEvidenceLedgers} from '../../packages/ledger/status.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';
import {requirementOf, requirementDigest} from './gates.mjs';
import {statusHistory} from './reconcile.mjs';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fileSha = f => (fs.existsSync(f) ? sha(fs.readFileSync(f)) : null);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** Every evidence bundle of `item`: under `bundlesDir`, and the ones the work ledger's outcome stages recorded. */
export function bundlesOf({item, bundlesDir = null, work = null}) {
  const out = [];
  const walk = (dir, origin) => {
    if (!dir || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, origin);
      else if (e.name === 'evidence.json' && readJson(p)?.item === item) out.push({dir: path.dirname(p), origin, ref: `${origin}:${path.relative(origin === 'retained' ? bundlesDir : dir, path.dirname(p)) || '.'}`});
    }
  };
  walk(bundlesDir, 'retained');
  for (const s of work ? work.stages(item).filter(x => x.stage === 'outcome' && x.outputs?.bundle) : []) {
    if (!out.some(b => path.resolve(b.dir) === path.resolve(s.outputs.bundle))) out.push({dir: s.outputs.bundle, origin: 'work', ref: `work:${s.hash}`});
  }
  return out;
}

/**
 * The digest of what a recovery searches and re-checks: each bundle's evidence and proposal bytes, the bytes its
 * proposal cites (run.json, the run and cycle ledger chains), and the item's ticket. A change to any of them makes
 * the item due for another search; nothing else does.
 */
export function sourcesDigest({repo, item, bundles}) {
  const cited = dir => {
    const loc = readJson(path.join(dir, 'proposal.json'))?.locations ?? {};
    const chain = d => (typeof d === 'string' ? fileSha(path.join(d, 'chain.jsonl')) : null);
    return {run_json: typeof loc.run_json === 'string' ? fileSha(loc.run_json) : null, run_ledger: chain(loc.run_ledger), cycle_ledger: chain(loc.cycle_ledger)};
  };
  return 'sha256:' + digest({ticket: fileSha(path.join(repo, 'tickets', `${item}.json`)),
    bundles: bundles.map(b => ({ref: b.ref, evidence: fileSha(path.join(b.dir, 'evidence.json')), proposal: fileSha(path.join(b.dir, 'proposal.json')), cited: cited(b.dir)}))
      .sort((a, b) => a.ref.localeCompare(b.ref))});
}

const commitIn = (repo, commit) => {
  try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${commit}^{commit}`], {stdio: 'ignore'}); } catch { return {present: false, in_head: false}; }
  try { execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', commit, 'HEAD'], {stdio: 'ignore'}); return {present: true, in_head: true}; }
  catch { return {present: true, in_head: false}; }
};

/** Whether one bundle is completion evidence for the item's current status; the rebuilt proposal when it is. */
function examine({repo, board, history, current, bundle, checked}) {
  const row = (result, why, extra = {}) => ({source: bundle.origin, ref: bundle.ref, result, why, ...extra});
  const old = readJson(path.join(bundle.dir, 'proposal.json'));
  if (!old) {
    const b = readJson(path.join(bundle.dir, 'evidence.json'));
    return row('not-evidence', `no proposal: the run ${b?.run?.shipped ? 'shipped' : 'did not ship'} and its review is ${b?.review?.close ? 'closed' : b?.review ? 'open' : 'absent'}; only a closed review's proposal is completion evidence`);
  }
  const malformed = proposalRefusal(old);
  if (malformed) return row('refused', `its proposal is malformed: ${malformed}`);
  if (old.item !== current.item) return row('refused', `its proposal is for "${old.item}"`);
  if (old.to.state !== 'Resolved') return row('not-evidence', `its proposal proposes ${old.to.state}, not Resolved`);
  // The requirement it was made against must still be the item's requirement.
  const upTo = history.findIndex(s => s.entry === old.from.entry);
  if (upTo < 0) return row('refused', 'its proposal was made against a status that is not in this item\'s history');
  const then = requirementOf(history.slice(0, upTo + 1)), now = requirementOf(history);
  if (requirementDigest(then) !== requirementDigest(now)) return row('stale', 'the item\'s requirement changed after that run (title or Ready basis)');
  let p;
  try {
    p = propose(board, {item: current.item, to: {state: 'Resolved', basis: `Completion evidence recovered from a retained run (${bundle.ref}): ${old.to.basis}`.slice(0, 2000), checked},
      evidence: old.evidence, ...(old.accept_unverified_reason ? {accept_unverified_reason: old.accept_unverified_reason} : {}), locations: old.locations});
  } catch (e) { return row('refused', e.message); }
  let checks;
  try { checks = checkEvidenceLedgers(p); } catch (e) { return row('refused', `the cited evidence does not re-check: ${e.message}`); }
  if (checks.checked !== 'structural') {
    const missing = Object.entries(checks).filter(([k, v]) => k !== 'checked' && !v).map(([k]) => k);
    return row('unverifiable-here', `not everything it cites is on this machine to re-check (${missing.join(', ')})`);
  }
  const c = commitIn(repo, p.evidence.commit);
  if (!c.present) return row('refused', `its commit ${p.evidence.commit.slice(0, 12)} is not in this repository`);
  return row('recovered', `a verified three-lab review of ${p.evidence.commit.slice(0, 12)} bound to tickets/${current.item}.json, re-checked structurally`,
    {commit: p.evidence.commit, in_head: c.in_head, proposal: p});
}

/**
 * Search, decide and (when evidence applies) write the unsigned proposal. Pure of ledger writes: the caller records
 * the result with work.recordRecovery. Returns {item, status_entry, sources, outcome, searched, proposal?}.
 */
export function recoverEvidence({repo, statusRoot, item, bundlesDir = null, work = null, outDir, now = Date.now()}) {
  const {board, byItem} = statusHistory(statusRoot);
  const current = board.items.find(i => i.item === item);
  if (!current) throw new Error(`"${item}" is not on the status board`);
  if (current.state !== 'Resolved') throw new Error(`"${item}" is ${current.state}: evidence recovery is for Resolved items`);
  const history = byItem.get(item) ?? [];
  const bundles = bundlesOf({item, bundlesDir, work});
  const sources = sourcesDigest({repo, item, bundles});
  const checked = new Date(now).toISOString().slice(0, 10);
  const searched = bundles.map(bundle => examine({repo, board, history, current, bundle, checked}));
  if (!bundlesDir) searched.push({source: 'retained', ref: 'retained', result: 'not-searched', why: 'no retained-runs directory was given (--bundles)'});
  else if (!bundles.some(b => b.origin === 'retained')) searched.push({source: 'retained', ref: 'retained', result: 'none', why: 'no evidence bundle of the item in the retained runs'});
  if (!bundles.some(b => b.origin === 'work')) searched.push({source: 'work', ref: 'work', result: 'none', why: 'no outcome of the item on the work ledger'});
  const hit = searched.find(r => r.result === 'recovered');
  const base = {item, status_entry: current.entry, sources, searched: searched.map(({proposal, ...r}) => r)};
  if (!hit) return {...base, outcome: 'not-found'};
  const file = path.join(outDir, item, `proposal-${proposalDigest(hit.proposal).slice(7, 19)}.json`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(hit.proposal, null, 2) + '\n');
  return {...base, outcome: 'recovered', proposal: {digest: proposalDigest(hit.proposal), file, commit: hit.commit, in_head: hit.in_head}};
}
