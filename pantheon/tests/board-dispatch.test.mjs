// Dispatch from the status board (src/board/operate.mjs): an item is dispatchable iff its latest status is
// Ready, every item it depends on is Resolved, and a valid ticket exists that its latest status has not
// already recorded. The full operating cycle is rehearsed in ophanim/tests/board-operating-cycle.test.mjs
// (OPHANIM's side, since it also checks the public record, which Pantheon does not import).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStatusLedger, EVIDENCE_SCHEMA } from "../../packages/ledger/status.mjs";
import { boardNext, readTicket, dispatchable, readBoard, cycleReviewers, seatTeam, dependencyOrder } from "../src/board/operate.mjs";

const TICKET = item => ({ schema: "ophanim.ticket/v1", item, slice: "one file", proposes: { state: "Ready", basis: "slice done" },
  title: "t", goal: "g", question: "q", repo_root: ".", slot: "a", path: "a.mjs", copy: ["a.mjs"], acceptance_cmd: "node a.mjs" });

function withRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), "pantheon-dispatch-"));
  try {
    writeFileSync(join(repo, "a.mjs"), "export {};\n");
    mkdirSync(join(repo, "tickets"));
    const statusRoot = join(repo, "status", "ledger");
    const S = openStatusLedger({ root: statusRoot });
    const day = { checked: "2026-11-17" };
    S.set({ ...day, item: "held", title: "Held", state: "On Hold", basis: "decision", waiting_on: "decision" });
    S.set({ ...day, item: "base", title: "Base", state: "Resolved", basis: "done" });
    S.set({ ...day, item: "ready", title: "Ready", state: "Ready", basis: "go", depends_on: ["base"] });
    S.set({ ...day, item: "blocked", title: "Blocked", state: "Ready", basis: "go", depends_on: ["unknown"] });
    S.set({ ...day, item: "noticket", title: "No ticket", state: "Ready", basis: "go" });
    S.set({ ...day, item: "later", title: "Later", state: "Ready", basis: "go" });
    for (const id of ["ready", "blocked", "held", "later"]) writeFileSync(join(repo, "tickets", `${id}.json`), JSON.stringify(TICKET(id)));
    return fn({ repo, statusRoot, S });
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

test("next lists exactly the dispatchable items, each with its ticket and team, and says why the rest are not", () => withRepo(({ repo, statusRoot }) => {
  const r = boardNext({ repo, statusRoot, pools: [] });
  assert.deepEqual(r.items.map(i => i.item), ["later", "ready"]);
  const why = Object.fromEntries(r.skipped.map(s => [s.item, s.why]));
  assert.match(why.blocked, /depends on unresolved unknown/);
  assert.match(why.noticket, /no ticket at tickets\/noticket.json/);
  assert.equal(why.held, undefined, "a hold is not a candidate at all");
  const team = r.items[0].team;
  for (const role of ["scout", "planner", "implementer", "reviewer"]) assert.ok(team[role].every(s => s.vendor && s.model && s.lab));
  assert.equal(new Set(team.cycle_reviewers.seats.map(s => s.lab)).size, 3);
  assert.equal(existsSync(join(statusRoot, "keys")), true, "the test's own ledger keeps its keys; next never reads them");
}));

test("a ticket is validated before anything is seated", () => withRepo(({ repo }) => {
  const write = t => writeFileSync(join(repo, "tickets", "ready.json"), JSON.stringify(t));
  write({ ...TICKET("ready"), repo_root: repo });
  assert.match(readTicket({ repo, item: "ready" }).why, /relative to the repository/);
  write({ ...TICKET("ready"), repo_root: ".." });
  assert.match(readTicket({ repo, item: "ready" }).why, /outside the repository/);
  write({ ...TICKET("ready"), item: "other" });
  assert.match(readTicket({ repo, item: "ready" }).why, /names item "other"/);
  write({ ...TICKET("ready"), copy: ["missing.mjs"] });
  assert.match(readTicket({ repo, item: "ready" }).why, /copy names missing.mjs/);
  write({ ...TICKET("ready"), proposes: { state: "On Hold", basis: "x" } });
  assert.match(readTicket({ repo, item: "ready" }).why, /proposes names the state/);
  write({ ...TICKET("ready"), slice: "" });
  assert.match(readTicket({ repo, item: "ready" }).why, /slice/);
  write({ ...TICKET("ready"), surprise: 1 });
  assert.match(readTicket({ repo, item: "ready" }).why, /unknown ticket field/);
  write({ ...TICKET("ready"), copy: ["../x"] });
  assert.match(readTicket({ repo, item: "ready" }).why, /copy/);
  write(TICKET("ready"));
  const t = readTicket({ repo, item: "ready" });
  assert.equal(t.spec.repo_root, repo, "repo_root resolves against the repository");
  assert.equal(t.spec.key, "ready");
  assert.equal(t.spec.schema, undefined, "runOpenItem gets only the run fields");
}));

test("a slice already recorded on the item's latest status is not dispatched again", () => withRepo(({ repo, statusRoot, S }) => {
  const t = readTicket({ repo, item: "later" });
  const h = c => "sha256:" + c.repeat(64);
  S.set({ item: "later", title: "Later", state: "Ready", basis: "slice 1 done", checked: "2026-11-18",
    evidence: { schema: EVIDENCE_SCHEMA, proposal: h("9"), checked: "not-available",
      run: { ledger_anchor: h("1"), ledger_head: h("2"), run_json_digest: h("3"), shipped: true, gate_entry: null },
      commit: "b".repeat(40), tests: { cmd: "node a.mjs", exit: 0 }, ticket: { path: t.path, digest: t.digest, slice: "one file" } } });
  assert.match(dispatchable(readBoard({ statusRoot }), "later", { repo }).why, /already recorded on its latest status; write the next slice's ticket/);
}));

// Owner direction 2026-11-17: the three-lab requirement is enforced; it is never lowered by an availability fallback.
// This test used to pin that fallback (the planner's lab reviewing when labs ran out); it now pins the refusal.
test("cycle reviewers avoid every contributing lab; when the pool runs short the review is pending, never narrowed", () => {
  const both = cycleReviewers({ planLabs: ["anthropic"], workLabs: ["anthropic"] });
  assert.equal(both.planner_excluded, true);
  assert.deepEqual(both.seats.map(s => s.lab).sort(), ["google", "openai", "xai"]);
  const split = cycleReviewers({ planLabs: ["anthropic"], workLabs: ["openai"] });
  assert.equal(split.seats, null);
  assert.equal(split.pending.code, "REVIEW_CAPACITY_PENDING");
  assert.deepEqual(split.author_labs, ["anthropic", "openai"]);
  const reseated = seatTeam({ overrides: { implementer: { vendor: "agy_google", model: "claude-sonnet-4-6" } } });
  assert.deepEqual(reseated.implementer.map(s => s.lab), ["anthropic"]);
});

test("dependency order puts an item after what it depends on", () => {
  const order = dependencyOrder([{ item: "b", depends_on: ["a"] }, { item: "a" }, { item: "c", depends_on: ["b"] }]).map(i => i.item);
  assert.deepEqual(order, ["a", "b", "c"]);
});
