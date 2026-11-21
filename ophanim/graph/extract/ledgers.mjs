// THE AUTHORITATIVE LEDGERS as graph sources, READ ONLY (Slice B, KB1; docs/knowledge-graph/slice-b.md).
//
// Purpose   Graph C's records and Graph E's items, from the ledgers that hold them -- each read through ITS OWN reader,
//           verified against a PINNED anchor (the genesis the caller trusts), never written:
//             the status ledger  packages/ledger/status.mjs openStatusLedger({create: false}): the owner's items, their
//                                states, dependencies and the chain of their entries (this checkout: 85 entries, 58 items)
//             the work ledger    ophanim/operate/work-ledger.mjs openWorkLedger({create: false}): claims and stage
//                                records (none in this container; the tests use a fixture)
//             the cycle ledger   ophanim/public/provenance.mjs openLedgerReadOnly: review cycles and their findings
//                                (a fixture in the tests)
//           A ledger is append-only, so its version is its HEAD ENTRY HASH, and readAt(head) re-derives the facts from
//           the prefix of the chain that ends there: a replay after later appends reproduces the same facts.
// Inputs    A ledger root (absolute) and its pinned anchor.
// Outputs   statusSource(), workSource(), cycleSource(); STATUS_ANCHOR (the status ledger's genesis, pinned).
// Facts     work/item/<item>                    status: title, state, basis, checked, waiting_on, the latest entry;
//                                               `depends-on` the items it names (an item not on the ledger is recorded
//                                               `unresolved`); `derived-from` its latest entry
//           evidence/record/status/<entry>      each status entry; `derived-from` the item's previous entry
//           work/lease/<claim>, work/execution/<stage record>   work: `depends-on` the item; a stage `derived-from`
//                                               its claim and the stage it received from
//           work/review/<cycle>, learning/finding/<finding>     cycle: the cycle's scope, base, head, reviews and
//                                               close; a finding `derived-from` its cycle, with its resolution
// Must never  Open a ledger writable: create:false always, no key directory is named, nothing is appended. A ledger
//           that is absent, does not verify, or is pinned to another anchor is UNAVAILABLE (the projection records it),
//           never created, repaired or re-pinned.
import fs from 'node:fs';
import path from 'node:path';
import {entityId} from '../../../packages/graph/index.mjs';
import {openStatusLedger} from '../../../packages/ledger/status.mjs';
import {openWorkLedger} from '../../operate/work-ledger.mjs';
import {openLedgerReadOnly, listCycles} from '../../public/provenance.mjs';
import {deriveCycle, closeClaim} from '../../../pantheon/src/ledger/cycle-kinds.mjs';

export const EXTRACTOR = 'ophanim.ledgers.extractor';
export const STATUS_SOURCE = 'ophanim.status', WORK_SOURCE = 'ophanim.work', CYCLE_SOURCE = 'ophanim.cycle';
export const LEDGERS_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [STATUS_SOURCE, WORK_SOURCE, CYCLE_SOURCE]});
/** The status ledger's genesis as committed in this repository (status/ledger/ANCHOR; docs/STATUS.md). */
export const STATUS_ANCHOR = 'sha256:816a79525846cb2ade6173260237f1236cd5bea103d9027be51ea2981a2b536d';
const HASH = /^sha256:[0-9a-f]{64}$/;
const hex = h => h.slice('sha256:'.length);
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
export const itemId = item => entityId({domain: 'work', type: 'item', key: item});
export const statusRecordId = h => entityId({domain: 'evidence', type: 'record', key: `status/${hex(h)}`});
const E = (domain, type, key) => entityId({domain, type, key});

/** The entries of a verified ledger up to and including `version` (its head when this was read): [{hash, entry, payload}]. */
function prefixTo(ledger, version) {
  if (!HASH.test(version ?? '')) throw new Error(`${version} is not a ledger entry hash`);
  const all = ledger.read(), out = [];
  for (const e of all) {
    const h = ledger.hashOf(e);
    out.push({hash: h, entry: e, payload: ledger.payloadOf(e)});
    if (h === version) return out;
  }
  throw new Error(`entry ${version} is not on this ledger`);
}
const viewOf = rows => {
  const by = new Map(rows.map(r => [r.hash, r]));
  return {entry: h => by.get(h)?.entry ?? null, payload: h => by.get(h)?.payload ?? null, entries: () => rows.map(r => r.hash)};
};

// ---- the status ledger ----------------------------------------------------------------------------------------------
/** Open the status ledger at `root` READ ONLY against `anchor`: never creates, never names a key directory. */
export function readStatusLedger({root, anchor}) {
  if (!root || !path.isAbsolute(root)) throw new Error('the status ledger is read at an absolute root');
  return openStatusLedger({root, anchor, create: false, keys: null});
}

/** The status facts of the chain that ends at `version`. */
export function statusFacts(S, version) {
  const rows = prefixTo(S.ledger, version).filter(r => r.entry.kind === 'status');
  const latest = new Map(), count = new Map(), prevOf = new Map(), drafts = [];
  for (const r of rows) {
    const p = r.payload, prev = latest.get(p.item)?.hash ?? null;
    prevOf.set(r.hash, prev);
    latest.set(p.item, r);
    count.set(p.item, (count.get(p.item) ?? 0) + 1);
    drafts.push({entity: statusRecordId(r.hash), ref: `status/ledger#${r.hash}`, attributes: {entry: r.hash, seq: r.entry.seq, item: p.item, state: p.state,
      checked: p.checked, basis: cut(p.basis, 600), waiting_on: p.waiting_on ?? null}});
    if (prev) drafts.push({type: 'derived-from', from: statusRecordId(r.hash), to: statusRecordId(prev), ref: `status/ledger#${r.hash}`, attributes: {basis: 'the entry cites the item\'s previous status'}});
  }
  const named = new Set();
  for (const [item, r] of latest) {
    const p = r.payload;
    drafts.push({entity: itemId(item), ref: `status/ledger#${r.hash}`, attributes: {item, title: cut(p.title, 300), state: p.state, basis: cut(p.basis, 600), checked: p.checked,
      waiting_on: p.waiting_on ?? null, depends_on: p.depends_on ?? [], owner_role: p.owner_role ?? null, entry: r.hash, entries: count.get(item),
      evidence: p.evidence ? {commit: p.evidence.commit ?? null, schema: p.evidence.schema ?? null, tests: p.evidence.tests ?? null} : null}});
    drafts.push({type: 'derived-from', from: itemId(item), to: statusRecordId(r.hash), ref: `status/ledger#${r.hash}`, attributes: {basis: 'the item\'s latest status'}});
    for (const d of p.depends_on ?? []) {
      if (!latest.has(d)) named.add(d);
      drafts.push({type: 'depends-on', from: itemId(item), to: itemId(d), ref: `status/ledger#${r.hash}`, attributes: {basis: 'the status names this dependency'}});
    }
  }
  for (const d of [...named].sort()) drafts.push({entity: itemId(d), ref: 'status/ledger', status: 'unresolved', attributes: {item: d},
    missing_evidence: ['named as a dependency, but the status ledger holds no status for this item']});
  return drafts;
}

/** The status ledger as a source: version = its head entry hash, read through openStatusLedger with create:false. */
export function statusSource({root, anchor = STATUS_ANCHOR, extractor = EXTRACTOR}) {
  return {
    id: STATUS_SOURCE, extractor, ref: 'status/ledger',
    authority: 'the status ledger (packages/ledger/status.mjs; owner-signed, append-only; read only against its pinned anchor)',
    current: () => { const b = readStatusLedger({root, anchor}).board(); if (!b.head) throw new Error('the status ledger has no entry'); return {version: b.head}; },
    readAt: version => statusFacts(readStatusLedger({root, anchor}), version),
  };
}

// ---- the work ledger ------------------------------------------------------------------------------------------------
export function readWorkLedger({root, anchor}) {
  if (!root || !path.isAbsolute(root)) throw new Error('the work ledger is read at an absolute root');
  if (!anchor) throw new Error('the work ledger is read against a pinned anchor');
  return openWorkLedger({root, anchor, create: false, keys: null});
}

/** The work facts of the chain that ends at `version`. */
export function workFacts(W, version) {
  const rows = prefixTo(W.ledger, version), drafts = [], items = new Set(), released = new Map();
  for (const r of rows) if (r.entry.kind === 'work.release') for (const c of r.entry.derived_from) released.set(c, r.payload.outcome);
  for (const r of rows) {
    const p = r.payload, ref = `status/work#${r.hash}`;
    if (r.entry.kind === 'work.claim') {
      items.add(p.item);
      drafts.push({entity: E('work', 'lease', hex(r.hash)), ref, attributes: {claim: r.hash, item: p.item, stage: p.stage, attempt: p.attempt, holder: cut(p.holder, 120),
        leased_at: p.leased_at, lease_ms: p.lease_ms, released: released.get(r.hash) ?? null}});
      drafts.push({type: 'depends-on', from: E('work', 'lease', hex(r.hash)), to: itemId(p.item), ref, attributes: {basis: 'the claim names its item'}});
    } else if (r.entry.kind === 'work.stage') {
      const item = p.identity?.item;
      if (typeof item !== 'string') continue;
      items.add(item);
      const S = E('work', 'execution', hex(r.hash));
      drafts.push({entity: S, ref, attributes: {record: r.hash, item, stage: p.stage, status: p.status, attempt: p.attempt ?? null, at: p.at ?? null, next: p.next ?? null,
        blocker: p.blocker?.code ?? null, findings: Array.isArray(p.findings) ? p.findings.length : 0}});
      drafts.push({type: 'depends-on', from: S, to: itemId(item), ref, attributes: {basis: 'the stage record names its item'}});
      const claim = r.entry.derived_from[0], from = p.handoff?.from ?? null;
      if (claim && rows.some(x => x.hash === claim && x.entry.kind === 'work.claim')) drafts.push({type: 'derived-from', from: S, to: E('work', 'lease', hex(claim)), ref, attributes: {basis: 'recorded under this claim'}});
      if (from && rows.some(x => x.hash === from && x.entry.kind === 'work.stage')) drafts.push({type: 'derived-from', from: S, to: E('work', 'execution', hex(from)), ref, attributes: {basis: 'the handoff it received'}});
    }
  }
  for (const i of [...items].sort()) drafts.push({entity: itemId(i), ref: 'status/work', attributes: {named_by_work_ledger: true}});
  return drafts;
}

export function workSource({root, anchor, extractor = EXTRACTOR}) {
  return {
    id: WORK_SOURCE, extractor, ref: 'status/work',
    authority: 'the work ledger (ophanim/operate/work-ledger.mjs; controller-signed, append-only; read only against its pinned anchor)',
    current: () => { const v = readWorkLedger({root, anchor}).verify(); if (!v.ok) throw new Error(`the work ledger does not verify: ${v.why}`); return {version: v.head}; },
    readAt: version => workFacts(readWorkLedger({root, anchor}), version),
  };
}

// ---- the review-cycle ledger ----------------------------------------------------------------------------------------
export function readCycleLedger({root, anchor}) {
  if (!anchor) throw new Error('the cycle ledger is read against a pinned anchor');
  if (!fs.existsSync(path.join(root ?? '', 'chain.jsonl'))) throw new Error('no cycle ledger there');
  return openLedgerReadOnly({root, anchor});
}

/** The cycle facts of the chain that ends at `version`. */
export function cycleFacts(C, version) {
  const rows = prefixTo(C.ledger, version), view = viewOf(rows), drafts = [];
  for (const c of listCycles(view)) {
    const st = deriveCycle(view, c.hash), R = E('work', 'review', hex(c.hash)), ref = `cycle#${c.hash}`, claim = st.close ? null : closeClaim(st);
    const closed = st.close ? view.payload(st.close) : null;
    drafts.push({entity: R, ref, attributes: {cycle: c.hash, scope: c.scope, ordinal: c.ordinal, base: c.base ?? null, head: c.head ?? null,
      files: (st.cycle.files ?? []).slice(0, 64), reviewers: st.cycle.reviewers ?? null, required_reviewers: st.cycle.required_reviewers ?? null,
      reviews: st.reviews.map(r => ({lab: r.lab, verdict: r.verdict, model: r.model, served_model: r.served_model})),
      closed: Boolean(st.close), outcome: closed?.outcome ?? closed?.claim?.outcome ?? null,
      would_close: claim ? (claim.why ? {no: cut(claim.why, 300)} : {outcome: claim.claim?.outcome ?? null}) : null}});
    for (const f of st.findings) {
      const F = E('learning', 'finding', hex(f.hash)), res = st.resolutions.get(f.hash)?.payload ?? null;
      drafts.push({entity: F, ref: `cycle#${f.hash}`, attributes: {finding: f.hash, cycle: c.hash, severity: f.payload.severity ?? null, claim: cut(f.payload.claim, 400),
        file: f.payload.file ?? null, line: f.payload.line ?? null, resolution: res ? {status: res.status, commit: res.fix?.commit ?? null} : null}});
      drafts.push({type: 'derived-from', from: F, to: R, ref: `cycle#${f.hash}`, attributes: {basis: 'a finding of this cycle'}});
    }
  }
  return drafts;
}

export function cycleSource({root, anchor, extractor = EXTRACTOR}) {
  return {
    id: CYCLE_SOURCE, extractor, ref: 'cycle ledger',
    authority: 'a review-cycle ledger (pantheon/src/ledger/cycle-kinds.mjs; read only against its pinned anchor)',
    current: () => ({version: readCycleLedger({root, anchor}).head}),
    readAt: version => cycleFacts(readCycleLedger({root, anchor}), version),
  };
}
