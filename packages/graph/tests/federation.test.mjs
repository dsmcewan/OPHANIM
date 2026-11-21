// Federation (Slice E; the directive's section 6 and demonstration 10). A SYNTHETIC demonstration (KE7): two
// departmental instances, Finance and Technology, and a central instance, each on its own real packages/ledger chain
// with synthetic keys (federation-fixture.mjs). Every value a policy withholds is a synthetic sentinel, and the
// disclosure tests search the serialized exports, notices and the central's files for each of them, for their source
// references and for the digests that would reveal them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash, createPrivateKey, sign} from 'node:crypto';
import {canonical, digest} from '../../ledger/canonical.mjs';
import {generateSigner} from '../../ledger/chain.mjs';
import {assertion, closure, createGraphLedger, decodeKey, definePolicy, department, versionOf, LINKER, REFERENCES, WITHHELD} from '../index.mjs';
import {federation, worldOf, financeSnapshot, technologySnapshot, POLICY, F, TECH, SECRET, T0, at, filesUnder, CENTRAL} from './federation-fixture.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'federation-child.mjs');
const H = value => 'sha256:' + digest(value);
const refusedAs = (fn, code, re) => assert.throws(fn, e => e.code === code && re.test(e.message), `${code} ${re}`);
const linkSubject = (from, to, type = 'depends-on') => `${type}(${from} -> ${to})`;
/** A tool's observation in a department (observed, with its run). */
const toolRecord = (inst, over) => assertion({origin: `${inst}.tool`, classification: 'observed', run: {id: `${inst}-run-1`}, observed_at: T0,
  source: {id: `${inst}.runs`, authority: 'synthetic measurement runs', ref: `${inst}.runs#${over.entity ?? over.type}`, version: versionOf({inst, run: 1})},
  scope: {access: 'internal', owner: inst}, ...over});
/** Re-sign an export (or a notice body) after a test alters it: the forger holds `signer`. */
function resign(e, signer) {
  const {id, signature, ...body} = e, nid = H(body);
  return {...body, id: nid, signature: {key_id: signer.key_id, sig: sign(null, Buffer.from(canonical({...body, id: nid})), createPrivateKey(signer.privatePem)).toString('base64')}};
}

/**
 * The demonstration's starting point: Technology observes its systems and measures its API; Finance references
 * Technology's payments API at the version Technology exported; both publish; the central catches up once.
 */
function linked(t, o = {}) {
  const w = federation(t, o);
  const tech = w.open('technology'), fin = w.open('finance');
  w.publishSource('technology', technologySnapshot());
  tech.observe(0);
  const sla = toolRecord('technology', {entity: TECH.sla, attributes: {p99: SECRET.slaP99}});
  const verifies = toolRecord('technology', {type: 'verifies', from: TECH.sla, to: TECH.api});
  tech.dept.assert([sla, verifies], w.by('technology', 'tool'));
  const tv1 = tech.publish(1).export;
  const ref = {instance: 'technology', anchor: w.anchors.technology, node: TECH.api, version: tv1.nodes.find(n => n.node === TECH.api).version};
  w.publishSource('finance', financeSnapshot(ref));
  fin.observe(2);
  const fv1 = fin.publish(3).export;
  const central = w.central();
  const c1 = central.catchUp({by: w.centralBy, now: at(4)});
  return {w, tech, fin, central, tv1, fv1, ref, sla, verifies, c1};
}

/** Everything a department withholds under POLICY, as the strings that must never leave it. */
function withheldNeedles(dept, secret) {
  const v = dept.graph.view(), out = new Set([secret.toString('hex')]);
  const strings = x => (typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(strings) : x && typeof x === 'object' ? Object.values(x).flatMap(strings) : []);
  for (const s of v.subjects()) for (const a of v.query(s, 'established')) {
    const r = v.assertion(a.id).record;
    if (r.kind === 'entity' && r.subject.includes('/evidence/source/')) { out.add(r.source.version); if (r.attributes.digest) out.add(r.attributes.digest); continue; }
    if (r.classification === 'authoritative') out.add(r.source.version);                 // the digest of the whole source
    if (r.scope.access === 'public') continue;
    const {[REFERENCES]: _refs, ...attrs} = r.attributes;
    for (const x of strings(attrs)) out.add(x);
    out.add(r.source.ref); out.add(r.id); out.add(hexOf(r.id));
    if (Object.keys(attrs).length) { out.add(versionOf(attrs)); out.add(digest(attrs)); out.add(versionOf(r.attributes)); }
    if (r.scope.access === 'restricted' && r.kind === 'entity') {
      for (const x of [r.subject, decodeKey(r.subject)]) { out.add(x); out.add(digest(x)); out.add(versionOf(x)); out.add(createHash('sha256').update(x).digest('hex')); }
    }
  }
  return [...out].filter(x => typeof x === 'string' && x.length >= 8);
}
const hexOf = ref => ref.slice('sha256:'.length);

test('demonstration 10: two departments expose permitted relationships to a central instance, which discovers the cross-department dependency (synthetic)', t => {
  const {w, tech, fin, central, tv1, fv1, ref, c1} = linked(t);
  // Three instances: three ledgers, three anchors, three namespaces.
  assert.deepEqual([fin.dept.identity, tech.dept.identity, central.identity].map(x => x.instance), ['finance', 'technology', CENTRAL]);
  assert.deepEqual([fin.dept.identity.anchor, tech.dept.identity.anchor, central.identity.anchor], [w.anchors.finance, w.anchors.technology, w.anchors.central]);
  assert.equal(new Set(Object.values(w.anchors)).size, 3);
  // An export is signed, versioned by its ledger head, and addressed to the hub.
  assert.deepEqual([fv1.version, fv1.seq, fv1.audience], [fin.graph.view().head, fin.graph.projection.seq, {instance: CENTRAL, anchor: w.anchors.central}]);
  assert.equal(fv1.signature.key_id, 'finance-export');
  // Permitted relationships: public with details, internal as a reference, a placeholder where an endpoint is restricted.
  const node = (e, id) => e.nodes.find(n => n.node === id), rel = (e, type, from) => e.relationships.find(r => r.type === type && r.from === from);
  assert.deepEqual(node(fv1, F.recon).details.attributes, {cadence: 'daily', note: WITHHELD}, 'public, with its details; the text naming a restricted node scrubbed');
  assert.deepEqual(node(fv1, F.run), {node: F.run, domain: 'systems', type: 'process', access: 'internal', version: node(fv1, F.run).version, references: [{type: 'depends-on', to: ref}]},
    'internal: a reference, its type and its permitted references, no details');
  assert.deepEqual(rel(fv1, 'depends-on', F.recon).details.attributes, {why: 'settles the payment run'});
  assert.equal(Object.hasOwn(rel(fv1, 'produces', F.run), 'details'), false);
  assert.match(rel(fv1, 'consumes', F.run).to.placeholder, /^placeholder:[0-9a-f]{64}$/);
  assert.deepEqual([fv1.nodes.some(n => n.node === F.payroll), fv1.withheld], [false, {nodes: 1, relationships: 2, references: 0}],
    'the restricted node is counted, never listed; the restricted relationship and the unpermitted one are counted');
  // The central imported both, read only, and derived the cross-department dependency from the reference.
  assert.deepEqual(c1.imported, {finance: [fv1.id], technology: [tv1.id]});
  const d = central.dependencies({now: at(5)});
  assert.deepEqual(d.links.map(l => [l.type, l.from, l.to, l.from_instance, l.to_instance, l.established, l.stale]),
    [['depends-on', F.run, TECH.api, 'finance', 'technology', true, false]]);
  assert.deepEqual([d.links[0].reference, d.unresolved, d.stale], [ref, [], []]);
  assert.deepEqual(Object.values(d.freshness).map(f => [f.instance, f.state]), [['finance', 'current'], ['technology', 'current']]);
  assert.deepEqual(d.withheld.map(x => [x.node, x.type, x.direction]).sort(), [[F.run, 'consumes', 'out'], [TECH.api, 'depends-on', 'out']].sort(),
    'the withheld endpoints are visible as such, never as nodes');
  // Transitively, over the imported relationships only: what Finance's reconciliation rests on, across the boundary...
  const up = central.closure(F.recon, {direction: 'forward', now: at(5)});
  assert.deepEqual(up.nodes.map(n => [n.id, n.instance]), [[F.recon, 'finance'], [F.run, 'finance'], [TECH.api, 'technology'], [TECH.sla, 'technology']]);
  assert.deepEqual(up.nodes.find(n => n.id === TECH.api).path.map(s => [s.type, s.from]), [['depends-on', F.recon], ['depends-on', F.run]], 'each reached node says why');
  // ...and what a change to Technology's API reaches in Finance.
  const down = central.closure(TECH.api, {direction: 'reverse', now: at(5)});
  assert.deepEqual(down.nodes.map(n => n.id).sort(), [TECH.api, TECH.v2, F.run, F.recon, F.report].sort());
  // The central holds no copy of anything withheld: not in its inbox, its ledger or its outbox.
  const everything = JSON.stringify(filesUnder(path.join(w.root, CENTRAL)));
  for (const s of [...Object.values(SECRET), F.payroll, TECH.vault]) assert.equal(everything.includes(s), false, s);
  // No permanent connectivity: with both departments off the network, the central still answers, marked stale.
  w.offline('finance'); w.offline('technology');
  central.catchUp({by: w.centralBy, now: at(6)});
  const d2 = central.dependencies({now: at(6)});
  assert.deepEqual([d2.stale, d2.links.map(l => [l.established, l.stale])], [['finance', 'technology'], [[true, true]]]);
});

test('withheld: a restricted node is never exported, and nothing the policy withholds appears in the serialized export, not even as a digest (KE3, register KG-3)', t => {
  const {w, tech, fin, central, tv1, fv1, ref} = linked(t);
  for (const [d, e, restricted] of [[fin, fv1, F.payroll], [tech, tv1, TECH.vault]]) {
    const text = JSON.stringify(e);
    const needles = withheldNeedles(d, Buffer.from(w.secrets[d.inst], 'hex'));
    assert.ok(needles.length > 20, `${d.inst}: the search covers what is withheld (${needles.length} strings)`);
    for (const x of needles) assert.equal(text.includes(x), false, `${d.inst}'s export discloses ${x}`);
    assert.equal(e.nodes.some(n => n.node === restricted), false);
    for (const n of e.nodes.filter(x => x.access !== 'public')) assert.equal(Object.hasOwn(n, 'details'), false, `${n.node}: no details`);
    for (const r of e.relationships) assert.ok([r.from, r.to].some(x => typeof x === 'string'), 'never two withheld endpoints');
  }
  // The placeholder is keyed by the department's secret: it is no digest of the node, and it is stable across exports.
  const ph = fv1.relationships.find(r => r.type === 'consumes').to.placeholder;
  for (const x of [digest(F.payroll), createHash('sha256').update(F.payroll).digest('hex'), hexOf(versionOf(F.payroll))]) assert.equal(ph.includes(x), false);
  const again = fin.publish(10, {refresh: true}).export;
  assert.equal(again.relationships.find(r => r.type === 'consumes').to.placeholder, ph);
  // A change to the restricted node changes nothing in the export: no change entry, nothing to propagate.
  const snap = financeSnapshot(ref);
  w.publishSource('finance', {...snap, entities: {...snap.entities, [F.payroll]: {access: 'restricted', attributes: {total: 'SYNTH-WITHHELD-PAYROLL-4712'}}}});
  fin.observe(11);
  const fv3 = fin.publish(12).export;
  assert.notEqual(fv3.version, again.version);
  assert.deepEqual([fv3.changes, fv3.nodes, fv3.relationships], [[], again.nodes, again.relationships]);
  assert.equal(JSON.stringify(fv3).includes('SYNTH-WITHHELD-PAYROLL-4712'), false);
  // The ceiling holds in the policy: a policy that would export more than KE3 allows is refused.
  const spec = {id: 'too-open', version: '1', access: {public: 'details', internal: 'reference', restricted: 'withhold'}, relationships: ['depends-on']};
  refusedAs(() => definePolicy({...spec, access: {...spec.access, internal: 'details'}}), 'FEDERATION_POLICY', /internal may be exported as reference or withhold/);
  refusedAs(() => definePolicy({...spec, access: {...spec.access, restricted: 'reference'}}), 'FEDERATION_POLICY', /restricted may be exported as withhold/);
  refusedAs(() => definePolicy({...spec, relationships: ['qualified-for']}), 'FEDERATION_POLICY', /cannot cross an instance boundary/);
  // A stricter policy is a policy: withholding internal nodes too leaves only the public ones and counts the rest.
  const strict = definePolicy({...spec, id: 'strict', access: {public: 'details', internal: 'withhold', restricted: 'withhold'}, relationships: ['depends-on'], placeholders: false});
  const se = department({graph: fin.graph, policy: strict, secret: null, signer: w.keys['finance-export'], outbox: path.join(w.root, 'finance', 'outbox-strict'), hub: w.hub})
    .exportAt(undefined, {exported_at: at(13)});
  assert.deepEqual([se.nodes.map(n => n.node).sort(), se.relationships], [[F.recon, F.report].sort(), []]);
  assert.equal(JSON.stringify(se).includes(F.run), false, 'the internal node, withheld, is scrubbed from the public details too');
  // And the central refuses an export that breaks the ceiling, even one the department signed.
  const leaky = resign({...fv3, previous: central.inbox.chain('finance').at(-1).id, nodes: [...fv3.nodes, {node: F.payroll, domain: 'systems', type: 'dataset', access: 'restricted', version: fv3.version, references: []}]}, w.keys['finance-export']);
  const detailed = resign({...fv3, previous: central.inbox.chain('finance').at(-1).id, nodes: fv3.nodes.map(n => (n.node === F.run ? {...n, details: {attributes: {team: SECRET.runTeam}}} : n))}, w.keys['finance-export']);
  for (const [e, re] of [[leaky, /exports the restricted node/], [detailed, /exports the details of the internal node/]]) {
    const o = central.offer('finance', [e]);
    assert.deepEqual([o.stored, o.refused.map(x => x.code)], [[], ['FEDERATION_POLICY']]);
    assert.match(o.refused[0].why, re);
  }
});

test('independence: a department keeps operating with the hub absent, and the central catches up by version on reconnection, with no duplicates and no lost updates (KE5)', t => {
  const {w, tech, fin, tv1, fv1, ref, sla, verifies} = linked(t);
  // The hub goes away entirely: its directory is gone and it cannot be reached.
  const centralDir = path.join(w.root, CENTRAL), away = path.join(w.root, 'central.away');
  fs.renameSync(centralDir, away);
  w.offline(CENTRAL);
  // Finance keeps operating: it writes (a new source version), exports, queries and replays, without the hub.
  const check = step => financeSnapshot(ref, {extra: {'finance/systems/process/close-check': {access: 'public', attributes: {step}}}});
  w.publishSource('finance', check(1));
  assert.equal(fin.observe(10).recorded, true);
  const fv2 = fin.publish(11).export;
  w.publishSource('finance', check(2));
  fin.observe(12);
  const fv3 = fin.publish(13).export;
  assert.equal(fin.publish(14).published, false, 'an unchanged state is not published again');
  assert.deepEqual([fv2.previous, fv3.previous], [fv1.id, fv2.id], 'its own outbox chains its exports');
  const digest = fin.graph.digest(), reopened = w.open('finance');
  assert.equal(reopened.graph.digest(), digest, 'a replay without the hub reproduces its projection');
  assert.deepEqual(closure(reopened.graph.view(), F.run, {direction: 'reverse'}).nodes.map(n => n.id).sort(), [F.run, F.recon, F.plan, F.report].sort(),
    'its own queries, its restricted edges included');
  const p = reopened.dept.pull({by: w.by('finance', 'receiver')});
  assert.deepEqual([p.reachable, p.received], [false, []], 'the hub being gone is reported, not an error');
  // Technology too: an incident invalidates its measurement of the API.
  tech.dept.assert([toolRecord('technology', {entity: TECH.incident, attributes: {note: SECRET.incident}, invalidates: [sla.id, verifies.id], run: {id: 'technology-run-2'}})], w.by('technology', 'tool'));
  const tv2 = tech.publish(15).export;
  // The hub returns, as another process opens it, and catches up by version.
  fs.renameSync(away, centralDir);
  w.offline(CENTRAL, false);
  const hub = w.central();
  const c = hub.catchUp({by: w.centralBy, now: at(20)});
  assert.deepEqual(c.imported, {finance: [fv2.id, fv3.id], technology: [tv2.id]}, 'every export after the last imported, in order');
  const imports = inst => hub.graph.events().events.filter(e => e.source === `federation.${inst}` && e.state === 'current').map(e => e.to_version);
  assert.deepEqual([imports('finance'), imports('technology')], [[fv1.id, fv2.id, fv3.id], [tv1.id, tv2.id]], 'one import per export, none skipped');
  assert.deepEqual(hub.graph.view().query(linkSubject(F.run, TECH.api), 'recorded').map(a => a.origin), [LINKER], 'the link derived once');
  assert.equal(hub.notices('finance').length, 1, 'the invalidation noticed once');
  // Catching up again changes nothing: no import, link or notice is repeated.
  const entries = hub.graph.ledger.read().length;
  const c2 = hub.catchUp({by: w.centralBy, now: at(30)});
  assert.deepEqual([c2.imported, c2.notices.issued, hub.graph.ledger.read().length, hub.notices('finance').length], [{finance: [], technology: []}, [], entries, 1]);
  assert.deepEqual(hub.graph.view().query(linkSubject(F.run, TECH.api), 'recorded').length, 1);
  assert.deepEqual(hub.offer('finance', fin.dept.published()).stored, [], 'offering the same exports again stores nothing');
  // Finance, back in touch, pulls the notice once.
  assert.deepEqual(reopened.dept.pull({by: w.by('finance', 'receiver'), observed_at: at(31)}).received.map(r => r.recorded), [true]);
  assert.deepEqual(reopened.dept.pull({by: w.by('finance', 'receiver'), observed_at: at(32)}).received.map(r => r.recorded), [false]);
});

test('freshness: an import older than its bound, or of an instance that cannot be reached, is stale in every central answer that uses it (KE5)', t => {
  const {w, tech, fin, central, tv1, fv1, ref} = linked(t, {maxAgeMs: 30 * 60_000});
  const f0 = central.freshness({now: at(5)});
  assert.deepEqual(Object.values(f0).map(f => [f.state, f.export, f.version, f.exported_at, f.imported_at]),
    [['current', fv1.id, fv1.version, at(3), at(4)], ['current', tv1.id, tv1.version, at(1), at(4)]], 'each import records its export, version and times');
  // Technology cannot be reached: recorded so on the central ledger, and its facts stay as last imported, marked.
  w.offline('technology');
  const c = central.catchUp({by: w.centralBy, now: at(6)});
  assert.deepEqual([c.fetched.technology.reachable, c.recorded.technology, c.fetched.finance.reachable], [false, 'unavailable', true]);
  const f1 = central.freshness({now: at(7)});
  assert.deepEqual([f1.technology.state, f1.finance.state], ['stale', 'current']);
  assert.match(f1.technology.reasons.join('; '), /unreachable/);
  // The reasons are true: an instance recorded unreachable is stale for that reason, not because its import failed to
  // re-derive (coordinator fix at integration; the agent's caveat).
  assert.deepEqual(f1.technology.reasons.filter(x => /could not be re-derived/.test(x)), [], f1.technology.reasons.join('; '));
  const d = central.dependencies({now: at(7)});
  assert.deepEqual([d.stale, d.links.map(l => l.stale)], [['technology'], [true]], 'the dependency answer says it rests on a stale import');
  const r = central.resolve(ref, {now: at(7)});
  assert.deepEqual([r.resolved, r.stale], [true, ['technology']]);
  const up = central.closure(F.recon, {direction: 'forward', now: at(7)});
  assert.deepEqual(up.nodes.map(n => [n.id, n.stale]), [[F.recon, false], [F.run, false], [TECH.api, true], [TECH.sla, true]]);
  assert.deepEqual([up.stale, up.coverage.stale_sources], [['technology'], ['federation.technology']]);
  assert.equal(w.central().freshness({now: at(7)}).technology.state, 'stale', 'another process reads it from the ledger alone');
  // Too old: Finance's export ages past its bound and is stale too, in every answer.
  const f2 = central.freshness({now: at(3 + 31)});
  assert.equal(f2.finance.state, 'stale');
  assert.match(f2.finance.reasons.join('; '), /older than its bound/);
  assert.deepEqual(central.dependencies({now: at(3 + 31)}).stale, ['finance', 'technology']);
  // Reconnected: Technology is reachable and both heartbeat; both are current again.
  w.offline('technology', false);
  tech.publish(40, {refresh: true});
  fin.publish(40, {refresh: true});
  central.catchUp({by: w.centralBy, now: at(41)});
  assert.deepEqual(Object.values(central.freshness({now: at(42)})).map(f => f.state), ['current', 'current']);
  assert.deepEqual(central.dependencies({now: at(42)}).stale, []);
});

test('propagation: an invalidation in one department reaches, through the central, the department whose permitted relationship depends on it, with its provenance (KE6)', t => {
  const {w, tech, fin, central, ref, sla, verifies} = linked(t);
  const incident = toolRecord('technology', {entity: TECH.incident, attributes: {note: SECRET.incident}, invalidates: [sla.id, verifies.id], run: {id: 'technology-run-2'}});
  const wr = tech.dept.assert([incident], w.by('technology', 'tool'));
  const tv2 = tech.publish(10).export;
  // The export says what changed, each change at its own Technology ledger entry.
  const inv = tv2.changes.filter(c => c.because === 'invalidated');
  assert.deepEqual(inv.map(c => c.subject), [{node: TECH.sla}, {relationship: {type: 'verifies', from: TECH.sla, to: TECH.api}}]);
  assert.deepEqual(inv.map(c => c.at), [{seq: wr.seq, entry: wr.hash}, {seq: wr.seq, entry: wr.hash}]);
  const c = central.catchUp({by: w.centralBy, now: at(11)});
  assert.equal(c.notices.issued.length, 1);
  assert.deepEqual(central.notices('technology'), [], 'the originating department is not sent its own change');
  const [n] = central.notices('finance');
  // Provenance: the originating instance, its anchor, its export and version, and each change's own entry.
  assert.deepEqual([n.origin.instance, n.origin.anchor, n.origin.export, n.origin.version, n.origin.seq], ['technology', w.anchors.technology, tv2.id, tv2.version, tv2.seq]);
  assert.deepEqual(n.origin.changes.map(x => [x.change, x.because, x.at.entry]), [['removed', 'invalidated', wr.hash], ['removed', 'invalidated', wr.hash]]);
  const entry = tech.graph.projection.log.find(x => x.hash === wr.hash);
  assert.deepEqual(entry.records, [incident.id], 'checked against Technology\'s own ledger: the entry that recorded the incident');
  assert.deepEqual([n.via.instance, n.via.anchor, n.to], [CENTRAL, w.anchors.central, {instance: 'finance', anchor: w.anchors.finance}]);
  assert.deepEqual(n.references, [{node: F.run, type: 'depends-on', reference: ref, counterpart: 'technology'}]);
  // Nothing withheld travels: the notice names no Technology node Finance does not itself reference.
  const text = JSON.stringify(n);
  for (const s of [TECH.sla, TECH.incident, TECH.vault, ...Object.values(SECRET)]) assert.equal(text.includes(s), false, s);
  assert.deepEqual(n.origin.changes.map(x => x.subject), [null, null]);
  // Finance pulls it and records it in its own ledger, with its own key; what it reassesses is its own neighbourhood.
  const p = fin.dept.pull({by: w.by('finance', 'receiver'), observed_at: at(12)});
  assert.deepEqual(p.received.map(r => [r.id, r.recorded, r.record.origin, r.record.scope.access]), [[n.id, true, 'federation.receiver', 'restricted']]);
  assert.equal(fin.graph.ledger.read().at(-1).author.key_id, 'finance-receiver');
  assert.deepEqual(p.received[0].affected.nodes.map(x => x.id).sort(), [F.run, F.recon, F.plan, F.report].sort());
  assert.deepEqual(fin.dept.pull({by: w.by('finance', 'receiver'), observed_at: at(13)}).received.map(r => r.recorded), [false], 'a repeat is a no-op');
  // A notice is accepted only unaltered, from the pinned hub, by its addressee.
  refusedAs(() => fin.dept.receive({...n, origin: {...n.origin, instance: 'finance'}}, {by: w.by('finance', 'receiver')}), 'FEDERATION_NOTICE', /id is not the digest/);
  const {id: _id, issued_at, signature: _sig, ...body} = n, forged = {...body, origin: {...body.origin, export: tv2.previous}};
  const fid = H(forged);
  const wrongKey = {...forged, id: fid, issued_at, signature: {key_id: 'central-notice', sig: sign(null, Buffer.from(canonical({...forged, id: fid, issued_at})), createPrivateKey(w.keys['technology-export'].privatePem)).toString('base64')}};
  refusedAs(() => fin.dept.receive(wrongKey, {by: w.by('finance', 'receiver')}), 'FEDERATION_NOTICE', /not signed by a key of the pinned hub/);
  refusedAs(() => tech.dept.receive(n, {by: w.by('technology', 'receiver')}), 'FEDERATION_NOTICE', /not addressed to this instance/);
  // In the central's projection the measurement is gone; the dependency itself stands (the API did not change).
  assert.deepEqual(central.closure(TECH.api, {direction: 'forward', now: at(12)}).nodes.map(x => x.id), [TECH.api]);
  assert.deepEqual(central.dependencies({now: at(12)}).links.map(l => l.established), [true]);
});

test('references: a wrong anchor, a missing or withheld node and a stale version leave a cross-instance reference unresolved, never guessed (KE2)', t => {
  const {w, tech, fin, central, ref} = linked(t);
  // A replaced Technology ledger: the same name with a new genesis (a new operator) is a different instance.
  const replacedDir = path.join(w.root, 'technology-replaced'), operator = generateSigner('technology-operator-2');
  fs.mkdirSync(replacedDir, {recursive: true});
  const ring = {...Object.fromEntries(Object.entries(w.keys).filter(([k]) => k.startsWith('technology-')).map(([k, s]) => [k, s.publicJwk])), [operator.key_id]: operator.publicJwk};
  const replaced = createGraphLedger({dir: replacedDir, authority: {keyring: ring, orderer: operator.key_id, operators: [operator.key_id]}, operator, order: operator});
  assert.notEqual(replaced, w.anchors.technology);
  const bad = {'wrong-anchor': {...ref, anchor: replaced}, 'missing-node': {...ref, node: 'technology/systems/service/ghost'},
    withheld: {...ref, node: TECH.vault}, 'unknown-instance': {...ref, instance: 'compliance', node: 'compliance/systems/contract/sox-404'}};
  assert.equal(central.resolve(ref, {now: at(5)}).resolved, true);
  assert.deepEqual(Object.entries(bad).map(([k, r]) => [k, central.resolve(r, {now: at(5)}).reason]),
    [['wrong-anchor', 'wrong-anchor'], ['missing-node', 'missing-node'], ['withheld', 'missing-node'], ['unknown-instance', 'unknown-instance']],
    'a withheld node is indistinguishable from a missing one');
  // Finance carrying them: the central links only the reference that resolves, and lists the others with why.
  const snap = financeSnapshot(ref);
  const refs = [ref, bad['wrong-anchor'], bad['missing-node'], bad.withheld].map(to => ({type: 'depends-on', to}));
  const withRefs = r => ({...snap, entities: {...snap.entities, [F.run]: {...snap.entities[F.run], attributes: {...snap.entities[F.run].attributes, [REFERENCES]: r}}}});
  w.publishSource('finance', withRefs(refs));
  fin.observe(10);
  fin.publish(11);
  central.catchUp({by: w.centralBy, now: at(12)});
  const d = central.dependencies({now: at(12)});
  assert.deepEqual(d.links.map(l => [l.to, l.established]), [[TECH.api, true]]);
  assert.deepEqual(d.unresolved.map(u => [u.reference.node, u.reason]).sort(), [[TECH.api, 'wrong-anchor'], [TECH.vault, 'missing-node'], ['technology/systems/service/ghost', 'missing-node']].sort());
  // A stale version: Technology changes the API; the version Finance relied on no longer resolves, and the link is stale.
  w.publishSource('technology', technologySnapshot({api: {revision: 'SYNTH-WITHHELD-REVISION-2'}}));
  tech.observe(20);
  const tv2 = tech.publish(21).export, current = tv2.nodes.find(n => n.node === TECH.api).version;
  assert.notEqual(current, ref.version);
  central.catchUp({by: w.centralBy, now: at(22)});
  const r = central.resolve(ref, {now: at(22)});
  assert.deepEqual([r.resolved, r.reason, r.current_version], [false, 'stale-version', current]);
  const d2 = central.dependencies({now: at(22)});
  assert.deepEqual(d2.links.map(l => [l.to, l.established]), [[TECH.api, false]], 'a link whose input changed is stale, not established');
  assert.ok(d2.unresolved.some(u => u.reference.node === TECH.api && u.reason === 'stale-version' && u.current_version === current));
  // Finance reassesses and pins the new version: the link is derived again, superseding the stale one, which stays in the record.
  w.publishSource('finance', withRefs([{type: 'depends-on', to: {...ref, version: current}}]));
  fin.observe(23);
  fin.publish(24);
  central.catchUp({by: w.centralBy, now: at(25)});
  const d3 = central.dependencies({now: at(25)});
  assert.deepEqual(d3.links.map(l => [l.to, l.established, l.reference.version]), [[TECH.api, true, current]]);
  assert.deepEqual(d3.unresolved, []);
  assert.deepEqual(central.graph.view().query(linkSubject(F.run, TECH.api), 'recorded').map(a => [a.current, a.retired?.how ?? null]),
    [[false, 'superseded'], [false, 'superseded'], [true, null]], 'derived again each time an input changed (the references, then the pin); every earlier link stays recorded');
  // An export from the replaced ledger is refused: it is not the pinned instance.
  const g2 = w.graphOf('technology', {dir: replacedDir, anchor: replaced});
  g2.observe('technology.systems', {signer: w.keys['technology-extractor'], order: operator, observed_at: at(30)});
  const impostor = department({graph: g2, policy: POLICY, secret: Buffer.from(w.secrets.technology, 'hex'), signer: w.keys['technology-export'],
    outbox: path.join(w.root, 'technology-replaced-outbox'), hub: w.hub}).exportAt(undefined, {exported_at: at(31), previous: tv2});
  const o = central.offer('technology', [impostor]);
  assert.deepEqual([o.stored, o.refused.map(x => x.code)], [[], ['FEDERATION_IDENTITY']]);
  assert.match(o.refused[0].why, /a renamed or replaced ledger is a different instance/);
});

test('authority: the central never writes a department\'s ledger or namespace, and a department never takes in as its own what it does not own', t => {
  const {w, tech, fin, central, ref, fv1, sla, verifies} = linked(t);
  const financeLedger = () => filesUnder(path.join(w.root, 'finance', 'ledger'));
  const before = financeLedger();
  // The central's keys cannot write Finance's ledger: no Finance origin names them, and Finance's keyring does not hold them.
  const g = w.graphOf('finance');
  refusedAs(() => g.assert([toolRecord('finance', {entity: 'finance/evidence/observation/from-central'})], {signer: w.keys['central-link'], order: w.keys['finance-operator']}),
    'GRAPH_REFUSED', /key "central-link" may not write as origin "finance.tool"/);
  // The central's write boundary: nothing in a department's namespace, nothing recorded as a department's.
  const runFact = central.graph.view().query(F.run, 'established')[0].id;
  const derived = over => assertion({origin: LINKER, classification: 'derived', inputs: [runFact], observed_at: at(5),
    source: {id: 'federation.links', authority: 'a test', ref: 'test', version: null}, scope: {access: 'internal', owner: CENTRAL}, ...over});
  refusedAs(() => central.assert([derived({entity: 'finance/evidence/conclusion/reassess-run'})], w.centralBy.link), 'FEDERATION_UNAUTHORIZED', /namespace of finance/);
  refusedAs(() => central.assert([derived({type: 'depends-on', from: F.recon, to: TECH.api, scope: {access: 'internal', owner: 'finance'}})], w.centralBy.link),
    'FEDERATION_UNAUTHORIZED', /owned by finance/);
  // Catch-up, linking and propagation leave Finance's ledger as Finance wrote it, byte for byte.
  tech.dept.assert([toolRecord('technology', {entity: TECH.incident, invalidates: [sla.id, verifies.id], run: {id: 'technology-run-2'}})], w.by('technology', 'tool'));
  tech.publish(10);
  const c = central.catchUp({by: w.centralBy, now: at(11)});
  assert.equal(c.notices.issued.length, 1);
  assert.deepEqual(financeLedger(), before);
  assert.ok(fin.graph.ledger.read().every(e => e.author.key_id.startsWith('finance-')), 'every entry of Finance\'s ledger is Finance\'s');
  // A department records only its own nodes, as its own.
  refusedAs(() => fin.dept.assert([toolRecord('finance', {entity: TECH.api})], w.by('finance', 'tool')), 'FEDERATION_UNAUTHORIZED', /is a node of technology/);
  refusedAs(() => fin.dept.assert([toolRecord('finance', {entity: 'finance/evidence/observation/x', scope: {access: 'internal', owner: 'technology'}})], w.by('finance', 'tool')),
    'FEDERATION_UNAUTHORIZED', /owned by technology/);
  refusedAs(() => fin.dept.assert([toolRecord('finance', {type: 'depends-on', from: F.run, to: TECH.api})], w.by('finance', 'tool')), 'FEDERATION_UNAUTHORIZED', /is a node of technology/);
  // The central refuses an export listing another instance's node as the exporter's own, even signed by it...
  const last = central.inbox.chain('finance').at(-1);
  const foreign = resign({...fv1, previous: last.id, nodes: [...fv1.nodes, {node: TECH.api, domain: 'systems', type: 'service', access: 'internal', version: fv1.version, references: []}]}, w.keys['finance-export']);
  const foreignChange = resign({...fv1, previous: last.id, exported_at: at(49), changes: [{subject: {node: TECH.api}, change: 'removed', because: null, at: {seq: 1, entry: fv1.version}}]}, w.keys['finance-export']);
  const o = central.offer('finance', [foreign, foreignChange]);
  assert.deepEqual([o.stored, o.refused.map(x => x.code)], [[], ['FEDERATION_FOREIGN', 'FEDERATION_FOREIGN']], 'nor a change it says another instance\'s node underwent');
  // ...and one altered after signing, signed by a key not pinned for it, or addressed to another hub.
  const altered = {...foreign, nodes: fv1.nodes, exported_at: at(50)};
  const unpinned = resign({...fv1, previous: last.id, exported_at: at(51)}, w.keys['technology-export']);
  const elsewhere = resign({...fv1, previous: last.id, exported_at: at(52), audience: {instance: 'other-hub', anchor: w.anchors.central}}, w.keys['finance-export']);
  const o2 = central.offer('finance', [altered, unpinned, elsewhere]);
  assert.deepEqual([o2.stored, o2.refused.map(x => x.code)], [[], ['FEDERATION_SIGNATURE', 'FEDERATION_SIGNATURE', 'FEDERATION_AUDIENCE']]);
  // Nor does a department launder another's node through its own source: its export refuses to present it as its own.
  const snap = financeSnapshot(ref);
  w.publishSource('finance', {...snap, entities: {...snap.entities, [TECH.api]: {access: 'public', attributes: {host: 'copied'}}}});
  fin.observe(20);
  refusedAs(() => fin.publish(21), 'FEDERATION_FOREIGN', /holds technology\/systems\/service\/payments-api, which it does not own/);
});

test('replay: the central projection is reproduced from its ledger and the exports it holds; an import whose export is gone is marked, never invented', t => {
  const {w, central} = linked(t);
  const digest = central.graph.digest();
  const again = w.central();
  assert.deepEqual([again.graph.digest(), again.graph.verification.complete, again.graph.reconcile().equal], [digest, true, true]);
  assert.deepEqual(again.dependencies({now: at(5)}).links.map(l => [l.from, l.to, l.established]), [[F.run, TECH.api, true]]);
  // The stored export of Technology is lost: replay cannot re-derive that import, so its facts are absent and it is stale.
  const [tv] = central.inbox.chain('technology');
  fs.rmSync(path.join(w.root, CENTRAL, 'inbox', 'technology', hexOf(tv.id) + '.json'));
  const lost = w.central();
  assert.equal(lost.graph.verification.complete, false);
  assert.equal(lost.graph.view().node(TECH.api).present, false, 'not invented');
  const f = lost.freshness({now: at(5)});
  assert.equal(f.technology.state, 'stale');
  assert.match(f.technology.reasons.join('; '), /could not be re-derived/);
  assert.deepEqual(lost.dependencies({now: at(5)}).links.map(l => [l.established, l.stale]), [[false, true]]);
});

const run = args => new Promise(resolve => {
  const c = spawn(process.execPath, [CHILD, ...args], {stdio: ['ignore', 'pipe', 'pipe']});
  let out = '', err = '';
  c.stdout.on('data', d => { out += d; });
  c.stderr.on('data', d => { err += d; });
  c.once('close', code => resolve({code, out, err}));
});

test('concurrency: two central processes catching up at once import each export once, derive each link once and issue each notice once', {timeout: 180_000}, async t => {
  const w = federation(t);
  const tech = w.open('technology'), fin = w.open('finance');
  w.publishSource('technology', technologySnapshot());
  tech.observe(0);
  const sla = toolRecord('technology', {entity: TECH.sla, attributes: {p99: SECRET.slaP99}}), verifies = toolRecord('technology', {type: 'verifies', from: TECH.sla, to: TECH.api});
  tech.dept.assert([sla, verifies], w.by('technology', 'tool'));
  const tv1 = tech.publish(1).export;
  const ref = {instance: 'technology', anchor: w.anchors.technology, node: TECH.api, version: tv1.nodes.find(n => n.node === TECH.api).version};
  w.publishSource('finance', financeSnapshot(ref));
  fin.observe(2);
  const fv1 = fin.publish(3).export;
  tech.dept.assert([toolRecord('technology', {entity: TECH.incident, invalidates: [sla.id, verifies.id], run: {id: 'technology-run-2'}})], w.by('technology', 'tool'));
  const tv2 = tech.publish(10).export;
  w.publishSource('finance', financeSnapshot(ref, {extra: {'finance/systems/process/close-check': {access: 'public', attributes: {step: 1}}}}));
  fin.observe(11);
  const fv2 = fin.publish(12).export;
  // Two processes open the central (it has never caught up) and catch up at the same moment.
  const children = ['a', 'b'].map(name => run(['catchup', w.root, name]));
  fs.writeFileSync(path.join(w.root, 'go'), '');
  const results = await Promise.all(children);
  for (const r of results) assert.equal(r.code, 0, r.err);
  const summaries = results.map(r => JSON.parse(r.out.trim().split('\n').at(-1)));
  const c = worldOf(w.root).central();
  assert.deepEqual([c.graph.verification.complete, c.graph.reconcile().equal], [true, true]);
  const imports = inst => c.graph.events().events.filter(e => e.source === `federation.${inst}` && e.state === 'current').map(e => e.to_version);
  assert.deepEqual([imports('finance'), imports('technology')], [[fv1.id, fv2.id], [tv1.id, tv2.id]], 'each export imported once, in order');
  assert.deepEqual(summaries.flatMap(s => [...s.imported.finance, ...s.imported.technology]).sort(), [fv1.id, fv2.id, tv1.id, tv2.id].sort(),
    'what the two processes say they imported adds up to what is there');
  assert.equal(c.graph.view().query(linkSubject(F.run, TECH.api), 'recorded').length, 1, 'the link derived once');
  assert.deepEqual([c.notices('finance').length, summaries.reduce((k, s) => k + s.issued, 0)], [1, 1], 'the notice issued once');
});
