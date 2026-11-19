// STAGE 3: the IMPLEMENTER and its WRITE JAIL.
//
// One specialist owns the whole multi-file unit in the unit's own worktree. The turn is INJECTED (the real one is
// pipeline/turns.mjs: an Antigravity SDK session for an SDK seat, the earlier agy CLI worker for a lane; tests script
// it). The model is not trusted to stay inside its unit: after the turn the CONTROLLER reads the worktree from disk
// and enforces the jail.
//
// Inputs:  {unit, worktree, seat, ladder, turn, a2a, attempt, findings} (+ rubric, checkpoint, scratch_paths, signal,
//          control_dir, mcp_server)
// Outputs: an attempt record {status: "written" | "refused" | "failed", changed, violations, checkpoint, ...}.
//   written  the turn's changes are all inside owned_paths and are committed as the unit's new checkpoint;
//   refused  the write jail found a violation: the offending paths are listed and EVERYTHING the turn wrote is
//            discarded (the worktree is reset to the checkpoint it started from);
//   failed   the turn itself threw; whatever it left behind is discarded the same way. A throw that carries
//            code "quota_exhausted" (code QUOTA_EXHAUSTED here), code "model_unavailable" (the provider does not serve
//            the model: code MODEL_UNAVAILABLE) or code "lane_failure" with a `kind` in timeout | exit | stream | spawn
//            (code LANE_FAILURE) is a LANE failure: the record carries `lane_failure: {kind, cause, why, status}` and
//            the controller (index.mjs) applies the failover ladder instead of spending a revision. A fault of the SDK
//            transport that NO rung can cure (transportBlockerOf: the provider refused the key, no key, no jail, no
//            SDK or an unqualified SDK version) is recorded with `transport_blocker: true` and its own code: the
//            controller blocks the unit on it instead of walking the ladder.
//
// AN SDK SEAT ({transport: "antigravity-sdk"}): the attempt also records `transport`, `effort` (the thinking level
// asked for) and `session` (the session's evidence, kept when it failed too: subagents, gateway, availability, usage,
// runtime, jail, tool decisions; pipeline/turns.mjs). Its subagents are the SDK's own, on gemini-4-hydrogen: the turn
// is given the unit's `allowed_subagents` as specialist TYPE names and no A2A relay.
//
// THE CALL CONTRACT of the injected implementer turn (one object):
//   {vendor, model, seat, prompt, cwd, signal, role: "implementer", unit_id, attempt,
//    a2a: {socket, token, roles, url: null} | null, env: {PANTHEON_A2A_SOCKET, PANTHEON_A2A_TOKEN, PANTHEON_A2A_ROLES,
//    PANTHEON_UNIT_ID}, sandbox: {...CAPABILITIES.implementer, owned_paths}, owned_paths, verify_cmd,
//    control_dir (controller-owned, outside the worktree, already created), mcp_server (absolute path of
//    a2a-mcp-server.mjs, the stdio MCP relay to the socket), allowed_subagents (the unit's)}
//   For an SDK seat `a2a` is null, `env` is {} and `mcp_server` is null.
//
// THE JAIL. A changed, added or deleted path (tracked, untracked or git-ignored) must match the unit's owned_paths.
// A symlink the turn created must point inside the worktree, by a relative target. No changed path may resolve,
// through a symlinked directory, outside the worktree. The turn may not move HEAD. A worktree that already TRACKS a
// symlink leaving it is refused before the turn: a write through such a link is invisible to git. Git status is not a
// complete inventory, so a PRE/POST FILESYSTEM SNAPSHOT (snapshotTree: path, type, mode, size, mtime, ctime, dev,
// inode, link count, for every entry, the `.git` pointer included, `.git` internals excluded) is compared too: a
// mode-only change, a restored write, a hard link made to a file, or a touched `.git` pointer outside owned_paths is a
// violation as well.
//
// Must never: keep any part of an attempt that broke the jail; accept the implementer's own account of what it
// changed; follow a symlink out of the worktree; run git synchronously.
import { lstat, readFile, readlink, realpath, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, clone, sha256, str } from "./util.mjs";
import { matchesOwned } from "./paths.mjs";
import { git } from "./git.mjs";
import { workerVerifyPromptLines } from "../agy/workspace.mjs";
import { VERIFY_LAUNCHER_NAME } from "../agy/jail-hook.mjs";
import { isSdkSeat, SDK_TRANSPORT } from "../antigravity/config.mjs";
import { ceilingFor, SUBAGENT_MODEL, SUBAGENT_TYPES } from "../antigravity/subagents.mjs";

/** Absolute path of the stdio MCP relay the implementer's agent launches to reach the unit's subagent shim. */
export const MCP_SERVER_PATH = fileURLToPath(new URL("./a2a-mcp-server.mjs", import.meta.url));
/** The kinds of a non-quota lane failure an implementer transport may throw (code "lane_failure"). */
export const LANE_FAILURE_KINDS = Object.freeze(["timeout", "exit", "stream", "spawn"]);

/**
 * The faults of the SDK transport that no rung of a ladder can cure: the unit blocks on them. METERED_GEMINI_DISABLED is
 * the seat's own refusal with metered Gemini spend off (route/quota-failover.mjs): every rung of the transport is billed
 * the same way, and no lane is seated in its place.
 */
export const TRANSPORT_BLOCKERS = Object.freeze(["CREDENTIAL_REFUSED", "NO_API_KEY", "SANDBOX_UNAVAILABLE", "SDK_VERSION", "SDK_UNAVAILABLE", "METERED_GEMINI_DISABLED"]);
/** The blocker code a thrown error of the SDK transport names (TRANSPORT_BLOCKERS), or null. */
export function transportBlockerOf(e) {
  if (e?.transport !== SDK_TRANSPORT) return null;
  if (e?.sdk_unavailable === true) return "SDK_UNAVAILABLE";
  return TRANSPORT_BLOCKERS.includes(e?.code) ? e.code : null;
}

/** Is `b` the same RUNG as `a`: the same seat on the same transport at the same thinking level? */
export const sameRung = (a, b) => Boolean(a && b) && a.vendor === b.vendor && a.model === b.model && (a.effort ?? null) === (b.effort ?? null) && (a.transport ?? null) === (b.transport ?? null);

/** The lane failure a thrown error names, as {kind, cause, why, status}, or null when it is not one. */
export function laneFailureOf(e) {
  const why = String(e?.message ?? e).slice(0, 500);
  if (e?.code === "quota_exhausted") return { kind: "quota", cause: "quota", why, status: e?.status ?? 429 };
  // The provider does not serve the model (the SDK transport's availability check, or a 404 mid-session): a step of
  // the ladder with its own cause on the record, never a quota refusal and never retried on the same model.
  if (e?.code === "model_unavailable") return { kind: "model_unavailable", cause: "model_unavailable", why, status: e?.status ?? 404 };
  if (e?.code === "lane_failure") return { kind: LANE_FAILURE_KINDS.includes(e?.kind) ? e.kind : "exit", cause: "lane", why, status: e?.status ?? null, ...(LANE_FAILURE_KINDS.includes(e?.kind) ? {} : { reported_kind: e?.kind ?? null }) };
  return null;
}

/**
 * The implementer's prompt. `worker_verify` (optional) is the exact command the worker may run: the unit's VERIFY
 * LAUNCHER <real control_dir>/pantheon-verify, which runs `cd '<worktree>' && <verify_cmd>` in the verify jail
 * (src/agy/verify-jail.mjs: no credential is reachable from the code the command runs). Observed on agy 1.5.10
 * (2026-11-18), run_command carries no working directory; the jail hook approves exactly that string. The GROUND TRUTH
 * line stays the plain verify_cmd: the controller's own run (in the same kind of jail).
 */
export function IMPLEMENTER_PROMPT({ unit, rubric, a2a = null, attempt = 1, findings = [], worker_verify = null, seat = null }) {
  const subs = unit.allowed_subagents ?? [];
  // AN SDK SEAT's subagents are the SDK's own (owner direction 2026-11-19): specialist types the controller pins to
  // gemini-4-hydrogen, within the ceiling of the implementer model in use. The controller enforces both; this says so.
  const native = isSdkSeat(seat);
  const types = native ? subs.filter(n => Object.hasOwn(SUBAGENT_TYPES, n)) : [], ceiling = native ? ceilingFor(seat.model) : 0;
  const subagents = !native
    ? (subs.length && a2a
      ? [`SUBAGENTS: you may ask a specialist ONE stateless question at a time (it has no tools, no files and no memory). Allowed roles: ${subs.join(", ")}.`,
         "  Use the MCP tool `ask_subagent` of the server `pantheon-subagents` with {\"role\": \"<one of the roles above>\", \"question\": \"<your question>\"}.",
         "  The answer is the tool result's `answer` field. Calls and bytes are bounded; an answer is advice, and what you write is yours."].join("\n")
      : "SUBAGENTS: none are allowed for this unit.")
    : !types.length ? "SUBAGENTS: none are allowed for this unit."
    : ceiling < 1 ? `SUBAGENTS: none in this session (a ${seat.model} implementer delegates to no subagent). Do the work yourself.`
    : [`SUBAGENTS: you may delegate a specific assignment to a specialist with the tool \`invoke_subagent\`. Types allowed for this unit: ${types.join(", ")}.`,
       `  At most ${ceiling} may be live in this session. That is a ceiling, not a target: start one only when you have a specific, bounded assignment for it, and give an idle one its next task instead of starting another.`,
       `  Each runs on ${SUBAGENT_MODEL} in this same worktree. A type that reads cannot write; a type that writes may write only the paths you own. What a subagent writes is part of your change: you answer for all of it.`].join("\n");
  return [
    `ROLE: ${unit.specialist_role} — the single implementer of work unit "${unit.unit_id}" (difficulty: ${unit.difficulty}). You own this whole unit: its types, its implementation and its tests, together, in one change.`,
    "",
    "YOUR WORKING DIRECTORY is an isolated git worktree that already contains the merged results of the units this one depends on. Work only there.",
    "",
    "PATHS YOU OWN (the only paths you may create, change or delete; anything else you touch is detected from disk and the whole attempt is discarded):",
    ...unit.owned_paths.map(p => `- ${p}`),
    "Do not commit, do not move HEAD, do not create symlinks that leave the worktree, do not edit files outside the list above — not even to fix something you believe is wrong there. Say so in your final message instead.",
    "",
    "INVARIANTS (must hold when you finish):",
    ...unit.invariants.map(i => `- ${i}`),
    "",
    "ACCEPTANCE RUBRIC (frozen; a reviewer will check each line against your diff and the command output):",
    ...rubric.map((c, i) => `${i + 1}. ${c}`),
    "",
    ...workerVerifyPromptLines(worker_verify),
    "GROUND TRUTH: the controller will run this command in your worktree after you finish; its exit code decides, not your report:",
    `  ${unit.verify_cmd}`,
    worker_verify ? "Run the VERIFY COMMAND above yourself before you stop." : "Run it yourself before you stop.",
    "",
    subagents,
    "",
    attempt > 1 || findings.length
      ? `THIS IS ATTEMPT ${attempt}. Your earlier work is in the worktree. Address every finding below; do not start over unless a finding requires it.\n${findings.map(f => `- ${f}`).join("\n")}`
      : "",
    "When you are done, finish with a short plain-text note of what you changed. It is not evidence and is not shown to the reviewer.",
  ].filter(l => l !== "").join("\n");
}

async function walk(root, rel, out) {
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const p = `${rel}/${e.name}`;
    if (e.isDirectory() && !e.isSymbolicLink()) await walk(root, p, out); else out.push(p);
  }
}
const inside = (root, p) => p === root || p.startsWith(root + sep);

/**
 * THE PRE/POST FILESYSTEM SNAPSHOT of a worktree (independent review round 2, assignment 4 (OpenAI gpt-6-astra,
 * 77480d6), question 6: git status misses a mode-only change that keeps the executable bit, directory metadata, a write
 * later restored to the original bytes, a hard link made to a file, and the linked worktree's `.git` pointer file).
 * {<relative path>: {type, mode, size, mtime_ms, ctime_ms, dev, ino, nlink, link?}} for every entry under the
 * worktree, the `.git` entry itself included (the pointer file of a linked worktree, or the directory's own metadata)
 * but nothing inside a `.git` directory (git's own internals, which the controller's own git commands rewrite).
 * ctime is the one a process cannot set back: a write restored to its original bytes and mtime still changes it.
 */
export async function snapshotTree(worktree, { hashIf = () => false } = {}) {
  const root = await realpath(worktree), out = {};
  const rec = (st, extra = {}) => ({ type: st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "other",
    mode: st.mode, size: st.isDirectory() ? null : st.size, mtime_ms: st.mtimeMs, ctime_ms: st.ctimeMs, dev: st.dev, ino: st.ino, nlink: st.nlink, ...extra });
  const visit = async rel => {
    const abs = rel ? join(root, rel) : root;
    const st = await lstat(abs).catch(() => null);
    if (!st) return;
    // `hashIf(rel)` (the owned paths, in runImplementer): a content hash too, so an owned file's bytes are on record.
    const hash = st.isFile() && rel && hashIf(rel) ? sha256(await readFile(abs).catch(() => Buffer.alloc(0))) : undefined;
    out[rel || "."] = rec(st, { ...(st.isSymbolicLink() ? { link: await readlink(abs).catch(() => null) } : {}), ...(hash ? { hash } : {}) });
    if (!st.isDirectory() || (rel && rel.split("/").at(-1) === ".git")) return;
    for (const e of (await readdir(abs).catch(() => [])).sort()) await visit(rel ? `${rel}/${e}` : e);
  };
  await visit("");
  return out;
}
/** Is the entry's change a side effect of its children changing (a directory's mtime/ctime/nlink), not a write to it? */
const dirSideEffect = (a, b) => a.type === "dir" && b.type === "dir" && a.mode === b.mode && a.dev === b.dev && a.ino === b.ino;
const sameEntry = (a, b) => a.type === b.type && a.mode === b.mode && a.size === b.size && a.mtime_ms === b.mtime_ms && a.ctime_ms === b.ctime_ms
  && a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink && (a.link ?? null) === (b.link ?? null) && (!a.hash || !b.hash || a.hash === b.hash);
/**
 * What the snapshots say changed: [{path, state: "added" | "deleted" | "metadata" | "modified", what: [fields]}].
 * A directory whose only change is its timestamps or link count (its children changed) is not listed; a NEW directory
 * is listed only when nothing below it is listed (an empty directory git cannot see).
 */
export function snapshotChanges(before, after) {
  const out = [];
  for (const p of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort()) {
    const a = before?.[p], b = after?.[p];
    if (p === ".") { if (a && b && a.mode !== b.mode) out.push({ path: p, state: "metadata", what: ["mode"] }); continue; }
    if (a && b) {
      if (sameEntry(a, b) || dirSideEffect(a, b)) continue;
      const what = ["type", "mode", "size", "mtime_ms", "ctime_ms", "dev", "ino", "nlink", "link", ...(a.hash && b.hash ? ["hash"] : [])].filter(k => (a[k] ?? null) !== (b[k] ?? null));
      out.push({ path: p, state: what.some(k => k === "size" || k === "mtime_ms" || k === "type" || k === "ino" || k === "link" || k === "hash") ? "modified" : "metadata", what });
    } else out.push({ path: p, state: a ? "deleted" : "added", what: [] });
  }
  return out.filter(c => !(c.state === "added" && after[c.path].type === "dir" && out.some(o => o.path.startsWith(`${c.path}/`))));
}

/**
 * Read what a turn changed, FROM DISK, against `checkpoint`, and judge it against `owned_paths`.
 * `scratch_paths` are patterns for tool droppings the controller is told in advance to delete rather than count
 * (injected, default none); what was deleted is listed, never hidden.
 * `before` (optional): snapshotTree(worktree) taken before the turn; every entry the pre/post snapshot comparison says
 * changed (snapshotChanges) is judged too, so a change git status cannot see is still a violation outside owned_paths
 * (code OUTSIDE_OWNED, state "metadata" / "modified" / "added" / "deleted"; the `.git` entry is never owned: code
 * GIT_POINTER_CHANGED).
 * Returns {ok, changed: [{path, state}], violations: [{path, code, why}], scratch_discarded: [path]}, each sorted.
 */
export async function inspectWrites({ worktree, owned_paths, checkpoint, scratch_paths = [], before = null }) {
  const root = await realpath(worktree);
  const violations = [], changed = new Map(), scratch_discarded = [];
  const head = (await git(worktree, ["rev-parse", "HEAD"])).trim();
  if (head !== checkpoint) {
    violations.push({ path: "HEAD", code: "HEAD_MOVED", why: `the turn moved HEAD from ${checkpoint} to ${head}: the implementer does not commit` });
    const names = await git(worktree, ["diff", "--name-only", "--no-renames", "-z", checkpoint, head], { allowFail: true });
    for (const p of names.stdout.split("\0").filter(Boolean)) changed.set(p, "committed");
  }
  const status = await git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--no-renames"]);
  for (const entry of status.split("\0").filter(Boolean)) {
    const xy = entry.slice(0, 2), p = entry.slice(3);
    const state = xy === "??" ? "added" : xy === "!!" ? "added_ignored" : xy.includes("D") ? "deleted" : xy.includes("A") ? "added" : "modified";
    if (p.endsWith("/")) { const files = []; await walk(root, p.slice(0, -1), files); for (const f of files) changed.set(f, state); }
    else changed.set(p, state);
  }
  // What git cannot see: the pre/post snapshot (see snapshotTree). A path git already listed keeps git's state.
  const snapOnly = new Map();
  if (before) {
    for (const c of snapshotChanges(before, await snapshotTree(worktree, { hashIf: p => matchesOwned(p, owned_paths) }))) {
      if (c.path === ".git") { violations.push({ path: ".git", code: "GIT_POINTER_CHANGED", why: `the worktree's .git entry changed (${c.state}${c.what.length ? `: ${c.what.join(", ")}` : ""}): a turn never touches it` }); continue; }
      if (c.path === ".") { violations.push({ path: ".", code: "OUTSIDE_OWNED", why: `the worktree root's mode changed: it is never owned` }); continue; }
      if (!changed.has(c.path)) { changed.set(c.path, c.state); snapOnly.set(c.path, c); }
    }
  }
  for (const [p] of [...changed]) if (scratch_paths.length && matchesOwned(p, scratch_paths)) {
    await rm(join(root, p), { recursive: true, force: true });
    changed.delete(p); scratch_discarded.push(p);
  }
  for (const [p] of changed) {
    const snap = snapOnly.get(p);
    // A new directory (snapshot-only) is owned when a path under it could be: an empty dir src/a/new under src/a/**.
    const owned = matchesOwned(p, owned_paths) || (snap?.state === "added" && before && matchesOwned(`${p}/x`, owned_paths));
    if (!owned) { violations.push({ path: p, code: "OUTSIDE_OWNED", why: `${p} is not matched by the unit's owned_paths${snap ? ` (seen by the filesystem snapshot, not by git: ${snap.state}${snap.what.length ? ` ${snap.what.join(", ")}` : ""})` : ""}` }); continue; }
    const abs = join(root, p);
    const parent = await realpath(dirname(abs)).catch(() => null);
    if (parent && !inside(root, parent)) { violations.push({ path: p, code: "RESOLVES_OUTSIDE", why: `${p} resolves through a symlinked directory to ${parent}, outside the worktree` }); continue; }
    const st = await lstat(abs).catch(() => null);
    if (st?.isSymbolicLink()) {
      const target = await readlink(abs);
      const lexical = resolve(dirname(abs), target);
      const real = await realpath(abs).catch(() => null);
      if (isAbsolute(target)) violations.push({ path: p, code: "SYMLINK_ESCAPE", why: `${p} is a symlink to the absolute path ${target}` });
      else if (!inside(root, lexical) || (real && !inside(root, real))) violations.push({ path: p, code: "SYMLINK_ESCAPE", why: `${p} is a symlink to ${target}, which leaves the worktree (${relative(root, real ?? lexical)})` });
    }
  }
  const order = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { ok: !violations.length, changed: [...changed].map(([path, state]) => ({ path, state })).sort(order), violations: violations.sort(order), scratch_discarded: scratch_discarded.sort() };
}

/** Tracked symlinks of the worktree that resolve outside it: [{path, code: "SYMLINK_ESCAPE_TRACKED", why}], sorted. */
export async function preexistingEscapes(worktree) {
  const root = await realpath(worktree), out = [];
  const listed = await git(worktree, ["ls-files", "-s", "-z"]);
  for (const entry of listed.split("\0").filter(e => e.startsWith("120000 "))) {
    const p = entry.slice(entry.indexOf("\t") + 1), abs = join(root, p);
    const target = await readlink(abs).catch(() => null);
    if (target === null) continue;
    const real = await realpath(abs).catch(() => null);
    if (isAbsolute(target) || !inside(root, resolve(dirname(abs), target)) || (real && !inside(root, real))) out.push({ path: p, code: "SYMLINK_ESCAPE_TRACKED", why: `${p} is a tracked symlink to ${target}, which leaves the worktree` });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Discard everything in the worktree that is not `checkpoint`: tracked changes, untracked and ignored files, and a moved HEAD. */
export async function discardWrites({ worktree, checkpoint }) {
  await git(worktree, ["reset", "-q", "--hard", checkpoint]);
  await git(worktree, ["clean", "-ffdxq"]);
}

/** Commit the (jail-checked) worktree as the unit's next checkpoint. Returns the new HEAD (unchanged if nothing changed). */
export async function checkpointWrites({ worktree, message }) {
  await git(worktree, ["add", "-A", "-f", "--", "."]);
  const staged = await git(worktree, ["diff", "--cached", "--quiet"], { allowFail: true });
  if (staged.code !== 0) await git(worktree, ["commit", "--no-verify", "-q", "-m", message]);
  return (await git(worktree, ["rev-parse", "HEAD"])).trim();
}

/**
 * One implementer attempt on one unit.
 *   unit      the dispatched unit (specialist_role and difficulty as the dispatcher fixed them)
 *   seat      the seat asked this attempt; `ladder` its escalation ladder (recorded; the controller picks the rung)
 *   turn(<THE CALL CONTRACT in the header>) -> {text, served_model, served_model_source?, quota_failover?}
 *   a2a       {socket, token, roles} of the unit's subagent shim, or null
 *   control_dir  the unit's controller-owned directory (outside the worktree); mcp_server the relay's path
 *   verify_jail  {hide}: what the unit's verify jail hides beyond its defaults (passed to the turn as verify_hide)
 *   findings  the findings this attempt must address (empty on the first)
 *   rubric    the frozen rubric (default unit.rubric); checkpoint: the commit the attempt starts from (default HEAD)
 */
export async function runImplementer({ unit, worktree, seat, ladder = [seat], turn, a2a = null, attempt = 1, findings = [], rubric = unit.rubric, checkpoint = null, scratch_paths = [], signal = null, control_dir = null, mcp_server = MCP_SERVER_PATH, verify_jail = null, deadline = null }) {
  const start = checkpoint ?? (await git(worktree, ["rev-parse", "HEAD"])).trim();
  const native = isSdkSeat(seat);
  const level = ladder.findIndex(s => sameRung(s, seat));
  const rec = { n: attempt, role: "implementer", standing: "author", authored: true, vendor: seat.vendor, model: seat.model, ...(native ? { transport: seat.transport, effort: seat.effort ?? null } : {}),
    level: level < 0 ? null : level, requested_model: seat.model, served_model: null, served_model_source: null,
    status: "failed", code: null, why: null, findings_in: findings.length, changed: [], violations: [], scratch_discarded: [], started_from: start, checkpoint: start, text_digest: null };
  if (native) a2a = null;   // an SDK seat has no A2A relay: its subagents are the SDK's own
  // The worker's command is the unit's verify launcher in the REAL control dir: prepareWorkerWorkspace writes it there
  // and the same string into jail.json. Without a control dir (an older caller) the prompt names no command.
  const worker_verify = typeof unit.verify_cmd === "string" && unit.verify_cmd.trim() && control_dir ? join(await realpath(control_dir), VERIFY_LAUNCHER_NAME) : null;
  const prompt = IMPLEMENTER_PROMPT({ unit, rubric, a2a, attempt, findings, worker_verify, seat });
  rec.prompt_digest = sha256(a2a ? prompt.split(a2a.token).join("<token>") : prompt);   // the digest must not depend on the secret
  // A tracked symlink that already leaves the worktree makes the jail unenforceable: a write THROUGH it lands outside
  // the worktree, where git — and so the controller — cannot see it. Refused before the turn is asked.
  const escapes = await preexistingEscapes(worktree);
  if (escapes.length) return Object.assign(rec, { status: "refused", code: "JAIL_UNENFORCEABLE", violations: escapes,
    why: `write jail cannot be enforced: the worktree tracks symlink(s) that leave it (${escapes.map(v => v.path).join(", ")}); no turn was asked` });
  // The pre-turn filesystem snapshot: the post-turn jail compares against it as well as against git (see snapshotTree).
  const before = await snapshotTree(worktree, { hashIf: p => matchesOwned(p, unit.owned_paths) });
  let out;
  try {
    const roles = a2a ? [...(a2a.roles ?? unit.allowed_subagents ?? [])] : [];
    out = await turn({ vendor: seat.vendor, model: seat.model, seat: clone(seat), prompt, cwd: worktree, signal,
      a2a: a2a ? { socket: a2a.socket, token: a2a.token, roles, url: null } : null,
      env: a2a ? { PANTHEON_A2A_SOCKET: a2a.socket, PANTHEON_A2A_TOKEN: a2a.token, PANTHEON_A2A_ROLES: roles.join(","), PANTHEON_UNIT_ID: unit.unit_id } : {},
      sandbox: { ...CAPABILITIES.implementer, owned_paths: [...unit.owned_paths] }, owned_paths: [...unit.owned_paths], verify_cmd: unit.verify_cmd,
      control_dir, mcp_server: native ? null : mcp_server, allowed_subagents: [...(unit.allowed_subagents ?? [])], role: "implementer", unit_id: unit.unit_id, attempt,
      ...(verify_jail?.hide?.length ? { verify_hide: [...verify_jail.hide] } : {}), ...(Number.isFinite(deadline) ? { deadline } : {}) });
  } catch (e) {
    await discardWrites({ worktree, checkpoint: start });
    if (e?.quota_failover) rec.quota_failover = clone(e.quota_failover);
    if (e?.session) rec.session = clone(e.session);   // what an SDK session recorded up to its failure
    // A fault no rung can cure: the unit blocks on it (index.mjs), with the transport's own code.
    const blocker = transportBlockerOf(e);
    if (blocker) return Object.assign(rec, { code: blocker, transport_blocker: true, why: `the implementer transport cannot run (${blocker}): ${String(e?.message ?? e).slice(0, 500)}` });
    const lane = laneFailureOf(e);
    if (lane) return Object.assign(rec, { code: lane.cause === "quota" ? "QUOTA_EXHAUSTED" : lane.cause === "model_unavailable" ? "MODEL_UNAVAILABLE" : "LANE_FAILURE",
      lane_failure: lane, why: `the implementer lane ${seat.model} failed (${lane.kind}): ${lane.why}` });
    // THE MODEL GUARD (L-504 invariant 3; board/agy-cli.mjs AGY_MODEL_MISMATCH): the lane's CLI started on another agent or
    // model. Kept under its own code with both identities (not TURN_FAILED), never a lane failure: no ladder step.
    if (e?.code === "AGY_MODEL_MISMATCH") return Object.assign(rec, { code: "AGY_MODEL_MISMATCH", identity: e.identity ?? null, why: `the implementer lane ${seat.model} was refused by the model guard: ${String(e?.message ?? e)}` });
    return Object.assign(rec, { code: e?.code === "PROVIDER_LIMIT" ? "PROVIDER_LIMIT" : "TURN_FAILED", why: `the implementer turn failed: ${String(e?.message ?? e)}` });
  }
  rec.text_digest = typeof out?.text === "string" ? sha256(out.text) : null;
  rec.served_model = str(out?.served_model) ? out.served_model : null;   // an author's unnamed served model is recorded as unnamed, not guessed
  rec.served_model_source = out?.served_model_source ?? null;
  // A transport that fell over from an Antigravity lane to the metered API of the same base model says so; kept as said.
  if (out?.quota_failover) rec.quota_failover = clone(out.quota_failover);
  if (out?.session) rec.session = clone(out.session);   // an SDK session's evidence (pipeline/turns.mjs)

  const jail = await inspectWrites({ worktree, owned_paths: unit.owned_paths, checkpoint: start, scratch_paths, before });
  Object.assign(rec, { changed: jail.changed, violations: jail.violations, scratch_discarded: jail.scratch_discarded });
  if (!jail.ok) {
    await discardWrites({ worktree, checkpoint: start });
    return Object.assign(rec, { status: "refused", code: "WRITE_JAIL", why: `write jail: ${jail.violations.map(v => `${v.path} (${v.code})`).join(", ")}; the attempt's changes were discarded` });
  }
  rec.checkpoint = await checkpointWrites({ worktree, message: `pantheon pipeline: unit ${unit.unit_id} attempt ${attempt}` });
  rec.status = "written";
  return rec;
}
