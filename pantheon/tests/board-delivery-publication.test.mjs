// Controller-owned publication of a board delivery (#143): only an independently verified, exactly delivered object,
// under a current publication lease, with the controller's policy, through the unchanged guard. Disposable board,
// repository and bare remote; the transport is a stub (or a local push to the disposable bare remote).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publish, boardState } from "../src/board/index.mjs";
import { withBoard, seeded, CONTROLLER } from "./board-helper.mjs";
import { launchWorker } from "../../scripts/blackboard/worker-launch.mjs";
import { admitHandoff } from "../../scripts/blackboard/worker-handoff.mjs";
import { gitPushTransport } from "../../scripts/blackboard/publish-candidate.mjs";
import { publishDelivery } from "../../scripts/blackboard/publish-delivery.mjs";

const KEY = "delivery", VER = `${KEY}-verify`, SCOPE = ["a.mjs"], BRANCH = "claude/delivery";
const BUILDER = { vendor: "controller", seat_id: "fixture-external-bridge" };
const VERIFIER = { vendor: "controller", seat_id: "independent-verifier" };
const PUBLISHER = { vendor: "controller", seat_id: "publisher" };
const POLICY = { branch: BRANCH, remote: "origin", verifier: { key: VER, seats: [VERIFIER.seat_id] } };

async function scenario({ content = "// delivered\n", workerClaims = {} } = {}, fn) {
  const d = mkdtempSync(join(tmpdir(), "delivery-pub-"));
  const repo = join(d, "repo"), remote = join(d, "remote.git"), rroot = join(d, "receipts"), lroot = join(d, "launch"), proot = join(d, "publication");
  const g = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  mkdirSync(join(repo, "scripts", "test-gates"), { recursive: true }); mkdirSync(rroot); mkdirSync(lroot);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  writeFileSync(join(repo, "a.mjs"), "// base\n");
  // The candidate's own required lint: it fails when the delivered a.mjs says LINTFAIL.
  writeFileSync(join(repo, "scripts", "test-gates", "lint-tests.mjs"), 'import fs from "node:fs";\nprocess.exit(fs.readFileSync("a.mjs", "utf8").includes("LINTFAIL") ? 1 : 0);\n');
  // The in-gate rendezvous: run as the policy's extra test gate INSIDE the guard's box, it marks `ready` in the
  // gate's controller-owned scratch and holds until the test writes `go` -- the authority changes while the gate
  // provably runs, ordered by files, not by sleeps.
  writeFileSync(join(repo, "rendezvous.test.mjs"), 'import fs from "node:fs";\nconst s = process.env.OPHANIM_GATE_SCRATCH;\n' +
    'fs.writeFileSync(s + "/ready", String(process.pid));\nconst until = Date.now() + 60000;\n' +
    'while (!fs.existsSync(s + "/go")) { if (Date.now() > until) process.exit(3); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }\n');
  g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-q", "-m", "base"); g("remote", "add", "origin", remote);
  const base = g("rev-parse", "HEAD");
  try {
    await withBoard(async board => {
      await seeded(board);
      const ctx = { ...board, ref: "refs/board/lock-helper" };
      assert.equal((await publish({ ...ctx, author: CONTROLLER, msg: "ticket", entries: [
        { kind: "work_item", payload: { key: KEY, title: "deliver", state: "active", artifact_slots: [], base_sha: base, write_scope: SCOPE, ...workerClaims } },
        { kind: "work_item", payload: { key: VER, title: "verify", state: "ready", depends_on: [KEY], artifact_slots: [], write_scope: [] } }] })).ok, true);
      const grant = async (r, h) => (await board.runtime.acquire({ resource: r, holder: h, ttlMs: 600_000 })).lease.gen;
      const leases = { item: { resource: `item:${KEY}`, gen: await grant(`item:${KEY}`, BUILDER) }, scopes: [{ resource: "scope:a.mjs", gen: await grant("scope:a.mjs", BUILDER) }] };
      const launched = await launchWorker({ repo, ticket: { key: KEY, base, scope: SCOPE }, leases, worker: ["/bin/sh", "-c", `printf ${JSON.stringify(content)} > a.mjs`], root: lroot, receiptRoot: rroot, timeoutMs: 20_000 });
      assert.equal(launched.receipt.outcome.phase, "worker_exited", JSON.stringify(launched.receipt.outcome));
      const candidate = launched.candidate;
      const admit = () => admitHandoff({ board, ref: ctx.ref, repo, ticket: { key: KEY, base, scope: SCOPE }, holder: BUILDER, leases,
        receipt: { root: rroot, name: launched.name, sha256: launched.sha256 }, request: { ticket: KEY, candidate } });
      const verify = async ({ by = VERIFIER, verdict = "accept", forCandidate = candidate, item = VER } = {}) => {
        // Each verdict is its own grant to its own seat (a fence, so a different seat can take the verifier lease).
        const gen = (await board.runtime.fence({ resource: `item:${item}`, holder: by, reason: "test: verdict" })).lease.gen;
        const existing = boardState(ctx).items.find(i => i.key === item);
        const { cid, slot, links, ...payload } = existing ?? { key: item, title: "another check", artifact_slots: [], write_scope: [] };
        const r = await publish({ ...ctx, author: by, lease: { resource: `item:${item}`, gen }, expect: boardState(ctx).commit,
          entries: [{ kind: "work_item", payload: { ...payload, state: "done", verdict, verifies: { item: KEY, candidate: forCandidate } } }] });
        assert.equal(r.ok, true, r.why);
      };
      const pubLease = async () => ({ resource: `publish:${KEY}`, gen: await grant(`publish:${KEY}`, PUBLISHER) });
      const stub = () => { const calls = []; const t = async a => { calls.push(a); return { stub: true }; }; t.calls = calls; return t; };
      const run = (over = {}) => publishDelivery({ board, ref: ctx.ref, key: KEY, policy: POLICY, holder: PUBLISHER, repo, receiptRoot: proot, workRoot: d, ...over });
      const remoteHead = () => { try { return execFileSync("git", ["-C", remote, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`], { encoding: "utf8" }).trim(); } catch { return null; } };
      await fn({ board, ctx, repo, g, base, candidate, admit, verify, pubLease, stub, run, remoteHead, d });
    });
  } finally { rmSync(d, { recursive: true, force: true }); }
}

const RDV = { ...POLICY, tests: ["rendezvous.test.mjs"] };
/** Wait until a gate of this run is at the rendezvous, change the authority, then release the gate. */
async function rendezvous(root, during) {
  const at = () => readdirSync(root).filter(n => n.startsWith("publication-checkout-")).map(n => join(root, n, "scratch")).find(p => existsSync(join(p, "ready")));
  const until = Date.now() + 60_000;
  let scratch;
  while (!(scratch = at())) { if (Date.now() > until) throw new Error("no gate reached the rendezvous"); await new Promise(r => setTimeout(r, 20)); }
  await during();
  writeFileSync(join(scratch, "go"), "");
}

test("transport entry: a verdict turned reject while the gates run is a typed pre-transport refusal; the transport is never called", async () => {
  await scenario({}, async s => {
    assert.equal((await s.admit()).ok, true);
    await s.verify(); s.g("branch", "-f", BRANCH, s.candidate);
    const t = s.stub();
    const running = s.run({ policy: RDV, lease: await s.pubLease(), transport: t });
    await rendezvous(s.d, () => s.verify({ verdict: "reject" }));
    const r = await running;
    assert.deepEqual([r.ok, r.code, r.changed, r.cause, t.calls.length, r.transport_called], [false, "AUTHORITY_CHANGED", "verdict", "NOT_VERIFIED", 0, false], r.why);
    assert.deepEqual(r.marker.guard.gates.map(g => [g.name, g.passed]), [["test-lint", true], ["tests", true]], "every gate passed: only the authority refused");
    assert.deepEqual([r.marker.status, r.marker.authority_at_transport, s.remoteHead()], ["refused", null, null]);
    assert.equal(r.marker.decision.verifier.by, VERIFIER.seat_id, "the decision read before any external I/O is kept");
    assert.equal((await s.run({ lease: await s.pubLease(), transport: t })).code, "NOT_VERIFIED", "definite, so retryable: it refuses again on its own merits");
    assert.equal(t.calls.length, 0);
  });
});

test("transport entry: a publication lease fenced while the gates run is the same typed refusal, never an untyped transport failure", async () => {
  await scenario({}, async s => {
    assert.equal((await s.admit()).ok, true);
    await s.verify(); s.g("branch", "-f", BRANCH, s.candidate);
    const t = s.stub();
    const running = s.run({ policy: RDV, lease: await s.pubLease(), transport: t });
    await rendezvous(s.d, () => s.board.runtime.fence({ resource: `publish:${KEY}`, holder: { ...PUBLISHER, seat_id: "other" }, reason: "test: fenced mid-gate" }));
    const r = await running;
    assert.deepEqual([r.code, r.changed, r.cause, t.calls.length, r.marker.status, s.remoteHead()], ["AUTHORITY_CHANGED", "lease", "FENCED", 0, "refused", null], r.why);
  });
});

test("transport entry, positive control: with nothing changed at the rendezvous the transport is called once, bound to the authority it read", async () => {
  await scenario({}, async s => {
    assert.equal((await s.admit()).ok, true);
    await s.verify(); s.g("branch", "-f", BRANCH, s.candidate);
    const t = s.stub();
    const running = s.run({ policy: RDV, lease: await s.pubLease(), transport: t });
    await rendezvous(s.d, async () => {});
    const r = await running;
    assert.deepEqual([r.ok, r.code, t.calls.length], [true, "PUBLISHED", 1], r.why);
    const a = r.marker.authority_at_transport;
    assert.deepEqual([a?.candidate, a?.verifier?.by, a?.lease?.resource], [s.candidate, VERIFIER.seat_id, `publish:${KEY}`]);
    assert.match(a.board_commit, /^commit:[0-9a-f]{64}$/);
    assert.equal(a.board_commit, r.marker.decision.board_commit, "nothing changed between the decision read before I/O and the one read at transport entry");
  });
});

test("green: a delivered, independently accepted candidate under a current publication lease reaches exactly one transport, recorded on the board", async () => {
  await scenario({}, async s => {
    assert.equal((await s.admit()).ok, true);
    await s.verify(); s.g("branch", "-f", BRANCH, s.candidate);
    const t = s.stub();
    const r = await s.run({ lease: await s.pubLease(), transport: t });
    assert.deepEqual([r.ok, r.code], [true, "PUBLISHED"], r.why);
    assert.deepEqual(t.calls.map(c => [c.sha, c.branch, c.remote]), [[s.candidate, BRANCH, "origin"]]);
    assert.equal(r.marker.status, "published");
    assert.match(r.trace.sha256, /^[0-9a-f]{64}$/);
    assert.ok(s.board.store.get(r.trace.commit), "the raw outcome is a board commit");
  });
});

test("refused with no transport: a real lint failure in the delivered candidate", async () => {
  await scenario({ content: "// LINTFAIL\n" }, async s => {
    assert.equal((await s.admit()).ok, true);
    await s.verify(); s.g("branch", "-f", BRANCH, s.candidate);
    const t = s.stub();
    const r = await s.run({ lease: await s.pubLease(), transport: t });
    assert.deepEqual([r.code, r.marker.status, r.marker.guard.gates.map(g => [g.name, g.status]), t.calls.length], ["GATE_FAILED", "refused", [["test-lint", 1]], 0]);
  });
});

test("refused with no transport: no delivery, no or stale lease, no / unrelated / non-independent verifier, wrong ref, unscoped policy", async () => {
  await scenario({}, async s => {
    const t = s.stub();
    assert.equal((await s.run({ lease: await s.pubLease(), transport: t })).code, "NOT_DELIVERED");
    assert.equal((await s.run({ key: "nothing", lease: await s.pubLease(), transport: t })).code, "NOT_DELIVERED");
    assert.equal((await s.admit()).ok, true);
    s.g("branch", "-f", BRANCH, s.candidate);
    assert.equal((await s.run({ lease: await s.pubLease(), transport: t })).code, "NOT_VERIFIED", "no verifier result yet");
    await s.verify({ forCandidate: s.base });
    assert.equal((await s.run({ lease: await s.pubLease(), transport: t })).code, "VERIFIER_MISMATCH", "a verdict about another object");
    await s.verify({ by: { ...VERIFIER, seat_id: BUILDER.seat_id } });
    assert.equal((await s.run({ lease: await s.pubLease(), transport: t })).code, "NOT_INDEPENDENT", "recorded by the delivery's own author");
    // Wrong assignment, though the stated sha matches: an unassigned seat, and an accepting item the policy did not name.
    await s.verify({ by: { ...VERIFIER, seat_id: "some-other-seat" } });
    assert.equal((await s.run({ lease: await s.pubLease(), transport: t })).code, "NOT_ASSIGNED");
    await s.verify({ item: "unassigned-check" });
    assert.equal((await s.run({ lease: await s.pubLease(), transport: t })).code, "NOT_ASSIGNED", "the assigned item is still the unassigned seat's verdict");
    assert.equal((await s.run({ policy: { ...POLICY, verifier: undefined }, lease: await s.pubLease(), transport: t })).code, "POLICY");
    await s.verify();
    assert.equal((await s.run({ transport: t })).code, "LEASE_MISSING");
    const lease = await s.pubLease();
    await s.board.runtime.fence({ resource: lease.resource, holder: { ...PUBLISHER, seat_id: "other" }, reason: "test: fenced" });
    assert.equal((await s.run({ lease, transport: t })).code, "FENCED", "a stale publication lease");
    s.g("branch", "-f", BRANCH, s.base);
    const fresh = await s.board.runtime.fence({ resource: lease.resource, holder: PUBLISHER, reason: "test: re-grant" });
    assert.equal((await s.run({ lease: { resource: lease.resource, gen: fresh.lease.gen }, transport: t })).code, "REF_MISMATCH");
    s.g("branch", "-f", BRANCH, s.candidate);
    for (const branch of ["main", "feature/x", "claude/../main"]) assert.equal((await s.run({ policy: { ...POLICY, branch }, lease: { resource: lease.resource, gen: fresh.lease.gen }, transport: t })).code, "POLICY", branch);
    assert.equal(t.calls.length, 0, "not one refusal reached the transport");
  });
});

test("a worker's own publication claims on its work item authorize nothing; the destination is the controller's", async () => {
  await scenario({ workerClaims: { publish_branch: "claude/worker-chosen", authorized: true, publish: { branch: "main", remote: "elsewhere" } } }, async s => {
    assert.equal((await s.admit()).ok, true);
    await s.verify(); s.g("branch", "-f", BRANCH, s.candidate);
    const t = s.stub();
    assert.equal((await s.run({ policy: undefined, lease: await s.pubLease(), transport: t })).code, "POLICY", "without the controller's policy nothing is published");
    const r = await s.run({ lease: await s.pubLease(), transport: t });
    assert.deepEqual([r.code, t.calls.map(c => [c.branch, c.remote])], ["PUBLISHED", [[BRANCH, "origin"]]]);
  });
});

test("cold path: an ambiguous attempt is reconciled against the remote before any re-attempt", async () => {
  await scenario({}, async s => {
    assert.equal((await s.admit()).ok, true);
    await s.verify(); s.g("branch", "-f", BRANCH, s.candidate);
    // 1. the transport pushed (to the disposable bare remote) and then failed: the effect is unknown to the caller.
    const pushedThenThrew = async a => { gitPushTransport(a); throw new Error("connection reset after the push"); };
    const r1 = await s.run({ lease: await s.pubLease(), transport: pushedThenThrew });
    assert.deepEqual([r1.code, r1.marker.status, s.remoteHead()], ["TRANSPORT_FAILED", "attempted", s.candidate]);
    // 2. cold re-run: the remote already holds the candidate -- reconciled, no new transport.
    const t = s.stub();
    const r2 = await s.run({ lease: await s.pubLease(), transport: t });
    assert.deepEqual([r2.code, r2.transport_called, t.calls.length, r2.marker.status, r2.marker.observed_remote], ["RECONCILED", false, 0, "published", s.candidate]);
    assert.match(r2.marker.reconciled_by, /not established/, "it records what was observed, not who changed it");
    // 3. and from then on it is already published.
    assert.equal((await s.run({ lease: await s.pubLease(), transport: t })).code, "ALREADY_PUBLISHED");
    assert.equal(t.calls.length, 0);
  });
});

test("cold path: an ambiguous attempt with the remote still at its pre-attempt sha stays ambiguous, even under a fresh fenced grant", async () => {
  await scenario({}, async s => {
    assert.equal((await s.admit()).ok, true);
    await s.verify(); s.g("branch", "-f", BRANCH, s.candidate);
    // The remote branch exists at an earlier sha before the attempt.
    s.g("push", "-q", "origin", `${s.base}:refs/heads/${BRANCH}`);
    const threw = async () => { throw new Error("connection lost, effect unknown"); };
    const lease1 = await s.pubLease();
    const r1 = await s.run({ lease: lease1, transport: threw });
    assert.deepEqual([r1.code, r1.marker.status, r1.marker.pre_attempt_remote, s.remoteHead()], ["TRANSPORT_FAILED", "attempted", s.base, s.base]);
    const t = s.stub();
    assert.deepEqual([(await s.run({ lease: lease1, transport: t })).code, t.calls.length], ["AMBIGUOUS", 0]);
    // The decisive pair: a fresh fenced grant, the remote at the same earlier sha -> still ambiguous, no transport.
    const f = await s.board.runtime.fence({ resource: lease1.resource, holder: PUBLISHER, reason: "test: fenced re-grant" });
    const r3 = await s.run({ lease: { resource: lease1.resource, gen: f.lease.gen }, transport: t });
    assert.deepEqual([r3.code, t.calls.length, r3.marker.status, r3.marker.pre_attempt_remote], ["AMBIGUOUS", 0, "attempted", s.base], "the attempted record and its pre-attempt sha are kept");
  });
});

test("cold path: after an ambiguous attempt, a changed destination or an unreadable remote reaches no transport; a definite pre-transport refusal stays retryable", async () => {
  await scenario({}, async s => {
    assert.equal((await s.admit()).ok, true);
    await s.verify(); s.g("branch", "-f", BRANCH, s.candidate);
    const threw = async () => { throw new Error("effect unknown"); };
    assert.equal((await s.run({ lease: await s.pubLease(), transport: threw })).code, "TRANSPORT_FAILED");
    // Someone else moves the destination: neither the candidate nor its pre-attempt value.
    s.g("push", "-q", "origin", `${s.base}:refs/heads/${BRANCH}`);
    const t = s.stub();
    const fresh = await s.board.runtime.fence({ resource: `publish:${KEY}`, holder: PUBLISHER, reason: "test: re-grant" });
    const lease = { resource: `publish:${KEY}`, gen: fresh.lease.gen };
    assert.deepEqual([(await s.run({ lease, transport: t })).code, t.calls.length], ["CHANGED_DESTINATION", 0]);
    // An unreadable remote: no blind re-attempt.
    s.g("remote", "set-url", "origin", join(s.d, "missing.git"));
    assert.deepEqual([(await s.run({ lease, transport: t })).code, t.calls.length], ["REMOTE_UNKNOWN", 0]);
  });
  await scenario({ content: "// LINTFAIL\n" }, async s => {
    assert.equal((await s.admit()).ok, true);
    await s.verify(); s.g("branch", "-f", BRANCH, s.candidate);
    const t = s.stub();
    const r = await s.run({ lease: await s.pubLease(), transport: t });
    assert.deepEqual([r.code, r.marker.status, t.calls.length], ["GATE_FAILED", "refused", 0], "a definite refusal, recorded as such -- not an ambiguous attempt");
    assert.notEqual((await s.run({ lease: await s.pubLease(), transport: t })).code, "AMBIGUOUS", "and it is retryable (it refuses again on its own merits)");
  });
  // A known pre-transport refusal, then a correction: the same key publishes once the cause is gone.
  await scenario({}, async s => {
    assert.equal((await s.admit()).ok, true);
    await s.verify(); s.g("branch", "-f", BRANCH, s.base);              // wrong ref: refused before any transport
    const t = s.stub();
    assert.equal((await s.run({ lease: await s.pubLease(), transport: t })).code, "REF_MISMATCH");
    s.g("branch", "-f", BRANCH, s.candidate);                           // corrected
    const r = await s.run({ lease: await s.pubLease(), transport: t });
    assert.deepEqual([r.code, t.calls.length], ["PUBLISHED", 1]);
  });
});
