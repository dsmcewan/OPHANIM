// Capability records: cited or UNRECORDED, never inferred; and every place the code disagrees is named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS } from "../src/config/models.mjs";
import { FACTS, capabilityDrift } from "../src/config/facts.mjs";

const VENDOR_DOCS = /^https:\/\/(developers\.openai\.com|docs\.x\.ai|aistudio\.google\.com|platform\.claude\.com)\//;
const adapterVendor = v => (v === "google" ? "agy_google" : v);

test("every registry model has a record, and every figure is cited or UNRECORDED", () => {
  for (const [vendor, names] of Object.entries(MODELS)) for (const model of Object.values(names)) {
    const f = FACTS.models[model];
    assert.ok(f, `${model} has no capability record`);
    assert.equal(f.vendor, adapterVendor(vendor), `${model} vendor`);
    for (const key of ["window", "output", "efforts"]) {
      const field = f[key];
      if (field === "UNRECORDED") continue;
      assert.match(field.source ?? "", VENDOR_DOCS, `${model}.${key} must cite the vendor's own docs`);
      assert.ok(typeof field.quote === "string" && field.quote.length > 0, `${model}.${key} must carry the quoted text`);
    }
  }
});

// The disagreements found on 2026-11-16. Each is a decision to make, not a fact to overwrite silently;
// fixing one means removing it here, and a new one fails this test until it is examined.
const KNOWN_DRIFT = [
  "gemini-3.5-flash:deprecated",
  "gemini-3.8-flash-high:not-an-api-id",
  "gpt-6-astra:efforts",
  "gpt-6-astra:router-effort",
  "gpt-6-luna:router-effort",
  "gpt-6-sol:router-effort",
  "gpt-6.1-sol:router-effort",
  "grok-4.3:efforts",
  "grok-4.7:efforts",
];

test("the code's disagreements with the cited facts are exactly the known list", () => {
  const drift = capabilityDrift();
  assert.deepEqual(drift.map(d => d.id), KNOWN_DRIFT, JSON.stringify(drift, null, 1));
});

test("drift is computed: a changed figure in the code is caught", () => {
  const capabilities = { "gpt-6-astra": { window: 999, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] } };
  assert.deepEqual(capabilityDrift({ capabilities, seatFacts: {} }).filter(d => d.id.startsWith("gpt-6-astra")).map(d => d.id), ["gpt-6-astra:window"]);
});
