// MODEL IDENTITY for review independence (owner direction 2026-11-17: exclude the actual models that contributed to
// the reviewed work, not every model of their lab; keep three distinct labs on the panel).
//
// THE POLICY. Everything that decides "which model is this, and which lab made it" is one value, an identity policy
// (IDENTITY_POLICY_SCHEMA): the same-model map, the lab of every declared model, the lab of every direct vendor, the
// vendors that are routes, and the snapshot rule. `currentPolicy()` builds it from the configuration files. A cycle
// opened under pantheon.cycle/v3 RECORDS the whole policy with its digest (cycle-kinds.mjs), and every check of that
// cycle uses the recorded policy, never the files: editing the configuration cannot change how a recorded ledger
// verifies. A later correction is new evidence (`reassess`), recorded as such.
//
// RESOLUTION. `resolveModel(vendor, model, policy)` -> {id, lab, base, known, why}:
//   - the name is reduced to its base model: `same_model` (effort, thinking, lane and alias names), then a trailing
//     date snapshot (-YYYYMMDD) is dropped;
//   - the LAB is the base model's own (`model_lab`), whatever vendor or route reached it. It is never inferred from
//     the transport: a model the policy does not declare is UNRESOLVED (known: false, lab: null, id: null);
//   - a direct vendor (not a route) can only serve its own lab's models; any other pairing is unresolved.
// An unresolved name is never treated as a different model, and never as a model of the vendor's lab.
//
// Must never: treat two effort levels, aliases, snapshots, sessions or routes of one model as two reviewers; take a
// model's lab from the route that served it; qualify a reviewer whose identity is unresolved; or let the current
// configuration change the verdict on a recorded cycle.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { canonical } from "../../../packages/ledger/canonical.mjs";
import { MODELS, LANES } from "../config/models.mjs";

export const IDENTITY_POLICY_SCHEMA = "pantheon.identity-policy/v1";
const FILE = join(dirname(fileURLToPath(import.meta.url)), "../config/model-identity.json");
const str = v => typeof v === "string" && v.trim() !== "";
const SNAPSHOT = /-\d{8}$/;
// The policy's `resolver` number is the version of its ADMISSION rule, pinned with the rest on each cycle:
//   1  (cycles recorded before the review of 10cbd52) an answer that names no serving model was taken to have been
//      served by the model asked for. Kept only so those cycles verify as they were recorded.
//   2  an answer is admitted only on the identity of the model that ANSWERED: a missing, blank or unresolved
//      serving model does not qualify, and the model asked for is never evidence of which model answered.
//   3  (owner direction 2026-11-17) as 2, and a ROUTE is seated only for the labs the policy lists for it
//      (`route_labs`): Antigravity serves Gemini models only. A seat on a route for a model of any other lab is not
//      asked and its answer is not admitted. Contributors are still resolved by model, whatever route reached them.
export const RESOLVER = 3;
export const RESOLVERS = Object.freeze([1, 2, 3]);

/** A base model name under `policy`: lower case, through `same_model`, without a date snapshot (applied to a fixpoint). */
function baseOf(model, policy) {
  let m = String(model).trim().toLowerCase();
  for (let i = 0; i < 8; i++) {
    const next = (policy.same_model[m] ?? m).replace(SNAPSHOT, "");
    if (next === m) break;
    m = next;
  }
  return m;
}

/** The policy the configuration files describe now. Built once per process. */
function build() {
  const rules = JSON.parse(readFileSync(FILE, "utf8"));
  const same_model = Object.fromEntries(Object.entries(rules.same_model ?? {}).map(([k, v]) => [k.toLowerCase(), String(v.model).toLowerCase()]));
  const routes = [...(rules.routes ?? [])].sort();
  const bare = { same_model };
  const model_lab = {};
  const declare = (model, lab, from) => {
    const b = baseOf(model, bare);
    if (model_lab[b] && model_lab[b] !== lab) throw new Error(`identity policy: ${b} is declared for ${model_lab[b]} and for ${lab} (${from})`);
    model_lab[b] = lab;
  };
  for (const [m, lab] of Object.entries(rules.model_lab ?? {})) declare(m, lab, "model-identity.json");
  // models.json: a vendor's own registry. A route has no registry of its own models here.
  for (const [vendor, names] of Object.entries(MODELS)) for (const id of Object.values(names)) declare(id, vendor, "models.json");
  // lanes.json: each lane model names its lab.
  for (const lane of Object.values(LANES)) for (const [m, spec] of Object.entries(lane)) declare(m, spec.lab, "lanes.json");
  const vendor_lab = Object.fromEntries(Object.keys(MODELS).filter(v => !routes.includes(v)).sort().map(v => [v, v]));
  const route_labs = Object.fromEntries(Object.entries(rules.route_labs ?? {}).sort().map(([v, labs]) => [v, [...labs].sort()]));
  for (const v of Object.keys(route_labs)) if (!routes.includes(v)) throw new Error(`identity policy: route_labs names ${v}, which is not a route`);
  const policy = { schema: IDENTITY_POLICY_SCHEMA, resolver: RESOLVER, snapshot: "-YYYYMMDD", same_model, model_lab: Object.fromEntries(Object.entries(model_lab).sort()), vendor_lab, routes, route_labs };
  return Object.freeze(policy);
}
let CURRENT = null;
export const currentPolicy = () => (CURRENT ??= build());
export const policyDigest = policy => "sha256:" + createHash("sha256").update(canonical(policy)).digest("hex");
/** Why `policy` is not a usable identity policy, or null. */
export function policyRefusal(policy) {
  const map = (o, ok) => o && typeof o === "object" && !Array.isArray(o) && Object.entries(o).every(([k, v]) => str(k) && ok(v));
  return policy?.schema === IDENTITY_POLICY_SCHEMA && RESOLVERS.includes(policy.resolver) && map(policy.same_model, str) && map(policy.model_lab, str)
    && map(policy.vendor_lab, str) && Array.isArray(policy.routes) && policy.routes.every(str)
    && (policy.resolver >= 3 ? map(policy.route_labs, v => Array.isArray(v) && v.every(str)) : policy.route_labs === undefined) ? null
    : `an identity policy is a ${IDENTITY_POLICY_SCHEMA} object {resolver, same_model, model_lab, vendor_lab, routes} (and route_labs from resolver 3)`;
}

/** Resolve a model reached through `vendor`. Unresolved: {known: false, id: null, lab: null, why}. */
export function resolveModel(vendor, model, policy = currentPolicy()) {
  if (!str(model)) return null;
  const base = baseOf(model, policy), lab = policy.model_lab[base] ?? null;
  const no = why => ({ id: null, lab: null, base, known: false, why });
  if (!lab) return no(`"${model}" is not a model this identity policy declares: its lab is not inferred from the ${vendor ?? "unknown"} route`);
  if (str(vendor) && !policy.routes.includes(vendor)) {
    const own = policy.vendor_lab[vendor] ?? null;
    if (!own) return no(`"${vendor}" is not a vendor this identity policy declares`);
    if (own !== lab) return no(`${base} is a ${lab} model and cannot have been served by the ${vendor} vendor directly`);
  }
  return { id: `${lab}/${base}`, lab, base, known: true, why: null };
}
/** Kept name: the identity of a model (see resolveModel). */
export const modelIdentity = resolveModel;

/** Why a seat on `vendor` may not be seated for a model of `lab` under `policy` (resolver 3: route_labs), or null. */
function routeRefusal(vendor, lab, policy) {
  const allowed = policy.route_labs?.[vendor];
  return allowed && !allowed.includes(lab) ? `the ${vendor} route is seated for ${allowed.join(", ")} models only, and this is a ${lab} model` : null;
}

/**
 * What a set of contributions excludes from reviewing:
 *   models      the contributing models, by identity (the requested and the served model of a turn both count);
 *   labs        the labs of contributions that name a lab and no model (an explicit lab, not an inference);
 *   unresolved  contributions whose model name the policy cannot resolve. Nothing can be said about who may review
 *               such work, so no panel qualifies until the name is declared.
 * Returns {models, labs, unresolved, contributing_labs}, sorted.
 */
export function contributorKeys(contributions = [], policy = currentPolicy()) {
  const models = new Set(), labs = new Set(), all = new Set(), unresolved = new Map();
  for (const c of contributions) {
    const names = [...new Set([c.model, c.served_model, c.requested_model].filter(str))];
    if (!names.length) { if (str(c.lab)) { labs.add(c.lab); all.add(c.lab); } else unresolved.set(`${c.vendor ?? "?"}/-`, { vendor: c.vendor ?? null, model: null, why: "a contribution that names neither a model nor a lab" }); continue; }
    for (const m of names) {
      const r = resolveModel(c.vendor, m, policy);
      if (r.known) { models.add(r.id); all.add(r.lab); } else unresolved.set(`${c.vendor ?? "?"}/${m}`, { vendor: c.vendor ?? null, model: m, why: r.why });
    }
  }
  return { models: [...models].sort(), labs: [...labs].sort(), unresolved: [...unresolved.values()], contributing_labs: [...all].sort() };
}

/**
 * BEFORE A CALL: may this seat be ASKED? Only the model asked for is known. It must resolve, and must not be a
 * contributor. Returns {lab, id} or {why, code}.
 */
export function candidateIdentity(seat, policy = currentPolicy()) {
  const asked = resolveModel(seat.vendor, seat.model, policy);
  if (!asked?.known) return { code: "UNRESOLVED", why: `the seat's identity is unresolved: ${asked?.why ?? "no model is named"}` };
  const route = routeRefusal(seat.vendor, asked.lab, policy);
  if (route) return { code: "ROUTE_LAB", why: route };
  return { lab: asked.lab, id: asked.id };
}
/** Why `seat` ({vendor, model}) may not be asked to review work with contributor `keys`, or null. */
export function candidateRefusal(seat, keys, policy = currentPolicy()) {
  if ((keys.unresolved ?? []).length) return `a contributor's identity is unresolved (${keys.unresolved.map(u => u.model ?? u.vendor).join(", ")}): no reviewer can be shown not to be it`;
  const who = candidateIdentity(seat, policy);
  if (who.why) return who.why;
  if ((keys.labs ?? []).includes(who.lab)) return `the ${who.lab} lab is excluded: a contribution from it names no model`;
  return (keys.models ?? []).includes(who.id) ? `${who.id} contributed to the change under review and may not review it` : null;
}

/**
 * AFTER A CALL: the identity an ANSWER is admitted under, or why it is not. `answer` is {vendor, model, served_model}:
 * the model asked for and the model that answered. Both must resolve, to the SAME lab; the lab a review counts for is
 * that lab. Under resolver 2 the serving model must be NAMED: the model asked for is not evidence of which model
 * answered. Returns {lab, ids} or {why, code}.
 */
export function reviewerIdentity(answer, policy = currentPolicy()) {
  const asked = resolveModel(answer.vendor, answer.model, policy);
  if (!asked?.known) return { code: "UNRESOLVED", why: `the reviewer's identity is unresolved: ${asked?.why ?? "no model is named"}` };
  const route = routeRefusal(answer.vendor, asked.lab, policy);
  if (route) return { code: "ROUTE_LAB", why: route };
  let served;
  if (str(answer.served_model)) served = resolveModel(answer.vendor, answer.served_model, policy);
  else if (policy.resolver >= 2) return { code: "NO_SERVED_IDENTITY", why: `the answer names no serving model: ${asked.id} was asked, and that is not evidence of which model answered` };
  else served = asked;   // resolver 1, for cycles recorded under it
  if (!served.known) return { code: "UNRESOLVED", why: `the model that answered is unresolved: ${served.why}` };
  if (served.lab !== asked.lab) return { code: "LAB_MISMATCH", why: `${asked.id} was asked and ${served.id} answered: a review counts for one lab` };
  return { lab: served.lab, ids: [...new Set([asked.id, served.id])] };
}

/** Why an ANSWER may not count as a review of work with contributor `keys` ({models, labs, unresolved?}), or null. */
export function reviewerRefusal(answer, keys, policy = currentPolicy()) {
  if ((keys.unresolved ?? []).length) return `a contributor's identity is unresolved (${keys.unresolved.map(u => u.model ?? u.vendor).join(", ")}): no reviewer can be shown not to be it`;
  const who = reviewerIdentity(answer, policy);
  if (who.why) return who.why;
  if ((keys.labs ?? []).includes(who.lab)) return `the ${who.lab} lab is excluded: a contribution from it names no model`;
  const hit = who.ids.find(i => (keys.models ?? []).includes(i));
  return hit ? `${hit} contributed to the change under review and may not review it` : null;
}

/**
 * NEW EVIDENCE, never a change of history: which recorded reviews of a v3 cycle would not qualify under another
 * policy (by default the current one). `reviews` are {seat: {vendor}, model, served_model, hash}; `cycle` the cycle
 * payload. Returns {policy: digest, recorded: digest, changed, findings: [{review, why}]}.
 */
export function reassess({ cycle, reviews, policy = currentPolicy() }) {
  const keys = contributorKeys(cycle.contributors ?? [], policy);
  const findings = [];
  for (const r of reviews) {
    const why = reviewerRefusal({ vendor: r.seat.vendor, model: r.model, served_model: r.served_model ?? null }, keys, policy);
    if (why) findings.push({ review: r.hash, why });
  }
  const labsNow = reviews.map(r => reviewerIdentity({ vendor: r.seat.vendor, model: r.model, served_model: r.served_model ?? null }, policy).lab ?? null);
  if (new Set(labsNow.filter(Boolean)).size < labsNow.length && !findings.length) findings.push({ review: null, why: "under this policy two of the reviews count for one lab" });
  return { policy: policyDigest(policy), recorded: cycle.identity_policy?.digest ?? null, changed: policyDigest(policy) !== (cycle.identity_policy?.digest ?? null), findings };
}
