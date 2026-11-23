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
 *               Its containment probes record, per disposable fixture, the in-box operation's own result, the
 *               exit and the bytes before and after; the outcome is derived from those (probeOutcome), never
 *               labelled. It must include the positive control written and an existing denial fixture refused
 *               EROFS by the in-box write itself. A missing target, a box that never started or timed out, or
 *               any other errno attests nothing.
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
 * A probe's outcome is DERIVED, never labelled. A probe is
 *   { fixture: "positive"|"denial", path, exit, before, after, inbox }
 * where before/after are the sha256 of the fixture's bytes (null when absent) and `inbox` is the in-box
 * operation's own machine-readable result -- { ran: true, result: "written" } or { ran: true, result:
 * "denied", errno } -- or null when no such result came back (bwrap never started, it timed out, or the inner
 * operation never ran). A null inbox is ABSENCE of evidence, never a denial.
 *
 *   allowed  inbox written, exit 0, the target existed before, and its bytes changed
 *   denied   inbox denied with errno EROFS (the write policy), exit 0, the target existed before, bytes unchanged
 *
 * Everything else attests nothing: a missing target ("Directory nonexistent" gives the same shell status as a
 * read-only file and must not count), ENOENT, EACCES or any other errno, a bare exit, changed bytes on a
 * denial, unchanged bytes on a write.
 */
export function probeOutcome(p) {
  const bad = why => no("RECEIPT_CONTAINMENT", `probe ${JSON.stringify(p?.path)} attests nothing: ${why}`);
  if (!p || typeof p !== "object" || !["positive", "denial"].includes(p.fixture) || typeof p.path !== "string" || !p.path ||
      !Number.isInteger(p.exit) || !(p.before === null || HASH.test(p.before)) || !(p.after === null || HASH.test(p.after)) ||
      !("inbox" in p)) {
    return bad(`a probe is { fixture: positive|denial, path, exit: integer, before, after: sha256|null, inbox }; got ${JSON.stringify(p)}`);
  }
  const ib = p.inbox;
  if (ib === null) return bad(`no in-box result (exit ${p.exit}): the box did not start, timed out, or the probe never ran`);
  if (typeof ib !== "object" || ib.ran !== true || !["written", "denied"].includes(ib.result)) return bad(`malformed in-box result ${JSON.stringify(ib)}`);
  if (p.exit !== 0) return bad(`the in-box probe exited ${p.exit}`);
  if (p.before === null) return bad("the target did not exist before the probe; only an existing fixture can show the write policy");
  const changed = p.before !== p.after;
  if (ib.result === "written") return changed ? { ok: true, outcome: "allowed" } : bad("the in-box write reported success but the bytes did not change");
  if (ib.errno !== "EROFS") return bad(`the in-box write failed with ${JSON.stringify(ib.errno)}, not the read-only write policy (EROFS)`);
  return changed ? bad("the write was reported denied but the bytes changed") : { ok: true, outcome: "denied" };
}

const digestOf = f => existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : null;
const INBOX_KEYS = { written: ["ran", "result"], denied: ["errno", "ran", "result"] };
// The in-box operation: append one line to the fixture and report what the kernel said, as one JSON line.
const PROBE_JS = 'const fs=require("fs");let r;try{const fd=fs.openSync(process.argv[1],"a");fs.writeSync(fd,"probe\\n");' +
  'fs.closeSync(fd);r={ran:true,result:"written"}}catch(e){r={ran:true,result:"denied",errno:e.code??null}}' +
  'process.stdout.write(JSON.stringify(r)+"\\n")';
function parseInbox(out) {
  const lines = String(out ?? "").split("\n").filter(Boolean);
  if (lines.length !== 1) return null;
  try {
    const r = JSON.parse(lines[0]);
    const keys = INBOX_KEYS[r?.result];
    return keys && Object.keys(r).sort().join() === keys.join() && r.ran === true ? r : null;
  } catch { return null; }
}
const fixtureName = n => typeof n === "string" && n && !isAbsolute(n) && !n.split(/[\\/]/).includes("..");

/**
 * The controller's own observation of a box, on DISPOSABLE fixtures in a scratch root of the controller's (never
 * the candidate checkout, so the probe writes no source). Each probe runs in a fresh bwrap box that mounts the
 * host read-only, unshares the network, re-binds `root` read-only and binds ONLY `positive` writable; inside,
 * the probe appends to its fixture and prints the kernel's answer. Recorded per probe: the exit, the bytes
 * before and after, and that in-box result (null when none came back). `network` is the flag this function
 * itself passed. A fixture that is not canonical (a symlink, or outside the root) is refused before any box.
 */
export function observeContainment({ root, positive, denial }) {
  if (typeof root !== "string" || !isAbsolute(root)) throw new Error("observeContainment: root must be absolute");
  const names = [positive, ...denial];
  if (!names.every(fixtureName) || new Set(names).size !== names.length) throw new Error("observeContainment: fixtures must be distinct relative names inside the root");
  for (const n of names) {
    const abs = resolvePath(root, n);
    if (existsSync(abs) && realpathSync(abs) !== abs) throw new Error(`observeContainment: ${n} is not canonical (${realpathSync(abs)})`);
  }
  const pos = resolvePath(root, positive);
  const run = (fixture, name) => {
    const abs = resolvePath(root, name);
    const before = digestOf(abs);
    let exit, out;
    try {
      out = execFileSync("bwrap", ["--die-with-parent", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev",
        "--ro-bind", root, root, "--bind", pos, pos, "--", process.execPath, "-e", PROBE_JS, abs],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer: 4096, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      exit = 0;
    } catch (e) { exit = Number.isInteger(e.status) ? e.status : -1; out = null; }
    return { fixture, path: name, exit, before, after: digestOf(abs), inbox: exit === 0 ? parseInbox(out) : null };
  };
  return { tool: "bwrap", network: "unshared", probes: [run("positive", positive), ...denial.map(n => run("denial", n))] };
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
  const seen = new Set();
  const outcomes = [];
  for (const p of c.probes) {
    const o = probeOutcome(p);
    if (!o.ok) return o;
    if (seen.has(p.path)) return no("RECEIPT_CONTAINMENT", `probe path ${p.path} appears twice; the positive control and a denial must be different fixtures`);
    seen.add(p.path);
    if (p.fixture === "denial" && o.outcome === "allowed") return no("CONTAINMENT_BREACH", `the unbound denial fixture ${p.path} was written by the in-box operation`);
    if (p.fixture === "positive" && o.outcome === "denied") return no("RECEIPT_CONTAINMENT", `the positive control ${p.path} was denied; the box did not grant the bound write`);
    outcomes.push({ fixture: p.fixture, outcome: o.outcome });
  }
  if (outcomes.filter(p => p.fixture === "positive").length !== 1 || !outcomes.some(p => p.fixture === "positive" && p.outcome === "allowed")) return no("RECEIPT_CONTAINMENT", "exactly one positive control, observed written, is required");
  if (!outcomes.some(p => p.fixture === "denial" && p.outcome === "denied")) return no("RECEIPT_CONTAINMENT", "no existing denial fixture was observed denied EROFS");
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
