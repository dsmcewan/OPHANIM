// ADVISORY ELIGIBILITY over the capability graph (knowledge graphs, Slice C1, KC3; docs/knowledge-graph/slice-c1.md).
//
// Purpose   An EXPLAINABLE decision of which executable capabilities may serve a task's requirements (role, task profile,
//           needed features, context, effort, delegation), from capability EVIDENCE only (owner decision 2026-11-20, "Work by
//           evidence, review by lab"). Each decision lists the eligible capabilities and why, what excluded every other one,
//           the capability snapshot's digest and versions it was decided on, and its own digest.
// Modes     the directive's three, mapped onto selectSeat's precedence (route/frontier.mjs PRECEDENCE):
//             automatic  policy | profile                 every capability the evidence admits
//             preferred  operator-override | slot-override the operator's capability, with its documented fallback: an
//                                                        explicit seat is its chair's only occupant; its pools, in order,
//                                                        are the only transport failover (so no other capability)
//             pinned     ticket-pin | escalation           the required capability; one that is not eligible is reported
//                                                        as one that WOULD BE REFUSED
//           ADVISORY (owner decision 2026-11-20, "Keep the seats as we have them for now"): nothing here refuses, reorders or
//           selects a live seat. route/frontier.mjs records the decision beside each live selection (advisory.mjs).
// Lab       enters only as lineage, and as the reviewer-exclusion input of a role that REVIEWS (roles.mjs: needs a different
//           vendor, or may judge): it never restricts who may do the work. The three-lab floor of a change review is unchanged
//           and reported.
// Must never  read an owner-directed placement (a seating row, a fit-matrix cell) as evidence of eligibility (they are
//           reported, as direction); count a hypothetical or unresolved assertion as established; claim isolation the
//           bubble does not hold; resolve an unknown model or runtime to something else (it is unresolved, and a pin of it
//           would be refused).
import {digest} from '../../../packages/ledger/canonical.mjs';
import {E, capabilityId, bubbleHolds} from './graph.mjs';

export const ELIGIBILITY_SCHEMA = 'pantheon.capability-eligibility/v1';
export const MODES = Object.freeze(['automatic', 'preferred', 'pinned']);
/** selectSeat's precedence (route/frontier.mjs PRECEDENCE, and the argo `profile` source) -> the directive's mode. */
export const MODE_OF_SOURCE = Object.freeze({escalation: 'pinned', 'slot-override': 'preferred', 'ticket-pin': 'pinned', 'operator-override': 'preferred', policy: 'automatic', profile: 'automatic'});
export const PREFERRED_FALLBACK = 'an explicit seat is its chair\'s only occupant; its pools, in order, are the only transport failover (route/frontier.mjs selectSeat): no other capability is used';
export const REVIEW_FLOOR = Object.freeze({value: 3, basis: 'the three-lab floor of a change review (owner decision 2026-11-20: unchanged)'});
const ROLE_LINEAGE = 'lab is lineage only for a role that does not review: avoided vendors and labs are recorded, never applied (owner decision 2026-11-20, "Work by evidence, review by lab")';
const H = v => 'sha256:' + digest(v);
const uniq = xs => [...new Set(xs)];

/** Normalize a task's requirements. Unknown fields are refused: a requirement no check reads would be silently ignored. */
export function requirementsOf(spec = {}) {
  const known = ['role', 'mode', 'context', 'effort', 'features', 'delegation', 'avoid', 'avoid_labs', 'bubble', 'billing', 'target', 'quota_failover', 'task', 'runtime',
    'agy_transport', 'review_floor', 'source', 'profile'];
  for (const k of Object.keys(spec)) if (!known.includes(k)) throw new Error(`eligibility: unknown requirement "${k}" (known: ${known.join(', ')})`);
  if (typeof spec.role !== 'string' || !spec.role) throw new Error('eligibility: a requirement names its role');
  const mode = spec.mode ?? 'automatic';
  if (!MODES.includes(mode)) throw new Error(`eligibility: mode is one of ${MODES.join(', ')}`);
  if (mode !== 'automatic' && !spec.target?.model) throw new Error(`eligibility: a ${mode} requirement names its target {vendor, model, transport}`);
  return {role: spec.role, mode, source: spec.source ?? null, profile: spec.profile ?? null,
    context: Number.isFinite(spec.context) ? spec.context : null, effort: spec.effort ?? null,
    features: uniq(spec.features ?? []).sort(), delegation: Number.isInteger(spec.delegation) ? spec.delegation : null,
    avoid: uniq(spec.avoid ?? []).sort(), avoid_labs: uniq(spec.avoid_labs ?? []).sort(),
    bubble: spec.bubble ?? 'record', billing: {gemini_primary: spec.billing?.gemini_primary ?? null},
    target: spec.target ? {vendor: spec.target.vendor ?? null, model: spec.target.model, transport: spec.target.transport ?? null} : null,
    quota_failover: Boolean(spec.quota_failover), task: spec.task ?? null, runtime: spec.runtime ?? null,
    agy_transport: spec.agy_transport ?? 'cli', review_floor: spec.review_floor ?? REVIEW_FLOOR.value};
}

// ---- reading the graph -------------------------------------------------------------------------------------------------
const attrs = (ix, id) => ix.node(id)?.attributes ?? {};
/** The occupant (model or lane) an executable capability combines. */
const occupantOf = (ix, cap) => (ix.allOut(cap) ?? []).find(e => e.type === 'combines' && ['model', 'lane'].includes(e.attributes?.component))?.to ?? null;
/** The model an occupant denotes (a lane is an alias of its base model). */
function modelOfOccupant(ix, occ) {
  if (!occ) return null;
  if (ix.node(occ)?.type === 'model') return occ;
  return ix.out(occ, 'alias-of')[0]?.to ?? null;
}
/** The lab of a capability, for lineage and reviewer exclusion: made-by of its model; a lane's own declared lab otherwise. */
function labOf(ix, cap) {
  const occ = occupantOf(ix, cap), model = modelOfOccupant(ix, occ);
  const madeBy = model ? ix.out(model, 'made-by')[0]?.to : null;
  if (madeBy) return {lab: decodeTail(madeBy), via: `made-by (${decodeTail(model)})`};
  const own = occ ? attrs(ix, occ).lab : null;
  return own ? {lab: own, via: 'the lane\'s declared lab (lanes.json)'} : {lab: null, via: 'no lab in the graph'};
}
const decodeTail = id => decodeURIComponent(id.split('/').slice(3).join('/'));
/** The documented window of a capability's occupant: a lane's cited window; a model's cited fact, else its frontier capability. */
function windowOf(ix, occ) {
  const a = attrs(ix, occ);
  if (ix.node(occ)?.type === 'lane') return a.window?.value ? {value: a.window.value, source: a.window.source ?? 'pantheon/src/config/lanes.json'} : null;
  if (a.facts?.window?.value) return {value: a.facts.window.value, source: a.facts.window.source};
  if (Number.isFinite(a.frontier?.window)) return {value: a.frontier.window, source: 'packages/model-client/registry.mjs CAPABILITIES'};
  return null;
}
function effortsOf(ix, occ) {
  const model = modelOfOccupant(ix, occ), m = model ? attrs(ix, model) : {};
  return m.facts?.efforts?.values ?? m.frontier?.efforts ?? [];
}

/** The capability id a live seat ({vendor, model, transport}) is served as, under the same rule as frontier.mjs seatTransport. */
export function capabilityOfSeat(ix, {vendor, model, transport = null}, {role = null, agy_transport = 'cli'} = {}) {
  const lane = ix.node(E('lane', model));
  let profile;
  if (transport === 'api' || transport === 'agy-cli' || transport === 'agy-sdk') profile = transport;
  else if (transport === 'agy') profile = ['reviewer', 'scout'].includes(role) && agy_transport === 'sdk' ? 'agy-sdk' : 'agy-cli';
  else if (lane) profile = 'agy-cli';
  else {
    const m = attrs(ix, E('model', model));
    profile = m.frontier || (vendor && vendor !== 'agy_google') ? 'api' : ['reviewer', 'scout'].includes(role) && agy_transport === 'sdk' ? 'agy-sdk' : 'agy-cli';
  }
  const id = capabilityId(profile, vendor ?? (lane ? lane.attributes.vendor : attrs(ix, E('model', model)).vendor ?? 'unknown'), model);
  return ix.node(id) ? id : null;
}

// ---- the checks --------------------------------------------------------------------------------------------------------
/**
 * Every reason capability `cap` is not eligible for `req` (empty: eligible), plus what is recorded about it either way
 * (lab lineage, the bubble, the owner-directed placements, conditions). Pure over the index.
 */
export function judge(ix, req, cap, {roleNode = ix.node(E('role', req.role))} = {}) {
  const why = [], notes = [], conditions = [];
  const n = ix.node(cap), a = n?.attributes ?? {};
  const no = (check, text, extra = {}) => why.push({check, why: text, ...extra});
  if (!n) { no('unknown', 'not an executable capability of the graph'); return {why, notes, conditions, lab: null, bubble: null}; }
  if (!n.established) no('established', `not established: ${n.missing_evidence.join('; ') || 'unresolved or hypothetical'}`);
  // Every component the combination is made of must itself be established (an unresolved runtime claim, a withdrawn lane).
  for (const e of ix.allOut(cap).filter(x => x.type === 'combines')) {
    if (!e.established || !ix.established(e.to)) no('component', `its ${e.attributes?.component ?? 'component'} ${decodeTail(e.to)} is not established (${ix.node(e.to)?.missing_evidence?.join('; ') || 'absent from the graph'})`);
  }
  if (a.availability?.state && a.availability.state !== 'available') no('availability', `${a.availability.state}: ${a.availability.why}`, {source: a.availability.source});
  if (req.runtime && a.runtime !== req.runtime) no('runtime', `runs in ${a.runtime}, not the required ${req.runtime}`);
  if (Array.isArray(a.roles) && !a.roles.includes(req.role)) no('role', `the ${a.runtime} runtime serves only the roles ${a.roles.join(', ')}`, {evidence: attrs(ix, E('runtime', a.runtime)).evidence?.[0] ?? null});
  if (a.use?.value === 'quota-failover' && !req.quota_failover) no('use', `served only as a quota failover: ${a.use.why}`);
  for (const e of ix.out(cap, 'limited-by')) {
    const l = attrs(ix, e.to), id = decodeTail(e.to);
    if (l.blocks) no('limitation', `${id}: ${l.title}`, {limitation: id});
    if ((l.blocks_roles ?? []).includes(req.role)) no('limitation', `${id} blocks the ${req.role} role: ${l.title}`, {limitation: id});
    for (const f of (l.excludes ?? []).filter(f => req.features.includes(f))) no('feature', `${id} excludes the required ${f}: ${l.title}`, {limitation: id});
    if (l.requires === 'gemini_api_primary') {
      if (req.billing.gemini_primary === false) no('billing', `${id}: ${l.title}`, {limitation: id});
      else if (req.billing.gemini_primary === null) conditions.push(`${id}: ${l.title}`);
    }
  }
  const occ = occupantOf(ix, cap);
  if (req.context !== null) {
    const w = windowOf(ix, occ);
    if (!w) no('context', `window unrecorded; cannot admit an estimated ${req.context} tokens (M7)`);
    else if (w.value < req.context) no('context', `documented window ${w.value} < estimated ${req.context}`, {source: w.source});
  }
  if (req.effort) {
    if (a.effort !== 'carried') no('effort', `effort ${req.effort} is not carried by the ${a.transport} transport (${a.effort})`);
    else if (!effortsOf(ix, occ).includes(req.effort)) no('effort', `effort ${req.effort} is not on the documented ladder [${effortsOf(ix, occ).join(', ')}]`);
  }
  const provided = ix.out(E('runtime', a.runtime), 'supports').map(e => decodeTail(e.to));
  for (const f of req.features) if (!provided.includes(f)) no('feature', `the ${a.runtime} runtime does not provide ${f}`);
  if (req.delegation !== null && req.delegation > 0 && !(a.delegation?.native_subagents && (a.delegation.depth ?? 0) >= req.delegation
    && (!a.delegation.roles_with_subagents || a.delegation.roles_with_subagents.includes(req.role)))) {
    no('delegation', `delegation depth ${req.delegation} is not provided: ${a.delegation?.why ?? 'no delegation declared'}`);
  }
  // REVIEW BY LAB: the contributing labs (and vendors) are excluded only for a role that reviews.
  const lab = labOf(ix, cap), reviews = Boolean(roleNode?.attributes?.reviews);
  if (reviews) {
    if (lab.lab && req.avoid_labs.includes(lab.lab)) no('independence', `the ${lab.lab} lab contributed to the work under review (reviewer independence)`, {lab: lab.lab});
    if (req.avoid.includes(a.vendor)) no('independence', `vendor ${a.vendor} contributed to the work under review (reviewer independence)`);
    if (!lab.lab) no('independence', 'no lab in the graph: reviewer independence cannot be checked');
  } else if ((lab.lab && req.avoid_labs.includes(lab.lab)) || req.avoid.includes(a.vendor)) notes.push(`${lab.lab ?? a.vendor}: ${ROLE_LINEAGE}`);
  const bubble = {holds: bubbleHolds(a.bubble), components: Object.fromEntries(Object.entries(a.bubble ?? {}).map(([k, v]) => [k, v.holds])),
    limitations: uniq(Object.values(a.bubble ?? {}).map(v => v.limitation).filter(Boolean))};
  if (req.bubble === 'required' && !bubble.holds) {
    const broken = Object.entries(a.bubble ?? {}).filter(([, v]) => !(v.holds === true || v.holds === 'not-applicable'));
    no('bubble', `the bubble does not hold: ${broken.map(([k, v]) => `${k} ${v.holds === false ? 'does not hold' : 'is unresolved'}${v.limitation ? ` (${v.limitation})` : ''}: ${v.why}`).join('; ')}`);
  }
  return {why, notes, conditions, lab, bubble};
}

/** The owner- or operator-directed placements of `occupant` for `role`: reported as direction, never read as evidence. */
function placementsOf(ix, role, occ) {
  const roleId = E('role', role);
  return ix.in(occ, 'places').map(e => e.from).filter(p => ix.out(p, 'places').some(x => x.to === roleId))
    .map(p => { const a = attrs(ix, p); return {placement: decodeTail(p), table: a.table, rank: a.rank, basis: a.basis, evidence_type: a.evidence_type}; })
    .sort((x, y) => (x.placement < y.placement ? -1 : 1));
}

/**
 * The decision for `requirements` over a capability snapshot (graph.mjs capabilitySnapshot) or {index, digest, sources}
 * (a graph view: indexOfView). Never throws for an unknown model, runtime or role: those are reported unresolved.
 */
export function decide(snapshot, requirements) {
  const req = requirementsOf(requirements), ix = snapshot.index;
  const snap = {digest: snapshot.digest, contract: snapshot.contract ?? null, versions: Object.fromEntries((snapshot.sources ?? []).map(s => [s.id, s.version]))};
  const unresolved = [];
  const roleNode = ix.node(E('role', req.role));
  if (!roleNode?.established) unresolved.push(`role ${req.role} is not in the capability graph`);
  if (req.runtime && !ix.node(E('runtime', req.runtime))?.established) unresolved.push(`runtime ${req.runtime} is not in the capability graph`);
  for (const f of req.features) if (!ix.node(E('feature', f))?.established) unresolved.push(`feature ${f} is not in the capability graph`);
  const caps = ix.ofType('capability').map(n => n.id).sort();
  const eligible = [], excluded = [], lineage = {};
  for (const cap of caps) {
    const j = judge(ix, req, cap, {roleNode});
    if (j.lab?.lab) (lineage[j.lab.lab] ??= []).push(decodeTail(cap));
    const occ = occupantOf(ix, cap);
    if (!j.why.length && !unresolved.length) eligible.push({capability: decodeTail(cap), lab: j.lab.lab, lab_via: j.lab.via, runtime: attrs(ix, cap).runtime, transport: attrs(ix, cap).transport,
      bubble: j.bubble, placed: placementsOf(ix, req.role, occ), ...(j.conditions.length ? {conditions: j.conditions} : {}), ...(j.notes.length ? {notes: j.notes} : {})});
    else excluded.push({capability: decodeTail(cap), why: unresolved.length ? [{check: 'unresolved', why: unresolved.join('; ')}, ...j.why] : j.why});
  }
  // The target of a preferred or pinned requirement.
  let target = null;
  if (req.target) {
    const id = capabilityOfSeat(ix, req.target, {role: req.role, agy_transport: req.agy_transport});
    const j = id ? judge(ix, req, id, {roleNode}) : null;
    const ok = Boolean(id) && !j.why.length && !unresolved.length;
    target = {requested: req.target, capability: id ? decodeTail(id) : null, eligible: ok,
      why: !id ? [{check: 'unresolved', why: `${req.target.vendor ?? '?'}/${req.target.model} is not an executable capability of the capability graph`}] : [...(unresolved.length ? [{check: 'unresolved', why: unresolved.join('; ')}] : []), ...j.why],
      ...(req.mode === 'pinned' ? {would_refuse: !ok, refusal: ok ? null : 'a pinned capability must be used or the assignment refused: this one WOULD BE REFUSED (advisory: nothing is refused live)'} : {}),
      ...(req.mode === 'preferred' ? {fallback: {documented: PREFERRED_FALLBACK, would_fall_back_to: ok ? null : [], note: ok ? null : 'the preference is not eligible, and its documented fallback reaches no other capability'}} : {})};
    if (!id) unresolved.push(`${req.target.model} is not an executable capability of the capability graph`);
  }
  const reviews = Boolean(roleNode?.attributes?.reviews);
  const labs = uniq(eligible.map(e => e.lab).filter(Boolean)).sort();
  const review = reviews ? {applies: true, excluded_labs: req.avoid_labs, excluded_vendors: req.avoid, distinct_labs: labs.length, labs,
    floor: {value: req.review_floor, basis: REVIEW_FLOOR.basis, met: labs.length >= req.review_floor}} : {applies: false, why: ROLE_LINEAGE, recorded_labs: req.avoid_labs, recorded_vendors: req.avoid};
  const byCheck = {};
  for (const x of excluded) for (const w of x.why) byCheck[w.check] = (byCheck[w.check] ?? 0) + 1;
  const broken = eligible.filter(e => !e.bubble.holds);
  const explanation = [
    `${req.mode} (${req.source ?? 'requirements'}): ${eligible.length} of ${caps.length} executable capabilities are eligible for ${req.role} on capability evidence (snapshot ${snap.digest}).`,
    ...(excluded.length ? [`excluded ${excluded.length}: ${Object.entries(byCheck).sort().map(([k, v]) => `${k} ${v}`).join(', ')}.`] : []),
    ...(unresolved.length ? [`unresolved: ${unresolved.join('; ')}.`] : []),
    ...(target ? [`${req.mode} ${target.requested.vendor ?? '?'}/${target.requested.model}: ${target.eligible ? 'eligible' : `${req.mode === 'pinned' ? 'WOULD BE REFUSED' : 'not eligible'}: ${target.why.map(w => w.why).join('; ')}`}.`] : []),
    reviews ? `review by lab: ${req.avoid_labs.length ? `the contributing labs ${req.avoid_labs.join(', ')} are excluded` : 'no contributing lab named'}; ${labs.length} distinct labs remain (${labs.join(', ') || 'none'}), the floor of ${req.review_floor} ${labs.length >= req.review_floor ? 'is met' : 'is NOT met'}.`
      : (req.avoid_labs.length || req.avoid.length ? `${ROLE_LINEAGE}.` : null),
    ...(broken.length ? [`the bubble does not hold for ${broken.length} eligible capabilit${broken.length === 1 ? 'y' : 'ies'}: ${broken.map(e => `${e.capability} (${Object.entries(e.bubble.components).filter(([, v]) => v !== true && v !== 'not-applicable').map(([k]) => k).join(', ')}${e.bubble.limitations.length ? `; ${e.bubble.limitations.join(', ')}` : ''})`).join('; ')}.`] : []),
    'advisory: live seat selection keeps the owner-directed seating tables and fit matrix; this decision changes no seat (owner decision 2026-11-20).',
  ].filter(Boolean);
  const body = {schema: ELIGIBILITY_SCHEMA, advisory: true, mode: req.mode, role: req.role, snapshot: snap, requirements: req, eligible, excluded, target, review,
    lineage: Object.fromEntries(Object.entries(lineage).sort()), unresolved, explanation};
  return {...body, digest: H(body)};
}

/**
 * The decision as a selection record carries it: every field but the per-capability detail, which is re-derived by
 * decide(snapshot, requirements) from the snapshot the record names (its digest is the full decision's).
 */
export function compactDecision(d) {
  return {schema: d.schema, digest: d.digest, advisory: true, mode: d.mode, role: d.role, snapshot: d.snapshot, requirements: d.requirements,
    eligible: d.eligible.map(e => e.capability), excluded: Object.fromEntries(d.excluded.map(x => [x.capability, uniq(x.why.map(w => w.check))])),
    target: d.target, review: d.review, unresolved: d.unresolved, explanation: d.explanation};
}
