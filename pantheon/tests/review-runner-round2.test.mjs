// The runner defects the owner's round-2 records show (docs/reviews/2026-11-18-independent-review/findings-runs-77480d6
// and findings-*-77480d6, WSL host, 2026-11-19), each with the test that would have caught it:
//   1. Codex on WSL failed before any turn ("bwrap cannot mkdir /run/WSL under denied /run"); the operator wrapped the
//      whole runner in an outer bwrap namespace (host read-only, private /run and /tmp). The runner now does that itself
//      on WSL, around codex only, keeping the inner profile and its exact-profile preflight.
//   2. "Git could not independently confirm HEAD": the worktree's .git file named <repo>/.git/worktrees/<id>, unreadable
//      in codex's profile. The copy is now a fresh single-commit repository -- and no withheld findings file can be
//      recovered from its history.
//   3. pipeline-a2a tests failed with `listen EINVAL` under a 107-byte TMPDIR: the scratch TMPDIR is now <= 48 bytes, checked against the repository's own socket tests.
// (4, the Grok permission form, is in review-runner-grok-stream and review-runner-subscription.)
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, EXIT } from "../src/review-runner/index.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { compareExport, exportReviewCopy, parseTreeEntries } from "../src/review-runner/review-copy.mjs";
import { SCRATCH_TMP_MAX, codexOuterLauncher, detectWsl, scratchCandidates, scratchFits } from "../src/review-runner/codex.mjs";
import { fixtureRepo, fakeFetch, capture, deps, sh, mkdtemp, cleanup, REVIEW_DIR } from "./review-runner-helper.mjs";
import { fakeCodexSdk, fakeReviewClis } from "./fixtures/review-clis.mjs";

after(cleanup);
const have = await sandboxAvailable("bwrap");
const needBwrap = { skip: have.ok ? false : `bwrap unavailable: ${have.why}` };

let shared;
async function setup() {
  shared ??= await fixtureRepo();
  const base = await mkdtemp(join(tmpdir(), "rr-r2-"));
  const bin = join(base, "bin"), home = join(base, "home"), outDir = join(base, "out");
  await mkdir(bin); await mkdir(join(home, ".codex"), { recursive: true }); await mkdir(outDir);
  return { repo: shared, base, bin, home, outDir, clis: fakeReviewClis(bin) };
}
async function run(f, { n = 2, args = [], env = {}, extra = {} } = {}) {
  const out = capture();
  const d = await deps({ root: f.repo.root, out, fetch: fakeFetch([]), env: { PATH: `${f.bin}:${process.env.PATH}`, HOME: f.home, ...env } });
  d.CodexSDK = fakeCodexSdk();
  d.osRelease = "6.6.0-generic";   // not WSL unless a test says so
  Object.assign(d, extra);
  const code = await main(["--via", "subscription", "--assignment", String(n), "--commit", f.repo.commit, "--out", f.outDir, "--codex-cli", f.clis.codex, "--max-wall-s", "60", ...args], d);
  let plan = null; try { plan = JSON.parse(out.out); } catch {}
  return { code, out, plan, d, sdk: d.CodexSDK.calls, read: name => readFile(join(f.outDir, name), "utf8") };
}
const headerOf = md => md.split("<!-- reviewer's final message, verbatim, follows -->\n\n")[0];

// ---- 2. the review copy ---------------------------------------------------------------------------------------------

test("the review copy is a fresh single-commit repository: git works in it, every blob id is the source's, the withheld findings are in no object, the owner's repository is untouched, and the commit id is reproducible", async () => {
  const { root, commit } = await fixtureRepo();
  // History the old worktree exposed: an earlier commit with another reviewer's findings, since deleted.
  await mkdir(join(root, REVIEW_DIR, "findings-2-xai-old"), { recursive: true });
  await writeFile(join(root, REVIEW_DIR, "findings-2-xai-old", "findings-2-xai.md"), "OLD-ROUND-WITHHELD-MARKER\n");
  const g = (...a) => sh("git", ["-C", root, ...a]);
  await g("add", "-A"); await g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "old round");
  await g("rm", "-rq", `${REVIEW_DIR}/findings-2-xai-old`); await g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "drop old round");
  const head = (await g("rev-parse", "HEAD")).trim();
  assert.notEqual(head, commit);
  const indexBefore = await g("ls-files", "-s"), statusBefore = await g("status", "--porcelain");
  const withheld = [`${REVIEW_DIR}/findings-4-openai.md`];
  const base = await mkdtemp(join(tmpdir(), "rr-copy-"));
  const c = await exportReviewCopy({ repoRoot: root, commit: head, dest: join(base, "copy"), withheld, scratch: join(base, "scratch") });
  const cg = (...a) => sh("git", ["-C", join(base, "copy"), ...a]);
  // git works, with one commit naming the source.
  assert.equal((await cg("rev-list", "--count", "HEAD")).trim(), "1");
  assert.equal((await cg("rev-parse", "HEAD")).trim(), c.head);
  assert.match(await cg("log", "-1", "--format=%B"), new RegExp(`^Review copy of ${head}\\n\\nsource-commit: ${head}\\nsource-tree: ${c.source_tree}\\nwithheld: 1 path`));
  assert.equal((await cg("status", "--porcelain")).trim(), "", "a clean copy");
  assert.equal((await cg("remote")).trim(), "", "no remote");
  assert.deepEqual(await readdir(join(base, "copy", ".git", "hooks")).catch(() => []), [], "no hooks (no template)");
  // Every blob id is the source commit's; the withheld path is absent.
  const src = parseTreeEntries(await g("ls-tree", "-r", "-z", "--full-tree", head), "ls-tree"), dst = parseTreeEntries(await cg("ls-files", "-s", "-z"), "ls-files");
  assert.equal(dst.size, src.size - 1);
  for (const [p, v] of dst) assert.equal(v, src.get(p), p);
  assert.equal(existsSync(join(base, "copy", withheld[0])), false);
  // No object of the copy holds a withheld or historical findings file (the old worktree's `git log -p` did).
  const objects = await cg("cat-file", "--batch-all-objects", "--batch");
  assert.doesNotMatch(objects, /PRIOR-FINDINGS-UNIQUE-MARKER|OLD-ROUND-WITHHELD-MARKER/);
  assert.doesNotMatch(await cg("log", "--all", "-p"), /PRIOR-FINDINGS-UNIQUE-MARKER|OLD-ROUND-WITHHELD-MARKER/);
  // The owner's repository: same index, same status, no worktree, no new ref.
  assert.equal(await g("ls-files", "-s"), indexBefore);
  assert.equal(await g("status", "--porcelain"), statusBefore);
  assert.equal((await g("worktree", "list")).trim().split("\n").length, 1);
  // Reproducible: the same tree gives the same commit id.
  const c2 = await exportReviewCopy({ repoRoot: root, commit: head, dest: join(base, "copy2"), withheld, scratch: join(base, "scratch2") });
  assert.deepEqual([c2.head, c2.tree], [c.head, c.tree]);
  assert.deepEqual([c.source_commit, c.withheld_count, c.files], [head, 1, dst.size]);
});

test("compareExport refuses any difference: a changed blob, a missing path, an extra or withheld path", () => {
  const src = new Map([["a", "100644 aa"], ["b", "100755 bb"], ["w", "100644 ww"]]);
  assert.equal(compareExport(src, new Map([["a", "100644 aa"], ["b", "100755 bb"]]), ["w"]).ok, true);
  assert.deepEqual(compareExport(src, new Map([["a", "100644 XX"], ["b", "100755 bb"]]), ["w"]).differ, ["a"]);
  assert.deepEqual(compareExport(src, new Map([["a", "100644 aa"]]), ["w"]).missing, ["b"]);
  assert.deepEqual(compareExport(src, new Map([["a", "100644 aa"], ["b", "100755 bb"], ["w", "100644 ww"], ["x", "100644 xx"]]), ["w"]).unexpected, ["w", "x"]);
  assert.deepEqual(compareExport(src, new Map([["a", "100644 aa"], ["b", "100644 bb"]]), ["w"]).differ, ["b"], "a mode change is a difference");
});

test("a codex run reviews the fresh copy: the header records review_copy (HEAD, tree, the source commit's blob ids, the withheld count)", async () => {
  const f = await setup();
  const r = await run(f, { n: 2 });
  assert.equal(r.code, EXIT.complete, r.out.err);
  const h = headerOf(await r.read("findings-2-openai.md"));
  assert.match(h, new RegExp(`^- review_copy: fresh single-commit git repository .*: HEAD \`[0-9a-f]{40}\` \\(tree \`[0-9a-f]{40}\`\\), \\d+ file\\(s\\) whose modes and blob ids equal \`${f.repo.commit}\`'s \\(tree \`[0-9a-f]{40}\`\\), 1 withheld path\\(s\\) never written into it$`, "m"));
  const t = JSON.parse(await r.read("findings-2-openai.transcript.json"));
  assert.equal(t.review_copy.source_commit, f.repo.commit);
  assert.equal((await sh("git", ["-C", f.repo.root, "worktree", "list"])).trim().split("\n").length, 1, "no worktree of the owner's repository");
});

// ---- 3. the scratch TMPDIR ---------------------------------------------------------------------------------------------

test("the codex scratch TMPDIR is at most 48 bytes: under the review temp base when that fits, else /var/tmp; removed after the run; a warning when nothing fits", async () => {
  assert.equal(scratchFits({ parent: "/home/u/.cache/ophanim-review", prefix: "t-" }), true);
  // The owner's round-2 base: 107-byte sockets failed under it.
  const owner = "/home/fixture/Projects/OPHANIM-review-77480d6-s7aehe1w/home-astra-a4/.cache/ophanim-review";
  assert.deepEqual(scratchCandidates(owner).map(scratchFits), [false, true]);
  const f = await setup();
  let r = await run(f, { n: 4 });
  assert.equal(r.code, EXIT.complete, r.out.err);
  const near = r.plan.scratch_tmp;
  assert.ok(near.bytes <= SCRATCH_TMP_MAX && near.path.startsWith(r.d.tmpBase + "/t-"), JSON.stringify(near));
  assert.equal(r.sdk[0].tmpdir, near.path, "the SDK's env carries it as TMPDIR");
  assert.match(headerOf(await r.read("findings-4-openai.md")), /^- scratch_tmpdir: `.+` \(\d+ bytes; at most 48 so the tests' Unix sockets fit 107 bytes\)$/m);
  // A long temp base (as on the owner's host): /var/tmp, removed after the run.
  const long = join(await mkdtemp(join(tmpdir(), "rr-r2-long-")), "x".repeat(70));
  r = await run(f, { n: 4, args: ["--force"], extra: { tmpBase: long } });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.ok(r.plan.scratch_tmp.path.startsWith("/var/tmp/ophanim-rt-") && r.plan.scratch_tmp.bytes <= SCRATCH_TMP_MAX, r.plan.scratch_tmp.path);
  assert.equal(r.sdk[0].tmpdir, r.plan.scratch_tmp.path);
  assert.equal(existsSync(r.plan.scratch_tmp.path), false, "removed after the run");
  assert.ok(r.plan.sandbox.filesystem[r.plan.scratch_tmp.path] === "write");
  // Nothing fits: the old in-run dir, with a warning naming the socket limit.
  r = await run(f, { n: 4, args: ["--force", "--dry-run"], extra: { tmpBase: long, scratchCandidates: () => [{ parent: long, prefix: "t-" }] } });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.match(r.plan.preflight.warnings.join(""), /scratch TMPDIR: no candidate .* is at most 48 bytes .*listen EINVAL \(the limit is 107 bytes\)/);
});

// ---- 1. WSL: the outer runtime -------------------------------------------------------------------------------------------

test("detectWsl: the kernel release or WSL_DISTRO_NAME; the launcher is the operator's argv (host read-only, private /run and /tmp) around codex", () => {
  assert.equal(detectWsl({ osrelease: "5.15.167.4-microsoft-standard-WSL2" }).wsl, true);
  assert.equal(detectWsl({ env: { WSL_DISTRO_NAME: "Ubuntu" }, osrelease: "6.6.0" }).wsl, true);
  assert.deepEqual(detectWsl({ env: {}, osrelease: "6.18.44-fc-v653" }), { wsl: false, evidence: [] });
  const l = codexOuterLauncher({ bwrap: "/usr/bin/bwrap", codex: "/n/vendor/bin/codex", writable: ["/h/.cache/ophanim-review/run-x", "/h/.codex"], readOnly: ["/n/vendor/bin"] });
  // The operator's launch (findings-1-openai-77480d6/operator-launch.json), with codex in place of the whole runner.
  assert.deepEqual(l.argv.slice(0, 13), ["/usr/bin/bwrap", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/run", "--tmpfs", "/tmp"]);
  assert.deepEqual(l.argv.slice(-2), ["--", "/n/vendor/bin/codex"]);
  assert.deepEqual(l.writable, ["/h/.codex", "/h/.cache/ophanim-review/run-x"]);
  assert.match(l.script, /^#!\/bin\/sh\n.*\nexec '\/usr\/bin\/bwrap' '--die-with-parent' .* '--' '\/n\/vendor\/bin\/codex' "\$@"\n$/s);
  assert.throws(() => codexOuterLauncher({ bwrap: "bwrap", codex: "/c", writable: [] }), /not an absolute path/);
});

test("on WSL (detected, or --codex-outer-runtime on) codex and every preflight run through the outer namespace: a private /tmp, the unchanged inner profile passes its exact check, WSL_INTEROP dropped, the header says so", needBwrap, async () => {
  const f = await setup();
  const marker = join(f.base, "host-tmp-marker");
  await writeFile(marker, "x");
  // Not WSL: no outer runtime; the marker under the host /tmp is visible to codex.
  let r = await run(f, { n: 2, args: ["--dry-run"], env: { FAKE_CODEX_MARKER: marker } });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.deepEqual([r.plan.codex_outer_runtime.applied, r.plan.codex_outer_runtime.wsl], [false, false]);
  assert.match(r.plan.preflight.checks.version.text, /marker=visible/);
  // WSL detected from the kernel release.
  r = await run(f, { n: 2, env: { FAKE_CODEX_MARKER: marker, WSL_INTEROP: "/run/WSL/1_interop" }, extra: { osRelease: "5.15.167.4-microsoft-standard-WSL2" } });
  assert.equal(r.code, EXIT.complete, r.out.err);
  const o = r.plan.codex_outer_runtime;
  assert.deepEqual([o.applied, o.wsl, o.mode], [true, true, "auto"]);
  assert.match(r.plan.preflight.checks.version.text, /marker=hidden/, "the preflight ran inside the outer namespace (private /tmp)");
  assert.equal(r.plan.preflight.checks.permission_profile.ok, true, "the exact-profile check passes through the launcher");
  assert.equal(r.sdk[0].codexPathOverride, o.launcher, "the SDK spawns the launcher");
  assert.ok(!r.sdk[0].env_names.includes("WSL_INTEROP"));
  assert.deepEqual(r.plan.argv.slice(0, 13), [o.argv[0], "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/run", "--tmpfs", "/tmp"]);
  assert.ok(o.writable.includes(r.plan.scratch_tmp.path) && o.writable.some(p => p.endsWith("/.codex")));
  const h = headerOf(await r.read("findings-2-openai.md"));
  assert.match(h, /^- codex_outer_runtime: an outer bwrap namespace around codex \(WSL: \/proc\/sys\/kernel\/osrelease is "5\.15\.167\.4-microsoft-standard-WSL2"\): host read-only, private \/run and \/tmp, writable only .*unchanged inner permission profile.*Cost: one more namespace level$/m);
  assert.match(h, /- sandbox: codex permission profile ophanim-review \(codex's own bubblewrap sandbox, inside the runner's outer WSL namespace/);
  // Forced off on WSL: recorded; forced on elsewhere: applied.
  r = await run(f, { n: 2, args: ["--dry-run", "--codex-outer-runtime", "off"], extra: { osRelease: "5.15.167.4-microsoft-standard-WSL2" } });
  assert.deepEqual([r.code, r.plan.codex_outer_runtime.applied, r.plan.codex_outer_runtime.wsl], [EXIT.complete, false, true]);
  r = await run(f, { n: 2, args: ["--dry-run", "--codex-outer-runtime", "on"], env: { FAKE_CODEX_MARKER: marker } });
  assert.deepEqual([r.code, r.plan.codex_outer_runtime.applied], [EXIT.complete, true], r.out.err);
  assert.match(r.plan.preflight.checks.version.text, /marker=hidden/);
  // No CODEX_HOME to bind: refused, never run outside the namespace on WSL.
  r = await run(f, { n: 2, args: ["--dry-run"], env: { CODEX_HOME: join(f.base, "absent") }, extra: { osRelease: "5.15.0-microsoft-standard-WSL2" } });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /the WSL outer runtime for codex could not be set up: .*absent \(CODEX_HOME\) does not exist/);
  assert.equal((await run(f, { n: 2, args: ["--dry-run", "--codex-outer-runtime", "maybe"] })).code, EXIT.usage);
});

test("the SCRATCH_TMP_MAX budget holds for the repository's own socket tests: pipeline-a2a, -mcp and -run pass with a TMPDIR of exactly that many bytes (21 of 29 failed under a ~100-byte one)", async () => {
  const base = await mkdtemp("/var/tmp/rr-r2-");
  const dir = join(base, "x".repeat(SCRATCH_TMP_MAX - base.length - 1));
  await mkdir(dir);
  assert.equal(Buffer.byteLength(dir), SCRATCH_TMP_MAX);
  const files = ["pipeline-a2a", "pipeline-mcp", "pipeline-run"].map(n => fileURLToPath(new URL(`./${n}.test.mjs`, import.meta.url)));
  const env = { ...process.env, TMPDIR: dir }; delete env.NODE_TEST_CONTEXT;   // a nested test run reports to its own stdout
  const out = await sh(process.execPath, ["--test", "--test-reporter=spec", ...files], { env }).catch(e => e.message);
  assert.match(out, /^ℹ fail 0$/m, out.slice(-3000));
  assert.match(out, /^ℹ cancelled 0$/m);
});
