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
import { BINDING_NAME_RE, BINDING_SCHEMA, LABS, MARKER, gitCli, judgeReviewer, main, panelProblems, reviewerSections, runnerArgs, sha256, shapeProblems, verifyBinding } from "../src/review-runner/pr-review.mjs";
import { assignmentRow } from "../src/review-runner/brief.mjs";
import { REAL_ROOT, fixtureRepo, fakeFetch, capture, deps, LIMITS, cleanup, mkdtemp, sh } from "./review-runner-helper.mjs";
import { fakeCodexSdk, fakeReviewClis } from "./fixtures/review-clis.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";

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

async function run(f, { argv = [], behaviour = {}, stageRoot, graceMs, now, runnerScript = FAKE, env: extraEnv = {} } = {}) {
  const probe = join(f.root, `probe-${Math.random().toString(16).slice(2)}.jsonl`);
  const o = capture();
  const t0 = now ?? new Date(Date.UTC(2026, 10, 21, 21, 30, 0));
  const code = await main(["--binding", `${DIR}/binding.json`, "--telos-root", f.repo, "--max-wall-s", "60", ...argv], {
    repoRoot: f.repo, env: { ...process.env, FAKE_RR: JSON.stringify(behaviour), FAKE_RR_PROBE: probe, ...extraEnv }, out: o.stdout, err: o.stderr,
    now: () => t0, gitFn, runnerScript, stageRoot: stageRoot ?? "/tmp", graceMs: graceMs ?? 60_000,
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
  // The OpenAI seat's relayed test (relay.mjs): who requested it, which runner executed it, what codex concluded.
  const openai = result.reviewers.find(x => x.lab_key === "openai");
  assert.deepEqual(openai.relayed_tests.counts, { requested: 1, run: 1, ran_in_jail: 1, refused: 0, not_run: 0, concluded: 1, unconcluded: [] });
  const [q] = openai.relayed_tests.requests;
  assert.deepEqual([q.id, q.requested_by.transport, q.requested_by.lab, q.requested_by.model, q.executed_by.launcher, q.executed_by.commit, q.result.exit_code, q.reviewer_conclusion],
    ["R1", "codex-sdk", "OpenAI", "gpt-6-astra", "pantheon-test", f.head, 0, "FAKE-RELAY-CONCLUSION"]);
  assert.match(q.executed_by.runner, /run-review\.mjs \(the runner process, outside the reviewer's sandbox\)/);
  assert.equal(result.reviewers.find(x => x.lab_key === "xai").relayed_tests, null, "a lab that runs its own tests in the jail relays none");
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

// ---- the xAI SDK route: one lab over the official SDK, the others unchanged --------------------------------------

const SDK_LIMITS = { max_turns: 8, max_tool_calls: 10, max_output_tokens: 4000, timeout_s: 120 };
const SDK_XAI = { lab: "xai", model: "grok-4.7", route: "xai-sdk", limits: SDK_LIMITS };
const SDK_RUNNER = fileURLToPath(new URL("./fixtures/review-pr-sdk-runner.mjs", import.meta.url));

test("XAI SDK ROUTE: the binding may route the xAI reviewer over the SDK, with declared limits; nothing else may", () => {
  const ok = { panel: [SDK_XAI, PANEL[1], PANEL[2]] };
  const probs = b => shapeProblems({ ...b }).filter(p => p.startsWith("panel"));
  assert.deepEqual(probs(ok), []);
  assert.deepEqual(panelProblems({ ...ok, author: { labs: ["Anthropic"] } }), [], "the route changes no independence rule");
  assert.match(probs({ panel: [{ ...PANEL[1], route: "xai-sdk", limits: SDK_LIMITS }] }).join("; "), /panel: route xai-sdk is for the xai lab only/);
  assert.match(probs({ panel: [{ ...SDK_XAI, route: "grok-http" }] }).join("; "), /panel: route "grok-http" is not a route \(xai-sdk\)/);
  assert.match(probs({ panel: [{ ...SDK_XAI, limits: undefined }] }).join("; "), /panel: route xai-sdk must declare limits/);
  assert.match(probs({ panel: [{ ...SDK_XAI, limits: { ...SDK_LIMITS, max_turns: 0 } }] }).join("; "), /panel: limits\.max_turns must be a whole number from 1 to 200/);
  assert.match(probs({ panel: [{ ...SDK_XAI, limits: { ...SDK_LIMITS, extra: 1 } }] }).join("; "), /panel: limits has an unknown key "extra"/);
  assert.match(probs({ panel: [{ ...PANEL[1], limits: SDK_LIMITS }] }).join("; "), /panel: limits apply to a routed reviewer only/);
});

test("XAI SDK ROUTE: runnerArgs dispatch the routed reviewer over the API with its limits, and the legacy reviewers exactly as before", () => {
  const binding = { brief: { dir: DIR, assignment: 1 }, head: { sha: "a".repeat(40) } };
  const common = { binding, readmeRow: { lab: "xAI", model: "grok-4.7" }, telosRoot: "/t", maxWallS: 900, dryRun: false, hostFlags: { "grok-state-dir": "/g", "codex-cli": "/c" } };
  assert.deepEqual(runnerArgs({ ...common, reviewer: SDK_XAI, out: "/tmp/s/xai" }), ["--via", "api", "--xai-transport", "sdk", "--review-dir", DIR, "--assignment", "1",
    "--commit", "a".repeat(40), "--max-turns", "8", "--max-tool-calls", "10", "--max-output-tokens", "4000", "--timeout-s", "120", "--max-wall-s", "900", "--telos-root", "/t", "--out", "/tmp/s/xai"]);
  // The legacy bindings: byte-for-byte what they dispatched before (the subscription and its host flags).
  assert.deepEqual(runnerArgs({ ...common, reviewer: { lab: "xai", model: "grok-4.7" }, out: "/tmp/s/xai" }), ["--via", "subscription", "--review-dir", DIR, "--assignment", "1",
    "--commit", "a".repeat(40), "--max-wall-s", "900", "--telos-root", "/t", "--out", "/tmp/s/xai", "--grok-state-dir", "/g", "--codex-cli", "/c"]);
  assert.deepEqual(runnerArgs({ ...common, reviewer: PANEL[1], out: "/tmp/s/google", dryRun: true }), ["--via", "subscription", "--review-dir", DIR, "--assignment", "1",
    "--commit", "a".repeat(40), "--max-wall-s", "900", "--telos-root", "/t", "--out", "/tmp/s/google", "--reviewer", "google:gemini-4-carbon", "--grok-state-dir", "/g", "--codex-cli", "/c", "--dry-run"]);
});

// The recorded events of a qualifying fresh run: 3 provider calls (each served by the bound model), 3 source reads and
// one jailed test run -- the facts its counters and coverage summary must agree with.
const served = (n, model = "grok-4.7") => ({ type: "provider_call", n, turn: n, attempt: 1, served_model: model, response: { id: `c${n}`, model, choices: [] } });
const tool = (n, name, args, extra = {}) => ({ type: "tool_call", n, turn: n, name, args, outcome: "ok", exit_code: name === "run_tests" ? 0 : null, ...extra });
const OK_EVENTS = () => [served(1), tool(1, "read_file", { path: "ophanim/operate/a.mjs" }), tool(2, "read_file", { path: "ophanim/operate/b.mjs" }), tool(3, "read_file", { path: "ophanim/operate/c.mjs" }),
  served(2), tool(4, "run_tests", { files: [".review-tests/stop.test.mjs"] }), served(3)];
// What a qualifying API/SDK run leaves in its out directory, with one thing changed per refusal.
async function sdkRun({ binding: b, edit = t => t, findings } = {}) {
  const d = await mkdtemp(join(tmpdir(), "prr-sdk-judge-"));
  const t = edit({
    schema: "ophanim.review-transcript/v1", via: "api", transport: "xai-sdk", assignment: 1, lab: "xAI", vendor: "xai", requested_model: "grok-4.7", commit: b.head.sha,
    prompt: { readme_sha256: b.brief.files["README.md"], assignment_sha256: b.brief.files["1-x.md"], harness_template: { path: `${DIR}/HARNESS.md`, sha256: b.brief.files["HARNESS.md"] } },
    status: "complete", stop_reason: "final answer", coverage: { source_reads: 3, denied_reads: 0, tests_run: 1, tests_allowed: true, method: "tool events" }, coverage_gate: { ok: true, reasons: [] },
    limits: { ...SDK_LIMITS, max_wall_s: 900 }, provider_calls: 3, tool_calls: 4, served_models: ["grok-4.7"], worktree_check: { changed: [".review-tests/stop.test.mjs"], violations: [] },
    cost_totals: { reported_calls: 0, unreported_calls: 3, value: null, field: null }, events: OK_EVENTS(),
  });
  await writeFile(join(d, "findings-1-xai.transcript.json"), JSON.stringify(t));
  await writeFile(join(d, "findings-1-xai.md"), findings ?? `header\n${MARKER}\n\n## Findings\n1. holds\n## Tests run\nnode --test .review-tests/stop.test.mjs: exit 0\n## Unresolved questions\nnone\n`);
  return d;
}
const OK_RUN = { exit_code: 0, signal: null, killed_for: null, spawn_error: null, stderr_tail: [] };
const JB = { head: { sha: "a".repeat(40) }, brief: { assignment: 1, files: { "README.md": "1".repeat(64), "1-x.md": "2".repeat(64), "HARNESS.md": "3".repeat(64), "HARNESS-cli.md": "4".repeat(64) } } };

test("XAI SDK ROUTE: judgeReviewer accepts a qualifying SDK run and records its route, transport, served model and cost reading", async () => {
  const j = await judgeReviewer({ binding: JB, reviewer: SDK_XAI, readmeRow: { lab: "xAI", model: "grok-4.7", testing: "Mock providers and isolated processes" }, outDir: await sdkRun({ binding: JB }), run: OK_RUN });
  assert.equal(j.status, "complete", JSON.stringify(j.why));
  assert.equal(j.route, "xai-sdk");
  assert.equal(j.runner.transport, "xai-sdk");
  assert.deepEqual(j.served_models, ["grok-4.7"]);
  assert.deepEqual(j.cost_totals, { reported_calls: 0, unreported_calls: 3, value: null, field: null });
  assert.equal(j.tests.tests_run, 1);
});

test("XAI SDK ROUTE: judgeReviewer refuses the wrong transport, the old CLI result carried forward, another model, missing provenance or coverage, a source edit and an overrun", async () => {
  const cases = [
    ["the CLI transcript carried forward", t => ({ ...t, schema: "ophanim.review-transcript/v2-subscription", via: "subscription", transport: "grok-cli", prompt: { ...t.prompt, harness_cli_template: { sha256: JB.brief.files["HARNESS-cli.md"] } } }),
      /the transcript's via is subscription, not api \(route xai-sdk\)/],
    ["the fetch route", t => ({ ...t, transport: undefined }), /the transcript's transport is none, not xai-sdk/],
    ["another transport", t => ({ ...t, transport: "grok-cli" }), /the transcript's transport is grok-cli, not xai-sdk/],
    ["another requested model", t => ({ ...t, requested_model: "grok-4.6" }), /the transcript's model is grok-4\.6, not the bound grok-4\.7/],
    ["another served model", t => ({ ...t, served_models: ["grok-4.7", "grok-3"] }), /a response was served by grok-3, not the bound grok-4\.7/],
    ["no served-model evidence", t => ({ ...t, served_models: [null] }), /missing provenance: a response named no served model/],
    ["no served models at all", t => ({ ...t, served_models: [] }), /missing provenance: no response named a served model/],
    ["the coverage gate failed", t => ({ ...t, status: "incomplete", coverage: { ...t.coverage, tests_run: 0 }, coverage_gate: { ok: false, reasons: ["no test command ran although the testing limit allows tests"] } }),
      /the coverage gate did not pass: no test command ran/],
    ["no worktree check", t => ({ ...t, worktree_check: undefined }), /missing evidence: the transcript records no check of the review copy/],
    ["a source edit", t => ({ ...t, worktree_check: { changed: ["ophanim/operate/stages.mjs"], violations: ["ophanim/operate/stages.mjs"] } }), /the review copy changed outside \.review-tests\/: ophanim\/operate\/stages\.mjs/],
    ["another brief's harness", t => ({ ...t, prompt: { ...t.prompt, harness_template: { sha256: "9".repeat(64) } } }), /the prompt's harness is not the bound HARNESS\.md/],
    ["other limits", t => ({ ...t, limits: { ...t.limits, max_turns: 50 } }), /the run's limits are not the bound limits \(max_turns 50 vs 8\)/],
    // A counter alone over the limit contradicts the events (the over-the-limit EVENTS case is round 5's).
    ["more calls than the limit", t => ({ ...t, provider_calls: 9 }), /the recorded events hold 3 provider call\(s\); the transcript's provider_calls says 9/],
  ];
  for (const [name, edit, want] of cases) {
    const j = await judgeReviewer({ binding: JB, reviewer: SDK_XAI, readmeRow: { lab: "xAI", model: "grok-4.7", testing: "Mock providers and isolated processes" }, outDir: await sdkRun({ binding: JB, edit }), run: OK_RUN });
    assert.equal(j.status, "incomplete", name);
    assert.match(j.why.join("; "), want, `${name}: ${j.why.join("; ")}`);
  }
  // And a legacy (subscription) reviewer is never satisfied by an SDK run either.
  const j = await judgeReviewer({ binding: JB, reviewer: { lab: "xai", model: "grok-4.7" }, outDir: await sdkRun({ binding: JB }), run: OK_RUN });
  assert.equal(j.status, "incomplete");
  assert.match(j.why.join("; "), /the transcript's via is api, not subscription/);
});

test("XAI SDK ROUTE: a binding record may sit beside its brief under another name (binding-<name>.json), never elsewhere", async () => {
  const f = await prFixture({ edit: b => { b.panel = [SDK_XAI, PANEL[1], PANEL[2]]; } });
  await sh("git", ["-C", f.repo, "mv", `${DIR}/binding.json`, `${DIR}/binding-xai-sdk.json`]);
  await sh("git", ["-C", f.repo, ...ID, "commit", "-qm", "rename the record"]);
  const b = JSON.parse(await readFile(join(f.repo, DIR, "binding-xai-sdk.json"), "utf8"));
  const v = await verifyBinding({ binding: b, bindingRel: `${DIR}/binding-xai-sdk.json`, repoRoot: f.repo, gitFn });
  assert.ok(v.checks.find(c => c.check === "record beside its brief").ok);
  const bad = await verifyBinding({ binding: b, bindingRel: `${DIR}/notes.json`, repoRoot: f.repo, gitFn });
  assert.match(bad.checks.find(c => c.check === "record beside its brief").detail, /binding\.json or binding-<name>\.json/);
});

test("XAI SDK ROUTE: the complete coordinator path -- the routed xAI leg runs the REAL API runner on a scripted SDK, is judged complete; the subscription labs run as before", { skip: !(await sandboxAvailable("bwrap")).ok && "bwrap unavailable" }, async () => {
  const f = await prFixture({ edit: b => { b.panel = [SDK_XAI, PANEL[1], PANEL[2]]; } });
  const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const turn = (calls, content = null, finish = "tool_calls") => ({ id: `c${Math.random()}`, model: "grok-4.7", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) } }] });
  const steps = [
    turn([call("t1", "read_file", { path: "a.txt" }), call("t2", "write_test", { name: "stop", content: 'import test from "node:test";\ntest("stops", () => {});\n' })]),
    turn([call("t3", "run_tests", { files: [".review-tests/stop.test.mjs"] })]),
    turn(null, "## Findings\n1. holds (a.txt:1)\n\n## Tests run\nnode --test .review-tests/stop.test.mjs: exit 0\n\n## Unresolved questions\nSDK-UNRESOLVED-MARKER\n\n## Blockers for merging\nnone\n", "stop"),
  ];
  const r = await run(f, { runnerScript: SDK_RUNNER, env: { XAI_API_KEY: "xai-FAKEKEY-0123456789abcdef", FAKE_XAI_STEPS: JSON.stringify(steps) } });
  assert.equal(r.code, 0, r.o.err);
  const xaiStart = r.probe.find(p => p.at === "start" && p.lab === "xai");
  const val = k => xaiStart.argv[xaiStart.argv.indexOf(k) + 1];
  assert.equal(val("--via"), "api"); assert.equal(val("--xai-transport"), "sdk"); assert.equal(val("--max-turns"), "8");
  assert.deepEqual(r.probe.find(p => p.at === "client").opts, { apiKey: "<set>", baseURL: "https://api.x.ai/v1", maxRetries: 0, timeout: 120_000 });
  assert.equal(r.probe.find(p => p.at === "end" && p.lab === "xai").sdk_calls, 3);
  const result = JSON.parse(await readFile(join(r.releaseDir, "result.json"), "utf8"));
  assert.equal(result.panel.status, "complete");
  const x = result.reviewers.find(y => y.lab_key === "xai");
  assert.equal(x.status, "complete", JSON.stringify(x.why));
  assert.equal(x.route, "xai-sdk");
  assert.equal(x.runner.transport, "xai-sdk");
  assert.deepEqual(x.served_models, ["grok-4.7"]);
  assert.equal(x.tests.tests_run, 1);
  assert.match(x.reviewer_sections.unresolved_questions, /SDK-UNRESOLVED-MARKER/);
  for (const lab of ["google", "openai"]) {
    const s = r.probe.find(p => p.at === "start" && p.lab === lab);
    assert.equal(s.argv[s.argv.indexOf("--via") + 1], "subscription", `${lab} keeps its subscription route`);
    assert.equal(result.reviewers.find(y => y.lab_key === lab).status, "complete");
  }
  assert.ok(!JSON.stringify(result).includes("xai-FAKEKEY"), "the key is in no record");
});

test("XAI SDK ROUTE: the committed record for the fresh xAI leg of PR #84 binds the same PR, head, brief and other reviewers as binding.json; only xAI is routed", () => {
  const dir = "docs/reviews/2026-11-21-pr84-account-refusal";
  const legacy = JSON.parse(readFileSync(join(REAL_ROOT, dir, "binding.json"), "utf8"));
  const b = JSON.parse(readFileSync(join(REAL_ROOT, dir, "binding-xai-sdk.json"), "utf8"));
  assert.deepEqual(shapeProblems(b), []);
  assert.deepEqual(panelProblems(b), []);
  for (const k of ["schema", "repo", "pr", "base", "head", "brief", "author", "via", "telos"]) assert.deepEqual(b[k], legacy[k], k);
  assert.deepEqual(b.panel.map(r => r.lab), legacy.panel.map(r => r.lab), "the same labs, in the same order");
  const x = b.panel.find(r => r.lab === "xai");
  assert.equal(x.route, "xai-sdk"); assert.equal(x.model, legacy.panel.find(r => r.lab === "xai").model);
  for (const lab of ["google", "openai"]) assert.deepEqual(b.panel.find(r => r.lab === lab), legacy.panel.find(r => r.lab === lab), `${lab} keeps its route`);
  assert.ok(BINDING_NAME_RE.test("binding-xai-sdk.json"));
});

// Codex's independent cases at 42836cc (round 2): the judge FAILS CLOSED on an incomplete record. The README row gives the
// assignment's testing limit, against which the coverage facts are checked.
const ROW = { lab: "xAI", model: "grok-4.7", testing: "Mock providers and isolated processes" };

test("XAI SDK ROUTE R2: the positive control -- the full qualifying record, judged against the assignment's row, is complete", async () => {
  const j = await judgeReviewer({ binding: JB, reviewer: SDK_XAI, readmeRow: ROW, outDir: await sdkRun({ binding: JB }), run: OK_RUN });
  assert.equal(j.status, "complete", JSON.stringify(j.why));
});

test("XAI SDK ROUTE R2: a record with a required field removed, malformed or contradicting another is incomplete", async () => {
  const drop = k => t => { const { [k]: _, ...rest } = t; return rest; };
  const cases = [
    ["provider_calls removed", drop("provider_calls"), /missing evidence: provider_calls is not a whole number/],
    ["tool_calls removed", drop("tool_calls"), /missing evidence: tool_calls is not a whole number/],
    ["provider_calls a string", t => ({ ...t, provider_calls: "3" }), /missing evidence: provider_calls is not a whole number/],
    ["no provider call at all", t => ({ ...t, provider_calls: 0, events: OK_EVENTS().filter(e => e.type !== "provider_call") }), /no provider call is recorded/],
    ["worktree_check {}", t => ({ ...t, worktree_check: {} }), /missing evidence: the check of the review copy is malformed/],
    ["worktree_check violations not a list", t => ({ ...t, worktree_check: { changed: [], violations: "none" } }), /missing evidence: the check of the review copy is malformed/],
    ["gate ok, but no test ran", t => ({ ...t, coverage: { ...t.coverage, tests_run: 0 } }), /the coverage facts contradict the gate: no test command ran although the testing limit allows tests/],
    ["gate ok, no source read", t => ({ ...t, coverage: { ...t.coverage, source_reads: 0 } }), /the coverage facts contradict the gate: no source file was read/],
    ["gate ok, a denied read", t => ({ ...t, coverage: { ...t.coverage, denied_reads: 1 } }), /the coverage facts contradict the gate: 1 read\(s\) were denied/],
    ["coverage removed", drop("coverage"), /missing evidence: no coverage record/],
    ["tests marked not allowed although the assignment allows them", t => ({ ...t, coverage: { ...t.coverage, tests_allowed: false, tests_run: 0 } }),
      /the coverage record says tests are not allowed; the assignment's testing limit \(Mock providers and isolated processes\) allows them/],
    ["served_models not a list", t => ({ ...t, served_models: "grok-4.7" }), /missing provenance: no response named a served model/],
    ["limits removed", drop("limits"), /the run's limits are not the bound limits/],
    ["a recorded mismatch", t => ({ ...t, identity_mismatch: true }), /the runner refused a response served by another model \(identity_mismatch\)/],
  ];
  for (const [name, edit, want] of cases) {
    const j = await judgeReviewer({ binding: JB, reviewer: SDK_XAI, readmeRow: ROW, outDir: await sdkRun({ binding: JB, edit }), run: OK_RUN });
    assert.equal(j.status, "incomplete", name);
    assert.match(j.why.join("; "), want, `${name}: ${j.why.join("; ")}`);
  }
  // Without the assignment's row the coverage cannot be checked against it: incomplete, never assumed.
  const j = await judgeReviewer({ binding: JB, reviewer: SDK_XAI, outDir: await sdkRun({ binding: JB }), run: OK_RUN });
  assert.equal(j.status, "incomplete");
  assert.match(j.why.join("; "), /the assignment's testing limit is not known here: the coverage cannot be checked against it/);
});

// Codex's independent control at 1a7050f (round 3): the worktree check's own `violations` summary is not evidence of a
// clean review copy. The judge re-derives the violations from the CHANGED paths, with the bound assignment's write
// permission and the runner's own path policy (cli-common.mjs worktreeViolations).
test("XAI SDK ROUTE R3: a changed path outside .review-tests/ fails the judge even when the record's violations list is empty", async () => {
  const wc = changed => t => ({ ...t, worktree_check: { changed, violations: [] } });
  const judge = async (edit, row = ROW) => judgeReviewer({ binding: JB, reviewer: SDK_XAI, readmeRow: row, outDir: await sdkRun({ binding: JB, edit }), run: OK_RUN });
  // The positive control: a reviewer-written test under .review-tests/, where the assignment allows writing one.
  let j = await judge(wc([".review-tests/allowed.test.mjs"]));
  assert.equal(j.status, "complete", JSON.stringify(j.why));
  for (const p of ["ophanim/operate/account-refusal.mjs", ".review-tests/../ophanim/x.mjs", "review-tests/x.test.mjs", ".review-testsX/a.mjs"]) {
    j = await judge(wc([".review-tests/allowed.test.mjs", p]));
    assert.equal(j.status, "incomplete", p);
    assert.match(j.why.join("; "), new RegExp(`the review copy's changed paths contradict its violations list: ${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not allowed by the bound write policy`), `${p}: ${j.why.join("; ")}`);
  }
  // The write-disabled assignment (source inspection only): even a .review-tests/ file is a violation.
  const READONLY = { ...ROW, testing: "Source inspection and existing authorized tests only" };
  j = await judge(wc([".review-tests/allowed.test.mjs"]), READONLY);
  assert.equal(j.status, "incomplete");
  assert.match(j.why.join("; "), /\.review-tests\/allowed\.test\.mjs is not allowed by the bound write policy \(this assignment allows no write\)/);
  j = await judge(wc([]), READONLY);
  assert.equal(j.status, "complete", JSON.stringify(j.why));
});

test("XAI SDK ROUTE R4: a recorded response served by another model (or none) anywhere in the events fails the judge, whatever served_models says", async () => {
  const withFirst = first => t => ({ ...t, events: [first, ...OK_EVENTS().slice(1)] });
  for (const [name, edit, want] of [
    ["a rejected response kept from an earlier run", withFirst(served(1, "grok-4.6")), /the recorded response at turn 1 was served by grok-4\.6, not the bound grok-4\.7/],
    ["a recorded response naming no model", withFirst({ type: "provider_call", n: 1, turn: 1, served_model: null, response: { id: "c1", choices: [] } }), /missing provenance: the recorded response at turn 1 named no served model/],
    ["a call naming another served model without its response body", withFirst({ type: "provider_call", n: 1, turn: 1, served_model: "grok-4.6" }),
      /the recorded response at turn 1 was served by grok-4\.6, not the bound grok-4\.7/],
  ]) {
    const j = await judgeReviewer({ binding: JB, reviewer: SDK_XAI, readmeRow: ROW, outDir: await sdkRun({ binding: JB, edit }), run: OK_RUN });
    assert.equal(j.status, "incomplete", name);
    assert.match(j.why.join("; "), want, `${name}: ${j.why.join("; ")}`);
  }
  // A failed attempt (no response, no served model) is not a served response -- and it is a provider call (a retry).
  const j = await judgeReviewer({ binding: JB, reviewer: SDK_XAI, readmeRow: ROW,
    outDir: await sdkRun({ binding: JB, edit: t => ({ ...t, provider_calls: 4, events: [{ type: "provider_call", n: 0, turn: 1, attempt: 1, http_status: 429 }, ...OK_EVENTS()] }) }), run: OK_RUN });
  assert.equal(j.status, "complete", JSON.stringify(j.why));
});


// ---- #118: the attestation is the RAW provider response's model; a derived event model never outranks or replaces it ----
test("XAI SDK ROUTE #118: the judge attests a response by its raw provider model -- a derived event model that contradicts it, or claims a model the raw response does not name, fails; the valid, retried and continued controls pass", async () => {
  const withFirst = first => t => ({ ...t, events: [first, ...OK_EVENTS().slice(1)] });
  const raw = (model, event) => ({ type: "provider_call", n: 1, turn: 1, attempt: 1, ...(event === undefined ? {} : { served_model: event }), response: { id: "c1", ...(model === undefined ? {} : { model }), choices: [] } });
  const verdict = async edit => judgeReviewer({ binding: JB, reviewer: SDK_XAI, readmeRow: ROW, outDir: await sdkRun({ binding: JB, edit }), run: OK_RUN });
  // 1. raw = bound, the event agrees: complete.
  let j = await verdict(withFirst(raw("grok-4.7", "grok-4.7")));
  assert.equal(j.status, "complete", JSON.stringify(j.why));
  // 2. raw another model, the event model omitted: incomplete.
  j = await verdict(withFirst(raw("grok-4.6")));
  assert.deepEqual([j.status, /the recorded response at turn 1 was served by grok-4\.6/.test(j.why.join("; "))], ["incomplete", true], j.why.join("; "));
  // 3. raw contradicts the derived event model: incomplete.
  j = await verdict(withFirst(raw("grok-4.6", "grok-4.7")));
  assert.equal(j.status, "incomplete", "a derived grok-4.7 over a raw grok-4.6");
  assert.match(j.why.join("; "), /the recorded response at turn 1 was served by grok-4\.6/);
  assert.match(j.why.join("; "), /turn 1: the event's served_model grok-4\.7 contradicts the provider response's model grok-4\.6/);
  // 4. raw names no model, the event claims the bound one: incomplete.
  j = await verdict(withFirst(raw(undefined, "grok-4.7")));
  assert.equal(j.status, "incomplete", "a derived grok-4.7 with no raw model");
  assert.match(j.why.join("; "), /missing provenance: the recorded response at turn 1 named no served model/);
  // A claimed served model with no response at all is no attestation.
  j = await verdict(withFirst({ type: "provider_call", n: 1, turn: 1, attempt: 1, served_model: "grok-4.7" }));
  assert.equal(j.status, "incomplete");
  assert.match(j.why.join("; "), /missing provenance: the call at turn 1 claims served model grok-4\.7 with no recorded provider response/);
  // Controls: a failed-and-retried call (no response, no served model) is not a served response, and is a call.
  j = await verdict(t => ({ ...t, provider_calls: 4, events: [{ type: "provider_call", n: 0, turn: 1, attempt: 1, http_status: 429 }, ...OK_EVENTS()] }));
  assert.equal(j.status, "complete", JSON.stringify(j.why));
});


// ---- round 5 (Codex's independent pass at 8942598): the routed judge derives its counts and coverage from the events ---

test("XAI SDK ROUTE R5: the three summary-over-facts cases are refused -- empty events, more calls than the counter (over the bound), a claimed test with no test event", async () => {
  const cases = [
    ["no events at all", t => ({ ...t, events: [] }), [/missing evidence: no recorded response was served by the bound grok-4\.7/, /the recorded events hold 0 provider call\(s\); the transcript's provider_calls says 3/,
      /the coverage summary contradicts the recorded events \(source_reads 3 vs 0, tests_run 1 vs 0\)/]],
    ["9 recorded calls, the counter says 3", t => ({ ...t, events: [...OK_EVENTS(), ...[4, 5, 6, 7, 8, 9].map(n => served(n))] }),
      [/the recorded events hold 9 provider call\(s\); the transcript's provider_calls says 3/, /9 recorded provider calls exceed the bound max_turns 8/]],
    ["a claimed test, no test event", t => ({ ...t, tool_calls: 3, events: OK_EVENTS().filter(e => e.name !== "run_tests") }),
      [/the coverage summary contradicts the recorded events \(tests_run 1 vs 0\)/, /the recorded events do not pass the coverage gate: no test command ran although the testing limit allows tests/]],
  ];
  for (const [name, edit, wants] of cases) {
    const j = await judgeReviewer({ binding: JB, reviewer: SDK_XAI, readmeRow: ROW, outDir: await sdkRun({ binding: JB, edit }), run: OK_RUN });
    assert.equal(j.status, "incomplete", name);
    for (const w of wants) assert.match(j.why.join("; "), w, `${name}: ${j.why.join("; ")}`);
  }
});

test("XAI SDK ROUTE R5: a retry is a provider call in the count -- an errored attempt the counter leaves out is a contradiction", async () => {
  const retried = t => ({ ...t, events: [{ type: "provider_call", n: 1, turn: 1, attempt: 1, http_status: 429, sdk_error: "RateLimitError" }, ...OK_EVENTS()] });
  let j = await judgeReviewer({ binding: JB, reviewer: SDK_XAI, readmeRow: ROW, outDir: await sdkRun({ binding: JB, edit: t => ({ ...retried(t), provider_calls: 4 }) }), run: OK_RUN });
  assert.equal(j.status, "complete", JSON.stringify(j.why));
  j = await judgeReviewer({ binding: JB, reviewer: SDK_XAI, readmeRow: ROW, outDir: await sdkRun({ binding: JB, edit: retried }), run: OK_RUN });
  assert.equal(j.status, "incomplete");
  assert.match(j.why.join("; "), /the recorded events hold 4 provider call\(s\); the transcript's provider_calls says 3/);
});

test("XAI SDK ROUTE R5: a valid continuation -- earlier events kept, per-run counters over this run's events, cumulative over all -- is complete; mismatched counts are not", async () => {
  const prior = [served(1), tool(1, "read_file", { path: "ophanim/operate/a.mjs" }), tool(2, "read_file", { path: "ophanim/operate/b.mjs" }), tool(3, "read_file", { path: "ophanim/operate/c.mjs" })];
  const now = [{ type: "continuation", from_sha256: "f".repeat(64), method: "replayed-history" }, served(2), tool(4, "run_tests", { files: [".review-tests/stop.test.mjs"] }), served(3)];
  const cont = (over = {}) => t => ({ ...t, events: [...prior, ...now], continued_from: { transcript: "findings-1-xai.transcript.json", sha256: "f".repeat(64), method: "replayed-history" },
    provider_calls: 2, tool_calls: 1, cumulative: { runs: 2, provider_calls: 3, tool_calls: 4, usage: {}, wall_s: 9 }, ...over });
  const judge = async edit => judgeReviewer({ binding: JB, reviewer: SDK_XAI, readmeRow: ROW, outDir: await sdkRun({ binding: JB, edit }), run: OK_RUN });
  let j = await judge(cont());
  assert.equal(j.status, "complete", JSON.stringify(j.why));
  // The false comparison this control guards against: this run's counters set to the cumulative totals.
  j = await judge(cont({ provider_calls: 3, tool_calls: 4 }));
  assert.equal(j.status, "incomplete");
  assert.match(j.why.join("; "), /this run's events \(after its continuation\) hold 2 provider call\(s\); the transcript's provider_calls says 3/);
  j = await judge(cont({ cumulative: { runs: 2, provider_calls: 2, tool_calls: 4, usage: {}, wall_s: 9 } }));
  assert.match(j.why.join("; "), /the recorded events hold 3 provider call\(s\) across the runs; cumulative\.provider_calls says 2/);
  j = await judge(cont({ cumulative: undefined }));
  assert.match(j.why.join("; "), /missing evidence: a continuation records no cumulative counts/);
  j = await judge(t => ({ ...cont()(t), events: [...prior, ...now.slice(1)] }));
  assert.match(j.why.join("; "), /a transcript continued from another records no continuation event/);
});
