#!/usr/bin/env node
// THE OPT-IN DEPENDENCY SOURCES, from the command line (docs/knowledge-graph/dependencies.md).
//
//   node ophanim/graph/deps/cli.mjs needs SUBJECT       what SUBJECT depends on, by kind, with lines and sources
//   node ophanim/graph/deps/cli.mjs needed-by SUBJECT   what depends on SUBJECT, and the advisory assessment
//   node ophanim/graph/deps/cli.mjs audit               what each reading could not state; each pin against the sibling's file
//   node ophanim/graph/deps/cli.mjs stats               the sources observed and the size of the graph
//   options: [--repo DIR] [--commit C] [--telos DIR] [--argo DIR] [--lexi DIR] [--state NAME=DIR] [--no-status] [--no-lessons]
//   --state names ONE runtime state directory (the record of what the runtime built there): Slice B2's board source and
//   this directory's runtime source both read it.
//
// The graph is Slice B2's (ophanim/graph/extract/index.mjs, with its dependency sources) and, beside it, the sources of
// this directory: the calls between this repository's functions, the runtime's record and the sibling repositories.
// SUBJECT is whatever B2's questions accept (a path, npm:name@version, package:name, node:name, env:NAME, exec:name,
// host:name, workspace:name, repository:name, a graph id) and also path#function and <sibling>:path[#function]. A
// sibling repository is read only from a checkout given by its option or by OPHANIM_TELOS_ROOT, OPHANIM_ARGO_ROOT or
// OPHANIM_LEXI_ROOT; one that is not given is listed as absent and nothing is stated of it. TELOS is read at the commit
// this repository pins.
//
// Each run builds the graph afresh in a temporary directory with SYNTHETIC keys made for the run and discarded with it;
// it writes nothing else and opens no network. The answer is JSON on stdout. Exit 0 with an answer, 1 when the subject
// cannot be answered (the reason is the output), 2 on a usage error.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {dependencyGraph, SIBLINGS, ROOT} from './index.mjs';
import {needs, neededBy, audit} from './query.mjs';

const USAGE = `usage: node ophanim/graph/deps/cli.mjs (needs|needed-by) SUBJECT [options]
       node ophanim/graph/deps/cli.mjs (audit|stats) [options]
       options: [--repo DIR] [--commit C] ${Object.keys(SIBLINGS).map(n => `[--${n} DIR]`).join(' ')} [--state NAME=DIR] [--no-status] [--no-lessons]`;
const WITH_SUBJECT = {needs, 'needed-by': neededBy}, WITHOUT = ['audit', 'stats'];

export function main(argv, {out = s => process.stdout.write(s), err = s => process.stderr.write(s), env = process.env} = {}) {
  const [command, ...rest] = argv, flags = {}, positional = [];
  const VALUED = ['repo', 'commit', 'state', ...Object.keys(SIBLINGS)], BARE = ['no-status', 'no-lessons'];
  let state = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const k = a.slice(2);
    if (BARE.includes(k)) flags[k] = true;
    else if (k === 'state' && !state && /^[a-z][a-z0-9-]{0,31}=.+/.test(rest[i + 1] ?? '')) { const v = rest[++i], eq = v.indexOf('='); state = {name: v.slice(0, eq), stateDir: path.resolve(v.slice(eq + 1))}; }
    else if (VALUED.includes(k) && k !== 'state' && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) flags[k] = rest[++i];
    else { err(USAGE + '\n'); return 2; }
  }
  const needsSubject = Object.hasOwn(WITH_SUBJECT, command);
  if ((!needsSubject && !WITHOUT.includes(command)) || positional.length !== (needsSubject ? 1 : 0)) { err(USAGE + '\n'); return 2; }
  const siblings = Object.fromEntries(Object.keys(SIBLINGS).map(n => [n, flags[n] ?? env[`OPHANIM_${n.toUpperCase()}_ROOT`]]).filter(([, dir]) => dir).map(([n, dir]) => [n, {repo: path.resolve(dir)}]));
  const g = dependencyGraph({repo: flags.repo ? path.resolve(flags.repo) : ROOT, commit: flags.commit, siblings, state,
    ...(flags['no-status'] ? {status: null} : {}), lessons: !flags['no-lessons']});
  try {
    const view = g.graph.view();
    const graph = {commit: g.commit, cursor: view.seq, digest: view.digest(), pinned: g.pinned, absent: g.absent,
      sources: Object.fromEntries(Object.entries(g.observed).map(([id, o]) => [id, {recorded: o.recorded, state: o.state, version: o.version, facts: o.count, ...(o.why ? {why: o.why} : {})}])),
      note: 'built for this run from the registered sources (synthetic keys, a temporary graph ledger); nothing is claimed beyond what they state'};
    const answer = command === 'stats' ? {query: 'stats', stats: view.stats()} : command === 'audit' ? audit(view) : WITH_SUBJECT[command](view, positional[0]);
    out(JSON.stringify({graph, ...answer}, null, 1) + '\n');
    return answer.error ? 1 : 0;
  } finally { g.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
