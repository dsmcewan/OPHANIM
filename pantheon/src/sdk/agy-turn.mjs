// A SINGLE-TURN seat served through Antigravity (the `agy` CLI lane), for the seats that are not inside a board run:
// the planner, the plan and change reviewers, and the validator. Used by liveTurn (live.mjs) for a seat whose model
// is a declared Antigravity lane (config/lanes.json, transport agy-cli); such a name is not a Gemini API id.
//
// Owner direction 2026-11-17:
//   - Antigravity serves Gemini models only: any other lab is refused before the CLI is launched;
//   - Antigravity returns no serving model. The model is a required input (and runAgyCliTurn fails when the model the
//     CLI reports at start is not the one asked for), so the answer carries that input as its model, marked
//     served_model_source "input": the pinned model, not a statement by the provider about this answer.
//
// The seat reads only its prompt: it is given an empty directory, not the repository under review.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgyCliTurn } from "../board/agy-cli.mjs";
import { resolveModel } from "../review/identity.mjs";
import { classifyFailure } from "../../../packages/model-client/index.mjs";
import { seatTransport, QUOTA_FAILOVER_RULE } from "../route/frontier.mjs";
import { laneFor, laneLevels, quotaFailoverFor } from "../route/fit-matrix.mjs";
import { geminiAdmission, isGeminiBillingRefusal, isMeteredGemini, spendGemini, METERED_GEMINI_DISABLED } from "../route/quota-failover.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The role card a single-turn seat runs under: the planner's for a planner, the reviewer's for every judging seat. */
const cardOf = role => (role === "planner" ? "planner" : "reviewer");

// `signal` (optional) cancels the CLI's process group: a stage stopped at its elapsed budget does not wait for the turn.
// `charge` (optional): the caller's charge for this provider call, made inside runAgyCliTurn BETWEEN its jail build and
// its spawn, so a turn that fails before the CLI is started is charged nothing; a throw refuses the call (self-audit
// round 3, assignment 3 (sealed bb1287a), L-301).
export async function agySingleTurn({ vendor, model, prompt, seat = null, timeoutS = 900, signal = undefined, charge = null }) {
  const made = resolveModel(vendor, model);
  if (!made?.known || made.lab !== "google") {
    throw Object.assign(new Error(`the Antigravity transport serves Gemini models only: ${model} is ${made?.known ? `a ${made.lab} model` : "not a declared model"}`), { code: "AGY_GEMINI_ONLY" });
  }
  const cli = process.env.PANTHEON_AGY_CLI ?? join(homedir(), ".local", "bin", "agy");
  if (cli.includes("/") && !existsSync(cli)) throw new Error(`agy seat: CLI absent at ${cli} (set PANTHEON_AGY_CLI)`);
  const empty = mkdtempSync(join(tmpdir(), "pantheon-agy-turn-"));
  try {
    signal?.throwIfAborted();
    const r = await runAgyCliTurn({ cli, repo: REPO, worktree: empty, role: cardOf(seat?.role), model, prompt, timeoutS, ...(signal ? { signal } : {}),
      ...(typeof charge === "function" ? { charge: () => charge({ kind: "lane" }) } : {}) });
    return { text: r.text ?? "", response_id: r.response_id ?? null, served_model: model, served_model_source: "input" };
  } finally { rmSync(empty, { recursive: true, force: true }); }
}

/**
 * GEMINI THROUGH ANTIGRAVITY FIRST, for a single-turn seat (owner direction 2026-11-17). Pure over `lane` and `api`,
 * the two ways a turn can be served; it imports no SDK.
 *
 *   a seat naming a metered Gemini API id that has an Antigravity lane  -> that lane first (at the seat's effort;
 *                                                                          `high` when it carries none)
 *   a seat naming a lane                                                -> that lane
 *   anything else                                                       -> `api`, unchanged
 *
 * The metered API answers ONLY when the lane attempt was refused for quota (HTTP 429 / quota exhausted, as
 * classifyFailure classifies it), and the answer then says so (`quota_failover`). Any other lane failure is thrown as
 * it is: it never moves the turn to the metered API. A lane whose base model has no API id has no failover.
 */
// THE BILLING POLICY (register L-136; route/gemini-billing.mjs). `billing` (the turn's context: the policy and its
// persistent usage record; default both kinds off) admits every billed Gemini request this turn could make:
//   - the lane's quota failover (kind "failover", metered_gemini_failover): off, or its budget spent, keeps the lane's
//     quota refusal as it is -- thrown, marked quota_failover {used: false, disabled: true (off) | code, refused} and
//     `billing` (the refusal) -- and the metered API is not called;
//   - a Gemini seat with NO declared lane (kind "primary", gemini_api_primary): refused before anything is made or
//     charged unless primary Gemini API execution is enabled, its budget not spent. The failover switch never admits it.
// The subscription lane itself is never refused by either setting.
// THE FAILOVER IS ITS OWN PROVIDER CALL. The caller's `charge()` (in the turn's arguments: the pipeline's admit, the
// lifecycle meter's) is called BEFORE the metered API is asked, after the policy admitted it and before its usage row is
// persisted; a throw refuses the failover (the lane's quota refusal is thrown, marked quota_failover {used: false,
// refused}) and the API is not called. `signal` is passed to the lane and to the API, and an aborted signal refuses the
// failover the same way (independent review, assignment 3 (OpenAI gpt-6-astra extra review, 09d490f), questions 1 and 9).
// `admitRequest` (optional; live.mjs, the second charge contract): nothing was charged before the turn; every provider call
// is admitted at its point of spend -- the lane's (passed to `lane` as `charge`, called between the jail build and the
// spawn), the API's first and further requests, and the failover (admitted here, before the API is asked, with kind
// "failover"; the API then charges only its further requests). It replaces `charge` when given.
export async function laneFirstTurn({ vendor, model, prompt, seat = null, extra = null, signal = undefined, charge = null, admitRequest = null, billing = null }, { lane, api, ...rest }) {
  if (Object.hasOwn(rest, "failover")) throw new Error("laneFirstTurn: the failover switch is replaced by the turn's `billing` (the Gemini billing policy, route/gemini-billing.mjs)");
  const transport = seatTransport(vendor, model);
  const isLane = transport === "agy-cli";
  const sig = signal ? { signal } : {};
  const viaLane = isLane ? { vendor, model } : vendor === "agy_google" && transport === "api" && laneLevels(model).length ? laneFor(model, seat?.effort ?? null) : null;
  // A Gemini seat with NO declared lane can only be answered by the Gemini API: PRIMARY Gemini API execution. Refused here,
  // before the client is made or anything is charged, unless gemini_api_primary admits it (the seat stays unanswered, its
  // stage pending with this reason, rather than silently spending: independent review round 2, assignment 3 (Google
  // gemini-4-carbon, manual, 77480d6), finding 6); every request it then makes is admitted again at its point of spend.
  if (!viaLane && isMeteredGemini({ vendor, transport: "api" })) {
    geminiAdmission(billing, { kind: "primary", vendor, model, purpose: seat?.role ?? null, role: seat?.role ?? null, transport: "api" });
  }
  // `charge` reaches the API seat too: every billed request after the turn's first is admitted by it (finding 1.1).
  const admits = typeof admitRequest === "function";
  const ch = admits ? { charge: () => admitRequest({ kind: "continuation" }) } : typeof charge === "function" ? { charge } : {};
  if (!viaLane) return api({ vendor, model, prompt, seat, extra, ...sig, billing, billingKind: "primary", ...(admits ? { admitRequest } : ch) });
  const spare = isLane ? quotaFailoverFor(model) : { vendor, model, effort: seat?.effort ?? null };
  try {
    const r = await lane({ vendor: viaLane.vendor, model: viaLane.model, prompt, seat, ...sig, ...(admits ? { charge: admitRequest } : {}) });
    return { ...r, transport: "agy-cli", requested_model: model };
  } catch (e) {
    if (!spare || !classifyFailure(e).quota) throw e;
    const after = [{ lane: viaLane.model, outcome: "quota", source: "attempt", status: e?.status ?? null, code: e?.code ?? null, why: String(e?.message ?? e).slice(0, 200) }];
    try {
      signal?.throwIfAborted();
      // The policy first (off or spent: refused, nothing admitted), then the caller's admission, then the usage row.
      spendGemini(billing, { kind: "failover", vendor: spare.vendor, model: spare.model, purpose: seat?.role ?? null, role: seat?.role ?? null, transport: "api", request: 1 },
        () => { if (admits) admitRequest({ kind: "failover" }); else if (typeof charge === "function") charge(); });
    } catch (refusal) {
      const billed = isGeminiBillingRefusal(refusal), off = billed && refusal.code === METERED_GEMINI_DISABLED;
      throw Object.assign(e, { quota_failover: { used: false, ...(off ? { disabled: true } : {}), ...(billed ? { code: refusal.code } : {}), refused: String(refusal?.message ?? refusal).slice(0, 300),
        lanes: [viaLane.model], rule: off ? "metered Gemini API failover disabled by the billing policy (metered_gemini_failover off)" : QUOTA_FAILOVER_RULE, after }, ...(billed ? { billing: refusal.billing } : {}) });
    }
    const r = await api({ vendor: spare.vendor, model: spare.model, prompt, seat, ...sig, billing, billingKind: "failover", firstAdmitted: true, ...ch });
    return { ...r, transport: "api", requested_model: model,
      quota_failover: { used: true, base: spare.model, lanes: [viaLane.model], rule: QUOTA_FAILOVER_RULE,
        after } };
  }
}
