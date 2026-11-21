import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAgyDb } from "../src/context/project.mjs";

// THE DEFECT, knowledge-graph inventory section (i). projectAgyDb computed the DatabaseSync class and
// then ran `new sqlite(path, ...)` -- the lazy LOADER -- as a constructor. That expression evaluates to
// the class itself, not an open connection, so `db.prepare` was undefined and every call threw a
// TypeError. bin/pantheon turns any error there into UNREADABLE, so an agy seat could never project its
// SQLite store. The lazy-load test only checked that the error did not say "not available", which a
// TypeError satisfies; these tests open a real database.
//
// node:sqlite exists from Node 22.5; on an older Node these skip rather than fail to load.
let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* Node < 22.5 */ }
const skip = DatabaseSync ? false : "node:sqlite needs Node >= 22.5";

// A conversation store with the agy shape, rows inserted OUT of idx order so the projection has to
// sort. idx is deliberately not INTEGER PRIMARY KEY: that would alias rowid and a bare scan would come
// back sorted anyway, hiding a lost ORDER BY. Payloads are opaque bytes (one is not valid UTF-8, one
// is NULL).
function withAgyDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "agy-db-"));
  const path = join(dir, "conversation.db");
  const w = new DatabaseSync(path);
  w.exec("CREATE TABLE steps (idx INTEGER NOT NULL, step_type INTEGER, status INTEGER, step_payload BLOB)");
  const ins = w.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)");
  ins.run(2, 3, 0, Buffer.from([0x00, 0xff, 0x10]));
  ins.run(0, 1, 0, Buffer.from("alpha"));
  ins.run(1, 2, 0, null);
  w.close();
  try { return fn(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Digests computed outside this code: printf 'agy-step:<type>:<payload bytes>' | sha256sum
const EXPECTED = [
  { role: "step:1", sha: "7b825306bbe55e3bd251d64fbc875caf2a6769837cc7797809e8c4797082c579", len: 5, tools: [] },
  { role: "step:2", sha: "508c2311f97d05e085fe33a29f8210e85ede7b72e20b80feefa059e2048f2cef", len: 0, tools: [] },
  { role: "step:3", sha: "67763f41c74b1fe625c3ee6f343090b3e185c4b5e1eb7e72689088abbe2aad9f", len: 3, tools: [] },
];

test("an agy SQLite store projects one entry per step, in idx order, with stable digests", { skip }, () => {
  withAgyDb(path => {
    assert.deepEqual(projectAgyDb(path), EXPECTED);
  });
});

test("an injected sqlite driver is the one used, and the store is opened read-only", { skip }, () => {
  withAgyDb(path => {
    const opened = [];
    class Spy extends DatabaseSync {
      constructor(...args) { super(...args); opened.push(args); }
    }
    assert.deepEqual(projectAgyDb(path, { sqlite: Spy }), EXPECTED);
    assert.deepEqual(opened, [[path, { readOnly: true }]]);
  });
});
