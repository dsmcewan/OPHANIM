// STAGE 3: the IMPLEMENTER and its WRITE JAIL.
//
// One specialist owns the whole multi-file unit in the unit's own worktree. The turn is INJECTED (the real one is
// the multi-turn agy CLI transport; tests script it). The model is not trusted to stay inside its unit: after the
// turn the CONTROLLER reads the worktree from disk and enforces the jail.
//
// Inputs:  {unit, worktree, seat, ladder, turn, a2a, attempt, findings} (+ rubric, checkpoint, scratch_paths, signal,
//          control_dir, mcp_server)
// Outputs: an attempt record {status: "written" | "refused" | "failed", changed, violations, checkpoint, ...}.
//   written  the turn's changes are all inside owned_paths and are committed as the unit's new checkpoint;
//   refused  the write jail found a violation: the offending paths are listed and EVERYTHING the turn wrote is
//            discarded (the worktree is reset to the checkpoint it started from);
//   failed   the turn itself threw; whatever it left behind is discarded the same way. A throw that carries
//            code "quota_exhausted" (code QUOTA_EXHAUSTED here) or code "lane_failure" with a `kind` in
//            timeout | exit | stream | spawn (code LANE_FAILURE) is a LANE failure: the record carries
//            `lane_failure: {kind, cause, why, status}` and the controller (index.mjs) applies the failover ladder
//            instead of spending a revision.
//
// THE CALL CONTRACT of the injected implementer turn (one object):
//   {vendor, model, seat, prompt, cwd, signal, role: "implementer", unit_id, attempt,
//    a2a: {socket, token, roles, url: null} | null, env: {PANTHEON_A2A_SOCKET, PANTHEON_A2A_TOKEN, PANTHEON_A2A_ROLES,
//    PANTHEON_UNIT_ID}, sandbox: {...CAPABILITIES.implementer, owned_paths}, owned_paths, verify_cmd,
//    control_dir (controller-owned, outside the worktree, already created), mcp_server (absolute path of
//    a2a-mcp-server.mjs, the stdio MCP relay to the socket)}
//
// THE JAIL. A changed, added or deleted path (tracked, untracked or git-ignored) must match the unit's owned_paths.
// A symlink the turn created must point inside the worktree, by a relative target. No changed path may resolve,
// through a symlinked directory, outside the worktree. The turn may not move HEAD. A worktree that already TRACKS a
// symlink leaving it is refused before the turn: a write through such a link is invisible to git.
//
// Must never: keep any part of an attempt that broke the jail; accept the implementer's own account of what it
// changed; follow a symlink out of the worktree; run git synchronously.
import { lstat, readlink, realpath, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, clone, sha256, str } from "./util.mjs";
import { matchesOwned } from "./paths.mjs";
import { git } from "./git.mjs";

/** Absolute path of the stdio MCP relay the implementer's agent launches to reach the unit's subagent shim. */
export const MCP_SERVER_PATH = fileURLToPath(new URL("./a2a-mcp-server.mjs", import.meta.url));
/** The kinds of a non-quota lane failure an implementer transport may throw (code "lane_failure"). */
export const LANE_FAILURE_KINDS = Object.freeze(["timeout", "exit", "stream", "spawn"]);

/** The lane failure a thrown error names, as {kind, cause, why, status}, or null when it is not one. */
export function laneFailureOf(e) {
  const why = String(e?.message ?? e).slice(0, 500);
  if (e?.code === "quota_exhausted") return { kind: "quota", cause: "quota", why, status: e?.status ?? 429 };
  if (e?.code === "lane_failure") return { kind: LANE_FAILURE_KINDS.includes(e?.kind) ? e.kind : "exit", cause: "lane", why, status: e?.status ?? null, ...(LANE_FAILURE_KINDS.includes(e?.kind) ? {} : { reported_kind: e?.kind ?? null }) };
  return null;
}

export function IMPLEMENTER_PROMPT({ unit, rubric, a2a = null, attempt = 1, findings = [] }) {
  const subs = unit.allowed_subagents ?? [];
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
    "GROUND TRUTH: the controller will run this command in your worktree after you finish; its exit code decides, not your report:",
    `  ${unit.verify_cmd}`,
    "Run it yourself before you stop.",
    "",
    subs.length && a2a
      ? [`SUBAGENTS: you may ask a specialist ONE stateless question at a time (it has no tools, no files and no memory). Allowed roles: ${subs.join(", ")}.`,
         "  Use the MCP tool `ask_subagent` of the server `pantheon-subagents` with {\"role\": \"<one of the roles above>\", \"question\": \"<your question>\"}.",
         "  The answer is the tool result's `answer` field. Calls and bytes are bounded; an answer is advice, and what you write is yours."].join("\n")
      : "SUBAGENTS: none are allowed for this unit.",
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
 * Read what a turn changed, FROM DISK, against `checkpoint`, and judge it against `owned_paths`.
 * `scratch_paths` are patterns for tool droppings the controller is told in advance to delete rather than count
 * (injected, default none); what was deleted is listed, never hidden.
 * Returns {ok, changed: [{path, state}], violations: [{path, code, why}], scratch_discarded: [path]}, each sorted.
 */
export async function inspectWrites({ worktree, owned_paths, checkpoint, scratch_paths = [] }) {
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
  for (const [p] of [...changed]) if (scratch_paths.length && matchesOwned(p, scratch_paths)) {
    await rm(join(root, p), { recursive: true, force: true });
    changed.delete(p); scratch_discarded.push(p);
  }
  for (const [p] of changed) {
    if (!matchesOwned(p, owned_paths)) { violations.push({ path: p, code: "OUTSIDE_OWNED", why: `${p} is not matched by the unit's owned_paths` }); continue; }
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
 *   findings  the findings this attempt must address (empty on the first)
 *   rubric    the frozen rubric (default unit.rubric); checkpoint: the commit the attempt starts from (default HEAD)
 */
export async function runImplementer({ unit, worktree, seat, ladder = [seat], turn, a2a = null, attempt = 1, findings = [], rubric = unit.rubric, checkpoint = null, scratch_paths = [], signal = null, control_dir = null, mcp_server = MCP_SERVER_PATH }) {
  const start = checkpoint ?? (await git(worktree, ["rev-parse", "HEAD"])).trim();
  const level = ladder.findIndex(s => s.vendor === seat.vendor && s.model === seat.model);
  const rec = { n: attempt, role: "implementer", standing: "author", authored: true, vendor: seat.vendor, model: seat.model, level: level < 0 ? null : level, requested_model: seat.model, served_model: null, served_model_source: null,
    status: "failed", code: null, why: null, findings_in: findings.length, changed: [], violations: [], scratch_discarded: [], started_from: start, checkpoint: start, text_digest: null };
  const prompt = IMPLEMENTER_PROMPT({ unit, rubric, a2a, attempt, findings });
  rec.prompt_digest = sha256(a2a ? prompt.split(a2a.token).join("<token>") : prompt);   // the digest must not depend on the secret
  // A tracked symlink that already leaves the worktree makes the jail unenforceable: a write THROUGH it lands outside
  // the worktree, where git — and so the controller — cannot see it. Refused before the turn is asked.
  const escapes = await preexistingEscapes(worktree);
  if (escapes.length) return Object.assign(rec, { status: "refused", code: "JAIL_UNENFORCEABLE", violations: escapes,
    why: `write jail cannot be enforced: the worktree tracks symlink(s) that leave it (${escapes.map(v => v.path).join(", ")}); no turn was asked` });
  let out;
  try {
    const roles = a2a ? [...(a2a.roles ?? unit.allowed_subagents ?? [])] : [];
    out = await turn({ vendor: seat.vendor, model: seat.model, seat: clone(seat), prompt, cwd: worktree, signal,
      a2a: a2a ? { socket: a2a.socket, token: a2a.token, roles, url: null } : null,
      env: a2a ? { PANTHEON_A2A_SOCKET: a2a.socket, PANTHEON_A2A_TOKEN: a2a.token, PANTHEON_A2A_ROLES: roles.join(","), PANTHEON_UNIT_ID: unit.unit_id } : {},
      sandbox: { ...CAPABILITIES.implementer, owned_paths: [...unit.owned_paths] }, owned_paths: [...unit.owned_paths], verify_cmd: unit.verify_cmd,
      control_dir, mcp_server, role: "implementer", unit_id: unit.unit_id, attempt });
  } catch (e) {
    await discardWrites({ worktree, checkpoint: start });
    if (e?.quota_failover) rec.quota_failover = clone(e.quota_failover);
    const lane = laneFailureOf(e);
    if (lane) return Object.assign(rec, { code: lane.cause === "quota" ? "QUOTA_EXHAUSTED" : "LANE_FAILURE", lane_failure: lane, why: `the implementer lane ${seat.model} failed (${lane.kind}): ${lane.why}` });
    return Object.assign(rec, { code: e?.code === "PROVIDER_LIMIT" ? "PROVIDER_LIMIT" : "TURN_FAILED", why: `the implementer turn failed: ${String(e?.message ?? e)}` });
  }
  rec.text_digest = typeof out?.text === "string" ? sha256(out.text) : null;
  rec.served_model = str(out?.served_model) ? out.served_model : null;   // an author's unnamed served model is recorded as unnamed, not guessed
  rec.served_model_source = out?.served_model_source ?? null;
  // A transport that fell over from an Antigravity lane to the metered API of the same base model says so; kept as said.
  if (out?.quota_failover) rec.quota_failover = clone(out.quota_failover);

  const jail = await inspectWrites({ worktree, owned_paths: unit.owned_paths, checkpoint: start, scratch_paths });
  Object.assign(rec, { changed: jail.changed, violations: jail.violations, scratch_discarded: jail.scratch_discarded });
  if (!jail.ok) {
    await discardWrites({ worktree, checkpoint: start });
    return Object.assign(rec, { status: "refused", code: "WRITE_JAIL", why: `write jail: ${jail.violations.map(v => `${v.path} (${v.code})`).join(", ")}; the attempt's changes were discarded` });
  }
  rec.checkpoint = await checkpointWrites({ worktree, message: `pantheon pipeline: unit ${unit.unit_id} attempt ${attempt}` });
  rec.status = "written";
  return rec;
}
