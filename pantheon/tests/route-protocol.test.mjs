// Routing and escalation protocol: decisions come from recorded outcomes and cited facts, are the
// cheapest change for their cause, are recorded, and re-derive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextStep, escalationRecord, verifyEscalation, routeFor, classifyOutcome } from "../src/route/protocol.mjs";
import { withEffort } from "../src/sdk/adapter.mjs";
import { runOpenItem } from "../src/board/run-item.mjs";
import { openCooldownStore } from "../../packages/model-client/index.mjs";

const rejected = { kind: "acceptance", exit: 1 };
const sol = { vendor: "openai", model: "gpt-6-sol" };
const err = (status, retryAfter) => Object.assign(new Error("e"), { status, headers: { get: n => (n === "retry-after" ? retryAfter ?? null : null) } });

test("each cause gets its own action, cheapest first", () => {
  assert.equal(nextStep({ role: "implementer", seat: sol, outcome: { kind: "acceptance", exit: 0 } }).action, "hold");
  assert.equal(nextStep({ role: "implementer", seat: sol, outcome: { kind: "turn-error", error: err(429, "7") } }).action, "wait");
  assert.equal(nextStep({ role: "implementer", seat: sol, outcome: { kind: "turn-error", error: err(429) } }).action, "reseat");
  assert.equal(nextStep({ role: "implementer", seat: sol, outcome: { kind: "turn-error", error: err(400) } }).action, "stop",
    "a stronger model does not fix a malformed request");
  const effort = nextStep({ role: "implementer", seat: sol, outcome: rejected });
  assert.deepEqual([effort.action, effort.from.effort, effort.to.effort], ["raise_effort", null, "high"], "from the documented default, medium");
  assert.match(effort.basis, /developers\.openai\.com\/api\/docs\/models\/gpt-6-sol/);
  assert.equal(nextStep({ role: "implementer", seat: { ...sol, effort: "xhigh" }, outcome: rejected }).to.effort, "max");
});

test("at the top of the documented dial the next harder band is taken; with none, it stops", () => {
  const top = nextStep({ role: "implementer", seat: { ...sol, effort: "max" }, outcome: rejected });
  assert.equal(top.action, "step_rung");
  assert.notEqual(top.to.model, "gpt-6-sol");
  const reviewer = nextStep({ role: "explorer", seat: { vendor: "xai", model: "grok-4.7", effort: "xhigh" }, outcome: rejected });
  assert.equal(reviewer.action, "stop", "a role with no bands has no 'up'");
  assert.equal(nextStep({ role: "implementer", seat: sol, outcome: rejected, steps: 4 }).action, "stop", "bounded");
});

test("a truncated reply raises only the output budget, within the documented ceiling", () => {
  const cut = { kind: "turn", complete: false, terminal_state: "max_tokens" };
  const up = nextStep({ role: "planner", seat: { vendor: "anthropic", model: "claude-sonnet-5", output: 1024 }, outcome: cut });
  assert.deepEqual([up.action, up.to.output, up.to.effort], ["raise_output", 2048, null]);
  assert.equal(nextStep({ role: "planner", seat: { vendor: "anthropic", model: "claude-sonnet-5", output: 128000 }, outcome: cut }).action, "stop");
  assert.equal(nextStep({ role: "scout", seat: { vendor: "xai", model: "grok-4.6", output: 1000 }, outcome: cut }).action, "stop",
    "an undocumented ceiling is not guessed");
  assert.equal(classifyOutcome({ kind: "critique", verdict: "request_changes" }).cause, "work-rejected");
});

test("decisions are records that re-derive, and a tampered or skipped record is refused", () => {
  const first = escalationRecord({ role: "implementer", seat: sol, outcome: rejected, steps: 0 });
  const second = escalationRecord({ role: "implementer", seat: { ...sol, effort: "high" }, outcome: rejected, steps: 1 });
  assert.equal(verifyEscalation([first, second]).ok, true);
  const forged = structuredClone(second); forged.decision.to.effort = "max";
  assert.throws(() => verifyEscalation([first, forged]), /not intact/);
  assert.throws(() => verifyEscalation([first, escalationRecord({ ...second, steps: 3 })]), /step count/);
});

test("routing skips ids that are not API or lane models, and uses a deprecated model only as a last resort", () => {
  const facts = { models: {
    "a-model": { vendor: "openai", api_id: true, window: { value: 1000, source: "x", quote: "x" } },
    "b-model": { vendor: "openai", api_id: "deprecated; replaced", window: { value: 1000, source: "x", quote: "x" } },
    "c-model": { vendor: "openai", api_id: false, window: "UNRECORDED" },
  } };
  const seating = { implementer: [
    { vendor: "openai", model: "c-model", band: "medium", basis: "TASTE", why: "x" },
    { vendor: "openai", model: "b-model", band: "medium", basis: "TASTE", why: "x" },
    { vendor: "openai", model: "a-model", band: "easy", basis: "TASTE", why: "x" },
  ] };
  const r = routeFor("implementer", { difficulty: "medium", facts, seating });
  assert.equal(r.model, "a-model", "the deprecated exact band loses to a current model");
  assert.deepEqual(r.skipped.map(s => s.model), ["c-model"]);
  assert.equal(routeFor("implementer", { difficulty: "medium", needsContext: 5000, facts, seating }).ok, false);
});

test("the direct path applies a documented effort per surface and refuses an undocumented one", () => {
  assert.equal(withEffort("responses", "gpt-6-sol", "high", { model: "gpt-6-sol" }).reasoning.effort, "high");
  assert.equal(withEffort("messages", "claude-opus-5", "xhigh", { model: "claude-opus-5" }).output_config.effort, "xhigh");
  assert.throws(() => withEffort("messages", "claude-haiku-4-5-20251001", "high", {}), /not documented for claude-haiku/);
  assert.throws(() => withEffort("responses", "gpt-6-astra", "none", {}), /not documented/);
  assert.equal(withEffort("responses", "gpt-6-sol", null, { model: "x" }).reasoning, undefined);
});

// End to end: a gpt-6-sol slot fails acceptance; its second revision is sent at the raised effort.
test("a failed revision escalates the next one through the protocol, and the run records it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-protocol-"));
  try {
    mkdirSync(join(dir, "seed"), { recursive: true });
    writeFileSync(join(dir, "seed", "keep.txt"), "seed\n");
    const sent = [];
    let n = 0;
    const promptOf = req => typeof req.input === "string" ? req.input : req.input?.at(-1)?.content ?? req.messages?.at(-1)?.content ?? "";
    const answer = prompt => /VERDICT/i.test(prompt) ? "VERDICT: approve" : /TITLE:/i.test(prompt) ? "TITLE: fix"
      : /RAN: nothing/i.test(prompt) ? "RAN: nothing" : /FAILED the executed acceptance/.test(prompt) ? "export const fixed = true;\n" : "export const draft = true;\n";
    const stream = items => ({ async *[Symbol.asyncIterator]() { for (const i of items) yield i; } });
    const makeClientFor = () => ({
      responses: { inputTokens: { count: async () => ({ input_tokens: 10 }) }, create: async req => {
        sent.push({ model: req.model, effort: req.reasoning?.effort ?? null, prompt: promptOf(req) });
        const text = answer(promptOf(req)), id = `r${++n}`;
        const response = { id, status: "completed", output_text: text, output: [{ type: "message", content: [{ type: "output_text", text }] }] };
        return stream([{ type: "response.output_text.delta", delta: text }, { type: "response.completed", response }]);
      } },
      messages: { create: async req => stream([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer(promptOf(req)) } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }]) },
    });
    const seat = (vendor, model) => ({ vendor, model, rank: 0, pool: vendor, band: null, basis: "OPERATOR", why: "scripted" });
    const result = await runOpenItem({ key: "protocolFixture", repo_root: dir, title: "one file", goal: "g", copy: ["seed"],
      acceptance_cmd: "grep -q fixed alpha.mjs", question: "q", slots: [{ slot: "alpha", path: "alpha.mjs", goal: "g" }] },
    { dir: join(dir, "board"), makeClientFor, scouts: ["xai"], revisions: 2, cooldown: openCooldownStore(join(dir, "cooldown")),
      seatOverrides: { planner: seat("anthropic", "claude-fable-5-2"), implementer: seat("openai", "gpt-6-sol"), reviewer: seat("xai", "grok-4.6") } });
    assert.equal(result.shipped, true, JSON.stringify(result.error));
    const impl = sent.filter(s => s.model === "gpt-6-sol" && /Output ONLY the complete new contents/.test(s.prompt));
    assert.deepEqual(impl.map(s => s.effort), [null, "high"], "rev 1 at the default, rev 2 at the escalated documented effort");
    const run = JSON.parse(readFileSync(join(result.board, "run.json"), "utf8"));
    assert.deepEqual(run.escalations.map(e => [e.slot, e.rev, e.decision.action, e.decision.to.effort]), [["alpha", 1, "raise_effort", "high"]]);
    assert.equal(verifyEscalation(run.escalations.map(({ slot, rev, ...record }) => record)).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
