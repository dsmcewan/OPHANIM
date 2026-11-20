// A SIBLING'S OWN SIGNED DEPENDENCY WEAVE, brought in as what the sibling DECLARES (TELOS's Clotho).
//
// Purpose   TELOS already weaves its own dependency graph: Clotho (clotho/weave.mjs, thread-ledger.mjs at TELOS 0c9b539)
//           extracts edges between its symbols, tests, documents and commits, chains each record to the one before by
//           hash, signs it, and commits a snapshot of the ledger. That is evidence OPHANIM did not produce and should not
//           re-derive by resemblance. This source reads the committed snapshot at a commit, checks the chain, and states
//           each record as a relationship the sibling declares, beside OPHANIM's own reading of the same code (code.mjs):
//           where both state an edge it has two independent supports, and where only one does, that is visible.
// Inputs    The sibling's repository root, a commit, its name in the graph, and the snapshot's path.
// Outputs   weaveSource(); weaveFacts(); WEAVE_ORIGIN; weaveSourceIdOf(name); canonical() (the ledger's line form).
// Checked   Line by line, as Clotho's own verifier does for these three properties: every line is canonical JSON (keys
//           sorted, no spacing); a record's prev_hash is the sha256 of the line before; its record_hash is the sha256 of
//           its content with prev_hash; its signature verifies over the record hash under the key in the header.
//           NOT re-run: Clotho's closure, inventory and count checks. The key travels in the weave's own header, so a
//           signature is evidence against tampering, not of who signed.
// Facts     depends-on      symbol or file -> symbol or file, as declared; and file -> file where the weave declares a
//                           dependency between symbols of two files
//           verified-by     symbol or file -> the check the weave names (a `systems/test` node of its own, derived-from
//                           the file: what TELOS calls a test is not always a test by this repository's file naming)
//           documented-in   symbol or file -> the document, with the section's heading path and digest (the section is
//                           NOT re-derived here: `checked: false`)
//           derived-from    symbol or file -> the sibling's commit that introduced it
// Invariants  A record is stated only if every file it was woven from is still that blob at the commit read; otherwise
//           it is counted as stale with the blob it was woven from. Record kinds with no registered counterpart
//           (obligations, concerns, run evidence) are counted, by kind, never forced into another relationship.
// Must never  State anything from a weave that does not verify; run the sibling's code; treat the header's key as an
//           identity; state a stale record as current.
import {createHash, createPublicKey, verify as edVerify} from 'node:crypto';
import {treeAt, blobsAt, resolveCommit} from '../extract/git.mjs';
import {repositoryId, fileIdIn, symbolIdIn, checkIdIn, commitId} from './ids.mjs';

export const WEAVE_PATH = 'docs/runs/clotho-self-weave/thread-ledger.snapshot.jsonl';
export const WEAVE_EXTRACTOR = 'sibling.weave.extractor';
export const weaveSourceIdOf = name => `sibling.${name}.weave`;
/** DECLARED: what the sibling's signed ledger states (the registry admits verified-by from nothing weaker). */
export const WEAVE_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [weaveSourceIdOf('telos')]});

const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);
/** A ledger line: JSON with every object's keys sorted and no spacing. */
export const canonical = v => JSON.stringify(sortKeys(v));
const sha = x => createHash('sha256').update(x).digest('hex');
const DECLARED = 'the sibling\'s signed weave declares it';
const TYPES = {'depends-on': 'depends-on', 'verified-by': 'verified-by', 'documented-in': 'documented-in', 'introduced-by': 'derived-from'};

/** The first reason the ledger does not verify, or null; fills `records` with [{line, record}] on the way. */
function refusal(lines, records) {
  let header;
  try { header = JSON.parse(lines[0])?.clotho_weave_header; } catch { /* reported below */ }
  if (!header || typeof header.pub_key !== 'string') return 'line 1: not a weave header';
  let key;
  try { key = createPublicKey({key: Buffer.from(header.pub_key, 'base64'), format: 'der', type: 'spki'}); } catch { return 'line 1: the header\'s key is not a public key'; }
  for (let i = 1; i < lines.length; i++) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { return `line ${i + 1}: not JSON`; }
    if (canonical(o) !== lines[i]) return `line ${i + 1}: not canonical JSON`;
    if (o.clotho_weave_trailer) { if (i !== lines.length - 1) return `line ${i + 1}: a trailer before the end`; break; }
    const {prev_hash, record_hash, signature, ...payload} = o;
    if (prev_hash !== sha(lines[i - 1])) return `line ${i + 1}: broken chain (prev_hash is not the hash of the line before)`;
    if (record_hash !== sha(canonical({...payload, prev_hash}))) return `line ${i + 1}: record hash does not match its content`;
    let ok = false;
    try { ok = typeof signature === 'string' && edVerify(null, Buffer.from(record_hash, 'hex'), key, Buffer.from(signature, 'base64')); } catch { ok = false; }
    if (!ok) return `line ${i + 1}: the signature does not verify under the header's key`;
    records.push({line: i + 1, record: o});
  }
  return null;
}

/** The facts the sibling's weave declares at `commit`, as the extractor's drafts. */
export function weaveFacts(repo, commit, {name = 'telos', path = WEAVE_PATH} = {}) {
  const tree = treeAt(repo, commit), entries = new Map(tree.entries.map(e => [e.path, e])), at = entries.get(path);
  const failed = why => [{entity: repositoryId(name), ref: path, status: 'unresolved', missing_evidence: [why], attributes: {read_at: commit, weave: {path}}}];
  if (!at) return failed(`${path} is not in the tree at this commit`);
  const lines = blobsAt(repo, [at.blob]).get(at.blob).toString('utf8').split('\n').filter(Boolean), records = [];
  const why = refusal(lines, records);
  if (why) return failed(why);
  const header = JSON.parse(lines[0]).clotho_weave_header;

  const entities = new Map(), edges = new Map(), implied = new Map(), unmapped = {}, staleExamples = [];
  let stated = 0, stale = 0;
  const entity = (id, ref, attributes) => { if (!entities.has(id)) entities.set(id, {entity: id, ref, attributes}); };
  /** A locator as a node of this graph, or null where no registered type fits. `stale` names a blob that has changed. */
  const nodeOf = loc => {
    const l = loc?.locator ?? {}, here = l.path === undefined ? null : entries.get(l.path);
    const changed = l.blob_sha !== undefined && here?.blob !== l.blob_sha ? {path: l.path, woven_from: l.blob_sha, now: here?.blob ?? null} : null;
    const fileNode = () => entity(fileIdIn(name, l.path), l.path, {path: l.path, blob: here.blob, bytes: here.size});
    switch (loc?.kind) {
      case 'code-symbol': return {id: symbolIdIn(name, l.path, l.symbol), path: l.path, changed, make: () => { fileNode(); entity(symbolIdIn(name, l.path, l.symbol), l.path, {module: l.path, name: l.symbol, blob: here.blob}); }};
      case 'repository-file': return {id: fileIdIn(name, l.path), path: l.path, changed, make: fileNode};
      case 'test': return {id: checkIdIn(name, l.path), path: l.path, changed, check: true, make: () => { fileNode(); entity(checkIdIn(name, l.path), l.path, {path: l.path, blob: here.blob, declared_by: 'the weave'}); }};
      case 'doc-section': case 'contract-clause':
        return {id: fileIdIn(name, l.path), path: l.path, changed: here ? null : {path: l.path, woven_from: null, now: null}, make: fileNode,
          section: {heading_path: l.heading_path, text_sha256: l.text_sha256, checked: false, ...(loc.kind === 'contract-clause' ? {clause: true} : {})}};
      case 'commit': return /^[0-9a-f]{40}$/.test(l.sha ?? '') ? {id: commitId(l.sha), changed: null, make: () => entity(commitId(l.sha), `git:${l.sha}`, {commit: l.sha, repository: name})} : null;
      default: return null;
    }
  };
  for (const {line, record: r} of records) {
    const type = TYPES[r.edge_kind], from = type ? nodeOf(r.from_locator) : null, to = type ? nodeOf(r.to_locator) : null;
    // A relationship the registry would not admit between these node types is not forced into another one.
    const fits = from && to && !(type === 'verified-by' && !to.check) && !(type === 'documented-in' && !to.id.includes('/systems/file/')) &&
      !(type === 'derived-from' && !to.id.includes('/systems/change/')) && !(type === 'depends-on' && (to.check || to.section || to.id.includes('/systems/change/')));
    if (!fits) { unmapped[r.edge_kind] = (unmapped[r.edge_kind] ?? 0) + 1; continue; }
    const changed = from.changed ?? to.changed;
    if (changed) { stale++; if (staleExamples.length < 16) staleExamples.push({line, ...changed}); continue; }
    from.make(); to.make(); stated++;
    if (to.check) edges.set(`derived-from\0${to.id}\0${fileIdIn(name, to.path)}`, {type: 'derived-from', from: to.id, to: fileIdIn(name, to.path), ref: path, attributes: {basis: 'the weave names this file as a test'}});
    const k = `${type}\0${from.id}\0${to.id}`;
    if (edges.has(k)) { edges.get(k).attributes.more_records = (edges.get(k).attributes.more_records ?? 0) + 1; continue; }
    edges.set(k, {type, from: from.id, to: to.id, ref: `${path}#${r.record_hash}`, attributes: {basis: DECLARED, asserted_by: r.asserted_by, assertion_status: r.assertion_status,
      source_ref: r.source_ref, record_hash: r.record_hash, ...(to.section ? {section: to.section} : {})}});
    if (type === 'depends-on' && from.path !== to.path && !(r.from_locator.kind === 'repository-file' && r.to_locator.kind === 'repository-file')) {
      const fk = `${from.path}\0${to.path}`;
      implied.set(fk, {from: from.path, to: to.path, edges: (implied.get(fk)?.edges ?? 0) + 1});
    }
  }
  for (const i of implied.values()) {
    const k = `depends-on\0${fileIdIn(name, i.from)}\0${fileIdIn(name, i.to)}`;
    if (!edges.has(k)) edges.set(k, {type: 'depends-on', from: fileIdIn(name, i.from), to: fileIdIn(name, i.to), ref: path,
      attributes: {basis: 'the weave declares a dependency between symbols of these files', edges: i.edges}});
  }
  const gaps = [...(stale ? [`${stale} record(s) were woven from files that have since changed and are not stated`] : []),
    ...(Object.keys(unmapped).length ? [`${Object.values(unmapped).reduce((a, b) => a + b, 0)} record(s) have no registered counterpart and are counted only`] : [])];
  const root = {entity: repositoryId(name), ref: path, attributes: {read_at: commit, weave: {path, records: records.length, verified: 'the hash chain, each record hash and each signature',
    key: 'carried in the weave\'s own header: evidence against tampering, not of who signed', woven_at: header.woven_at ?? null, woven_from: header.repo_head ?? null,
    stated, stale, unmapped: sortKeys(unmapped)}, ...(staleExamples.length ? {stale_examples: staleExamples} : {})}, ...(gaps.length ? {missing_evidence: gaps} : {})};
  const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [root, ...[...entities.values()].sort((a, b) => byId(a.entity, b.entity)),
    ...[...edges.values()].sort((a, b) => byId(`${a.type}\0${a.from}\0${a.to}`, `${b.type}\0${b.from}\0${b.to}`))];
}

/** The adapter: the sibling's committed weave at the commit `ref` names now (readAt: that commit's objects). */
export function weaveSource({repo, ref = 'HEAD', name = 'telos', path = WEAVE_PATH, extractor = WEAVE_EXTRACTOR} = {}) {
  return {
    id: weaveSourceIdOf(name), extractor, ref: path,
    authority: `${path} in the ${name} repository at a commit: the dependency ledger ${name} wove and signed itself, checked here line by line`,
    current: () => ({version: resolveCommit(repo, ref)}),
    readAt: version => weaveFacts(repo, version, {name, path}),
  };
}
