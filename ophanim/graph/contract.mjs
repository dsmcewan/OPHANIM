// THE GRAPH CONTRACT (owner specification "Federated Knowledge Graph Architecture & Implementation", 2026-11-20;
// docs/knowledge-graph/architecture.md). One identity scheme, one assertion shape and one closed table of relationship
// types for five knowledge domains. Nothing here stores anything: store.mjs keeps what this module admits.
//
// Purpose   Say what an entity is, what a relationship means and in which direction, and what every assertion must
//           carry about where it came from. Refuse everything else, by name.
// Inputs    An assertion (plain JSON) and the instance it is offered to.
// Outputs   null when it is admitted, else {code, why}. Identities and digests of an admitted assertion.
// Invariants
//   - An identity names its instance, domain and type; a relationship is admitted only between the endpoint types its
//     row allows, in the direction its row states.
//   - Every assertion names its source (authority, reference, version) and its origin (who or what made it).
//   - What a model or an agent says is a HYPOTHESIS: it is never admitted as observed, derived or authoritative, and
//     never as verified. An authorized mechanism admits it as its own assertion, with evidence (work-ledger.mjs).
//   - `verified` and `qualified` name evidence. `authoritative` names an authority that is signed or owner-kept.
// Must never  Admit an edge because two things look alike; let a later assertion erase an earlier one (store.mjs keeps
//           history); be imported by packages/ledger or pantheon (the layering rule).
import {digest} from '../../packages/ledger/index.mjs';

export const GRAPH_SCHEMA = 'ophanim.graph/v1';

/** The five knowledge domains and the entity types of each. */
export const DOMAINS = Object.freeze({
  // A. What each model, runtime and tool can do. `executable` is a model IN a runtime: the thing that is seated.
  capability: ['lab', 'provider', 'model', 'runtime', 'executable', 'feature', 'role', 'tool'],
  // B. What is built: bricks (component, capability), mortar (interface, data), building codes (contract, test).
  systems: ['repository', 'component', 'capability', 'contract', 'test', 'mutation', 'interface', 'data-store', 'dataset', 'process', 'department', 'application', 'environment'],
  // C. How it is known: what was required, seen, supposed, decided, and what was delivered to whom.
  evidence: ['requirement', 'source', 'observation', 'hypothesis', 'claim', 'decision', 'authorization', 'investigation', 'review'],
  // D. What went wrong, what was done about it, and what that taught.
  learning: ['failure-class', 'defect', 'correction', 'lesson', 'limitation', 'detection-gap'],
  // E. What work exists, why, and what it used.
  work: ['prompt', 'item', 'ticket', 'plan', 'unit', 'stage', 'team', 'artifact', 'checkpoint', 'budget', 'obligation'],
});

export const CLASSES = Object.freeze(['hypothetical', 'derived', 'observed', 'authoritative']);   // weakest first
export const STATUSES = Object.freeze(['verified', 'qualified', 'unverified', 'disputed', 'unresolved']);
export const SCOPES = Object.freeze(['internal', 'shared', 'restricted']);
export const ORIGINS = Object.freeze(['extractor', 'operator', 'tool', 'agent', 'model']);
/** Where an assertion can come from. `signed` authorities are ledgers or owner-kept records; only they are authoritative. */
export const AUTHORITIES = Object.freeze({
  'status-ledger': {signed: true}, 'work-ledger': {signed: true}, 'run-ledger': {signed: true}, config: {signed: true},
  'lessons-registry': {signed: true}, register: {signed: true}, repository: {signed: false}, federation: {signed: false},
});

// IMPACT: who must be looked at again when one end of the edge changes. 'forward': a change of `from` reaches `to`.
// 'backward': a change of `to` reaches `from`. 'both', or null for an edge that carries history and no dependency.
const R = (from, to, impact, meaning) => Object.freeze({from, to, impact, meaning});
/** The closed table of relationship types: allowed endpoints (`domain:type`, `domain:*`), direction and meaning. */
export const RELATIONS = Object.freeze({
  implements: R(['systems:component'], ['systems:capability', 'systems:contract', 'systems:interface'], 'both', 'from provides the behaviour that to names'),
  'depends-on': R(['systems:*', 'work:item', 'work:unit'], ['systems:*', 'work:item', 'work:unit'], 'backward', 'from cannot work, or cannot start, without to'),
  consumes: R(['systems:*'], ['systems:*'], 'backward', 'from reads what to holds or emits'),
  produces: R(['systems:*', 'work:*'], ['systems:*', 'work:*', 'evidence:*'], 'forward', 'from makes to'),
  governs: R(['systems:contract', 'learning:limitation', 'evidence:decision'], ['systems:*', 'work:*', 'capability:*'], 'forward', 'to must satisfy from'),
  authorizes: R(['evidence:authorization', 'evidence:decision'], ['work:*', 'capability:*', 'systems:*'], 'forward', 'from permits to'),
  verifies: R(['systems:test', 'systems:mutation', 'evidence:review'], ['systems:*', 'work:artifact', 'evidence:claim'], 'both', 'from checks to, and its verdict is about the version of to it ran on'),
  'derived-from': R(['*'], ['*'], 'backward', 'from was made out of to'),
  supports: R(['evidence:*'], ['evidence:claim', 'evidence:hypothesis', 'evidence:decision'], 'forward', 'from is evidence for to'),
  contradicts: R(['evidence:*'], ['evidence:*'], 'forward', 'from is evidence against to'),
  supersedes: R(['*'], ['*'], null, 'from replaces to; to is kept'),
  'introduced-because-of': R(['systems:*', 'learning:correction', 'work:*'], ['evidence:*', 'learning:*', 'work:prompt', 'work:item'], null, 'to is the reason from exists'),
  invalidates: R(['*'], ['*'], 'forward', 'from makes what was established about to no longer hold'),
  'qualified-for': R(['capability:executable', 'capability:model', 'systems:component'], ['capability:role', 'systems:capability'], 'forward', 'from is eligible to do to, on the evidence the assertion names'),
  'contributed-to': R(['capability:*'], ['work:*', 'evidence:*'], null, 'from took part in making to'),
  'shares-failure-mechanism-with': R(['learning:defect', 'learning:failure-class'], ['learning:defect', 'learning:failure-class'], null, 'from and to fail by the same mechanism (an established cause, not a resemblance)'),
  // The rest of what the five domains need to be connected.
  'requires-capability': R(['work:*'], ['systems:capability', 'capability:feature'], 'backward', 'from cannot be done until to exists and is qualified'),
  'runs-in': R(['capability:model'], ['capability:runtime'], 'backward', 'from is executed by to'),
  provides: R(['capability:runtime', 'capability:executable', 'capability:model'], ['capability:feature', 'capability:tool'], 'forward', 'from has to'),
  'member-of': R(['capability:model', 'capability:provider', 'capability:executable'], ['capability:lab', 'capability:provider', 'capability:model', 'capability:runtime'], 'backward', 'from belongs to to'),
  'part-of': R(['*'], ['*'], null, 'from is contained in to'),
  'instance-of': R(['learning:defect'], ['learning:failure-class'], null, 'from is one occurrence of to'),
  corrects: R(['learning:correction'], ['learning:defect', 'learning:failure-class'], null, 'from repairs to'),
  detects: R(['systems:test', 'systems:mutation'], ['learning:failure-class', 'learning:defect'], null, 'from fails when to recurs'),
  'documented-in': R(['*'], ['learning:lesson', 'learning:limitation', 'evidence:source'], null, 'to is where from is written down'),
  'applies-to': R(['learning:lesson', 'learning:limitation', 'learning:failure-class'], ['systems:*', 'capability:*', 'work:*'], null, 'from is relevant to to, under the conditions the assertion names'),
  modifies: R(['work:unit', 'work:stage', 'work:artifact'], ['systems:*'], null, 'from changes to'),
  'assigned-to': R(['work:*'], ['capability:*'], null, 'to does from'),
  // Evidence delivery, kept apart: available, supplied, retrieved, cited and independently checked are five facts.
  'supplied-to': R(['evidence:*', 'systems:*'], ['work:stage', 'work:team'], null, 'from was put in front of to'),
  'retrieved-by': R(['evidence:*', 'systems:*'], ['work:stage', 'work:team'], null, 'to asked for from and was given it'),
  'cited-by': R(['evidence:*', 'systems:*'], ['work:*', 'evidence:claim', 'evidence:decision'], 'forward', 'to names from as its ground'),
  'checked-by': R(['evidence:*', 'systems:*'], ['evidence:review', 'work:stage'], null, 'to read from itself and compared it with what was claimed'),
  'same-as': R(['*'], ['*'], null, 'from and to are one thing under two instances\' names'),
});

const INSTANCE = /^[a-z][a-z0-9-]{0,31}$/;
// eslint-disable-next-line no-control-regex
const KEY = /^[^\s\u0000-\u001f]{1,400}$/;
const str = v => typeof v === 'string' && v.length > 0;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const no = (code, why) => ({code, why});

/** `<instance>:<domain>:<type>:<key>` -> its parts, or null. The key may itself hold ':' and '/'. */
export function parseId(id) {
  if (!str(id)) return null;
  const [instance, domain, type, ...rest] = id.split(':');
  const key = rest.join(':');
  if (!INSTANCE.test(instance ?? '') || !Object.hasOwn(DOMAINS, domain ?? '') || !DOMAINS[domain].includes(type) || !KEY.test(key)) return null;
  return {instance, domain, type, key};
}
export const idOf = (instance, domain, type, key) => `${instance}:${domain}:${type}:${key}`;
const matches = (p, patterns) => patterns.some(x => x === '*' || x === `${p.domain}:*` || x === `${p.domain}:${p.type}`);

/** What an assertion is about: the entity's id, or the relationship's type and ends. */
export const subjectOf = a => (a.kind === 'entity' ? {id: a.id} : {rel: a.rel, from: a.from, to: a.to});
/** One source's statement about one subject: a later statement in the same slot supersedes the earlier one. */
export const slotOf = a => 'sha256:' + digest({subject: subjectOf(a), authority: a.source.authority, ref: a.source.ref, origin: {kind: a.origin.kind, name: a.origin.name}});
/** The assertion itself, without when it was seen: the same statement from the same version is the same assertion. */
export const aidOf = a => { const {observed_at, ...rest} = a; return 'sha256:' + digest(rest); };

const KEYS = new Set(['kind', 'id', 'rel', 'from', 'to', 'attrs', 'source', 'origin', 'class', 'status', 'scope', 'observed_at', 'effective_at', 'evidence', 'uncertainty']);

/**
 * Why `a` is not admitted to the graph of `instance`, or null. `foreign` allows identities of other instances: only the
 * federation projection passes it (federation.mjs), for what another instance exported.
 */
export function assertionRefusal(a, {instance, foreign = false} = {}) {
  if (!isObject(a)) return no('GRAPH_SHAPE', 'an assertion is an object');
  for (const k of Object.keys(a)) if (!KEYS.has(k)) return no('GRAPH_SHAPE', `"${k}" is not a field of an assertion`);
  const ids = [];
  if (a.kind === 'entity') {
    if (a.rel !== undefined || a.from !== undefined || a.to !== undefined) return no('GRAPH_SHAPE', 'an entity assertion names no relationship');
    ids.push(['id', a.id]);
  } else if (a.kind === 'relation') {
    if (a.id !== undefined) return no('GRAPH_SHAPE', 'a relationship assertion names its ends, not an id');
    if (!Object.hasOwn(RELATIONS, a.rel ?? '')) return no('GRAPH_RELATION', `"${a.rel}" is not a relationship type of ${GRAPH_SCHEMA}`);
    ids.push(['from', a.from], ['to', a.to]);
  } else return no('GRAPH_SHAPE', 'kind is entity or relation');
  const parsed = {};
  for (const [field, id] of ids) {
    const p = parseId(id);
    if (!p) return no('GRAPH_IDENTITY', `${field} "${String(id).slice(0, 120)}" is not <instance>:<domain>:<type>:<key> with a domain and type of ${GRAPH_SCHEMA}`);
    parsed[field] = p;
  }
  // An instance speaks for itself. An entity of another instance is asserted only by that instance; an edge to one is
  // admitted only through the federation projection, from what that instance exported.
  if (!INSTANCE.test(instance ?? '')) return no('GRAPH_IDENTITY', 'the graph has no instance name');
  if (!foreign) for (const [field, p] of Object.entries(parsed)) if (p.instance !== instance) return no('GRAPH_FOREIGN_INSTANCE', `${field} belongs to instance "${p.instance}"; this is the graph of "${instance}"`);
  if (a.kind === 'relation') {
    const row = RELATIONS[a.rel];
    if (!matches(parsed.from, row.from)) return no('GRAPH_ENDPOINT', `${a.rel} does not start at a ${parsed.from.domain}:${parsed.from.type} (allowed: ${row.from.join(', ')})`);
    if (!matches(parsed.to, row.to)) return no('GRAPH_ENDPOINT', `${a.rel} does not end at a ${parsed.to.domain}:${parsed.to.type} (allowed: ${row.to.join(', ')})`);
    if (a.from === a.to) return no('GRAPH_ENDPOINT', `${a.rel} from a thing to itself says nothing`);
  }
  if (a.attrs !== undefined && !isObject(a.attrs)) return no('GRAPH_SHAPE', 'attrs is an object');
  // PROVENANCE: where it is written, in which version, and who or what read it there.
  const s = a.source, o = a.origin;
  if (!isObject(s) || !Object.hasOwn(AUTHORITIES, s.authority ?? '') || !str(s.ref) || !str(s.version)) return no('GRAPH_PROVENANCE', `an assertion names its source: authority (${Object.keys(AUTHORITIES).join(', ')}), ref and version`);
  if (!isObject(o) || !ORIGINS.includes(o.kind) || !str(o.name)) return no('GRAPH_PROVENANCE', `an assertion names its origin: kind (${ORIGINS.join(', ')}) and name`);
  if (s.authority === 'federation' && !foreign) return no('GRAPH_PROVENANCE', 'only the federation projection admits what another instance exported');
  if (!CLASSES.includes(a.class)) return no('GRAPH_CLASS', `class is one of ${CLASSES.join(', ')}`);
  if (!STATUSES.includes(a.status)) return no('GRAPH_STATUS', `status is one of ${STATUSES.join(', ')}`);
  if (a.scope !== undefined && !SCOPES.includes(a.scope)) return no('GRAPH_SCOPE', `scope is one of ${SCOPES.join(', ')}`);
  if (a.evidence !== undefined && !(Array.isArray(a.evidence) && a.evidence.every(e => isObject(e) && str(e.ref) && str(e.version)))) return no('GRAPH_SHAPE', 'evidence is a list of {ref, version}');
  if (a.uncertainty !== undefined && !(Array.isArray(a.uncertainty) && a.uncertainty.every(str))) return no('GRAPH_SHAPE', 'uncertainty is a list of sentences');
  for (const t of ['observed_at', 'effective_at']) if (a[t] !== undefined && !(str(a[t]) && !Number.isNaN(Date.parse(a[t])))) return no('GRAPH_SHAPE', `${t} is a timestamp`);
  // WHAT A MODEL OR AN AGENT SAYS IS A HYPOTHESIS, whatever it is about and however sure it sounds.
  if ((o.kind === 'model' || o.kind === 'agent') && (a.class !== 'hypothetical' || a.status === 'verified' || a.status === 'qualified')) {
    return no('GRAPH_MODEL_CLAIM', `an assertion made by ${o.kind === 'model' ? 'a model' : 'an agent'} (${o.name}) is hypothetical and unverified until an authorized mechanism admits it with evidence; it was offered as ${a.class}/${a.status}`);
  }
  if (a.class === 'authoritative' && !AUTHORITIES[s.authority].signed) return no('GRAPH_CLASS', `${s.authority} is not an authority: what is read from it is observed or derived`);
  if (a.class === 'derived' && !(o.kind === 'extractor' || o.kind === 'tool')) return no('GRAPH_CLASS', 'a derived assertion is made by a deterministic extractor or tool');
  if ((a.status === 'verified' || a.status === 'qualified') && !(a.evidence?.length)) return no('GRAPH_STATUS', `${a.status} names the evidence it rests on`);
  if (a.class === 'hypothetical' && (a.status === 'verified' || a.status === 'qualified')) return no('GRAPH_STATUS', 'a hypothesis is not verified');
  return null;
}

/** What a graph record of the work ledger is about, as one digest: the same subject is not recorded twice in a phase. */
export const subjectDigest = subject => 'sha256:' + digest(subject.kind === 'entity' ? {id: subject.id} : {rel: subject.rel, from: subject.from, to: subject.to});
/**
 * The assertion a work-ledger graph record makes (work-ledger.mjs `work.graph`), as the projection reads it: its source
 * is the ledger entry itself, its origin whoever the record names. `hash` is the entry's hash.
 */
export function recordAssertion(p, hash) {
  const s = p.subject ?? {};
  return {kind: s.kind, ...(s.kind === 'entity' ? {id: s.id} : {rel: s.rel, from: s.from, to: s.to}), ...(s.attrs !== undefined ? {attrs: s.attrs} : {}),
    source: {authority: 'work-ledger', ref: `entry:${hash}`, version: hash}, origin: {kind: p.by?.kind, name: p.by?.name}, class: p.class, status: p.status,
    ...(p.scope !== undefined ? {scope: p.scope} : {}), ...(p.evidence !== undefined ? {evidence: p.evidence} : {}), ...(p.uncertainty !== undefined ? {uncertainty: p.uncertainty} : {}), ...(p.at ? {observed_at: p.at} : {})};
}

/** The cursor of a source: how far the projection has read it. Any non-empty string; the source decides its meaning. */
export const cursorOk = c => c === null || (str(c) && c.length <= 200);
