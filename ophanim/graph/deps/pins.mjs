// WHAT THIS REPOSITORY PINS FROM OUTSIDE ITSELF, at a commit, as a graph source (the dependency sources; ids.mjs).
//
// Purpose   Three declarations a file of this repository makes about something that is not this repository:
//           (a) ophanim/governance.mjs pins TELOS: `TELOS_COMMIT` (a commit id) and `TELOS_PINS` (TELOS path -> sha256
//               of the file's bytes), and it pins its own checker files in tables of the same form (today `CHECK_PINS`
//               and `EFFICIENCY_PINS`: file names under ophanim/governance/). At run time createGovernance()'s
//               assertPins() hashes the WORKING-TREE file at each path (TELOS paths under the checkout it is given,
//               checker names under the `governance` folder beside the file) and refuses on any difference.
//           (b) PROVENANCE.json records that this repository was filtered out of ARGO: the source commits, the pairs
//               ARGO commit -> commit here, the paths taken, left out and kept behind.
//           (c) the CI workflows name the actions they use (`uses: owner/name@ref`) and the Node they set up
//               (`node-version:`); package.json names the Node range it accepts (`engines.node`).
//           All three are DECLARATIONS, so the extractor's basis is `declared`.
// Inputs    The repository root and a commit: the three files' text at that commit, from git's object store (git.mjs).
//           governance.mjs is read AS TEXT, never imported (importing it loads TELOS code). No TELOS checkout is read
//           here: whether a pinned digest holds is compared by the audit (query.mjs) with the digest the sibling's own
//           source states for the file at the pinned commit, so these facts are the same with or without a checkout.
// Outputs   pinsSource(): the adapter; pinsFacts(): the drafts of one commit; pinTables() and workflowDeclarations():
//           the two text readers, exported for the tests; siblingChangeId(): a commit of a sibling repository.
// Facts     systems/repository/telos                 the pinned commit and who pins it
//           systems/module|file/telos:<path>         a pinned TELOS file: its pinned sha256, the commit, the line of the
//                                                    table entry. Nothing here says whether the digest holds.
//           depends-on   governance.mjs -> the TELOS repository (basis 'commit pin'); -> each pinned TELOS file and
//                        each pinned local checker (basis 'digest pin'). A local pin carries `found` and `matches`:
//                        the sha256 of that file's blob AT THE SAME COMMIT against the pinned one. (The run-time check
//                        is of the working tree; this one is of the commit.)
//           systems/repository/argo                  the ARGO source commit PROVENANCE.json names
//           derived-from the repository -> ARGO, with the record's fields (bounded); a commit here -> the ARGO commit
//                        it was filtered from (systems/change/argo:<commit>)
//           systems/workflow/<file>                  a workflow: the actions and Node versions it names
//           systems/component/action:<owner/name>    an action, with the refs seen; the workflow `depends-on` it
//           systems/component/program:node           Node, with each version text as stated; the workflow that sets it
//                                                    up and package.json (engines.node) `depend-on` it
//           systems/repository/ophanim               what was read; UNRESOLVED when PROVENANCE.json is absent, not
//                                                    valid JSON or names no ARGO commit (never a throw, never a guess)
// Limits    The pin tables are read by line: `const NAME_PINS = Object.freeze({`, one `'path': '<64 hex>',` a line,
//           `});`. A line of a table in another form is listed (`unread_lines`); a table declared in another form is
//           listed (`unread_tables`). A local table is placed only by the comparison line that names its folder
//           (`path.join(HERE, '<folder>', rel)`); without it the table's pins are counted, not placed.
//           THE WORKFLOW READER IS NOT A YAML PARSER. It reads lines of the form `uses: value` and `node-version: value`
//           (after an optional `- `; a comment line is not of that form), skips the body of a block scalar (`run: |`), and takes a quoted
//           or bare scalar with a trailing comment removed. It misses: flow mappings (`{uses: a/b@v1}`), a value on the
//           following lines, anchors and aliases, quoted keys, `node-version-file:`, and a matrix's expansion (an
//           expression is listed as text, not resolved). It cannot tell a `node-version:` that is a setup-node input
//           from one that is a matrix variable: both are a Node version the workflow states.
//           The ARGO lineage is what the record declares; it is not checked against the ARGO repository.
//           The version of this source is the commit of THIS repository. Whether a TELOS checkout was given is not part
//           of it: the same commit read with and without one yields different facts (`verified` present or absent).
// Must never  Import or run governance.mjs or any file of TELOS; read a working tree; state `verified` without having
//           hashed the file at the pinned commit; record an absolute path of this machine; resolve an action's ref.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {entityId} from '../../../packages/graph/index.mjs';
import {treeAt, blobsAt, historyAt, resolveCommit, COMMIT} from '../extract/git.mjs';
import {fileId, changeId} from '../extract/repo.mjs';
import {workflowId} from '../extract/verification.mjs';
import {HOME, repositoryId, fileIdIn, packageId} from './ids.mjs';

export const SOURCE_ID = 'ophanim.pins';
export const EXTRACTOR = 'ophanim.pins.extractor';
/** DECLARED: a pin table, a provenance record and a workflow each state what they need (depends-on, derived-from). */
export const PINS_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [SOURCE_ID]});
export const GOVERNANCE = 'ophanim/governance.mjs';
export const PROVENANCE = 'PROVENANCE.json';
export const PACKAGE = 'package.json';
export const WORKFLOWS = '.github/workflows';
const TELOS = 'telos', ARGO = 'argo', TELOS_TABLE = 'TELOS_PINS';
/** A commit of a sibling repository. ids.mjs has no helper for one; the key follows its `<repository>:<...>` form. */
export const siblingChangeId = (repo, commit) => entityId({domain: 'systems', type: 'change', key: `${repo}:${commit}`});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const bounded = (xs, n = 32) => (xs.length > n ? [...xs.slice(0, n), `... ${xs.length - n} more`] : xs);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const uniq = xs => [...new Set(xs)].sort();
const strings = (v, n = 300) => (Array.isArray(v) ? bounded(v.filter(x => typeof x === 'string').map(x => cut(x, n))) : []);
const evidence = list => (list.length ? {missing_evidence: list} : {});

// ---- (a) the pin tables, read as text ---------------------------------------------------------------------------------
const COMMIT_DECL = /^(?:export\s+)?const\s+TELOS_COMMIT\s*=\s*'([0-9a-f]{40})'\s*;?\s*$/;
const TABLE_DECL = /\bconst\s+([A-Z][A-Z0-9_]*_PINS)\s*=/;
const TABLE_OPEN = /^(export\s+)?const\s+([A-Z][A-Z0-9_]*_PINS)\s*=\s*Object\.freeze\(\{\s*$/;
const TABLE_CLOSE = /^\}\);?\s*$/;
const ENTRY = /^\s*'([^'\\]+)'\s*:\s*'([0-9a-f]{64})'\s*,?\s*$/;
// The run-time comparison, as assertPins() writes it: which table, and what its paths are joined to.
const COMPARE = /Object\.entries\(\s*([A-Z][A-Z0-9_]*_PINS)\s*\)\s*\)\s*if\s*\(\s*rawHash\(\s*regular\(\s*path\.join\(\s*([A-Za-z_$][\w$]*)\s*,(?:\s*'([^'\\]*)'\s*,)?\s*rel\s*\)\s*\)\s*\)\s*!==\s*sha\s*\)/;

/**
 * The pin declarations of a governance file's text: {commit: {value, line} | null, tables: [{name, line, exported,
 * entries: [{path, sha256, line}], unread_lines, duplicates}], comparisons: {table: {root, dir, line}}, unread_tables}.
 * Lines are 1-based. Nothing is evaluated: a line that is not in the form read is listed, never interpreted.
 */
export function pinTables(text) {
  let commit = null, open = null;
  const tables = [], comparisons = {}, unread_tables = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, ''), n = i + 1;
    if (open) {
      if (TABLE_CLOSE.test(line)) { tables.push(open); open = null; return; }
      const e = ENTRY.exec(line);
      if (e) {
        if (open.entries.some(x => x.path === e[1])) open.duplicates.push({path: e[1], line: n});
        else open.entries.push({path: e[1], sha256: e[2], line: n});
      } else if (line.trim() && !/^\s*\/\//.test(line)) open.unread_lines.push(n);
      return;
    }
    const c = COMMIT_DECL.exec(line);
    if (c && !commit) { commit = {value: c[1], line: n}; return; }
    const t = TABLE_OPEN.exec(line);
    if (t) { open = {name: t[2], line: n, exported: Boolean(t[1]), entries: [], unread_lines: [], duplicates: []}; return; }
    const d = TABLE_DECL.exec(line);
    if (d) { unread_tables.push({name: d[1], line: n}); return; }
    const m = COMPARE.exec(line);
    if (m && !Object.hasOwn(comparisons, m[1])) comparisons[m[1]] = {root: m[2], dir: m[3] ?? null, line: n};
  });
  // A table whose closing line was never found: what was read of it is kept and marked.
  if (open) tables.push({...open, unclosed: true});
  return {commit, tables, comparisons, unread_tables};
}

function pinFacts({text, read, has, drafts, home}) {
  if (text === null) { home.attributes.pin_file = null; home.missing.push(`${GOVERNANCE} is not in the tree at this commit: no TELOS pin is read`); return; }
  home.attributes.pin_file = GOVERNANCE;
  const {commit, tables, comparisons, unread_tables} = pinTables(text);
  const from = fileId(GOVERNANCE), missing = [], descriptors = [];
  const local = {count: 0, matching: 0, mismatched: [], unresolved: []}, repeated = [], placed = new Set();
  for (const t of tables) {
    const cmp = comparisons[t.name] ?? null;
    const dir = t.name === TELOS_TABLE ? null : cmp?.root === 'HERE' ? path.posix.join(path.posix.dirname(GOVERNANCE), cmp.dir ?? '') : undefined;
    descriptors.push({name: t.name, line: t.line, entries: t.entries.length, pins: t.name === TELOS_TABLE ? TELOS : dir === undefined ? null : `${dir}/`, compared_at_line: cmp?.line ?? null,
      ...(t.unread_lines.length ? {unread_lines: bounded(t.unread_lines)} : {}), ...(t.duplicates.length ? {repeated_paths: bounded(uniq(t.duplicates.map(d => d.path)))} : {}),
      ...(t.unclosed ? {unclosed: true} : {})});
    if (t.unread_lines.length) missing.push(`${t.unread_lines.length} line(s) of ${t.name} are not a 'path': 'sha256' entry and were not read`);
    if (t.duplicates.length) missing.push(`${t.duplicates.length} path(s) of ${t.name} are written more than once; the first is read`);
    if (t.unclosed) missing.push(`the end of ${t.name} was not found: what follows its first line was read as the table`);
    if (t.name === TELOS_TABLE) continue;
    if (dir === undefined) { if (t.entries.length) missing.push(`${GOVERNANCE} does not say what the paths of ${t.name} are relative to: its ${t.entries.length} pin(s) are not placed`); continue; }
    // A local checker: the pinned digest against the file's blob at this same commit.
    for (const e of t.entries) {
      const p = path.posix.join(dir, e.path);
      if (placed.has(p)) { repeated.push(p); continue; }
      placed.add(p);
      local.count++;
      if (!has(p)) { local.unresolved.push(p); continue; }
      const found = sha256(read(p)), matches = found === e.sha256;
      if (matches) local.matching++; else local.mismatched.push(p);
      drafts.push({type: 'depends-on', from, to: fileId(p), ref: `${GOVERNANCE}#${t.name}`, attributes: {basis: 'digest pin', table: t.name, sha256: e.sha256, found, matches, line: e.line}});
    }
  }
  for (const u of unread_tables) missing.push(`${u.name} is declared at line ${u.line} in a form this reader does not read`);
  if (repeated.length) missing.push(`${repeated.length} local path(s) are pinned by more than one table; the first is read`);
  if (local.unresolved.length) missing.push(`${local.unresolved.length} locally pinned path(s) are not in the tree at this commit`);
  drafts.push({entity: from, ref: GOVERNANCE, attributes: {path: GOVERNANCE, telos_commit: commit?.value ?? null, pin_tables: bounded(descriptors),
    local_pins: {...local, mismatched: bounded(local.mismatched.sort()), unresolved: bounded(local.unresolved.sort())},
    ...(unread_tables.length ? {unread_tables: bounded(unread_tables)} : {}), ...(repeated.length ? {repeated_local_pins: bounded(uniq(repeated))} : {})}, ...evidence(missing)});

  // TELOS: the repository at the pinned commit and each pinned file, AS DECLARED. Whether a pinned digest holds is not
  // stated here: that is a comparison with the sibling's own file at the pinned commit, which the sibling's source states
  // (code.mjs `content_sha256`) and the audit makes (query.mjs). So this source gives the same facts for the same commit
  // whether or not a TELOS checkout is at hand, and a replay re-derives them.
  const pins = tables.find(t => t.name === TELOS_TABLE)?.entries ?? [];
  if (!commit && !tables.some(t => t.name === TELOS_TABLE)) return;
  const n = pins.length, c = commit?.value ?? null;
  const unchecked = c ? null : [`${GOVERNANCE} states no TELOS_COMMIT: there is no commit to check the ${n} pinned digest(s) at`, `${GOVERNANCE} states no TELOS_COMMIT: there is no commit to check the pinned digest at`];
  drafts.push({entity: repositoryId(TELOS), ref: `${GOVERNANCE}#${commit ? 'TELOS_COMMIT' : TELOS_TABLE}`,
    attributes: {name: TELOS, pinned_commit: c, pinned_by: GOVERNANCE, line: commit?.line ?? null, pinned_files: n},
    ...(unchecked ? {missing_evidence: [unchecked[0]]} : {})});
  if (commit) drafts.push({type: 'depends-on', from, to: repositoryId(TELOS), ref: `${GOVERNANCE}#TELOS_COMMIT`, attributes: {basis: 'commit pin', commit: c, line: commit.line}});
  for (const e of pins) {
    const id = fileIdIn(TELOS, e.path);
    drafts.push({entity: id, ref: `${GOVERNANCE}#${TELOS_TABLE}`, attributes: {repository: TELOS, path: e.path, sha256: e.sha256, commit: c, pinned_by: GOVERNANCE, line: e.line},
      ...(unchecked ? {missing_evidence: [unchecked[1]]} : {})});
    drafts.push({type: 'depends-on', from, to: id, ref: `${GOVERNANCE}#${TELOS_TABLE}`, attributes: {basis: 'digest pin', table: TELOS_TABLE, sha256: e.sha256, commit: c, line: e.line}});
  }
}

// ---- (b) the lineage record --------------------------------------------------------------------------------------------
const PROVENANCE_KEYS = ['schema', 'argoSourceCommit', 'pantheonSourceCommit', 'filteredCommits', 'includedPaths', 'excludedPaths', 'retainedInArgo', 'extraction'];

function lineageFacts({text, ancestry, drafts, home}) {
  const unresolved = why => { home.unresolved = true; home.attributes.provenance = null; home.missing.push(why); };
  if (text === null) return unresolved(`${PROVENANCE} is not in the tree at this commit: the lineage of this repository is not stated`);
  let j;
  try { j = JSON.parse(text); } catch { return unresolved(`${PROVENANCE} is not valid JSON at this commit: the lineage of this repository is not read`); }
  if (!plain(j) || typeof j.argoSourceCommit !== 'string' || !COMMIT.test(j.argoSourceCommit)) return unresolved(`${PROVENANCE} does not state argoSourceCommit as a commit id: the lineage of this repository is not read`);
  const all = plain(j.filteredCommits) ? Object.entries(j.filteredCommits) : [];
  const pairs = all.filter(([a, o]) => COMMIT.test(a) && typeof o === 'string' && COMMIT.test(o)).sort(([a], [b]) => (a < b ? -1 : 1));
  const unread = all.length - pairs.length, unknown = Object.keys(j).filter(k => !PROVENANCE_KEYS.includes(k)).sort();
  home.attributes.provenance = {file: PROVENANCE, schema: ['number', 'string'].includes(typeof j.schema) ? j.schema : null, filtered_commits: pairs.length,
    ...(unread ? {unread_pairs: unread} : {}), ...(unknown.length ? {uninterpreted_keys: bounded(unknown)} : {})};
  if (unread) home.missing.push(`${unread} entry(ies) of filteredCommits in ${PROVENANCE} are not a commit id naming a commit id and were not read`);
  drafts.push({entity: repositoryId(ARGO), ref: PROVENANCE, attributes: {name: ARGO, source_commit: j.argoSourceCommit, stated_by: PROVENANCE},
    missing_evidence: [`the lineage is what ${PROVENANCE} declares; it is not checked against the ARGO repository`]});
  drafts.push({type: 'derived-from', from: repositoryId(HOME), to: repositoryId(ARGO), ref: PROVENANCE, attributes: {basis: 'provenance record',
    argo_source_commit: j.argoSourceCommit, pantheon_source_commit: typeof j.pantheonSourceCommit === 'string' ? cut(j.pantheonSourceCommit, 80) : null, filtered_commits: pairs.length,
    included_paths: strings(j.includedPaths), excluded_paths: strings(j.excludedPaths), retained_in_argo: strings(j.retainedInArgo),
    extraction: typeof j.extraction === 'string' ? cut(j.extraction, 600) : null}});
  // Each pair, as two changes. Two ARGO commits may name one commit here: that commit is one entity, derived from both.
  const at = `${PROVENANCE}#filteredCommits`, here = new Map();
  for (const [a, o] of pairs) (here.get(o) ?? here.set(o, []).get(o)).push(a);
  for (const [a] of pairs) drafts.push({entity: siblingChangeId(ARGO, a), ref: at, attributes: {repository: ARGO, commit: a}});
  for (const [o, from] of [...here].sort(([a], [b]) => (a < b ? -1 : 1))) {
    drafts.push({entity: changeId(o), ref: at, attributes: {commit: o, filtered_from: from, in_ancestry: ancestry.has(o)}});
    for (const a of from) drafts.push({type: 'derived-from', from: changeId(o), to: siblingChangeId(ARGO, a), ref: at, attributes: {basis: 'filtered commit'}});
  }
}

// ---- (c) the workflows and package.json ------------------------------------------------------------------------------
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const KEY_LINE = /^\s*(?:-\s+)?([A-Za-z_][\w-]*):(?:\s+(.*))?$/;
const BLOCK_SCALAR = /^[|>][+-]?\d*[+-]?\s*(?:#.*)?$/;
const ACTION = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)@([^\s@]+)$/;
const scalar = v => { const q = /^(['"])(.*?)\1\s*(?:#.*)?$/.exec(v); return q ? q[2] : v.replace(/(?:^|\s+)#.*$/, '').trim(); };

/**
 * The `uses:` and `node-version:` lines of a workflow's text (see Limits in the header: not a YAML parser).
 * {uses: [{name, ref, line}], other_uses: [{value, line}], node_versions: [{version, line}], node_expressions: [{text, line}]}.
 */
export function workflowDeclarations(text) {
  const out = {uses: [], other_uses: [], node_versions: [], node_expressions: []};
  let block = null;                                             // the indentation of the key whose block scalar we are inside
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return;
    const indent = line.length - line.trimStart().length;
    if (block !== null) { if (indent > block) return; block = null; }
    const m = KEY_LINE.exec(line);
    if (!m) return;
    const rest = (m[2] ?? '').trim();
    if (BLOCK_SCALAR.test(rest)) { block = indent; return; }
    if (m[1] !== 'uses' && m[1] !== 'node-version') return;
    const value = scalar(rest);
    if (m[1] === 'uses') {
      if (!value) return;
      const a = ACTION.exec(value);
      if (a) out.uses.push({name: a[1], ref: a[2], line: i + 1}); else out.other_uses.push({value: cut(value, 200), line: i + 1});
    } else if (!value) out.node_expressions.push({text: '(a value on the following lines, not read)', line: i + 1});
    else if (value.includes('${{')) out.node_expressions.push({text: cut(value, 200), line: i + 1});
    else out.node_versions.push({version: cut(value, 80), line: i + 1});
  });
  return out;
}

function ciFacts({tree, read, drafts, home}) {
  const node = packageId('program', 'node'), stated = [], actions = new Map();
  const files = tree.entries.filter(e => WORKFLOW_FILE.test(e.path) && e.mode !== '120000').map(e => e.path);
  home.attributes.workflows = files.length;
  let nodeNamed = false;
  for (const file of files) {
    const d = workflowDeclarations(read(file).toString('utf8')), id = workflowId(file), byAction = new Map();
    for (const u of d.uses) (byAction.get(u.name) ?? byAction.set(u.name, []).get(u.name)).push(u);
    const others = uniq(d.other_uses.map(u => u.value)), expressions = uniq(d.node_expressions.map(x => x.text)), versions = uniq(d.node_versions.map(v => v.version));
    drafts.push({entity: id, ref: file, attributes: {file, uses: bounded(uniq(d.uses.map(u => `${u.name}@${u.ref}`))), node_versions: bounded(versions),
      ...(others.length ? {other_uses: bounded(others)} : {}), ...(expressions.length ? {node_expressions: bounded(expressions)} : {})},
      ...evidence([...(d.other_uses.length ? [`${d.other_uses.length} \`uses:\` value(s) are not owner/name@ref (a local or container action) and are listed, not resolved`] : []),
        ...(d.node_expressions.length ? [`${d.node_expressions.length} \`node-version:\` value(s) are expressions and are listed, not resolved`] : [])])});
    for (const [name, us] of [...byAction].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const seen = actions.get(name) ?? actions.set(name, {refs: new Set(), workflows: []}).get(name);
      for (const u of us) seen.refs.add(u.ref);
      seen.workflows.push(file);
      drafts.push({type: 'depends-on', from: id, to: packageId('action', name), ref: file, attributes: {basis: 'uses', refs: bounded(uniq(us.map(u => u.ref))), lines: bounded(us.map(u => u.line))}});
    }
    if (d.node_versions.length || d.node_expressions.length) {
      nodeNamed = true;
      for (const v of versions) stated.push({stated_by: file, version: v});
      drafts.push({type: 'depends-on', from: id, to: node, ref: file, attributes: {basis: 'node-version', versions: bounded(versions),
        lines: bounded([...d.node_versions, ...d.node_expressions].map(x => x.line).sort((a, b) => a - b)), ...(expressions.length ? {expressions: bounded(expressions)} : {})}});
    }
  }
  for (const [name, seen] of [...actions].sort(([a], [b]) => (a < b ? -1 : 1))) {
    drafts.push({entity: packageId('action', name), ref: WORKFLOWS, attributes: {ecosystem: 'action', name, refs: bounded([...seen.refs].sort()), workflows: bounded(seen.workflows)}});
  }
  // package.json: the Node range the package accepts.
  const pkg = read(PACKAGE);
  let engines = null;
  if (pkg) {
    try { const j = JSON.parse(pkg.toString('utf8')); if (typeof j?.engines?.node === 'string' && j.engines.node) engines = cut(j.engines.node, 80); }
    catch { home.missing.push(`${PACKAGE} is not valid JSON at this commit: engines.node is not read`); }
  }
  if (engines) {
    stated.push({stated_by: PACKAGE, version: engines});
    drafts.push({type: 'depends-on', from: fileId(PACKAGE), to: node, ref: PACKAGE, attributes: {basis: 'engines.node', version: engines}});
  }
  if (nodeNamed || engines) drafts.push({entity: node, ref: nodeNamed ? WORKFLOWS : PACKAGE, attributes: {ecosystem: 'program', name: 'node', versions: bounded(stated)}});
}

/** The facts of the three declarations at `commit`, as the extractor's drafts. */
export function pinsFacts(repo, commit) {
  const tree = treeAt(repo, commit), byPath = new Map(tree.entries.map(e => [e.path, e]));
  const has = p => byPath.has(p) && byPath.get(p).mode !== '120000';
  const read = p => (has(p) ? blobsAt(repo, [byPath.get(p).blob]).get(byPath.get(p).blob) : null);
  const textOf = p => read(p)?.toString('utf8') ?? null;
  const drafts = [], home = {attributes: {name: HOME}, missing: [], unresolved: false};
  pinFacts({text: textOf(GOVERNANCE), read, has, drafts, home});
  lineageFacts({text: textOf(PROVENANCE), ancestry: new Set(historyAt(repo, commit).map(c => c.commit)), drafts, home});
  ciFacts({tree, read, drafts, home});
  // The repository itself: what was read of it, and whether its lineage could be.
  drafts.push({entity: repositoryId(HOME), ref: PROVENANCE, ...(home.unresolved ? {status: 'unresolved'} : {}), attributes: home.attributes, ...evidence(home.missing)});
  // Entities first: a relationship is admitted only after both its endpoints are.
  return [...drafts.filter(d => d.entity), ...drafts.filter(d => !d.entity)];
}

/** The adapter: the declarations at the commit `ref` names now (readAt: that commit's objects). */
export function pinsSource({repo, ref = 'HEAD', extractor = EXTRACTOR} = {}) {
  return {
    id: SOURCE_ID, extractor, ref: GOVERNANCE,
    authority: `${GOVERNANCE} (the TELOS commit and digest pins), ${PROVENANCE} (the ARGO lineage record), the CI workflows and ${PACKAGE} engines, at a commit`,
    current: () => ({version: resolveCommit(repo, ref)}),
    readAt: version => pinsFacts(repo, version),
  };
}
