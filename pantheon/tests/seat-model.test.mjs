// A seat's conversation records the model that holds it; another model continues it only as a recorded reseat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sdkTurn } from "../src/sdk/seat-sdk.mjs";
import { loadSeat, saveSeat } from "../src/seat/store.mjs";

const withHome = async fn => {
  const home = mkdtempSync(join(tmpdir(), "pantheon-seat-model-"));
  try { return await fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
};
const client = () => {
  let n = 0;
  return { seen: [], responses: { create: async function (req) { this.seen?.push(req.model);
    const id = `r${++n}`; return { id, status: "completed", output_text: "ok", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }; } } };
};
const SEAT = { vendor: "openai", purpose: "p", cwd: "/repo/a" };

test("the first turn records the model, and the same model continues without a reseat", () => withHome(async home => {
  const c = client();
  const a = await sdkTurn({ ...SEAT, model: "gpt-6-sol", prompt: "one", client: c, home });
  assert.equal(a.ok, true);
  assert.deepEqual([loadSeat(SEAT, { home }).model, loadSeat(SEAT, { home }).model_gen], ["gpt-6-sol", 1]);
  const b = await sdkTurn({ ...SEAT, model: "gpt-6-sol", prompt: "two", client: c, home });
  assert.equal(b.ok, true);
  assert.equal(b.model_reseated, false);
  assert.equal(loadSeat(SEAT, { home }).model_gen, 1);
}));

test("a different model is refused unless the reseat is explicit, and then it is recorded", () => withHome(async home => {
  const c = client();
  await sdkTurn({ ...SEAT, model: "gpt-6-sol", prompt: "one", client: c, home });
  const before = loadSeat(SEAT, { home });
  const refused = await sdkTurn({ ...SEAT, model: "gpt-6-luna", prompt: "two", client: c, home });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "MODEL_CHANGED");
  assert.equal(refused.persisted, false);
  assert.deepEqual(loadSeat(SEAT, { home }), before, "a refusal leaves the record untouched");
  const reseated = await sdkTurn({ ...SEAT, model: "gpt-6-luna", prompt: "two", client: c, home, reseatModel: true });
  assert.equal(reseated.ok, true);
  assert.equal(reseated.model_reseated, true);
  assert.deepEqual([loadSeat(SEAT, { home }).model, loadSeat(SEAT, { home }).model_gen], ["gpt-6-luna", 2]);
}));

test("an omitted model resolves to the adapter default, so a default-model seat is still guarded", () => withHome(async home => {
  const c = client();
  await sdkTurn({ ...SEAT, prompt: "one", client: c, home });
  assert.equal(loadSeat(SEAT, { home }).model, "gpt-6-luna", "openai's adapter default");
  assert.equal((await sdkTurn({ ...SEAT, model: "gpt-6-sol", prompt: "two", client: c, home })).code, "MODEL_CHANGED");
}));

test("a legacy seat without a model adopts it on its next turn; saveSeat refuses a malformed model", () => withHome(async home => {
  const c = client();
  await sdkTurn({ ...SEAT, model: "gpt-6-sol", prompt: "one", client: c, home });
  const legacy = loadSeat(SEAT, { home });
  delete legacy.model; delete legacy.model_gen;
  const { writeFileSync, readdirSync } = await import("node:fs");
  writeFileSync(join(home, "seats", readdirSync(join(home, "seats"))[0]), JSON.stringify(legacy));
  const r = await sdkTurn({ ...SEAT, model: "gpt-6-luna", prompt: "two", client: c, home });
  assert.equal(r.ok, true);
  assert.equal(r.model_reseated, false, "adoption is not a reseat: there was nothing recorded to change");
  assert.deepEqual([loadSeat(SEAT, { home }).model, loadSeat(SEAT, { home }).model_gen], ["gpt-6-luna", 1]);
  assert.throws(() => saveSeat(SEAT, { model: "not a model id" }, { home }), /model must be a model id/);
  assert.throws(() => saveSeat(SEAT, { model_gen: 0 }, { home }), /model_gen/);
}));
