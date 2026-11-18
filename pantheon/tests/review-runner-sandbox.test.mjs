import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnv, resolveInRoot, ToolRefusal } from "../src/review-runner/sandbox.mjs";
import { mkdtemp, cleanup } from "./review-runner-helper.mjs";
import { createToolbox, permissionsFor } from "../src/review-runner/tools.mjs";

after(cleanup);

const PASS = 'import test from "node:test";\ntest("ok", () => {});\n';

async function tree() {
  const base = await mkdtemp(join(tmpdir(), "rr-sbx-"));
  const root = join(base, "wt"), outside = join(base, "outside");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "pantheon/tests"), { recursive: true });
  await mkdir(join(root, "ophanim/operate"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "docs/reviews/r"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "OUTSIDE-SECRET\n");
  await writeFile(join(root, ".git/config"), "[core]\n");
  await writeFile(join(root, "a.txt"), "alpha\nbeta\ngamma\n");
  await writeFile(join(root, "docs/reviews/r/findings-2-openai.md"), "PRIOR\n");
  await writeFile(join(root, "pantheon/tests/agy-x.test.mjs"), PASS);
  await writeFile(join(root, "pantheon/tests/other.test.mjs"), PASS);
  await writeFile(join(root, "ophanim/operate/x.test.mjs"), PASS);
  await writeFile(join(root, "scripts/x.test.mjs"), PASS);
  await symlink(outside, join(root, "out-link"));
  await symlink(join(outside, "secret.txt"), join(root, "secret-link.txt"));
  await symlink("a.txt", join(root, "inside-link.txt"));
  return { base, root, outside };
}

const env = home => buildChildEnv({ parentEnv: { PATH: process.env.PATH }, home, tmpdir: home });
const box = (root, testing, listed = []) => createToolbox({ root, permissions: permissionsFor(testing, listed), env: env(root), timeoutMs: 20_000 });

test("paths: absolute, '..', .git, symlink escape and withheld findings are refused; inside paths work", async () => {
  const { root } = await tree();
  for (const p of ["/etc/passwd", "../outside/secret.txt", "a/../../x", ".git/config", "pantheon/.git/x", "out-link/secret.txt", "secret-link.txt", "~/x", "docs/reviews/r/findings-2-openai.md"]) {
    await assert.rejects(resolveInRoot(root, p), ToolRefusal, p);
  }
  assert.equal((await resolveInRoot(root, "inside-link.txt")).rel, "inside-link.txt");
  const t = box(root, "Synthetic identity and ledger tests");
  for (const p of ["/etc/passwd", "../outside/secret.txt", ".git/config", "secret-link.txt", "out-link/secret.txt"]) {
    const r = await t.call("read_file", { path: p });
    assert.ok(r.refused, p);
    assert.doesNotMatch(r.text, /OUTSIDE-SECRET/);
  }
  const ok = await t.call("read_file", { path: "a.txt", start_line: 2, end_line: 3 });
  assert.equal(ok.text, "2\tbeta\n3\tgamma\n");
  const g = await t.call("grep", { pattern: "SECRET|PRIOR|core" });
  assert.equal(g.text, "(no matches)"); // symlinks, .git and withheld files are not searched
  const l = await t.call("list_files", { path: "." });
  assert.doesNotMatch(l.text, /\.git/);
  const lr = await t.call("list_files", { path: "docs/reviews/r" });
  assert.equal(lr.text, "(empty)");
  const lg = await t.call("list_files", { path: ".", glob: "pantheon/tests/*.test.mjs" });
  assert.deepEqual(lg.text.split("\n"), ["pantheon/tests/agy-x.test.mjs", "pantheon/tests/other.test.mjs"]);
});

test("write_test writes only .review-tests/<name>.test.mjs", async () => {
  const { root, outside } = await tree();
  const t = box(root, "Local deterministic fixtures");
  for (const name of ["../evil", "a/b", "UPPER", "", "x".repeat(65), "x.test"]) {
    assert.ok((await t.call("write_test", { name, content: PASS })).refused, name);
  }
  const ok = await t.call("write_test", { name: "probe-1", content: PASS });
  assert.ok(!ok.refused && !ok.error, ok.text);
  assert.equal(await readFile(join(root, ".review-tests/probe-1.test.mjs"), "utf8"), PASS);

  // A .review-tests that is a symlink out of the root is refused.
  const { root: root2 } = await tree();
  await symlink(outside, join(root2, ".review-tests"));
  const r = await box(root2, "Local deterministic fixtures").call("write_test", { name: "x", content: PASS });
  assert.ok(r.refused);
  await assert.rejects(stat(join(outside, "x.test.mjs")));
});

test("run_tests under assignments 1-3: existing ophanim/ or pantheon/tests/ tests and .review-tests only", async () => {
  const { root } = await tree();
  const t = box(root, "Mock providers and isolated processes");
  assert.ok((await t.call("run_tests", { files: ["scripts/x.test.mjs"] })).refused);
  assert.ok((await t.call("run_tests", { files: ["a.txt"] })).refused);
  assert.ok((await t.call("run_tests", { files: [] })).refused);
  const r = await t.call("run_tests", { files: ["pantheon/tests/other.test.mjs", "ophanim/operate/x.test.mjs"] });
  assert.equal(r.exit_code, 0, r.text);
  await t.call("write_test", { name: "mine", content: PASS });
  assert.equal((await t.call("run_tests", { files: [".review-tests/mine.test.mjs"] })).exit_code, 0);
  assert.deepEqual(permissionsFor("Mock providers and isolated processes").tools, ["list_files", "read_file", "grep", "write_test", "run_tests", "run_suite"]);
});

test("assignment 4: no write_test, no run_suite, run_tests only on the listed files", async () => {
  const { root } = await tree();
  const perms = permissionsFor("Source inspection and existing authorized tests only", ["pantheon/tests/agy-x.test.mjs"]);
  assert.deepEqual(perms.tools, ["list_files", "read_file", "grep", "run_tests"]);
  const t = box(root, "Source inspection and existing authorized tests only", ["pantheon/tests/agy-x.test.mjs"]);
  assert.deepEqual(t.definitions.map(d => d.name), ["list_files", "read_file", "grep", "run_tests"]);
  assert.match((await t.call("write_test", { name: "x", content: PASS })).text, /not available/);
  assert.match((await t.call("run_suite", { suite: "all" })).text, /not available/);
  const no = await t.call("run_tests", { files: ["pantheon/tests/other.test.mjs"] });
  assert.ok(no.refused);
  assert.match(no.text, /not one of the existing tests this assignment lists/);
  assert.ok((await t.call("run_tests", { files: ["pantheon/tests/agy-x.test.mjs", "pantheon/tests/other.test.mjs"] })).refused);
  assert.equal((await t.call("run_tests", { files: ["pantheon/tests/agy-x.test.mjs"] })).exit_code, 0);
  assert.equal(permissionsFor("Some new testing limit"), null); // unknown limit: no policy, the runner refuses
});

test("child env is built from nothing: no keys, tokens, secrets or credentialed proxies", () => {
  const parent = {
    PATH: "/usr/bin", LANG: "en_US.UTF-8", HOME: "/home/fixture",
    OPENAI_API_KEY: "sk-live", XAI_API_KEY: "xai-live", GEMINI_API_KEY: "AIza-live", GITHUB_TOKEN: "ghp", AWS_SECRET_ACCESS_KEY: "s",
    NODE_OPTIONS: "--require /x", HTTPS_PROXY: "http://proxy:3128", HTTP_PROXY: "http://user:pw@proxy:3128", ALL_PROXY: "socks://x",
    OPHANIM_TELOS_ROOT: "/owner/telos", ANTHROPIC_BASE_URL: "http://x",
  };
  const e = buildChildEnv({ parentEnv: parent, home: "/tmp/h", tmpdir: "/tmp/t" });
  assert.deepEqual(Object.keys(e).sort(), ["HOME", "HTTPS_PROXY", "LANG", "PATH", "TMPDIR"]);
  assert.equal(e.HOME, "/tmp/h");
  assert.equal(e.TMPDIR, "/tmp/t");
  const withTelos = buildChildEnv({ parentEnv: parent, home: "/tmp/h", tmpdir: "/tmp/t", telosRoot: "/given/telos" });
  assert.equal(withTelos.OPHANIM_TELOS_ROOT, "/given/telos");
  const leaky = buildChildEnv({ parentEnv: { PATH: "/usr/bin:sk-live" }, home: "/h", tmpdir: "/t", secrets: ["sk-live"] });
  assert.equal(leaky.PATH, undefined);
});

test("a test run sees the scrubbed env, and a hanging process is killed at the timeout", async () => {
  const { root } = await tree();
  const childEnv = buildChildEnv({ parentEnv: { ...process.env, OPENAI_API_KEY: "sk-should-not-leak" }, home: join(root, "h"), tmpdir: root });
  const t = createToolbox({ root, permissions: permissionsFor("Local deterministic fixtures"), env: childEnv, timeoutMs: 1500 });
  await t.call("write_test", { name: "env", content: 'import test from "node:test";\ntest("env", () => { console.log("ENV=" + JSON.stringify(Object.keys(process.env).sort())); });\n' });
  const r = await t.call("run_tests", { files: [".review-tests/env.test.mjs"] });
  assert.equal(r.exit_code, 0, r.text);
  assert.doesNotMatch(r.text, /OPENAI_API_KEY|sk-should-not-leak/);
  await t.call("write_test", { name: "hang", content: 'import test from "node:test";\ntest("hang", () => new Promise(() => setInterval(() => {}, 1000)));\n' });
  const h = await t.call("run_tests", { files: [".review-tests/hang.test.mjs"] });
  assert.equal(h.timed_out, true);
  assert.match(h.text, /timed out/);
});
