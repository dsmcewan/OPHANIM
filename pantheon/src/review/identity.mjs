// MODEL IDENTITY for review independence (owner direction 2026-11-17: exclude the actual models that contributed to
// the reviewed work, not every model of their lab; keep three distinct labs on the panel).
//
// A contributor is a MODEL. It stays the same model whatever the effort level, the alias or lane name, the dated
// snapshot id, the session, or the route (vendor) that reached it. `modelIdentity` reduces a (vendor, model) pair to
// `<lab>/<base model>`:
//   - a name declared in config/model-identity.json `same_model` is the model it maps to (effort and lane variants);
//   - a trailing date snapshot (-YYYYMMDD) is dropped;
//   - the lab comes from labOf, so the same model through another vendor's lane is the same identity.
// `known` says whether the base model is one this configuration declares (models.json, lanes.json, or the identity
// file). A contributor whose model is NOT known cannot be told apart from its siblings, so it excludes its whole
// lab: the old rule, kept as the safe fallback. The same holds for a contribution that names no model.
//
// Must never: treat two effort levels, aliases, sessions or routes of one model as two reviewers; or guess that an
// unknown name is a different model.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { MODELS, LANES, labOf } from "../config/models.mjs";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "../config/model-identity.json");
const RAW = readFileSync(FILE, "utf8");
export const IDENTITY_RULES = JSON.parse(RAW);
/** The digest of the identity rules a cycle was opened under (recorded on the cycle, for audit). */
export const IDENTITY_RULES_DIGEST = "sha256:" + createHash("sha256").update(RAW).digest("hex");

const baseOf = model => {
  let m = String(model).trim().toLowerCase();
  for (let i = 0; i < 4 && IDENTITY_RULES.same_model[m]; i++) m = IDENTITY_RULES.same_model[m].model;
  return m.replace(/-\d{8}$/, "");
};
const DECLARED = new Set([...Object.values(MODELS).flatMap(names => Object.values(names)), ...Object.values(LANES).flatMap(lane => Object.keys(lane)),
  ...Object.values(IDENTITY_RULES.same_model).map(x => x.model), ...(IDENTITY_RULES.declared_elsewhere ?? [])].map(baseOf));

/** {id, lab, base, known} for a model reached through `vendor`. */
export function modelIdentity(vendor, model) {
  if (typeof model !== "string" || !model.trim()) return null;
  const lab = labOf(vendor, model), base = baseOf(model);
  return { id: `${lab}/${base}`, lab, base, known: DECLARED.has(base) };
}

/**
 * What a set of contributions excludes from reviewing: the contributing MODELS (by identity; the requested and the
 * served model of a turn both count), and the LABS of contributions whose model is unknown or unnamed.
 * Returns {models: [ids], labs: [labs], contributing_labs: [labs]}, each sorted.
 */
export function contributorKeys(contributions = []) {
  const models = new Set(), labs = new Set(), all = new Set();
  for (const c of contributions) {
    const names = [...new Set([c.model, c.served_model, c.requested_model].filter(x => typeof x === "string" && x.trim()))];
    const ids = names.map(m => modelIdentity(c.vendor, m));
    const lab = c.lab ?? ids[0]?.lab ?? (c.vendor ? labOf(c.vendor) : null);
    if (lab) all.add(lab);
    if (!ids.length || ids.some(i => !i.known)) { if (lab) labs.add(lab); }
    for (const i of ids) { models.add(i.id); all.add(i.lab); }
  }
  return { models: [...models].sort(), labs: [...labs].sort(), contributing_labs: [...all].sort() };
}

/** Why `seat` ({vendor, model, served_model?}) may not review under `keys` ({models, labs}), or null. */
export function reviewerRefusal(seat, keys) {
  const lab = labOf(seat.vendor, seat.served_model ?? seat.model);
  if ((keys.labs ?? []).includes(lab)) return `the ${lab} lab is excluded: a contribution from it names no model this configuration can identify`;
  for (const m of [...new Set([seat.model, seat.served_model].filter(Boolean))]) {
    const i = modelIdentity(seat.vendor, m);
    if (i && (keys.models ?? []).includes(i.id)) return `${i.id} contributed to the change under review and may not review it (${m} is that model)`;
  }
  return null;
}
