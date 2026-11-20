// The composed foundry seat provider (ophanim/foundry/seats.mjs): one makeClientFor(vendor) that dispatches each lab to
// the transport serving it, with one shared spending meter, and reachable(seat) gated on whether that transport is
// actually available here. SYNTHETIC: every transport below is a stand-in (no model, no network, no key, no SDK).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {composeSeats} from '../foundry/seats.mjs';

// A stand-in transport: serves `vendors`, is `reachable`, declares `live`, and every turn costs `cost` and answers with
// its own id so the test can see which transport served. Honors opts.maxUsd by refusing past it (as the real seats do).
const fakeTransport = ({id, vendors, reachable = true, live = false, cost = 0.1}) => ({
  id, vendors, live, reachable: () => reachable,
  make: ({maxUsd = 5, effort = null, onCall = () => {}} = {}) => {
    let spent = 0; const calls = [];
    const makeClientFor = vendor => {
      if (!vendors.includes(vendor)) throw new Error(`${id} does not serve ${vendor}`);
      return {messages: {create: async req => {
        if (spent >= maxUsd) { const e = Object.assign(new Error(`${id}: spending cap ${maxUsd} reached`), {status: 402, code: 'FOUNDRY_BUDGET'}); calls.push({vendor, effort, outcome: 'refused', cost_usd: 0}); onCall(calls.at(-1)); throw e; }
        spent += cost; const row = {vendor, effort, outcome: 'ok', cost_usd: cost, served_by: id}; calls.push(row); onCall(row);
        return {id: `${id}:1`, type: 'message', role: 'assistant', model: req.model, content: [{type: 'text', text: id}], stop_reason: 'end_turn', usage: {input_tokens: 1, output_tokens: 1}};
      }}};
    };
    makeClientFor.providers = {kind: live ? 'live' : 'synthetic', transport: id};
    makeClientFor.calls = calls;
    makeClientFor.spent = () => ({usd: Number(spent.toFixed(6)), calls: calls.filter(c => c.outcome === 'ok').length});
    return makeClientFor;
  },
});
const seat = (vendor, profile = 'api') => ({capability: `${profile}/${vendor}/m`, profile, vendor, model: 'm', lab: vendor});
const ask = (clientFor, vendor) => clientFor(vendor).messages.create({model: 'm', max_tokens: 10, messages: [{role: 'user', content: 'x'}]});

test('reachable(seat) is true only when some transport serves that vendor AND is reachable here', () => {
  const cli = fakeTransport({id: 'claude-cli', vendors: ['anthropic'], reachable: true});
  const api = fakeTransport({id: 'live-api', vendors: ['openai', 'xai'], reachable: false}); // present but not serveable (no SDK/key)
  const {reachable} = composeSeats({transports: [cli, api]});
  assert.equal(reachable(seat('anthropic')), true);
  assert.equal(reachable(seat('openai')), false, 'served by a transport that is not reachable here');
  assert.equal(reachable(seat('xai')), false);
  assert.equal(reachable(seat('agy_google', 'agy-cli')), false, 'no transport serves this vendor');
});

test('makeClients dispatches each vendor to the transport that serves it; a vendor no reachable transport serves is refused', async () => {
  const cli = fakeTransport({id: 'claude-cli', vendors: ['anthropic']});
  const api = fakeTransport({id: 'live-api', vendors: ['openai', 'xai']});
  const {makeClients} = composeSeats({transports: [cli, api]});
  const clientFor = makeClients({setup: {effort: null}});
  assert.equal((await ask(clientFor, 'anthropic')).content[0].text, 'claude-cli');
  assert.equal((await ask(clientFor, 'openai')).content[0].text, 'live-api');
  assert.equal((await ask(clientFor, 'xai')).content[0].text, 'live-api');
  assert.throws(() => clientFor('agy_google'), /no reachable transport serves "agy_google"/);
});

test('one spending meter is shared across transports: spend on one lab refuses a later call on another', async () => {
  const cli = fakeTransport({id: 'claude-cli', vendors: ['anthropic'], cost: 0.6});
  const api = fakeTransport({id: 'live-api', vendors: ['openai'], cost: 0.6});
  const {makeClients} = composeSeats({transports: [cli, api], maxUsd: 1});
  const clientFor = makeClients({setup: {effort: null}});
  await ask(clientFor, 'anthropic'); await ask(clientFor, 'anthropic'); // 1.2 of 1 spent on the CLI transport
  await assert.rejects(ask(clientFor, 'openai'), e => e.code === 'FOUNDRY_BUDGET'); // the meter is shared: the API transport is refused on the CLI's spend
  assert.equal(clientFor.spent().usd, 1.2, 'the composed meter is the sum across transports');
});

test('providers.kind is live only when every reachable transport is live; one synthetic transport makes the trial synthetic', () => {
  const liveCli = fakeTransport({id: 'claude-cli', vendors: ['anthropic'], live: true});
  const liveApi = fakeTransport({id: 'live-api', vendors: ['openai'], live: true});
  const synthApi = fakeTransport({id: 'stub', vendors: ['openai'], live: false});
  assert.equal(composeSeats({transports: [liveCli, liveApi]}).makeClients({setup: {}}).providers.kind, 'live');
  assert.equal(composeSeats({transports: [liveCli, synthApi]}).makeClients({setup: {}}).providers.kind, 'synthetic');
  const unreachableSynth = fakeTransport({id: 'stub', vendors: ['openai'], live: false, reachable: false});
  assert.equal(composeSeats({transports: [liveCli, unreachableSynth]}).makeClients({setup: {}}).providers.kind, 'live', 'an unreachable transport never serves, so it does not taint liveness');
});

test('an effort is carried to the per-trial clients, and clients of different efforts share one budget', async () => {
  const rows = [];
  const cli = fakeTransport({id: 'claude-cli', vendors: ['anthropic'], cost: 0.4});
  const {makeClients} = composeSeats({transports: [cli], maxUsd: 1, onCall: r => rows.push(r)});
  const low = makeClients({setup: {effort: 'low'}}), high = makeClients({setup: {effort: 'high'}});
  await ask(low, 'anthropic'); await ask(low, 'anthropic'); await ask(high, 'anthropic'); // 1.2 of 1 across two effort clients
  await assert.rejects(ask(high, 'anthropic'), e => e.code === 'FOUNDRY_BUDGET');
  assert.deepEqual(rows.filter(r => r.outcome === 'ok').map(r => r.effort), ['low', 'low', 'high']);
});
