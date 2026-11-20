// The live provider seats, built at the edge: the vendor SDKs are imported here, lazily, and nowhere else in the
// pipeline (runOpenItem takes makeClientFor; the review cycle, the planner and the validator take turn).
//
// liveClients(): makeClientFor(vendor, {pool, poolConfig}) for the work seats, one client per vendor and pool,
// marked {providers: {kind: "live"}} so a run records that live providers answered.
// liveTurn(): turn({vendor, model, prompt, signal?, charge?, admitRequest?, billing?}) for single-turn seats; an incomplete
// reply is an error, never a text. `signal` reaches the request (API) or the CLI process (lane). TWO CHARGE CONTRACTS
// (docs/routing-task-profile.md, "What one provider call is"; self-audit round 3, assignment 3 (sealed bb1287a), L-301):
//   charge        the caller charged the turn's first provider call BEFORE calling turn(); `charge` admits every FURTHER one
//                 (a continuation hop, a compaction, a lane's metered failover) before it is sent.
//   admitRequest  the caller charged NOTHING up front; `admitRequest({kind})` is called before EVERY provider call at its
//                 point of spend: the API's first request and each further one (kind "request"/"continuation"), the
//                 lane's CLI process between its jail build and its spawn (kind "lane": a lane turn that fails before
//                 the spawn is charged nothing), and a metered failover (kind "failover"). A throw refuses the call.
// When both are given, admitRequest wins.
// THE GEMINI BILLING POLICY (register L-136; route/gemini-billing.mjs, docs/billing-policy.md): `billing` is the context
// (policy + persistent usage record) every billed Gemini request of these seats is admitted by, at its point of spend,
// BEFORE the charge contract above admits it and before it is sent: a primary Gemini API seat's every request
// (gemini_api_primary) and a lane's quota failover and its further requests (metered_gemini_failover). Default: both
// kinds off. A call may carry its own `billing` (a lifecycle stage's: the work ledger under its claim), which wins.
// apiTurn(): the same API seat with no Antigravity lane in front of it (pantheon-review-cycle, pantheon-compare's cycle
// review): a Gemini seat there is PRIMARY Gemini API execution, admitted by gemini_api_primary request by request.
// Nothing here calls a provider until a seat is used.
import { agySingleTurn, laneFirstTurn } from "./agy-turn.mjs";
import { geminiAdmission, isMeteredGemini, spendGemini } from "../route/quota-failover.mjs";
import { seatTransport } from "../route/frontier.mjs";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GEMINI_BILLING_INVALID, GEMINI_KINDS, FLAG_OF, SETTING_OF, USAGE_FLAG, billingFlagsFromArgv, billingRecord, geminiBilling, geminiUsageFile }
  from "../route/gemini-billing.mjs";
import { GENERATION_METHODS } from "../../../packages/model-client/index.mjs";

export async function liveClients() {
  const [{ default: OpenAI }, { GoogleGenAI }, { default: Anthropic }, { makeClient }] = await Promise.all([
    import("openai"), import("@google/genai"), import("@anthropic-ai/sdk"), import("./adapter.mjs")]);
  const clients = {};
  const make = (v, { pool = v, poolConfig } = {}) => (clients[`${v}:${pool}`] ??= makeClient(v, { OpenAI, GoogleGenAI, Anthropic, poolConfig }));
  make.providers = { kind: "live" };
  return make;
}

// The API seat: one unary turn through the vendor SDK. For a Gemini vendor every generation request (the first and each
// continuation hop or compaction) passes the billing policy (`billingKind`: "primary", or "failover" when it answers a
// lane's quota refusal) before the caller's own admission and before it is sent; `firstAdmitted`: the caller already
// spent the first request through the policy (laneFirstTurn's failover).
async function apiSeat(label) {
  const [{ default: OpenAI }, { GoogleGenAI }, { default: Anthropic }, { makeClient, sendTurn }] = await Promise.all([
    import("openai"), import("@google/genai"), import("@anthropic-ai/sdk"), import("./adapter.mjs")]);
  const clients = new Map();
  // `extra` carries per-seat request options (e.g. reasoning.context for an OpenAI reviewer); only OpenAI receives it.
  // `signal` aborts the in-flight request (a stage stopped at its elapsed budget does not wait for it).
  return async ({ vendor, model, prompt, extra = null, signal = undefined, charge = null, admitRequest = null, seat = null, billing = null, billingKind = "primary", firstAdmitted = false }) => {
    const gemini = isMeteredGemini({ vendor, transport: "api" });
    const spend = { kind: billingKind, vendor, model, purpose: label, role: seat?.role ?? null, transport: "api" };
    // Checked before the client is made, so a refused seat is refused by the policy, never by a missing key.
    if (gemini && !firstAdmitted) geminiAdmission(billing, spend);
    if (!clients.has(vendor)) clients.set(vendor, makeClient(vendor, { OpenAI, GoogleGenAI, Anthropic }));
    signal?.throwIfAborted();
    // Every billed request after the turn's first (a continuation hop, a compaction) is charged before it is sent; a
    // refused charge refuses it (independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 1.1).
    const own = request => (typeof admitRequest === "function" ? admitRequest({ kind: request === 1 ? "request" : "continuation" })
      : typeof charge === "function" && request > 1 ? charge("continuation") : undefined);
    const onRequest = gemini
      ? ({ request }) => { if (!(request === 1 && firstAdmitted)) spendGemini(billing, { ...spend, request }, () => own(request)); }
      : typeof admitRequest === "function" ? ({ request }) => own(request) : typeof charge === "function" ? () => charge("continuation") : null;
    const r = await sendTurn({ client: clients.get(vendor), vendor, model, prompt, label: `${vendor}-${label}`,
      ...(vendor === "openai" && extra && Object.keys(extra).length ? { extra } : {}), ...(signal ? { signal } : {}),
      ...(onRequest ? { onRequest, chargeFirstRequest: gemini || typeof admitRequest === "function" } : {}) });
    if (r.complete === false) throw new Error(`${vendor}/${model}: the reply did not complete (${r.terminal_state ?? "unknown"})`);
    // sendTurn's served_model is the model named by the provider's own response: marked "provider" (a pipeline seat
    // labels a served name with no source "unknown", pipeline/turns.mjs).
    const named = typeof r.served_model === "string" && r.served_model.trim() !== "";
    return { text: r.text ?? "", response_id: r.response_id ?? null, served_model: r.served_model ?? null, served_model_source: named ? "provider" : null };
  };
}

// `billing`: the Gemini billing context of these seats (route/gemini-billing.mjs geminiBilling; default both kinds off).
export async function liveTurn({ label = "cycle-review", billing = null, ...rest } = {}) {
  if (Object.hasOwn(rest, "meteredFailover")) throw new Error("liveTurn: meteredFailover is replaced by `billing` (the Gemini billing policy, route/gemini-billing.mjs)");
  const api = await apiSeat(label);
  // A declared Antigravity lane is not an API id: it is served by the agy CLI (agy-turn.mjs). A Gemini seat goes
  // through its lane first; the metered API answers only as that lane's 429/quota failover (laneFirstTurn), or as PRIMARY
  // Gemini API execution for a Gemini seat with no lane -- each admitted by the billing policy.
  const turn = args => laneFirstTurn({ ...args, billing: args?.billing ?? billing }, { lane: agySingleTurn, api });
  turn.providers = { kind: "live" };
  return turn;
}

/** The API seat with no lane in front of it: a Gemini seat here is PRIMARY Gemini API execution (gemini_api_primary). */
export async function apiTurn({ label = "cycle-review", billing = null } = {}) {
  const api = await apiSeat(label);
  const turn = args => api({ ...args, billing: args?.billing ?? billing, billingKind: "primary", firstAdmitted: false });
  turn.providers = { kind: "live" };
  return turn;
}

/**
 * AN INJECTED SINGLE-TURN MODULE (an entry point's `--turn MODULE`, e.g. pantheon/bin/cycle-review-http-turn.mjs, which
 * calls the Gemini API itself): the entry point cannot see the module's requests, so a call on a Gemini seat that is NOT
 * a declared Antigravity lane is PRIMARY Gemini API execution, ONE billed request per call, admitted by the billing
 * policy and recorded before the module is called (refused: the module is not called). A lane-named seat is the
 * module's lane (the subscription) and passes through; the call's own `billing` (a lifecycle stage's) reaches the
 * module, so a module built on liveTurn applies the failover policy itself.
 * A MODULE THAT DECLARES ITS GEMINI CALLS METERED (`turn.meteredGeminiApi === true`; register L-146) has no lane: every
 * call it makes on a Gemini seat is charged as primary, a lane-named seat included. bin/cycle-review-http-turn.mjs sends
 * every agy_google call to the Gemini API whatever the model is named, so passing a lane-named model through as a
 * subscription lane billed the metered API outside the policy (found by the coordinator, 2026-11-20). A declaration
 * can only add charges: no module can declare a Gemini API id seat unbilled. `purpose` names the caller on the record.
 */
export function billedTurnModule(turn, billing = null, { purpose = "injected turn module" } = {}) {
  if (typeof turn !== "function") return turn;
  const metered = turn.meteredGeminiApi === true;
  const wrapped = async args => {
    const bill = args?.billing ?? billing;
    if (isMeteredGemini({ vendor: args?.vendor, transport: "api" }) && (metered || seatTransport(args.vendor, args.model) !== "agy-cli")) {
      spendGemini(bill, { kind: "primary", vendor: args.vendor, model: args.model, purpose, role: args.seat?.role ?? null, transport: "api" });
    }
    return turn({ ...args, ...(bill ? { billing: bill } : {}) });
  };
  return Object.assign(wrapped, turn.providers ? { providers: turn.providers } : {});
}

const invalidScript = why => Object.assign(new Error(`${GEMINI_BILLING_INVALID}: ${why}`), { code: GEMINI_BILLING_INVALID, usage: true });
/**
 * THE OPERATOR SCRIPTS' POINT OF SPEND (register L-146; docs/billing-policy.md, "Operator scripts"): bin/cross-lab-review.mjs
 * and scripts/live-check, live-ship, stream-check and view-check take the Gemini billing policy here and nowhere else --
 * the L-136 mechanism (billingFromFlags, geminiBilling, geminiUsageFile, spendGemini), not one per script. Invoking a
 * script authorizes nothing: both kinds are off unless its own argv says otherwise.
 *
 *   rawArgv   the script's argv; `--gemini-api-primary N`, `--metered-gemini-failover N` and `--gemini-usage FILE` are
 *             taken out (route/gemini-billing.mjs billingFlagsFromArgv) and `argv` is the rest, for the script's own parsing.
 *   runDir    (argv) => the script's natural run directory, or null. With one (the cross-lab review directory, live-ship's
 *             board) the usage record is <runDir>/gemini-billing.jsonl, so a re-run on the same directory counts what was
 *             already spent, and --gemini-usage is refused. Without one, enabling either kind REQUIRES --gemini-usage FILE:
 *             the operator chooses whether a budget spans invocations; there is no silent default location.
 *   make      (vendor) => the vendor client, built the script's own way (sdk/adapter.mjs makeClient); for clientFor.
 *
 * A malformed flag, an enabled kind without its record, or --gemini-usage beside a run directory is GEMINI_BILLING_INVALID
 * at startup: printed, exit 2, nothing runs. Returns {argv, billing, clientFor, shown}:
 *   clientFor(vendor, {model, purpose, role})  a metered Gemini vendor's client is admitted as PRIMARY Gemini API
 *             execution (gemini_api_primary) BEFORE `make` is called -- before any credential is read, so a missing key, a
 *             proxy placeholder and a present key all give the policy's refusal -- and every generation request its client
 *             sends afterwards (GENERATION_METHODS.models: the first of a turn, each continuation hop, the next turn) is
 *             spent through spendGemini, admitted, charged and persisted on the usage record, before the SDK sends it.
 *             Token counts are not billed and are not charged (L-604). Any other vendor's client is make(vendor), unchanged.
 *   shown()   the record: the policy with its source, the record's path, the usage per kind, the rows, the refusals.
 * The record is printed (`gemini_billing {...}`) whenever the process exits, however it ends, and appended with a run
 * directory to <runDir>/gemini-billing-runs.jsonl, so the refusals of every invocation stay as evidence.
 */
export function operatorGemini(rawArgv, { script, runDir = null, make = null } = {}) {
  let argv, billing, dir = null;
  try {
    const parsed = billingFlagsFromArgv(rawArgv);
    argv = parsed.argv;
    dir = typeof runDir === "function" ? runDir(argv) ?? null : null;
    if (dir && parsed.usage !== null) throw invalidScript(`${script} keeps its usage record in its run directory (${join(dir, "gemini-billing.jsonl")}); ${USAGE_FLAG} is not taken here`);
    const file = dir ? join(dir, "gemini-billing.jsonl") : parsed.usage !== null ? resolve(parsed.usage) : null;
    const enabled = GEMINI_KINDS.filter(k => parsed.policy[SETTING_OF[k]].enabled);
    if (enabled.length && !file) {
      throw invalidScript(`${enabled.map(k => FLAG_OF[k]).join(" and ")} given without ${USAGE_FLAG} FILE: ${script} keeps no usage record of its own, `
        + "so the operator names the file its budget is counted from (one invocation or several); nothing runs");
    }
    billing = geminiBilling({ policy: parsed.policy, ledger: file ? geminiUsageFile(file) : null });
  } catch (e) {
    if (e?.code !== GEMINI_BILLING_INVALID) throw e;
    console.error(`${script}: ${e.message}`);
    process.exit(2);
  }
  const used = k => { try { return billing.ledger ? billing.ledger.used(k) : 0; } catch { return null; } };
  const shown = () => ({ script, ...billingRecord(billing), used: Object.fromEntries(GEMINI_KINDS.map(k => [k, used(k)])) });
  process.once("exit", code => {
    const rec = { ...shown(), exit: code, at: new Date().toISOString() };
    console.log(`gemini_billing ${JSON.stringify(rec)}`);
    if (dir) { try { appendFileSync(join(dir, "gemini-billing-runs.jsonl"), JSON.stringify(rec) + "\n"); } catch { /* the printed record stands */ } }
  });
  const made = new Map();
  const client = vendor => { if (!made.has(vendor)) made.set(vendor, make(vendor)); return made.get(vendor); };
  const clientFor = (vendor, { model = null, purpose = script, role = null } = {}) => {
    if (typeof make !== "function") throw new Error(`${script}: operatorGemini was given no client factory`);
    if (!isMeteredGemini({ vendor, transport: "api" })) return client(vendor);
    const spend = { kind: "primary", vendor, model, purpose, role, transport: "api" };
    geminiAdmission(billing, spend);
    const real = client(vendor);
    const models = Object.create(real.models);
    let request = 0;
    for (const m of GENERATION_METHODS.models) {
      const send = real.models[m].bind(real.models);
      models[m] = async (req, ...more) => { spendGemini(billing, { ...spend, model: req?.model ?? model, request: ++request }); return send(req, ...more); };
    }
    return Object.assign(Object.create(real), { models });
  };
  return { argv, billing, clientFor, shown };
}
