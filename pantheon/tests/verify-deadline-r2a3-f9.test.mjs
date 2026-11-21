// Independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 9: runVerify had no
// failsafe kill and ignored the stage's abort signal, and the agy worker's --print-timeout was a constant instead of what
// is left of the stage. Real bwrap (the verify jail); the fixture is under /var/tmp (see verify-jail-credential-isolation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runVerify } from "../src/pipeline/review.mjs";
import { exec } from "../src/pipeline/git.mjs";
import { pipelineTurns, printTimeoutOf } from "../src/pipeline/turns.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";

const have = await sandboxAvailable("bwrap");
const varTmp = (() => { try { rmSync(mkdtempSync("/var/tmp/pantheon-f9-probe-"), { recursive: true }); return true; } catch { return false; } })();
const gate = { skip: !have.ok ? `bwrap unavailable: ${have.why}` : !varTmp ? "/var/tmp is not writable" : false };
const wtOf = t => { const d = realpathSync(mkdtempSync("/var/tmp/pantheon-f9-")); t.after(() => rmSync(d, { recursive: true, force: true })); mkdirSync(join(d, "wt")); return join(d, "wt"); };
const wait = ms => new Promise(r => setTimeout(r, ms));

test("finding 9: the stage's abort signal stops runVerify at once: the jail (and a background child inside it) is killed, the result says aborted and FAILED", gate, async t => {
  const wt = wtOf(t), ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 400);
  const v = await runVerify({ worktree: wt, verify_cmd: "(sleep 3 && touch late-bg) & sleep 3 && touch late", timeout_ms: 60000, signal: ac.signal });
  assert.ok(Date.now() - t0 < 5000, `returned after ${Date.now() - t0} ms`);
  assert.deepEqual([v.aborted, v.timed_out, v.exit_code, v.passed], [true, false, null, false]);
  await wait(3500);
  assert.equal(existsSync(join(wt, "late")), false, "the jailed command was killed");
  assert.equal(existsSync(join(wt, "late-bg")), false, "and so was its background child (the jail's PID namespace died)");
  // A signal that already fired starts nothing.
  const v2 = await runVerify({ worktree: wt, verify_cmd: "touch ran", signal: AbortSignal.abort() });
  assert.deepEqual([v2.not_started, v2.aborted, v2.passed, existsSync(join(wt, "ran"))], [true, true, false, false]);
});

test("finding 9: the stage's deadline caps runVerify's timeout (a 60 s timeout, 600 ms left: killed at the deadline, timed_out); a deadline already past starts nothing", gate, async t => {
  const wt = wtOf(t), t0 = Date.now();
  const v = await runVerify({ worktree: wt, verify_cmd: "sleep 5 && touch late", timeout_ms: 60000, deadline: Date.now() + 600 });
  assert.ok(Date.now() - t0 < 4000, `returned after ${Date.now() - t0} ms`);
  assert.deepEqual([v.timed_out, v.exit_code, v.passed], [true, null, false]);
  assert.ok(v.timeout_ms <= 600, `the effective timeout ${v.timeout_ms} is the deadline's`);
  const v2 = await runVerify({ worktree: wt, verify_cmd: "touch ran", deadline: Date.now() - 1 });
  assert.deepEqual([v2.not_started, v2.timed_out, v2.passed, existsSync(join(wt, "ran"))], [true, true, false, false]);
  await wait(200);
  const ok = await runVerify({ worktree: wt, verify_cmd: "true", deadline: Date.now() + 30000 });
  assert.deepEqual([ok.exit_code, ok.passed, ok.aborted, ok.timed_out], [0, true, false, false]);
});

test("finding 9: the exec failsafe resolves after a kill even when a process OUTSIDE the killed group still holds the output pipe", async t => {
  const d = realpathSync(mkdtempSync("/var/tmp/pantheon-f9-fs-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const pidf = join(d, "stray.pid");
  t.after(() => { try { process.kill(Number(readFileSync(pidf, "utf8")), "SIGKILL"); } catch { /* gone */ } });
  const t0 = Date.now();
  const r = await exec("sh", ["-c", `setsid sh -c 'echo $$ > ${pidf}; exec sleep 30' & sleep 30`], { timeout_ms: 300, group: true, kill_grace_ms: 300 });
  assert.ok(Date.now() - t0 < 3000, `resolved after ${Date.now() - t0} ms (without the failsafe: 30 s)`);
  assert.deepEqual([r.timed_out, r.code], [true, null]);
});

test("finding 9: the worker's --print-timeout is derived: the caller's timeout, capped by the stage's deadline minus the kill grace; no time left -> the turn is not started", async () => {
  const now = 1_000_000;
  assert.equal(printTimeoutOf({ timeoutS: 1800, now }), 1800);
  assert.equal(printTimeoutOf({ timeoutS: 1800, graceS: 15, deadline: now + 120_000, now }), 105);
  assert.equal(printTimeoutOf({ timeoutS: 60, graceS: 15, deadline: now + 3_600_000, now }), 60, "the caller's own timeout when it is the smaller");
  assert.equal(printTimeoutOf({ timeoutS: 1800, graceS: 15, deadline: now + 15_500, now }), null);
  // Through the turn adapter: what the lane is launched with.
  const seen = [];
  const turns = pipelineTurns({ turn: async () => ({ text: "" }), agy: { timeoutS: 1800, run: async a => { seen.push([a.timeoutS, a.graceS]); return { text: "ok" }; } } });
  const base = { vendor: "agy_google", model: "gemini-4-hydrogen-medium", prompt: "p", cwd: realpathSync(mkdtempSync("/tmp/pantheon-f9-turn-")), owned_paths: ["a/**"], verify_cmd: "true", unit_id: "u" };
  try {
    await turns.implementer({ ...base });
    await turns.implementer({ ...base, deadline: Date.now() + 200_000 });
    await turns.implementer({ ...base, timeoutS: 30, deadline: Date.now() + 200_000 });
    await assert.rejects(turns.implementer({ ...base, deadline: Date.now() + 5_000 }), e => e.code === "DEADLINE");
  } finally { rmSync(base.cwd, { recursive: true, force: true }); }
  assert.equal(seen.length, 3, "the turn with no time left never launched the CLI");
  assert.deepEqual(seen[0], [1800, 15]);
  assert.ok(seen[1][0] <= 185 && seen[1][0] >= 180, `capped by the deadline: ${seen[1][0]}`);
  assert.deepEqual(seen[2], [30, 15]);
});
