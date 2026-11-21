// THE REGISTER'S RECORDS AT A COMMIT as a graph source (Slice B, KB1; docs/knowledge-graph/slice-b.md).
//
// Purpose   The open-limitations register (docs/OPEN-LIMITATIONS.md, coordinator-only; read here, never written) and the
//           code that cites its entries, projected with a TEXTUAL basis: an entry id (`L-504`, `KG-1`) written in a file,
//           or a repository path written in an entry, is a `mentions` -- what the text NAMES. Per the relationship
//           registry a mention is never a dependency, a cause or a qualification: impact does not follow it, and a
//           change to a cited file names its citing records for reassessment without declaring them affected.
// Inputs    The repository root and a commit: the register's text and every code file's text at that commit (git.mjs).
// Outputs   recordsSource(); recordsFacts(); registerEntries() (the register's parser, exported for the tests).
// Facts     evidence/record/register/<id>   an entry: its section, its status cell, its text (bounded) and the owner
//                                           decisions quoted for it; an id cited by a file but not an entry of the
//                                           register at that commit is recorded `unresolved`, never invented
//           mentions                        a code or test file -> an entry it cites (with the lines); an entry -> a
//                                           file of the tree it names; an entry -> another entry it names
// Must never  Admit a mention as depends-on or a cause; read the working tree; read a withheld path; write the register.
import {entityId} from '../../../packages/graph/index.mjs';
import {treeAt, blobsAt, resolveCommit} from './git.mjs';
import {fileId} from './repo.mjs';

export const SOURCE_ID = 'ophanim.records';
export const EXTRACTOR = 'ophanim.records.extractor';
export const REGISTER = 'docs/OPEN-LIMITATIONS.md';
/** TEXTUAL: what this extractor admits are mentions (the registry admits nothing else from a textual basis). */
export const RECORDS_ORIGIN = Object.freeze({kind: 'extractor', basis: 'textual', sources: [SOURCE_ID]});
export const ENTRY_ID = /\b(L-\d{3}|KG-\d+)\b/g;
export const recordId = id => entityId({domain: 'evidence', type: 'record', key: `register/${id}`});
const JS = /\.(mjs|js|cjs)$/;
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const bounded = (xs, n = 32) => (xs.length > n ? [...xs.slice(0, n), `... ${xs.length - n} more`] : xs);

/**
 * The register's entries: a table row whose first cell is an id defines it ({id, line, section, cells, status});
 * an owner-decision bullet `- **L-001.** ...` adds a decision to it. Returns Map id -> entry, in order of definition.
 */
export function registerEntries(text) {
  const entries = new Map(), decisions = new Map();
  let section = null;
  text.split('\n').forEach((line, i) => {
    const h = /^#{2,4}\s+(.+)$/.exec(line);
    if (h) { section = cut(h[1].trim(), 160); return; }
    const row = /^\|\s*(L-\d{3}|KG-\d+)\s*\|(.*)\|\s*$/.exec(line);
    if (row && !entries.has(row[1])) {
      const cells = row[2].split(/(?<!\\)\|/).map(c => c.trim());
      entries.set(row[1], {id: row[1], line: i + 1, section, text: line, item: cut(cells[0] ?? '', 600), status: cut(cells.at(-1) ?? '', 300), cells: cells.length + 1});
      return;
    }
    const bullet = /^\s*-\s+\*\*(L-\d{3}|KG-\d+)\.?\*\*\.?\s*(.*)$/.exec(line);
    if (bullet) (decisions.get(bullet[1]) ?? decisions.set(bullet[1], []).get(bullet[1])).push({line: i + 1, section, text: cut(bullet[2], 400)});
  });
  for (const [id, ds] of decisions) if (entries.has(id)) entries.get(id).decisions = ds;
  return entries;
}

/** The facts of the register and its citations at `commit`, as the extractor's drafts. */
export function recordsFacts(repo, commit, {register = REGISTER} = {}) {
  const tree = treeAt(repo, commit), paths = new Set(tree.entries.map(e => e.path));
  const reg = tree.entries.find(e => e.path === register);
  const code = tree.entries.filter(e => JS.test(e.path) && e.mode !== '120000');
  const bytes = blobsAt(repo, [...(reg ? [reg.blob] : []), ...code.map(e => e.blob)]);
  const drafts = [];
  const entries = reg ? registerEntries(bytes.get(reg.blob).toString('utf8')) : new Map();
  // What each file cites: id -> lines.
  const cited = new Map();
  for (const e of code) {
    const lines = bytes.get(e.blob).toString('utf8').split('\n');
    lines.forEach((l, i) => { for (const m of l.matchAll(ENTRY_ID)) {
      const k = `${e.path}\0${m[1]}`;
      (cited.get(k) ?? cited.set(k, {path: e.path, id: m[1], lines: []}).get(k)).lines.push(i + 1);
    } });
  }
  const unresolved = new Map();
  for (const c of cited.values()) if (!entries.has(c.id)) (unresolved.get(c.id) ?? unresolved.set(c.id, []).get(c.id)).push(c.path);
  // A ref names WHERE (the entry by its id), never the version or a line: an edit elsewhere in the register is not a
  // change of this entry. (Its line at this commit is the retrieval's business: {op: show, commit, path}.)
  for (const en of entries.values()) {
    const at = `${register}#${en.id}`;
    drafts.push({entity: recordId(en.id), ref: at, attributes: {id: en.id, register, section: en.section,
      item: en.item, status: en.status, decisions: (en.decisions ?? []).slice(0, 16)}});
    // What the entry names: files of the tree (in backticks or bare, with an optional :line suffix) and other entries.
    const named = new Set();
    for (const m of en.text.matchAll(/`([^`\s]+)`|(?<![\w./-])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,5})(?![\w/])/g)) {
      const p = (m[1] ?? m[2]).replace(/[:~]\d+(?:-\d+)?$/, '').replace(/[,.;)]+$/, '');
      if (paths.has(p)) named.add(p);
    }
    for (const p of [...named].sort()) drafts.push({type: 'mentions', from: recordId(en.id), to: fileId(p), ref: at, attributes: {basis: 'the entry names this path'}});
    const others = new Set([...en.text.matchAll(ENTRY_ID)].map(m => m[1]).filter(x => x !== en.id && entries.has(x)));
    for (const o of [...others].sort()) drafts.push({type: 'mentions', from: recordId(en.id), to: recordId(o), ref: at, attributes: {basis: 'the entry names this entry'}});
  }
  for (const [id, files] of [...unresolved].sort()) {
    drafts.push({entity: recordId(id), ref: `${register}#${id}`, status: 'unresolved',
      missing_evidence: [`cited by ${files.length} file(s) but not an entry of ${register} at this commit${reg ? '' : ' (the register is not in that tree)'}`],
      attributes: {id, register, cited_by: bounded(files.sort())}});
  }
  for (const c of [...cited.values()].sort((a, b) => (`${a.path}\0${a.id}` < `${b.path}\0${b.id}` ? -1 : 1))) {
    drafts.push({type: 'mentions', from: fileId(c.path), to: recordId(c.id), ref: c.path,
      attributes: {basis: 'the file cites this entry id', lines: bounded(c.lines, 16)}});
  }
  return drafts;
}

/** The adapter: the register and its citations at the commit `ref` names now (readAt: that commit's objects). */
export function recordsSource({repo, ref = 'HEAD', register = REGISTER, extractor = EXTRACTOR} = {}) {
  return {
    id: SOURCE_ID, extractor, ref: register,
    authority: `${register} (the open-limitations register; coordinator-only, read here) and the code that cites it, at a commit`,
    current: () => ({version: resolveCommit(repo, ref)}),
    readAt: version => recordsFacts(repo, version, {register}),
  };
}
