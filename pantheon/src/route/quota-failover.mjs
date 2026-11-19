// THE WALK OVER A SEAT'S CANDIDATES, with the one rule the shared router does not know (owner direction 2026-11-17):
// a candidate marked `quota_failover` -- the metered Gemini API id of an Antigravity lane's base model -- is reached
// ONLY after one of the lanes it stands behind was refused for QUOTA: an attempt that packages/model-client
// classifyFailure classifies `quota` (HTTP 429 without an interval, or a quota-exhausted code), or that lane's quota
// authority already in a recorded quota cooldown. Any other lane failure (a transient error, a timeout, a wrong
// answer) never moves the turn to the metered API: the candidate is skipped and the walk continues past it.
//
// Everything else is routeCall's own behaviour, one candidate at a time: a non-retryable error is thrown as it is, a
// refused pool is not offered twice in one walk, and every refusal is written to the cooldown store.
//
// QUOTA AUTHORITY. A lane spends from the operator's Antigravity login, per base model; the API id spends from an API
// key. They are two authorities under one vendor name, so a lane's cooldown is keyed `agy_cli_oauth:<base model>` and
// never closes (or is closed by) the API pool. The recorded `pool` of a seat is unchanged.
import { routeCall, classifyFailure } from "../../../packages/model-client/index.mjs";
import { laneParts } from "./fit-matrix.mjs";

export const cooldownKeyOf = c => (c.transport === "agy-cli" ? `agy_cli_oauth:${laneParts(c.model)?.base ?? c.model}` : c.pool);

// METERED GEMINI AT THE POINT OF SPEND (L-504 invariant 4, L-124). With the metered Gemini failover OFF (the live-run
// manifest's billing.metered_gemini_failover: false, carried as meteredFailover / METERED_FAILOVER) NO seat makes a
// metered Google call: not the quota failover of a lane (skipped in the walk below), and not any other Google-billed seat
// either -- an operator's or a ticket pin's Gemini API seat (agy_google over the API: sdk/adapter.mjs's genai client,
// billed to GEMINI_API_KEY), or the python Antigravity SDK seat (scripts/agy-seat.py, billed to GEMINI_API_KEY or
// Vertex). The seat refuses itself immediately before the billed request or spawn, before it is admitted or charged,
// whatever key the environment holds: withholding the key upstream (ophanim/operate/live-run.mjs "not-used") is not what
// protects it. The Antigravity CLI lanes are the subscription (OAuth) and are never refused here.
// THE ANTIGRAVITY SDK TRANSPORT (owner direction 2026-11-19: the Google implementer is the google-antigravity SDK on the
// Gemini API) is a metered Google call from its first request, so it is one of these seats: with the switch off the
// implementer seat refuses itself before its transport is entered (pipeline/turns.mjs). It alone can be authorized BY
// NAME beside the switch (pipelineTurns {antigravity: {geminiApi: true}}; the live-run manifest's
// billing.gemini_api_implementer), because a `fit` run cannot implement without it: that authorization covers this
// transport's own billing and nothing else, and every other Google-billed seat still follows the switch.
/** The vendors whose API seat is billed to the metered Gemini key (sdk/adapter.mjs ADAPTERS: key_env GEMINI_API_KEY). */
export const METERED_GEMINI_VENDORS = Object.freeze(["agy_google"]);
export const METERED_GEMINI_DISABLED = "METERED_GEMINI_DISABLED";
export const METERED_GEMINI_RULE = "metered Gemini spend disabled by the caller (meteredFailover: false): no Google-billed seat is called";
/** The transports billed to the metered Gemini key: "api" the vendor SDK, "sdk" the python Antigravity SDK seat, "antigravity-sdk" the SDK implementer transport. */
export const METERED_GEMINI_TRANSPORTS = Object.freeze(["api", "sdk", "antigravity-sdk"]);
/** Is a call on `vendor` over `transport` (METERED_GEMINI_TRANSPORTS) a metered Gemini call? */
export const isMeteredGemini = ({ vendor, transport = "api" }) => METERED_GEMINI_VENDORS.includes(vendor) && METERED_GEMINI_TRANSPORTS.includes(transport);
/** The refusal of a metered Gemini call with the failover off: code METERED_GEMINI_DISABLED, nothing was sent or charged. */
export function meteredGeminiRefusal({ vendor, model, purpose = null, transport = "api" }) {
  const via = transport === "sdk" ? "the python Antigravity SDK seat (API key or Vertex billed)" : transport === "antigravity-sdk" ? "the Antigravity SDK transport (the Gemini API, billed to its key)" : "the metered Gemini API";
  return Object.assign(new Error(`${vendor}/${model}${purpose ? ` (${purpose})` : ""} would be served by ${via}, and metered Gemini spend is disabled for this run (meteredFailover: false): the seat is refused before it is admitted, charged or called`),
    { code: METERED_GEMINI_DISABLED, provider_requests: 0, transport, quota_failover: { used: false, disabled: true, lanes: [], rule: METERED_GEMINI_RULE } });
}

//
// `meteredFailover: false` (the caller's budget allows no metered Gemini spend): a `quota_failover` candidate is never
// reached, even after its lane's quota refusal; it is skipped (onSkip says why) and the walk goes on past it. The
// switch existed for the pipeline and the single-turn seats but not here, so runOpenItem's walk could still call the
// metered API (independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 6).
// `admit` is routeCall's: called before every attempt, retries included (finding 1.1).
export async function routeSeats({ candidates, invoke, cooldown = null, signal, deadline, maxAttempts, onSkip = () => {}, meteredFailover = true, admit = undefined }) {
  if (!Array.isArray(candidates) || !candidates.length || typeof invoke !== "function") throw new Error("Routing needs candidates and invoke");
  if (typeof meteredFailover !== "boolean") throw new Error("meteredFailover is true or false");
  const quota = new Map();      // lane model -> the quota refusal observed for it
  const closed = new Set(), attempts = [];
  for (const c of candidates) {
    const key = cooldownKeyOf(c);
    let seat = c;
    if (c.quota_failover && !meteredFailover) {
      onSkip({ seat: c, why: `quota failover of ${c.quota_failover.lanes.join(", ")} not used: the metered Gemini API failover is disabled for this run` });
      continue;
    }
    if (c.quota_failover) {
      const evidence = c.quota_failover.lanes.map(m => quota.get(m)).filter(Boolean);
      if (!evidence.length) {
        onSkip({ seat: c, why: `quota failover of ${c.quota_failover.lanes.join(", ")} not used: no quota refusal of that lane` });
        continue;
      }
      const used = { ...c.quota_failover, used: true, after: evidence };
      seat = { ...c, quota_failover: used, selection: c.selection ? { ...c.selection, quota_failover: { ...c.selection.quota_failover, ...used } } : c.selection };
    }
    if (closed.has(key)) continue;
    const view = cooldown ? { get: () => cooldown.get(key), refuse: (_p, row) => cooldown.refuse(key, row), success: () => cooldown.success(key) } : undefined;
    // A lane whose quota authority is already in a recorded QUOTA cooldown is quota evidence without a new call.
    if (c.transport === "agy-cli" && cooldown) {
      const held = await cooldown.get(key);
      if (held?.until > Date.now() && held.reason === "quota") quota.set(c.model, { lane: c.model, outcome: "quota", source: "cooldown", cooldown: key, until: held.until });
    }
    try {
      const routed = await routeCall({ candidates: [seat], cooldown: view, signal, ...(deadline === undefined ? {} : { deadline }), ...(maxAttempts === undefined ? {} : { maxAttempts }),
        ...(admit === undefined ? {} : { admit }),
        invoke: async (s, ctx) => {
          try { return await invoke(s, ctx); }
          catch (e) {
            if (c.transport === "agy-cli" && classifyFailure(e).quota) quota.set(c.model, { lane: c.model, outcome: "quota", source: "attempt", status: e?.status ?? null, code: e?.code ?? null, why: String(e?.message ?? e).slice(0, 200) });
            throw e;
          }
        } });
      return { ...routed, attempts: [...attempts, ...routed.attempts], quota_failover: seat.quota_failover?.used ? seat.quota_failover : null };
    } catch (e) {
      if (e?.code !== "POOLS_UNAVAILABLE") throw e;
      attempts.push(...(e.attempts ?? []));
      closed.add(key);
    }
  }
  throw Object.assign(new Error("All configured credential pools unavailable"), { code: "POOLS_UNAVAILABLE", attempts });
}
