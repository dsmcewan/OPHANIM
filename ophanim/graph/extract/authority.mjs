// AUTHORITY AT A COMMIT: the ownership manifests as a graph source (Slice B2, KD2-5, register KG-7;
// docs/knowledge-graph/slice-b2.md).
//
// Purpose   Who was authorized to change what, as the coordinator's ownership manifests (docs/execution/*-ownership.json,
//           ophanim.wave-ownership/v1) STATE it, read at a commit with a DECLARED basis:
//             evidence/authorization/<manifest>                   the manifest: its wave, base commit, authorization
//                                                                 text, frozen candidate, dependencies -- QUOTED
//             evidence/authorization/<manifest>#<subwave>/<agent> each agent's grant: branch, base commit, findings,
//                                                                 files, new files, region limits, interface rules,
//                                                                 allowed extras, notes -- QUOTED
//             systems/change/paths/<glob>                         the changes to the paths one manifest glob names
//                                                                 (the manifest's own unit), with how many tracked
//                                                                 files it matches at the commit
//           authorizes  a grant -> the changes to the paths of each of its `files` entries (and allowed extras), the
//                       entry quoted, and the region-limit keys that fall within it (their text quoted on the grant)
//           governs     the manifest -> the changes to the paths of each `coordinator_only` glob: only the
//                       coordinator makes them
//           derived-from  the manifest and each grant -> the manifest file
//           A glob is read exactly as docs/execution/check-ownership.mjs reads it (an entry's first word, matched with
//           path.matchesGlob). Which grant covers a FILE is that match, made at query time (impact.mjs authorityOf) and
//           labelled as one; no authority is inferred from who committed what.
// Inputs    The repository root and a commit (git.mjs; never the working tree).
// Must never  Infer authority; paraphrase a manifest's words; read the working tree or a withheld path.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {entityId, encodeKey} from '../../../packages/graph/index.mjs';
import {treeAt, blobsAt, resolveCommit} from './git.mjs';
import {fileId} from './repo.mjs';
import {keyLine} from './packages.mjs';

export const AUTHORITY_SOURCE = 'ophanim.authority';
export const AUTHORITY_EXTRACTOR = 'ophanim.authority.extractor';
export const AUTHORITY_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [AUTHORITY_SOURCE]});
export const MANIFESTS = /^docs\/execution\/[^/]+-ownership\.json$/;
export const SCHEMA = 'ophanim.wave-ownership/v1';
export const authorizationId = key => entityId({domain: 'evidence', type: 'authorization', key});
export const grantId = (manifest, subwave, agent) => authorizationId(`${manifest}#${subwave === null ? '' : `${subwave}/`}${agent}`);
/** The change set of a manifest glob; a glob too long for a key (512 encoded characters) is keyed by its digest (the glob is its attribute). */
export const changeSetId = glob => {
  const id = `paths/${glob}`;
  return encodeKey(id).length <= 480 ? entityId({domain: 'systems', type: 'change', key: id})
    : entityId({domain: 'systems', type: 'change', key: `paths-digest/${createHash('sha256').update(glob).digest('hex')}`});
};
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** A manifest entry's glob: its first word (the checker's reading: `"ophanim/x/*.test.mjs (existing tests)"`). */
export const globOf = entry => String(entry).split(' ')[0];
const prefixOf = g => g.slice(0, g.search(/[*?[{]|$/));
/** Whether `file` is matched by `glob` as the ownership checker matches it (path.matchesGlob; a literal path is itself). */
export const globMatches = (file, glob) => file === glob || (file.startsWith(prefixOf(glob)) && path.matchesGlob(file, glob));
const QUOTED = ['branch', 'base_commit', 'findings', 'files', 'new_files', 'region_limits', 'interface_rules', 'interface_rule', 'allowed_extra', 'note', 'starts_after'];

/** The grants of a manifest: [{subwave (null for `workers`), agent, grant}]. */
export function grantsOf(m) {
  const out = [];
  for (const [sw, agents] of Object.entries(m.subwaves ?? {})) for (const [agent, grant] of Object.entries(agents ?? {})) out.push({subwave: sw, agent, grant});
  for (const [agent, grant] of Object.entries(m.workers ?? {})) out.push({subwave: null, agent, grant});
  return out;
}
/** The region limits of a grant that apply to `file`: [{key, limit}] (a key is a path, or a glob matched like a files entry). */
export function regionLimitsFor(grant, file) {
  return Object.entries(grant.region_limits ?? {}).filter(([k]) => globMatches(file, globOf(k))).map(([key, limit]) => ({key, limit}));
}

/** The facts of the ownership manifests at `commit` (declared). */
export function authorityFacts(repo, commit) {
  const tree = treeAt(repo, commit), drafts = [];
  const tracked = tree.entries.map(e => e.path), manifests = tree.entries.filter(e => MANIFESTS.test(e.path)).sort((a, b) => byString(a.path, b.path));
  const sets = new Map(), count = g => tracked.filter(t => globMatches(t, g)).length;
  const setOf = g => { if (!sets.has(g)) sets.set(g, count(g)); return changeSetId(g); };
  const bytes = blobsAt(repo, manifests.map(e => e.blob));
  for (const e of manifests) {
    const text = bytes.get(e.blob).toString('utf8');
    let m;
    try { m = JSON.parse(text); } catch (err) { drafts.push({entity: authorizationId(e.path), ref: e.path, status: 'unresolved', attributes: {manifest: e.path, unreadable: err.message.slice(0, 200)}, missing_evidence: ['the manifest is not JSON at this commit']}); continue; }
    if (m?.schema !== SCHEMA) continue;
    const id = authorizationId(e.path), coordinator = Array.isArray(m.coordinator_only) ? m.coordinator_only.filter(c => typeof c === 'string') : [];
    drafts.push({entity: id, ref: e.path, attributes: {manifest: e.path, schema: m.schema, wave: m.wave ?? null, base_commit: m.base_commit ?? null, authorization: m.authorization ?? null,
      frozen: m.frozen ?? null, dependencies: m.dependencies ?? null, cross_agent_interfaces: m.cross_agent_interfaces ?? null, coordinator_only: coordinator,
      grants: grantsOf(m).map(g => `${g.subwave === null ? '' : `${g.subwave}/`}${g.agent}`), line: keyLine(text, 'authorization') ?? keyLine(text, 'wave')},
      ...(m.authorization === undefined ? {missing_evidence: ['the manifest states no authorization text']} : {})});
    drafts.push({type: 'derived-from', from: id, to: fileId(e.path), ref: e.path, attributes: {basis: 'the manifest states it'}});
    const coLine = keyLine(text, 'coordinator_only');
    for (const c of [...new Set(coordinator)].sort()) drafts.push({type: 'governs', from: id, to: setOf(globOf(c)), ref: e.path, attributes: {basis: 'coordinator_only', entry: c, line: coLine}});
    for (const {subwave, agent, grant} of grantsOf(m)) {
      const gid = grantId(e.path, subwave, agent), files = Array.isArray(grant.files) ? grant.files.filter(x => typeof x === 'string') : [];
      const extra = Array.isArray(grant.allowed_extra) ? grant.allowed_extra.filter(x => typeof x === 'string') : [];
      drafts.push({entity: gid, ref: e.path, attributes: {manifest: e.path, subwave, agent, ...Object.fromEntries(QUOTED.filter(k => grant[k] !== undefined).map(k => [k, grant[k]])), line: keyLine(text, agent)}});
      drafts.push({type: 'derived-from', from: gid, to: fileId(e.path), ref: e.path, attributes: {basis: 'the manifest states the grant', line: keyLine(text, agent)}});
      const entries = new Map();
      for (const f of files) (entries.get(globOf(f)) ?? entries.set(globOf(f), []).get(globOf(f))).push(f);
      for (const x of extra) (entries.get(x) ?? entries.set(x, []).get(x)).push(`allowed_extra: ${x}`);
      for (const [g, quoted] of [...entries].sort((a, b) => byString(a[0], b[0]))) {
        const within = Object.keys(grant.region_limits ?? {}).filter(k => globOf(k) === g || globMatches(globOf(k), g));
        drafts.push({type: 'authorizes', from: gid, to: setOf(g), ref: e.path, attributes: {basis: 'the grant\'s files', entries: quoted, region_limits: within}});
      }
    }
  }
  for (const [g, n] of [...sets].sort((a, b) => byString(a[0], b[0]))) drafts.push({entity: changeSetId(g), ref: 'docs/execution', attributes: {glob: g, matched: n}});
  return drafts;
}

/** The adapter of the ownership manifests at the commit `ref` names now. */
export function authoritySource({repo, ref = 'HEAD', extractor = AUTHORITY_EXTRACTOR} = {}) {
  return {id: AUTHORITY_SOURCE, extractor, ref: 'docs/execution',
    authority: 'the ownership manifests docs/execution/*-ownership.json, quoted',
    current: () => ({version: resolveCommit(repo, ref)}), readAt: version => authorityFacts(repo, version)};
}
