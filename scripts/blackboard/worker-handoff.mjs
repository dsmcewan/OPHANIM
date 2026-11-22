/**
 * External worker handoff (#121, ticket runtime-external-worker-adapter).
 *
 * An external builder (a worker outside the board's own seats) says "ticket T is done at commit C". The
 * native publish() would accept that sentence as written: it checks the entry's SHAPE and the item lease,
 * so a `done` naming any candidate string lands, and the verifier unlocks on a claim. This adapter admits
 * the transition only on what the CONTROLLER can observe:
 *
 *   git      -- the base and the candidate are real commits; the candidate's ONE parent is the exact base
 *               (ancestry alone would admit intermediate off-scope edits); the changed paths, read from
 *               git, are inside the ticket's scope and the item's write_scope.
 *   board    -- the item is active at that base; it is not already delivered (REPLAY / CONFLICT).
 *   leases   -- the item lease and EVERY scope:<path> lease are current. Checked early for a clear error
 *               and again inside refs.swap's ref lock -> lease lock (publish's `leases`), so a fence that
 *               lands between this validation and the swap refuses the write.
 *   receipt  -- read from a controller-owned root, confined to it, bounded, and equal to a digest the
 *               CONTROLLER supplies. Its facts -- ticket, base, candidate, changed paths and the item and
 *               scope GENERATIONS it was observed under -- must equal what is observed and presented now.
 *               Its containment probes record a command exit and the file's bytes before and after; the
 *               outcome is derived from those (probeOutcome), never labelled, and must include an in-scope
 *               write that was allowed and an out-of-scope write, on a different path, that was refused.
 *
 * What the worker supplies is only { ticket, candidate }. Its word on paths, generations or containment is
 * never read. Then, and only then, the item moves to `done` through the native publish(), and the native
 * scheduler unlocks the verifier exactly as it does for any other delivery. No second scheduler, no review.
 *
 * Every refusal is { ok:false, code, why } and publishes nothing.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, fstatSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { publish } from "../../pantheon/src/board/dag.mjs";
import { boardState } from "../../pantheon/src/board/controller.mjs";

export const RECEIPT_KIND = "ophanim.worker-handoff.receipt";
export const RECEIPT_MAX_BYTES = 64 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const RECEIPT_KEYS = ["kind", "v", "ticket", "base", "candidate", "changed_paths", "generations", "containment"];
const HASH = /^[0-9a-f]{64}$/;

const no = (code, why, extra = {}) => ({ ok: false, code, why, ...extra });
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Git, run by the controller against its own repository: no shell, a finite deadline, a bounded output,
 *  and none of the caller's environment beyond PATH (no GIT_DIR or alternates smuggled in). */
function git(repo, args) {
  try {
    return { ok: true, out: execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    }) };
  } catch (e) { return { ok: false, why: String(e.stderr || e.message).trim().split("\n")[0] }; }
}

/** The git facts the decision rests on. */
export function observeCandidate({ repo, base, candidate }) {
  for (const [name, sha] of [["base", base], ["candidate", candidate]]) {
    if (typeof sha !== "string" || !SHA.test(sha)) return no("SHA_SHAPE", `${name} must be a full 40-hex commit id; got ${JSON.stringify(sha)}`);
    const t = git(repo, ["cat-file", "-t", sha]);
    if (!t.ok || t.out.trim() !== "commit") return no("NO_COMMIT", `${name} ${sha} is not a commit in ${repo}${t.ok ? ` (it is a ${t.out.trim()})` : `: ${t.why}`}`);
  }
  const p = git(repo, ["rev-list", "--parents", "-n", "1", candidate]);
  if (!p.ok) return no("NO_COMMIT", `cannot read the parents of ${candidate}: ${p.why}`);
  const parents = p.out.trim().split(/\s+/).slice(1);
  if (parents.length !== 1 || parents[0] !== base) {
    return no("WRONG_PARENT", `candidate ${candidate} has parent(s) [${parents.join(", ")}]; this ticket requires exactly one parent, the exact base ${base}. ` +
      `A descendant of the base is not enough: intermediate commits are unreviewed and unscoped.`, { parents });
  }
  const d = git(repo, ["diff", "--name-only", "--no-renames", "-z", base, candidate]);
  if (!d.ok) return no("DIFF_FAILED", `cannot diff ${base}..${candidate}: ${d.why}`);
  const changed = d.out.split("\0").filter(Boolean).sort();
  if (!changed.length) return no("EMPTY_CANDIDATE", `candidate ${candidate} changes nothing relative to ${base}`);
  return { ok: true, parents, changed };
}

/** Read the receipt the controller observed. The root and the digest are the controller's; the bytes are
 *  only accepted if they hash to that digest. */
export function readReceipt({ root, name, sha256, maxBytes = RECEIPT_MAX_BYTES }) {
  if (typeof root !== "string" || !isAbsolute(root)) return no("RECEIPT_ROOT", "the receipt root must be an absolute, controller-owned directory");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return no("RECEIPT_DIGEST", "the controller must supply the receipt's sha256 (64 hex)");
  if (typeof name !== "string" || !name || isAbsolute(name)) return no("RECEIPT_PATH", `the receipt name must be relative to the root; got ${JSON.stringify(name)}`);
  let realRoot, real;
  try { realRoot = realpathSync(root); real = realpathSync(resolvePath(root, name)); }
  catch (e) { return no("RECEIPT_MISSING", `no receipt at ${name} under the controller root: ${e.code ?? e.message}`); }
  const rel = relative(realRoot, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) return no("RECEIPT_PATH", `${name} resolves outside the controller-owned receipt root`);
  let fd;
  try {
    fd = openSync(real, "r");
    const st = fstatSync(fd);
    if (!st.isFile()) return no("RECEIPT_PATH", `${name} is not a regular file`);
    if (st.size > maxBytes) return no("RECEIPT_TOO_LARGE", `receipt is ${st.size} bytes; the bound is ${maxBytes}`);
    const buf = Buffer.alloc(maxBytes + 1);
    const n = readSync(fd, buf, 0, maxBytes + 1, 0);
    if (n > maxBytes) return no("RECEIPT_TOO_LARGE", `receipt grew past ${maxBytes} bytes while being read`);
    const bytes = buf.subarray(0, n);
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== sha256) return no("RECEIPT_DIGEST", `receipt bytes hash to ${got}, not the controller's ${sha256}`);
    let json;
    try { json = JSON.parse(bytes.toString("utf8")); } catch (e) { return no("RECEIPT_SHAPE", `receipt is not JSON: ${e.message}`); }
    return { ok: true, receipt: json, sha256: got, bytes: n };
  } finally { if (fd !== undefined) closeSync(fd); }
}

const hasEnvKey = v => v && typeof v === "object" &&
  Object.entries(v).some(([k, x]) => /^env(ironment)?$/i.test(k) || hasEnvKey(x));

/**
 * A probe's outcome is DERIVED, never labelled: { path, exit, before, after } where before/after are the
 * sha256 of the file's bytes (null when absent). Exit 0 with the bytes changed is "allowed"; a non-zero exit
 * with the bytes unchanged is "refused"; anything else (exit 0 and nothing changed, or a failure that still
 * changed the file) contradicts itself and is refused as evidence.
 */
export function probeOutcome(p) {
  if (!p || typeof p.path !== "string" || !p.path || !Number.isInteger(p.exit) ||
      !(p.before === null || HASH.test(p.before)) || !(p.after === null || HASH.test(p.after))) {
    return no("RECEIPT_CONTAINMENT", `a probe is { path, exit: integer, before, after: sha256|null }; got ${JSON.stringify(p)}`);
  }
  const changed = p.before !== p.after;
  if (p.exit === 0 && changed) return { ok: true, outcome: "allowed" };
  if (p.exit !== 0 && !changed) return { ok: true, outcome: "refused" };
  return no("RECEIPT_CONTAINMENT", `probe ${p.path} contradicts itself: exit ${p.exit} with the file ${changed ? "changed" : "unchanged"}`);
}

const digestOf = f => existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : null;

/**
 * The controller's own observation of a box: one real write per path, each in a fresh bwrap box that
 * mounts the host read-only, unshares the network, and binds ONLY `scope` writable under `root`. The
 * recorded exit and the bytes before and after are what probeOutcome() reads. `network` records the flag
 * this function itself passed, not a claim from anyone else.
 */
export function observeContainment({ root, scope, probe }) {
  const binds = scope.flatMap(p => ["--bind", resolvePath(root, p), resolvePath(root, p)]);
  const probes = probe.map(path => {
    const abs = resolvePath(root, path);
    const before = digestOf(abs);
    let exit;
    try {
      execFileSync("bwrap", ["--die-with-parent", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev",
        "--ro-bind", root, root, ...binds, "--", "/bin/sh", "-c", 'printf "probe\\n" >> "$1"', "probe", abs],
        { stdio: ["ignore", "ignore", "ignore"], timeout: 10_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      exit = 0;
    } catch (e) { exit = Number.isInteger(e.status) ? e.status : -1; }
    return { path, exit, before, after: digestOf(abs) };
  });
  return { tool: "bwrap", network: "unshared", probes };
}

/** The receipt must state exactly the facts the controller observed, and its own containment outcomes. */
export function checkReceipt(receipt, { ticket, base, candidate, changed, scope, generations }) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return no("RECEIPT_SHAPE", "receipt must be a JSON object");
  const keys = Object.keys(receipt);
  if (!sameSet(keys, RECEIPT_KEYS)) return no("RECEIPT_SHAPE", `receipt keys must be exactly ${RECEIPT_KEYS.join(", ")}; got ${keys.join(", ")}`);
  if (hasEnvKey(receipt)) return no("RECEIPT_ENV", "a receipt carries observed outcomes, never environment values");
  if (receipt.kind !== RECEIPT_KIND || receipt.v !== 1) return no("RECEIPT_SHAPE", `receipt kind/v must be ${RECEIPT_KIND}/1`);
  for (const [k, want] of [["ticket", ticket], ["base", base], ["candidate", candidate]]) {
    if (receipt[k] !== want) return no("RECEIPT_FACTS", `receipt ${k} is ${JSON.stringify(receipt[k])}; observed ${JSON.stringify(want)}`);
  }
  // The receipt binds the generations it was observed under. A genuine receipt from an earlier grant is a
  // receipt about that grant: when the controller re-grants, the old receipt does not carry over, whatever
  // generations the publish presents.
  const g = receipt.generations;
  if (!g || typeof g !== "object" || Array.isArray(g) || !sameSet(Object.keys(g), Object.keys(generations)) ||
      !Object.entries(generations).every(([k, v]) => g[k] === v)) {
    return no("RECEIPT_GENERATION", `receipt generations ${JSON.stringify(g)} are not the presented leases ${JSON.stringify(generations)}`);
  }
  if (!Array.isArray(receipt.changed_paths) || !sameSet(receipt.changed_paths, changed)) {
    return no("RECEIPT_FACTS", `receipt changed_paths ${JSON.stringify(receipt.changed_paths)} differ from git's ${JSON.stringify(changed)}`);
  }
  const c = receipt.containment;
  if (!c || c.tool !== "bwrap" || c.network !== "unshared" || !Array.isArray(c.probes) || !c.probes.length) {
    return no("RECEIPT_CONTAINMENT", "receipt containment must name tool bwrap, network unshared, and its probes");
  }
  const inScope = p => scope.includes(p);
  const seen = new Set();
  const outcomes = [];
  for (const p of c.probes) {
    const o = probeOutcome(p);
    if (!o.ok) return o;
    if (seen.has(p.path)) return no("RECEIPT_CONTAINMENT", `probe path ${p.path} appears twice; an allowed and a refused write must be different paths`);
    seen.add(p.path);
    if (!inScope(p.path) && o.outcome === "allowed") return no("CONTAINMENT_BREACH", `an out-of-scope write to ${p.path} exited ${p.exit} and changed the file`);
    if (inScope(p.path) && o.outcome === "refused") return no("RECEIPT_CONTAINMENT", `the in-scope write to ${p.path} was refused (exit ${p.exit}); the box did not grant the scope`);
    outcomes.push({ path: p.path, outcome: o.outcome });
  }
  if (!outcomes.some(p => inScope(p.path) && p.outcome === "allowed")) return no("RECEIPT_CONTAINMENT", "no in-scope write was observed allowed");
  if (!outcomes.some(p => !inScope(p.path) && p.outcome === "refused")) return no("RECEIPT_CONTAINMENT", "no out-of-scope write was observed refused");
  return { ok: true };
}

/**
 * Admit one external delivery.
 *
 *   board      { store, refs, runtime } and `ref`, the board ref the item lives on
 *   repo       the controller's git repository
 *   ticket     { key, base, scope: [exact git paths] }                   -- controller's
 *   holder     the seat the item and scope leases were granted to          -- controller's
 *   leases     { item: { resource, gen }, scopes: [{ resource, gen }] }    -- controller's
 *   receipt    { root, name, sha256, maxBytes? }                           -- controller's
 *   request    { ticket, candidate }                                       -- the worker's, and all it says
 *   onValidated  optional observer called after every check and before the publish (a test seam for the
 *              fence-in-the-gap case; it is given nothing it could use to change the decision)
 */
export async function admitHandoff({ board, ref, repo, ticket, holder, leases, receipt, request, onValidated = null }) {
  if (!ticket?.key || !Array.isArray(ticket.scope) || !ticket.scope.length) return no("TICKET_SHAPE", "ticket needs a key, a base and a non-empty scope");
  if (!request || request.ticket !== ticket.key) return no("WRONG_TICKET", `request names ticket ${JSON.stringify(request?.ticket)}, not ${ticket.key}`);
  const { base } = ticket, candidate = request.candidate;

  // Leases: the item, and one scope:<path> per scoped path -- no more, no fewer.
  const item = leases?.item, scopes = leases?.scopes;
  if (!item || item.resource !== `item:${ticket.key}` || !Number.isInteger(item.gen)) return no("LEASE_MISSING", `the item lease must be item:${ticket.key} with an integer gen`);
  if (!Array.isArray(scopes) || !sameSet(scopes.map(s => s?.resource), ticket.scope.map(p => `scope:${p}`)) || !scopes.every(s => Number.isInteger(s.gen))) {
    return no("LEASE_MISSING", `scope leases must be exactly ${ticket.scope.map(p => `scope:${p}`).join(", ")}, each with an integer gen`);
  }
  for (const l of [item, ...scopes]) {
    const v = board.runtime.verify({ resource: l.resource, seat_id: holder.seat_id, gen: l.gen });
    if (!v.ok) return no(v.code, v.why, { resource: l.resource });
  }

  // The board's own view of the item.
  const state = boardState({ ...board, ref });
  const it = state.items.find(i => i.key === ticket.key);
  if (!it) return no("NO_ITEM", `no work_item ${ticket.key} on ${ref}`);
  if (it.state === "done") {
    return it.candidate_commit === candidate
      ? no("REPLAY", `${ticket.key} is already done at ${candidate}; nothing to publish`, { commit: state.commit })
      : no("CONFLICT", `${ticket.key} is already done at ${it.candidate_commit}; a second candidate ${candidate} is a conflict, not an update`);
  }
  if (it.state !== "active") return no("ITEM_STATE", `${ticket.key} is ${it.state}, not active`);
  if (it.base_sha !== base) return no("WRONG_BASE", `${ticket.key} was planned at ${it.base_sha}, not ${base}`);
  if (!Array.isArray(it.write_scope) || !sameSet(it.write_scope, ticket.scope)) return no("SCOPE_MISMATCH", `${ticket.key}'s write_scope ${JSON.stringify(it.write_scope)} is not the ticket scope`);

  // Git.
  const g = observeCandidate({ repo, base, candidate });
  if (!g.ok) return g;
  const off = g.changed.filter(p => !ticket.scope.includes(p));
  if (off.length) return no("OUT_OF_SCOPE", `candidate changes ${off.join(", ")}, outside the scope`, { changed: g.changed });

  // The receipt.
  const r = readReceipt(receipt ?? {});
  if (!r.ok) return r;
  const generations = Object.fromEntries([item, ...scopes].map(l => [l.resource, l.gen]));
  const rc = checkReceipt(r.receipt, { ticket: ticket.key, base, candidate, changed: g.changed, scope: ticket.scope, generations });
  if (!rc.ok) return rc;

  if (onValidated) await onValidated({ ticket: ticket.key, candidate });

  // The native transition. `expect` pins the board head this decision was made on; `leases` makes every
  // scope generation part of the same locked landing as the item lease.
  const { cid: _cid, slot: _slot, links: _links, ...payload } = it;
  const res = await publish({ ...board, ref, author: holder, lease: item, leases: scopes, expect: state.commit,
    msg: `external delivery ${ticket.key} at ${candidate} (receipt ${r.sha256.slice(0, 12)})`,
    entries: [{ kind: "work_item", payload: { ...payload, state: "done", candidate_commit: candidate } }] });
  if (!res.ok) return no(res.code ?? "PUBLISH_REFUSED", res.why, { resource: res.resource });
  return { ok: true, commit: res.commit, candidate, changed: g.changed, receipt_sha256: r.sha256 };
}
