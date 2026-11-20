// The repository AT A COMMIT, read from git's object store only (Slice B, KB1; docs/knowledge-graph/slice-b.md).
//
// Purpose   The one reader the repository-backed extractors share (repo.mjs, verification.mjs, records.mjs): the tree of
//           a commit, the bytes of its blobs, its ancestry, and a skeleton of it on disk for the code that only reads
//           files (scripts/test-gates/suites.mjs). A commit is immutable, so a reading at a commit is reproducible: a
//           replay asks for the same commit and gets the same facts. THE WORKING TREE IS NEVER READ: an uncommitted edit,
//           an untracked file or a deleted one does not change what these functions return.
// Inputs    The repository root and a commit id (or a name git resolves to one: only resolveCommit takes a name).
// Outputs   treeAt: {commit, entries [{path, mode, type, blob, size}], withheld}; blobsAt: Map blob -> Buffer;
//           historyAt: [{commit, parents, date, subject, paths, cut}] newest first; historyCut: a shallow clone's boundary; skeletonAt: a temporary directory.
// Must never  Read a withheld path's bytes (WITHHELD: review findings, `findings-*`, which no agent of this program
//           reads; they are counted, never opened); write to the repository; follow a symbolic link's target.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

/** Paths no extractor reads: recorded review findings (`findings-*` folders and files). Counted, never opened. */
export const WITHHELD = /(^|\/)findings-[^/]*(\/|$)/;
export const COMMIT = /^[0-9a-f]{40}$/;
const MAX = 1 << 28;

const run = (repo, args, opts = {}) => execFileSync('git', ['-c', 'core.quotepath=off', '-C', repo, ...args],
  {maxBuffer: MAX, stdio: ['pipe', 'pipe', 'pipe'], ...opts});

/** The 40-hex commit `ref` names in `repo` (a name is resolved once, here); throws when it names no commit. */
export function resolveCommit(repo, ref = 'HEAD') {
  let out;
  try { out = run(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {encoding: 'utf8'}).trim(); }
  catch { throw new Error(`${ref} is not a commit of ${path.basename(repo)}`); }
  if (!COMMIT.test(out)) throw new Error(`${ref} did not resolve to a commit id`);
  return out;
}

// One commit's readings are kept while it is the one being read (the three extractors read the same commit in turn).
const cache = new Map(), blobCache = new Map();
const cached = (key, make) => {
  if (cache.has(key)) return cache.get(key);
  const v = make();
  if (cache.size > 24) cache.delete(cache.keys().next().value);
  cache.set(key, v);
  return v;
};

/** The tree of `commit`: every blob with its mode, id and size. Withheld paths are counted and left out. */
export function treeAt(repo, commit) {
  if (!COMMIT.test(commit ?? '')) throw new Error(`${commit} is not a commit id (a tree is read at a commit, never at a name)`);
  return cached(`${repo}\0tree\0${commit}`, () => {
    const raw = run(repo, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit], {encoding: 'utf8'});
    const entries = [];
    let withheld = 0;
    for (const rec of raw.split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t'), [mode, type, blob, size] = rec.slice(0, tab).trim().split(/\s+/), p = rec.slice(tab + 1);
      if (type !== 'blob') continue;                                   // a submodule is not this repository's file
      if (WITHHELD.test(p)) { withheld++; continue; }
      entries.push({path: p, mode, type, blob, size: Number(size)});
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return Object.freeze({commit, entries: Object.freeze(entries), withheld});
  });
}

/** The bytes of the given blobs, from git's object store in one `cat-file --batch`. */
export function blobsAt(repo, blobs) {
  const want = [...new Set(blobs)].filter(b => !blobCache.has(`${repo}\0${b}`));
  if (want.length) {
    const out = run(repo, ['cat-file', '--batch'], {input: want.join('\n') + '\n'});
    let at = 0;
    for (const b of want) {
      const nl = out.indexOf(0x0a, at), head = out.subarray(at, nl).toString('utf8').split(' ');
      if (head[1] === 'missing') throw new Error(`blob ${b} is not in git's object store`);
      const size = Number(head[2]), body = out.subarray(nl + 1, nl + 1 + size);
      if (head[0] !== b) throw new Error(`git returned ${head[0]} for ${b}`);
      blobCache.set(`${repo}\0${b}`, body);
      at = nl + 1 + size + 1;
    }
    while (blobCache.size > 20_000) blobCache.delete(blobCache.keys().next().value);
  }
  return new Map(blobs.map(b => [b, blobCache.get(`${repo}\0${b}`)]));
}

/** The text of one path at `commit`, or null when the commit's tree has no such (readable) path. */
export function textAt(repo, commit, p) {
  if (WITHHELD.test(p)) return null;
  const e = treeAt(repo, commit).entries.find(x => x.path === p);
  return e && e.mode !== '120000' ? blobsAt(repo, [e.blob]).get(e.blob).toString('utf8') : null;
}

/**
 * The ancestry of `commit`, newest first: each commit's parents, author date, subject line and the paths it changed
 * against its first parent (none for a merge, as `git log --name-only` reports it). Withheld paths are left out.
 */
/**
 * The commits this checkout's history is CUT at: a shallow clone's boundary, whose parents are not in it (git's
 * `shallow` file). Empty when the history is complete. A cut commit looks like a root commit to `git log`, which then
 * lists every path of its tree as changed; that is not a fact about the commit (coordinator fix at integration: a
 * shallow CI checkout named its single commit as the one that introduced every file).
 */
export function historyCut(repo) {
  return cached(`${repo}\0shallow`, () => {
    let file;
    try { file = run(repo, ['rev-parse', '--git-path', 'shallow'], {encoding: 'utf8'}).trim(); } catch { return Object.freeze([]); }
    const at = path.isAbsolute(file) ? file : path.join(repo, file);
    let text = '';
    try { text = fs.readFileSync(at, 'utf8'); } catch { return Object.freeze([]); }
    return Object.freeze(text.split('\n').map(x => x.trim()).filter(x => COMMIT.test(x)).sort());
  });
}

export function historyAt(repo, commit) {
  if (!COMMIT.test(commit ?? '')) throw new Error(`${commit} is not a commit id`);
  return cached(`${repo}\0history\0${commit}`, () => {
    const cut = new Set(historyCut(repo));
    const raw = run(repo, ['log', '--no-renames', '--name-only', '--format=%x01%H%x00%P%x00%aI%x00%s', commit], {encoding: 'utf8'});
    const out = [];
    for (const chunk of raw.split('\x01')) {
      if (!chunk.trim()) continue;
      const nl = chunk.indexOf('\n'), head = (nl === -1 ? chunk : chunk.slice(0, nl)).split('\0');
      const paths = (nl === -1 ? '' : chunk.slice(nl + 1)).split('\n').map(s => s.trim()).filter(p => p && !WITHHELD.test(p));
      out.push(Object.freeze({commit: head[0], parents: head[1] ? head[1].split(' ') : [], date: head[2], subject: head[3] ?? '', paths: Object.freeze([...new Set(paths)].sort()),
        cut: cut.has(head[0])}));
    }
    return Object.freeze(out);
  });
}

/** The paths that differ between two commits ({path, status}: A, M, D), from git, never from the working tree. */
export function changedBetween(repo, from, to) {
  for (const c of [from, to]) if (!COMMIT.test(c ?? '')) throw new Error(`${c} is not a commit id`);
  const raw = run(repo, ['diff', '--no-renames', '--name-status', '-z', from, to], {encoding: 'utf8'}).split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < raw.length; i += 2) if (!WITHHELD.test(raw[i + 1])) out.push({status: raw[i][0], path: raw[i + 1]});
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A SKELETON of `commit` in a new temporary directory: every (non-withheld) path of its tree, empty, except the paths
 * `withContent(path)` selects, which hold their bytes at the commit. For code that reads a tree from disk (suites.mjs
 * expands its globs against one) without ever reading the working tree. The caller removes it (`dispose`).
 */
export function skeletonAt(repo, commit, withContent) {
  const tree = treeAt(repo, commit);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-skeleton-'));
  const full = tree.entries.filter(e => e.mode !== '120000' && withContent(e.path));
  const bytes = blobsAt(repo, full.map(e => e.blob));
  const selected = new Set(full.map(e => e.path));
  for (const e of tree.entries) {
    const abs = path.join(dir, e.path);
    fs.mkdirSync(path.dirname(abs), {recursive: true});
    fs.writeFileSync(abs, selected.has(e.path) ? bytes.get(e.blob) : '');
  }
  return {dir, dispose: () => fs.rmSync(dir, {recursive: true, force: true})};
}
