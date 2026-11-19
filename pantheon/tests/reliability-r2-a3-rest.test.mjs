// Regression tests for the remaining findings of independent review round 2, assignment 3 (Google gemini-4-carbon,
// manual, 77480d6): execution reliability. Each test names the finding it pins; each failed on b5b088b. New exports are
// reached through namespace imports, so this file loads on b5b088b and its tests fail there by assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { routeCall } from "../../packages/model-client/index.mjs";
import { routeSeats } from "../src/route/quota-failover.mjs";
import { pathsOverlap } from "../src/pipeline/paths.mjs";
import { waves } from "../src/pipeline/dispatch.mjs";
import * as PIPE from "../src/pipeline/index.mjs";
import { scopeQuota, probeQuota } from "../src/agy/quota.mjs";
import { unit } from "./fixtures/pipeline-stages.mjs";

const http = status => Object.assign(new Error(`HTTP ${status}`), { status, headers: new Headers({ "retry-after": "0.001" }) });

// ---- finding 1.1: a transient retry is its own provider request

test("finding 1.1: routeCall admits every attempt, the retry of a transient 5xx included, and a refused admission sends nothing", async () => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 1.1: routeCall retried a
  // 503 inside one routed call that a caller had charged once.
  let sent = 0, admitted = 0;
  const bound = 1;
  const admit = () => { if (admitted >= bound) throw Object.assign(new Error("PROVIDER_CALL_LIMIT: the bound of 1 call is spent"), { code: "PROVIDER_CALL_LIMIT" }); admitted++; };
  await assert.rejects(routeCall({ candidates: [{ vendor: "openai", model: "gpt-6-luna", pool: "p" }], admit, invoke: async () => { sent++; throw http(503); } }),
    e => e.code === "PROVIDER_CALL_LIMIT");
  assert.equal(sent, 1, "the retry was refused before it was sent");
  assert.equal(admitted, 1);
  // Under a bound that allows it, the retry is admitted (and counted) like the first attempt.
  const seen = [];
  const r = await routeCall({ candidates: [{ vendor: "openai", model: "gpt-6-luna", pool: "p" }], admit: a => seen.push(a.attempt),
    invoke: async (_s, { attempt }) => { if (attempt === 0) throw http(503); return "ok"; } });
  assert.equal(r.value, "ok");
  assert.deepEqual(seen, [0, 1]);
  // routeSeats passes it on.
  const viaSeats = [];
  await routeSeats({ candidates: [{ vendor: "openai", model: "gpt-6-luna", pool: "p", transport: "api" }], admit: a => viaSeats.push(a.attempt),
    invoke: async (_s, { attempt }) => { if (attempt === 0) throw http(503); return "ok"; } });
  assert.deepEqual(viaSeats, [0, 1]);
});

// ---- finding 3.1: case-only collisions

test("finding 3.1: owned paths that differ only in case overlap, and are never put in one wave", () => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 3.1.
  assert.equal(pathsOverlap("src/Foo.mjs", "src/foo.mjs"), true);
  assert.equal(pathsOverlap("SRC/**", "src/a.mjs"), true);
  assert.equal(pathsOverlap("src/A*.mjs", "src/abc.mjs"), true);
  assert.equal(pathsOverlap("src/foo.mjs", "src/bar.mjs"), false, "folding adds overlaps only for case");
  assert.deepEqual(waves([unit("a", { owned_paths: ["src/Foo.mjs"] }), unit("b", { owned_paths: ["src/foo.mjs"] })]), [["a"], ["b"]]);
});

// ---- finding 3.3: one mutex per repository

test("finding 3.3: orphan recovery takes the repository's own worktree mutex, the one every pipeline run on that repository holds", async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 3.3: each run had a
  // private mutex and the lifecycle's orphan recovery none, so concurrent items mutated one .git/worktrees at once.
  assert.equal(typeof PIPE.repoMutex, "function", "a per-repository mutex is exported");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "r2a3r-mutex-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), orphan = join(root, "orphans");
  mkdirSync(repo); mkdirSync(join(orphan, "w1"), { recursive: true });
  writeFileSync(join(orphan, "w1", "f"), "x");
  assert.equal(PIPE.repoMutex(repo), PIPE.repoMutex(join(root, ".", "repo")), "one mutex per repository path");
  let release;
  const held = PIPE.repoMutex(repo)(() => new Promise(r => { release = r; }));
  const recovering = PIPE.recoverOrphanWorktrees({ repo, root: orphan });
  await new Promise(r => setTimeout(r, 100));
  assert.ok(existsSync(join(orphan, "w1")), "recovery waits while another holder mutates the repository");
  release();
  await held;
  await recovering;
  assert.ok(!existsSync(join(orphan, "w1")), "then it runs");
});

// ---- finding 5.2: unscoped exhaustion is not proof

test("finding 5.2: an exhaustion the report does not attribute to the lane's group is unknown, not exhausted", async t => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 5.2: scopeQuota and the
  // probe's stderr reading left an unscoped exhaustion `exhausted` for any lane.
  const spent = { name: "weekly", exhausted: true, remaining: 0, remaining_unit: "%" };
  assert.equal(scopeQuota({ state: "exhausted", buckets: [spent] }, "gemini-4-carbon").state, "unknown", "no group named: not this lane's");
  assert.equal(scopeQuota({ state: "available", buckets: [{ name: "weekly", exhausted: false, remaining: 50 }] }, "gemini-4-carbon").state, "available");
  assert.equal(scopeQuota({ state: "exhausted", buckets: [{ ...spent, group: "Gemini Flash" }] }, "gemini-4-carbon").state, "unknown", "a family-only match is not this lane's group");
  assert.equal(scopeQuota({ state: "exhausted", buckets: [{ ...spent, group: "Gemini 4 Carbon" }] }, "gemini-4-carbon").state, "exhausted");
  assert.equal(scopeQuota({ state: "exhausted", buckets: [{ ...spent, group: "g", models: ["Gemini 4 Carbon"] }] }, "gemini-4-carbon").state, "exhausted");
  // The probe: a failing CLI that reports an unscoped spent quota on stderr.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "r2a3r-probe-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "agy");
  writeFileSync(cli, "#!/bin/sh\necho 'weekly limit reached' >&2\nexit 1\n", { mode: 0o755 });
  const q = await probeQuota({ cli, model: "gemini-4-carbon-high", timeoutS: 10 });
  assert.notEqual(q.state, "exhausted", JSON.stringify(q));
});

// ---- finding 6: the metered-failover switch on the walk

test("finding 6: with meteredFailover false, routeSeats never reaches a metered Gemini quota-failover candidate", async () => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 6: routeSeats (runOpenItem)
  // had no switch, so a lane's quota refusal reached the metered API whatever the run's billing said.
  const quota = () => Object.assign(new Error("agy: 429 RESOURCE_EXHAUSTED"), { status: 429, code: "quota_exhausted" });
  const LANE = { vendor: "agy_google", model: "gemini-4-carbon-high", transport: "agy-cli", pool: "agy_google" };
  const SPARE = { vendor: "agy_google", model: "gemini-4-carbon", transport: "api", pool: "agy_google", quota_failover: { base: "gemini-4-carbon", lanes: ["gemini-4-carbon-high"] } };
  const NEXT = { vendor: "openai", model: "gpt-6-astra", transport: "api", pool: "openai" };
  const asked = [], skipped = [];
  const r = await routeSeats({ candidates: [LANE, SPARE, NEXT], meteredFailover: false, onSkip: s => skipped.push(s.why),
    invoke: async c => { asked.push(c.model); if (c.transport === "agy-cli") throw quota(); return c.model; } });
  assert.deepEqual(asked, ["gemini-4-carbon-high", "gpt-6-astra"]);
  assert.equal(r.value, "gpt-6-astra");
  assert.ok(skipped.some(w => /disabled/.test(w)), JSON.stringify(skipped));
});
