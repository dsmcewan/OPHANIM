// External worker handoff (#121): a builder outside the board says "done at <sha>"; the controller admits
// it only on what it observed -- git, the board, every lease generation, and a controller-owned receipt --
// and the native scheduler then unlocks the verifier exactly once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { publish, boardState, schedule } from "../src/board/index.mjs";
import { withBoard, seeded, CONTROLLER } from "./board-helper.mjs";
import { admitHandoff, observeContainment, probeOutcome, RECEIPT_KIND } from "../../scripts/blackboard/worker-handoff.mjs";

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

/** A controller-recorded probe set: exit and the bytes' digests before and after each write. */
const recordedProbes = () => ([
  { path: SCOPE[3], exit: 0, before: sha("a"), after: sha("a+probe") },
  { path: OUTSIDE, exit: 1, before: sha("b"), after: sha("b") },
]);

async function scenario(fn) {
  const repo = makeRepo();
  const rroot = mkdtempSync(join(tmpdir(), "handoff-receipts-"));
  try {
    await withBoard(async board => {
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
      const receiptOf = (over = {}) => ({ kind: RECEIPT_KIND, v: 1, ticket: KEY, base: repo.base, candidate: repo.good,
        changed_paths: [SCOPE[0], SCOPE[3]], generations: gens(),
        containment: { tool: "bwrap", network: "unshared", probes: recordedProbes() }, ...over });
      let n = 0;
      const writeReceipt = (obj, bytes = JSON.stringify(obj)) => {
        const name = `r${n++}.json`; writeFileSync(join(rroot, name), bytes);
        return { root: rroot, name, sha256: sha(bytes) };
      };
      const verifyReady = () => schedule(ctx).ready.filter(x => x.item === `${KEY}-verify`).length;
      const item = () => boardState(ctx).items.find(i => i.key === KEY);
      const admit = (over = {}) => admitHandoff({ board, ref: ctx.ref, repo: repo.dir,
        ticket: { key: KEY, base: repo.base, scope: [...SCOPE] }, holder: HOLDER, leases,
        receipt: writeReceipt(receiptOf()), request: { ticket: KEY, candidate: repo.good }, ...over });
      await fn({ board, ctx, repo, leases, gens, receiptOf, writeReceipt, verifyReady, item, admit, rroot });
    });
  } finally { repo.cleanup(); rmSync(rroot, { recursive: true, force: true }); }
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
    const env = s.receiptOf(); env.containment = { ...env.containment, env: { PATH: "/bin" } };
    await refuses(s, await s.admit({ receipt: s.writeReceipt(env) }), "RECEIPT_ENV");
  });
});

test("paired control (generation): a genuine receipt from the previous grant fails after a re-grant, though publish would present the fresh generations", async () => {
  await scenario(async s => {
    const oldReceipt = s.writeReceipt(s.receiptOf());        // observed under the current generations
    const f = await s.board.runtime.fence({ resource: `scope:${SCOPE[1]}`, holder: HOLDER, reason: "test: controller re-grants" });
    s.leases.scopes[1] = { ...s.leases.scopes[1], gen: f.lease.gen };   // the fresh generation is presented
    const head = s.board.refs.resolve(s.ctx.ref);
    await refuses(s, await s.admit({ receipt: oldReceipt }), "RECEIPT_GENERATION");
    assert.equal(s.board.refs.resolve(s.ctx.ref), head);
    // The pair: the same receipt with only the generation brought current is admitted.
    const res = await s.admit({ receipt: s.writeReceipt(s.receiptOf()) });
    assert.equal(res.ok, true, res.why);
  });
});

test("paired control (observed write): only the refused probe's recorded exit and bytes change, and admission refuses without moving the ref", async () => {
  await scenario(async s => {
    const breach = s.receiptOf();
    breach.containment = { ...breach.containment, probes: [breach.containment.probes[0], { path: OUTSIDE, exit: 0, before: sha("b"), after: sha("b+probe") }] };
    const head = s.board.refs.resolve(s.ctx.ref);
    await refuses(s, await s.admit({ receipt: s.writeReceipt(breach) }), "CONTAINMENT_BREACH");
    assert.equal(s.board.refs.resolve(s.ctx.ref), head);
    assert.equal((await s.admit()).ok, true);
  });
});

test("probe outcomes are derived from exit and bytes: self-contradicting, duplicate-path and one-sided probe sets are refused", async () => {
  assert.deepEqual(probeOutcome({ path: "a", exit: 0, before: null, after: sha("x") }), { ok: true, outcome: "allowed" });
  assert.deepEqual(probeOutcome({ path: "a", exit: 1, before: null, after: null }), { ok: true, outcome: "refused" });
  assert.equal(probeOutcome({ path: "a", exit: 0, before: sha("x"), after: sha("x") }).code, "RECEIPT_CONTAINMENT");
  assert.equal(probeOutcome({ path: "a", exit: 2, before: sha("x"), after: sha("y") }).code, "RECEIPT_CONTAINMENT");
  assert.equal(probeOutcome({ path: "a", expected: "allowed", observed: "allowed" }).code, "RECEIPT_CONTAINMENT");
  await scenario(async s => {
    const with_ = probes => s.writeReceipt(s.receiptOf({ containment: { tool: "bwrap", network: "unshared", probes } }));
    const [inP, outP] = [s.receiptOf().containment.probes[0], s.receiptOf().containment.probes[1]];
    await refuses(s, await s.admit({ receipt: with_([inP, { ...inP, exit: 1, after: inP.before }]) }), "RECEIPT_CONTAINMENT");
    await refuses(s, await s.admit({ receipt: with_([inP]) }), "RECEIPT_CONTAINMENT");
    await refuses(s, await s.admit({ receipt: with_([outP]) }), "RECEIPT_CONTAINMENT");
    await refuses(s, await s.admit({ receipt: with_([{ ...inP, exit: 1, after: inP.before }, outP]) }), "RECEIPT_CONTAINMENT");
  });
});

const hasBwrap = (() => { try { execFileSync("bwrap", ["--ro-bind", "/", "/", "true"], { stdio: "ignore", timeout: 10_000 }); return true; } catch { return false; } })();

test("real box: the controller's own bwrap probe allows the scoped write, refuses the other, and that receipt is admitted",
  { skip: hasBwrap ? false : "bwrap is not usable on this host" }, async () => {
  await scenario(async s => {
    const containment = observeContainment({ root: s.repo.dir, scope: [SCOPE[3]], probe: [SCOPE[3], OUTSIDE] });
    assert.deepEqual(containment.probes.map(p => [p.path, p.exit === 0, p.before !== p.after]),
      [[SCOPE[3], true, true], [OUTSIDE, false, false]]);
    const res = await s.admit({ receipt: s.writeReceipt(s.receiptOf({ containment })) });
    assert.equal(res.ok, true, res.why);
    assert.equal(s.verifyReady(), 1);
  });
});
