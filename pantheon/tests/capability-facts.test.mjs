// Capability records: cited or UNRECORDED, never inferred; and every place the code disagrees is named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS } from "../src/config/models.mjs";
import { FACTS, capabilityDrift } from "../src/config/facts.mjs";

const VENDOR_DOCS = /^https:\/\/(developers\.openai\.com|docs\.x\.ai|aistudio\.google\.com|platform\.claude\.com)\//;
const OWNER_STATED = /^owner statement \d{4}-\d{2}-\d{2}$/;
const adapterVendor = v => (v === "google" ? "agy_google" : v);

test("every registry model has a record, and every figure is cited or UNRECORDED", () => {
  for (const [vendor, names] of Object.entries(MODELS)) for (const model of Object.values(names)) {
    const f = FACTS.models[model];
    assert.ok(f, `${model} has no capability record`);
    assert.equal(f.vendor, adapterVendor(vendor), `${model} vendor`);
    for (const key of ["window", "output", "efforts"]) {
      const field = f[key];
      if (field === "UNRECORDED") continue;
      // A figure is cited from the vendor's own docs, or it is the OWNER'S DATED STATEMENT and says so (the owner seated
      // gemini-4-hydrogen on 2026-11-17 by stating its figures; no URL is invented for a page nobody read). Nothing else.
      if (OWNER_STATED.test(field.source ?? "")) { assert.match(field.quote ?? "", /^owner-stated \d{4}-\d{2}-\d{2}: /, `${model}.${key}: an owner statement quotes itself as one`); continue; }
      assert.match(field.source ?? "", VENDOR_DOCS, `${model}.${key} must cite the vendor's own docs`);
      assert.ok(typeof field.quote === "string" && field.quote.length > 0, `${model}.${key} must carry the quoted text`);
    }
  }
});

// The disagreements found on 2026-11-16. Each is a decision to make, not a fact to overwrite silently;
// fixing one means removing it here, and a new one fails this test until it is examined.
const KNOWN_DRIFT = [];

test("the code's disagreements with the cited facts are exactly the known list", () => {
  const drift = capabilityDrift();
  assert.deepEqual(drift.map(d => d.id), KNOWN_DRIFT, JSON.stringify(drift, null, 1));
});

test("drift is computed: a changed figure in the code is caught", () => {
  const capabilities = { "gpt-6-astra": { window: 999, output: 128000, efforts: ["low", "medium", "high", "xhigh", "max"] } };
  assert.deepEqual(capabilityDrift({ capabilities, seatFacts: {} }).filter(d => d.id.startsWith("gpt-6-astra")).map(d => d.id), ["gpt-6-astra:window"]);
});

test("gemini-4-hydrogen is in the catalog on the owner's statement: window, output and thinking levels", () => {
  const f = FACTS.models[MODELS.google.hydrogen];
  assert.equal(MODELS.google.hydrogen, "gemini-4-hydrogen");
  assert.deepEqual([f.window.value, f.output.value, f.efforts.values], [1048576, 65536, ["low", "medium", "high", "xhigh"]]);
  for (const key of ["window", "output", "efforts"]) assert.equal(f[key].source, "owner statement 2026-11-17");
  assert.ok(!f.efforts.values.includes("minimal"));
  // The registry owner-stated figures are exactly these models: an owner statement is not a general way around citing.
  const stated = Object.entries(FACTS.models).filter(([, m]) => ["window", "output", "efforts"].some(k => OWNER_STATED.test(m[k]?.source ?? ""))).map(([k]) => k);
  assert.deepEqual(stated, ["gemini-4-hydrogen"]);
});
