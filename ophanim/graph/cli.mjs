#!/usr/bin/env node
// THE SYSTEMS AND EVIDENCE GRAPH, from the command line (Slice B, KB5; docs/knowledge-graph/slice-b.md "Queries").
//
//   node ophanim/graph/cli.mjs QUERY SUBJECT [--commit C] [--since C] [--depth N] [--max-nodes N] [--max-edges N] [--no-status] [--no-lessons]
//   node ophanim/graph/cli.mjs trace SUBJECT [--commit C]
//   node ophanim/graph/cli.mjs impact-range FROM TO          (the graph is built at TO)
//   node ophanim/graph/cli.mjs stats [--commit C]
//   node ophanim/graph/cli.mjs package NAME [--commit C]                 (Slice B2: what depends on a package, every version)
//   node ophanim/graph/cli.mjs needs PATH [--transitive] [--commit C]    (what a code file needs from its environment)
//   node ophanim/graph/cli.mjs authority PATH [--commit C]               (which manifest authorized changes to it, and under which limit)
//   node ophanim/graph/cli.mjs why-exists PATH [--commit C]              (Slice D1, KD1-6: the requirement and decision that introduced it)
//   node ophanim/graph/cli.mjs learning PATH [--test FILE#NAME] [--claim TEXT]   (Slice D1, KD1-4: the established learning about a new defect)
//   node ophanim/graph/cli.mjs shared-prerequisites --work-root DIR --work-anchor A [--commit C]   (Slice D1, KD1-2: with the capability graph)
//   node ophanim/graph/cli.mjs hub-readiness [--scales 1,4] [--commit C]   (ADVISORY: whether OPHANIM may replicate into three
//                                            departments with itself as the hub; hub.mjs, docs/knowledge-graph/hub-and-spoke.md)
//
// QUERY is one of the directive's section 8 questions: why (does it exist), requirement (that introduced it), governs
// (which contracts govern it), dependents (what depends on it), evidence (what qualified it), changed-since (--since C),
// invalidates (what a change to it would invalidate), unknown (what remains unknown or disputed). SUBJECT is a repository
// path, a graph id, a register entry (L-504, KG-1), item:<id>, a schema id (ophanim.graph/v1) or commit:<40 hex>; and
// (Slice B2) npm:<name>@<version>, package:<name>, lock:<lockfile>#<entry>, node:<builtin>, workspace:<name>,
// repository:<name> (repository:telos is the TELOS pin), env:<NAME>, exec:<command>, host:<host>, runtime:node -- so
// `invalidates lock:package-lock.json#pantheon/node_modules/@google/genai` and `invalidates repository:telos` say what a
// change to a lockfile entry or to the TELOS pin reaches.
//
// Each run builds the graph afresh in a temporary directory: the repository at the commit (default HEAD, resolved once
// and pinned), its declared verification, the register's records, the lessons registry and the status ledger (read
// only), and Slice B2's dependency sources (packages, pins, imports, environment, paths, authority, literals; --no-deps
// leaves them out), observed by their registered extractors, with SYNTHETIC keys made for this run and discarded with the directory.
// The answer is JSON on stdout: bounded, explained (paths and relationships), and naming every source and version it
// rests on; gaps and unresolved links are part of it. Exit 0 with an answer, 1 when the subject or query cannot be
// answered (the reason is the output), 2 on a usage error. Writes nothing outside the temporary directory.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {systemsGraph, ROOT} from './extract/index.mjs';
import {answer, trace, subjectOf, impactOfRange, QUERIES, DEPENDENCY_QUERIES} from './impact.mjs';
import {resolveCommit} from './extract/git.mjs';
import {sourcesOf, openSystemsGraph, observeAll, ORDER} from './extract/index.mjs';
import {capabilitySources, capabilityOrigins, currentRegistries, DECLARED, STRUCTURAL, SOURCE_ORDER} from '../../pantheon/src/capability/graph.mjs';
import {sharedPrerequisites} from './work.mjs';
import {learningReuse} from './learning.mjs';
import {whyExists} from './why.mjs';
import {hubReadiness} from './hub.mjs';

/** Slice D part 1's queries (docs/knowledge-graph/slice-d1.md). */
export const D1_QUERIES = Object.freeze(['why-exists', 'learning', 'shared-prerequisites']);
/** The graph for shared-prerequisites: the repository and the work ledger named, with the REAL capability graph (what can exist). */
function d1Built({repo, commit, work, deps, observed_at}) {
  const {sources} = sourcesOf({repo, commit, status: null, work, lessons: false, deps, only: ['ophanim.repo', 'ophanim.work-graph']});
  const g = openSystemsGraph({sources: [...sources, ...capabilitySources(currentRegistries())],
    extraOrigins: capabilityOrigins({keys: {[DECLARED]: ['graph-extractor'], [STRUCTURAL]: ['graph-extractor']}})});
  return {...g, commit, observed: observeAll(g.graph, g.by, {observed_at, order: [...ORDER, ...SOURCE_ORDER]})};
}

const USAGE = `usage: node ophanim/graph/cli.mjs (${[...QUERIES, 'trace'].join('|')}) SUBJECT [--commit C] [--since C] [--depth N] [--max-nodes N] [--max-edges N] [--no-status] [--no-lessons] [--no-deps]
       node ophanim/graph/cli.mjs (${DEPENDENCY_QUERIES.join('|')}) SUBJECT [--transitive] [--commit C]
       node ophanim/graph/cli.mjs impact-range FROM TO
       node ophanim/graph/cli.mjs stats [--commit C]
       node ophanim/graph/cli.mjs (why-exists|learning) SUBJECT [--test FILE#NAME] [--claim TEXT] [--commit C]
       node ophanim/graph/cli.mjs shared-prerequisites --work-root DIR --work-anchor A [--commit C]
       node ophanim/graph/cli.mjs hub-readiness [--scales 1,4] [--commit C]`;

/**
 * Run the CLI on `argv` (without node and the script); {code, output} (output: the JSON text, or the usage). `built`: a
 * graph already built at the same commit (extract/index.mjs systemsGraph), used instead of building one (tests).
 */
export function run(argv, {repo = ROOT, observed_at, built = null} = {}) {
  const flags = new Map(), pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--no-status', '--no-lessons', '--no-deps', '--transitive', '--help'].includes(a)) flags.set(a, true);
    else if (a.startsWith('--')) { if (i + 1 >= argv.length) return {code: 2, output: `${a} needs a value\n${USAGE}`}; flags.set(a, argv[++i]); }
    else pos.push(a);
  }
  if (flags.has('--help') || !pos.length) return {code: pos.length ? 0 : 2, output: USAGE};
  const int = name => { const v = flags.get(name); if (v === undefined) return undefined; const n = Number(v); return Number.isInteger(n) ? n : NaN; };
  const bounds = {depth: int('--depth'), maxNodes: int('--max-nodes'), maxEdges: int('--max-edges')};
  if (Object.values(bounds).some(v => Number.isNaN(v))) return {code: 2, output: `--depth, --max-nodes and --max-edges are whole numbers\n${USAGE}`};
  const [q, subject, extra] = pos;
  if (![...QUERIES, ...DEPENDENCY_QUERIES, ...D1_QUERIES, 'trace', 'impact-range', 'stats', 'hub-readiness'].includes(q)) return {code: 2, output: `unknown query "${q}"\n${USAGE}`};
  const scales = q === 'hub-readiness' ? String(flags.get('--scales') ?? '1,4').split(',').map(Number) : null;
  if (scales && !scales.every(k => Number.isFinite(k) && k > 0 && k <= 16)) return {code: 2, output: `--scales is a comma-separated list of department sizes, multiples of this graph's (0 < k <= 16)\n${USAGE}`};
  if (q === 'impact-range' && (!subject || !extra)) return {code: 2, output: USAGE};
  if (q === 'shared-prerequisites' && !(flags.get('--work-root') && flags.get('--work-anchor'))) return {code: 2, output: `shared-prerequisites reads a work ledger: name --work-root and --work-anchor\n${USAGE}`};
  if (!['stats', 'impact-range', 'shared-prerequisites', 'hub-readiness'].includes(q) && !subject) return {code: 2, output: `${q} needs a SUBJECT\n${USAGE}`};
  let commit;
  try { commit = resolveCommit(repo, q === 'impact-range' ? extra : flags.get('--commit') ?? 'HEAD'); }
  catch (e) { return {code: 1, output: JSON.stringify({error: 'NOT_FOUND', why: e.message}, null, 2)}; }
  if (built && built.commit !== commit) return {code: 1, output: JSON.stringify({error: 'BAD_REQUEST', why: `the graph given is at ${built.commit}, not ${commit}`}, null, 2)};
  const g = built ?? (q === 'shared-prerequisites' ? d1Built({repo, commit, work: {root: path.resolve(flags.get('--work-root')), anchor: flags.get('--work-anchor')}, deps: false, observed_at})
    : null) ?? systemsGraph({repo, commit, lessons: !flags.has('--no-lessons'), deps: !flags.has('--no-deps'), observed_at,
    ...(flags.has('--no-status') ? {status: null} : {status: {root: path.join(repo, 'status/ledger')}})});
  try {
    const view = g.graph.view();
    const head = {graph: {commit, cursor: view.seq, digest: view.digest(), sources: g.observed,
      note: 'built for this run from the registered sources (synthetic keys, a temporary graph ledger); nothing is claimed beyond what they state'}};
    let out;
    if (q === 'stats') out = {...head, stats: view.stats()};
    else if (q === 'hub-readiness') out = {...head, ...hubReadiness({built: g, repo, scales})};
    else if (q === 'impact-range') {
      let from;
      try { from = resolveCommit(repo, subject); } catch (e) { return {code: 1, output: JSON.stringify({error: 'NOT_FOUND', why: e.message}, null, 2)}; }
      out = {...head, ...impactOfRange(view, {repo, from, to: commit, ...bounds})};
    } else if (D1_QUERIES.includes(q)) {
      if (q === 'shared-prerequisites') out = {...head, ...sharedPrerequisites(view)};
      else {
        const s = subjectOf(view, subject);
        out = s.error ? s : q === 'why-exists' ? {...head, ...whyExists(view, s.id)}
          : {...head, ...learningReuse(view, {component: s.id, test: flags.get('--test'), claim: flags.get('--claim')})};
      }
    } else if (q === 'trace') {
      const s = subjectOf(view, subject);
      out = s.error ? s : {...head, ...trace(view, s.id)};
    } else {
      const a = answer(g.graph, q, subject, {...bounds, since: flags.get('--since'), transitive: flags.has('--transitive')});
      out = a.error ? a : {...head, ...a};
    }
    return {code: out.error ? 1 : 0, output: JSON.stringify(out, null, 2)};
  } finally { if (!built) g.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const {code, output} = run(process.argv.slice(2));
  (code === 2 ? process.stderr : process.stdout).write(output + '\n');
  process.exit(code);
}
