// THE GEMINI BILLING POLICY (register L-136, extending L-124; owner decisions 2026-11-19; docs/billing-policy.md is the
// single description). ONE policy, resolved HERE and nowhere else, re-exported by route/quota-failover.mjs (the L-124
// mechanism it extends), and enforced at every point of Gemini spend through geminiAdmission / spendGemini below.
//
//   metered_gemini_failover  the metered Gemini API answering an Antigravity lane's PROVEN QUOTA REFUSAL (kind "failover")
//   gemini_api_primary       PRIMARY Gemini API or SDK execution: a Gemini API id seat with no lane in front of it, an
//                            operator's or a ticket's Gemini API pin, the python Antigravity SDK seat (kind "primary")
//
// Both default to OFF when absent. Each is enabled only by an explicit CLI flag (`--metered-gemini-failover N`,
// `--gemini-api-primary N`, N the budget) or a supported configuration setting ({enabled: true, budget: N}). NO
// environment variable and NO credential presence is read here: a GEMINI_API_KEY (or GOOGLE_API_KEY, or Vertex) in the
// environment authorizes nothing. Enabling either REQUIRES a declared budget, a positive integer of BILLED GEMINI
// REQUESTS of that kind; enabling without one is refused at startup (GEMINI_BILLING_INVALID: nothing runs). The two
// settings are independent: the failover switch never authorizes a primary seat, and the primary setting never
// authorizes a failover. The subscription (OAuth) Antigravity CLI lanes are not billed requests and are never refused by
// either setting.
//
// AT THE POINT OF SPEND, before every billed Gemini request (a continuation hop and a retry are requests too):
//   1. geminiAdmission: refused when the kind is off (METERED_GEMINI_DISABLED, GEMINI_PRIMARY_DISABLED) or when the
//      PERSISTED usage of that kind has reached its budget (METERED_GEMINI_BUDGET_EXHAUSTED, carrying the kind). Nothing
//      is admitted, charged, spawned or sent; the refusal is on the context's `refusals` and on the error (`billing`,
//      provider_requests: 0).
//   2. the caller's own admission (its provider-call bound and its charge: admitRequest / admitProviderCall / charge);
//   3. the usage row is PERSISTED on the billing ledger (the work ledger under operate, a usage file beside the run
//      record elsewhere) -- all before the request is sent. Consumption is always derived from that persisted record,
//      never from process memory, so a restart, a resumed attempt or a later service tick cannot reset a budget.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const GEMINI_BILLING_SCHEMA = "ophanim.gemini-billing/v1";
export const GEMINI_KINDS = Object.freeze(["failover", "primary"]);
/** The owner's setting name of each kind, and the CLI flag that enables it (its value is the budget). */
export const SETTING_OF = Object.freeze({ failover: "metered_gemini_failover", primary: "gemini_api_primary" });
export const FLAG_OF = Object.freeze({ failover: "--metered-gemini-failover", primary: "--gemini-api-primary" });
export const METERED_GEMINI_DISABLED = "METERED_GEMINI_DISABLED";
export const GEMINI_PRIMARY_DISABLED = "GEMINI_PRIMARY_DISABLED";
export const METERED_GEMINI_BUDGET_EXHAUSTED = "METERED_GEMINI_BUDGET_EXHAUSTED";
/** A startup refusal: an enabled setting without a budget, a malformed flag or setting. Nothing runs. */
export const GEMINI_BILLING_INVALID = "GEMINI_BILLING_INVALID";
/** The refusals made at the point of spend. */
export const GEMINI_BILLING_REFUSALS = Object.freeze([METERED_GEMINI_DISABLED, GEMINI_PRIMARY_DISABLED, METERED_GEMINI_BUDGET_EXHAUSTED]);
const DISABLED_CODE = Object.freeze({ failover: METERED_GEMINI_DISABLED, primary: GEMINI_PRIMARY_DISABLED });

const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = why => { throw Object.assign(new Error(`${GEMINI_BILLING_INVALID}: ${why}`), { code: GEMINI_BILLING_INVALID, usage: true }); };

function settingOf(kind, d) {
  const name = SETTING_OF[kind];
  if (d === undefined || d === null) return Object.freeze({ enabled: false, budget: null, source: "default: absent, off" });
  if (!plain(d)) invalid(`${name} is {enabled, budget}`);
  const unknown = Object.keys(d).filter(k => !["enabled", "budget", "source"].includes(k));
  if (unknown.length) invalid(`${name}: unknown key(s) ${unknown.join(", ")} (it is {enabled, budget})`);
  if (typeof d.enabled !== "boolean") invalid(`${name}.enabled is true or false`);
  if (typeof d.source !== "string" || !d.source.trim()) invalid(`${name} names where it was declared`);
  if (d.enabled) {
    if (!(Number.isSafeInteger(d.budget) && d.budget > 0)) {
      invalid(`${name} is enabled (${d.source}) without a declared budget: a positive integer of billed Gemini requests is required, and nothing runs without it`);
    }
  } else if (d.budget !== undefined && d.budget !== null) invalid(`${name} declares a budget (${d.source}) but is not enabled`);
  return Object.freeze({ enabled: d.enabled, budget: d.enabled ? d.budget : null, source: d.source });
}

/**
 * THE ONE RESOLUTION. `failover` / `primary`: undefined (absent: off) or {enabled, budget?, source}. Returns the frozen
 * policy {schema, metered_gemini_failover: {enabled, budget, source}, gemini_api_primary: {...}, digest}; `digest` covers
 * what is enforced (enabled and budget of each kind), not where it was declared.
 */
export function resolveGeminiBilling({ failover, primary } = {}) {
  const f = settingOf("failover", failover), p = settingOf("primary", primary);
  const digest = "sha256:" + createHash("sha256").update(JSON.stringify({ failover: [f.enabled, f.budget], primary: [p.enabled, p.budget] })).digest("hex");
  return Object.freeze({ schema: GEMINI_BILLING_SCHEMA, [SETTING_OF.failover]: f, [SETTING_OF.primary]: p, digest });
}
/** Both kinds off: the policy whenever nothing is declared. */
export const GEMINI_BILLING_OFF = resolveGeminiBilling();
const isPolicy = p => plain(p) && p.schema === GEMINI_BILLING_SCHEMA && GEMINI_KINDS.every(k => plain(p[SETTING_OF[k]])) && typeof p.digest === "string";
/** The policy as a record carries it (no function, no ledger). */
export const policyRecord = p => ({ digest: p.digest, ...Object.fromEntries(GEMINI_KINDS.map(k => [SETTING_OF[k], { ...p[SETTING_OF[k]] }])) });

/**
 * The two CLI flags, from an entry point's parsed options (`opts["metered-gemini-failover"]`, `opts["gemini-api-primary"]`:
 * the budget as written). A flag enables its kind with that budget; its value must be a positive integer.
 */
export function billingFromFlags(opts = {}) {
  const declared = {};
  for (const kind of GEMINI_KINDS) {
    const flag = FLAG_OF[kind], raw = opts?.[flag.slice(2)];
    if (raw === undefined || raw === null) continue;
    const s = String(raw);
    if (!/^[1-9]\d*$/.test(s)) invalid(`${flag} takes its budget, a positive integer of billed Gemini requests (got ${JSON.stringify(raw)}); enabling without a budget is refused`);
    declared[kind] = { enabled: true, budget: Number(s), source: `flag ${flag} ${s}` };
  }
  return resolveGeminiBilling(declared);
}

/** A configuration block {metered_gemini_failover?: {enabled, budget?}, gemini_api_primary?: {enabled, budget?}}, declared at `where`. */
export function billingFromConfig(block, where) {
  if (block === undefined || block === null) return GEMINI_BILLING_OFF;
  if (!plain(block)) invalid(`${where} is an object {${Object.values(SETTING_OF).join(", ")}}`);
  const known = Object.values(SETTING_OF);
  const unknown = Object.keys(block).filter(k => !known.includes(k));
  if (unknown.length) invalid(`${where}: unknown key(s) ${unknown.join(", ")} (it holds ${known.join(" and ")})`);
  const declared = {};
  for (const kind of GEMINI_KINDS) {
    const b = block[SETTING_OF[kind]];
    if (b === undefined) continue;
    if (!plain(b)) invalid(`${where}.${SETTING_OF[kind]} is {enabled, budget}`);
    if (Object.hasOwn(b, "source")) invalid(`${where}.${SETTING_OF[kind]}: unknown key(s) source (it is {enabled, budget})`);
    declared[kind] = { ...b, source: `${where}.${SETTING_OF[kind]}` };
  }
  return resolveGeminiBilling(declared);
}

/**
 * A PERSISTENT USAGE RECORD in a file: one JSON line per billed Gemini request, appended and fsynced BEFORE the request
 * is sent. Consumption is counted from the file every time it is asked (never cached), so a restart cannot reset it. A
 * line that does not parse fails closed: consumption cannot be derived, so no billed request is admitted.
 */
export function geminiUsageFile(file) {
  const rows = () => {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l, i) => {
      let r = null;
      try { r = JSON.parse(l); } catch { r = null; }
      if (r?.schema !== GEMINI_BILLING_SCHEMA || !GEMINI_KINDS.includes(r.kind)) {
        throw Object.assign(new Error(`${GEMINI_BILLING_INVALID}: the Gemini usage record ${file} is unreadable at line ${i + 1}: consumption cannot be derived, so no billed request is admitted`), { code: GEMINI_BILLING_INVALID });
      }
      return r;
    });
  };
  const record = row => {
    mkdirSync(dirname(file), { recursive: true });
    const fd = openSync(file, "a");
    try { writeSync(fd, JSON.stringify(row) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  };
  return Object.freeze({ where: file, used: kind => rows().filter(r => r.kind === kind).length, rows, record });
}

/**
 * THE BILLING CONTEXT a run carries to its points of spend: the policy, the ledger its usage is persisted on, and the
 * refusals and rows of THIS context (in memory, for the run's own record; never the source of a budget). An enabled kind
 * needs a ledger: without a persistent record no billed request could be counted, so none is allowed.
 */
export function geminiBilling({ policy = GEMINI_BILLING_OFF, ledger = null } = {}) {
  if (!isPolicy(policy)) invalid("the billing policy is the one resolveGeminiBilling() returns");
  const enabled = GEMINI_KINDS.filter(k => policy[SETTING_OF[k]].enabled);
  if (enabled.length && !(ledger && typeof ledger.used === "function" && typeof ledger.record === "function")) {
    invalid(`${enabled.map(k => SETTING_OF[k]).join(" and ")} enabled with no persistent usage record: no billed Gemini request could be counted, so none is allowed`);
  }
  return { policy, ledger, refusals: [], rows: [] };
}
const contextOf = billing => (billing && isPolicy(billing.policy) ? billing : geminiBilling());

/** Is this error a refusal of the billing policy (at the point of spend, or a lane quota refusal it annotated)? */
export const isGeminiBillingRefusal = e => GEMINI_BILLING_REFUSALS.includes(e?.code) || GEMINI_BILLING_REFUSALS.includes(e?.billing?.code);
/** The billing kind of a Gemini API or SDK call: "failover" only when it answers a lane's proven quota refusal. */
export const geminiKindOf = ({ quota_failover = null } = {}) => (quota_failover?.used ? "failover" : "primary");

function refusal(ctx, code, info, message) {
  const row = { code, ...info, provider_requests: 0, at: new Date().toISOString() };
  ctx.refusals.push(row);
  return Object.assign(new Error(message), { code, provider_requests: 0, billing: row });
}

/**
 * THE CHECK AT THE POINT OF SPEND, before a billed Gemini request of `kind` is admitted: throws the refusal, or returns
 * the usage row the request will be recorded with. Records nothing.
 */
export function geminiAdmission(billing, { kind, vendor, model, purpose = null, role = null, transport = "api", request = 1 }) {
  const ctx = contextOf(billing), policy = ctx.policy;
  const name = SETTING_OF[kind];
  if (!name) throw new Error(`geminiAdmission: the billing kind is ${GEMINI_KINDS.join(" or ")}, got ${kind}`);
  const set = policy[name];
  const via = kind === "failover" ? "the metered Gemini API as an Antigravity lane's quota failover"
    : transport === "sdk" ? "primary Gemini execution on the python Antigravity SDK seat (billed to GEMINI_API_KEY or Vertex)" : "primary Gemini API execution (billed to GEMINI_API_KEY)";
  const info = { kind, setting: name, vendor, model, purpose, role, transport, source: set.source, budget: set.budget, policy: policy.digest };
  const who = `${vendor}/${model}${purpose ? ` (${purpose})` : ""}`;
  if (!set.enabled) {
    throw refusal(ctx, DISABLED_CODE[kind], info, `${DISABLED_CODE[kind]}: ${who} would be served by ${via}, and ${name} is off (${set.source}); `
      + "a Gemini key in the environment authorizes nothing: the request is refused before it is admitted, charged, spawned or sent");
  }
  const used = ctx.ledger.used(kind);
  if (used >= set.budget) {
    throw refusal(ctx, METERED_GEMINI_BUDGET_EXHAUSTED, { ...info, used }, `${METERED_GEMINI_BUDGET_EXHAUSTED}: ${who} would be served by ${via}, and the ${name} budget of ${set.budget} billed `
      + `request(s) (${set.source}) is spent: ${used} recorded at ${ctx.ledger.where ?? "the usage record"}; the request is refused before it is admitted, charged, spawned or sent`);
  }
  return { schema: GEMINI_BILLING_SCHEMA, ...info, request, used_before: used, remaining_after: set.budget - used - 1, at: new Date().toISOString() };
}

/**
 * THE WHOLE POINT-OF-SPEND SEQUENCE for one billed Gemini request: the policy's admission (refused: nothing else
 * happens), then the caller's own admission `admit(row)` (its call bound and charge; a throw refuses the request), then
 * the usage row persisted on the billing ledger -- all BEFORE the request is sent. Returns the row.
 */
export function spendGemini(billing, args, admit = () => {}) {
  const ctx = contextOf(billing);
  const row = geminiAdmission(ctx, args);
  admit(row);
  try { ctx.ledger.record(row); }
  catch (e) {
    // The persisted record refused it (the work ledger's own budget check under its append lock, a fenced claim): the
    // request is not sent. A budget refusal keeps its code.
    const code = /METERED_GEMINI_BUDGET_EXHAUSTED/.test(String(e?.message)) ? METERED_GEMINI_BUDGET_EXHAUSTED : (e?.code ?? "GEMINI_USAGE_UNRECORDED");
    if (code === METERED_GEMINI_BUDGET_EXHAUSTED) throw refusal(ctx, code, { ...row, used: row.used_before }, `${code}: ${String(e?.message ?? e).slice(0, 400)}`);
    throw Object.assign(new Error(`the usage of ${row.vendor}/${row.model} could not be recorded before the request (${String(e?.message ?? e).slice(0, 300)}): it is not sent`), { code, provider_requests: 0, cause: e });
  }
  ctx.rows.push(row);
  return row;
}

/** A budget refusal as the persisted record states it, shared by the work ledger's re-derivation: null when within. */
export function budgetRefusal({ kind, budget, used }) {
  return Number.isSafeInteger(budget) && budget > 0 && Number.isInteger(used) && used < budget ? null
    : `${METERED_GEMINI_BUDGET_EXHAUSTED}: the ${SETTING_OF[kind] ?? kind} budget of ${budget} billed request(s) is spent (${used} recorded before this one)`;
}

/** What a run's record carries about billing: the policy in force, the rows charged and the refusals made under it. */
export const billingRecord = billing => {
  const ctx = contextOf(billing);
  return { policy: policyRecord(ctx.policy), where: ctx.ledger?.where ?? null, rows: ctx.rows.map(r => ({ ...r })), refusals: ctx.refusals.map(r => ({ ...r })) };
};
