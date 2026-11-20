// THE PROJECTOR: read the sources, hand each reading to the graph, say what is current and what is not
// (docs/knowledge-graph/architecture.md).
//
// Purpose   Keep the graph ledger in step with the authoritative sources, one source at a time, and rebuild it from
//           them when it is lost or does not verify.
// Inputs    The repository; the status ledger and the work ledger (read, never written); the graph ledger's root.
// Outputs   project(): what each source's reading changed. freshness(): where each source stands against the graph.
//           reconcile(): whether a graph built from nothing equals the one held. recover(): a rebuilt graph.
// Invariants
//   - Each source is read and applied on its own cursor: a failure or an absence of one source leaves the others'
//     batches as they are and is reported by name. Nothing is marked current that was not read.
//   - A graph that does not verify is never repaired in place. It is set aside whole (kept, renamed) and a new one is
//     built from the sources; what the new one holds is exactly what the sources state now.
// Must never  Write to the status ledger or the work ledger; treat the graph as the source when the two disagree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStatusLedger} from '../../packages/ledger/index.mjs';
import {openWorkLedger} from '../operate/work-ledger.mjs';
import {openGraph} from './store.mjs';
import {readRepository, readRegister, readLessons, readCapabilities, readStatus, readWork} from './extract.mjs';

export const INSTANCE = 'ophanim';
export const SOURCES = Object.freeze(['repository', 'register', 'lessons-registry', 'config', 'status-ledger', 'work-ledger']);
export const defaultGraphRoot = repo => path.join(repo, 'status', 'graph');

const openStatus = root => { try { return root && fs.existsSync(path.join(root, 'ANCHOR')) ? openStatusLedger({root, create: false}) : null; } catch { return null; } };
const openWork = root => { try { return root && fs.existsSync(path.join(root, 'ANCHOR')) ? openWorkLedger({root, create: false}) : null; } catch { return null; } };

/** One reading of one source: {cursor, assertions, refs?, absent?, unverified?}. */
async function read(source, {repo, instance, statusRoot, workRoot, paths}) {
  if (source === 'repository') return readRepository({repo, instance, paths});
  if (source === 'register') return readRegister({repo, instance});
  if (source === 'lessons-registry') return readLessons({repo, instance});
  if (source === 'config') return readCapabilities({repo, instance});
  if (source === 'status-ledger') { const L = openStatus(statusRoot); return L ? readStatus({repo, instance, board: L.board()}) : {cursor: 'absent', assertions: [], absent: true}; }
  if (source === 'work-ledger') return readWork({repo, instance, work: openWork(workRoot)});
  throw new Error(`"${source}" is not a source of the graph (${SOURCES.join(', ')})`);
}
const paths_ = ({repo, statusRoot, workRoot}) => ({statusRoot: statusRoot ?? path.join(repo, 'status', 'ledger'), workRoot: workRoot ?? path.join(repo, 'status', 'work')});

/**
 * Bring the graph at `graphRoot` up to the sources: {results: {source: {...}}, projection}. `only` limits the sources;
 * `paths` makes the repository reading a targeted one (those files only). A source that is absent or does not verify is
 * left where the graph has it and reported.
 */
export async function project({repo, graphRoot = defaultGraphRoot(repo), instance = INSTANCE, statusRoot = null, workRoot = null, only = null, paths = null, at = new Date().toISOString(), graph = null}) {
  const g = graph ?? openGraph({root: graphRoot, instance}), where = paths_({repo, statusRoot, workRoot}), results = {};
  for (const source of only ?? SOURCES) {
    try {
      const r = await read(source, {repo, instance, ...where, paths: source === 'repository' ? paths : null});
      if (r.absent || r.unverified) { results[source] = {applied: false, state: r.absent ? 'unavailable' : 'unverified', why: r.unverified ?? 'the source is not here', graph_at: g.projection().cursor(source)}; continue; }
      const s = g.sync(source, r.cursor, r.assertions, {at, ...(r.refs ? {refs: r.refs} : {})});
      results[source] = {applied: s.applied, state: 'current', cursor: r.cursor, ops: s.ops ?? 0, assertions: r.assertions.length};
    } catch (e) { results[source] = {applied: false, state: 'failed', why: String(e?.message ?? e).slice(0, 400), code: e?.code ?? null}; }
  }
  return {graph: g, results, projection: g.projection()};
}

/** Where each source stands against the graph: current, stale (the source moved), unavailable, or never read. */
export async function freshness({repo, graphRoot = defaultGraphRoot(repo), instance = INSTANCE, statusRoot = null, workRoot = null, graph = null}) {
  const g = graph ?? openGraph({root: graphRoot, instance, create: false}), p = g.projection(), where = paths_({repo, statusRoot, workRoot}), out = [];
  for (const source of SOURCES) {
    let r; try { r = await read(source, {repo, instance, ...where, paths: null}); } catch (e) { out.push({source, state: 'failed', graph_at: p.cursor(source), why: String(e?.message ?? e).slice(0, 200)}); continue; }
    const graph_at = p.cursor(source);
    out.push({source, graph_at, source_at: r.absent ? null : r.cursor, state: r.absent ? 'unavailable' : r.unverified ? 'unverified' : graph_at === null ? 'never-read' : graph_at === r.cursor ? 'current' : 'stale'});
  }
  return out;
}

/**
 * BOUNDED FULL RECONCILIATION: build a graph from nothing in a scratch directory and compare what holds there with what
 * holds here. {ok, held, rebuilt, sources: [{source, same}]}. Nothing is changed.
 */
export async function reconcile({repo, graphRoot = defaultGraphRoot(repo), instance = INSTANCE, statusRoot = null, workRoot = null, at = new Date().toISOString()}) {
  const held = openGraph({root: graphRoot, instance, create: false}).projection();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-reconcile-'));
  try {
    const fresh = (await project({repo, graphRoot: path.join(scratch, 'g'), instance, statusRoot, workRoot, at})).projection;
    const aids = (p, s) => p.assertionsOf(s).map(r => r.aid).sort().join('\n');
    const sources = SOURCES.map(source => ({source, same: aids(held, source) === aids(fresh, source), held: held.assertionsOf(source).length, rebuilt: fresh.assertionsOf(source).length}));
    return {ok: sources.every(s => s.same), held: held.digest(), rebuilt: fresh.digest(), sources};
  } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
}

/**
 * Open the graph; if it is not there, start it; if it does not verify, SET IT ASIDE and build a new one from the
 * sources. {graph, rebuilt, set_aside, results}. The sources decide what the new graph holds; the broken one is kept.
 */
export async function recover({repo, graphRoot = defaultGraphRoot(repo), instance = INSTANCE, statusRoot = null, workRoot = null, at = new Date().toISOString()}) {
  let set_aside = null;
  try { const g = openGraph({root: graphRoot, instance, create: false}); return {graph: g, rebuilt: false, set_aside, results: null}; }
  catch (e) {
    if (e?.code === 'NO_GRAPH' && !fs.existsSync(graphRoot)) { /* never built: build it */ }
    else if (e?.code === 'GRAPH_FOREIGN_INSTANCE') throw e;
    else {
      // Whatever is there cannot be trusted as a whole: keep it for whoever wants to look, and do not read from it.
      let n = 1; while (fs.existsSync(`${graphRoot}.set-aside-${n}`)) n += 1;
      set_aside = `${graphRoot}.set-aside-${n}`;
      fs.renameSync(graphRoot, set_aside);
    }
  }
  const r = await project({repo, graphRoot, instance, statusRoot, workRoot, at});
  return {graph: r.graph, rebuilt: true, set_aside, results: r.results};
}
