// Advisory eligibility over the capability graph (knowledge graphs, Slice C1, KC3 and KC6): the three modes with their
// explanations, lab as lineage and as the reviewer-exclusion input only, the requirement checks, and demonstration 4 -- a
// data change alone gives a new explainable decision while the live selection stays as it was.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {capabilitySnapshot, indexOfView, capabilityId, E, S} from '../src/capability/graph.mjs';
import {decide, PREFERRED_FALLBACK, MODE_OF_SOURCE} from '../src/capability/eligibility.mjs';
import {selectSeat, PRECEDENCE} from '../src/route/frontier.mjs';
import {affected} from '../../packages/graph/events.mjs';
import {registries, retireLane, removeLane, changeLimitation, capabilityWorld, T0} from './fixtures/capability-helpers.mjs';

const REG = registries(), SNAP = capabilitySnapshot(REG);
const ids = d => d.eligible.map(e => e.capability);
const why = (d, cap) => d.excluded.find(x => x.capability === cap)?.why.map(w => `${w.check}: ${w.why}`) ?? [];
const strip = choice => JSON.parse(JSON.stringify(choice, (k, v) => (k === 'advisory' ? undefined : v)));

test('modes: selectSeat\'s precedence maps onto automatic, preferred and pinned', () => {
  assert.deepEqual(PRECEDENCE.map(p => MODE_OF_SOURCE[p]), ['pinned', 'preferred', 'pinned', 'preferred', 'automatic']);
  assert.equal(MODE_OF_SOURCE.profile, 'automatic');
});

test('automatic: every capability the evidence admits, each exclusion with its reason, the snapshot digest and versions named', () => {
  const d = decide(SNAP, {role: 'implementer', context: 600000});
  assert.equal(d.snapshot.digest, SNAP.digest);
  assert.deepEqual(Object.keys(d.snapshot.versions), SNAP.sources.map(s => s.id));
  assert.match(d.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(ids(d).includes('agy-cli/agy_google/gemini-4-hydrogen-high') && ids(d).includes('api/openai/gpt-6-astra'));
  const unplaced = d.eligible.filter(e => e.placed.length === 0).map(e => e.capability);
  assert.ok(unplaced.includes('api/xai/grok-4.3'), `a capability no table places for the implementer is still eligible on its evidence (${unplaced.length}: ${unplaced})`);
  assert.match(why(d, 'agy-cli/agy_google/claude-sonnet-4-6').join(), /availability: retired/);
  assert.match(why(d, 'agy-sdk/agy_google/gemini-3.6-flash').join(), /role: the antigravity-sdk runtime serves only the roles reviewer, scout, fact-checker/);
  assert.match(why(d, 'api/agy_google/gemini-4-carbon').join(), /use: served only as a quota failover/);
  assert.match(why(d, 'api/anthropic/claude-haiku-4-5-20251001').join(), /context: documented window 200000 < estimated 600000/);
  assert.equal(d.eligible.length + d.excluded.length, SNAP.index.ofType('capability').length);
  assert.ok(d.excluded.every(x => x.why.length > 0), 'every exclusion says why');
  assert.match(d.explanation[0], /^automatic .* eligible for implementer on capability evidence \(snapshot sha256:/);
  assert.match(d.explanation.join('\n'), /excluded \d+: .*availability \d+/);
  const placed = d.eligible.find(e => e.capability === 'agy-cli/agy_google/gemini-4-hydrogen-high').placed;
  assert.ok(placed.some(p => p.table === 'fit' && p.evidence_type === 'owner-direction'), 'owner direction reported beside the evidence, never as it');
});

test('preferred: the operator\'s capability, with its documented fallback (its pools only: no other capability)', () => {
  const ok = decide(SNAP, {role: 'planner', mode: 'preferred', target: {vendor: 'openai', model: 'gpt-6-sol', transport: 'api'}});
  assert.deepEqual([ok.target.capability, ok.target.eligible, ok.target.fallback.documented], ['api/openai/gpt-6-sol', true, PREFERRED_FALLBACK]);
  const bad = decide(SNAP, {role: 'planner', mode: 'preferred', context: 900000, target: {vendor: 'anthropic', model: 'claude-haiku-4-5-20251001'}});
  assert.equal(bad.target.eligible, false);
  assert.deepEqual(bad.target.fallback.would_fall_back_to, []);
  assert.match(bad.explanation.join('\n'), /preferred anthropic\/claude-haiku-4-5-20251001: not eligible: documented window 200000 < estimated 900000/);
  assert.equal(bad.target.would_refuse, undefined, 'a preference is not a pin: nothing would be refused');
});

test('pinned: a pinned capability that is not eligible is reported as one that WOULD BE REFUSED; an eligible one is not', () => {
  const ok = decide(SNAP, {role: 'implementer', mode: 'pinned', target: {vendor: 'agy_google', model: 'gemini-4-carbon-high'}});
  assert.deepEqual([ok.target.capability, ok.target.would_refuse], ['agy-cli/agy_google/gemini-4-carbon-high', false]);
  const retired = decide(SNAP, {role: 'implementer', mode: 'pinned', target: {vendor: 'agy_google', model: 'claude-opus-4-6-thinking'}});
  assert.equal(retired.target.would_refuse, true);
  assert.match(retired.target.refusal, /WOULD BE REFUSED \(advisory: nothing is refused live\)/);
  assert.match(retired.explanation.join('\n'), /pinned agy_google\/claude-opus-4-6-thinking: WOULD BE REFUSED: retired: 2026-11-17/);
  const sdk = decide(SNAP, {role: 'planner', mode: 'pinned', target: {vendor: 'agy_google', model: 'gemini-3.6-flash', transport: 'agy-sdk'}});
  assert.equal(sdk.target.would_refuse, true, 'the SDK seat does not serve the planner');
});

test('lab: never excludes a producer (lineage only), and does exclude a contributing lab\'s reviewer; the three-lab floor is reported', () => {
  const producer = decide(SNAP, {role: 'implementer', avoid_labs: ['openai'], avoid: ['openai']});
  assert.ok(ids(producer).includes('api/openai/gpt-6-astra'), 'a producer of the contributing lab stays eligible');
  assert.equal(producer.excluded.filter(x => x.why.some(w => w.check === 'independence')).length, 0);
  assert.match(producer.eligible.find(e => e.capability === 'api/openai/gpt-6-astra').notes.join(), /lineage only/);
  assert.equal(producer.review.applies, false);
  assert.equal(producer.eligible.find(e => e.capability === 'api/openai/gpt-6-astra').lab, 'openai', 'the lab is recorded for lineage');
  const reviewer = decide(SNAP, {role: 'reviewer', avoid_labs: ['openai']});
  assert.ok(!ids(reviewer).includes('api/openai/gpt-6.1-sol'));
  assert.match(why(reviewer, 'api/openai/gpt-6.1-sol').join(), /independence: the openai lab contributed/);
  assert.deepEqual([reviewer.review.applies, reviewer.review.labs, reviewer.review.floor.value, reviewer.review.floor.met], [true, ['anthropic', 'google', 'xai'], 3, true]);
  const judge = decide(SNAP, {role: 'judge', avoid_labs: ['google', 'xai']});
  assert.deepEqual([judge.review.labs, judge.review.floor.met], [['anthropic', 'openai'], false], 'two labs left: the floor is reported NOT met');
  // A lane served by the agy_google vendor is a Google model by its made-by lineage, not by the vendor string.
  assert.equal(reviewer.eligible.find(e => e.capability === 'agy-cli/agy_google/gemini-4-carbon-high').lab_via, 'made-by (gemini-4-carbon)');
});

test('requirements: effort, features and delegation each exclude with their reason; the bubble excludes only when required', () => {
  const effort = decide(SNAP, {role: 'implementer', effort: 'max'});
  assert.match(why(effort, 'agy-cli/agy_google/gemini-4-carbon-high').join(), /effort: effort max is not carried by the agy-cli transport/);
  assert.match(why(effort, 'api/agy_google/gemini-4-carbon').join(), /not on the documented ladder \[low, medium, high\]/);
  assert.ok(ids(effort).includes('api/openai/gpt-6-astra'));
  const web = decide(SNAP, {role: 'scout', features: ['web-search']});
  assert.deepEqual(ids(web), ['agy-sdk/agy_google/gemini-3.6-flash']);
  const delegate = decide(SNAP, {role: 'reviewer', delegation: 1});
  assert.deepEqual(ids(delegate), ['agy-sdk/agy_google/gemini-3.6-flash'], 'only the SDK reviewer may start a subagent');
  assert.deepEqual(decide(SNAP, {role: 'scout', delegation: 1}).eligible, [], 'and only for the reviewer role');
  // The bubble (Slice C2: the SDK seat is jailed, L-155 closed): the API seats are the ones whose bubble does not hold (no
  // per-assignment teardown), and with the bubble required only the jailed seats remain, the CLI lanes and the SDK seat.
  const recorded = decide(SNAP, {role: 'reviewer'}), required = decide(SNAP, {role: 'reviewer', bubble: 'required'});
  assert.ok(ids(recorded).includes('agy-sdk/agy_google/gemini-3.6-flash') && ids(recorded).includes('api/openai/gpt-6-astra'));
  assert.match(recorded.explanation.join('\n'), /the bubble does not hold for .*api\/openai\/gpt-6-astra \(lifetime\)/);
  assert.doesNotMatch(recorded.explanation.join('\n'), /agy-sdk\/agy_google\/gemini-3\.6-flash \(/, 'the jailed SDK seat is not among them');
  assert.match(why(required, 'api/openai/gpt-6-astra').join(), /bubble: the bubble does not hold: lifetime does not hold/);
  assert.ok(ids(required).includes('agy-sdk/agy_google/gemini-3.6-flash'), 'the jailed SDK seat stays eligible with the bubble required');
  assert.ok(ids(required).every(c => c.startsWith('agy-cli/') || c.startsWith('agy-sdk/')), 'with the bubble required, only the jailed seats remain');
  const billing = decide(SNAP, {role: 'reviewer', billing: {gemini_primary: false}});
  assert.match(why(billing, 'agy-sdk/agy_google/gemini-3.6-flash').join(), /billing: sdk-seat-metered/);
});

test('demonstration 4: a data change alone (a lane retired, a lane removed, a limitation changed) gives a new explainable decision; the live seat is unchanged', t => {
  const pick = {role: 'implementer', mode: 'pinned', target: {vendor: 'agy_google', model: 'gemini-4-hydrogen-high'}};
  const cases = [
    {what: 'a lane retired', reg: retireLane(REG, 'gemini-4-hydrogen-high'), req: pick, cap: 'agy-cli/agy_google/gemini-4-hydrogen-high', expect: /availability: retired: retired for the test/},
    {what: 'a lane removed', reg: removeLane(REG, 'gemini-4-carbon-low'), req: {...pick, target: {vendor: 'agy_google', model: 'gemini-4-carbon-low'}}, cap: null, expect: /not an executable capability of the capability graph/},
    {what: 'a limitation changed', reg: changeLimitation(REG, 'L-004', {blocks_roles: ['reviewer']}), req: {role: 'reviewer', mode: 'pinned', target: {vendor: 'agy_google', model: 'gemini-3.8-flash-high'}},
      cap: 'agy-cli/agy_google/gemini-3.8-flash-high', expect: /limitation: L-004 blocks the reviewer role/},
  ];
  for (const c of cases) {
    const before = decide(SNAP, c.req), snap = capabilitySnapshot(c.reg), after = decide(snap, c.req);
    assert.equal(before.target.would_refuse, false, `${c.what}: eligible before`);
    assert.notEqual(snap.digest, SNAP.digest, `${c.what}: a new snapshot`);
    assert.equal(after.target.would_refuse, true, `${c.what}: would be refused after`);
    assert.match(after.target.why.map(w => `${w.check}: ${w.why}`).join(), c.expect, `${c.what}: and says why`);
    assert.notEqual(after.digest, before.digest);
    assert.equal(after.target.capability, c.cap);
    const changed = Object.keys(after.snapshot.versions).filter(s => after.snapshot.versions[s] !== before.snapshot.versions[s]);
    assert.ok(changed.length > 0 && changed.every(s => [S.lanes, S.identity, S.runtimes, S.executable, S.seating, S.fit].includes(s)), `${c.what}: the versions name what changed (${changed})`);
  }
  // The same change through a real graph ledger: one observation per source, a change event, its affected neighbourhood.
  const w = capabilityWorld(t, {reg: REG});
  w.observeAll();
  const d1 = decide({index: indexOfView(w.graph.view()), digest: w.graph.digest(), sources: w.graph.view().sources()}, pick);
  w.advance(cases[0].reg);
  const lanes = w.graph.observe(S.lanes, {...w.by('declared-key'), observed_at: T0});
  const exec = w.graph.observe(S.executable, {...w.by('structural-key'), observed_at: T0});
  assert.deepEqual(lanes.event.nodes, [E('lane', 'gemini-4-hydrogen-high')], 'the lane observation changes exactly that lane');
  assert.ok(exec.event.nodes.includes(capabilityId('agy-cli', 'agy_google', 'gemini-4-hydrogen-high')));
  const reach = affected(w.graph.projection, lanes.event);
  assert.ok(reach.nodes.some(n => n.id === capabilityId('agy-cli', 'agy_google', 'gemini-4-hydrogen-high')), 'the capability combining the lane is in its affected neighbourhood');
  assert.ok(!reach.nodes.some(n => n.id === capabilityId('api', 'openai', 'gpt-6-astra')), 'an unrelated capability is not');
  const d2 = decide({index: indexOfView(w.graph.view()), digest: w.graph.digest(), sources: w.graph.view().sources()}, pick);
  assert.deepEqual([d1.target.would_refuse, d2.target.would_refuse], [false, true]);
  // Live selection is unchanged by any of it: the owner-directed matrix still seats the lane.
  const live = selectSeat('implementer', {profile: 'fit', difficulty: 'medium', advisory: false});
  const before = selectSeat('implementer', {profile: 'fit', difficulty: 'medium'});
  const retired = capabilitySnapshot(cases[0].reg);
  const advised = selectSeat('implementer', {profile: 'fit', difficulty: 'medium', capability: retired});
  assert.equal(JSON.stringify(strip(advised)), JSON.stringify(live));
  assert.equal(JSON.stringify(strip(before)), JSON.stringify(live));
  assert.equal(advised.seat.model, 'gemini-4-hydrogen-high');
  assert.deepEqual([before.seat.selection.advisory.eligible, advised.seat.selection.advisory.eligible], [true, false]);
  assert.match(advised.seat.selection.advisory.why.join(), /availability: retired/);
  assert.notEqual(advised.seat.selection.advisory.record.digest, before.seat.selection.advisory.record.digest, 'the recorded decision is the new one');
  assert.equal(advised.seat.selection.advisory.record.snapshot.digest, retired.digest);
  assert.ok(!advised.seat.selection.advisory.record.eligible.includes('agy-cli/agy_google/gemini-4-hydrogen-high'));
});
