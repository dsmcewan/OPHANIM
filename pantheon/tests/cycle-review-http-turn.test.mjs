// The HTTPS reviewer turn sends the provider's own key when the owner's environment has it, and the
// proxy placeholder only when it does not. fetch is stubbed: no network, no real key.
import test from 'node:test';
import assert from 'node:assert/strict';
import turn from '../bin/cycle-review-http-turn.mjs';

async function headerFor(vendor, env) {
  const saved = {...process.env}, realFetch = globalThis.fetch;
  let auth = null;
  for (const k of ['OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY']) delete process.env[k];
  Object.assign(process.env, env);
  globalThis.fetch = async (_url, init) => { auth = init.headers.authorization;
    return {ok: true, json: async () => vendor === 'agy_google'
      ? {id: 'r', model: 'm', choices: [{finish_reason: 'stop', message: {content: 'ok'}}]}
      : {id: 'r', model: 'm', status: 'completed', output_text: 'ok'}}; };
  try { await turn({vendor, model: 'm', prompt: 'p'}); return auth; }
  finally { globalThis.fetch = realFetch; for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
}

test('each lab uses its own key variable when set', async () => {
  assert.equal(await headerFor('openai', {OPENAI_API_KEY: 'fixture-openai'}), 'Bearer fixture-openai');
  assert.equal(await headerFor('xai', {XAI_API_KEY: 'fixture-xai'}), 'Bearer fixture-xai');
  assert.equal(await headerFor('agy_google', {GEMINI_API_KEY: 'fixture-gemini'}), 'Bearer fixture-gemini');
});

test('with no key variable, the proxy placeholder is sent, and one lab never gets another lab\'s key', async () => {
  assert.equal(await headerFor('openai', {}), 'Bearer proxy-injected');
  assert.equal(await headerFor('xai', {OPENAI_API_KEY: 'fixture-openai'}), 'Bearer proxy-injected');
});
