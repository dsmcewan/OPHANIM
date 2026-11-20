// THE GRAPH'S PROJECTION LEDGER AND ITS FOLD (docs/knowledge-graph/architecture.md).
//
// Purpose   Keep what the extractors read out of the authoritative sources, as an append-only, hash-chained ledger of
//           batches (packages/ledger: its chain, lock, fsync and re-derivation), and fold it into one in-memory
//           projection that can be asked what holds now and what held at any earlier point.
// Inputs    A root directory; the instance's name; batches {source, from, to, ops} from the projector (project.mjs).
// Outputs   {sync, commit, projection, at, verify, head}.
// Invariants
//   - It is a PROJECTION. Nothing here is an authority over a fact: a batch says "this was read from that source at
//     that version". The sources stay where they are, and a graph that is lost is rebuilt from them (project.mjs).
//   - One batch per step of one source's cursor. A batch is admitted only when it starts where that source's last
//     batch ended, so two writers cannot both apply the same change, apply changes out of order, or lose one.
//   - An assertion is never deleted. A later statement in the same slot supersedes it; a statement the source no
//     longer makes is retracted. Both stay in the history with the batch that ended them.
//   - Every assertion passed the contract (contract.mjs) when it was appended and passes it again on every verify.
// Must never  Be read as the authority for work, status, evidence or routing; be written by anything but a holder of
//           the projector key; repair a chain that does not verify (it is set aside whole and rebuilt).
import fs from 'node:fs';
import path from 'node:path';
import {createLedger, openLedger, defineKinds, generateSigner, keyStore, digest} from '../../packages/ledger/index.mjs';
import {GRAPH_SCHEMA, CLASSES, assertionRefusal, slotOf, aidOf, subjectOf, cursorOk, parseId} from './contract.mjs';

export const BATCH_KIND = 'graph.batch';
const str = v => typeof v === 'string' && v.length > 0;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (message, code = 'GRAPH') => { throw Object.assign(new Error(message), {code}); };
const rank = c => CLASSES.indexOf(c);

function batchRefusal(p) {
  if (p?.schema !== GRAPH_SCHEMA || !str(p.instance) || !str(p.source) || p.source.length > 120 || !cursorOk(p.from) || !str(p.to) || !cursorOk(p.to) || !str(p.at) || Number.isNaN(Date.parse(p.at)) || !Array.isArray(p.ops)) {
    return 'a graph batch names {schema, instance, source, from, to, at, ops}';
  }
  for (const [i, op] of p.ops.entries()) {
    if (op?.op === 'assert') {
      const bad = assertionRefusal(op.a, {instance: p.instance, foreign: p.source.startsWith('federation:')});
      if (bad) return `op ${i}: [${bad.code}] ${bad.why}`;
    } else if (op?.op === 'retract') {
      if (!/^sha256:[0-9a-f]{64}$/.test(op.slot ?? '') || !str(op.why)) return `op ${i}: a retraction names the slot and why`;
    } else return `op ${i}: an op asserts or retracts`;
  }
  return null;
}

const kinds = ({operators}) => ({
  [BATCH_KIND]: {
    authors: a => operators.includes(a.key_id),
    validate: batchRefusal,
    // THE CURSOR RULE: a batch continues its own source from where that source's last batch left it.
    rederive: (e, view) => {
      let last = null;
      for (const h of view.entries()) { const x = view.entry(h); if (x?.kind === BATCH_KIND && h !== e.hash) { const p = view.payload(h); if (p.source === e.payload.source) last = p; } }
      const at = last?.to ?? null;
      if (e.payload.from !== at) return `the batch of ${e.payload.source} starts at ${JSON.stringify(e.payload.from)}, and that source is at ${JSON.stringify(at)}`;
      if (last && last.instance !== e.payload.instance) return 'a graph ledger belongs to one instance';
      return null;
    },
  },
});

/**
 * Fold batches (in chain order) into a projection. `upTo` stops after that many batches: the graph as it was.
 * A record: {a, aid, slot, source, from_seq, to_seq, ended: null | {by: 'superseded'|'retracted', why, aid?}}.
 */
export function fold(batches, {upTo = Infinity} = {}) {
  const current = new Map(), history = [], cursors = new Map(), bySource = new Map();
  let seq = 0, instance = null;
  const end = (rec, how) => { rec.to_seq = seq; rec.ended = how; current.delete(rec.slot); bySource.get(rec.source)?.delete(rec.slot); };
  for (const b of batches) {
    if (seq >= upTo) break;
    seq += 1; instance ??= b.instance;
    for (const op of b.ops) {
      if (op.op === 'retract') { const rec = current.get(op.slot); if (rec && rec.source === b.source) end(rec, {by: 'retracted', why: op.why}); continue; }
      const slot = slotOf(op.a), aid = aidOf(op.a), had = current.get(slot);
      if (had?.aid === aid) continue;                         // the same statement again: nothing changes
      if (had) end(had, {by: 'superseded', aid, why: 'a later version of the same source'});
      const rec = {a: op.a, aid, slot, source: b.source, from_seq: seq, to_seq: null, ended: null, at: b.at};
      current.set(slot, rec); history.push(rec);
      if (!bySource.has(b.source)) bySource.set(b.source, new Map());
      bySource.get(b.source).set(slot, rec);
    }
    cursors.set(b.source, b.to);
  }
  return projectionOf({instance, seq, current, history, cursors, bySource});
}

function projectionOf({instance, seq, current, history, cursors, bySource}) {
  const entities = new Map(), out = new Map(), inn = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const rec of current.values()) {
    if (rec.a.kind === 'entity') push(entities, rec.a.id, rec);
    else { push(out, rec.a.from, rec); push(inn, rec.a.to, rec); }
  }
  const strongestFirst = (x, y) => rank(y.a.class) - rank(x.a.class) || (x.aid < y.aid ? -1 : 1);
  const P = {
    instance, seq,
    cursor: source => cursors.get(source) ?? null,
    sources: () => [...cursors.keys()].sort(),
    records: () => [...current.values()],
    history: () => [...history],
    assertionsOf: source => [...(bySource.get(source)?.values() ?? [])],
    has: id => entities.has(id),
    ids: () => [...entities.keys()].sort(),
    /**
     * One entity as every source describes it. Each attribute's value is the strongest class's; where sources of the
     * SAME strength disagree, or a weaker one disagrees with a stronger one, the disagreement is listed in `conflicts`
     * and nothing is dropped. A hypothesis never changes the value an observation or an authority gave.
     */
    entity(id) {
      const recs = [...(entities.get(id) ?? [])].sort(strongestFirst);
      const p = parseId(id);
      if (!recs.length) return p ? {id, ...p, exists: false, unresolved: true, attrs: {}, assertions: [], conflicts: []} : null;
      const attrs = {}, seen = new Map();
      for (const r of recs) for (const [k, v] of Object.entries(r.a.attrs ?? {})) {
        if (!seen.has(k)) { seen.set(k, []); attrs[k] = v; }
        seen.get(k).push({value: v, class: r.a.class, status: r.a.status, source: r.a.source, origin: r.a.origin, aid: r.aid});
      }
      const conflicts = [...seen.entries()].filter(([, vs]) => new Set(vs.map(x => JSON.stringify(x.value))).size > 1).map(([attr, values]) => ({attr, values}));
      return {id, ...p, exists: true, unresolved: false, attrs, class: recs[0].a.class, status: recs[0].a.status, scope: recs.map(r => r.a.scope ?? 'internal').sort((a, b) => ['shared', 'internal', 'restricted'].indexOf(b) - ['shared', 'internal', 'restricted'].indexOf(a))[0],
        assertions: recs, conflicts};
    },
    out: (id, rel = null) => (out.get(id) ?? []).filter(r => !rel || r.a.rel === rel),
    in: (id, rel = null) => (inn.get(id) ?? []).filter(r => !rel || r.a.rel === rel),
    relations: ({rel = null, from = null, to = null} = {}) => [...current.values()].filter(r => r.a.kind === 'relation' && (!rel || r.a.rel === rel) && (!from || r.a.from === from) && (!to || r.a.to === to)),
    /** Edges one of whose ends no source describes: kept, named, and never passed off as resolved. */
    unresolved: () => [...current.values()].filter(r => r.a.kind === 'relation' && (!entities.has(r.a.from) || !entities.has(r.a.to)))
      .map(r => ({rel: r.a.rel, from: r.a.from, to: r.a.to, missing: [r.a.from, r.a.to].filter(x => !entities.has(x)), source: r.a.source, aid: r.aid})),
    /** What holds now, as one digest: the same sources at the same versions give the same digest, however they got here. */
    digest: () => 'sha256:' + digest([...current.values()].map(r => r.aid).sort()),
    /** What changed after batch `since`: the assertions that began and the ones that ended. */
    changesSince: since => ({began: history.filter(r => r.from_seq > since), ended: history.filter(r => r.to_seq !== null && r.to_seq > since)}),
  };
  return P;
}

/** The ops that take `have` (the current records of one source, or of the refs given) to `want` (assertions). */
export function diffOps(have, want, {why = 'the source no longer states it'} = {}) {
  const wanted = new Map();
  for (const a of want) wanted.set(slotOf(a), a);       // the last statement of a slot in one reading wins
  const ops = [];
  const held = new Map(have.map(r => [r.slot, r]));
  for (const [slot, a] of [...wanted.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) if (held.get(slot)?.aid !== aidOf(a)) ops.push({op: 'assert', a});
  for (const slot of [...held.keys()].sort()) if (!wanted.has(slot)) ops.push({op: 'retract', slot, why});
  return ops;
}

/**
 * Open (or, with `create`, start) the graph ledger at `root` for `instance`. The projector's keys live under
 * <root>/keys; a reader without them can verify and query, never write (NO_AUTHORITY).
 */
export function openGraph({root, instance, create = true, keys = null}) {
  if (!root || !path.isAbsolute(root)) fail('an absolute graph root is required');
  const anchorFile = path.join(root, 'ANCHOR'), keysDir = keys ?? path.join(root, 'keys'), nameFile = path.join(root, 'INSTANCE');
  if (!fs.existsSync(anchorFile)) {
    if (!create) fail(`no graph ledger at ${root}`, 'NO_GRAPH');
    if (fs.existsSync(path.join(root, 'chain.jsonl'))) fail('a graph ledger without its ANCHOR is not opened');
    if (!parseId(`${instance}:work:item:x`)) fail(`"${instance}" is not an instance name`);
    fs.mkdirSync(root, {recursive: true});
    const store = keyStore(keysDir);
    const op = store.put(generateSigner('projector')), order = store.put(generateSigner('graph-orderer'));
    const pinned = createLedger({dir: root, operator: op, order, authority: {keyring: {projector: op.publicJwk, 'graph-orderer': order.publicJwk}, orderer: 'graph-orderer', operators: ['projector']}});
    fs.writeFileSync(nameFile, instance + '\n');
    fs.writeFileSync(anchorFile, pinned + '\n');
  }
  const pinned = fs.readFileSync(anchorFile, 'utf8').trim(), named = fs.readFileSync(nameFile, 'utf8').trim();
  if (instance && instance !== named) fail(`the graph ledger at ${root} belongs to instance "${named}", not "${instance}"`, 'GRAPH_FOREIGN_INSTANCE');
  let operators = ['projector'];
  const open = () => openLedger({dir: root, kinds: defineKinds(kinds({operators})), anchor: pinned});
  let L = open();
  const state = L.verify();
  if (!state.ok) fail(`the graph ledger does not verify: ${state.why}`, 'GRAPH_CORRUPT');
  operators = state.authority.operators;
  L = open();
  const batches = () => L.read().filter(e => e.kind === BATCH_KIND).map(e => L.payloadOf(e));
  const signers = () => {
    const store = fs.existsSync(keysDir) ? keyStore(keysDir) : null;
    const op = store ? operators.map(id => store.get(id)).find(Boolean) : null, order = store?.get(state.authority.orderer) ?? null;
    if (!op || !order) fail('no projector key is held here: the graph can be verified and queried, not changed', 'NO_AUTHORITY');
    return {op, order};
  };
  const projection = () => fold(batches());

  /**
   * Append one batch: {applied: true, seq} | {applied: false, why: 'already-applied' | 'stale'}. A batch whose `from` is
   * not where the source stands is not written: it was applied already (the source is at `to`), or another writer got
   * there first (`stale`: read again and compute the change again).
   */
  function commit({source, from, to, at, ops}) {
    const payload = {schema: GRAPH_SCHEMA, instance: named, source, from, to, at, ops};
    const bad = batchRefusal(payload);
    if (bad) fail(bad, 'GRAPH_REFUSED');
    const {op, order} = signers();
    try {
      L.append({kind: BATCH_KIND, payload, author: {key_id: op.key_id}, signer: op, order, derivedFrom: []});
      return {applied: true, ops: ops.length};
    } catch (e) {
      const m = /starts at .*, and that source is at (.*)$/.exec(String(e?.message ?? ''));
      if (!m) throw e;
      return {applied: false, why: m[1] === JSON.stringify(to) ? 'already-applied' : 'stale', at: m[1]};
    }
  }

  /**
   * Bring `source` to cursor `to`: `assertions` is everything the source states now (or, with `refs`, everything it
   * states under those references; statements under other references are left as they are). Idempotent: the same
   * reading again changes nothing. Raced by another writer, it reads again and recomputes, a bounded number of times.
   */
  function sync(source, to, assertions, {at, refs = null, why} = {}) {
    for (const a of assertions) { const bad = assertionRefusal(a, {instance: named, foreign: source.startsWith('federation:')}); if (bad) fail(`${source}: [${bad.code}] ${bad.why}`, bad.code); }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const p = projection(), from = p.cursor(source);
      const have = p.assertionsOf(source).filter(r => !refs || refs.includes(r.a.source.ref));
      const ops = diffOps(have, assertions, {why});
      if (!ops.length && from === to) return {applied: false, why: 'already-applied', ops: 0, from, to};
      const r = commit({source, from, to, at: at ?? new Date().toISOString(), ops});
      if (r.applied) return {...r, from, to};
      if (r.why === 'already-applied' && !ops.length) return {...r, ops: 0, from, to};
    }
    fail(`${source}: the graph kept moving under this writer; nothing of this reading was applied`, 'GRAPH_CONTENDED');
  }

  return {
    root, instance: named, anchor: pinned, commit, sync, projection,
    /** The graph as it was after `seq` batches. */
    at: seq => fold(batches(), {upTo: seq}),
    batches,
    verify: () => { const v = open().verify(); return {ok: v.ok, why: v.why ?? null, head: v.head ?? null, batches: v.ok ? batches().length : null}; },
    canWrite: () => { try { signers(); return true; } catch { return false; } },
  };
}

export {subjectOf};
