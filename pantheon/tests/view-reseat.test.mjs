// A model switch from the live view is an explicit, recorded reseat: refused by default, applied only
// with the operator's consent, recorded on the seat (model_gen) and announced on the bus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createViewServer } from "../src/view/server.mjs";
import { reduceSeats } from "../src/view/bus.mjs";

// The view streams every turn, so the fake answers with a stream ending in a completed response.
async function* iter(items) { for (const item of items) yield item; }
const output = [{ type: "message", content: [{ type: "output_text", text: "a" }] }];
const client = { responses: { create: async () => iter([{ type: "response.output_text.delta", delta: "a" },
  { type: "response.completed", response: { id: "r1", status: "completed", output } }]) } };

async function withView(fn) {
  const home = mkdtempSync(join(tmpdir(), "view-reseat-"));
  const cwd = mkdtempSync(join(tmpdir(), "view-reseat-cwd-"));
  const srv = createViewServer({ makeClientFor: () => client, home, cwd });
  const { port } = await srv.listen(0);
  const post = body => fetch(`http://127.0.0.1:${port}/turn`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  try { await fn({ post, srv }); }
  finally {
    srv.server.closeAllConnections?.();
    await new Promise(r => srv.server.close(() => r()));
    rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
  }
}

test("switching a seat's model needs consent, and the consent is recorded", async () => {
  await withView(async ({ post }) => {
    const first = await post({ vendor: "openai", model: "gpt-6-sol", prompt: "one" });
    assert.deepEqual([first.body.results[0].ok, first.body.results[0].model_gen], [true, 1]);
    const refused = await post({ vendor: "openai", model: "gpt-6-luna", prompt: "two" });
    assert.equal(refused.body.results[0].ok, false);
    assert.equal(refused.body.results[0].code, "MODEL_CHANGED", "the view reports why, so the page can ask");
    const reseated = await post({ vendor: "openai", model: "gpt-6-luna", prompt: "two", reseat: true });
    assert.deepEqual([reseated.body.results[0].ok, reseated.body.results[0].model_gen], [true, 2]);
    const same = await post({ vendor: "openai", model: "gpt-6-luna", prompt: "three" });
    assert.deepEqual([same.body.results[0].ok, same.body.results[0].model_gen], [true, 2], "the new holder continues without another reseat");
  });
});

test("consent is per seat in a fan-out, and only booleans are accepted", async () => {
  await withView(async ({ post }) => {
    assert.equal((await post({ vendor: "openai", prompt: "x", reseat: "yes" })).status, 400);
    assert.equal((await post({ seats: ["openai"], prompt: "x", reseats: { openai: 1 } })).status, 400);
    await post({ seats: ["openai"], models: { openai: "gpt-6-sol" }, prompt: "one" });
    const r = await post({ seats: ["openai"], models: { openai: "gpt-6-luna" }, prompt: "two", reseats: { openai: true } });
    assert.deepEqual([r.body.results[0].ok, r.body.results[0].model_gen], [true, 2]);
  });
});

test("an accepted reseat is announced on the bus and shown in the seat state", async () => {
  await withView(async ({ post, srv }) => {
    await post({ vendor: "openai", model: "gpt-6-sol", prompt: "one" });
    await post({ vendor: "openai", model: "gpt-6-luna", prompt: "two" });
    assert.ok(srv.bus.snapshot().some(e => e.type === "error" && e.code === "MODEL_CHANGED"), "the refusal carries its code");
    await post({ vendor: "openai", model: "gpt-6-luna", prompt: "two", reseat: true });
    const events = srv.bus.snapshot();
    assert.ok(events.some(e => e.type === "reseat" && e.model === "gpt-6-luna" && e.model_gen === 2));
    const seat = Object.values(reduceSeats(events)).find(s => s.model_gen);
    assert.deepEqual([seat.model, seat.model_gen], ["gpt-6-luna", 2]);
  });
});
