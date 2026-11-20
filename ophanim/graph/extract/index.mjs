// THE SYSTEMS AND EVIDENCE GRAPH's composition (Slice B, KB1; docs/knowledge-graph/slice-b.md; Slice B2, KD2-1;
// docs/knowledge-graph/slice-b2.md).
//
// Purpose   Compose the registered origins and source adapters of Slice B over packages/graph (contract
//           ophanim.graph/v1): the repository, its declared verification and the register's records at one commit;
//           the status, work and cycle ledgers at their heads; the lessons registry (Slice A's adapter); and Slice B2's
//           dependency sources at the same commit (packages and imports, pinned external sources, the environment,
//           files read by path, authority, the literals' mentions) and the board's obligations when a state directory
//           is named. Open a graph over them and observe each source, in the order their references need (a mention
//           names a file the repository source holds, so the repository is observed first).
// Inputs    The repository root, the commit (a name is resolved ONCE here and pinned), the ledgers' roots and anchors,
//           the board's state directory.
// Outputs   ORIGIN_SPEC / originsOf(): the origin registry; sourcesOf(): the adapters, each declaring its extractor's
//           version (extractorVersionOf: the digest of the extractor's module and its local imports, transitively, as
//           read from disk; a snapshot derived by other code is refused, packages/graph/checkpoint.mjs); openSystemsGraph(): a graph
//           ledger with SYNTHETIC keys generated for this process (never persisted, never a production key: key
//           custody for the graph domain is the owner's decision, architecture.md section 16); observeAll().
// Must never  Hold or name a production key; write any source; observe a source out of its reference order.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {generateSigner} from '../../../packages/ledger/index.mjs';
import {createGraphLedger, openGraph, defineOrigins} from '../../../packages/graph/index.mjs';
import {lessonsSource, SOURCE_ID as LESSONS_SOURCE, EXTRACTOR as LESSONS_EXTRACTOR, LESSONS_ORIGIN} from '../lessons.mjs';
import {repoSource, SOURCE_ID as REPO_SOURCE, EXTRACTOR as REPO_EXTRACTOR, REPO_ORIGIN, SPEC} from './repo.mjs';
import {verificationSource, SOURCE_ID as VERIFICATION_SOURCE, EXTRACTOR as VERIFICATION_EXTRACTOR, VERIFICATION_ORIGIN} from './verification.mjs';
import {recordsSource, SOURCE_ID as RECORDS_SOURCE, EXTRACTOR as RECORDS_EXTRACTOR, RECORDS_ORIGIN} from './records.mjs';
import {statusSource, workSource, cycleSource, STATUS_SOURCE, WORK_SOURCE, CYCLE_SOURCE, STATUS_ANCHOR, EXTRACTOR as LEDGERS_EXTRACTOR, LEDGERS_ORIGIN} from './ledgers.mjs';
import {packagesSource, importsSource, PACKAGES_SOURCE, IMPORTS_SOURCE, PACKAGES_EXTRACTOR, IMPORTS_EXTRACTOR, PACKAGES_ORIGIN, IMPORTS_ORIGIN} from './packages.mjs';
import {environmentSource, pathsSource, literalsSource, ENVIRONMENT_SOURCE, PATHS_SOURCE, LITERALS_SOURCE, ENVIRONMENT_EXTRACTOR, PATHS_EXTRACTOR, LITERALS_EXTRACTOR,
  ENVIRONMENT_ORIGIN, PATHS_ORIGIN, LITERALS_ORIGIN} from './needs.mjs';
import {pinsSource, PINS_SOURCE, PINS_EXTRACTOR, PINS_ORIGIN} from './pins.mjs';
import {authoritySource, AUTHORITY_SOURCE, AUTHORITY_EXTRACTOR, AUTHORITY_ORIGIN} from './authority.mjs';
import {boardSource, BOARD_SOURCE, BOARD_EXTRACTOR, BOARD_ORIGIN} from './board.mjs';
import {resolveCommit} from './git.mjs';
import {IMPACT_RULE} from '../impact.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export {IMPACT_RULE};
export {REPO_SOURCE, VERIFICATION_SOURCE, RECORDS_SOURCE, STATUS_SOURCE, WORK_SOURCE, CYCLE_SOURCE, LESSONS_SOURCE, STATUS_ANCHOR};
export {PACKAGES_SOURCE, PINS_SOURCE, IMPORTS_SOURCE, ENVIRONMENT_SOURCE, PATHS_SOURCE, AUTHORITY_SOURCE, LITERALS_SOURCE, BOARD_SOURCE};
/** Slice B2's dependency sources read from the repository at the commit (KD2-1), in their reference order. */
export const DEPENDENCY_SOURCES = Object.freeze([PACKAGES_SOURCE, PINS_SOURCE, IMPORTS_SOURCE, ENVIRONMENT_SOURCE, PATHS_SOURCE, AUTHORITY_SOURCE, LITERALS_SOURCE]);
/**
 * The order sources are observed in: every reference a source's facts make is to a source observed before it (Slice
 * B2's: the packages before the imports that resolve to them; the pins after the workflows of the verification source;
 * the literals, whose mentions name what the others hold, last of the repository-backed; the board with the ledgers).
 */
export const ORDER = Object.freeze([REPO_SOURCE, VERIFICATION_SOURCE, RECORDS_SOURCE, LESSONS_SOURCE, ...DEPENDENCY_SOURCES, STATUS_SOURCE, WORK_SOURCE, CYCLE_SOURCE, BOARD_SOURCE]);

/** The origins of Slice B (and Slice A's lessons extractor), each with the key id that may write as it. */
export const ORIGIN_SPEC = Object.freeze({
  [REPO_EXTRACTOR]: {...REPO_ORIGIN, keys: ['graph-extractor']},
  [VERIFICATION_EXTRACTOR]: {...VERIFICATION_ORIGIN, keys: ['graph-extractor']},
  [RECORDS_EXTRACTOR]: {...RECORDS_ORIGIN, keys: ['graph-extractor']},
  [LEDGERS_EXTRACTOR]: {...LEDGERS_ORIGIN, keys: ['graph-extractor']},
  [LESSONS_EXTRACTOR]: {...LESSONS_ORIGIN, keys: ['graph-extractor']},
  [PACKAGES_EXTRACTOR]: {...PACKAGES_ORIGIN, keys: ['graph-extractor']},
  [IMPORTS_EXTRACTOR]: {...IMPORTS_ORIGIN, keys: ['graph-extractor']},
  [ENVIRONMENT_EXTRACTOR]: {...ENVIRONMENT_ORIGIN, keys: ['graph-extractor']},
  [PATHS_EXTRACTOR]: {...PATHS_ORIGIN, keys: ['graph-extractor']},
  [LITERALS_EXTRACTOR]: {...LITERALS_ORIGIN, keys: ['graph-extractor']},
  [PINS_EXTRACTOR]: {...PINS_ORIGIN, keys: ['graph-extractor']},
  [AUTHORITY_EXTRACTOR]: {...AUTHORITY_ORIGIN, keys: ['graph-extractor']},
  [BOARD_EXTRACTOR]: {...BOARD_ORIGIN, keys: ['graph-extractor']},
  [IMPACT_RULE]: {kind: 'rule', basis: 'structural', keys: ['graph-rule']},
});
/** The composed origin registry; `extra` adds origins (a test's synthetic tools and models). */
export const originsOf = (extra = {}) => defineOrigins({...ORIGIN_SPEC, ...extra});

/**
 * The version of the code an extractor runs: the digest of the text of `file` and of every module it imports by a
 * relative specifier, transitively, as read from disk now (the import-specifier regex is repo.mjs's SPEC, the layering
 * test's). A specifier that names no readable file is part of the digest as unresolved. Paths are relative to `root`, so
 * the version does not depend on where the checkout is. Modules imported by name (node built-ins, packages) are not this
 * repository's code and are not followed.
 */
export function extractorVersionOf(file, {root = ROOT} = {}) {
  const seen = new Map(), todo = [path.resolve(file)];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    let text = null;
    try { text = fs.readFileSync(f); } catch {}
    seen.set(f, text === null ? null : createHash('sha256').update(text).digest('hex'));
    if (text !== null) for (const m of text.toString('utf8').matchAll(SPEC)) if (m[2].startsWith('.')) todo.push(path.resolve(path.dirname(f), m[2]));
  }
  const rows = [...seen].map(([f, h]) => [path.relative(root, f).split(path.sep).join('/'), h]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return 'sha256:' + createHash('sha256').update(JSON.stringify({schema: 'ophanim.graph.extractor-version/v1', modules: rows})).digest('hex');
}
const here = spec => fileURLToPath(new URL(spec, import.meta.url));
/** Each source's extractor: the adapter factory, and the module it is defined in (the root of its version's closure). */
export const EXTRACTOR_MODULES = Object.freeze({
  [REPO_SOURCE]: {factory: repoSource, module: here('./repo.mjs')}, [VERIFICATION_SOURCE]: {factory: verificationSource, module: here('./verification.mjs')},
  [RECORDS_SOURCE]: {factory: recordsSource, module: here('./records.mjs')}, [LESSONS_SOURCE]: {factory: lessonsSource, module: here('../lessons.mjs')},
  [STATUS_SOURCE]: {factory: statusSource, module: here('./ledgers.mjs')}, [WORK_SOURCE]: {factory: workSource, module: here('./ledgers.mjs')},
  [CYCLE_SOURCE]: {factory: cycleSource, module: here('./ledgers.mjs')},
  [PACKAGES_SOURCE]: {factory: packagesSource, module: here('./packages.mjs')}, [IMPORTS_SOURCE]: {factory: importsSource, module: here('./packages.mjs')},
  [ENVIRONMENT_SOURCE]: {factory: environmentSource, module: here('./needs.mjs')}, [PATHS_SOURCE]: {factory: pathsSource, module: here('./needs.mjs')},
  [LITERALS_SOURCE]: {factory: literalsSource, module: here('./needs.mjs')}, [PINS_SOURCE]: {factory: pinsSource, module: here('./pins.mjs')},
  [AUTHORITY_SOURCE]: {factory: authoritySource, module: here('./authority.mjs')}, [BOARD_SOURCE]: {factory: boardSource, module: here('./board.mjs')},
});
// Read once per process: the version of the code this process loaded when it first composed its sources.
const versions = new Map();
const declared = s => {
  const m = EXTRACTOR_MODULES[s.id].module;
  if (!versions.has(m)) versions.set(m, extractorVersionOf(m));
  return {...s, extractorVersion: versions.get(m)};
};

/**
 * The source adapters, each declaring its extractor's version. `commit` pins the repository-backed sources (repo,
 * verification, records, and Slice B2's dependency sources unless `deps` is false) to ONE commit, so their
 * cross-references meet in one tree; the ledgers are included when their roots are given, the board when its state
 * directory is (`board: {stateDir}`).
 */
export function sourcesOf({repo = ROOT, commit, status = {root: path.join(repo, 'status/ledger'), anchor: STATUS_ANCHOR}, work = null, cycle = null,
  lessons = true, deps = true, board = null, only = null} = {}) {
  const pinned = resolveCommit(repo, commit ?? 'HEAD');
  const all = [
    repoSource({repo, ref: pinned}), verificationSource({repo, ref: pinned}), recordsSource({repo, ref: pinned}),
    ...(lessons ? [lessonsSource({repo})] : []),
    ...(deps ? [packagesSource({repo, ref: pinned}), pinsSource({repo, ref: pinned}), importsSource({repo, ref: pinned}), environmentSource({repo, ref: pinned}),
      pathsSource({repo, ref: pinned}), authoritySource({repo, ref: pinned}), literalsSource({repo, ref: pinned})] : []),
    ...(status ? [statusSource(status)] : []), ...(work ? [workSource(work)] : []), ...(cycle ? [cycleSource(cycle)] : []),
    ...(board ? [boardSource(board)] : []),
  ].map(declared);
  return {commit: pinned, sources: only ? all.filter(s => only.includes(s.id)) : all};
}

/**
 * A new graph ledger at `dir` (default: a new temporary directory) with SYNTHETIC keys made here, opened over
 * `sources`. Returns {graph, dir, anchor, by (the extractors' writer), rule (the impact rule's writer), origins, close}.
 * `snapshot` ({dir, keys}: a snapshot directory and the PINNED keys that may sign one; packages/graph/checkpoint.mjs):
 * every open() opens from the newest acceptable snapshot there, else in full. open(sources, {snapshot}) names one per
 * open. Which key signs the real graph's snapshots is the owner's decision (KG-4): this file names none.
 */
export function openSystemsGraph({dir = null, sources, extraOrigins = {}, extraKeys = {}, snapshot = null} = {}) {
  const root = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-b-'));
  const op = generateSigner('graph-operator'), ex = generateSigner('graph-extractor'), rk = generateSigner('graph-rule');
  const keys = Object.fromEntries(Object.keys(extraKeys).map(k => [k, generateSigner(k)]));
  const anchor = createGraphLedger({dir: root, operator: op, order: op, authority: {orderer: 'graph-operator', operators: ['graph-operator'],
    keyring: {'graph-operator': op.publicJwk, 'graph-extractor': ex.publicJwk, 'graph-rule': rk.publicJwk, ...Object.fromEntries(Object.entries(keys).map(([k, s]) => [k, s.publicJwk]))}}});
  const origins = originsOf(extraOrigins);
  const open = (s = sources, o = {}) => openGraph({dir: root, anchor, origins, sources: s, ...(snapshot ? {snapshot} : {}), ...o});
  const graph = open();
  return {graph, dir: root, anchor, origins, open, by: {signer: ex, order: op}, rule: {signer: rk, order: op},
    signers: Object.fromEntries(Object.entries(keys).map(([k, s]) => [k, {signer: s, order: op}])),
    close: () => { if (!dir) fs.rmSync(root, {recursive: true, force: true}); }};
}

/** Observe every registered source, in ORDER; {source: {recorded, state, count, ms, why}}. */
export function observeAll(graph, by, {observed_at = new Date().toISOString(), order = ORDER} = {}) {
  const out = {};
  const ids = [...graph.projection.adapters.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || (a < b ? -1 : 1));
  for (const id of ids) {
    const t = process.hrtime.bigint();
    const r = graph.observe(id, {...by, observed_at});
    out[id] = {recorded: r.recorded, state: r.state ?? null, version: r.record?.source.version ?? null, count: r.record?.attributes.count ?? null,
      ms: Number(process.hrtime.bigint() - t) / 1e6, why: r.why ?? r.record?.attributes.why ?? null};
  }
  return out;
}

/** One call: the systems and evidence graph of `repo` at `commit`, observed. Close it with `close()`. */
export function systemsGraph({repo = ROOT, commit, status, work = null, cycle = null, lessons = true, deps = true, board = null, dir = null, observed_at, extraOrigins, extraKeys, snapshot} = {}) {
  const {commit: pinned, sources} = sourcesOf({repo, commit, ...(status !== undefined ? {status} : {}), work, cycle, lessons, deps, board});
  const g = openSystemsGraph({dir, sources, extraOrigins, extraKeys, snapshot});
  const observed = observeAll(g.graph, g.by, {observed_at});
  return {...g, commit: pinned, observed};
}
