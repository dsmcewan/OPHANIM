// WHAT A REPOSITORY'S CODE NAMES IN ITS STRINGS, at a commit, as a graph source with a TEXTUAL basis.
//
// Purpose   A URL or a path written in a string says the file NAMES a host or another file; it does not say the file
//           calls the host or reads the path (code.mjs states a read only where the path is the argument of a read). Per
//           the relationship registry a mention is never a dependency: impact does not follow it, and a change to a named
//           file lists the files that name it for reassessment without declaring them affected.
// Inputs    A repository root, a commit, and the repository's name in the graph. The same parse as code.mjs (read.mjs).
// Outputs   textSource(); textFacts(); textOrigin(names); textSourceIdOf(name).
// Facts     systems/service host:<host>   a host some string of the code names
//           mentions   file -> host (with the lines); file -> a tracked file whose path a string IS, exactly, from the
//                      repository root, or beside the file when the string starts with ./ or ../
// Must never  Admit a mention as depends-on; match a path by its ending or by resemblance; read a comment as a string;
//           read the working tree.
import path from 'node:path';
import {resolveCommit} from '../extract/git.mjs';
import {readTree} from './read.mjs';
import {HOME, fileIdIn, hostId} from './ids.mjs';

export const TEXT_EXTRACTOR = 'ophanim.code-text.extractor';
export const textSourceIdOf = name => (name === HOME ? 'ophanim.code-text' : `sibling.${name}.code-text`);
/** TEXTUAL: what this extractor admits are mentions (the registry admits nothing else from a textual basis). */
export const textOrigin = (names = [HOME]) => Object.freeze({kind: 'extractor', basis: 'textual', sources: names.map(textSourceIdOf)});
const bounded = (xs, n = 16) => (xs.length > n ? [...xs.slice(0, n), `... ${xs.length - n} more`] : xs);

/** The mentions in the code of `repo` at `commit`, as the extractor's drafts. */
export function textFacts(repo, commit, {name = HOME} = {}) {
  const tree = readTree(repo, commit), fid = p => fileIdIn(name, p);
  const hosts = new Map(), mentions = new Map(), files = new Set();
  const note = (from, to, attributes, line) => {
    const k = `${from}\0${to.host ? 'host:' + to.host : 'path:' + to.path}`;
    (mentions.get(k) ?? mentions.set(k, {from, to, attributes, lines: new Set()}).get(k)).lines.add(line);
  };
  for (const file of tree.code) {
    const r = tree.readings.get(file);
    if (!r.ok) continue;
    for (const h of r.hosts) {
      (hosts.get(h.host) ?? hosts.set(h.host, {first: file, files: new Set()}).get(h.host)).files.add(file);
      note(file, {host: h.host}, {basis: 'the file names this host in a string'}, h.line);
    }
    for (const s of r.strings) {
      const beside = s.value.startsWith('./') || s.value.startsWith('../');
      const dir = path.posix.dirname(file), target = path.posix.normalize(beside ? (dir === '.' ? s.value : `${dir}/${s.value}`) : s.value);
      if (target === file || !tree.paths.has(target)) continue;
      files.add(file); files.add(target);
      note(file, {path: target}, {basis: 'the file names this path in a string', as_written: s.value}, s.line);
    }
  }
  const drafts = [];
  for (const [host, v] of [...hosts].sort()) drafts.push({entity: hostId(host), ref: v.first, attributes: {host, named_by: v.files.size}});
  if (name !== HOME) {
    for (const h of hosts.values()) for (const f of h.files) files.add(f);
    for (const p of [...files].sort()) drafts.push({entity: fid(p), ref: p, attributes: {path: p, blob: tree.entries.get(p).blob, bytes: tree.entries.get(p).size}});
  }
  const edges = [...mentions.values()].map(m => ({type: 'mentions', from: fid(m.from), to: m.to.host ? hostId(m.to.host) : fid(m.to.path), ref: m.from,
    attributes: {...m.attributes, lines: bounded([...m.lines].sort((a, b) => a - b))}}));
  return [...drafts, ...edges.sort((a, b) => (`${a.from}\0${a.to}` < `${b.from}\0${b.to}` ? -1 : 1))];
}

/** The adapter: what the code names in its strings at the commit `ref` names now (readAt: that commit's objects). */
export function textSource({repo, ref = 'HEAD', name = HOME, extractor = TEXT_EXTRACTOR} = {}) {
  return {
    id: textSourceIdOf(name), extractor, ref: 'git',
    authority: `the strings in the code of the ${name} repository at a commit: what the text names, never what the code does`,
    current: () => ({version: resolveCommit(repo, ref)}),
    readAt: version => textFacts(repo, version, {name}),
  };
}
