// THE WORK GRAPH (knowledge graphs, Slice D part 1; the directive's Graph E; KD1-1, KD1-2; docs/knowledge-graph/slice-d1.md).
//
// Purpose   Project the work ledger (ophanim/operate/work-ledger.mjs, ophanim.work/v1) as `work`-domain facts, READ ONLY,
//           through the ledger's OWN reader at a pinned anchor, and derive from them the SHARED PREREQUISITES of independent
//           work items (demonstration 1). Every fact is projected from the entry that states it: its `ref` names that
//           entry (`status/work#<entry hash>`, an immutable ledger id) and its attributes carry the hash; the source's
//           version is the ledger's head entry, so a replay re-derives the same facts from the same prefix.
// Inputs    The work ledger's absolute root and its pinned anchor (a genesis the caller trusts).
// Outputs   workGraphSource(): the adapter ({id, extractor, authority, ref, current, readAt}); workGraphFacts(); the
//           shared-prerequisite rule (sharedPrerequisites, existenceOf, recordSharedPrerequisites); dependencyCycles().
// Facts     work/prompt/<source>:<ref>          an intake record (a status item, an issue, a ticket); an issue with no item
//                                               is a CANDIDATE prompt, never executed; item `introduced-because-of` it
//           work/item/<item>                    an item the ledger names
//           work/lease/<claim>, work/budget/<claim>   a claim: its lease (Slice B's id) and its declared budget
//           work/usage/spend/<entry>, work/usage/stage/<record>   provider calls charged before they were made; a stage's usage
//           work/request/<entry>                one billed Gemini request (work.billing)
//           work/execution/<record>             a stage record (Slice B's id)
//           work/plan/<record>                  a passed plan: its item, requirement digest, dependencies (`depends-on`
//                                               items), its TYPED requirements (`requires-capability` or `depends-on` a graph
//                                               id the plan names in `requires` or `capabilities`; free text stays text, never
//                                               an edge), the files it cites as evidence (`derived-from`, with their digests)
//           work/work-unit/<record>/<unit>      a unit of the plan (`derived-from` the plan; `depends-on` its units)
//           work/ticket/<item>                  the ticket a plan wrote (`derived-from` the plan)
//           work/artifact/<record>              an implemented change (`derived-from` its plan; `produces` its files)
//           work/review/stage/<record>          a passed change review (`derived-from` and `verifies` the artifact)
//           work/validation/<record>            a validation (`derived-from` its review and the files it cited; `verifies`
//                                               the artifact)
//           work/obligation/completion/<record> an outcome's unsigned status proposal: a completion CLAIM resting on its
//                                               validation (`derived-from`), never a completion
//           work/discovery/policy/<entry>       a recorded identity-policy reassessment of a review cycle
// Must never  Open the work ledger writable (create:false, no key directory named, nothing appended); admit a requirement
//           from free text; merge, reassign or re-own a ticket because it shares a prerequisite (directive: "Sharing a
//           dependency does not automatically mean tickets should be merged"); report a prerequisite as existing because
//           a plan names it.
import path from 'node:path';
import {entityId, parseId, idRefusal, assertion, endpointAllowed} from '../../packages/graph/index.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';
import {openWorkLedger} from '../operate/work-ledger.mjs';
import {fileId, ticketId, itemId} from './extract/repo.mjs';

export const WORK_GRAPH_SOURCE = 'ophanim.work-graph';
export const WORK_GRAPH_EXTRACTOR = 'ophanim.work-graph.extractor';
/** DECLARED: every fact is what a work-ledger entry states. */
export const WORK_GRAPH_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [WORK_GRAPH_SOURCE]});
/** The registered rule that records a shared-prerequisite finding (derived, from the declared requirement edges). */
export const WORK_RULE = 'ophanim.work.rule';
export const WORK_RULE_ORIGIN = Object.freeze({kind: 'rule', basis: 'declared'});
/** The sources whose assertion of a node only NAMES it as a requirement: never evidence that the prerequisite exists. */
export const NAMING_SOURCES = Object.freeze([WORK_GRAPH_SOURCE]);
const HASH = /^sha256:[0-9a-f]{64}$/;
const hex = h => h.slice('sha256:'.length);
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const bounded = (xs, n = 32) => (xs.length > n ? [...xs.slice(0, n), `... ${xs.length - n} more`] : xs);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const E = (type, key) => entityId({domain: 'work', type, key});
export const promptId = (source, ref) => E('prompt', `${source}:${ref}`);
export const planId = record => E('plan', hex(record));
export const unitId = (record, unit) => E('work-unit', `${hex(record)}/${unit}`);
export const artifactId = record => E('artifact', hex(record));
export const stageReviewId = record => E('review', `stage/${hex(record)}`);
export const validationId = record => E('validation', hex(record));
export const completionId = record => E('obligation', `completion/${hex(record)}`);
export const leaseId = claim => E('lease', hex(claim));
export const executionId = record => E('execution', hex(record));
export const discoveryId = key => E('discovery', key);
const kindOf = id => { const p = parseId(id); return `${p.domain}/${p.type}`; };
const keyOf = id => decodeURIComponent(parseId(id).key);

// ---- reading, READ ONLY ---------------------------------------------------------------------------------------------
/** Open the work ledger at `root` READ ONLY against `anchor`: never creates, names no key directory, appends nothing. */
export function readWorkLedgerOnly({root, anchor}) {
  if (!root || !path.isAbsolute(root)) throw new Error('the work ledger is read at an absolute root');
  if (!anchor) throw new Error('the work ledger is read against a pinned anchor');
  return openWorkLedger({root, anchor, create: false, keys: null});
}
/** The entries of the work ledger up to and including `version`: [{hash, kind, derived_from, payload}]. */
export function entriesTo(W, version) {
  if (!HASH.test(version ?? '')) throw new Error(`${version} is not a ledger entry hash`);
  const out = [];
  for (const e of W.ledger.read()) {
    const h = W.ledger.hashOf(e);
    out.push({hash: h, kind: e.kind, derived_from: e.derived_from ?? [], payload: W.ledger.payloadOf(e)});
    if (h === version) return out;
  }
  throw new Error(`entry ${version} is not on this work ledger`);
}

// ---- typed requirements ---------------------------------------------------------------------------------------------
/**
 * The requirements a plan states: a graph id in `requires` ([id] or [{id, why}]) or in `capabilities`. A capability
 * written as free text is TEXT: it is kept on the plan, never turned into an edge (a textual match is never a
 * requirement). Returns {typed: [{id, type, why, field}], free: [text], refused: [{value, why}]}.
 */
export function requirementsOf(plan, from = {domain: 'work', type: 'plan'}) {
  const typed = [], free = [], refused = [], seen = new Set();
  const add = (x, field) => {
    const id = typeof x === 'string' ? x : plain(x) ? x.id : null, why = plain(x) && typeof x.why === 'string' ? cut(x.why, 300) : null;
    if (typeof id !== 'string' || !id) { refused.push({value: cut(JSON.stringify(x), 200), why: `${field}: an entry is a graph id or {id, why}`}); return; }
    const bad = idRefusal(id);
    if (bad) { if (field === 'capabilities') free.push(cut(id, 300)); else refused.push({value: cut(id, 200), why: bad}); return; }
    if (seen.has(id)) return;
    const to = parseId(id);
    const type = endpointAllowed('requires-capability', from, to) ? 'requires-capability' : endpointAllowed('depends-on', from, to) ? 'depends-on' : null;
    if (!type) { refused.push({value: id, why: `${to.domain}/${to.type} is not a capability or a component a work item can require`}); return; }
    seen.add(id);
    typed.push({id, type, why, field});
  };
  for (const x of Array.isArray(plan?.requires) ? plan.requires : []) add(x, 'requires');
  for (const x of Array.isArray(plan?.capabilities) ? plan.capabilities : []) add(x, 'capabilities');
  return {typed, free, refused};
}

// ---- the facts ------------------------------------------------------------------------------------------------------
/** The work facts of the chain that ends at `version`, as the extractor's drafts. */
export function workGraphFacts(W, version) {
  const rows = entriesTo(W, version), byHash = new Map(rows.map(r => [r.hash, r]));
  const drafts = [], entities = new Map();
  const ref = r => `status/work#${r.hash}`;
  // An entity is asserted once per readAt; a second statement of the same subject adds nothing (first wins).
  const entity = (id, r, attributes, extra = {}) => { if (!entities.has(id)) { entities.set(id, true); drafts.push({entity: id, ref: typeof r === 'string' ? r : ref(r), attributes, ...extra}); } };
  const rel = (type, from, to, r, attributes = {}) => drafts.push({type, from, to, ref: typeof r === 'string' ? r : ref(r), attributes});
  const relSeen = new Set();
  const relOnce = (type, from, to, r, attributes) => { const k = `${type}\0${from}\0${to}`; if (!relSeen.has(k)) { relSeen.add(k); rel(type, from, to, r, attributes); } };
  const item = (name, r) => { entity(itemId(name), 'status/work', {item: name, named_by_work_ledger: true}); return itemId(name); };
  const named = (id, r, why) => entity(id, r, {required_by_work_ledger: true, why: cut(why, 200)});
  const released = new Map();
  for (const r of rows) if (r.kind === 'work.release') for (const c of r.derived_from) released.set(c, r.payload.outcome);
  const typedOf = new Map();                                 // stage record -> the typed entity it states
  const artifactOf = new Map();                              // review/validate record -> the artifact its chain verifies
  for (const r of rows) {
    const p = r.payload;
    if (r.kind === 'work.intake') {
      const P = promptId(p.source, p.ref);
      if (entities.has(P)) continue;                         // intake is once per source; an older duplicate adds nothing
      entity(P, r, {entry: r.hash, source: p.source, ref: cut(p.ref, 300), classification: p.classification, item: p.item ?? null, why: cut(p.why, 300), at: p.at,
        executable: p.classification === 'item'},
      p.classification === 'item' ? {} : {missing_evidence: ['a candidate or coordination prompt: recorded, never executed, until the owner adds an item']});
      if (p.classification === 'item' && p.item) relOnce('introduced-because-of', item(p.item, r), P, r, {basis: 'the intake records the item from this source'});
    } else if (r.kind === 'work.claim') {
      const L = leaseId(r.hash);
      entity(L, r, {claim: r.hash, item: p.item, stage: p.stage, attempt: p.attempt, released: released.get(r.hash) ?? null});
      relOnce('depends-on', L, item(p.item, r), r, {basis: 'the claim names its item'});
      const B = E('budget', hex(r.hash));
      entity(B, r, {entry: r.hash, item: p.item, stage: p.stage, ...p.budget, reserve_total: p.reserve?.total_provider_calls ?? null, key: p.key});
      rel('derived-from', B, L, r, {basis: 'the budget the claim declares before dispatch'});
    } else if (r.kind === 'work.spend' || r.kind === 'work.billing') {
      const claim = r.derived_from.find(h => byHash.get(h)?.kind === 'work.claim');
      if (!claim) continue;
      const U = r.kind === 'work.spend' ? E('usage', `spend/${hex(r.hash)}`) : E('request', hex(r.hash));
      entity(U, r, r.kind === 'work.spend' ? {entry: r.hash, item: p.item, stage: p.stage, attempt: p.attempt, provider_calls: p.provider_calls, at: p.at,
        basis: 'provider calls charged under the claim BEFORE they were made (cumulative)'}
        : {entry: r.hash, item: p.item, stage: p.stage, attempt: p.attempt, kind: p.kind, setting: p.setting, vendor: p.vendor, model: p.model, purpose: p.purpose ?? null,
          role: p.role ?? null, transport: p.transport ?? null, budget: p.budget, policy: p.policy, used_before: p.used_before ?? null, at: p.at});
      rel('derived-from', U, leaseId(claim), r, {basis: r.kind === 'work.spend' ? 'charged under this claim' : 'billed under this claim'});
    } else if (r.kind === 'work.reassessment') {
      const D = discoveryId(`policy/${hex(r.hash)}`);
      entity(D, r, {entry: r.hash, item: p.item, cycle: p.cycle, recorded_policy: p.recorded_policy, policy: p.policy, findings: (p.findings ?? []).length, at: p.at,
        note: 'new evidence about a closed review cycle under a later identity policy; never a change to the cycle'});
      relOnce('derived-from', D, item(p.item, r), r, {basis: 'the reassessment names its item'});
    } else if (r.kind === 'work.stage') {
      const it = p.identity?.item;
      if (typeof it !== 'string') continue;
      const X = executionId(r.hash), I = item(it, r);
      entity(X, r, {record: r.hash, item: it, stage: p.stage, status: p.status});
      relOnce('depends-on', X, I, r, {basis: 'the stage record names its item'});
      if (p.usage && Number.isInteger(p.usage.provider_calls)) {
        const U = E('usage', `stage/${hex(r.hash)}`);
        entity(U, r, {entry: r.hash, item: it, stage: p.stage, provider_calls: p.usage.provider_calls, tokens: p.usage.tokens ?? null, elapsed_ms: p.usage.elapsed_ms ?? null});
        rel('derived-from', U, X, r, {basis: 'the usage the stage record states'});
      }
      const from = p.handoff?.from ?? null, up = from ? typedOf.get(from) ?? null : null;
      const upstream = () => up ?? (from && byHash.get(from)?.kind === 'work.stage' ? executionId(from) : null);
      if (p.stage === 'plan' && p.status === 'passed' && plain(p.outputs?.plan)) {
        const doc = p.outputs.plan, P = planId(r.hash), req = requirementsOf(doc);
        const evidence = (p.outputs.evidence ?? []).filter(e => plain(e) && typeof e.path === 'string' && typeof e.sha256 === 'string');
        const views = (p.outputs.evidence ?? []).filter(e => plain(e) && !e.path).map(e => ({source: cut(e.source ?? e.ref, 200), version: e.version ?? null}));
        entity(P, r, {record: r.hash, item: it, requirement: p.identity.requirement, plan_digest: p.outputs.plan_digest ?? null,
          statement: cut(doc.problem?.statement, 300), dependencies: (doc.dependencies ?? []).slice(0, 64), requires: req.typed.map(t => ({id: t.id, relationship: t.type, why: t.why, field: t.field})),
          free_text_capabilities: bounded(req.free), refused_requirements: req.refused.slice(0, 16),
          slices: (doc.slices ?? []).filter(plain).map(s => ({id: s.id ?? null, slot: s.slot ?? null, path: s.path ?? null})).slice(0, 64),
          acceptance: (doc.acceptance ?? []).filter(plain).map(a => a.id).slice(0, 64), work_units: Array.isArray(doc.work_units) ? doc.work_units.length : 0,
          evidence_files: evidence.length, evidence_views: views.slice(0, 32), ticket: p.outputs.ticket ?? null},
        req.free.length ? {missing_evidence: [`${req.free.length} capability requirement(s) are free text: not typed, so no requirement edge is admitted from them`]} : {});
        typedOf.set(r.hash, P);
        relOnce('derived-from', P, X, r, {basis: 'the passed plan record that states it'});
        relOnce('derived-from', P, I, r, {basis: 'the plan is made for this item\'s requirement', requirement: p.identity.requirement});
        for (const d of doc.dependencies ?? []) if (typeof d === 'string' && d) relOnce('depends-on', P, item(d, r), r, {basis: 'the plan names this dependency'});
        for (const t of req.typed) {
          named(t.id, r, `named as a requirement by a plan of ${it}`);
          relOnce(t.type, P, t.id, r, {basis: `the plan states this requirement (${t.field})`, why: t.why});
        }
        for (const e of evidence) {
          entity(fileId(e.path), r, {path: e.path, cited_by_work_ledger: true});
          relOnce('derived-from', P, fileId(e.path), r, {basis: 'the plan cites this file as evidence, by the digest of the bytes it was given', sha256: e.sha256});
        }
        if (plain(p.outputs.ticket) && typeof p.outputs.ticket.path === 'string') {
          entity(ticketId(it), r, {item: it});
          relOnce('derived-from', ticketId(it), P, r, {basis: 'the plan wrote this ticket', path: p.outputs.ticket.path, digest: p.outputs.ticket.digest ?? null});
        }
        const units = Array.isArray(doc.work_units) ? doc.work_units.filter(u => plain(u) && typeof u.unit_id === 'string') : [];
        const ids = new Set(units.map(u => u.unit_id));
        for (const u of units) {
          const N = unitId(r.hash, u.unit_id), unknown = (u.depends_on ?? []).filter(d => !ids.has(d));
          entity(N, r, {plan: r.hash, item: it, unit_id: u.unit_id, owned_paths: (u.owned_paths ?? []).slice(0, 32), difficulty: u.difficulty ?? null,
            specialist_role: u.specialist_role ?? null, verify_cmd: cut(u.verify_cmd, 300), depends_on: (u.depends_on ?? []).slice(0, 32), invariants: (u.invariants ?? []).length},
          unknown.length ? {missing_evidence: [`depends on ${unknown.join(', ')}, which is not a unit of this plan`]} : {});
          relOnce('derived-from', N, P, r, {basis: 'a work unit of the plan'});
        }
        for (const u of units) for (const d of u.depends_on ?? []) if (ids.has(d) && d !== u.unit_id) relOnce('depends-on', unitId(r.hash, u.unit_id), unitId(r.hash, d), r, {basis: 'the unit depends on this unit'});
      } else if (p.stage === 'implement' && p.status === 'passed' && upstream()) {
        const A = artifactId(r.hash), files = (p.outputs?.files ?? []).filter(f => typeof f === 'string');
        entity(A, r, {record: r.hash, item: it, commit: p.outputs?.commit ?? null, branch: p.outputs?.branch ?? null, files: files.slice(0, 64), ticket: p.identity?.ticket ?? null});
        typedOf.set(r.hash, A);
        relOnce('derived-from', A, upstream(), r, {basis: 'implemented from the plan it received'});
        relOnce('derived-from', A, X, r, {basis: 'the passed implement record that states it'});
        for (const f of files.slice(0, 64)) { entity(fileId(f), r, {path: f, cited_by_work_ledger: true}); relOnce('produces', A, fileId(f), r, {basis: 'the implemented change writes this file'}); }
      } else if (p.stage === 'review' && p.status === 'passed' && upstream()) {
        const R = stageReviewId(r.hash);
        entity(R, r, {record: r.hash, item: it, cycle: p.outputs?.cycle ?? null, close: p.outputs?.close ?? null, outcome: p.outputs?.outcome ?? null, labs: p.outputs?.labs ?? null});
        typedOf.set(r.hash, R);
        relOnce('derived-from', R, upstream(), r, {basis: 'the review received this change'});
        if (up && kindOf(up) === 'work/artifact') { artifactOf.set(r.hash, up); relOnce('verifies', R, up, r, {basis: 'the coordinated review closed on this change'}); }
      } else if (p.stage === 'validate' && upstream() && (p.status === 'passed' || typeof p.outputs?.verdict === 'string')) {
        const V = validationId(r.hash), A = artifactOf.get(from) ?? null;
        const cited = (p.outputs?.sources ?? []).filter(s => plain(s) && s.delivered && typeof s.source === 'string' && s.source.startsWith('file:') && s.version != null);
        entity(V, r, {record: r.hash, item: it, status: p.status, verdict: p.outputs?.verdict ?? null, criteria: (p.outputs?.criteria ?? []).filter(plain).map(c => ({id: c.id ?? null, met: c.met ?? null})).slice(0, 32),
          cited_files: cited.length});
        typedOf.set(r.hash, V);
        if (A) artifactOf.set(r.hash, A);
        relOnce('derived-from', V, upstream(), r, {basis: 'the validation received this review'});
        if (A) relOnce('verifies', V, A, r, {basis: 'the validator judged this change against the original requirement'});
        for (const s of cited.slice(0, 64)) {
          const f = s.source.slice(5);
          entity(fileId(f), r, {path: f, cited_by_work_ledger: true});
          relOnce('derived-from', V, fileId(f), r, {basis: 'the validator cited this file, by the version it was given', version: String(s.version)});
        }
      } else if (p.stage === 'outcome' && p.status === 'passed' && upstream()) {
        const C = completionId(r.hash);
        entity(C, r, {record: r.hash, item: it, to: p.outputs?.to ?? null, proposal_digest: p.outputs?.proposal_digest ?? null, commit: p.outputs?.commit ?? null,
          signed: false, claim: 'an UNSIGNED status proposal: a completion claim for the owner, who alone signs the status ledger; never a completion'});
        relOnce('derived-from', C, upstream(), r, {basis: 'the proposal rests on this validation'});
      }
    }
  }
  return drafts;
}

/** The work ledger as a source of the work graph: version = its head entry hash, read through openWorkLedger({create: false}). */
export function workGraphSource({root, anchor, extractor = WORK_GRAPH_EXTRACTOR}) {
  return {
    id: WORK_GRAPH_SOURCE, extractor, ref: 'status/work',
    authority: 'the work ledger (ophanim/operate/work-ledger.mjs; controller-signed, append-only; read only against its pinned anchor)',
    current: () => { const v = readWorkLedgerOnly({root, anchor}).verify(); if (!v.ok) throw new Error(`the work ledger does not verify: ${v.why}`); return {version: v.head}; },
    readAt: version => workGraphFacts(readWorkLedgerOnly({root, anchor}), version),
  };
}

// ---- shared prerequisites (KD1-2, demonstration 1) ------------------------------------------------------------------
const REQUIRING = ['work/plan', 'work/work-unit'];
const REQUIRED = id => /^(capability|systems)\//.test(kindOf(id));
const sourceOf = a => ({source: a.source.id, version: a.source.version, ref: a.source.ref, assertion: a.id, classification: a.classification});
/**
 * Whether the prerequisite `target` EXISTS, from what a source other than the one that names it states: an executable
 * capability of the capability graph (or one that combines the runtime, transport or tool, or a runtime that supports
 * the feature); a component with an established `implemented-by` / `implements`; a file the repository holds. A node
 * only NAMED by a plan (NAMING_SOURCES) is not evidence that it exists: missing is a GAP, never assumed.
 */
export function existenceOf(view, target, {naming = NAMING_SOURCES} = {}) {
  const stated = id => view.query(id, 'established').filter(a => !naming.includes(a.source.id));
  const k = kindOf(target), own = stated(target);
  const capOf = id => kindOf(id) === 'capability/capability' && stated(id).length > 0;
  const via = [];
  if (k === 'capability/capability' && own.length) return {exists: true, basis: 'an executable capability the capability graph states', by: [target], sources: own.map(sourceOf)};
  if (['capability/runtime', 'capability/transport', 'capability/tool'].includes(k)) {
    for (const e of view.edgesOf(target, {mode: 'established', types: ['combines']})) if (e.to === target && capOf(e.from)) via.push({id: e.from, relationship: e.type, assertions: e.assertions});
    if (via.length) return {exists: true, basis: `an executable capability combines this ${k.split('/')[1]}`, by: via.map(v => v.id).sort(byString), sources: via.flatMap(v => v.assertions.map(id => sourceOf(view.assertion(id))))};
  }
  if (k === 'capability/feature') {
    for (const e of view.edgesOf(target, {mode: 'established', types: ['supports']})) if (e.to === target && stated(e.from).length) {
      const caps = view.edgesOf(e.from, {mode: 'established', types: ['combines']}).filter(c => c.to === e.from && capOf(c.from));
      for (const c of caps) via.push({id: c.from, runtime: e.from, assertions: [...e.assertions, ...c.assertions]});
    }
    if (via.length) return {exists: true, basis: 'a runtime that supports the feature is combined into an executable capability', by: [...new Set(via.map(v => v.id))].sort(byString),
      sources: via.flatMap(v => v.assertions.map(id => sourceOf(view.assertion(id))))};
  }
  if (k.startsWith('systems/')) {
    for (const e of view.edgesOf(target, {mode: 'established', types: ['implemented-by', 'implements']})) {
      const other = e.from === target ? e.to : e.from;
      if (((e.type === 'implemented-by' && e.from === target) || (e.type === 'implements' && e.to === target)) && stated(other).length) via.push({id: other, relationship: e.type, assertions: e.assertions});
    }
    if (via.length) return {exists: true, basis: 'a component is stated to implement it', by: via.map(v => v.id).sort(byString), sources: via.flatMap(v => v.assertions.map(id => sourceOf(view.assertion(id))))};
    if (['systems/module', 'systems/test', 'systems/file', 'systems/symbol'].includes(k) && own.length) return {exists: true, basis: 'the repository holds it at the graph\'s commit', by: [target], sources: own.map(sourceOf)};
  }
  return {exists: false, basis: null, by: [], sources: [],
    gap: `no source states that ${keyOf(target)} exists: no executable capability provides it and no component is stated to implement it (a plan naming it is not evidence that it exists)`};
}

/**
 * The SHARED PREREQUISITES of independent work items: every capability or component that the plans (or units) of two
 * or more items require, by an ESTABLISHED `requires-capability` or `depends-on`. Each finding is a REPORT: the items'
 * ids, the requirement each states and where (its source, ref and ledger entry), and whether the prerequisite exists
 * (existenceOf). It never merges tickets, reassigns or re-owns work.
 */
export function sharedPrerequisites(view, {min = 2} = {}) {
  const by = new Map();
  for (const s of view.subjects()) {
    if (!REQUIRING.includes(kindOfSafe(s)) || !view.nodeIn(s, 'established')) continue;
    const it = view.node(s).attributes.item;
    if (typeof it !== 'string') continue;
    for (const e of view.edgesOf(s, {mode: 'established', types: ['requires-capability', 'depends-on']})) {
      if (e.from !== s || !REQUIRED(e.to)) continue;
      const a = view.assertion(e.assertions[0]).record;
      if (!by.has(e.to)) by.set(e.to, new Map());
      const items = by.get(e.to);
      if (!items.has(it)) items.set(it, []);
      items.get(it).push({by: s, relationship: e.type, why: a.attributes.why ?? null, stated: a.attributes.basis ?? null, ref: a.source.ref, version: a.source.version,
        assertions: [...e.assertions].sort(byString)});
    }
  }
  const findings = [];
  for (const [target, items] of [...by].sort((x, y) => byString(x[0], y[0]))) {
    if (items.size < min) continue;
    findings.push({prerequisite: target, kind: kindOf(target), items: [...items].sort((x, y) => byString(x[0], y[0])).map(([item, plans]) => ({item, requirements: plans})),
      existence: existenceOf(view, target),
      report: 'a shared prerequisite is reported, never acted on: each item keeps its own objective, ticket and ownership boundary; nothing is merged or reassigned'});
  }
  return {query: 'shared-prerequisites', cursor: view.seq, findings, note: findings.length ? `${findings.length} prerequisite(s) required by two or more items` : 'no capability or component is required by two or more items'};
}
const kindOfSafe = s => { try { return kindOf(s); } catch { return null; } };

/** The id of the finding about `target`: one per prerequisite, the same in every process (no writer's own state). */
export const sharedPrerequisiteId = target => discoveryId(`shared-prerequisite/${digest(target).slice(0, 32)}`);
/**
 * RECORD each shared-prerequisite finding as a `derived` work/discovery of the registered rule, its inputs the
 * requirement edges (and, where it exists, what establishes the prerequisite). A finding already recorded is a no-op;
 * a changed one supersedes the rule's own earlier finding of the same prerequisite. Writes nothing else.
 */
export function recordSharedPrerequisites(graph, by, {observed_at = new Date().toISOString(), view = graph.view()} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return recordFindings(graph, by, {observed_at, view}); }
    catch (e) {
      // Another writer superseded a finding under this one's feet: read again and recompute (bounded).
      if (attempt >= 3 || !/GRAPH_STALE/.test(e.message ?? '')) throw e;
      graph.refresh(); view = graph.view();
    }
  }
}
function recordFindings(graph, by, {observed_at, view}) {
  const out = [];
  for (const f of sharedPrerequisites(view).findings) {
    const inputs = [...new Set([...f.items.flatMap(i => i.requirements.flatMap(r => r.assertions)), ...f.existence.sources.map(s => s.assertion)])].sort(byString).slice(0, 1000);
    const subject = sharedPrerequisiteId(f.prerequisite);
    const attributes = {prerequisite: f.prerequisite, kind: f.kind,
      items: f.items.slice(0, 32).map(i => ({item: i.item, requirements: i.requirements.slice(0, 8).map(r => ({by: r.by, relationship: r.relationship, why: r.why, ref: r.ref}))})),
      existence: {exists: f.existence.exists, basis: f.existence.basis, by: f.existence.by.slice(0, 16), gap: f.existence.gap ?? null}, report: f.report};
    const draft = {entity: subject, origin: WORK_RULE, classification: 'derived', observed_at, inputs,
      source: {id: 'ophanim.work-rule', authority: 'the shared-prerequisite rule (ophanim/graph/work.mjs): derived from the requirement edges the work ledger states', ref: f.prerequisite,
        version: 'sha256:' + digest(inputs)},
      missing_evidence: f.existence.exists ? [] : [f.existence.gap], attributes};
    // The same finding (whatever it superseded) is a no-op; a changed one supersedes the rule's own current finding.
    const content = r => digest({attributes: r.attributes, inputs: r.inputs, missing_evidence: r.missing_evidence});
    const prior = view.query(subject, 'recorded').filter(a => a.current && a.origin === WORK_RULE).map(a => view.assertion(a.id).record);
    const same = prior.find(r => content(r) === content(draft));
    const record = assertion({...draft, supersedes: same ? [] : prior.map(r => r.id).sort(byString)});
    const w = same ? {appended: false} : record.supersedes.length ? graph.supersede([record], by) : graph.assert([record], by);
    out.push({prerequisite: f.prerequisite, id: same ? same.id : record.id, subject, recorded: Boolean(w.appended)});
  }
  return out;
}

/** Dependency cycles among the work graph's nodes (established depends-on), each as the list of its members; bounded. */
export function dependencyCycles(view, {max = 50} = {}) {
  const work = view.subjects().filter(s => kindOfSafe(s)?.startsWith('work/') && view.nodeIn(s, 'established'));
  const next = n => view.edgesOf(n, {mode: 'established', types: ['depends-on']}).filter(e => e.from === n && kindOfSafe(e.to)?.startsWith('work/')).map(e => e.to).sort(byString);
  const color = new Map(), cycles = [], stack = [];
  const visit = n => {
    color.set(n, 1); stack.push(n);
    for (const m of next(n)) {
      if (cycles.length >= max) break;
      if (color.get(m) === 1) cycles.push(stack.slice(stack.indexOf(m)));
      else if (!color.has(m)) visit(m);
    }
    stack.pop(); color.set(n, 2);
  };
  for (const n of work) if (!color.has(n) && cycles.length < max) visit(n);
  return cycles;
}
