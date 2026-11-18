// The quota probe's tolerant parser and the quota-failure recogniser (src/agy/quota.mjs).
// EVERY REPORT BELOW IS AN INVENTED FIXTURE: Antigravity documents no output format for `agy -p /quota`; these
// samples only exercise the parser's recognition rules, they are not observed CLI output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQuotaReport, isQuotaFailure, quotaEvidence, probeQuota } from "../src/agy/quota.mjs";
import { agyQuotaRefusal } from "../src/board/agy-cli.mjs";
import { fakeAgy } from "./fixtures/dispatch.mjs";

const SAMPLES = {
  // invented: a plain table with percentages used
  table: "Quota status (refreshed)\n  Gemini 4 Hydrogen\n    5-hour limit:   42% used, resets in 2h 10m\n    Weekly limit:   61% used, resets on Monday\n",
  // invented: a spent five-hour bucket
  spent: "Five-hour usage: 100% used (limit reached), resets in 37m\nWeekly: 80% used\n",
  // invented: phrased as what is left
  left: "5h window: 0% left — resets at 14:00 UTC\n7-day window: 12% left\n",
  // invented: Argon's weekly group, exhausted, counted in requests
  argon: "Argon weekly quota: 0 remaining (resets in 3 days)\nfive hour: 20 requests remaining\n",
  // invented: a JSON-looking variant
  json: JSON.stringify({ quota: { five_hour: { used_percent: 15, resets_at: "2026-11-18T20:00:00Z" }, weekly: { remaining_fraction: 0.4 }, groups: [{ name: "argon weekly", exhausted: true }] } }),
  // invented: nothing recognisable
  noise: "Refreshing quota from the backend...\nDone.\n",
  // invented: a bucket with a bare percentage (direction unknown)
  bare: "Five-hour: 100%\nWeekly: 100%\n",
  // invented: contradicting figures in one bucket
  contradict: "Weekly: 100% used, 20 remaining\n",
  // invented: a negated statement
  negated: "Weekly limit not reached (35% used)\n",
};

test("parseQuotaReport: available, exhausted and unknown readings of invented samples; never exhausted on ambiguity", () => {
  const r = Object.fromEntries(Object.entries(SAMPLES).map(([k, v]) => [k, parseQuotaReport(v)]));
  assert.equal(r.table.state, "available");
  assert.deepEqual(r.table.buckets.map(b => [b.name, b.used_pct, b.exhausted]), [["five_hour", 42, false], ["weekly", 61, false]]);
  assert.equal(r.table.buckets[0].resets_at, "in 2h 10m");
  assert.equal(r.spent.state, "exhausted");
  assert.deepEqual(r.spent.buckets.map(b => [b.name, b.exhausted]), [["five_hour", true], ["weekly", false]]);
  assert.equal(r.left.state, "exhausted");
  assert.deepEqual(r.left.buckets.map(b => [b.name, b.remaining, b.remaining_unit, b.exhausted]), [["five_hour", 0, "%", true], ["weekly", 12, "%", false]]);
  assert.equal(r.argon.state, "exhausted");
  assert.deepEqual(r.argon.buckets.map(b => [b.name, b.remaining, b.exhausted]), [["argon_weekly", 0, true], ["five_hour", 20, false]]);
  assert.equal(r.json.state, "exhausted");
  assert.deepEqual(r.json.buckets.map(b => [b.name, b.exhausted]).sort(), [["argon_weekly", true], ["five_hour", false], ["weekly", false]]);
  assert.equal(r.json.buckets.find(b => b.name === "weekly").remaining, 40);
  assert.deepEqual(r.noise, { state: "unknown", buckets: [] });
  assert.equal(r.bare.state, "unknown", "a bare 100% does not say used or left");
  assert.ok(r.bare.buckets.every(b => !b.exhausted));
  assert.equal(r.contradict.state, "unknown");
  assert.equal(r.negated.state, "available");
  for (const v of ["", null, undefined, 42, "{not json"]) assert.equal(parseQuotaReport(v).state, "unknown");
});

test("isQuotaFailure / quotaEvidence: explicit (429, RESOURCE_EXHAUSTED) vs soft phrases; ordinary failures are not quota", () => {
  for (const [said, explicit] of [[{ status: 429 }, true], [{ stderr: "HTTP 429 Too Many Requests" }, true], [{ result: { status: "RESOURCE_EXHAUSTED" } }, true],
    [{ stderr: "Error: weekly quota reached" }, false], [{ stderr: "Rate limit exceeded" }, false], [{ result: { error: "Spend cap reached for this account" } }, false],
    [{ result: { error: { message: "prepaid balance is exhausted" } } }, false], [{ stderr: "QUOTA" }, false]]) {
    assert.equal(isQuotaFailure(said), true, JSON.stringify(said));
    assert.equal(quotaEvidence(said).explicit, explicit, JSON.stringify(said));
  }
  for (const said of [{ stderr: "internal error" }, { stderr: "print timeout" }, { stderr: "wrote 4290 bytes" }, { result: { status: "SUCCESS" } }, {}]) assert.equal(isQuotaFailure(said), false, JSON.stringify(said));
  // agy-cli keeps its quota refusal shape (status 429, code quota_exhausted), now built on quota.mjs.
  assert.deepEqual(agyQuotaRefusal({ stderr: "weekly quota reached" }), { status: 429, code: "quota_exhausted", matched: "weekly quota", explicit: false });
});

test("probeQuota runs `agy --print /usage --output-format json` (no model, minimal env, an empty cwd) and parses it; a failing or missing CLI is unknown", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-quota-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = fakeAgy(dir);
  writeFileSync(join(dir, "quota-report.txt"), SAMPLES.spent);
  const before = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "never-to-the-probe";
  t.after(() => { if (before === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = before; });
  const p = await probeQuota({ cli });
  assert.deepEqual([p.state, p.exit_code], ["exhausted", 0]);
  assert.match(p.raw_digest, /^sha256:[0-9a-f]{64}$/);
  writeFileSync(join(dir, "quota-report.txt"), SAMPLES.noise);
  assert.equal((await probeQuota({ cli })).state, "unknown");
  assert.equal((await probeQuota({ cli: join(dir, "missing-agy") })).state, "unknown");
  // The probe's environment: a minimal one, without a Google API key (a CLI that prints its env).
  const envCli = join(dir, "env-agy");
  const seen = join(dir, "seen.txt");
  writeFileSync(envCli, `#!/bin/sh\n{ printf 'args=%s\\n' "$*"; printf 'cwd=%s\\n' "$PWD"; env; } > ${seen}\n`, { mode: 0o755 });
  const r = await probeQuota({ cli: envCli, env: { EXTRA_FOR_PROBE: "1" } });
  assert.equal(r.state, "unknown");
  const { readFileSync } = await import("node:fs");
  const got = readFileSync(seen, "utf8");
  // The structured form observed on agy 1.5.10 (it spent no tokens there): no --model, no workspace flags.
  assert.match(got, /^args=--print \/usage --output-format json$/m, "no --model, no workspace flags");
  assert.match(got, /^AGY_CLI_DISABLE_AUTO_UPDATE=true$/m);
  assert.doesNotMatch(got, /GEMINI_API_KEY|GOOGLE_API_KEY/);
  assert.match(got, /^EXTRA_FOR_PROBE=1$/m);
  assert.match(got, /^cwd=.*pantheon-agy-quota-/m, "an empty temporary cwd, not a workspace");
  assert.ok(!/^FAKE_AGY_LOG=/m.test(got), "a minimal environment: unrelated variables are not passed");
});
