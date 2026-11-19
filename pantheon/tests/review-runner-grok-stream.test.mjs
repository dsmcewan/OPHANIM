// The Grok CLI's streaming-json as OBSERVED (grok 1.0.44, the owner's assignment-3 runs at 09d490f, 2026-11-19):
//   - the trimmed fixture tests/fixtures/grok-1.0.44-observed-stream.json (the real event shapes of both legs);
//   - the recorded transcripts themselves (docs/reviews/2026-11-18-independent-review/findings-3-xai-09d490f/), whose
//     cli.own holds the raw events: the parser must give back, byte for byte, the final message the owner recovered by
//     hand (grok-assignment-3-recovered-final.md, sha256 in grok-assignment-3-recovery.json).
// Also the stop-reason rule (any stopReason but end_turn is not a finished review) and the permission-config reader.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { grokPermissionConfig, grokPermissionVerdict, grokRecommendedAllow, grokStopFailure, parseGrokInspect, parseGrokStream } from "../src/review-runner/grok.mjs";
import { READ_ONLY_SHELL } from "../src/review-runner/cli-common.mjs";
import { mkdtemp, cleanup } from "./review-runner-helper.mjs";

test.after(cleanup);

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, "fixtures", "grok-1.0.44-observed-stream.json"), "utf8"));
const REVIEW = join(HERE, "..", "..", "docs", "reviews", "2026-11-18-independent-review");
const RUN = join(REVIEW, "findings-3-xai-09d490f");
const lines = evs => evs.map(e => JSON.stringify(e));

test("fixture: the fixture holds no home path and no credential-looking value", () => {
  const raw = readFileSync(join(HERE, "fixtures", "grok-1.0.44-observed-stream.json"), "utf8");
  assert.doesNotMatch(raw, /\/home\/(?!fixture\b)[^/"]+/);
  assert.doesNotMatch(raw, /"signature":"(?!<elided>)/);
  assert.deepEqual([FX.cli_version, FX.leg_1.stop_reason, FX.leg_2.stop_reason], ["grok 1.0.44 (5b807183dd79)", "cancelled", "end_turn"]);
});

test("observed leg 2 (end_turn): the final text is the text chunks after the last tool event, joined; thoughts, plan, usage and end never count", () => {
  const r = parseGrokStream(lines(FX.leg_2.events));
  assert.equal(r.final_text, FX.leg_2.expected_final_text);
  assert.ok(r.final_text.startsWith("# Assignment 3: Execution reliability\n\nLab: xAI."));
  assert.deepEqual([r.final_source, r.stop_reason, r.unparsed, r.cancelled_tools], ["chunks", "end_turn", 0, []]);
  assert.equal(r.chunks, FX.leg_2.events.filter(e => e.type === "text").length);
  assert.equal(r.num_turns, 91);
  assert.equal(typeof r.usage.input_tokens, "number", "the end event's usage is the last usage");
});

test("observed leg 1 (cancelled): narration before a tool call is not a final text; the stop reason and the cancelled tool are reported", () => {
  const r = parseGrokStream(lines(FX.leg_1.events));
  assert.ok(FX.leg_1.events.some(e => e.type === "text"), "the leg has narration text");
  assert.equal(r.final_text, null);
  assert.equal(r.stop_reason, "cancelled");
  assert.deepEqual(r.cancelled_tools, [{ tool: "search_replace", message: "User cancelled the execution for tool `search_replace`" }]);
  const why = grokStopFailure(r.stop_reason, r.cancelled_tools, FX.leg_1.exit_code);
  assert.match(why, /^grok ended its turn with stopReason "cancelled", not "end_turn" \(exit 0\): the review did not finish; 1 tool call\(s\) were cancelled \(search_replace: "User cancelled/);
  assert.match(why, /permission profile/);
  assert.match(why, /string-form allow rules \(`allow = \[\.\.\.\]` under \[permission\]\)/);
  assert.match(grokStopFailure("max_tokens", [], 0), /stopReason "max_tokens", not "end_turn".*permission profile/);
});

test("the recorded 09d490f transcripts: the parser reproduces the owner's recovered final message byte for byte (leg 2) and none for leg 1", { skip: existsSync(join(RUN, "findings-3-xai.transcript.json")) ? false : "the recorded run is not in this checkout" }, () => {
  const recovery = JSON.parse(readFileSync(join(RUN, "grok-assignment-3-recovery.json"), "utf8"));
  const recovered = readFileSync(join(RUN, "grok-assignment-3-recovered-final.md"));
  assert.equal(createHash("sha256").update(recovered).digest("hex"), recovery.recovered_sha256);
  const leg2 = JSON.parse(readFileSync(join(RUN, "findings-3-xai.transcript.json"), "utf8")).cli.own;
  const r2 = parseGrokStream(leg2.map(o => o.text));
  assert.equal(r2.stop_reason, "end_turn");
  assert.equal(r2.chunks, recovery.public_text_chunks_joined);
  const bytes = Buffer.from(r2.final_text, "utf8");
  assert.equal(bytes.length, recovery.recovered_utf8_bytes);
  assert.ok(bytes.equals(recovered), "byte-for-byte the recovered final message");
  const leg1 = JSON.parse(readFileSync(join(RUN, "continuation", "findings-3-xai.transcript.json"), "utf8")).cli.own;
  const r1 = parseGrokStream(leg1.map(o => o.text));
  assert.deepEqual([r1.final_text, r1.stop_reason, r1.cancelled_tools.map(c => c.tool)], [null, "cancelled", ["search_replace"]]);
});

test("the other stream shapes still parse (results, assistant messages, *_delta chunks); a tool call after a message drops it", () => {
  const s = parseGrokStream(['{"type":"start"}', "nope", '{"type":"message","role":"assistant","content":"partial"}', '{"type":"result","result":"FINAL","usage":{"t":1}}', ""]);
  assert.deepEqual([s.final_text, s.unparsed, s.events, s.usage, s.stop_reason], ["FINAL", 1, 3, { t: 1 }, null]);
  assert.equal(parseGrokStream(['{"type":"text_delta","delta":"A"}', '{"type":"usage","usage":{}}', '{"type":"text_delta","delta":"B"}']).final_text, "AB", "housekeeping does not split a run");
  assert.equal(parseGrokStream(['{"type":"text","data":"I will look."}', '{"type":"tool_call","toolName":"grep"}']).final_text, null);
  assert.equal(parseGrokStream(['{"type":"result","result":"R"}', '{"type":"tool_call","toolName":"grep"}']).final_text, "R", "a result event stands");
});

test("grokPermissionConfig reads the [ui] permission mode and the [permission] section; only the STRING form counts as loaded rules (grok 1.0.44 loaded zero from structured rules); never throws", async () => {
  const d = await mkdtemp(join(tmpdir(), "rr-grok-perm-"));
  assert.deepEqual(await grokPermissionConfig(d), { path: join(d, "config.toml"), present: false, permission_mode: null, rules: [], allow: [], deny: [], structured_rules: 0, structured_allow_rules: 0, allow_rules: 0 });
  await mkdir(join(d, "sub"));
  await writeFile(join(d, "config.toml"), [
    "# owner's config", "[ui]", 'permission_mode = "ask" # default', "[permission]", "rules = [",
    '  { action = "allow", tool = "Edit" },', '  { action = "allow", tool = "Bash", pattern = "node --test *" },', '  { action = "deny", tool = "Bash", pattern = "rm -rf *" },', "]",
    "[other]", 'api_key = "not-recorded"', ""].join("\n"));
  let p = await grokPermissionConfig(d);
  // The round-1 count (2 "allow" lines) was what the header showed while the CLI loaded zero rules.
  assert.deepEqual([p.present, p.permission_mode, p.allow_rules, p.structured_rules, p.structured_allow_rules], [true, "permission_mode=ask", 0, 3, 2]);
  assert.deepEqual(p.rules, ["rules = [", '{ action = "allow", tool = "Edit" },', '{ action = "allow", tool = "Bash", pattern = "node --test *" },', '{ action = "deny", tool = "Bash", pattern = "rm -rf *" },', "]"]);
  assert.ok(!JSON.stringify(p).includes("not-recorded"), "only the [ui] mode and the [permission] section are read");
  assert.match(grokPermissionVerdict(p).failed.join("\n"), /has no string-form \[permission\] allow rule \(it has 2 structured `rules = \[\.\.\.\]` allow rule\(s\), which grok 1.0.44 loaded as zero rules/);
  // A multi-line string array, with a deny array.
  await writeFile(join(d, "config.toml"), ['[permission]', 'allow = [', '  "Read",', "  'Grep',", '  "Bash(sed -n *)",', ']', 'deny = ["Bash(rm *)"]', ""].join("\n"));
  p = await grokPermissionConfig(d);
  assert.deepEqual([p.allow, p.deny, p.allow_rules, p.structured_rules], [["Read", "Grep", "Bash(sed -n *)"], ["Bash(rm *)"], 3, 0]);
});

test("the owner's round-2 Grok profile (77480d6): the six string-form rules count, the structured array does not; the missing read-only allowances that cancelled the first leg (wc, find) are named", async () => {
  const d = await mkdtemp(join(tmpdir(), "rr-grok-perm-"));
  await writeFile(join(d, "config.toml"), readFileSync(join(REVIEW, "findings-runs-77480d6", "grok-effective-permission-profile.toml"), "utf8"));
  const p = await grokPermissionConfig(d);
  const compat = JSON.parse(readFileSync(join(REVIEW, "findings-runs-77480d6", "grok-permission-cli-compatibility.json"), "utf8"));
  assert.deepEqual(p.allow, compat.equivalent_allow_rules);
  assert.deepEqual([p.allow_rules, p.structured_rules], [6, 6]);
  const v = grokPermissionVerdict(p);
  assert.deepEqual(v.failed, []);
  assert.match(v.warnings[0], /also has 6 structured `rules = \[\.\.\.\]` rule\(s\); grok 1.0.44 loaded none/);
  for (const r of ["Bash(wc *)", "Bash(find *)", "Bash(sed -n *)", "Bash(git log *)", "Bash(OPHANIM_TELOS_ROOT=* npm run test:proof)", "Bash(npm --prefix pantheon test)"]) assert.ok(v.warnings[1].includes(r), r);
  // The CLI's own inspection, as the owner captured it: 6 loaded, none skipped -> no refusal; 0 loaded -> refusal.
  const inspected = parseGrokInspect(readFileSync(join(REVIEW, "findings-runs-77480d6", "grok-permission-inspect.json"), "utf8"));
  assert.deepEqual([inspected.ok, inspected.loaded, inspected.skipped], [true, 6, []]);
  assert.deepEqual(grokPermissionVerdict(p, inspected).failed, []);
  assert.match(grokPermissionVerdict(p, { ...inspected, loaded: 0 }).failed.join(""), /reports 0 loaded permission rules/);
  assert.match(grokPermissionVerdict(p, parseGrokInspect("not json")).failed.join(""), /inspection could not be read \(the inspection output is not JSON\)/);
});

test("the README's Grok example is the string form, holds every recommended allowance, and no auto/always-approve mode", async () => {
  const readme = readFileSync(join(REVIEW, "README.md"), "utf8");
  const block = /Grok permissions[\s\S]*?```toml\n([\s\S]*?)```/.exec(readme)[1];
  assert.doesNotMatch(block, /rules\s*=/, "the structured form grok 1.0.44 does not load is not the example");
  const d = await mkdtemp(join(tmpdir(), "rr-grok-perm-"));
  await writeFile(join(d, "config.toml"), block);
  const p = await grokPermissionConfig(d);
  assert.deepEqual(grokPermissionVerdict(p), { failed: [], warnings: [] });
  assert.deepEqual([...p.allow].sort(), [...grokRecommendedAllow()].sort());
  for (const c of READ_ONLY_SHELL) assert.ok(p.allow.includes(`Bash(${c} *)`), c);
  // A mode that approves everything is a refusal.
  await writeFile(join(d, "config.toml"), `[ui]\npermission_mode = "always-approve"\n${block}`);
  assert.match(grokPermissionVerdict(await grokPermissionConfig(d)).failed.join(""), /sets permission_mode=always-approve/);
});
