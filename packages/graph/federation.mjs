// Federation (Slice E; docs/knowledge-graph/slice-e.md, the directive's section 6 and demonstration 10).
//
// Several OPHANIM instances, each with its OWN graph (packages/graph on its own packages/ledger chain), and a central
// instance that links what they permit it to see. Nothing here is a shared store: a department's facts stay in its
// ledger and its sources; the central holds only the signed exports a department chose to give it, and re-derives its
// projection from them.
//
//   INSTANCE IDENTITY (KE2)  an instance is {instance, anchor}: its id and its graph ledger's genesis hash. A renamed
//                            or replaced ledger is a different instance. A CROSS-INSTANCE REFERENCE is
//                            {instance, anchor, node, version}; the version is the department ledger entry that
//                            admitted the node's current established support. Resolving it checks the anchor; one
//                            that does not resolve is unresolved, with why, never guessed.
//   EXPORT (KE3)             department(...).exportAt / publish: a permitted projection of the department's established
//                            view, signed by its export key and versioned by its ledger head, under an explicit access
//                            policy (definePolicy) that enforces every assertion's `scope` (register KG-3):
//                              public      exported with its details (attributes, provenance; no source digest);
//                              internal    exported as a reference: id, type, version, permitted relationships and
//                                          cross-instance references, without its details;
//                              restricted  never exported: at most counted, or an opaque keyed placeholder where a
//                                          permitted relationship needs an endpoint.
//                            A policy may be stricter, never looser (ACCESS_CEILING). Public details that name a
//                            withheld node are scrubbed. Source nodes (digests of whole sources) are never exported.
//   CENTRAL (KE4)            openCentral: imports exports READ ONLY. Each department is a registered SOURCE of the
//                            central graph (`federation.<instance>`), its extractor projecting the export's nodes and
//                            relationships owned by that department; the central never asserts in a department's
//                            namespace (its write boundary refuses it) and never opens a department's ledger.
//                            Cross-department links are DERIVED by the central's linker from resolved references, with
//                            the two imported facts as inputs: when either input changes, the link is stale, not
//                            established (Slice A's derived rule), until the reference resolves again.
//   FRESHNESS (KE5)          each import records the export's version (source.version), its time (effective_at) and
//                            the import time (observed_at). An import older than its bound, or one whose instance could
//                            not be reached (recorded `unavailable` on the central ledger), is STALE in every central
//                            answer that uses it. A department never needs the hub: its writes, replay, queries and
//                            exports are its own. On reconnection the central catches up BY VERSION: the next import is
//                            always the export whose `previous` is the last one imported, so nothing is skipped and
//                            nothing is imported twice (and two central processes racing record each once: the cursor
//                            rule and idempotency of packages/graph).
//   PROPAGATION (KE6)        a department's export lists what changed since its previous export, each change with its
//                            own ledger entry. The central follows each change through its projection (reverse impact
//                            closure, before and after the import) to the other instances whose permitted relationships
//                            depend on it, and issues each a signed NOTICE that keeps the originating instance, anchor,
//                            export, version and change entries. A notice discloses to its recipient only its own nodes
//                            and the foreign nodes it itself references. The recipient pulls it and records it in its
//                            own ledger with its own key; the central never writes there.
//
// Domain-free, like the rest of packages/graph: imports only packages/ledger, packages/graph and Node built-ins. The
// production access policy, departmental key custody (export keys, placeholder secrets) and where instances run are
// the owner's (slice-e.md "The owner's").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sign as edSign, verify as edVerify, createPrivateKey, createPublicKey, createHmac, randomBytes} from 'node:crypto';
import {canonical, digest} from '../ledger/canonical.mjs';
import {INSTANCE_NAME, SHA256_REF, parseId, decodeKey, relationshipSubject} from './identity.mjs';
import {GRAPH_SCHEMA, ACCESS, RELATIONSHIPS, defineOrigins, idRefusal, endpointAllowed, admits, assertion, retraction, isSourceNode} from './schema.mjs';
import {openGraph} from './kinds.mjs';
import {closure} from './traverse.mjs';

export const EXPORT_SCHEMA = 'ophanim.graph.export/v1';
export const NOTICE_SCHEMA = 'ophanim.graph.notice/v1';
/** The attribute a department's node carries its cross-instance references in: [{type, to: {instance, anchor, node, version}}]. */
export const REFERENCES = 'federation_references';
/** What each access level may be exported as (KE3). A policy may choose a stricter treatment, never a looser one. */
export const ACCESS_CEILING = Object.freeze({public: Object.freeze(['details', 'reference', 'withhold']),
  internal: Object.freeze(['reference', 'withhold']), restricted: Object.freeze(['withhold'])});
/** The coordinator's default freshness bound for an import (the owner may set another per department). */
export const DEFAULT_MAX_AGE_MS = 3_600_000;
/** The central's rule origin that derives cross-department links; the receiver origin a department records notices as. */
export const LINKER = 'federation.linker';
export const RECEIVER = 'federation.receiver';
export const WITHHELD = '[withheld]';
const NOTICE_SOURCE = 'federation.notices', LINK_SOURCE = 'federation.links';

const H = value => 'sha256:' + digest(value);
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PLACEHOLDER = /^placeholder:[0-9a-f]{64}$/;
const POLICY_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const RANK = Object.freeze({public: 0, internal: 1, restricted: 2});
const CLASS_RANK = Object.freeze({authoritative: 0, observed: 1, derived: 2, hypothetical: 3});
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const refused = (why, code = 'FEDERATION_REFUSED') => Object.assign(new Error(why), {code});
const fail = (why, code) => { throw refused(why, code); };
const instanceOf = id => id.split('/')[0];
const hex = ref => ref.slice('sha256:'.length);
/** The source (and import extractor) id under which the central projects a department's exports. */
export const importSource = instance => `federation.${instance}`;

// ---- identity (KE2) -------------------------------------------------------------------------------------------------
/** The identity of an open graph: its instance and the genesis hash its ledger is pinned to. */
export const identityOf = graph => Object.freeze({instance: graph.instance, anchor: graph.anchor});
/** Why `claimed` is not the pinned instance `pinned` ({instance, anchor}), or null. */
export function identityRefusal(pinned, claimed) {
  if (!plain(claimed) || claimed.instance !== pinned.instance) return `instance "${claimed?.instance}" is not "${pinned.instance}"`;
  if (claimed.anchor !== pinned.anchor) return `${pinned.instance}: anchor ${claimed.anchor} is not the pinned ${pinned.anchor}; a renamed or replaced ledger is a different instance`;
  return null;
}
/** Why `ref` is not a well-formed cross-instance reference {instance, anchor, node, version}, or null. */
export function referenceRefusal(ref) {
  if (!plain(ref) || Object.keys(ref).length !== 4 || !['instance', 'anchor', 'node', 'version'].every(k => Object.hasOwn(ref, k))) return 'a cross-instance reference is {instance, anchor, node, version}';
  if (!INSTANCE_NAME.test(ref.instance ?? '')) return `reference instance "${ref.instance}" is not an instance name`;
  if (!SHA256_REF.test(ref.anchor ?? '')) return 'a reference names the genesis hash (anchor) of the instance it points into';
  const why = idRefusal(ref.node);
  if (why) return why;
  if (instanceOf(ref.node) !== ref.instance) return `reference node ${ref.node} is not in the namespace of ${ref.instance}`;
  if (!SHA256_REF.test(ref.version ?? '')) return 'a reference names the version (a ledger entry hash) of the node it relies on';
  return null;
}

// ---- signing --------------------------------------------------------------------------------------------------------
const signOf = (value, signer) => ({key_id: signer.key_id, sig: edSign(null, Buffer.from(canonical(value)), createPrivateKey(signer.privatePem)).toString('base64')});
function signatureValid(value, signature, keys) {
  const jwk = plain(signature) && typeof signature.key_id === 'string' && Object.hasOwn(keys ?? {}, signature.key_id) ? keys[signature.key_id] : null;
  if (!jwk || typeof signature.sig !== 'string') return false;
  try { return edVerify(null, Buffer.from(canonical(value)), createPublicKey({key: jwk, format: 'jwk'}), Buffer.from(signature.sig, 'base64')); }
  catch { return false; }
}

// ---- the access policy (KE3) ----------------------------------------------------------------------------------------
/**
 * An access policy: {id, version, access: {public, internal, restricted} -> treatment, relationships: [type] permitted
 * across the boundary, placeholders, counts}. Refused (FEDERATION_POLICY) if it is looser than ACCESS_CEILING or names a
 * relationship type the central could not admit (an import is authoritative from a declared basis; a cross-instance
 * reference is derived from a declared basis). The test policy is the coordinator's; the production policy the owner's.
 */
export function definePolicy(spec) {
  const {id, version, access, relationships, placeholders = false, counts = true} = spec ?? {};
  if (!POLICY_ID.test(id ?? '')) fail('a policy has an id (a name)', 'FEDERATION_POLICY');
  if (typeof version !== 'string' || !version) fail(`policy ${id}: a policy has a version`, 'FEDERATION_POLICY');
  if (!plain(access) || Object.keys(access).length !== ACCESS.length) fail(`policy ${id}: access names a treatment for each of ${ACCESS.join(', ')}`, 'FEDERATION_POLICY');
  for (const a of ACCESS) if (!ACCESS_CEILING[a].includes(access[a])) fail(`policy ${id}: ${a} may be exported as ${ACCESS_CEILING[a].join(' or ')}, not "${access[a]}" (KE3)`, 'FEDERATION_POLICY');
  if (!Array.isArray(relationships)) fail(`policy ${id}: relationships lists the types permitted across instances`, 'FEDERATION_POLICY');
  for (const t of relationships) {
    if (!Object.hasOwn(RELATIONSHIPS, t)) fail(`policy ${id}: "${t}" is not a registered relationship type`, 'FEDERATION_POLICY');
    if (!admits(t, 'authoritative', 'declared') || !admits(t, 'derived', 'declared')) fail(`policy ${id}: ${t} cannot cross an instance boundary: the central admits an import only as authoritative and a link only as derived, from a declared basis`, 'FEDERATION_POLICY');
  }
  const body = {id, version, access: {public: access.public, internal: access.internal, restricted: access.restricted},
    relationships: [...new Set(relationships)].sort(byString), placeholders: Boolean(placeholders), counts: Boolean(counts)};
  return Object.freeze({...body, access: Object.freeze(body.access), relationships: Object.freeze(body.relationships), digest: H(body)});
}

// ---- small stores: write once, atomically -------------------------------------------------------------------------
/** Write `value` to `file` unless it exists; atomic (link from a temporary file). True when this call wrote it. */
function writeOnce(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, typeof value === 'string' ? value : JSON.stringify(value));
  try { fs.linkSync(tmp, file); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  finally { fs.rmSync(tmp, {force: true}); }
}
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * A department's OUTBOX: its own record of what it published. exports/<hex>.json, and the chain: chain/<previous hex>
 * (or chain/genesis) names the export that follows it, created exclusively, so the chain cannot fork.
 */
export function outbox(dir) {
  const file = id => path.join(dir, 'exports', hex(id) + '.json');
  const link = prev => path.join(dir, 'chain', prev ? hex(prev) : 'genesis');
  const get = id => { const e = readJson(file(id)); return e && e.id === id ? e : null; };
  function all() {
    const out = [];
    for (let cur = null; ;) {
      let next;
      try { next = fs.readFileSync(link(cur), 'utf8').trim(); } catch { break; }
      const e = get(next);
      if (!e) break;
      out.push(e); cur = next;
      if (out.length > 1_000_000) break;
    }
    return out;
  }
  return {dir, get, all, head: () => all().at(-1) ?? null,
    /** Put `e` after `previous`; false when another export already follows `previous` (the chain is not forked). */
    append(e) { writeOnce(file(e.id), e); return writeOnce(link(e.previous), e.id); }};
}
/** The reference transport over a department's outbox directory. `reachable()` false simulates a partition. */
export function outboxTransport(dir, {reachable = () => true} = {}) {
  return {fetch() { if (!reachable()) throw new Error(`the outbox ${path.basename(dir)} cannot be reached`); return outbox(dir).all(); }};
}
/** The reference transport over the central's notice outbox, as a department pulls it. */
export function noticeTransport(centralDir, {reachable = () => true} = {}) {
  return {notices(identity) {
    if (!reachable()) throw new Error('the central instance cannot be reached');
    const dir = path.join(centralDir, 'outbox', identity.instance);
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => /^[0-9a-f]{64}\.json$/.test(n)); } catch { return []; }
    return names.map(n => readJson(path.join(dir, n))).filter(Boolean).sort((a, b) => a.via.seq - b.via.seq || byString(a.id, b.id));
  }};
}

// ---- the department side --------------------------------------------------------------------------------------------
/**
 * A department's federation handle over its own open graph. `policy` (definePolicy); `secret` (bytes the placeholders
 * are keyed with, held by the department); `signer` (its export key); `outbox` (a directory it owns); `hub`: the pinned
 * identity of the central instance its exports are for and its notice keys ({instance, anchor, keys}); `transport`
 * (optional): how it pulls notices. Nothing here needs the hub to be reachable except `pull`, which reports it.
 */
export function department({graph, policy, secret, signer, outbox: dir, hub, transport = null, receiver = RECEIVER}) {
  const me = identityOf(graph);
  if (!policy?.digest) fail('a department exports under a policy made by definePolicy', 'FEDERATION_POLICY');
  if (policy.placeholders && !(secret && Buffer.from(secret).length >= 32)) fail('placeholders are keyed with a department secret of at least 32 bytes', 'FEDERATION_POLICY');
  if (!signer?.key_id || !signer?.privatePem) fail('a department signs its exports');
  if (!hub || !INSTANCE_NAME.test(hub.instance ?? '') || !SHA256_REF.test(hub.anchor ?? '')) fail('a department names the hub its exports are for ({instance, anchor, keys})');
  const box = outbox(dir);
  const placeholderOf = node => 'placeholder:' + createHmac('sha256', Buffer.from(secret)).update(canonical({instance: me.instance, anchor: me.anchor, node})).digest('hex');

  /** The signed export of the established view at `cursor` (default: the latest), chained after `previous`. */
  function exportAt(cursor, {exported_at, previous = null} = {}) {
    if (!TIME.test(exported_at ?? '')) fail('an export states when it was made (exported_at, ISO-8601 UTC)');
    const v = graph.view(cursor);
    if (!v.head) fail(`${me.instance}: nothing to export (the graph ledger has no graph entry)`);
    const hashAt = new Map(graph.projection.log.map(x => [x.seq, x.hash])), seqOf = new Map(graph.projection.log.map(x => [x.hash, x.seq]));
    const versionOfSupport = est => hashAt.get(Math.max(...est.map(a => a.admitted)));
    const nodes = new Map(), rels = [];
    let withheldRels = 0, withheldRefs = 0;
    for (const s of v.subjects()) {
      const est = v.query(s, 'established');
      if (!est.length) continue;
      const records = est.map(a => v.assertion(a.id).record).sort((x, y) => CLASS_RANK[x.classification] - CLASS_RANK[y.classification] || byString(x.id, y.id));
      const r0 = records[0];
      if (r0.kind === 'entity' && isSourceNode(s)) continue;            // a source node commits to its whole source: never exported
      const ends = r0.kind === 'entity' ? [s] : [r0.from, r0.to];
      const foreign = ends.find(e => instanceOf(e) !== me.instance) ?? (records.find(r => r.scope.owner !== me.instance) ? s : null);
      if (foreign) fail(`${me.instance} holds ${foreign}, which it does not own (owner ${records.find(r => r.scope.owner !== me.instance)?.scope.owner ?? instanceOf(foreign)}); an export never presents another instance's node as its own`, 'FEDERATION_FOREIGN');
      const access = records.reduce((a, r) => (RANK[r.scope.access] > RANK[a] ? r.scope.access : a), 'public');
      const item = {access, treatment: policy.access[access], records, est, version: versionOfSupport(est)};
      if (r0.kind === 'entity') nodes.set(s, item); else rels.push({subject: s, type: r0.type, from: r0.from, to: r0.to, ...item});
    }
    const withheld = new Set([...nodes].filter(([, n]) => n.treatment === 'withhold').map(([id]) => id));
    const needles = [...withheld].flatMap(id => [id, decodeKey(id)]).filter((x, i, xs) => xs.indexOf(x) === i);
    const scrub = value => {
      if (typeof value === 'string') return needles.some(x => value.includes(x)) ? WITHHELD : value;
      if (Array.isArray(value)) return value.map(scrub);
      if (plain(value)) return Object.fromEntries(Object.entries(value).filter(([k]) => !needles.some(x => k.includes(x))).map(([k, x]) => [k, scrub(x)]));
      return value;
    };
    const detailsOf = records => {
      const attributes = {};
      for (const r of records) for (const [k, x] of Object.entries(r.attributes)) if (k !== REFERENCES && !Object.hasOwn(attributes, k)) attributes[k] = x;
      return scrub({attributes, provenance: records.map(r => ({classification: r.classification, origin: r.origin, status: r.status,
        source: {id: r.source.id, authority: r.source.authority, ref: r.source.ref}}))});
    };
    const outNodes = [];
    for (const [id, n] of [...nodes].sort(([a], [b]) => byString(a, b))) {
      if (n.treatment === 'withhold') continue;
      const refs = new Map();
      for (const r of n.records) for (const x of r.attributes[REFERENCES] ?? []) {
        const why = !plain(x) || Object.keys(x).length !== 2 ? 'a reference is {type, to}' : referenceRefusal(x.to)
          ?? (x.to.instance === me.instance ? `${id} references its own instance; that is a relationship, not a cross-instance reference` : null)
          ?? (!Object.hasOwn(RELATIONSHIPS, x.type) ? `"${x.type}" is not a registered relationship type`
            : !endpointAllowed(x.type, parseId(id), parseId(x.to.node)) ? `${x.type} does not join ${id} to ${x.to.node}` : null);
        if (why) fail(`${me.instance}: the cross-instance reference of ${id} is refused: ${why}`);
        if (!policy.relationships.includes(x.type)) { withheldRefs++; continue; }
        refs.set(canonical(x), {type: x.type, to: x.to});
      }
      const {domain, type} = parseId(id);
      outNodes.push({node: id, domain, type, access: n.access, version: n.version,
        references: [...refs.entries()].sort(([a], [b]) => byString(a, b)).map(([, x]) => x),
        ...(n.treatment === 'details' ? {details: detailsOf(n.records)} : {})});
    }
    const outRels = [];
    for (const r of rels) {
      if (!policy.relationships.includes(r.type) || r.treatment === 'withhold') { withheldRels++; continue; }
      const end = e => (nodes.has(e) && nodes.get(e).treatment !== 'withhold' ? e : policy.placeholders && nodes.has(e) ? {placeholder: placeholderOf(e)} : null);
      const from = end(r.from), to = end(r.to);
      if (from === null || to === null || (typeof from !== 'string' && typeof to !== 'string')) { withheldRels++; continue; }
      outRels.push({type: r.type, from, to, access: r.access, version: r.version, ...(r.treatment === 'details' ? {details: detailsOf(r.records)} : {})});
    }
    outRels.sort((a, b) => byString(canonical([a.type, a.from, a.to]), canonical([b.type, b.from, b.to])));
    // What changed since the previous export, each change with the department ledger entry it happened at.
    const at = seq => ({seq, entry: hashAt.get(seq)});
    const atVersion = version => ({seq: seqOf.get(version) ?? null, entry: version});
    const real = new Map(policy.placeholders ? [...withheld].map(id => [placeholderOf(id), id]) : []);
    const subjectOf = x => (x.node ? x.node : (() => {
      const [f, t] = [x.from, x.to].map(e => (typeof e === 'string' ? e : real.get(e.placeholder) ?? null));
      return f && t ? relationshipSubject(x.type, f, t, {symmetric: Boolean(RELATIONSHIPS[x.type]?.symmetric)}) : null;
    })());
    const retirement = (subject, after) => {
      let best = null;
      for (const a of subject ? v.query(subject, 'recorded') : []) if (a.retired && a.admitted <= after && a.retired.seq > after && (!best || a.retired.seq > best.seq)) best = a.retired;
      return best;
    };
    const changes = [];
    if (previous) {
      const keyOf = x => (x.node ? canonical({node: x.node}) : canonical({type: x.type, from: x.from, to: x.to}));
      const subjectRef = x => (x.node ? {node: x.node} : {relationship: {type: x.type, from: x.from, to: x.to}});
      const before = new Map([...previous.nodes, ...previous.relationships].map(x => [keyOf(x), x]));
      const now = new Map([...outNodes, ...outRels].map(x => [keyOf(x), x]));
      for (const [k, x] of now) {
        const p = before.get(k);
        if (!p) changes.push({subject: subjectRef(x), change: 'added', because: null, at: atVersion(x.version)});
        else if (canonical(p) !== canonical(x)) changes.push({subject: subjectRef(x), change: 'changed', because: retirement(subjectOf(x), previous.seq)?.how ?? null, at: atVersion(x.version)});
      }
      for (const [k, p] of before) if (!now.has(k)) {
        const r = retirement(subjectOf(p), previous.seq);
        changes.push({subject: subjectRef(p), change: 'removed', because: r?.how ?? null, at: r ? at(r.seq) : {seq: v.seq, entry: v.head}});
      }
      changes.sort((a, b) => byString(canonical(a.subject), canonical(b.subject)));
    }
    const body = {schema: EXPORT_SCHEMA, contract: GRAPH_SCHEMA, instance: me.instance, anchor: me.anchor, version: v.head, seq: v.seq,
      previous: previous?.id ?? null, exported_at, audience: {instance: hub.instance, anchor: hub.anchor},
      policy: {id: policy.id, version: policy.version, digest: policy.digest},
      nodes: outNodes, relationships: outRels,
      withheld: policy.counts ? {nodes: withheld.size, relationships: withheldRels, references: withheldRefs} : null, changes};
    const id = H(body);
    return {...body, id, signature: signOf({...body, id}, signer)};
  }

  /**
   * Publish the current export to this department's own outbox, chained after its last one. Idempotent: an unchanged
   * state (same ledger version, policy and audience) is not published again unless `refresh` (a heartbeat) asks.
   */
  function publish({exported_at = new Date().toISOString(), refresh = false} = {}) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const head = box.head();
      const e = exportAt(undefined, {exported_at, previous: head});
      if (head && !refresh && head.version === e.version && head.policy.digest === e.policy.digest && canonical(head.audience) === canonical(e.audience)) {
        return {published: false, export: head, why: 'unchanged since the last export'};
      }
      if (box.append(e)) return {published: true, export: e};
    }
    fail(`${me.instance}: another publisher kept extending the outbox`, 'FEDERATION_CONTENDED');
  }

  /** Why `notice` may not be recorded here, or null: signed by the pinned hub, addressed to this instance, about its nodes. */
  function noticeRefusal(notice, v) {
    if (!plain(notice) || notice.schema !== NOTICE_SCHEMA) return 'a notice is {schema: ophanim.graph.notice/v1, ...}';
    const {id, issued_at, signature, ...body} = notice;
    if (id !== H(body)) return 'the notice id is not the digest of its content';
    if (!TIME.test(issued_at ?? '') || !signatureValid({...body, id, issued_at}, signature, hub.keys)) return `the notice is not signed by a key of the pinned hub ${hub.instance}`;
    const via = identityRefusal({instance: hub.instance, anchor: hub.anchor}, body.via);
    if (via) return `the notice does not come through the pinned hub: ${via}`;
    const to = identityRefusal(me, body.to);
    if (to) return `the notice is not addressed to this instance: ${to}`;
    if (!plain(body.origin) || !INSTANCE_NAME.test(body.origin.instance ?? '') || !SHA256_REF.test(body.origin.anchor ?? '') || !Array.isArray(body.origin.changes)) return 'a notice keeps its origin {instance, anchor, export, version, seq, changes}';
    if (!Array.isArray(body.references) || !body.references.length) return 'a notice names the nodes of this instance it reaches';
    for (const r of body.references) if (!plain(r) || typeof r.node !== 'string' || instanceOf(r.node) !== me.instance || !v.nodeIn(r.node, 'possible')) return `the notice names ${r?.node}, which is not a node of ${me.instance}`;
    return null;
  }

  /**
   * Record a notice the hub issued, in this instance's own ledger as `by` (its receiver's key): an observation of the
   * originating change, kept restricted (it is never re-exported). Returns the local neighbourhood to reassess: the
   * reverse impact closure, in this instance's own graph, of the nodes the notice reaches. A repeat is a no-op.
   */
  function receive(notice, {by, observed_at = new Date().toISOString()} = {}) {
    const why = noticeRefusal(notice, graph.view());
    if (why) fail(`${me.instance} refuses the notice: ${why}`, 'FEDERATION_NOTICE');
    const {signature, ...kept} = notice;
    const record = assertion({entity: `${me.instance}/evidence/observation/notice-${hex(notice.id)}`, origin: receiver, classification: 'observed',
      run: {id: notice.id}, observed_at, scope: {access: 'restricted', owner: me.instance},
      source: {id: NOTICE_SOURCE, authority: `a propagation notice signed by the hub ${hub.instance}`, ref: `notice:${notice.id}`, version: notice.id},
      attributes: {notice: kept}});
    const w = graph.assert([record], by);
    const seeds = [...new Set(notice.references.map(r => r.node))].sort(byString);
    return {recorded: w.appended, record, seeds, affected: closure(graph.view(), seeds, {direction: 'reverse'})};
  }

  /** Pull and record the hub's notices for this instance. The hub being unreachable is reported, never an error. */
  function pull({by, observed_at} = {}) {
    let notices;
    try {
      if (!transport) throw new Error('no transport to the hub is configured');
      notices = transport.notices(me);
    } catch (e) { return {reachable: false, why: String(e.message ?? e), received: []}; }
    const received = [], refusedList = [];
    for (const n of notices) {
      try { received.push({id: n.id, ...receive(n, {by, observed_at})}); }
      catch (e) { if (e.code !== 'FEDERATION_NOTICE') throw e; refusedList.push({id: n?.id ?? null, why: e.message}); }
    }
    return {reachable: true, received, refused: refusedList};
  }

  // The department's own writes: only its own namespace and ownership (it never takes in another instance's node).
  const ownRefusal = r => {
    if (r.kind === 'retraction') return null;
    if (r.scope?.owner !== me.instance) return `${r.subject} is recorded as owned by ${r.scope?.owner}, not ${me.instance}`;
    for (const e of r.kind === 'entity' ? [r.subject] : [r.from, r.to]) if (instanceOf(e) !== me.instance) return `${e} is a node of ${instanceOf(e)}; ${me.instance} records only its own nodes (a dependency on another instance is a cross-instance reference)`;
    return null;
  };
  const guarded = kind => (records, by) => {
    for (const r of records) { const why = ownRefusal(r); if (why) fail(`${me.instance} refuses to record what it does not own: ${why}`, 'FEDERATION_UNAUTHORIZED'); }
    return graph.write(kind, records, by);
  };

  return {identity: me, graph, policy, outbox: box, exportAt, publish, published: () => box.all(), receive, pull,
    assert: guarded('graph.assert'), supersede: guarded('graph.supersede'), retract: guarded('graph.retract')};
}
/** The receiver origin a department composes into its registry (defineOrigins) to record notices with its own key. */
export const receiverOrigin = keys => ({[RECEIVER]: {kind: 'tool', basis: 'measured', keys}});

// ---- the central side -----------------------------------------------------------------------------------------------
/**
 * Why `e` is not an export the central may store for department `pinned` ({instance, anchor, keys}), or null:
 * {code, why}. It checks what can be checked without the department's ledger: identity, audience, id, signature, chain
 * fields, ownership (every node and endpoint the exporter's own), and that the policy's ceiling holds (no restricted
 * node, no details of an internal one).
 */
export function exportRefusal(e, {pinned, audience}) {
  const no = (why, code = 'FEDERATION_REFUSED') => ({code, why: `export of ${pinned.instance}: ${why}`});
  if (!plain(e) || e.schema !== EXPORT_SCHEMA || e.contract !== GRAPH_SCHEMA) return no(`an export is {schema: ${EXPORT_SCHEMA}, contract: ${GRAPH_SCHEMA}, ...}`);
  const {id, signature, ...body} = e;
  const who = identityRefusal(pinned, body);
  if (who) return no(who, 'FEDERATION_IDENTITY');
  const aud = identityRefusal(audience, body.audience);
  if (aud) return no(`it is not addressed to this hub: ${aud}`, 'FEDERATION_AUDIENCE');
  if (id !== H(body)) return no('its id is not the digest of its content', 'FEDERATION_SIGNATURE');
  if (!signatureValid({...body, id}, signature, pinned.keys)) return no(`it is not signed by a key pinned for ${pinned.instance}`, 'FEDERATION_SIGNATURE');
  if (!SHA256_REF.test(body.version ?? '') || !Number.isInteger(body.seq) || body.seq < 1 || (body.previous !== null && !SHA256_REF.test(body.previous ?? '')) || !TIME.test(body.exported_at ?? '')) return no('version, seq, previous and exported_at are malformed');
  if (!plain(body.policy) || !POLICY_ID.test(body.policy.id ?? '') || !SHA256_REF.test(body.policy.digest ?? '')) return no('it names its policy {id, version, digest}');
  if (!Array.isArray(body.nodes) || !Array.isArray(body.relationships) || !Array.isArray(body.changes)) return no('nodes, relationships and changes are lists');
  const seen = new Set();
  for (const n of body.nodes) {
    const why = idRefusal(n?.node);
    if (why) return no(why);
    if (instanceOf(n.node) !== pinned.instance) return no(`it lists ${n.node}, a node of ${instanceOf(n.node)}, as its own`, 'FEDERATION_FOREIGN');
    const p = parseId(n.node);
    if (n.domain !== p.domain || n.type !== p.type) return no(`${n.node}: domain and type are the id's`);
    if (n.access === 'restricted') return no(`it exports the restricted node ${n.node}`, 'FEDERATION_POLICY');
    if (!ACCESS.includes(n.access)) return no(`${n.node}: access is one of ${ACCESS.join(', ')}`);
    if (n.access !== 'public' && Object.hasOwn(n, 'details')) return no(`it exports the details of the ${n.access} node ${n.node}`, 'FEDERATION_POLICY');
    if (!SHA256_REF.test(n.version ?? '') || !Array.isArray(n.references)) return no(`${n.node}: version and references`);
    for (const r of n.references) {
      const w = !plain(r) || !Object.hasOwn(RELATIONSHIPS, r.type) ? 'a reference is {type, to}' : referenceRefusal(r.to);
      if (w) return no(`${n.node}: ${w}`);
      if (r.to.instance === pinned.instance || !endpointAllowed(r.type, p, parseId(r.to.node)) || !admits(r.type, 'derived', 'declared')) return no(`${n.node}: the reference ${r.type} -> ${r.to.node} cannot be linked`);
    }
    if (seen.has(n.node)) return no(`${n.node} is listed twice`);
    seen.add(n.node);
  }
  for (const r of body.relationships) {
    if (!plain(r) || !Object.hasOwn(RELATIONSHIPS, r.type) || !admits(r.type, 'authoritative', 'declared')) return no(`relationship type ${r?.type} cannot be imported`);
    if (!ACCESS.includes(r.access) || r.access === 'restricted') return no(`it exports a ${r.access} relationship ${r.type}`, 'FEDERATION_POLICY');
    if (r.access !== 'public' && Object.hasOwn(r, 'details')) return no(`it exports the details of an ${r.access} relationship`, 'FEDERATION_POLICY');
    const ends = [r.from, r.to];
    for (const x of ends) {
      if (typeof x === 'string') {
        if (instanceOf(x) !== pinned.instance) return no(`a relationship joins ${x}, a node of ${instanceOf(x)}`, 'FEDERATION_FOREIGN');
        if (!seen.has(x)) return no(`a relationship joins ${x}, which the export does not list`);
      } else if (!plain(x) || Object.keys(x).length !== 1 || !PLACEHOLDER.test(x.placeholder ?? '')) return no('a withheld endpoint is {placeholder}');
    }
    if (ends.every(x => typeof x !== 'string')) return no('a relationship between two withheld endpoints is never exported', 'FEDERATION_POLICY');
    if (ends.every(x => typeof x === 'string') && !endpointAllowed(r.type, parseId(r.from), parseId(r.to))) return no(`${r.type} does not join ${r.from} to ${r.to}`);
  }
  // What changed: each change names a subject of the exporter's own, how, and the ledger entry it happened at.
  const own = x => typeof x === 'string' ? !idRefusal(x) && instanceOf(x) === pinned.instance : plain(x) && Object.keys(x).length === 1 && PLACEHOLDER.test(x.placeholder ?? '');
  for (const c of body.changes) {
    const s = plain(c) ? c.subject : null;
    const subjectOk = plain(s) && Object.keys(s).length === 1 && (typeof s.node === 'string' ? own(s.node)
      : plain(s.relationship) && Object.hasOwn(RELATIONSHIPS, s.relationship.type) && own(s.relationship.from) && own(s.relationship.to));
    if (!subjectOk) return no(`a change names ${canonical(s ?? null)}, which is not a subject of ${pinned.instance}`, 'FEDERATION_FOREIGN');
    if (!['added', 'changed', 'removed'].includes(c.change) || (c.because !== null && typeof c.because !== 'string')) return no('a change is added, changed or removed, with why or null');
    if (!plain(c.at) || (c.at.seq !== null && !Number.isInteger(c.at.seq)) || !SHA256_REF.test(c.at.entry ?? '')) return no('a change names the ledger entry it happened at {seq, entry}');
  }
  return null;
}

/** The origin registry of a central instance: one import extractor per department and the linker rule. */
export function centralOrigins({departments, importKeys, linkKeys}) {
  const spec = {};
  for (const inst of departments) spec[importSource(inst)] = {kind: 'extractor', basis: 'declared', keys: importKeys, sources: [importSource(inst)]};
  spec[LINKER] = {kind: 'rule', basis: 'declared', keys: linkKeys};
  return defineOrigins(spec);
}

/**
 * Open the central instance at `dir` (its ledger in `dir/ledger`, pinned to `anchor`; the exports it received in
 * `dir/inbox`; the notices it issued in `dir/outbox`). `departments`: {instance: {anchor, keys, transport, maxAgeMs}},
 * each pinned by identity and the keys its exports are signed with. The central's write boundary refuses anything in a
 * department's namespace or ownership; it never opens a department's ledger.
 */
export function openCentral({dir, anchor, instance = 'central', departments, importKeys, linkKeys, maxAgeMs = DEFAULT_MAX_AGE_MS,
  lockTimeoutMs = 60_000, lockStaleMs = 600_000, ...opts}) {
  const names = Object.keys(departments ?? {}).sort(byString);
  if (!names.length) fail('a central instance federates at least one department');
  for (const n of names) {
    if (!INSTANCE_NAME.test(n) || n === instance) fail(`department "${n}" is not an instance name distinct from the central's`);
    if (!SHA256_REF.test(departments[n].anchor ?? '') || !plain(departments[n].keys) || !Object.keys(departments[n].keys).length) fail(`department ${n} is pinned by its anchor and its export keys`);
  }
  const origins = centralOrigins({departments: names, importKeys, linkKeys});
  const pinned = Object.fromEntries(names.map(n => [n, Object.freeze({instance: n, anchor: departments[n].anchor, keys: departments[n].keys})]));
  const reach = new Map();                                             // this process's last fetch of each department
  const inboxDir = path.join(dir, 'inbox'), noticeDir = path.join(dir, 'outbox');
  const me = Object.freeze({instance, anchor});                       // known before the first replay re-derives an import
  let graph = null;

  // ---- the inbox: the exports received, by id; the chain by `previous` --------------------------------------------
  const cache = new Map();
  function load(inst) {
    let c = cache.get(inst);
    if (!c) { c = {byId: new Map(), byPrevious: new Map()}; cache.set(inst, c); }
    let files = [];
    try { files = fs.readdirSync(path.join(inboxDir, inst)).filter(n => /^[0-9a-f]{64}\.json$/.test(n)); } catch {}
    for (const f of files) {
      const id = 'sha256:' + f.slice(0, 64);
      if (c.byId.has(id)) continue;
      const e = readJson(path.join(inboxDir, inst, f));
      if (!e || e.id !== id) continue;
      c.byId.set(id, e);
      const p = e.previous ?? 'genesis';
      if (!c.byPrevious.has(p) || byString(id, c.byPrevious.get(p).id) < 0) c.byPrevious.set(p, e);
    }
    return c;
  }
  // Inbox files are written once and never change: a cached entry stays valid, and only a miss reads the directory.
  const inbox = {
    get: (inst, id) => (id ? cache.get(inst)?.byId.get(id) ?? load(inst).byId.get(id) ?? null : null),
    next: (inst, previous) => cache.get(inst)?.byPrevious.get(previous ?? 'genesis') ?? load(inst).byPrevious.get(previous ?? 'genesis') ?? null,
    chain(inst) { const out = []; for (let e = inbox.next(inst, null); e && out.length < 1_000_000; e = inbox.next(inst, e.id)) out.push(e); return out; },
  };
  /** Store exports offered for `inst` after checking each; {stored, refused}. A second export after the same one is a fork, refused. */
  function offer(inst, exports) {
    if (!Object.hasOwn(pinned, inst)) fail(`${inst} is not an instance this hub federates`, 'FEDERATION_IDENTITY');
    const stored = [], refusedList = [];
    for (const e of exports) {
      if (inbox.get(inst, e?.id)) continue;
      const no = exportRefusal(e, {pinned: pinned[inst], audience: me});
      const fork = no ? null : inbox.next(inst, e.previous);
      if (no || fork) { refusedList.push({id: e?.id ?? null, ...(no ?? {code: 'FEDERATION_FORK', why: `export of ${inst}: ${fork.id} already follows ${e.previous ?? 'the start of the chain'}`})}); continue; }
      writeOnce(path.join(inboxDir, inst, hex(e.id) + '.json'), e);
      load(inst);
      stored.push(e.id);
    }
    return {stored, refused: refusedList};
  }

  // ---- each department is a registered source of the central graph ------------------------------------------------
  const lastRecord = inst => graph.projection.sourceNode(importSource(inst));
  function adapter(inst) {
    const draftsOf = e => {
      const out = [], edges = new Map();
      for (const r of e.relationships) {
        const [id, other, direction] = typeof r.from === 'string' && typeof r.to !== 'string' ? [r.from, r.to, 'out'] : typeof r.to === 'string' && typeof r.from !== 'string' ? [r.to, r.from, 'in'] : [null];
        if (id) { if (!edges.has(id)) edges.set(id, []); edges.get(id).push({type: r.type, direction, placeholder: other.placeholder, access: r.access}); continue; }
        out.push({type: r.type, from: r.from, to: r.to, scope: {access: r.access, owner: inst}, ref: `inbox/${inst}#${r.type}`,
          attributes: {access: r.access, version: r.version, ...(r.details ? {details: r.details} : {})}});
      }
      for (const n of e.nodes) {
        const w = (edges.get(n.node) ?? []).sort((a, b) => byString(canonical(a), canonical(b)));
        out.unshift({entity: n.node, scope: {access: n.access, owner: inst}, ref: `inbox/${inst}#node`,
          attributes: {access: n.access, version: n.version, references: n.references, ...(n.details ? {details: n.details} : {}), ...(w.length ? {withheld_edges: w} : {})}});
      }
      return out;
    };
    return {
      id: importSource(inst), extractor: importSource(inst), ref: `inbox/${inst}`,
      authority: `the signed export of instance ${inst} (anchor ${pinned[inst].anchor}), as its access policy permits`,
      // The version to import next: the export that follows the last one imported. Unreachable: refused, recorded so.
      current() {
        const r = reach.get(inst);
        if (r && !r.ok) throw new Error(`instance ${inst} cannot be reached: ${r.why}`);
        const at = lastRecord(inst)?.source.version ?? null;
        const e = inbox.next(inst, at) ?? inbox.get(inst, at);
        if (!e) throw new Error(at ? `the export ${at} of ${inst} is not in the inbox` : `nothing has been received from ${inst}`);
        return {version: e.id, effective_at: e.exported_at};
      },
      // Replay re-derives each import from the stored export, checked again; one missing or altered is never invented.
      readAt(version) {
        const e = inbox.get(inst, version);
        if (!e) throw new Error(`the export ${version} of ${inst} is not in the inbox`);
        const no = exportRefusal(e, {pinned: pinned[inst], audience: me});
        if (no) throw new Error(no.why);
        return draftsOf(e);
      },
    };
  }
  graph = openGraph({dir: path.join(dir, 'ledger'), anchor, origins, sources: names.map(adapter), instance, lockTimeoutMs, lockStaleMs, ...opts});

  // ---- the write boundary: the central records only what it owns ----------------------------------------------------
  const importOrigins = new Set(names.map(importSource));
  const centralRefusal = r => {
    if (r.kind === 'retraction') return null;
    if (r.scope?.owner !== me.instance) return `${r.subject} would be recorded as owned by ${r.scope?.owner}: the central never records a department's assertion`;
    if (r.kind === 'entity' && instanceOf(r.subject) !== me.instance) return `${r.subject} is in the namespace of ${instanceOf(r.subject)}: the central never writes a department's graph`;
    if (importOrigins.has(r.origin)) return `${r.origin} admits only by importing an export`;
    return null;
  };
  function write(kind, records, by) {
    for (const r of records) { const why = centralRefusal(r); if (why) fail(`the central refuses: ${why}`, 'FEDERATION_UNAUTHORIZED'); }
    return graph.write(kind, records, by);
  }

  // ---- reading the imports -------------------------------------------------------------------------------------------
  /** The established import fact of `node` in view `v`, or null. */
  const factOf = (v, node) => {
    for (const a of v.query(node, 'established')) if (importOrigins.has(a.origin)) return v.assertion(a.id).record;
    return null;
  };
  /** Every imported node in `v` that carries references: [[node, fact]]. */
  function referring(v) {
    const out = [];
    for (const s of v.subjects()) {
      const f = factOf(v, s);
      if (f && f.kind === 'entity' && f.attributes.references?.length) out.push([s, f]);
    }
    return out;
  }
  /** Resolve a cross-instance reference against view `v`: {resolved: true, node, fact} or {resolved: false, reason, why}. */
  function resolveIn(v, ref) {
    const bad = referenceRefusal(ref);
    if (bad) return {resolved: false, reason: 'malformed', why: bad};
    if (!Object.hasOwn(pinned, ref.instance)) return {resolved: false, reason: 'unknown-instance', why: `${ref.instance} is not an instance this hub federates`};
    const who = identityRefusal(pinned[ref.instance], ref);
    if (who) return {resolved: false, reason: 'wrong-anchor', why: who};
    if (!v.sources().some(s => s.id === importSource(ref.instance))) return {resolved: false, reason: 'not-imported', why: `nothing of ${ref.instance} has been imported`};
    const f = factOf(v, ref.node);
    // A node absent and a node withheld are indistinguishable here: the export never said which.
    if (!f) return {resolved: false, reason: 'missing-node', why: `${ref.node} is not among what ${ref.instance} exports`};
    if (f.attributes.version !== ref.version) return {resolved: false, reason: 'stale-version', why: `${ref.node} is at ${f.attributes.version}, not ${ref.version}`, current_version: f.attributes.version};
    return {resolved: true, node: {id: ref.node, ...parseId(ref.node), access: f.attributes.access, version: f.attributes.version, ...(f.attributes.details ? {details: f.attributes.details} : {})}, fact: f};
  }

  // ---- the linker: cross-department relationships derived from resolved references -----------------------------------
  const linkRecord = (node, ref, inputs, observed_at, supersedes = []) => assertion({type: ref.type, from: node, to: ref.to.node,
    origin: LINKER, classification: 'derived', observed_at, inputs: [...inputs].sort(byString), supersedes,
    source: {id: LINK_SOURCE, authority: `the cross-instance references of the exports ${me.instance} imported, resolved against the pinned anchors`, ref: `link:${node}`, version: null},
    scope: {access: 'internal', owner: me.instance},
    attributes: {reference: ref.to, from_instance: instanceOf(node), to_instance: ref.to.instance}});
  const linkKey = r => canonical({subject: r.subject, inputs: r.inputs, attributes: r.attributes});
  function linkPlan(v, observed_at) {
    const desired = new Map(), refsOf = new Map();
    for (const [node, f] of referring(v)) {
      refsOf.set(node, new Set(f.attributes.references.map(x => canonical(x.to))));
      for (const ref of f.attributes.references) {
        const res = resolveIn(v, ref.to);
        if (!res.resolved) continue;
        const rec = linkRecord(node, ref, [f.id, res.fact.id], observed_at);
        if (!desired.has(rec.subject)) desired.set(rec.subject, rec);
      }
    }
    const existing = new Map();
    for (const s of v.subjects()) {
      const cur = v.query(s, 'recorded').filter(a => a.current && a.origin === LINKER);
      if (cur.length) existing.set(s, cur.map(a => v.assertion(a.id).record));
    }
    const add = [], supersede = [], retract = [];
    for (const [s, rec] of desired) {
      const cur = existing.get(s) ?? [];
      if (cur.some(x => linkKey(x) === linkKey(rec))) continue;
      if (cur.length) supersede.push(linkRecord(rec.from, {type: rec.type, to: rec.attributes.reference}, rec.inputs, observed_at, cur.map(x => x.id)));
      else add.push(rec);
    }
    // A link whose reference its node no longer carries is retracted; one whose reference no longer resolves stays,
    // stale (an input changed) and visible as unresolved.
    for (const [s, cur] of existing) if (!desired.has(s)) for (const x of cur) {
      if (refsOf.get(x.from)?.has(canonical(x.attributes.reference))) continue;
      retract.push(retraction({retracts: x.id, origin: LINKER, reason: `${x.from} no longer carries the reference to ${x.attributes.reference.node}`, observed_at}));
    }
    return {add, supersede, retract};
  }
  function link(by, observed_at) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const plan = linkPlan(graph.view(), observed_at);
      try {
        if (plan.add.length) write('graph.assert', plan.add, by);
        if (plan.supersede.length) write('graph.supersede', plan.supersede, by);
        if (plan.retract.length) write('graph.retract', plan.retract, by);
        return {linked: plan.add.length, relinked: plan.supersede.length, retracted: plan.retract.length};
      } catch (e) {
        if (e.code === 'GRAPH_REFUSED' && /GRAPH_(STALE|DUPLICATE|REFERENCE)/.test(e.message)) { graph.refresh(); continue; }
        throw e;
      }
    }
    fail('the central graph kept moving under the linker', 'FEDERATION_CONTENDED');
  }

  // ---- propagation: each imported change, followed to the instances that depend on it --------------------------------
  /** The notices the imports of the central ledger call for, issued (signed, written once) to the central's outbox. */
  function propagate(signer, issued_at) {
    const issued = [];
    let truncated = false;
    for (let after = 0; ;) {
      const page = graph.events({after, limit: 1000});
      for (const ev of page.events) {
        if (!ev.source.startsWith('federation.') || ev.state !== 'current' || ev.replay !== 'applied') continue;
        const inst = ev.source.slice('federation.'.length), exp = inbox.get(inst, ev.to_version);
        if (!exp?.changes?.length) continue;
        const views = [graph.view(ev.seq - 1), graph.view(ev.seq)];
        const recipients = new Map();
        exp.changes.forEach((c, index) => {
          const seeds = [];
          if (c.subject.node) seeds.push(c.subject.node);
          else {
            const {type, from, to} = c.subject.relationship, impact = RELATIONSHIPS[type]?.impact;
            const dependent = impact === 'to->from' ? from : impact === 'from->to' ? to : null;
            if (typeof dependent === 'string') seeds.push(dependent);
          }
          if (!seeds.length) return;
          for (const v of views) {
            const r = closure(v, seeds, {direction: 'reverse', mode: 'established'});
            truncated ||= r.coverage.truncated;
            for (const n of r.nodes) {
              const to = instanceOf(n.id);
              if (to === inst || !Object.hasOwn(pinned, to)) continue;
              // where the path enters the recipient: a link the central derived, and the reference behind it
              const step = n.path.findLast(s => (instanceOf(s.from) === to) !== (instanceOf(s.to) === to));
              const lk = step?.assertions.map(id => v.assertion(id)?.record).find(x => x?.origin === LINKER);
              if (!lk) continue;
              const own = instanceOf(lk.from) === to;
              if (!recipients.has(to)) recipients.set(to, {references: new Map(), changes: new Set()});
              const got = recipients.get(to);
              const entry = {node: own ? lk.from : lk.to, type: lk.type, reference: own ? lk.attributes.reference : null, counterpart: own ? lk.attributes.to_instance : lk.attributes.from_instance};
              got.references.set(canonical(entry), entry);
              got.changes.add(index);
            }
          }
        });
        for (const [to, got] of [...recipients].sort(([a], [b]) => byString(a, b))) {
          const references = [...got.references.entries()].sort(([a], [b]) => byString(a, b)).map(([, x]) => x);
          const named = new Set(references.filter(x => x.reference).map(x => x.reference.node));
          const changes = [...got.changes].sort((a, b) => a - b).map(i => exp.changes[i]).map(c => ({change: c.change, because: c.because, at: c.at,
            subject: c.subject.node && named.has(c.subject.node) ? c.subject : null}));
          const body = {schema: NOTICE_SCHEMA,
            origin: {instance: inst, anchor: exp.anchor, export: exp.id, version: exp.version, seq: exp.seq, changes},
            via: {instance: me.instance, anchor: me.anchor, seq: ev.seq, entry: ev.hash},
            to: {instance: to, anchor: pinned[to].anchor}, references};
          const id = H(body), notice = {...body, id, issued_at, signature: signOf({...body, id, issued_at}, signer)};
          if (writeOnce(path.join(noticeDir, to, hex(id) + '.json'), notice)) issued.push(id);
        }
      }
      if (!page.more) break;
      after = page.cursor;
    }
    return {issued, truncated};
  }

  // ---- catch-up -------------------------------------------------------------------------------------------------------
  /** Fetch from `inst`'s transport into the inbox; records whether it could be reached (this process). */
  function fetchFrom(inst, at) {
    let list;
    try { list = departments[inst].transport.fetch(); }
    catch (e) { reach.set(inst, {ok: false, why: String(e.message ?? e), at}); return {reachable: false, why: String(e.message ?? e), stored: [], refused: []}; }
    reach.set(inst, {ok: true, at});
    return {reachable: true, ...offer(inst, list)};
  }
  const pendingOf = inst => {
    const last = lastRecord(inst), at = last?.source.version ?? null;
    return inbox.next(inst, at) ?? (last && last.attributes.state !== 'current' ? inbox.get(inst, at) : null);
  };
  // One catch-up at a time: imports, links and notices are one ordered sequence, so which notices an import calls for
  // does not depend on how two processes interleave. (Each import is recorded once without this lock too: the graph
  // ledger's cursor rule and idempotency.) A lock whose holder died on this host, or older than lockStaleMs, is broken.
  function exclusive(fn) {
    const lock = path.join(dir, 'catch-up.lock'), host = os.hostname();
    const token = JSON.stringify({pid: process.pid, host, time: Date.now(), nonce: randomBytes(8).toString('hex')});
    const deadline = Date.now() + lockTimeoutMs;
    fs.mkdirSync(dir, {recursive: true});
    for (let wait = 1; ;) {
      try { fs.writeFileSync(lock, token, {flag: 'wx'}); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      let held = null; try { held = fs.readFileSync(lock, 'utf8'); } catch { continue; }
      let rec = null; try { rec = JSON.parse(held); } catch {}
      const dead = rec?.host === host && Number.isInteger(rec.pid) && rec.pid !== process.pid && (() => { try { process.kill(rec.pid, 0); return false; } catch (e) { return e.code !== 'EPERM'; } })();
      if (dead || Date.now() - (Number.isFinite(rec?.time) ? rec.time : 0) > lockStaleMs) {
        const aside = `${lock}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
        try { fs.renameSync(lock, aside); if (fs.readFileSync(aside, 'utf8') !== held) { try { fs.linkSync(aside, lock); } catch {} } fs.rmSync(aside, {force: true}); } catch {}
        continue;
      }
      if (Date.now() > deadline) fail('another catch-up holds the central instance', 'FEDERATION_CONTENDED');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      wait = Math.min(wait * 2, 50);
    }
    try { return fn(); }
    finally { let held = null; try { held = fs.readFileSync(lock, 'utf8'); } catch {} if (held === token) fs.rmSync(lock, {force: true}); }
  }

  /**
   * Catch up: fetch from every department, record those that cannot be reached, import every pending export BY
   * VERSION (each department's chain in order, departments interleaved by export time), link after each import, and
   * issue the notices the imports call for. `by`: {import: {signer, order}, link: {signer, order}, notice: signer}.
   */
  const catchUp = (o = {}) => exclusive(() => catchUpLocked(o));
  function catchUpLocked({by, now = new Date().toISOString()} = {}) {
    const fetched = Object.fromEntries(names.map(n => [n, fetchFrom(n, now)]));
    graph.refresh();
    const imported = Object.fromEntries(names.map(n => [n, []])), recorded = {};
    for (const n of names) if (!fetched[n].reachable && lastRecord(n)) {
      const r = graph.observe(importSource(n), {...by.import, observed_at: now});
      if (r.recorded) recorded[n] = r.state;
    }
    const done = new Set(names.filter(n => !fetched[n].reachable));
    const limit = names.reduce((k, n) => k + inbox.chain(n).length, 0) + names.length + 1;
    for (let step = 0; step < limit; step++) {
      let pick = null;
      for (const n of names) {
        if (done.has(n)) continue;
        const e = pendingOf(n);
        if (!e) { done.add(n); continue; }
        if (!pick || e.exported_at < pick.e.exported_at || (e.exported_at === pick.e.exported_at && n < pick.n)) pick = {n, e};
      }
      if (!pick) break;
      const r = graph.observe(importSource(pick.n), {...by.import, observed_at: now});
      if (!r.recorded) { done.add(pick.n); continue; }
      if (r.state !== 'current') { recorded[pick.n] = r.state; done.add(pick.n); }
      else if (r.record.source.version !== r.record.attributes.from_version) imported[pick.n].push(r.record.source.version);
      else recorded[pick.n] = 'current';                              // reachable again, at the version it last imported
      link(by.link, now);
    }
    const links = link(by.link, now);
    const notices = propagate(by.notice, now);
    return {fetched, imported, recorded, links, notices};
  }

  // ---- freshness and answers (KE5) -----------------------------------------------------------------------------------
  /** Where each department's import stands at `now`: current, stale (with every reason) or never-imported. */
  function freshness({now = new Date().toISOString(), view = graph.view()} = {}) {
    const out = {};
    for (const n of names) {
      const s = view.sources().find(x => x.id === importSource(n)) ?? null;
      const node = `${me.instance}/evidence/source/${importSource(n)}`;
      const last = view.query(node, 'recorded').filter(a => view.assertion(a.id).record.attributes.state === 'current').at(-1);
      const rec = last ? view.assertion(last.id).record : null;
      const e = rec ? inbox.get(n, rec.source.version) : null;
      const bound = departments[n].maxAgeMs ?? maxAgeMs;
      const reasons = [];
      if (!s) reasons.push('nothing has been imported');
      else {
        if (s.state === 'unavailable') reasons.push(`unreachable, as recorded at ${s.observed_at}: ${s.why}`);
        if (s.state === 'stale') reasons.push(`an export could not be imported: ${s.why}`);
        if (s.replay !== 'applied' && s.replay !== 'recorded') reasons.push(`its import could not be re-derived here (${s.replay})`);
      }
      const r = reach.get(n);
      if (r && !r.ok && s?.state !== 'unavailable') reasons.push(`unreachable at ${r.at}: ${r.why}`);
      const age = rec?.effective_at ? Date.parse(now) - Date.parse(rec.effective_at) : null;
      if (age !== null && age > bound) reasons.push(`older than its bound: exported ${age} ms ago, bound ${bound} ms`);
      const chain = inbox.chain(n), i = rec ? chain.findIndex(x => x.id === rec.source.version) : -1;
      const pending = chain.length - (i + 1);
      if (pending > 0) reasons.push(`${pending} received export(s) not yet imported`);
      out[n] = {instance: n, anchor: pinned[n].anchor, state: !s ? 'never-imported' : reasons.length ? 'stale' : 'current', reasons,
        export: rec?.source.version ?? null, version: e?.version ?? null, seq: e?.seq ?? null, exported_at: rec?.effective_at ?? null,
        imported_at: rec?.observed_at ?? null, age_ms: age, bound_ms: bound, pending};
    }
    return out;
  }
  /** Every central answer carries the freshness of the instances it used, and marks what is stale. */
  function answer(instances, body, now) {
    const f = freshness({now}), used = [...new Set(instances)].filter(n => Object.hasOwn(f, n)).sort(byString);
    return {...body, freshness: Object.fromEntries(used.map(n => [n, f[n]])), stale: used.filter(n => f[n].state !== 'current')};
  }
  const staleSet = now => new Set(Object.values(freshness({now})).filter(x => x.state !== 'current').map(x => x.instance));

  /** Resolve a cross-instance reference now, with the freshness of its instance. */
  function resolve(ref, {now = new Date().toISOString()} = {}) {
    const r = resolveIn(graph.view(), ref);
    const {fact, ...rest} = r;
    return answer([ref?.instance], {...rest, reference: ref, ...(fact ? {assertion: fact.id} : {})}, now);
  }

  /**
   * Cross-department dependency discovery over the imported relationships only: every link the central derived (with
   * whether it is established, and its reference), every reference that does not resolve (and why), and the withheld
   * endpoints departments declared, each marked stale when an instance it rests on is.
   */
  function dependencies({now = new Date().toISOString()} = {}) {
    const v = graph.view(), stale = staleSet(now), used = new Set();
    const links = [], unresolved = [], withheld = [];
    for (const s of v.subjects()) {
      for (const a of v.query(s, 'recorded').filter(x => x.current && x.origin === LINKER)) {
        const r = v.assertion(a.id).record;
        used.add(r.attributes.from_instance); used.add(r.attributes.to_instance);
        links.push({type: r.type, from: r.from, to: r.to, from_instance: r.attributes.from_instance, to_instance: r.attributes.to_instance,
          reference: r.attributes.reference, assertion: a.id, established: v.established(a.id),
          stale: stale.has(r.attributes.from_instance) || stale.has(r.attributes.to_instance)});
      }
      const f = factOf(v, s);
      if (f?.kind === 'entity' && f.attributes.withheld_edges) for (const w of f.attributes.withheld_edges) withheld.push({node: s, instance: instanceOf(s), ...w, stale: stale.has(instanceOf(s))});
    }
    for (const [node, f] of referring(v)) for (const ref of f.attributes.references) {
      const r = resolveIn(v, ref.to);
      if (r.resolved) continue;
      used.add(instanceOf(node)); used.add(ref.to.instance);
      unresolved.push({from: node, type: ref.type, reference: ref.to, reason: r.reason, why: r.why, ...(r.current_version ? {current_version: r.current_version} : {}),
        stale: stale.has(instanceOf(node)) || stale.has(ref.to.instance)});
    }
    return answer([...used], {cursor: v.seq, links, unresolved, withheld}, now);
  }

  /** A bounded traversal over the central projection (Slice A `closure`), each node marked with its instance and staleness. */
  function traverse(start, opts = {}) {
    const {now = new Date().toISOString(), ...o} = opts;
    const r = closure(graph.view(), start, o), stale = staleSet(now);
    const nodes = r.nodes.map(n => ({...n, instance: instanceOf(n.id), stale: stale.has(instanceOf(n.id))}));
    return answer(nodes.map(n => n.instance).filter(n => Object.hasOwn(pinned, n)), {...r, nodes}, now);
  }

  return {
    identity: me, graph, departments: pinned, inbox, offer, catchUp, freshness, resolve, dependencies, closure: traverse,
    notices: inst => noticeTransport(dir).notices({instance: inst}),
    link: (by, observed_at = new Date().toISOString()) => link(by, observed_at),
    propagate: (signer, issued_at = new Date().toISOString()) => propagate(signer, issued_at),
    assert: (records, by) => write('graph.assert', records, by),
    supersede: (records, by) => write('graph.supersede', records, by),
    retract: (records, by) => write('graph.retract', records, by),
  };
}
