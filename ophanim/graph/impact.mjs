// IMPACT, REASSESSMENT, TRACEABILITY AND THE SECTION-8 QUERIES over the systems and evidence graph (Slice B, KB2, KB3,
// KB5; docs/knowledge-graph/slice-b.md).
//
// Purpose   Answer, from what the registered sources state, what a change reaches and where a component comes from:
//   impact      a changed file, contract or commit range -> its affected neighbourhood: the reverse closure along the
//               ESTABLISHED relationships that carry a change of content (packages/graph traverse.mjs `closure`, impact
//               types only), each node with its explained path; then, ONE hop and never further, the qualifications to
//               reassess (a check whose subject changed: `verifies`, `detects`, ...) and the records that cite them
//               (`mentions`, named for reassessment, never declared affected). Bounded; never a global invalidation.
//   reassess    a change event (a source observed changed, unavailable or stale) -> a RECORDED reassessment set: what is
//               affected and why, appended to the graph ledger as a derived `work/discovery` of the registered impact
//               rule, derived from the observation that caused it. It never claims completion; for a source that cannot
//               be read, its facts are listed as unverifiable, never as current.
//   trace       a component -> backward: the requirement that introduced it, the decisions, the evidence, the
//               implementing commits, the tests that verify it, and the later corrections. Only what a source states:
//               a link no source states is a GAP, reported as one, never filled by resemblance.
//   answer      the directive's section 8 queries (why, requirement, governs, dependents, evidence, changed-since,
//               invalidates, unknown), each bounded, explained, with its sources and versions.
//   graphView   the same, as REFERENCES to the underlying records (source, version, why included, the retrieval that
//               returns the original), for the context operation (ophanim/operate/context.mjs `graph`).
// Inputs    A graph opened over Slice B's sources (extract/index.mjs) or a view of one at a cursor.
// Must never  Follow a non-impact relationship (a mention, a contradiction) as a change; propagate through a
//           qualification; widen to the whole graph; fill a gap by inference; report a source that cannot be read as
//           current; stand a summary in for the records it refers to.
import {closure, contradictions, neighborhood, affected, freshness, IMPACT_TYPES, RELATIONSHIPS, parseId, idRefusal, assertion,
  entityId, DEFAULTS, CEILINGS} from '../../packages/graph/index.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';
import {changedBetween, COMMIT} from './extract/git.mjs';
import {fileId, changeId, contractId, itemId} from './extract/repo.mjs';
import {recordId} from './extract/records.mjs';

/** The registered rule that records a reassessment set: derived from the source observation that caused it. */
export const IMPACT_RULE = 'ophanim.impact.rule';

/** Relationships that carry a change of a check's SUBJECT to its qualification: reported one hop, never propagated. */
export const QUALIFY_TYPES = Object.freeze(['verifies', 'verified-by', 'detects', 'supports']);
/** The impact-following types a change of content propagates along (the registry's impact types less the above). */
export const CHANGE_TYPES = Object.freeze(IMPACT_TYPES.filter(t => !QUALIFY_TYPES.includes(t)));
/** How many members of a list an answer shows; the rest are counted, never dropped silently. */
export const LIST_MAX = 50;
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const kindOf = id => { const p = parseId(id); return `${p.domain}/${p.type}`; };
const keyOf = id => decodeURIComponent(parseId(id).key);
const cap = (xs, n = LIST_MAX) => ({shown: xs.slice(0, n), total: xs.length, more: Math.max(0, xs.length - n)});

// ---- subjects -------------------------------------------------------------------------------------------------------
/**
 * The graph id a caller names: an id; a repository path; `L-504` / `KG-1` (a register entry); `item:<id>`;
 * `schema:<id>` or a schema id (a contract); `commit:<40 hex>`. {id} or {error, why}.
 */
export function subjectOf(view, s) {
  if (typeof s !== 'string' || !s) return {error: 'BAD_REQUEST', why: 'a subject is an id, a repository path, an entry id, item:<id>, schema:<id> or commit:<id>'};
  const tryId = id => (view.nodeIn(id, 'recorded') ? {id} : null);
  if (!idRefusal(s)) return tryId(s) ?? {error: 'NOT_FOUND', why: `${s} is not in the graph at cursor ${view.seq}`};
  if (/^(L-\d{3}|KG-\d+)$/.test(s)) return tryId(recordId(s)) ?? {error: 'NOT_FOUND', why: `register entry ${s} is not in the graph`};
  if (s.startsWith('item:')) return tryId(itemId(s.slice(5))) ?? {error: 'NOT_FOUND', why: `item ${s.slice(5)} is not in the graph`};
  if (s.startsWith('commit:') && COMMIT.test(s.slice(7))) return tryId(changeId(s.slice(7))) ?? {error: 'NOT_FOUND', why: `commit ${s.slice(7)} is not in the graph`};
  const schema = s.startsWith('schema:') ? s.slice(7) : /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+\/v\d+$/.test(s) ? s : null;
  if (schema) return tryId(contractId(schema)) ?? {error: 'NOT_FOUND', why: `contract ${schema} is not in the graph`};
  try { return tryId(fileId(s)) ?? {error: 'NOT_FOUND', why: `${s} is not a file of the repository at the graph's commit`}; }
  catch { return {error: 'BAD_REQUEST', why: `${s} is not a subject the graph can name`}; }
}

// ---- explanation and sources ----------------------------------------------------------------------------------------
const sourceOf = a => ({source: a.source.id, version: a.source.version, ref: a.source.ref, assertion: a.id, classification: a.classification, origin: a.origin});
/** One traversal node, explained: its type, depth, the path from a seed (each step with its supporting source), its sources. */
export function explain(view, n) {
  return {id: n.id, kind: kindOf(n.id), depth: n.depth, established: n.established,
    via: n.path.map(p => ({type: p.type, from: p.from, to: p.to, sources: p.assertions.map(id => view.assertion(id)).filter(Boolean).map(sourceOf)})),
    sources: n.assertions.map(sourceOf)};
}
const edgeSources = (view, e) => e.assertions.map(id => view.assertion(id)).filter(Boolean).map(sourceOf);
/** Every source a result rests on, with the state the graph recorded for it (and whether it was re-derived). */
function sourcesTable(view, ids) {
  const recorded = new Map(view.sources().map(s => [s.id, s]));
  return [...ids].sort(byString).map(id => {
    const s = recorded.get(id);
    return {source: id, version: s?.version ?? null, state: s ? (s.state === 'current' && s.replay === 'applied' ? 'current' : s.state === 'current' ? `recorded current, not re-derived here (${s.replay})` : s.state) : 'never-observed',
      observed_at: s?.observed_at ?? null, seq: s?.seq ?? null};
  });
}

// ---- impact (KB2) ---------------------------------------------------------------------------------------------------
const GROUPS = [['consumers', k => k === 'systems/module' || k === 'systems/symbol'], ['tests', k => k === 'systems/test'], ['suites', k => k === 'systems/suite'],
  ['workflows', k => k === 'systems/workflow'], ['mutations', k => k === 'systems/mutation'], ['contracts', k => k === 'systems/contract'],
  ['work', k => k.startsWith('work/')], ['records', k => k.startsWith('evidence/') || k.startsWith('learning/')], ['other', () => true]];
const groupOf = id => GROUPS.find(([, f]) => f(kindOf(id)))[0];

/**
 * The affected neighbourhood of a change to `seeds` (ids), at `view`. Options: depth, maxNodes, maxEdges (the
 * traversal's bounds), continuation. A contract seed is reached through what carries it (`implements`): a change of the
 * contract is a change of the constants that carry it, and the closure starts from them too.
 */
export function impact(view, seeds, opts = {}) {
  const start = [...new Set([seeds].flat())].sort(byString);
  for (const s of start) if (!view.nodeIn(s, 'possible')) return {error: 'NOT_FOUND', why: `${s} is not in the graph at cursor ${view.seq}`};
  const carriers = [];
  for (const s of start) if (kindOf(s) === 'systems/contract') {
    for (const e of view.edgesOf(s, {mode: 'established', types: ['implements']})) if (e.to === s) carriers.push({carrier: e.from, contract: s, edge: e.subject, sources: edgeSources(view, e)});
  }
  const walkFrom = [...new Set([...start, ...carriers.map(c => c.carrier)])].sort(byString);
  const reach = opts.continuation ? closure(view, null, {continuation: opts.continuation})
    : closure(view, walkFrom, {direction: 'reverse', types: [...CHANGE_TYPES], depth: opts.depth, maxNodes: opts.maxNodes, maxEdges: opts.maxEdges, mode: 'established'});
  const nodes = reach.nodes.map(n => explain(view, n)), reached = new Set(nodes.map(n => n.id));
  const affectedGroups = Object.fromEntries(GROUPS.map(([g]) => [g, []]));
  for (const n of nodes) if (!walkFrom.includes(n.id)) affectedGroups[groupOf(n.id)].push(n);
  // ONE hop: checks of an affected node (its subject changed, so what it established is to be reassessed), and the
  // records that cite an affected node or that it cites. Neither is followed further.
  const qualifications = new Map(), citing = new Map();
  for (const id of reached) {
    for (const e of view.edgesOf(id, {mode: 'established', types: [...QUALIFY_TYPES]})) {
      const imp = RELATIONSHIPS[e.type].impact, [cause, dependent] = imp === 'to->from' ? [e.to, e.from] : [e.from, e.to];
      if (cause !== id || qualifications.has(e.subject)) continue;
      qualifications.set(e.subject, {qualification_of: dependent, because: cause, relationship: {type: e.type, from: e.from, to: e.to}, sources: edgeSources(view, e),
        why: `${keyOf(cause)} is in the changed neighbourhood and ${e.type === 'verifies' || e.type === 'verified-by' ? 'verifies' : e.type} ${keyOf(dependent)}: what it established is to be reassessed (not propagated further)`});
    }
    for (const e of view.edgesOf(id, {mode: 'possible', types: ['mentions']})) {
      if (citing.has(e.subject)) continue;
      const other = e.from === id ? e.to : e.from;
      citing.set(e.subject, {record: other, names: id, direction: e.from === id ? `${keyOf(id)} cites it` : `it names ${keyOf(id)}`, relationship: {type: e.type, from: e.from, to: e.to},
        sources: edgeSources(view, e), why: 'a textual mention: named for reassessment, never declared affected'});
    }
  }
  const sources = new Set(nodes.flatMap(n => n.sources.map(s => s.source)));
  for (const q of qualifications.values()) for (const s of q.sources) sources.add(s.source);
  for (const c of citing.values()) for (const s of c.sources) sources.add(s.source);
  return {query: 'impact', cursor: view.seq, seeds: start, carriers, affected: affectedGroups,
    counts: Object.fromEntries(Object.entries(affectedGroups).map(([g, xs]) => [g, xs.length])),
    qualifications: [...qualifications.values()].sort((a, b) => byString(a.qualification_of, b.qualification_of)),
    citing: [...citing.values()].sort((a, b) => byString(a.record, b.record)),
    coverage: {...reach.coverage, types: [...CHANGE_TYPES]}, continuation: reach.continuation, sources: sourcesTable(view, sources),
    note: 'targeted: only what an established change-carrying relationship reaches from the seeds; everything else is untouched by this change'};
}

/** Impact of the commit range `from..to` of `repo`, on a view of the repository AT `to`: the changed paths are the seeds. */
export function impactOfRange(view, {repo, from, to, ...opts}) {
  const changed = changedBetween(repo, from, to);
  const seeds = [], removed = [], absent = [];
  for (const c of changed) {
    const id = fileId(c.path);
    if (c.status === 'D') removed.push(c.path);
    else if (view.nodeIn(id, 'established')) seeds.push(id);
    else absent.push(c.path);
  }
  const r = seeds.length ? impact(view, seeds, opts) : {query: 'impact', cursor: view.seq, seeds: [], affected: {}, counts: {}, qualifications: [], citing: [], coverage: {truncated: false}, continuation: null, sources: []};
  return {...r, range: {from, to, changed: changed.length, removed,
    absent: absent.length ? {paths: absent, why: 'changed in the range but not established in this view: the graph is not observed at the range\'s end'} : null}};
}

// ---- reassessment (KB2, demonstration 7) ----------------------------------------------------------------------------
export const discoveryId = key => entityId({domain: 'work', type: 'discovery', key});
const REASSESS_MAX = 200, REASSESS_BYTES = 24_000;
/**
 * The reassessment set of a change event (`graph.observe(...).event`, or one of `graph.events()`), RECORDED: a derived
 * `work/discovery/reassess/<event seq>` assertion of the impact rule, derived from the observation that caused it.
 * `by`: the rule's writer {signer, order}. Returns {recorded, id, set}. A source that could not be read (unavailable)
 * or projected (stale) yields the facts it last gave and what rests on them, each UNVERIFIABLE; nothing is current.
 */
export function reassess(graph, event, {by, observed_at = new Date().toISOString(), bounds = {}} = {}) {
  const view = graph.view(event.seq), set = reassessmentSet(graph, event, bounds);
  const obs = view.query(entityId({domain: 'evidence', type: 'source', key: event.source}), 'recorded').filter(a => a.admitted === event.seq).at(-1);
  if (!obs) throw Object.assign(new Error(`event ${event.key} is not a source observation of this graph`), {code: 'GRAPH_REFUSED'});
  // Recorded within the assertion's attribute bound: members while they fit REASSESS_BYTES, and the digest of EVERY
  // member's id, so the whole set is identified (and re-derivable: reassessmentSet is deterministic at the cursor).
  const members = [];
  let bytes = 0;
  for (const m of set.members) {
    const row = {id: m.id, status: m.status, why: String(m.why).slice(0, 200)}, n = Buffer.byteLength(JSON.stringify(row));
    if (members.length >= REASSESS_MAX || bytes + n > REASSESS_BYTES) break;
    members.push(row); bytes += n;
  }
  const record = assertion({entity: discoveryId(`reassess/${event.seq}`), origin: IMPACT_RULE, classification: 'derived', observed_at,
    source: {id: 'ophanim.impact', authority: 'the impact rule (ophanim/graph/impact.mjs reassess): derived from a source observation', ref: event.key, version: obs.id},
    inputs: [obs.id], status: 'unverified',
    missing_evidence: set.state === 'current' ? [] : [`${event.source} is ${set.state}: what rests on it cannot be re-checked until it is observed current`],
    attributes: {event: {seq: event.seq, key: event.key, source: event.source, state: set.state, from_version: event.from_version ?? null, to_version: event.to_version ?? null},
      members, total: set.members.length, members_digest: 'sha256:' + digest(set.members.map(m => m.id).sort()),
      truncated: members.length < set.members.length || Boolean(set.coverage.truncated), coverage: set.coverage,
      completion: 'not claimed', note: set.note}});
  const w = graph.assert([record], by);
  return {recorded: w.appended || w.duplicates.includes(record.id), id: record.id, subject: record.subject, set};
}

/** The reassessment set of a change event, not recorded: {state, members [{id, kind, why, status}], coverage, note}. */
export function reassessmentSet(graph, event, bounds = {}) {
  const state = event.state, P = graph.projection;
  if (state === 'current') {
    const a = affected(P, event, {depth: bounds.depth, maxNodes: bounds.maxNodes, maxEdges: bounds.maxEdges, types: [...CHANGE_TYPES]});
    if (a.unknown) return {state, members: [], coverage: {truncated: true}, note: a.why};
    // A reverse step leaves its cause: the seed is the `from` end of an outgoing step, the `to` end of an incoming one.
    const seedOf = p => (p.toward === 'out' ? p.from : p.to);
    const members = [...a.nodes.map(n => ({id: n.id, kind: kindOf(n.id), status: 'reassess',
      why: n.path.length ? `reached from ${keyOf(seedOf(n.path[0]))} by ${n.path.map(p => p.type).join(' -> ')}` : 'changed by this observation'})),
      ...a.incident.filter(e => !a.nodes.some(n => n.id === e.from) || !a.nodes.some(n => n.id === e.to)).map(e => ({id: e.subject, kind: e.type, status: 'reassess',
        why: `a ${e.type} relationship of a changed node: named for reassessment, not declared invalid`}))];
    return {state, members, coverage: {truncated: a.coverage.truncated}, note: `${event.source} changed from ${event.from_version ?? 'nothing'} to ${event.to_version}: the reverse closure of what changed, before and after; nothing outside it`};
  }
  // Unavailable or stale: its facts are as last observed and cannot be re-checked. They, and what rests on them, are
  // UNVERIFIABLE until the source is observed current again.
  const view = graph.view(event.seq), facts = [];
  for (const s of view.subjects()) {
    for (const a of view.query(s, 'established')) if (a.source.id === event.source && a.classification === 'authoritative' && !s.includes('/evidence/source/')) { facts.push(s); break; }
  }
  const entities = facts.filter(s => !s.includes('('));
  const reach = entities.length ? closure(view, entities.slice(0, 2000), {direction: 'reverse', types: [...CHANGE_TYPES], depth: bounds.depth ?? 2, maxNodes: bounds.maxNodes ?? DEFAULTS.maxNodes, maxEdges: bounds.maxEdges ?? DEFAULTS.maxEdges})
    : {nodes: [], coverage: {truncated: false}};
  const own = new Set(entities);
  const members = [...entities.map(id => ({id, kind: kindOf(id), status: 'unverifiable', why: `a fact of ${event.source}, which is ${state} since ledger seq ${event.seq}: as last observed, not re-checked`})),
    ...reach.nodes.filter(n => !own.has(n.id)).map(n => ({id: n.id, kind: kindOf(n.id), status: 'unverifiable', why: `rests on a fact of ${event.source} (${n.path.map(p => p.type).join(' -> ')}), which cannot be re-checked`}))];
  return {state, members, coverage: {truncated: reach.coverage.truncated || entities.length > 2000, facts: entities.length},
    note: `${event.source} is ${state}: no fact of it, and nothing resting on it, is reported current`};
}

// ---- traceability (KB3, demonstration 3) ----------------------------------------------------------------------------
const link = (view, e, extra = {}) => ({relationship: {type: e.type, from: e.from, to: e.to}, sources: edgeSources(view, e), ...extra});
const nodeAttrs = (view, id) => view.node(id).attributes;
const inEdges = (view, id, types, mode = 'established') => view.edgesOf(id, {mode, types}).filter(e => e.to === id);
const outEdges = (view, id, types, mode = 'established') => view.edgesOf(id, {mode, types}).filter(e => e.from === id);

/**
 * The backward walk of `subject` (an id): what introduced it, what decided it, what verifies it, which commits built it,
 * and what corrected it later. Every link is a relationship a source states (with its source and version), or an
 * identity both sources state (a ticket's item, a registry's commit text): such a JOIN is labelled. A category no source
 * fills is a GAP.
 */
export function trace(view, subject, {lessonsSource = 'ophanim.lessons'} = {}) {
  if (!view.nodeIn(subject, 'possible')) return {error: 'NOT_FOUND', why: `${subject} is not in the graph at cursor ${view.seq}`};
  const node = view.node(subject), gaps = [], used = new Set();
  const note = arr => { for (const x of arr) for (const s of x.sources ?? []) used.add(s.source); return arr; };
  // What it implements: a ticket (a work requirement) and the item the ticket names; a contract it carries.
  const requirements = [];
  for (const e of outEdges(view, subject, ['implements'])) {
    const k = kindOf(e.to);
    if (k === 'work/ticket') {
      requirements.push(link(view, e, {kind: 'ticket', id: e.to, title: nodeAttrs(view, e.to).title ?? null}));
      for (const d of outEdges(view, e.to, ['depends-on'])) if (kindOf(d.to) === 'work/item') {
        const item = view.node(d.to);
        requirements.push(link(view, d, {kind: 'status item', id: d.to, state: item.attributes.state ?? null, title: item.attributes.title ?? null,
          on_status_ledger: item.assertions.some(a => a.source.id === 'ophanim.status'),
          join: 'the ticket names its item; the status ledger states the item under the same id'}));
      }
    } else if (k === 'evidence/requirement' || k === 'work/item') requirements.push(link(view, e, {kind: k, id: e.to}));
  }
  for (const e of outEdges(view, subject, ['introduced-because-of'])) requirements.push(link(view, e, {kind: kindOf(e.to), id: e.to}));
  if (!requirements.length) gaps.push({category: 'requirement', why: 'no source states the requirement that introduced it: no ticket names it as its slot, and no introduced-because-of relationship is recorded'});
  // The register: entries that name it, or that it cites. TEXTUAL: a mention says the text names it, not that the entry
  // introduced, decided or corrected it.
  const register = [];
  for (const e of view.edgesOf(subject, {mode: 'possible', types: ['mentions']})) {
    const other = e.from === subject ? e.to : e.from;
    if (kindOf(other) !== 'evidence/record') continue;
    const a = nodeAttrs(view, other);
    register.push(link(view, e, {id: other, entry: a.id ?? keyOf(other), direction: e.from === subject ? 'cited by this file' : 'names this file', section: a.section ?? null,
      status: a.status ?? null, decisions: (a.decisions ?? []).length, resolved: view.nodeIn(other, 'established'),
      basis: 'textual (a mention): the text names it; not a statement that it introduced, decided or corrected it'}));
  }
  const decisions = register.filter(r => r.decisions > 0 || /decision/i.test(r.section ?? ''));
  if (!decisions.length) gaps.push({category: 'decision', why: 'no owner decision recorded in the register names it (and no decision relationship is recorded)'});
  // The evidence: what verifies it, by what the sources state.
  const tests = inEdges(view, subject, ['depends-on']).filter(e => kindOf(e.from) === 'systems/test').map(e => link(view, e, {id: e.from, basis: 'the test imports it (structural)'}));
  const verifiers = inEdges(view, subject, ['verifies']).map(e => link(view, e, {id: e.from, mutations: view.assertion(e.assertions[0]).record.attributes.mutations ?? [],
    basis: 'a mutation runner declares this test decides mutations of it'}));
  const mutations = inEdges(view, subject, ['depends-on']).filter(e => kindOf(e.from) === 'systems/mutation').map(e => link(view, e, {id: e.from,
    role: view.assertion(e.assertions[0]).record.attributes.role ?? null, what: nodeAttrs(view, e.from).what ?? null}));
  const testIds = new Set([...tests, ...verifiers].map(t => t.id));
  const suites = new Map();
  for (const t of testIds) for (const e of inEdges(view, t, ['depends-on'])) if (kindOf(e.from) === 'systems/suite' && !suites.has(e.from)) {
    const wf = inEdges(view, e.from, ['depends-on']).filter(w => kindOf(w.from) === 'systems/workflow').map(w => w.from);
    suites.set(e.from, link(view, e, {id: e.from, through: t, workflows: wf}));
  }
  if (!testIds.size) gaps.push({category: 'tests', why: 'no test imports it and no mutation runner declares a test that decides it'});
  if (!mutations.length) gaps.push({category: 'mutations', why: 'no mutation runner edits it'});
  // The implementing commits: the ancestry's commits that changed it (structural: git log at the graph's commit).
  const commits = outEdges(view, subject, ['derived-from']).filter(e => kindOf(e.to) === 'systems/change')
    .map(e => ({...link(view, e), id: e.to, ...nodeAttrs(view, e.to)})).sort((a, b) => byString(a.date ?? '', b.date ?? '') || byString(a.id, b.id));
  if (!commits.length && ['systems/module', 'systems/test', 'systems/file'].includes(kindOf(subject))) gaps.push({category: 'commits', why: 'no commit of the ancestry changed this path under this name (a rename is not followed)'});
  // Later corrections: the lessons registry's classes whose detector is a test of it, or whose fix is a commit that changed it.
  const corrections = [];
  const shaOf = text => /^[0-9a-f]{7,40}\b/.exec(text ?? '')?.[0] ?? null;
  const touched = new Map(commits.map(c => [c.commit, c]));
  const classes = view.subjects().filter(s => s.includes('/learning/failure-class/') && view.nodeIn(s, 'established'));
  const unresolvedFixes = [];
  for (const fc of classes) {
    const a = nodeAttrs(view, fc);
    const det = inEdges(view, fc, ['detects']).map(e => e.from).filter(t => testIds.has(fileId(keyOf(t).split('#')[0])));
    if (det.length) corrections.push({kind: 'lesson (detector)', id: fc, class: a.class, detector: keyOf(det[0]), sources: inEdges(view, fc, ['detects']).flatMap(e => edgeSources(view, e)),
      join: 'the registry names its detector as <file>#<name substring>; <file> is a test of this component'});
    const fix = a.fixed_in ?? null, sha = shaOf(fix);
    if (fix && sha) {
      const hit = [...touched.keys()].find(c => c.startsWith(sha));
      if (hit) corrections.push({kind: 'lesson (fix)', id: fc, class: a.class, commit: hit, subject: touched.get(hit).subject, sources: view.node(fc).assertions.map(sourceOf),
        join: `the registry names its fix as "${String(fix).slice(0, 80)}"; ${sha} is a commit that changed this path`});
    } else if (fix && det.length) unresolvedFixes.push({class: fc, fixed_in: String(fix).slice(0, 160)});
  }
  for (const u of unresolvedFixes) gaps.push({category: 'correction commit', why: `${keyOf(u.class)} names its fix as "${u.fixed_in}", which resolves to no commit`});
  const later = commits.slice(1);
  note([...requirements, ...register, ...tests, ...verifiers, ...mutations, ...suites.values(), ...commits, ...corrections]);
  for (const a of node.assertions) used.add(a.source.id);
  return {query: 'trace', cursor: view.seq, subject, node: {id: subject, kind: kindOf(subject), established: node.established, sources: node.assertions.map(sourceOf),
    attributes: Object.fromEntries(Object.entries(node.attributes).filter(([k]) => ['path', 'blob', 'bytes', 'lines', 'title', 'state', 'id', 'schema'].includes(k)))},
  requirements, decisions: decisions.map(d => ({...d})), register: cap(register),
  evidence: {tests: cap(tests), verifiers: cap(verifiers), mutations: cap(mutations), suites: [...suites.values()]},
  commits: {introduced: commits[0] ?? null, later: cap(later.reverse()), total: commits.length},
  corrections: {lessons: corrections, register: register.filter(r => /repaired|class covered|qualified|fixed/i.test(r.status ?? '')).map(r => r.id), later_commits: later.length},
  gaps, sources: sourcesTable(view, used)};
}

// ---- the section-8 queries (KB5) ------------------------------------------------------------------------------------
export const QUERIES = Object.freeze(['why', 'requirement', 'governs', 'dependents', 'evidence', 'changed-since', 'invalidates', 'unknown']);
/**
 * One of the directive's section 8 queries about `subject` (anything subjectOf names), on `graph` (an opened graph).
 * Each answer is bounded (traversal bounds, LIST_MAX per list), explained, and names its sources and versions.
 */
export function answer(graph, query, subject, opts = {}) {
  try { return answerOf(graph, query, subject, opts); }
  catch (e) { if (e instanceof RangeError) return {error: 'BAD_REQUEST', why: e.message}; throw e; }
}
function answerOf(graph, query, subject, opts) {
  const view = graph.view(opts.cursor), s = subjectOf(view, subject);
  if (s.error) return s;
  const id = s.id, base = {query, subject: id, cursor: view.seq, digest: view.digest()};
  if (!QUERIES.includes(query)) return {error: 'BAD_REQUEST', why: `query is one of ${QUERIES.join(', ')}`};
  if (query === 'dependents' || query === 'invalidates') {
    const r = impact(view, [id], opts);
    if (r.error) return r;
    if (query === 'dependents') return {...base, dependents: Object.fromEntries(Object.entries(r.affected).map(([g, xs]) => [g, cap(xs)])), counts: r.counts, coverage: r.coverage, continuation: r.continuation, sources: r.sources, note: r.note};
    return {...base, invalidates: {affected: Object.fromEntries(Object.entries(r.affected).map(([g, xs]) => [g, cap(xs)])), qualifications: cap(r.qualifications), citing: cap(r.citing)},
      counts: r.counts, coverage: r.coverage, continuation: r.continuation, sources: r.sources, note: `${r.note}; a qualification or a citing record is named for reassessment, not declared invalid`};
  }
  const t = trace(view, id);
  if (t.error) return t;
  if (query === 'why') return {...base, exists_because: {requirements: t.requirements, decisions: t.decisions, introduced_by: t.commits.introduced, register: t.register},
    gaps: t.gaps.filter(g => ['requirement', 'decision', 'commits'].includes(g.category)), sources: t.sources};
  if (query === 'requirement') return {...base, requirements: t.requirements, register: t.register, gaps: t.gaps.filter(g => g.category === 'requirement'), sources: t.sources};
  if (query === 'evidence') return {...base, evidence: t.evidence, corrections: t.corrections, gaps: t.gaps.filter(g => ['tests', 'mutations'].includes(g.category)), sources: t.sources,
    note: 'what the sources STATE verifies it (imports, declared mutation deciders, suites, workflows); no run result is in the repository, so none is claimed'};
  if (query === 'governs') {
    const governed = [...outEdges(view, id, ['governed-by']).map(e => link(view, e, {id: e.to})), ...inEdges(view, id, ['governs']).map(e => link(view, e, {id: e.from}))];
    const obligations = outEdges(view, id, ['implements']).map(e => link(view, e, {id: e.to, kind: kindOf(e.to)}));
    return {...base, governed_by: governed, implements: obligations, register: t.register,
      gaps: governed.length ? [] : [{category: 'governance', why: 'no governs or governed-by relationship is stated for it; the register entries that name it are listed as mentions, not as governance'}],
      sources: t.sources};
  }
  if (query === 'changed-since') {
    const since = opts.since ?? null, commits = [t.commits.introduced, ...t.commits.later.shown.slice().reverse()].filter(Boolean);
    const at = since ? commits.findIndex(c => c.commit.startsWith(since)) : -1;
    const fresh = freshness(graph.projection).filter(f => t.node.sources.some(x => x.source === f.source));
    return {...base, since, commits_after: since ? (at === -1 ? {why: `${since} is not a commit that changed it; every commit that changed it is listed`, all: commits} : commits.slice(at + 1)) : commits,
      recorded: view.query(id, 'recorded').map(a => ({assertion: a.id, source: a.source.id, version: a.source.version, admitted: a.admitted, retired: a.retired})),
      sources_now: fresh, sources: t.sources, note: 'commits are the ancestry of the graph\'s commit that changed this path; the recorded history is the graph\'s own, as of this cursor'};
  }
  // unknown or disputed
  const possible = view.query(id, 'possible');
  const conflicts = view.node(id).conflicts;
  const disputed = contradictions(view, id, {mode: 'possible', depth: 2, maxNodes: 50});
  const unresolvedNear = view.edgesOf(id, {mode: 'possible'}).map(e => (e.from === id ? e.to : e.from)).filter(n => !view.nodeIn(n, 'established')).sort(byString);
  const stale = freshness(graph.projection).filter(f => f.state !== 'current');
  return {...base, gaps: t.gaps, possible, conflicts, contradictions: disputed.members.filter(m => m.id !== id).map(m => ({id: m.id, established: m.established, assertions: m.assertions})),
    unresolved_neighbours: cap(unresolvedNear), stale_sources: stale, sources: t.sources};
}

// ---- references for the context operation (KB4) ---------------------------------------------------------------------
/** The request (an existing retrieval op) that returns the underlying record of a fact, or a note why none can. */
export function retrievalOf(src, attributes = {}) {
  const v = src.version, ref = String(src.ref ?? '');
  if (['ophanim.repo', 'ophanim.verification', 'ophanim.records'].includes(src.source)) {
    const m = /^git:([0-9a-f]{40})$/.exec(ref);
    if (m) return {op: 'show', commit: m[1]};
    const p = attributes.path ?? ref.replace(/#.*$/, '').replace(/:\d+$/, '');
    return COMMIT.test(v ?? '') && p ? {op: 'show', commit: v, path: p} : null;
  }
  if (src.source === 'ophanim.status') return attributes.item ? {op: 'status', item: attributes.item} : null;
  if (src.source === 'ophanim.work') return attributes.record ? {op: 'record', hash: attributes.record} : attributes.item ? {op: 'work', item: attributes.item} : null;
  if (src.source === 'ophanim.lessons') return {op: 'file', path: 'ophanim/lessons/corrections.json', note: `the fact is of blob ${v}; the file op serves the working file`};
  return null;
}
const lineOf = (view, n, why) => {
  const sources = n.sources ?? view.node(n.id).assertions.map(sourceOf), attrs = view.node(n.id).attributes;
  return {node: n.id, kind: kindOf(n.id), ...(n.depth !== undefined ? {depth: n.depth} : {}), established: view.nodeIn(n.id, 'established'), why,
    sources: sources.map(s => ({source: s.source, version: s.version, ref: s.ref, assertion: s.assertion, classification: s.classification})),
    retrieve: sources.map(s => retrievalOf(s, attrs)).find(Boolean) ?? {none: 'no retrieval op reads this source; cite the assertion and its source version'}};
};
const pathText = via => (via.length ? via.map(p => `${p.type}(${keyOf(p.from)} -> ${keyOf(p.to)})`).join(' / ') : 'the subject itself');

/**
 * A graph query as REFERENCES: {header, rows, coverage, continuation} where each row names a node, why it is included
 * (its explained path or relationship), the sources and versions that state it, and the existing retrieval request that
 * returns the original record. Never a summary in place of the records. `request` {query, subject, depth, maxNodes,
 * maxEdges, types, direction, continuation}.
 */
export function graphReferences(graph, request) {
  const view = graph.view(), q = request.query ?? 'neighbourhood';
  let subject = null;
  if (!request.continuation) {
    const s = subjectOf(view, request.subject ?? request.path);
    if (s.error) return s;
    subject = s.id;
  }
  const bounds = {depth: request.depth, maxNodes: request.maxNodes, maxEdges: request.maxEdges};
  let rows = [], coverage = null, continuation = null, extra = {};
  try {
    if (q === 'neighbourhood' || q === 'neighborhood') {
      const r = request.continuation ? neighborhood(view, null, {continuation: request.continuation})
        : neighborhood(view, subject, {...bounds, types: request.types ?? null, direction: request.direction ?? 'both', mode: request.mode ?? 'established'});
      rows = r.nodes.map(n => lineOf(view, explain(view, n), pathText(explain(view, n).via)));
      coverage = r.coverage; continuation = r.continuation;
    } else if (q === 'impact') {
      const r = impact(view, [subject].filter(Boolean), {...bounds, continuation: request.continuation});
      if (r.error) return r;
      rows = [...Object.values(r.affected).flat().map(n => lineOf(view, n, `affected: ${pathText(n.via)}`)),
        ...r.qualifications.map(x => lineOf(view, {id: x.qualification_of}, x.why)), ...r.citing.map(x => lineOf(view, {id: x.record}, `${x.direction}; ${x.why}`))];
      coverage = r.coverage; continuation = r.continuation;
    } else if (q === 'contradictions') {
      const r = request.continuation ? contradictions(view, null, {continuation: request.continuation}) : contradictions(view, subject, {...bounds, mode: 'possible'});
      rows = r.members.map(m => ({...lineOf(view, {id: m.id, depth: m.depth, sources: m.assertions.map(a => ({source: a.source.id, version: a.source.version, ref: a.source.ref, assertion: a.id, classification: a.classification}))},
        m.depth === 0 ? 'the subject' : `contradicts (${pathText(explain(view, m).via)}): both sides kept, neither resolved`), side_established: m.established,
        hypothetical: m.assertions.every(a => a.classification === 'hypothetical')}));
      coverage = r.coverage; continuation = r.continuation;
    } else if (q === 'node') {
      const n = view.node(subject);
      rows = view.query(subject, 'recorded').map(a => ({node: subject, assertion: a.id, classification: a.classification, origin: a.origin, current: a.current, established: a.established,
        retired: a.retired, why: 'an assertion of the subject, as recorded (challenge the projection here)', sources: [{source: a.source.id, version: a.source.version, ref: a.source.ref}],
        retrieve: retrievalOf({source: a.source.id, version: a.source.version, ref: a.source.ref}, n.attributes) ?? {none: 'no retrieval op reads this source'}}));
      coverage = {truncated: false, returned: {nodes: 1, edges: 0}};
      extra = {conflicts: n.conflicts.map(c => ({attribute: c.attribute, values: c.values.map(v => ({assertion: v.assertion, classification: v.classification, origin: v.origin}))}))};
    } else if (q === 'trace') {
      const t = trace(view, subject);
      if (t.error) return t;
      const add = (xs, why) => { for (const x of xs) if (x.id) rows.push(lineOf(view, {id: x.id, sources: x.sources}, why(x))); };
      add(t.requirements, x => `requirement (${x.kind}${x.join ? `; ${x.join}` : ''})`);
      add(t.register.shown, x => `register entry ${x.entry}, ${x.direction} (textual mention)`);
      add(t.evidence.tests.shown, () => 'a test that imports it');
      add(t.evidence.verifiers.shown, () => 'a test a mutation runner declares decides it');
      add(t.evidence.mutations.shown, x => `a mutation of it (${x.role})`);
      add(t.evidence.suites, x => `a suite that runs ${keyOf(x.through)}`);
      if (t.commits.introduced) add([t.commits.introduced], () => 'the first commit of the ancestry that changed it');
      add(t.commits.later.shown, () => 'a later commit that changed it');
      add(t.corrections.lessons, x => `${x.kind}: ${x.join}`);
      coverage = {truncated: t.register.more + t.evidence.tests.more + t.commits.later.more > 0, lists: LIST_MAX};
      extra = {gaps: t.gaps};
    } else return {error: 'BAD_REQUEST', why: 'query is neighbourhood, impact, contradictions, node or trace'};
  } catch (e) {
    if (e instanceof RangeError) return {error: 'BAD_REQUEST', why: e.message};
    throw e;
  }
  const sources = sourcesTable(view, new Set(rows.flatMap(r => r.sources.map(s => s.source))));
  return {query: q, subject, cursor: view.seq, digest: view.digest(), rows, coverage, continuation, sources, ...extra};
}

/** The bounds no graph retrieval may exceed (the context operation clamps a request to them). */
export const RETRIEVAL_BOUNDS = Object.freeze({depth: 4, maxNodes: 200, maxEdges: 1000});
export {DEFAULTS, CEILINGS};
