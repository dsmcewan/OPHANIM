// A merge makes no provider request, so its spend row states a known $0 and no publication -- an
// unstated USD there made every real board's cost total read as unknown (audit M5 follow-up).
import { test } from "node:test";
import assert from "node:assert/strict";
import { publish } from "../src/board/dag.mjs";
import { merge } from "../src/board/merge.mjs";
import { withBoard, seeded, seat, CONTROLLER } from "./board-helper.mjs";

const REF = "refs/board/lock-helper";

test("a merge's spend row is a known $0 with no publication and no provider call", () => withBoard(async (board) => {
  await seeded(board);
  const rows = [];
  const runtime = { ...board.runtime, recordSpend: row => rows.push(row) };
  const iso = "refs/iso/xai/claim";
  await board.refs.branch({ name: iso, from: REF, author: seat("xai", "explore", "xai-1") });
  await publish({ ...board, ref: iso, author: seat("xai", "explore", "xai-1"), msg: "claim",
    entries: [{ kind: "hypothesis", payload: { key: "coarse", claim: "c", status: "open" }, visibility: "isolated" }] });
  rows.length = 0;
  const m = await merge({ ...board, runtime, into: REF, from: iso, author: CONTROLLER });
  assert.equal(m.ok, true, m.why);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].publications, rows[0].usd, rows[0].provider_calls], [0, 0, 0]);
  assert.match(rows[0].usd_basis, /no provider request/);
}));
