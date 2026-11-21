// THE CAPABILITY AND MODEL/RUNTIME GRAPH (knowledge graphs, Slice C1; the directive's Graph A; docs/knowledge-graph/slice-c1.md).
//
// Purpose   Project Pantheon's real registries as `capability`-domain assertions of the graph contract (packages/graph,
//           ophanim.graph/v1, contract 1.1.0), through REGISTERED EXTRACTORS that observe each source at its version. A model
//           and its runtime are separate entities; the EXECUTABLE CAPABILITY is their combination (model or lane x runtime x
//           transport x tools x sandbox profile x credential scope) with the constraints under which it works, and with its
//           isolation (the bubble, owner decision 2026-11-20 "Yes, bubble per seat") as the CODE provides it.
// Inputs    the registries (currentRegistries): packages/model-client/models.json and registry.mjs CAPABILITIES; the cited
//           capability facts and the routing classes; the identity policy (model-identity.json); lanes.json; the runtime
//           declarations (runtimes.json), each claim with its code evidence; roles, chairs; the owner-directed seating tables
//           (role/seating.mjs), the ARGO seats (route/frontier.mjs) and the fit matrix (route/fit-matrix.mjs), READ ONLY.
// Outputs   capabilitySources(): one source adapter per registry ({id, extractor, authority, ref, current, readAt}), for
//           packages/graph openGraph; capabilityOrigins(): the extractors' registration; capabilitySnapshot(): every fact the
//           extractors project at the current versions, validated by the graph schema, with the snapshot's digest and versions
//           and an index the eligibility decision reads (eligibility.mjs); indexOfView(): the same index over a graph view.
// Sources   pantheon.runtimes  runtimes, transports, environments, pools, tools, features, limitations  (declared + code evidence)
//           pantheon.models    providers, labs, registry models (cited facts, frontier capabilities, routing class), made-by
//           pantheon.lanes     Antigravity lanes (transport, thinking level, cited window, retired), served-by
//           pantheon.identity  models only the identity policy declares, their labs, alias-of (same_model)
//           pantheon.roles     roles, chairs, holds
//           pantheon.executable  the executable capabilities, combines, runs-in, limited-by, the bubble    (structural)
//           pantheon.seating   SEATING, INTAKE and ARGO placements, the subagent depth limit      (owner direction, declared)
//           pantheon.fit-matrix  the fit matrix cells, the implementer ladders, the reviewer path (owner direction, declared)
// Must never  record an owner-directed placement as a measurement (its evidence type is owner-direction, its basis declared);
//           emit qualified-for (that needs measurements under an owner-defined criterion: metrics.mjs); claim an isolation
//           property whose code evidence is not found (it is recorded unresolved); collapse a model into its runtime; write
//           any registry, seating.mjs or fit-matrix.mjs; claim a source is continuously synchronized (it is current as of its
//           last observation).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {digest} from '../../../packages/ledger/canonical.mjs';
import {entityId, versionOf} from '../../../packages/graph/identity.mjs';
import {defineOrigins, CONTRACT_VERSION, GRAPH_SCHEMA} from '../../../packages/graph/schema.mjs';
import {createProjection} from '../../../packages/graph/projection.mjs';
import {CAPABILITIES} from '../../../packages/model-client/registry.mjs';
import {SEATING, INTAKE, DEPTH_LIMIT, modelOf} from '../role/seating.mjs';
import {FIT_MATRIX, IMPLEMENTER_LADDERS, REVIEWER_ESCALATION, FIT_DIFFICULTIES} from '../route/fit-matrix.mjs';
import {SEAT_FACTS} from '../route/router.mjs';
import {ROLES} from '../role/roles.mjs';
import {ROSTER} from '../team/roster.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SNAPSHOT_SCHEMA = 'pantheon.capability-snapshot/v1';
export const DECLARED = 'pantheon.capability.declared';
export const STRUCTURAL = 'pantheon.capability.structural';
export const METRICS_TOOL = 'pantheon.capability.metrics';
export const S = Object.freeze({runtimes: 'pantheon.runtimes', models: 'pantheon.models', lanes: 'pantheon.lanes', identity: 'pantheon.identity',
  roles: 'pantheon.roles', executable: 'pantheon.executable', seating: 'pantheon.seating', fit: 'pantheon.fit-matrix'});
/** The order sources are observed in: every relationship's endpoints are projected by its own source or an earlier one. */
export const SOURCE_ORDER = Object.freeze([S.runtimes, S.models, S.lanes, S.identity, S.roles, S.executable, S.seating, S.fit]);
const EXTRACTOR_OF = {[S.executable]: STRUCTURAL};
export const extractorOf = id => EXTRACTOR_OF[id] ?? DECLARED;
/** The evidence types the graph distinguishes (owner decision 3 and the directive: never merged). */
export const EVIDENCE_TYPES = Object.freeze({documented: 'a documented capability: a registry or vendor document states it, cited',
  code: 'a property the code provides, with the file and the quote it was read from', 'owner-direction': 'an owner- or operator-directed placement: a direction, never a measurement',
  measured: 'a metric extracted from execution records (metrics.mjs)'});

/**
 * The extractors' (and the metrics tool's) registration in an origin registry. `keys` maps each origin to the key ids that
 * may write as it: WHICH key signs is the owner's decision (docs/knowledge-graph/architecture.md section 16), so it is
 * the composer's argument, never a default here.
 */
export function capabilityOrigins({keys, extra = {}}) {
  if (!keys?.[DECLARED]?.length || !keys?.[STRUCTURAL]?.length) throw new Error('capabilityOrigins: name the key ids of both extractors (an owner decision)');
  return defineOrigins({
    [DECLARED]: {kind: 'extractor', basis: 'declared', keys: keys[DECLARED], sources: SOURCE_ORDER.filter(s => extractorOf(s) === DECLARED)},
    [STRUCTURAL]: {kind: 'extractor', basis: 'structural', keys: keys[STRUCTURAL], sources: [S.executable]},
    ...(keys[METRICS_TOOL]?.length ? {[METRICS_TOOL]: {kind: 'tool', basis: 'measured', keys: keys[METRICS_TOOL]}} : {}),
    ...extra,                                                     // other origins of the composition (agents, models, tools)
  });
}
// The registry a snapshot is materialized under. Nothing is signed or written for a snapshot, so its key id is a label.
const SNAPSHOT_ORIGINS = capabilityOrigins({keys: {[DECLARED]: ['unsigned-snapshot'], [STRUCTURAL]: ['unsigned-snapshot']}});

// ---- the registries ----------------------------------------------------------------------------------------------------
const plainOf = v => JSON.parse(JSON.stringify(v));
const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
/** git's blob id of these bytes (sha1 of "blob <length>\0<bytes>"), computed without running git. */
export const blobId = text => { const b = Buffer.from(text, 'utf8'); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };
/** Every {file, quote} under a declaration. */
export function evidenceOf(value, out = []) {
  if (Array.isArray(value)) for (const v of value) evidenceOf(v, out);
  else if (value && typeof value === 'object') {
    if (typeof value.file === 'string' && typeof value.quote === 'string') out.push(value);
    for (const v of Object.values(value)) evidenceOf(v, out);
  }
  return out;
}

/**
 * The registries as data, read now. JSON registries are read from their files (their content at this checkout); the code
 * tables (frontier capabilities, seating, fit matrix, roles, roster) are the modules' values. `argo`: the ARGO seat table
 * (route/frontier.mjs ARGO_SEATS), passed by the caller so this module never imports the selector. `evidence` holds the
 * text of every file the runtime declarations cite, so each quote is checked against the code it names.
 */
export function currentRegistries({argo = null, root = ROOT} = {}) {
  const runtimes = readJson(root, 'pantheon/src/capability/runtimes.json');
  const files = [...new Set(evidenceOf(runtimes).map(e => e.file))].sort();
  const evidence = Object.fromEntries(files.map(f => { try { return [f, fs.readFileSync(path.join(root, f), 'utf8')]; } catch { return [f, null]; } }));
  return {
    models: readJson(root, 'packages/model-client/models.json'),
    frontier: plainOf(CAPABILITIES),
    facts: readJson(root, 'pantheon/src/config/capability-facts.json'),
    classes: readJson(root, 'pantheon/src/config/classes.json'),
    continuity: Object.fromEntries(Object.entries(SEAT_FACTS).map(([v, f]) => [v, {continuity: f.continuity ?? null, quota_pool: f.quota_pool ?? null}])),
    identity: readJson(root, 'pantheon/src/config/model-identity.json'),
    lanes: readJson(root, 'pantheon/src/config/lanes.json'),
    runtimes, evidence,
    roles: Object.fromEntries(Object.entries(ROLES).map(([r, x]) => [r, {needs: [...(x.needs ?? [])], may_judge: Boolean(x.mayJudge), produces_kinds: [...(x.produces_kinds ?? [])], pre_board: Boolean(x.preBoard)}])),
    roster: plainOf(ROSTER),
    seating: Object.fromEntries(Object.entries(SEATING).map(([role, rows]) => [role, rows.map(c => ({vendor: c.vendor, model: modelOf(c), band: c.band ?? null, basis: c.basis, why: c.why ?? null}))])),
    intake: Object.fromEntries(Object.entries(INTAKE).map(([role, rows]) => [role, rows.map(c => ({vendor: c.vendor, model: modelOf(c), band: c.band ?? null, basis: c.basis, why: c.why ?? null}))])),
    argo: argo ? plainOf(argo) : null,
    depth_limit: DEPTH_LIMIT,
    fit: {matrix: plainOf(FIT_MATRIX), ladders: plainOf(IMPLEMENTER_LADDERS), reviewer_escalation: plainOf(REVIEWER_ESCALATION), difficulties: [...FIT_DIFFICULTIES]},
  };
}

// ---- ids ---------------------------------------------------------------------------------------------------------------
export const E = (type, key) => entityId({domain: 'capability', type, key});
export const capabilityKey = (profile, vendor, model) => `${profile}/${vendor}/${model}`;
export const capabilityId = (profile, vendor, model) => E('capability', capabilityKey(profile, vendor, model));
const VENDOR_OF_REGISTRY = v => (v === 'google' ? 'agy_google' : v);
const LAB_OF_VENDOR = v => (v === 'agy_google' ? 'google' : v);
const registryModels = models => Object.entries(models).flatMap(([key, names]) => Object.entries(names).map(([name, id]) => ({vendor: VENDOR_OF_REGISTRY(key), registry_key: key, name, model: id})));
const laneTable = lanes => lanes?.agy_cli ?? {};

// ---- the evidence check ------------------------------------------------------------------------------------------------
/** Each {file, quote} of a claim with `found`: the quote read verbatim in that file's text, or not. */
function checked(list, texts) {
  return (list ?? []).map(e => ({file: e.file, quote: e.quote, found: typeof texts?.[e.file] === 'string' && texts[e.file].includes(e.quote)}));
}
const missingOf = ev => ev.filter(e => !e.found).map(e => `evidence not found: "${e.quote.slice(0, 120)}" in ${e.file}`);
/** A claim's draft fields: its evidence checked, and `unresolved` with the missing evidence when any quote is not found. */
function claim(list, texts) {
  const evidence = checked(list, texts), missing = missingOf(evidence);
  return {evidence, missing, ...(missing.length ? {status: 'unresolved'} : {})};
}
/** A bubble component as the code provides it: `holds` is the declared value only when every quote is found, else unresolved. */
function bubbleComponent(c, texts) {
  const evidence = checked(c?.evidence, texts), missing = missingOf(evidence);
  const declared = c?.holds ?? null;
  // A component that does NOT hold needs no proof to be recorded so. One that holds (or does not apply) is recorded so only
  // on its evidence, every quote found; anything else is unresolved, never isolated.
  const holds = declared === false ? false
    : (declared === true || declared === 'not-applicable') && evidence.length && !missing.length ? declared : 'unresolved';
  return {holds, declared, why: c?.why ?? null, limitation: c?.limitation ?? null, evidence, ...(missing.length ? {missing} : {})};
}
const BUBBLE = Object.freeze(['sandbox', 'credentials', 'tools', 'lifetime']);
/** Whether a bubble holds as a whole: every component holds (or does not apply) on code evidence. */
export const bubbleHolds = b => BUBBLE.every(k => b?.[k]?.holds === true || b?.[k]?.holds === 'not-applicable');

// ---- the extractors (one per source; each projects only its own source's data) ------------------------------------------
const ent = (type, key, ref, attributes, extra = {}) => ({entity: E(type, key), ref, attributes, ...extra});
const rel = (type, from, to, ref, attributes = {}) => ({type, from, to, ref, attributes});
const claimDraft = (type, key, ref, attributes, c, extra = {}) => ent(type, key, ref, {...attributes, evidence: c.evidence, evidence_type: 'code'},
  {...extra, ...(c.missing.length ? {status: 'unresolved', missing_evidence: c.missing} : {})});

function extractRuntimes({declaration: d}, texts) {
  const out = [], f = 'pantheon/src/capability/runtimes.json';
  if (d?.schema !== 'pantheon.capability-runtimes/v1') throw new Error(`${f}: not pantheon.capability-runtimes/v1`);
  for (const [k, r] of Object.entries(d.runtimes)) out.push(claimDraft('runtime', k, `${f}#runtimes/${k}`, {title: r.title, roles: r.roles, effort: r.effort, delegation: r.delegation}, claim(r.evidence, texts)));
  for (const [k, t] of Object.entries(d.transports)) out.push(claimDraft('transport', k, `${f}#transports/${k}`, {title: t.title, billing: t.billing ?? null}, claim(t.evidence, texts)));
  for (const [k, e] of Object.entries(d.environments)) out.push(claimDraft('environment', k, `${f}#environments/${k}`,
    {title: e.title, local_execution: e.local_execution ?? null, sandboxed: e.sandboxed ?? null}, claim(e.evidence, texts)));
  for (const [k, p] of Object.entries(d.pools)) out.push(claimDraft('pool', k, `${f}#pools/${k}`, {title: p.title, credentials_in_seat: p.credentials_in_seat ?? null}, claim(p.evidence, texts)));
  for (const [k, t] of Object.entries(d.tools)) out.push(claimDraft('tool', k, `${f}#tools/${k}`, {runtime: t.runtime, environment: t.environment, executes: Boolean(t.executes), policy: t.policy}, claim(t.evidence, texts)));
  for (const [k, x] of Object.entries(d.features)) out.push(ent('feature', k, `${f}#features/${k}`, {title: x.title, providers: x.providers, evidence_type: 'code'}));
  for (const [k, l] of Object.entries(d.limitations)) {
    const c = claim([...(l.register ? [l.register] : []), ...(l.evidence ?? [])], texts);
    out.push(claimDraft('limitation', k, `${f}#limitations/${k}`, {title: l.title, status: l.status, planned: l.planned ?? null, breaks: l.breaks ?? [],
      excludes: l.excludes ?? [], blocks_roles: l.blocks_roles ?? [], blocks: Boolean(l.blocks), use: l.use ?? null, requires: l.requires ?? null,
      register: l.register ? {file: l.register.file, quote: l.register.quote} : null}, c));
  }
  const has = (type, k) => Object.hasOwn(d[type] ?? {}, k);
  for (const [k, x] of Object.entries(d.features)) for (const p of x.providers ?? []) if (has('runtimes', p)) out.push(rel('supports', E('runtime', p), E('feature', k), `${f}#features/${k}`));
  for (const [k, t] of Object.entries(d.tools)) {
    if (has('runtimes', t.runtime)) out.push(rel('runs-in', E('tool', k), E('runtime', t.runtime), `${f}#tools/${k}`));
    if (has('environments', t.environment)) out.push(rel('runs-in', E('tool', k), E('environment', t.environment), `${f}#tools/${k}`));
  }
  for (const [type, kind] of [['environments', 'environment'], ['pools', 'pool'], ['tools', 'tool']]) for (const [k, x] of Object.entries(d[type])) {
    for (const l of x.limitations ?? []) if (has('limitations', l)) out.push(rel('limited-by', E(kind, k), E('limitation', l), `${f}#${type}/${k}`));
  }
  return out;
}

function extractModels({models, frontier, facts, classes, continuity}) {
  const out = [], f = 'packages/model-client/models.json';
  const vendors = [...new Set(registryModels(models).map(m => m.vendor))].sort();
  for (const v of vendors) out.push(ent('provider', v, `${f}#${v === 'agy_google' ? 'google' : v}`, {registry_key: v === 'agy_google' ? 'google' : v, ...(continuity?.[v] ?? {}), evidence_type: 'documented'}));
  for (const lab of [...new Set(vendors.map(LAB_OF_VENDOR))].sort()) out.push(ent('lab', lab, `pantheon/src/config/models.mjs#labOf`, {rule: "a vendor's lab is its own name, except agy_google, which is Google's", evidence_type: 'documented'}));
  for (const m of registryModels(models)) {
    const fact = facts?.models?.[m.model] ?? null, cls = classes?.models?.[m.model] ?? null;
    out.push(ent('model', m.model, `${f}#${m.registry_key}/${m.name}`, {vendor: m.vendor, registry_key: m.registry_key, name: m.name,
      frontier: frontier?.[m.model] ?? null, facts: fact, class: cls ? {class: cls.class, basis: cls.basis, status: cls.status, kind: 'a declared routing label, not a measurement'} : null,
      evidence_type: 'documented'}, fact ? {} : {missing_evidence: ['no cited capability record (pantheon/src/config/capability-facts.json)']}));
    out.push(rel('served-by', E('model', m.model), E('provider', m.vendor), `${f}#${m.registry_key}/${m.name}`));
    out.push(rel('made-by', E('model', m.model), E('lab', LAB_OF_VENDOR(m.vendor)), `pantheon/src/config/models.mjs#labOf`, {basis: 'the vendor\'s lab (models.mjs labOf)'}));
  }
  return out;
}

function extractLanes({lanes}) {
  const out = [], f = 'pantheon/src/config/lanes.json';
  for (const [name, l] of Object.entries(laneTable(lanes))) {
    out.push(ent('lane', name, `${f}#agy_cli/${name}`, {vendor: l.vendor, transport: l.transport, lab: l.lab ?? null, base: l.base ?? null, thinking: l.thinking ?? null,
      window: l.window ?? null, retired: l.retired ?? null, basis: l.basis ?? null, evidence_type: 'documented'},
    l.window ? {} : {missing_evidence: ['no cited window for this lane']}));
    out.push(rel('served-by', E('lane', name), E('transport', l.transport), `${f}#agy_cli/${name}`));
  }
  return out;
}

function extractIdentity({identity, models, lanes}) {
  const out = [], f = 'pantheon/src/config/model-identity.json';
  const registry = new Set(registryModels(models).map(m => m.model)), laneNames = new Set(Object.keys(laneTable(lanes)));
  const declared = new Set();
  for (const [m, lab] of Object.entries(identity?.model_lab ?? {})) {
    if (registry.has(m)) continue;                                   // its lab is the registry's (pantheon.models)
    declared.add(m);
    out.push(ent('model', m, `${f}#model_lab/${m}`, {vendor: null, declared_by: 'identity policy model_lab', registry: false, evidence_type: 'documented'},
      {missing_evidence: ['not a registry model: no API id and no cited capability record in the registry']}));
    out.push(rel('made-by', E('model', m), E('lab', lab), `${f}#model_lab/${m}`, {basis: 'model_lab'}));
  }
  for (const [name, s] of Object.entries(identity?.same_model ?? {})) {
    if (!(registry.has(s.model) || declared.has(s.model))) continue;   // an alias of a model the graph does not hold is not asserted
    const from = laneNames.has(name) ? E('lane', name) : registry.has(name) || declared.has(name) ? E('model', name) : null;
    if (from) out.push(rel('alias-of', from, E('model', s.model), `${f}#same_model/${name}`, {basis: s.basis}));
  }
  return out;
}

const REVIEW_NEEDS = 'different_vendor';
function extractRoles(data) {
  const {roles, roster} = data, out = [], names = roleNamesOf(data);
  for (const r of names) {
    const x = roles[r] ?? null;
    // A role REVIEWS (review by lab, owner decision 2026-11-20) when roles.mjs requires a different vendor or lets it judge.
    out.push(ent('role', r, x ? `pantheon/src/role/roles.mjs#${r}` : `pantheon/src/role/roles.mjs (not declared; named by a seating table)`, {
      reviews: Boolean(x && (x.needs.includes(REVIEW_NEEDS) || x.may_judge)), needs: x?.needs ?? [], may_judge: x?.may_judge ?? false,
      produces_kinds: x?.produces_kinds ?? [], declared_in_roles: Boolean(x), evidence_type: 'documented'}));
  }
  for (const [chair, c] of Object.entries(roster ?? {})) {
    out.push(ent('chair', chair, `pantheon/src/team/roster.mjs#${chair}`, {pod: c.pod, roles: c.roles, candidates: c.candidates, charter: c.charter,
      may_ship: Boolean(c.may_ship), on_request: Boolean(c.on_request), turn_cap: c.turn_cap ?? null, evidence_type: 'documented'}));
    for (const r of c.roles ?? []) if (names.includes(r)) out.push(rel('holds', E('chair', chair), E('role', r), `pantheon/src/team/roster.mjs#${chair}`));
  }
  return out;
}

/** The serving profile's model selector (runtimes.json `serving[].select`) over the registry and the lanes. */
function selected(select, {models, frontier, lanes}) {
  const reg = registryModels(models), isFrontier = m => Object.hasOwn(frontier ?? {}, m);
  if (select === 'registry-frontier-or-not-agy') return reg.filter(m => isFrontier(m.model) || m.vendor !== 'agy_google').map(m => ({...m, served_as: 'model'}));
  if (select === 'registry-agy-not-frontier') return reg.filter(m => !isFrontier(m.model) && m.vendor === 'agy_google' && !laneTable(lanes)[m.model]).map(m => ({...m, served_as: 'model'}));
  if (select === 'lanes') return Object.entries(laneTable(lanes)).filter(([, l]) => l.transport === 'agy-cli').map(([name, l]) => ({vendor: l.vendor, model: name, served_as: 'lane', lane: l}));
  throw new Error(`runtimes.json: unknown serving selector "${select}"`);
}
function extractExecutable({serving, profiles, limitations, runtimes, models, frontier, lanes}, texts) {
  const out = [], f = 'pantheon/src/capability/runtimes.json';
  const laneBases = new Set(Object.values(laneTable(lanes)).filter(l => !l.retired && l.base).map(l => l.base));
  const seen = new Set();
  for (const [i, rule] of (serving ?? []).entries()) {
    const p = profiles[rule.profile];
    if (!p) throw new Error(`${f}: serving rule ${i} names an unknown profile "${rule.profile}"`);
    const rc = claim(rule.evidence, texts);
    const bubble = Object.fromEntries(BUBBLE.map(k => [k, bubbleComponent(p.bubble?.[k], texts)]));
    const runtime = runtimes[p.runtime] ?? null;
    for (const m of selected(rule.select, {models, frontier, lanes})) {
      const key = capabilityKey(rule.profile, m.vendor, m.model);
      if (seen.has(key)) continue;
      seen.add(key);
      // The constraints under which this combination works, each from a registry or the code.
      const retired = m.served_as === 'lane' ? m.lane.retired ?? null : null;
      const failoverOnly = rule.profile === 'api' && m.vendor === 'agy_google' && laneBases.has(m.model);
      const lims = [...new Set([...(p.limitations ?? []), ...(failoverOnly ? ['gemini-api-quota-failover-only'] : [])])].filter(l => Object.hasOwn(limitations, l));
      out.push(ent('capability', key, `${f}#serving/${i}`, {
        vendor: m.vendor, model: m.model, served_as: m.served_as, profile: rule.profile, runtime: p.runtime, transport: p.transport, environment: p.environment, pool: p.pool,
        tools: [...p.tools], roles: runtime?.roles ?? null, effort: runtime?.effort ?? null, delegation: runtime?.delegation ?? null,
        availability: retired ? {state: 'retired', why: retired, source: `pantheon/src/config/lanes.json#agy_cli/${m.model}`} : {state: 'available', why: null, source: null},
        use: failoverOnly ? {value: 'quota-failover', why: limitations['gemini-api-quota-failover-only']?.title ?? 'served only as an Antigravity lane\'s quota failover'} : {value: 'primary', why: null},
        limitations: lims, bubble, isolated: bubbleHolds(bubble), serving: {select: rule.select, why: rule.why, evidence: rc.evidence}, evidence_type: 'code'},
      rc.missing.length ? {status: 'unresolved', missing_evidence: rc.missing} : {}));
      const id = E('capability', key);
      out.push(rel('combines', id, m.served_as === 'lane' ? E('lane', m.model) : E('model', m.model), `${f}#serving/${i}`, {component: m.served_as}));
      for (const [component, type, k] of [['runtime', 'runtime', p.runtime], ['transport', 'transport', p.transport], ['sandbox profile', 'environment', p.environment],
        ['credential scope', 'pool', p.pool], ...p.tools.map(t => ['tool', 'tool', t])]) out.push(rel('combines', id, E(type, k), `${f}#profiles/${rule.profile}`, {component}));
      for (const l of lims) out.push(rel('limited-by', id, E('limitation', l), `${f}#profiles/${rule.profile}`));
    }
  }
  return out;
}

// A placement names its occupant by the id a table uses: a lane name or a registry (or identity-declared) model.
function occupantOf(model, {known_models, lanes}) {
  if (Object.hasOwn(laneTable(lanes), model)) return E('lane', model);
  if (known_models.includes(model)) return E('model', model);
  return null;
}
function placement(table, key, ref, row, ctx, authority) {
  const occ = occupantOf(row.model, ctx);
  const drafts = [ent('placement', `${table}/${key}`, ref, {table, role: row.role, vendor: row.vendor, model: row.model, rank: row.rank ?? null, band: row.band ?? null,
    difficulty: row.difficulty ?? null, basis: row.basis, why: row.why ?? null, authority, evidence_type: 'owner-direction',
    kind: 'a direction with its declared basis; not a measurement, not a qualification'},
  occ ? {} : {status: 'unresolved', missing_evidence: [`the placed model ${row.model} is neither a lane nor a model the graph holds`]})];
  if (ctx.roles.includes(row.role)) drafts.push(rel('places', E('placement', `${table}/${key}`), E('role', row.role), ref, {as: 'role'}));
  if (occ) drafts.push(rel('places', E('placement', `${table}/${key}`), occ, ref, {as: 'occupant'}));
  return drafts;
}
function extractSeating({seating, intake, argo, depth_limit, ...ctx}) {
  const out = [], seen = new Set(), push = ds => { for (const d of ds) { const k = d.entity ?? `${d.type}|${d.from}|${d.to}`; if (!seen.has(k)) { seen.add(k); out.push(d); } } };
  const S1 = 'pantheon/src/role/seating.mjs';
  for (const [table, rows, authority] of [['seating', seating, 'operator seating, owner-directed (pantheon/src/role/seating.mjs SEATING): a stated preference with its basis'],
    ['intake', intake, 'operator intake seating (pantheon/src/role/seating.mjs INTAKE)']]) {
    for (const [role, list] of Object.entries(rows ?? {})) list.forEach((c, rank) => push(placement(table, `${role}/${c.vendor}/${c.model}`, `${S1}#${table.toUpperCase()}.${role}`,
      {...c, role, rank}, ctx, authority)));
  }
  for (const [role, list] of Object.entries(argo ?? {})) list.forEach((c, rank) => push(placement('argo', `${role}/${c.vendor}/${c.model}`, `pantheon/src/route/frontier.mjs#ARGO_SEATS.${role}`,
    {...c, role, rank, basis: 'OPERATOR', why: 'ARGO November model policy'}, ctx, 'the ARGO November model policy (operator profile, pantheon/src/route/frontier.mjs)')));
  out.push(ent('limitation', 'pantheon-subagent-depth', `${S1}#DEPTH_LIMIT`, {title: `a Pantheon subagent tree is at most ${depth_limit} deep`, limit: depth_limit, status: 'by design',
    breaks: [], excludes: [], blocks_roles: [], blocks: false, use: null, requires: null, register: null, evidence_type: 'documented'}));
  return out;
}
function extractFit({fit, ...ctx}) {
  const out = [], F = 'pantheon/src/route/fit-matrix.mjs', authority = 'owner direction 2026-11-17 (pantheon/src/route/fit-matrix.mjs); orderings unmeasured';
  for (const [role, row] of Object.entries(fit.matrix)) for (const d of fit.difficulties) out.push(...placement('fit', `${role}/${d}`, `${F}#FIT_MATRIX.${role}.${d}`,
    {...row[d], role, difficulty: d, rank: 0, basis: 'OWNER'}, ctx, authority));
  for (const [d, ladder] of Object.entries(fit.ladders)) ladder.forEach((c, rank) => out.push(...placement('fit-ladder', `implementer/${d}/${c.model}`, `${F}#IMPLEMENTER_LADDERS.${d}`,
    {...c, role: 'implementer', difficulty: d, rank, basis: 'OWNER'}, ctx, authority)));
  fit.reviewer_escalation.forEach((c, rank) => out.push(...placement('fit-reviewer', `reviewer/${c.model}`, `${F}#REVIEWER_ESCALATION`,
    {...c, role: 'reviewer', rank, basis: 'OWNER', why: 'pinned to the dispatcher of the unit; escalates only inside OpenAI'}, ctx, authority)));
  return out;
}

// ---- the source adapters -----------------------------------------------------------------------------------------------
const AUTHORITY = {
  [S.runtimes]: 'pantheon/src/capability/runtimes.json: the runtime declarations, each claim checked against the code it quotes',
  [S.models]: 'packages/model-client/models.json and registry.mjs (frontier capabilities), pantheon/src/config/capability-facts.json (cited) and classes.json (routing labels)',
  [S.lanes]: 'pantheon/src/config/lanes.json (owner direction 2026-11-17: Antigravity lanes)',
  [S.identity]: 'pantheon/src/config/model-identity.json (the identity policy)',
  [S.roles]: 'pantheon/src/role/roles.mjs, pantheon/src/team/roster.mjs and the roles the seating tables name',
  [S.executable]: 'the serving profiles of runtimes.json applied to the registry and the lanes: the executable capabilities',
  [S.seating]: 'pantheon/src/role/seating.mjs (SEATING, INTAKE, DEPTH_LIMIT) and the ARGO seats of pantheon/src/route/frontier.mjs: owner and operator direction, read only',
  [S.fit]: 'pantheon/src/route/fit-matrix.mjs: owner direction 2026-11-17, read only',
};
const REF = {[S.runtimes]: 'pantheon/src/capability/runtimes.json', [S.models]: 'packages/model-client/models.json', [S.lanes]: 'pantheon/src/config/lanes.json',
  [S.identity]: 'pantheon/src/config/model-identity.json', [S.roles]: 'pantheon/src/role/roles.mjs', [S.executable]: 'pantheon/src/capability/runtimes.json#serving',
  [S.seating]: 'pantheon/src/role/seating.mjs', [S.fit]: 'pantheon/src/route/fit-matrix.mjs'};
const EXTRACT = {[S.runtimes]: extractRuntimes, [S.models]: extractModels, [S.lanes]: extractLanes, [S.identity]: extractIdentity, [S.roles]: extractRoles,
  [S.executable]: extractExecutable, [S.seating]: extractSeating, [S.fit]: extractFit};

const roleInputs = reg => ({roles: reg.roles, fit_roles: [...Object.keys(reg.fit?.matrix ?? {}), 'reviewer'], argo_roles: Object.keys(reg.argo ?? {}), intake_roles: Object.keys(reg.intake ?? {}),
  agy_roles: [...new Set(Object.values(reg.runtimes?.runtimes ?? {}).flatMap(r => (Array.isArray(r.roles) ? r.roles : [])))].sort(), roster: reg.roster});
const roleNamesOf = x => [...new Set([...Object.keys(x.roles), ...x.fit_roles, ...x.argo_roles, ...x.intake_roles, ...x.agy_roles])].sort();
/** What each source's version is computed over (its data), and the file texts its claims are checked against (`texts`). */
export function sourceInputs(reg) {
  const known_models = [...new Set([...registryModels(reg.models).map(m => m.model), ...Object.keys(reg.identity?.model_lab ?? {})])].sort();
  const roleData = roleInputs(reg), roles = roleNamesOf(roleData);
  const blobs = files => Object.fromEntries(files.map(f => [f, typeof reg.evidence?.[f] === 'string' ? blobId(reg.evidence[f]) : null]));
  const runtimeFiles = [...new Set(evidenceOf(reg.runtimes).map(e => e.file))].sort();
  const exec = {serving: reg.runtimes.serving, profiles: reg.runtimes.profiles, limitations: reg.runtimes.limitations, runtimes: reg.runtimes.runtimes,
    models: reg.models, frontier: reg.frontier, lanes: reg.lanes};
  const execFiles = [...new Set(evidenceOf({serving: exec.serving, profiles: exec.profiles}).map(e => e.file))].sort();
  const ctx = {known_models, lanes: reg.lanes, roles};
  return {
    [S.runtimes]: {data: {declaration: reg.runtimes, evidence: blobs(runtimeFiles)}, texts: reg.evidence},
    [S.models]: {data: {models: reg.models, frontier: reg.frontier, facts: reg.facts, classes: reg.classes, continuity: reg.continuity}},
    [S.lanes]: {data: {lanes: reg.lanes}},
    [S.identity]: {data: {identity: reg.identity, models: reg.models, lanes: reg.lanes}},
    [S.roles]: {data: roleData},
    [S.executable]: {data: {...exec, evidence: blobs(execFiles)}, texts: reg.evidence},
    [S.seating]: {data: {seating: reg.seating, intake: reg.intake, argo: reg.argo, depth_limit: reg.depth_limit, ...ctx}},
    [S.fit]: {data: {fit: reg.fit, ...ctx}},
  };
}
/** The facts (extractor drafts) of source `id` over its inputs. */
export const extract = (id, {data, texts = {}}) => EXTRACT[id](data, texts);

/**
 * One adapter per source, for packages/graph openGraph / createProjection. A source's version is the digest of its data
 * (versionOf over canonical JSON); readAt(version) re-derives the facts of a version this adapter holds -- the current
 * one, any registries passed in `history`, or one `remember`ed -- and throws for any other version (the projection
 * records the source unavailable at replay, never invents its facts).
 */
export function capabilitySources(registries, {history = []} = {}) {
  const held = new Map();                                       // `${source}@${version}` -> inputs
  const remember = reg => {
    const inputs = sourceInputs(reg), versions = {};
    for (const id of SOURCE_ORDER) { const v = versionOf(inputs[id].data); held.set(`${id}@${v}`, inputs[id]); versions[id] = v; }
    return versions;
  };
  for (const h of history) remember(h);
  let current = remember(registries);
  const adapters = SOURCE_ORDER.map(id => ({id, extractor: extractorOf(id), authority: AUTHORITY[id], ref: REF[id],
    current: () => ({version: current[id]}),
    readAt(version) {
      const inputs = held.get(`${id}@${version}`);
      if (!inputs) throw new Error(`${id} at ${version} is not a version this adapter holds (the registries it was given)`);
      return extract(id, inputs);
    }}));
  /** Make `reg` the current registries (a data change: a lane retired or removed, a limitation changed). */
  const advance = reg => { current = remember(reg); return {...current}; };
  return Object.assign(adapters, {versions: () => ({...current}), advance, remember});
}

// ---- the snapshot ------------------------------------------------------------------------------------------------------
/**
 * Every fact the extractors project at the registries' current versions, each validated as an authoritative record of
 * its source by the graph schema (packages/graph projection materialize): {schema, contract, graph, sources: [{id, extractor,
 * version, digest, count}], digest, records, index}. The digest commits to each source's version and the digest of its
 * facts, so a decision that names it names exactly what it was decided on. Nothing is written.
 */
export function capabilitySnapshot(registries = currentRegistries(), {sources = capabilitySources(registries)} = {}) {
  const projection = createProjection({origins: SNAPSHOT_ORIGINS, sources});
  const rows = [], records = [];
  for (const s of sources) {
    const version = s.current().version, m = projection.materialize(s.id, version);
    if (!m.ok) throw Object.assign(new Error(`capability snapshot: ${m.why}`), {code: 'CAPABILITY_SOURCE'});
    rows.push({id: s.id, extractor: s.extractor, version, digest: m.digest, count: m.count});
    records.push(...m.facts);
  }
  const body = {schema: SNAPSHOT_SCHEMA, graph: GRAPH_SCHEMA, contract: CONTRACT_VERSION, sources: rows};
  const snap = {...body, digest: 'sha256:' + digest(body), records, index: indexOf(records)};
  return snap;
}
/** The snapshot as a ledger input records it (pantheon/src/ledger/kinds.mjs `capability`): no facts, only what names them. */
export const snapshotPayload = snap => ({schema: snap.schema, graph: snap.graph, contract: snap.contract, sources: snap.sources, digest: snap.digest});
export const snapshotDigestOf = payload => 'sha256:' + digest({schema: payload.schema, graph: payload.graph, contract: payload.contract, sources: payload.sources});

// ---- the index the eligibility decision reads ---------------------------------------------------------------------------
/**
 * An index over capability records (a snapshot's, or a graph view's current ones): nodes with their attributes and whether
 * they are ESTABLISHED (not hypothetical, not unresolved), and typed edges both ways. A node two sources assert keeps both.
 */
export function indexOf(records, {established = r => r.classification !== 'hypothetical' && r.status !== 'unresolved'} = {}) {
  const nodes = new Map(), out = new Map(), inn = new Map();
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const r of records) {
    const ok = established(r);
    if (r.kind === 'entity') {
      const n = nodes.get(r.subject) ?? {id: r.subject, type: r.type, attributes: {}, established: false, assertions: [], missing_evidence: [], sources: []};
      for (const [k, v] of Object.entries(r.attributes)) if (!Object.hasOwn(n.attributes, k) || (ok && !n.established)) n.attributes[k] = v;
      n.established ||= ok;
      n.assertions.push({id: r.id, classification: r.classification, status: r.status, origin: r.origin, source: r.source.id, version: r.source.version});
      n.missing_evidence.push(...r.missing_evidence);
      if (!n.sources.includes(r.source.id)) n.sources.push(r.source.id);
      nodes.set(r.subject, n);
    } else {
      const e = {type: r.type, from: r.from, to: r.to, attributes: r.attributes, established: ok, id: r.id, classification: r.classification, source: r.source.id};
      add(out, r.from, e); add(inn, r.to, e);
    }
  }
  const node = id => nodes.get(id) ?? null;
  const est = id => Boolean(nodes.get(id)?.established);
  return {
    nodes, node, established: est,
    /** The established edges of `type` out of (or into) `id`, to established endpoints. */
    out: (id, type) => (out.get(id) ?? []).filter(e => e.type === type && e.established && est(e.to)),
    in: (id, type) => (inn.get(id) ?? []).filter(e => e.type === type && e.established && est(e.from)),
    /** Every current edge, established or not (for the explanation of what does not count). */
    allOut: id => out.get(id) ?? [],
    ofType: type => [...nodes.values()].filter(n => n.type === type),
  };
}
/** The index over a graph view (packages/graph): every CURRENT assertion, established or possible, with its status there. */
export function indexOfView(view) {
  const records = [], establishedIds = new Set();
  for (const s of view.subjects()) {
    for (const q of view.query(s, 'established')) { records.push(view.assertion(q.id).record); establishedIds.add(q.id); }
    for (const q of view.query(s, 'possible')) records.push(view.assertion(q.id).record);
  }
  return indexOf(records.filter(r => r.kind === 'relationship' || r.domain === 'capability' || r.type === 'observation'), {established: r => establishedIds.has(r.id)});
}

/** Counts per source and per entity type: what the extractors projected (the report's extraction table). */
export function extractionCounts(snap) {
  const bySource = Object.fromEntries(snap.sources.map(s => [s.id, {facts: s.count, entities: 0, relationships: 0, types: {}}]));
  for (const r of snap.records) {
    const b = bySource[r.source.id];
    if (r.kind === 'entity') { b.entities++; b.types[r.type] = (b.types[r.type] ?? 0) + 1; } else { b.relationships++; b.types[r.type] = (b.types[r.type] ?? 0) + 1; }
  }
  return bySource;
}
