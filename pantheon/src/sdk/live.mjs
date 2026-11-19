// The live provider seats, built at the edge: the vendor SDKs are imported here, lazily, and nowhere else in the
// pipeline (runOpenItem takes makeClientFor; the review cycle, the planner and the validator take turn).
//
// liveClients(): makeClientFor(vendor, {pool, poolConfig}) for the work seats, one client per vendor and pool,
// marked {providers: {kind: "live"}} so a run records that live providers answered.
// liveTurn(): turn({vendor, model, prompt, signal?, charge?}) for single-turn seats; an incomplete reply is an error, never a
// text. `signal` reaches the request (API) or the CLI process (lane); `charge` admits a metered failover (laneFirstTurn).
// Nothing here calls a provider until a seat is used.
import { agySingleTurn, laneFirstTurn } from "./agy-turn.mjs";

export async function liveClients() {
  const [{ default: OpenAI }, { GoogleGenAI }, { default: Anthropic }, { makeClient }] = await Promise.all([
    import("openai"), import("@google/genai"), import("@anthropic-ai/sdk"), import("./adapter.mjs")]);
  const clients = {};
  const make = (v, { pool = v, poolConfig } = {}) => (clients[`${v}:${pool}`] ??= makeClient(v, { OpenAI, GoogleGenAI, Anthropic, poolConfig }));
  make.providers = { kind: "live" };
  return make;
}

// `meteredFailover: false`: a Gemini lane's quota refusal is not answered by the metered Gemini API (laneFirstTurn).
export async function liveTurn({ label = "cycle-review", meteredFailover = true } = {}) {
  const [{ default: OpenAI }, { GoogleGenAI }, { default: Anthropic }, { makeClient, sendTurn }] = await Promise.all([
    import("openai"), import("@google/genai"), import("@anthropic-ai/sdk"), import("./adapter.mjs")]);
  const clients = new Map();
  // `extra` carries per-seat request options (e.g. reasoning.context for an OpenAI reviewer); only OpenAI receives it.
  // `signal` aborts the in-flight request (a stage stopped at its elapsed budget does not wait for it).
  const api = async ({ vendor, model, prompt, extra = null, signal = undefined }) => {
    if (!clients.has(vendor)) clients.set(vendor, makeClient(vendor, { OpenAI, GoogleGenAI, Anthropic }));
    signal?.throwIfAborted();
    const r = await sendTurn({ client: clients.get(vendor), vendor, model, prompt, label: `${vendor}-${label}`,
      ...(vendor === "openai" && extra && Object.keys(extra).length ? { extra } : {}), ...(signal ? { signal } : {}) });
    if (r.complete === false) throw new Error(`${vendor}/${model}: the reply did not complete (${r.terminal_state ?? "unknown"})`);
    return { text: r.text ?? "", response_id: r.response_id ?? null, served_model: r.served_model ?? null };
  };
  // A declared Antigravity lane is not an API id: it is served by the agy CLI (agy-turn.mjs). A Gemini seat goes
  // through its lane first; the metered API answers only as that lane's 429/quota failover (laneFirstTurn).
  const turn = args => laneFirstTurn(args, { lane: agySingleTurn, api, failover: meteredFailover });
  turn.providers = { kind: "live" };
  return turn;
}
