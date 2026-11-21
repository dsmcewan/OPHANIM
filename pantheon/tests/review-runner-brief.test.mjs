import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAssignments, assignmentRow, loadBrief, composeBrief, renderHarness, listedTests, SEPARATOR, BriefError } from "../src/review-runner/brief.mjs";
import { main, EXIT } from "../src/review-runner/index.mjs";
import { REAL_ROOT, REVIEW_DIR, fixtureRepo, fakeFetch, capture, deps, LIMITS, cleanup } from "./review-runner-helper.mjs";

after(cleanup);

const dir = join(REAL_ROOT, REVIEW_DIR);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const HV = { MAX_TURNS: 1, MAX_TOOL_CALLS: 2, MAX_OUTPUT_TOKENS: 3, TIMEOUT_S: 4, READ_CAP: 5, GREP_CAP: 6, OUTPUT_CAP: 7 };

test("README table: vendor and model per assignment, as the owner assigned them", async () => {
  const rows = parseAssignments(await readFile(join(dir, "README.md"), "utf8"));
  const pick = n => { const r = rows.get(n); return [r.lab, r.vendor, r.model, r.file]; };
  assert.deepEqual(pick(1), ["Google", "gemini", "gemini-4-carbon", "1-lifecycle-evidence.md"]);
  assert.deepEqual(pick(2), ["OpenAI", "openai", "gpt-6-astra", "2-review-independence.md"]);
  assert.deepEqual(pick(3), ["xAI", "xai", "grok-4.7", "3-execution-reliability.md"]);
  assert.deepEqual(pick(4), ["OpenAI", "openai", "gpt-6.1-sol", "4-sandbox-security.md"]);
  assert.equal(rows.get(4).testing, "Source inspection and existing authorized tests only");
});

test("a row naming no model, or an unknown lab, is refused", () => {
  const readme = "| # | Assignment | Reviewer lab | Scope | Testing |\n|---|---|---|---|---|\n" +
    "| 1 | [A](1-a.md) | Google | s | Local deterministic fixtures |\n" +
    "| 2 | [B](2-b.md) | Acme, `m-1` | s | t |\n" +
    "| 3 | [C](3-c.md) | xAI, `grok-4.7` | s | t |\n";
  assert.throws(() => assignmentRow(readme, 1), BriefError, /names no model/);
  assert.throws(() => assignmentRow(readme, 2), /not one of Google, OpenAI, xAI/);
  assert.throws(() => assignmentRow(readme, 4), /not in the README table/);
  assert.equal(assignmentRow(readme, 3).model, "grok-4.7");
});

test("the runner refuses (exit 1) an assignment whose README row names no model, with no provider call", async () => {
  const real = await readFile(join(dir, "README.md"), "utf8");
  const { root, commit } = await fixtureRepo({ readme: real.replace("Google, `gemini-4-carbon`", "Google") });
  const out = capture(), fetch = fakeFetch([]);
  const code = await main(["--assignment", "1", "--commit", commit, ...LIMITS, "--dry-run"], await deps({ root, fetch, out }));
  assert.equal(code, EXIT.refused);
  assert.match(out.err, /names no model/);
  assert.equal(fetch.calls.length, 0);
});

test("brief = README + separator + assignment file verbatim + one commit line; system = HARNESS.md", async () => {
  const readme = await readFile(join(dir, "README.md"), "utf8");
  const a2 = await readFile(join(dir, "2-review-independence.md"), "utf8");
  const a4 = await readFile(join(dir, "4-sandbox-security.md"), "utf8");
  const harness = await readFile(join(dir, "HARNESS.md"), "utf8");
  const b = await loadBrief({ repoRoot: REAL_ROOT, n: 2, commit: COMMIT, harnessValues: HV });
  assert.equal(b.brief, readme + SEPARATOR + a2 + "\nCommit under review: " + COMMIT + "\n");
  assert.equal(b.brief, composeBrief({ readme, assignmentText: a2, commit: COMMIT }));
  assert.ok(b.brief.startsWith(readme));
  // Nothing from another assignment's file that the README does not itself contain.
  assert.ok(a4.includes("**Hook fail-closed.**"));
  for (const marker of ["**Hook fail-closed.**", "**Earliest gate.**", "**Call budgets.**", "findings-"]) {
    if (marker === "findings-") { assert.equal(/findings-\d/.test(b.brief), false); continue; }
    assert.equal(b.brief.includes(marker), false, marker);
  }
  assert.equal(b.brief.split("\n").filter(l => l.startsWith("Commit under review:")).length, 1);
  // System text: HARNESS.md with only its placeholders filled.
  assert.equal(b.harnessTemplate, harness);
  assert.equal(b.system, harness.replace(/\{\{(\w+)\}\}/g, (_, k) => String({ COMMIT, ...HV }[k])));
  assert.doesNotMatch(b.system, /\{\{/);
  assert.ok(b.system.includes(COMMIT));
});

test("HARNESS rendering refuses an unknown placeholder", () => {
  assert.throws(() => renderHarness("x {{NOPE}}", {}), /unknown placeholder/);
});

test("assignment 4's listed tests expand its globs and bare names against the commit's files", async () => {
  const a4 = await readFile(join(dir, "4-sandbox-security.md"), "utf8");
  const files = ["pantheon/tests/agy-a.test.mjs", "pantheon/tests/agy-b.test.mjs", "pantheon/tests/pipeline-a2a.test.mjs",
    "pantheon/tests/pipeline-mcp.test.mjs", "pantheon/tests/pipeline-run.test.mjs", "pantheon/tests/pipeline-ladder.test.mjs",
    "pantheon/tests/other.test.mjs", "pantheon/tests/agy-helper.mjs"];
  const r = listedTests(a4, files);
  assert.deepEqual(r.patterns, ["pantheon/tests/agy-*.test.mjs", "pantheon/tests/pipeline-a2a.test.mjs", "pantheon/tests/pipeline-mcp.test.mjs", "pantheon/tests/pipeline-run.test.mjs"]);
  assert.deepEqual(r.files, ["pantheon/tests/agy-a.test.mjs", "pantheon/tests/agy-b.test.mjs", "pantheon/tests/pipeline-a2a.test.mjs", "pantheon/tests/pipeline-mcp.test.mjs", "pantheon/tests/pipeline-run.test.mjs"]);
});
