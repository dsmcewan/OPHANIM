// The operating loop over the status board (docs/operating-workflow.md).
//
// Pantheon reads the AUTHORITATIVE board (the status ledger, packages/ledger/status.mjs, which must
// verify), takes the items that are dispatchable, seats a team for one, runs it through its real
// pipeline (runOpenItem: plan, work, acceptance, in-run review, ship), commits the shipped change on a
// branch, has the change reviewed by independent reviewers on distinct labs (reviewCycle, every turn and
// review on the run's ledger), and ends in an evidence bundle and an UNSIGNED status proposal.
//
// It never writes the status ledger and never needs its keys. Recording the proposal is `status.mjs
// apply`, run by the key holder (the owner, on the owner's machine).
//
// An item is dispatchable iff its latest status is Ready, every item it depends on is Resolved, and a
// valid ticket exists for it at tickets/<item>.json that has not already been applied (the latest status
// entry's evidence names a different ticket digest, or none). A ticket names one bounded slice of the
// item's work, honestly: a slice that leaves the rest of the item to do proposes Ready again, with the
// slice recorded; only a ticket that covers the whole item proposes Resolved.
//
// Every vendor SDK stays at the edge: `makeClientFor` (the seats) and `turn` (the cycle reviewers) are
// injected, as for runOpenItem and reviewCycle.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, relative, isAbsolute, dirname, basename } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { openStatusLedger, propose, proposalRefusal, proposalDigest, STATES } from "../../../packages/ledger/status.mjs";
import { digest } from "../../../packages/ledger/canonical.mjs";
import { runOpenItem } from "./run-item.mjs";
import { openBoard } from "./index.mjs";
import { cidOf } from "./canon.mjs";
import { certifiedArtifacts } from "./artifacts.mjs";
import { ticketRuntimeRefusal, ticketContainmentRefusal, normalizeSlots, isUnder } from "./ticket-safety.mjs";
import { frontierCandidates, readPools } from "../route/frontier.mjs";
import { labOf } from "../config/models.mjs";
import { TOKEN_TIERS } from "../config/tiers.mjs";
import { taskProfile } from "../route/task-profile.mjs";
import { openPantheonLedger } from "../ledger/system.mjs";
import { reviewCycle, reviewSeats } from "../ledger/review-cycle.mjs";
import { CYCLE_CONTRACT } from "../ledger/practice-kinds.mjs";
import { closeClaim } from "../ledger/cycle-kinds.mjs";
import { evaluate, automaticAssessment, defaultEvidenceStore } from "../practice/evaluate.mjs";
import { DEFAULT_ELIGIBLE_STRATA, BASELINE_ARM, CANDIDATE_ARM, PAIR_SCHEMA, pairFor } from "../practice/assign.mjs";
import { runMetrics } from "../practice/metrics.mjs";

export const TICKET_SCHEMA = "ophanim.ticket/v1";
export const BUNDLE_SCHEMA = "pantheon.board-run/v1";
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const RUN_FIELDS = ["key", "title", "goal", "question", "repo_root", "slot", "path", "slots", "source", "copy", "attach",
  "tests_file", "acceptance_cmd", "difficulty", "constraints", "forbidden",
  // The `fit` profile's declared dimensions (src/route/task-profile.mjs). Ignored by argo and legacy.
  "depth", "output", "stakes", "ambiguity", "latency", "kind"];
const TICKET_FIELDS = ["schema", "item", "slice", "proposes", ...RUN_FIELDS];
const ROLES = ["scout", "planner", "implementer", "reviewer"];
const fail = (why, code = "BOARD_REFUSED") => { throw Object.assign(new Error(why), { code }); };
const str = v => typeof v === "string" && v.trim() !== "";
const sha256 = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
export const today = () => new Date().toISOString().slice(0, 10);

export const defaultStatusRoot = repo => resolve(process.env.OPHANIM_STATUS_LEDGER ?? join(repo, "status", "ledger"));
export const ticketPath = (repo, item) => join(repo, "tickets", `${item}.json`);

/** The verified board: the latest status of every item, from a status ledger that verifies. */
export function readBoard({ statusRoot, anchor = null }) {
  return openStatusLedger({ root: statusRoot, anchor, create: false }).board();
}

/**
 * A ticket for `item`, validated: {ticket, spec, path, digest} or {why}. `spec` is what runOpenItem
 * takes, with repo_root resolved against the repository (a ticket names it relative, so it is portable).
 */
export function readTicket({ repo, item }) {
  const file = ticketPath(repo, item), rel = relative(repo, file);
  if (!existsSync(file)) return { why: `no ticket at ${rel}` };
  let t;
  try { t = JSON.parse(readFileSync(file, "utf8")); } catch (e) { return { why: `${rel} is not JSON: ${e.message}` }; }
  const why = ticketRefusal(t, { repo, item });
  if (why) return { why: `${rel}: ${why}` };
  const spec = Object.fromEntries(RUN_FIELDS.filter(k => t[k] !== undefined).map(k => [k, t[k]]));
  spec.key ??= item;
  spec.repo_root = resolve(repo, t.repo_root ?? ".");
  return { ticket: t, spec, path: rel, digest: "sha256:" + digest(t) };
}

function ticketRefusal(t, { repo, item }) {
  if (!t || typeof t !== "object" || Array.isArray(t) || t.schema !== TICKET_SCHEMA) return `a ticket is an ${TICKET_SCHEMA} object`;
  const extra = Object.keys(t).filter(k => !TICKET_FIELDS.includes(k));
  if (extra.length) return `unknown ticket field(s): ${extra.join(", ")}`;
  if (t.item !== item) return `the ticket names item "${t.item}", not "${item}"`;
  if (!str(t.slice)) return "a ticket names the slice of the item it does (slice)";
  const p = t.proposes;
  if (!p || !["Resolved", "Ready", "In progress"].includes(p.state) || !str(p.basis) || Object.keys(p).some(k => !["state", "basis"].includes(k))) {
    return "proposes names the state the item takes when the slice ships and its review closes (Resolved, Ready or In progress) and its basis";
  }
  for (const k of ["title", "goal", "question", "acceptance_cmd"]) if (!str(t[k])) return `the ticket names its ${k}`;
  if (t.repo_root !== undefined && (typeof t.repo_root !== "string" || isAbsolute(t.repo_root))) return "repo_root is relative to the repository, so the ticket is portable";
  const root = resolve(repo, t.repo_root ?? ".");
  if (!isUnder(repo, root)) return "repo_root is outside the repository";
  if (t.difficulty !== undefined && !Object.hasOwn(TOKEN_TIERS, t.difficulty)) return `difficulty is one of ${Object.keys(TOKEN_TIERS).join(", ")}`;
  try { taskProfile(t); } catch (e) { return e.message; }
  for (const k of ["constraints", "forbidden"]) if (t[k] !== undefined && !(Array.isArray(t[k]) && t[k].every(str))) return `${k} lists strings`;
  const spec = { ...t, key: t.key ?? item, repo_root: root };
  const refused = ticketRuntimeRefusal(spec) ?? ticketContainmentRefusal(spec);
  if (refused) return refused;
  for (const c of t.copy) if (!existsSync(join(root, c))) return `copy names ${c}, which is not in the repository`;
  return null;
}

/** The seats runOpenItem would put in each chair (its default routing profile), and the cycle reviewers. */
export function seatTeam({ pools = [], overrides = {} } = {}) {
  const seat = c => ({ vendor: c.vendor, model: c.model, lab: labOf(c.vendor, c.model), pool: c.pool ?? c.vendor });
  // An operator reseat (--seat role=vendor/model) is the chair's only occupant for the run, as in runOpenItem.
  const ladder = role => (overrides[role] ? [{ ...seat(overrides[role]), operator: true }] : frontierCandidates(role, { pools }).map(seat));
  const team = Object.fromEntries(ROLES.map(r => [r, ladder(r)]));
  const authors = { plan: [team.planner[0]?.lab].filter(Boolean), work: [team.implementer[0]?.lab].filter(Boolean) };
  return { ...team, cycle_reviewers: cycleReviewers({ planLabs: authors.plan, workLabs: authors.work }) };
}

/**
 * The cycle's reviewers: n labs, none of which made the change. The planner's lab is excluded too when
 * the seating table has enough labs; otherwise only the implementer's lab is, the author turns are not
 * cited (so the planner's lab may review), and the result says so.
 */
export function cycleReviewers({ planLabs = [], workLabs = [], n = 3 }) {
  const all = [...new Set([...workLabs, ...planLabs])];
  try {
    return { seats: reviewSeats({ n, avoidLabs: all }), author_labs: all, planner_excluded: true };
  } catch (e) {
    if (e.code !== "NO_SEATS") throw e;
    return { seats: reviewSeats({ n, avoidLabs: [...new Set(workLabs)] }), author_labs: [...new Set(workLabs)], planner_excluded: false,
      note: `excluding the planner's lab (${planLabs.join(", ")}) as well leaves fewer than ${n} labs: the planner's lab may review, and the author turns are not cited` };
  }
}

/** Items ordered so that an item's dependencies come before it (cycles broken by id order). */
export function dependencyOrder(items) {
  const byId = new Map(items.map(i => [i.item, i])), out = [], seen = new Set();
  const visit = (i, stack) => {
    if (seen.has(i.item) || stack.has(i.item)) return;
    stack.add(i.item);
    for (const d of [...(i.depends_on ?? [])].sort()) if (byId.has(d)) visit(byId.get(d), stack);
    stack.delete(i.item);
    seen.add(i.item);
    out.push(i);
  };
  for (const i of [...items].sort((a, b) => a.item.localeCompare(b.item))) visit(i, new Set());
  return out;
}

/** Why `item` is not dispatchable on `board`, or null; with its ticket when it is. */
export function dispatchable(board, item, { repo }) {
  const byId = new Map(board.items.map(i => [i.item, i]));
  const it = byId.get(item);
  if (!it) return { why: `"${item}" is not on the status board` };
  if (it.state !== "Ready") return { why: `its latest status is ${it.state}, not Ready` };
  const open = (it.depends_on ?? []).filter(d => byId.get(d)?.state !== "Resolved");
  if (open.length) return { why: `depends on unresolved ${open.join(", ")}` };
  const t = readTicket({ repo, item });
  if (t.why) return { why: t.why };
  if (it.evidence?.ticket?.digest === t.digest) return { why: `${t.path} (${t.ticket.slice}) is already recorded on its latest status; write the next slice's ticket` };
  return { ticket: t };
}

/** `next`: the dispatchable items, in dependency order, each with its ticket and the team it would seat. */
export function boardNext({ repo, statusRoot = defaultStatusRoot(repo), anchor = null, pools = null, overrides = {} }) {
  const board = readBoard({ statusRoot, anchor });
  const team = seatTeam({ pools: pools ?? readPools(), overrides });
  const items = [], skipped = [];
  for (const it of dependencyOrder(board.items)) {
    if (it.state !== "Ready") continue;
    const d = dispatchable(board, it.item, { repo });
    if (d.why) { skipped.push({ item: it.item, why: d.why }); continue; }
    const t = d.ticket;
    items.push({ item: it.item, title: it.title, entry: it.entry, basis: it.basis,
      ticket: { path: t.path, digest: t.digest, slice: t.ticket.slice, proposes: t.ticket.proposes, key: t.spec.key,
        files: normalizeSlots(t.spec).map(s => s.path), acceptance_cmd: t.spec.acceptance_cmd, difficulty: t.spec.difficulty ?? "medium" },
      team });
  }
  return { board: { anchor: board.anchor, head: board.head, entries: board.entries, root: statusRoot }, items, skipped };
}

// --- git, for the produced change -------------------------------------------------------------------
const gitIn = repo => (args, { input, env, encoding = "utf8" } = {}) =>
  execFileSync("git", ["-C", repo, ...args], { encoding, input, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 256 * 1024 * 1024 });

function gitTop(repo) {
  try { return gitIn(repo)(["rev-parse", "--show-toplevel"]).trim(); } catch { return fail(`${repo} is not a git repository: the produced change is committed there`); }
}

/**
 * Commit the shipped artifacts on `branch`, from `base`, without touching the working tree or the index:
 * every file's base version must be the baseline the implementer was shown (else something changed it
 * since the run started, and the commit is refused).
 */
export function commitShipped({ repo, base, files, branch, message }) {
  const git = gitIn(repo);
  const ref = `refs/heads/${branch}`;
  let exists = true;
  try { git(["rev-parse", "--verify", "--quiet", ref]); } catch { exists = false; }
  if (exists) fail(`branch ${branch} already exists; delete it or name another with --branch`);
  for (const f of files) {
    let at = null;
    try { at = git(["show", `${base}:${f.path}`], { encoding: "buffer" }); } catch { at = null; }
    if ((at !== null) !== f.baseline.exists || (at !== null && cidOf("blob", at) !== f.baseline.bytes)) {
      fail(`${f.path} at ${base.slice(0, 12)} is not what the implementer was shown; the change is not committed over it`);
    }
  }
  const index = join(tmpdir(), `pantheon-board-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(["read-tree", base], { env });
    for (const f of files) {
      const mode = git(["ls-tree", base, "--", f.path]).split(/\s/)[0] || "100644";
      const blob = git(["hash-object", "-w", "--stdin"], { input: f.contents }).trim();
      git(["update-index", "--add", "--cacheinfo", `${mode},${blob},${f.path}`], { env });
    }
    const tree = git(["write-tree"], { env }).trim();
    const commit = git(["commit-tree", tree, "-p", base, "-F", "-"], { input: message }).trim();
    git(["update-ref", ref, commit, "0".repeat(commit.length)]);
    return commit;
  } finally { rmSync(index, { force: true }); }
}

// --- the run -----------------------------------------------------------------------------------------
const turnsOf = (run, purpose) => (run.turns ?? []).filter(t => t.purpose === purpose);
// The selection policy the run actually dispatched under, from its recorded turns (audit C3): the cycle
// that reviews the run names it as the policy in effect. Null when no turn recorded one.
const runPolicy = run => {
  const s = (run?.turns ?? []).map(t => t.selection).find(x => x?.policy && x?.policy_hash && x?.profile);
  return s ? { version: s.policy, hash: s.policy_hash, profile: s.profile } : null;
};
/**
 * The cycle's practice assessment (audit C3, practice-kinds.mjs), recorded when the cycle opened under the
 * practice contract has none and the caller states one: `practice` is {outcome, question, evidence?,
 * measured?, provenance?}. Without one, the cycle stays open, as with an unresolved finding.
 */
function recordPractice(rec, cycle, practice) {
  const state = rec.cycleState(cycle);
  if (state.cycle.contract !== CYCLE_CONTRACT || !practice || state.dispositions.some(d => d.payload.stage === "assessment")) return null;
  const { outcome, question, evidence = [], measured = false, provenance = { by: { role: "lead@orch" }, method: measured ? "measured comparison" : "operator-recorded assessment, unmeasured" } } = practice;
  return rec.recordDisposition({ cycle, outcome, question, evidence, measured, provenance });
}

/** The evidence store of a bundle: where its run was deposited, else `<run ledger dir>/../runs`. */
const storeOf = bundle => bundle.evidence_store ?? join(dirname(resolve(bundle.review.ledger)), "runs");

/**
 * Every cycle close gets an assessment (audit C3; docs/routing-task-profile.md, "Continuous evaluation"): when
 * the close waits on nothing but its practice assessment and none was stated, the controller records the one
 * the continuous evaluation gives over the evidence store (src/practice/evaluate.mjs). The evaluation record is
 * written to <store>/evaluations/<digest>.json and cited by its digest, synthetic-flagged. It is never a
 * promote: an assessment cannot be one, and the strongest automatic outcome is propose_policy. A cycle that
 * cannot close for another reason (a missing review, an open finding) gets nothing yet, so a stated assessment
 * given when it can close (resume, propose) is still the one recorded.
 */
function recordAutomaticPractice(rec, cycle, store) {
  const state = rec.cycleState(cycle);
  if (state.cycle.contract !== CYCLE_CONTRACT || state.dispositions.some(d => d.payload.stage === "assessment")) return null;
  const waiting = closeClaim(state).why;
  if (!waiting || !/no practice assessment/.test(waiting)) return null;
  const pools = readPools();
  const record = evaluate({ runs: existsSync(store) ? store : [], pools, at: new Date().toISOString() });
  const dir = join(store, "evaluations");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${record.digest.slice("sha256:".length)}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  const a = automaticAssessment(record, { policy: state.cycle.policy, pools });
  const disposition = rec.recordDisposition({ cycle, ...a });
  return { disposition, digest: record.digest, file, store, evaluation: record.outcome, recorded: a.outcome, halted: record.halted,
    synthetic: record.synthetic, measured: a.measured, runs: record.runs.length, excluded: record.excluded.length };
}
const labsOf = turns => [...new Set(turns.map(t => labOf(t.vendor, t.served_model ?? t.model)))];

// --- paired runs -------------------------------------------------------------------------------------
// The owner's decision of 2026-11-17 (docs/routing-task-profile.md, "Continuous evaluation", "Paired runs"):
// a sampled ticket (assign.mjs pairFor) is also run under the other profile, so that `fit` and `argo` are
// compared on the SAME ticket and the between-ticket variance drops out of the comparison.
export const PAIR_REFUSAL = Object.freeze({
  PAIR_UNBOUNDED: "pairing needs an explicit provider-call bound for the counterpart (pairMaxProviderCalls, --pair-max-provider-calls N): no counterpart runs without one",
  PAIR_PROFILE: "the primary ran a profile that is neither argo nor fit: there is no counterpart profile",
  PAIR_NO_PRIMARY: "the primary produced no run record: there is nothing to pair with",
});
const RUN_DEFAULT_REVISIONS = 3; // runOpenItem's own default (run-item.mjs), used when the primary named none
// Options of the primary that the counterpart does not inherit: its profile is the other one, it is never
// interleaved, an operator reseat would seat both arms alike, and its bound, ledger and board are its own.
const NOT_INHERITED = ["profile", "interleave", "assignmentPolicy", "seatOverrides", "maxProviderCalls", "ledger", "ledgerRoot", "revisions", "dir", "resume", "retryStopped", "progress", "makeClientFor"];

/**
 * The paths of the target repository a ticket reads, relative to the repository's top: what the dry snapshot
 * holds (the run copies `copy` into its own worktree and reads the slots, sources, attachments and oracle).
 */
function ticketPaths(spec, top) {
  const rel = p => relative(top, join(spec.repo_root, p));
  const slots = normalizeSlots(spec).flatMap(s => [s.path, s.source].filter(Boolean));
  return [...new Set([...(spec.copy ?? []), ...(spec.attach ?? []), spec.tests_file, spec.source, ...slots].filter(Boolean).map(rel))].sort();
}

/**
 * The counterpart of a paired run: `spec` under the other profile, in a separate DRY board, on a snapshot of
 * the ticket's paths at `base` (git archive into the dry directory: the target repository is only read). So it
 * never ships to the real shipping ref (it ships, if at all, to its own board's ref), never merges into the
 * target repository (nothing is committed there and its working tree is never written: the run's outputs go to
 * the snapshot), never writes the status ledger or the shared run ledger (its ledger is <dry>/ledger), and never
 * opens or closes the real review cycle. It runs under an explicit provider-call bound and the primary's
 * revisions. Its failure or refusal is an outcome, recorded. The pair record goes to <store>/pairs/<pair_id>/.
 */
async function runCounterpart({ spec, ticket, top, base, boardDir, store, runOpts, run, runJsonFile, makeClientFor, sampling, bound, pairDir, progress }) {
  const primaryProfile = run?.profile ?? runOpts.profile ?? BASELINE_ARM;
  const other = primaryProfile === BASELINE_ARM ? CANDIDATE_ARM : primaryProfile === CANDIDATE_ARM ? BASELINE_ARM : null;
  const revisions = runOpts.revisions ?? RUN_DEFAULT_REVISIONS;
  const primaryBytes = run ? readFileSync(runJsonFile) : null;
  const primaryDigest = primaryBytes ? sha256(primaryBytes) : null;
  const pair_id = "pair-" + createHash("sha256").update([PAIR_SCHEMA, spec.key, ticket.digest, primaryDigest ?? boardDir].join("\0")).digest("hex").slice(0, 24);
  const dir = join(store, "pairs", pair_id);
  mkdirSync(dir, { recursive: true });
  if (primaryBytes) writeFileSync(join(dir, "primary.run.json"), primaryBytes);
  const bounds = { max_provider_calls: bound, revisions };
  const record = { schema: PAIR_SCHEMA, pair_id, ticket: { key: spec.key, item: ticket.item, path: ticket.path, digest: ticket.digest },
    stakes: sampling.stakes, sampling: { basis: sampling.basis, rate: sampling.rate, u: sampling.u },
    primary: { profile: primaryProfile, run_digest: primaryDigest, board: boardDir }, bounds };
  const write = rec => { writeFileSync(join(dir, "pair.json"), JSON.stringify(rec, null, 2) + "\n"); return rec; };
  const refuse = code => {
    progress({ event: "pair.refused", pair_id, code, why: PAIR_REFUSAL[code] });
    return write({ ...record, status: "refused", refusal: { code, why: PAIR_REFUSAL[code] }, counterpart: null, at: new Date().toISOString() });
  };
  if (!run) return refuse("PAIR_NO_PRIMARY");
  if (!other) return refuse("PAIR_PROFILE");
  if (!(Number.isSafeInteger(bound) && bound > 0)) return refuse("PAIR_UNBOUNDED");

  let dry = pairDir ?? join(boardDir, `pair-${other}`);
  if (existsSync(dry)) dry = `${dry}-${Date.now()}`;
  const snapshot = join(dry, "repo");
  mkdirSync(snapshot, { recursive: true });
  const git = gitIn(top);
  const present = ticketPaths(spec, top).filter(p => { try { git(["cat-file", "-e", `${base}:${p}`]); return true; } catch { return false; } });
  if (present.length) execFileSync("tar", ["-x", "-C", snapshot], { input: git(["archive", "--format=tar", base, "--", ...present], { encoding: "buffer" }) });
  const cspec = { ...spec, repo_root: join(snapshot, relative(top, spec.repo_root)) };
  mkdirSync(cspec.repo_root, { recursive: true });
  const inherited = Object.fromEntries(Object.entries(runOpts).filter(([k]) => !NOT_INHERITED.includes(k)));
  const cboard = join(dry, "board");
  progress({ event: "pair.start", pair_id, board: dry, profile: other, bound, revisions });
  let result = null, error = null;
  try {
    result = await runOpenItem(cspec, { ...inherited, dir: cboard, makeClientFor, profile: other, revisions, maxProviderCalls: bound,
      ledgerRoot: join(dry, "ledger"), progress: ev => progress({ ...ev, from: "pair" }) });
  } catch (e) { error = { message: String(e.message ?? e).slice(0, 500), code: e.code ?? null }; }
  const cfile = join(cboard, "run.json");
  const cbytes = existsSync(cfile) ? readFileSync(cfile) : null;
  if (cbytes) writeFileSync(join(dir, "counterpart.run.json"), cbytes);
  const crun = cbytes ? JSON.parse(cbytes.toString("utf8")) : null;
  const row = crun ? runMetrics(crun, { profile: other, result }) : null;
  // Kept as an outcome whatever happened: a counterpart that failed, hit its bound or threw is not accepted.
  const outcome = { accepted: row?.accepted === true, first_pass: row?.first_pass === true, shipped: crun?.shipped === true,
    status: row?.status ?? "failed", why: row?.why ?? error?.message ?? result?.error?.message ?? null };
  progress({ event: "pair.end", pair_id, board: dry, profile: other, accepted: outcome.accepted, status: outcome.status });
  return write({ ...record, status: "completed",
    counterpart: { profile: other, dry: true, board: cboard, snapshot, run_digest: cbytes ? sha256(cbytes) : null, outcome,
      providers: makeClientFor.providers ?? null, ...(error ? { error } : {}) },
    at: new Date().toISOString() });
}

/**
 * `run <item>`: the ticket through runOpenItem (the ledger on, by default at <board>/ledger or
 * OPHANIM_LEDGER), the shipped change committed on a branch, a review cycle over base..head with `n`
 * reviewers on distinct labs (none of them the implementer's) on the same ledger, and an evidence bundle.
 * When the cycle closes (no findings, or once they are fixed or deferred), the bundle gains an unsigned
 * status proposal (`proposeFromBundle`). Never writes the status ledger.
 */
export async function runBoardItem({ repo, item, statusRoot = defaultStatusRoot(repo), anchor = null, makeClientFor, turn, n = 3,
  dir = null, out = null, branch = null, runOpts = {}, checked = today(), progress = () => {}, practice = null, evidenceStore = null,
  pairRate = 0, pairMaxProviderCalls = null, pairDir = null }) {
  if (typeof makeClientFor !== "function") fail("runBoardItem: pass makeClientFor(vendor) for the seats");
  pairFor({ ticketKey: "rate-check", policy: { pairRate } }); // a rate outside [0, 1] is refused before any work
  if (typeof turn !== "function") fail("runBoardItem: pass turn({vendor, model, prompt, seat}) for the cycle reviewers");
  const board = readBoard({ statusRoot, anchor });
  const d = dispatchable(board, item, { repo });
  if (d.why) fail(`"${item}" is not dispatchable: ${d.why}`);
  const { spec, ticket, path: ticketRel, digest: ticketDigest } = d.ticket;
  const top = gitTop(spec.repo_root);
  const git = gitIn(top);
  const base = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  // The run copies from the working tree; what it copies must be the base commit, or the change would be
  // reviewed against bytes nobody committed.
  const dirty = git(["status", "--porcelain", "--", ...spec.copy.map(c => relative(top, join(spec.repo_root, c)) || ".")]).trim();
  if (dirty) fail(`the ticket's copy paths have uncommitted changes; commit or stash them first:\n${dirty}`);

  const boardDir = dir ?? join(homedir(), ".pantheon", "boards", `board-${item}-${Date.now()}`);
  const bundleDir = out ?? join(boardDir, "operating");
  mkdirSync(bundleDir, { recursive: true });
  progress({ event: "run.start", item, ticket: ticketRel, slice: ticket.slice, board: boardDir });
  const ledgerRoot = resolve(process.env.OPHANIM_LEDGER ?? join(boardDir, "ledger"));
  const chainFile = join(ledgerRoot, "chain.jsonl");
  const entriesBefore = existsSync(chainFile) ? readFileSync(chainFile, "utf8").split("\n").filter(Boolean).length : 0;
  // The evidence store the continuous evaluation reads (src/practice/evaluate.mjs): configured, else
  // PANTHEON_EVIDENCE_STORE, else beside the run ledger (<OPHANIM_LEDGER>/../runs, or <board>/runs).
  const store = evidenceStore ? resolve(evidenceStore) : defaultEvidenceStore({ ledgerRoot });
  // Interleaving and pairing (both opt-in) consult the store for the strata the stop rule has halted.
  let halted = null;
  const haltedNow = () => (halted ??= existsSync(store) ? evaluate({ runs: store }).halted : []);
  if (runOpts.interleave === true && !runOpts.assignmentPolicy) {
    runOpts = { ...runOpts, assignmentPolicy: { eligible: [...DEFAULT_ELIGIBLE_STRATA], halted: haltedNow() } };
  }
  let stakes = null;
  try { stakes = taskProfile(spec, { paths: normalizeSlots(spec).map(s => s.path), mode: "batch" }).stakes.value; } catch { stakes = null; }
  const sampling = pairFor({ ticketKey: spec.key, stakes, policy: { pairRate, halted: pairRate > 0 ? haltedNow() : [] } });
  const result = await runOpenItem(spec, { dir: boardDir, makeClientFor, progress: ev => progress({ ...ev, from: "pipeline" }), ...runOpts });
  const runJsonFile = join(boardDir, "run.json");
  const run = existsSync(runJsonFile) ? JSON.parse(readFileSync(runJsonFile, "utf8")) : null;
  // Every run, shipped or not, is deposited in the store: a failed run is evidence too.
  if (run) {
    mkdirSync(join(store, basename(boardDir)), { recursive: true });
    writeFileSync(join(store, basename(boardDir), "run.json"), readFileSync(runJsonFile));
  }
  // A sampled ticket's counterpart, before anything of the primary is committed or reviewed (it reads only the
  // base commit, so the order cannot change what the primary commits); its record joins the store.
  let pairRecord = null;
  if (sampling.sampled) {
    pairRecord = await runCounterpart({ spec, ticket: { item, path: ticketRel, digest: ticketDigest }, top, base, boardDir, store, runOpts, run, runJsonFile,
      makeClientFor, sampling, bound: pairMaxProviderCalls, pairDir, progress });
  }
  const pairSummary = pairRecord ? { pair_id: pairRecord.pair_id, status: pairRecord.status, file: join(store, "pairs", pairRecord.pair_id, "pair.json"),
    ...(pairRecord.refusal ? { refusal: pairRecord.refusal } : {}),
    ...(pairRecord.counterpart ? { counterpart: { profile: pairRecord.counterpart.profile, outcome: pairRecord.counterpart.outcome } } : {}) }
    : { status: "not_sampled", basis: sampling.basis, rate: sampling.rate };
  const sys = openPantheonLedger({ root: ledgerRoot, board: openBoard(boardDir) });
  const rec = sys.recorder();
  const v = rec.verify();
  if (!v.ok) fail(`the run ledger does not verify: ${v.why}`);
  const bundle = {
    schema: BUNDLE_SCHEMA, item, title: board.items.find(i => i.item === item).title, made_against: board.items.find(i => i.item === item).entry,
    status_ledger: { anchor: board.anchor, head: board.head }, checked,
    ticket: { path: ticketRel, digest: ticketDigest, slice: ticket.slice, proposes: ticket.proposes, key: spec.key },
    board: boardDir, base, branch: null, commit: null, evidence_store: store,
    run: { ledger: ledgerRoot, ledger_anchor: sys.anchor, ledger_head: v.head, run_json: existsSync(runJsonFile) ? runJsonFile : null,
      run_json_digest: existsSync(runJsonFile) ? sha256(readFileSync(runJsonFile)) : null, shipped: result.shipped === true,
      gate_entry: run?.ledger?.gate ?? null, error: result.error ?? null,
      tests: run?.acceptance ? { cmd: run.acceptance.cmd, exit: run.acceptance.exit } : null,
      seats: [...new Map((run?.turns ?? []).map(t => [`${t.purpose}|${t.vendor}|${t.model}`, { purpose: t.purpose, vendor: t.vendor, model: t.model,
        served_model: t.served_model ?? null, lab: labOf(t.vendor, t.served_model ?? t.model) }])).values()] },
    review: null, proposal: null, pair: pairSummary,
  };
  const save = () => writeFileSync(join(bundleDir, "evidence.json"), JSON.stringify(bundle, null, 2) + "\n");
  if (!result.shipped) { save(); progress({ event: "run.refused", why: result.error?.message ?? "not shipped" }); return { bundle, dir: bundleDir }; }

  // The shipped change, as a commit: certified bytes only (the board re-checks the manifest).
  const files = certifiedArtifacts(run, { repoRoot: spec.repo_root, outDir: result.outDir })
    .map(f => ({ ...f, path: relative(top, join(spec.repo_root, f.path)) }));
  const workTurns = turnsOf(run, "work"), planTurns = turnsOf(run, "plan");
  const branchName = branch ?? `pantheon/${item}`;
  const message = [`${item}: ${spec.title}`, "", `Slice: ${ticket.slice}`, "",
    `Produced by a Pantheon board run (${ticketRel}); shipped by the controller after acceptance and in-run review.`,
    `Seats: ${bundle.run.seats.map(s => `${s.purpose} ${s.vendor}/${s.model} (${s.lab})`).join("; ")}. These are model seats, not people.`, "",
    `Pantheon-Ticket: ${ticketDigest}`, `Pantheon-Run-Ledger: ${sys.anchor}`, ""].join("\n");
  const head = commitShipped({ repo: top, base, files, branch: branchName, message });
  Object.assign(bundle, { branch: branchName, commit: head });
  progress({ event: "committed", branch: branchName, commit: head });

  // The review cycle over base..head, on the run's ledger.
  const chosen = cycleReviewers({ planLabs: labsOf(planTurns), workLabs: labsOf(workTurns), n });
  // This run's work turns on the ledger: recorded after the run started, by the seats run.json names.
  const workSeats = new Set(workTurns.map(t => `${t.vendor}-work@${t.model}`));
  const authorTurns = chosen.planner_excluded ? sys.ledger.read().slice(entriesBefore).filter(e => e.kind === "turn")
    .filter(e => { const p = sys.ledger.payloadOf(e); return p.purpose === "work" && workSeats.has(p.seat.seat_id); }).map(e => sys.ledger.hashOf(e)) : [];
  const diff = git(["diff", "--no-color", base, head]);
  const changed = git(["diff", "--name-only", base, head]).split("\n").filter(Boolean);
  const scope = `board/${item}/${base.slice(0, 12)}`;
  const r = await reviewCycle({ ledger: rec, change: { scope, base, head, diff, files: changed, author_labs: chosen.author_labs, author_turns: authorTurns },
    seats: chosen.seats, turn, n, policy: runPolicy(run) ?? undefined });
  bundle.review = { ledger: ledgerRoot, ledger_anchor: sys.anchor, scope, cycle: r.cycle, author_labs: chosen.author_labs,
    planner_excluded: chosen.planner_excluded, ...(chosen.note ? { note: chosen.note } : {}), author_turns: authorTurns,
    reviews: bundleReviews(r.reviews), failed: r.failed, close: null, outcome: null };
  save();
  progress({ event: "reviewed", cycle: r.cycle, reviews: r.reviews.length, failed: r.failed.length,
    findings: r.reviews.reduce((n, x) => n + x.findings.length, 0) });
  const proposed = proposeFromBundle({ dir: bundleDir, statusRoot, anchor, sys, practice });
  return { bundle: proposed.bundle, dir: bundleDir, proposal: proposed.proposal, why: proposed.why };
}

const bundleReviews = reviews => reviews.map(x => ({ vendor: x.vendor, model: x.model, served_model: x.served_model, lab: x.lab, review: x.review, verdict: x.verdict,
  findings: x.findings.map(f => ({ finding: f.hash, severity: f.severity, file: f.file, line: f.line, claim: f.claim, reproduction: f.reproduction })) }));

/**
 * Resume a board run whose review cycle a failed reviewer left open (independent review 2026-11-16, C2):
 * `pantheon-board resume <item> --out DIR`. It does not run the item again and never opens a new cycle:
 * it reopens the bundle's cycle on the run's ledger and asks again only the reviewer seats with no review
 * (reviewCycle with `resume: true`), under the cycle's own change (the bundle's base..commit, re-read from
 * the repository and checked against the digests the cycle bound) and the reviewers the run seated,
 * re-derived from its run.json. Reviews already recorded are kept; each try is a recorded attempt, up to
 * the cycle's limit. Then, as after a run, the cycle closes if it can and the proposal is written.
 */
export async function resumeBoardItem({ repo, dir, item = null, turn, statusRoot = defaultStatusRoot(repo), anchor = null, max_attempts, progress = () => {}, practice = null }) {
  if (typeof turn !== "function") fail("resumeBoardItem: pass turn({vendor, model, prompt, seat}) for the cycle reviewers");
  const file = join(dir, "evidence.json");
  if (!existsSync(file)) fail(`no evidence bundle at ${file}: resume names the --out DIR of the run`);
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  if (bundle.schema !== BUNDLE_SCHEMA) fail(`${file} is not a ${BUNDLE_SCHEMA} bundle`);
  if (item !== null && bundle.item !== item) fail(`the bundle at ${dir} is for "${bundle.item}", not "${item}"`);
  if (!bundle.run.shipped || !bundle.commit) fail("the run did not ship: there is no change to review, and a resume does not run the item again");
  if (!bundle.review?.cycle) fail("the change was never put under review: there is no cycle to resume");
  const sys = openPantheonLedger({ root: bundle.review.ledger, anchor: bundle.review.ledger_anchor, board: openBoard(bundle.board) });
  const rec = sys.recorder();
  const last = rec.lastCycle(bundle.review.scope);
  if (last?.hash !== bundle.review.cycle) fail(`the bundle's cycle ${bundle.review.cycle.slice(0, 19)} is not the last cycle of ${bundle.review.scope} on the run ledger`);
  const state = rec.cycleState(bundle.review.cycle);
  if (!state.close) {
    // The reviewers the run seated, re-derived from the run.json the bundle names (its digest is checked).
    if (!bundle.run.run_json || !existsSync(bundle.run.run_json) || sha256(readFileSync(bundle.run.run_json)) !== bundle.run.run_json_digest) {
      fail("the run's run.json is missing or is not the one the bundle names: the run's reviewers cannot be re-derived");
    }
    const run = JSON.parse(readFileSync(bundle.run.run_json, "utf8"));
    const chosen = cycleReviewers({ planLabs: labsOf(turnsOf(run, "plan")), workLabs: labsOf(turnsOf(run, "work")), n: state.cycle.reviewers });
    if ([...chosen.author_labs].sort().join() !== [...bundle.review.author_labs].sort().join()) fail("the run's author labs do not re-derive the bundle's");
    const git = gitIn(gitTop(repo));
    const diff = git(["diff", "--no-color", bundle.base, bundle.commit]);
    const files = git(["diff", "--name-only", bundle.base, bundle.commit]).split("\n").filter(Boolean);
    progress({ event: "resume.start", cycle: bundle.review.cycle, reviews: state.reviews.length, reviewers: state.cycle.reviewers });
    const r = await reviewCycle({ ledger: rec, resume: true, turn, max_attempts, seats: chosen.seats,
      change: { scope: bundle.review.scope, base: bundle.base, head: bundle.commit, diff, files, author_labs: bundle.review.author_labs, author_turns: bundle.review.author_turns } });
    Object.assign(bundle.review, { reviews: bundleReviews(r.reviews), failed: r.failed,
      resumes: [...(bundle.review.resumes ?? []), { retained: r.retained, attempted: r.attempted, failed: r.failed.length, complete: r.complete }] });
    writeFileSync(file, JSON.stringify(bundle, null, 2) + "\n");
    progress({ event: "resumed", cycle: r.cycle, reviews: r.reviews.length, retained: r.retained.length, attempted: r.attempted.length, failed: r.failed.length });
  }
  const proposed = proposeFromBundle({ dir, statusRoot, anchor, sys, practice });
  return { bundle: proposed.bundle, dir, proposal: proposed.proposal, why: proposed.why };
}

/**
 * Close the bundle's review cycle if its entries allow it, and write the unsigned proposal. A cycle with
 * open findings stays open: fix or defer each (pantheon-review-cycle fix|defer --ledger <run ledger>),
 * then call this again (`pantheon-board.mjs propose --bundle DIR`). A cycle that closes `unverified` can
 * propose Resolved only with `acceptUnverified` (a stated reason, recorded). A cycle opened under the
 * practice contract also needs its practice assessment (audit C3): `practice` ({outcome, question, ...})
 * records it here (`pantheon-board.mjs propose --practice-outcome O --practice-question TEXT`).
 */
export function proposeFromBundle({ dir, statusRoot, anchor = null, acceptUnverified = undefined, sys = null, practice = null }) {
  const file = join(dir, "evidence.json");
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  if (bundle.schema !== BUNDLE_SCHEMA) fail(`${file} is not a ${BUNDLE_SCHEMA} bundle`);
  const save = () => writeFileSync(file, JSON.stringify(bundle, null, 2) + "\n");
  if (!bundle.run.shipped) return { bundle, why: "the run did not ship: there is nothing to propose" };
  if (!bundle.review) return { bundle, why: "the change has not been reviewed" };
  sys ??= openPantheonLedger({ root: bundle.review.ledger, anchor: bundle.review.ledger_anchor, board: openBoard(bundle.board) });
  const rec = sys.recorder();
  if (!rec.cycleState(bundle.review.cycle).close) {
    recordPractice(rec, bundle.review.cycle, practice);
    const auto = recordAutomaticPractice(rec, bundle.review.cycle, storeOf(bundle));
    if (auto) bundle.review.evaluation = auto;
  }
  const state = rec.cycleState(bundle.review.cycle);
  bundle.review.practice = state.dispositions.map(d => ({ disposition: d.hash, stage: d.payload.stage, outcome: d.payload.outcome, provisional: d.payload.provisional }));
  if (!state.close) {
    try { const c = rec.closeCycle(bundle.review.cycle); bundle.review.close = c.hash; bundle.review.outcome = c.outcome; }
    catch (e) {
      if (e.code !== "CYCLE_OPEN") throw e;
      save();
      return { bundle, why: e.message };
    }
  } else {
    bundle.review.close = state.close;
    bundle.review.outcome = sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === state.close)).outcome;
  }
  bundle.review.resolutions = state.findings.map(f => ({ finding: f.hash, resolution: rec.cycleState(bundle.review.cycle).resolutions.get(f.hash)?.payload ?? null }));
  const reviewers = state.reviews.map(x => ({ vendor: x.seat.vendor, lab: x.lab, review: x.hash })).map(x => {
    const p = sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === x.review));
    return { vendor: x.vendor, model: p.model, served_model: p.served_model ?? null, lab: x.lab };
  });
  const evidence = {
    run: { ledger_anchor: bundle.run.ledger_anchor, ledger_head: bundle.run.ledger_head, run_json_digest: bundle.run.run_json_digest,
      shipped: bundle.run.shipped, gate_entry: bundle.run.gate_entry },
    review: { cycle_ledger_anchor: bundle.review.ledger_anchor, cycle: bundle.review.cycle, close_entry: bundle.review.close,
      outcome: bundle.review.outcome, reviewers },
    commit: bundle.commit, tests: bundle.run.tests,
    ticket: { path: bundle.ticket.path, digest: bundle.ticket.digest, slice: bundle.ticket.slice },
  };
  const f = bundle.review.resolutions.length;
  // The basis says what happened in one line; the full record (ticket, commands, ledgers) is the evidence.
  const basis = `${bundle.ticket.proposes.basis}. Board run: shipped as ${bundle.commit.slice(0, 12)} (acceptance exit ${bundle.run.tests?.exit})`
    + `; review cycle ${bundle.review.cycle.slice(7, 19)} closed ${bundle.review.outcome}`
    + ` by ${reviewers.map(x => x.lab).join(", ")} (${f} finding${f === 1 ? "" : "s"})`;
  const board = readBoard({ statusRoot, anchor });
  const latest = board.items.find(i => i.item === bundle.item);
  if (!latest || latest.entry !== bundle.made_against) {
    save();
    return { bundle, why: `the item's status changed since the run started (${bundle.made_against.slice(0, 19)} -> ${latest?.entry.slice(0, 19) ?? "absent"}): re-dispatch it` };
  }
  const p = propose(board, { item: bundle.item, to: { state: bundle.ticket.proposes.state, basis, checked: bundle.checked }, evidence,
    ...(acceptUnverified ? { accept_unverified_reason: acceptUnverified } : {}),
    locations: { run_ledger: bundle.run.ledger, cycle_ledger: bundle.review.ledger, run_json: bundle.run.run_json } });
  writeFileSync(join(dir, "proposal.json"), JSON.stringify(p, null, 2) + "\n");
  bundle.proposal = { file: join(dir, "proposal.json"), digest: proposalDigest(p), to: p.to.state };
  save();
  return { bundle, proposal: p };
}

/**
 * Full re-derivation of a proposal's evidence with Pantheon's kinds (status.mjs apply checks it only
 * structurally, since packages/ledger supplies no domain): the run ledger verifies and re-derives against
 * its anchor, the cycle closed with the stated outcome on the stated reviews, the commit exists, descends
 * from the cycle's base and its diff is the one the reviewers were given.
 */
export function checkProposal({ proposal: p, repo }) {
  const why = proposalRefusal(p);
  if (why) fail(`proposal refused: ${why}`);
  const loc = p.locations ?? {};
  if (!loc.run_ledger || !existsSync(loc.run_ledger)) fail("the run ledger is not on this machine: the evidence can only be checked structurally");
  const sys = openPantheonLedger({ root: loc.run_ledger, anchor: p.evidence.run.ledger_anchor });
  const v = sys.ledger.verify();
  if (!v.ok) fail(`the run ledger does not verify: ${v.why}`);
  const rec = sys.recorder();
  const found = [];
  if (!sys.ledger.read().some(e => sys.ledger.hashOf(e) === p.evidence.run.ledger_head)) fail("the cited run ledger head is not in the ledger");
  found.push(`run ledger verifies against ${p.evidence.run.ledger_anchor.slice(0, 19)} (${v.entries} entries; complete: ${v.complete})`);
  const rv = p.evidence.review;
  if (rv) {
    if (rv.cycle_ledger_anchor !== p.evidence.run.ledger_anchor) fail("this check reads a review cycle on the run's own ledger");
    const state = rec.cycleState(rv.cycle);
    if (!state.cycle) fail("the cited cycle is not on the run ledger");
    if (state.close !== rv.close_entry) fail("the cited close is not the cycle's close");
    const claim = sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === state.close));
    if (claim.outcome !== rv.outcome) fail(`the cycle closed ${claim.outcome}, not ${rv.outcome}`);
    const labs = state.reviews.map(r => r.lab).sort();
    if (labs.join() !== rv.reviewers.map(r => r.lab).sort().join()) fail("the reviewers' labs differ from the recorded reviews");
    found.push(`cycle ${rv.cycle.slice(0, 19)} closed ${claim.outcome}: ${state.reviews.length} reviews on ${labs.join(", ")}`);
    if (repo && p.evidence.commit) {
      const git = gitIn(repo);
      try { git(["cat-file", "-e", `${p.evidence.commit}^{commit}`]); } catch { fail(`commit ${p.evidence.commit} is not in ${repo}`); }
      if (state.cycle.head !== p.evidence.commit) fail("the commit is not the head the cycle reviewed");
      try { git(["merge-base", "--is-ancestor", state.cycle.base, p.evidence.commit]); } catch { fail("the commit does not descend from the cycle's base"); }
      const diff = git(["diff", "--no-color", state.cycle.base, p.evidence.commit]);
      if (sha256(diff) !== state.cycle.diff_sha) fail("the commit's diff is not the one the reviewers were given");
      found.push(`commit ${p.evidence.commit.slice(0, 12)} is the reviewed head; its diff matches the cycle`);
    }
  }
  if (loc.run_json) {
    if (sha256(readFileSync(loc.run_json)) !== p.evidence.run.run_json_digest) fail("run.json is not the one the proposal cites");
    found.push("run.json matches its digest");
  }
  return { ok: true, proposal: proposalDigest(p), found };
}

export { STATES };
