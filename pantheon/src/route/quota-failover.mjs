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

export async function routeSeats({ candidates, invoke, cooldown = null, signal, deadline, maxAttempts, onSkip = () => {} }) {
  if (!Array.isArray(candidates) || !candidates.length || typeof invoke !== "function") throw new Error("Routing needs candidates and invoke");
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
