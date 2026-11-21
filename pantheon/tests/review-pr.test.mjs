// The coordinator action "independently review a PR" (pantheon/src/review-runner/pr-review.mjs), and the runner's
// --review-dir it relies on. Every repository here is a throwaway one with a local bare `origin`; the reviewers are
// the stand-in runner tests/fixtures/review-pr-fake-runner.mjs. No CLI, no provider, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile, mkdtemp as mkdtempRaw } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as runReview } from "../src/review-runner/index.mjs";
import { BINDING_SCHEMA, LABS, MARKER, gitCli, judgeReviewer, main, panelProblems, reviewerSections, runnerArgs, sha256, shapeProblems, verifyBinding } from "../src/review-runner/pr-review.mjs";
import { assignmentRow } from "../src/review-runner/brief.mjs";
import { REAL_ROOT, fixtureRepo, fakeFetch, capture, deps, LIMITS, cleanup, mkdtemp, sh } from "./review-runner-helper.mjs";
import { fakeCodexSdk, fakeReviewClis } from "./fixtures/review-clis.mjs";

test.after(cleanup);
const FAKE = fileURLToPath(new URL("./fixtures/review-pr-fake-runner.mjs", import.meta.url));
const DIR = "docs/reviews/2026-11-21-pr-fixture";
const PANEL = [{ lab: "xai", model: "grok-4.7" }, { lab: "google", model: "gemini-4-carbon" }, { lab: "openai", model: "gpt-6-astra" }];
const HARNESS_CLI = readFileSync(join(REAL_ROOT, "docs/reviews/2026-11-21-pr84-account-refusal/HARNESS-cli.md"), "utf8");
const HARNESS = readFileSync(join(REAL_ROOT, "docs/reviews/2026-11-21-pr84-account-refusal/HARNESS.md"), "utf8");
const ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];

// A checkout with a bound brief for PR 84 of a local origin: main, a PR head pushed as refs/pull/84/head, main moved on
// after the PR branched (so the merge base is not main's tip), and the brief and its binding committed on main.
async function prFixture({ panel = PANEL, author = ["Anthropic"], edit } = {}) {
  const root = await mkdtemp(join(tmpdir(), "prr-"));
  const origin = join(root, "origin.git"), repo = join(root, "repo");
  const g = (...a) => sh("git", ["-C", repo, ...a]);
  await sh("git", ["init", "-q", "--bare", origin]);
  await sh("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "a.txt"), "one\n");
  await g("add", "-A"); await g(...ID, "commit", "-qm", "base");
  const mergeBase = (await g("rev-parse", "HEAD")).trim();
  await g("remote", "add", "origin", origin);
  await g("checkout", "-qb", "pr");
  await writeFile(join(repo, "a.txt"), "one\ntwo\n");
  await g("add", "-A"); await g(...ID, "commit", "-qm", "the PR");
  const head = (await g("rev-parse", "HEAD")).trim();
  await g("push", "-q", "origin", "HEAD:refs/pull/84/head");
  await g("checkout", "-q", "main");
  await writeFile(join(repo, "b.txt"), "main moved on\n");
  await g("add", "-A"); await g(...ID, "commit", "-qm", "main moves");
  const brief = {
    "README.md": `# Review of PR #84 at ${head}\n\n| # | Assignment | Reviewer lab | Scope | Testing |\n|---|---|---|---|---|\n| 1 | [The stop](1-the-stop.md) | xAI, \`grok-4.7\` | the stop | Mock providers and isolated processes |\n`,
    "1-the-stop.md": `# Assignment 1\n\nPR #84 at \`${head}\`.\n**Testing:** mock providers and isolated processes.\n\n## Questions\n\n1. Does it stop?\n`,
    "HARNESS.md": HARNESS, "HARNESS-cli.md": HARNESS_CLI,
  };
  await mkdir(join(repo, DIR), { recursive: true });
  for (const [f, t] of Object.entries(brief)) await writeFile(join(repo, DIR, f), t);
  const binding = { schema: BINDING_SCHEMA, repo: "dsmcewan/OPHANIM", pr: 84, base: { ref: "main", merge_base: mergeBase }, head: { ref: "pr", sha: head },
    brief: { dir: DIR, assignment: 1, files: Object.fromEntries(Object.entries(brief).map(([f, t]) => [f, sha256(t)])) },
    author: { labs: author }, via: "subscription", panel, telos: { ci_pin: "0".repeat(40) } };
  if (edit) edit(binding, { head, mergeBase, repo });
  await writeFile(join(repo, DIR, "binding.json"), JSON.stringify(binding, null, 2) + "\n");
  await g("add", "-A"); await g(...ID, "commit", "-qm", "the brief and its binding");
  await g("push", "-q", "origin", "main");
  return { root, origin, repo, head, mergeBase, binding, g };
}

// The checkout's origin is a local bare repository; its configured URL is what a GitHub checkout's would be.
const gitFn = (root, args) => args[0] === "remote" && args[1] === "get-url" ? Promise.resolve({ code: 0, stdout: "https://github.com/dsmcewan/OPHANIM.git\n", stderr: "" }) : gitCli(root, args);

async function run(f, { argv = [], behaviour = {}, stageRoot, graceMs, now } = {}) {
  const probe = join(f.root, `probe-${Math.random().toString(16).slice(2)}.jsonl`);
  const o = capture();
  const t0 = now ?? new Date(Date.UTC(2026, 10, 21, 21, 30, 0));
  const code = await main(["--binding", `${DIR}/binding.json`, "--telos-root", f.repo, "--max-wall-s", "60", ...argv], {
    repoRoot: f.repo, env: { ...process.env, FAKE_RR: JSON.stringify(behaviour), FAKE_RR_PROBE: probe }, out: o.stdout, err: o.stderr,
    now: () => t0, gitFn, runnerScript: FAKE, stageRoot: stageRoot ?? "/tmp", graceMs: graceMs ?? 60_000,
  });
  const lines = existsSync(probe) ? readFileSync(probe, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  return { code, o, probe: lines, releaseDir: join(f.repo, DIR, `findings-${f.head.slice(0, 12)}-${t0.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`) };
}

// ---- the runner's --review-dir ---------------------------------------------------------------------------------

test("REVIEW DIR: --review-dir loads another round's README, assignment and harness, and names them in the plan", async () => {
  const { root, commit } = await fixtureRepo();
  const other = "docs/reviews/2026-11-21-other-round";
  await mkdir(join(root, other), { recursive: true });
  await writeFile(join(root, other, "README.md"), "# Other\n\n| # | Assignment | Lab | Scope | Testing |\n|---|---|---|---|---|\n| 1 | [Other](1-other.md) | xAI, `grok-4.7` | x | Mock providers and isolated processes |\n");
  await writeFile(join(root, other, "1-other.md"), "# OTHER-ROUND-ASSIGNMENT-MARKER\n**Testing:** mock providers and isolated processes.\n");
  await writeFile(join(root, other, "HARNESS.md"), HARNESS);
  const out = capture();
  const code = await runReview(["--assignment", "1", "--commit", commit, ...LIMITS, "--review-dir", other, "--dry-run"], await deps({ root, out }));
  assert.equal(code, 0, out.err);
  const plan = JSON.parse(out.out);
  assert.equal(plan.assignment.file, `${other}/1-other.md`);
  assert.equal(plan.assignment.title, "Other");
  assert.equal(plan.request.harness_template.path, `${other}/HARNESS.md`);
  assert.equal(plan.request.harness_template.sha256, sha256(HARNESS));
  assert.ok(plan.out.findings.includes(other), "the findings default to the round's own directory");
});

test("REVIEW DIR: in subscription mode the preamble is the round's own HARNESS-cli.md", async () => {
  const { root, commit } = await fixtureRepo();
  const other = "docs/reviews/2026-11-21-other-round";
  await mkdir(join(root, other), { recursive: true });
  await writeFile(join(root, other, "README.md"), "# Other\n\n| # | Assignment | Lab | Scope | Testing |\n|---|---|---|---|---|\n| 1 | [Other](1-other.md) | OpenAI, `gpt-6-astra` | x | Mock providers and isolated processes |\n");
  await writeFile(join(root, other, "1-other.md"), "# Other\n**Testing:** mock providers and isolated processes.\n");
  const cli = HARNESS_CLI.replace("# Harness (command-line agent)", "# Harness (command-line agent) OTHER-ROUND-HARNESS-MARKER");
  await writeFile(join(root, other, "HARNESS-cli.md"), cli);
  await writeFile(join(root, other, "HARNESS.md"), HARNESS);
  const base = await mkdtemp(join(tmpdir(), "prr-sub-"));
  const bin = join(base, "bin"), home = join(base, "home"), outDir = join(base, "out");
  await mkdir(bin); await mkdir(home); await mkdir(outDir);
  const clis = fakeReviewClis(bin);
  const out = capture();
  const d = await deps({ root, out, fetch: fakeFetch([]), env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_CLI_LOG: join(base, "cli.log") } });
  d.CodexSDK = fakeCodexSdk();
  const code = await runReview(["--via", "subscription", "--assignment", "1", "--commit", commit, "--review-dir", other, "--out", outDir, "--codex-cli", clis.codex, "--max-wall-s", "60", "--dry-run"], d);
  assert.equal(code, 0, out.err);
  const plan = JSON.parse(out.out);
  assert.equal(plan.assignment.file, `${other}/1-other.md`);
  assert.deepEqual(plan.prompt.harness_cli_template, { path: `${other}/HARNESS-cli.md`, sha256: sha256(cli) });
  assert.equal(plan.prompt.readme_sha256, sha256(readFileSync(join(root, other, "README.md"), "utf8")));
});

test("REVIEW DIR: a --review-dir outside docs/reviews/<name> is a usage error, and the default round is unchanged", async () => {
  const { root, commit } = await fixtureRepo();
  for (const bad of ["../etc", "docs/reviews/a/b", "/tmp/x", "docs/reviews/..", "docs/other/x"]) {
    const out = capture();
    assert.equal(await runReview(["--assignment", "1", "--commit", commit, ...LIMITS, "--review-dir", bad, "--dry-run"], await deps({ root, out })), 2, bad);
    assert.match(out.err, /--review-dir must be docs\/reviews\/<name>/);
  }
  const out = capture();
  assert.equal(await runReview(["--assignment", "1", "--commit", commit, ...LIMITS, "--dry-run"], await deps({ root, out })), 0, out.err);
  assert.equal(JSON.parse(out.out).assignment.file, "docs/reviews/2026-11-18-independent-review/1-lifecycle-evidence.md");
});

// ---- the bindings, verified before dispatch ---------------------------------------------------------------------

test("PR REVIEW BINDING: a fresh record verifies, every check passes", async () => {
  const f = await prFixture();
  const v = await verifyBinding({ binding: f.binding, bindingRel: `${DIR}/binding.json`, repoRoot: f.repo, gitFn });
  assert.ok(v.ok, JSON.stringify(v.checks.filter(c => !c.ok)));
  assert.deepEqual(v.checks.map(c => c.check), ["shape", "record beside its brief", "committed", "brief digests", "assignment row", "brief names the candidate",
    "origin is the repository", "head in the checkout", "head is the PR's head now", "merge base with the base ref now", "panel independence"]);
});

const refusedCases = [
  ["the PR's head moved on origin", async f => {
    await writeFile(join(f.repo, "c.txt"), "x\n"); await f.g("add", "-A"); await f.g(...ID, "commit", "-qm", "moved");
    await f.g("push", "-qf", "origin", "HEAD:refs/pull/84/head"); await f.g("reset", "-q", "--hard", "HEAD~1");
  }, /FAILED  head is the PR's head now: origin refs\/pull\/84\/head is [0-9a-f]{40}: the PR moved/],
  ["a brief file changed after binding (uncommitted)", async f => { await writeFile(join(f.repo, DIR, "1-the-stop.md"), "changed\n"); }, /FAILED  committed: .*differs from HEAD[\s\S]*FAILED  brief digests: 1-the-stop\.md is sha256/],
  ["a brief file changed after binding (committed)", async f => { await writeFile(join(f.repo, DIR, "HARNESS-cli.md"), "changed\n"); await f.g("add", "-A"); await f.g(...ID, "commit", "-qm", "edit"); }, /FAILED  brief digests: HARNESS-cli\.md is sha256/],
  ["the record is not tracked", async f => { await f.g("rm", "-q", "--cached", `${DIR}/binding.json`); await f.g(...ID, "commit", "-qm", "untrack"); }, /FAILED  committed: not tracked/],
  ["the head is not in the checkout", null, /FAILED  head in the checkout: [0-9a-f]{40} is not in this checkout/, (b) => { b.head.sha = "1".repeat(40); }],
  ["the bound merge base is not the merge base", null, /FAILED  merge base with the base ref now: .* bound 2{40}/, (b) => { b.base.merge_base = "2".repeat(40); }],
  ["an author lab is on the panel", null, /FAILED  panel independence: .*xAI wrote the PR and cannot review it/, (b) => { b.author.labs = ["Anthropic", "xAI"]; }],
  ["two labs only", null, /FAILED  panel independence: .*2 distinct lab\(s\); a review panel keeps at least 3/, (b) => { b.panel = PANEL.slice(0, 2); }],
  ["a lab twice", null, /FAILED  panel independence: .*a lab appears more than once \(google\)/, (b) => { b.panel = [...PANEL, { lab: "google", model: "gemini-4-flash" }]; }],
  ["an Anthropic reviewer", null, /FAILED  shape: .*lab "anthropic" is not one of google, openai, xai/, (b) => { b.panel = [...PANEL, { lab: "anthropic", model: "claude-fable-5-2" }]; }],
  ["the metered API", null, /FAILED  shape: .*via must be "subscription"/, (b) => { b.via = "api"; }],
  ["the record is not in the brief's directory", async f => { await f.g("mv", `${DIR}/binding.json`, "binding.json"); await f.g(...ID, "commit", "-qm", "move"); }, /FAILED  record beside its brief: the record is binding\.json/, null, "binding.json"],
];
for (const [name, mutate, expect, edit, at] of refusedCases) {
  test(`PR REVIEW BINDING refuses before dispatch: ${name}`, async () => {
    const f = await prFixture({ edit: edit ?? undefined });
    if (mutate) await mutate(f);
    const o = capture();
    const probe = join(f.root, "probe.jsonl");
    const code = await main(["--binding", at ?? `${DIR}/binding.json`, "--telos-root", f.repo, "--max-wall-s", "60"], {
      repoRoot: f.repo, env: { ...process.env, FAKE_RR_PROBE: probe }, out: o.stdout, err: o.stderr, gitFn, runnerScript: FAKE, stageRoot: "/tmp" });
    assert.equal(code, 1, o.err);
    assert.match(o.err, expect);
    assert.match(o.err, /refused: a binding did not verify, so no reviewer was dispatched/);
    assert.ok(!existsSync(probe), "no reviewer was started");
    assert.ok(!(await readdir(join(f.repo, DIR)).catch(() => [])).some(e => e.startsWith("findings-")), "nothing was released");
  });
}

test("PR REVIEW BINDING refuses before dispatch: origin is another repository", async () => {
  const f = await prFixture();
  const other = (root, args) => args[0] === "remote" ? Promise.resolve({ code: 0, stdout: "git@github.com:someone/fork.git\n", stderr: "" }) : gitCli(root, args);
  const v = await verifyBinding({ binding: f.binding, bindingRel: `${DIR}/binding.json`, repoRoot: f.repo, gitFn: other });
  assert.ok(!v.ok);
  assert.match(v.checks.find(c => c.check === "origin is the repository").detail, /origin is someone\/fork, the record binds dsmcewan\/OPHANIM/);
});

test("PR REVIEW BINDING refuses before dispatch: origin cannot be reached", async () => {
  const f = await prFixture();
  await rm(f.origin, { recursive: true, force: true });
  const v = await verifyBinding({ binding: f.binding, bindingRel: `${DIR}/binding.json`, repoRoot: f.repo, gitFn });
  assert.ok(!v.ok);
  assert.match(v.checks.find(c => c.check === "head is the PR's head now").detail, /cannot read refs\/pull\/84\/head from origin/);
});

test("PR REVIEW BINDING: the brief must name the bound PR and head", async () => {
  const f = await prFixture({ edit: b => { b.head.sha = b.base.merge_base; } });
  const v = await verifyBinding({ binding: f.binding, bindingRel: `${DIR}/binding.json`, repoRoot: f.repo, gitFn });
  assert.match(v.checks.find(c => c.check === "brief names the candidate").detail, /README\.md, 1-the-stop\.md must name PR #84 and its head/);
});

test("PR REVIEW BINDING: the README's row for the assignment must link the bound assignment file", async () => {
  const f = await prFixture();
  await writeFile(join(f.repo, DIR, "2-other.md"), `PR #84 at ${f.head}\n`);
  await f.g("add", "-A"); await f.g(...ID, "commit", "-qm", "another assignment file");
  const files = { ...f.binding.brief.files, "2-other.md": sha256(`PR #84 at ${f.head}\n`) };
  delete files["1-the-stop.md"];
  const v = await verifyBinding({ binding: { ...f.binding, brief: { ...f.binding.brief, files } }, bindingRel: `${DIR}/binding.json`, repoRoot: f.repo, gitFn });
  const row = v.checks.find(c => c.check === "assignment row");
  assert.equal(row.ok, false);
  assert.match(row.detail, /README row 1 links 1-the-stop\.md, the record binds 2-other\.md/);
});

// ---- dispatch: one at a time, peers hidden, released after the last --------------------------------------------

test("PR REVIEW: each lab runs alone through run-review, its output staged under /tmp mode 0700, nothing released until the last ends", async () => {
  const f = await prFixture();
  const r = await run(f);
  assert.equal(r.code, 0, r.o.err);
  const starts = r.probe.filter(p => p.at === "start"), ends = r.probe.filter(p => p.at === "end");
  assert.deepEqual(starts.map(p => p.lab), ["xai", "google", "openai"], "the binding's order");
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i].t >= ends[i - 1].t, `${starts[i].lab} started before ${ends[i - 1].lab} ended`);
  for (const s of starts) {
    assert.deepEqual(s.cwd_findings, [], `${s.lab}: a findings path was in the checkout while it ran`);
    assert.equal(s.stage_mode, 0o700); assert.equal(s.out_mode, 0o700);
    assert.ok(s.stage.startsWith("/tmp/"), s.stage);
  }
  assert.deepEqual(starts.map(s => s.stage_entries), [["xai"], ["google", "xai"], ["google", "openai", "xai"]], "each lab's own directory in the private stage");
  const argv = Object.fromEntries(starts.map(s => [s.lab, s.argv]));
  for (const [lab, a] of Object.entries(argv)) {
    const val = k => a[a.indexOf(k) + 1];
    assert.equal(val("--via"), "subscription"); assert.equal(val("--review-dir"), DIR); assert.equal(val("--assignment"), "1");
    assert.equal(val("--commit"), f.head); assert.equal(val("--telos-root"), f.repo); assert.equal(val("--max-wall-s"), "60");
    assert.ok(val("--out").endsWith(`/${lab}`));
    assert.equal(a.includes("--reviewer"), lab !== "xai", `${lab}: --reviewer only where the README row names another reviewer`);
    if (lab !== "xai") assert.equal(val("--reviewer"), `${lab}:${PANEL.find(p => p.lab === lab).model}`);
    assert.ok(!a.includes("--dry-run"));
  }
  const result = JSON.parse(await readFile(join(r.releaseDir, "result.json"), "utf8"));
  assert.equal(result.panel.status, "complete");
  assert.deepEqual(result.panel.complete_labs, ["xAI", "Google", "OpenAI"]);
  assert.equal(result.head.sha, f.head); assert.equal(result.base.merge_base, f.mergeBase);
  assert.equal(result.binding.sha256, sha256(readFileSync(join(f.repo, DIR, "binding.json"))));
  assert.ok(result.verification.every(c => c.ok));
  assert.match(result.merge_decision, /the owner's/);
  for (const x of result.reviewers) {
    assert.equal(x.status, "complete", JSON.stringify(x.why));
    assert.equal(x.tests.tests_run, 2);
    assert.match(x.reviewer_sections.tests_run, /node --test \.review-tests\/stop\.test\.mjs: exit 0/);
    assert.match(x.reviewer_sections.unresolved_questions, /FAKE-UNRESOLVED-MARKER/);
    assert.match(x.reviewer_sections.blockers_for_merging, /^none\b/);
    assert.ok(x.files.some(y => y.path === `findings-1-${x.lab.toLowerCase()}.md` && /^[0-9a-f]{64}$/.test(y.sha256)));
    assert.ok(existsSync(join(r.releaseDir, x.lab_key, `findings-1-${x.lab.toLowerCase()}.md`)));
  }
  assert.equal(result.telos.matches_ci_pin, false, "the TELOS checkout's head is recorded against CI's pin");
  assert.deepEqual(result.pr_head_after, { sha: f.head, still_bound_head: true });
  assert.deepEqual(result.prior_releases_visible, []);
  assert.ok(!JSON.stringify(result).includes(f.root), "result.json names no absolute machine path");
  assert.match(r.o.out, /panel complete \(3\/3 complete/);
});

test("PR REVIEW: a timeout, a refusal to start (sign-in) and an exit 3 each leave that review incomplete; the others still run", async () => {
  const f = await prFixture();
  const r = await run(f, { argv: ["--max-wall-s", "1"], graceMs: 300, behaviour: { xai: "hang", google: "refused", openai: "exit3" } });
  assert.equal(r.code, 3, r.o.err);
  const result = JSON.parse(await readFile(join(r.releaseDir, "result.json"), "utf8"));
  const by = Object.fromEntries(result.reviewers.map(x => [x.lab_key, x]));
  assert.equal(by.xai.status, "incomplete"); assert.equal(by.xai.run.killed_for, "timeout"); assert.match(by.xai.why.join(";"), /^timeout: /);
  assert.equal(by.google.status, "incomplete"); assert.match(by.google.why.join(";"), /refused to start \(exit 1\): run-review: refused: codex login status does not report a ChatGPT sign-in/);
  assert.equal(by.openai.status, "incomplete"); assert.match(by.openai.why.join(";"), /recorded the review incomplete \(exit 3\)/);
  assert.equal(result.panel.status, "incomplete");
  assert.deepEqual(result.panel.incomplete_labs, ["xAI", "Google", "OpenAI"]);
  assert.equal(r.probe.filter(p => p.at === "start").length, 3, "every lab was dispatched");
});

test("PR REVIEW: missing evidence -- no files, no required section, another model, another brief, a gate that failed under exit 0 -- is incomplete", async () => {
  const cases = { nofiles: /missing evidence: no findings file[\s\S]*missing evidence: no readable transcript/, nosections: /missing evidence: the reviewer's message has no "Unresolved questions" section/,
    wrongmodel: /the transcript's model is another-model, not the bound/, wrongcommit: /the transcript reviewed f{40}, not the bound head/, wrongbrief: /the prompt's README is not the bound README/,
    "gatefail-exit0": /the transcript's status is incomplete[\s\S]*the coverage gate did not pass: no test command ran/ };
  for (const [behaviour, expect] of Object.entries(cases)) {
    const f = await prFixture();
    const r = await run(f, { behaviour: { google: behaviour } });
    assert.equal(r.code, 3, `${behaviour}: ${r.o.err}`);
    const result = JSON.parse(await readFile(join(r.releaseDir, "result.json"), "utf8"));
    const g = result.reviewers.find(x => x.lab_key === "google");
    assert.equal(g.status, "incomplete", behaviour);
    assert.match(g.why.join("; "), expect, behaviour);
    assert.deepEqual(result.reviewers.filter(x => x.lab_key !== "google").map(x => x.status), ["complete", "complete"], behaviour);
  }
});

test("PR REVIEW: a second run records the earlier release a jail could read, and a PR head that moved during the run", async () => {
  const f = await prFixture();
  const first = await run(f);
  assert.equal(first.code, 0, first.o.err);
  const moveOnStart = { ...process.env };
  // The second run's first reviewer moves the PR's head on origin while it runs.
  const mover = join(f.root, "move.mjs");
  await writeFile(mover, `import {execFileSync} from "node:child_process";\nimport {existsSync, writeFileSync} from "node:fs";\nif (!existsSync(${JSON.stringify(join(f.repo, "c.txt"))})) {\nwriteFileSync(${JSON.stringify(join(f.repo, "c.txt"))}, "x\\n");\nexecFileSync("git", ["-C", ${JSON.stringify(f.repo)}, "add", "c.txt"]);\nexecFileSync("git", ["-C", ${JSON.stringify(f.repo)}, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "moved"]);\nexecFileSync("git", ["-C", ${JSON.stringify(f.repo)}, "push", "-qf", "origin", "HEAD:refs/pull/84/head"]);\n}\nawait import(${JSON.stringify(FAKE)});\n`);
  const o = capture();
  const t1 = new Date(Date.UTC(2026, 10, 21, 22, 0, 0));
  const code = await main(["--binding", `${DIR}/binding.json`, "--telos-root", f.repo, "--max-wall-s", "60"], {
    repoRoot: f.repo, env: moveOnStart, out: o.stdout, err: o.stderr, now: () => t1, gitFn, runnerScript: mover, stageRoot: "/tmp", graceMs: 60_000 });
  assert.equal(code, 0, o.err);
  const second = JSON.parse(await readFile(join(f.repo, DIR, `findings-${f.head.slice(0, 12)}-20261121T220000Z`, "result.json"), "utf8"));
  assert.deepEqual(second.prior_releases_visible, [`findings-${f.head.slice(0, 12)}-20261121T213000Z`]);
  assert.match(o.err, /1 earlier release\(s\) in .*a reviewer jail can read the checkout/);
  assert.equal(second.pr_head_after.still_bound_head, false);
  assert.notEqual(second.pr_head_after.sha, f.head);
  assert.match(o.out, /NOTE: the PR's head is now [0-9a-f]{40}, not the reviewed/);
  assert.ok(second.reviewers.every(x => x.status === "complete"), "the reviews are of the bound head, whatever the PR did since");
});

test("PR REVIEW: the stage must be under the literal /tmp, which every reviewer jail replaces", async () => {
  const f = await prFixture();
  const elsewhere = await mkdtempRaw(join(homedir(), ".prr-stage-"));
  try {
    const r = await run(f, { stageRoot: elsewhere });
    assert.equal(r.code, 1);
    assert.match(r.o.err, /refused: the stage must be under \/tmp/);
    assert.equal(r.probe.length, 0, "no reviewer was started");
  } finally { await rm(elsewhere, { recursive: true, force: true }); }
});

test("PR REVIEW: a dry run verifies, runs each lab's dry run, and releases nothing", async () => {
  const f = await prFixture();
  const r = await run(f, { argv: ["--dry-run"] });
  assert.equal(r.code, 0, r.o.err);
  assert.ok(r.probe.filter(p => p.at === "start").every(p => p.argv.includes("--dry-run")));
  assert.ok(!existsSync(r.releaseDir));
  const result = JSON.parse(r.o.out);
  assert.equal(result.dry_run, true); assert.equal(result.panel.status, "dry-run");
  const bad = await run(await prFixture(), { argv: ["--dry-run"], behaviour: { openai: "dry-fail" } });
  assert.equal(bad.code, 3);
});

test("PR REVIEW: usage -- the binding and the wall clock are required; the TELOS root must be absolute", async () => {
  const f = await prFixture();
  const o = capture();
  const d = { repoRoot: f.repo, env: {}, out: o.stdout, err: o.stderr, gitFn, runnerScript: FAKE };
  assert.equal(await main(["--telos-root", f.repo, "--max-wall-s", "60"], d), 2);
  assert.equal(await main(["--binding", `${DIR}/binding.json`, "--telos-root", f.repo], d), 2);
  assert.equal(await main(["--binding", `${DIR}/binding.json`, "--telos-root", "relative/telos", "--max-wall-s", "60"], d), 1);
  assert.match(o.err, /--telos-root \(or OPHANIM_TELOS_ROOT\) must be an absolute path/);
});

// ---- the pieces -----------------------------------------------------------------------------------------------------

test("PR REVIEW: the reviewer's sections are read after the runner's marker, by heading", () => {
  const md = `- status: complete\n## Tests run\nRUNNER-HEADER-NOT-THIS\n${MARKER}\n# Findings\n1. holds\n## Tests run\n- a: exit 0\n### detail\nkept\n## Unresolved questions\n- q\n## Blockers for merging\nnone\n`;
  const s = reviewerSections(md);
  assert.equal(s.tests_run, "- a: exit 0\n### detail\nkept");
  assert.equal(s.unresolved_questions, "- q");
  assert.equal(s.blockers_for_merging, "none");
  assert.equal(reviewerSections("no marker\n## Tests run\nx\n").found_marker, false);
});

test("PR REVIEW: shape and panel problems name what is wrong", () => {
  const sp = shapeProblems({ schema: "x" });
  for (const want of [`schema is "x", expected ${BINDING_SCHEMA}`, "repo must be <owner>/<name>", "head.sha must be a full 40-hex commit id", "brief.files must bind README.md",
    "author.labs must name the labs that wrote the PR", "panel must list the reviewers"]) assert.ok(sp.includes(want), `${want} in ${JSON.stringify(sp)}`);
  assert.deepEqual(panelProblems({ panel: PANEL, author: { labs: ["Anthropic"] } }), []);
  assert.deepEqual(Object.keys(LABS), ["google", "openai", "xai"]);
  const a = runnerArgs({ binding: { brief: { dir: DIR, assignment: 1 }, head: { sha: "a".repeat(40) } }, reviewer: { lab: "google", model: "m" }, readmeRow: { lab: "xAI", model: "grok-4.7" },
    telosRoot: "/t", maxWallS: 5, out: "/tmp/s/google", dryRun: false, hostFlags: { "grok-state-dir": "/g" } });
  assert.deepEqual(a, ["--via", "subscription", "--review-dir", DIR, "--assignment", "1", "--commit", "a".repeat(40), "--max-wall-s", "5", "--telos-root", "/t",
    "--out", "/tmp/s/google", "--reviewer", "google:m", "--grok-state-dir", "/g"]);
});

// ---- the committed record for PR #84 ------------------------------------------------------------------------------

test("PR REVIEW: the committed binding for PR #84 binds its brief, its panel and its head", async () => {
  const dir = "docs/reviews/2026-11-21-pr84-account-refusal";
  const b = JSON.parse(readFileSync(join(REAL_ROOT, dir, "binding.json"), "utf8"));
  assert.deepEqual(shapeProblems(b), []);
  assert.deepEqual(panelProblems(b), []);
  assert.equal(b.pr, 84);
  assert.equal(b.head.sha, "b42c49e99f5140eb2e616af7694f943d5b9d0420");
  assert.equal(b.base.ref, "main");
  assert.equal(b.base.merge_base, "ba3f03862f3e452f4db4f5891a1c288ebbc5cc6e");
  assert.equal(b.brief.dir, dir);
  for (const [f, h] of Object.entries(b.brief.files)) assert.equal(sha256(readFileSync(join(REAL_ROOT, dir, f))), h, `${f} is not the bound file`);
  const readme = readFileSync(join(REAL_ROOT, dir, "README.md"), "utf8");
  const row = assignmentRow(readme, b.brief.assignment);
  assert.ok(b.brief.files[row.file], "the README row's assignment file is bound");
  for (const f of ["README.md", row.file]) { const t = readFileSync(join(REAL_ROOT, dir, f), "utf8"); assert.ok(t.includes(b.head.sha) && t.includes("PR #84"), f); }
  assert.ok(b.author.labs.includes("Anthropic"));
});

test("PR REVIEW: judgeReviewer reads only what the run left, never the reviewer's own claim of completeness", async () => {
  const d = await mkdtemp(join(tmpdir(), "prr-judge-"));
  const b = { head: { sha: "a".repeat(40) }, brief: { assignment: 1, files: { "README.md": "1".repeat(64), "1-x.md": "2".repeat(64), "HARNESS.md": "3".repeat(64), "HARNESS-cli.md": "4".repeat(64) } } };
  await writeFile(join(d, "findings-1-xai.md"), `${MARKER}\n## Tests run\nall of them, and this review is complete\n## Unresolved questions\nnone\n`);
  const j = await judgeReviewer({ binding: b, reviewer: { lab: "xai", model: "grok-4.7" }, outDir: d, run: { exit_code: 0, signal: null, killed_for: null, spawn_error: null, stderr_tail: [] } });
  assert.equal(j.status, "incomplete");
  assert.match(j.why.join("; "), /missing evidence: no readable transcript/);
});
