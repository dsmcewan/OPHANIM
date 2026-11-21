// THE FOUNDRY'S CONCRETE TRANSPORTS: the descriptors composeSeats (seats.mjs) wires into one multi-lab seat provider.
//
// Purpose   composeSeats needs, per lab, a transport {id, vendors[], live, reachable(), make()}. This module builds the
//           three the foundry has: the Claude command line (claude-cli.mjs), and pantheon's live SDK seats (sdk/live.mjs
//           liveClients) for the OpenAI/xAI API and for agy_google. realTransports() returns the set, each with an honest
//           reachability probe, so a run uses whatever labs this environment can serve and is ready for the rest the
//           moment their SDK and credential are present.
// Inputs    the environment (credentials are read for PRESENCE only, never a value); the Claude CLI command; whether the
//           seats answer with a live model (`live`). sdkTransport takes an injected `open` (the liveClients factory) and
//           `reachable`, so it is tested without a vendor SDK, a network or a key.
// Outputs   claudeCliTransport(), sdkTransport(), realTransports() -> transport[]. A transport's make({maxUsd, perCallUsd,
//           effort, onCall}) -> makeClientFor(vendor), the vendor-correct client Pantheon's pipeline drives.
// Limits    The SDK seats have no USD figure here (model-client carries no price list): they meter provider CALLS, not
//           dollars (spent().usd is 0), so a run that mixes them is bounded in dollars only on the Claude lane and in
//           calls elsewhere (runOpenItem's provider-call cap). Only the Claude command line is reachable where no vendor
//           SDK is installed and no API key a provider accepts is present, which is the state this repo ships in.
// Must never  Read a credential's value into a record; serve a vendor a transport does not list; report a trial live when
//           a synthetic seat served a turn (composeSeats enforces the liveness rule over these descriptors).
import fs from 'node:fs';
import path from 'node:path';
import {claudeCliClients} from './claude-cli.mjs';

/** Resolve a CLI command to a path that exists: an absolute/relative path as given, else searched on PATH. */
export function resolveCli(cli, env = process.env) {
  if (!cli) return null;
  if (cli.includes('/')) return fs.existsSync(cli) ? cli : null;
  return String(env.PATH ?? '').split(':').filter(Boolean).map(d => path.join(d, cli)).find(p => fs.existsSync(p)) ?? null;
}
/** Whether a module specifier resolves in this install (the vendor SDK is present), without importing it. */
export function sdkResolvable(spec) {
  try { import.meta.resolve(spec); return true; } catch { return false; }
}
const present = (env, ...keys) => keys.some(k => typeof env[k] === 'string' && env[k].trim() !== '');

/** The Claude command-line seat: anthropic/api, served by `claude -p` (claude-cli.mjs). Reachable when its CLI resolves. */
export function claudeCliTransport({cli = process.env.OPHANIM_CLAUDE_CLI ?? 'claude', env = process.env, live = false} = {}) {
  return {
    id: 'claude-cli', vendors: ['anthropic'], live: live === true,
    reachable: () => resolveCli(cli, env) !== null,
    make: ({maxUsd = 5, perCallUsd = 0.5, effort = null, onCall = () => {}} = {}) => claudeCliClients({cli, env, maxUsd, perCallUsd, effort, live, onCall}),
  };
}

/**
 * A live SDK seat for one or more vendors, backed by an injected liveClients factory (`open`, async -> makeClientFor).
 * The vendor-correct client (openai responses.create, google models.generateContent, ...) is returned as-is to the
 * pipeline; each generation call is counted (no USD here). `reachable` is injected so the probe stays the caller's.
 */
export function sdkTransport({id, vendors, live = true, reachable, open}) {
  if (!id || !Array.isArray(vendors) || !vendors.length || typeof reachable !== 'function' || typeof open !== 'function') throw new Error('sdkTransport: {id, vendors[], reachable(), open()} required');
  const SURFACES = ['responses', 'messages', 'models'];
  return {
    id, vendors: [...vendors], live: live === true, reachable: () => reachable() === true,
    make: ({effort = null, onCall = () => {}} = {}) => {
      let openP = null; const ensure = () => (openP ??= open());   // the liveClients factory is built once, lazily
      let calls = 0; const rows = [];
      const makeClientFor = vendor => {
        if (!vendors.includes(vendor)) throw new Error(`${id} does not serve ${vendor}`);
        const surface = name => new Proxy({}, {get: (_t, method) => async (...args) => {
          const mk = await ensure(); const client = await mk(vendor, {});
          const r = await client[name][method](...args);
          calls++; const row = {vendor, effort, outcome: 'ok', cost_usd: 0, served_by: id}; rows.push(row); onCall(row);
          return r;
        }});
        return Object.fromEntries(SURFACES.map(s => [s, surface(s)]));
      };
      makeClientFor.providers = {kind: live === true ? 'live' : 'synthetic', transport: id};
      makeClientFor.calls = rows;
      makeClientFor.spent = () => ({usd: 0, calls});
      return makeClientFor;
    },
  };
}

/** The live liveClients factory, lazily imported so this module loads with no vendor SDK present. */
const liveClientsFactory = async () => (await import('../../pantheon/src/sdk/live.mjs')).liveClients();

/**
 * All four labs: the Claude command line, the OpenAI/xAI API, and agy_google. The API seats are reachable only when their
 * SDK is installed AND a credential for them is present (PRESENCE only); agy_google is also reachable through the agy CLI.
 */
export function realTransports({env = process.env, live = true, open = liveClientsFactory} = {}) {
  return [
    claudeCliTransport({env, live}),
    sdkTransport({id: 'live-api', vendors: ['openai', 'xai'], live,
      reachable: () => sdkResolvable('openai') && present(env, 'OPENAI_API_KEY', 'XAI_API_KEY'), open}),
    sdkTransport({id: 'agy', vendors: ['agy_google'], live,
      reachable: () => (sdkResolvable('@google/genai') && present(env, 'GEMINI_API_KEY', 'GOOGLE_API_KEY')) || resolveCli(env.PANTHEON_AGY_CLI ?? 'agy', env) !== null, open}),
  ];
}
