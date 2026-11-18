// A reviewer whose findings reach a revision prompt contributed to the revised bytes (review of 86ce18a, defect 3).
// The in-run critique's findings are put in the next revision's prompt ("address them"), so the reviewer's lab
// shaped the code it would then judge again. Its critique is recorded as a contribution of the slot (purpose
// `critique`), so the slot's later in-run review and the cycle's `change` scope exclude that lab. A critique whose
// text reached nothing is not a contribution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenItem } from "../src/board/run-item.mjs";
import { changeScope, cycleReviewers } from "../src/board/operate.mjs";
import { reviewScope } from "../src/review/scope.mjs";
import { openCooldownStore } from "../../packages/model-client/index.mjs";
import { withFakeAgy } from "./fixtures/dispatch.mjs";

function scripted({ review }) {
  const sent = [];
  let n = 0;
  const promptOf = req => typeof req.input === "string" ? req.input : req.input?.at(-1)?.content ?? req.messages?.at(-1)?.content ?? "";
  const answer = prompt => /Output ONLY the complete new contents/.test(prompt)
      ? (/REQUESTED CHANGES/.test(prompt) ? "export const fixed = true; // boundary handled\n" : "export const fixed = true;\n")
    : /VERDICT/i.test(prompt) ? `the boundary case is wrong\n\nVERDICT: ${review(prompt)}` : /TITLE:/i.test(prompt) ? "TITLE: fix"
    : /RAN: nothing/i.test(prompt) ? "RAN: nothing" : "export const fixed = true;\n";
  const stream = items => ({ async *[Symbol.asyncIterator]() { for (const i of items) yield i; } });
  return { sent, makeClientFor: vendor => ({
    responses: { inputTokens: { count: async () => ({ input_tokens: 10 }) }, create: async req => {
      sent.push({ vendor, model: req.model, prompt: promptOf(req) });
      const text = answer(promptOf(req)), id = `r${++n}`;
      const response = { id, status: "completed", output_text: text, output: [{ type: "message", content: [{ type: "output_text", text }] }] };
      return stream([{ type: "response.output_text.delta", delta: text }, { type: "response.completed", response }]);
    } },
    messages: { countTokens: async () => ({ input_tokens: 10 }), create: async req => {
      sent.push({ vendor, model: req.model, prompt: promptOf(req) });
      return stream([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer(promptOf(req)) } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }]);
    } },
    models: { countTokens: async () => ({ totalTokens: 10 }), generateContentStream: async req => {
      const prompt = (req.contents?.at?.(-1)?.parts ?? []).map(p => p.text ?? "").join("") || String(req.contents ?? "");
      sent.push({ vendor, model: req.model, prompt });
      return stream([{ candidates: [{ finishReason: "STOP", content: { parts: [{ text: answer(prompt) }] } }] }]);
    } },
  }) };
}
const seat = (vendor, model) => ({ vendor, model, rank: 0, pool: vendor, band: null, basis: "OPERATOR", why: "scripted" });
const SPEC = dir => ({ key: "critiqueFixture", repo_root: dir, title: "one file", goal: "g", copy: ["seed"],
  acceptance_cmd: "grep -q fixed alpha.mjs", question: "q", slots: [{ slot: "alpha", path: "alpha.mjs", goal: "g" }] });
const OPTS = (dir, clients, extra = {}) => ({ dir: join(dir, "board"), makeClientFor: clients.makeClientFor, scouts: ["xai"], revisions: 2,
  planTitle: "ticket", cooldown: openCooldownStore(join(dir, "cooldown")),
  seatOverrides: { implementer: seat("openai", "gpt-6-sol"), reviewer: seat("xai", "grok-4.6") }, ...extra });

test("a reviewer whose findings reach the revision is a contributor: its lab is in the scope and does not review again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-critique-contrib-"));
  const savedLedger = process.env.OPHANIM_LEDGER;
  delete process.env.OPHANIM_LEDGER;
  try {
    mkdirSync(join(dir, "seed"), { recursive: true });
    writeFileSync(join(dir, "seed", "keep.txt"), "seed\n");
    let reject = true;
    const clients = scripted({ review: () => (reject ? "request_changes" : "approve") });
    const first = await runOpenItem(SPEC(dir), OPTS(dir, clients));
    assert.equal(first.shipped, false, "the xai reviewer requested changes");
    let run = JSON.parse(readFileSync(join(first.board, "run.json"), "utf8"));
    assert.equal(run.files[0].escalation.pending.reason, "review");
    // Requested changes that have not reached any prompt yet are not a contribution.
    assert.deepEqual(run.review_scopes.alpha.contributions.map(c => c.purpose), ["work"]);

    reject = false;
    const before = clients.sent.length;
    // With the operator still pinning the xai reviewer, the revised bytes are not reviewed by it: refused, by name.
    const pinned = await runOpenItem(SPEC(dir), OPTS(dir, clients, { resume: first.board }));
    assert.equal(pinned.shipped, false, "the xai reviewer whose findings shaped the revision reviewed it again, and it shipped");
    assert.match(pinned.error?.message ?? "", /xai shares the xai lab with a critique in the reviewed scope .*revision input.* cannot review it/);
    // Unpinned, the selector seats a lab that contributed nothing to the revised bytes, and the change ships.
    // The selector's next reviewer is the Google seat, which goes through its Antigravity lane first (owner direction
    // 2026-11-17): the fake CLI answers it, and its log is where that review is seen.
    let lane = [];
    const second = await withFakeAgy(dir, async ({ agy }) => {
      const r = await runOpenItem(SPEC(dir), OPTS(dir, clients, { resume: first.board, seatOverrides: { implementer: seat("openai", "gpt-6-sol") } }));
      lane = agy();
      return r;
    });
    assert.equal(second.shipped, true, JSON.stringify(second.error));
    const revised = clients.sent.slice(before).find(s => /Output ONLY the complete new contents/.test(s.prompt));
    assert.match(revised.prompt, /the boundary case is wrong/, "the xai reviewer's findings reached the worker");
    run = JSON.parse(readFileSync(join(second.board, "run.json"), "utf8"));
    const scope = run.review_scopes.alpha;
    const critique = scope.contributions.find(c => c.purpose === "critique");
    assert.ok(critique, `the reviewer's critique is a contribution of the slot: ${JSON.stringify(scope.contributions)}`);
    assert.equal(critique.lab, "xai");
    assert.equal(critique.via, "the reviewer's findings were given to the worker as revision input");
    assert.ok(scope.author_labs.includes("xai"));
    // The revised bytes' in-run review was NOT by the lab whose findings shaped them.
    const reviews = clients.sent.slice(before).filter(s => /VERDICT/.test(s.prompt) && !/Output ONLY/.test(s.prompt));
    const laneReviews = lane.filter(a => a.agent === "pantheon-reviewer");
    assert.ok(reviews.length + laneReviews.length >= 1);
    assert.ok(reviews.every(s => s.vendor !== "xai"), `the revised bytes were reviewed by ${reviews.map(s => s.vendor)}`);
    assert.ok(run.turns.filter(t => t.purpose === "critique").slice(-1).every(t => t.vendor !== "xai"), "the last review was not by xai");
    // The contribution survives the resume in run.json, and the cycle's change scope excludes the lab too.
    assert.ok(run.files[0].contributors.some(c => c.purpose === "critique" && c.vendor === "xai"));
    const change = changeScope(run);
    assert.ok(change.author_labs.includes("xai"), `change scope author labs: ${change.author_labs}`);
    const chosen = cycleReviewers({ scope: change });
    assert.ok(chosen.pending || chosen.seats.every(s => s.lab !== "xai"), "no cycle reviewer from the contributing lab");
    assert.ok(chosen.author_labs.includes("xai"));
  } finally {
    if (savedLedger === undefined) delete process.env.OPHANIM_LEDGER; else process.env.OPHANIM_LEDGER = savedLedger;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewScope: a critique counts only when its text reached a revision prompt", () => {
  const turns = [{ purpose: "work", vendor: "openai", model: "gpt-6-sol" },
    { purpose: "critique", vendor: "xai", model: "grok-4.6", revision_input: true },
    { purpose: "critique", vendor: "anthropic", model: "claude-sonnet-5" }];
  for (const kind of ["artifact", "change"]) {
    const s = reviewScope({ kind, turns });
    assert.deepEqual(s.contributions.map(c => [c.purpose, c.lab]), [["work", "openai"], ["critique", "xai"]]);
    assert.deepEqual(s.excluded.map(c => [c.purpose, c.lab]), [["critique", "anthropic"]]);
    assert.match(s.excluded[0].why, /reached no revision/);
    assert.deepEqual(s.author_labs, ["openai", "xai"]);
  }
});
