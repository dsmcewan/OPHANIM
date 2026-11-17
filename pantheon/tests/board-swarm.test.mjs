// Swarms on the board: each layer is a gated, law-checked, recorded transition of the same cycle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { publish, treeSlots } from "../src/board/dag.mjs";
import { merge } from "../src/board/merge.mjs";
import { boardState } from "../src/board/controller.mjs";
import { stageCheck } from "../src/board/stage-gate.mjs";
import { runSwarmLayer } from "../src/board/run-swarm.mjs";
import { verifyEscalation } from "../src/route/protocol.mjs";
import { withBoard, seeded, seat, HUMAN, CONTROLLER } from "./board-helper.mjs";

const QUESTION = "Why does the fenced lease keep timing out?";
const SEATING = {
  explorer: [
    { vendor: "anthropic", model: "claude-sonnet-5", basis: "QUOTA", why: "test" },
    { vendor: "openai", model: "gpt-6-sol", basis: "QUOTA", why: "test" },
  ],
  reviewer: [{ vendor: "xai", model: "grok-4.6", band: "medium", basis: "ISOLATION", why: "test" },
             { vendor: "anthropic", model: "claude-sonnet-5", band: "easy", basis: "ISOLATION", why: "test" }],
  judge: [{ vendor: "anthropic", model: "claude-sonnet-5", basis: "ISOLATION", why: "test" },
          { vendor: "agy_google", model: "gemini-4-carbon", basis: "ISOLATION", why: "test" }],
};
const answers = (cut = () => false) => {
  const calls = [];
  return { calls, turn: async ({ vendor, model, role, output }) => {
    calls.push({ vendor, model, role, output });
    return cut({ vendor, output }) ? { text: "partial", complete: false, terminal_state: "max_tokens" }
      : { text: `${vendor}/${model} as ${role}: the lease TTL is shorter than the slowest worker`, complete: true };
  } };
};

async function stuck(board) {
  const s = await seeded(board);
  const planner = seat("anthropic", "plan");
  const blocked = await publish({ ...board, ref: s.wip, author: planner, msg: "block it", entries: [{ kind: "work_item",
    payload: { key: s.itemKey, title: "implement the fenced lease", state: "blocked", artifact_slots: [`artifact:${s.slot}`], block: { reason: "timeouts" } } }] });
  assert.equal(blocked.ok, true, blocked.why);
  const m = await merge({ ...board, into: s.ref, from: s.wip, author: CONTROLLER, msg: "carry the block" });
  assert.equal(m.ok, true, m.why);
  return s;
}
async function split(board, ref) {
  const d = await publish({ ...board, ref, author: HUMAN, msg: "split", entries: [{ kind: "decision",
    payload: { key: "lease-ttl", question: QUESTION, options: [{ id: "longer-ttl" }, { id: "heartbeat" }], resolution: { type: "split", recorded: true } } }] });
  assert.equal(d.ok, true, d.why);
}

test("an executing board schedules no swarm step: nothing runs, nothing changes", () => withBoard(async board => {
  const { ref } = await seeded(board);
  const before = board.refs.resolve(ref);
  const r = await runSwarmLayer({ board, ref, question: QUESTION, turn: answers().turn, seating: SEATING });
  assert.equal(r.done, true);
  assert.equal(board.refs.resolve(ref), before);
}));

test("a stuck board runs explore forks in isolation, each on its own lab's ref with its model", () => withBoard(async board => {
  const { ref } = await stuck(board);
  const before = board.refs.resolve(ref);
  const r = await runSwarmLayer({ board, ref, question: QUESTION, turn: answers().turn, seating: SEATING });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.step, r.chair, r.round], ["explore", "scout@opt", 1]);
  for (const vendor of ["anthropic", "openai"]) {
    const slots = treeSlots(board.store, board.refs.resolve(`refs/iso/${vendor}/explore`));
    const e = board.store.get(slots[`hypothesis:explore-r1-${vendor}`]);
    assert.equal(e.visibility, "isolated");
    assert.equal(e.author.mode, "explore");
    assert.ok(e.author.model, "the fork names the model that answered");
  }
  assert.equal(board.refs.resolve(ref), before, "forks never touch the board ref");
}));

test("the scout chair dies at its turn cap, and a stuck board never opens the judge", () => withBoard(async board => {
  const { ref } = await stuck(board);
  for (let round = 1; round <= 3; round++) assert.equal((await runSwarmLayer({ board, ref, question: QUESTION, turn: answers().turn, seating: SEATING })).round, round);
  const fourth = await runSwarmLayer({ board, ref, question: QUESTION, turn: answers().turn, seating: SEATING });
  assert.deepEqual([fourth.ok, fourth.refused], [false, "law"]);
  assert.match(fourth.why, /cap of 3/);
  const synth = stageCheck({ ...board, ref, stage: "synthesize" });
  assert.equal(synth.ok, false);
  assert.match(synth.why, /timeboxed_swarm pattern through scout@opt, not arbiter@judge/);
}));

test("on a split, a judge from an uninvolved lab synthesizes onto the board, then the claim is refuted in isolation", () => withBoard(async board => {
  const { ref } = await stuck(board);
  await runSwarmLayer({ board, ref, question: QUESTION, turn: answers().turn, seating: SEATING });
  await split(board, ref);
  const synth = await runSwarmLayer({ board, ref, question: QUESTION, turn: answers().turn, seating: SEATING });
  assert.equal(synth.ok, true, synth.why);
  assert.equal(synth.step, "synthesize");
  assert.equal(synth.judge.vendor, "agy_google", "anthropic and openai made the forks, so neither may judge them");
  const claim = boardState({ ...board, ref }).hypotheses.find(h => h.key === "synth-r1-agy-google");
  assert.ok(claim, "the synthesis is carried to the board as an open claim");
  assert.equal(claim.status, "open");
  assert.equal(board.store.get(claim.cid).links.supports.length, 2);

  const refute = await runSwarmLayer({ board, ref, question: QUESTION, turn: answers().turn, seating: SEATING });
  assert.equal(refute.ok, true, refute.why);
  assert.equal(refute.step, "refute");
  const e = board.store.get(refute.published[0]);
  assert.equal(e.visibility, "isolated");
  assert.deepEqual(e.links.contradicts, [claim.cid]);
  assert.notEqual(e.author.vendor, "agy_google", "the refuter is not the lab that made the claim");
}));

test("a judge is refused when every candidate lab produced a fork; the human takes the seat", () => withBoard(async board => {
  const { ref } = await stuck(board);
  await runSwarmLayer({ board, ref, question: QUESTION, turn: answers().turn, seating: SEATING });
  await split(board, ref);
  const r = await runSwarmLayer({ board, ref, question: QUESTION, turn: answers().turn,
    seating: { ...SEATING, judge: [SEATING.explorer[0], SEATING.explorer[1]] } });
  assert.deepEqual([r.ok, r.refused], [false, "judge"]);
  assert.match(r.why, /human takes the seat/);
}));

test("a cut-off swarm turn is escalated by the protocol within the documented ceiling, and recorded", () => withBoard(async board => {
  const { ref } = await stuck(board);
  const a = answers(({ vendor, output }) => vendor === "anthropic" && output < 20000);
  const r = await runSwarmLayer({ board, ref, question: QUESTION, turn: a.turn, seating: SEATING });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(a.calls.filter(c => c.vendor === "anthropic").map(c => c.output), [16384, 32768]);
  assert.deepEqual(r.escalations.map(e => [e.tier, e.decision.action, e.decision.to.output]), [["medium", "raise_output", 32768]]);
  assert.equal(verifyEscalation(r.escalations).ok, true, "the tier is a note on the record, not part of it");
}));

test("a swarm runs at the ticket's difficulty tier, and an unknown difficulty is refused", () => withBoard(async board => {
  const { ref } = await stuck(board);
  const refused = await runSwarmLayer({ board, ref, question: QUESTION, turn: answers().turn, seating: SEATING, difficulty: "toString" });
  assert.deepEqual([refused.ok, refused.refused], [false, "difficulty"]);
  const a = answers(() => false);
  const r = await runSwarmLayer({ board, ref, question: QUESTION, turn: a.turn, seating: SEATING, difficulty: "easy" });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(a.calls.filter(c => c.vendor === "anthropic").map(c => c.output), [4096]);
}));

test("the contribution projection reports all five chairs, including the swarm's forks, refutations and syntheses", () => withBoard(async board => {
  const { chairContributions, verifyChairContributions } = await import("../src/board/contributions.mjs");
  const { ref } = await stuck(board);
  await runSwarmLayer({ board, ref, question: QUESTION, turn: answers().turn, seating: SEATING });
  await split(board, ref);
  await runSwarmLayer({ board, ref, question: QUESTION, turn: answers().turn, seating: SEATING });
  await runSwarmLayer({ board, ref, question: QUESTION, turn: answers().turn, seating: SEATING });
  const p = chairContributions(board);
  assert.deepEqual(p.chairs.map(c => c.chair), ["lead@orch", "impl@build", "check@review", "scout@opt", "arbiter@judge"]);
  const scout = p.chairs.find(c => c.chair === "scout@opt"), judge = p.chairs.find(c => c.chair === "arbiter@judge");
  assert.deepEqual([scout.metrics.forks, scout.metrics.refutations, judge.metrics.syntheses], [2, 1, 1]);
  assert.deepEqual(judge.occupants.map(o => `${o.vendor}/${o.model}`), ["agy_google/gemini-4-carbon"]);
  assert.equal(verifyChairContributions(p, board).ok, true);
  // OPHANIM ranks this five-chair projection on its own side: ophanim/efficiency/investigation/chairs-board.test.mjs.
}));
