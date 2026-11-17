// Audit M5 on the operator's surfaces: `pantheon-board.mjs run|resume --max-provider-calls N` and the build
// API's `max_provider_calls`. The bound covers the board run's provider calls (the pipeline's, then the cycle
// reviewers'); a resume inherits it with the calls already made counted, unless the operator passes a new one.
// Everything is a fake: scripted seats (--clients), scripted cycle reviewers (--turn, logging each call), a
// temporary git repository and a status ledger whose keys are moved out of the repository.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { withDispatch } from "./fixtures/dispatch.mjs";
import { createBuildServer } from "../src/view/build-server.mjs";
import { boardFixture } from "./fixtures/board-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD_CLI = resolve(HERE, "..", "bin", "pantheon-board.mjs");
const ITEM = "bound-item";

const cli = (repo, statusRoot, ...args) => spawnSync(process.execPath, [BOARD_CLI, ...args, "--repo", repo, "--status-ledger", statusRoot,
  "--turn", join(repo, "turn.fixture.mjs")], { encoding: "utf8", env: process.env, timeout: 120_000 });
const reviews = repo => existsSync(join(repo, "reviews.log")) ? readFileSync(join(repo, "reviews.log"), "utf8").split("\n").filter(Boolean).length : 0;

test("M5: --max-provider-calls bounds the board run; resume inherits it with the calls already made, unless the operator names a new one", async () => {
  await withDispatch(async ({ dir: repo }) => {
    const { statusRoot, keys } = boardFixture(repo);
    try {
      // scout, plan, work and the in-run critique are the pipeline's four calls: none is left for the cycle.
      const out = cli(repo, statusRoot, "run", ITEM, "--clients", join(repo, "clients.fixture.mjs"), "--max-provider-calls", "4",
        "--dir", join(repo, "board"), "--out", join(repo, "bundle"), "--checked", "2026-11-18");
      const first = JSON.parse(out.stdout);
      assert.equal(first.shipped, true, `${out.stdout}\n${out.stderr.slice(-2000)}`);
      assert.equal(first.proposal, null, "the cycle could not be asked: no proposal");
      assert.deepEqual([first.provider_calls.limit, first.provider_calls.pipeline, first.provider_calls.review, first.provider_calls.made], [4, 4, 0, 4]);
      assert.equal(first.provider_calls.refused.length, 3, "each cycle reviewer was refused before it was called");
      assert.equal(reviews(repo), 0);

      // Resumed without a bound: the run's bound and its four calls still apply; no reviewer is asked.
      const again = JSON.parse(cli(repo, statusRoot, "resume", ITEM, "--out", join(repo, "bundle")).stdout);
      assert.equal(again.proposal, null);
      assert.equal(reviews(repo), 0, "a resume does not get a fresh limit");
      assert.deepEqual([again.provider_calls.limit, again.provider_calls.basis, again.provider_calls.made], [4, "inherited", 4]);
      assert.equal(again.resumes.at(-1).provider_calls.basis, "inherited");

      // The operator's explicit bound for this resume: recorded as such, and the reviewers are asked.
      const raised = JSON.parse(cli(repo, statusRoot, "resume", ITEM, "--out", join(repo, "bundle"), "--max-provider-calls", "3").stdout);
      assert.equal(reviews(repo), 3);
      assert.deepEqual([raised.provider_calls.limit, raised.provider_calls.basis, raised.provider_calls.made], [3, "operator", 3]);
      assert.equal(raised.resumes.at(-1).provider_calls.prior, 4);
      assert.equal(raised.failed.length, 0, JSON.stringify(raised));

      const bad = cli(repo, statusRoot, "resume", ITEM, "--out", join(repo, "bundle"), "--max-provider-calls", "0");
      assert.equal(bad.status, 2, "a bound is a positive integer");
    } finally { rmSync(keys, { recursive: true, force: true }); }
  });
});

test("M5: the build API passes max_provider_calls to the pipeline and refuses a bad one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-bound-build-"));
  const seen = [];
  const run = async (spec, o) => { seen.push(o.maxProviderCalls); return { ok: false, shipped: false, error: null }; };
  const { server, listen } = createBuildServer({ makeClientFor: () => ({}), allowedRoot: dirname(dir), run });
  const addr = await listen(0);
  try {
    const ticket = key => ({ key, repo_root: dir, title: "t", goal: "g", slot: "out.txt", path: "out.txt", copy: [], acceptance_cmd: "true", question: "q" });
    const post = body => fetch(`http://127.0.0.1:${addr.port}/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ ticket: ticket("bad"), max_provider_calls: 0 })).status, 400);
    assert.equal((await post({ ticket: ticket("bad2"), max_provider_calls: "5" })).status, 400);
    assert.equal((await post({ ticket: ticket("good"), max_provider_calls: 7 })).status, 202);
    assert.equal((await post({ ticket: ticket("none") })).status, 202);
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(seen, [7, undefined]);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});
