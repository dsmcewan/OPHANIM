// FIXTURES for Slice D part 1's tests: a graph composed of the registered sources (extract/index.mjs sourcesOf, the work
// and learning sources included), optionally with the REAL capability graph's sources (pantheon/src/capability/graph.mjs),
// in a temporary directory with SYNTHETIC keys generated for the process (openSystemsGraph). No provider; nothing written
// outside the temporary directory.
import {sourcesOf, openSystemsGraph, observeAll, ORDER, ROOT} from '../extract/index.mjs';
import {capabilitySources, capabilityOrigins, currentRegistries, DECLARED, STRUCTURAL, SOURCE_ORDER} from '../../../pantheon/src/capability/graph.mjs';

export const T0 = '2026-11-20T12:00:00.000Z';
export {ROOT};
/**
 * A graph over `repo` at `commit` with the sources sourcesOf composes for {work, cycle, lessons, status, deps}, restricted
 * to `only` when given, plus the capability graph's sources when `capability`. Every source is observed in reference
 * order. Returns openSystemsGraph's handle with {commit, observed, tool (the synthetic tool key's writer)}.
 */
export function d1Graph({repo = ROOT, commit, work = null, cycle = null, lessons = true, status = null, deps = false, only = null, capability = false, observed_at = T0, extraOrigins = {}} = {}) {
  const {commit: pinned, sources} = sourcesOf({repo, commit, status, work, cycle, lessons, deps, only});
  const cap = capability ? capabilitySources(currentRegistries()) : [];
  const origins = capability ? {...capabilityOrigins({keys: {[DECLARED]: ['graph-extractor'], [STRUCTURAL]: ['graph-extractor']}}), ...extraOrigins} : extraOrigins;
  const g = openSystemsGraph({sources: [...sources, ...cap], extraOrigins: origins, extraKeys: {'graph-tool': true, 'graph-agent': true}});
  const observed = observeAll(g.graph, g.by, {observed_at, order: [...ORDER, ...SOURCE_ORDER]});
  return {...g, commit: pinned, observed, tool: g.signers['graph-tool'], agent: g.signers['graph-agent']};
}
