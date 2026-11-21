// The graph contract ophanim.graph/v1 (docs/knowledge-graph/architecture.md): the five domains and their entity
// types, the relationship registry, the classifications and who may admit them, and the static checks of an
// assertion record. Stateful checks (duplicates, references, supersession, contradiction handling) are the
// projection's (projection.mjs); this file decides only what can be decided from the record and the registries.
//
// The relationship registry is kept EQUAL to the contract document's table by packages/graph/tests/schema.test.mjs.
// A type has a meaning, a direction (from -> to), the entity types it may join (domain and range, cross-domain pairs
// included), its symmetry, whether impact traversal follows it and which way, and the classifications that may
// assert it, each with the bases (how the origin knows) it may be admitted from. "depends-on" is never admitted
// from textual similarity or a model's inference: a hypothetical depends-on stays hypothetical until a registered
// extractor or rule establishes it.
import {canonical, digest} from '../ledger/canonical.mjs';
import {grammarRefusal, parseId, decodeKey, relationshipSubject, assertionId, contentOf, VERSION, SHA256_REF, DEFAULT_INSTANCE, INSTANCE_NAME} from './identity.mjs';

export const GRAPH_SCHEMA = 'ophanim.graph/v1';
// 1.1.0 (Slice C1): capability-domain entity types (lane, chair, placement) and relationship types (made-by, served-by,
// alias-of, limited-by, combines, holds, places, measures) ADDED; no existing type changed.
// 1.2.0 (Slice B2, the dependency sources of Graph B): systems-domain entity types (package, environment-variable,
// executable, host) ADDED; no relationship type added (the registered depends-on, consumes, produces, governs,
// authorizes, mentions and derived-from carry their facts); no existing type changed.
export const CONTRACT_VERSION = '1.2.0';

// ---- domains and entity types (KD3) ---------------------------------------------------------------------------------
const types = spec => Object.freeze(Object.fromEntries(spec.map(([t, meaning]) => [t, Object.freeze({meaning})])));
export const DOMAINS = Object.freeze({
  capability: Object.freeze({graph: 'A', title: 'Model, runtime and capability', types: types([
    ['provider', 'a model provider or vendor'],
    ['lab', 'an independent laboratory, the unit of review independence'],
    ['model', 'a model identity at a version'],
    ['runtime', 'an SDK, CLI or execution runtime'],
    ['transport', 'a request transport (API, CLI, relay)'],
    ['tool', 'a tool an agent may use'],
    ['agent', 'an agent or seat that executes or reviews work'],
    ['environment', 'an execution environment (sandbox, host)'],
    ['capability', 'an executable model/runtime combination with the constraints under which it works'],
    ['feature', 'a feature a runtime or model provides (native subagents, an effort level)'],
    ['role', 'a work role (planner, implementer, reviewer, validator)'],
    ['qualification', 'a qualification record, established only from measured evidence'],
    ['limitation', 'a known limitation or constraint'],
    ['pool', 'an availability or quota pool'],
    ['lane', 'a named serving variant of a model on one transport at a fixed setting (an Antigravity lane name); not a model of its own'],
    ['chair', 'a roster chair: a named seat position, the roles it holds and the vendors that may occupy it'],
    ['placement', 'an owner- or operator-directed placement of a model in a role (a seating-table row, an ARGO seat, a fit-matrix cell), with its declared basis; a direction, never a measurement'],
  ])}),
  systems: Object.freeze({graph: 'B', title: 'Systems, components and dependencies', types: types([
    ['enterprise', 'an enterprise'], ['department', 'a department'], ['process', 'a business process'],
    ['application', 'an application'], ['repository', 'a source repository'], ['module', 'a module or source file of code'],
    ['symbol', 'a function, class or exported symbol'], ['file', 'a file that is not code (data, configuration, document)'],
    ['component', 'a reusable component'], ['service', 'a running service'], ['api', 'an API'], ['interface', 'an interface or handoff'],
    ['datastore', 'a database or store'], ['dataset', 'a table, view or dataset'], ['schema', 'a data or record schema'],
    ['transformation', 'a transformation'], ['pipeline', 'a pipeline'],
    ['contract', 'a contract'], ['invariant', 'an invariant'], ['test', 'a test or acceptance check'], ['suite', 'a test suite'],
    ['mutation', 'a mutation target'], ['workflow', 'a CI or operating workflow'], ['deployment', 'a deployment environment'],
    ['change', 'a commit or change set'],
    // added in contract 1.2.0 (Slice B2)
    ['package', 'a package code imports or a manifest declares: an npm package at the version its lockfile resolved, a workspace package, or a runtime built-in'],
    ['environment-variable', 'an environment variable, by its NAME only (never its value)'],
    ['executable', 'a program code runs by name'],
    ['host', 'a network host a request names'],
  ])}),
  evidence: Object.freeze({graph: 'C', title: 'Evidence, decisions and provenance', types: types([
    ['requirement', 'an original requirement'], ['document', 'a source document'],
    ['source', 'a registered source and the version last observed of it'],
    ['observation', 'an observation, with its run'], ['evidence', 'a piece of retrieved or delivered evidence'],
    ['claim', 'a stated claim'], ['hypothesis', 'a hypothesis or competing explanation'],
    ['investigation', 'an investigation'], ['experiment', 'an experiment, test or reproduction run'],
    ['decision', 'a decision'], ['authorization', 'an authorization'], ['conclusion', 'a conclusion'],
    ['record', 'an execution or verification record'],
  ])}),
  learning: Object.freeze({graph: 'D', title: 'Failures, corrections and learning', types: types([
    ['defect', 'an observed defect or unexpected behaviour'], ['symptom', 'a symptom'], ['trigger', 'a trigger or contributing factor'],
    ['cause', 'a proposed or established cause'], ['reproduction', 'a reproduction or negative test'],
    ['mutation-outcome', 'a mutation-testing outcome'], ['repair', 'a repair, mitigation or rejected alternative'],
    ['finding', 'a reviewer finding'], ['lesson', 'a lesson with its applicability conditions'],
    ['failure-class', 'a recurring failure class (the lessons registry\'s unit)'],
    ['failure-mechanism', 'an underlying failure mechanism shared by defects'], ['detection-gap', 'a known detection gap'],
  ])}),
  work: Object.freeze({graph: 'E', title: 'Work, resources and execution', types: types([
    ['prompt', 'an original prompt'], ['item', 'an authorized work identity (a status item)'], ['ticket', 'a ticket'],
    ['plan', 'a plan'], ['work-unit', 'a work unit'], ['team', 'a team'], ['assignment', 'an assignment of a role'],
    ['lease', 'an execution lease or claim'], ['worktree', 'a worktree'], ['budget', 'a resource budget'],
    ['request', 'a provider request'], ['usage', 'resource usage'], ['execution', 'an execution or attempt'],
    ['checkpoint', 'a checkpoint'], ['artifact', 'a produced artifact'], ['review', 'a review'], ['validation', 'a validation'],
    ['obligation', 'a completion condition or unresolved obligation'], ['discovery', 'a discovery that creates, revises or invalidates work'],
  ])}),
});
export const DOMAIN_NAMES = Object.freeze(Object.keys(DOMAINS));

// ---- classifications and origins (KD5) ------------------------------------------------------------------------------
export const CLASSIFICATIONS = Object.freeze(['authoritative', 'observed', 'derived', 'hypothetical']);
/** How an origin knows: a source states it, it is parsed from structure, a run measured it, text matched, or inferred. */
export const BASES = Object.freeze(['declared', 'structural', 'measured', 'textual', 'inferred']);
/** Origin kinds: what each may admit (besides hypothetical, which anyone registered may propose) and on what basis. */
export const ORIGIN_KINDS = Object.freeze({
  extractor: Object.freeze({admits: ['authoritative'], bases: ['declared', 'structural', 'textual']}),
  tool: Object.freeze({admits: ['observed'], bases: ['measured']}),
  rule: Object.freeze({admits: ['derived'], bases: ['declared', 'structural', 'measured', 'textual']}),
  agent: Object.freeze({admits: [], bases: ['inferred']}),
  model: Object.freeze({admits: [], bases: ['inferred']}),
});
export const STATUSES = Object.freeze(['unverified', 'verified', 'unresolved']);
export const ACCESS = Object.freeze(['public', 'internal', 'restricted']);
const SOURCE_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const ORIGIN_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const KEY_ID = /^[A-Za-z0-9._@:-]{1,128}$/;

const refuse = why => Object.assign(new Error(why), {code: 'GRAPH_REFUSED'});

/**
 * The origin registry a reader composes, like the ledger's kind registry: {id: {kind, basis, keys: [key_id],
 * sources: [source id] (extractors: the sources whose authority they project)}}. Frozen; refused if malformed.
 */
export function defineOrigins(spec) {
  const out = {};
  for (const [id, o] of Object.entries(spec ?? {})) {
    if (!ORIGIN_ID.test(id)) throw refuse(`origin id "${id}" is not a name`);
    const k = ORIGIN_KINDS[o?.kind];
    if (!k) throw refuse(`origin ${id}: kind "${o?.kind}" is not one of ${Object.keys(ORIGIN_KINDS).join(', ')}`);
    if (!k.bases.includes(o.basis)) throw refuse(`origin ${id}: ${o.kind} origins know by ${k.bases.join(' or ')}, not "${o.basis}"`);
    if (!Array.isArray(o.keys) || !o.keys.length || !o.keys.every(x => KEY_ID.test(x))) throw refuse(`origin ${id}: keys are the key ids that may write as it`);
    const sources = o.sources ?? [];
    if (!Array.isArray(sources) || !sources.every(s => SOURCE_ID.test(s))) throw refuse(`origin ${id}: sources are source ids`);
    if (o.kind === 'extractor' && !sources.length) throw refuse(`origin ${id}: an extractor names the sources it projects`);
    if (o.kind !== 'extractor' && sources.length) throw refuse(`origin ${id}: only an extractor projects a source`);
    out[id] = Object.freeze({id, kind: o.kind, basis: o.basis, keys: Object.freeze([...o.keys]), sources: Object.freeze([...sources])});
  }
  return Object.freeze(out);
}

// ---- the relationship registry (KD6) --------------------------------------------------------------------------------
// Endpoint patterns: 'domain/type', 'domain/*' or '*'. impact: which endpoint a CHANGE propagates to.
//   'to->from'  a change to `to` affects `from` (A depends-on B: B changes, A is affected);
//   'from->to'  a change to `from` affects `to` (K governs C: K changes, C is affected);
//   null        impact traversal never follows it.
// admits: classification -> the bases it may be admitted from ('*': any basis). A classification absent is refused.
const ANY = '*';
const STRUCT = ['declared', 'structural'];
const R = (meaning, from, to, impact, admits, extra = {}) => Object.freeze({meaning, from: Object.freeze(from), to: Object.freeze(to),
  impact, symmetric: Boolean(extra.symmetric), inverse: extra.inverse ?? null, sameType: Boolean(extra.sameType),
  admits: Object.freeze(Object.fromEntries(Object.entries(admits).map(([c, b]) => [c, b === ANY ? ANY : Object.freeze(b)])))});
const IMPL_FROM = ['systems/*', 'work/artifact', 'work/work-unit', 'capability/runtime', 'capability/tool', 'capability/capability', 'learning/repair'];
const IMPL_TO = ['evidence/requirement', 'systems/contract', 'systems/interface', 'systems/invariant', 'systems/api', 'capability/capability',
  'capability/feature', 'work/ticket', 'work/item', 'work/obligation', 'work/plan'];
const GOVERNORS = ['systems/contract', 'systems/invariant', 'evidence/authorization', 'evidence/decision', 'evidence/requirement'];
const GOVERNED = ['systems/*', 'work/*', 'capability/*'];
const VERIFIERS = ['systems/test', 'systems/suite', 'systems/mutation', 'evidence/observation', 'evidence/experiment', 'evidence/investigation',
  'work/validation', 'work/review'];
const VERIFIED = ['systems/*', 'evidence/requirement', 'evidence/conclusion', 'evidence/claim', 'capability/*', 'work/*', 'learning/repair'];
const ACTORS = ['systems/*', 'work/*', 'capability/agent', 'capability/tool', 'capability/runtime'];
const CLAIMS = ['evidence/*', 'learning/*', 'work/review', 'work/validation', 'capability/qualification'];
const SEATS = ['capability/model', 'capability/capability', 'capability/agent', 'capability/runtime', 'capability/tool', 'work/team'];

export const RELATIONSHIPS = Object.freeze({
  'implements': R('the source realizes the target requirement, contract, interface, capability or work obligation',
    IMPL_FROM, IMPL_TO, 'from->to', {authoritative: STRUCT, observed: ['measured'], derived: STRUCT, hypothetical: ANY}, {inverse: 'implemented-by'}),
  'implemented-by': R('the source requirement, contract, interface, capability or obligation is realized by the target',
    IMPL_TO, IMPL_FROM, 'to->from', {authoritative: STRUCT, observed: ['measured'], derived: STRUCT, hypothetical: ANY}, {inverse: 'implements'}),
  'depends-on': R('the source cannot be correct or complete without the target',
    ['systems/*', 'work/*', 'capability/*'], ['systems/*', 'work/*', 'capability/*', 'evidence/requirement', 'evidence/authorization', 'evidence/decision'],
    'to->from', {authoritative: STRUCT, observed: ['measured'], derived: ['declared', 'structural', 'measured'], hypothetical: ANY}),
  'consumes': R('the source reads or uses the target as an input',
    ACTORS, ['systems/*', 'work/artifact', 'evidence/*', 'capability/*'], 'to->from',
    {authoritative: STRUCT, observed: ['measured'], derived: ['declared', 'structural', 'measured'], hypothetical: ANY}),
  'produces': R('the source creates or writes the target as an output',
    ACTORS, ['systems/*', 'work/artifact', 'evidence/*'], 'from->to',
    {authoritative: STRUCT, observed: ['measured'], derived: ['declared', 'structural', 'measured'], hypothetical: ANY}),
  'governs': R('the source contract, invariant, authorization, decision or requirement constrains the target',
    GOVERNORS, GOVERNED, 'from->to', {authoritative: ['declared'], derived: ['declared'], hypothetical: ANY}, {inverse: 'governed-by'}),
  'governed-by': R('the source is constrained by the target contract, invariant, authorization, decision or requirement',
    GOVERNED, GOVERNORS, 'to->from', {authoritative: ['declared'], derived: ['declared'], hypothetical: ANY}, {inverse: 'governs'}),
  'authorizes': R('the source authorization or decision permits the target to exist or proceed',
    ['evidence/authorization', 'evidence/decision'], ['work/*', 'systems/change', 'evidence/decision', 'capability/*'], 'from->to',
    {authoritative: ['declared'], derived: ['declared'], hypothetical: ANY}),
  'verifies': R('the source check establishes, by running, whether the target holds',
    VERIFIERS, VERIFIED, 'from->to', {authoritative: ['declared'], observed: ['measured'], derived: ['declared', 'measured'], hypothetical: ANY},
    {inverse: 'verified-by'}),
  'verified-by': R('the source is established, by running, by the target check',
    VERIFIED, VERIFIERS, 'to->from', {authoritative: ['declared'], observed: ['measured'], derived: ['declared', 'measured'], hypothetical: ANY},
    {inverse: 'verifies'}),
  'derived-from': R('the source was computed, copied or built from the target',
    [ANY], [ANY], 'to->from', {authoritative: STRUCT, observed: ['measured'], derived: STRUCT, hypothetical: ANY}),
  'supports': R('the source provides positive support for the target: evidence that bears out a claim, or a runtime that provides a feature; never a dependency',
    [...CLAIMS, 'systems/test', 'capability/runtime', 'capability/model'], [...CLAIMS, 'work/plan', 'capability/feature'], 'from->to',
    {authoritative: ['declared'], observed: ['measured'], derived: ['declared', 'structural', 'measured'], hypothetical: ANY}),
  'contradicts': R('the source and the target cannot both hold; both are kept and retrievable as a contradiction set',
    CLAIMS, CLAIMS, null, {authoritative: ['declared'], observed: ['measured'], derived: ['declared', 'structural', 'measured'], hypothetical: ANY},
    {symmetric: true}),
  'supersedes': R('the source replaces the target, an entity of the same domain and type, which stays in the record',
    [ANY], [ANY], null, {authoritative: STRUCT, derived: STRUCT, hypothetical: ANY}, {sameType: true}),
  'introduced-because-of': R('the source exists because of the target requirement, finding, failure or decision',
    ['systems/*', 'work/*', 'capability/*', 'learning/repair', 'learning/lesson', 'evidence/decision'],
    ['evidence/*', 'learning/*', 'work/ticket', 'work/item', 'work/prompt'], 'to->from',
    {authoritative: ['declared'], derived: ['declared'], hypothetical: ANY}),
  'invalidates': R('the source makes the target no longer valid; the target stays in the record',
    ['systems/change', 'evidence/observation', 'evidence/decision', 'learning/finding', 'work/discovery'],
    ['capability/qualification', 'evidence/*', 'work/*', 'learning/*'], 'from->to',
    {authoritative: ['declared'], observed: ['measured'], derived: ['declared', 'structural', 'measured'], hypothetical: ANY}),
  'qualified-for': R('the source is qualified for the target role on measured evidence; never from configuration or preference',
    SEATS, ['capability/role'], null, {observed: ['measured'], derived: ['measured'], hypothetical: ANY}),
  'eligible-for': R('the source may be assigned the target role under a documented basis, without a claim of measured qualification',
    SEATS, ['capability/role'], null, {authoritative: ['declared'], derived: ['declared', 'measured'], hypothetical: ANY}),
  'contributed-to': R('the source contributed to the target',
    ['capability/agent', 'capability/model', 'capability/capability', 'work/team'], ['work/*', 'evidence/*', 'learning/*', 'systems/*'], null,
    {authoritative: ['declared'], observed: ['measured'], derived: ['declared'], hypothetical: ANY}),
  'shares-failure-mechanism-with': R('the source and the target fail by one established mechanism; never inferred from similar symptoms or text',
    ['learning/defect', 'learning/failure-class', 'learning/finding'], ['learning/defect', 'learning/failure-class', 'learning/finding'], null,
    {authoritative: ['declared'], observed: ['measured'], derived: ['declared', 'measured'], hypothetical: ANY}, {symmetric: true}),
  'requires-capability': R('the source work or component needs the target capability to be done or to run',
    ['work/*', 'systems/*'], ['capability/capability', 'capability/feature', 'capability/runtime', 'capability/tool', 'systems/component',
      'systems/service', 'systems/api', 'systems/interface'], 'to->from',
    {authoritative: ['declared'], derived: STRUCT, hypothetical: ANY}),
  'detects': R('the source check fails when the target failure occurs',
    ['systems/test', 'systems/suite', 'systems/mutation', 'evidence/observation', 'work/review'], ['learning/*'], 'from->to',
    {authoritative: ['declared'], observed: ['measured'], derived: ['declared', 'measured'], hypothetical: ANY}),
  'documented-in': R('the source is recorded or explained in the target document or lesson',
    [ANY], ['evidence/document', 'learning/lesson', 'learning/failure-class', 'systems/file'], 'from->to',
    {authoritative: STRUCT, derived: STRUCT, hypothetical: ANY}),
  'applies-to': R('the source lesson, failure or repair applies to the target, under its stated conditions',
    ['learning/lesson', 'learning/failure-class', 'learning/failure-mechanism', 'learning/repair'], ['systems/*', 'work/*', 'capability/*'], 'from->to',
    {authoritative: ['declared'], derived: ['declared', 'measured'], hypothetical: ANY}),
  'runs-in': R('the source model, agent or tool executes in the target runtime, environment or transport',
    ['capability/model', 'capability/agent', 'capability/tool'], ['capability/runtime', 'capability/environment', 'capability/transport'], 'to->from',
    {authoritative: ['declared'], observed: ['measured'], derived: ['declared'], hypothetical: ANY}),
  'mentions': R('the source text names the target; a textual relation, never a dependency, cause or qualification',
    [ANY], [ANY], null, {authoritative: ['textual', 'declared'], derived: ['textual', 'structural'], hypothetical: ANY}),
  // ---- added in contract 1.1.0 (Slice C1, the capability and model/runtime graph) -------------------------------------
  'made-by': R('the source model was made by the target laboratory: lineage and the reviewer-exclusion input, never a restriction on who may do the work',
    ['capability/model'], ['capability/lab'], null, {authoritative: ['declared'], derived: ['declared'], hypothetical: ANY}),
  'served-by': R('the source model, lane or executable capability is served through the target provider, transport or credential pool',
    ['capability/model', 'capability/lane', 'capability/capability'], ['capability/provider', 'capability/transport', 'capability/pool'], 'to->from',
    {authoritative: STRUCT, observed: ['measured'], derived: STRUCT, hypothetical: ANY}),
  'alias-of': R('the source name denotes the target model (a thinking or effort variant, a lane name, an alias); it is not another model',
    ['capability/lane', 'capability/model'], ['capability/model'], 'to->from', {authoritative: STRUCT, derived: STRUCT, hypothetical: ANY}),
  'limited-by': R('the source is constrained by the target known limitation, which carries its source and quote; a limitation is never read as a capability',
    ['capability/capability', 'capability/runtime', 'capability/transport', 'capability/tool', 'capability/environment', 'capability/model', 'capability/lane',
      'capability/pool', 'capability/agent'], ['capability/limitation'], 'to->from',
    {authoritative: STRUCT, observed: ['measured'], derived: ['declared', 'structural', 'measured'], hypothetical: ANY}),
  'combines': R('the source executable capability is the combination of the target model or lane, runtime, transport, tool, sandbox profile (environment) or credential scope (pool); each stays its own entity',
    ['capability/capability'], ['capability/model', 'capability/lane', 'capability/runtime', 'capability/transport', 'capability/tool', 'capability/environment', 'capability/pool'],
    'to->from', {authoritative: STRUCT, derived: STRUCT, hypothetical: ANY}),
  'holds': R('the source roster chair holds the target role',
    ['capability/chair'], ['capability/role'], null, {authoritative: ['declared'], derived: ['declared'], hypothetical: ANY}),
  'places': R('the source owner- or operator-directed placement names the target role, or the model, lane or executable capability placed in it; a direction, never a measurement or a qualification',
    ['capability/placement'], ['capability/role', 'capability/model', 'capability/lane', 'capability/capability'], 'to->from',
    {authoritative: ['declared'], derived: ['declared'], hypothetical: ANY}),
  'measures': R('the source observation is a defined metric over the recorded executions of the target (its sources and coverage stated); never a qualification',
    ['evidence/observation'], ['capability/capability', 'capability/model', 'capability/lane', 'capability/runtime', 'capability/transport', 'capability/role'], null,
    {observed: ['measured'], derived: ['measured'], hypothetical: ANY}),
});
export const RELATIONSHIP_TYPES = Object.freeze(Object.keys(RELATIONSHIPS));
export const IMPACT_TYPES = Object.freeze(RELATIONSHIP_TYPES.filter(t => RELATIONSHIPS[t].impact));

const matches = (pattern, domain, type) => pattern === ANY || pattern === `${domain}/*` || pattern === `${domain}/${type}`;
/** Whether `type` may join an entity of (fromDomain, fromType) to one of (toDomain, toType). */
export function endpointAllowed(type, from, to) {
  const r = RELATIONSHIPS[type];
  if (!r) return false;
  if (r.sameType && (from.domain !== to.domain || from.type !== to.type)) return false;
  return r.from.some(p => matches(p, from.domain, from.type)) && r.to.some(p => matches(p, to.domain, to.type));
}
/** Whether `type` may be asserted as `classification` by an origin that knows by `basis`. */
export function admits(type, classification, basis) {
  const allowed = RELATIONSHIPS[type]?.admits[classification];
  return allowed === ANY || Boolean(allowed?.includes(basis));
}

/** The refusal of an id: its grammar (identity.mjs), then a registered domain and entity type (KD3). */
export function idRefusal(id) {
  const why = grammarRefusal(id);
  if (why) return why;
  const {domain, type} = parseId(id);
  if (!Object.hasOwn(DOMAINS, domain)) return `id "${id}": domain "${domain}" is not one of ${DOMAIN_NAMES.join(', ')}`;
  if (!Object.hasOwn(DOMAINS[domain].types, type)) return `id "${id}": "${type}" is not an entity type of domain "${domain}"`;
  return null;
}

/** Whether a hypothetical may override (supersede, retract, invalidate) an assertion of `targetClass`. */
export const overrides = (byClass, targetClass) => !(byClass === 'hypothetical' && targetClass !== 'hypothetical');

// ---- the assertion record (KD4) -------------------------------------------------------------------------------------
export const RECORD_FIELDS = Object.freeze(['schema', 'id', 'kind', 'subject', 'domain', 'type', 'from', 'to', 'source', 'observed_at',
  'effective_at', 'origin', 'classification', 'status', 'verified_by', 'scope', 'supersedes', 'invalidates', 'uncertainty',
  'missing_evidence', 'inputs', 'run', 'attributes']);
export const RETRACTION_FIELDS = Object.freeze(['schema', 'id', 'kind', 'retracts', 'origin', 'reason', 'observed_at']);
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_ATTRIBUTES = 32_768, MAX_SOURCE_ATTRIBUTES = 2_097_152, MAX_TEXT = 2048, MAX_LIST = 64, MAX_RECORDS = 1000;
export const SOURCE_STATES = Object.freeze(['current', 'unavailable', 'stale']);
/** At most this many changed subjects are listed in one observation record; beyond it, their count and digest. */
export const CHANGE_LIST_MAX = 10_000;
/** The digest of a set of changed subjects. */
export const changeDigest = subjects => 'sha256:' + digest([...subjects].sort());
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = MAX_TEXT) => typeof v === 'string' && v.length > 0 && v.length <= max;
const ids = (v, max = MAX_LIST) => Array.isArray(v) && v.length <= max && v.every(x => SHA256_REF.test(x)) && new Set(v).size === v.length;

/** Is this entity id a source node (evidence/source), the record a source observation writes? */
export const isSourceNode = id => typeof id === 'string' && id.includes('/evidence/source/') && grammarRefusal(id) === null && parseId(id).domain === 'evidence' && parseId(id).type === 'source';
/** The source id a source node names. */
export const sourceIdOf = id => decodeKey(parseId(id).key);

/**
 * The static refusal of an assertion record, or null: everything decidable without the graph's state. `origins` is
 * the composed origin registry (defineOrigins).
 */
export function recordRefusal(r, {origins, built = false}) {
  if (!plain(r)) return 'an assertion is an object';
  for (const k of Object.keys(r)) if (!RECORD_FIELDS.includes(k)) return `assertion field "${k}" is not in ${GRAPH_SCHEMA}`;
  for (const k of RECORD_FIELDS) if (!Object.hasOwn(r, k)) return `assertion lacks "${k}"`;
  if (r.schema !== GRAPH_SCHEMA) return `assertion schema is ${GRAPH_SCHEMA}`;
  // `built`: the record came from assertion() here, which computed its id over its canonical content; a record read or
  // received is canonicalized and its id recomputed below.
  if (!built) { try { canonical(r); } catch (e) { return `assertion is not canonical JSON: ${e.message}`; } }
  // what is asserted: an entity, or a typed relationship between two entities
  if (r.kind === 'entity') {
    const why = idRefusal(r.subject);
    if (why) return why;
    const {domain, type} = parseId(r.subject);
    if (r.domain !== domain || r.type !== type) return `entity ${r.subject}: domain and type are the id's (${domain}/${type})`;
    if (r.from !== null || r.to !== null) return `entity ${r.subject}: from and to are null`;
  } else if (r.kind === 'relationship') {
    const rel = RELATIONSHIPS[r.type];
    if (!rel) return `relationship type "${r.type}" is not registered`;
    if (r.domain !== null) return 'a relationship has no domain of its own; its endpoints do';
    for (const end of [r.from, r.to]) { const why = idRefusal(end); if (why) return why; }
    if (r.from === r.to) return `relationship ${r.type}: an entity is not related to itself`;
    const from = parseId(r.from), to = parseId(r.to);
    if (!endpointAllowed(r.type, from, to)) return `relationship ${r.type} does not join ${from.domain}/${from.type} to ${to.domain}/${to.type}`;
    if (rel.symmetric && r.to < r.from) return `relationship ${r.type} is symmetric: from is the lesser endpoint`;
    if (r.subject !== relationshipSubject(r.type, r.from, r.to, {symmetric: rel.symmetric})) return `relationship subject is ${relationshipSubject(r.type, r.from, r.to, {symmetric: rel.symmetric})}`;
  } else return 'assertion kind is entity or relationship';
  // provenance
  if (!plain(r.source)) return 'source is {id, authority, ref, version}';
  for (const k of Object.keys(r.source)) if (!['id', 'authority', 'ref', 'version'].includes(k)) return `source field "${k}" is not {id, authority, ref, version}`;
  if (!SOURCE_ID.test(r.source.id ?? '')) return 'source.id is a source name';
  if (!text(r.source.authority) || !text(r.source.ref)) return 'source.authority and source.ref name the authority and the canonical reference';
  if (r.source.version !== null && !VERSION.test(r.source.version)) return `source.version "${r.source.version}" is not a digest or immutable id`;
  if (!TIME.test(r.observed_at ?? '')) return 'observed_at is an ISO-8601 UTC time';
  if (r.effective_at !== null && !TIME.test(r.effective_at)) return 'effective_at is an ISO-8601 UTC time or null';
  // who, and how it is classified (KD5): only registered extractors, tools and rules admit; anyone registered proposes
  const o = Object.hasOwn(origins, r.origin) ? origins[r.origin] : null;
  if (!o) return `origin "${r.origin}" is not registered`;
  if (!CLASSIFICATIONS.includes(r.classification)) return `classification is one of ${CLASSIFICATIONS.join(', ')}`;
  if (r.classification !== 'hypothetical' && !ORIGIN_KINDS[o.kind].admits.includes(r.classification)) return `${o.kind} origin ${r.origin} may not admit an assertion classified ${r.classification}; it may propose a hypothetical one`;
  if (r.classification === 'authoritative' && !o.sources.includes(r.source.id)) return `extractor ${r.origin} does not project source "${r.source.id}"`;
  const unread = r.kind === 'entity' && isSourceNode(r.subject) && r.attributes?.state !== 'current';   // a source never read has no version
  if (['authoritative', 'observed'].includes(r.classification) && r.source.version === null && !unread) return `a ${r.classification} assertion names its source version`;
  if (r.kind === 'relationship' && !admits(r.type, r.classification, o.basis)) return `${r.type} may not be admitted as ${r.classification} from a ${o.basis} basis (${r.origin})`;
  if (!STATUSES.includes(r.status)) return `status is one of ${STATUSES.join(', ')}`;
  if (!ids(r.verified_by)) return 'verified_by is a list of assertion ids';
  if (r.status === 'verified' && !r.verified_by.length) return 'a verified assertion names what verified it';
  if (r.status === 'verified' && r.classification === 'hypothetical') return 'a hypothetical assertion is never verified';
  if (r.status !== 'verified' && r.verified_by.length) return 'only a verified assertion names verifiers';
  if (!plain(r.scope) || !ACCESS.includes(r.scope.access) || !INSTANCE_NAME.test(r.scope.owner ?? '') || Object.keys(r.scope).length !== 2) return `scope is {access: ${ACCESS.join('|')}, owner: an instance}`;
  if (!ids(r.supersedes) || !ids(r.invalidates)) return 'supersedes and invalidates are lists of assertion ids';
  if (r.uncertainty !== null && !text(r.uncertainty)) return 'uncertainty is text or null';
  if (!Array.isArray(r.missing_evidence) || r.missing_evidence.length > MAX_LIST || !r.missing_evidence.every(x => text(x))) return 'missing_evidence is a list of conditions';
  if (r.classification === 'hypothetical' && r.source.version === null && !r.missing_evidence.length) return 'a hypothetical without a source version states its missing evidence';
  if (!ids(r.inputs, 1000)) return 'inputs is a list of assertion ids';
  if (r.classification === 'derived' && !r.inputs.length) return 'a derived assertion names its inputs';
  if (r.classification !== 'derived' && r.inputs.length) return 'only a derived assertion names inputs';
  if (r.classification === 'observed') { if (!plain(r.run) || !text(r.run.id, 256)) return 'an observed assertion carries its run identity ({id})'; }
  else if (r.run !== null) return 'only an observed assertion carries a run';
  if (!plain(r.attributes)) return 'attributes is an object';
  const size = canonical(r.attributes).length;
  if (r.kind === 'entity' && isSourceNode(r.subject)) {
    const why = sourceRecordRefusal(r, o);
    if (why) return why;
    if (size > MAX_SOURCE_ATTRIBUTES) return `a source observation's attributes exceed ${MAX_SOURCE_ATTRIBUTES} bytes`;
  } else if (size > MAX_ATTRIBUTES) return `attributes exceed ${MAX_ATTRIBUTES} bytes`;
  if (!built && r.id !== assertionId(r)) return `assertion id is ${assertionId(r)}, the digest of its content without timestamps`;
  return null;
}

// A source observation (KD10): the extractor of that source records the version it observed, the digest of what it
// projected there, and the subjects that changed. It is the change event, and its order is the ledger's.
function sourceRecordRefusal(r, o) {
  const s = sourceIdOf(r.subject), a = r.attributes;
  if (r.classification !== 'authoritative' || o.kind !== 'extractor' || !o.sources.includes(s)) return `only the registered extractor of source "${s}" records its observations`;
  if (r.source.id !== s) return `a source observation of "${s}" names that source`;
  const keys = ['state', 'digest', 'count', 'from_version', 'changes', 'nodes', 'relationships', 'why', 'live_version'];
  for (const k of Object.keys(a)) if (!keys.includes(k)) return `source observation attribute "${k}" is not one of ${keys.join(', ')}`;
  for (const k of keys) if (!Object.hasOwn(a, k)) return `source observation lacks attribute "${k}"`;
  if (!SOURCE_STATES.includes(a.state)) return `source state is one of ${SOURCE_STATES.join(', ')}`;
  if (a.from_version !== null && !VERSION.test(a.from_version)) return 'from_version is a version or null';
  if (!Array.isArray(a.nodes) || !Array.isArray(a.relationships) || a.nodes.length + a.relationships.length > CHANGE_LIST_MAX) return `nodes and relationships list at most ${CHANGE_LIST_MAX} changed subjects`;
  if (a.nodes.some(n => idRefusal(n)) || a.relationships.some(x => typeof x !== 'string')) return 'nodes are entity ids';
  const sorted = xs => xs.every((x, i) => i === 0 || xs[i - 1] < x);
  if (!sorted(a.nodes) || !sorted(a.relationships)) return 'nodes and relationships are sorted and distinct';
  if (a.state === 'current') {
    if (r.source.version === null || !SHA256_REF.test(a.digest ?? '') || !Number.isInteger(a.count) || a.count < 0 || a.why !== null || a.live_version !== null) return 'a current observation names its version, the digest and count of what it projected, and no why';
    // What changed: always its count and digest; the subjects themselves while they fit (bounded storage), else they
    // are re-derived by replay from the two versions.
    const c = a.changes;
    if (!plain(c) || Object.keys(c).length !== 3 || !Number.isInteger(c.count) || c.count < 0 || !SHA256_REF.test(c.digest ?? '') || typeof c.listed !== 'boolean') return 'changes is {count, digest, listed}';
    if (c.listed !== (c.count <= CHANGE_LIST_MAX)) return `the changed subjects are listed exactly when there are at most ${CHANGE_LIST_MAX}`;
    if (c.listed ? changeDigest([...a.nodes, ...a.relationships]) !== c.digest || a.nodes.length + a.relationships.length !== c.count : a.nodes.length + a.relationships.length !== 0) return 'the listed changes are the ones the digest names';
  } else {
    if (a.digest !== null || a.count !== null || a.changes !== null || a.nodes.length || a.relationships.length || !text(a.why)) return `an ${a.state} observation changes nothing and says why`;
    if (a.live_version !== null && !VERSION.test(a.live_version)) return 'live_version is a version or null';
    if (a.state === 'unavailable' && a.live_version !== null) return 'an unavailable source has no live version';
  }
  return null;
}

/** The static refusal of a retraction record ({id, retracts, origin, reason, observed_at}), or null. */
export function retractionRefusal(r, {origins}) {
  if (!plain(r)) return 'a retraction is an object';
  for (const k of Object.keys(r)) if (!RETRACTION_FIELDS.includes(k)) return `retraction field "${k}" is not in ${GRAPH_SCHEMA}`;
  for (const k of RETRACTION_FIELDS) if (!Object.hasOwn(r, k)) return `retraction lacks "${k}"`;
  if (r.schema !== GRAPH_SCHEMA || r.kind !== 'retraction') return 'a retraction is {schema, kind: retraction, ...}';
  if (!SHA256_REF.test(r.retracts ?? '')) return 'retracts names an assertion id';
  if (!Object.hasOwn(origins, r.origin)) return `origin "${r.origin}" is not registered`;
  if (!text(r.reason)) return 'a retraction states its reason';
  if (!TIME.test(r.observed_at ?? '')) return 'observed_at is an ISO-8601 UTC time';
  if (r.id !== assertionId(r)) return `retraction id is ${assertionId(r)}`;
  return null;
}

export const KINDS = Object.freeze(['graph.assert', 'graph.retract', 'graph.supersede']);
/** The static refusal of a graph ledger payload of `kind`, or null. */
export function payloadRefusal(kind, p, {origins}) {
  if (!plain(p) || p.schema !== GRAPH_SCHEMA) return `a graph payload is {schema: ${GRAPH_SCHEMA}, ...}`;
  if (kind === 'graph.retract') {
    if (Object.keys(p).length !== 2 || !Array.isArray(p.retractions) || !p.retractions.length || p.retractions.length > MAX_RECORDS) return `graph.retract carries 1 to ${MAX_RECORDS} retractions`;
    for (const x of p.retractions) { const why = retractionRefusal(x, {origins}); if (why) return why; }
    if (new Set(p.retractions.map(x => x.id)).size !== p.retractions.length) return 'a payload names a retraction once';
    return null;
  }
  if (!KINDS.includes(kind)) return `kind ${kind} is not a graph kind`;
  if (Object.keys(p).length !== 2 || !Array.isArray(p.records) || !p.records.length || p.records.length > MAX_RECORDS) return `${kind} carries 1 to ${MAX_RECORDS} records`;
  for (const r of p.records) {
    const why = recordRefusal(r, {origins});
    if (why) return why;
    if (kind === 'graph.assert' && r.supersedes.length) return 'graph.assert admits new assertions; a replacement is graph.supersede';
    if (kind === 'graph.supersede' && !r.supersedes.length) return 'graph.supersede names the assertions it replaces';
  }
  if (new Set(p.records.map(r => r.id)).size !== p.records.length) return 'a payload names an assertion once';
  return null;
}

// ---- record builders ------------------------------------------------------------------------------------------------
/**
 * A full assertion record from a draft, its id computed. Entity: {entity: id} or {domain, type, key}; relationship:
 * {type, from, to} (a symmetric type's endpoints are ordered here).
 */
export function assertion(d) {
  const instance = d.instance ?? DEFAULT_INSTANCE;
  let kind, subject, domain = null, type, from = null, to = null;
  if (d.kind ? d.kind === 'relationship' : d.from !== undefined && d.from !== null) {
    kind = 'relationship'; type = d.type;
    const rel = RELATIONSHIPS[type];
    [from, to] = rel?.symmetric && d.to < d.from ? [d.to, d.from] : [d.from, d.to];
    subject = relationshipSubject(type, from, to, {symmetric: Boolean(rel?.symmetric)});
  } else {
    kind = 'entity';
    subject = d.entity ?? `${instance}/${d.domain}/${d.type}/${d.key}`;
    const p = grammarRefusal(subject) ? {domain: d.domain ?? null, type: d.type ?? null} : parseId(subject);
    domain = p.domain; type = p.type;
  }
  const r = {schema: GRAPH_SCHEMA, id: null, kind, subject, domain, type, from, to,
    source: d.source, observed_at: d.observed_at, effective_at: d.effective_at ?? null, origin: d.origin,
    classification: d.classification, status: d.status ?? 'unverified', verified_by: d.verified_by ?? [],
    scope: d.scope ?? {access: 'internal', owner: instance}, supersedes: d.supersedes ?? [], invalidates: d.invalidates ?? [],
    uncertainty: d.uncertainty ?? null, missing_evidence: d.missing_evidence ?? [], inputs: d.inputs ?? [], run: d.run ?? null,
    attributes: d.attributes ?? {}};
  r.id = assertionId(r);
  return r;
}
/** A full retraction record. */
export function retraction({retracts, origin, reason, observed_at}) {
  const r = {schema: GRAPH_SCHEMA, id: null, kind: 'retraction', retracts, origin, reason, observed_at};
  r.id = assertionId(r);
  return r;
}
/** The record content that decides whether a source fact changed between versions: no id, timestamps, version or supersession. */
export function factDigestOf(r) {
  const c = contentOf(r);
  return canonical({...c, supersedes: [], source: {...c.source, version: null}});
}

// ---- the registry as the contract document tabulates it -------------------------------------------------------------
const list = xs => xs.join(', ');
const admitsText = a => CLASSIFICATIONS.filter(c => Object.hasOwn(a, c)).map(c => `${c}: ${a[c] === ANY ? 'any basis' : list(a[c])}`).join('; ');
const impactText = i => (i === 'to->from' ? 'to → from' : i === 'from->to' ? 'from → to' : 'not followed');
/** The relationship registry as rows: [type, meaning, from, to, symmetric, inverse, impact, admitted as]. */
export function relationshipRows() {
  return RELATIONSHIP_TYPES.map(t => {
    const r = RELATIONSHIPS[t];
    return [t, r.meaning + (r.sameType ? ' (same domain and type)' : ''), list(r.from), list(r.to), r.symmetric ? 'yes' : 'no', r.inverse ?? '—', impactText(r.impact), admitsText(r.admits)];
  });
}
/** The entity types as rows: [domain, graph, type, meaning]. */
export function entityRows() {
  return DOMAIN_NAMES.flatMap(d => Object.entries(DOMAINS[d].types).map(([t, x]) => [d, DOMAINS[d].graph, t, x.meaning]));
}
