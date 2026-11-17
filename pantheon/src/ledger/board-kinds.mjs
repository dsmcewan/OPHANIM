// The board's runtime records on the ledger: lease rows, budget limits and ref moves.
//
// Pantheon keeps these beside the DAG (runtime/leases.json, runtime/budget.json, refs/ and the reflog),
// mutable by design and never hashed into a commit. That is right for identity and wrong for evidence:
// an edited lease row, a raised cap or a ref moved by hand leaves nothing to check. Here each change is
// an entry that cites the previous entry for the same thing, so the records form one chain per lease,
// per budget and per ref, and re-derive:
//
//   lease     {scope, resource, event, gen, holder, when, expires_at?, reason?, state?}
//             generation monotonic per resource; holder and expiry consistent with the previous entry
//   budget    {scope, limits, declared_at}
//             a new cap is a new entry citing the previous one; spend stays bound to commits (runtime.mjs)
//   ref.move  {scope, name, from, to, msg, by, reset}
//             `from` is where the previous move left the ref; `to` is a commit in the board's store whose
//             history contains `from`, unless the move is a recorded reset
//
// `scope` names the board (its root), so a ledger shared by several boards keeps their chains apart.
// The files stay for display and for the runtime's own reads; with a ledger, the runtime records here
// first and refuses the change when the ledger does (pantheon/src/board/runtime.mjs, refs.mjs).
import fs from 'node:fs';
import path from 'node:path';
import {openStore} from '../board/cas.mjs';

export const LEASE = 'lease', BUDGET = 'budget', REF_MOVE = 'ref.move';
const EVENTS = ['observed', 'granted', 'renewed', 'released', 'expired', 'fenced'];
const ACTIVE_EVENTS = new Set(['granted', 'renewed', 'fenced']);
const COMMIT = /^commit:[0-9a-f]{64}$/;
const ISO = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const KEY = {
  [LEASE]: p => `${p.scope}\u0000${p.resource}`,
  [BUDGET]: p => p.scope,
  [REF_MOVE]: p => `${p.scope}\u0000${p.name}`,
};
export const leaseActive = p => ACTIVE_EVENTS.has(p.event) || (p.event === 'observed' && p.state === 'active');

// Payloads are content-addressed, so a payload read once (and hash-checked by the view) can be kept.
function payloads() {
  const cache = new Map();
  return (view, h) => {
    const e = view.entry(h);
    if (!e) return null;
    if (cache.has(e.payload_ref)) return cache.get(e.payload_ref);
    const p = view.payload(h);
    if (p !== null) cache.set(e.payload_ref, p);
    return p;
  };
}
const read = payloads();

/** The latest entry of `kind` for `key` before the entry being checked, or null. */
export function latestFor(view, kind, key) {
  const hs = view.entries();
  for (let i = hs.length - 1; i >= 0; i--) {
    if (view.entry(hs[i])?.kind !== kind) continue;
    const p = read(view, hs[i]);
    if (p && KEY[kind](p) === key) return {hash: hs[i], payload: p};
  }
  return null;
}

// Every entry cites the previous entry for the same lease, budget or ref, and only that one: a record
// that skips one, cites a stale one, or forks the chain does not re-derive.
function chained(e, view, kind) {
  const prev = latestFor(view, kind, KEY[kind](e.payload));
  const cites = e.derived_from.filter(h => view.entry(h)?.kind === kind);
  if (prev && (cites.length !== 1 || cites[0] !== prev.hash)) return {why: `does not cite the previous ${kind} entry for the same ${kind === REF_MOVE ? 'ref' : kind === LEASE ? 'resource' : 'board'}`};
  if (!prev && cites.length) return {why: `cites a ${kind} entry, but there is none earlier for the same ${kind === REF_MOVE ? 'ref' : 'resource'}`};
  return {prev: prev?.payload ?? null};
}

/** The lease table a scope's lease entries derive, as of the view: resource -> {hash, payload}. */
export function leaseTableAt(view, scope) {
  const out = new Map();
  for (const h of view.entries()) {
    if (view.entry(h)?.kind !== LEASE) continue;
    const p = read(view, h);
    if (p?.scope === scope) out.set(p.resource, {hash: h, payload: p});
  }
  return out;
}
/** The rows the LEASE gate reads (gate-kind leaseSnapshot's shape), from lease entries. */
export function leaseRows(table) {
  return Object.fromEntries([...table].filter(([, {payload: p}]) => leaseActive(p)).sort(([a], [b]) => a.localeCompare(b))
    .map(([r, {payload: p}]) => [r, {state: 'active', expires_at: p.expires_at, gen: p.gen, holder: {seat_id: p.holder.seat_id}}]));
}

/** Is `ancestor` in `commit`'s history? Stops at the first hit; bounded. */
function descends(store, commit, ancestor, limit = 100_000) {
  const queue = [commit], seen = new Set();
  while (queue.length && seen.size < limit) {
    const cid = queue.shift();
    if (cid === ancestor) return true;
    if (seen.has(cid)) continue;
    seen.add(cid);
    let c; try { c = store.get(cid); } catch { return false; }
    queue.push(...(c?.parents ?? []));
  }
  return false;
}

/**
 * The store a scope's ref moves are checked against: the board the ledger was opened with, else the
 * board at that root when one is there (read-only), else null (the move's chain is still checked, its
 * commits cannot be; see the doc's limits).
 */
export function storeResolver(board = null) {
  const opened = new Map();
  return scope => {
    if (board?.store && (board.root === undefined || board.root === scope)) return board.store;
    if (opened.has(scope)) return opened.get(scope);
    const s = typeof scope === 'string' && path.isAbsolute(scope) && fs.existsSync(path.join(scope, 'objects')) ? openStore(scope, {readOnly: true}) : null;
    opened.set(scope, s);
    return s;
  };
}

export function boardKinds({authors = () => true, board = null, stores = storeResolver(board)} = {}) {
  return {
    [LEASE]: {
      authors,
      validate: p => (typeof p?.scope === 'string' && typeof p.resource === 'string' && p.resource && EVENTS.includes(p.event)
        && Number.isInteger(p.gen) && p.gen > 0 && typeof p.holder?.seat_id === 'string' && ISO(p.when)
        && (!leaseActive(p) || ISO(p.expires_at))
        && (p.event !== 'fenced' || (typeof p.reason === 'string' && p.reason !== ''))
        && (p.event !== 'observed' || ['active', 'released', 'fenced'].includes(p.state))
        ? null : 'a lease entry names {scope, resource, event, gen, holder, when} and, while active, its expiry'),
      rederive: (e, view) => {
        const p = e.payload, c = chained(e, view, LEASE);
        if (c.why) return c.why;
        const prev = c.prev;
        if (prev && Date.parse(p.when) < Date.parse(prev.when)) return `the lease's time runs backwards (${prev.when} -> ${p.when})`;
        if (leaseActive(p) && p.event !== 'observed' && Date.parse(p.expires_at) <= Date.parse(p.when)) return 'an active lease expires no later than it was granted';
        switch (p.event) {
          case 'observed':
            return prev ? 'a lease is observed only when the ledger has no entry for it yet' : null;
          case 'granted':
            if (prev && leaseActive(prev)) return `gen ${prev.gen} is still active; it is released, expired or fenced first`;
            return prev && p.gen !== prev.gen + 1 ? `a grant after gen ${prev.gen} is gen ${prev.gen + 1}, not ${p.gen}` : null;
          case 'fenced':
            return prev && p.gen !== prev.gen + 1 ? `a fence after gen ${prev.gen} is gen ${prev.gen + 1}, not ${p.gen}` : null;
          default: {   // renewed, released, expired: the same generation, held by the same seat
            if (!prev) return `a lease is ${p.event} only after it was granted on the ledger`;
            if (!leaseActive(prev)) return `gen ${prev.gen} is no longer active (${prev.event})`;
            if (p.gen !== prev.gen) return `gen ${p.gen} is not the active gen ${prev.gen}`;
            if (p.holder.seat_id !== prev.holder.seat_id) return `gen ${p.gen} is held by ${prev.holder.seat_id}, not ${p.holder.seat_id}`;
            if (p.event === 'expired' && Date.parse(p.when) < Date.parse(prev.expires_at)) return `gen ${p.gen} does not expire until ${prev.expires_at}`;
            return null;
          }
        }
      },
    },
    [BUDGET]: {
      authors,
      validate: p => {
        if (typeof p?.scope !== 'string' || !p.limits || typeof p.limits !== 'object' || Array.isArray(p.limits) || !ISO(p.declared_at)) return 'a budget entry names {scope, limits, declared_at}';
        const {max_turns: t, max_usd: u} = p.limits;
        if (t !== undefined && !(Number.isInteger(t) && t >= 0)) return 'max_turns is a non-negative integer';
        if (u !== undefined && !(Number.isFinite(u) && u >= 0)) return 'max_usd is a non-negative number';
        return null;
      },
      rederive: (e, view) => {
        const c = chained(e, view, BUDGET);
        if (c.why) return c.why;
        return c.prev && Date.parse(e.payload.declared_at) < Date.parse(c.prev.declared_at) ? 'declared before the limit it replaces' : null;
      },
    },
    [REF_MOVE]: {
      authors,
      validate: p => (typeof p?.scope === 'string' && typeof p.name === 'string' && p.name.startsWith('refs/')
        // `to` is a commit, or null only for a recorded reset (an undone creation: the ref does not exist).
        && (p.from === null || COMMIT.test(p.from)) && (COMMIT.test(p.to) || (p.to === null && p.reset === true)) && typeof p.msg === 'string' && typeof p.by === 'string'
        && typeof p.reset === 'boolean'
        ? null : 'a ref move names {scope, name, from, to, msg, by, reset}'),
      rederive: (e, view) => {
        const p = e.payload, c = chained(e, view, REF_MOVE);
        if (c.why) return c.why;
        if (c.prev && p.from !== c.prev.to) return `${p.name} was left at ${String(c.prev.to).slice(0, 19)}, not ${String(p.from).slice(0, 19)}: it moved off the ledger`;
        const store = stores(p.scope);
        if (!store) return null;
        if (p.to !== null && !store.has(p.to)) return `${p.to.slice(0, 19)} is not a commit in this board's store`;
        if (p.from !== null && !store.has(p.from)) return `${p.from.slice(0, 19)} is not a commit in this board's store`;
        if (p.from !== null && !p.reset && !descends(store, p.to, p.from)) return `${p.to.slice(0, 19)} does not descend from ${p.from.slice(0, 19)}, and the move is not a recorded reset`;
        return null;
      },
    },
  };
}

/**
 * The board's recorder: what openRuntime and openRefs call when they hold a ledger. `scope` is the
 * board root. Every record cites the latest entry for the same thing; a refused record throws, and the
 * runtime then makes no change.
 */
export function boardRecorder({ledger, controller, order, scope}) {
  const by = {author: {key_id: controller.key_id}, signer: controller, order};
  const cache = new Map();
  const payload = e => {
    if (!cache.has(e.payload_ref)) cache.set(e.payload_ref, ledger.payloadOf(e));
    return cache.get(e.payload_ref);
  };
  const latest = (kind, key) => {
    const e = ledger.read().findLast(x => x.kind === kind && KEY[kind](payload(x) ?? {}) === key);
    return e ? {hash: ledger.hashOf(e), payload: payload(e)} : null;
  };
  const append = (kind, p) => {
    const prev = latest(kind, KEY[kind](p));
    return ledger.append({kind, payload: p, derivedFrom: prev ? [prev.hash] : [], ...by}).hash;
  };
  const row = l => ({holder: {seat_id: l.holder?.seat_id ?? null}});
  return {
    scope,
    /**
     * One lease change. `current` is the row before the change: a lease the ledger has never seen is
     * first recorded as `observed` (a signed input, as the gate's lease rows were), then changed.
     */
    recordLease(ev, current = null) {
      const p = {scope, resource: ev.resource, event: ev.event, gen: ev.gen, ...row(ev), when: ev.when,
        ...(ev.expires_at ? {expires_at: ev.expires_at} : {}), ...(ev.reason ? {reason: ev.reason} : {})};
      if (current && !latest(LEASE, KEY[LEASE](p))) {
        append(LEASE, {scope, resource: ev.resource, event: 'observed', state: current.state, gen: current.gen, ...row(current),
          when: ev.when, expires_at: current.expires_at});
      }
      return append(LEASE, p);
    },
    recordBudget(limits, declared_at) {
      return append(BUDGET, {scope, limits: JSON.parse(JSON.stringify(limits)), declared_at});
    },
    /** The declared limits as the ledger holds them, or null. */
    budget() {
      return latest(BUDGET, scope)?.payload ?? null;
    },
    recordRefMove({name, from, to, msg = '', by: who, reset = false}) {
      return append(REF_MOVE, {scope, name, from: from ?? null, to, msg: String(msg), by: String(who), reset: Boolean(reset)});
    },
    /** The latest lease entries of this board, for a `gate` entry to cite (gate-kind.mjs). */
    leaseCitations() {
      const out = new Map();
      for (const e of ledger.read()) {
        if (e.kind !== LEASE) continue;
        const p = payload(e);
        if (p?.scope === scope) out.set(p.resource, {hash: ledger.hashOf(e), payload: p});
      }
      return {scope, hashes: [...out.values()].filter(x => leaseActive(x.payload)).map(x => x.hash), rows: leaseRows(out)};
    },
  };
}
