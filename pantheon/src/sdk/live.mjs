// The live provider seats, built at the edge: the vendor SDKs are imported here, lazily, and nowhere else in the
// pipeline (runOpenItem takes makeClientFor; the review cycle, the planner and the validator take turn).
//
// liveClients(): makeClientFor(vendor, {pool, poolConfig}) for the work seats, one client per vendor and pool,
// marked {providers: {kind: "live"}} so a run records that live providers answered.
// liveTurn(): turn({vendor, model, prompt}) for single-turn seats; an incomplete reply is an error, never a text.
// Nothing here calls a provider until a seat is used.
import { seatTransport } from "../route/frontier.mjs";
import { agySingleTurn } from "./agy-turn.mjs";

export async function liveClients() {
  const [{ default: OpenAI }, { GoogleGenAI }, { default: Anthropic }, { makeClient }] = await Promise.all([
    import("openai"), import("@google/genai"), import("@anthropic-ai/sdk"), import("./adapter.mjs")]);
  const clients = {};
  const make = (v, { pool = v, poolConfig } = {}) => (clients[`${v}:${pool}`] ??= makeClient(v, { OpenAI, GoogleGenAI, Anthropic, poolConfig }));
  make.providers = { kind: "live" };
  return make;
}

export async function liveTurn({ label = "cycle-review" } = {}) {
  const [{ default: OpenAI }, { GoogleGenAI }, { default: Anthropic }, { makeClient, sendTurn }] = await Promise.all([
    import("openai"), import("@google/genai"), import("@anthropic-ai/sdk"), import("./adapter.mjs")]);
  const clients = new Map();
  const turn = async ({ vendor, model, prompt, seat = null }) => {
    // A declared Antigravity lane is not an API id: it is served by the agy CLI (agy-turn.mjs).
    if (seatTransport(vendor, model) === "agy-cli") return agySingleTurn({ vendor, model, prompt, seat });
    if (!clients.has(vendor)) clients.set(vendor, makeClient(vendor, { OpenAI, GoogleGenAI, Anthropic }));
    const r = await sendTurn({ client: clients.get(vendor), vendor, model, prompt, label: `${vendor}-${label}` });
    if (r.complete === false) throw new Error(`${vendor}/${model}: the reply did not complete (${r.terminal_state ?? "unknown"})`);
    return { text: r.text ?? "", response_id: r.response_id ?? null, served_model: r.served_model ?? null };
  };
  turn.providers = { kind: "live" };
  return turn;
}
