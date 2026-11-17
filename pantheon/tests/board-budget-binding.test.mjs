// Q6: spend that decides scheduling counts only commits the board actually holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { schedule } from "../src/board/controller.mjs";
import { withBoard, seeded } from "./board-helper.mjs";

test("a forged spend row is reported, never counted, and cannot exhaust the budget", () => withBoard(async board => {
  const { ref } = await seeded(board);
  const honest = board.runtime.budget();
  assert.equal(honest.binding, "store");
  assert.equal(honest.unbound_rows, 0);
  assert.ok(honest.spent_turns >= 1, "real publishes are counted");
  board.runtime.setBudget({ max_turns: honest.spent_turns + 1 });
  for (const commit of ["commit:" + "0".repeat(64), "not-a-commit", undefined])
    board.runtime.recordSpend({ commit: commit ?? "commit:" + "f".repeat(64), seat: "x", vendor: "openai", turns: 5 });
  const b = board.runtime.budget();
  assert.equal(b.unbound_rows, 3);
  assert.equal(b.spent_turns, honest.spent_turns, "forged rows add nothing");
  assert.equal(b.exhausted, false, "a side log alone cannot stop the board");
  assert.ok(schedule({ ...board, ref }).ready.some(r => r.ks === "work"));
}));

test("real spend still exhausts the budget and blocks spending triggers", () => withBoard(async board => {
  const { ref } = await seeded(board);
  board.runtime.setBudget({ max_turns: 1 });
  const b = board.runtime.budget();
  assert.equal(b.exhausted, true);
  assert.equal(b.unbound_rows, 0);
  assert.equal(schedule({ ...board, ref }).ready.length, 0);
}));
