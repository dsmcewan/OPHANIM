// Shared fixtures of the SDK seat's jail tests (knowledge graphs, Slice C2; register L-155; pantheon/tests/agy-sdk-jail.test.mjs).
//
// THE STUB INTERPRETER. The google-antigravity SDK is not installed where these tests run, so the seat's "python" (passed
// through PANTHEON_AGY_PYTHON or the launcher's --python, the existing spawn inputs) is a #! script written here: it runs
// the probe (agy-sdk-jail-probe.py) INSIDE the real jail first, then execs the real scripts/agy-seat.py over the L-150
// stub SDK (fixtures/l150-sdk-stub), whose requests reach the controller's real metering relay. Its plan is written INTO the
// script, because nothing outside the workspace and the out dir is visible in the jail and its environment is an allowlist.
// Every key and secret is SYNTHETIC; the relay's upstream is a local fake (fixtures/l150-fake-gemini.mjs).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROBE = join(HERE, "agy-sdk-jail-probe.py");
export const L150_STUB = join(HERE, "l150-sdk-stub");
export const SEAT_PY = join(HERE, "..", "..", "scripts", "agy-seat.py");
/** A needle as the probe receives it: reversed, hex-encoded (so it never appears in an environment it searches). */
export const hexRev = s => Buffer.from(String(s ?? ""), "utf8").reverse().toString("hex");

/** Write the stub interpreter into `dir` with `plan` baked in; returns its path. */
export function stubInterpreter(dir, plan) {
  const py = join(dir, "python"), json = JSON.stringify(plan);
  if (json.includes("'")) throw new Error("the probe's plan may not hold a single quote (it is a shell literal)");
  writeFileSync(py, `#!/bin/sh
# The python SDK seat's stub interpreter (knowledge graphs, Slice C2): the probe first, inside the jail; then the real
# agy-seat.py over the L-150 stub SDK. Its plan is written into it: nothing outside the workspace and the out dir is
# visible in the jail, and the jail's environment is an allowlist.
AGY_SDK_JAIL_PLAN='${json}' PYTHONDONTWRITEBYTECODE=1 python3 ${JSON.stringify(PROBE)} "$@" || exit 97
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=${JSON.stringify(L150_STUB)} exec python3 "$@"
`, { mode: 0o755 });
  return py;
}

/** The host processes whose command line names `needle` (the jailed seat's own processes, seen from outside the jail). */
export function processesNaming(needle) {
  const out = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    let argv;
    try { argv = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { continue; }
    if (argv.some(a => a.includes(needle))) out.push({ pid: Number(d), argv0: argv[0] });
  }
  return out;
}
/** Is any process left that names `needle`? (pgrep, as the L-306 tests ask; "" when none.) */
export const pgrep = needle => { try { return execFileSync("pgrep", ["-f", needle], { encoding: "utf8" }).trim(); } catch { return ""; } };
export const readJson = f => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
