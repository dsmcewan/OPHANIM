// The status board as a projection of a ledger.
//
// Every status change is a `status` entry, signed by an operator and citing that item's previous status,
// so the board's history is the chain and the board itself (docs/STATUS.md) is generated from it, never
// edited by hand. The standing rule is enforced on append, not left to review:
//   - Resolved      done; names its basis
//   - In progress   being worked
//   - Ready         its dependencies have converged and nothing external is awaited: start it
//   - On Hold       waits on something OUTSIDE the work: governance, a credential, evidence from real
//                   runs, a fact a vendor has not published, or a decision only a person can make.
//                   "Not started yet" is never a hold; such an item is Ready.
// A hold also names when it was last re-checked, because a hold is re-evaluated for a change in
// circumstances before a loop concludes.
//
// Layout (committed): status/ledger/{chain.jsonl, objects/, ANCHOR}. Private keys live in
// status/ledger/keys/ by default, which is never committed: anyone can verify the board, only a key
// holder can change it. The owner keeps them off the repository (e.g. ~/.local/share/ophanim/status-ledger/keys)
// and names that directory with --keys or OPHANIM_STATUS_KEYS.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openLedger, createLedger, defineKinds, generateSigner} from './chain.mjs';
import {keyStore} from './home.mjs';
import {canonical, digest} from './canonical.mjs';

export const STATUS_SCHEMA = 'ophanim.status/v1';
export const STATES = ['Resolved', 'In progress', 'Ready', 'On Hold'];
export const EXTERNAL = ['governance', 'credential', 'evidence', 'fact', 'decision'];
// Optional: who owns the item. One of Pantheon's five chairs (model seats, not people), or
// `decision-authority`: an item only the human owner decides. Absent on entries recorded before it existed.
export const OWNER_ROLES = ['impl@build', 'check@review', 'lead@orch', 'scout@opt', 'arbiter@judge', 'decision-authority'];
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fail = why => { throw Object.assign(new Error(why), {code: 'STATUS_REFUSED'}); };

function statusKind({operators}) {
  return {
    status: {
      authors: a => operators.includes(a.key_id),
      validate: p => {
        if (p?.schema !== STATUS_SCHEMA || !ID.test(p.item ?? '') || typeof p.title !== 'string' || !p.title) return 'a status names its item id and title';
        if (!STATES.includes(p.state)) return `state must be one of ${STATES.join(', ')}`;
        if (typeof p.basis !== 'string' || !p.basis) return 'a status names its basis';
        if (!DATE.test(p.checked ?? '')) return 'a status names the date it was checked';
        if (p.depends_on !== undefined && !(Array.isArray(p.depends_on) && p.depends_on.every(d => ID.test(d)))) return 'depends_on lists item ids';
        if (p.owner_role !== undefined && !OWNER_ROLES.includes(p.owner_role)) return `owner_role must be one of ${OWNER_ROLES.join(', ')}`;
        if (p.evidence !== undefined) return evidenceRefusal(p.evidence, p.state);
        return null;
      },
      rederive: (e, view) => {
        const p = e.payload;
        // The standing rule: a hold waits on something outside the work, or on an item that itself waits.
        if (p.state === 'On Hold') {
          const external = EXTERNAL.includes(p.waiting_on);
          const blocked = (p.depends_on ?? []).some(d => {
            const s = latest(view, d);
            return s && s.state !== 'Resolved';
          });
          if (!external && !blocked) return `"${p.item}" is held on nothing external and no unresolved dependency: it is Ready, not On Hold`;
        } else if (p.waiting_on != null) return 'only a hold waits on something';
        // An item's statuses chain: a change cites the item's previous status, and a first status cites none.
        const prev = latestHash(view, p.item);
        const cited = e.derived_from.filter(h => view.entry(h)?.kind === 'status' && view.payload(h).item === p.item);
        if (prev ? !(cited.length === 1 && cited[0] === prev) : cited.length !== 0) return `a status for "${p.item}" cites its previous status, and only that`;
        return null;
      },
    },
  };
}

function latestHash(view, item) {
  let found = null;
  for (const h of view.entries()) if (view.entry(h).kind === 'status' && view.payload(h).item === item) found = h;
  return found;
}
function latest(view, item) { const h = latestHash(view, item); return h ? view.payload(h) : null; }

/** Open (or create on first use) the status ledger at `root`. */
//   create  false: refuse, rather than create, when no ledger is there (every reader but the first set)
//   keys    the directory holding the operator and orderer private keys (default <root>/keys). It is only
//           read: an apply on the owner's machine names the owner's key directory here, and nothing is
//           ever written to it or printed from it.
export function openStatusLedger({root, anchor = null, create = true, keys = null}) {
  if (!root || !path.isAbsolute(root)) fail('an absolute status ledger root is required');
  if (keys !== null && !path.isAbsolute(keys)) fail('an absolute key directory is required');
  const anchorFile = path.join(root, 'ANCHOR');
  if (!create && !fs.existsSync(anchorFile)) fail(`no status ledger at ${root}`);
  fs.mkdirSync(root, {recursive: true});
  let pinned = fs.existsSync(anchorFile) ? fs.readFileSync(anchorFile, 'utf8').trim() : null;
  const keysDir = keys ?? path.join(root, 'keys');
  if (!pinned) {
    if (fs.existsSync(path.join(root, 'chain.jsonl'))) fail('a status ledger without its ANCHOR is not opened');
    const keys = keyStore(keysDir);
    const operator = keys.put(generateSigner('operator')), orderer = keys.put(generateSigner('status-orderer'));
    pinned = createLedger({dir: root, operator, order: orderer,
      authority: {keyring: {operator: operator.publicJwk, 'status-orderer': orderer.publicJwk}, orderer: 'status-orderer', operators: ['operator']}});
    fs.writeFileSync(anchorFile, pinned + '\n');
  }
  if (anchor && anchor !== pinned) fail('this status ledger is not the one the caller pinned');
  // The kind is bound to whoever the chain's authority names as operators: opened once to read the
  // authority, then again with the operators it names.
  let operators = ['operator'];
  const L = () => openLedger({dir: root, kinds: defineKinds(statusKind({operators})), anchor: pinned});
  let ledger = L();
  const state = ledger.verify();
  if (!state.ok) fail(`status ledger does not verify: ${state.why}`);
  operators = state.authority.operators;
  ledger = L();

  const view = () => {
    const at = new Map(ledger.read().map(e => [ledger.hashOf(e), e]));
    return {entry: h => at.get(h) ?? null, payload: h => (at.has(h) ? ledger.payloadOf(at.get(h)) : null), entries: () => [...at.keys()]};
  };
  const signers = () => {
    // Read only: a missing key directory is refused, never created.
    if (!fs.existsSync(keysDir)) fail('no operator or orderer key is held here: the board can be verified, not changed');
    const keys = keyStore(keysDir);
    const op = operators.map(id => keys.get(id)).find(Boolean), order = keys.get(state.authority.orderer);
    if (!op || !order) fail('no operator or orderer key is held here: the board can be verified, not changed');
    return {op, order};
  };
  return {
    ledger, anchor: pinned, root,
    /** Record a status for an item (a change cites the item's previous status). */
    set({item, title, state: s, basis, checked, waiting_on = null, depends_on = undefined, owner_role = undefined, evidence = undefined, cites = []}) {
      const {op, order} = signers();
      const prev = latestHash(view(), item);
      const payload = {schema: STATUS_SCHEMA, item, title, state: s, basis, checked, waiting_on, ...(depends_on ? {depends_on} : {}), ...(owner_role !== undefined ? {owner_role} : {}),
        ...(evidence !== undefined ? {evidence} : {})};
      return ledger.append({kind: 'status', payload, author: {key_id: op.key_id}, signer: op, order, derivedFrom: [...(prev ? [prev] : []), ...cites]}).hash;
    },
    /** The board: the latest status of every item, from a ledger that verifies. */
    board() {
      const v = ledger.verify();
      if (!v.ok) fail(`status ledger does not verify: ${v.why}`);
      const vw = view(), items = new Map();
      for (const h of vw.entries()) if (vw.entry(h).kind === 'status') items.set(vw.payload(h).item, {...vw.payload(h), entry: h});
      return {head: v.head, anchor: pinned, entries: v.entries, items: [...items.values()]};
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Status proposals (docs/operating-workflow.md). Pantheon's board dispatcher never writes this ledger
// and never holds its keys: a run ends in an UNSIGNED proposal naming the status it was made against
// and the evidence for the change. Only `apply`, run by whoever holds the operator and orderer keys
// (the owner, on the owner's machine), records it, and only if it is still current and its evidence
// checks out. The recorded status carries the evidence (an optional, validated `evidence` object on the
// status payload; entries recorded before it existed have none and are unaffected).
//
// proposal (ophanim.status-proposal/v1):
//   {schema, item, from: {state, entry}, to: {state, basis, checked, waiting_on?, owner_role?},
//    evidence: {run: {ledger_anchor, ledger_head, run_json_digest, shipped, gate_entry},
//               review: {cycle_ledger_anchor, cycle, close_entry, outcome,
//                        reviewers: [{vendor, model, served_model, lab}]},
//               commit, tests: {cmd, exit}, ticket?: {path, digest, slice}},
//    accept_unverified_reason?, locations?: {run_ledger, cycle_ledger, run_json}}
// `locations` are local hints for apply (where the cited ledgers are on this machine). They are not
// part of the proposal's digest and are never recorded: a status entry names no machine path.
export const PROPOSAL_SCHEMA = 'ophanim.status-proposal/v1';
export const EVIDENCE_SCHEMA = 'ophanim.status-evidence/v1';
const SHA = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const OUTCOMES = ['verified', 'unverified'];
// What apply re-checked of the cited ledgers: `structural` (genesis, signatures, links, payloads and the
// cited entries, on this machine) or `not-available` (the ledgers were not here to check).
const CHECKED = ['structural', 'not-available'];
const str = v => typeof v === 'string' && v.trim() !== '';
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (o, keys) => Object.keys(o).every(k => keys.includes(k));
const sha256 = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

function runRefusal(r) {
  if (!plain(r) || !only(r, ['ledger_anchor', 'ledger_head', 'run_json_digest', 'shipped', 'gate_entry'])) {
    return 'evidence.run names {ledger_anchor, ledger_head, run_json_digest, shipped, gate_entry}';
  }
  if (![r.ledger_anchor, r.ledger_head, r.run_json_digest].every(h => SHA.test(h ?? ''))) {
    return 'evidence.run names its ledger anchor, ledger head and run.json digest as sha256 hashes';
  }
  if (typeof r.shipped !== 'boolean') return 'evidence.run.shipped is true or false';
  if (!(r.gate_entry === null || SHA.test(r.gate_entry ?? ''))) return 'evidence.run.gate_entry is a ledger entry hash or null';
  return null;
}
const reviewerShape = x => plain(x) && only(x, ['vendor', 'model', 'served_model', 'lab']) && str(x.vendor) && str(x.model)
  && (x.served_model === null || str(x.served_model)) && str(x.lab);
function reviewRefusal(r) {
  if (!plain(r) || !only(r, ['cycle_ledger_anchor', 'cycle', 'close_entry', 'outcome', 'reviewers'])) {
    return 'evidence.review names {cycle_ledger_anchor, cycle, close_entry, outcome, reviewers}';
  }
  if (!SHA.test(r.cycle_ledger_anchor ?? '') || !SHA.test(r.cycle ?? '')) return 'evidence.review names its ledger anchor and cycle entry';
  const closed = SHA.test(r.close_entry ?? '') && OUTCOMES.includes(r.outcome);
  if (r.close_entry === null ? r.outcome !== null : !closed) {
    return 'evidence.review names a close entry with its outcome (verified or unverified), or neither while the cycle is open';
  }
  if (!Array.isArray(r.reviewers) || !r.reviewers.length || !r.reviewers.every(reviewerShape)) {
    return 'evidence.review lists its reviewers as {vendor, model, served_model, lab}';
  }
  if (new Set(r.reviewers.map(x => x.lab)).size !== r.reviewers.length) return 'evidence.review: two reviewers share a lab';
  return null;
}
function testsRefusal(t) {
  if (t === null) return null;
  return plain(t) && only(t, ['cmd', 'exit']) && str(t.cmd) && Number.isInteger(t.exit) ? null : 'evidence.tests names {cmd, exit}';
}
function ticketRefusal(t) {
  if (t === undefined) return null;
  const ok = plain(t) && only(t, ['path', 'digest', 'slice']) && str(t.path) && !path.isAbsolute(t.path) && SHA.test(t.digest ?? '') && str(t.slice);
  return ok ? null : 'evidence.ticket names {path (repository-relative), digest, slice}';
}
// What a change to Resolved needs: shipped work, passing tests, a commit, and a closed review cycle. A
// cycle that closed `unverified` (a finding without a reproduction was deferred) needs a stated reason.
function resolvedRefusal(ev, reason) {
  if (!ev.run.shipped) return 'a change to Resolved cites a run that shipped';
  if (!ev.commit) return 'a change to Resolved names the commit it shipped';
  if (ev.tests?.exit !== 0) return 'a change to Resolved names tests that passed (exit 0)';
  if (!ev.review || ev.review.close_entry === null) return 'a change to Resolved cites a review-cycle close';
  if (ev.review.outcome === 'unverified' && !str(reason)) {
    return 'a review cycle that closed unverified cannot propose Resolved without an explicit accept_unverified_reason';
  }
  return null;
}
function evidenceCore(ev) {
  return runRefusal(ev.run)
    ?? (ev.review === undefined || ev.review === null ? null : reviewRefusal(ev.review))
    ?? (ev.commit === null || COMMIT.test(ev.commit ?? '') ? null : 'evidence.commit is a git commit id or null')
    ?? testsRefusal(ev.tests ?? null)
    ?? ticketRefusal(ev.ticket);
}

const EVIDENCE_FIELDS = ['schema', 'proposal', 'run', 'review', 'commit', 'tests', 'ticket', 'accept_unverified_reason', 'checked'];
/** The reason a status payload's `evidence` is refused, or null. */
export function evidenceRefusal(ev, state) {
  if (!plain(ev) || ev.schema !== EVIDENCE_SCHEMA) return `evidence is an ${EVIDENCE_SCHEMA} object`;
  if (!only(ev, EVIDENCE_FIELDS)) return 'evidence carries only its named fields';
  if (!SHA.test(ev.proposal ?? '')) return 'evidence names the digest of the proposal it was applied from';
  if (!CHECKED.includes(ev.checked)) return `evidence.checked is one of ${CHECKED.join(', ')}`;
  if (ev.accept_unverified_reason !== undefined && !str(ev.accept_unverified_reason)) return 'accept_unverified_reason is a non-empty reason';
  return evidenceCore(ev) ?? (state === 'Resolved' ? resolvedRefusal(ev, ev.accept_unverified_reason) : null);
}

/** The proposal's digest: canonical JSON of everything but its local `locations`. */
export const proposalDigest = p => 'sha256:' + digest(Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'locations')));

/** The reason a proposal is malformed, or null. Says nothing about whether it is still current. */
export function proposalRefusal(p) {
  if (!plain(p) || p.schema !== PROPOSAL_SCHEMA) return `a proposal is an ${PROPOSAL_SCHEMA} object`;
  if (!only(p, ['schema', 'item', 'from', 'to', 'evidence', 'accept_unverified_reason', 'locations'])) return 'a proposal carries only its named fields';
  if (!ID.test(p.item ?? '')) return 'a proposal names its item id';
  if (!plain(p.from) || !STATES.includes(p.from.state) || !SHA.test(p.from.entry ?? '')) {
    return 'a proposal names the status it was made against: from {state, entry}';
  }
  const t = p.to;
  if (!plain(t) || !only(t, ['state', 'basis', 'checked', 'waiting_on', 'owner_role'])) return 'a proposal names to {state, basis, checked, waiting_on?, owner_role?}';
  if (!STATES.includes(t.state)) return `to.state must be one of ${STATES.join(', ')}`;
  if (!str(t.basis) || !DATE.test(t.checked ?? '')) return 'to names its basis and the date it was checked';
  if (t.waiting_on != null && !(t.state === 'On Hold' && EXTERNAL.includes(t.waiting_on))) return 'only a hold waits, on something external';
  if (t.owner_role !== undefined && !OWNER_ROLES.includes(t.owner_role)) return `owner_role must be one of ${OWNER_ROLES.join(', ')}`;
  if (p.accept_unverified_reason !== undefined && !str(p.accept_unverified_reason)) return 'accept_unverified_reason is a non-empty reason';
  const ev = p.evidence;
  if (!plain(ev) || !only(ev, ['run', 'review', 'commit', 'tests', 'ticket'])) return 'a proposal carries evidence {run, review, commit, tests, ticket?}';
  const local = v => v === null || (str(v) && path.isAbsolute(v));
  if (p.locations !== undefined && !(plain(p.locations) && Object.values(p.locations).every(local))) return 'locations are absolute local paths';
  return evidenceCore(ev) ?? (t.state === 'Resolved' ? resolvedRefusal(ev, p.accept_unverified_reason) : null);
}

/** Build a proposal against the item's latest status on `board` (from: that entry). Needs no key. */
export function propose(board, {item, to, evidence, accept_unverified_reason = undefined, locations = undefined}) {
  const latest = board.items.find(i => i.item === item);
  if (!latest) fail(`"${item}" is not on the status board`);
  const p = {schema: PROPOSAL_SCHEMA, item, from: {state: latest.state, entry: latest.entry}, to, evidence,
    ...(accept_unverified_reason !== undefined ? {accept_unverified_reason} : {}), ...(locations !== undefined ? {locations} : {})};
  const why = proposalRefusal(p);
  if (why) fail(`proposal refused: ${why}`);
  return p;
}

// A cited ledger, re-checked where it is on this machine. packages/ledger supplies no domain's kinds, so
// this is the STRUCTURAL check (chain.mjs, "Domains"): the genesis is the cited anchor, every signature
// and link verifies, every payload is intact, and the cited entries are in that chain with the stated
// kinds and content. Full re-derivation with Pantheon's kinds is `pantheon-board.mjs check`.
function citedLedger(dir, anchor) {
  if (!fs.existsSync(path.join(dir, 'chain.jsonl'))) return null;
  const L = openLedger({dir, kinds: defineKinds({}), anchor});
  const v = L.verify();
  if (!v.ok) fail(`a cited ledger does not verify: ${v.why}`);
  const at = new Map(L.read().map(e => [L.hashOf(e), e]));
  return {entry: h => at.get(h) ?? null, payload: h => (at.has(h) ? L.payloadOf(at.get(h)) : null), entries: () => [...at.keys()]};
}

function checkReview(cyc, review) {
  if (cyc.entry(review.cycle)?.kind !== 'cycle') fail('the review cycle the proposal cites is not a cycle on its ledger');
  if (review.close_entry) {
    const close = cyc.entry(review.close_entry);
    if (close?.kind !== 'cycle.close' || !close.derived_from.includes(review.cycle)) fail('the close entry the proposal cites does not close that cycle');
    const claim = cyc.payload(review.close_entry);
    if (claim.outcome !== review.outcome) fail(`the cycle closed ${claim.outcome}, not ${review.outcome}`);
    if (canonical([...claim.labs].sort()) !== canonical(review.reviewers.map(r => r.lab).sort())) fail('the reviewers\' labs are not the ones the close names');
  }
  const key = r => `${r.vendor}|${r.model}|${r.served_model ?? ''}`;
  const recorded = cyc.entries().filter(h => cyc.entry(h).kind === 'review' && cyc.entry(h).derived_from.includes(review.cycle))
    .map(h => cyc.payload(h)).map(r => key({vendor: r.seat.vendor, model: r.model, served_model: r.served_model})).sort();
  if (canonical(recorded) !== canonical(review.reviewers.map(key).sort())) fail('the reviewers the proposal names are not the reviews recorded on the cycle');
}

/** Re-check the ledgers a proposal cites, where its `locations` say they are. Throws on any mismatch. */
export function checkEvidenceLedgers(p) {
  const ev = p.evidence, loc = p.locations ?? {};
  const run = loc.run_ledger ? citedLedger(loc.run_ledger, ev.run.ledger_anchor) : null;
  if (loc.run_ledger && !run) fail(`the run ledger named in the proposal is not at ${loc.run_ledger}`);
  if (run) {
    if (!run.entry(ev.run.ledger_head)) fail('the run ledger head the proposal cites is not in that ledger');
    if (ev.run.gate_entry && run.entry(ev.run.gate_entry)?.kind !== 'gate') fail('the gate entry the proposal cites is not a gate verdict on the run ledger');
  }
  if (loc.run_json) {
    if (!fs.existsSync(loc.run_json)) fail(`the run.json named in the proposal is not at ${loc.run_json}`);
    if (sha256(fs.readFileSync(loc.run_json)) !== ev.run.run_json_digest) fail('run.json is not the one the proposal cites');
  }
  let cyc = null;
  if (ev.review && loc.cycle_ledger) {
    const same = loc.cycle_ledger === loc.run_ledger && ev.review.cycle_ledger_anchor === ev.run.ledger_anchor;
    cyc = same ? run : citedLedger(loc.cycle_ledger, ev.review.cycle_ledger_anchor);
    if (!cyc) fail(`the review-cycle ledger named in the proposal is not at ${loc.cycle_ledger}`);
    checkReview(cyc, ev.review);
  }
  return {run: Boolean(run), review: Boolean(cyc), checked: run && (!ev.review || cyc) ? 'structural' : 'not-available'};
}

/**
 * Apply a proposal: the status ledger verifies, the proposal is well formed and still current (from.entry
 * is the item's latest status), its cited ledgers re-check where they are held, and the status is then
 * recorded with the operator and orderer keys from `keys`, carrying the evidence. The entry cites only
 * the item's previous status, as every status does. Returns the new entry and the board after it.
 */
export function applyProposal({root, proposal: p, keys = null, anchor = null}) {
  const why = proposalRefusal(p);
  if (why) fail(`proposal refused: ${why}`);
  const S = openStatusLedger({root, anchor, create: false, keys});
  const latest = S.board().items.find(i => i.item === p.item);
  if (!latest) fail(`"${p.item}" is not on the status board`);
  if (latest.entry !== p.from.entry || latest.state !== p.from.state) {
    fail(`stale proposal: it was made against ${p.from.entry.slice(0, 19)} (${p.from.state}); the item's latest status is ${latest.entry.slice(0, 19)} (${latest.state})`);
  }
  const checks = checkEvidenceLedgers(p);
  const {run, review = null, commit, tests, ticket} = p.evidence;
  const evidence = {schema: EVIDENCE_SCHEMA, proposal: proposalDigest(p), run, ...(review ? {review} : {}), commit: commit ?? null, tests: tests ?? null,
    ...(ticket ? {ticket} : {}), ...(p.accept_unverified_reason ? {accept_unverified_reason: p.accept_unverified_reason} : {}), checked: checks.checked};
  const t = p.to;
  const entry = S.set({item: p.item, title: latest.title, state: t.state, basis: t.basis, checked: t.checked, waiting_on: t.waiting_on ?? null,
    depends_on: latest.depends_on, owner_role: t.owner_role ?? latest.owner_role, evidence});
  return {entry, item: p.item, state: t.state, proposal: evidence.proposal, checked: checks, board: S.board()};
}

const ORDER = {'On Hold': 0, 'In progress': 1, 'Ready': 2, 'Resolved': 3};
// A status recorded from a proposal names its evidence in the board row (the full record is the issue).
const evidenceNote = ev => {
  if (!ev) return '';
  const parts = [ev.commit ? `commit ${ev.commit.slice(0, 12)}` : null, ev.tests ? `tests exit ${ev.tests.exit}` : null,
    ev.review ? `review cycle ${ev.review.cycle.slice(7, 19)} ${ev.review.outcome ?? 'open'} (${ev.review.reviewers.map(x => x.lab).join(', ')})` : null];
  return ` (evidence: ${parts.filter(Boolean).join('; ')})`;
};
/** Render the board as Markdown. The output is generated; edit the ledger, not the file. */
export function renderBoard(board) {
  const rows = [...board.items].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.item.localeCompare(b.item));
  const cell = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const counts = STATES.map(s => `${s}: ${rows.filter(r => r.state === s).length}`).join(' · ');
  return [
    '# Status board',
    '',
    '<!-- Generated from the status ledger (status/ledger). Do not edit by hand: record a status change',
    '     with `node packages/ledger/status.mjs set ...`, then `node packages/ledger/status.mjs render`. -->',
    '',
    `**Ledger:** \`status/ledger\` · anchor \`${board.anchor}\` · head \`${board.head}\` · ${board.entries} entries.`,
    `Verify it: \`node packages/ledger/status.mjs verify\`.`,
    '',
    `**Counts:** ${counts}.`,
    '',
    '**Rule** (enforced when a status is recorded): On Hold only for something outside the work, meaning governance, a credential, evidence from real runs, an unpublished fact, or a person\'s decision, or for an item that depends on one. An item that is merely not started is Ready, and starts.',
    '',
    '| Item | State | Waiting on | Basis | Checked |',
    '|---|---|---|---|---|',
    ...rows.map(r => `| **${cell(r.title)}** (\`${r.item}\`) | ${r.state} | ${r.waiting_on ?? (r.depends_on?.length ? `depends on ${r.depends_on.join(', ')}` : '')} | ${cell(r.basis)}${evidenceNote(r.evidence)} | ${r.checked} |`),
    '',
  ].join('\n');
}

// CLI:
//   node packages/ledger/status.mjs verify
//   node packages/ledger/status.mjs render [--board FILE]
//   node packages/ledger/status.mjs set --json '{"item":...}' [--keys DIR]
//   node packages/ledger/status.mjs propose --json '{"item":..., "to":{...}, "evidence":{...}}' [--out FILE]   (no keys)
//   node packages/ledger/status.mjs apply <proposal.json> [--keys DIR] [--board FILE]
// The ledger is OPHANIM_STATUS_LEDGER, else status/ledger. The key directory is --keys, else
// OPHANIM_STATUS_KEYS, else <ledger>/keys; it is only read. The rendered board is --board, else
// OPHANIM_STATUS_BOARD, else docs/STATUS.md for the default ledger (another ledger is not rendered over it).
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '../../status/ledger');
export const DEFAULT_BOARD = path.resolve(HERE, '../../docs/STATUS.md');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = {}, args = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i]; else args.push(rest[i]);
  }
  const root = path.resolve(process.env.OPHANIM_STATUS_LEDGER ?? DEFAULT_ROOT);
  const keysFlag = flags.keys ?? process.env.OPHANIM_STATUS_KEYS ?? null;
  const keys = keysFlag ? path.resolve(keysFlag) : null;
  const boardFile = flags.board ?? process.env.OPHANIM_STATUS_BOARD ?? (root === DEFAULT_ROOT ? DEFAULT_BOARD : null);
  const render = board => {
    if (!boardFile) return 'not rendered: name --board for a ledger other than status/ledger';
    fs.writeFileSync(path.resolve(boardFile), renderBoard(board));
    return `wrote ${path.relative(process.cwd(), path.resolve(boardFile))}`;
  };
  const usage = () => {
    console.error('usage: status.mjs verify | render [--board FILE] | set --json \'{"item":..., "title":..., "state":..., "basis":..., "checked":"YYYY-MM-DD", ...}\' [--keys DIR]'
      + ' | propose --json \'{"item":..., "to":{...}, "evidence":{...}}\' [--out FILE] | apply <proposal.json> [--keys DIR] [--board FILE]');
    process.exit(2);
  };
  try {
    if (cmd === 'verify') { const b = openStatusLedger({root, create: false}).board(); console.log(`ok: ${b.items.length} items, ${b.entries} entries, head ${b.head}`); }
    else if (cmd === 'render') console.log(render(openStatusLedger({root, create: false}).board()));
    else if (cmd === 'set' && flags.json) console.log(openStatusLedger({root, keys}).set(JSON.parse(flags.json)));
    else if (cmd === 'propose' && flags.json) {
      const p = propose(openStatusLedger({root, create: false}).board(), JSON.parse(flags.json));
      const text = JSON.stringify(p, null, 2) + '\n';
      if (flags.out) { fs.writeFileSync(path.resolve(flags.out), text); console.log(`wrote ${flags.out} (${proposalDigest(p)})`); } else process.stdout.write(text);
    } else if (cmd === 'apply' && args.length === 1) {
      const r = applyProposal({root, keys, proposal: JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8'))});
      console.log(JSON.stringify({applied: r.entry, item: r.item, state: r.state, proposal: r.proposal, cited_ledgers: r.checked.checked, board: render(r.board)}, null, 2));
    } else usage();
  } catch (err) {
    if (err.code !== 'STATUS_REFUSED' && err.code !== 'LEDGER_REFUSED') throw err;
    console.error(`refused: ${err.message}`);
    process.exit(1);
  }
}
