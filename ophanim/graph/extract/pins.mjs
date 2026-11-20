// PINNED EXTERNAL SOURCES AT A COMMIT as a graph source (Slice B2, KD2-1, KD2-6; docs/knowledge-graph/slice-b2.md).
//
// Purpose   What OPHANIM DECLARES it is built on and runs on, outside itself, read at a commit from git's object store:
//             the TELOS pin of ophanim/governance.mjs (its pinned commit and the digests of the TELOS files it checks),
//               and the digests of its own verifiers it pins (each compared with the file's bytes at the commit);
//             PROVENANCE.json: the declared lineage (the source repositories and commits the tree was extracted from);
//             the CI workflows: each action a step uses (a repository at its ref), the runner a job runs on, the Node
//               version setup-node installs, a repository a step checks out at a pinned commit, and the variables a
//               step sets from a secret or a repository variable (by NAME only: never a value);
//             the Node version each package.json declares (`engines`).
//           A DECLARED basis: each fact is what a committed file states. A ref that is a tag or a branch is recorded as
//           such (mutable), never as a version.
// Inputs    The repository root and a commit.
// Facts     systems/repository/telos (its pinned commit); systems/<type>/telos:<path> (a pinned TELOS file and its
//           sha256); systems/repository/<host>/<owner>/<name> (an action or a checked-out repository);
//           systems/repository/argo, systems/repository/pantheon (PROVENANCE.json's sources); systems/deployment/
//           github-actions/<runner>; capability/runtime/node; systems/environment-variable/<NAME>.
//           depends-on: governance.mjs -> the TELOS repository, each pinned TELOS file, each pinned local verifier;
//           a workflow -> each action, its runner, the Node runtime (with its version), a checked-out repository;
//           a package.json -> the Node runtime (its engines range). derived-from: a pinned TELOS file -> TELOS; the
//           repository -> each PROVENANCE.json source (with its commit); a filtered commit -> its source commit.
//           produces: a workflow -> a variable a step sets (from a secret or a repository variable, by name).
// Must never  Read the TELOS checkout, a secret, an environment value or the working tree; take a tag for a version.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {entityId} from '../../../packages/graph/index.mjs';
import {treeAt, blobsAt, resolveCommit, COMMIT} from './git.mjs';
import {fileId, typeOf, changeId} from './repo.mjs';
import {workflowId} from './verification.mjs';
import {repositoryId, runtimeId, envId} from './code.mjs';
import {keyLine} from './packages.mjs';

export const PINS_SOURCE = 'ophanim.pins';
export const PINS_EXTRACTOR = 'ophanim.pins.extractor';
export const PINS_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [PINS_SOURCE]});
/** The file that pins TELOS (KD2-6). */
export const GOVERNANCE = 'ophanim/governance.mjs';
export const PROVENANCE = 'PROVENANCE.json';
export const telosFileId = rel => entityId({domain: 'systems', type: typeOf(rel), key: `telos:${rel}`});
export const runnerId = label => entityId({domain: 'systems', type: 'deployment', key: `github-actions/${label}`});
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** The pins of governance.mjs's text: {commit: {value, line} | null, tables: [{name, line, entries: [{rel, sha, line}], root}]}. */
export function governancePins(text) {
  const c = /^export\s+const\s+TELOS_COMMIT\s*=\s*'([0-9a-f]{40})'/m.exec(text);
  const tables = [];
  for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*Object\.freeze\(\{([^}]*)\}\)/g)) {
    const entries = [...m[2].matchAll(/'([^'\n]+)'\s*:\s*'([0-9a-f]{64})'/g)].map(e => ({rel: e[1], sha: e[2], line: lineOf(text, m.index + m[0].indexOf(e[0]))}));
    if (!entries.length) continue;
    // WHERE the code reads each table's files: `Object.entries(NAME)) if (rawHash(regular(path.join(ROOT, rel))) !== sha)`.
    const use = new RegExp(`Object\\.entries\\(${m[1]}\\)\\)\\s*if\\s*\\(rawHash\\(regular\\(path\\.join\\(([^)]*?),\\s*rel\\)\\)\\)\\s*!==\\s*sha\\)`).exec(text);
    const args = use?.[1].trim() ?? null, local = args && /^HERE\s*,\s*'([^'\n]+)'$/.exec(args);
    tables.push({name: m[1], line: lineOf(text, m.index), entries,
      root: args === 'telosRoot' ? {kind: 'telos'} : local ? {kind: 'local', dir: path.posix.join(path.posix.dirname(GOVERNANCE), local[1])} : {kind: 'unknown', args}});
  }
  return {commit: c ? {value: c[1], line: lineOf(text, c.index)} : null, tables};
}

/** A workflow's declarations, line by line: uses, runs-on, setup-node's node-version, env set from secrets or vars, a pinned checkout. */
export function workflowDeclarations(text) {
  const lines = text.split('\n'), uses = [], runners = [], nodes = [], envs = [], checkouts = [];
  let clone = null;
  lines.forEach((l, i) => {
    const line = i + 1;
    const u = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s#]+)['"]?/.exec(l);
    if (u) uses.push({uses: u[1], line});
    const r = /^\s*runs-on:\s*['"]?([^'"\s#]+)['"]?/.exec(l);
    if (r) runners.push({label: r[1], line});
    const nv = /^\s*node-version:\s*['"]?([^'"\s#]+)['"]?/.exec(l);
    if (nv) nodes.push({version: nv[1], line});
    const ev = /^\s*([A-Z_][A-Z0-9_]*):\s*\$\{\{\s*(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/.exec(l);
    if (ev) envs.push({name: ev[1], from: `${ev[2]}.${ev[3]}`, line});
    const cl = /\bgit\s+clone\b.*?\b(https:\/\/[^\s"']+?)(?:\.git)?["']?(?:\s|$)/.exec(l);
    if (cl) clone = {url: cl[1], line};
    const co = /\bgit\b.*\bcheckout\b.*\b([0-9a-f]{40})\b/.exec(l);
    if (co && clone) checkouts.push({url: clone.url, commit: co[1], line, clone_line: clone.line});
  });
  return {uses, runners, nodes, envs, checkouts};
}
const repoOfUrl = url => { const m = /^https:\/\/([^/]+)\/(.+)$/.exec(url); return m ? {host: m[1].toLowerCase(), name: m[2].replace(/\.git$/, '')} : null; };

/** The facts of the pinned external sources at `commit` (declared). */
export function pinsFacts(repo, commit) {
  const tree = treeAt(repo, commit), paths = new Set(tree.entries.map(e => e.path)), drafts = [];
  const blob = p => tree.entries.find(e => e.path === p);
  const workflows = tree.entries.filter(e => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(e.path));
  const manifests = tree.entries.filter(e => /(^|\/)package\.json$/.test(e.path) && !/node_modules\//.test(e.path));
  const want = [GOVERNANCE, PROVENANCE].map(blob).filter(Boolean);
  const bytes = blobsAt(repo, [...want, ...workflows, ...manifests].map(e => e.blob));
  const textOf = e => bytes.get(e.blob).toString('utf8');
  const repos = new Map(), addRepo = (id, attributes) => { if (!repos.has(id)) repos.set(id, attributes); };
  let runtime = false;
  // TELOS and the local verifiers, as governance.mjs pins them.
  const gov = blob(GOVERNANCE);
  if (gov) {
    const text = textOf(gov), pins = governancePins(text), telos = repositoryId('telos');
    const local = tree.entries.filter(e => pins.tables.some(t => t.root.kind === 'local' && t.entries.some(x => path.posix.join(t.root.dir, x.rel) === e.path)));
    const localBytes = blobsAt(repo, local.map(e => e.blob));
    if (pins.commit) {
      addRepo(telos, {name: 'telos', commit: pins.commit.value, pinned_in: GOVERNANCE, line: pins.commit.line, named_by: 'TELOS_COMMIT'});
      drafts.push({type: 'depends-on', from: fileId(GOVERNANCE), to: telos, ref: GOVERNANCE, attributes: {basis: 'the module pins this repository at a commit', commit: pins.commit.value, line: pins.commit.line}});
    }
    const pinGaps = [];
    for (const t of pins.tables) for (const x of t.entries) {
      if (t.root.kind === 'telos' && pins.commit) {
        const id = telosFileId(x.rel);
        drafts.push({entity: id, ref: GOVERNANCE, attributes: {repository: 'telos', path: x.rel, commit: pins.commit.value, sha256: x.sha}});
        drafts.push({type: 'derived-from', from: id, to: telos, ref: GOVERNANCE, attributes: {basis: 'a file of the pinned TELOS commit', commit: pins.commit.value}});
        drafts.push({type: 'depends-on', from: fileId(GOVERNANCE), to: id, ref: GOVERNANCE, attributes: {basis: 'the module pins this file\'s sha256 and refuses another', table: t.name, sha256: x.sha, line: x.line}});
      } else if (t.root.kind === 'local') {
        const p = path.posix.join(t.root.dir, x.rel), e = local.find(y => y.path === p);
        if (!e) { pinGaps.push({table: t.name, path: p, line: x.line, why: 'pinned, but not a file of the tree at this commit'}); continue; }
        drafts.push({type: 'depends-on', from: fileId(GOVERNANCE), to: fileId(p), ref: GOVERNANCE, attributes: {basis: 'the module pins this file\'s sha256 and refuses another', table: t.name, sha256: x.sha,
          matches: sha256(localBytes.get(e.blob)) === x.sha, line: x.line}});
      } else pinGaps.push({table: t.name, path: x.rel, line: x.line, why: `the reader of this table is not recognized (${String(t.root.args ?? 'no TELOS commit').slice(0, 80)})`});
    }
    if (pinGaps.length) drafts.push({entity: fileId(GOVERNANCE), ref: GOVERNANCE, attributes: {pin_gaps: pinGaps.slice(0, 16)}, missing_evidence: [`${pinGaps.length} pinned file(s) not resolved here`]});
  }
  // PROVENANCE.json: the declared lineage.
  const prov = blob(PROVENANCE);
  if (prov) {
    const text = textOf(prov);
    let j = null;
    try { j = JSON.parse(text); } catch {}
    if (j) {
      const self = repositoryId('ophanim');
      addRepo(self, {name: 'ophanim'});
      for (const [field, name] of [['argoSourceCommit', 'argo'], ['pantheonSourceCommit', 'pantheon']]) {
        if (typeof j[field] !== 'string' || !COMMIT.test(j[field])) continue;
        addRepo(repositoryId(name), {name, commit: j[field], declared_in: PROVENANCE, line: keyLine(text, field)});
        drafts.push({type: 'derived-from', from: self, to: repositoryId(name), ref: PROVENANCE, attributes: {basis: 'PROVENANCE.json declares this source of the tree', field, source_commit: j[field], line: keyLine(text, field),
          included_paths: j.includedPaths ?? [], excluded_paths: j.excludedPaths ?? [], retained_in_argo: j.retainedInArgo ?? [], extraction: typeof j.extraction === 'string' ? j.extraction : null}});
      }
      const from = keyLine(text, 'filteredCommits') ?? 1, changes = new Set();
      for (const [src, out] of Object.entries(j.filteredCommits ?? {}).sort()) {
        if (!COMMIT.test(src) || !COMMIT.test(out)) continue;
        for (const c of [src, out]) if (!changes.has(c)) { changes.add(c); drafts.push({entity: changeId(c), ref: PROVENANCE, attributes: {commit: c, declared_by: PROVENANCE}}); }
        drafts.push({type: 'derived-from', from: changeId(out), to: changeId(src), ref: PROVENANCE, attributes: {basis: 'PROVENANCE.json maps the source commit to the filtered commit', line: keyLine(text, src, from),
          source_repository: [j.argoSourceCommit === src ? 'argo' : null, j.pantheonSourceCommit === src ? 'pantheon' : null].filter(Boolean)[0] ?? null}});
      }
    }
  }
  // The workflows: actions, runners, the Node version, checked-out repositories, variables set from secrets.
  const runnersSeen = new Set(), vars = new Set();
  for (const w of workflows) {
    const text = textOf(w), d = workflowDeclarations(text), wf = workflowId(w.path);
    drafts.push({entity: wf, ref: w.path, attributes: {file: w.path}});
    const rows = new Map(), add = (to, attrs, line) => { const r = rows.get(to) ?? rows.set(to, {to, lines: [], items: []}).get(to); r.lines.push(line); r.items.push(attrs); };
    for (const u of d.uses) {
      const [name, ref = null] = u.uses.split('@');
      if (name.startsWith('docker://')) continue;
      if (name.startsWith('./')) {
        const p = name.slice(2).replace(/\/$/, ''), f = [`${p}/action.yml`, `${p}/action.yaml`, p].find(x => paths.has(x));
        if (f) add(fileId(f), {uses: u.uses}, u.line);
        continue;
      }
      const id = repositoryId(`github.com/${name}`);
      addRepo(id, {name, host: 'github.com', kind: 'a GitHub Action'});
      add(id, {uses: u.uses, ref, ref_kind: ref && COMMIT.test(ref) ? 'commit' : 'a tag or branch: mutable, not a version'}, u.line);
    }
    for (const r of d.runners) { runnersSeen.add(r.label); add(runnerId(r.label), {runs_on: r.label}, r.line); }
    for (const n of d.nodes) { runtime = true; add(runtimeId('node'), {version: n.version, via: 'actions/setup-node node-version'}, n.line); }
    for (const c of d.checkouts) {
      const at = repoOfUrl(c.url);
      if (!at) continue;
      const id = repositoryId(`${at.host}/${at.name}`);
      addRepo(id, {name: at.name, host: at.host, kind: 'a repository a step checks out'});
      add(id, {checkout: c.commit, url: c.url, clone_line: c.clone_line}, c.line);
    }
    for (const [to, r] of [...rows].sort((a, b) => byString(a[0], b[0]))) {
      drafts.push({type: 'depends-on', from: wf, to, ref: w.path, attributes: {basis: 'the workflow declares it', declarations: r.items, lines: [...new Set(r.lines)].sort((a, b) => a - b)}});
    }
    const produced = new Map();
    for (const e of d.envs) { vars.add(e.name); const p = produced.get(e.name) ?? produced.set(e.name, {froms: new Set(), lines: []}).get(e.name); p.froms.add(e.from); p.lines.push(e.line); }
    for (const [name, p] of [...produced].sort()) drafts.push({type: 'produces', from: wf, to: envId(name), ref: w.path,
      attributes: {basis: 'a step sets this variable from a secret or a repository variable, by name (never its value)', from: [...p.froms].sort(), lines: p.lines}});
  }
  for (const label of [...runnersSeen].sort()) drafts.push({entity: runnerId(label), ref: '.github/workflows', attributes: {runner: label, platform: 'GitHub Actions'}});
  for (const v of [...vars].sort()) drafts.push({entity: envId(v), ref: '.github/workflows', attributes: {name: v}});
  // The Node version each package.json declares.
  for (const m of manifests) {
    let j = null;
    const text = textOf(m);
    try { j = JSON.parse(text); } catch { continue; }
    if (typeof j?.engines?.node !== 'string') continue;
    runtime = true;
    drafts.push({type: 'depends-on', from: fileId(m.path), to: runtimeId('node'), ref: m.path, attributes: {basis: 'the package declares the Node versions it runs on (engines)', engines: j.engines.node, line: keyLine(text, 'node', keyLine(text, 'engines') ?? 1)}});
  }
  if (runtime) drafts.push({entity: runtimeId('node'), ref: 'engines and setup-node', attributes: {name: 'node'}});
  for (const [id, attributes] of [...repos].sort((a, b) => byString(a[0], b[0]))) drafts.push({entity: id, ref: attributes.pinned_in ?? attributes.declared_in ?? '.github/workflows', attributes});
  return drafts;
}

/** The adapter of the pinned external sources at the commit `ref` names now. */
export function pinsSource({repo, ref = 'HEAD', extractor = PINS_EXTRACTOR} = {}) {
  return {id: PINS_SOURCE, extractor, ref: GOVERNANCE,
    authority: 'what committed files declare of the sources they pin (governance.mjs, PROVENANCE.json, workflows, engines)',
    current: () => ({version: resolveCommit(repo, ref)}), readAt: version => pinsFacts(repo, version)};
}
