// The suite must not depend on the host it runs on. On the owner's machine (2026-11-19, at 09d490f) three tests failed
// for that reason alone: agy-sandbox.test.mjs probed a FIXED /tmp/scratch (the host already had a /tmp/scratch
// directory, so `readFileSync` of it threw EISDIR), and both forms of the agy-worker-probe test asserted that a
// HOST-WIDE `ps` listing of agy processes was empty (the owner had Antigravity running). This guard reads the test
// sources and fails on the two patterns that caused it:
//   - a filesystem call on a literal fixed path directly under /tmp (use mkdtemp, or a name derived from one);
//   - an assertion that the probe's host-wide agy process listing is empty (scope it to the test's own processes).
// It is a source check, so it is narrow by design: it names the file and line it objects to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = dirname(fileURLToPath(import.meta.url));
const sources = () => {
  const out = [];
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.m?js$/.test(e.name)) out.push(p); } };
  walk(TESTS);
  return out.filter(p => p !== fileURLToPath(import.meta.url));
};
const offenders = re => sources().flatMap(p => readFileSync(p, "utf8").split("\n").map((l, i) => (re.test(l) ? `${relative(TESTS, p)}:${i + 1}: ${l.trim().slice(0, 160)}` : null)).filter(Boolean));

const FS_CALL = /\b(existsSync|readFileSync|writeFileSync|appendFileSync|mkdirSync|rmSync|statSync|lstatSync|readdirSync|openSync|readFile|writeFile|appendFile|mkdir|rm|stat|lstat|readdir|access|tryWrite)\(\s*(?:["'][^"']*["']\s*,\s*)?(["'])\/tmp\/[^"'$+]*\2\s*[,)]/;

test("no test touches a fixed path directly under /tmp (the host's /tmp is not the test's: /tmp/scratch existed on the owner's machine)", () => {
  assert.deepEqual(offenders(FS_CALL), []);
  // The pattern catches the original defect.
  assert.ok(FS_CALL.test(`tryWrite("tmp", "/tmp/scratch");`) && FS_CALL.test(`existsSync("/tmp/scratch")`));
  assert.ok(!FS_CALL.test(`tryWrite("tmp", tmpProbe);`) && !FS_CALL.test(`tryWrite("/tmp/fake-" + process.pid + ".txt")`));
});

test("no test asserts that the host-wide agy process listing is empty (ambient Antigravity processes are not the test's)", () => {
  const EMPTY_HOST_LISTING = /host_agy_processes\.(before|after)\.processes\b(?!\.some|\.filter|\))[^;]*\[\s*\[\s*\]/;
  assert.deepEqual(offenders(EMPTY_HOST_LISTING), []);
  assert.ok(EMPTY_HOST_LISTING.test("assert.deepEqual([o.gemini_state.host_agy_processes.before.processes, o.gemini_state.host_agy_processes.after.processes], [[], []]);"));
});
