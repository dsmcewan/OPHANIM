// Audit M6 (docs/reviews/2026-11-16-routing-coordination): an operator's lane seat on the command line,
// `pantheon-board.mjs run <item> --seat implementer=agy_google/<lane model>`, must reach the lane's
// declared transport (agy-cli), never an API-only registry lookup -- and the run must say so on the turn.
// The lane this was first written against (claude-sonnet-4-6) was retired 2026-11-17, owner direction:
// Antigravity serves Gemini models only. The positive case now runs on the remaining live lane
// (gemini-3.8-flash-high); the old seat is kept as a refusal that must make no Antigravity call.
// Everything is a fake: the seats (--clients), the cycle reviewers (--turn), the agy CLI (a script that logs
// its launch), a temporary git repository and a status ledger signed by test keys moved out of the repo.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { openStatusLedger } from "../../packages/ledger/status.mjs";
import { withDispatch } from "./fixtures/dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD_CLI = resolve(HERE, "..", "bin", "pantheon-board.mjs");
const FIXTURE = pathToFileURL(join(HERE, "fixtures", "dispatch.mjs")).href;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const ITEM = "lane-seat-item";

// One CLI run of the fixture item with the given --seat values; returns what the run left behind.
async function runCli(seats, fn) {
  await withDispatch(async ({ dir: repo, agy }) => {
    writeFileSync(join(repo, "alpha.mjs"), "export const ok = false;\n");
    writeFileSync(join(repo, "verify.mjs"), 'import assert from "node:assert/strict"; import {ok} from "./alpha.mjs"; assert.equal(ok, true);\n');
    writeFileSync(join(repo, ".gitignore"), "outputs/\ncooldowns/\nboard/\nbundle/\nagy.log\nfake-agy\n*.fixture.mjs\n");
    mkdirSync(join(repo, "tickets"));
    writeFileSync(join(repo, "tickets", `${ITEM}.json`), JSON.stringify({
      schema: "ophanim.ticket/v1", item: ITEM, slice: "the whole item: alpha.mjs exports ok = true",
      proposes: { state: "Resolved", basis: "alpha.mjs exports ok = true" },
      title: "alpha.mjs exports ok = true", goal: "Make alpha.mjs export `ok` as true.", question: "fixture",
      repo_root: ".", slot: "alpha", path: "alpha.mjs", copy: ["alpha.mjs", "verify.mjs"], acceptance_cmd: "node verify.mjs", difficulty: "easy",
    }, null, 2) + "\n");
    // The scripted seats and cycle reviewers, as the modules the CLI loads.
    writeFileSync(join(repo, "clients.fixture.mjs"), `import { scriptedClients } from ${JSON.stringify(FIXTURE)};\nexport default scriptedClients();\n`);
    writeFileSync(join(repo, "turn.fixture.mjs"), "let n = 0;\nexport default async ({ vendor, model }) => ({ text: '```json\\n{\"verdict\": \"approve\", \"findings\": []}\\n```', response_id: `cli_${vendor}_${++n}`, served_model: model });\n");
    const statusRoot = join(repo, "status", "ledger");
    openStatusLedger({ root: statusRoot });
    const keys = mkdtempSync(join(tmpdir(), "pantheon-cli-keys-"));
    try {
      chmodSync(keys, 0o700);
      for (const f of readdirSync(join(statusRoot, "keys"))) renameSync(join(statusRoot, "keys", f), join(keys, f));
      rmSync(join(statusRoot, "keys"), { recursive: true });
      openStatusLedger({ root: statusRoot, keys }).set({ item: ITEM, title: "Lane seat", state: "Ready", basis: "nothing external awaited", checked: "2026-11-17" });
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.name", "Fixture Owner");
      git(repo, "config", "user.email", "owner@example.invalid");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "fixture base");

      const out = spawnSync(process.execPath, [BOARD_CLI, "run", ITEM, "--repo", repo, "--status-ledger", statusRoot,
        "--clients", join(repo, "clients.fixture.mjs"), "--turn", join(repo, "turn.fixture.mjs"),
        ...seats.flatMap(s => ["--seat", s]),
        "--dir", join(repo, "board"), "--out", join(repo, "bundle"), "--checked", "2026-11-18"], { encoding: "utf8", env: process.env, timeout: 120_000 });
      const runPath = join(repo, "board", "run.json");
      await fn({ out, result: JSON.parse(out.stdout), agy, run: existsSync(runPath) ? JSON.parse(readFileSync(runPath, "utf8")) : null });
    } finally { rmSync(keys, { recursive: true, force: true }); }
  });
}

test("M6: --seat implementer=agy_google/gemini-3.8-flash-high through pantheon-board.mjs reaches the agy lane transport", async () => {
  await runCli(["planner=anthropic/claude-fable-5-2", "implementer=agy_google/gemini-3.8-flash-high", "reviewer=xai/grok-4.6"], ({ out, result, agy, run }) => {
    assert.equal(result.shipped, true, `${out.stdout}\n${out.stderr.slice(-2000)}`);
    assert.deepEqual(agy().filter(a => a.agent === "pantheon-implementer"), [{ agent: "pantheon-implementer", model: "gemini-3.8-flash-high" }],
      "the implementer turn launched the agy lane with the operator's model");
    const work = run.turns.filter(t => t.purpose === "work");
    assert.deepEqual(work.map(t => [t.vendor, t.model, t.transport, t.pool, t.selection?.source]),
      [["agy_google", "gemini-3.8-flash-high", "agy-cli", "agy_google", "operator-override"]]);
    // The Antigravity transport reports no serving model; the turn carries the requested one, marked as an input.
    assert.deepEqual(work.map(t => [t.served_model, t.served_model_source]), [["gemini-3.8-flash-high", "input"]]);
  });
});

test("M6: --seat implementer=agy_google/claude-sonnet-4-6 (a retired lane) is refused, and no Antigravity call is made", async () => {
  await runCli(["planner=anthropic/claude-fable-5-2", "implementer=agy_google/claude-sonnet-4-6", "reviewer=xai/grok-4.6"], ({ out, result, agy, run }) => {
    const said = `${out.stdout}\n${out.stderr.slice(-2000)}`;
    assert.equal(result.shipped, false, said);
    assert.equal(result.commit, null, said);
    assert.match(out.stderr, /the Antigravity transport serves Gemini models only: claude-sonnet-4-6 is a anthropic model/);
    assert.deepEqual(agy(), [], "the fake agy CLI was never launched: the refusal precedes any Antigravity call");
    assert.deepEqual((run?.turns ?? []).filter(t => t.purpose === "work"), [], "no work turn was recorded");
  });
});
