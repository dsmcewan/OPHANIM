// THE EXTRACTORS: deterministic readings of the authoritative sources, as graph assertions (docs/knowledge-graph/architecture.md).
//
// Purpose   Read one source as it is NOW and say what it states: {cursor, assertions}. project.mjs hands that to the
//           graph, which keeps the difference from the last reading.
// Inputs    The repository (files as they are on disk), the status ledger, the work ledger. Nothing else: no provider,
//           no model, no clock (a reading of the same bytes is the same reading).
// Outputs   Assertions that pass contract.mjs. Each names the file or ledger entry it was read from and its version.
// Invariants
//   - An extractor states what its source states and classes it by how it knows: a ledger entry or an owner-kept
//     record is authoritative; a file's content is observed; what is computed from content (an import edge, a path named
//     in prose) is derived. It never raises a status: a test that imports a module is recorded as importing it, an
//     assigned role as assigned. Whether something is QUALIFIED is said only where a record says so.
//   - It reads; it writes nothing and repairs nothing. A source that is absent yields no assertions and a cursor that
//     says it is absent (the projector records that visibly).
// Must never  Call a provider; follow text as instruction; infer an edge from a resemblance.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {idOf, recordAssertion} from './contract.mjs';

const sha = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
const EXTRACTOR = v => ({kind: 'extractor', name: `ophanim-graph/${v}`});
const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Every file of the repository that is tracked or new and not ignored, as it is on disk: [{path, bytes}] sorted. */
export function repoFiles(repo) {
  return execFileSync('git', ['-C', repo, 'ls-files', '-co', '--exclude-standard', '-z'], {encoding: 'utf8', maxBuffer: 1 << 28}).split('\0').filter(Boolean).sort()
    .filter(f => { try { return fs.lstatSync(path.join(repo, f)).isFile(); } catch { return false; } });
}

const IMPORT = /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"\n]+)['"]|(?:^|[\s;(])import\s*\(\s*['"]([^'"\n]+)['"]\s*\)|^\s*import\s+['"]([^'"\n]+)['"]/gm;
const EXPORT = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
const isCode = f => /\.(mjs|js|cjs)$/.test(f), isTest = f => /\.test\.mjs$/.test(f), isRunner = f => /\.mutate\.mjs$/.test(f);
const isSupport = f => /(^|\/)fixtures\/|test-fixtures\.mjs$|test-[\w-]+-child\.mjs$/.test(f);

/**
 * GRAPH B, the systems side: components, tests, the import edges between them, mutation targets and documents.
 * `paths` limits the reading to those files (a targeted update); the cursor is always of the whole tree.
 */
export async function readRepository({repo, instance, paths = null}) {
  const files = repoFiles(repo), known = new Set(files), assertions = [];
  const C = f => idOf(instance, 'systems', isTest(f) ? 'test' : 'component', f);
  const versions = new Map(files.map(f => [f, sha(fs.readFileSync(path.join(repo, f)))]));
  const want = paths ? files.filter(f => paths.includes(f)) : files;
  const A = (ref, a) => assertions.push({...a, source: {authority: 'repository', ref, version: versions.get(ref)}, origin: EXTRACTOR('repository/v1'), status: 'unverified'});
  for (const f of want) {
    if (/\.md$/.test(f) && f.startsWith('docs/')) {
      const text = fs.readFileSync(path.join(repo, f), 'utf8');
      A(f, {kind: 'entity', id: idOf(instance, 'evidence', 'source', f), attrs: {path: f, title: cut(/^#\s+(.+)$/m.exec(text)?.[1] ?? f, 160)}, class: 'observed'});
      continue;
    }
    if (!isCode(f) && !/\.py$/.test(f)) continue;
    const text = fs.readFileSync(path.join(repo, f), 'utf8');
    A(f, {kind: 'entity', id: C(f), class: 'observed', attrs: {path: f, kind: isTest(f) ? 'test' : isRunner(f) ? 'mutation-runner' : isSupport(f) ? 'test-support' : 'module', bytes: Buffer.byteLength(text),
      ...(isCode(f) ? {exports: [...text.matchAll(EXPORT)].map(m => m[1]).slice(0, 40)} : {})}});
    if (!isCode(f)) continue;
    const seen = new Set();
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec.startsWith('.')) continue;                    // a package: outside this repository's graph
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
      if (target === f || seen.has(target) || !(isCode(target) || /\.json$/.test(target))) continue;
      seen.add(target);
      if (/\.json$/.test(target)) continue;
      // A test that imports a module is RECORDED as verifying it on that basis only: importing is not passing.
      const rel = isTest(f) && known.has(target) && !isTest(target) && !isSupport(target) ? 'verifies' : 'depends-on';
      A(f, {kind: 'relation', rel, from: C(f), to: C(target), class: 'derived', attrs: {basis: 'import'}});
    }
  }
  // MUTATION TARGETS: a runner states which tests decide which line of which file. The statement is the runner's; a
  // result (killed, on which commit) is not in the repository and is not asserted. The runner is READ AS TEXT: a reading
  // never executes its source (importing one of these runners starts it).
  for (const f of want.filter(isRunner)) {
    const list = mutationTargets(fs.readFileSync(path.join(repo, f), 'utf8'));
    A(f, {kind: 'entity', id: idOf(instance, 'systems', 'component', f) , class: 'derived', attrs: {mutations_listed: list.listed, mutations_read: list.targets.filter(m => known.has(m.file)).length}});
    for (const m of list.targets) {
      const mid = idOf(instance, 'systems', 'mutation', `${f}#${m.id}`);
      if (!known.has(m.file)) continue;
      A(f, {kind: 'entity', id: mid, class: 'observed', attrs: {runner: f, id: m.id, what: cut(m.what, 240)}});
      A(f, {kind: 'relation', rel: 'verifies', from: mid, to: C(m.file), class: 'derived', attrs: {basis: 'mutation-target'}});
      for (const t of m.tests.filter(x => known.has(x) && isTest(x))) {
        A(f, {kind: 'relation', rel: 'verifies', from: C(t), to: C(m.file), class: 'derived', attrs: {basis: 'mutation-target', mutation: `${f}#${m.id}`}});
      }
    }
  }
  return {cursor: 'tree:' + sha(files.map(f => `${f}\u0000${versions.get(f)}`).join('\n')).slice(7, 39), assertions, refs: paths ? want : null, files: files.length};
}

/**
 * The mutation targets a runner's SOURCE TEXT lists: {listed, targets: [{id, what, file, tests}]}. Text only: constants
 * of the form NAME = 'path', a table `const T = {name: ['file', ...]}`, and entries `{id: '..', what: '..', file|path: ..,
 * tests: ..}`. An entry whose file this cannot resolve is counted in `listed` and left out of `targets`.
 */
export function mutationTargets(text) {
  const consts = new Map([...text.matchAll(/\b([A-Z][A-Z0-9_]*)\s*=\s*'([^'\n]+)'/g)].map(m => [m[1], m[2]]));
  // Lists of test files: `const T = {name: ['file']}`, and `const NAME = ['file', ...OTHER]`.
  const lists = new Map();
  const T = /const T = \{([\s\S]*?)\};/.exec(text)?.[1] ?? '';
  for (const m of T.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) lists.set(`T.${m[1]}`, [...m[2].matchAll(/'([^'\n]+)'/g)].map(x => x[1]));
  for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*\[([^\]\n]*)\]/g)) {
    lists.set(m[1], [...[...m[2].matchAll(/'([^'\n]+)'/g)].map(x => x[1]), ...[...m[2].matchAll(/\.\.\.([A-Z][A-Z0-9_]*)/g)].flatMap(x => lists.get(x[1]) ?? [])]);
  }
  const lit = v => (v === undefined ? null : v.startsWith("'") ? v.slice(1, -1) : consts.get(v) ?? null);
  const chunks = text.split(/\{\s*id:\s*'/).slice(1), targets = [];
  for (const c of chunks) {
    const id = /^([A-Za-z0-9_.-]+)'/.exec(c)?.[1];
    // `file:` names the target; `path:` is a label in some runners and is not read as one.
    const file = lit(/\bfile:\s*([A-Z][A-Z0-9_]*|'[^'\n]+')/.exec(c)?.[1]) ?? lit(/\bone\(\s*([A-Z][A-Z0-9_]*|'[^'\n]+')/.exec(c)?.[1]);
    const what = (/\bwhat:\s*'((?:[^'\\\n]|\\.)*)'/.exec(c)?.[1] ?? '').replace(/\\'/g, "'");
    const spec = /\btests:\s*(\[[^\]]*\]|T\.\w+|[A-Z][A-Z0-9_]*)/.exec(c)?.[1] ?? '';
    const named = [...[...spec.matchAll(/(T\.\w+|\b[A-Z][A-Z0-9_]*\b)/g)].flatMap(m => lists.get(m[1]) ?? []), ...[...spec.matchAll(/'([^'\n]+)'/g)].map(m => m[1])].filter(x => /\.test\.mjs$/.test(x));
    // A runner whose tests are name patterns of one suite states that suite once (SUITE).
    const tests = [...new Set(named.length ? named : (consts.has('SUITE') ? [consts.get('SUITE')] : []))];
    if (id && file) targets.push({id, what, file, tests});
  }
  return {listed: chunks.length, targets};
}

/** A path named in prose, resolved to one tracked file: exact, or the only file that ends with it. Else null. */
const resolver = files => { const set = new Set(files); return token => { if (set.has(token)) return token; if (!/[/.]/.test(token) || !/\.(mjs|js|py|json|md)$/.test(token)) return null; const hits = files.filter(f => f.endsWith('/' + token)); return hits.length === 1 ? hits[0] : null; }; };

/** GRAPH D, the limitations register: every `| L-nnn |` row, its status word, and the files its row names. */
export function readRegister({repo, instance, file = 'docs/OPEN-LIMITATIONS.md'}) {
  const abs = path.join(repo, file);
  if (!fs.existsSync(abs)) return {cursor: 'absent', assertions: [], absent: true};
  const text = fs.readFileSync(abs, 'utf8'), resolve = resolver(repoFiles(repo)), assertions = [];
  let section = null;
  for (const line of text.split('\n')) {
    const h = /^#{2,4}\s+(.+)$/.exec(line); if (h) { section = cut(h[1], 120); continue; }
    const m = /^\|\s*(L-\d{3})\s*\|(.*)\|\s*$/.exec(line); if (!m) continue;
    const cells = m[2].split('|').map(c => c.trim()), statusCell = cells.at(-1) ?? '';
    const word = /^\**\s*(open|planned|active|repaired|class covered|qualified|accepted by owner|pending owner|retained|decided|requirement)/i.exec(statusCell)?.[1]?.toLowerCase() ?? 'other';
    const lim = idOf(instance, 'learning', 'limitation', m[1]), ref = `${file}#${m[1]}`;
    const meta = {source: {authority: 'register', ref, version: sha(line)}, origin: EXTRACTOR('register/v1'), status: 'unverified'};
    assertions.push({kind: 'entity', id: lim, class: 'authoritative', attrs: {id: m[1], section, register_status: word, title: cut(/\*\*(.+?)\*\*/.exec(cells[0] ?? '')?.[1] ?? cells[0] ?? '', 240)}, ...meta});
    const named = new Set([...line.matchAll(/`([^`\s]+)`/g)].map(x => resolve(x[1].replace(/:\d+(-\d+)?$/, ''))).filter(Boolean));
    for (const f of [...named].sort()) if (/\.(mjs|js|py)$/.test(f)) assertions.push({kind: 'relation', rel: 'applies-to', from: lim, to: idOf(instance, 'systems', isTest(f) ? 'test' : 'component', f), class: 'derived', attrs: {basis: 'a path the entry names'}, ...meta});
  }
  return {cursor: sha(text), assertions};
}

/** GRAPH D, the lessons registry: failure classes, their recorded occurrences, and the tests said to detect them. */
export function readLessons({repo, instance, file = 'ophanim/lessons/corrections.json'}) {
  const abs = path.join(repo, file);
  if (!fs.existsSync(abs)) return {cursor: 'absent', assertions: [], absent: true};
  const raw = fs.readFileSync(abs), reg = JSON.parse(raw), files = repoFiles(repo), known = new Set(files), assertions = [];
  const meta = (ref, body) => ({source: {authority: 'lessons-registry', ref: `${file}#${ref}`, version: sha(JSON.stringify(body))}, origin: EXTRACTOR('lessons/v1'), status: 'unverified'});
  for (const c of reg.classes ?? []) {
    const fc = idOf(instance, 'learning', 'failure-class', c.id);
    assertions.push({kind: 'entity', id: fc, class: 'authoritative', attrs: {id: c.id, class: cut(c.class, 300), fixed_in: c.fixed_in ?? null, detector: c.detector?.kind ?? 'none'}, ...meta(c.id, {...c, instances: undefined})});
    if (c.detector?.kind === 'test' && known.has(c.detector.file)) {
      assertions.push({kind: 'relation', rel: 'detects', from: idOf(instance, 'systems', 'test', c.detector.file), to: fc, class: 'authoritative', attrs: {test: cut(c.detector.name, 200), basis: 'the registry names this test as the detector'}, ...meta(`${c.id}/detector`, c.detector)});
    }
    for (const [i, x] of (c.instances ?? []).entries()) {
      const d = idOf(instance, 'learning', 'defect', `${c.id}#${i + 1}`), m = meta(`${c.id}/${i + 1}`, x);
      assertions.push({kind: 'entity', id: d, class: 'authoritative', attrs: {observed_by: x.observed_by ?? null, date: x.date ?? null, ref: cut(x.ref ?? '', 120), corrected_by: x.corrected_by ?? null, note: cut(x.note ?? '', 300)}, ...m});
      assertions.push({kind: 'relation', rel: 'instance-of', from: d, to: fc, class: 'authoritative', ...m});
      // A recurrence check is prose. The test files it names are read out of it and recorded as that: named in prose.
      const prose = String(x.recurrence_check ?? ''), named = new Set([...prose.matchAll(/([\w./-]+\.test\.mjs)/g)].map(y => y[1]).filter(f => known.has(f)));
      for (const f of [...named].sort()) assertions.push({kind: 'relation', rel: 'detects', from: idOf(instance, 'systems', 'test', f), to: d, class: 'derived', attrs: {basis: 'named in the occurrence\'s recurrence check'}, ...m});
    }
  }
  return {cursor: sha(raw), assertions};
}

const readJson = (repo, f) => { const abs = path.join(repo, f); if (!fs.existsSync(abs)) return null; const raw = fs.readFileSync(abs); return {body: JSON.parse(raw), version: sha(raw), file: f}; };
const CONFIG = 'pantheon/src/config';

/**
 * GRAPH A: labs, models, runtimes, and the EXECUTABLE a model is in a runtime, with what the configuration states
 * about each and on what basis. A model and its runtime are two things: `google/gemini-4-carbon` runs in `agy-cli`
 * and in `antigravity-sdk`, and each pairing has its own limits and its own assigned roles.
 */
export function readCapabilities({repo, instance}) {
  const models = readJson(repo, `${CONFIG}/models.json`), facts = readJson(repo, `${CONFIG}/capability-facts.json`), lanes = readJson(repo, `${CONFIG}/lanes.json`),
    ident = readJson(repo, `${CONFIG}/model-identity.json`), sdk = readJson(repo, `${CONFIG}/antigravity-sdk.json`);
  const present = [models, facts, lanes, ident, sdk].filter(Boolean);
  if (!models) return {cursor: 'absent', assertions: [], absent: true};
  const assertions = [], E = (type, key) => idOf(instance, 'capability', type, key);
  const from = j => ({source: {authority: 'config', ref: j.file, version: j.version}, origin: EXTRACTOR('capability/v1'), status: 'unverified'});
  const ent = (j, type, key, attrs, cls = 'observed') => assertions.push({kind: 'entity', id: E(type, key), attrs, class: cls, ...from(j)});
  const rel = (j, r, a, b, attrs = undefined, cls = 'observed') => assertions.push({kind: 'relation', rel: r, from: a, to: b, ...(attrs ? {attrs} : {}), class: cls, ...from(j)});
  const routeLabs = ident?.body.route_labs ?? {}, modelLab = ident?.body.model_lab ?? {};
  const labOfVendor = v => (routeLabs[v]?.length === 1 ? routeLabs[v][0] : v);
  const labOf = (vendor, model) => modelLab[model] ?? labOfVendor(vendor);
  const labs = new Set(), declared = new Set();
  const model = (j, lab, mid, attrs) => { labs.add(lab); const key = `${lab}/${mid}`; if (!declared.has(`${j.file}|${key}`)) { declared.add(`${j.file}|${key}`); ent(j, 'model', key, attrs); rel(j, 'member-of', E('model', key), E('lab', lab)); } return E('model', key); };
  // The basis of a fact is what the configuration says it is: a vendor page it quotes, the owner's statement, or nothing.
  const basisOf = f => { const s = [f?.window?.source, f?.output?.source, f?.efforts?.source].filter(Boolean); return !s.length ? 'unrecorded' : s.every(x => /^https?:/.test(x)) ? 'documented' : s.some(x => /^https?:/.test(x)) ? 'documented and owner-stated' : 'owner-stated'; };
  const val = x => (x && typeof x === 'object' && 'value' in x ? x.value : null);

  // RUNTIMES. What authenticates each is stated only where the configuration states it.
  ent(models, 'runtime', 'api', {transport: 'api', what: 'the vendor\'s HTTPS API through packages/model-client', auth: 'UNRECORDED in configuration (a key per vendor; see pantheon/src/sdk/adapter.mjs)'});
  if (lanes) ent(lanes, 'runtime', 'agy-cli', {transport: 'agy-cli', what: 'the Antigravity CLI lane', auth: 'the cached Antigravity login (a subscription)'});
  if (sdk) {
    const s = sdk.body;
    ent(sdk, 'runtime', s.transport, {transport: s.transport, what: `${s.sdk?.distribution} ${s.sdk?.version}`, auth: s.api?.key_env ?? null, sdk_version: s.sdk?.version ?? null, max_subagent_depth: s.subagents?.max_depth ?? null});
    ent(sdk, 'feature', 'native-subagent-delegation', {what: 'a session may start subagents of a declared type on a declared model', max_depth: s.subagents?.max_depth ?? null});
    rel(sdk, 'provides', E('runtime', s.transport), E('feature', 'native-subagent-delegation'), {basis: 'observed on the installed SDK (see the contract suite)'});
    ent(sdk, 'feature', 'read-only-research-session', {what: 'a session bound read-only, with read tools only'});
    rel(sdk, 'provides', E('runtime', s.transport), E('feature', 'read-only-research-session'));
  }
  // MODELS of the registry, each with its API executable.
  for (const [vendor, table] of Object.entries(models.body)) {
    for (const mid of [...new Set(Object.values(table))].sort()) {
      const f = facts?.body.models?.[mid] ?? null, lab = labOf(vendor, mid);
      const m = model(models, lab, mid, {id: mid, vendor});
      if (f) ent(facts, 'model', `${lab}/${mid}`, {window: val(f.window), output: val(f.output), efforts: f.efforts?.values ?? null, default_effort: f.efforts?.default ?? null, api_id: f.api_id ?? null, lifecycle: cut(String(f.status ?? ''), 80), basis: basisOf(f)});
      const x = E('executable', `api/${vendor}/${mid}`);
      ent(models, 'executable', `api/${vendor}/${mid}`, {model: mid, runtime: 'api', vendor});
      rel(models, 'member-of', x, m); rel(models, 'member-of', x, E('runtime', 'api')); rel(models, 'runs-in', m, E('runtime', 'api'));
    }
  }
  // LANES: a model at a thinking level, in the CLI runtime.
  for (const [lane, l] of Object.entries(lanes?.body.agy_cli ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const baseModel = l.base ?? lane, m = model(lanes, l.lab, baseModel, {id: baseModel, vendor: l.vendor});
    const x = E('executable', `agy-cli/${lane}`);
    ent(lanes, 'executable', `agy-cli/${lane}`, {model: baseModel, runtime: 'agy-cli', lane, thinking: l.thinking ?? null, window: val(l.window), retired: l.retired ?? null, available: l.retired ? false : null, basis: cut(String(l.basis ?? ''), 160)});
    rel(lanes, 'member-of', x, m); rel(lanes, 'member-of', x, E('runtime', 'agy-cli')); rel(lanes, 'runs-in', m, E('runtime', 'agy-cli'));
  }
  // THE SDK: executables, delegation limits, and the roles the owner assigned, each recorded as assigned.
  if (sdk) {
    const s = sdk.body, rt = E('runtime', s.transport), X = mid => E('executable', `${s.transport}/${mid}`);
    for (const [mid, m] of Object.entries(s.models ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const mm = model(sdk, labOf(s.vendor, mid) === s.vendor ? s.lab : labOf(s.vendor, mid), mid, {id: mid, vendor: s.vendor});
      ent(sdk, 'executable', `${s.transport}/${mid}`, {model: mid, runtime: s.transport, thinking: m.thinking ?? [], facts: cut(String(m.facts ?? ''), 120), subagent_ceiling: s.subagents?.ceilings?.[mid] ?? s.subagents?.default_ceiling ?? 0});
      rel(sdk, 'member-of', X(mid), mm); rel(sdk, 'member-of', X(mid), rt); rel(sdk, 'runs-in', mm, rt);
      if ((s.subagents?.ceilings?.[mid] ?? 0) > 0) rel(sdk, 'provides', X(mid), E('feature', 'native-subagent-delegation'), {ceiling: s.subagents.ceilings[mid], subagent_model: s.subagents.model, basis: 'owner-assigned ceiling'}, 'authoritative');
    }
    const role = (name, what) => ent(sdk, 'role', name, {role: name, what}, 'authoritative');
    const assign = (mid, r, attrs) => { if (s.models?.[mid]) rel(sdk, 'qualified-for', X(mid), E('role', r), {basis: 'owner-assigned', measured: false, ...attrs}, 'authoritative'); };
    role('implementer', 'writes a work unit');
    for (const [difficulty, ladder] of Object.entries(s.ladders ?? {})) for (const [i, c] of ladder.entries()) assign(c.model, 'implementer', {difficulty, order: i + 1, effort: c.effort ?? null});
    for (const [r, def] of Object.entries(s.research?.roles ?? {})) { role(r, cut(def.charter ?? '', 200)); for (const [i, c] of (def.candidates ?? []).entries()) assign(c.model, r, {order: i + 1, effort: c.effort ?? null}); }
    if (s.research?.subordinate) { role('research-specialist', 'a bounded question under a research coordinator; does not delegate'); assign(s.research.subordinate.model, 'research-specialist', {order: 1, effort: s.research.subordinate.effort ?? null}); }
    if (s.subagents?.model) { role('subagent', 'an implementer\'s native specialist'); assign(s.subagents.model, 'subagent', {order: 1}); }
  }
  for (const lab of [...labs].sort()) ent(models, 'lab', lab, {lab, what: 'an independent laboratory: reviewers are counted by lab, not by model'}, 'authoritative');
  return {cursor: sha(present.map(j => `${j.file}\u0000${j.version}`).join('\n')), assertions};
}

/** GRAPH E (and C), the status ledger: every item, its state and requirement, what it depends on, and its prompt. */
export function readStatus({repo, instance, board}) {
  const assertions = [], I = k => idOf(instance, 'work', 'item', k);
  const meta = it => ({source: {authority: 'status-ledger', ref: `item:${it.item}`, version: it.entry}, origin: EXTRACTOR('status/v1'), class: 'authoritative', status: 'unverified'});
  for (const it of [...board.items].sort((a, b) => (a.item < b.item ? -1 : 1))) {
    assertions.push({kind: 'entity', id: I(it.item), attrs: {item: it.item, state: it.state, title: cut(it.title ?? '', 200), waiting_on: it.waiting_on ?? null, owner_role: it.owner_role ?? null, checked: it.checked ?? null}, ...meta(it)});
    for (const d of it.depends_on ?? []) assertions.push({kind: 'relation', rel: 'depends-on', from: I(it.item), to: I(d), ...meta(it)});
    const promptFile = path.join(repo, 'intake', 'prompts', `${it.item}.json`);
    if (/^prompt-/.test(it.item) && fs.existsSync(promptFile)) {
      const raw = fs.readFileSync(promptFile), P = idOf(instance, 'work', 'prompt', it.item);
      assertions.push({kind: 'entity', id: P, attrs: {item: it.item, bytes: raw.length}, source: {authority: 'repository', ref: `intake/prompts/${it.item}.json`, version: sha(raw)}, origin: EXTRACTOR('status/v1'), class: 'observed', status: 'unverified'});
      assertions.push({kind: 'relation', rel: 'derived-from', from: I(it.item), to: P, ...meta(it)});
    }
  }
  return {cursor: board.head ?? 'empty', assertions};
}

/**
 * GRAPH E and C, the work ledger: stages, plans, work units, what a plan cited at which version, who contributed, what
 * was billed, and every graph record the controller admitted, observed or took as a proposal (work.graph).
 */
export function readWork({repo, instance, work}) {
  if (!work) return {cursor: 'absent', assertions: [], absent: true};
  const v = work.verify();
  if (!v.ok) return {cursor: 'unverified', assertions: [], unverified: v.why};
  const assertions = [], files = new Set(repoFiles(repo));
  const W = (type, key) => idOf(instance, 'work', type, key), I = k => W('item', k);
  const meta = hash => ({source: {authority: 'work-ledger', ref: `entry:${hash}`, version: hash}, origin: EXTRACTOR('work/v1'), class: 'authoritative', status: 'unverified'});
  const billed = new Map();
  for (const b of work.billings()) billed.set(b.item, {...(billed.get(b.item) ?? {}), [b.kind]: ((billed.get(b.item) ?? {})[b.kind] ?? 0) + 1, last: b.hash});
  for (const s of work.stages()) {
    const item = s.identity.item, S = W('stage', s.hash), m = meta(s.hash);
    assertions.push({kind: 'entity', id: S, attrs: {item, stage: s.stage, status: s.status, attempt: s.attempt ?? null, at: s.at ?? null, requirement: s.identity.requirement ?? null}, ...m});
    assertions.push({kind: 'relation', rel: 'part-of', from: S, to: I(item), ...m});
    if (s.handoff?.from) assertions.push({kind: 'relation', rel: 'derived-from', from: S, to: W('stage', s.handoff.from), ...m});
    // WHO TOOK PART: each model, with the lab it belongs to. A subagent of a Google model is a Google contributor.
    for (const c of s.contributions ?? []) if (c.vendor && c.model) {
      const lab = c.lab ?? c.vendor, mid = idOf(instance, 'capability', 'model', `${lab}/${c.served_model ?? c.model}`);
      assertions.push({kind: 'relation', rel: 'contributed-to', from: mid, to: S, attrs: {purpose: c.purpose ?? c.kind ?? null, lab, requested: c.model}, ...m});
    }
    if (s.stage === 'plan' && s.outputs?.plan_digest) {
      const P = W('plan', `${item}@${String(s.outputs.plan_digest).replace(/^sha256:/, '').slice(0, 16)}`);
      assertions.push({kind: 'entity', id: P, attrs: {item, plan_digest: s.outputs.plan_digest, status: s.status, difficulty: s.outputs.plan?.difficulty ?? null}, ...m});
      assertions.push({kind: 'relation', rel: 'produces', from: S, to: P, ...m}, {kind: 'relation', rel: 'part-of', from: P, to: I(item), ...m});
      // WHAT THE PLAN RESTS ON, at the version it was read: a later version of the file reaches the plan (query.mjs impact).
      for (const e of s.outputs.evidence ?? []) if (typeof e.ref === 'string' && files.has(e.ref)) {
        assertions.push({kind: 'relation', rel: 'cited-by', from: idOf(instance, 'systems', /\.test\.mjs$/.test(e.ref) ? 'test' : 'component', e.ref), to: P, attrs: {cited_version: e.sha256 ?? e.version ?? null, why: cut(e.why ?? '', 160)}, ...m});
      }
      for (const u of s.outputs.plan?.work_units ?? []) {
        const U = W('unit', `${item}/${u.unit_id}`);
        assertions.push({kind: 'entity', id: U, attrs: {item, unit_id: u.unit_id, difficulty: u.difficulty ?? null, owned_paths: u.owned_paths ?? [], verify_cmd: cut(u.verify_cmd ?? '', 160)}, ...m});
        assertions.push({kind: 'relation', rel: 'part-of', from: U, to: P, ...m});
        for (const d of u.depends_on ?? []) assertions.push({kind: 'relation', rel: 'depends-on', from: U, to: W('unit', `${item}/${d}`), ...m});
        for (const p of u.owned_paths ?? []) if (files.has(p)) assertions.push({kind: 'relation', rel: 'modifies', from: U, to: idOf(instance, 'systems', 'component', p), ...m});
      }
    }
  }
  for (const [item, b] of [...billed.entries()].sort()) { const {last, ...counts} = b; assertions.push({kind: 'entity', id: W('budget', item), attrs: {item, billed_requests: counts}, ...meta(last)}); assertions.push({kind: 'relation', rel: 'part-of', from: W('budget', item), to: I(item), ...meta(last)}); }
  // GRAPH RECORDS: what the controller admitted or observed, and what was proposed. Withdrawn ones are left out; the
  // ledger keeps them, and the graph's own history keeps what they said while they stood.
  // The `work.graph` kind is a sketch that was never committed (docs/knowledge-graph/pr70-work-graph-kind.patch): a work
  // ledger without it has no such records.
  for (const g of (work.graphs?.({live: true}) ?? []).filter(x => x.instance === instance)) assertions.push(recordAssertion(g, g.hash));
  return {cursor: v.head ?? 'empty', assertions};
}
