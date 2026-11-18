// A killed stage does not record its calls; the next tick charges the stage again.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStatusLedger } from "../packages/ledger/status.mjs";
import { openWorkLedger } from "../ophanim/operate/work-ledger.mjs";
import { tick, spent } from "../ophanim/operate/scheduler.mjs";

test("a claim killed before recordStage is absent from spent(), and the resume charges the stage again", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "exec-restart-"));
  const statusRoot = path.join(repo, "status", "ledger");
  const workRoot = path.join(repo, "status", "work");
  const S = openStatusLedger({ root: statusRoot });
  S.set({ item: "k", title: "K", state: "Ready", checked: "2026-11-17", basis: "the requirement of k" });
  fs.mkdirSync(path.join(repo, "tickets"));
  const external = { calls: 0 };
  const t0 = Date.parse("2026-11-17T00:00:00Z");
  let n = 0;
  const plan = async () => {
    n++;
    external.calls += 4;
    if (n === 1) {
      // The process is killed after the provider calls and before recordStage: the executor never returns.
      await new Promise(() => {});
    }
    return { status: "passed", outputs: { n }, team: [], contributions: [], findings: [{ id: "kept", text: "only the second run" }], usage: { provider_calls: 4 }, next: { stage: "implement", why: "ok" } };
  };
  const limits = { total_provider_calls: 20, stage_provider_calls: 10, lease_ms: 1000, iterations: 5 };
  const first = tick({ repo, statusRoot, workRoot, executors: { plan }, limits, clock: () => t0 });
  await new Promise(r => setTimeout(r, 30));
  const mid = openWorkLedger({ root: workRoot });
  assert.equal(mid.claims("k").length, 1);
  assert.equal(mid.stages("k").length, 0);
  assert.equal(spent(mid).calls, 0, "the killed calls are not in the budget");
  const resumed = await tick({ repo, statusRoot, workRoot, executors: { plan }, limits, clock: () => t0 + 5000 });
  first.catch(() => {});
  assert.equal(resumed.released_expired.length, 1);
  assert.equal(resumed.dispatched[0].status, "passed");
  assert.equal(spent(openWorkLedger({ root: workRoot })).calls, 4);
  assert.equal(external.calls, 8, "the provider was called again for the same stage");
  assert.equal(openWorkLedger({ root: workRoot }).stages("k")[0].findings.length, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});
