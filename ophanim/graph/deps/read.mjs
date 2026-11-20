// ONE READING OF A REPOSITORY'S CODE AT A COMMIT, shared by the dependency sources that state different things from it.
//
// Purpose   The structural source (code.mjs) and the textual source (text.mjs) both rest on the same parse of the same
//           files at the same commit. This reads the tree once (git's object store, never the working tree) and parses
//           each code file once, so the two sources cannot disagree about what a file says.
// Inputs    A repository root and a commit (40 hex).
// Outputs   readTree(repo, commit) -> {commit, entries (path -> {path, blob, size, mode}), paths (Set), withheld,
//           code: [paths read], text (path -> text, for code files and manifests), readings (path -> readCode result)}.
// Invariants  Withheld paths (extract/git.mjs WITHHELD: recorded review findings) are never read. A symbolic link is
//           never read as code. The result for one (repo, commit) is the same object while it is kept (a small cache).
// Must never  Read the working tree, or keep more than a few commits' readings in memory.
import {treeAt, blobsAt} from '../extract/git.mjs';
import {readCode} from './parse.mjs';

export const CODE = /\.(mjs|js|cjs|jsx|ts|mts|cts|tsx)$/;
export const MANIFEST = /(^|\/)(package\.json|package-lock\.json)$/;
const VENDORED = /(^|\/)node_modules\//;
const KEEP = 6, cache = new Map();

export function readTree(repo, commit) {
  const key = `${repo}\0${commit}`;
  if (cache.has(key)) return cache.get(key);
  const tree = treeAt(repo, commit);
  const entries = new Map(tree.entries.map(e => [e.path, e])), paths = new Set(entries.keys());
  const wanted = tree.entries.filter(e => e.mode !== '120000' && !VENDORED.test(e.path) && (CODE.test(e.path) || MANIFEST.test(e.path)));
  const bytes = blobsAt(repo, wanted.map(e => e.blob));
  const text = new Map(wanted.map(e => [e.path, bytes.get(e.blob).toString('utf8')]));
  const code = wanted.filter(e => CODE.test(e.path)).map(e => e.path).sort();
  const readings = new Map(code.map(p => [p, readCode(text.get(p), {file: p})]));
  const out = Object.freeze({commit, entries, paths, withheld: tree.withheld, code, text, readings});
  cache.set(key, out);
  if (cache.size > KEEP) cache.delete(cache.keys().next().value);
  return out;
}
