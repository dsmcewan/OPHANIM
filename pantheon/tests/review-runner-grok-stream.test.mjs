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
import { grokPermissionConfig, grokStopFailure, parseGrokStream } from "../src/review-runner/grok.mjs";
import { mkdtemp, cleanup } from "./review-runner-helper.mjs";

test.after(cleanup);

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, "fixtures", "grok-1.0.44-observed-stream.json"), "utf8"));
const RUN = join(HERE, "..", "..", "docs", "reviews", "2026-11-18-independent-review", "findings-3-xai-09d490f");
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
  assert.match(why, /\[permission\] allow rules/);
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

test("grokPermissionConfig reads the [ui] permission mode and the [permission] lines of the state dir's config.toml, and never throws", async () => {
  const d = await mkdtemp(join(tmpdir(), "rr-grok-perm-"));
  assert.deepEqual(await grokPermissionConfig(d), { path: join(d, "config.toml"), present: false, permission_mode: null, rules: [], allow_rules: 0 });
  await mkdir(join(d, "sub"));
  await writeFile(join(d, "config.toml"), [
    "# owner's config", "[ui]", 'permission_mode = "ask" # default', "[permission]", "rules = [",
    '  { action = "allow", tool = "Edit" },', '  { action = "allow", tool = "Bash", pattern = "node --test *" },', '  { action = "deny", tool = "Bash", pattern = "rm -rf *" },', "]",
    "[other]", 'api_key = "not-recorded"', ""].join("\n"));
  const p = await grokPermissionConfig(d);
  assert.deepEqual([p.present, p.permission_mode, p.allow_rules], [true, "permission_mode=ask", 2]);
  assert.deepEqual(p.rules, ["rules = [", '{ action = "allow", tool = "Edit" },', '{ action = "allow", tool = "Bash", pattern = "node --test *" },', '{ action = "deny", tool = "Bash", pattern = "rm -rf *" },', "]"]);
  assert.ok(!JSON.stringify(p).includes("not-recorded"), "only the [ui] mode and the [permission] section are read");
});
