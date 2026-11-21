// The capability and model/runtime graph (knowledge graphs, Slice C1; docs/knowledge-graph/slice-c1.md): the extractors over
// the REAL registries, the model kept apart from its runtime, owner direction never read as measurement, the bubble as the
// code provides it (the SDK seat's jail, Slice C2: L-155 closed), observation into a real graph ledger, and the negative cases of
// demonstration 12.
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {capabilitySnapshot, extractionCounts, indexOfView, capabilityId, E, S, SOURCE_ORDER, DECLARED, STRUCTURAL} from '../src/capability/graph.mjs';
import {decide} from '../src/capability/eligibility.mjs';
import {seatTransport, ARGO_SEATS} from '../src/route/frontier.mjs';
import {sdkModels, SDK_VENDOR} from '../src/antigravity/config.mjs';
import {SEATING, INTAKE, modelOf} from '../src/role/seating.mjs';
import {FIT_MATRIX, IMPLEMENTER_LADDERS, REVIEWER_ESCALATION} from '../src/route/fit-matrix.mjs';
import {ROSTER} from '../src/team/roster.mjs';
import {recordRefusal, admits, assertion} from '../../packages/graph/schema.mjs';
import {registries, capabilityWorld, ORIGINS, KEYS, T0} from './fixtures/capability-helpers.mjs';

const REG = registries(), SNAP = capabilitySnapshot(REG), IX = SNAP.index;
// An entity id's key: what follows <instance>/<domain>/<type>/.
const tail = id => decodeURIComponent(id.replace(/^(?:[^/]+\/){3}/, ''));
const modelsOf = reg => Object.entries(reg.models).flatMap(([v, names]) => Object.values(names).map(m => ({vendor: v === 'google' ? 'agy_google' : v, model: m})));

test('extraction: every source projects its own registry, counted against the registry itself; every fact is a valid graph record', t => {
  const c = extractionCounts(SNAP), models = modelsOf(REG), lanes = Object.keys(REG.lanes.agy_cli);
  assert.deepEqual(SNAP.sources.map(s => s.id), SOURCE_ORDER, 'one observation per source, in order');
  assert.deepEqual(SNAP.sources.map(s => s.extractor), SOURCE_ORDER.map(s => (s === S.executable ? STRUCTURAL : DECLARED)));
  assert.equal(c[S.models].types.model, models.length, 'one model per models.json entry');
  assert.equal(c[S.models].types.provider, Object.keys(REG.models).length);
  assert.equal(c[S.models].types['made-by'], models.length, 'every registry model names its lab');
  assert.equal(c[S.lanes].types.lane, lanes.length, 'one lane per lanes.json entry, retired ones included');
  assert.equal(c[S.identity].types.model, Object.keys(REG.identity.model_lab).filter(m => !models.some(x => x.model === m)).length);
  assert.equal(c[S.roles].types.chair, Object.keys(ROSTER).length);
  // The executable capabilities, counted by the live selector's OWN transport rule (frontier.mjs seatTransport).
  const want = models.flatMap(m => (seatTransport(m.vendor, m.model) === 'agy' ? [`agy-cli/${m.vendor}/${m.model}`, `agy-sdk/${m.vendor}/${m.model}`] : [`${seatTransport(m.vendor, m.model)}/${m.vendor}/${m.model}`]))
    .concat(lanes.map(l => `agy-cli/${REG.lanes.agy_cli[l].vendor}/${l}`))
    // and the Antigravity SDK transport's models, as the live code lists them (antigravity/config.mjs; register KG-23).
    .concat(sdkModels().map(m => `antigravity-sdk/${SDK_VENDOR}/${m}`)).sort();
  assert.deepEqual(IX.ofType('capability').map(n => tail(n.id)).sort(), want, 'every registry model and lane, served as the selector serves it');
  for (const l of lanes) assert.equal(seatTransport(REG.lanes.agy_cli[l].vendor, l), 'agy-cli', `${l} is served by its lane's transport`);
  const seatRows = new Set([...Object.entries(SEATING).flatMap(([r, rows]) => rows.map(x => `seating/${r}/${x.vendor}/${modelOf(x)}`)),
    ...Object.entries(INTAKE).flatMap(([r, rows]) => rows.map(x => `intake/${r}/${x.vendor}/${modelOf(x)}`)),
    ...Object.entries(ARGO_SEATS).flatMap(([r, rows]) => rows.map(x => `argo/${r}/${x.vendor}/${x.model}`))]);
  assert.equal(c[S.seating].types.placement, seatRows.size, 'one placement per seating, intake and ARGO row');
  assert.equal(c[S.fit].types.placement, Object.keys(FIT_MATRIX).length * 3 + Object.values(IMPLEMENTER_LADDERS).flat().length + REVIEWER_ESCALATION.length);
  for (const r of SNAP.records) assert.equal(recordRefusal(r, {origins: ORIGINS}), null, r.subject);
  assert.equal(SNAP.records.length, SNAP.sources.reduce((n, s) => n + s.count, 0));
  t.diagnostic(`capability snapshot ${SNAP.digest}: ${SNAP.sources.map(s => `${s.id} ${s.count}`).join(', ')}; ${SNAP.records.length} facts`);
});

test('model and runtime are separate entities: each executable capability combines one model or lane, one runtime, transport, sandbox profile and credential scope', () => {
  for (const n of IX.ofType('capability')) {
    const comps = IX.out(n.id, 'combines'), of = type => comps.filter(e => IX.node(e.to).type === type).map(e => e.to);
    assert.equal(of('model').length + of('lane').length, 1, `${n.id} combines one model or lane`);
    for (const type of ['runtime', 'transport', 'environment', 'pool']) assert.equal(of(type).length, 1, `${n.id} combines one ${type}`);
    assert.notEqual([...of('model'), ...of('lane')][0], of('runtime')[0]);
    assert.deepEqual(of('tool').map(tail).sort(), [...n.attributes.tools].sort(), `${n.id}: its tools are components`);
  }
  const models = new Set(IX.ofType('model').map(n => n.id)), runtimes = new Set(IX.ofType('runtime').map(n => n.id));
  assert.equal([...models].filter(m => runtimes.has(m)).length, 0, 'no entity is both a model and a runtime');
  // One model, two runtimes: gemini-3.6-flash on the Antigravity CLI and on the python SDK seat.
  const flash = IX.in(E('model', 'gemini-3.6-flash'), 'combines').map(e => e.from).sort();
  assert.deepEqual(flash, [capabilityId('agy-cli', 'agy_google', 'gemini-3.6-flash'), capabilityId('agy-sdk', 'agy_google', 'gemini-3.6-flash')]);
  assert.deepEqual(flash.map(c => IX.node(c).attributes.runtime), ['antigravity-cli', 'antigravity-sdk']);
  // A lane is a name of a model, not a model: gemini-4-carbon-high is an alias of gemini-4-carbon, which the API also serves.
  assert.equal(IX.out(E('lane', 'gemini-4-carbon-high'), 'alias-of')[0].to, E('model', 'gemini-4-carbon'));
  assert.equal(IX.node(capabilityId('api', 'agy_google', 'gemini-4-carbon')).attributes.runtime, 'model-client');
  assert.deepEqual(IX.out(E('model', 'gemini-4-carbon'), 'made-by').map(e => e.to), [E('lab', 'google')]);
  assert.ok(IX.out(E('runtime', 'antigravity-sdk'), 'supports').some(e => e.to === E('feature', 'native-subagents')), 'the SDK runtime provides native subagents');
  assert.equal(IX.node(E('runtime', 'antigravity-sdk')).attributes.delegation.depth, 1, 'its delegation limit as the code states it');
});

test('owner direction is never a measurement: every seating, ARGO and fit placement is declared owner direction, and nothing is qualified-for', () => {
  const placements = SNAP.records.filter(r => r.kind === 'entity' && r.type === 'placement');
  assert.ok(placements.length > 40);
  for (const p of placements) {
    assert.equal(p.attributes.evidence_type, 'owner-direction', p.subject);
    assert.equal(p.classification, 'authoritative', p.subject);
    assert.equal(ORIGINS[p.origin].basis, 'declared', `${p.subject} is admitted from a declared basis`);
  }
  assert.ok(SNAP.records.filter(r => r.type === 'places').every(r => ORIGINS[r.origin].basis === 'declared'));
  assert.equal(SNAP.records.filter(r => r.type === 'qualified-for' || r.type === 'measures').length, 0, 'no qualification and no measurement is projected from a registry');
  assert.equal(SNAP.records.filter(r => r.classification === 'observed').length, 0);
  // The contract refuses it too: a placement is never admitted as a measurement, a qualification never from a declaration.
  assert.equal(admits('places', 'observed', 'measured'), false);
  assert.equal(admits('qualified-for', 'authoritative', 'declared'), false);
  const asMeasured = assertion({type: 'places', from: placements[0].subject, to: E('role', 'planner'), origin: 'pantheon.capability.metrics', classification: 'observed',
    source: {id: 'pantheon.capability.records', authority: 'test', ref: 'test', version: 'sha256:' + '1'.repeat(64)}, run: {id: 'r'}, observed_at: T0});
  assert.match(recordRefusal(asMeasured, {origins: ORIGINS}), /places may not be admitted as observed/);
});

test('the bubble: each profile as the code provides it -- the SDK seat jailed (L-155 closed, its shared network a retained limitation), the CLI lane jailed (L-004 retained), the API seat not torn down; isolation only on found code evidence', () => {
  const sdk = IX.node(capabilityId('agy-sdk', 'agy_google', 'gemini-3.6-flash')).attributes;
  // Slice C2: the SDK seat's whole process runs in its jail at both spawn points, so all four components hold on the jail's
  // code (C1's rule, unchanged: all four hold or do not apply): the SDK capability IS isolated.
  assert.deepEqual(Object.fromEntries(Object.entries(sdk.bubble).map(([k, v]) => [k, v.holds])), {sandbox: true, credentials: true, tools: true, lifetime: true});
  assert.equal(sdk.isolated, true, 'the jailed SDK seat is recorded as isolated, on the jail\'s code');
  assert.equal(sdk.environment, 'sdk-jail');
  assert.deepEqual([sdk.bubble.sandbox.limitation, sdk.bubble.tools.limitation], ['sdk-jail-egress', 'sdk-jail-egress'], 'with the retained limitation recorded');
  const cited = Object.values(sdk.bubble).flatMap(c => c.evidence.map(e => e.file));
  for (const f of ['pantheon/src/agy/sandbox.mjs', 'pantheon/src/board/run-item.mjs', 'pantheon/bin/agy-seat.mjs']) assert.ok(cited.includes(f), `the bubble cites ${f}: the jail and both spawn points`);
  assert.ok(sdk.bubble.sandbox.evidence.some(e => /^const \[cmd, \.\.\.argv\] = \[\.\.\.jail\.prefix, python, \.\.\.args\];$/.test(e.quote)), 'the board\'s jailed spawn is quoted');
  assert.ok(sdk.bubble.sandbox.evidence.some(e => /^const \[cmd, \.\.\.argv\] = \[\.\.\.jail\.prefix, python, SEAT, \.\.\.args\];$/.test(e.quote)), 'the launcher\'s jailed spawn is quoted');
  assert.ok(sdk.bubble.lifetime.evidence.some(e => /dropSdkSeatScratch/.test(e.quote)), 'the lifetime cites the teardown');
  const env = IX.node(E('environment', 'sdk-jail'));
  assert.deepEqual([env.established, env.attributes.sandboxed], [true, true]);
  assert.equal(IX.node(E('environment', 'host-process')), null, 'no SDK seat runs as a plain host process any more');
  // L-155 no longer limits the SDK capability: its register line is found and its record says closed, by the jail's code.
  const l155 = IX.node(E('limitation', 'L-155'));
  assert.deepEqual([l155.established, l155.attributes.status, l155.attributes.breaks], [true, 'closed', []]);
  assert.equal(l155.attributes.register.file, 'docs/OPEN-LIMITATIONS.md');
  assert.ok(l155.attributes.evidence.length >= 3 && l155.attributes.evidence.every(e => e.found), 'the register line and the jail that closed it, each quote found');
  assert.deepEqual(IX.in(E('limitation', 'L-155'), 'limited-by'), [], 'nothing is limited by L-155');
  // The shared network is RETAINED, never claimed isolated: the capability, its environment and its run_command are limited by it.
  const egress = IX.node(E('limitation', 'sdk-jail-egress'));
  assert.deepEqual([egress.established, egress.attributes.status], [true, 'retained']);
  for (const from of [capabilityId('agy-sdk', 'agy_google', 'gemini-3.6-flash'), E('environment', 'sdk-jail'), E('tool', 'agy-sdk/run_command')]) {
    assert.ok(IX.out(from, 'limited-by').some(e => e.to === E('limitation', 'sdk-jail-egress')), `${from} is limited by sdk-jail-egress`);
  }
  assert.ok(IX.out(E('tool', 'agy-sdk/run_command'), 'runs-in').some(e => e.to === E('environment', 'sdk-jail')), 'run_command runs in the jail');
  const cli = IX.node(capabilityId('agy-cli', 'agy_google', 'gemini-4-carbon-high')).attributes;
  assert.equal(cli.isolated, true, 'the jailed CLI lane: the jail hook, the scrubbed environment, a fresh control dir per turn');
  assert.equal(cli.bubble.sandbox.limitation, 'L-004', 'with the retained limitation recorded');
  // The negative example among the real profiles: an API seat's records persist, so its bubble does not hold.
  const api = IX.node(capabilityId('api', 'openai', 'gpt-6-astra')).attributes;
  assert.equal(api.bubble.sandbox.holds, 'not-applicable');
  assert.equal(api.bubble.lifetime.holds, false, 'no per-assignment teardown is enforced for an API seat');
  assert.equal(api.isolated, false);
  for (const n of IX.ofType('capability')) {
    for (const [k, v] of Object.entries(n.attributes.bubble)) if (v.holds === true || v.holds === 'not-applicable') assert.ok(v.evidence.length && v.evidence.every(e => e.found), `${n.id} ${k} holds only on found evidence`);
  }
});

test('the bubble: the SDK seat\'s jail is its evidence -- the jail\'s code gone from the files it quotes, the SDK seat\'s sandbox, credentials and tools are unresolved and it is not isolated', () => {
  // The code changes under the claim: the jail's argv and both jailed spawns removed from their files' text.
  const r = structuredClone(REG);
  const cut = (file, quote) => { assert.ok(r.evidence[file].includes(quote), `${file} holds ${quote}`); r.evidence[file] = r.evidence[file].split(quote).join(''); };
  cut('pantheon/src/agy/sandbox.mjs', 'const prefix = [bwrap, "--die-with-parent", "--unshare-pid", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];');
  cut('pantheon/src/board/run-item.mjs', 'const [cmd, ...argv] = [...jail.prefix, python, ...args];');
  cut('pantheon/src/board/run-item.mjs', 'sdkRun = await spawnPromise(cmd, argv, { env: jail.env, timeout: (timeoutS + 60) * 1000, ...(signal ? { signal } : {}) });');
  cut('pantheon/bin/agy-seat.mjs', 'const [cmd, ...argv] = [...jail.prefix, python, SEAT, ...args];');
  const ix = capabilitySnapshot(r).index, sdk = ix.node(capabilityId('agy-sdk', 'agy_google', 'gemini-3.6-flash')).attributes;
  assert.deepEqual([sdk.bubble.sandbox.holds, sdk.bubble.credentials.holds, sdk.bubble.tools.holds], ['unresolved', 'unresolved', 'unresolved']);
  assert.ok(sdk.bubble.sandbox.missing.some(m => /jail\.prefix, python, \.\.\.args/.test(m)), 'the missing quote is named');
  assert.equal(sdk.isolated, false, 'nothing is recorded as isolated that the code does not isolate');
  assert.equal(ix.node(E('environment', 'sdk-jail')).established, false, 'the jail environment\'s claim is unresolved, not established');
  assert.equal(ix.node(E('limitation', 'L-155')).established, false, 'and so is the closing of L-155');
});

test('the bubble: isolation is never claimed without code evidence (a missing or absent quote leaves the claim unresolved)', () => {
  const claim = mutate => { const r = structuredClone(REG); mutate(r); return capabilitySnapshot(r).index; };
  // A FIXTURE capability (fixtures/capability-bubble-fixture.json): its sandbox claims to hold on a quote the code does not
  // contain. The SDK seat was this example until its jail made its bubble hold (Slice C2).
  const fx = JSON.parse(readFileSync(new URL('./fixtures/capability-bubble-fixture.json', import.meta.url), 'utf8'));
  const withFixture = (sandbox = fx.profile.bubble.sandbox) => r => {
    r.runtimes.profiles['fixture-unquoted'] = {...structuredClone(fx.profile), bubble: {...structuredClone(fx.profile.bubble), sandbox}};
    r.runtimes.serving.push(structuredClone(fx.serving));
  };
  const fxOf = ix => ix.node(capabilityId('fixture-unquoted', 'agy_google', 'gemini-3.6-flash')).attributes;
  const quoted = claim(withFixture());
  assert.equal(fxOf(quoted).bubble.sandbox.holds, 'unresolved', 'a quote the code does not contain proves nothing');
  assert.deepEqual([fxOf(quoted).bubble.credentials.holds, fxOf(quoted).bubble.tools.holds, fxOf(quoted).bubble.lifetime.holds], [true, 'not-applicable', true], 'its other components hold on found quotes');
  assert.equal(fxOf(quoted).isolated, false);
  const bare = claim(withFixture({holds: true, why: 'claimed'}));
  assert.equal(fxOf(bare).bubble.sandbox.holds, 'unresolved', 'a claim with no evidence at all');
  assert.equal(fxOf(bare).isolated, false);
  // The control: the same claim on a quote the code does contain holds -- the rule decides, not the fixture.
  const found = claim(withFixture({...fx.profile.bubble.sandbox, evidence: [fx.found]}));
  assert.deepEqual([fxOf(found).bubble.sandbox.holds, fxOf(found).isolated], [true, true]);
  // The code changes under a claim: the jail's quote disappears from agy-cli.mjs. Nothing of the lane is isolated any more.
  const gone = claim(r => { r.evidence['pantheon/src/board/agy-cli.mjs'] = r.evidence['pantheon/src/board/agy-cli.mjs'].replace('refusing to run the worker unjailed (pass sandbox.allowUnsandboxed: true to override)', 'running'); });
  const lane = gone.node(capabilityId('agy-cli', 'agy_google', 'gemini-4-carbon-high')).attributes;
  assert.equal(lane.bubble.sandbox.holds, 'unresolved');
  assert.equal(lane.isolated, false);
  assert.equal(gone.node(E('environment', 'bwrap-jail')).established, false, 'the environment claim is unresolved, not established');
});

test('the graph: observed into a real graph ledger, its view gives the snapshot\'s decision; replay reconstructs the same projection', t => {
  const w = capabilityWorld(t, {reg: REG});
  const obs = w.observeAll();
  for (const id of SOURCE_ORDER) assert.equal(obs[id].recorded, true, `${id} observed`);
  assert.equal(w.observeAll()[S.models].recorded, false, 'observing the same version again records nothing');
  const view = w.graph.view(), vix = indexOfView(view);
  assert.deepEqual(vix.ofType('capability').filter(n => n.established).map(n => n.id).sort(), IX.ofType('capability').filter(n => n.established).map(n => n.id).sort());
  for (const req of [{role: 'implementer', context: 200000}, {role: 'reviewer', avoid_labs: ['openai']}, {role: 'scout', features: ['web-search']}]) {
    const a = decide(SNAP, req), b = decide({index: vix, digest: view.digest(), sources: view.sources()}, req);
    assert.deepEqual([b.eligible, b.excluded, b.target, b.review], [a.eligible, a.excluded, a.target, a.review], JSON.stringify(req));
  }
  assert.equal(w.open().digest(), w.graph.digest(), 'a fresh process replays the ledger to the same projection digest');
  assert.ok(w.graph.freshness().every(f => f.state === 'current'));
});

test('negative cases: an unverified model claim is hypothetical, never established, and changes no decision', t => {
  const w = capabilityWorld(t, {reg: REG});
  w.observeAll();
  const before = decide({index: indexOfView(w.graph.view()), digest: 'x', sources: []}, {role: 'planner', features: ['native-subagents']});
  const claim = assertion({type: 'supports', from: E('runtime', 'antigravity-cli'), to: E('feature', 'native-subagents'), origin: 'synthetic.model', classification: 'hypothetical',
    source: {id: 'synthetic.model', authority: 'a model\'s claim', ref: 'test', version: null}, observed_at: T0, missing_evidence: ['no code evidence: a model said so']});
  assert.equal(w.graph.assert([claim], w.by(KEYS.model)).appended, true);
  const view = w.graph.view();
  assert.deepEqual(view.query(claim.subject, 'established'), []);
  assert.match(view.query(claim.subject, 'possible')[0].why, /^hypothetical/);
  const after = decide({index: indexOfView(view), digest: 'x', sources: []}, {role: 'planner', features: ['native-subagents']});
  assert.deepEqual(after.eligible, before.eligible, 'the claim admits nothing');
  assert.ok(after.excluded.some(x => x.capability.startsWith('agy-cli/') && x.why.some(w2 => w2.check === 'feature')));
  // A model may not admit it as anything else.
  const asFact = assertion({...claim, classification: 'observed', run: {id: 'r'}, source: {...claim.source, version: 'sha256:' + '2'.repeat(64)}, missing_evidence: []});
  assert.match(recordRefusal(asFact, {origins: ORIGINS}), /may not admit an assertion classified observed/);
});

test('negative cases: an unknown model, runtime or role is unresolved, a pin of it would be refused, and an edge to it is refused', t => {
  const pin = decide(SNAP, {role: 'implementer', mode: 'pinned', target: {vendor: 'openai', model: 'gpt-7-imagined'}});
  assert.equal(pin.target.capability, null);
  assert.equal(pin.target.would_refuse, true);
  assert.ok(pin.unresolved.some(u => /gpt-7-imagined is not an executable capability/.test(u)));
  const runtime = decide(SNAP, {role: 'implementer', runtime: 'imagined-cli'});
  assert.deepEqual([runtime.eligible, runtime.unresolved], [[], ['runtime imagined-cli is not in the capability graph']]);
  assert.deepEqual(decide(SNAP, {role: 'no-such-role'}).eligible, []);
  const w = capabilityWorld(t, {reg: REG});
  w.observeAll();
  const edge = assertion({type: 'runs-in', from: E('model', 'gpt-7-imagined'), to: E('runtime', 'model-client'), origin: 'synthetic.agent', classification: 'hypothetical',
    source: {id: 'synthetic.agent', authority: 'an agent', ref: 'test', version: null}, observed_at: T0, missing_evidence: ['an unverified claim']});
  assert.throws(() => w.graph.assert([edge], w.by(KEYS.agent)), /GRAPH_REFERENCE broken reference/);
});
