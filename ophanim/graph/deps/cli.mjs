#!/usr/bin/env node
// THE DEPENDENCY GRAPH, from the command line (docs/knowledge-graph/dependencies.md).
//
//   node ophanim/graph/deps/cli.mjs needs SUBJECT       what SUBJECT depends on, by kind, with lines and sources
//   node ophanim/graph/deps/cli.mjs needed-by SUBJECT   what depends on SUBJECT, and the advisory assessment
//   node ophanim/graph/deps/cli.mjs audit               what each reading could not state; where two sources agree
//   node ophanim/graph/deps/cli.mjs stats               the sources observed and the size of the graph
//   options: [--repo DIR] [--commit C] [--telos DIR] [--argo DIR] [--lexi DIR] [--no-status] [--no-lessons]
//
// SUBJECT is a path, path#function, npm:name, node:name, program:name, env:NAME, host:name, <sibling>:path[#function],
// or a graph id. A sibling repository is read only from a checkout given by its option or by OPHANIM_TELOS_ROOT,
// OPHANIM_ARGO_ROOT or OPHANIM_LEXI_ROOT; one that is not given is listed as absent and nothing is stated of it. TELOS is
// read at the commit this repository pins.
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
       options: [--repo DIR] [--commit C] ${Object.keys(SIBLINGS).map(n => `[--${n} DIR]`).join(' ')} [--no-status] [--no-lessons]`;
const WITH_SUBJECT = {needs, 'needed-by': neededBy}, WITHOUT = ['audit', 'stats'];

export function main(argv, {out = s => process.stdout.write(s), err = s => process.stderr.write(s), env = process.env} = {}) {
  const [command, ...rest] = argv, flags = {}, positional = [];
  const VALUED = ['repo', 'commit', ...Object.keys(SIBLINGS)], BARE = ['no-status', 'no-lessons'];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const k = a.slice(2);
    if (BARE.includes(k)) flags[k] = true;
    else if (VALUED.includes(k) && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) flags[k] = rest[++i];
    else { err(USAGE + '\n'); return 2; }
  }
  const needsSubject = Object.hasOwn(WITH_SUBJECT, command);
  if ((!needsSubject && !WITHOUT.includes(command)) || positional.length !== (needsSubject ? 1 : 0)) { err(USAGE + '\n'); return 2; }
  const siblings = Object.fromEntries(Object.keys(SIBLINGS).map(n => [n, flags[n] ?? env[`OPHANIM_${n.toUpperCase()}_ROOT`]]).filter(([, dir]) => dir).map(([n, dir]) => [n, {repo: path.resolve(dir)}]));
  const g = dependencyGraph({repo: flags.repo ? path.resolve(flags.repo) : ROOT, commit: flags.commit, siblings,
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
