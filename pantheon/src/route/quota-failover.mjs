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

// METERED GEMINI AT THE POINT OF SPEND (L-504 invariant 4, L-124; extended by L-136). THE BILLING POLICY is resolved
// in ./gemini-billing.mjs (re-exported here: this is the one mechanism, not a second one) and enforced at every point of
// Gemini spend: a lane's quota failover (kind "failover", setting metered_gemini_failover) and PRIMARY Gemini execution
// (kind "primary", setting gemini_api_primary): an operator's or a ticket pin's Gemini API id seat (agy_google over the
// API: sdk/adapter.mjs's genai client, billed to GEMINI_API_KEY), a Gemini seat with no lane, and the python Antigravity
// SDK seat (scripts/agy-seat.py, billed to GEMINI_API_KEY or Vertex). Both default OFF; each is enabled only by an
// explicit flag or setting with a declared budget, never by a key in the environment. The seat refuses itself
// immediately before the billed request or spawn, before it is admitted or charged: withholding the key upstream
// (ophanim/operate/live-run.mjs "not-used") is not what protects it. The Antigravity CLI lanes are the subscription
// (OAuth) and are never refused here.
export * from "./gemini-billing.mjs";
import { geminiAdmission, isGeminiBillingRefusal } from "./gemini-billing.mjs";
/** The vendors whose API seat is billed to the metered Gemini key (sdk/adapter.mjs ADAPTERS: key_env GEMINI_API_KEY). */
export const METERED_GEMINI_VENDORS = Object.freeze(["agy_google"]);
/** Is a call on `vendor` over `transport` ("api": the vendor SDK; "sdk": the python Antigravity SDK seat) a metered Gemini call? */
export const isMeteredGemini = ({ vendor, transport = "api" }) => METERED_GEMINI_VENDORS.includes(vendor) && (transport === "api" || transport === "sdk");

//
// `billing` (the run's billing context, gemini-billing.mjs geminiBilling; default: both kinds off): a `quota_failover`
// candidate is reached only after a quota refusal of a lane it stands behind AND only while the policy admits a failover
// request (metered_gemini_failover enabled, its budget not spent); otherwise it is skipped (onSkip says why; a billing
// refusal is also on billing.refusals) and the walk goes on past it. The switch existed for the pipeline and the
// single-turn seats but not here, so runOpenItem's walk could still call the metered API (independent review round 2,
// assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 6). The seat is checked again at its point of spend,
// request by request (board/run-item.mjs turn()).
// `admit` is routeCall's: called before every attempt, retries included (finding 1.1).
export async function routeSeats({ candidates, invoke, cooldown = null, signal, deadline, maxAttempts, onSkip = () => {}, billing = null, admit = undefined, ...rest }) {
  if (!Array.isArray(candidates) || !candidates.length || typeof invoke !== "function") throw new Error("Routing needs candidates and invoke");
  if (Object.hasOwn(rest, "meteredFailover")) throw new Error("routeSeats: meteredFailover is replaced by `billing` (the Gemini billing policy, route/gemini-billing.mjs)");
  const quota = new Map();      // lane model -> the quota refusal observed for it
  const closed = new Set(), attempts = [];
  for (const c of candidates) {
    const key = cooldownKeyOf(c);
    let seat = c;
    if (c.quota_failover) {
      const evidence = c.quota_failover.lanes.map(m => quota.get(m)).filter(Boolean);
      if (!evidence.length) {
        onSkip({ seat: c, why: `quota failover of ${c.quota_failover.lanes.join(", ")} not used: no quota refusal of that lane` });
        continue;
      }
      // The lane WAS refused for quota: the failover is a billed request, admitted only by the policy (off by default).
      try { geminiAdmission(billing, { kind: "failover", vendor: c.vendor, model: c.model, purpose: c.role ?? null, role: c.role ?? null, transport: "api" }); }
      catch (e) {
        if (!isGeminiBillingRefusal(e)) throw e;
        onSkip({ seat: c, code: e.code, why: `quota failover of ${c.quota_failover.lanes.join(", ")} not used: ${e.message}` });
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
