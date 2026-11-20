// The projection (KD8, docs/knowledge-graph/architecture.md "Storage, replay and the projection").
//
// Inputs: the graph ledger's entries, in ledger order, and the registered sources they observed. A source's facts are
// NOT copied into the ledger: an observation entry records the source, the version observed, the digest of what the
// registered extractor projected there and the subjects that changed; replay asks the source for that version again
// (readAt) and re-derives the facts. So the ledger holds only what no source can re-derive, and the current state is
// reproducible from its recorded inputs. A source that cannot be read at replay is marked, never invented.
//
// State: every assertion ever admitted, with the ledger seq that admitted it and, once retired, the seq, how
// (superseded, retracted, invalidated, withdrawn by its source) and by what. Nothing is deleted. A view at any cursor
// (seq) is a filter over that history, so "as of" is exact. The projection digest commits to the cursor, the ledger
// head and every assertion's interval, sorted by id: the same records give the same digest in any process.
//
// The kinds (kinds.mjs) call sync() as their re-derivation, so the ledger's own verify() is the replay: an entry is
// checked against the state before it (duplicates, references, supersession, admission) and then applied.
import {digest, canonical} from '../ledger/canonical.mjs';
import {DEFAULT_INSTANCE, SHA256_REF} from './identity.mjs';
import {KINDS, GRAPH_SCHEMA, overrides, assertion, recordRefusal, factDigestOf, isSourceNode, sourceIdOf, changeDigest} from './schema.mjs';

const H = value => 'sha256:' + digest(value);
const GRAPH_KINDS = new Set(KINDS);
/** The entry as the chain stores it (without the payload the ledger attaches for re-derivation), and its hash. */
const storedOf = e => { const {payload, ...rest} = e; return rest; };
export const entryHash = e => H(storedOf(e));
const EPOCH = '1970-01-01T00:00:00Z';
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RANK = Object.freeze({authoritative: 0, observed: 1, derived: 2, hypothetical: 3});

/**
 * A projection over one graph ledger. `origins` is the composed origin registry (schema.mjs defineOrigins);
 * `sources` the registered source adapters: {id, authority, ref, extractor, current(), readAt(version)}.
 */
export function createProjection({instance = DEFAULT_INSTANCE, origins, sources = []} = {}) {
  const adapters = new Map();
  for (const s of sources) {
    if (adapters.has(s.id)) throw Object.assign(new Error(`source ${s.id} is registered twice`), {code: 'GRAPH_REFUSED'});
    adapters.set(s.id, s);
  }
  const facts = new Map();                         // `${source}@${version}` -> materialized facts (ok results only)
  let st;
  function reset() {
    st = {seq: 0, head: null, log: [], bySeq: new Map(), assertions: new Map(), bySubject: new Map(), incident: new Map(),
      retractions: new Map(), sourceLog: new Map(), factsBySource: new Map(), gap: new Set(), pending: new Map(), expected: st?.expected ?? null};
  }
  reset();

  // ---- source facts: re-derived from the source at a version ----------------------------------------------------------
  /** The facts the registered extractor projects from `sourceId` at `version`: {ok, facts, digest, count} or {ok: false, why}. */
  function materialize(sourceId, version) {
    const k = `${sourceId}@${version}`;
    if (facts.has(k)) return facts.get(k);
    const a = adapters.get(sourceId);
    if (!a) return {ok: false, why: `no adapter for source "${sourceId}" in this composition`, unavailable: true};
    const o = Object.hasOwn(origins, a.extractor) ? origins[a.extractor] : null;
    if (!o || o.kind !== 'extractor' || !o.sources.includes(sourceId)) return {ok: false, why: `the extractor "${a.extractor}" of source "${sourceId}" is not registered for it`, invalid: true};
    let drafts;
    try { drafts = a.readAt(version); }
    catch (e) { return {ok: false, why: `source "${sourceId}" at ${version} could not be read: ${e.message}`, unavailable: true}; }
    if (!Array.isArray(drafts)) return {ok: false, why: `source "${sourceId}" at ${version} did not yield a list of facts`, invalid: true};
    const out = [], seen = new Set();
    for (const [i, d] of drafts.entries()) {
      let r;
      try {
        r = assertion({...d, instance, origin: a.extractor, classification: 'authoritative', observed_at: EPOCH, effective_at: null,
          source: {id: sourceId, authority: a.authority, ref: d.ref ?? a.ref, version}, supersedes: [], invalidates: [], inputs: [], run: null});
      } catch (e) { return {ok: false, why: `fact ${i} of ${sourceId}@${version}: ${e.message}`, invalid: true}; }
      const why = recordRefusal(r, {origins, built: true}) ?? (isSourceNode(r.subject) ? 'a source fact is never a source node' : null)
        ?? (seen.has(r.subject) ? `subject ${r.subject} appears twice` : null);
      if (why) return {ok: false, why: `fact ${i} of ${sourceId}@${version}: ${why}`, invalid: true};
      seen.add(r.subject);
      out.push(r);
    }
    // The digest is over the SET of facts (their ids commit to their content and the version): the order an extractor
    // yields them in is not part of the source.
    const m = {ok: true, facts: out, digest: H(out.map(f => f.id).sort(byString)), count: out.length};
    facts.set(k, m);
    return m;
  }

  const current = id => { const a = st.assertions.get(id); return Boolean(a) && !a.retired; };
  // A fact's content without its version, id, timestamps or supersession: computed only when two versions are compared,
  // and kept per assertion id (bounded).
  const factKeys = new Map();
  const factKey = r => {
    let k = factKeys.get(r.id);
    if (k === undefined) { if (factKeys.size > 1_000_000) factKeys.clear(); k = factDigestOf(r); factKeys.set(r.id, k); }
    return k;
  };
  /** The current facts of a source (its extractor's assertions, not its source node): subject -> record. */
  function currentFacts(sourceId) {
    const out = new Map();
    for (const id of st.factsBySource.get(sourceId) ?? []) if (current(id)) { const r = st.assertions.get(id).record; out.set(r.subject, r); }
    return out;
  }
  const withSupersedes = (r, ids) => { const x = {...r, supersedes: ids, id: null}; return assertion({...x, entity: x.kind === 'entity' ? x.subject : undefined}); };
  /** What observing `sourceId` at `version` changes, against the current state: the facts to add and the ids withdrawn. */
  function diffFor(sourceId, version) {
    const m = materialize(sourceId, version);
    if (!m.ok) return m;
    const prev = currentFacts(sourceId), add = [], withdraw = [];
    for (const f of m.facts) {
      const p = prev.get(f.subject);
      if (!p) add.push(f);
      else if (factKey(p) !== factKey(f)) add.push(withSupersedes(f, [p.id]));
    }
    const now = new Set(m.facts.map(f => f.subject));
    for (const [subject, p] of prev) if (!now.has(subject)) withdraw.push(p.id);
    const changed = [...add.map(f => f), ...withdraw.map(id => st.assertions.get(id).record)];
    const nodes = [...new Set(changed.filter(r => r.kind === 'entity').map(r => r.subject))].sort(byString);
    const relationships = [...new Set(changed.filter(r => r.kind === 'relationship').map(r => r.subject))].sort(byString);
    return {ok: true, digest: m.digest, count: m.count, add, withdraw, nodes, relationships,
      changes: {count: nodes.length + relationships.length, digest: changeDigest([...nodes, ...relationships])}};
  }
  /** The latest source node assertion of a source (its last observation), or null. */
  function sourceNode(sourceId) {
    const log = st.sourceLog.get(sourceId);
    return log?.length ? st.assertions.get(log.at(-1).record).record : null;
  }

  // ---- checking an entry against the state before it ------------------------------------------------------------------
  // The state an entry is checked against: the projection as it stands, plus what the entry itself admitted or retired
  // so far (a payload's records are checked in order).
  function simulate() {
    const added = new Map(), addedBy = new Map(), retired = new Set();
    const get = id => added.get(id) ?? st.assertions.get(id)?.record ?? null;
    const isCur = id => (added.has(id) || current(id)) && !retired.has(id);
    const support = node => [...(st.bySubject.get(node) ?? []), ...(addedBy.get(node) ?? [])].filter(isCur);
    return {get, isCur, retired,
      known: id => added.has(id) || st.assertions.has(id),
      present: node => support(node).length > 0,
      firm: node => support(node).some(id => get(id).classification !== 'hypothetical'),
      admit(r) { added.set(r.id, r); if (!addedBy.has(r.subject)) addedBy.set(r.subject, []); addedBy.get(r.subject).push(r.id); },
      retire(id) { retired.add(id); }};
  }
  const sourceFact = r => r.classification === 'authoritative' && !isSourceNode(r.subject);
  const keyRefusal = (originId, author) => {
    const o = Object.hasOwn(origins, originId) ? origins[originId] : null;
    if (!o) return `origin "${originId}" is not registered`;
    return o.keys.includes(author?.key_id) ? null : `key "${author?.key_id}" may not write as origin "${originId}"`;
  };

  // A reference to something absent is refused -- except when an entry ALREADY ON THE LEDGER is replayed while a
  // source could not be re-derived here (st.gap): then the endpoint may be one of that source's facts, so the reference
  // is noted as not re-derived (the ledger's `partial`) and the edge stays recorded, orphaned. A new write is always strict.
  const blind = (strict, notes, what) => { if (strict || !st.gap.size) return false; notes.push(`${what}: not re-derived here, because ${[...st.gap].sort().join(', ')} could not be read`); return true; };
  function referenceRefusal(r, sim, strict = true, notes = []) {
    if (r.kind !== 'relationship') return null;
    for (const end of [r.from, r.to]) {
      if (!sim.present(end) && blind(strict, notes, `the reference to ${end}`)) continue;
      if (!sim.present(end)) return `GRAPH_REFERENCE broken reference: ${end} is not in the graph`;
      if (r.classification !== 'hypothetical' && !sim.firm(end)) return `GRAPH_REFERENCE a ${r.classification} relationship needs established endpoints; ${end} is only hypothetical`;
    }
    return null;
  }

  /**
   * Why entry `e` ({kind, author, payload, seq}) is refused against the current state, or null. `notes` collects what
   * could not be re-derived (a source unavailable now). Refusal texts start with a GRAPH_* marker the writer acts on.
   */
  function check(e, notes = [], {strict = true} = {}) {
    const p = e.payload, sim = simulate();
    if (e.kind === 'graph.retract') {
      const seen = new Set();
      for (const x of p.retractions) {
        if (st.retractions.has(x.id) || seen.has(x.id)) return `GRAPH_DUPLICATE retraction ${x.id} is already recorded`;
        seen.add(x.id);
        const why = keyRefusal(x.origin, e.author);
        if (why) return `GRAPH_UNAUTHORIZED ${why}`;
        const t = sim.get(x.retracts);
        if (!t) return `GRAPH_REFERENCE retraction of ${x.retracts}, which is not in the graph`;
        if (!sim.isCur(x.retracts)) return `GRAPH_STALE ${x.retracts} is no longer current`;
        if (sourceFact(t) || isSourceNode(t.subject)) return `GRAPH_SOURCE a source's assertions change only when the source is observed again`;
        if (t.origin !== x.origin) return `GRAPH_UNAUTHORIZED an assertion is retracted by its own origin (${t.origin}), not ${x.origin}`;
        sim.retire(x.retracts);
      }
      return null;
    }
    for (const r of p.records) {
      const why = keyRefusal(r.origin, e.author);
      if (why) return `GRAPH_UNAUTHORIZED ${why}`;
      if (sim.known(r.id)) return `GRAPH_DUPLICATE assertion ${r.id} is already recorded`;
      if (isSourceNode(r.subject)) {
        if (p.records.length !== 1) return 'GRAPH_SOURCE a source observation is recorded alone';
        const w = observationRefusal(r, sim, notes);
        if (w) return w;
        continue;
      }
      if (sourceFact(r)) return 'GRAPH_SOURCE an authoritative assertion is projected from its source by observing it, not written to the graph ledger';
      for (const t of r.supersedes) {
        const tr = sim.get(t);
        if (!tr) return `GRAPH_REFERENCE supersedes ${t}, which is not in the graph`;
        if (!sim.isCur(t)) return `GRAPH_STALE ${t} was already superseded or retracted`;
        if (tr.subject !== r.subject) return `GRAPH_REFUSED a supersession replaces an assertion of the same subject (${tr.subject})`;
        if (!overrides(r.classification, tr.classification)) return `GRAPH_HYPOTHETICAL a hypothetical assertion never supersedes a ${tr.classification} one`;
        if (tr.origin !== r.origin) return `GRAPH_UNAUTHORIZED ${t} is superseded only by its own origin (${tr.origin}); another origin's disagreement is a contradiction, not an overwrite`;
        sim.retire(t);
      }
      for (const t of r.invalidates) {
        const tr = sim.get(t);
        if (!tr) return `GRAPH_REFERENCE invalidates ${t}, which is not in the graph`;
        if (!sim.isCur(t)) return `GRAPH_STALE ${t} is no longer current`;
        if (sourceFact(tr) || isSourceNode(tr.subject)) return 'GRAPH_SOURCE a source\'s assertion is not invalidated; record a contradiction or observe the source again';
        if (!overrides(r.classification, tr.classification)) return `GRAPH_HYPOTHETICAL a hypothetical assertion never invalidates a ${tr.classification} one`;
        sim.retire(t);
      }
      for (const i of r.inputs) {
        if (!sim.get(i) && blind(strict, notes, `the input ${i}`)) continue;
        if (!sim.get(i) || !sim.isCur(i)) return `GRAPH_REFERENCE derived from ${i}, which is not a current assertion`;
      }
      sim.admit(r);
      const ref = referenceRefusal(r, sim, strict, notes);
      if (ref) return ref;
    }
    return null;
  }

  // THE CURSOR RULE (KD10, KD11; carried from pull request 70): one observation per step of one source's cursor. An
  // observation is admitted only when it starts where that source's last admitted observation ended -- its
  // from_version is that observation's version and it supersedes exactly that observation -- and this is checked here,
  // in re-derivation, under the ledger's append lock. So a source's events have no gap, no overlap and no reordering:
  // a reading computed on an older state (an older version landing after a newer one) is refused as stale, and the
  // writer reads again.
  function cursorRefusal(r, prev) {
    const s = sourceIdOf(r.subject), at = prev ? prev.source.version : null;
    if (r.attributes.from_version !== at || r.supersedes.length !== (prev ? 1 : 0) || (prev && r.supersedes[0] !== prev.id)) {
      return `GRAPH_STALE the observation of ${s} starts at ${r.attributes.from_version} (superseding ${r.supersedes.join(', ') || 'nothing'}); that source is at ${at}${prev ? ` (${prev.id})` : ''}`;
    }
    return null;
  }

  // A source observation re-derives: the extractor's facts at that version, their digest, and what changed.
  function observationRefusal(r, sim, notes) {
    const s = sourceIdOf(r.subject), prev = sourceNode(s), a = r.attributes;
    const stale = cursorRefusal(r, prev);
    if (stale) return stale;
    if (a.state !== 'current') {
      if (a.state === 'stale' && a.live_version === null) return 'GRAPH_REFUSED a stale source names the version it could not project';
      if (prev && prev.attributes.state === a.state && prev.source.version === r.source.version && prev.attributes.live_version === a.live_version) return `GRAPH_DUPLICATE ${s} is already recorded as ${a.state}`;
      return null;
    }
    if (prev && prev.attributes.state === 'current' && prev.source.version === r.source.version) return `GRAPH_DUPLICATE ${s}@${r.source.version} is already observed`;
    const d = diffFor(s, r.source.version);
    if (!d.ok) { notes.push(`${s}@${r.source.version}: ${d.why}; its facts are not re-derived here`); return null; }
    if (d.digest !== a.digest || d.count !== a.count) { notes.push(`${s}@${r.source.version}: the source now yields digest ${d.digest}, not the recorded ${a.digest}; its facts are not applied`); return null; }
    if (!st.gap.has(s) && (d.changes.digest !== a.changes.digest || d.changes.count !== a.changes.count)) {
      return `GRAPH_SOURCE the observation of ${s}@${r.source.version} does not re-derive: the changed subjects differ`;
    }
    // Referential integrity of what the observation admits: entities first, then the relationships, after withdrawals.
    for (const id of d.withdraw) sim.retire(id);
    for (const f of d.add) { for (const t of f.supersedes) sim.retire(t); if (f.kind === 'entity') sim.admit(f); }
    for (const f of d.add) if (f.kind === 'relationship') {
      sim.admit(f);
      const ref = referenceRefusal(f, sim);
      if (ref) return `${ref} (in the facts of ${s}@${r.source.version})`;
    }
    st.pending.set(r.id, d);
    return null;
  }

  // ---- applying an entry ----------------------------------------------------------------------------------------------
  function admit(r, seq) {
    st.assertions.set(r.id, {record: r, admitted: seq, retired: null});
    if (!st.bySubject.has(r.subject)) st.bySubject.set(r.subject, []);
    st.bySubject.get(r.subject).push(r.id);
    if (r.kind === 'relationship') for (const end of new Set([r.from, r.to])) {
      if (!st.incident.has(end)) st.incident.set(end, []);
      st.incident.get(end).push(r.id);
    }
  }
  function retire(id, seq, how, by) { const a = st.assertions.get(id); if (a && !a.retired) a.retired = {seq, how, by}; }

  /** Apply entry `e` (already checked) at its seq. */
  function apply(e) {
    const seq = e.seq, hash = e.hash ?? entryHash(e);
    const item = {seq, hash, parent: e.parent ?? null, kind: e.kind, author: e.author?.key_id ?? null, records: [], retractions: [], observation: null};
    if (e.kind === 'graph.retract') {
      for (const x of e.payload.retractions) {
        st.retractions.set(x.id, {record: x, seq});
        retire(x.retracts, seq, 'retracted', x.id);
        item.retractions.push(x.id);
      }
    } else {
      for (const r of e.payload.records) {
        admit(r, seq);
        item.records.push(r.id);
        for (const t of r.supersedes) retire(t, seq, 'superseded', r.id);
        for (const t of r.invalidates) retire(t, seq, 'invalidated', r.id);
        if (isSourceNode(r.subject)) item.observation = applyObservation(r, seq);
      }
    }
    st.log.push(item);
    st.bySeq.set(seq, item);
    st.seq = seq; st.head = hash;
    st.pending.clear();
  }

  function applyObservation(r, seq) {
    const s = sourceIdOf(r.subject), a = r.attributes;
    let replay = 'recorded';
    if (a.state === 'current') {
      const d = st.pending.get(r.id) ?? diffFor(s, r.source.version);
      if (!d.ok) { replay = d.unavailable ? 'unavailable' : 'invalid'; st.gap.add(s); }
      else if (d.digest !== a.digest || d.count !== a.count) { replay = 'diverged'; st.gap.add(s); }
      else {
        if (!st.factsBySource.has(s)) st.factsBySource.set(s, new Set());
        for (const id of d.withdraw) retire(id, seq, 'withdrawn', r.id);
        // entities before relationships, so a view never sees an edge before its endpoint
        const ordered = [...d.add.filter(f => f.kind === 'entity'), ...d.add.filter(f => f.kind === 'relationship')];
        for (const f of ordered) {
          const x = {...f, observed_at: r.observed_at, effective_at: r.effective_at};
          admit(x, seq);
          st.factsBySource.get(s).add(x.id);
          for (const t of x.supersedes) retire(t, seq, 'superseded', x.id);
        }
        replay = 'applied';
        st.gap.delete(s);
        st.lastDiff = d;
      }
    }
    if (!st.sourceLog.has(s)) st.sourceLog.set(s, []);
    // A record that changes no facts (unavailable, stale) leaves them as last observed: as re-derived here, or not.
    const lastCurrent = st.sourceLog.get(s).filter(x => x.state === 'current').at(-1);
    if (a.state !== 'current' && lastCurrent && lastCurrent.replay !== 'applied') replay = lastCurrent.replay;
    st.sourceLog.get(s).push({seq, record: r.id, version: r.source.version, state: a.state, replay});
    // The changed subjects: as listed, or (when too many to list) as this replay re-derived them, or unknown.
    const listed = a.state !== 'current' || a.changes.listed, d = replay === 'applied' ? (st.lastDiff ?? null) : null;
    st.lastDiff = null;
    return {source: s, from_version: a.from_version, to_version: r.source.version, state: a.state, replay,
      nodes: listed ? a.nodes : d ? d.nodes : null, relationships: listed ? a.relationships : d ? d.relationships : null};
  }

  // ---- the ledger's re-derivation hook --------------------------------------------------------------------------------
  /**
   * Re-derive entry `e` (the ledger passes it with its payload) against the chain before it (`view`: the ledger's
   * re-derivation view). Catches up on any graph entry this projection has not applied, checks `e`, applies it.
   * Returns the refusal or null; what could not be re-derived is reported through view.note.
   */
  function sync(e, view) {
    const h = entryHash(e);
    const known = st.bySeq.get(e.seq);
    if (known && known.hash === h) return null;              // already applied in this process, under this registry
    if (known) reset();                                       // another chain: replay it from its start
    const missing = [];
    let cur = e.parent;
    while (cur !== st.head) {
      if (cur === null) { if (st.head !== null) { reset(); } break; }   // our head is not before e: replay from genesis
      const x = view.entry(cur);
      if (!x) return 'GRAPH_REPLAY an entry before this one is missing from the chain';
      if (GRAPH_KINDS.has(x.kind)) missing.push({...x, payload: view.payload(cur), hash: cur});
      cur = x.parent;
    }
    for (const m of missing.reverse()) {
      const notes = [], why = check(m, notes, {strict: false});
      if (why) return `entry ${m.seq}: ${why}`;
      for (const n of notes) view.note?.(n);
      apply(m);
    }
    const notes = [], why = check(e, notes, {strict: st.expected !== null && e.payload_ref === st.expected});
    if (why) { st.pending.clear(); return why; }
    for (const n of notes) view.note?.(n);
    apply({...e, hash: h});
    return null;
  }

  /** Apply every graph entry of `entries` (the whole chain, in order) this projection has not applied. */
  function catchUp(entries, payloadOf) {
    if (st.seq > entries.length || (st.seq > 0 && H(entries[st.seq - 1]) !== st.head)) reset();
    const notes = [];
    for (let i = st.seq; i < entries.length; i++) {
      const x = entries[i];
      if (!GRAPH_KINDS.has(x.kind) || st.bySeq.has(x.seq)) continue;
      const e = {...x, payload: payloadOf(x), hash: H(x)};
      const why = check(e, notes, {strict: false});
      if (why) throw Object.assign(new Error(`graph entry ${x.seq} does not re-derive: ${why}`), {code: 'GRAPH_REPLAY'});
      apply(e);
    }
    return notes;
  }

  // ---- views at a cursor ----------------------------------------------------------------------------------------------
  /** The view of the graph as of ledger seq `cursor` (default: the latest applied). */
  function at(cursor = st.seq) {
    const c = typeof cursor === 'object' && cursor !== null ? cursor.seq : cursor;
    if (!Number.isInteger(c) || c < 0 || c > st.seq) throw new RangeError(`cursor ${c} is not between 0 and ${st.seq}`);
    return makeView(st, c, origins);
  }

  return {
    instance, origins, adapters, at, check, apply, sync, catchUp, reset, materialize, diffFor, sourceNode,
    knows: id => st.assertions.has(id) || st.retractions.has(id),
    /** The payload ref of the entry a writer is about to append: that entry is checked strictly, never leniently. */
    expect: ref => { st.expected = ref; },
    retractionOf: id => st.retractions.get(id)?.record ?? null,
    get seq() { return st.seq; }, get head() { return st.head; }, get log() { return st.log; },
    digest: cursor => at(cursor).digest(),
  };
}

function makeView(st, c, origins) {
  const live = id => { const a = st.assertions.get(id); return Boolean(a) && a.admitted <= c && !(a.retired && a.retired.seq <= c); };
  const recorded = id => (st.assertions.get(id)?.admitted ?? Infinity) <= c;
  const retiredAt = a => (a.retired && a.retired.seq <= c ? a.retired : null);
  const memo = new Map();
  // Established: current, not hypothetical, not marked unresolved, its endpoints established (an orphaned edge is not),
  // and, if derived, every input still established (a derived assertion whose input went away is stale).
  function established(id) {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, false);                                     // a cycle through derived inputs is not support
    let ok = live(id);
    if (ok) {
      const r = st.assertions.get(id).record;
      ok = r.classification !== 'hypothetical' && r.status !== 'unresolved'
        && (r.kind !== 'relationship' || (nodeEstablished(r.from) && nodeEstablished(r.to)))
        && (r.classification !== 'derived' || r.inputs.every(established));
    }
    memo.set(id, ok);
    return ok;
  }
  const subjectIds = s => (st.bySubject.get(s) ?? []).filter(recorded);
  const nodePresent = n => subjectIds(n).some(live);
  const nodeEstablished = n => subjectIds(n).some(established);
  const present = id => { const a = st.assertions.get(id); return live(id) && (a.record.kind !== 'relationship' || (nodePresent(a.record.from) && nodePresent(a.record.to))); };
  const MODES = {established, possible: present, recorded};
  const modeOf = m => { const f = MODES[m]; if (!f) throw new RangeError(`mode is one of ${Object.keys(MODES).join(', ')}`); return f; };

  const describe = id => {
    const a = st.assertions.get(id), ret = retiredAt(a), r = a.record;
    return {id, subject: r.subject, classification: r.classification, origin: r.origin, status: r.status, source: r.source,
      admitted: a.admitted, retired: ret, current: live(id), established: established(id)};
  };
  const headAt = () => { let h = null; for (let i = st.log.length - 1; i >= 0; i--) if (st.log[i].seq <= c) { h = st.log[i].hash; break; } return h; };
  const sourcesAt = () => [...st.sourceLog.entries()].map(([id, log]) => {
    const last = log.filter(x => x.seq <= c).at(-1);
    if (!last) return null;
    const r = st.assertions.get(last.record).record;
    return {id, version: last.version, state: last.state, replay: last.replay, seq: last.seq, observed_at: r.observed_at, record: last.record,
      live_version: r.attributes.live_version, why: r.attributes.why};
  }).filter(Boolean).sort((a, b) => byString(a.id, b.id));

  const view = {
    seq: c,
    get head() { return headAt(); },
    /** One assertion as of this cursor, or null. */
    assertion: id => (recorded(id) ? {...describe(id), record: st.assertions.get(id).record} : null),
    established, current: live,
    /**
     * A node: whether it is present (any current assertion) or established, what supports it, each attribute's value
     * from the strongest current assertion (authoritative, observed, derived, then hypothetical: a hypothesis never
     * changes the value another class gave), and every attribute the current assertions disagree on, with each value's
     * assertion. Nothing is dropped: a disagreement is listed, not resolved.
     */
    node(n) {
      const cur = subjectIds(n).filter(live).sort((x, y) => RANK[st.assertions.get(x).record.classification] - RANK[st.assertions.get(y).record.classification] || byString(x, y));
      const attributes = {}, seen = new Map();
      for (const id of cur) for (const [k, v] of Object.entries(st.assertions.get(id).record.attributes)) {
        if (!seen.has(k)) { seen.set(k, []); attributes[k] = v; }
        seen.get(k).push({value: v, assertion: id, classification: st.assertions.get(id).record.classification, origin: st.assertions.get(id).record.origin});
      }
      const conflicts = [...seen].filter(([, vs]) => new Set(vs.map(x => canonical(x.value))).size > 1).map(([attribute, values]) => ({attribute, values}));
      return {id: n, present: cur.length > 0, established: nodeEstablished(n), assertions: cur.map(describe), attributes, conflicts};
    },
    /** The relationships incident to node `n` in `mode` (established | possible | recorded), one per subject. */
    edgesOf(n, {mode = 'established', types = null} = {}) {
      const keep = modeOf(mode), groups = new Map();
      for (const id of st.incident.get(n) ?? []) {
        if (!keep(id)) continue;
        const r = st.assertions.get(id).record;
        if (types && !types.includes(r.type)) continue;
        if (!groups.has(r.subject)) groups.set(r.subject, {subject: r.subject, type: r.type, from: r.from, to: r.to, assertions: []});
        groups.get(r.subject).assertions.push(id);
      }
      return [...groups.values()].sort((a, b) => byString(a.subject, b.subject));
    },
    nodeIn: (n, mode) => (mode === 'established' ? nodeEstablished(n) : mode === 'possible' ? nodePresent(n) : subjectIds(n).length > 0),
    /**
     * The directive's four categories as query modes over one subject: what was RECORDED (the trace, with each
     * assertion's status at this cursor), what is ESTABLISHED, what is POSSIBLE (current but not established:
     * hypotheses, unresolved, orphaned or stale-derived assertions, each with why), and what may change (the
     * TRANSITIONS the admission rules authorize for each current assertion).
     */
    query(subject, mode) {
      const all = subjectIds(subject);
      if (mode === 'recorded') return all.map(describe);
      if (mode === 'established') return all.filter(established).map(describe);
      if (mode === 'possible') return all.filter(id => live(id) && !established(id)).map(id => ({...describe(id), why: whyNot(id)}));
      if (mode === 'transitions') return all.filter(live).map(id => ({...describe(id), may: transitions(id)}));
      throw new RangeError('mode is recorded, established, possible or transitions');
    },
    subjects: () => [...st.bySubject.keys()].filter(s => subjectIds(s).length).sort(byString),
    sources: sourcesAt,
    /** The projection digest at this cursor: cursor, head and every assertion's interval, sorted by id. */
    digest() {
      const rows = [];
      for (const [id, a] of st.assertions) if (a.admitted <= c) { const r = retiredAt(a); rows.push([id, a.admitted, r?.seq ?? null, r?.how ?? null, r?.by ?? null]); }
      rows.sort((x, y) => byString(x[0], y[0]));
      const retractions = [...st.retractions].filter(([, x]) => x.seq <= c).map(([id]) => id).sort(byString);
      return H({schema: 'ophanim.graph.projection/v1', contract: GRAPH_SCHEMA, seq: c, head: headAt(), assertions: rows, retractions,
        sources: sourcesAt().map(s => [s.id, s.seq, s.version, s.state, s.replay])});
    },
    /** Counts at this cursor. */
    stats() {
      let current = 0, entities = 0, relationships = 0;
      for (const [id, a] of st.assertions) if (live(id)) { current++; if (a.record.kind === 'entity') entities++; else relationships++; }
      return {seq: c, assertions: [...st.assertions.values()].filter(a => a.admitted <= c).length, current, entities, relationships};
    },
  };

  function whyNot(id) {
    const r = st.assertions.get(id).record;
    if (r.classification === 'hypothetical') return 'hypothetical: proposed, never established until a registered extractor, tool or rule admits it';
    if (r.status === 'unresolved') return 'marked unresolved by its origin';
    if (r.kind === 'relationship' && !(nodeEstablished(r.from) && nodeEstablished(r.to))) return 'orphaned: an endpoint is not established';
    if (r.classification === 'derived') return 'stale: an input is no longer established';
    return 'not established';
  }
  function transitions(id) {
    const r = st.assertions.get(id).record;
    if (r.classification === 'authoritative') return {by: `observing source ${r.source.id} again (its extractor ${r.origin})`, supersede: [], retract: [], invalidate: []};
    const noHypo = r.classification !== 'hypothetical';
    const invalidators = Object.values(origins).filter(o => o.kind !== 'agent' && o.kind !== 'model').map(o => o.id).sort(byString);
    return {by: 'a graph ledger entry', supersede: [`${r.origin}${noHypo ? ' (not as hypothetical)' : ''}`], retract: [r.origin],
      invalidate: noHypo ? invalidators : Object.keys(origins).sort(byString)};
  }
  return view;
}

/** Is this a sha256 assertion id? */
export const isAssertionId = x => SHA256_REF.test(x);
