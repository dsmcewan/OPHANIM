// THE COMPOSED SEAT PROVIDER: one makeClientFor(vendor) that serves every lab the foundry's setups admit, each vendor
// dispatched to the transport that can serve it, under one shared spending meter.
//
// Purpose   candidateSetups() (setups.mjs) admits planner/implementer/reviewer seats across every lab the capability
//           graph lists (anthropic, openai, xai, agy_google), then keeps the ones reachable(seat) says this environment
//           can serve. The foundry's CLI wired only the Claude command line, so only Anthropic ran. This module composes
//           a set of TRANSPORTS into the pair the foundry wants -- reachable(seat) and makeClients({setup}) -- so a run
//           uses whichever labs are reachable here and is ready for the rest the moment their transport is.
// A TRANSPORT  {id, vendors: string[], live: boolean, reachable(): boolean, make({maxUsd, perCallUsd, effort, onCall}):
//           makeClientFor}. `vendors` are the lab tokens it serves; `reachable()` is whether it can serve here now (the
//           CLI on PATH, a vendor SDK importable with a credential present); `make()` builds an SDK-shaped provider
//           (claude-cli.mjs or pantheon's liveClients, wrapped). Nothing here imports a vendor SDK or probes a network.
// Inputs    transports; the whole-run spending cap (maxUsd) and per-call cap (perCallUsd); onCall (one row per turn,
//           forwarded to every transport). reachable(seat) reads seat.vendor only.
// Outputs   composeSeats() -> {reachable(seat), makeClients({setup}) -> makeClientFor, transports: status[]}.
//           makeClientFor(vendor) throws when no reachable transport serves the vendor; it carries .providers
//           ({kind, transports}), .spent() (the shared meter) and .calls.
// Invariants  ONE meter for the whole run: every turn of every lab and every effort counts against maxUsd, and a turn
//           is refused (402 FOUNDRY_BUDGET) once the meter reaches it -- the same rule as a single seat (claude-cli.mjs).
//           A trial is `live` only when every reachable transport is live; one synthetic transport makes it synthetic
//           (a run that mixes live and test evidence is test evidence). An unreachable transport never serves and never
//           taints liveness. A vendor is dispatched to the first reachable transport that serves it.
// Must never  Serve a vendor through an unreachable transport; let a transport's own cap mask the shared meter; report a
//           trial live when a synthetic transport served any of its turns.
const fail = (status, message, extra = {}) => Object.assign(new Error(message), {status, ...extra});

/**
 * Compose transports into the foundry's {reachable, makeClients}. `maxUsd` is the whole run's cap, shared across every
 * lab and effort; `perCallUsd` and `onCall` are forwarded to each transport's make().
 */
export function composeSeats({transports = [], maxUsd = 5, perCallUsd = 0.5, onCall = () => {}} = {}) {
  if (!Array.isArray(transports) || !transports.length) throw new Error('composeSeats: pass at least one transport');
  for (const t of transports) if (typeof t?.reachable !== 'function' || typeof t?.make !== 'function' || !Array.isArray(t?.vendors)) throw new Error('composeSeats: a transport is {id, vendors[], live, reachable(), make()}');

  const reachableTransports = () => transports.filter(t => t.reachable());
  const transportFor = vendor => reachableTransports().find(t => t.vendors.includes(vendor)) ?? null;
  const reachable = seat => transportFor(seat?.vendor) !== null;

  // ONE meter for the whole run. Each transport's underlying provider is built once per effort and given the full cap so
  // its own records stay sane; the shared `spent` below is what actually gates, checked before every turn and advanced by
  // what the underlying reports it spent on that turn. `kind` is live only when every reachable transport is live.
  const status = transports.map(t => ({id: t.id, vendors: [...t.vendors], live: t.live === true, reachable: t.reachable()}));
  const reach = reachableTransports();
  const kind = reach.length && reach.every(t => t.live === true) ? 'live' : 'synthetic';

  // The whole run shares one cap. Each transport's underlying provider is built lazily, once per effort, and given the
  // budget REMAINING at that moment (what every already-built provider reports it has spent). Its own meter then refuses
  // past that remainder (claude-cli.mjs raises 402 FOUNDRY_BUDGET), so the cap is shared without wrapping a vendor's
  // generation surface -- which differs by lab (openai responses.create, google models.generateContent) -- and the client
  // the foundry hands to the pipeline is the vendor-correct one, unchanged. Trials run one at a time, so a later vendor's
  // client is built after an earlier one has spent, and the remainder it sees is current.
  const built = new Map();   // `${effort}::${transportId}` -> underlying makeClientFor
  const spentUsd = () => Number([...built.values()].reduce((a, m) => a + (m.spent?.().usd ?? 0), 0).toFixed(6));
  const underlyingFor = (vendor, effort) => {
    const t = transportFor(vendor);
    if (!t) throw fail(400, `no reachable transport serves "${vendor}": ${status.filter(s => s.vendors.includes(vendor)).map(s => `${s.id} (${s.reachable ? 'reachable' : 'not reachable here'})`).join(', ') || 'no transport serves it'}`);
    const key = `${effort ?? ''}::${t.id}`;
    if (!built.has(key)) built.set(key, t.make({maxUsd: Math.max(maxUsd - spentUsd(), 0), perCallUsd, effort: effort ?? null, onCall}));
    return built.get(key);
  };

  const makeClients = ({setup} = {}) => {
    const effort = setup?.effort ?? null;
    const clientFor = vendor => underlyingFor(vendor, effort)(vendor);   // the vendor-correct client, as-is
    clientFor.providers = {kind, transports: status.filter(s => s.reachable).map(s => ({id: s.id, transport: s.id, live: s.live}))};
    clientFor.spent = () => ({usd: spentUsd(), calls: [...built.values()].reduce((a, m) => a + (m.spent?.().calls ?? 0), 0)});
    clientFor.calls = () => [...built.values()].flatMap(m => m.calls ?? []);
    return clientFor;
  };

  return {reachable, makeClients, transports: status};
}
