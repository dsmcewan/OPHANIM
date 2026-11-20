// THE DEPENDENCY GRAPH's composition: one graph over this repository's sources and its sibling repositories'.
//
// Purpose   The dependency sources of this directory are registered beside the systems and evidence sources
//           (extract/index.mjs) on the same contract and the same graph ledger: there is one graph, with more sources.
//           This composes them, pins this repository's sources to ONE commit, pins each sibling to the commit its
//           checkout is read at, and observes every source in the order their references need.
// Inputs    This repository's root and commit; for each sibling a checkout ({repo, ref}); runtime state directories
//           ({name, stateDir}), each a source of its own (runtime.mjs); the same options as
//           extract/index.mjs systemsGraph for the base sources.
// Outputs   dependencyGraph() -> {graph, commit, observed, absent, pinned, by, close, ...}; dependencySources(); SIBLINGS.
// Invariants  A sibling with no checkout is not guessed at: it is listed in `absent` with why, and nothing is stated of
//           it. Keys are SYNTHETIC, generated for the process (extract/index.mjs openSystemsGraph): key custody for the
//           graph domain is the owner's decision.
// Must never  Write a source, a sibling repository or a production key; observe a source before one it refers to.
import {sourcesOf, openSystemsGraph, observeAll, ORDER, ROOT, REPO_SOURCE, VERIFICATION_SOURCE, RECORDS_SOURCE, LESSONS_SOURCE, STATUS_SOURCE, WORK_SOURCE, CYCLE_SOURCE} from '../extract/index.mjs';
import {codeSource, codeOrigin, CODE_EXTRACTOR, sourceIdOf} from './code.mjs';
import {textSource, textOrigin, TEXT_EXTRACTOR, textSourceIdOf} from './text.mjs';
import {weaveSource, WEAVE_ORIGIN, WEAVE_EXTRACTOR, weaveSourceIdOf} from './weave.mjs';
import {pinsSource, pinTables, PINS_ORIGIN, EXTRACTOR as PINS_EXTRACTOR, SOURCE_ID as PINS_SOURCE, GOVERNANCE} from './pins.mjs';
import {ownershipSource, OWNERSHIP_ORIGIN, EXTRACTOR as OWNERSHIP_EXTRACTOR, SOURCE_ID as OWNERSHIP_SOURCE} from './authority.mjs';
import {runtimeSource, EXTRACTOR as RUNTIME_EXTRACTOR} from './runtime.mjs';
import {declaredSource, declaredOrigin, DECLARED_EXTRACTOR, declaredSourceIdOf} from './declared.mjs';
import {textAt, resolveCommit} from '../extract/git.mjs';
import {HOME} from './ids.mjs';

/** The sibling repositories this graph knows by name. `weave`: the sibling commits a signed dependency ledger of its own. */
export const SIBLINGS = Object.freeze({telos: Object.freeze({weave: true}), argo: Object.freeze({weave: false}), lexi: Object.freeze({weave: false})});
export {ROOT};

/**
 * The source adapters and the origins that may write them. `siblings`: {name: {repo, ref}} for the checkouts at hand.
 * Returns {commit, sources, origins, order, absent}.
 */
export function dependencySources({repo = ROOT, commit, status, work = null, cycle = null, lessons = true, verification = true, records = true, siblings = {}, states = [], extra = []} = {}) {
  for (const s of states) if (!/^[a-z][a-z0-9-]{0,31}$/.test(s?.name ?? '') || typeof s.stateDir !== 'string') throw Object.assign(new Error('a runtime state has a short lowercase name and a directory'), {code: 'DEPS_REFUSED'});
  const runtimeId = name => `ophanim.runtime.${name}`;
  const only = [REPO_SOURCE, ...(verification ? [VERIFICATION_SOURCE] : []), ...(records ? [RECORDS_SOURCE] : []), LESSONS_SOURCE, STATUS_SOURCE, WORK_SOURCE, CYCLE_SOURCE];
  const base = sourcesOf({repo, commit, ...(status !== undefined ? {status} : {}), work, cycle, lessons, only});
  // TELOS is read at the commit this repository pins (ophanim/governance.mjs at this commit), so a pinned file and the
  // sibling's own node for it are the same file. A checkout that lacks the pinned commit is not read at another one.
  const pinned = {}, absent = [], refs = {};
  let governance = null;
  try { governance = pinTables(textAt(repo, base.commit, GOVERNANCE)); } catch { /* no governance file at this commit: nothing is pinned */ }
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
  const own = [codeSource({repo, ref: base.commit}), textSource({repo, ref: base.commit}),
    pinsSource({repo, ref: base.commit, telos: siblings.telos?.repo ?? null}), ownershipSource({repo, ref: base.commit}), ...extra.map(make => make({repo, commit: base.commit})),
    ...states.map(s => runtimeSource({stateDir: s.stateDir, name: s.name, id: runtimeId(s.name)}))];
  const theirs = present.flatMap(n => [codeSource({repo: siblings[n].repo, ref: refs[n], name: n}), textSource({repo: siblings[n].repo, ref: refs[n], name: n}),
    ...(SIBLINGS[n].weave ? [weaveSource({repo: siblings[n].repo, ref: refs[n], name: n})] : []), declaredSource({repo: siblings[n].repo, ref: refs[n], name: n})]);
  const origins = {
    ...(present.length ? {[DECLARED_EXTRACTOR]: {...declaredOrigin(present), keys: ['graph-extractor']}} : {}),
    [PINS_EXTRACTOR]: {...PINS_ORIGIN, keys: ['graph-extractor']},
    [OWNERSHIP_EXTRACTOR]: {...OWNERSHIP_ORIGIN, keys: ['graph-extractor']},
    ...(states.length ? {[RUNTIME_EXTRACTOR]: {kind: 'extractor', basis: 'declared', sources: states.map(s => runtimeId(s.name)), keys: ['graph-extractor']}} : {}),
    [CODE_EXTRACTOR]: {...codeOrigin([HOME, ...present]), keys: ['graph-extractor']},
    [TEXT_EXTRACTOR]: {...textOrigin([HOME, ...present]), keys: ['graph-extractor']},
    [WEAVE_EXTRACTOR]: {...WEAVE_ORIGIN, keys: ['graph-extractor']},
  };
  // A sibling's weave refers to the files its code source states, so the code is observed first; this repository first of all.
  const order = [...ORDER, sourceIdOf(HOME), textSourceIdOf(HOME), PINS_SOURCE, OWNERSHIP_SOURCE, ...own.slice(4).map(s => s.id),
    ...present.flatMap(n => [sourceIdOf(n), textSourceIdOf(n), ...(SIBLINGS[n].weave ? [weaveSourceIdOf(n)] : []), declaredSourceIdOf(n)])];
  return {commit: base.commit, sources: [...base.sources, ...own, ...theirs], origins, order, absent, pinned};
}

/** One call: the dependency graph of `repo` at `commit` with the siblings at hand, observed. Close it with `close()`. */
export function dependencyGraph({dir = null, observed_at, extraOrigins = {}, ...opts} = {}) {
  const {commit, sources, origins, order, absent, pinned} = dependencySources(opts);
  const g = openSystemsGraph({dir, sources, extraOrigins: {...origins, ...extraOrigins}});
  const observed = observeAll(g.graph, g.by, {observed_at, order});
  return {...g, commit, observed, absent, pinned};
}
