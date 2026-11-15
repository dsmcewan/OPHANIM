import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBoard } from "../src/board/index.mjs";
import { boardState } from "../src/board/controller.mjs";
import { ship, GATES } from "../src/board/integrate.mjs";

// This is the offline demo: canned seat entries, including acceptance evidence, exercise the
// native controller. It neither calls providers nor runs the suite named by its canned repro.
// The worker used to publish its offer without the lease it still held, so the real ref fence
// refused the CLI before any review or ship could happen.
test("offline board-run carries its item lease through the offer and native ship gates", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-board-run-lease-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../scripts/board-run.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script, "--dir", dir], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

  const board = openBoard(dir), ref = "refs/board/fenced-lease";
  const state = boardState({ ...board, ref });
  assert.equal(state.bySlot["item:withSeatLock"].payload.state, "done");
  const artifact = state.bySlot["artifact:src/seat/lock.mjs"];
  assert.equal(artifact.kind, "artifact");
  const bytes = board.store.get(artifact.links.bytes); // CAS verifies the content hash on read.
  assert.equal(Buffer.isBuffer(bytes), true);
  assert.ok(bytes.length > 0);

  const lease = board.runtime.leaseFor("item:withSeatLock");
  assert.equal(lease.state, "released");
  const offer = board.refs.reflog().find(entry => entry.msg === "offer it");
  assert.ok(offer, "the worker offer must actually land");
  assert.equal(offer.lease_gen, lease.gen);
  assert.equal(board.store.get(offer.to).lease_gen, lease.gen);

  // Re-evaluate every native gate against the persisted pre-ship board and offered commit.
  // Merely printing success or marking an item done cannot satisfy this assertion.
  const close = board.store.get(state.commit);
  const shipped = board.store.get(close.parents[0]);
  assert.equal(shipped.author.vendor, "controller");
  const sourceRef = "refs/seat/regression-source/wip";
  const refs = { ...board.refs, resolve(name) {
    if (name === ref) return shipped.parents[0];
    if (name === sourceRef) return shipped.parents[1];
    return board.refs.resolve(name);
  } };
  const checked = await ship({ ...board, refs, ref, from: sourceRef,
    actor: { vendor: "controller" }, dryRun: true });
  assert.equal(checked.ok, true, checked.why);
  assert.deepEqual(checked.gates.map(gate => [gate.gate, gate.ok]), GATES.map(gate => [gate, true]));
  assert.deepEqual(checked.would_ship, ["artifact:src/seat/lock.mjs"]);
});
