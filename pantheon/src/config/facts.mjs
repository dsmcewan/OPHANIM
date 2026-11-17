// Vendor capability facts, read from vendor documentation and cited (capability-facts.json), and the
// places the code disagrees with them. The disagreements are computed, not remembered: a test pins
// the current list, so a new one fails and a fixed one must be removed from the list.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MODELS } from "./models.mjs";
import { CAPABILITIES } from "../../../packages/model-client/index.mjs";
import { SEAT_FACTS } from "../route/router.mjs";
import { effortLadder } from "../role/seating.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FACTS = JSON.parse(readFileSync(join(HERE, "capability-facts.json"), "utf8"));
const value = field => (field && typeof field === "object" && "value" in field ? field.value : undefined);
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

/** Every disagreement between the code and the cited facts, as stable ids with a reason. */
export function capabilityDrift({ facts = FACTS, capabilities = CAPABILITIES, seatFacts = SEAT_FACTS } = {}) {
  const drift = [];
  const add = (id, why) => drift.push({ id, why });
  for (const [vendor, names] of Object.entries(MODELS)) for (const model of Object.values(names)) {
    const f = facts.models[model];
    if (!f) { add(`${model}:no-record`, "registry model has no capability record"); continue; }
    if (f.api_id === false) add(`${model}:not-an-api-id`, "registered as an API model, but the vendor's API docs do not list this id");
    if (typeof f.api_id === "string" && f.api_id.startsWith("deprecated")) add(`${model}:deprecated`, f.api_id);
  }
  for (const [model, cap] of Object.entries(capabilities)) {
    const f = facts.models[model];
    if (!f) { add(`${model}:no-record`, "frontier capability has no cited record"); continue; }
    if (value(f.window) !== undefined && value(f.window) !== cap.window) add(`${model}:window`, `code ${cap.window}, docs ${value(f.window)}`);
    // A configured long-decode bound is in agreement when it lies inside the documented range.
    const ceiling = value(f.output_long_decode) ?? value(f.output);
    if (value(f.output) !== undefined && value(f.output) !== null && cap.output !== null &&
        !(cap.output >= value(f.output) && cap.output <= ceiling))
      add(`${model}:output`, `code ${cap.output}, docs ${value(f.output)}${ceiling !== value(f.output) ? `..${ceiling}` : ""}`);
    if (f.efforts?.values && !sameSet(cap.efforts, f.efforts.values)) add(`${model}:efforts`, `code [${cap.efforts}], docs [${f.efforts.values}]`);
  }
  for (const [vendor, fact] of Object.entries(seatFacts)) for (const [model, window] of Object.entries(fact.windows ?? {})) {
    const f = facts.models[model];
    if (f && value(f.window) !== undefined && value(f.window) !== window) add(`${model}:router-window`, `router ${window}, docs ${value(f.window)}`);
  }
  // The router's escalation ladder may not climb to a value the model's page does not list.
  for (const [model, f] of Object.entries(facts.models)) {
    if (!f.efforts?.values?.length || !seatFacts[f.vendor]) continue;
    const extra = effortLadder(f.vendor, model, seatFacts).filter(v => !f.efforts.values.includes(v));
    if (extra.length) add(`${model}:router-effort`, `escalation ladder reaches [${extra}], which the docs do not list`);
  }
  return drift.sort((a, b) => a.id.localeCompare(b.id));
}
