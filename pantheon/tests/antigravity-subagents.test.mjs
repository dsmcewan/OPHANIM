// THE SUBAGENT GOVERNOR (src/antigravity/subagents.mjs): the controller's admission of native Antigravity subagents.
// Pure: no SDK, no provider, no process. Each test names the defect it would catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { subagentGovernor, SUBAGENT_MODEL, SUBAGENT_CEILINGS, SUBAGENT_TYPES, ceilingFor } from "../src/antigravity/subagents.mjs";

const CARBON = { vendor: "agy_google", model: "gemini-4-carbon" }, NEON = { vendor: "agy_google", model: "gemini-4-neon" }, HYDROGEN = { vendor: "agy_google", model: "gemini-4-hydrogen" };
const ROOT = "root-trajectory";
const entry = (i, over = {}) => ({ TypeName: "code-explorer", Role: `Code Explorer ${i}`, Prompt: `Find every caller of parseTicket() under src/board and report file and line (assignment ${i}).`, ...over });
const ask = (g, n, over = {}, from = ROOT) => g.admit({ call_id: `call-${Math.random()}`, trajectory_id: from, args: { Subagents: Array.from({ length: n }, (_, i) => entry(i + 1, over)) } });
const gov = (implementer, over = {}) => { const g = subagentGovernor({ implementer, unit_id: "u1", allowed_types: Object.keys(SUBAGENT_TYPES), ...over }); g.observe({ event: "trajectory_state", trajectory_id: ROOT, parent_trajectory_id: "", depth: 0, state: "RUNNING" }); return g; };

test("the ceilings are the owner's: Carbon 8, Neon 4, Hydrogen none; any other implementer model delegates to none", () => {
  assert.deepEqual(SUBAGENT_CEILINGS, { "gemini-4-carbon": 8, "gemini-4-neon": 4, "gemini-4-hydrogen": 0 });
  assert.equal(ceilingFor("gemini-4-carbon"), 8);
  assert.equal(ceilingFor("gemini-4-neon"), 4);
  assert.equal(ceilingFor("gemini-4-hydrogen"), 0);
  assert.equal(ceilingFor("gemini-4-argon"), 0, "a model with no declared ceiling gets none, never a default team");
  assert.equal(SUBAGENT_MODEL, "gemini-4-hydrogen");
});

test("a Carbon implementer is admitted up to 8 live subagents; the ninth is rejected, and the rejection is on the record", () => {
  const g = gov(CARBON);
  const first = ask(g, 5), second = ask(g, 3);
  assert.equal(first.allow, true); assert.equal(second.allow, true);
  const ninth = ask(g, 1);
  assert.equal(ninth.allow, false);
  assert.equal(ninth.code, "SUBAGENT_LIMIT");
  assert.match(ninth.reason, /8 live \+ 1 asked > 8/);
  const rec = g.record();
  assert.equal(rec.ceiling, 8);
  assert.equal(rec.admitted_total, 8, "exactly the ceiling was admitted");
  assert.equal(rec.instances.length, 8);
  assert.equal(rec.rejections.length, 1);
  assert.deepEqual({ code: rec.rejections[0].code, asked: rec.rejections[0].asked, live: rec.rejections[0].live, ceiling: rec.rejections[0].ceiling }, { code: "SUBAGENT_LIMIT", asked: 1, live: 8, ceiling: 8 });
  assert.ok(rec.instances.every(i => i.model === "gemini-4-hydrogen"), "every admitted subagent is pinned to Hydrogen");
});

test("a single call asking for more than the ceiling is rejected whole: nothing of it is admitted", () => {
  const g = gov(NEON);
  const r = ask(g, 5);
  assert.equal(r.allow, false);
  assert.equal(r.code, "SUBAGENT_LIMIT");
  assert.equal(g.record().admitted_total, 0, "a rejected call admits no part of itself");
  assert.equal(ask(g, 4).allow, true, "the ceiling itself is still available after the rejection");
  assert.equal(ask(g, 1).allow, false);
});

test("a Neon implementer never exceeds 4 live subagents", () => {
  const g = gov(NEON);
  assert.equal(ask(g, 4).allow, true);
  const fifth = ask(g, 1);
  assert.deepEqual([fifth.allow, fifth.code], [false, "SUBAGENT_LIMIT"]);
  assert.equal(g.record().peak_live, 4);
});

test("a Hydrogen implementer delegates to no subagent by default", () => {
  const g = gov(HYDROGEN);
  const r = ask(g, 1);
  assert.deepEqual([r.allow, r.code], [false, "SUBAGENT_NOT_ALLOWED"]);
  assert.match(r.reason, /gemini-4-hydrogen implementer delegates to no subagent/);
  assert.equal(g.record().rejections[0].code, "SUBAGENT_NOT_ALLOWED");
});

// The runtime starts child `i` with the assignment the (i + 1)th admitted subagent was given: that is how a trajectory
// is bound to its instance, and only a bound instance carries a state.
const start = (g, i) => g.observe({ event: "child_started", trajectory_id: `child-${i}`, parent_trajectory_id: ROOT, prompt: entry(i + 1).Prompt });
const state = (g, i, name) => g.observe({ event: "trajectory_state", trajectory_id: `child-${i}`, parent_trajectory_id: ROOT, depth: 1, state: name });

test("an idle subagent still holds its slot: the runtime lets its parent wake it without a controller checkpoint", () => {
  const g = gov(NEON);
  assert.equal(ask(g, 4).allow, true);
  // All four ran and went idle. A slot freed here would let four more start and the first four be woken: eight at once.
  for (let i = 0; i < 4; i++) { start(g, i); state(g, i, "RUNNING"); }
  for (let i = 0; i < 4; i++) state(g, i, "FULLY_IDLE");
  assert.deepEqual(g.record().instances.map(i => i.status), ["idle", "idle", "idle", "idle"], "each child is bound to its admitted subagent: the governor knows all four are idle");
  const r = ask(g, 1);
  assert.deepEqual([r.allow, r.code], [false, "SUBAGENT_LIMIT"], "idle is not terminated: the slot is held for the session");
  const rec = g.record();
  assert.equal(rec.peak_active, 4);
  assert.equal(rec.active, 0);
  assert.equal(rec.live, 4);
});

test("a cancelled subagent does not free its slot either: the gateway's count of child sessions never shrinks, so a freed slot would admit a subagent the wire then refuses", () => {
  const g = gov(NEON);
  assert.equal(ask(g, 4).allow, true);
  for (let i = 0; i < 4; i++) { start(g, i); state(g, i, "RUNNING"); }
  state(g, 0, "CANCELLED");
  const r = ask(g, 1);
  assert.deepEqual([r.allow, r.code], [false, "SUBAGENT_LIMIT"], "a slot is held from admission to the end of the implementer session");
  const rec = g.record();
  assert.equal(rec.instances[0].status, "cancelled", "the cancellation itself is on the record");
  assert.deepEqual([rec.live, rec.admitted_total, rec.peak_live, rec.active], [4, 4, 4, 3]);
  assert.deepEqual(rec.rejections.map(x => [x.code, x.live, x.ceiling]), [["SUBAGENT_LIMIT", 4, 4]]);
});

test("a subagent type the controller did not pin to Hydrogen is rejected: it would run as a clone of the implementer", () => {
  const g = gov(CARBON);
  const r = ask(g, 1, { TypeName: "dyn-helper" });
  assert.deepEqual([r.allow, r.code], [false, "SUBAGENT_TYPE_NOT_PINNED"]);
  assert.match(r.reason, /dyn-helper/);
});

test("a type the unit's contract does not allow is rejected, even though the controller pins it", () => {
  const g = gov(CARBON, { allowed_types: ["code-explorer"] });
  const r = ask(g, 1, { TypeName: "bounded-implementer" });
  assert.deepEqual([r.allow, r.code], [false, "SUBAGENT_TYPE_NOT_ALLOWED"]);
  assert.equal(ask(g, 1).allow, true);
});

test("a model or tier named on the invocation is rejected: the pin decides, never the implementer", () => {
  const g = gov(CARBON);
  for (const Model of ["pro", "flash", "flash_lite", "gemini-4-carbon"]) {
    const r = ask(g, 1, { Model });
    assert.deepEqual([r.allow, r.code], [false, "SUBAGENT_MODEL_OVERRIDE"], Model);
  }
  assert.equal(ask(g, 1, { Model: "inherit" }).allow, true, "\"inherit\" names no other model: the pinned type still runs on Hydrogen (SDK contract test)");
});

test("a branched or shared workspace is rejected: a subagent works in the unit's one controller-bound worktree", () => {
  const g = gov(CARBON);
  for (const Workspace of ["branch", "share", "/tmp/elsewhere"]) {
    const r = ask(g, 1, { Workspace });
    assert.deepEqual([r.allow, r.code], [false, "SUBAGENT_WORKSPACE"], Workspace);
  }
  assert.equal(ask(g, 1, { Workspace: "inherit" }).allow, true);
});

test("a subagent may not delegate: an invocation from a child trajectory is rejected", () => {
  const g = gov(CARBON);
  assert.equal(ask(g, 1).allow, true);
  g.observe({ event: "trajectory_state", trajectory_id: "child-0", parent_trajectory_id: ROOT, depth: 1, state: "RUNNING" });
  const r = ask(g, 1, {}, "child-0");
  assert.deepEqual([r.allow, r.code], [false, "SUBAGENT_RECURSION"]);
});

test("an invocation without a specific assignment is rejected", () => {
  const g = gov(CARBON);
  for (const over of [{ Prompt: "" }, { Prompt: "help" }, { Role: " " }, { Prompt: 7 }]) {
    const r = ask(g, 1, over);
    assert.deepEqual([r.allow, r.code], [false, "SUBAGENT_ASSIGNMENT"], JSON.stringify(over));
  }
  for (const args of [{}, { Subagents: [] }, { Subagents: "x" }, { Subagents: [null] }, null]) {
    const r = g.admit({ call_id: "c", trajectory_id: ROOT, args });
    assert.deepEqual([r.allow, r.code], [false, "SUBAGENT_MALFORMED"], JSON.stringify(args));
  }
});

test("each admitted subagent has an identity, a scope and its tool permissions on the record; the prompt itself is not kept", () => {
  const g = gov(CARBON);
  const secret = "Find the callers of loadTicket() in src/board and list them with line numbers.";
  const r = g.admit({ call_id: "call-1", trajectory_id: ROOT, args: { Subagents: [{ TypeName: "code-explorer", Role: "Caller Finder", Prompt: secret }, { TypeName: "test-constructor", Role: "Test Writer", Prompt: "Write tests for loadTicket() covering a missing file and a malformed ticket." }] } });
  assert.equal(r.allow, true);
  const [a, b] = g.record().instances;
  assert.deepEqual({ id: a.id, type: a.type, role: a.role, model: a.model, call_id: a.call_id, status: a.status }, { id: "sa-1", type: "code-explorer", role: "Caller Finder", model: "gemini-4-hydrogen", call_id: "call-1", status: "admitted" });
  assert.equal(a.scope.write, "none");
  assert.match(b.scope.write, /owned_paths/);
  assert.ok(a.tools.includes("view_file") && !a.tools.includes("create_file") && !a.tools.includes("run_command"));
  assert.ok(b.tools.includes("create_file") && b.tools.includes("edit_file") && !b.tools.includes("run_command"));
  assert.match(a.prompt_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.prompt_bytes, Buffer.byteLength(secret));
  assert.ok(!JSON.stringify(g.record()).includes("loadTicket"), "the record holds the assignment's digest, not its text");
});

test("lifecycle and usage are tracked per subagent, bound by the assignment each child was started with", () => {
  const g = gov(CARBON);
  const promptA = "Report every file under src/route that imports fit-matrix.mjs, with the names imported.";
  const promptB = "Report which tests under tests/ cover reviewerEscalation(), by test name and file.";
  g.admit({ call_id: "c1", trajectory_id: ROOT, args: { Subagents: [{ TypeName: "dependency-analyst", Role: "Import Tracer", Prompt: promptA }, { TypeName: "context-retriever", Role: "Test Locator", Prompt: promptB }] } });
  // The children start in the other order: binding is by assignment, not by arrival.
  g.observe({ event: "trajectory_state", trajectory_id: "t-b", parent_trajectory_id: ROOT, depth: 1, state: "RUNNING" });
  g.observe({ event: "child_started", trajectory_id: "t-b", parent_trajectory_id: ROOT, prompt: promptB });
  g.observe({ event: "trajectory_state", trajectory_id: "t-a", parent_trajectory_id: ROOT, depth: 1, state: "RUNNING" });
  g.observe({ event: "child_started", trajectory_id: "t-a", parent_trajectory_id: ROOT, prompt: promptA });
  g.observe({ event: "usage", agents: { [ROOT]: { total_token_count: 900 }, "t-a": { prompt_token_count: 100, candidates_token_count: 20, thoughts_token_count: 5, total_token_count: 125 }, "t-b": { total_token_count: 40 } } });
  g.observe({ event: "child_output", trajectory_id: "t-a", text: "three files import it" });
  g.observe({ event: "trajectory_state", trajectory_id: "t-a", parent_trajectory_id: ROOT, depth: 1, state: "FULLY_IDLE" });
  g.observe({ event: "trajectory_state", trajectory_id: "t-b", parent_trajectory_id: ROOT, depth: 1, state: "FULLY_IDLE", error: "model unreachable", error_code: "UNAVAILABLE" });
  const rec = g.record();
  const a = rec.instances.find(i => i.type === "dependency-analyst"), b = rec.instances.find(i => i.type === "context-retriever");
  assert.equal(a.trajectory_id, "t-a"); assert.equal(b.trajectory_id, "t-b");
  assert.deepEqual(a.states.map(s => s.state), ["RUNNING", "FULLY_IDLE"]);
  assert.equal(a.status, "idle");
  assert.equal(a.usage.total_token_count, 125);
  assert.match(a.output.digest, /^sha256:/); assert.equal(a.output.bytes, Buffer.byteLength("three files import it"));
  assert.equal(b.status, "errored");
  assert.match(b.error, /model unreachable/);
  assert.equal(rec.peak_active, 2);
  assert.equal(rec.unbound_trajectories.length, 0);
});

test("a child trajectory the controller cannot attribute to an admitted subagent is recorded, never ignored", () => {
  const g = gov(CARBON);
  g.observe({ event: "trajectory_state", trajectory_id: "ghost", parent_trajectory_id: ROOT, depth: 1, state: "RUNNING" });
  const rec = g.record();
  assert.deepEqual(rec.unbound_trajectories.map(t => t.trajectory_id), ["ghost"]);
  assert.equal(g.subagentOf("ghost"), null);
  assert.equal(g.isChild("ghost"), true, "an unattributed child is still a child: the tool policy treats it as read-only");
  assert.equal(g.isChild(ROOT), false);
});
