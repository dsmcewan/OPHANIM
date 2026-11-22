#!/usr/bin/env node
/**
 * Controller-owned publication of a board delivery (#143): the sole path from "done on the board" to a branch push.
 *
 * Local admission (admitHandoff) and review progress never wait on this; it runs afterwards, asynchronously, and the
 * network is only a projection of what the board already decided. It publishes only an independently verified,
 * exactly-delivered object, under a current publication lease, by the verified guard (publish-candidate.mjs):
 *
 *   1  verifyDelivery re-derives the delivery from the board alone: the done item, its exact candidate, its
 *      committed launch receipt
 *   2  the ASSIGNED independent check: the policy pins the verifier item key and the seats allowed to decide it;
 *      that item is done with verdict "accept" for exactly {item, candidate}, recorded by an allowed seat that is
 *      not the delivery's author (a different seat string alone proves nothing). This is the scoped delivery check,
 *      not the three-lab release qualification.
 *   3  the policy -- destination branch, remote, extra test gates -- is the CONTROLLER's argument, never a field of
 *      a worker's work_item; the required gates are the guard's own
 *   4  the publication lease (publish:<key>) verifies at its generation, and the branch head is the candidate
 *   5  an earlier attempt for (key, candidate) is reconciled first, against the remote ref recorded BEFORE it:
 *      published -> ALREADY_PUBLISHED; remote now at the candidate -> RECONCILED (no new transport); remote
 *      unobservable -> REMOTE_UNKNOWN; remote changed to anything else -> CHANGED_DESTINATION; remote still at the
 *      recorded pre-attempt value -> AMBIGUOUS. A ref equal to its earlier value is consistent with no update AND
 *      with an update later undone, and a higher lease generation proves only new ownership, so neither licenses a
 *      repeat: no ambiguous attempt is ever re-attempted automatically. Only a definite pre-transport refusal (the
 *      guard recorded that it never called the transport) stays retryable. Every attempted marker, with its
 *      pre-attempt sha, is kept for forensics.
 *   6  a durable "attempted" marker, then the UNCHANGED publishCandidate guard, whose transport re-verifies the
 *      lease immediately before the push
 *   7  the marker is finalised and the raw guard receipt lands on the board as a trace (native CAS), digest-linked
 *
 * Trusted: the board via verifyDelivery, the runtime's lease table, the controller's policy, git in the controller's
 * repository, the guard's own gate runs, the remote's ls-remote. Never trusted: a work_item field, a worker claim,
 * a caller's status.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { verifyDelivery } from "./worker-handoff.mjs";
import { publishCandidate, testGates, gitPushTransport } from "./publish-candidate.mjs";
import { publish } from "../../pantheon/src/board/dag.mjs";
import { boardState } from "../../pantheon/src/board/controller.mjs";

export const DELIVERY_PUBLICATION_KIND = "ophanim.delivery-publication/1";
const SCOPED = /^claude\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const sha256 = b => createHash("sha256").update(b).digest("hex");
const no = (code, why, extra = {}) => ({ ok: false, code, why, ...extra });
const GIT_ENV = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", HOME: process.env.HOME ?? "/nonexistent" });
const git = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: GIT_ENV(), timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const remoteHead = (repo, remote, branch) => {
  try { const out = git(repo, ["ls-remote", remote, `refs/heads/${branch}`]); return out ? out.split(/\s+/)[0] : null; } catch { return undefined; }
};

/** The independent check for exactly this delivery, from the board. */
export function independentCheck({ store, refs, ref, key, verifier, seats, candidate }) {
  if (typeof verifier !== "string" || !verifier || !Array.isArray(seats) || !seats.length) return no("POLICY", "the controller's policy pins the verifier item key and the seats allowed to decide it");
  const st = boardState({ store, refs, ref });
  const v = st.items.find(i => i.key === verifier), d = st.items.find(i => i.key === key);
  if (!v) return no("NO_VERIFIER", `no verifier item ${verifier} on ${ref}`);
  if (v.state !== "done" || v.verdict !== "accept") return no("NOT_VERIFIED", `${verifier} is ${v.state}${v.verdict ? ` (${v.verdict})` : ""}, not done with verdict accept`);
  if (v.verifies?.item !== key || v.verifies?.candidate !== candidate) return no("VERIFIER_MISMATCH", `${verifier} verifies ${JSON.stringify(v.verifies)}, not ${key} at ${candidate}`);
  const va = store.get(v.cid)?.author?.seat_id ?? store.get(v.cid)?.author?.vendor, da = store.get(d.cid)?.author?.seat_id ?? store.get(d.cid)?.author?.vendor;
  if (!va || va === da) return no("NOT_INDEPENDENT", `${verifier} was recorded by ${va ?? "(unknown)"}, the delivery's own author`);
  if (!seats.includes(va)) return no("NOT_ASSIGNED", `${verifier} was decided by ${va}, which is not an assigned verifier (${seats.join(", ")})`);
  return { ok: true, verifier, by: va };
}

/**
 * Publish the delivery of `key`. `policy` = {branch, remote, tests} is the controller's. `lease` = {resource, gen} is
 * the publication lease (resource publish:<key>), held by `holder`. `transport` is the guard's test seam.
 */
export async function publishDelivery({ board, ref, key, policy, holder, lease, repo, receiptRoot, transport = gitPushTransport, workRoot } = {}) {
  repo = resolvePath(repo ?? ".");
  mkdirSync(receiptRoot, { recursive: true });
  const { store, refs, runtime } = board;
  // 1. the delivery, re-derived
  const dv = verifyDelivery({ store, refs, ref, key });
  if (!dv.ok) return no(dv.code, dv.why);
  const candidate = dv.candidate;
  // 3 (first: everything after reads it). the controller's policy
  if (!policy || typeof policy.branch !== "string" || !SCOPED.test(policy.branch) || policy.branch.includes("..") || typeof policy.remote !== "string" || !policy.remote) {
    return no("POLICY", "the controller's policy names a scoped claude/ branch and a remote");
  }
  const tests = Array.isArray(policy.tests) ? policy.tests : [];
  // 2. the assigned independent check
  const ic = independentCheck({ store, refs, ref, key, verifier: policy.verifier?.key, seats: policy.verifier?.seats, candidate });
  if (!ic.ok) return ic;
  // 4. the publication lease, and the ref
  const leaseOk = () => (lease?.resource === `publish:${key}` && Number.isInteger(lease.gen))
    ? runtime.verify({ resource: lease.resource, seat_id: holder?.seat_id, gen: lease.gen }) : no("LEASE_MISSING", `the publication lease must be publish:${key} with an integer gen`);
  const l0 = leaseOk();
  if (!l0.ok) return no(l0.code, l0.why);
  let head = null; try { head = git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${policy.branch}^{commit}`]); } catch { /* absent */ }
  if (head !== candidate) return no("REF_MISMATCH", `refs/heads/${policy.branch} is ${head ?? "(absent)"}, not the delivered candidate ${candidate}`);
  // 5. an earlier attempt
  const markerPath = join(receiptRoot, `attempt-${key}-${candidate}.json`);
  if (existsSync(markerPath)) {
    const m = JSON.parse(readFileSync(markerPath, "utf8"));
    if (m.status === "published") return no("ALREADY_PUBLISHED", `${candidate} was already published to ${m.branch}`, { marker: m });
    if (m.status === "attempted") {
      const at = remoteHead(repo, policy.remote, policy.branch);
      if (at === candidate) {
        // The destination is observed at the candidate; who moved it there is not established, and not claimed.
        const done = { ...m, status: "published", reconciled_at: new Date().toISOString(), observed_remote: at, reconciled_by: "observation: the remote holds the candidate; the writer of that update is not established" };
        writeFileSync(markerPath, JSON.stringify(done, null, 2));
        return { ok: true, code: "RECONCILED", candidate, branch: policy.branch, marker: done, transport_called: false };
      }
      // The ambiguous marker is kept as it is in every refusal below.
      if (at === undefined) return no("REMOTE_UNKNOWN", `an earlier attempt's effect cannot be read from ${policy.remote}; not re-attempting blind`, { marker: m });
      if (at !== m.pre_attempt_remote) return no("CHANGED_DESTINATION", `${policy.remote} ${policy.branch} is ${at ?? "(absent)"}, neither the candidate nor its value before the attempt (${m.pre_attempt_remote ?? "(absent)"}); not re-attempting`, { marker: m });
      return no("AMBIGUOUS", `the earlier attempt's effect is unknown: the remote is at its pre-attempt value ${at ?? "(absent)"}, which does not show the attempt had no effect; not re-attempting (a fresh grant proves only ownership)`, { marker: m });
    }
  }
  // 6. the attempt, through the guard -- after recording the remote ref it starts from
  const pre = remoteHead(repo, policy.remote, policy.branch);
  if (pre === undefined) return no("REMOTE_UNKNOWN", `${policy.remote} cannot be read before the attempt; an attempt that could not be reconciled is not started`);
  const marker = { kind: DELIVERY_PUBLICATION_KIND, key, candidate, branch: policy.branch, remote: policy.remote, verifier: ic, lease, pre_attempt_remote: pre, status: "attempted", attempted_at: new Date().toISOString() };
  writeFileSync(markerPath, JSON.stringify(marker, null, 2));
  let calls = 0;
  const leased = async args => {
    const l = leaseOk();
    if (!l.ok) throw Object.assign(new Error(`publication lease no longer current: ${l.why}`), { code: "LEASE_LOST" });
    if (args.sha !== candidate || args.branch !== policy.branch) throw new Error("the guard asked to publish another object or branch");
    calls++;
    return transport(args);
  };
  const r = await publishCandidate({ repo, sha: candidate, branch: policy.branch, remote: policy.remote, extra: testGates({ tests }), transport: leased,
    receiptRoot: join(receiptRoot, `guard-${key}-${candidate.slice(0, 12)}-${Date.now()}`), workRoot });
  // 7. the outcome
  const final = { ...marker, status: r.ok ? "published" : (calls ? "attempted" : "refused"), guard: { code: r.code, why: r.why, receipt: r.receipt_path, receipt_sha256: r.receipt_sha256,
    gates: r.gates.map(g => ({ name: g.name, status: g.status, passed: g.passed })) }, finished_at: new Date().toISOString() };
  writeFileSync(markerPath, JSON.stringify(final, null, 2));
  const bytes = Buffer.from(JSON.stringify(final));
  let trace = null;
  try {
    const p = await publish({ ...board, ref, author: holder, entries: [{ kind: "trace", payload: { test: `publication of ${key} at ${candidate}: ${r.code}` }, blob: bytes }] });
    trace = p.ok ? { commit: p.commit, sha256: sha256(bytes) } : { refused: p.code };
  } catch (e) { trace = { error: String(e?.message ?? e) }; }
  return { ok: r.ok, code: r.code, why: r.why, candidate, branch: policy.branch, transport_called: calls > 0, marker: final, trace };
}
