// `--via subscription` end to end with FAKE CLIs only (tests/fixtures/review-clis.mjs for codex and grok, the fake agy
// of tests/fixtures/dispatch.mjs under the real bwrap). No network, no real CLI, no key: the API keys put in the parent
// environment here exist only to prove they never reach a child.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, EXIT } from "../src/review-runner/index.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { fixtureRepo, fakeFetch, capture, deps, FAKE_KEY, sh, mkdtemp, cleanup } from "./review-runner-helper.mjs";
import { fakeReviewClis } from "./fixtures/review-clis.mjs";
import { fakeAgy } from "./fixtures/dispatch.mjs";

after(cleanup);

const KEYS = { OPENAI_API_KEY: FAKE_KEY, CODEX_API_KEY: "codex-key-SHOULD-NOT-LEAK-123", XAI_API_KEY: "xai-key-SHOULD-NOT-LEAK-12345", GEMINI_API_KEY: "AIzaSHOULDNOTLEAK0123456789abcdef" };
const have = await sandboxAvailable("bwrap");
const needBwrap = { skip: have.ok ? false : `bwrap unavailable: ${have.why}` };

let shared;
async function setup() {
  shared ??= await fixtureRepo();
  const base = await mkdtemp(join(tmpdir(), "rr-sub-"));
  const bin = join(base, "bin"), home = join(base, "home"), outDir = join(base, "out"), log = join(base, "cli.log");
  await mkdir(bin); await mkdir(home); await mkdir(outDir);
  const clis = fakeReviewClis(bin);
  return { repo: shared, base, bin, home, outDir, log, clis };
}
const calls = async log => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);

async function run(f, { n, args = [], env = {} }) {
  const out = capture(), fetch = fakeFetch([]);
  const d = await deps({ root: f.repo.root, out, fetch, env: { PATH: `${f.bin}:${process.env.PATH}`, HOME: f.home, FAKE_CLI_LOG: f.log, ...KEYS, ...env } });
  const code = await main(["--via", "subscription", "--assignment", String(n), "--commit", f.repo.commit, "--out", f.outDir, ...args], d);
  const plan = (() => { try { return JSON.parse(out.out); } catch { return null; } })();
  const files = await readdir(f.outDir);
  const read = name => readFile(join(f.outDir, name), "utf8");
  return { code, out, fetch, plan, files, read, d };
}
const headerOf = md => md.split("<!-- reviewer's final message, verbatim, follows -->\n\n")[0];
const bodyOf = md => md.split("<!-- reviewer's final message, verbatim, follows -->\n\n")[1];

test("usage: --via is required, subscription requires --max-wall-s, the API caps are ignored with a note", async () => {
  const f = await setup();
  const out = capture(), d = await deps({ root: f.repo.root, out, fetch: fakeFetch([]) });
  assert.equal(await main(["--assignment", "2", "--commit", f.repo.commit, "--max-turns", "1", "--max-tool-calls", "1", "--max-output-tokens", "1", "--timeout-s", "1"], d), EXIT.usage);
  assert.match(out.err, /--via is required/);
  assert.equal(await main(["--via", "metered", "--assignment", "2", "--commit", f.repo.commit], d), EXIT.usage);
  assert.equal(await main(["--via", "subscription", "--assignment", "2", "--commit", f.repo.commit, "--timeout-s", "5"], d), EXIT.usage);
  assert.match(out.err, /--max-wall-s is required/);
  const r = await run(f, { n: 2, args: ["--max-wall-s", "60", "--max-turns", "9", "--dry-run"] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.match(r.out.err, /--max-turns is an API-mode cap.*ignored/);
  assert.deepEqual(r.plan.limits.ignored, ["--max-turns"]);
});

test("codex dry run: only the zero-spend preflights (version, login status, model list), the plan with the redacted argv, no model turn, no API call", async () => {
  const f = await setup();
  const r = await run(f, { n: 2, args: ["--max-wall-s", "600", "--dry-run"] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.equal(r.fetch.calls.length, 0);
  const c = await calls(f.log);
  assert.deepEqual(c.map(x => x.argv.slice(0, 2).join(" ")), ["--version", "login status", "debug models"]);
  const p = r.plan;
  assert.deepEqual([p.via, p.transport, p.requested_model, p.subscription_coverage, p.model_turns, p.preflight.ok], ["subscription", "codex-cli", "gpt-6-astra", "documented", 0, true]);
  assert.equal(p.argv[0], f.clis.codex);
  assert.deepEqual(p.argv.slice(1, -3), ["exec", "--json", "-m", "gpt-6-astra", "-C", p.worktree.path, "--skip-git-repo-check", "-a", "never", "--sandbox", "workspace-write"]);
  assert.match(p.argv.at(-1), /^<prompt sha256:[0-9a-f]{64}>$/);
  assert.equal(p.argv.at(-1), `<prompt sha256:${p.prompt.sha256}>`);
  assert.equal(p.preflight.checks.login_status.auth_method_observed, "chatgpt");
  assert.equal(p.preflight.checks.model_list.status, "listed");
  for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY"]) { assert.ok(p.env.removed.includes(k), k); assert.ok(!p.env.passed.includes(k), k); }
  assert.ok(p.verified_by_preflight.length && p.assumed.length && p.enforced_by_runner.length);
  assert.ok(!JSON.stringify(p).includes(FAKE_KEY));
  assert.deepEqual(await readdir(f.outDir), []);
  assert.deepEqual(await readdir(r.d.tmpBase), [], "the stand-in worktree is removed");
});

test("codex run, assignment 4: read-only sandbox, scrubbed env, findings header fields, the final message verbatim", async () => {
  const f = await setup();
  const r = await run(f, { n: 4, args: ["--max-wall-s", "60"] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  const exec = (await calls(f.log)).find(x => x.argv[0] === "exec");
  assert.equal(exec.argv[exec.argv.indexOf("--sandbox") + 1], "read-only");
  assert.equal(exec.argv[exec.argv.indexOf("-m") + 1], "gpt-6.1-sol");
  assert.deepEqual((await calls(f.log)).map(x => x.keys), [[], [], [], []], "no OPENAI_API_KEY, CODEX_API_KEY or XAI_API_KEY reaches any codex invocation");
  const md = await r.read("findings-4-openai.md");
  const h = headerOf(md);
  for (const line of ["- status: complete", "- via: subscription", "- transport: codex-cli", "- cli_version: `codex-cli 9.9.9-fake`", "- auth_method_observed: chatgpt",
    "- subscription_coverage: documented", "- requested_model: `gpt-6.1-sol`", "- served_model: `gpt-6.1-sol`", "- policy_violations: none"]) assert.ok(h.includes(line + "\n"), line);
  assert.match(h, /- served_model_source: input/);
  assert.match(h, /- sandbox: codex read-only/);
  assert.match(h, /- usage_totals: `\{"input_tokens":100,"cached_input_tokens":10,"output_tokens":20\}`/);
  assert.match(h, /- prompt_sha256: `[0-9a-f]{64}`/);
  assert.equal(bodyOf(md), "# Findings (fake codex)\n\n1. holds\n\nModel: gpt-6.1-sol\n");
  const t = JSON.parse(await r.read("findings-4-openai.transcript.json"));
  assert.deepEqual([t.via, t.transport, t.worktree_check.violations], ["subscription", "codex-cli", []]);
  for (const s of [md, JSON.stringify(t), r.out.out, r.out.err]) for (const v of Object.values(KEYS)) assert.ok(!s.includes(v));
  assert.equal(r.fetch.calls.length, 0);
  assert.deepEqual(await readdir(r.d.tmpBase), []);
  assert.equal((await sh("git", ["-C", f.repo.root, "worktree", "list"])).trim().split("\n").length, 1);
});

test("the post-run git check: a change outside .review-tests/ is a policy violation; inside it is allowed for 1-3 and a violation for 4", async () => {
  const f = await setup();
  let r = await run(f, { n: 2, args: ["--max-wall-s", "60"], env: { FAKE_CLI_WRITE: "pantheon/evil.mjs" } });
  assert.equal(r.code, EXIT.incomplete);
  let h = headerOf(await r.read("findings-2-openai.md"));
  assert.match(h, /- status: policy_violation/);
  assert.match(h, /- policy_violations: `pantheon\/evil\.mjs`/);
  r = await run(f, { n: 2, args: ["--max-wall-s", "60", "--force"], env: { FAKE_CLI_WRITE: ".review-tests/mine.test.mjs" } });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.match(headerOf(await r.read("findings-2-openai.md")), /- policy_violations: none/);
  r = await run(f, { n: 4, args: ["--max-wall-s", "60"], env: { FAKE_CLI_WRITE: ".review-tests/x.test.mjs" } });
  assert.equal(r.code, EXIT.incomplete);
  h = headerOf(await r.read("findings-4-openai.md"));
  assert.match(h, /- status: policy_violation/);
  assert.match(h, /- policy_violations: `\.review-tests\/x\.test\.mjs`/);
});

test("codex refusals, never a fallback: API-key login, no login, model missing, unreadable catalog, CLI absent", async () => {
  const f = await setup();
  const execs = async () => (await calls(f.log)).filter(x => x.argv[0] === "exec").length;
  let r = await run(f, { n: 2, args: ["--max-wall-s", "60"], env: { FAKE_CODEX_LOGIN: "apikey" } });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /reports an API key/);
  assert.equal(r.plan.preflight.checks.login_status.auth_method_observed, "api-key");
  assert.doesNotMatch(r.out.out, /ABCDEFGHIJKLMNOPQRSTUVWX/, "the login status text is recorded redacted");
  r = await run(f, { n: 2, args: ["--max-wall-s", "60", "--allow-api-key-in-cli", "--dry-run"], env: { FAKE_CODEX_LOGIN: "apikey" } });
  assert.equal(r.code, EXIT.complete, "explicitly allowed");
  r = await run(f, { n: 2, args: ["--max-wall-s", "60"], env: { FAKE_CODEX_LOGIN: "none" } });
  assert.equal(r.code, EXIT.refused);
  r = await run(f, { n: 2, args: ["--max-wall-s", "60"], env: { FAKE_CODEX_MODELS: "missing" } });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /does not list gpt-6-astra/);
  r = await run(f, { n: 2, args: ["--max-wall-s", "60", "--dry-run"], env: { FAKE_CODEX_MODELS: "garbage" } });
  assert.equal(r.code, EXIT.refused);
  r = await run(f, { n: 2, args: ["--max-wall-s", "60", "--dry-run", "--skip-model-check"], env: { FAKE_CODEX_MODELS: "garbage" } });
  assert.equal(r.code, EXIT.complete);
  r = await run(f, { n: 2, args: ["--max-wall-s", "60", "--codex-cli", join(f.base, "absent")] });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /never falls back to the API/);
  assert.equal(await execs(), 0, "no model run was started");
  assert.equal(r.fetch.calls.length, 0);
  assert.ok(!r.files.some(x => x.startsWith("findings-2")));
});

test("the wall clock kills the CLI's process group (its child too) and the run is incomplete", async () => {
  const f = await setup();
  const pidfile = join(f.base, "child.pid");
  const t0 = Date.now();
  const r = await run(f, { n: 2, args: ["--max-wall-s", "2"], env: { FAKE_CLI_MODE: "hang", FAKE_CLI_PIDFILE: pidfile } });
  assert.equal(r.code, EXIT.incomplete);
  assert.ok(Date.now() - t0 < 20_000);
  assert.match(headerOf(await r.read("findings-2-openai.md")), /- stop_reason: wall clock reached \(2 s\): process group killed/);
  const pid = Number(await readFile(pidfile, "utf8"));
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) { try { process.kill(pid, 0); await new Promise(res => setTimeout(res, 100)); } catch { alive = false; } }
  assert.equal(alive, false, "the CLI's child process was killed with its group");
});

test("grok, assignment 3: inside bwrap -- worktree read-only, .review-tests writable, state dir a scratch copy; XAI_API_KEY scrubbed; coverage undocumented; unknowns printed", needBwrap, async () => {
  const f = await setup();
  await mkdir(join(f.home, ".grok")); await writeFile(join(f.home, ".grok", "auth.json"), "{}");
  const r = await run(f, { n: 3, args: ["--max-wall-s", "60"] });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.deepEqual([r.plan.transport, r.plan.subscription_coverage, r.plan.unknowns.length > 0], ["grok-cli", "undocumented", true]);
  assert.equal(r.plan.argv[0], "bwrap");
  assert.ok(r.plan.argv.includes("--die-with-parent"));
  const md = await r.read("findings-3-xai.md");
  const probe = JSON.parse(/PROBE (\{.*\})/.exec(bodyOf(md))[1]);
  assert.deepEqual([probe.worktree_root, probe.review_tests, probe.state, probe.state_login_visible, probe.tmp], ["EROFS", "ok", "ok", true, "ok"]);
  assert.equal(existsSync(join(f.home, ".grok", "written-in-run.txt")), false, "the real state dir is untouched (the run wrote its scratch copy)");
  assert.deepEqual(probe.keys, [], "no XAI_API_KEY (nor any other key) inside the jail");
  assert.deepEqual(probe.argv, ["-p", "--output-format", "streaming-json", "-m", "grok-4.7"]);
  const h = headerOf(md);
  for (const line of ["- status: complete", "- transport: grok-cli", "- subscription_coverage: undocumented", "- served_model: `grok-4.7`", "- policy_violations: none"]) assert.ok(h.includes(line + "\n"), line);
  const t = JSON.parse(await r.read("findings-3-xai.transcript.json"));
  assert.deepEqual([t.cli.unparsed_lines, t.worktree_check.changed], [1, [".review-tests/probe.test.mjs"]]);
  assert.deepEqual(await readdir(r.d.tmpBase), []);
});

test("grok refusals: no browser login state, or a CLI that asks for a key (never given XAI_API_KEY)", needBwrap, async () => {
  const f = await setup();
  let r = await run(f, { n: 3, args: ["--max-wall-s", "60"] });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /no Grok browser login found/);
  assert.equal((await calls(f.log)).filter(x => x.argv.includes("-p")).length, 0);
  await mkdir(join(f.home, ".grok")); await writeFile(join(f.home, ".grok", "auth.json"), "{}");
  r = await run(f, { n: 3, args: ["--max-wall-s", "60"], env: { FAKE_CLI_MODE: "needkey" } });
  assert.equal(r.code, EXIT.refused);
  const h = headerOf(await r.read("findings-3-xai.md"));
  assert.match(h, /- status: refused/);
  assert.match(h, /asked for an API key or a login: subscription mode never supplies XAI_API_KEY/);
});

// ---- agy (assignment 1) with the fake agy under the real bwrap -------------------------------------------------
const usage = fraction => JSON.stringify({ conversation_id: "", status: "SUCCESS", response: "", num_turns: 0, usage: { total_tokens: 0 }, command: { name: "usage", data: { groups: [
  { name: "Gemini Models", description: "Models within this group: Gemini 4 Carbon, Gemini 3.8 Flash", buckets: [{ id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: fraction }] }] } } });
async function agySetup() {
  const f = await setup();
  const fx = join(f.base, "fx");
  await mkdir(fx);
  const g = join(f.home, ".gemini"), c = join(g, "antigravity-cli");
  await mkdir(join(c, "log"), { recursive: true }); await mkdir(join(g, "config", "projects"), { recursive: true });
  await writeFile(join(c, "antigravity-oauth-token"), "fake-token");
  const cli = fakeAgy(fx);
  await writeFile(join(fx, "quota-report.txt"), usage(0.8)); await writeFile(join(fx, "quota-exit"), "0");
  const worker = join(fx, "review-worker.sh");
  await writeFile(worker, [
    'agy_write "$dir/.review-tests/mine.test.mjs" \'import test from "node:test"; test("ok", () => {});\' || true',
    'agy_write "$dir/pantheon/evil.mjs" "x" || true',
    'agy_run "cd \'$dir\' && node --test pantheon/tests/other.test.mjs .review-tests/mine.test.mjs" >/dev/null 2>&1 || true',
    'agy_run "cd \'$dir\' && rm -rf pantheon" >/dev/null 2>&1 || true',
    'reply="# Findings (fake agy reviewer)"', ""].join("\n"));
  const env = { FAKE_AGY_LOG: join(fx, "agy.log"), PANTHEON_AGY_STATE_DIRS: fx, FAKE_AGY_WORKER: worker };
  return { ...f, fx, cli, env, launches: async () => (existsSync(join(fx, "agy.log")) ? (await readFile(join(fx, "agy.log"), "utf8")).trim().split("\n").filter(Boolean) : []) };
}

test("agy dry run, assignment 1: the jailed zero-spend preflight (/usage, lane quota, card, agents) and the plan; zero model turns", needBwrap, async () => {
  const f = await agySetup();
  const r = await run(f, { n: 1, args: ["--max-wall-s", "120", "--dry-run", "--agy-cli", f.cli], env: f.env });
  assert.equal(r.code, EXIT.complete, r.out.err);
  const p = r.plan;
  assert.deepEqual([p.transport, p.lane, p.preflight.ok, p.preflight.checks.lane_quota.state], ["agy-cli", "gemini-4-carbon-high", true, "available"]);
  for (const a of ["--agent", "pantheon-reviewer-agent", "--model", "gemini-4-carbon-high", "--mode=accept-edits", "--add-dir", "--disable-slash-commands", "--output-format", "stream-json", "--print-timeout", "--log-file"]) assert.ok(p.argv.includes(a), a);
  assert.ok(!p.argv.some(a => a === "--sandbox" || a === "--dangerously-skip-permissions"));
  assert.deepEqual(p.hook_policy.owned_paths, [".review-tests/**"]);
  assert.deepEqual(await f.launches(), [], "no model turn");
  r.plan.preflight.ok && assert.ok(!JSON.stringify(p).includes("fake-token"));
});

test("agy run, assignment 1: the hook approves the .review-tests write and the listed test command, denies the rest; findings written with the lane as served model", needBwrap, async () => {
  const f = await agySetup();
  const r = await run(f, { n: 1, args: ["--max-wall-s", "120", "--agy-cli", f.cli], env: f.env });
  assert.equal(r.code, EXIT.complete, r.out.err);
  assert.deepEqual((await f.launches()).map(l => l.split(" ")), [["pantheon-reviewer-agent", "gemini-4-carbon-high"]]);
  const t = JSON.parse(await r.read("findings-1-google.transcript.json"));
  const decisions = t.cli.jail_decisions.map(d => [d.tool, d.decision]);
  assert.deepEqual(decisions, [["write_file", "auto_approve"], ["write_file", "deny"], ["run_command", "auto_approve"], ["run_command", "deny"]]);
  assert.deepEqual(t.worktree_check, { ...t.worktree_check, changed: [".review-tests/mine.test.mjs"], violations: [] });
  const md = await r.read("findings-1-google.md");
  const h = headerOf(md);
  for (const line of ["- status: complete", "- transport: agy-cli", "- subscription_coverage: documented", "- requested_model: `gemini-4-carbon`", "- lane: `gemini-4-carbon-high`", "- served_model: `gemini-4-carbon-high`"]) assert.ok(h.includes(line + "\n"), line);
  assert.equal(bodyOf(md), "# Findings (fake agy reviewer)");
  for (const v of Object.values(KEYS)) assert.ok(!md.includes(v) && !JSON.stringify(t).includes(v));
  assert.deepEqual(await readdir(r.d.tmpBase), []);
});

test("agy refuses before any model turn when the in-jail /usage shows no login (no fallback)", needBwrap, async () => {
  const f = await agySetup();
  const r = await run(f, { n: 1, args: ["--max-wall-s", "120", "--agy-cli", f.cli], env: { ...f.env, FAKE_AGY_NOT_LOGGED_IN: "1" } });
  assert.equal(r.code, EXIT.refused);
  assert.match(r.out.err, /agy preflight auth/);
  assert.deepEqual(await f.launches(), []);
  assert.equal(r.fetch.calls.length, 0);
});
