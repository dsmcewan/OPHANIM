#!/usr/bin/env node
// THE BOARD'S CONTROLLER FOR THE SDK SEAT'S JAIL TESTS (knowledge graphs, Slice C2; pantheon/tests/agy-sdk-jail.test.mjs).
//
//   node agy-sdk-jail-board.mjs <config.json>
//
// A process of its own, so the controller's INITIAL environment holds the synthetic GEMINI_API_KEY (/proc/<pid>/environ shows
// the environment a process was started with, not later changes to process.env): the probe inside the jail must find it in
// no /proc/<pid>/environ, this process's included. It runs the board (runOpenItem, the production entry point) with its
// reviewer on the python SDK seat (PANTHEON_AGY_TRANSPORT=sdk), the stub interpreter of agy-sdk-jail-helpers.mjs as the
// seat's python, the relay's upstream a local fake, and writes what the test asserts to config.result:
//   {result, run (run.json), worktree, seat_dirs: [{dir, files, home}], probe, progress (events), pgrep_after}
// Config: {result, key (the run's key), upstream, usage (the Gemini usage record), budget, model, plan ({secrets, writes,
// hang}), bwrap (a binary for opts.sdkJail), timeout (PANTHEON_AGY_TIMEOUT), abort (stop the run once the probe reported)}.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withDispatch, seat } from "./dispatch.mjs";
import { stubInterpreter, hexRev, pgrep, readJson } from "./agy-sdk-jail-helpers.mjs";
import { billingFromFlags, geminiBilling, geminiUsageFile } from "../../src/route/gemini-billing.mjs";
import { runOpenItem } from "../../src/board/run-item.mjs";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const KEY = process.env.GEMINI_API_KEY, CANARY = process.env.AGY_C2_JAIL_CANARY;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let report = null;
await withDispatch(async ({ dir, spec, opts }) => {
  const python = stubInterpreter(dir, { ...(cfg.plan ?? {}), controller_pid: process.pid, key_hex_rev: hexRev(KEY), canary_hex_rev: hexRev(CANARY) });
  // withDispatch takes the provider keys out of process.env; the relay forwards with the controller's key, so it is put
  // back (the controller's initial environment, which the probe searches, holds it all along).
  Object.assign(process.env, { GEMINI_API_KEY: KEY, PANTHEON_AGY_TRANSPORT: "sdk", PANTHEON_AGY_PYTHON: python, PANTHEON_AGY_RELAY_UPSTREAM: cfg.upstream,
    ...(cfg.timeout ? { PANTHEON_AGY_TIMEOUT: String(cfg.timeout) } : {}) });
  const billing = geminiBilling({ policy: billingFromFlags({ "gemini-api-primary": String(cfg.budget ?? 100) }), ledger: geminiUsageFile(cfg.usage) });
  const events = [], ac = new AbortController();
  const seatRoot = join(dir, "outputs", "open-items", cfg.key, "agy_google");
  const seatDirs = () => (existsSync(seatRoot) ? readdirSync(seatRoot).sort().map(n => join(seatRoot, n)) : []);
  const running = runOpenItem(spec(cfg.key), { ...opts(), maxProviderCalls: 50, billing, signal: ac.signal, ...(cfg.bwrap ? { sdkJail: { bwrap: cfg.bwrap } } : {}),
    progress: ev => { if (/^seat\.|^turn\.refused$|^relay\./.test(ev.event ?? "")) events.push({ event: ev.event, detail: ev.detail ?? null }); },
    seatOverrides: { reviewer: seat("agy_google", cfg.model, { transport: "agy" }) } }).catch(e => ({ error: { message: String(e?.message ?? e), code: e?.code ?? null } }));
  if (cfg.abort) {
    // The kill path: the run's stop (L-306) once the jailed probe has reported, while it hangs.
    for (let i = 0; i < 600 && !seatDirs().some(d => existsSync(join(d, "jail-probe.json"))); i++) await sleep(100);
    ac.abort(Object.assign(new Error("STAGE_ELAPSED: stopped by the jail test"), { code: "STAGE_ELAPSED" }));
  }
  const r = await running;
  await sleep(1000);
  const board = r?.board ?? null;
  report = {
    result: { shipped: r?.shipped ?? null, error: r?.error ? { message: String(r.error.message ?? r.error).slice(0, 600), code: r.error.code ?? null } : null },
    run: board && existsSync(join(board, "run.json")) ? JSON.parse(readFileSync(join(board, "run.json"), "utf8")) : null,
    worktree: board ? join(board, "worktree") : null,
    seat_dirs: seatDirs().map(d => ({ dir: d, files: readdirSync(d).sort(), home: existsSync(join(d, "home")) })),
    probe: seatDirs().map(d => readJson(join(d, "jail-probe.json"))).find(Boolean) ?? null,
    progress: events,
    pgrep_after: pgrep(python),
    python,
  };
});
writeFileSync(cfg.result, JSON.stringify(report, null, 1));
