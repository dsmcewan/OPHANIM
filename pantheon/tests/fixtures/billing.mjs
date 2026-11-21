// EXPLICIT OPT-IN TO GEMINI BILLING, for the tests that exercise a metered failover or a primary Gemini seat (register
// L-136, owner decisions 2026-11-19: both kinds default OFF and a key in the environment authorizes nothing). A test that
// relied on the old default (failover on) now declares the policy the way an operator does: enabled, with a budget of
// billed requests, over a persistent usage record of its own. No assertion of those tests is changed by this.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGeminiBilling, geminiBilling, geminiUsageFile } from "../../src/route/gemini-billing.mjs";

const made = [];
process.once("exit", () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const declared = budget => (budget ? { enabled: true, budget, source: "test: explicit opt-in" } : undefined);
/** The resolved policy: `failover` / `primary` are budgets (positive integers), or null for off. */
export const optInPolicy = ({ failover = null, primary = null } = {}) => resolveGeminiBilling({ failover: declared(failover), primary: declared(primary) });
/** A billing context with that policy over a fresh usage file (or `file`). */
export function optIn({ failover = null, primary = null, file = null } = {}) {
  let at = file;
  if (!at) { const d = mkdtempSync(join(tmpdir(), "gemini-billing-")); made.push(d); at = join(d, "usage.jsonl"); }
  return geminiBilling({ policy: optInPolicy({ failover, primary }), ledger: geminiUsageFile(at) });
}
