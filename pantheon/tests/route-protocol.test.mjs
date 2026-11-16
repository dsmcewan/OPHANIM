// Routing and escalation protocol: decisions come from recorded outcomes and cited facts, are the
// cheapest change for their cause, are recorded, and re-derive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextStep, escalationRecord, verifyEscalation, routeFor, classifyOutcome, carriesEffort } from "../src/route/protocol.mjs";
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

test("an agy seat's effort is not carried, so a rejection steps a rung instead of raising a dropped dial", () => {
  assert.equal(carriesEffort({ vendor: "agy_google", model: "claude-sonnet-4-6" }), false, "CLI lane model");
  assert.equal(carriesEffort({ vendor: "agy_google", model: "gemini-3.6-flash" }), false, "agy-seat.py takes no effort either");
  assert.equal(carriesEffort({ vendor: "agy_google", model: "gemini-4-argon" }), true, "frontier client carries it");
  assert.equal(carriesEffort(sol), true);
  const seating = { implementer: [
    { vendor: "agy_google", model: "gemini-3.6-flash", band: "easy", basis: "TASTE", why: "x" },
    { vendor: "openai", model: "gpt-6-sol", band: "hard", basis: "TASTE", why: "x" },
  ] };
  const agy = { vendor: "agy_google", model: "gemini-3.6-flash" };
  const d = nextStep({ role: "implementer", seat: agy, outcome: rejected, seating });
  assert.deepEqual([d.action, d.to.model, d.to.effort], ["step_rung", "gpt-6-sol", null], "documented efforts exist, but the transport drops them");
  assert.match(d.why, /not carried by the agy transport/);
  const rec = escalationRecord({ role: "implementer", seat: agy, outcome: rejected, steps: 0, seating });
  assert.equal(verifyEscalation([rec], { seating }).ok, true);
  // The planner's default ladder: the Sonnet lane rung steps to the Opus lane rung, then stops.
  const up = nextStep({ role: "planner", seat: { vendor: "agy_google", model: "claude-sonnet-4-6" }, outcome: rejected });
  assert.deepEqual([up.action, up.to.model], ["step_rung", "claude-opus-4-6-thinking"]);
  const top = nextStep({ role: "planner", seat: { vendor: "agy_google", model: "claude-opus-4-6-thinking" }, outcome: rejected });
  assert.equal(top.action, "stop");
  assert.match(top.why, /not carried by the agy transport and there is no higher banded rung/);
  const frontier = nextStep({ role: "implementer", seat: { vendor: "agy_google", model: "gemini-4-argon" }, outcome: rejected,
    seating: { implementer: [{ vendor: "agy_google", model: "gemini-4-argon", band: "easy", basis: "TASTE", why: "x" }] } });
  assert.deepEqual([frontier.action, frontier.to.effort], ["raise_effort", "high"], "the frontier path still raises the dial");
  assert.equal(routeFor("implementer", { difficulty: "easy", seating }).effort, null, "routing names no effort for an agy seat");
});

test("decisions are records that re-derive, and a tampered or skipped record is refused", () => {
  const first = escalationRecord({ role: "implementer", seat: sol, outcome: rejected, steps: 0 });
  const second = escalationRecord({ role: "implementer", seat: { ...sol, effort: "high" }, outcome: rejected, steps: 1 });
  assert.equal(verifyEscalation([first, second]).ok, true);
  const forged = structuredClone(second); forged.decision.to.effort = "max";
  assert.throws(() => verifyEscalation([first, forged]), /not intact/);
  assert.throws(() => verifyEscalation([first, escalationRecord({ ...second, steps: 3 })]), /step count/);
  // As the run stores them: with notes on where they were made. The notes are not part of the record.
  const stored = [{ purpose: "work", tier: "medium", ...first }, { slot: "a.txt", rev: 2, ...second }];
  assert.equal(verifyEscalation(stored).ok, true);
  const swapped = structuredClone(stored[1]); swapped.decision.action = "step_rung";
  assert.throws(() => verifyEscalation([stored[0], swapped]), /not intact/, "a note never shields the record itself");
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

// Scripted clients for the run-path tests below. `review` decides the reviewer's verdict;
// `cutAt` cuts an Anthropic reply off when its max_tokens is below that budget.
function scripted({ review = () => "approve", cutAt = 0 } = {}) {
  const sent = [];
  let n = 0;
  const promptOf = req => typeof req.input === "string" ? req.input : req.input?.at(-1)?.content ?? req.messages?.at(-1)?.content ?? "";
  // The implementer's request is recognised first: once findings reach it, its prompt quotes a VERDICT too.
  const answer = prompt => /Output ONLY the complete new contents/.test(prompt)
      ? (/REQUESTED CHANGES/.test(prompt) ? "export const fixed = true; // boundary handled\n" : "export const fixed = true;\n")
    : /VERDICT/i.test(prompt) ? `the boundary case is wrong\n\nVERDICT: ${review(prompt)}` : /TITLE:/i.test(prompt) ? "TITLE: fix"
    : /RAN: nothing/i.test(prompt) ? "RAN: nothing" : "export const fixed = true;\n";
  const stream = items => ({ async *[Symbol.asyncIterator]() { for (const i of items) yield i; } });
  return { sent, makeClientFor: () => ({
    responses: { inputTokens: { count: async () => ({ input_tokens: 10 }) }, create: async req => {
      sent.push({ model: req.model, effort: req.reasoning?.effort ?? null, prompt: promptOf(req) });
      const text = answer(promptOf(req)), id = `r${++n}`;
      const response = { id, status: "completed", output_text: text, output: [{ type: "message", content: [{ type: "output_text", text }] }] };
      return stream([{ type: "response.output_text.delta", delta: text }, { type: "response.completed", response }]);
    } },
    messages: { create: async req => {
      sent.push({ model: req.model, max_tokens: req.max_tokens, prompt: promptOf(req) });
      const cut = req.max_tokens < cutAt;
      return stream([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: cut ? "TITLE: fi" : answer(promptOf(req)) } },
        { type: "message_delta", delta: { stop_reason: cut ? "max_tokens" : "end_turn" } }, { type: "message_stop" }]);
    } },
  }) };
}
async function runFixture(dir, clients, extraOpts = {}) {
  mkdirSync(join(dir, "seed"), { recursive: true });
  writeFileSync(join(dir, "seed", "keep.txt"), "seed\n");
  const seat = (vendor, model) => ({ vendor, model, rank: 0, pool: vendor, band: null, basis: "OPERATOR", why: "scripted" });
  return runOpenItem({ key: "escFixture", repo_root: dir, title: "one file", goal: "g", copy: ["seed"],
    acceptance_cmd: "grep -q fixed alpha.mjs", question: "q", slots: [{ slot: "alpha", path: "alpha.mjs", goal: "g" }] },
  { dir: join(dir, "board"), makeClientFor: clients.makeClientFor, scouts: ["xai"], revisions: 2, cooldown: openCooldownStore(join(dir, "cooldown")),
    seatOverrides: { planner: seat("anthropic", "claude-sonnet-5"), implementer: seat("openai", "gpt-6-sol"), reviewer: seat("xai", "grok-4.6") }, ...extraOpts });
}

test("a cut-off reply is retried with a larger output budget within the documented ceiling, and recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-protocol-cut-"));
  try {
    const clients = scripted({ cutAt: 20000 });
    const result = await runFixture(dir, clients);
    assert.equal(result.shipped, true, JSON.stringify(result.error));
    const plan = clients.sent.filter(s => s.model === "claude-sonnet-5" && /TITLE:/.test(s.prompt));
    assert.deepEqual(plan.map(s => s.max_tokens), [16384, 32768], "the medium tier, then doubled within the documented 128K");
    const run = JSON.parse(readFileSync(join(result.board, "run.json"), "utf8"));
    const cut = run.escalations.filter(e => e.purpose === "plan");
    assert.deepEqual(cut.map(e => [e.tier, e.decision.action, e.decision.to.output]), [["medium", "raise_output", 32768]]);
    assert.equal(verifyEscalation(cut.map(({ purpose, tier, ...r }) => r)).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a reviewer's rejection of passing work escalates the maker, and resume revises at the decided effort", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-protocol-review-"));
  try {
    let reject = true;
    const clients = scripted({ review: () => (reject ? "request_changes" : "approve") });
    const first = await runFixture(dir, clients);
    assert.equal(first.shipped, false, "the REVIEW gate refuses the rejected bytes");
    let run = JSON.parse(readFileSync(join(first.board, "run.json"), "utf8"));
    const decision = run.escalations.find(e => e.outcome.kind === "critique");
    assert.deepEqual([decision.decision.action, decision.decision.to.effort], ["raise_effort", "high"]);
    assert.equal(run.files[0].escalation.pending.reason, "review");
    assert.equal(run.files[0].escalation.effort, "high");

    reject = false;
    const before = clients.sent.length;
    const second = await runOpenItem({ key: "escFixture", repo_root: dir, title: "one file", goal: "g", copy: ["seed"],
      acceptance_cmd: "grep -q fixed alpha.mjs", question: "q", slots: [{ slot: "alpha", path: "alpha.mjs", goal: "g" }] },
    { dir: join(dir, "board"), makeClientFor: clients.makeClientFor, scouts: ["xai"], revisions: 2, resume: first.board,
      cooldown: openCooldownStore(join(dir, "cooldown")),
      seatOverrides: { planner: { vendor: "anthropic", model: "claude-sonnet-5", rank: 0, pool: "anthropic", band: null, basis: "OPERATOR", why: "s" },
        implementer: { vendor: "openai", model: "gpt-6-sol", rank: 0, pool: "openai", band: null, basis: "OPERATOR", why: "s" },
        reviewer: { vendor: "xai", model: "grok-4.6", rank: 0, pool: "xai", band: null, basis: "OPERATOR", why: "s" } } });
    assert.equal(second.shipped, true, JSON.stringify(second.error));
    const revised = clients.sent.slice(before).find(s => s.model === "gpt-6-sol" && /Output ONLY the complete new contents/.test(s.prompt));
    assert.ok(revised, "resume revised the rejected slot instead of re-reviewing the same bytes");
    assert.equal(revised.effort, "high");
    assert.match(revised.prompt, /REQUESTED CHANGES/);
    assert.match(revised.prompt, /the boundary case is wrong/, "the reviewer's findings reach the maker");
    run = JSON.parse(readFileSync(join(second.board, "run.json"), "utf8"));
    assert.equal(run.files[0].escalation.pending, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("K3: with a ledger, the run verifies it first and records each escalation as an entry that re-derives", async () => {
  const { openLedger, createLedger, defineKinds, generateSigner } = await import("../../ophanim/ledger/chain.mjs");
  const { pantheonKinds, escalationRecorder } = await import("../../ophanim/ledger/kinds.mjs");
  const dir = mkdtempSync(join(tmpdir(), "pantheon-protocol-ledger-"));
  try {
    const operator = generateSigner("operator"), controller = generateSigner("controller");
    const authority = { keyring: { operator: operator.publicJwk, controller: controller.publicJwk }, orderer: "controller", operators: ["operator"] };
    const ledgerDir = join(dir, "ledger");
    mkdirSync(ledgerDir);
    const anchor = createLedger({ dir: ledgerDir, authority, operator, order: controller });
    const ledger = openLedger({ dir: ledgerDir, kinds: defineKinds(pantheonKinds({
      authors: { inputs: a => a.key_id === "operator", decisions: a => a.key_id === "controller" } })), anchor });
    const recorder = escalationRecorder({ ledger, controller, order: controller, operator });
    const clients = scripted({ cutAt: 20000 });
    const result = await runFixture(dir, clients, { ledger: recorder });
    assert.equal(result.shipped, true, JSON.stringify(result.error));
    const entries = ledger.read();
    const esc = entries.filter(e => e.kind === "escalation");
    assert.equal(esc.length, 1, "the one truncation decision is on the ledger");
    assert.deepEqual(ledger.payloadOf(esc[0]).decision.to.output, 32768);
    assert.deepEqual(esc[0].derived_from.slice(0, 2), [recorder.inputs.facts, recorder.inputs.seating], "it cites the inputs it was decided under");
    assert.equal(ledger.verify().ok, true, "every entry re-derives on replay");
    // A ledger that no longer verifies stops the next run before it relies on anything.
    const file = join(ledgerDir, "chain.jsonl");
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const forged = JSON.parse(lines.at(-1)); forged.derived_from = forged.derived_from.slice(0, 1);
    writeFileSync(file, [...lines.slice(0, -1), JSON.stringify(forged)].join("\n") + "\n");
    await assert.rejects(runFixture(join(dir, "again"), scripted(), { ledger: recorder }), /ledger does not verify, refusing to run/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
