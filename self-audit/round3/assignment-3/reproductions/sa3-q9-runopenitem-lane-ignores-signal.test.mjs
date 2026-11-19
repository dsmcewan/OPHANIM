// SELF-AUDIT A3 Q9 (af0dc30). PASSING = DEFECT PRESENT.
// runOpenItem's Antigravity LANE turn ignores the caller's stop signal. 5f26e17 says "runOpenItem admits no provider
// call once it has fired, and every turn ... defaults to it", but run-item.mjs turn() calls
// agyTurn({purpose, model, prompt, declared}) with no signal, and agyTurn calls runAgyCliTurn (which does accept
// `signal`) without one, with timeoutS = PANTHEON_AGY_TIMEOUT ?? 900 and no deadline. runOpenItem itself returns on
// the abort (routeCall races the invoke against the signal), but the agy CLI process is NOT killed: it runs on for up
// to 900 + 15 s after the stage was stopped and recorded -- an orphan that live keeps an Antigravity session working
// (and writing into the board dir) after the stage's record says it stopped, and after the lease may have passed to a
// new holder.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runOpenItem } from "../pantheon/src/board/run-item.mjs";
import { withDispatch, seat } from "../pantheon/tests/fixtures/dispatch.mjs";

test("Q9: an aborted runOpenItem leaves its agy lane process running until the CLI's own timeout", { timeout: 120_000 }, async () => {
  await withDispatch(async ({ spec, opts }) => {
    const before = { hang: process.env.FAKE_AGY_HANG, t: process.env.PANTHEON_AGY_TIMEOUT };
    process.env.FAKE_AGY_HANG = "gemini-4-carbon-high";   // the fake CLI sleeps 60 s for this lane model
    process.env.PANTHEON_AGY_TIMEOUT = "5";                // the CLI turn's own timeout: (5 + 15) s
    try {
      const ac = new AbortController();
      let planStarted = 0;
      const progress = ev => {
        if (ev.event === "turn.start" && ev.seat === "agy_google" && !planStarted) {
          planStarted = Date.now();
          setTimeout(() => ac.abort(Object.assign(new Error("STAGE_ELAPSED: the caller stopped the run"), { code: "STAGE_ELAPSED" })), 500);
        }
      };
      await runOpenItem(spec("laneHang"), { ...opts(), maxProviderCalls: 20, signal: ac.signal, progress,
        seatOverrides: { planner: seat("agy_google", "gemini-4-carbon-high", { transport: "agy-cli" }) } }).catch(() => null);
      assert.ok(planStarted > 0, "the lane turn started");
      const returnedAfter = Date.now() - planStarted;
      assert.equal(ac.signal.aborted, true);
      // runOpenItem itself returns promptly (routeCall races the turn against the signal) ...
      assert.ok(returnedAfter < 5_000, `runOpenItem returned ${returnedAfter} ms after the lane turn started`);
      // ... but the agy CLI process it started is NOT cancelled: it keeps running (and, live, keeps the lane session
      // spending) until its own timeout, after the stage has been recorded as stopped. An orphan of the stop.
      await new Promise(r => setTimeout(r, 3_000));
      let alive = "";
      try { alive = execFileSync("pgrep", ["-f", "fake-agy.*gemini-4-carbon-high"], { encoding: "utf8" }).trim(); } catch { alive = ""; }
      assert.ok(alive.length > 0, "the lane's agy process is still running 3 s after the abort and after runOpenItem returned");
      // Let it die on its own timeout before the fixture removes its directory.
      for (let i = 0; i < 40; i++) { try { execFileSync("pgrep", ["-f", "fake-agy.*gemini-4-carbon-high"]); } catch { break; } await new Promise(r => setTimeout(r, 1000)); }
    } finally {
      for (const [k, v] of [["FAKE_AGY_HANG", before.hang], ["PANTHEON_AGY_TIMEOUT", before.t]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});
