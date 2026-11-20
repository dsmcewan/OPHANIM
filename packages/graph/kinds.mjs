// The graph ledger domain (KD7, KD11; docs/knowledge-graph/architecture.md "Storage and keys").
//
// Kinds graph.assert, graph.retract and graph.supersede in a `graph` domain on packages/ledger's chain: signed by each
// entry's author and co-signed by the orderer, hash-chained, append-only, one writer at a time under the ledger's lock,
// every entry re-derived before it is written and on every verify. Re-derivation is the projection's: schema, the
// origin registry, referential integrity, admission and the cursor rule (projection.mjs). Nothing is deleted:
// supersession and retraction are new entries, and history stays queryable.
//
// Signing takes the signer and orderer interface the other ledgers use (packages/ledger generateSigner, keyStore).
// WHICH key signs which origin, and who holds it, is the owner's decision: this file names no production key.
//
// openGraph() is the writer and reader: it replays the ledger into a projection (the ledger's verify IS the replay),
// and appends through the ledger's append discipline. A repeated assertion is a no-op; a write that loses a race to
// another process is refused under the lock and recomputed on the newer state; nothing is lost.
// recoverGraph() opens a ledger that verifies as it is; one that does not is never repaired: it is set aside whole and
// a new one is built from the registered sources (carried from pull request 70).
import fs from 'node:fs';
import path from 'node:path';
import {createLedger, openLedger, defineKinds} from '../ledger/chain.mjs';
import {digest} from '../ledger/canonical.mjs';
import {DEFAULT_INSTANCE} from './identity.mjs';
import {GRAPH_SCHEMA, KINDS, payloadRefusal} from './schema.mjs';
import {createProjection} from './projection.mjs';
import {observationOf, changeEvents, freshness as freshnessOf} from './events.mjs';

export const GRAPH_DOMAIN = 'graph';
const refused = (why, code = 'GRAPH_REFUSED') => Object.assign(new Error(why), {code});
const RETRY = /does not re-derive: GRAPH_(DUPLICATE|STALE|REFERENCE|SOURCE)/;

/** The graph kinds for a ledger, re-derived by `projection` under the composed `origins`. */
export function graphKinds({projection, origins}) {
  const keys = new Set(Object.values(origins).flatMap(o => o.keys));
  const kind = name => ({
    authors: a => keys.has(a?.key_id),
    validate: p => payloadRefusal(name, p, {origins}),
    rederive: (e, view) => projection.sync(e, view),
  });
  return defineKinds(Object.fromEntries(KINDS.map(k => [k, kind(k)])));
}

/** Create a graph ledger (its genesis declares the graph domain); returns the anchor readers pin. */
export function createGraphLedger({dir, authority, operator, order}) {
  return createLedger({dir, authority: {...authority, domains: {...(authority.domains ?? {}), [GRAPH_DOMAIN]: [...KINDS]}}, operator, order});
}

/**
 * Open the graph ledger at `dir`, pinned to `anchor`, and replay it. `origins`: the origin registry
 * (defineOrigins); `sources`: the registered source adapters. Throws GRAPH_CORRUPT if the ledger does not verify.
 */
export function openGraph({dir, anchor, origins, sources = [], instance = DEFAULT_INSTANCE, checkpointEvery = 64,
  lockTimeoutMs = 10_000, lockStaleMs = 600_000, log = () => {}}) {
  const projection = createProjection({instance, origins, sources});
  const ledger = openLedger({dir, kinds: graphKinds({projection, origins}), anchor, checkpointEvery, lockTimeoutMs, lockStaleMs, log});
  let verification;
  function refresh({mode = 'frontier'} = {}) {
    let v;
    try { v = ledger.verify({mode}); } catch (e) { throw refused(`the graph ledger does not verify: ${e.message}`, 'GRAPH_CORRUPT'); }
    if (!v.ok) throw refused(`the graph ledger does not verify: ${v.why}`, v.why.startsWith('entry 0:') ? 'GRAPH_FOREIGN' : 'GRAPH_CORRUPT');
    const notes = projection.catchUp(ledger.read(), ledger.payloadOf);
    verification = {ok: true, entries: v.entries, head: v.head, rederived: v.rederived, partial: v.partial, complete: v.complete, notes};
    return verification;
  }
  refresh({mode: 'full'});

  /**
   * Append records (or retractions) of `kind` as `signer` (the author's key) co-signed by `order`. Records the graph
   * already holds are dropped first; if none is left the write is a no-op. Refused records throw GRAPH_REFUSED. A write
   * refused under the lock because another process got there first is recomputed on the newer state.
   */
  function write(kind, items, {signer, order} = {}) {
    if (!signer?.key_id || !order?.key_id) throw refused('a graph write names its signer and the orderer');
    const payloadOf = xs => (kind === 'graph.retract' ? {schema: GRAPH_SCHEMA, retractions: xs} : {schema: GRAPH_SCHEMA, records: xs});
    const bad = payloadRefusal(kind, payloadOf(items), {origins: projection.origins});
    if (bad) throw refused(bad);
    const author = {key_id: signer.key_id};
    let refreshed = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const fresh = items.filter(x => !projection.knows(x.id)), duplicates = items.filter(x => projection.knows(x.id)).map(x => x.id);
      if (!fresh.length) return {appended: false, ids: [], duplicates};
      const payload = payloadOf(fresh);
      const pre = projection.check({kind, author, payload, seq: projection.seq + 1});
      if (pre) {
        if (!refreshed) { refresh(); refreshed = true; continue; }
        throw refused(pre);
      }
      try {
        projection.expect('sha256:' + digest(payload));
        const r = ledger.append({kind, payload, author, signer, order});
        return {appended: true, hash: r.hash, seq: r.seq, ids: fresh.map(x => x.id), duplicates, ...(r.partial ? {partial: r.partial} : {})};
      } catch (e) {
        projection.expect(null);
        refresh(); refreshed = true;                       // also drops anything applied for a write that failed
        if (RETRY.test(e.message ?? '')) continue;
        throw e;
      } finally { projection.expect(null); }
    }
    throw refused('the graph kept moving under this writer; nothing of this write was applied', 'GRAPH_CONTENDED');
  }

  /**
   * Observe a registered source now: append its observation if the graph does not already hold this state of it.
   * {recorded, record, seq, event} or {recorded: false, why}.
   */
  function observe(sourceId, {signer, order, observed_at = new Date().toISOString(), effective_at = null} = {}) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const o = observationOf(projection, sourceId, {observed_at, effective_at});
      if (o.none) return {recorded: false, why: o.none};
      const kind = o.record.supersedes.length ? 'graph.supersede' : 'graph.assert';
      try {
        const w = write(kind, [o.record], {signer, order});
        if (!w.appended) return {recorded: false, why: `${sourceId}: this observation is already recorded`};
        return {recorded: true, record: o.record, seq: w.seq, state: o.record.attributes.state,
          event: changeEvents(projection, {after: w.seq - 1, limit: 1}).events[0] ?? null};
      } catch (e) {
        if (e.code === 'GRAPH_REFUSED' && /^GRAPH_(STALE|DUPLICATE)/.test(e.message)) { refresh(); continue; }
        throw e;
      }
    }
    throw refused(`${sourceId}: the source's cursor kept moving under this writer`, 'GRAPH_CONTENDED');
  }

  /**
   * BOUNDED FULL RECONCILIATION: replay the ledger from nothing into a fresh projection and compare it with this
   * (incremental) one at this one's cursor. {equal, cursor, incremental, replay, ahead, behind, differences, truncated}.
   * Nothing is changed.
   */
  function reconcile({limit = 100} = {}) {
    const fresh = createProjection({instance, origins: projection.origins, sources: [...projection.adapters.values()]});
    const L = openLedger({dir, kinds: graphKinds({projection: fresh, origins: projection.origins}), anchor, checkpointEvery, lockTimeoutMs, lockStaleMs, log});
    const v = L.verify();
    if (!v.ok) return {equal: false, why: `the ledger does not verify: ${v.why}`};
    fresh.catchUp(L.read(), L.payloadOf);
    const c = projection.seq, ahead = c > fresh.seq, rc = Math.min(c, fresh.seq);
    const inc = projection.at(c), rep = fresh.at(rc);
    const differences = [];
    let total = 0;
    const subjects = [...new Set([...inc.subjects(), ...rep.subjects()])].sort();
    for (const s of subjects) {
      const a = new Map(inc.query(s, 'recorded').map(x => [x.id, x])), b = new Map(rep.query(s, 'recorded').map(x => [x.id, x]));
      for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
        const x = a.get(id), y = b.get(id);
        const same = x && y && x.admitted === y.admitted && JSON.stringify(x.retired) === JSON.stringify(y.retired);
        if (same) continue;
        total++;
        if (differences.length < limit) differences.push({id, subject: s, incremental: x ? {admitted: x.admitted, retired: x.retired} : null, replay: y ? {admitted: y.admitted, retired: y.retired} : null});
      }
    }
    const di = inc.digest(), dr = rep.digest();
    return {equal: !ahead && di === dr && total === 0, cursor: c, incremental: {seq: c, digest: di}, replay: {seq: fresh.seq, digest: dr},
      ahead, behind: fresh.seq - rc, differences, total, truncated: total > differences.length};
  }

  return {
    dir, anchor, instance, ledger, projection,
    get verification() { return verification; },
    refresh, write,
    assert: (records, by) => write('graph.assert', records, by),
    supersede: (records, by) => write('graph.supersede', records, by),
    retract: (retractions, by) => write('graph.retract', retractions, by),
    observe, reconcile,
    view: cursor => projection.at(cursor),
    events: (opts = {}) => changeEvents(projection, opts),
    freshness: () => freshnessOf(projection),
    digest: cursor => projection.at(cursor).digest(),
  };
}

/**
 * RECOVERY (carried from pull request 70). Open the graph at `dir` if its ledger verifies under `anchor`. If it does
 * not, it is NEVER repaired: the directory is renamed aside whole (`<dir>.set-aside-<n>`, kept for inspection) and a
 * new graph ledger is created with `create` ({authority, operator, order}) and rebuilt by observing every registered
 * source as `observeAs` ({signer, order}). What the sources re-derive is rebuilt; what only the set-aside ledger held
 * (hypothetical, observed and derived assertions) is not trusted and not carried over. A ledger pinned to another
 * anchor (GRAPH_FOREIGN) is not ours to set aside and is refused.
 */
export function recoverGraph({dir, anchor, create, observeAs, observed_at, ...opts}) {
  let set_aside = null, why = null;
  if (anchor && fs.existsSync(path.join(dir, 'chain.jsonl'))) {
    try { return {graph: openGraph({dir, anchor, ...opts}), rebuilt: false, set_aside, anchor}; }
    catch (e) {
      if (e.code !== 'GRAPH_CORRUPT' && e.code !== 'GRAPH_REPLAY') throw e;
      why = e.message;
    }
    let n = 1;
    while (fs.existsSync(`${dir}.set-aside-${n}`)) n++;
    set_aside = `${dir}.set-aside-${n}`;
    fs.renameSync(dir, set_aside);
  }
  if (!create) throw refused('recovery needs the authority to create a new graph ledger (create: {authority, operator, order})', 'NO_AUTHORITY');
  fs.mkdirSync(dir, {recursive: true});
  const fresh = createGraphLedger({dir, ...create});
  const graph = openGraph({dir, anchor: fresh, ...opts});
  const observed = {};
  for (const s of [...graph.projection.adapters.keys()].sort()) observed[s] = graph.observe(s, {...observeAs, observed_at});
  return {graph, rebuilt: true, set_aside, why, anchor: fresh, previous_anchor: anchor ?? null, observed};
}
