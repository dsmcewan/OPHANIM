// Guarded exact-commit publication (#139): the transport is reached only when every required gate, run by the guard
// on the exact committed object, exits 0 -- and the branch still points at it. Disposable local repositories and
// transport stubs only; nothing here talks to a real remote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishCandidate, testGates, REQUIRED_GATES } from "../../scripts/blackboard/publish-candidate.mjs";

const CLI = fileURLToPath(new URL("../../scripts/blackboard/publish-candidate.mjs", import.meta.url));
const BRANCH = "claude/candidate";

/** A work repository whose own lint exits `lint` and whose one test passes; a bare "remote"; the branch at HEAD. */
function fixture({ lint = 0, testOk = true } = {}) {
  const d = mkdtempSync(join(tmpdir(), "publication-"));
  const repo = join(d, "work"), remote = join(d, "remote.git");
  const g = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  mkdirSync(repo); execFileSync("git", ["init", "-q", "--bare", remote]);
  g(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "scripts", "test-gates"), { recursive: true });
  writeFileSync(join(repo, "scripts", "test-gates", "lint-tests.mjs"), `// fixture lint: its exit is the committed one\nprocess.stdout.write("fixture lint\\n"); process.exit(${lint});\n`);
  writeFileSync(join(repo, "t.test.mjs"), `import { test } from "node:test"; import assert from "node:assert/strict";\ntest("fixture", () => assert.equal(${testOk ? 1 : 2}, 1));\n`);
  g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "base");
  g(repo, "remote", "add", "origin", remote);
  g(repo, "checkout", "-q", "-b", BRANCH);
  writeFileSync(join(repo, "change.txt"), "candidate\n"); g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "candidate");
  const sha = g(repo, "rev-parse", "HEAD");
  const remoteHead = () => { try { return g(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`); } catch { return null; } };
  return { d, repo, remote, sha, g, remoteHead, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}
const stub = () => { const calls = []; const t = async args => { calls.push(args); return { stub: true }; }; t.calls = calls; return t; };
const extra = testGates({ tests: ["t.test.mjs"], timeoutMs: 60_000 });

test("red: an exact commit whose lint exits 1, with its tests passing, is refused; the transport is never called and the observation is kept", async () => {
  const f = fixture({ lint: 1 });
  try {
    const transport = stub();
    const r = await publishCandidate({ repo: f.repo, sha: f.sha, branch: BRANCH, extra, transport, workRoot: f.d });
    assert.deepEqual([r.ok, r.code, transport.calls.length], [false, "GATE_FAILED", 0]);
    assert.match(r.why, /required gate test-lint exited 1/);
    assert.deepEqual(r.gates.map(g => [g.name, g.status, g.passed]), [["test-lint", 1, false]], "the lint is read as its own exit; no later gate can outvote it");
    assert.equal(readFileSync(r.gates[0].stdout_ref, "utf8"), "fixture lint\n", "the raw output is kept by reference");
    assert.equal(JSON.parse(readFileSync(r.receipt_path, "utf8")).decision, "refused");
    assert.equal(f.remoteHead(), null);
  } finally { f.cleanup(); }
});

test("green: every gate exits 0 on the exact commit; the transport is called exactly once, for exactly that object and branch", async () => {
  const f = fixture();
  try {
    const transport = stub();
    const r = await publishCandidate({ repo: f.repo, sha: f.sha, branch: BRANCH, extra, transport, workRoot: f.d });
    assert.deepEqual([r.ok, r.code], [true, "PUBLISHED"], r.why);
    assert.deepEqual(r.gates.map(g => [g.name, g.status, g.passed]), [["test-lint", 0, true], ["tests", 0, true]]);
    assert.deepEqual(transport.calls, [{ repo: f.repo, remote: "origin", sha: f.sha, branch: BRANCH }]);
    // The gates ran in a real git checkout of exactly that object, detached, separate from the work tree.
    assert.equal(r.checkout_head, f.sha);
    assert.notEqual(r.checkout, f.repo);
    assert.equal(existsSync(r.checkout), false, "the controller's clone is removed once the decision is made");
    assert.deepEqual(r.gates.map(g => g.input_intact), [true, true], "the committed input was proven unchanged after every gate");
    assert.equal(f.g(f.repo, "status", "--porcelain"), "", "the caller's checkout was not written");
  } finally { f.cleanup(); }
});

test("fail closed: a failing test, a timeout, an empty gate list, a bad gate, a stale head, main and unscoped branches, a missing sha", async () => {
  const f = fixture();
  try {
    const t = stub();
    const run = over => publishCandidate({ repo: f.repo, sha: f.sha, branch: BRANCH, extra, transport: t, workRoot: f.d, ...over });
    const failing = fixture({ testOk: false });
    try {
      const r = await publishCandidate({ repo: failing.repo, sha: failing.sha, branch: BRANCH, extra, transport: t, workRoot: failing.d });
      assert.deepEqual([r.code, r.gates.map(g => [g.name, g.status])], ["GATE_FAILED", [["test-lint", 0], ["tests", 1]]]);
    } finally { failing.cleanup(); }
    const slow = await run({ extra: [{ name: "slow", argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"], timeoutMs: 300 }] });
    assert.deepEqual([slow.code, slow.gates.map(g => [g.name, g.killed_for, g.status])], ["GATE_FAILED", [["test-lint", null, 0], ["slow", "timeout", null]]]);
    assert.equal((await run({ required: [] })).code, "NO_GATES");
    assert.equal((await run({ extra: [{ name: "x" }] })).code, "GATE_SHAPE");
    assert.equal((await run({ extra: [{ name: "nope", argv: ["/nonexistent/binary"] }] })).code, "GATE_FAILED");
    // The head moves while the gates run -- from OUTSIDE the box (a gate cannot write the repository): a slow gate
    // runs, the branch is committed to meanwhile, and the admitted object is no longer the candidate.
    const slowGate = { name: "slow-ok", argv: [process.execPath, "-e", "setTimeout(() => {}, 1500)"], timeoutMs: 20_000 };
    const pending = run({ extra: [slowGate] });
    await new Promise(res => setTimeout(res, 500));
    f.g(f.repo, "commit", "-q", "--allow-empty", "-m", "late");
    const stale = await pending;
    assert.deepEqual([stale.code, stale.gates.map(g => g.passed)], ["STALE", [true, true]]);
    // A gate that tries to move the head itself is refused by the read-only box: it fails, and the head stays.
    const fresh = fixture();
    try {
      const mover = { name: "moves-the-head", argv: ["git", "-C", fresh.repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "inside"] };
      const m = await publishCandidate({ repo: fresh.repo, sha: fresh.sha, branch: BRANCH, extra: [mover], transport: t, workRoot: fresh.d });
      assert.deepEqual([m.code, m.gates.map(g => [g.name, g.passed])], ["GATE_FAILED", [["test-lint", true], ["moves-the-head", false]]]);
      assert.equal(fresh.g(fresh.repo, "rev-parse", BRANCH), fresh.sha, "the repository was not written from inside the box");
    } finally { fresh.cleanup(); }
    assert.equal((await run({})).code, "HEAD_MISMATCH", "and from then on the candidate no longer matches the branch");
    for (const branch of ["main", "master", "feature/x", "claude", "claude/../main"]) assert.equal((await run({ branch })).code, "BRANCH_SCOPE", branch);
    assert.equal((await run({ sha: "0".repeat(40) })).code, "NO_COMMIT");
    assert.equal((await run({ sha: "HEAD" })).code, "SHA_SHAPE");
    assert.equal(t.calls.length, 0, "not one refused case reached the transport");
  } finally { f.cleanup(); }
});

test("no caller-supplied status authorizes the transport: claims beside a failing gate are ignored", async () => {
  const f = fixture({ lint: 1 });
  try {
    const t = stub();
    const r = await publishCandidate({ repo: f.repo, sha: f.sha, branch: BRANCH, extra, transport: t, workRoot: f.d, status: 0, passed: true, ok: true, lint: "passed" });
    assert.deepEqual([r.ok, r.code, t.calls.length], [false, "GATE_FAILED", 0]);
  } finally { f.cleanup(); }
});

test("the normal entry: the CLI refuses a lint-failing commit and publishes a passing one to a local bare remote, exactly at the sha", () => {
  for (const [lint, want] of [[1, { status: 1, ok: false, code: "GATE_FAILED", remote: null }], [0, { status: 0, ok: true, code: "PUBLISHED" }]]) {
    const f = fixture({ lint });
    try {
      const r = spawnSync(process.execPath, [CLI, "--repo", f.repo, "--sha", f.sha, "--branch", BRANCH, "--test", "t.test.mjs", "--receipts", join(f.d, "receipts")],
        { encoding: "utf8", timeout: 120_000 });
      const out = JSON.parse(r.stdout);
      assert.deepEqual([r.status, out.ok, out.code], [want.status, want.ok, want.code], r.stderr);
      assert.equal(f.remoteHead(), lint ? null : f.sha, "the remote branch holds exactly the admitted object, or nothing");
      assert.equal(existsSync(out.receipt), true);
    } finally { f.cleanup(); }
  }
});

test("required gates are the module's: a caller's extra test gate adds to them and cannot replace or omit the lint", async () => {
  assert.deepEqual(REQUIRED_GATES.map(g => g.name), ["test-lint"]);
  assert.throws(() => { REQUIRED_GATES.push({ name: "x", argv: ["true"] }); }, TypeError, "the requirement is frozen");
  const f = fixture({ lint: 1 });
  try {
    const t = stub();
    // Only passing extra gates, and the lint still runs first and refuses.
    const r = await publishCandidate({ repo: f.repo, sha: f.sha, branch: BRANCH, extra: [{ name: "always-ok", argv: [process.execPath, "-e", "0"] }], transport: t, workRoot: f.d });
    assert.deepEqual([r.code, r.gates.map(g => g.name), t.calls.length], ["GATE_FAILED", ["test-lint"], 0]);
  } finally { f.cleanup(); }
});

test("a gate that reads committed source through git sees the exact object: rev-parse HEAD inside the gate equals the sha", async () => {
  const f = fixture();
  try {
    const t = stub();
    const probe = { name: "head-is-sha", argv: [process.execPath, "-e", `const h = require("child_process").execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); process.exit(h === ${JSON.stringify(f.sha)} ? 0 : 3);`] };
    const r = await publishCandidate({ repo: f.repo, sha: f.sha, branch: BRANCH, extra: [probe], transport: t, workRoot: f.d });
    assert.deepEqual([r.code, r.gates.map(g => [g.name, g.status])], ["PUBLISHED", [["test-lint", 0], ["head-is-sha", 0]]], r.why);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------- generation 2: the committed input across gates
const writer = (file, text) => ({ name: `writes-${file}`, argv: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(text)})`] });
const reader = (file, want) => ({ name: `reads-${file}`, argv: [process.execPath, "-e", `process.exit(require("fs").readFileSync(${JSON.stringify(file)}, "utf8") === ${JSON.stringify(want)} ? 0 : 1)`] });

test("in a gate the committed input is read-only by the kernel (EROFS) while scratch is writable and git still reads HEAD; a rewriting gate fails before any later gate", async () => {
  const f = fixture();
  try {
    const t = stub();
    // The probe gate records what the kernel said about a write to a tracked file, writes scratch, and reads HEAD.
    const probe = { name: "probe", argv: [process.execPath, "-e", `
      const fs = require("fs"), path = require("path");
      let code; try { fs.writeFileSync("change.txt", "tampered\\n"); code = "WROTE"; } catch (e) { code = e.code; }
      const head = require("child_process").execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      fs.writeFileSync(path.join(process.env.OPHANIM_GATE_SCRATCH, "probe.json"), JSON.stringify({ code, head }));
      process.stdout.write(JSON.stringify({ code, head }));
      process.exit(code === "EROFS" && head === ${JSON.stringify(f.sha)} ? 0 : 7);`] };
    const r = await publishCandidate({ repo: f.repo, sha: f.sha, branch: BRANCH, extra: [probe], transport: t, workRoot: f.d });
    assert.deepEqual([r.code, r.gates.map(g => [g.name, g.status, g.input_intact])], ["PUBLISHED", [["test-lint", 0, true], ["probe", 0, true]]], r.why);
    assert.deepEqual(JSON.parse(readFileSync(r.gates[1].stdout_ref, "utf8")), { code: "EROFS", head: f.sha }, "kernel read-only evidence, and HEAD readable");
    // A gate that rewrites a tracked input is stopped by the kernel: it fails, the reader after it never runs.
    const r2 = await publishCandidate({ repo: f.repo, sha: f.sha, branch: BRANCH, extra: [writer("change.txt", "generated\n"), reader("change.txt", "generated\n")], transport: t, workRoot: f.d });
    assert.deepEqual([r2.code, r2.gates.map(g => [g.name, g.status])], ["GATE_FAILED", [["test-lint", 0], ["writes-change.txt", 1]]]);
    assert.match(readFileSync(r2.gates[1].stderr_ref, "utf8"), /EROFS|read-only file system/i);
    const added = await publishCandidate({ repo: f.repo, sha: f.sha, branch: BRANCH, extra: [writer("new.json", "{}")], transport: t, workRoot: f.d });
    assert.equal(added.code, "GATE_FAILED", "an added file is refused by the kernel too");
    assert.equal(t.calls.length, 1, "only the probe run reached the transport");
    for (const x of [r, r2, added]) assert.equal(existsSync(x.checkout), false);
    assert.equal(f.g(f.repo, "status", "--porcelain"), "", "the caller's checkout is untouched");
  } finally { f.cleanup(); }
});

test("no unboxed path: when the read-only gate box cannot start, nothing runs and nothing is published", async () => {
  const f = fixture();
  try {
    const t = stub();
    const r = await publishCandidate({ repo: f.repo, sha: f.sha, branch: BRANCH, transport: t, workRoot: f.d, bwrap: "/nonexistent/bwrap" });
    assert.deepEqual([r.code, r.gates.length, t.calls.length, existsSync(r.checkout)], ["SANDBOX_UNAVAILABLE", 0, 0, false]);
  } finally { f.cleanup(); }
});

test("benign two-stage: gate output goes to the controller's separate scratch, the next gate reads it there, and the exact commit publishes", async () => {
  const f = fixture();
  try {
    const t = stub();
    const viaScratch = [
      { name: "produce", argv: [process.execPath, "-e", 'require("fs").writeFileSync(require("path").join(process.env.OPHANIM_GATE_SCRATCH, "status.json"), "{\\"ok\\":1}")'] },
      { name: "consume", argv: [process.execPath, "-e", 'process.exit(require("fs").readFileSync(require("path").join(process.env.OPHANIM_GATE_SCRATCH, "status.json"), "utf8") === "{\\"ok\\":1}" ? 0 : 1)'] },
    ];
    const r = await publishCandidate({ repo: f.repo, sha: f.sha, branch: BRANCH, extra: viaScratch, transport: t, workRoot: f.d });
    assert.deepEqual([r.code, r.gates.map(g => [g.name, g.status, g.input_intact]), t.calls.length],
      ["PUBLISHED", [["test-lint", 0, true], ["produce", 0, true], ["consume", 0, true]], 1], r.why);
    assert.equal(existsSync(r.checkout), false);
  } finally { f.cleanup(); }
});

test("cleanup on every outcome: the clone is removed after success, a gate refusal and a throwing transport; the receipt and gate hashes remain", async () => {
  const f = fixture();
  try {
    const boom = async () => { throw new Error("transport down"); };
    for (const [over, code] of [[{}, "PUBLISHED"], [{ extra: [{ name: "fails", argv: [process.execPath, "-e", "process.exit(4)"] }] }, "GATE_FAILED"], [{ transport: boom }, "TRANSPORT_FAILED"]]) {
      const r = await publishCandidate({ repo: f.repo, sha: f.sha, branch: BRANCH, transport: stub(), workRoot: f.d, ...over });
      assert.equal(r.code, code, r.why);
      assert.equal(existsSync(r.checkout), false, `${code}: no clone left behind`);
      const kept = JSON.parse(readFileSync(r.receipt_path, "utf8"));
      assert.deepEqual(kept.gates.map(g => /^[0-9a-f]{64}$/.test(g.stdout_sha256)), r.gates.map(() => true), `${code}: every gate's output hash is kept`);
    }
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------- generation 3: a least-privilege read view
test("a gate sees only its allowlisted view: a marker outside the checkout and scratch is not visible, the network is refused, and EROFS, scratch and HEAD hold", async () => {
  const f = fixture();
  try {
    const marker = join(f.d, "outside-marker.txt");
    writeFileSync(marker, "harmless marker\n");
    const t = stub();
    const look = { name: "look", argv: [process.execPath, "-e", `
      const fs = require("fs"), path = require("path"), net = require("net");
      const seen = { marker: fs.existsSync(${JSON.stringify(marker)}), repo: fs.existsSync(${JSON.stringify(f.repo)}) };
      try { fs.writeFileSync("change.txt", "x"); seen.write = "WROTE"; } catch (e) { seen.write = e.code; }
      fs.writeFileSync(path.join(process.env.OPHANIM_GATE_SCRATCH, "s.txt"), "ok"); seen.scratch = fs.readFileSync(path.join(process.env.OPHANIM_GATE_SCRATCH, "s.txt"), "utf8");
      seen.head = require("child_process").execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const s = net.connect({ host: "127.0.0.1", port: 9 });
      s.on("connect", () => { seen.net = "CONNECTED"; done(); }); s.on("error", e => { seen.net = e.code; done(); });
      function done() { process.stdout.write(JSON.stringify(seen)); process.exit(0); }`] };
    const r = await publishCandidate({ repo: f.repo, sha: f.sha, branch: BRANCH, extra: [look], transport: t, workRoot: f.d });
    assert.equal(r.code, "PUBLISHED", r.why);
    const seen = JSON.parse(readFileSync(r.gates[1].stdout_ref, "utf8"));
    assert.deepEqual([seen.marker, seen.repo, seen.write, seen.scratch, seen.head], [false, false, "EROFS", "ok", f.sha]);
    assert.notEqual(seen.net, "CONNECTED", `the network is unshared (${seen.net})`);
    assert.equal(existsSync(marker), true, "the marker is untouched outside");
    assert.equal(existsSync(r.checkout), false);
  } finally { f.cleanup(); }
});
