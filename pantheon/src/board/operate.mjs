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
import { join, resolve, relative, isAbsolute } from "node:path";
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
import { openPantheonLedger } from "../ledger/system.mjs";
import { reviewCycle, reviewSeats } from "../ledger/review-cycle.mjs";

export const TICKET_SCHEMA = "ophanim.ticket/v1";
export const BUNDLE_SCHEMA = "pantheon.board-run/v1";
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const RUN_FIELDS = ["key", "title", "goal", "question", "repo_root", "slot", "path", "slots", "source", "copy", "attach",
  "tests_file", "acceptance_cmd", "difficulty", "constraints", "forbidden"];
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
const labsOf = turns => [...new Set(turns.map(t => labOf(t.vendor, t.served_model ?? t.model)))];

/**
 * `run <item>`: the ticket through runOpenItem (the ledger on, by default at <board>/ledger or
 * OPHANIM_LEDGER), the shipped change committed on a branch, a review cycle over base..head with `n`
 * reviewers on distinct labs (none of them the implementer's) on the same ledger, and an evidence bundle.
 * When the cycle closes (no findings, or once they are fixed or deferred), the bundle gains an unsigned
 * status proposal (`proposeFromBundle`). Never writes the status ledger.
 */
export async function runBoardItem({ repo, item, statusRoot = defaultStatusRoot(repo), anchor = null, makeClientFor, turn, n = 3,
  dir = null, out = null, branch = null, runOpts = {}, checked = today(), progress = () => {} }) {
  if (typeof makeClientFor !== "function") fail("runBoardItem: pass makeClientFor(vendor) for the seats");
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
  const result = await runOpenItem(spec, { dir: boardDir, makeClientFor, progress: ev => progress({ ...ev, from: "pipeline" }), ...runOpts });
  const runJsonFile = join(boardDir, "run.json");
  const run = existsSync(runJsonFile) ? JSON.parse(readFileSync(runJsonFile, "utf8")) : null;
  const sys = openPantheonLedger({ root: ledgerRoot, board: openBoard(boardDir) });
  const rec = sys.recorder();
  const v = rec.verify();
  if (!v.ok) fail(`the run ledger does not verify: ${v.why}`);
  const bundle = {
    schema: BUNDLE_SCHEMA, item, title: board.items.find(i => i.item === item).title, made_against: board.items.find(i => i.item === item).entry,
    status_ledger: { anchor: board.anchor, head: board.head }, checked,
    ticket: { path: ticketRel, digest: ticketDigest, slice: ticket.slice, proposes: ticket.proposes, key: spec.key },
    board: boardDir, base, branch: null, commit: null,
    run: { ledger: ledgerRoot, ledger_anchor: sys.anchor, ledger_head: v.head, run_json: existsSync(runJsonFile) ? runJsonFile : null,
      run_json_digest: existsSync(runJsonFile) ? sha256(readFileSync(runJsonFile)) : null, shipped: result.shipped === true,
      gate_entry: run?.ledger?.gate ?? null, error: result.error ?? null,
      tests: run?.acceptance ? { cmd: run.acceptance.cmd, exit: run.acceptance.exit } : null,
      seats: [...new Map((run?.turns ?? []).map(t => [`${t.purpose}|${t.vendor}|${t.model}`, { purpose: t.purpose, vendor: t.vendor, model: t.model,
        served_model: t.served_model ?? null, lab: labOf(t.vendor, t.served_model ?? t.model) }])).values()] },
    review: null, proposal: null,
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
    seats: chosen.seats, turn, n });
  bundle.review = { ledger: ledgerRoot, ledger_anchor: sys.anchor, scope, cycle: r.cycle, author_labs: chosen.author_labs,
    planner_excluded: chosen.planner_excluded, ...(chosen.note ? { note: chosen.note } : {}), author_turns: authorTurns,
    reviews: r.reviews.map(x => ({ vendor: x.vendor, model: x.model, served_model: x.served_model, lab: x.lab, review: x.review, verdict: x.verdict,
      findings: x.findings.map(f => ({ finding: f.hash, severity: f.severity, file: f.file, line: f.line, claim: f.claim, reproduction: f.reproduction })) })),
    failed: r.failed, close: null, outcome: null };
  save();
  progress({ event: "reviewed", cycle: r.cycle, reviews: r.reviews.length, failed: r.failed.length,
    findings: r.reviews.reduce((n, x) => n + x.findings.length, 0) });
  const proposed = proposeFromBundle({ dir: bundleDir, statusRoot, anchor, sys });
  return { bundle: proposed.bundle, dir: bundleDir, proposal: proposed.proposal, why: proposed.why };
}

/**
 * Close the bundle's review cycle if its entries allow it, and write the unsigned proposal. A cycle with
 * open findings stays open: fix or defer each (pantheon-review-cycle fix|defer --ledger <run ledger>),
 * then call this again (`pantheon-board.mjs propose --bundle DIR`). A cycle that closes `unverified` can
 * propose Resolved only with `acceptUnverified` (a stated reason, recorded).
 */
export function proposeFromBundle({ dir, statusRoot, anchor = null, acceptUnverified = undefined, sys = null }) {
  const file = join(dir, "evidence.json");
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  if (bundle.schema !== BUNDLE_SCHEMA) fail(`${file} is not a ${BUNDLE_SCHEMA} bundle`);
  const save = () => writeFileSync(file, JSON.stringify(bundle, null, 2) + "\n");
  if (!bundle.run.shipped) return { bundle, why: "the run did not ship: there is nothing to propose" };
  if (!bundle.review) return { bundle, why: "the change has not been reviewed" };
  sys ??= openPantheonLedger({ root: bundle.review.ledger, anchor: bundle.review.ledger_anchor, board: openBoard(bundle.board) });
  const rec = sys.recorder();
  const state = rec.cycleState(bundle.review.cycle);
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
