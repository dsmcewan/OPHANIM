// THE HUB-READINESS DETERMINATION (docs/knowledge-graph/hub-and-spoke.md; the directive's section 6, "Central OPHANIM:
// the enterprise-level orchestration and relationship hub"). ADVISORY: it splits nothing, federates nothing and changes
// no production behaviour.
//
// The question (the owner, 2026-11-20, as clarified twice): is it appropriate for OPHANIM to REPLICATE into three
// departmental instances (Finance, Technology, Compliance: full foundries from the same code, each with its own ledgers,
// authority and graph), with the original as the central hub running the collective knowledge graph, and what must be
// true first? It is answered by MEASUREMENT, on a SYNTHETIC three-department federation built on Slice E's machinery
// (packages/graph/federation.mjs; fixtures/hub-world.mjs), sized from OPHANIM's own graph, and by facts read from this
// repository at a commit (its graph, its register, its code at file:line). Criteria R1-R12, each with its threshold
// stated as a PROPOSAL the owner may change:
//   R1 authority  R2 the collective graph  R3 freshness and recovery  R4 hub cost  R5 ingestion integrity
//   R6 the hub's dual role  R7 governance  R8 load  R9 replication  R10 identity under replication  R11 code lineage
//   R12 collective learning
// Then a VERDICT: APPROPRIATE, APPROPRIATE WITH CONDITIONS (in order), or NOT APPROPRIATE NOW (the failing criteria),
// and the path to production.
//
// Inputs    A built graph of the repository at the commit (extract/index.mjs systemsGraph: synthetic keys, a temporary
//           ledger), the repository root, the scales (department size = OPHANIM's measured graph x scale).
// Must never  Write outside its temporary directories; open a real ledger writable; use a real key; reach a provider;
//           fix what it measures (packages/** is the coordinator's): a hole found is reported, with its register entry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createPrivateKey, randomBytes, sign as edSign} from 'node:crypto';
import {canonical, digest} from '../../packages/ledger/canonical.mjs';
import {generateSigner} from '../../packages/ledger/chain.mjs';
import {assertion, createGraphLedger, defineOrigins, definePolicy, department, importSource, openCentral, openGraph, parseId, writeSnapshot,
  CONTRACT_VERSION, LINKER, REFERENCES} from '../../packages/graph/index.mjs';
import {DEPARTMENTS, CENTRAL, NODES, KEY_IDS, POLICY, WITHHELD_MARK, at, hubWorld, seed, departmentSnapshot, scanForWithheld, plantedValues,
  filesUnder, refTo, sourceAt, originsFor, replica} from './fixtures/hub-world.mjs';
import {recordId, registerEntries, REGISTER} from './extract/records.mjs';
import {fileId, symbolId} from './extract/repo.mjs';
import {treeAt, blobsAt} from './extract/git.mjs';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {openWorkLedger} from '../operate/work-ledger.mjs';

export const HUB_SCHEMA = 'ophanim.hub-readiness/v1';
export const QUESTION = 'Is it appropriate for OPHANIM to replicate into three departmental instances, with the original as the central hub running the collective knowledge graph, and what must be true first?';
const CHILD = fileURLToPath(new URL('./fixtures/hub-child.mjs', import.meta.url));
const LIST = 50;
const cap = (xs, n = LIST) => ({shown: xs.slice(0, n), total: xs.length, more: Math.max(0, xs.length - n)});
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const H = v => 'sha256:' + digest(v);
const ms = t0 => Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10;
const timed = fn => { const t0 = process.hrtime.bigint(); const value = fn(); return {value, ms: ms(t0)}; };
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const instanceOf = id => id.split('/')[0];
/** A small federation for the behavioural criteria (their logic does not depend on size; the cost criteria run at scale). */
export const SMALL = Object.freeze({entities: 24, relationships: 60});

/** Each criterion's threshold: a PROPOSAL, the owner's to change. */
export const THRESHOLDS = Object.freeze({
  R1: 'zero withheld values (restricted, or an internal node\'s details) and zero restricted ids disclosed by their owner in any file of the central; every department ledger byte-identical across every hub operation; a central write into a department refused',
  R2: 'exactly the permitted, resolving cross-department references linked, each with its two imported inputs and its pinned {instance, anchor, node, version}; zero links of a forbidden type or to a withheld node',
  R3: 'an unreachable department reads stale in freshness and in every link resting on it; catch-up imports each export once, in chain order (zero skipped, zero duplicated); a repeated catch-up imports and issues nothing; every department records, publishes and answers while the hub is down',
  R4: 'a fresh-process open of the central <= 1000 ms (the inventory\'s 1 s per tick, KG-9; the coordinator\'s 500 ms margin reported) at x1, by the hub AS BUILT; a signed snapshot the hub as built uses, else a GAP',
  R5: 'zero spliced (previous not the stored chain tail), forked, rolled-back (seq below its predecessor\'s) or spoofed exports stored or imported; any one accepted blocks production',
  R6: 'the hub\'s own facts reach the collective graph only through a department export under the same policy as every spoke, and the code refuses a hub-namespace fact that would bypass it',
  R7: 'the hub cannot record work, a status or an intake in a department (each keeps its authority boundary); the owner\'s pending decisions listed (KG-4)',
  R8: 'what the collective graph adds to one tick of the hub (central open + an incremental catch-up) <= 1000 ms at x1, by the hub as built',
  R9: 'one command or function makes a departmental instance from the code at a commit: its own status, work, cycle, run and graph ledgers, anchors, keys and config, sharing nothing with the hub or another replica but exports',
  R10: 'every ledger of every replica has a distinct anchor, also when replicas are made with identical authority (else KG-8 makes replication unsafe); no replica is accepted as another',
  R11: 'an export names the code that produced it (commit, contract version); a mechanism carries code repairs from the hub\'s line to replicas by version; replica-local state is named',
  R12: 'a defect found in one replica reaches every replica that depends on it, transitively, as a signed notice with its origin, export and ledger entries, recorded by the recipient with its own key, no ledger copied; a lesson can cross under the policy',
});
/** The order conditions are met in (the path to production): integrity and identity first, cost last. */
export const PRIORITY = Object.freeze(['R5', 'R10', 'R1', 'R2', 'R3', 'R7', 'R9', 'R11', 'R6', 'R4', 'R8', 'R12']);

/** A criterion's row. `status`: pass | fail | gap | condition; `blocking`: a fail that blocks production. */
export function criterion(id, title, status, {blocking = false, measured = {}, facts = [], condition = null, register = [], threshold = THRESHOLDS[id]} = {}) {
  if (!['pass', 'fail', 'gap', 'condition'].includes(status)) throw new Error(`${id}: status is pass, fail, gap or condition`);
  return {id, title, status, blocking: status === 'fail' && blocking, threshold, measured, facts, register, condition: status === 'pass' ? null : condition};
}

/**
 * The verdict of `criteria`: NOT APPROPRIATE NOW when a blocking criterion fails (naming them); APPROPRIATE WITH
 * CONDITIONS when every other non-passing criterion is a condition or a gap (listed in PRIORITY order); else APPROPRIATE.
 * The path to production is every non-passing criterion's condition, in PRIORITY order.
 */
export function verdict(criteria) {
  const rank = c => (PRIORITY.indexOf(c.id) + 1 || 99);
  const open = criteria.filter(c => c.status !== 'pass').sort((a, b) => rank(a) - rank(b) || byString(a.id, b.id));
  const failing = open.filter(c => c.blocking).map(c => c.id);
  const conditions = open.filter(c => !c.blocking).map(c => ({criterion: c.id, condition: c.condition}));
  return {verdict: failing.length ? 'NOT APPROPRIATE NOW' : conditions.length ? 'APPROPRIATE WITH CONDITIONS' : 'APPROPRIATE',
    failing, conditions, path: open.map((c, i) => ({step: i + 1, criterion: c.id, blocking: c.blocking, do: c.condition}))};
}

// ---- helpers over a world ------------------------------------------------------------------------------------------------
/** The digest of every file of each department's ledger: the hub must leave them byte for byte as the departments wrote them. */
export function ledgerDigests(w) {
  return Object.fromEntries(DEPARTMENTS.map(d => [d, H(Object.entries(filesUnder(path.join(w.root, d, 'ledger'))).sort(([a], [b]) => byString(a, b)))]));
}
const sameDigests = (a, b) => DEPARTMENTS.every(d => a[d] === b[d]);
/** Re-sign an export after altering it, as whoever holds `signer` (an impostor, or the department itself). */
export function resign(e, signer) {
  const {id, signature, ...body} = e, nid = H(body);
  return {...body, id: nid, signature: {key_id: signer.key_id, sig: edSign(null, Buffer.from(canonical({...body, id: nid})), createPrivateKey(signer.privatePem)).toString('base64')}};
}
const attempt = fn => { try { return {ok: true, value: fn()}; } catch (e) { return {ok: false, code: e.code ?? null, why: String(e.message ?? e).slice(0, 240)}; } };
const tail = (central, inst) => central.inbox.chain(inst).at(-1) ?? null;
const recordOf = (central, id) => central.graph.view().assertion(id)?.record ?? null;

/** R1's search of the central's whole directory (inbox, ledger, outbox, snapshots) for every withheld value planted. */
export function withheldSearch(w) {
  const planted = plantedValues(w), scan = scanForWithheld(w.centralDir, {namedByReferrers: [NODES.vault]});
  const found = [...scan.marks.keys()];
  return {planted: {restricted: planted.restricted.size, internal: planted.internal.size},
    found: {restricted: found.filter(x => planted.restricted.has(x)).length, internal: found.filter(x => planted.internal.has(x)).length,
      other: found.filter(x => !planted.restricted.has(x) && !planted.internal.has(x)).length, values: cap(found.sort())},
    restricted_ids_disclosed_by_owner: cap(scan.sealed), restricted_ids_named_by_a_referrer: cap(scan.named), files: scan.files, bytes: scan.bytes};
}

/** R2 over a caught-up central: the links, against the directive's two permitted dependencies and the two forbidden ones. */
export function collectiveGraph(w, central, s, now) {
  const d = central.dependencies({now}), view = central.graph.view();
  const expected = [`consumes ${NODES.control} -> ${NODES.report}`, `depends-on ${NODES.run} -> ${NODES.api}`];
  const links = d.links.map(l => {
    const r = recordOf(central, l.assertion);
    return {link: `${l.type} ${l.from} -> ${l.to}`, established: l.established, stale: l.stale, assertion: l.assertion, origin: r?.origin ?? null,
      classification: r?.classification ?? null, inputs: r?.inputs?.length ?? 0, reference: l.reference};
  }).sort((a, b) => byString(a.link, b.link));
  const provenance = links.every(l => l.origin === LINKER && l.classification === 'derived' && l.inputs === 2 && l.reference?.anchor === w.anchors[instanceOf(l.link.split(' -> ')[1])] && /^sha256:/.test(l.reference?.version ?? ''));
  const forbiddenLinked = links.filter(l => l.link.includes(NODES.vault) || l.link.startsWith('mentions '));
  const reach = central.closure([NODES.api], {direction: 'reverse', now});
  const reached = reach.nodes.map(n => n.id);
  return {links, expected, linked_exactly_the_permitted: canonical(links.map(l => l.link)) === canonical(expected), provenance,
    forbidden_linked: forbiddenLinked.map(l => l.link),
    unresolved: d.unresolved.map(u => ({from: u.from, to: u.reference.node, reason: u.reason})),
    withheld_references: Object.fromEntries(DEPARTMENTS.map(x => [x, s.ex[x].withheld?.references ?? null])),
    transitive: {from: NODES.api, reaches: [NODES.run, NODES.report, NODES.control].filter(n => reached.includes(n)), instances: [...new Set(reached.map(instanceOf))].sort(), nodes: reached.length},
    central: view.stats()};
}

// ---- the cost run, at a scale (R1, R2, R4, R8): run in its own process (fixtures/hub-child.mjs scale) -----------------------
/**
 * Build the federation at `size` under `root`, catch the hub up, search it, link it, then `rounds` ticks (each department
 * changes one node; the hub catches up), then write a signed snapshot and open the central in FRESH processes, in full
 * (the hub as built) and from the snapshot. {size, seed, first, r1, r2, ticks, opens, snapshot, files}.
 */
export function scaleRun({root, size, rounds = 2, opens = 2, openArgs = []}) {
  const w = hubWorld({root});
  const s = seed(w, size);
  const d0 = ledgerDigests(w), central = w.central();
  const first = timed(() => central.catchUp({by: w.centralBy, now: at(10)}));
  const unchanged = [sameDigests(d0, ledgerDigests(w))];
  const r2 = collectiveGraph(w, central, s, at(10));
  const ticks = [];
  for (let r = 1; r <= rounds; r++) {
    // One tick: Technology's API changes (a change that reaches both other departments), Finance re-pins it, Compliance
    // re-pins Finance's report; each also changes one node of its own.
    const tech = s.republish('technology', 10 + r * 5, {changed: [r], round: r, patch: {[NODES.api]: {revision: r}}});
    const fin = s.republish('finance', 11 + r * 5, {changed: [r], round: r, refs: {[NODES.run]: [{type: 'depends-on', to: refTo(w, 'technology', tech.export, NODES.api)}]}});
    const com = s.republish('compliance', 12 + r * 5, {changed: [r], round: r, refs: {[NODES.control]: [{type: 'consumes', to: refTo(w, 'finance', fin.export, NODES.report)}, ...s.refs.forbidden]}});
    const dept = [{inst: 'technology', ...tech}, {inst: 'finance', ...fin}, {inst: 'compliance', ...com}];
    const before = ledgerDigests(w);
    const c = timed(() => central.catchUp({by: w.centralBy, now: at(12 + r * 5)}));
    unchanged.push(sameDigests(before, ledgerDigests(w)));
    ticks.push({round: r, catch_up_ms: c.ms, imported: Object.fromEntries(Object.entries(c.value.imported).map(([k, v]) => [k, v.length])), notices: c.value.notices.issued.length,
      department_export_ms: Object.fromEntries(dept.map(x => [x.inst, Math.round(x.ms)]))});
  }
  const write = central.catchUp({by: w.centralBy, now: at(40)});
  const r1 = {...withheldSearch(w), ledgers_unchanged: {operations: unchanged.length, all: unchanged.every(Boolean)},
    hub_as_built_snapshot: central.graph.verification?.snapshot ?? null};
  const snapDir = path.join(root, 'central-snapshots');
  const snap = timed(() => writeSnapshot(central.graph, {dir: snapDir, signer: w.snapshotKey}));
  const rss = process.memoryUsage().rss;
  const open = mode => {
    const r = spawnSync(process.execPath, [...openArgs, CHILD, 'open', root, ...(mode === 'snapshot' ? [snapDir] : [])], {encoding: 'utf8', maxBuffer: 1 << 26});
    if (r.status !== 0) return {mode, error: (r.stderr || r.stdout).slice(-400)};
    return {mode, ...JSON.parse(r.stdout.trim().split('\n').at(-1))};
  };
  const fresh = [open('full'), ...Array.from({length: opens}, () => open('snapshot'))];
  return {size, seed: {ms: Object.fromEntries(Object.entries(s.ms).map(([k, v]) => [k, Math.round(v)])),
    exports: Object.fromEntries(DEPARTMENTS.map(d => [d, {nodes: s.ex[d].nodes.length, relationships: s.ex[d].relationships.length, withheld: s.ex[d].withheld,
      bytes: Buffer.byteLength(JSON.stringify(s.ex[d]))}]))},
  first: {catch_up_ms: first.ms, imported: Object.fromEntries(Object.entries(first.value.imported).map(([k, v]) => [k, v.length])), rss_mb: Math.round(rss / 1e6)},
  r1, r2, ticks, idle: {imported: Object.values(write.imported).flat().length},
  snapshot: {write_ms: snap.ms, bytes: snap.value.bytes, seq: snap.value.seq}, opens: fresh,
  files: {central_bytes: r1.bytes, central_files: r1.files}};
}

// ---- the behavioural runs (small federations; temp dirs) -------------------------------------------------------------------
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const withWorld = (o, fn) => { const w = hubWorld(o); try { return fn(w); } finally { w.close(); } };

/** R3: disconnection, catch-up by version, independence from the hub. */
export function freshnessRun(size = SMALL) {
  return withWorld({}, w => {
    const s = seed(w, size), central = w.central();
    central.catchUp({by: w.centralBy, now: at(10)});
    // Compliance cut off; Technology changes; the hub catches up.
    w.offline('compliance');
    s.republish('technology', 11, {changed: [1], round: 1});
    central.catchUp({by: w.centralBy, now: at(12)});
    const f = central.freshness({now: at(12)}), deps = central.dependencies({now: at(12)});
    const staleLinks = deps.links.filter(l => l.stale).map(l => `${l.type} ${l.from} -> ${l.to}`);
    const disconnected = {state: f.compliance.state, reasons: f.compliance.reasons, others: {finance: f.finance.state, technology: f.technology.state},
      stale_links: staleLinks, link_of_others_stale: deps.links.some(l => l.stale && l.from_instance !== 'compliance' && l.to_instance !== 'compliance'), answer_stale: deps.stale};
    // The hub down: every department records, publishes and answers on its own.
    w.offline(CENTRAL);
    const before = Object.fromEntries(DEPARTMENTS.map(d => [d, central.inbox.chain(d).length]));
    const independent = DEPARTMENTS.map((inst, i) => {
      const p = attempt(() => s.republish(inst, 20 + i, {changed: [2 + i], round: 2}));
      const q = attempt(() => s.h[inst].graph.view().stats());
      const pull = s.h[inst].dept.pull({by: w.by(inst, 'graph-receiver'), observed_at: at(25)});
      return {instance: inst, published: p.ok && p.value.published, answered: q.ok, hub_reachable: pull.reachable, why: pull.why ?? null};
    });
    const published = Object.fromEntries(DEPARTMENTS.map(d => [d, s.h[d].dept.published().length]));
    // Back: one catch-up imports every export after the last, in order; a second imports and issues nothing.
    w.offline(CENTRAL, false); w.offline('compliance', false);
    const c1 = central.catchUp({by: w.centralBy, now: at(30)}), c2 = central.catchUp({by: w.centralBy, now: at(31)});
    const order = DEPARTMENTS.map(d => {
      const chain = central.inbox.chain(d).map(e => e.id), outbox = s.h[d].dept.published().map(e => e.id);
      return {instance: d, outbox: outbox.length, imported_now: c1.imported[d].length, expected_now: outbox.length - before[d],
        in_order: canonical(c1.imported[d]) === canonical(outbox.slice(before[d])), chain_equals_outbox: canonical(chain) === canonical(outbox), duplicates: chain.length - new Set(chain).size};
    });
    const after = central.freshness({now: at(31)});
    return {disconnected, independent, catch_up: order, repeat: {imported: Object.values(c2.imported).flat().length, notices: c2.notices.issued.length},
      all_current_after: DEPARTMENTS.every(d => after[d].state === 'current'), published};
  });
}

/** R5: the hub's ingestion against a spliced chain (KG-14), a fork, a rollback, spoofs and the genesis spoof (KG-8), and a value copied into a public attribute (KG-8). */
export function ingestionRun(size = SMALL) {
  return withWorld({}, w => {
    const s = seed(w, size), central = w.central();
    central.catchUp({by: w.centralBy, now: at(10)});
    const fin = s.h.finance, out = {};
    // KG-14: a legitimately signed export whose `previous` names an id the hub never received, then one chained after it.
    const ghost = {id: 'sha256:' + 'ab'.repeat(32), nodes: [], relationships: [], seq: 1};
    const e1 = fin.dept.exportAt(undefined, {exported_at: at(11), previous: ghost}), e2 = fin.dept.exportAt(undefined, {exported_at: at(12), previous: e1});
    const o1 = central.offer('finance', [e1, e2]);
    const cu = central.catchUp({by: w.centralBy, now: at(13)}), f = central.freshness({now: at(13)}).finance;
    out.splice = {register: 'KG-14', offered: 2, stored: o1.stored.length, refused: o1.refused.map(r => r.code), imported: cu.imported.finance.length,
      freshness: f.state, pending_reported: f.pending, stored_unimported: o1.stored.length - cu.imported.finance.length,
      accepted: o1.stored.length > 0};
    // A fork: a second export claiming the same predecessor (the start of the chain) as one already stored.
    const fork = fin.dept.exportAt(undefined, {exported_at: at(14), previous: null});
    const o2 = central.offer('finance', [fork]);
    out.fork = {stored: o2.stored.length, refused: o2.refused.map(r => r.code), accepted: o2.stored.length > 0};
    // A rollback: Finance changes and the hub imports it; then a signed export of Finance's EARLIER view, chained after it.
    const early = fin.graph.view().seq;
    s.republish('finance', 15, {changed: [3], round: 3});
    central.catchUp({by: w.centralBy, now: at(16)});
    const head = tail(central, 'finance'), nodeNow = central.graph.view().node(`finance/systems/process/n-3`)?.attributes?.version ?? null;
    const back = fin.dept.exportAt(early, {exported_at: at(17), previous: head});
    const o3 = central.offer('finance', [back]);
    const cu3 = central.catchUp({by: w.centralBy, now: at(18)});
    const nodeAfter = central.graph.view().node(`finance/systems/process/n-3`)?.attributes?.version ?? null;
    out.rollback = {register: null, previous_seq: head.seq, offered_seq: back.seq, stored: o3.stored.length, imported: cu3.imported.finance.length,
      projection_reverted: nodeAfter !== null && nodeAfter !== nodeNow, freshness: central.freshness({now: at(18)}).finance.state, accepted: o3.stored.length > 0};
    // Spoofs: another ledger claiming to be Finance (its own anchor); Finance's real export altered and signed by an unpinned key.
    const other = hubWorld();
    try {
      const os2 = seed(other, size);
      const o4 = central.offer('finance', [os2.ex.finance]);
      const forged = resign({...os2.ex.finance, instance: 'finance', anchor: w.anchors.finance, audience: {instance: CENTRAL, anchor: w.anchors[CENTRAL]}, previous: tail(central, 'finance').id},
        other.keys.finance['graph-export']);
      const o5 = central.offer('finance', [forged]);
      out.spoof_other_anchor = {refused: o4.refused.map(r => r.code), accepted: o4.stored.length > 0};
      out.spoof_unpinned_key = {refused: o5.refused.map(r => r.code), accepted: o5.stored.length > 0};
    } finally { other.close(); }
    // The genesis spoof (KG-8): Finance's ledger RE-CREATED elsewhere with the identical authority, a forged inventory,
    // signed with Finance's export key and chained after the hub's tail.
    const k = w.keys.finance, op = k['graph-operator'], dir = path.join(w.root, 'impostor', 'finance', 'ledger');
    fs.mkdirSync(dir, {recursive: true});
    const anchor = createGraphLedger({dir, authority: {keyring: Object.fromEntries(Object.entries(k).map(([id, x]) => [id, x.publicJwk])), orderer: op.key_id, operators: [op.key_id]}, operator: op, order: op});
    const imp = path.join(w.root, 'impostor');
    const src = sourceAt(imp, 'finance');
    fs.mkdirSync(path.join(imp, 'finance', 'src', 'versions'), {recursive: true});
    const forgedSnap = departmentSnapshot('finance', {entities: 4, relationships: 0}, {patch: {[NODES.report]: {format: 'FORGED-BY-IMPOSTOR'}}});
    const v = 'sha256:' + digest(forgedSnap);
    fs.writeFileSync(path.join(imp, 'finance', 'src', 'versions', v.slice(7) + '.json'), JSON.stringify(forgedSnap));
    fs.writeFileSync(path.join(imp, 'finance', 'src', 'CURRENT'), v);
    const g = openGraph({dir, anchor, origins: originsFor('finance'), sources: [src], instance: 'finance'});
    g.observe('finance.systems', {...w.by('finance', 'graph-extractor'), observed_at: at(19)});
    const dept = department({graph: g, policy: POLICY, secret: Buffer.from(w.secrets.finance, 'hex'), signer: k['graph-export'], outbox: path.join(imp, 'outbox'), hub: w.hub});
    const spoof = dept.exportAt(undefined, {exported_at: at(20), previous: tail(central, 'finance')});
    const o6 = central.offer('finance', [spoof]);
    const cu6 = central.catchUp({by: w.centralBy, now: at(21)});
    const report = central.graph.view().node(NODES.report)?.attributes?.details?.attributes?.format ?? null;
    out.genesis_spoof = {register: 'KG-8', same_anchor: anchor === w.anchors.finance, stored: o6.stored.length, imported: cu6.imported.finance.length,
      forged_fact_in_hub: report === 'FORGED-BY-IMPOSTOR', freshness: central.freshness({now: at(21)}).finance.state, accepted: o6.stored.length > 0,
      needs: 'the department\'s operator and export private keys (a custody failure), or a replica provisioned from the same template (R10)'};
    // The value leak (KG-8): a restricted value copied into a public attribute by the department itself.
    const leaked = `${WITHHELD_MARK}technology-vault-key`;
    s.republish('technology', 22, {patch: {[NODES.api]: {}}, extra: {'technology/systems/api/public-status': {access: 'public', attributes: {note: leaked}}}});
    central.catchUp({by: w.centralBy, now: at(23)});
    out.value_leak = {register: 'KG-8', restricted_value_in_hub: scanForWithheld(w.centralDir).marks.has(leaked), detectable_by_hub: false,
      why: 'the department classifies its own data; a restricted value copied into a public attribute leaves under the policy, and the scrub finds withheld ids, not values (federation.mjs scrub)'};
    return out;
  });
}

/** R12: a defect in Technology reaches Finance (direct) and Compliance (transitive) as notices; a lesson under the policy. */
export function learningRun(size = SMALL) {
  return withWorld({}, w => {
    const s = seed(w, size), central = w.central();
    central.catchUp({by: w.centralBy, now: at(10)});
    const before = Object.fromEntries(DEPARTMENTS.map(d => [d, new Set(central.notices(d).map(n => n.id))]));
    const changed = s.republish('technology', 11, {patch: {[NODES.api]: {defect: `${WITHHELD_MARK}technology-retry-storm`}}});
    const cu = central.catchUp({by: w.centralBy, now: at(12)});
    const notices = Object.fromEntries(DEPARTMENTS.map(d => [d, central.notices(d).filter(n => !before[d].has(n.id))]));
    const received = {};
    for (const d of ['finance', 'compliance']) {
      const p = s.h[d].dept.pull({by: w.by(d, 'graph-receiver'), observed_at: at(13)});
      const auth = s.h[d].graph.ledger.verify();
      const foreign = Object.values(auth.authority?.keys ?? {}).filter(j => [...Object.values(w.keys[CENTRAL]), ...DEPARTMENTS.filter(x => x !== d).flatMap(x => Object.values(w.keys[x]))]
        .some(k => k.publicJwk.x === j.x));
      received[d] = {reachable: p.reachable, recorded: p.received.filter(r => r.recorded).length, refused: p.refused?.length ?? 0,
        affected: p.received.flatMap(r => r.affected.nodes.map(n => n.id)).filter((x, i, xs) => xs.indexOf(x) === i).length,
        seeds: p.received.flatMap(r => r.seeds), ledger_verifies: auth.ok, own_keys_in_keyring: Object.keys(auth.authority?.keys ?? {}).length, foreign_keys_in_keyring: w.identical ? null : foreign.length};
    }
    const prov = Object.fromEntries(Object.entries(notices).map(([d, ns]) => [d, ns.map(n => ({origin: n.origin.instance, export: n.origin.export === changed.export.id,
      entries: n.origin.changes.every(c => /^sha256:/.test(c.at?.entry ?? '')), via: n.via.instance, references: n.references.map(r => r.node)}))]));
    // No ledger copied: no file of a department's ledger is in the central's directory.
    const deptFiles = new Set(DEPARTMENTS.flatMap(d => Object.values(filesUnder(path.join(w.root, d, 'ledger'))).map(t => H(t))));
    const copied = Object.values(filesUnder(w.centralDir)).filter(t => deptFiles.has(H(t))).length;
    // A lesson: Technology records a failure class that applies to Finance's payment run; the coordinator's policy permits no applies-to.
    const lastFin = central.inbox.chain('finance').at(-1);
    const lesson = s.republish('technology', 14, {extra: {[NODES.lesson]: {access: 'public', attributes: {mechanism: 'unbounded retries', [REFERENCES]: [{type: 'applies-to', to: refTo(w, 'finance', lastFin, NODES.run)}]}}}});
    central.catchUp({by: w.centralBy, now: at(15)});
    const lessonLinked = central.dependencies({now: at(15)}).links.some(l => l.from === NODES.lesson);
    const admissible = attempt(() => definePolicy({...POLICY, id: 'owner.lessons-probe', relationships: [...POLICY.relationships, 'applies-to']}));
    return {defect: {notices: Object.fromEntries(Object.entries(notices).map(([d, ns]) => [d, ns.length])), provenance: prov, received, ledger_files_copied_to_hub: copied},
      lesson: {withheld_references: lesson.export.withheld?.references ?? null, linked: lessonLinked, policy_relationships: POLICY.relationships,
        applies_to_admissible_across: admissible.ok}};
  });
}

/** R6 (synthetic part): does the code keep the central apart from a department, and the hub's own facts under the policy? */
export function dualRoleRun(size = SMALL) {
  return withWorld({}, w => {
    seed(w, size);
    const sameName = attempt(() => openCentral({dir: tmp('ophanim-hub-dual-'), anchor: w.anchors[CENTRAL], instance: 'technology',
      departments: {technology: {anchor: w.anchors.technology, keys: {'graph-export': w.keys.technology['graph-export'].publicJwk}}}, importKeys: ['central-import'], linkKeys: ['central-link']}));
    // openCentral spreads its options after its origin registry: a caller can give the central an origin of its own and
    // record facts in the central's namespace, which no department export and no policy filters.
    const extra = defineOrigins({...Object.fromEntries(DEPARTMENTS.map(d => [importSource(d), {kind: 'extractor', basis: 'declared', keys: ['central-import'], sources: [importSource(d)]}])),
      [LINKER]: {kind: 'rule', basis: 'declared', keys: ['central-link']}, 'hub.self': {kind: 'tool', basis: 'measured', keys: ['central-import']}});
    const central = w.central({origins: extra});
    const own = assertion({entity: `${CENTRAL}/systems/service/self-api`, origin: 'hub.self', classification: 'observed', run: {id: 'hub-self-1'}, observed_at: at(9),
      source: {id: 'hub.self.runs', authority: 'the hub observing its own systems', ref: 'hub.self#self-api', version: H({run: 1})},
      scope: {access: 'internal', owner: CENTRAL}, attributes: {detail: `${WITHHELD_MARK}hub-own-detail`}});
    const wrote = attempt(() => central.assert([own], w.centralBy.import));
    const visible = central.graph.view().nodeIn(own.subject, 'established');
    return {department_named_as_the_central: {refused: !sameName.ok, why: sameName.why ?? null},
      hub_own_fact_without_export: {recorded: wrote.ok && Boolean(wrote.value.appended), established_in_collective_graph: visible, why: wrote.why ?? null,
        detail_unfiltered_in_hub: scanForWithheld(w.centralDir).marks.has(`${WITHHELD_MARK}hub-own-detail`)}};
  });
}

/** R7: can the hub write into a department, or dispatch work there? */
export function governanceRun() {
  const root = tmp('ophanim-hub-gov-');
  try {
    const out = {};
    withWorld({}, w => {
      seed(w, SMALL);
      const central = w.central();
      const intruder = assertion({entity: 'finance/systems/process/intruder', origin: 'finance.tool', classification: 'observed', observed_at: at(1),
        source: {id: 'finance.systems', authority: 'synthetic', ref: 'r', version: 'sha256:' + '0'.repeat(64)}, scope: {access: 'public', owner: 'finance'}, attributes: {}});
      const r = attempt(() => central.assert([intruder], w.centralBy.import));
      out.central_writes_department = {refused: !r.ok, code: r.code, why: r.why ?? null};
      const t = w.keys[CENTRAL]['central-operator'];
      out.keys = {central_key_ids: Object.keys(w.keys[CENTRAL]).sort(), department_keyrings_hold_a_central_key: DEPARTMENTS.some(d => {
        const k = w.open(d).graph.ledger.verify().authority?.keys ?? {};
        return Object.values(k).some(j => j.x === t.publicJwk.x);
      })};
    });
    const rep = replica({root, instance: 'finance', commit: 'synthetic'});
    const S = openStatusLedger({root: rep.roots.status, create: false});
    const hubKey = generateSigner('central-operator');
    const st = attempt(() => S.ledger.append({kind: 'status', payload: {schema: 'ophanim.status/v1', item: 'hub-dispatched', title: 'work the hub dispatches', state: 'Ready', basis: 'the hub', checked: '2026-11-20'},
      author: {key_id: hubKey.key_id}, signer: hubKey, order: hubKey}));
    out.hub_signed_status_in_replica = {refused: !st.ok, why: st.why ?? null};
    const W = openWorkLedger({root: rep.roots.work, create: false});
    const intake = attempt(() => W.intake({source: 'federation', ref: 'notice:x', item: null, classification: 'candidate', why: 'a hub notice as work'}));
    out.federation_intake_in_replica = {refused: !intake.ok, why: intake.why ?? null, note: 'even signed by the replica\'s own controller key'};
    return out;
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

/** R9 and R10: three replicas from one commit; then replicas from one template; then identical-authority impersonation at the hub. */
export function replicationRun({commit, size = SMALL}) {
  const root = tmp('ophanim-hub-replicas-');
  try {
    const made = [];
    for (const inst of DEPARTMENTS) made.push(replica({root: path.join(root, 'fresh'), instance: inst, commit}));
    const anchors = made.flatMap(r => Object.entries(r.anchors).map(([ledger, a]) => ({instance: r.instance, ledger, anchor: a})));
    const distinct = new Set(anchors.map(a => a.anchor)).size;
    const roots = made.flatMap(r => Object.values(r.roots)), keyDirs = made.flatMap(r => Object.values(r.keyDirs));
    const template = Object.fromEntries(KEY_IDS.map(k => [k, generateSigner(k)]));
    const twins = [];
    for (const inst of ['finance', 'compliance']) twins.push(replica({root: path.join(root, 'template'), instance: inst, commit, template}));
    const twinAnchors = Object.fromEntries(Object.keys(twins[0].anchors).map(l => [l, twins[0].anchors[l] === twins[1].anchors[l]]));
    // At the hub: replicas provisioned from one template share one anchor; one signs as another and is imported.
    const impersonation = withWorld({identical: true}, w => {
      const s = seed(w, size), central = w.central();
      central.catchUp({by: w.centralBy, now: at(10)});
      const sameAnchors = new Set(DEPARTMENTS.map(d => w.anchors[d])).size === 1;
      const dir = path.join(w.root, 'impostor', 'compliance', 'ledger'), k = w.keys.finance, op = k['graph-operator'];
      fs.mkdirSync(dir, {recursive: true});
      const anchor = createGraphLedger({dir, authority: {keyring: Object.fromEntries(Object.entries(k).map(([id, x]) => [id, x.publicJwk])), orderer: op.key_id, operators: [op.key_id]}, operator: op, order: op});
      const imp = path.join(w.root, 'impostor');
      const snap = departmentSnapshot('compliance', {entities: 2, relationships: 0}, {patch: {[NODES.control]: {cadence: 'FORGED-BY-FINANCE'}}});
      const v = 'sha256:' + digest(snap);
      fs.mkdirSync(path.join(imp, 'compliance', 'src', 'versions'), {recursive: true});
      fs.writeFileSync(path.join(imp, 'compliance', 'src', 'versions', v.slice(7) + '.json'), JSON.stringify(snap));
      fs.writeFileSync(path.join(imp, 'compliance', 'src', 'CURRENT'), v);
      const g = openGraph({dir, anchor, origins: originsFor('compliance'), sources: [sourceAt(imp, 'compliance')], instance: 'compliance'});
      g.observe('compliance.systems', {signer: k['graph-extractor'], order: op, observed_at: at(11)});
      const dept = department({graph: g, policy: POLICY, secret: randomBytes(32), signer: k['graph-export'], outbox: path.join(imp, 'outbox'), hub: w.hub});
      const e = dept.exportAt(undefined, {exported_at: at(12), previous: tail(central, 'compliance')});
      const o = central.offer('compliance', [e]);
      const cu = central.catchUp({by: w.centralBy, now: at(13)});
      const forged = central.graph.view().node(NODES.control)?.attributes?.details?.attributes?.cadence === 'FORGED-BY-FINANCE';
      return {identical_anchors: sameAnchors, finance_key_signs_as_compliance: {stored: o.stored.length, imported: cu.imported.compliance.length, forged_fact_in_hub: forged}};
    });
    const separate = withWorld({}, w => {
      const s = seed(w, size), central = w.central();
      central.catchUp({by: w.centralBy, now: at(10)});
      const e = resign({...s.ex.compliance, previous: tail(central, 'compliance').id}, w.keys.finance['graph-export']);
      const o = central.offer('compliance', [e]);
      return {distinct_anchors: new Set(DEPARTMENTS.map(d => w.anchors[d])).size === 3, finance_key_signs_as_compliance: {stored: o.stored.length, refused: o.refused.map(r => r.code)}};
    });
    return {replicas: made.map(r => ({instance: r.instance, commit: r.commit, anchors: r.anchors, billing: r.config.billing.digest, manual: r.manual})),
      fresh: {anchors: anchors.length, distinct, roots_disjoint: new Set(roots).size === roots.length, key_dirs_disjoint: new Set(keyDirs).size === keyDirs.length},
      template: {same_anchor_by_ledger: twinAnchors}, impersonation, separate};
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

/** R11 (synthetic part): what an export says about the code that made it; a type the hub's contract lacks. */
export function lineageRun(size = SMALL) {
  return withWorld({}, w => {
    const s = seed(w, size), central = w.central();
    central.catchUp({by: w.centralBy, now: at(10)});
    const e = s.ex.finance, keys = Object.keys(e).sort();
    const code = keys.filter(k => /commit|code|extractor|contract_version|release/i.test(k));
    const ahead = resign({...e, previous: tail(central, 'finance').id, nodes: [...e.nodes, {node: 'finance/systems/frobnicator/new-type', domain: 'systems', type: 'frobnicator', access: 'public', version: e.version, references: []}]},
      w.keys.finance['graph-export']);
    const o = central.offer('finance', [ahead]);
    return {export_fields: keys, contract: e.contract, contract_version_named: JSON.stringify(Object.fromEntries(keys.filter(k => k !== 'nodes' && k !== 'relationships').map(k => [k, e[k]]))).includes(CONTRACT_VERSION),
      code_fields: code, newer_type_export: {stored: o.stored.length, refused: o.refused.map(r => `${r.code}: ${r.why.slice(0, 120)}`)}};
  });
}

// ---- facts of this repository at the commit -----------------------------------------------------------------------------------
/** The code facts the determination cites, each located at `file:line` in the commit's tree, or a GAP when absent. */
export const CODE_FACTS = Object.freeze([
  ['central-options-override', 'packages/graph/federation.mjs', /graph = openGraph\(\{dir: path\.join\(dir, 'ledger'\), anchor, origins, sources: names\.map\(adapter\), instance, lockTimeoutMs, lockStaleMs, \.\.\.opts\}\)/, 'openCentral spreads its caller\'s options after its origin registry and sources (R6)'],
  ['central-name-distinct', 'packages/graph/federation.mjs', /n === instance\) fail/, 'openCentral refuses a department named as the central (R6)'],
  ['central-write-boundary', 'packages/graph/federation.mjs', /the central never writes a department's graph/, 'the central\'s write boundary (R1, R7)'],
  ['offer-fork-only', 'packages/graph/federation.mjs', /const fork = no \? null : inbox\.next\(inst, e\.previous\)/, 'offer refuses only a second export after the same predecessor: no tail or seq check (R5, KG-14)'],
  ['export-contract-id', 'packages/graph/federation.mjs', /const body = \{schema: EXPORT_SCHEMA, contract: GRAPH_SCHEMA,/, 'an export names the contract id, not its version or the code (R11)'],
  ['export-refusal-contract', 'packages/graph/federation.mjs', /e\.contract !== GRAPH_SCHEMA/, 'the hub checks the contract id only (R11)'],
  ['source-nodes-never-exported', 'packages/graph/federation.mjs', /a source node commits to its whole source: never exported/, 'source nodes (and their extractor versions) never leave a department (R11)'],
  ['notice-recorded-restricted', 'packages/graph/federation.mjs', /scope: \{access: 'restricted', owner: me\.instance\},/, 'a received notice is the department\'s own restricted observation (R7, R12)'],
  ['intake-sources', 'ophanim/operate/work-ledger.mjs', /export const INTAKE_SOURCES = Object\.freeze\(\['status', 'issue', 'ticket', 'prompt'\]\)/, 'work enters a work ledger only from a status item, an issue, a ticket or an owner-authorized prompt (R7)'],
  ['status-authors', 'packages/ledger/status.mjs', /authors: a => operators\.includes\(a\.key_id\)/, 'a status entry is signed by the ledger\'s own operators (R7)'],
  ['status-anchor-pinned', 'ophanim/graph/extract/ledgers.mjs', /export const STATUS_ANCHOR = 'sha256:/, 'the graph pins THIS instance\'s status ledger anchor in code (R9)'],
  ['graph-cli-status-root', 'ophanim/graph/cli.mjs', /status: \{root: path\.join\(repo, 'status\/ledger'\)\}/, 'the graph CLI reads status/ledger in the checkout, against the pinned anchor (R9)'],
  ['operate-status-default', 'ophanim/operate/cli.mjs', /env\.OPHANIM_STATUS_LEDGER \?\? path\.join\(repo, 'status', 'ledger'\)/, 'the loop\'s status ledger defaults to the checkout\'s status/ledger (R9)'],
  ['operate-work-default', 'ophanim/operate/cli.mjs', /env\.OPHANIM_WORK_LEDGER \?\? path\.join\(repo, 'status', 'work'\)/, 'the work ledger defaults into the checkout (R9)'],
  ['cycle-default', 'pantheon/bin/pantheon-review-cycle.mjs', /'pantheon-cycles'\)\)/, 'the review-cycle ledger defaults under the git COMMON directory, shared by every worktree of a clone (R9)'],
  ['pantheon-home-default', 'pantheon/src/seat/store.mjs', /env\.PANTHEON_HOME \|\| join\(homedir\(\), "\.pantheon"\)/, 'seat records default to ~/.pantheon, shared by every instance of a user (R9)'],
  ['run-ledger-anchor-env', 'ophanim/ledger/system.mjs', /anchor = process\.env\.OPHANIM_LEDGER_ANCHOR \?\? null/, 'the run ledger\'s expected anchor comes from the environment (R9)'],
  ['seats-are-code', 'pantheon/src/route/fit-matrix.mjs', /export const FIT_MATRIX = freeze\(/, 'the seats are a code table at the commit, not per-instance config (R9, R11)'],
  ['graph-key-ids', 'ophanim/graph/extract/index.mjs', /generateSigner\('graph-operator'\)/, 'the graph\'s key ids are fixed names; only their material tells instances apart (R10)'],
  ['snapshot-binds-contract', 'packages/graph/checkpoint.mjs', /contract: contractOf\(\),/, 'a snapshot is bound to its writer\'s contract and extractors, per instance (R4, R11)'],
]);
/** Locate each code fact in the commit's tree: {id, what, at: file:line, text} or {id, what, gap}. */
export function codeFacts(repo, commit) {
  return CODE_FACTS.map(([id, file, re, what]) => {
    let text = null;
    try { text = execFileSync('git', ['-C', repo, 'show', `${commit}:${file}`], {encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore']}); } catch {}
    const lines = text?.split('\n') ?? [], i = lines.findIndex(l => re.test(l));
    return i < 0 ? {id, what, gap: `${file}: not found at ${commit.slice(0, 7)}`} : {id, what, at: `${file}:${i + 1}`, text: lines[i].trim().slice(0, 180)};
  });
}

const REGISTER_ENTRIES = ['KG-3', 'KG-4', 'KG-8', 'KG-9', 'KG-13', 'KG-14'];
/** From the built graph of this repository: its size, the register's entries (records source), state paths, and OPHANIM's own facts as a department. */
export function repositoryFacts(built, repo) {
  const view = built.graph.view(), stats = view.stats();
  // The register's entries as the records source states them (graph ids), each located by the source's own parser at the commit.
  const reg = treeAt(repo, built.commit).entries.find(e => e.path === REGISTER);
  const parsed = reg ? registerEntries(blobsAt(repo, [reg.blob]).get(reg.blob).toString('utf8')) : new Map();
  const register = Object.fromEntries(REGISTER_ENTRIES.map(id => {
    const n = view.nodeIn(recordId(id), 'established') ? view.node(recordId(id)).attributes : null;
    return [id, n ? {status: n.status, at: parsed.has(id) ? `${REGISTER}:${parsed.get(id).line}` : null, graph_id: recordId(id)} : {gap: `${id} is not an entry of the register in the graph at ${built.commit.slice(0, 7)}`}];
  }));
  // The owner's pending decisions: KG-4's full row.
  const row = parsed.get('KG-4') ?? null;
  const pick = re => (row ? (re.exec(row.text)?.[1] ?? null) : null);
  const decisions = {at: row ? `${REGISTER}:${row.line}` : null, slice_e: pick(/Slice E: (.*?)\. Slice C1:/), reserved: pick(/Reserved to the owner: (.*?)\. \|/), slice_a: pick(/Slice A: (.*?)\. Slice E:/)};
  // State an instance keeps, as the graph states it: variables the run-time code reads to locate a ledger, a home or keys.
  const state = [];
  for (const id of view.subjects()) {
    if (id.includes('(') || !id.includes('/systems/environment-variable/')) continue;
    const name = decodeURIComponent(parseId(id).key);
    if (!/(LEDGER|_HOME|STORE|KEYS|ANCHOR|STATE)/.test(name)) continue;
    const readers = view.edgesOf(id, {mode: 'possible', types: ['consumes']}).filter(e => e.to === id).map(e => ({e, a: view.assertion(e.assertions[0])?.record.attributes ?? {}})).filter(x => x.a.need === 'run-time');
    if (readers.length) state.push({name, runtime_readers: readers.length, e_g: `${decodeURIComponent(parseId(readers[0].e.from).key)}:${readers[0].a.lines?.[0] ?? '?'}`});
  }
  state.sort((a, b) => byString(a.name, b.name));
  const tracked = view.subjects().filter(id => !id.includes('(') && id.includes('/systems/file/') && decodeURIComponent(parseId(id).key).startsWith('status/ledger/')).length;
  // Replication as a capability the code exports: any run-time symbol named for it (this assessment's own files aside).
  const named = view.subjects().filter(id => id.includes('/systems/symbol/') && !id.includes('(')).map(id => decodeURIComponent(parseId(id).key))
    .filter(k => /#(replicat|instantiat|provision|createInstance|newInstance|spawnInstance|createDepartment)/i.test(k) && !/(^|\/)(fixtures?|tests?)\//.test(k) && !k.startsWith('ophanim/graph/hub')).sort();
  return {commit: built.commit, stats, register, decisions, state: cap(state), tracked_state: {status_ledger_files: tracked,
    lessons_registry: view.nodeIn(fileId('ophanim/lessons/corrections.json'), 'established') ? 'ophanim/lessons/corrections.json (a tracked file: a lesson is a code change)' : null,
    status_anchor_symbol: view.nodeIn(symbolId('ophanim/graph/extract/ledgers.mjs', 'STATUS_ANCHOR'), 'established') ? symbolId('ophanim/graph/extract/ledgers.mjs', 'STATUS_ANCHOR') : null},
  replication_symbols: named};
}

/** R6 on real data: OPHANIM's own systems graph exported as a department under the same policy as every spoke. */
export function ownGraphAsDepartment(built) {
  const dir = tmp('ophanim-hub-own-');
  try {
    const dept = department({graph: built.graph, policy: POLICY, secret: randomBytes(32), signer: generateSigner('graph-export'), outbox: path.join(dir, 'outbox'),
      hub: {instance: CENTRAL, anchor: 'sha256:' + '1'.repeat(64), keys: {}}});
    const t = timed(() => attempt(() => dept.exportAt(undefined, {exported_at: at(0)})));
    if (!t.value.ok) return {exported: false, refusal: t.value.why, code: t.value.code, ms: t.ms};
    const e = t.value.value, access = {};
    for (const n of e.nodes) access[n.access] = (access[n.access] ?? 0) + 1;
    return {exported: true, instance: e.instance, nodes: e.nodes.length, relationships: e.relationships.length, withheld: e.withheld, access, with_details: e.nodes.filter(n => n.details).length,
      bytes: Buffer.byteLength(JSON.stringify(e)), ms: t.ms};
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

// ---- the criteria ---------------------------------------------------------------------------------------------------------------
const fact = (facts, id) => facts.find(f => f.id === id) ?? {id, gap: 'not located'};
const where = (facts, ...ids) => ids.map(id => { const f = fact(facts, id); return f.at ? `${f.at} (${f.what})` : `GAP ${id}: ${f.gap}`; });

/** The twelve criteria from the measurements. */
export function criteria({scales, freshness, ingestion, learning, dual, governance, replication, lineage, repo: rf, own, facts}) {
  const x1 = scales.find(s => s.scale === 1) ?? scales[0];
  const out = [];
  // R1
  const r1ok = scales.every(s => !s.run.error && s.run.r1.found.restricted + s.run.r1.found.internal + s.run.r1.found.other === 0 && s.run.r1.restricted_ids_disclosed_by_owner.total === 0 && s.run.r1.ledgers_unchanged.all)
    && governance.central_writes_department.refused;
  out.push(criterion('R1', 'Authority: the hub never writes a department\'s ledger and holds no withheld value', r1ok ? 'pass' : 'fail', {blocking: true,
    measured: {by_scale: scales.map(s => ({scale: s.scale, ...(s.run.error ? {error: s.run.error} : {planted: s.run.r1.planted, found: {restricted: s.run.r1.found.restricted, internal: s.run.r1.found.internal, other: s.run.r1.found.other},
      restricted_ids_disclosed_by_owner: s.run.r1.restricted_ids_disclosed_by_owner.total, restricted_ids_named_by_a_referrer: s.run.r1.restricted_ids_named_by_a_referrer.total,
      searched: {files: s.run.r1.files, bytes: s.run.r1.bytes}, ledgers_unchanged: s.run.r1.ledgers_unchanged})})),
    central_write_into_department: governance.central_writes_department},
    facts: where(facts, 'central-write-boundary'), register: ['KG-3 (scope enforced, synthetic)'],
    condition: 'the hub must hold no withheld value and never change a department ledger'}));
  // R2
  const r2ok = scales.every(s => !s.run.error && s.run.r2.linked_exactly_the_permitted && s.run.r2.provenance && !s.run.r2.forbidden_linked.length && s.run.r2.transitive.reaches.length === 3);
  out.push(criterion('R2', 'The collective graph: cross-department dependencies discovered with provenance, nothing forbidden linked', r2ok ? 'pass' : 'fail', {blocking: true,
    measured: {by_scale: scales.map(s => ({scale: s.scale, ...(s.run.error ? {error: s.run.error} : {links: s.run.r2.links.map(l => ({link: l.link, established: l.established, inputs: l.inputs, reference: l.reference})),
      forbidden_linked: s.run.r2.forbidden_linked, unresolved: s.run.r2.unresolved, withheld_references: s.run.r2.withheld_references, transitive: s.run.r2.transitive, central: s.run.r2.central})}))},
    condition: 'the linker must discover exactly the permitted dependencies'}));
  // R3
  const f = freshness;
  const r3ok = f.disconnected.state === 'stale' && f.disconnected.reasons.some(r => /unreachable/.test(r)) && f.disconnected.stale_links.length > 0 && !f.disconnected.link_of_others_stale
    && f.independent.every(d => d.published && d.answered && d.hub_reachable === false) && f.catch_up.every(c => c.in_order && c.imported_now === c.expected_now && c.duplicates === 0 && c.chain_equals_outbox)
    && f.repeat.imported === 0 && f.repeat.notices === 0 && f.all_current_after;
  out.push(criterion('R3', 'Freshness and recovery', r3ok ? 'pass' : 'fail', {blocking: true, measured: f,
    condition: 'a disconnected department must read stale and catch-up must go by version, once'}));
  // R4
  const opened = s => ({scale: s.scale, central_facts: s.run.r2?.central?.assertions ?? null, full_open_ms: s.run.opens?.find(o => o.mode === 'full')?.ms ?? null,
    full_open_rss_mb: s.run.opens?.find(o => o.mode === 'full')?.rss_mb ?? null,
    snapshot_open_ms: s.run.opens?.filter(o => o.mode === 'snapshot').map(o => o.ms) ?? [], snapshot_used: s.run.opens?.filter(o => o.mode === 'snapshot').every(o => o.snapshot?.used === true) ?? false,
    snapshot_bytes: s.run.snapshot?.bytes ?? null, first_catch_up_ms: s.run.first?.catch_up_ms ?? null, hub_process_rss_mb: s.run.first?.rss_mb ?? null, hub_as_built_snapshot: s.run.r1?.hub_as_built_snapshot ?? null});
  const r4 = scales.filter(s => !s.run.error).map(opened), r4x1 = r4.find(r => r.scale === x1.scale);
  const asBuiltFits = r4x1 && r4x1.full_open_ms !== null && r4x1.full_open_ms <= 1000;
  const snapFits = r4x1 && r4x1.snapshot_used && median(r4x1.snapshot_open_ms) <= 1000;
  out.push(criterion('R4', 'Hub cost: central open time and memory', asBuiltFits ? 'pass' : snapFits ? 'gap' : 'fail', {blocking: false, measured: {by_scale: r4, as_built: 'openCentral opens in full: nothing in the tree writes or passes a central snapshot'},
    facts: where(facts, 'central-options-override', 'snapshot-binds-contract'), register: ['KG-9'],
    condition: (snapFits ? 'wire the signed checkpoint into the hub (write a central snapshot after each catch-up, open from it under a pinned key: the 1 s per tick holds only from a snapshot)'
      : 'the central open exceeds 1 s per tick even from a snapshot: a smaller projection or per-department segments before production')
      + r4.filter(r => r.scale > x1.scale && median(r.snapshot_open_ms) > 1000).map(r => `; at x${r.scale} (${r.central_facts} facts) even the snapshot open takes ${median(r.snapshot_open_ms)} ms: compaction per department (KG-9) before the departments grow`).join('')}));
  // R5
  const g = ingestion, accepted = ['splice', 'fork', 'rollback', 'spoof_other_anchor', 'spoof_unpinned_key', 'genesis_spoof'].filter(k => g[k]?.accepted);
  out.push(criterion('R5', 'Ingestion integrity: spliced, forked, rolled-back and spoofed chains', accepted.length ? 'fail' : g.value_leak.restricted_value_in_hub ? 'condition' : 'pass', {blocking: true,
    measured: g, facts: where(facts, 'offer-fork-only'), register: ['KG-14 (HIGH)', 'KG-8', ...(g.rollback.accepted ? ['UNREGISTERED: a chained export whose seq is below its predecessor\'s is imported (the hub\'s projection rolls back)'] : [])],
    condition: `the hub must refuse ${accepted.join(', ') || 'nothing'}: offer() to require that previous is the stored chain tail and seq strictly increases (KG-14, and the rollback), and an identity that a re-created ledger cannot share (KG-8); packages/graph/federation.mjs is the coordinator's`}));
  // R6
  const d6 = dual, enforced = d6.department_named_as_the_central.refused && !d6.hub_own_fact_without_export.recorded;
  out.push(criterion('R6', 'The hub\'s dual role: pure hub (a) or hub and Technology (b)', enforced ? 'pass' : 'condition', {blocking: false,
    measured: {...d6, ophanim_own_graph_as_a_department: own},
    facts: where(facts, 'central-name-distinct', 'central-options-override', 'central-write-boundary'),
    condition: 'shape (a): the hub is a PURE hub (its namespace holds imports and derived links only) and Technology is a replica like the others; the code does not enforce it (openCentral lets a caller add an origin and record the hub\'s own facts, unfiltered by any policy), so it must be a deployment rule until a guard exists'}));
  // R7
  const gv = governance, pending = /pending owner/i.test(rf.register['KG-4']?.status ?? '');
  const r7ok = gv.central_writes_department.refused && gv.hub_signed_status_in_replica.refused && gv.federation_intake_in_replica.refused && !gv.keys.department_keyrings_hold_a_central_key;
  out.push(criterion('R7', 'Governance: no dispatch into a department; the owner\'s decisions', !r7ok ? 'fail' : pending ? 'condition' : 'pass', {blocking: true,
    measured: {...gv, owner_decisions: rf.decisions, kg4_status: rf.register['KG-4']},
    facts: where(facts, 'intake-sources', 'status-authors', 'notice-recorded-restricted', 'central-write-boundary'), register: ['KG-4 (pending owner)'],
    condition: 'the owner decides (KG-4): key custody for every department and the hub (export keys, placeholder secrets, receiver keys, the central\'s import, link, notice and snapshot keys, their rotation), the production access policy, where instances run and their transports, freshness bounds and cadence, which instances federate; and whether work may ever cross (today it cannot: a department\'s work comes only from its own owner-signed status ledger)'}));
  // R8
  const r8 = scales.filter(s => !s.run.error).map(s => {
    const catchUp = median(s.run.ticks.map(t => t.catch_up_ms)), o = opened(s);
    return {scale: s.scale, incremental_catch_up_ms: s.run.ticks.map(t => t.catch_up_ms), notices_per_tick: s.run.ticks.map(t => t.notices),
      department_export_ms: s.run.ticks.map(t => t.department_export_ms),
      per_tick_as_built_ms: o.full_open_ms === null || catchUp === null ? null : Math.round(o.full_open_ms + catchUp),
      per_tick_with_snapshot_ms: !o.snapshot_open_ms.length || catchUp === null ? null : Math.round(median(o.snapshot_open_ms) + catchUp)};
  });
  const r8x1 = r8.find(r => r.scale === x1.scale);
  out.push(criterion('R8', 'Load: what the collective graph adds to each tick', r8x1?.per_tick_as_built_ms <= 1000 ? 'pass' : r8x1?.per_tick_with_snapshot_ms <= 1000 ? 'condition' : 'fail', {blocking: false,
    measured: {by_scale: r8, already: 'KG-13: the loop\'s own graph adds 1.3-1.6 s a tick; the self-repair lane is not measured here'}, register: ['KG-13', 'KG-8 (propagation recomputes every import event)'],
    condition: `run the hub's catch-up off the foundry tick (its own schedule), from a snapshot, with exports that carry changes rather than whole projections and a propagation cursor (KG-8), and budget it before the self-repair lane joins the same machine${r8x1 ? ` (measured at x1: ${r8x1.per_tick_with_snapshot_ms} ms a tick from a snapshot, ${r8x1.per_tick_as_built_ms} ms as built)` : ''}`}));
  // R9
  const rp = replication, gaps9 = where(facts, 'status-anchor-pinned', 'graph-cli-status-root', 'operate-status-default', 'operate-work-default', 'cycle-default', 'pantheon-home-default', 'run-ledger-anchor-env', 'seats-are-code');
  out.push(criterion('R9', 'Replication: a departmental instance from the code at a commit', rp.fresh.distinct === rp.fresh.anchors && rp.fresh.roots_disjoint && rf.replication_symbols.length ? 'pass' : 'gap', {blocking: false,
    measured: {made: rp.replicas, fresh: rp.fresh, replication_symbols_in_the_code: rf.replication_symbols, state_variables: rf.state, tracked_state: rf.tracked_state},
    facts: gaps9,
    condition: 'one replicate command (a function and a CLI) that composes the existing creators into a fresh instance with no default pointing into the checkout, ~/.pantheon or the git common directory, the status anchor passed in rather than pinned in code, and its keys generated at creation; today each ledger is created by its own module and nothing composes them'}));
  // R10
  const twinsSame = Object.entries(rp.template.same_anchor_by_ledger).filter(([, v]) => v).map(([k]) => k);
  const r10fail = twinsSame.length > 0 || rp.impersonation.finance_key_signs_as_compliance.imported > 0;
  out.push(criterion('R10', 'Identity under replication', r10fail ? 'fail' : 'pass', {blocking: true,
    measured: {fresh_replicas: rp.fresh, template_replicas_share_anchor: rp.template.same_anchor_by_ledger, at_the_hub: {identical_authority: rp.impersonation, separate_keys: rp.separate}},
    facts: where(facts, 'graph-key-ids'), register: ['KG-8'],
    condition: 'replication is unsafe until KG-8 is fixed: a genesis must carry what makes an instance unique (a nonce or the instance name), and every replica must generate its own keys at creation; the hub must pin keys per department that no other department holds'}));
  // R11
  const ln = lineage;
  out.push(criterion('R11', 'Code lineage: what stays replica-local, where code repairs land', ln.code_fields.length && ln.contract_version_named ? 'condition' : 'gap', {blocking: false,
    measured: {...ln, replica_local: ['its status, work, cycle, run and graph ledgers and their keys (state_variables)', 'PANTHEON_HOME', 'its billing setting', 'its domain sources'],
      code_line: ['the code, including the seats (fit-matrix.mjs) and the lessons registry (ophanim/lessons/corrections.json, tracked)', 'self-repair commits: on the hub\'s line, then each replica upgrades to a commit by version']},
    facts: where(facts, 'export-contract-id', 'export-refusal-contract', 'source-nodes-never-exported', 'snapshot-binds-contract', 'seats-are-code'),
    condition: 'exports must name the code that made them (commit and contract version) and the hub must refuse or label a replica behind it; code repairs land on the hub\'s line only, and a replica upgrades by version (hub first: an export with a type the hub\'s contract lacks is refused whole); federation carries graph facts, never code'}));
  // R12
  const lr = learning, defectOk = lr.defect.notices.finance > 0 && lr.defect.notices.compliance > 0 && lr.defect.notices.technology === 0
    && Object.values(lr.defect.provenance).flat().every(p => p.origin === 'technology' && p.export && p.entries && p.via === CENTRAL)
    && ['finance', 'compliance'].every(d => lr.defect.received[d].recorded > 0 && lr.defect.received[d].ledger_verifies) && lr.defect.ledger_files_copied_to_hub === 0;
  out.push(criterion('R12', 'Collective learning through the hub', !defectOk ? 'fail' : lr.lesson.linked ? 'pass' : 'condition', {blocking: false, measured: lr,
    facts: where(facts, 'notice-recorded-restricted'),
    condition: 'a defect in a shared dependency propagates, transitively, with provenance; a LESSON (learning/failure-class applies-to) does not cross under the coordinator\'s test policy: the owner\'s production policy must permit applies-to (it is admissible), or lessons stay local'}));
  return out;
}

// ---- the whole determination -----------------------------------------------------------------------------------------------------
/**
 * The determination. `built`: the graph of `repo` at its commit; `scales`: department sizes as multiples of OPHANIM's
 * measured graph (each run in its own process). Returns {schema, question, commit, sizing, criteria, verdict, ...}.
 */
export function hubReadiness({built, repo, scales = [1, 4], rounds = 2, opens = 2, heapMb = 8192}) {
  const t0 = process.hrtime.bigint();
  const rf = repositoryFacts(built, repo), facts = codeFacts(repo, built.commit);
  const sizeOf = k => ({entities: Math.max(8, Math.round(rf.stats.entities * k)), relationships: Math.max(8, Math.round(rf.stats.relationships * k))});
  const runs = scales.map(scale => {
    const root = tmp('ophanim-hub-scale-'), size = sizeOf(scale);
    try {
      const args = [`--max-old-space-size=${heapMb}`, CHILD, 'scale', root, JSON.stringify({size, rounds, opens, openArgs: [`--max-old-space-size=${heapMb}`]})];
      const t = process.hrtime.bigint();
      const r = spawnSync(process.execPath, args, {encoding: 'utf8', maxBuffer: 1 << 28});
      const run = r.status === 0 ? JSON.parse(r.stdout.trim().split('\n').at(-1)) : {error: `exit ${r.status}: ${(r.stderr || r.stdout).slice(-600)}`};
      return {scale, size, wall_ms: ms(t), run};
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
  });
  const behaviour = {freshness: freshnessRun(), ingestion: ingestionRun(), learning: learningRun(), dual: dualRoleRun(), governance: governanceRun(),
    replication: replicationRun({commit: built.commit}), lineage: lineageRun()};
  const own = ownGraphAsDepartment(built);
  const rows = criteria({scales: runs, ...behaviour, repo: rf, own, facts});
  return {schema: HUB_SCHEMA, question: QUESTION, commit: built.commit, advisory: 'measured on a SYNTHETIC federation; nothing is split, federated or changed',
    sizing: {measured: rf.stats, per_department: Object.fromEntries(scales.map(k => [`x${k}`, sizeOf(k)])), behavioural: SMALL,
      access_mix: 'entities: 1 in 10 restricted, 4 in 10 internal, the rest public; relationships: 1 in 10 restricted, 3 in 10 internal; 1 in 25 a mentions'},
    criteria: rows, verdict: verdict(rows), register: rf.register, code_facts: facts, scale_runs: runs.map(r => ({scale: r.scale, size: r.size, wall_ms: r.wall_ms, error: r.run.error ?? null,
      seed: r.run.seed ?? null, first: r.run.first ?? null, ticks: r.run.ticks ?? null, opens: r.run.opens ?? null, snapshot: r.run.snapshot ?? null})),
    ms: ms(t0), note: 'static imports and synthetic departments are not runtime coupling or real departmental data; a measured hole is reported with its register entry, never fixed here'};
}
