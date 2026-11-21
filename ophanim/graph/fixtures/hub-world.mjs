// FIXTURES for the hub-readiness assessment (ophanim/graph/hub.mjs; docs/knowledge-graph/hub-and-spoke.md): a SYNTHETIC
// federation of three departmental OPHANIM instances (Finance, Technology, Compliance) and the central hub, each on its
// OWN real packages/ledger chain, built on Slice E's machinery (packages/graph/federation.mjs department, definePolicy,
// openCentral) with the coordinator's test policy imported from packages/graph/tests/federation-fixture.mjs (not
// edited). Synthetic keys generated per world; every value a policy withholds is a sentinel that starts with
// WITHHELD_MARK, and every restricted entity's key starts with SEALED, so a single pass over a directory finds any leak.
// Each department is SIZED: {entities, relationships}, from a measurement of OPHANIM's own graph times a scale.
//
// The world lives on disk (keys, anchors, secrets, reachability flags: world.json), so a child process opens the same
// central (fixtures/hub-child.mjs). No provider, no network, no real data; everything under one temporary directory.
//
// replica(): a departmental OPHANIM instance made from the code at a commit with the EXISTING creators (status, work,
// cycle and run ledgers, a graph ledger, a billing setting through the one billing policy), in a temporary directory:
// what OPHANIM can do today to replicate itself, composed, not a production command (hub.mjs R9 reports the gaps).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {generateSigner} from '../../../packages/ledger/chain.mjs';
import {versionOf, defineOrigins, createGraphLedger, openGraph, department, openCentral, outboxTransport, noticeTransport, receiverOrigin,
  REFERENCES} from '../../../packages/graph/index.mjs';
import {POLICY, filesUnder} from '../../../packages/graph/tests/federation-fixture.mjs';
import {openStatusLedger} from '../../../packages/ledger/status.mjs';
import {openWorkLedger} from '../../operate/work-ledger.mjs';
import {openPantheonLedger} from '../../../pantheon/src/ledger/system.mjs';
import {openSystemLedger} from '../../ledger/system.mjs';
import {resolveGeminiBilling} from '../../../pantheon/src/route/gemini-billing.mjs';

export {POLICY, filesUnder};
export const DEPARTMENTS = Object.freeze(['finance', 'technology', 'compliance']);
export const CENTRAL = 'central';
export const T0 = '2026-11-20T10:00:00.000Z';
export const at = minutes => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
/** Every withheld value (restricted, or an internal node's details) starts with this; no permitted value contains it. */
export const WITHHELD_MARK = 'SYNTH-WITHHELD-';
/** Every restricted entity's key starts with this: its id must never reach the hub either. */
export const SEALED = 'zzsealed';
/** The key ids a department's authority names: instance-neutral, as the real graph's (extract/index.mjs: graph-operator, ...). */
export const KEY_IDS = Object.freeze(['graph-operator', 'graph-extractor', 'graph-tool', 'graph-receiver', 'graph-export']);
export const CENTRAL_KEYS = Object.freeze(['central-operator', 'central-import', 'central-link', 'central-notice', 'central-snapshot']);

/** The named nodes of the directive's example: a Finance process depends on a Technology service; Finance produces evidence Compliance consumes. */
export const NODES = Object.freeze({
  run: 'finance/systems/process/payment-run', report: 'finance/evidence/record/recon-report', payroll: `finance/systems/dataset/${SEALED}-payroll`,
  api: 'technology/systems/service/payments-api', vault: `technology/systems/datastore/${SEALED}-card-vault`, lesson: 'technology/learning/failure-class/retry-storm',
  control: 'compliance/systems/process/control-test',
});
const FILLER = Object.freeze({finance: ['systems/process', 'systems/dataset', 'evidence/record'], technology: ['systems/service', 'systems/api', 'systems/datastore'],
  compliance: ['systems/process', 'evidence/record', 'systems/dataset']});
const accessOf = i => (i % 10 === 0 ? 'restricted' : i % 10 <= 4 ? 'internal' : 'public');
const relAccessOf = j => (j % 10 === 0 ? 'restricted' : j % 10 <= 3 ? 'internal' : 'public');

/**
 * A department's synthetic systems inventory of `size` {entities, relationships}: its named nodes, then fillers in a
 * fixed order (a tenth restricted, four tenths internal, the rest public), each withheld value a sentinel. `refs`: the
 * cross-instance references its named nodes carry ({node: [{type, to}]}); `changed`: filler indexes whose value is bumped
 * (a change to publish); `extra`: entities added as is.
 */
export function departmentSnapshot(inst, size, {refs = {}, changed = [], extra = {}, round = 0, patch = {}} = {}) {
  const M = n => `${WITHHELD_MARK}${inst}-${n}`, entities = {}, relationships = [];
  const named = {
    finance: {[NODES.run]: {access: 'internal', attributes: {team: M('team'), cutoff: M('cutoff')}}, [NODES.report]: {access: 'public', attributes: {format: 'pdf'}},
      [NODES.payroll]: {access: 'restricted', attributes: {total: M('payroll-total')}}},
    technology: {[NODES.api]: {access: 'internal', attributes: {host: M('api-host'), tier: M('api-tier')}}, [NODES.vault]: {access: 'restricted', attributes: {key_ref: M('vault-key')}}},
    compliance: {[NODES.control]: {access: 'public', attributes: {cadence: 'monthly'}}},
  }[inst];
  for (const [id, x] of Object.entries(named)) entities[id] = {...x, attributes: {...x.attributes, ...(patch[id] ?? {}), ...(refs[id] ? {[REFERENCES]: refs[id]} : {})}};
  if (inst === 'finance') relationships.push(['produces', NODES.run, NODES.report, 'internal', {note: M('produces-note')}], ['consumes', NODES.run, NODES.payroll, 'internal', {note: M('consumes-note')}]);
  if (inst === 'technology') relationships.push(['depends-on', NODES.api, NODES.vault, 'internal', {}]);
  const types = FILLER[inst], fill = Math.max(0, size.entities - Object.keys(entities).length), ids = [], actors = [];
  const bumped = new Set(changed);
  for (let i = 0; i < fill; i++) {
    const type = types[i % types.length], access = accessOf(i), id = `${inst}/${type}/${access === 'restricted' ? SEALED : 'n'}-${i}`;
    const value = access === 'public' ? `public-${inst}-${i}` : M(`${access === 'restricted' ? 'r' : 'i'}${i}`);
    entities[id] = {access, attributes: {value, ...(bumped.has(i) ? {revision: round} : {})}};
    ids.push(id);
    if (!type.startsWith('evidence/')) actors.push(id);
  }
  const want = Math.max(0, size.relationships - relationships.length), seen = new Set(relationships.map(r => `${r[0]}|${r[1]}|${r[2]}`));
  for (let j = 0, made = 0; made < want && actors.length > 1 && j < want * 4; j++) {
    const from = actors[j % actors.length], to = ids[(Math.floor(j / actors.length) * 31 + j * 17 + 5) % ids.length];
    if (from === to) continue;
    const type = j % 25 === 24 ? 'mentions' : to.includes('/evidence/') ? (j % 2 ? 'produces' : 'consumes') : (j % 2 ? 'depends-on' : 'consumes');
    const k = `${type}|${from}|${to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const access = relAccessOf(j);
    relationships.push([type, from, to, access, access === 'public' ? {w: j % 7} : {note: M(`rel${j}`)}]);
    made++;
  }
  return {entities: {...entities, ...extra}, relationships};
}

const sourceOf = inst => `${inst}.systems`;
function draftsOf(inst, snap) {
  const src = sourceOf(inst);
  return [...Object.entries(snap.entities).map(([entity, x]) => ({entity, attributes: x.attributes, scope: {access: x.access, owner: inst}, ref: `${src}#${entity}`})),
    ...snap.relationships.map(([type, from, to, access, attributes]) => ({type, from, to, attributes, scope: {access, owner: inst}, ref: `${src}#${type}(${from}->${to})`}))];
}
export function sourceAt(root, inst) {
  const dir = path.join(root, inst, 'src');
  return {id: sourceOf(inst), extractor: `${inst}.extractor`, authority: `${inst}'s synthetic systems inventory (a JSON snapshot on disk)`, ref: `${sourceOf(inst)}/current.json`,
    current: () => ({version: fs.readFileSync(path.join(dir, 'CURRENT'), 'utf8').trim()}),
    readAt: version => draftsOf(inst, JSON.parse(fs.readFileSync(path.join(dir, 'versions', version.slice(7) + '.json'), 'utf8')))};
}
/** A department's origin registry: its extractor, its tool, its receiver; the keys are its own, under instance-neutral ids. */
export const originsFor = inst => defineOrigins({
  [`${inst}.extractor`]: {kind: 'extractor', basis: 'declared', keys: ['graph-extractor'], sources: [sourceOf(inst)]},
  [`${inst}.tool`]: {kind: 'tool', basis: 'measured', keys: ['graph-tool']},
  ...receiverOrigin(['graph-receiver']),
});
const serialize = s => ({key_id: s.key_id, privatePem: s.privatePem, publicJwk: s.publicJwk});

/**
 * A new world under `root` (default: a new temporary directory). `identical`: every department's authority is made of
 * ONE set of keys (a provisioning template copied to each replica) instead of keys generated for each. Returns worldOf(root).
 */
export function hubWorld({root = null, identical = false, maxAgeMs = 60 * 60_000} = {}) {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-hub-world-'));
  const template = identical ? Object.fromEntries(KEY_IDS.map(k => [k, generateSigner(k)])) : null;
  const keys = {};
  for (const inst of DEPARTMENTS) keys[inst] = Object.fromEntries(KEY_IDS.map(k => [k, serialize(template?.[k] ?? generateSigner(k))]));
  keys[CENTRAL] = Object.fromEntries(CENTRAL_KEYS.map(k => [k, serialize(generateSigner(k))]));
  const secrets = Object.fromEntries(DEPARTMENTS.map(d => [d, randomBytes(32).toString('hex')]));
  const anchors = {};
  for (const inst of [...DEPARTMENTS, CENTRAL]) {
    const ledger = path.join(dir, inst, 'ledger');
    fs.mkdirSync(ledger, {recursive: true});
    const k = keys[inst], op = k[inst === CENTRAL ? 'central-operator' : 'graph-operator'];
    // each instance's keyring holds its own keys only: no instance can sign into another's ledger
    anchors[inst] = createGraphLedger({dir: ledger, authority: {keyring: Object.fromEntries(Object.entries(k).map(([id, s]) => [id, s.publicJwk])), orderer: op.key_id, operators: [op.key_id]},
      operator: op, order: op});
  }
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({keys, secrets, anchors, maxAgeMs, identical}));
  return worldOf(dir);
}

/** The handles of the world saved at `root` (also what a child process opens). */
export function worldOf(root) {
  const {keys, secrets, anchors, maxAgeMs, identical} = JSON.parse(fs.readFileSync(path.join(root, 'world.json'), 'utf8'));
  const by = (inst, k) => ({signer: keys[inst][k], order: keys[inst][inst === CENTRAL ? 'central-operator' : 'graph-operator']});
  const reachable = inst => () => !fs.existsSync(path.join(root, 'offline', inst));
  const centralDir = path.join(root, CENTRAL);
  const hub = {instance: CENTRAL, anchor: anchors[CENTRAL], keys: {'central-notice': keys[CENTRAL]['central-notice'].publicJwk}};
  const w = {
    root, keys, anchors, secrets, hub, by, reachable, identical, centralDir,
    centralBy: {import: by(CENTRAL, 'central-import'), link: by(CENTRAL, 'central-link'), notice: keys[CENTRAL]['central-notice']},
    snapshotKey: keys[CENTRAL]['central-snapshot'],
    offline(inst, down = true) {
      fs.mkdirSync(path.join(root, 'offline'), {recursive: true});
      if (down) fs.writeFileSync(path.join(root, 'offline', inst), ''); else fs.rmSync(path.join(root, 'offline', inst), {force: true});
    },
    /** Publish a snapshot of a department's source; every version stays readable. */
    publishSource(inst, snapshot) {
      const dir = path.join(root, inst, 'src'), text = JSON.stringify(snapshot), version = versionOf(snapshot);
      fs.mkdirSync(path.join(dir, 'versions'), {recursive: true});
      fs.writeFileSync(path.join(dir, 'versions', version.slice(7) + '.json'), text);
      fs.writeFileSync(path.join(dir, 'CURRENT'), version + '\n');
      return version;
    },
    graphOf: (inst, o = {}) => openGraph({dir: path.join(root, inst, 'ledger'), anchor: anchors[inst], origins: originsFor(inst), sources: [sourceAt(root, inst)], instance: inst, ...o}),
    /** A department: its own graph and its federation handle. */
    open(inst, o = {}) {
      const graph = w.graphOf(inst, o.graph ?? {});
      const dept = department({graph, policy: o.policy ?? POLICY, secret: Buffer.from(secrets[inst], 'hex'), signer: keys[inst]['graph-export'],
        outbox: path.join(root, inst, 'outbox'), hub, transport: noticeTransport(centralDir, {reachable: reachable(CENTRAL)})});
      return {inst, graph, dept,
        observe: minutes => graph.observe(sourceOf(inst), {...by(inst, 'graph-extractor'), observed_at: at(minutes)}),
        publish: (minutes, o2 = {}) => dept.publish({exported_at: at(minutes), ...o2})};
    },
    /** The central instance (OPHANIM as the hub): every department pinned by its anchor and its export key. */
    central(o = {}) {
      return openCentral({dir: centralDir, anchor: anchors[CENTRAL], instance: CENTRAL,
        departments: Object.fromEntries(DEPARTMENTS.map(d => [d, {anchor: anchors[d], keys: {'graph-export': keys[d]['graph-export'].publicJwk},
          transport: outboxTransport(path.join(root, d, 'outbox'), {reachable: reachable(d)})}])),
        importKeys: ['central-import'], linkKeys: ['central-link'], maxAgeMs, lockTimeoutMs: 60_000, ...o});
    },
    close: () => fs.rmSync(root, {recursive: true, force: true}),
  };
  return w;
}

/** The version a department's latest export gives `node` (the version a cross-instance reference pins). */
export const versionIn = (exp, node) => exp.nodes.find(n => n.node === node)?.version ?? null;
export const refTo = (w, inst, exp, node) => ({instance: inst, anchor: w.anchors[inst], node, version: versionIn(exp, node)});

/**
 * The directive's example, seeded in order: Technology publishes; Finance pins Technology's payments API (depends-on);
 * Compliance pins Finance's reconciliation report (consumes), and names Technology's restricted vault (depends-on:
 * withheld, never linkable) and Technology's API by a `mentions` (a type the policy does not permit). Returns the
 * handles, each department's first export, and the per-step times (ms).
 */
export function seed(w, size, {policy} = {}) {
  const ms = {}, t = (k, fn) => { const s = process.hrtime.bigint(); const r = fn(); ms[k] = Number(process.hrtime.bigint() - s) / 1e6; return r; };
  const h = Object.fromEntries(DEPARTMENTS.map(d => [d, w.open(d, {policy})]));
  const ex = {};
  w.publishSource('technology', departmentSnapshot('technology', size));
  t('technology.observe', () => h.technology.observe(0));
  ex.technology = t('technology.export', () => h.technology.publish(1).export);
  const apiRef = refTo(w, 'technology', ex.technology, NODES.api);
  w.publishSource('finance', departmentSnapshot('finance', size, {refs: {[NODES.run]: [{type: 'depends-on', to: apiRef}]}}));
  t('finance.observe', () => h.finance.observe(2));
  ex.finance = t('finance.export', () => h.finance.publish(3).export);
  const reportRef = refTo(w, 'finance', ex.finance, NODES.report);
  const forbidden = [{type: 'depends-on', to: {instance: 'technology', anchor: w.anchors.technology, node: NODES.vault, version: 'sha256:' + '0'.repeat(64)}},
    {type: 'mentions', to: apiRef}];
  w.publishSource('compliance', departmentSnapshot('compliance', size, {refs: {[NODES.control]: [{type: 'consumes', to: reportRef}, ...forbidden]}}));
  t('compliance.observe', () => h.compliance.observe(4));
  ex.compliance = t('compliance.export', () => h.compliance.publish(5).export);
  // What each department republishes from (a later change keeps its references): departmentSnapshot(inst, size, opts[inst]).
  const opts = {technology: {}, finance: {refs: {[NODES.run]: [{type: 'depends-on', to: apiRef}]}}, compliance: {refs: {[NODES.control]: [{type: 'consumes', to: reportRef}, ...forbidden]}}};
  /** Republish `inst` with `over` (changed, patch, extra), observe and export it: {export, ms}. */
  const republish = (inst, minutes, over = {}) => {
    w.publishSource(inst, departmentSnapshot(inst, size, {...opts[inst], ...over}));
    const s = process.hrtime.bigint();
    h[inst].observe(minutes);
    const e = h[inst].publish(minutes + 0.5);
    return {...e, ms: Number(process.hrtime.bigint() - s) / 1e6};
  };
  return {h, ex, ms, opts, republish, refs: {api: apiRef, report: reportRef, forbidden}};
}

/**
 * Every file under `dir`, scanned ONCE for the withheld marks: {files, bytes, marks: Map value -> files, sealed: restricted
 * ids found, named: restricted ids found that a REFERRER names in its own reference (`namedByReferrers`: KE3 discloses a
 * reference's target id by design; the owner did not disclose it)}.
 */
export function scanForWithheld(dir, {namedByReferrers = []} = {}) {
  const files = filesUnder(dir), marks = new Map(), sealed = new Set(), named = new Set();
  const known = new Set(namedByReferrers.map(id => id.split('/').at(-1)));
  let bytes = 0;
  const mark = new RegExp(`${WITHHELD_MARK}[A-Za-z0-9-]+`, 'g'), seal = new RegExp(`${SEALED}-[A-Za-z0-9-]+`, 'g');
  for (const [f, text] of Object.entries(files)) {
    bytes += Buffer.byteLength(text);
    for (const m of text.matchAll(mark)) (marks.get(m[0]) ?? marks.set(m[0], new Set()).get(m[0])).add(f);
    for (const m of text.matchAll(seal)) (known.has(m[0]) ? named : sealed).add(`${m[0]} in ${f}`);
  }
  return {files: Object.keys(files).length, bytes, marks, sealed: [...sealed].sort(), named: [...named].sort()};
}
/** The withheld values a world planted (every sentinel in every department's current source), by class. */
export function plantedValues(w) {
  const out = {restricted: new Set(), internal: new Set()};
  for (const inst of DEPARTMENTS) {
    const dir = path.join(w.root, inst, 'src');
    const v = fs.readFileSync(path.join(dir, 'CURRENT'), 'utf8').trim();
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'versions', v.slice(7) + '.json'), 'utf8'));
    const add = (access, value) => { for (const m of JSON.stringify(value).matchAll(new RegExp(`${WITHHELD_MARK}[A-Za-z0-9-]+`, 'g'))) out[access === 'restricted' ? 'restricted' : 'internal'].add(m[0]); };
    for (const x of Object.values(snap.entities)) if (x.access !== 'public') add(x.access, x.attributes);
    for (const r of snap.relationships) if (r[3] !== 'public') add(r[3], r[4]);
  }
  return out;
}

// ---- replication (R9, R10): a departmental instance from the code at a commit, with the existing creators -------------
/**
 * A replica of OPHANIM for department `instance`, from `commit`, under `root` (nothing shared with any other instance):
 * its status, work, cycle (review) and run ledgers, each created by its own module's creator with keys generated there;
 * its graph ledger (createGraphLedger) with keys generated here, or `template` (one key set copied to every replica);
 * its own PANTHEON_HOME; and its config: its billing setting resolved through the one billing policy. Returns every
 * root, anchor and key directory, and what had to be supplied by hand (`manual`).
 */
export function replica({root, instance, commit, template = null}) {
  const base = path.join(root, instance), roots = {status: path.join(base, 'status', 'ledger'), work: path.join(base, 'status', 'work'),
    cycle: path.join(base, 'pantheon-cycles'), run: path.join(base, 'run', 'ledger'), graph: path.join(base, 'graph', 'ledger'), pantheon_home: path.join(base, 'pantheon-home')};
  const anchors = {};
  anchors.status = openStatusLedger({root: roots.status, create: true}).anchor;
  anchors.work = openWorkLedger({root: roots.work, create: true}).anchor;
  anchors.cycle = openPantheonLedger({root: roots.cycle, anchor: null}).anchor;
  anchors.run = openSystemLedger({root: roots.run, anchor: null}).anchor;
  fs.mkdirSync(roots.graph, {recursive: true});
  const g = Object.fromEntries(KEY_IDS.map(k => [k, template?.[k] ?? generateSigner(k)]));
  anchors.graph = createGraphLedger({dir: roots.graph, authority: {keyring: Object.fromEntries(Object.entries(g).map(([id, s]) => [id, s.publicJwk])), orderer: 'graph-operator', operators: ['graph-operator']},
    operator: g['graph-operator'], order: g['graph-operator']});
  fs.mkdirSync(roots.pantheon_home, {recursive: true});
  const billing = resolveGeminiBilling({failover: {enabled: false, source: `replica ${instance} config (synthetic)`}, primary: {enabled: false, source: `replica ${instance} config (synthetic)`}});
  const config = {schema: 'ophanim.replica-config/v0-synthetic', instance, commit, billing, seats: 'pantheon/src/route/fit-matrix.mjs FIT_MATRIX at the commit (code, not per-instance config)',
    env: {OPHANIM_STATUS_LEDGER: roots.status, OPHANIM_WORK_LEDGER: roots.work, PANTHEON_CYCLE_LEDGER: roots.cycle, OPHANIM_LEDGER: roots.run, PANTHEON_HOME: roots.pantheon_home}};
  fs.writeFileSync(path.join(base, 'replica.json'), JSON.stringify(config, null, 2));
  return {instance, commit, roots, anchors, keyDirs: {status: path.join(roots.status, 'keys'), work: path.join(roots.work, 'keys'), cycle: path.join(roots.cycle, 'keys'), run: path.join(roots.run, 'keys')},
    config, manual: ['every root above, passed as an environment variable or option (the defaults point into the checkout, ~/.pantheon or the git common directory)',
      'the graph ledger and its keys (no creator names a production graph ledger: KG-4)', 'the billing setting (per run manifest)']};
}
