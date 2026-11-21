#!/usr/bin/env node
// MUTATION RUNNER for the opt-in dependency sources of the knowledge graph (ophanim/graph/deps/: the calls between this
// repository's functions, the runtime's record and the sibling repositories, their readers, measures and questions).
// Modelled on ophanim/graph/graph-b.mutate.mjs (itself modelled on packages/graph/tests/graph.mutate.mjs). Every
// mutation re-introduces a plausible regression of a property a module of ophanim/graph/deps/ states in its header
// ("Must never ...", its invariants) -- the default open gaining a dependency source, a source without its
// extractorVersion, a sibling read at its checkout's head instead of the commit this repository pins, a source observed
// before one it refers to, a sibling's file written under this repository's ids, what Slice B2 states restated, the text beside a variable kept, a call invented by
// a name, the working tree read, a parser's rejection ignored, a refused file's half-reading reported, a credential or
// a value kept, a file not of its promised shape stated, a repository followed by resemblance, a second id form, a
// mention followed or admitted as a dependency, a subject the graph does not hold answered, a gap dropped from coverage,
// a pin mismatch reported as a match, a dependency between obligations stated by the runtime source, an unverified chain
// read, a weave's bad signature or stale record stated -- on a DISPOSABLE COPY of this tree (never the tree itself;
// recorded review findings, `findings-*`, are not copied). Only the tests that decide it run there (`tests`: each
// [file, --test-name-pattern]), and the copy is thrown away.
//
//   node ophanim/graph/deps.mutate.mjs [--only D1,D7] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does
// not occur exactly once (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1): its
// deciding tests stay green with it. Synthetic keys only; no test reaches a provider or the network, and no mutation
// reads a real environment variable's value (D7 keeps the source text beside a variable's NAME, never its value). This
// file is read as text by ophanim/graph/extract/verification.mjs and is never imported by anything (it runs at import).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_TEST = 'ophanim/graph/deps-cli.test.mjs', CODE_TEST = 'ophanim/graph/deps-code.test.mjs', DECLARED_TEST = 'ophanim/graph/deps-declared.test.mjs';
const MANIFESTS_TEST = 'ophanim/graph/deps-manifests.test.mjs', MEASURE_TEST = 'ophanim/graph/deps-measure.test.mjs', PARSE_TEST = 'ophanim/graph/deps-parse.test.mjs';
const PYTHON_TEST = 'ophanim/graph/deps-python.test.mjs', QUERY_TEST = 'ophanim/graph/deps-query.test.mjs', RUNTIME_TEST = 'ophanim/graph/deps-runtime.test.mjs';
const TEXT_TEST = 'ophanim/graph/deps-text.test.mjs', WEAVE_TEST = 'ophanim/graph/deps-weave.test.mjs';
const SUITES = [CLI_TEST, CODE_TEST, DECLARED_TEST, MANIFESTS_TEST, MEASURE_TEST, PARSE_TEST, PYTHON_TEST, QUERY_TEST, RUNTIME_TEST, TEXT_TEST, WEAVE_TEST];
const INDEX = 'ophanim/graph/deps/index.mjs', CODE = 'ophanim/graph/deps/code.mjs', READ = 'ophanim/graph/deps/read.mjs', PARSE = 'ophanim/graph/deps/parse.mjs';
const PYTHON = 'ophanim/graph/deps/python.mjs', MANIFESTS = 'ophanim/graph/deps/manifests.mjs', DECLARED = 'ophanim/graph/deps/declared.mjs', IDS = 'ophanim/graph/deps/ids.mjs';
const MEASURE = 'ophanim/graph/deps/measure.mjs', QUERY = 'ophanim/graph/deps/query.mjs', RUNTIME = 'ophanim/graph/deps/runtime.mjs', TEXT = 'ophanim/graph/deps/text.mjs';
const WEAVE = 'ophanim/graph/deps/weave.mjs', CLI = 'ophanim/graph/deps/cli.mjs', B2_INDEX = 'ophanim/graph/extract/index.mjs';
const WITHHELD = /(^|\/)findings-[^/]*(\/|$)/;
const one = (file, from, to) => ({file, from, to});

export const MUTATIONS = [
  // ---- index.mjs: opt-in, versioned, TELOS at its pin, a source after what it refers to --------------------------------
  {id: 'D1', what: 'the default open gains a dependency source: Slice B2\'s sourcesOf composes the calls source itself (no longer opt-in)', tests: [[QUERY_TEST, '^OPT-IN, BESIDE SLICE B2']],
    edits: [one(B2_INDEX, "import {resolveCommit} from './git.mjs';", "import {resolveCommit} from './git.mjs';\nimport {codeSource} from '../deps/code.mjs';"),
      one(B2_INDEX, '  ].map(declared);', "  ].map(declared).concat(deps ? [{...codeSource({repo, ref: pinned}), extractorVersion: extractorVersionOf(here('../deps/code.mjs'))}] : []);"),
      one(INDEX, '  const own = [code({repo, ref: all.commit}), ...(state ? ', '  const own = [...(state ? ')]},
  {id: 'D2', what: 'a source is composed without its extractorVersion (the weave)', tests: [[QUERY_TEST, '^OPT-IN, BESIDE SLICE B2']],
    edits: [one(INDEX, "    ...(SIBLINGS[n].weave ? [versioned(weaveSource({repo: siblings[n].repo, ref: refs[n], name: n}), './weave.mjs')] : []),",
      '    ...(SIBLINGS[n].weave ? [weaveSource({repo: siblings[n].repo, ref: refs[n], name: n})] : []),')]},
  {id: 'D3', what: 'TELOS is read at whatever its checkout has moved to, not at the commit this repository pins', tests: [[QUERY_TEST, '^TELOS IS READ AT THE COMMIT THIS REPOSITORY PINS']],
    edits: [one(INDEX, "    refs[n] = s.ref ?? pin ?? 'HEAD';", "    refs[n] = s.ref ?? 'HEAD';")]},
  {id: 'D4', what: 'a source is observed before one it refers to: the calls and the runtime before Slice B2\'s sources', tests: [[QUERY_TEST, '^(OPT-IN|A RUNTIME STATE the real controller|WHAT DOES IT NEED|WHAT NEEDS IT|THE AUDIT lists)']],
    edits: [one(INDEX, '  const order = [...ORDER, sourceIdOf(HOME), RUNTIME_SOURCE,', '  const order = [sourceIdOf(HOME), RUNTIME_SOURCE, ...ORDER,')]},
  // ---- code.mjs: a sibling under its own ids, nothing of B2 restated, never a value, never by resemblance -------------
  {id: 'D5', what: 'a sibling\'s files are written under this repository\'s file ids', tests: [[CODE_TEST, '^A SIBLING: its files are its own nodes']],
    edits: [one(CODE, '  const fid = p => fileIdIn(name, p), sid = (p, n) => symbolIdIn(name, p, n);', '  const fid = p => fileIdIn(HOME, p), sid = (p, n) => symbolIdIn(name, p, n);')]},
  {id: 'D6', what: 'what Slice B2 states for this repository (its imports) is stated again by the calls source', tests: [[CODE_TEST, '^THIS REPOSITORY: nothing Slice B2 already states']],
    edits: [one(CODE, '    for (const i of home ? [] : r.imports) {', '    for (const i of r.imports) {')]},
  {id: 'D7', what: 'the text beside a variable\'s NAME (its default) is kept on the edge that reads it', tests: [[CODE_TEST, '^A SIBLING: a built-in module, a variable NAME']],
    edits: [one(CODE, "      gathered('consumes', fid(file), envId(v.name), file, {basis: 'environment variable read', need}, v.line); counts.env++;",
      "      gathered('consumes', fid(file), envId(v.name), file, {basis: 'environment variable read', need, as_written: tree.text.get(file).split('\\n')[v.line - 1].trim()}, v.line); counts.env++;")]},
  {id: 'D8', what: 'a call whose definition is not found is invented by name: taken as the one function of that name in another file', tests: [[CODE_TEST, '^THIS REPOSITORY: a call whose definition is not found']],
    edits: [one(CODE, '      if (!def || !entities.has(sid(def.file, def.name))) { unresolved.calls++; continue; }',
      "      if (!def) { const same = [...entities.values()].filter(x => x.attributes.name === c.imported && x.attributes.module !== undefined && x.attributes.module !== file); if (same.length === 1) { edge('depends-on', from, same[0].entity, file, () => ({attributes: {basis, line: c.line}})); counts.calls++; continue; } }\n      if (!def || !entities.has(sid(def.file, def.name))) { unresolved.calls++; continue; }")]},
  // ---- read.mjs: the commit, and only a few commits kept ---------------------------------------------------------------
  {id: 'D9', what: 'the code is read from the working tree instead of the commit', tests: [[CODE_TEST, '^READ AT THE COMMIT']],
    edits: [one(READ, "  const text = new Map(wanted.map(e => [e.path, bytes.get(e.blob).toString('utf8')]));",
      "  const text = new Map(wanted.map(e => [e.path, process.getBuiltinModule('node:fs').readFileSync(repo + '/' + e.path, 'utf8')]));")]},
  {id: 'D10', what: 'every commit\'s reading is kept in memory: the cache is never bounded', tests: [[CODE_TEST, '^READ ONCE PER COMMIT']],
    edits: [one(READ, '  if (cache.size > KEEP) cache.delete(cache.keys().next().value);\n', '')]},
  // ---- parse.mjs: a rejected file gives nothing; a variable is its name -------------------------------------------------
  {id: 'D11', what: 'the parser\'s syntax errors are not consulted: a file it rejected is read as if it parsed', tests: [[PARSE_TEST, '^A FILE THAT DOES NOT PARSE'], [CODE_TEST, '^THIS REPOSITORY: nothing Slice B2 already states']],
    edits: [one(PARSE, '  const errors = sf.parseDiagnostics ?? [];', '  const errors = [];')]},
  {id: 'D12', what: 'the literal default beside an environment variable is kept with its name', tests: [[PARSE_TEST, '^ENVIRONMENT VARIABLES']],
    edits: [one(PARSE, 'out.env.push({name, line: lineOf(node)}); };',
      'out.env.push({name, line: lineOf(node), ...(node.parent?.kind === K.BinaryExpression && literal(node.parent.right) !== null ? {default: node.parent.right.text} : {})}); };')]},
  // ---- python.mjs: a refused file gives nothing; never a value ----------------------------------------------------------
  {id: 'D13', what: 'a file the Python reader refused still reports what it read before the refusal', tests: [[PYTHON_TEST, '^AN IMPORT STATEMENT THAT CANNOT BE READ']],
    edits: [one(PYTHON, '  } catch (e) { if (e instanceof Refusal) return {ok: false, why: e.message, ...empty()}; throw e; }', '  } catch (e) { if (e instanceof Refusal) return {...out, ok: false, why: e.message}; throw e; }')]},
  {id: 'D14', what: 'the value assigned to os.environ[NAME] is kept with the name', tests: [[PYTHON_TEST, '^ENVIRONMENT VARIABLES: the NAME read through os']],
    edits: [one(PYTHON, 'out.env.push({name, line, ...(assigned ? {assigned: true} : {})});', 'out.env.push({name, line, ...(assigned ? {assigned} : {})});'),
      one(PYTHON, "env(whole ? T[e + 1].v : null, line, 'environ', whole && isOp(T[e + 3], '=') && !isOp(T[e + 4], '='));",
        "env(whole ? T[e + 1].v : null, line, 'environ', whole && isOp(T[e + 3], '=') && !isOp(T[e + 4], '=') && (literal(T[e + 4]) ?? true));")]},
  // ---- manifests.mjs: no credential, only a URL's host, no value --------------------------------------------------------
  {id: 'D15', what: 'a credential leaves the reader: the user:password@ part of a URL is kept in text that is kept', tests: [[MANIFESTS_TEST, '^PACKAGE.JSON: identity'], [MANIFESTS_TEST, '^A URL gives its host']],
    edits: [one(MANIFESTS, String.raw`export const withoutCredentials = text => String(text).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1');`, 'export const withoutCredentials = text => String(text);')]},
  {id: 'D16', what: 'a lockfile entry keeps the whole URL it resolves from, credential and all, not only its host', tests: [[MANIFESTS_TEST, '^PACKAGE-LOCK v3']],
    edits: [one(MANIFESTS, '    return {path, name, version: e.version === undefined ? null : withoutCredentials(e.version), resolved_host: resolved === null ? null : hostOf(resolved),',
      '    return {path, name, version: e.version === undefined ? null : withoutCredentials(e.version), resolved_host: resolved,')]},
  {id: 'D17', what: 'a workflow line that only assigns keeps the value it assigns', tests: [[MANIFESTS_TEST, '^WORKFLOW: every']],
    edits: [one(MANIFESTS, '  if (assigns) return {first_word: `${assigns[1]}=`, assignment: true};', '  if (assigns) return {first_word: t.split(/\\s+/)[0], assignment: true};')]},
  // ---- declared.mjs: only the shape a name promises; never a repository by resemblance ----------------------------------
  {id: 'D18', what: 'a composition with no service that can be read is stated, not listed as unread', tests: [[DECLARED_TEST, '^A FILE THAT IS NOT WHAT ITS NAME PROMISES']],
    edits: [one(DECLARED, "      if (!r.ok || !r.services.length) { unread.push({file: p, why: r.ok ? 'no service could be read' : r.why}); continue; }", '      if (!r.ok) { unread.push({file: p, why: r.why}); continue; }')]},
  {id: 'D19', what: 'an inventory row with no repository link is followed by resemblance: a sibling whose name the row contains', tests: [[DECLARED_TEST, '^THE INVENTORY']],
    edits: [one(DECLARED, "        } else if (line.startsWith('|') && line.includes('`')) rows.push({line: i + 1, why: 'the row names no repository link with a 40-hex commit'});",
      "        } else if (line.startsWith('|') && line.includes('`') && ['telos', 'argo', 'lexi'].some(x => line.toLowerCase().includes(x))) { const r = ['telos', 'argo', 'lexi'].find(x => line.toLowerCase().includes(x)); entity(repositoryId(r), p, {name: r}); edge('derived-from', node.entity, repositoryId(r), p, {basis: 'the row names this repository', line: i + 1}); stated++; } else if (line.startsWith('|') && line.includes('`')) rows.push({line: i + 1, why: 'the row names no repository link with a 40-hex commit'});")]},
  // ---- ids.mjs: one id form for what B2 names --------------------------------------------------------------------------
  {id: 'D20', what: 'a second id form for this repository\'s symbols (ophanim:path#name beside B2\'s path#name)', tests: [[CODE_TEST, '^THIS REPOSITORY: a function depends on the function it calls'], [QUERY_TEST, '^A SUBJECT is named']],
    edits: [one(IDS, 'export const symbolIdIn = (repo, p, name) => (repo === HOME ? symbolId(p, name) : ', "export const symbolIdIn = (repo, p, name) => (repo === HOME ? entityId({domain: 'systems', type: 'symbol', key: repo + ':' + p + '#' + name}) : ")]},
  // ---- measure.mjs: no mention, the coverage floor, no measure of a node the graph does not hold ------------------------
  {id: 'D21', what: 'a mention is followed as a dependency by the measures', tests: [[MEASURE_TEST, '^A MENTION IS NOT FOLLOWED']],
    edits: [one(MEASURE, "export const DEPENDENCY_TYPES = Object.freeze(['depends-on', 'consumes']);", "export const DEPENDENCY_TYPES = Object.freeze(['depends-on', 'consumes', 'mentions']);")]},
  {id: 'D22', what: 'the coverage floor is dropped: low stays low when coverage is not attested complete', tests: [[MEASURE_TEST, '^THE RISK CLASS']],
    edits: [one(MEASURE, "  if (cls === 'low' && coverage !== 'attested-complete') cls = 'medium';\n", '')]},
  {id: 'D23', what: 'a measure of a node the graph does not hold is reported instead of refused', tests: [[MEASURE_TEST, '^AN ASSESSMENT']],
    edits: [one(MEASURE, "const known = (view, id) => { if (!view.nodeIn(id, 'established')) throw refuse(`${id} is not established in the graph at cursor ${view.seq}`); };", 'const known = () => {};')]},
  // ---- query.mjs: NOT_FOUND, the gaps, the pins, through a file's functions ---------------------------------------------
  {id: 'D24', what: 'a subject the graph does not hold is resolved (an empty answer, not NOT_FOUND)', tests: [[QUERY_TEST, '^A SUBJECT is named']],
    edits: [one(QUERY, "  const held = id => (view.nodeIn(id, 'recorded') ? {id} : missing);", '  const held = id => ({id});')]},
  {id: 'D25', what: 'an answer is called complete although a reading it rests on reported a gap', tests: [[QUERY_TEST, '^WHAT NEEDS IT']],
    edits: [one(QUERY, '  const coverage = coverageOf(view, {gaps: gapsOf(view, [s.id, ...reached])});', '  const coverage = coverageOf(view, {gaps: []});')]},
  {id: 'D26', what: 'the pin audit reports a mismatch as a match', tests: [[QUERY_TEST, '^THE AUDIT COMPARES EACH PINNED DIGEST']],
    edits: [one(QUERY, '    out.push({...base, checked: true, pinned: pinned.length, matching: found.filter(p => p.found === p.pinned).length,', '    out.push({...base, checked: true, pinned: pinned.length, matching: found.filter(p => p.found !== null).length,'),
      one(QUERY, '      differing: found.filter(p => p.found !== null && p.found !== p.pinned).map(p => ({path: p.path, pinned: p.pinned, found: p.found})), ', '      differing: [], ')]},
  {id: 'D27', what: 'the pin audit compares a pin with the sibling\'s file at another commit than the pinned one', tests: [[QUERY_TEST, '^THE AUDIT DOES NOT COMPARE A PIN']],
    edits: [one(QUERY, "    if (repo.read_at !== repo.commit) { out.push({...base, checked: false, pinned: pinned.length, why: 'the sibling was read at another commit than the pinned one'}); continue; }\n", '')]},
  {id: 'D28', what: 'what needs a file leaves out what needs a function the file defines', tests: [[QUERY_TEST, '^WHAT NEEDS IT']],
    edits: [one(QUERY, '  const seeds = [s.id, ...defined], direct = new Map();', '  const seeds = [s.id], direct = new Map();')]},
  // ---- runtime.mjs: nothing the board states, no value, a verified chain, the version asked, read only ------------------
  {id: 'D29', what: 'the runtime source states a dependency between obligations (the board source\'s fact)', tests: [[RUNTIME_TEST, '^OBLIGATIONS:']],
    edits: [one(RUNTIME, '      accepted_sha256: word(accepted?.sha256, 80), ...(numbers.length > listed.length ? {attempts_not_listed: numbers.length - listed.length} : {})}});',
      "      accepted_sha256: word(accepted?.sha256, 80), ...(numbers.length > listed.length ? {attempts_not_listed: numbers.length - listed.length} : {})}});\n    for (const d of list(spec.dependsOn)) link('depends-on', me, obligationId(d), at(where), {basis: 'the spec depends on it'});")]},
  {id: 'D30', what: 'a VALUE of the state (an accepted output) is put in a fact', tests: [[RUNTIME_TEST, '^ARTIFACTS:']],
    edits: [one(RUNTIME, '        plan_ref: word(accepted.planRef, 200), verification_sha256: sha256Of(accepted.verification), published_commit: word(published?.commit, 80), published_blob: word(published?.blob, 80)}});',
      '        plan_ref: word(accepted.planRef, 200), verification_sha256: sha256Of(accepted.verification), published_commit: word(published?.commit, 80), published_blob: word(published?.blob, 80), output: accepted.output}});')]},
  {id: 'D31', what: 'a commit whose chain does not verify is read', tests: [[RUNTIME_TEST, '^UNVERIFIED CHAIN']],
    edits: [one(RUNTIME, '  const verify = commit => { if (!verified.has(commit)) { verifyRuntimeChain(stateDir, {head: commit}); verified.add(commit); } };', '  const verify = commit => { verified.add(commit); };')]},
  {id: 'D32', what: 'a version is answered from the head instead of its own commit', tests: [[RUNTIME_TEST, '^VERSION:']],
    edits: [one(RUNTIME, '      return runtimeFacts(readRuntimeSnapshot(stateDir, commit).state, {name, commit});', '      return runtimeFacts(readRuntimeSnapshot(stateDir).state, {name, commit});')]},
  {id: 'D33', what: 'reading the state writes into its directory (a cursor of the commit read)', tests: [[RUNTIME_TEST, '^READ ONLY']],
    edits: [one(RUNTIME, '    const {commit} = readRuntimeSnapshot(stateDir);', "    const {commit} = readRuntimeSnapshot(stateDir);\n    fs.writeFileSync(stateDir + '/graph-read.cursor', String(commit));")]},
  // ---- text.mjs: a mention is a mention, exactly, and never this repository's -------------------------------------------
  {id: 'D34', what: 'a mention is admitted as depends-on (the textual origin declared structural, its edges typed depends-on)', tests: [[TEXT_TEST, '^IN THE GRAPH a mention is established and is NOT a dependency'], [TEXT_TEST, '^A TRACKED PATH NAMED IN A STRING']],
    edits: [one(TEXT, "export const textOrigin = names => Object.freeze({kind: 'extractor', basis: 'textual', sources: names.map(textSourceIdOf)});", "export const textOrigin = names => Object.freeze({kind: 'extractor', basis: 'structural', sources: names.map(textSourceIdOf)});"),
      one(TEXT, "  const edges = [...mentions.values()].map(m => ({type: 'mentions', ", "  const edges = [...mentions.values()].map(m => ({type: 'depends-on', ")]},
  {id: 'D35', what: 'a path in a string is matched by its ending: a string that ends a tracked path is taken as that file', tests: [[TEXT_TEST, '^A STRING THAT ONLY ENDS A TRACKED PATH']],
    edits: [one(TEXT, '      if (target === file || !tree.paths.has(target)) continue;',
      "      const named = tree.paths.has(target) ? target : [...tree.paths].find(x => x.endsWith('/' + s.value));\n      if (!named || named === file) continue;\n      files.add(file); files.add(named);\n      note(file, {path: named}, {basis: 'the file names this path in a string', as_written: s.value}, s.line);\n      continue;")]},
  {id: 'D36', what: 'this repository\'s mentions are stated again by a second source (the refusal removed)', tests: [[TEXT_TEST, '^THIS REPOSITORY is refused']],
    edits: [one(TEXT, "  if (name === HOME) throw Object.assign(new Error('this repository\\'s mentions are stated by Slice B2 (ophanim.literals)'), {code: 'DEPS_REFUSED'});\n", '')]},
  // ---- weave.mjs: only a weave that verifies, never a stale record, never the header's key as an identity -------------
  {id: 'D37', what: 'a weave record whose signature does not verify is stated', tests: [[WEAVE_TEST, '^A WEAVE THAT DOES NOT VERIFY']],
    edits: [one(WEAVE, "    if (!ok) return `line ${i + 1}: the signature does not verify under the header's key`;", '    void ok;')]},
  {id: 'D38', what: 'a record woven from a file that has since changed is stated as current', tests: [[WEAVE_TEST, '^AN EDGE WOVEN FROM A FILE THAT HAS SINCE CHANGED']],
    edits: [one(WEAVE, '    if (changed) { stale++; if (staleExamples.length < 16) staleExamples.push({line, ...changed}); continue; }', '    if (changed) { stale++; if (staleExamples.length < 16) staleExamples.push({line, ...changed}); }')]},
  {id: 'D39', what: 'the header\'s key is recorded as the identity that signed the weave', tests: [[WEAVE_TEST, '^A VERIFIED WEAVE']],
    edits: [one(WEAVE, "    key: 'carried in the weave\\'s own header: evidence against tampering, not of who signed', woven_at:", '    signed_by: header.pub_key, woven_at:')]},
  // ---- cli.mjs: exit 1 when the subject cannot be answered -------------------------------------------------------------
  {id: 'D40', what: 'the command line exits 0 for a subject the graph does not hold', tests: [[CLI_TEST, '^a subject the graph does not hold']],
    edits: [one(CLI, '    return answer.error ? 1 : 0;', '    return 0;')]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
function copyTree(dest) {
  // As graph-b.mutate.mjs: a local clone at HEAD (the history kept) whose sparse checkout never writes a withheld path
  // (recorded review findings), with this working tree committed on top.
  const g = (dir, args) => execFileSync('git', ['-C', dir, '-c', 'user.name=mutation-runner', '-c', 'user.email=mutation-runner@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    {stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28, encoding: 'utf8'});
  execFileSync('git', ['clone', '-q', '--no-checkout', '--no-hardlinks', ROOT, dest], {stdio: 'ignore'});
  g(dest, ['sparse-checkout', 'set', '--no-cone', '/*', '!findings-*/', '!findings-*']);
  g(dest, ['checkout', '-q', g(ROOT, ['rev-parse', 'HEAD']).trim()]);
  const files = g(ROOT, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const f of files) {
    if (WITHHELD.test(f)) continue;                                   // recorded review findings are not read, so not copied
    const from = path.join(ROOT, f), to = path.join(dest, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(to), {recursive: true});
    if (fs.lstatSync(from).isSymbolicLink()) { fs.rmSync(to, {force: true}); fs.symlinkSync(fs.readlinkSync(from), to); continue; }
    fs.copyFileSync(from, to);
    fs.chmodSync(to, fs.statSync(from).mode);
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules', 'packages/graph/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm)) && !fs.existsSync(path.join(dest, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
  g(dest, ['add', '-A']);
  g(dest, ['commit', '-q', '--allow-empty', '-m', 'the working tree under mutation']);
}
const runSuites = (dir, logFile, files, patterns = []) => {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=600000', ...patterns.map(p => `--test-name-pattern=${p}`), ...files],
    {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}});
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
    failed: [...new Set(out.split('\n').filter(l => /^\s*✖ /.test(l) && !/failing tests/.test(l)).map(l => l.trim().replace(/ \(\d+(\.\d+)?ms\)$/, '')))]};
};

const only = arg('--only')?.split(',') ?? null;
const chosen = MUTATIONS.filter(m => !only || only.includes(m.id));
if (only && chosen.length !== only.length) { console.error(`unknown mutation id(s): ${only.filter(id => !MUTATIONS.some(m => m.id === id)).join(', ')}`); process.exit(2); }
if (new Set(MUTATIONS.map(m => m.id)).size !== MUTATIONS.length) { console.error('mutation ids are not unique'); process.exit(2); }
// Every edit must apply EXACTLY ONCE on this tree, and every deciding test file must be a suite, before anything runs.
const bad = chosen.flatMap(m => m.edits.map(e => ({m, e, n: fs.readFileSync(path.join(ROOT, e.file), 'utf8').split(e.from).length - 1}))).filter(x => x.n !== 1);
const strays = chosen.flatMap(m => m.tests.filter(([f]) => !SUITES.includes(f)).map(([f]) => `${m.id}: ${f}`));
if (bad.length || strays.length) {
  for (const {m, e, n} of bad) console.error(`${m.id}: the target occurs ${n} time(s) in ${e.file}; a mutation applies exactly once`);
  for (const s of strays) console.error(`${s} is not one of the runner's suites`);
  process.exit(2);
}
if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation(s), every target occurring exactly once`); process.exit(0); }
const copyRoot = path.resolve(arg('--copy-root', os.tmpdir()));
const logDir = path.resolve(arg('--log', path.join(copyRoot, `deps-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'deps-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, path.join(logDir, 'baseline.log'), SUITES);
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !(baseline.tests > 0)) {
    console.error('the unmutated suites are not green: no mutation result would mean anything');
    exit = 3;
  } else {
    for (const m of chosen) {
      const originals = new Map();
      for (const e of m.edits) {
        const file = path.join(copy, e.file);
        if (!originals.has(file)) originals.set(file, fs.readFileSync(file, 'utf8'));
        const before = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, before.replace(e.from, () => e.to));
        if (fs.readFileSync(file, 'utf8') === before) { console.error(`${m.id}: EDIT DID NOT APPLY in ${e.file}`); exit = 2; }
      }
      const files = [...new Set(m.tests.map(([f]) => f))], patterns = [...new Set(m.tests.map(([, p]) => p))];
      const r = runSuites(copy, path.join(logDir, `${m.id}.log`), files, patterns);
      for (const [file, text] of originals) fs.writeFileSync(file, text);
      const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0) && r.tests > 0;
      summary.push({id: m.id, what: m.what, tests: m.tests, files: [...new Set(m.edits.map(e => e.file))], killed, ran: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
      console.log(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  ${m.what}`);
      for (const f of r.failed.slice(0, 3)) console.log(`    ${f.slice(0, 200)}`);
      if (!killed) exit = exit || 1;
    }
  }
} finally {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({suites: SUITES, mutations: summary}, null, 2) + '\n');
  fs.rmSync(copy, {recursive: true, force: true});
}
console.log(`logs: ${logDir}`);
process.exit(exit);
