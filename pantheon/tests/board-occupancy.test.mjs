// Q1 + Q2: the trail names which model produced each entry, and a reseat is a recorded transition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenItem } from "../src/board/run-item.mjs";
import { openBoard } from "../src/board/index.mjs";
import { validateEntry, BoardViolation, KINDS } from "../src/board/schema.mjs";
import { putCommit } from "../src/board/dag.mjs";
import { nextOccupancy, occupancyTrail } from "../src/board/occupancy.mjs";
import { openCooldownStore } from "../../packages/model-client/index.mjs";

const withTmp = async fn => {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-occupancy-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

// Every surface the run touches, scripted. `failModel` makes that model return a retryable 500 once
// the prompt is a revision, so routing falls through to the next candidate: a real reseat.
function scriptedClients({ failModel = null } = {}) {
  let n = 0;
  const answerFor = prompt => {
    if (/VERDICT/i.test(prompt)) return "looks right\n\nVERDICT: approve";
    if (/TITLE:/i.test(prompt)) return "TITLE: the fixture change";
    if (/RAN: nothing/i.test(prompt)) return "nothing known.\n\nRAN: nothing";
    return /FAILED the executed acceptance/.test(prompt) ? "export const fixed = true;\n" : "export const draft = true;\n";
  };
  const promptOf = req => typeof req.input === "string" ? req.input : req.input?.at(-1)?.content ?? req.messages?.at(-1)?.content
    ?? req.contents?.at(-1)?.parts?.map(p => p.text ?? "").join("") ?? "";
  const refuse = req => {
    if (req.model === failModel && /FAILED the executed acceptance/.test(promptOf(req))) throw Object.assign(new Error("overloaded"), { status: 500 });
  };
  const stream = items => ({ async *[Symbol.asyncIterator]() { for (const i of items) yield i; } });
  return vendor => ({
    responses: { inputTokens: { count: async () => ({ input_tokens: 1000 }) },
      create: async req => {
        refuse(req);
        const text = answerFor(promptOf(req)), id = `resp_${++n}`;
        const response = { id, status: "completed", output_text: text, output: [{ type: "message", content: [{ type: "output_text", text }] }] };
        return stream([{ type: "response.created", response: { id } }, { type: "response.output_text.delta", delta: text }, { type: "response.completed", response }]);
      } },
    messages: { create: async req => {
      refuse(req);
      const text = answerFor(promptOf(req));
      return stream([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }]);
    } },
    models: { countTokens: async () => ({ totalTokens: 1000 }),
      generateContentStream: async req => stream([{ candidates: [{ finishReason: "STOP", content: { parts: [{ text: answerFor(promptOf(req)) }] } }] }]) },
  });
}

const OVERRIDES = {
  planner: { vendor: "anthropic", model: "claude-fable-5-2", rank: 0, pool: "anthropic", band: null, basis: "OPERATOR", why: "scripted" },
  implementer: { vendor: "anthropic", model: "claude-opus-5-5", rank: 0, pool: "anthropic", band: null, basis: "OPERATOR", why: "scripted" },
  reviewer: { vendor: "xai", model: "grok-4.7", rank: 0, pool: "xai", band: null, basis: "OPERATOR", why: "scripted" },
};

async function run(dir, { failModel = null, acceptance = "true" } = {}) {
  mkdirSync(join(dir, "seed"), { recursive: true });
  writeFileSync(join(dir, "seed", "keep.txt"), "seed\n");
  return runOpenItem({
    key: "occupancyFixture", repo_root: dir, title: "one file", goal: "write alpha", copy: ["seed"],
    acceptance_cmd: acceptance, question: "q",
    slots: [{ slot: "alpha", path: "alpha.mjs", goal: "write alpha", model: "gpt-6-sol" }],
  }, { dir: join(dir, "board"), makeClientFor: scriptedClients({ failModel }), scouts: ["xai"], seatOverrides: OVERRIDES,
    // Injected refusals cool the pool down; a private store keeps that from reaching other tests.
    cooldown: openCooldownStore(join(dir, "cooldown")) });
}

// Every seat-authored entry reachable from any ref, by kind.
function seatEntries(root) {
  const board = openBoard(root), seen = new Set(), out = [];
  for (const ref of board.refs.list()) {
    for (const queue = [ref.cid]; queue.length;) {
      const cid = queue.pop();
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      const commit = board.store.get(cid);
      queue.push(...(commit.parents ?? []));
      for (const r of commit.records ?? []) {
        if (seen.has(r)) continue;
        seen.add(r);
        const e = board.store.get(r);
        if (e.author?.seat_id) out.push(e);
      }
    }
  }
  return out;
}

test("every seat-authored entry on the board names the model that produced it", () => withTmp(async dir => {
  const result = await run(dir);
  assert.equal(result.error, null, JSON.stringify(result.error));
  assert.equal(result.shipped, true);
  const entries = seatEntries(result.board);
  const byKind = kind => entries.filter(e => e.kind === kind).map(e => `${e.author.vendor}/${e.author.model}`);
  assert.deepEqual(byKind("artifact"), ["openai/gpt-6-sol"], "the slot's pinned model built it");
  assert.deepEqual(byKind("plan"), ["anthropic/claude-fable-5-2"]);
  assert.deepEqual(byKind("critique"), ["xai/grok-4.7"]);
  assert.equal(byKind("search").length, 1);
  assert.ok(entries.every(e => typeof e.author.model === "string" && e.author.occupancy_gen === 1));
}));

test("a reseat between revisions advances the chair's generation, and the trail re-derives it", () => withTmp(async dir => {
  // Rev 1 fails acceptance; on rev 2 the pinned openai model is overloaded and the chair falls
  // through to the anthropic override, which writes the fix.
  const result = await run(dir, { failModel: "gpt-6-sol", acceptance: "grep -q fixed alpha.mjs" });
  assert.equal(result.error, null, JSON.stringify(result.error));
  assert.equal(result.shipped, true);
  const artifacts = seatEntries(result.board).filter(e => e.kind === "artifact").sort((a, b) => a.payload.rev - b.payload.rev);
  assert.deepEqual(artifacts.map(e => [e.payload.rev, e.author.vendor, e.author.model, e.author.occupancy_gen]),
    [[1, "openai", "gpt-6-sol", 1], [2, "anthropic", "claude-opus-5-5", 2]]);
  const trail = occupancyTrail(artifacts.map(e => e.author));
  assert.equal(trail.generation, 2);
  assert.deepEqual(trail.reseats.map(r => [r.from, r.to]), [["openai/gpt-6-sol", "anthropic/claude-opus-5-5"]]);
}));

test("the occupancy rule: same occupant keeps the generation, a different vendor or model advances it", () => {
  const base = { seat_id: "s", mode: "work" };
  const first = nextOccupancy({ vendor: "openai", seat_id: "s", mode: "work", occupancy_gen: 1 }, { vendor: "openai", model: "gpt-6-sol" }, base);
  assert.equal(first.occupancy_gen, 1, "the first published occupant is generation 1");
  assert.equal(nextOccupancy(first, { vendor: "openai", model: "gpt-6-sol" }, base).occupancy_gen, 1);
  const sameVendor = nextOccupancy(first, { vendor: "openai", model: "gpt-6-luna" }, base);
  assert.equal(sameVendor.occupancy_gen, 2, "a model change inside one vendor is a reseat too");
  assert.equal(nextOccupancy(sameVendor, { vendor: "xai", model: "grok-4.7" }, base).occupancy_gen, 3);
  assert.throws(() => nextOccupancy(null, { vendor: "openai" }, base), /must name its vendor and model/);
});

test("the trail refuses a generation that does not follow from its occupants", () => {
  const a = { vendor: "openai", model: "gpt-6-sol" };
  assert.equal(occupancyTrail([{ ...a, occupancy_gen: 1 }, { ...a, occupancy_gen: 1 }]).reseats.length, 0);
  assert.throws(() => occupancyTrail([{ ...a, occupancy_gen: 1 }, { vendor: "xai", model: "grok-4.7", occupancy_gen: 1 }]), /expected 2/);
  assert.throws(() => occupancyTrail([{ ...a, occupancy_gen: 1 }, { ...a, occupancy_gen: 2 }]), /expected 1/);
  assert.throws(() => occupancyTrail([{ ...a, occupancy_gen: 2 }]), /expected 1/);
});

test("the schema accepts a model id on a seat author and refuses anything else there", () => {
  const at = author => ({ kind: "search", level: KINDS.search.level, visibility: "board", author,
    payload: { query: "q", urls: [] }, links: { excerpt: "blob:" + "a".repeat(64) } });
  const seat = { vendor: "xai", seat_id: "xai-scout", mode: "explore", occupancy_gen: 1 };
  assert.doesNotThrow(() => validateEntry(at({ ...seat, model: "grok-4.3" })));
  assert.doesNotThrow(() => validateEntry(at(seat)), "older entries without a model stay valid");
  assert.throws(() => validateEntry(at({ ...seat, model: "a model with spaces" })), BoardViolation);
  assert.throws(() => validateEntry(at({ ...seat, model: 42 })), BoardViolation);
  assert.throws(() => validateEntry(at({ ...seat, banner: "x" })), /not part of a seat's identity/);
});

test("a commit keeps the seat's model in its author", () => {
  const stored = [];
  const store = { put: (codec, value) => { stored.push(value); return "commit:x"; } };
  putCommit(store, { tree: "tree:" + "a".repeat(64), author: { vendor: "xai", seat_id: "s", mode: "explore", occupancy_gen: 1, model: "grok-4.3", extra: "dropped" } });
  assert.deepEqual(stored[0].author, { vendor: "xai", seat_id: "s", mode: "explore", occupancy_gen: 1, model: "grok-4.3" });
});
