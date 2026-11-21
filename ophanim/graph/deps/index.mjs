// THE OPT-IN DEPENDENCY SOURCES' composition: Slice B2's graph, plus calls, the runtime's record and the sibling repositories.
//
// Purpose   Slice B2 (ophanim/graph/extract/index.mjs) composes by default what this repository's code needs. The
//           sources of this directory are NOT in that default: they are composed here, when asked for, beside it, on
//           the same contract and the same graph ledger. They add the calls between this repository's functions, what
//           the runtime's record holds beyond its obligations (when a state directory is named), and the sibling
//           repositories TELOS, ARGO and LEXI (when a checkout of each is given), each pinned to one commit.
// Inputs    This repository's root and commit; for each sibling a checkout ({repo, ref}); one runtime state directory
//           ({name, stateDir}); the same options as extract/index.mjs sourcesOf for the base sources.
// Outputs   dependencyGraph() -> {graph, commit, observed, absent, pinned, by, close, ...}; dependencySources(); SIBLINGS.
// Invariants  The default open is not changed by this module: nothing here is in extract/index.mjs ORDER. Every source
//           declares its extractor's version (checkpoint.md section 5a). A sibling with no checkout is not guessed at:
//           it is listed in `absent` with why. TELOS is read at the commit this repository pins, or not at all. Keys are
//           SYNTHETIC, generated for the process (extract/index.mjs openSystemsGraph).
// Must never  Write a source, a sibling repository or a production key; observe a source before one it refers to;
//           state for this repository what a source of Slice B2 states.
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parserVersion} from './parse.mjs';
import {sourcesOf, openSystemsGraph, observeAll, extractorVersionOf, ORDER, ROOT, VERIFICATION_SOURCE, RECORDS_SOURCE} from '../extract/index.mjs';
import {governancePins, GOVERNANCE} from '../extract/pins.mjs';
import {textAt, resolveCommit} from '../extract/git.mjs';
import {codeSource, codeOrigin, CODE_EXTRACTOR, sourceIdOf} from './code.mjs';
import {textSource, textOrigin, TEXT_EXTRACTOR, textSourceIdOf} from './text.mjs';
import {weaveSource, WEAVE_ORIGIN, WEAVE_EXTRACTOR, weaveSourceIdOf} from './weave.mjs';
import {runtimeSource, EXTRACTOR as RUNTIME_EXTRACTOR, SOURCE_ID as RUNTIME_SOURCE, RUNTIME_ORIGIN} from './runtime.mjs';
import {declaredSource, declaredOrigin, DECLARED_EXTRACTOR, declaredSourceIdOf} from './declared.mjs';
import {HOME} from './ids.mjs';

/** The sibling repositories this graph knows by name. `weave`: the sibling commits a signed dependency ledger of its own. */
export const SIBLINGS = Object.freeze({telos: Object.freeze({weave: true}), argo: Object.freeze({weave: false}), lexi: Object.freeze({weave: false})});
export {ROOT};

// The version of the code each source's extractor runs: the digest of its module and of every module it imports, as
// extract/index.mjs computes it, and for the sources that read code, the parser's version too (a reading rests on the
// parser as much as on this repository's code). Read once per process.
const versions = new Map();
const versioned = (source, module, {parser = false} = {}) => {
  const key = `${module}\0${parser}`;
  if (!versions.has(key)) {
    const own = extractorVersionOf(fileURLToPath(new URL(module, import.meta.url)));
    versions.set(key, parser ? 'sha256:' + createHash('sha256').update(JSON.stringify({schema: 'ophanim.graph.deps.extractor-version/v1', modules: own, parser: `typescript ${parserVersion()}`})).digest('hex') : own);
  }
  return {...source, extractorVersion: versions.get(key)};
};

/**
 * The source adapters and the origins that may write the opt-in ones. `siblings`: {name: {repo, ref}} for the checkouts
 * at hand; `state`: {name, stateDir} for one runtime state directory. Returns {commit, sources, origins, order, absent, pinned}.
 */
export function dependencySources({repo = ROOT, commit, status, work = null, cycle = null, lessons = true, verification = true, records = true, siblings = {}, state = null} = {}) {
  if (state && (!/^[a-z][a-z0-9-]{0,31}$/.test(state.name ?? '') || typeof state.stateDir !== 'string')) throw Object.assign(new Error('a runtime state has a short lowercase name and a directory'), {code: 'DEPS_REFUSED'});
  const all = sourcesOf({repo, commit, ...(status !== undefined ? {status} : {}), work, cycle, lessons, deps: true, board: state ? {stateDir: state.stateDir} : null});
  const base = all.sources.filter(s => (verification || s.id !== VERIFICATION_SOURCE) && (records || s.id !== RECORDS_SOURCE));
  // TELOS is read at the commit this repository pins (ophanim/governance.mjs at this commit, read by B2's own reader), so
  // a pinned file and the sibling's own node for it are the same file. A checkout that lacks the pinned commit is not
  // read at another one.
  const pinned = {}, absent = [], refs = {};
  let governance = null;
  try { governance = governancePins(textAt(repo, all.commit, GOVERNANCE)); } catch { /* no governance file at this commit: nothing is pinned */ }
  for (const n of Object.keys(SIBLINGS)) {
    const s = siblings[n];
    if (!s?.repo) { absent.push({repository: n, why: 'no checkout was given'}); continue; }
    const pin = n === 'telos' && !s.ref ? governance?.commit?.value ?? null : null;
    if (pin) {
      try { resolveCommit(s.repo, pin); } catch { absent.push({repository: n, why: `its checkout does not hold the pinned commit ${pin}`}); continue; }
      pinned[n] = {commit: pin, by: GOVERNANCE};
    }
    refs[n] = s.ref ?? pin ?? 'HEAD';
  }
  const present = Object.keys(refs);
  const code = o => versioned(codeSource(o), './code.mjs', {parser: true}), text = o => versioned(textSource(o), './text.mjs', {parser: true});
  const own = [code({repo, ref: all.commit}), ...(state ? [versioned(runtimeSource({stateDir: state.stateDir, name: state.name}), './runtime.mjs')] : [])];
  const theirs = present.flatMap(n => [code({repo: siblings[n].repo, ref: refs[n], name: n}), text({repo: siblings[n].repo, ref: refs[n], name: n}),
    ...(SIBLINGS[n].weave ? [versioned(weaveSource({repo: siblings[n].repo, ref: refs[n], name: n}), './weave.mjs')] : []),
    versioned(declaredSource({repo: siblings[n].repo, ref: refs[n], name: n}), './declared.mjs')]);
  const origins = {
    [CODE_EXTRACTOR]: {...codeOrigin([HOME, ...present]), keys: ['graph-extractor']},
    ...(state ? {[RUNTIME_EXTRACTOR]: {...RUNTIME_ORIGIN, keys: ['graph-extractor']}} : {}),
    ...(present.length ? {[TEXT_EXTRACTOR]: {...textOrigin(present), keys: ['graph-extractor']}, [DECLARED_EXTRACTOR]: {...declaredOrigin(present), keys: ['graph-extractor']}} : {}),
    [WEAVE_EXTRACTOR]: {...WEAVE_ORIGIN, keys: ['graph-extractor']},
  };
  // After every source of the default open (the calls name B2's packages; the runtime's facts hang on the board's
  // obligations), and a sibling's code before what refers to its files.
  const order = [...ORDER, sourceIdOf(HOME), RUNTIME_SOURCE,
    ...present.flatMap(n => [sourceIdOf(n), textSourceIdOf(n), ...(SIBLINGS[n].weave ? [weaveSourceIdOf(n)] : []), declaredSourceIdOf(n)])];
  return {commit: all.commit, sources: [...base, ...own, ...theirs], origins, order, absent, pinned};
}

/** One call: the graph of `repo` at `commit` with the opt-in sources, the siblings at hand and the state named, observed. Close it with `close()`. */
export function dependencyGraph({dir = null, observed_at, extraOrigins = {}, ...opts} = {}) {
  const {commit, sources, origins, order, absent, pinned} = dependencySources(opts);
  const g = openSystemsGraph({dir, sources, extraOrigins: {...origins, ...extraOrigins}});
  const observed = observeAll(g.graph, g.by, {observed_at, order});
  return {...g, commit, observed, absent, pinned};
}
