// Stage 4: the controller's A2A leaf shim. Token, role allow-list, bounds, one stateless turn, structured JSON back,
// nothing but message/send, and no file/process capability in the module at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startA2AShim, A2A_ERRORS } from "../src/pipeline/a2a-shim.mjs";
import { a2aSocketFor, SOCKET_PATH_MAX } from "../src/pipeline/index.mjs";
import { ask, raw, GROK } from "./fixtures/pipeline-stages.mjs";

const sockDir = t => { const d = mkdtempSync(join(tmpdir(), "pa2a-test-")); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const start = async (t, over = {}) => {
  const turns = [], records = [];
  const shim = await startA2AShim({ unit_id: "u1", allowed_subagents: ["api-historian", "sql-reviewer"], seatFor: () => ({ ...GROK }), socket: join(sockDir(t), "a2a.sock"),
    subagentTurn: async args => { turns.push(args); return { text: `answer ${turns.length}`, served_model: "grok-4.5" }; }, onCall: r => records.push(r), ...over });
  t.after(() => shim.close());
  return { shim, turns, records };
};

test("an allowed role gets ONE stateless single turn and structured JSON back; the call is recorded", async t => {
  const { shim, turns, records } = await start(t);
  assert.equal(shim.url, null); assert.match(shim.socket, /\/a2a\.sock$/); assert.equal(existsSync(shim.socket), true);
  const first = await ask(shim, { role: "api-historian", unit_id: "u1", text: "what changed in v2? SECRET-ONE" });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.result.parts, [{ kind: "data", data: { role: "api-historian", answer: "answer 1", model: "grok-4.5", served_model: "grok-4.5" } }]);
  assert.equal(first.body.result.kind, "message"); assert.equal(first.body.result.role, "agent");
  const second = await ask(shim, { role: "sql-reviewer", unit_id: "u1", text: "and this query?" });
  assert.equal(second.body.result.parts[0].data.answer, "answer 2");
  // Stateless: the second turn carries nothing of the first; each turn is one prompt, with no history, tools or cwd.
  assert.equal(turns.length, 2);
  assert.doesNotMatch(turns[1].prompt, /SECRET-ONE|answer 1/);
  assert.match(turns[1].prompt, /^ROLE: sql-reviewer — a consulted specialist subagent/); assert.match(turns[1].prompt, /and this query\?$/);
  for (const k of ["cwd", "history", "messages", "tools", "worktree"]) assert.equal(k in turns[1], false, `the subagent turn was given ${k}`);
  assert.deepEqual([turns[0].vendor, turns[0].model], ["xai", "grok-4.5"]);
  assert.deepEqual(records.map(r => [r.n, r.role, r.status, r.model, r.served_model, r.request_bytes, r.answer_bytes]), [[1, "api-historian", "answered", "grok-4.5", "grok-4.5", 30, 8], [2, "sql-reviewer", "answered", "grok-4.5", "grok-4.5", 15, 8]]);
  assert.match(records[0].request_digest, /^sha256:/); assert.match(records[0].answer_digest, /^sha256:/);
  assert.equal(JSON.stringify(records).includes("SECRET-ONE"), false);   // sizes and digests, not content
});

test("the per-unit bearer token is required: no token, a wrong token and another unit's token are 401", async t => {
  const { shim, turns } = await start(t), other = await start(t);
  for (const token of [null, "nope", other.shim.token, shim.token + "x"]) {
    const r = await ask(shim, { role: "api-historian", unit_id: "u1", token });
    assert.equal(r.status, 401); assert.equal(r.body.error.code, A2A_ERRORS.UNAUTHORIZED);
  }
  assert.equal(turns.length, 0);
  assert.notEqual(shim.token, other.shim.token); assert.match(shim.token, /^[0-9a-f]{48}$/);
});

test("only roles in the unit's allowed_subagents are served (403), and only for this unit", async t => {
  const { shim, turns, records } = await start(t);
  const role = await ask(shim, { role: "release-manager", unit_id: "u1" });
  assert.equal(role.status, 403); assert.match(role.body.error.message, /not in this unit's allowed_subagents/);
  const unit = await ask(shim, { role: "api-historian", unit_id: "u2" });
  assert.equal(unit.status, 403);
  assert.equal(turns.length, 0);
  assert.deepEqual(records.map(r => [r.status, r.code]), [["refused", "ROLE_NOT_ALLOWED"], ["refused", "WRONG_UNIT"]]);
  const none = await start(t, { allowed_subagents: [] });
  assert.equal((await ask(none.shim, { role: "api-historian", unit_id: "u1" })).status, 403);
});

test("calls and bytes are bounded per unit (429 when exhausted), also under concurrent callers", async t => {
  const { shim, turns } = await start(t, { limits: { max_calls: 2, max_bytes: 1000 } });
  const three = await Promise.all([1, 2, 3].map(() => ask(shim, { role: "api-historian", unit_id: "u1" })));
  assert.deepEqual(three.map(r => r.status).sort(), [200, 200, 429]);
  assert.equal(turns.length, 2);
  assert.equal(three.find(r => r.status === 429).body.error.code, A2A_ERRORS.EXHAUSTED);
  assert.deepEqual(shim.usage().calls, 2);
  const small = await start(t, { limits: { max_calls: 10, max_bytes: 40 } });
  assert.equal((await ask(small.shim, { role: "api-historian", unit_id: "u1", text: "x".repeat(30) })).status, 200);
  const over = await ask(small.shim, { role: "api-historian", unit_id: "u1", text: "y".repeat(30) });
  assert.equal(over.status, 429); assert.equal(small.turns.length, 1);
  assert.ok(small.shim.usage().bytes <= 40);
});

test("unknown and write-like methods are refused with a JSON-RPC error; malformed requests are refused; no turn runs", async t => {
  const { shim, turns } = await start(t);
  for (const method of ["tasks/send", "tasks/get", "tasks/cancel", "message/stream", "files/write", "fs.writeFile", "git/commit", "board/update", "tools/call", "shell/exec"]) {
    const r = await ask(shim, { role: "api-historian", unit_id: "u1", method });
    assert.equal(r.body.error.code, A2A_ERRORS.METHOD_NOT_FOUND, method); assert.equal(r.body.result, undefined);
  }
  const twoParts = await ask(shim, { params: { message: { role: "user", parts: [{ kind: "text", text: "a" }, { kind: "file", file: { uri: "file:///etc/passwd" } }], metadata: { subagent_role: "api-historian", unit_id: "u1" } } } });
  assert.equal(twoParts.status, 400); assert.equal(twoParts.body.error.code, A2A_ERRORS.INVALID_PARAMS);
  const noMeta = await ask(shim, { params: { message: { role: "user", parts: [{ kind: "text", text: "a" }] } } });
  assert.equal(noMeta.body.error.code, A2A_ERRORS.INVALID_PARAMS);
  const bad = await raw(shim, { method: "POST", headers: { authorization: `Bearer ${shim.token}` }, body: "{not json" });
  assert.equal(bad.body.error.code, A2A_ERRORS.PARSE);
  for (const [method, path] of [["PUT", "/"], ["DELETE", "/"], ["POST", "/worktree"], ["GET", "/"]]) assert.equal((await raw(shim, { method, path })).status, 404);
  assert.equal(turns.length, 0);
});

test("the agent card names the leaf, its bearer scheme and exactly the allowed roles", async t => {
  const { shim } = await start(t);
  const card = (await raw(shim, { method: "GET", path: "/.well-known/agent.json" })).body;
  assert.equal(card.url, "http://localhost/"); assert.equal(card.preferredTransport, "JSONRPC");
  assert.deepEqual(card.skills.map(s => s.id), ["api-historian", "sql-reviewer"]);
  assert.deepEqual(card.capabilities, { streaming: false, pushNotifications: false, stateTransitionHistory: false });
  assert.deepEqual(card.security, [{ bearer: [] }]);
  assert.equal(JSON.stringify(card).includes(shim.token), false);
});

test("a failing subagent turn is a recorded failure, not an answer; close() stops the endpoint", async t => {
  const { shim, records } = await start(t, { subagentTurn: async () => { throw new Error("upstream down"); } });
  const r = await ask(shim, { role: "api-historian", unit_id: "u1" });
  assert.equal(r.status, 502); assert.equal(r.body.error.code, A2A_ERRORS.INTERNAL); assert.doesNotMatch(JSON.stringify(r.body), /upstream down/);
  assert.deepEqual(records.map(x => [x.status, x.code]), [["failed", "TURN_FAILED"]]);
  await shim.close();
  await assert.rejects(ask(shim, { role: "api-historian", unit_id: "u1" }));
  assert.equal(existsSync(shim.socket), false, "the socket file outlived close()");
});

test("the shim listens only on the socket the controller names; without one (and without the test-only tcp flag) it refuses to start", async t => {
  await assert.rejects(startA2AShim({ unit_id: "u1", seatFor: () => ({ ...GROK }), subagentTurn: async () => ({ text: "x" }) }), /Unix socket path/);
  const tcp = await startA2AShim({ unit_id: "u1", allowed_subagents: ["r"], seatFor: () => ({ ...GROK }), subagentTurn: async () => ({ text: "x", served_model: "grok-4.5" }), tcp: true });
  t.after(() => tcp.close());
  assert.match(tcp.url, /^http:\/\/127\.0\.0\.1:\d+\/$/); assert.equal(tcp.socket, null);
  assert.equal((await ask(tcp, { role: "r", unit_id: "u1" })).status, 200);
});

test("the controller's socket path: <control_dir>/a2a.sock, or a short controller-owned fallback under tmpdir when that is too long", async t => {
  const d = sockDir(t);
  const short = await a2aSocketFor(join(d, "control", "u1"));
  assert.deepEqual([short.file, short.fallback], [join(d, "control", "u1", "a2a.sock"), false]);
  const deep = join(d, "control", "x".repeat(120));
  const long = await a2aSocketFor(deep);
  t.after(() => rmSync(long.dir, { recursive: true, force: true }));
  assert.equal(long.fallback, true); assert.equal(long.wanted, join(deep, "a2a.sock"));
  assert.ok(Buffer.byteLength(long.file) <= SOCKET_PATH_MAX); assert.ok(long.file.startsWith(tmpdir()));
  assert.equal(existsSync(long.dir), true);
  // A shim really listens there.
  const shim = await startA2AShim({ unit_id: "u1", allowed_subagents: ["r"], seatFor: () => ({ ...GROK }), subagentTurn: async () => ({ text: "x", served_model: "grok-4.5" }), socket: long.file });
  assert.equal((await ask(shim, { role: "r", unit_id: "u1" })).status, 200);
  await shim.close();
});

test("ZERO file, git or process capability: the shim module imports only http and crypto, and is never given a path", () => {
  const src = readFileSync(new URL("../src/pipeline/a2a-shim.mjs", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm)].map(m => m[1]).sort();
  assert.deepEqual(imports, ["node:crypto", "node:http"]);
  assert.doesNotMatch(src, /\bimport\s*\(|\brequire\s*\(|process\.binding|node:fs|node:child_process|node:worker_threads|\bspawn\b|\bexec\b|writeFile|\bcwd\b|\bworktree\b(?! path)/);
  // The orchestrator starts it without the worktree path.
  const index = readFileSync(new URL("../src/pipeline/index.mjs", import.meta.url), "utf8");
  const call = index.slice(index.indexOf("startA2AShim({"), index.indexOf("onCall:"));
  assert.doesNotMatch(call, /\bpath\b|worktree/);
});
