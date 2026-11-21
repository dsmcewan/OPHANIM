// Fixtures for the federation tests (Slice E; KE7). A SYNTHETIC demonstration: two departmental instances, Finance
// and Technology, and a central instance, each on its OWN real packages/ledger chain (its own genesis, so its own
// anchor) with SYNTHETIC keys generated per test. Each department's source is a JSON snapshot on disk, versioned by its
// digest. No real enterprise data exists here: every value a policy withholds is a synthetic sentinel (SECRET) that the
// disclosure tests search the serialized exports, notices and the central's files for. No provider is reached.
//
// The world lives on disk (keys, anchors, secrets, reachability flags), so a child process can open the same instances.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {generateSigner} from '../../ledger/chain.mjs';
import {versionOf, defineOrigins, createGraphLedger, openGraph, definePolicy, department, openCentral, outboxTransport, noticeTransport, receiverOrigin,
  REFERENCES} from '../index.mjs';

export const DEPARTMENTS = Object.freeze(['finance', 'technology']);
export const CENTRAL = 'central';
export const T0 = '2026-11-20T10:00:00.000Z';
export const at = minutes => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

/** The coordinator's test policy (KE3 exactly): public with details, internal as a reference, restricted never. */
export const POLICY = definePolicy({id: 'coordinator.test-policy', version: '1',
  access: {public: 'details', internal: 'reference', restricted: 'withhold'},
  relationships: ['consumes', 'depends-on', 'implements', 'produces', 'verifies'], placeholders: true, counts: true});

export const F = Object.freeze({run: 'finance/systems/process/payment-run', recon: 'finance/systems/process/reconciliation',
  payroll: 'finance/systems/dataset/payroll-ledger', plan: 'finance/work/plan/q4-close', report: 'finance/evidence/record/recon-report'});
export const TECH = Object.freeze({api: 'technology/systems/service/payments-api', v2: 'technology/systems/api/payments-v2',
  vault: 'technology/systems/datastore/card-vault', sla: 'technology/evidence/observation/sla-run-1', incident: 'technology/evidence/observation/incident-42'});
/** The withheld values: synthetic sentinels, unique, searched for in everything that leaves a department. */
export const SECRET = Object.freeze({runTeam: 'SYNTH-WITHHELD-TREASURY-OPS', runCutoff: 'SYNTH-WITHHELD-CUTOFF-1600', payrollTotal: 'SYNTH-WITHHELD-PAYROLL-4711',
  planBudget: 'SYNTH-WITHHELD-Q4-BUDGET', consumesNote: 'SYNTH-WITHHELD-CONSUMES-NOTE', apiHost: 'SYNTH-WITHHELD-PAY-INT-07', apiTier: 'SYNTH-WITHHELD-TIER-GOLD',
  vaultKey: 'SYNTH-WITHHELD-VAULT-KEY-9', slaP99: 'SYNTH-WITHHELD-P99-212', incident: 'SYNTH-WITHHELD-INCIDENT-NOTE'});

/** Finance's systems: a payment run that depends on Technology's payments API (a cross-instance reference). */
export function financeSnapshot(ref, {extra = {}} = {}) {
  return {entities: {
    [F.run]: {access: 'internal', attributes: {team: SECRET.runTeam, cutoff: SECRET.runCutoff, ...(ref ? {[REFERENCES]: [{type: 'depends-on', to: ref}]} : {})}},
    [F.recon]: {access: 'public', attributes: {cadence: 'daily', note: `reads ${F.payroll} nightly`}},
    [F.payroll]: {access: 'restricted', attributes: {total: SECRET.payrollTotal}},
    [F.plan]: {access: 'internal', attributes: {budget: SECRET.planBudget}},
    [F.report]: {access: 'public', attributes: {format: 'pdf'}},
    ...extra,
  }, relationships: [
    ['depends-on', F.recon, F.run, 'public', {why: 'settles the payment run'}],
    ['consumes', F.run, F.payroll, 'internal', {note: SECRET.consumesNote}],
    ['produces', F.run, F.report, 'internal', {}],
    ['depends-on', F.plan, F.run, 'restricted', {}],                  // a restricted relationship: never exported
    ['mentions', F.recon, F.report, 'public', {}],                    // a type the policy does not permit across
  ]};
}
/** Technology's systems: the payments API, the public API it implements, and a restricted vault it depends on. */
export function technologySnapshot({api = {}} = {}) {
  return {entities: {
    [TECH.api]: {access: 'internal', attributes: {host: SECRET.apiHost, tier: SECRET.apiTier, ...api}},
    [TECH.v2]: {access: 'public', attributes: {path: '/v2/payments'}},
    [TECH.vault]: {access: 'restricted', attributes: {key_ref: SECRET.vaultKey}},
  }, relationships: [
    ['implements', TECH.api, TECH.v2, 'internal', {}],
    ['depends-on', TECH.api, TECH.vault, 'internal', {}],
  ]};
}

const sourceOf = inst => `${inst}.systems`;
function draftsOf(inst, snap) {
  const src = sourceOf(inst);
  return [...Object.entries(snap.entities).map(([entity, x]) => ({entity, attributes: x.attributes, scope: {access: x.access, owner: x.owner ?? inst}, ref: `${src}#${entity}`})),
    ...snap.relationships.map(([type, from, to, access, attributes]) => ({type, from, to, attributes, scope: {access, owner: inst}, ref: `${src}#${type}(${from}->${to})`}))];
}
/** The adapter of a department's synthetic source: its versions are the digests of the snapshots published. */
function deptSource(root, inst) {
  const dir = path.join(root, inst, 'src');
  return {id: sourceOf(inst), extractor: `${inst}.extractor`, authority: `${inst}'s synthetic systems inventory (a JSON snapshot on disk)`, ref: `${sourceOf(inst)}/current.json`,
    current: () => ({version: versionOf(JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')))}),
    readAt: version => draftsOf(inst, JSON.parse(fs.readFileSync(path.join(dir, 'versions', version.slice(7) + '.json'), 'utf8')))};
}
export const originsOf = inst => defineOrigins({
  [`${inst}.extractor`]: {kind: 'extractor', basis: 'declared', keys: [`${inst}-extractor`], sources: [sourceOf(inst)]},
  [`${inst}.tool`]: {kind: 'tool', basis: 'measured', keys: [`${inst}-tool`]},
  ...receiverOrigin([`${inst}-receiver`]),
});
const publicOf = (keys, prefix) => Object.fromEntries(Object.entries(keys).filter(([k]) => k.startsWith(prefix + '-')).map(([k, s]) => [k, s.publicJwk]));

/** A federation for one test: three ledgers, synthetic keys and secrets, saved on disk; removed after the test. */
export function federation(t, {maxAgeMs = 60 * 60_000} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-federation-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const keys = {};
  for (const inst of DEPARTMENTS) for (const k of ['operator', 'extractor', 'tool', 'receiver', 'export']) keys[`${inst}-${k}`] = generateSigner(`${inst}-${k}`);
  for (const k of ['operator', 'import', 'link', 'notice']) keys[`${CENTRAL}-${k}`] = generateSigner(`${CENTRAL}-${k}`);
  const secrets = Object.fromEntries(DEPARTMENTS.map(d => [d, randomBytes(32).toString('hex')]));
  const anchors = {};
  for (const inst of [...DEPARTMENTS, CENTRAL]) {
    const dir = path.join(root, inst, 'ledger');
    fs.mkdirSync(dir, {recursive: true});
    // each instance's keyring holds its own keys only: no instance can sign into another's ledger
    anchors[inst] = createGraphLedger({dir, authority: {keyring: publicOf(keys, inst), orderer: `${inst}-operator`, operators: [`${inst}-operator`]},
      operator: keys[`${inst}-operator`], order: keys[`${inst}-operator`]});
  }
  fs.writeFileSync(path.join(root, 'world.json'), JSON.stringify({keys, secrets, anchors, maxAgeMs}));
  return worldOf(root);
}

/** The handles of a federation saved at `root` (also what a child process opens). */
export function worldOf(root) {
  const {keys, secrets, anchors, maxAgeMs} = JSON.parse(fs.readFileSync(path.join(root, 'world.json'), 'utf8'));
  const by = (inst, k) => ({signer: keys[`${inst}-${k}`], order: keys[`${inst}-operator`]});
  const reachable = inst => () => !fs.existsSync(path.join(root, 'offline', inst));
  const hub = {instance: CENTRAL, anchor: anchors[CENTRAL], keys: {[`${CENTRAL}-notice`]: keys[`${CENTRAL}-notice`].publicJwk}};
  const w = {
    root, keys, anchors, secrets, hub, by, reachable,
    centralBy: {import: by(CENTRAL, 'import'), link: by(CENTRAL, 'link'), notice: keys[`${CENTRAL}-notice`]},
    /** Take an instance off the network (or back): its transport fails, as in a partition. */
    offline(inst, down = true) {
      fs.mkdirSync(path.join(root, 'offline'), {recursive: true});
      if (down) fs.writeFileSync(path.join(root, 'offline', inst), ''); else fs.rmSync(path.join(root, 'offline', inst), {force: true});
    },
    /** Publish a snapshot of a department's source; every version stays readable. */
    publishSource(inst, snapshot) {
      const dir = path.join(root, inst, 'src'), version = versionOf(snapshot);
      fs.mkdirSync(path.join(dir, 'versions'), {recursive: true});
      fs.writeFileSync(path.join(dir, 'versions', version.slice(7) + '.json'), JSON.stringify(snapshot));
      fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(snapshot));
      return version;
    },
    graphOf: (inst, o = {}) => openGraph({dir: path.join(root, inst, 'ledger'), anchor: anchors[inst], origins: originsOf(inst), sources: [deptSource(root, inst)], instance: inst, ...o}),
    /** A department: its own graph and its federation handle. */
    open(inst, o = {}) {
      const graph = w.graphOf(inst, o);
      const dept = department({graph, policy: o.policy ?? POLICY, secret: Buffer.from(secrets[inst], 'hex'), signer: keys[`${inst}-export`],
        outbox: path.join(root, inst, 'outbox'), hub, transport: noticeTransport(path.join(root, CENTRAL), {reachable: reachable(CENTRAL)})});
      return {inst, graph, dept,
        observe: minutes => graph.observe(sourceOf(inst), {...by(inst, 'extractor'), observed_at: at(minutes)}),
        publish: (minutes, o2 = {}) => dept.publish({exported_at: at(minutes), ...o2})};
    },
    /** The central instance. */
    central(o = {}) {
      return openCentral({dir: path.join(root, CENTRAL), anchor: anchors[CENTRAL], instance: CENTRAL,
        departments: Object.fromEntries(DEPARTMENTS.map(d => [d, {anchor: anchors[d], keys: {[`${d}-export`]: keys[`${d}-export`].publicJwk},
          transport: outboxTransport(path.join(root, d, 'outbox'), {reachable: reachable(d)})}])),
        importKeys: [`${CENTRAL}-import`], linkKeys: [`${CENTRAL}-link`], maxAgeMs, lockTimeoutMs: 60_000, ...o});
    },
  };
  return w;
}

/** Everything under `dir`, file by file (path -> bytes as text): what the disclosure tests search, and compare. */
export function filesUnder(dir) {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
