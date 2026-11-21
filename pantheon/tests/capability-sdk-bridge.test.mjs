// REGISTER KG-23: THE FIT IMPLEMENTER ON THE ANTIGRAVITY SDK TRANSPORT IS ITS OWN EXECUTABLE CAPABILITY.
//
// Since the base's f58dfc0 the fit implementer is an Antigravity SDK session (pantheon/src/antigravity/turn.mjs, the
// bridge), whose seat reads {transport: "api", direct_api: true, session_transport: "antigravity-sdk"}. The capability
// graph had no profile for it, so the advisory recorded beside each such selection named the plain shared-API-client
// capability (api/agy_google/<model>, another runtime, another bubble) or, for gemini-4-neon, none at all. These cells
// fail on the graph before the profile (runtimes.json profiles.antigravity-sdk, serving select sdk-config-models) and on
// a capabilityOfSeat that ignores session_transport.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectSeat} from '../src/route/frontier.mjs';
import {defaultSnapshot} from '../src/capability/advisory.mjs';
import {E, capabilityKey} from '../src/capability/graph.mjs';
import {decide} from '../src/capability/eligibility.mjs';
import {sdkModels, SDK_VENDOR} from '../src/antigravity/config.mjs';

const capOf = model => `antigravity-sdk/${SDK_VENDOR}/${model}`;

test('KG-23: every fit implementer seat on the Antigravity SDK transport, and each rung behind it, is advised as the bridge capability, never as the shared API client', () => {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const s = selectSeat('implementer', {profile: 'fit', difficulty});
    assert.equal(s.seat.session_transport, 'antigravity-sdk', `${difficulty}: the seat says its session transport`);
    const a = s.seat.selection.advisory;
    assert.equal(a.capability, capOf(s.seat.model), `${difficulty}: ${JSON.stringify(a.why)}`);
    assert.equal(a.eligible, true, `${difficulty}: ${JSON.stringify(a.why)}`);
    for (const c of s.candidates) assert.equal(c.selection.advisory.capability, capOf(c.model), `${difficulty}, rung ${c.model}`);
  }
  // A seat that is not on that transport keeps its own profile: argo's implementer is an API seat.
  assert.match(selectSeat('implementer', {profile: 'argo'}).seat.selection.advisory.capability, /^api\//);
});

test('KG-23: the bridge capability is established on found quotes: jailed, credential-free, its tool calls decided; NOT isolated, because its state outlives the session', () => {
  const ix = defaultSnapshot().index;
  for (const m of sdkModels()) {
    const n = ix.node(E('capability', capabilityKey('antigravity-sdk', SDK_VENDOR, m)));
    assert.ok(n, `${m}: an executable capability`);
    assert.equal(n.established, true, `${m}: ${JSON.stringify(n.missing_evidence)}`);
    const a = n.attributes;
    assert.deepEqual([a.runtime, a.transport, a.environment, a.pool], ['antigravity-sdk-bridge', 'antigravity-sdk', 'bridge-jail', 'bridge-gateway'], m);
    assert.deepEqual(Object.fromEntries(Object.entries(a.bubble).map(([k, v]) => [k, v.holds])), {sandbox: true, credentials: true, tools: true, lifetime: false}, m);
    assert.equal(a.isolated, false, `${m}: isolation is never claimed while a component does not hold`);
    assert.ok(['bridge-egress', 'L-715', 'bridge-state-persists'].every(l => a.limitations.includes(l)), `${m}: ${a.limitations}`);
    assert.ok(a.roles.includes('implementer'), m);
  }
});

test('KG-23: a decision that requires the bubble excludes the bridge capability and names the lifetime; one that records it keeps it eligible', () => {
  const snap = defaultSnapshot(), cap = capOf('gemini-4-carbon');
  const recorded = decide(snap, {role: 'implementer'}), required = decide(snap, {role: 'implementer', bubble: 'required'});
  assert.ok(recorded.eligible.some(e => e.capability === cap), 'recorded: eligible');
  const out = required.excluded.find(x => x.capability === cap);
  assert.ok(out, 'required: excluded');
  assert.match(out.why.map(w => `${w.check}: ${w.why}`).join('; '), /bubble: the bubble does not hold: lifetime does not hold \(bridge-state-persists\)/);
});
