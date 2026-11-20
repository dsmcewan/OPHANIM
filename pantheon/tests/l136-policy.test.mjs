// REGISTER L-136 (extending L-124): THE ONE GEMINI BILLING POLICY ITSELF (pantheon/src/route/gemini-billing.mjs, re-exported
// by route/quota-failover.mjs; docs/billing-policy.md). Its resolution (both kinds off when absent; a flag or a setting
// enables one kind with its budget; the environment is never read), its startup refusals, and the order at the point of
// spend (the policy, then the caller's admission, then the persisted usage row). Its enforcement through the real entry
// points is pantheon/tests/l136-billing.test.mjs and ophanim/operate/l136-billing.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGeminiBilling, billingFromFlags, billingFromConfig, geminiBilling, geminiUsageFile, geminiAdmission, spendGemini,
  METERED_GEMINI_DISABLED, GEMINI_PRIMARY_DISABLED, METERED_GEMINI_BUDGET_EXHAUSTED, GEMINI_BILLING_INVALID } from "../src/route/quota-failover.mjs";

// Synthetic credentials, and names that LOOK like an authorization: the policy reads neither.
const KEYS = { GEMINI_API_KEY: "AIza-l136-synthetic-not-a-key-0000000000", GOOGLE_API_KEY: "AIza-l136-synthetic-not-a-key-1111111111",
  METERED_GEMINI_FAILOVER: "true", GEMINI_API_PRIMARY: "100", PANTHEON_METERED_GEMINI_FAILOVER: "1" };
const jsonl = f => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);

test("L-136 policy: both kinds OFF when absent; a flag or a setting enables one kind with its budget; the environment and its keys are never read", () => {
  const off = resolveGeminiBilling();
  assert.deepEqual([off.metered_gemini_failover.enabled, off.gemini_api_primary.enabled], [false, false]);
  const saved = Object.fromEntries(Object.keys(KEYS).map(k => [k, process.env[k]]));
  Object.assign(process.env, KEYS);
  try {
    // A key and look-alike variables in the environment: nothing declared is still nothing admitted.
    const p = billingFromFlags({});
    assert.equal(p.digest, off.digest);
    assert.throws(() => geminiAdmission(geminiBilling({ policy: p }), { kind: "failover", vendor: "agy_google", model: "gemini-4-carbon" }), e => e.code === METERED_GEMINI_DISABLED && e.provider_requests === 0);
    assert.throws(() => geminiAdmission(geminiBilling({ policy: p }), { kind: "primary", vendor: "agy_google", model: "gemini-4-carbon" }), e => e.code === GEMINI_PRIMARY_DISABLED && e.provider_requests === 0);
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  const f = billingFromFlags({ "metered-gemini-failover": "3" });
  assert.deepEqual([f.metered_gemini_failover, f.gemini_api_primary.enabled], [{ enabled: true, budget: 3, source: "flag --metered-gemini-failover 3" }, false], "the failover flag never enables primary");
  const p = billingFromConfig({ gemini_api_primary: { enabled: true, budget: 2 } }, "service config x billing");
  assert.deepEqual([p.gemini_api_primary.budget, p.gemini_api_primary.source, p.metered_gemini_failover.enabled], [2, "service config x billing.gemini_api_primary", false], "the primary setting never enables the failover");
  assert.notEqual(f.digest, p.digest);
});

test("L-136 policy: enabling without a budget is refused at startup (GEMINI_BILLING_INVALID), as is a budget without its setting or an unknown key", () => {
  for (const bad of ["0", "-1", "1.5", "true", "yes", "", " 2", "1e3"]) {
    assert.throws(() => billingFromFlags({ "gemini-api-primary": bad }), e => e.code === GEMINI_BILLING_INVALID, JSON.stringify(bad));
    assert.throws(() => billingFromFlags({ "metered-gemini-failover": bad }), e => e.code === GEMINI_BILLING_INVALID, JSON.stringify(bad));
  }
  for (const block of [{ metered_gemini_failover: { enabled: true } }, { gemini_api_primary: { enabled: true, budget: 0 } }, { gemini_api_primary: { enabled: "yes", budget: 2 } },
    { metered_gemini_failover: { enabled: false, budget: 3 } }, { metered_gemini_failover: true }, { other: {} }, { gemini_api_primary: { enabled: true, budget: 2, source: "me" } }, []]) {
    assert.throws(() => billingFromConfig(block, "config"), e => e.code === GEMINI_BILLING_INVALID, JSON.stringify(block));
  }
  assert.throws(() => geminiBilling({ policy: billingFromFlags({ "gemini-api-primary": "2" }) }), e => e.code === GEMINI_BILLING_INVALID, "an enabled kind with no persistent usage record admits nothing");
});

test("L-136 policy at the point of spend: the policy first, then the caller's admission, then the usage row persisted; a budget is counted from the record, so a new process cannot reset it", () => {
  const dir = mkdtempSync(join(tmpdir(), "l136-policy-"));
  try {
    const file = join(dir, "usage.jsonl"), order = [];
    const ledger = geminiUsageFile(file);
    const record = row => { order.push("record"); ledger.record(row); };
    const billing = geminiBilling({ policy: billingFromFlags({ "metered-gemini-failover": "2" }), ledger: { where: file, used: ledger.used, record } });
    const args = { kind: "failover", vendor: "agy_google", model: "gemini-4-carbon", purpose: "critique", role: "reviewer" };
    const row = spendGemini(billing, args, () => order.push("admit"));
    assert.deepEqual(order, ["admit", "record"], "admitted by the caller, then recorded: both before the caller sends");
    assert.deepEqual([row.kind, row.budget, row.used_before, row.remaining_after, row.source], ["failover", 2, 0, 1, "flag --metered-gemini-failover 2"]);
    // A caller that refuses (its own bound) leaves nothing recorded.
    order.length = 0;
    assert.throws(() => spendGemini(billing, args, () => { order.push("admit"); throw new Error("PROVIDER_CALL_LIMIT"); }), /PROVIDER_CALL_LIMIT/);
    assert.deepEqual([order, jsonl(file).length], [["admit"], 1]);
    spendGemini(billing, args, () => {});
    // Exhausted: refused BEFORE the caller's admission, recorded on the context, nothing persisted.
    order.length = 0;
    assert.throws(() => spendGemini(billing, args, () => order.push("admit")), e => e.code === METERED_GEMINI_BUDGET_EXHAUSTED && e.billing.kind === "failover" && e.billing.used === 2 && e.provider_requests === 0);
    assert.deepEqual([order, jsonl(file).length, billing.refusals.at(-1).code], [[], 2, METERED_GEMINI_BUDGET_EXHAUSTED]);
    // "A restart": a new context over the same record (a new process) sees the same consumption.
    const again = geminiBilling({ policy: billingFromFlags({ "metered-gemini-failover": "2" }), ledger: geminiUsageFile(file) });
    assert.throws(() => geminiAdmission(again, args), e => e.code === METERED_GEMINI_BUDGET_EXHAUSTED);
    // The other kind has its own budget, never this one's.
    assert.equal(geminiUsageFile(file).used("primary"), 0);
    // An unreadable record fails closed: consumption cannot be derived, so nothing is admitted.
    writeFileSync(file, "not json\n", { flag: "a" });
    assert.throws(() => geminiAdmission(geminiBilling({ policy: billingFromFlags({ "metered-gemini-failover": "9" }), ledger: geminiUsageFile(file) }), args), e => e.code === GEMINI_BILLING_INVALID);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

