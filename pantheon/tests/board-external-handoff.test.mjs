// External worker handoff (#121): a builder outside the board says "done at <sha>"; the controller admits
// it only on what it observed -- git, the board, every lease generation, and a controller-owned receipt --
// and the native scheduler then unlocks the verifier exactly once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { publish, boardState, schedule, putBlob, putEntry, KINDS } from "../src/board/index.mjs";
import { withBoard, seeded, CONTROLLER } from "./board-helper.mjs";
import { admitHandoff, observeContainment, probeOutcome, verifyDelivery, RECEIPT_KIND } from "../../scripts/blackboard/worker-handoff.mjs";
import { launchWorker, LAUNCH_KIND } from "../../scripts/blackboard/worker-launch.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { designated } from "../../scripts/test-gates/real-bwrap.mjs";

const KEY = "runtime-external-worker-adapter";
const SCOPE = ["pantheon/src/board/dag.mjs", "pantheon/src/board/refs.mjs",
  "pantheon/tests/board-external-handoff.test.mjs", "scripts/blackboard/worker-handoff.mjs"];
const OUTSIDE = "pantheon/src/board/schema.mjs";
const HOLDER = { vendor: "controller", seat_id: "fixture-external-bridge" };
const OTHER = { vendor: "controller", seat_id: "someone-else" };
const sha = s => createHash("sha256").update(s).digest("hex");

/** A git repository with a base and the candidates each case needs. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "handoff-git-"));
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid",
    "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", env: { PATH: process.env.PATH } }).trim();
  const put = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
  const commit = m => { g("add", "-A"); g("commit", "-q", "-m", m); return g("rev-parse", "HEAD"); };
  g("init", "-q", "-b", "main");
  for (const p of [...SCOPE, OUTSIDE]) put(p, `// ${p}\n`);
  const base = commit("base");
  put(SCOPE[0], "// changed\n"); put(SCOPE[3], "// adapter\n");
  const good = commit("good candidate");
  put(SCOPE[1], "// more\n");
  const grandchild = commit("second commit on top: an ancestor-only candidate");
  g("checkout", "-q", base);
  put(OUTSIDE, "// off scope\n"); put(SCOPE[0], "// changed\n");
  const offScope = commit("touches a path outside the scope");
  g("checkout", "-q", "--orphan", "other"); g("rm", "-rqf", ".");
  put("x", "x\n"); const root = commit("unrelated root");
  put(SCOPE[0], "// changed\n"); const wrongParent = commit("one commit, wrong parent");
  g("checkout", "-q", "-f", good);
  return { dir, base, good, grandchild, offScope, wrongParent, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A controller-recorded probe set: for each disposable fixture, the exit, the bytes' digests before and
 *  after, and the in-box operation's own machine-readable result. */
const POSITIVE = { fixture: "positive", path: "positive.txt", exit: 0, before: sha("a"), after: sha("a+probe"), inbox: { ran: true, result: "written" } };
const DENIAL = { fixture: "denial", path: "denial.txt", exit: 0, before: sha("b"), after: sha("b"), inbox: { ran: true, result: "denied", errno: "EROFS" } };
const recordedProbes = () => ([{ ...POSITIVE, inbox: { ...POSITIVE.inbox } }, { ...DENIAL, inbox: { ...DENIAL.inbox } }]);

/** The controller's harmless offline worker: it tries to read a sentinel outside its workspace and to write a file
 *  outside its scope, records what happened in a scoped file, and edits one more scoped file. */
const WORKER = sentinel => ["/bin/sh", "-c",
  `if cat ${sentinel} >/dev/null 2>&1; then r=read; else r=sealed; fi; if echo x >> ${OUTSIDE} 2>/dev/null; then o=wrote; else o=refused; fi; ` +
  `printf "%s %s\\n" "$r" "$o" > ${SCOPE[0]}; printf "// adapter\\n" > ${SCOPE[3]}`];

async function scenario(fn) {
  const repo = makeRepo();
  const rroot = mkdtempSync(join(tmpdir(), "handoff-receipts-"));
  const launchRoot = mkdtempSync(join(tmpdir(), "handoff-launch-"));
  const sentinel = join(launchRoot, "SENTINEL");
  writeFileSync(sentinel, "outside the worker's read scope\n");
  try {
    await withBoard(async (board, boardRoot) => {
      await seeded(board);
      const ctx = { ...board, ref: "refs/board/lock-helper" };
      const b = await publish({ ...ctx, author: CONTROLLER, msg: "external ticket", entries: [
        { kind: "work_item", payload: { key: KEY, title: "external worker adapter", state: "active", artifact_slots: [], base_sha: repo.base, write_scope: [...SCOPE] } },
        { kind: "work_item", payload: { key: `${KEY}-verify`, title: "verify it", state: "ready", depends_on: [KEY], artifact_slots: [], write_scope: [] } },
      ] });
      assert.equal(b.ok, true, b.why);
      const grant = async r => (await board.runtime.acquire({ resource: r, holder: HOLDER, ttlMs: 600_000 })).lease.gen;
      const leases = { item: { resource: `item:${KEY}`, gen: await grant(`item:${KEY}`) }, scopes: [] };
      for (const p of SCOPE) leases.scopes.push({ resource: `scope:${p}`, gen: await grant(`scope:${p}`) });
      const gens = () => Object.fromEntries([leases.item, ...leases.scopes].map(l => [l.resource, l.gen]));
      // A real launch of the controller's worker, under the current leases: its candidate is the one delivered.
      const launch = (over = {}) => launchWorker({ repo: repo.dir, ticket: { key: KEY, base: repo.base, scope: [...SCOPE] }, leases: structuredClone(leases),
        worker: WORKER(sentinel), root: launchRoot, receiptRoot: rroot, timeoutMs: 20_000, ...over });
      const launched = await launch();
      assert.equal(launched.receipt.outcome.phase, "worker_exited", JSON.stringify(launched.receipt.outcome));
      repo.good = launched.candidate;
      const receiptOf = (over = {}) => ({ ...structuredClone(launched.receipt), ...over });
      let n = 0;
      const writeReceipt = (obj, bytes = JSON.stringify(obj)) => {
        const name = `r${n++}.json`; writeFileSync(join(rroot, name), bytes);
        return { root: rroot, name, sha256: sha(bytes) };
      };
      const verifyReady = () => schedule(ctx).ready.filter(x => x.item === `${KEY}-verify`).length;
      const item = () => boardState(ctx).items.find(i => i.key === KEY);
      const admit = (over = {}) => admitHandoff({ board, ref: ctx.ref, repo: repo.dir,
        ticket: { key: KEY, base: repo.base, scope: [...SCOPE] }, holder: HOLDER, leases,
        receipt: { root: rroot, name: launched.name, sha256: launched.sha256 }, request: { ticket: KEY, candidate: repo.good }, ...over });
      await fn({ board, boardRoot, ctx, repo, leases, gens, receiptOf, writeReceipt, verifyReady, item, admit, rroot, launch, launched, sentinel });
    });
  } finally { repo.cleanup(); rmSync(rroot, { recursive: true, force: true }); rmSync(launchRoot, { recursive: true, force: true }); }
}

/** A refusal moves nothing: same head, item still active, verifier still not ready. */
async function refuses(s, res, code) {
  assert.equal(res.ok, false, `expected ${code}, got ok`);
  assert.equal(res.code, code, res.why);
  assert.equal(s.item().state, "active");
  assert.equal(s.verifyReady(), 0);
}

test("valid delivery: done at the exact candidate, the verifier becomes ready exactly once; a replay publishes nothing", async () => {
  await scenario(async s => {
    assert.equal(s.verifyReady(), 0);
    const res = await s.admit();
    assert.equal(res.ok, true, res.why);
    assert.deepEqual(res.changed, [SCOPE[0], SCOPE[3]]);
    assert.equal(s.item().state, "done");
    assert.equal(s.item().candidate_commit, s.repo.good);
    assert.equal(s.board.refs.resolve(s.ctx.ref), res.commit);
    assert.equal(s.verifyReady(), 1);
    const again = await s.admit();
    assert.equal(again.code, "REPLAY", again.why);
    assert.equal(s.board.refs.resolve(s.ctx.ref), res.commit);
    assert.equal(s.verifyReady(), 1);
  });
});

test("conflict: a second, different candidate for a delivered item is refused and the head does not move", async () => {
  await scenario(async s => {
    assert.equal((await s.admit()).ok, true);
    const head = s.board.refs.resolve(s.ctx.ref);
    const res = await s.admit({ request: { ticket: KEY, candidate: s.repo.grandchild } });
    assert.equal(res.code, "CONFLICT", res.why);
    assert.equal(s.board.refs.resolve(s.ctx.ref), head);
    assert.equal(s.item().candidate_commit, s.repo.good);
  });
});

test("git: a nonexistent sha, a wrong parent and an ancestor-only candidate are refused", async () => {
  await scenario(async s => {
    const head = s.board.refs.resolve(s.ctx.ref);
    await refuses(s, await s.admit({ request: { ticket: KEY, candidate: "0".repeat(40) } }), "NO_COMMIT");
    await refuses(s, await s.admit({ request: { ticket: KEY, candidate: "HEAD" } }), "SHA_SHAPE");
    await refuses(s, await s.admit({ request: { ticket: KEY, candidate: s.repo.wrongParent } }), "WRONG_PARENT");
    await refuses(s, await s.admit({ request: { ticket: KEY, candidate: s.repo.grandchild } }), "WRONG_PARENT");
    assert.equal(s.board.refs.resolve(s.ctx.ref), head);
  });
});

test("scope: a candidate that changes a path outside the scope is refused, whatever the receipt says", async () => {
  await scenario(async s => {
    const r = s.writeReceipt(s.receiptOf({ candidate: s.repo.offScope, changed_paths: [OUTSIDE, SCOPE[0]] }));
    await refuses(s, await s.admit({ request: { ticket: KEY, candidate: s.repo.offScope }, receipt: r }), "OUT_OF_SCOPE");
  });
});

test("leases: a stale scope generation, a missing scope lease and a wrong ticket are refused", async () => {
  await scenario(async s => {
    const stale = { ...s.leases, scopes: s.leases.scopes.map((l, i) => i === 1 ? { ...l, gen: l.gen + 1 } : l) };
    await refuses(s, await s.admit({ leases: stale }), "FENCED");
    await refuses(s, await s.admit({ leases: { ...s.leases, scopes: s.leases.scopes.slice(1) } }), "LEASE_MISSING");
    await refuses(s, await s.admit({ request: { ticket: "another-ticket", candidate: s.repo.good } }), "WRONG_TICKET");
  });
});

test("atomicity: a scope lease fenced after validation and before the swap refuses the landing inside the lock", async () => {
  await scenario(async s => {
    const head = s.board.refs.resolve(s.ctx.ref);
    const res = await s.admit({ onValidated: async () => {
      const f = await s.board.runtime.fence({ resource: `scope:${SCOPE[2]}`, holder: OTHER, reason: "test: fence in the gap" });
      assert.equal(f.ok, true);
    } });
    await refuses(s, res, "FENCED");
    assert.equal(res.resource, `scope:${SCOPE[2]}`);
    assert.equal(s.board.refs.resolve(s.ctx.ref), head);
  });
});

test("native publish: an additional lease at a stale generation refuses the swap; absent, behaviour is unchanged", async () => {
  await scenario(async s => {
    const it = s.item();
    const { cid, slot, links, ...payload } = it;
    const stale = s.leases.scopes.map((l, i) => i === 0 ? { ...l, gen: l.gen + 7 } : l);
    const r = await publish({ ...s.ctx, author: HOLDER, lease: s.leases.item, leases: stale, expect: boardState(s.ctx).commit,
      entries: [{ kind: "work_item", payload: { ...payload, state: "done", candidate_commit: s.repo.good } }] });
    assert.equal(r.ok, false); assert.equal(r.code, "FENCED"); assert.equal(r.resource, `scope:${SCOPE[0]}`);
    const bad = await publish({ ...s.ctx, author: HOLDER, lease: s.leases.item, leases: [{ resource: "scope:x" }], expect: boardState(s.ctx).commit,
      entries: [{ kind: "work_item", payload: { ...payload, state: "done", candidate_commit: s.repo.good } }] });
    assert.equal(bad.code, "LEASES_SHAPE");
    assert.equal(s.item().state, "active");
    // The generic path still takes a false candidate under a real item lease: the adapter, not publish,
    // is where an external delivery is checked. This is the premise #121 starts from.
    const generic = await publish({ ...s.ctx, author: HOLDER, lease: s.leases.item, expect: boardState(s.ctx).commit,
      entries: [{ kind: "work_item", payload: { ...payload, state: "done", candidate_commit: "f".repeat(40) } }] });
    assert.equal(generic.ok, true, generic.why);
  });
});

test("receipt: altered bytes, different facts, an escaping path and environment values are refused", async () => {
  await scenario(async s => {
    const good = JSON.stringify(s.receiptOf());
    const altered = s.writeReceipt(null, good.replace(`"v":1`, `"v":1 `));
    await refuses(s, await s.admit({ receipt: { ...altered, sha256: sha(good) } }), "RECEIPT_DIGEST");
    await refuses(s, await s.admit({ receipt: s.writeReceipt(s.receiptOf({ changed_paths: [SCOPE[0]] })) }), "RECEIPT_FACTS");
    await refuses(s, await s.admit({ receipt: s.writeReceipt(s.receiptOf({ candidate: s.repo.grandchild })) }), "RECEIPT_FACTS");
    const outside = mkdtempSync(join(tmpdir(), "handoff-outside-"));
    try {
      writeFileSync(join(outside, "r.json"), good);
      symlinkSync(join(outside, "r.json"), join(s.rroot, "link.json"));
      await refuses(s, await s.admit({ receipt: { root: s.rroot, name: "link.json", sha256: sha(good) } }), "RECEIPT_PATH");
      await refuses(s, await s.admit({ receipt: { root: s.rroot, name: "../x.json", sha256: sha(good) } }), "RECEIPT_MISSING");
    } finally { rmSync(outside, { recursive: true, force: true }); }
    const env = s.receiptOf(); env.outcome = { ...env.outcome, env: { PATH: "/bin" } };
    await refuses(s, await s.admit({ receipt: s.writeReceipt(env) }), "RECEIPT_ENV");
  });
});

test("paired control (generation): a genuine launch receipt from the previous grant fails after a re-grant; a fresh launch under the new grant is admitted", async () => {
  await scenario(async s => {
    const f = await s.board.runtime.fence({ resource: `scope:${SCOPE[1]}`, holder: HOLDER, reason: "test: controller re-grants" });
    s.leases.scopes[1] = { ...s.leases.scopes[1], gen: f.lease.gen };   // the fresh generation is presented
    const head = s.board.refs.resolve(s.ctx.ref);
    await refuses(s, await s.admit(), "RECEIPT_GENERATION");
    assert.equal(s.board.refs.resolve(s.ctx.ref), head);
    // The pair: a NEW launch under the new generations (never the old receipt relabelled).
    const again = await s.launch();
    assert.equal(again.receipt.generations[`scope:${SCOPE[1]}`], f.lease.gen);
    const res = await s.admit({ receipt: { root: s.rroot, name: again.name, sha256: again.sha256 }, request: { ticket: KEY, candidate: again.candidate } });
    assert.equal(res.ok, true, res.why);
  });
});
test("worker launch: the original scratch-only containment receipt is refused -- a capability probe is not a worker run", async () => {
  await scenario(async s => {
    const scratchOnly = { kind: RECEIPT_KIND, v: 1, ticket: KEY, base: s.repo.base, candidate: s.repo.good, changed_paths: [SCOPE[0], SCOPE[3]],
      generations: s.gens(), containment: { tool: "bwrap", network: "unshared", probes: recordedProbes() } };
    const head = s.board.refs.resolve(s.ctx.ref);
    await refuses(s, await s.admit({ receipt: s.writeReceipt(scratchOnly) }), "NO_LAUNCH");
    assert.equal(s.board.refs.resolve(s.ctx.ref), head);
  });
});

test("worker launch: success is observed in-box -- exactly the scope writable, the sentinel unreadable, an outside write refused -- and its receipt is bounded", async () => {
  await scenario(async s => {
    const r = s.launched.receipt;
    assert.equal(r.kind, LAUNCH_KIND);
    assert.deepEqual([r.inbox.verdict, r.inbox.writable, r.outcome.phase, r.outcome.status], ["ok", [...SCOPE].sort(), "worker_exited", 0]);
    assert.deepEqual(r.changed_paths, [SCOPE[0], SCOPE[3]]);
    assert.equal(execFileSync("git", ["-C", s.repo.dir, "show", `${s.repo.good}:${SCOPE[0]}`], { encoding: "utf8" }), "sealed refused\n");
    assert.equal(execFileSync("git", ["-C", s.repo.dir, "rev-list", "--parents", "-n", "1", s.repo.good], { encoding: "utf8" }).trim(), `${s.repo.good} ${s.repo.base}`);
    // Bounded witness: only the mount lines under the checkout, no host mount table, no worker output.
    assert.equal(r.inbox.mounts, SCOPE.length + 1);
    assert.equal(JSON.stringify(r).includes("sealed"), false);
    assert.ok(Date.parse(r.expires_at) - Date.parse(r.issued_at) <= 15 * 60_000);
  });
});

test("worker launch: a prelude refusal, a timed-out run and a run that never starts keep their evidence, deliver nothing and leave the ref unchanged", async () => {
  await scenario(async s => {
    const head = s.board.refs.resolve(s.ctx.ref);
    const wide = await s.launch({ grant: [...SCOPE, OUTSIDE] });
    assert.deepEqual([wide.receipt.outcome.phase, wide.receipt.outcome.status, wide.receipt.inbox.verdict, wide.candidate], ["prelude_refused", 97, "refused", null]);
    const late = await s.launch({ worker: ["/bin/sh", "-c", "sleep 30"], timeoutMs: 400 });
    assert.deepEqual([late.receipt.outcome.phase, late.receipt.outcome.killed_for, late.candidate], ["stopped_timeout", "timeout", null]);
    const dead = await s.launch({ bwrap: "/nonexistent/bwrap" });
    assert.deepEqual([dead.receipt.outcome.phase, dead.receipt.inbox, dead.candidate], ["not_launched", null, null]);
    for (const [run, code] of [[wide, "LAUNCH_SCOPE"], [late, "LAUNCH_FAILED"], [dead, "LAUNCH_UNOBSERVED"]]) {
      assert.equal(readFileSync(join(s.rroot, run.name), "utf8").length > 0, true, "the evidence is kept");
      await refuses(s, await s.admit({ receipt: { root: s.rroot, name: run.name, sha256: run.sha256 } }), code);
    }
    await refuses(s, await s.admit({ receipt: { root: s.rroot, name: "launch-missing.json", sha256: "0".repeat(64) } }), "RECEIPT_MISSING");
    assert.equal(s.board.refs.resolve(s.ctx.ref), head);
  });
});

test("worker launch: an unrelated launch, altered output and an expired receipt are refused", async () => {
  await scenario(async s => {
    const other = await s.launch({ ticket: { key: "another-ticket", base: s.repo.base, scope: [...SCOPE] } });
    await refuses(s, await s.admit({ receipt: { root: s.rroot, name: other.name, sha256: other.sha256 } }), "RECEIPT_FACTS");
    // Altered output: a commit with the same parent and paths but different bytes, claimed under the launch receipt.
    const g = (...a) => execFileSync("git", ["-C", s.repo.dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
    g("checkout", "-q", s.repo.base);
    writeFileSync(join(s.repo.dir, SCOPE[0]), "forged\n"); writeFileSync(join(s.repo.dir, SCOPE[3]), "// adapter\n");
    g("add", "-A"); g("commit", "-q", "-m", "forged output"); const forged = g("rev-parse", "HEAD");
    await refuses(s, await s.admit({ request: { ticket: KEY, candidate: forged } }), "RECEIPT_FACTS");
    await refuses(s, await s.admit({ request: { ticket: KEY, candidate: forged }, receipt: s.writeReceipt(s.receiptOf({ candidate: forged })) }), "LAUNCH_PATCH");
    const expired = Date.parse(s.launched.receipt.expires_at) + 1;
    await refuses(s, await s.admit({ now: () => expired }), "RECEIPT_EXPIRED");
  });
});

test("durable delivery: the receipt lands as a trace blob in the same commit as the done item, and a fresh process re-derives it from the board", async () => {
  await scenario(async s => {
    const res = await s.admit();
    assert.equal(res.ok, true, res.why);
    const it = s.item();
    assert.deepEqual(it.delivery_receipt, { sha256: s.launched.sha256, blob: res.blob, trace: res.trace });
    assert.ok(s.board.store.get(res.commit).records.includes(res.trace), "the trace is introduced by the delivering commit");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { openBoard } from ${JSON.stringify(new URL("../src/board/index.mjs", import.meta.url).href)};
      import { verifyDelivery } from ${JSON.stringify(new URL("../../scripts/blackboard/worker-handoff.mjs", import.meta.url).href)};
      const b = openBoard(process.argv[1]);
      const v = verifyDelivery({ ...b, ref: "refs/board/lock-helper", key: ${JSON.stringify(KEY)} });
      process.stdout.write(JSON.stringify({ ok: v.ok, code: v.code ?? null, sha256: v.sha256 ?? null, candidate: v.candidate ?? null, run: v.receipt?.run_id ?? null }));`, s.boardRoot],
      { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { ok: true, code: null, sha256: s.launched.sha256, candidate: s.repo.good, run: s.launched.receipt.run_id });
    assert.equal(verifyDelivery({ ...s.board, ref: s.ctx.ref, key: `${KEY}-verify` }).code, "NOT_DELIVERED");
  });
});
test("probe outcomes are derived from the in-box result, the exit and the bytes; a denial needs an existing target and EROFS from the operation itself", async () => {
  assert.deepEqual(probeOutcome(POSITIVE), { ok: true, outcome: "allowed" });
  assert.deepEqual(probeOutcome(DENIAL), { ok: true, outcome: "denied" });
  // Not denial evidence: a missing target (the real "Directory nonexistent" holdout), a different errno, no in-box
  // result at all (bwrap never started, timed out, or the inner probe never ran), or bytes that changed.
  const notEvidence = [
    ["missing target", { ...DENIAL, before: null, after: null, inbox: { ran: true, result: "denied", errno: "ENOENT" } }],
    ["EROFS on a target that did not exist", { ...DENIAL, before: null, after: null }],
    ["EACCES is not the write policy", { ...DENIAL, inbox: { ran: true, result: "denied", errno: "EACCES" } }],
    ["launch failure: no in-box result", { ...DENIAL, exit: 1, inbox: null }],
    ["timeout: no in-box result", { ...DENIAL, exit: -1, inbox: null }],
    ["a bare exit and unchanged bytes (the earlier shape)", { path: "denial.txt", exit: 2, before: sha("b"), after: sha("b") }],
    ["denied but the bytes changed", { ...DENIAL, after: sha("b+probe") }],
    ["written but nothing changed", { ...POSITIVE, after: POSITIVE.before }],
    ["written to a target that did not exist", { ...POSITIVE, before: null }],
    ["a free-form label", { fixture: "denial", path: "denial.txt", expected: "refused", observed: "refused" }],
  ];
  for (const [why, p] of notEvidence) assert.equal(probeOutcome(p).code, "RECEIPT_CONTAINMENT", why);
});

const SELF = fileURLToPath(import.meta.url);
const have = await sandboxAvailable("bwrap");

test("gate: this file is a gate-recognized real-bwrap suite", () => {
  assert.deepEqual(designated([SELF]), { gated: [SELF], ungated: [] });
});

/** Disposable fixtures in a scratch root of their own -- never the candidate checkout. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "handoff-probe-"));
  writeFileSync(join(root, "positive.txt"), "a\n");
  writeFileSync(join(root, "denial.txt"), "b\n");
  return root;
}

test("real box: the allowed fixture is written and the unbound one is denied EROFS by the in-box operation; that probe alone admits nothing",
  { skip: have.ok ? false : have.why }, async () => {
  const root = scratch();
  try {
    const containment = observeContainment({ root, positive: "positive.txt", denial: ["denial.txt"] });
    assert.deepEqual(containment.probes.map(p => [p.fixture, p.path, p.exit, p.inbox]), [
      ["positive", "positive.txt", 0, { ran: true, result: "written" }],
      ["denial", "denial.txt", 0, { ran: true, result: "denied", errno: "EROFS" }],
    ]);
    assert.equal(readFileSync(join(root, "denial.txt"), "utf8"), "b\n");
    await scenario(async s => {
      await refuses(s, await s.admit({ receipt: s.writeReceipt({ kind: RECEIPT_KIND, v: 1, ticket: KEY, base: s.repo.base, candidate: s.repo.good, changed_paths: [SCOPE[0], SCOPE[3]], generations: s.gens(), containment: containment }) }), "NO_LAUNCH");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real box: a denial target under a missing directory, and a box that never starts, attest nothing",
  { skip: have.ok ? false : have.why }, async () => {
  const root = scratch();
  try {
    const missing = observeContainment({ root, positive: "positive.txt", denial: ["nodir/x.txt"] });
    const m = missing.probes[1];
    assert.equal(m.before, null); assert.equal(m.after, null); assert.equal(m.inbox.result, "denied");
    assert.notEqual(m.inbox.errno, "EROFS");
    const dead = observeContainment({ root: join(root, "does-not-exist"), positive: "positive.txt", denial: ["denial.txt"] });
    assert.deepEqual(dead.probes.map(p => p.inbox), [null, null]);
    assert.notEqual(dead.probes[1].exit, 0);
    await scenario(async s => {
      await refuses(s, await s.admit({ receipt: s.writeReceipt({ kind: RECEIPT_KIND, v: 1, ticket: KEY, base: s.repo.base, candidate: s.repo.good, changed_paths: [SCOPE[0], SCOPE[3]], generations: s.gens(), containment: missing }) }), "NO_LAUNCH");
      await refuses(s, await s.admit({ receipt: s.writeReceipt({ kind: RECEIPT_KIND, v: 1, ticket: KEY, base: s.repo.base, candidate: s.repo.good, changed_paths: [SCOPE[0], SCOPE[3]], generations: s.gens(), containment: dead }) }), "NO_LAUNCH");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worker launch: Git paths with spaces, under a scratch root with a space, are compared in mountinfo's escaped spelling before the worker runs; a wider bind is still refused", async () => {
  const d = mkdtempSync(join(tmpdir(), "launch space-"));
  try {
    const repo = join(d, "repo dir"); mkdirSync(repo);
    const g = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
    g("init", "-q");
    for (const f of ["plain.mjs", "planned file.mjs", "other.mjs"]) writeFileSync(join(repo, f), `// ${f}\n`);
    g("add", "-A"); g("commit", "-q", "-m", "base"); const base = g("rev-parse", "HEAD");
    const root = join(d, "scratch root"), rec = join(d, "receipts"); mkdirSync(root); mkdirSync(rec);
    const scope = ["plain.mjs", "planned file.mjs"];
    const leases = { item: { resource: "item:spaces", gen: 1 }, scopes: scope.map(p => ({ resource: `scope:${p}`, gen: 1 })) };
    const worker = ["/bin/sh", "-c", 'printf "a\\n" >> plain.mjs; printf "b\\n" >> "planned file.mjs"'];
    const ok = await launchWorker({ repo, ticket: { key: "spaces", base, scope }, leases, worker, root, receiptRoot: rec, timeoutMs: 20_000 });
    assert.deepEqual([ok.receipt.outcome.phase, ok.receipt.outcome.status, ok.receipt.inbox.verdict, ok.receipt.inbox.writable], ["worker_exited", 0, "ok", ["plain.mjs", "planned file.mjs"]]);
    assert.deepEqual(ok.receipt.changed_paths, ["plain.mjs", "planned file.mjs"]);
    const wide = await launchWorker({ repo, ticket: { key: "spaces", base, scope }, leases, worker, root, receiptRoot: rec, timeoutMs: 20_000, grant: [...scope, "other.mjs"] });
    assert.deepEqual([wide.receipt.outcome.phase, wide.receipt.inbox.verdict, wide.receipt.inbox.writable, wide.candidate], ["prelude_refused", "refused", ["other.mjs", "plain.mjs", "planned file.mjs"], null]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("durable delivery: a genuine receipt co-committed with an item naming another real candidate, or opaque receipt bytes whose links agree, does not verify", async () => {
  await scenario(async s => {
    const { cid, slot, links, ...payload } = s.item();
    const land = async (bytes, candidate) => {
      const blob = putBlob(s.board.store, bytes);
      const tp = { test: "forged binding" };
      const trace = putEntry(s.board.store, { kind: "trace", level: KINDS.trace.level, payload: tp, links: { log: blob }, author: HOLDER, visibility: "board" }).cid;
      const r = await publish({ ...s.ctx, author: HOLDER, lease: s.leases.item, leases: s.leases.scopes, expect: boardState(s.ctx).commit, entries: [
        { kind: "trace", payload: tp, blob: bytes },
        { kind: "work_item", payload: { ...payload, state: "done", candidate_commit: candidate, delivery_receipt: { sha256: sha(bytes), blob, trace } } }] });
      assert.equal(r.ok, true, r.why);
      return verifyDelivery({ ...s.board, ref: s.ctx.ref, key: KEY });
    };
    const genuine = readFileSync(join(s.rroot, s.launched.name));
    // offScope is a real commit with the same parent (the base); the receipt is about the launched candidate.
    assert.equal(execFileSync("git", ["-C", s.repo.dir, "rev-list", "--parents", "-n", "1", s.repo.offScope], { encoding: "utf8" }).trim(), `${s.repo.offScope} ${s.repo.base}`);
    const v1 = await land(genuine, s.repo.offScope);
    assert.equal(v1.code, "EVIDENCE_MISMATCH", v1.why);
    const v2 = await land(Buffer.from("opaque, not a receipt {"), s.repo.good);
    assert.equal(v2.code, "EVIDENCE_UNREADABLE", v2.why);
  });
});
