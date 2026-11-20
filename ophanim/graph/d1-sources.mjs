// SLICE D PART 1's REGISTRATION (knowledge graphs; KD1-9; docs/knowledge-graph/slice-d1.md): the origins, the source
// adapters and their extractor modules of the work and learning graphs, composed into the systems graph by
// ophanim/graph/extract/index.mjs as Slice B2's sources are, each with its `extractorVersion` (index.mjs `declared`).
//
//   ophanim.learning        the lessons registry, extended (learning.mjs)       composed with the lessons source
//   ophanim.work-graph      the work ledger, read only (work.mjs)              composed when a work ledger is named
//   ophanim.cycle-learning  the review-cycle ledger's findings (learning.mjs)   composed when a cycle ledger is named
//
// The rules and the tool are registered beside them: the shared-prerequisite rule, the shared-mechanism rule, the
// similarity rule (textual: hypotheses only), the reassessment rule, the why-it-exists join rule, and the mutation
// outcomes tool. Keys: the extractors write as `graph-extractor`, the rules as `graph-rule`, the tool as `graph-tool`;
// all are SYNTHETIC in every composition of this slice (key custody for the graph domain is the owner's, KG-4).
import {fileURLToPath} from 'node:url';
import {workGraphSource, WORK_GRAPH_SOURCE, WORK_GRAPH_EXTRACTOR, WORK_GRAPH_ORIGIN, WORK_RULE, WORK_RULE_ORIGIN} from './work.mjs';
import {learningSource, cycleLearningSource, LEARNING_SOURCE, LEARNING_EXTRACTOR, LEARNING_ORIGIN, CYCLE_LEARNING_SOURCE, CYCLE_LEARNING_EXTRACTOR,
  CYCLE_LEARNING_ORIGIN, LEARNING_RULE, LEARNING_RULE_ORIGIN, SIMILARITY_RULE, SIMILARITY_ORIGIN, MUTATION_TOOL, MUTATION_TOOL_ORIGIN,
  laneLearningSource, LANE_LEARNING_SOURCE, LANE_LEARNING_EXTRACTOR, LANE_LEARNING_ORIGIN} from './learning.mjs';
import {REASSESS_RULE, REASSESS_ORIGIN} from './reassess.mjs';
import {WHY_RULE, WHY_ORIGIN} from './why.mjs';

export {WORK_GRAPH_SOURCE, LEARNING_SOURCE, CYCLE_LEARNING_SOURCE, LANE_LEARNING_SOURCE, WORK_RULE, LEARNING_RULE, SIMILARITY_RULE, MUTATION_TOOL, REASSESS_RULE, WHY_RULE};
export const D1_SOURCES = Object.freeze([LEARNING_SOURCE, WORK_GRAPH_SOURCE, CYCLE_LEARNING_SOURCE, LANE_LEARNING_SOURCE]);
export const D1_ORIGIN_SPEC = Object.freeze({
  [WORK_GRAPH_EXTRACTOR]: {...WORK_GRAPH_ORIGIN, keys: ['graph-extractor']},
  [LEARNING_EXTRACTOR]: {...LEARNING_ORIGIN, keys: ['graph-extractor']},
  [CYCLE_LEARNING_EXTRACTOR]: {...CYCLE_LEARNING_ORIGIN, keys: ['graph-extractor']},
  [LANE_LEARNING_EXTRACTOR]: {...LANE_LEARNING_ORIGIN, keys: ['graph-extractor']},
  [WORK_RULE]: {...WORK_RULE_ORIGIN, keys: ['graph-rule']},
  [LEARNING_RULE]: {...LEARNING_RULE_ORIGIN, keys: ['graph-rule']},
  [SIMILARITY_RULE]: {...SIMILARITY_ORIGIN, keys: ['graph-rule']},
  [REASSESS_RULE]: {...REASSESS_ORIGIN, keys: ['graph-rule']},
  [WHY_RULE]: {...WHY_ORIGIN, keys: ['graph-rule']},
  [MUTATION_TOOL]: {...MUTATION_TOOL_ORIGIN, keys: ['graph-tool']},
});
const here = spec => fileURLToPath(new URL(spec, import.meta.url));
/** Each source's extractor: the adapter factory and the module it is defined in (the root of its version's closure). */
export const D1_MODULES = Object.freeze({
  [LEARNING_SOURCE]: {factory: learningSource, module: here('./learning.mjs')},
  [WORK_GRAPH_SOURCE]: {factory: workGraphSource, module: here('./work.mjs')},
  [CYCLE_LEARNING_SOURCE]: {factory: cycleLearningSource, module: here('./learning.mjs')},
  // The self-repair lane's rounds, from the same work ledger (owner, 2026-11-20: "wire the rounds into the learning graph").
  [LANE_LEARNING_SOURCE]: {factory: laneLearningSource, module: here('./learning.mjs')},
});
/** The adapters, as extract/index.mjs sourcesOf composes them: learning with the lessons, the others with their ledgers. */
export const d1Sources = ({repo, lessons, work, cycle}) => [...(lessons ? [learningSource({repo})] : []), ...(work ? [workGraphSource(work), laneLearningSource(work)] : []), ...(cycle ? [cycleLearningSource(cycle)] : [])];
