// THE SYSTEMS AND EVIDENCE GRAPH's composition (Slice B, KB1; docs/knowledge-graph/slice-b.md).
//
// Purpose   Compose the registered origins and source adapters of Slice B over packages/graph (contract
//           ophanim.graph/v1): the repository, its declared verification and the register's records at one commit;
//           the status, work and cycle ledgers at their heads; the lessons registry (Slice A's adapter). Open a graph
//           over them and observe each source, in the order their references need (a mention names a file the
//           repository source holds, so the repository is observed first).
// Inputs    The repository root, the commit (a name is resolved ONCE here and pinned), the ledgers' roots and anchors.
// Outputs   ORIGIN_SPEC / originsOf(): the origin registry; sourcesOf(): the adapters; openSystemsGraph(): a graph
//           ledger with SYNTHETIC keys generated for this process (never persisted, never a production key: key
//           custody for the graph domain is the owner's decision, architecture.md section 16); observeAll().
// Must never  Hold or name a production key; write any source; observe a source out of its reference order.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateSigner} from '../../../packages/ledger/index.mjs';
import {createGraphLedger, openGraph, defineOrigins} from '../../../packages/graph/index.mjs';
import {lessonsSource, SOURCE_ID as LESSONS_SOURCE, EXTRACTOR as LESSONS_EXTRACTOR, LESSONS_ORIGIN} from '../lessons.mjs';
import {repoSource, SOURCE_ID as REPO_SOURCE, EXTRACTOR as REPO_EXTRACTOR, REPO_ORIGIN} from './repo.mjs';
import {verificationSource, SOURCE_ID as VERIFICATION_SOURCE, EXTRACTOR as VERIFICATION_EXTRACTOR, VERIFICATION_ORIGIN} from './verification.mjs';
import {recordsSource, SOURCE_ID as RECORDS_SOURCE, EXTRACTOR as RECORDS_EXTRACTOR, RECORDS_ORIGIN} from './records.mjs';
import {statusSource, workSource, cycleSource, STATUS_SOURCE, WORK_SOURCE, CYCLE_SOURCE, STATUS_ANCHOR, EXTRACTOR as LEDGERS_EXTRACTOR, LEDGERS_ORIGIN} from './ledgers.mjs';
import {resolveCommit} from './git.mjs';
import {IMPACT_RULE} from '../impact.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export {IMPACT_RULE};
export {REPO_SOURCE, VERIFICATION_SOURCE, RECORDS_SOURCE, STATUS_SOURCE, WORK_SOURCE, CYCLE_SOURCE, LESSONS_SOURCE, STATUS_ANCHOR};
/** The order sources are observed in: every reference a source's facts make is to a source observed before it. */
export const ORDER = Object.freeze([REPO_SOURCE, VERIFICATION_SOURCE, RECORDS_SOURCE, LESSONS_SOURCE, STATUS_SOURCE, WORK_SOURCE, CYCLE_SOURCE]);

/** The origins of Slice B (and Slice A's lessons extractor), each with the key id that may write as it. */
export const ORIGIN_SPEC = Object.freeze({
  [REPO_EXTRACTOR]: {...REPO_ORIGIN, keys: ['graph-extractor']},
  [VERIFICATION_EXTRACTOR]: {...VERIFICATION_ORIGIN, keys: ['graph-extractor']},
  [RECORDS_EXTRACTOR]: {...RECORDS_ORIGIN, keys: ['graph-extractor']},
  [LEDGERS_EXTRACTOR]: {...LEDGERS_ORIGIN, keys: ['graph-extractor']},
  [LESSONS_EXTRACTOR]: {...LESSONS_ORIGIN, keys: ['graph-extractor']},
  [IMPACT_RULE]: {kind: 'rule', basis: 'structural', keys: ['graph-rule']},
});
/** The composed origin registry; `extra` adds origins (a test's synthetic tools and models). */
export const originsOf = (extra = {}) => defineOrigins({...ORIGIN_SPEC, ...extra});

/**
 * The source adapters. `commit` pins the repository-backed sources (repo, verification, records) to ONE commit, so their
 * cross-references meet in one tree; the ledgers are included when their roots are given.
 */
export function sourcesOf({repo = ROOT, commit, status = {root: path.join(repo, 'status/ledger'), anchor: STATUS_ANCHOR}, work = null, cycle = null,
  lessons = true, only = null} = {}) {
  const pinned = resolveCommit(repo, commit ?? 'HEAD');
  const all = [
    repoSource({repo, ref: pinned}), verificationSource({repo, ref: pinned}), recordsSource({repo, ref: pinned}),
    ...(lessons ? [lessonsSource({repo})] : []),
    ...(status ? [statusSource(status)] : []), ...(work ? [workSource(work)] : []), ...(cycle ? [cycleSource(cycle)] : []),
  ];
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
export function systemsGraph({repo = ROOT, commit, status, work = null, cycle = null, lessons = true, dir = null, observed_at, extraOrigins, extraKeys, snapshot} = {}) {
  const {commit: pinned, sources} = sourcesOf({repo, commit, ...(status !== undefined ? {status} : {}), work, cycle, lessons});
  const g = openSystemsGraph({dir, sources, extraOrigins, extraKeys, snapshot});
  const observed = observeAll(g.graph, g.by, {observed_at});
  return {...g, commit: pinned, observed};
}
