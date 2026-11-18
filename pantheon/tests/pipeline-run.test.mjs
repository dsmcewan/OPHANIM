// The orchestrator on real temporary git repositories with scripted turns: concurrency and worktree isolation,
// the multi-file unit, the write jail, skipping, limits, and the non-contributor arbiter pin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPipeline, contributionsOf, arbitersOf, PIPELINE_SCHEMA, MCP_SERVER_PATH } from "../src/pipeline/index.mjs";
import { candidateRefusal, contributorKeys } from "../src/review/identity.mjs";
import { tempRepo, seats, unit, scripted, sh, sleep, write, ask, reject, RUBRIC, LUNA, PLANNER } from "./fixtures/pipeline-stages.mjs";

const run = async (t, plan, script = {}, extra = {}) => {
  const env = await tempRepo(extra.files);
  t.after(env.cleanup);
  const s = scripted({ plan, ...script });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(extra.seats), turns: s.turns, limits: extra.limits, dir: env.dir, planner: PLANNER });
  return { ...env, out, calls: s.calls, disk: () => JSON.parse(readFileSync(join(env.dir, "pipeline.json"), "utf8")) };
};
const show = (repo, ref, path) => sh(`git show ${ref}:${path}`, repo);

test("disjoint units share a wave, really overlap in time, and each works in a DIFFERENT worktree", async t => {
  const plan = [unit("a"), unit("b"), unit("c", { depends_on: ["a", "b"], verify_cmd: "test -f src/a/impl.mjs && test -f src/b/impl.mjs && test -f src/c/impl.mjs" })];
  const r = await run(t, plan, { implement: async args => { await sleep(250); await write(args.cwd, `src/${args.unit_id}/impl.mjs`, "export {};\n"); return "done"; } });
  assert.equal(r.out.status, "completed");
  assert.deepEqual(r.out.waves, [["a", "b"], ["c"]]);
  const [a, b, c] = ["a", "b", "c"].map(id => r.calls.find(x => x.role === "implementer" && x.unit_id === id));
  assert.ok(a.t0 < b.t1 && b.t0 < a.t1, `a [${a.t0},${a.t1}] and b [${b.t0},${b.t1}] did not overlap`);
  assert.ok(c.t0 >= Math.max(a.t1, b.t1), "c started before its upstream wave ended");
  assert.equal(new Set([a.cwd, b.cwd, c.cwd]).size, 3);
  assert.notEqual(a.cwd, r.repo); assert.notEqual(b.cwd, r.repo);
  // Worktrees are removed when the unit ends; the integration branch holds all three units; the checkout is untouched.
  for (const x of [a, b, c]) assert.equal(existsSync(x.cwd), false);
  assert.equal((await sh("git worktree list", r.repo)).trim().split("\n").length, 1);
  for (const id of ["a", "b", "c"]) assert.match(await show(r.repo, r.out.integration.branch, `src/${id}/impl.mjs`), /export/);
  assert.equal((await sh("git status --porcelain", r.repo)).trim(), "");
  assert.equal(existsSync(join(r.repo, "src")), false);
  // The record on disk is the returned record.
  assert.equal(r.disk().schema, PIPELINE_SCHEMA);
  assert.deepEqual(r.disk(), JSON.parse(JSON.stringify(r.out)));
  assert.deepEqual(r.out.provider_calls, { total: 9, refused_at_limit: 0, by_role: { dispatcher: 3, implementer: 3, subagent: 0, reviewer: 3 } });
});

test("overlapping units without an order refuse the whole plan before any turn; a broken plan likewise", async t => {
  const r = await run(t, [unit("a", { owned_paths: ["src/**"] }), unit("b")]);
  assert.equal(r.out.status, "refused"); assert.equal(r.out.refusals[0].code, "LOCK_CONFLICT"); assert.equal(r.calls.length, 0);
  const bad = await run(t, [unit("a", { depends_on: ["nope"] })]);
  assert.equal(bad.out.status, "refused"); assert.equal(bad.out.refusals[0].code, "UNKNOWN_DEPENDENCY"); assert.equal(bad.disk().status, "refused");
});

test("overlapping units with an order run in different waves, the later one on top of the earlier one's merged result", async t => {
  const plan = [unit("a", { owned_paths: ["lib/**"], verify_cmd: "test -f lib/one.mjs" }), unit("b", { owned_paths: ["lib/two.mjs", "lib/one.mjs"], depends_on: ["a"], verify_cmd: "grep -q two lib/one.mjs" })];
  const r = await run(t, plan, { implement: async args => {
    if (args.unit_id === "a") await write(args.cwd, "lib/one.mjs", "export const one = 1;\n");
    else { assert.match(readFileSync(join(args.cwd, "lib/one.mjs"), "utf8"), /one = 1/); await write(args.cwd, "lib/one.mjs", "export const one = 1; // two\n"); await write(args.cwd, "lib/two.mjs", "export const two = 2;\n"); }
    return "done"; } });
  assert.equal(r.out.status, "completed"); assert.deepEqual(r.out.waves, [["a"], ["b"]]);
  assert.match(await show(r.repo, r.out.integration.branch, "lib/one.mjs"), /two/);
});

test("a multi-file unit: ONE implementer turn writes types + implementation + test in one worktree, verified by running the test", async t => {
  const plan = [unit("codec", { owned_paths: ["src/codec/**"], verify_cmd: "node src/codec/codec.test.mjs", invariants: ["encode and decode round-trip"] })];
  const r = await run(t, plan, { implement: async args => {
    await write(args.cwd, "src/codec/types.mjs", "export const KINDS = Object.freeze(['hex']);\n");
    await write(args.cwd, "src/codec/codec.mjs", "import { KINDS } from './types.mjs';\nexport const encode = s => Buffer.from(s).toString(KINDS[0]);\nexport const decode = h => Buffer.from(h, KINDS[0]).toString();\n");
    await write(args.cwd, "src/codec/codec.test.mjs", "import assert from 'node:assert/strict';\nimport { encode, decode } from './codec.mjs';\nassert.equal(decode(encode('pantheon')), 'pantheon');\nconsole.log('round-trip ok');\n");
    return "done"; } });
  assert.equal(r.out.status, "completed");
  const u = r.out.units.codec;
  assert.equal(r.calls.filter(c => c.role === "implementer").length, 1);
  assert.deepEqual(u.attempts[0].changed.map(c => c.path), ["src/codec/codec.mjs", "src/codec/codec.test.mjs", "src/codec/types.mjs"]);
  assert.equal(u.attempts[0].status, "written");
  assert.equal(u.reviews[0].verify.exit_code, 0); assert.match(u.reviews[0].verify.digest, /^sha256:/);
  assert.match(r.calls.find(c => c.role === "reviewer").prompt, /round-trip ok/);   // ground truth output reaches the reviewer
  assert.match(r.calls.find(c => c.role === "reviewer").prompt, /\+export const encode/);   // and the diff, read from disk
  assert.equal(r.calls.find(c => c.role === "reviewer").cwd, null);   // read-only: no working directory
  for (const f of ["types.mjs", "codec.mjs", "codec.test.mjs"]) await show(r.repo, r.out.integration.branch, `src/codec/${f}`);
  // The specialist prompt is built from the unit, not a general-purpose one.
  const p = r.calls.find(c => c.role === "implementer").prompt;
  for (const want of [/ROLE: node-esm-library-engineer/, /- src\/codec\/\*\*/, /encode and decode round-trip/, /1\. the verify command passes/, /node src\/codec\/codec\.test\.mjs/, /SUBAGENTS: none/]) assert.match(p, want);
});

test("write jail: a file outside owned_paths refuses the attempt and discards ALL of it; the next attempt is told why", async t => {
  const seen = [];
  const r = await run(t, [unit("a")], { implement: async (args, n) => {
    seen.push({ impl: existsSync(join(args.cwd, "src/a/impl.mjs")), stray: existsSync(join(args.cwd, "README.md")) && readFileSync(join(args.cwd, "README.md"), "utf8") });
    await write(args.cwd, "src/a/impl.mjs", "export {};\n");
    if (n === 1) { await write(args.cwd, "README.md", "rewritten\n"); await write(args.cwd, "src/other/new.mjs", "x\n"); }
    return "done"; } });
  const u = r.out.units.a;
  assert.equal(u.attempts[0].status, "refused"); assert.equal(u.attempts[0].code, "WRITE_JAIL");
  assert.deepEqual(u.attempts[0].violations.map(v => [v.path, v.code]), [["README.md", "OUTSIDE_OWNED"], ["src/other/new.mjs", "OUTSIDE_OWNED"]]);
  // Attempt 2 started from a clean worktree: the owned file of the refused attempt is gone too, README is the base's.
  assert.deepEqual(seen[1], { impl: false, stray: "base\n" });
  assert.match(r.calls.filter(c => c.role === "implementer")[1].prompt, /write jail: README\.md \(OUTSIDE_OWNED\)/);
  assert.equal(r.calls.filter(c => c.role === "reviewer").length, 1);   // the refused attempt never reached review
  assert.equal(u.status, "approved");
  assert.equal(await show(r.repo, r.out.integration.branch, "README.md"), "base\n");
  // Only the attempt that passed the jail is a contribution.
  assert.equal(contributionsOf(r.out).filter(c => c.kind === "work").length, 1);
});

test("write jail: symlink escapes, a deletion outside the unit, a git-ignored file and a commit by the implementer are all refused", async t => {
  const cases = {
    abs_link: [async cwd => { await write(cwd, "src/a/impl.mjs", "x\n"); await symlink("/etc/passwd", join(cwd, "src/a/passwd")); }, "src/a/passwd", "SYMLINK_ESCAPE"],
    rel_link: [async cwd => { await write(cwd, "src/a/impl.mjs", "x\n"); await symlink("../../../../outside.txt", join(cwd, "src/a/out")); }, "src/a/out", "SYMLINK_ESCAPE"],
    through_dir: [async cwd => { await writeFile(join(cwd, "src/a/escape/planted.txt"), "x\n"); }, "src/a/escape", "SYMLINK_ESCAPE_TRACKED"],
    deletion: [async cwd => { await write(cwd, "src/a/impl.mjs", "x\n"); await sh("rm README.md", cwd); }, "README.md", "OUTSIDE_OWNED"],
    ignored: [async cwd => { await write(cwd, "src/a/impl.mjs", "x\n"); await write(cwd, "cache/blob.bin", "x\n"); }, "cache/blob.bin", "OUTSIDE_OWNED"],
    committed: [async cwd => { await write(cwd, "src/a/impl.mjs", "x\n"); await sh("git add -A && git -c user.name=i -c user.email=i@i.invalid commit -q -m mine", cwd); }, "HEAD", "HEAD_MOVED"],
  };
  for (const [name, [act, path, code]] of Object.entries(cases)) {
    const env = await tempRepo({ "README.md": "base\n", ".gitignore": "cache/\n" });
    t.after(env.cleanup);
    if (name === "through_dir") {   // a tracked symlinked directory inside the owned paths, pointing out of the repository
      await sh(`mkdir -p ${JSON.stringify(join(env.root, "outside"))} src/a && ln -s ${JSON.stringify(join(env.root, "outside"))} src/a/escape && git add -A && git -c user.name=t -c user.email=t@t.invalid commit -q -m link`, env.repo);
    }
    const s = scripted({ plan: [unit("a")], implement: async args => { await act(args.cwd); return "done"; } });
    const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: [unit("a")] }, seats: seats(), turns: s.turns, dir: env.dir, limits: { max_revisions: 0 } });
    const a = out.units.a.attempts[0];
    if (name === "through_dir") {
      // A write THROUGH a tracked symlinked directory is invisible to git, so the unit is refused before any turn is asked.
      assert.equal(a.status, "refused"); assert.equal(a.code, "JAIL_UNENFORCEABLE");
      assert.deepEqual(a.violations.map(v => [v.path, v.code]), [["src/a/escape", "SYMLINK_ESCAPE_TRACKED"]]);
      assert.equal(s.calls.filter(c => c.role === "implementer").length, 0);
      continue;
    }
    assert.equal(a.status, "refused", `${name}: ${JSON.stringify(a)}`);
    assert.ok(a.violations.some(v => v.path === path && v.code === code), `${name}: ${JSON.stringify(a.violations)}`);
    assert.equal(out.units.a.status, "blocked"); assert.equal(out.units.a.merged, false);
    assert.equal(out.integration.head, out.base.commit, `${name}: something reached the integration branch`);
    assert.equal(s.calls.filter(c => c.role === "reviewer").length, 0);
  }
});

test("downstream units of a blocked unit are skipped with the reason; independent units continue", async t => {
  const plan = [unit("a"), unit("b", { depends_on: ["a"] }), unit("c", { depends_on: ["b"] }), unit("x")];
  const r = await run(t, plan, { implement: async args => { if (args.unit_id !== "a") await write(args.cwd, `src/${args.unit_id}/impl.mjs`, "x\n"); return "done"; } }, { limits: { max_revisions: 1 } });
  const st = Object.fromEntries(Object.values(r.out.units).map(u => [u.unit_id, u.status]));
  assert.deepEqual(st, { a: "blocked", b: "skipped", c: "skipped", x: "approved" });
  assert.match(r.out.units.b.reason, /upstream unit a ended blocked/); assert.match(r.out.units.c.reason, /upstream unit b ended skipped/);
  assert.equal(r.out.status, "incomplete");
  assert.deepEqual(r.out.integration.merged, ["x"]);
  assert.equal(r.calls.filter(c => c.unit_id === "b" || c.unit_id === "c").length, 0);
});

test("a non-cohesive unit is returned to the planner and never dispatched", async t => {
  const r = await run(t, [unit("a")], { dispatch: args => ({ unit_id: args.unit_id, cohesive: false, specialist_role: "x", difficulty: "medium", rubric: RUBRIC, notes: "split" }) });
  assert.equal(r.out.units.a.status, "returned"); assert.equal(r.out.units.a.worktree, null);
  assert.equal(r.calls.filter(c => c.role !== "dispatcher").length, 0);
});

test("limits: the provider-call bound stops the run truthfully; max_concurrent_units 1 serialises a wave", async t => {
  const capped = await run(t, [unit("a"), unit("b")], {}, { limits: { max_provider_calls: 4, max_concurrent_units: 1 } });
  assert.equal(capped.out.provider_calls.total, 4);
  assert.deepEqual([capped.out.units.a.status, capped.out.units.b.status], ["approved", "blocked"]);
  assert.match(capped.out.units.b.reason, /provider-call bound \(4\) is exhausted/);
  const serial = await run(t, [unit("a"), unit("b")], { implement: async args => { await sleep(120); await write(args.cwd, `src/${args.unit_id}/impl.mjs`, "x\n"); return "ok"; } }, { limits: { max_concurrent_units: 1 } });
  const [a, b] = ["a", "b"].map(id => serial.calls.find(c => c.role === "implementer" && c.unit_id === id));
  assert.ok(b.t0 >= a.t1, "two units were active at once under max_concurrent_units: 1");
  assert.equal(serial.out.status, "completed");
});

test("a dispatcher seat off the judging vendor, and a reviewer ladder that is not pinned or leaves OpenAI, are refused", async t => {
  const off = await run(t, [unit("a")], {}, { seats: { dispatcher: () => ({ vendor: "anthropic", model: "claude-opus-5" }) } });
  assert.equal(off.out.units.a.status, "refused"); assert.match(off.out.units.a.reason, /openai seats/); assert.equal(off.calls.length, 0);
  const unpinned = await run(t, [unit("a")], {}, { seats: { reviewerLadder: () => [{ vendor: "openai", model: "gpt-6-sol" }] } });
  assert.match(unpinned.out.units.a.reason, /pinned to the Stage 2 model/);
  const leaves = await run(t, [unit("a")], {}, { seats: { reviewerLadder: () => [{ ...LUNA }, { vendor: "anthropic", model: "claude-opus-5" }] } });
  assert.match(leaves.out.units.a.reason, /escalates within the dispatcher's vendor only/);
  assert.equal(leaves.calls.filter(c => c.role === "implementer").length, 0);
});

test("OWNER GOVERNANCE DECISION 2026-11-17: the dispatcher is a non-contributor arbiter, and its exact model is the pinned Stage 5 reviewer", async t => {
  const plan = [unit("a", { allowed_subagents: ["api-historian"] })];
  const r = await run(t, plan, { implement: async args => {
    const got = await ask(args.a2a, { role: "api-historian", unit_id: "a", text: "which codec?" });
    await write(args.cwd, "src/a/impl.mjs", `// ${got.body.result.parts[0].data.answer}\n`);
    return { text: "done", served_model: "gemini-4-hydrogen" }; } });
  assert.equal(r.out.status, "completed");
  const u = r.out.units.a;
  // Stage 2 is recorded as an arbiter that authored nothing; Stage 5 was performed by exactly that model.
  assert.deepEqual([u.dispatch.role, u.dispatch.standing, u.dispatch.authored], ["dispatcher", "arbiter", false]);
  assert.deepEqual([u.reviews[0].vendor, u.reviews[0].model, u.reviews[0].served_model], [u.dispatch.vendor, u.dispatch.model, u.dispatch.served_model]);
  assert.equal(u.reviews[0].pinned_to_dispatcher, true); assert.equal(u.reviews[0].rubric_hash, u.dispatch.rubric_hash);
  assert.equal(u.reviewer_fed_revision, false);

  const contributions = contributionsOf(r.out), arbiters = arbitersOf(r.out);
  assert.deepEqual(contributions.map(c => [c.kind, c.vendor, c.model, c.served_model]), [
    ["plan", "anthropic", "claude-opus-5", "claude-opus-5"],
    ["subtask", "xai", "grok-4.5", "grok-4.5"],
    ["work", "agy_google", "gemini-4-hydrogen-medium", "gemini-4-hydrogen"]]);
  assert.equal(contributions.some(c => c.vendor === "openai"), false);
  assert.deepEqual(arbiters.map(a => [a.role, a.standing, a.authored, a.vendor, a.model, a.rubric_hash]), [["dispatcher", "arbiter", false, "openai", "gpt-6-luna", u.dispatch.rubric_hash]]);
  assert.deepEqual(r.disk().contributions, contributions); assert.deepEqual(r.disk().arbiters, arbiters);

  // Under the repository's model-level rule the pinned reviewer is NOT refused given the run's contributions ...
  const keys = contributorKeys(contributions);
  assert.deepEqual(keys.unresolved, []);
  assert.equal(candidateRefusal(LUNA, keys), null);
  // ... and it WOULD be refused if the dispatcher were counted as a contributor. That difference is the decision.
  assert.match(candidateRefusal(LUNA, contributorKeys([...contributions, ...arbiters])), /openai\/gpt-6-luna contributed to the change under review/);
  // The models that did author are refused, as ever.
  assert.match(candidateRefusal({ vendor: "xai", model: "grok-4.5" }, keys), /contributed/);
  assert.match(candidateRefusal({ vendor: "anthropic", model: "claude-opus-5" }, keys), /contributed/);
});

test("a Stage 5 reviewer whose finding is fed to a revision becomes a `critique` contributor for later reviews, and STAYS the pinned reviewer", async t => {
  const r = await run(t, [unit("a")], { review: (args, n) => n === 1 ? reject(RUBRIC, ["impl.mjs exports nothing"]) : { verdict: "approve", criteria: RUBRIC.map(criterion => ({ criterion, met: true, evidence: "diff" })), findings: [] } });
  const u = r.out.units.a;
  assert.equal(u.status, "approved"); assert.equal(u.reviewer_fed_revision, true);
  assert.deepEqual(u.reviews.map(x => [x.model, x.status, x.fed_revision, x.pinned_to_dispatcher]), [["gpt-6-luna", "request_changes", true, true], ["gpt-6-luna", "approved", false, true]]);
  assert.match(r.calls.filter(c => c.role === "implementer")[1].prompt, /impl\.mjs exports nothing/);
  const contributions = contributionsOf(r.out);
  assert.deepEqual(contributions.filter(c => c.kind === "critique").map(c => [c.vendor, c.model]), [["openai", "gpt-6-luna"]]);
  // For a LATER, separate review the existing rule applies: luna has now shaped the work.
  assert.match(candidateRefusal(LUNA, contributorKeys(contributions)), /contributed to the change under review/);
  assert.equal(arbitersOf(r.out).length, 1);
});

test("a run that does not name its planner records an unnamed plan contribution: no reviewer can be shown independent of it", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const s = scripted({ plan: [unit("a")] });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: [unit("a")] }, seats: seats(), turns: s.turns, dir: env.dir });
  assert.deepEqual(contributionsOf(out).find(c => c.kind === "plan"), { kind: "plan", unit_id: null, role: "planner", vendor: null, model: null, served_model: null });
  assert.match(candidateRefusal(LUNA, contributorKeys(contributionsOf(out))), /unresolved/);
});

test("the implementer call contract: control_dir outside the worktree, the shim's Unix socket in it, the relay's env, owned paths and verify_cmd", async t => {
  const plan = [unit("a", { allowed_subagents: ["math", "api-historian"] })];
  let seen = null;
  const r = await run(t, plan, { implement: async args => {
    seen = { ...args, socket_up: existsSync(args.a2a.socket), control_is_dir: statSync(args.control_dir).isDirectory(), mode: statSync(args.control_dir).mode & 0o777 };
    const got = await ask(args.a2a, { role: "math", unit_id: "a", text: "six times seven?" });
    await write(args.cwd, "src/a/impl.mjs", `// ${got.body.result.parts[0].data.answer}\n`);
    return "done"; } });
  assert.equal(r.out.status, "completed");
  assert.deepEqual(Object.keys(seen.a2a).sort(), ["roles", "socket", "token", "url"]);
  assert.equal(seen.a2a.url, null); assert.deepEqual(seen.a2a.roles, ["api-historian", "math"]);
  assert.equal(seen.control_dir, join(r.dir, "control", "a")); assert.equal(seen.control_is_dir, true); assert.equal(seen.mode, 0o700);
  assert.equal(seen.control_dir.startsWith(seen.cwd), false); assert.equal(seen.cwd.startsWith(seen.control_dir), false);
  assert.equal(seen.a2a.socket, join(seen.control_dir, "a2a.sock")); assert.equal(seen.socket_up, true);
  assert.deepEqual(seen.env, { PANTHEON_A2A_SOCKET: seen.a2a.socket, PANTHEON_A2A_TOKEN: seen.a2a.token, PANTHEON_A2A_ROLES: "api-historian,math", PANTHEON_UNIT_ID: "a" });
  assert.deepEqual(seen.owned_paths, ["src/a/**"]); assert.equal(seen.verify_cmd, "test -f src/a/impl.mjs");
  assert.deepEqual([seen.unit_id, seen.mcp_server, seen.seat.model], ["a", MCP_SERVER_PATH, "gemini-4-hydrogen-medium"]);
  assert.match(seen.prompt, /MCP tool `ask_subagent` of the server `pantheon-subagents`/);
  assert.equal(seen.prompt.includes(seen.a2a.token), false, "the token is in the prompt");
  // The record names the socket used; the socket is gone when the unit ends; the token is not on disk.
  assert.deepEqual(r.out.units.a.a2a.socket, { file: seen.a2a.socket, fallback: false });
  assert.equal(existsSync(seen.a2a.socket), false);
  assert.equal(readFileSync(join(r.dir, "pipeline.json"), "utf8").includes(seen.a2a.token), false);
  assert.deepEqual(r.out.units.a.a2a.calls.map(c => [c.role, c.status]), [["math", "answered"]]);
});
