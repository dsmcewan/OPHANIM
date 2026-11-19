// The quota report as OBSERVED on the owner's machine (agy 1.5.10, 2026-11-18): the JSON envelope of
// `agy --print /usage --output-format json` and the text of `agy -p /quota`. Not invented: copied from that probe run,
// with one bucket changed only where a test says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUsageEnvelope, parseQuotaReport, scopeQuota, probeQuota as probeQuotaOf, displayNameOf, PROBE_ARGS } from "../src/agy/quota.mjs";

const OBSERVED_JSON = {"conversation_id":"","status":"SUCCESS","response":"Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-25T01:58:17Z\nGemini Models\tFive Hour Limit Remaining\t100%\t2026-11-18T06:58:17Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-25T01:58:17Z\nClaude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-18T06:58:17Z\n","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models. The 5-hour limit smooths out aggregate demand to fairly distribute global capacity across all users, while your weekly limit is tied directly to your individual tier.","groups":[{"name":"Gemini Models","description":"Models within this group: Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":1,"reset_time":"2026-11-25T01:58:17Z"},{"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":1,"reset_time":"2026-11-18T06:58:17Z"}]},{"name":"Claude and GPT models","description":"Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B","buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":1,"reset_time":"2026-11-25T01:58:17Z"},{"id":"3p-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":1,"reset_time":"2026-11-18T06:58:17Z"}]}]}}};
const OBSERVED_TEXT = "Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-25T01:58:51Z\nGemini Models\tFive Hour Limit Remaining\t100%\t2026-11-18T06:58:51Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-25T01:58:51Z\nClaude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-18T06:58:51Z\n";
const withGemini5h = fraction => { const o = structuredClone(OBSERVED_JSON); o.command.data.groups[0].buckets[1].remaining_fraction = fraction; return o; };
const withThirdParty = fraction => { const o = structuredClone(OBSERVED_JSON); for (const b of o.command.data.groups[1].buckets) b.remaining_fraction = fraction; return o; };

test("the observed JSON envelope: four buckets in two groups, all available, and the probe itself spent nothing", () => {
  const r = parseUsageEnvelope(OBSERVED_JSON);
  assert.equal(r.state, "available");
  assert.equal(r.format, "json");
  assert.deepEqual(r.spent, { num_turns: 0, total_tokens: 0 });
  assert.deepEqual(r.buckets.map(b => [b.group, b.id, b.window, b.remaining_fraction, b.exhausted]), [
    ["Gemini Models", "gemini-weekly", "weekly", 1, false], ["Gemini Models", "gemini-5h", "5h", 1, false],
    ["Claude and GPT models", "3p-weekly", "weekly", 1, false], ["Claude and GPT models", "3p-5h", "5h", 1, false]]);
  assert.ok(r.buckets[0].models.includes("Gemini 4 Hydrogen") && r.buckets[0].models.includes("Gemini 3.8 Flash"));
});

test("a spent bucket in the lane's own group is exhausted; a spent bucket in another group is not this lane's quota", () => {
  assert.equal(parseUsageEnvelope(withGemini5h(0)).state, "exhausted");
  assert.equal(scopeQuota(parseUsageEnvelope(withGemini5h(0)), "gemini-4-carbon").state, "exhausted");
  assert.equal(scopeQuota(parseUsageEnvelope(withGemini5h(0.2)), "gemini-4-carbon").state, "available");
  // The Claude/GPT group spent: the whole report says exhausted, a Gemini lane's scope does not.
  const other = parseUsageEnvelope(withThirdParty(0));
  assert.equal(other.state, "exhausted");
  assert.equal(scopeQuota(other, "gemini-4-hydrogen").state, "available");
  assert.equal(scopeQuota(other, "gemini-4-hydrogen").scope.all_state, "exhausted");
  // A model no group lists is unknown, never exhausted.
  assert.equal(scopeQuota(parseUsageEnvelope(withGemini5h(0)), "gemini-9-unlisted").state, "unknown");
  assert.equal(displayNameOf("gemini-3.8-flash"), "Gemini 3.8 Flash");
});

test("the observed text form parses to the same reading, with each bucket's group", () => {
  const r = parseQuotaReport(OBSERVED_TEXT);
  assert.equal(r.state, "available");
  assert.deepEqual(r.buckets.map(b => [b.group, b.name, b.remaining]), [["Gemini Models", "weekly", 100], ["Gemini Models", "five_hour", 100],
    ["Claude and GPT models", "weekly", 100], ["Claude and GPT models", "five_hour", 100]]);
  assert.equal(scopeQuota(r, "gemini-4-argon").state, "available");
  assert.deepEqual(scopeQuota(r, "gemini-4-argon").buckets.map(b => b.group), ["Gemini Models", "Gemini Models"]);
});

test("probeQuota runs the observed structured command and scopes it to the lane's group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-quota-observed-"));
  const cli = join(dir, "agy"), seen = join(dir, "argv");
  writeFileSync(join(dir, "report.json"), JSON.stringify(withThirdParty(0)));
  writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$@" > "${seen}"\nprintf 'AUTO=%s\\n' "$AGY_CLI_DISABLE_AUTO_UPDATE" >> "${seen}"\ncat "${join(dir, "report.json")}"\n`);
  chmodSync(cli, 0o755);
  // The probe runs in the worker's jail (L-401 sibling): the fake records into an explicit agy state dir (writable inside).
  const probeQuota = args => probeQuotaOf({ ...args, sandbox: { agy_state_dirs: [dir] } });
  const p = await probeQuota({ cli, model: "gemini-4-carbon-high" });
  assert.deepEqual(readFileSync(seen, "utf8").trim().split("\n"), [...PROBE_ARGS, "AUTO=true"]);
  assert.equal(p.format, "json");
  assert.equal(p.state, "available", "only the Claude/GPT group is spent; a Carbon lane is not");
  assert.deepEqual(p.scope.groups, ["Gemini Models"]);
  assert.deepEqual(p.spent, { num_turns: 0, total_tokens: 0 });
  writeFileSync(join(dir, "report.json"), JSON.stringify(withGemini5h(0)));
  assert.equal((await probeQuota({ cli, model: "gemini-4-carbon-high" })).state, "exhausted");
  writeFileSync(join(dir, "report.json"), OBSERVED_TEXT);
  const t = await probeQuota({ cli, model: "gemini-4-hydrogen-xhigh" });
  assert.equal(t.state, "available");
});
