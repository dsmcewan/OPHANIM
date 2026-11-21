// The lessons registry as a graph source (KD12; docs/knowledge-graph/architecture.md "The source adapter").
//
// Purpose   The one thin, real source adapter of Slice A: it shows the source-event model on a real OPHANIM record.
//           ophanim/lessons/corrections.json (ophanim.owner-corrections/v1) is projected as `learning` authoritative
//           assertions by a registered deterministic extractor, keyed by class id, at a version that is the file's git
//           blob id (the immutable object id git gives those bytes; equal to `git rev-parse HEAD:<file>` when the file
//           is as committed).
// Inputs    The repository root and the registry's path in it. Read only: the working file for its current version,
//           and `git cat-file blob <version>` for any earlier version replay asks for.
// Outputs   lessonsSource(): the adapter packages/graph's projection calls ({id, extractor, authority, ref, current,
//           readAt}); lessonFacts(): the facts of one registry text; LESSONS_ORIGIN: the extractor's registration.
// Facts     learning/failure-class/<class id>   the class, its source, fix, detector and instances (as attributes);
//                                               a class without an executable detector or a fix carries that as
//                                               missing evidence
//           systems/test/<file>#<name>          the detector the registry names (a name SUBSTRING: the test case
//                                               itself is resolved by the systems graph, Slice B), `detects` the class
//           systems/change/<commit>             the fix the registry names (resolved by Slice B),
//                                               `introduced-because-of` the class
// Must never  Write the registry (ophanim/lessons/** is coordinator-only); key a fact by its position in the file;
//           claim the registry is continuously synchronized (it is observed when observe() is called).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {entityId} from '../../packages/graph/index.mjs';

export const SOURCE_ID = 'ophanim.lessons';
export const EXTRACTOR = 'ophanim.lessons.extractor';
export const REGISTRY_SCHEMA = 'ophanim.owner-corrections/v1';
export const REGISTRY_PATH = 'ophanim/lessons/corrections.json';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** The extractor's registration in an origin registry; `keys` (who may write as it) is the composer's, an owner decision. */
export const LESSONS_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [SOURCE_ID]});

/** git's blob id of these bytes (sha1 of "blob <length>\0<bytes>"), computed without running git. */
export const blobId = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** The facts of one registry text, as the extractor's drafts. Throws if the text is not the registry's schema. */
export function lessonFacts(text, {file = REGISTRY_PATH} = {}) {
  const reg = JSON.parse(text);
  if (reg?.schema !== REGISTRY_SCHEMA || !Array.isArray(reg.classes)) throw new Error(`${file}: not ${REGISTRY_SCHEMA}`);
  const drafts = [], tests = new Map(), changes = new Map();
  for (const c of reg.classes) {
    if (typeof c?.id !== 'string' || !c.id) throw new Error(`${file}: a class without an id`);
    const fc = entityId({domain: 'learning', type: 'failure-class', key: c.id});
    const instances = Array.isArray(c.instances) ? c.instances : [];
    const d = c.detector ?? null, missing = [];
    if (d?.kind !== 'test') missing.push(`no executable detector: ${d?.why ?? 'none recorded'}`);
    if (!c.fixed_in) missing.push('no fix recorded');
    drafts.push({entity: fc, ref: `${file}#${c.id}`, missing_evidence: missing, attributes: {
      class: c.class ?? null, source: c.source ?? null, fixed_in: c.fixed_in ?? null, detector: d, instances,
      owner_interventions: instances.filter(i => i.observed_by === 'owner').length,
      mechanism_detections: instances.filter(i => i.observed_by === 'mechanism').length}});
    if (d?.kind === 'test') {
      const t = entityId({domain: 'systems', type: 'test', key: `${d.file}#${d.name}`});
      tests.set(t, {file: d.file, name_pattern: d.name});
      drafts.push({type: 'detects', from: t, to: fc, ref: `${file}#${c.id}/detector`, attributes: {}});
    }
    if (c.fixed_in) {
      const ch = entityId({domain: 'systems', type: 'change', key: c.fixed_in});
      changes.set(ch, {commit: c.fixed_in});
      drafts.push({type: 'introduced-because-of', from: ch, to: fc, ref: `${file}#${c.id}/fixed_in`, attributes: {}});
    }
  }
  for (const [t, attributes] of tests) drafts.push({entity: t, ref: `${file} (detector ${attributes.file})`, attributes,
    uncertainty: 'the registry names a test by a substring of its name; the systems graph resolves the test case'});
  for (const [ch, attributes] of changes) drafts.push({entity: ch, ref: `${file} (fixed_in ${attributes.commit})`, attributes,
    uncertainty: 'the registry names the commit; the systems graph resolves it'});
  return drafts;
}

/**
 * The adapter. `repo`: the repository root (default this checkout); `file`: the registry's path in it.
 * current(): {version: blob id of the working file}; readAt(version): the facts of that blob -- the working file if it
 * is that version, else git's object store (read only), else it throws (the projection records it unavailable).
 */
export function lessonsSource({repo = ROOT, file = REGISTRY_PATH, extractor = EXTRACTOR} = {}) {
  const abs = path.join(repo, file);
  const bytesAt = version => {
    if (fs.existsSync(abs)) { const b = fs.readFileSync(abs); if (blobId(b) === version) return b; }
    let b;
    try { b = execFileSync('git', ['-C', repo, 'cat-file', 'blob', version], {stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26}); }
    catch { throw new Error(`${file} at ${version} is neither the working file nor in git's object store`); }
    if (blobId(b) !== version) throw new Error(`${file}: git returned bytes that are not blob ${version}`);
    return b;
  };
  return {
    id: SOURCE_ID, extractor, ref: file,
    authority: `${file} (${REGISTRY_SCHEMA}; maintained by the coordinator, ophanim/lessons/** is coordinator-only)`,
    current: () => ({version: blobId(fs.readFileSync(abs))}),
    readAt: version => lessonFacts(bytesAt(version).toString('utf8'), {file}),
  };
}
