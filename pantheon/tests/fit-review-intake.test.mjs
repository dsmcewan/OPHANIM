// The `fit` profile's stated requirements, consumed through the REAL dispatcher (runOpenItem) with fake
// providers (tests/fixtures/dispatch.mjs). docs/routing-task-profile.md: stakes set `review_labs` (1/1/2/3)
// and ambiguity sets `explorer_width` (0/1/3 distinct labs). Before this change nothing consumed either, the
// intake scouts under `fit` used the legacy INTAKE seats, and an effort escalation after a fallback answered
// started from the primary's mapped effort. argo and legacy must not move.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runOpenItem } from "../src/board/run-item.mjs";
import { labOf } from "../src/config/models.mjs";
import { documentedEfforts, documentedDefaultEffort } from "../src/route/protocol.mjs";
import { withDispatch, WORK, seat } from "./fixtures/dispatch.mjs";

const runJson = r => JSON.parse(readFileSync(join(r.board, "run.json"), "utf8"));
const REVIEW = /VERDICT/;
const SCOUT = /RAN: nothing/;
const lab = t => labOf(t.vendor, t.model);
const quota = () => Object.assign(new Error("You exceeded your current quota"), { status: 429, code: "insufficient_quota" });
// A planner the operator seats on the maker's lab leaves the configured in-run reviewer pool three labs (openai,
// xai, anthropic): law 3 avoids both the maker's and the assigner's lab. That is this configuration's pool,
// not a count of possible reviewers. Under the fit matrix the maker is a Gemini model (owner direction 2026-11-17; since
// 2026-11-19 through the Gemini API itself, not an Antigravity lane), so the maker's lab is google.
const SAME_LAB_PLANNER = { planner: seat("agy_google", "gemini-4-carbon-high") };

test("fit, critical stakes: three reviewers from three distinct labs, none the maker's, all approving, then ship", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    const r = await runOpenItem(spec("fitCritical", { stakes: "critical" }), opts({ profile: "fit", seatOverrides: SAME_LAB_PLANNER }));
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const run = runJson(r);
    const work = run.turns.find(t => t.purpose === "work");
    const critiques = run.turns.filter(t => t.purpose === "critique");
    assert.equal(critiques.length, 3, `three reviewers ran (got ${critiques.map(t => t.model)})`);
    const labs = critiques.map(lab);
    assert.equal(new Set(labs).size, 3, `three distinct labs (${labs})`);
    assert.equal(new Set(critiques.map(t => t.vendor)).size, 3, "three distinct vendors, so three critique slots");
    assert.ok(!labs.includes(lab(work)), `none is the maker's lab ${lab(work)} (${labs})`);
    assert.ok(!labs.includes("google"), "none is the planner's lab either (law 3)");
    for (const t of critiques) {
      assert.equal(t.selection.profile, "fit");
      assert.equal(t.selection.requirements.review_labs.value, 3);
    }
    assert.equal(calls.filter(c => REVIEW.test(c.prompt)).length, 3);
    const panel = run.review.panels?.[0];
    assert.ok(panel, "the run records the review panel");
    assert.equal(panel.required, 3);
    assert.deepEqual(panel.reviewers.map(x => x.verdict), ["approve", "approve", "approve"]);
    assert.ok(run.gates.find(g => g.gate === "REVIEW")?.ok);
  });
});

test("fit, critical stakes: one of the three reviewers rejects, so the change is not shipped", async () => {
  await withDispatch(async ({ spec, opts, review }) => {
    // The xai reviewer rejects; the other two approve.
    review(c => c.vendor === "xai" ? "The ticket's case is missing.\nVERDICT: request_changes" : null);
    const r = await runOpenItem(spec("fitOneRejects", { stakes: "critical" }), opts({ profile: "fit", seatOverrides: SAME_LAB_PLANNER }));
    assert.equal(r.shipped, false);
    const run = runJson(r);
    const critiques = run.turns.filter(t => t.purpose === "critique");
    assert.equal(critiques.length, 3, "every panel member reviewed: verdicts are independent");
    assert.equal(run.review.verdict, "request_changes", "the slot's verdict is approve only if all approve");
    assert.deepEqual(run.review.panels[0].reviewers.map(x => x.verdict).sort(), ["approve", "approve", "request_changes"]);
    assert.equal(run.shipped, false);
    assert.equal(run.gates.find(g => g.gate === "REVIEW")?.ok, false, "the existing REVIEW gate refuses a blocking finding");
  });
});

test("fit, critical stakes with too few eligible labs: a named pending state before any work call, and no reviewer is called", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    // The operator seats the planner on a reviewer lab (anthropic) and fit seats the maker on openai: the configured
    // in-run reviewer pool then offers only xai and google.
    const r = await runOpenItem(spec("fitTooFewLabs", { stakes: "critical" }),
      opts({ profile: "fit", seatOverrides: { planner: seat("anthropic", "claude-fable-5-2") } }));
    assert.equal(r.shipped, false);
    assert.equal(r.error?.stage, "work");
    assert.match(r.error.message, /REVIEW_CAPACITY_PENDING/);
    assert.match(r.error.message, /3 independent review labs/);
    assert.match(r.error.message, /configured in-run reviewer pool/, "it names the configured pool, not a universal limit");
    assert.equal(calls.filter(c => WORK.test(c.prompt)).length, 0, "no generation is spent on work that cannot be reviewed as required");
    assert.equal(calls.filter(c => REVIEW.test(c.prompt)).length, 0, "it never runs fewer reviewers");
  });
});

test("fit, contested ambiguity: three intake scouts from three distinct labs, each chosen by the fit selector and recorded", async () => {
  await withDispatch(async ({ spec, opts, calls, agy }) => {
    const r = await runOpenItem(spec("fitContested", { ambiguity: "contested" }), opts({ profile: "fit" }));
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const run = runJson(r);
    const scouts = run.turns.filter(t => t.purpose === "scout");
    assert.equal(scouts.length, 3, `three scouts (got ${scouts.map(t => t.model)})`);
    assert.equal(new Set(scouts.map(lab)).size, 3, `three distinct labs (${scouts.map(lab)})`);
    for (const t of scouts) {
      assert.equal(t.selection.profile, "fit");
      assert.equal(t.selection.source, "policy", `${t.model} was chosen by the fit selector, not the INTAKE table`);
      assert.equal(t.selection.requirements.explorer_width.value, 3);
    }
    assert.equal(run.intake.explorer_width.value, 3);
    assert.deepEqual(run.intake.scouts.map(s => s.model), scouts.map(t => t.model), "each scout's selection is recorded");
    assert.ok(run.intake.scouts.every(s => s.selection?.policy_hash));
    // The Google scout goes through Antigravity first (owner direction 2026-11-17): two API requests and one lane turn.
    assert.equal(calls.filter(c => SCOUT.test(c.prompt)).length + agy().filter(a => a.agent === "pantheon-scout").length, 3);
    // A Google SCOUT still goes through its Antigravity lane (only implementation routing changed): the one Gemini API
    // request of the run is the implementer's.
    assert.deepEqual(calls.filter(c => c.vendor === "agy_google").map(c => WORK.test(c.prompt)), [true], "the Gemini API was asked for the work and nothing else");
  });
});

test("fit, settled ambiguity: explorer width 0 means no explorer stage", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    const r = await runOpenItem(spec("fitSettled", { ambiguity: "settled" }), opts({ profile: "fit" }));
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const run = runJson(r);
    assert.equal(run.turns.filter(t => t.purpose === "scout").length, 0);
    assert.equal(calls.filter(c => SCOUT.test(c.prompt)).length, 0, "no scout request was sent");
    assert.equal(run.intake.explorer_width.value, 0);
    assert.deepEqual(run.intake.scouts, []);
    assert.match(run.intake.skipped, /explorer width 0/);
  });
});

test("argo and legacy are unchanged: one scout from the configured vendor and one reviewer, whatever the fit dimensions say", async () => {
  for (const profile of ["argo", "legacy"]) {
    await withDispatch(async ({ spec, opts }) => {
      const r = await runOpenItem(spec(`${profile}Unchanged`, { stakes: "critical", ambiguity: "contested" }), opts({ profile }));
      assert.equal(r.shipped, true, `${profile}: ${JSON.stringify(r.error)}`);
      const run = runJson(r);
      const scouts = run.turns.filter(t => t.purpose === "scout");
      assert.equal(scouts.length, 1, `${profile}: one scout`);
      assert.equal(scouts[0].vendor, "xai");
      assert.equal(run.turns.filter(t => t.purpose === "critique").length, 1, `${profile}: one reviewer`);
      assert.equal(run.intake, undefined, `${profile}: no fit intake record`);
      assert.equal(run.review.panels, undefined, `${profile}: no fit review panel record`);
      assert.deepEqual(Object.keys(run.review), ["verdict"]);
    });
  }
});

test("fit: when a fallback answered, the effort escalation starts from the ANSWERING seat's effort", async () => {
  await withDispatch(async ({ spec, opts, calls, fault, implement }) => {
    // The ticket pins its implementer to gpt-6-astra, and the operator's seat for the role (claude-fable-5-2) is the
    // fallback after the pin. The pinned seat is refused for quota, so the fallback answers the first revision; the
    // acceptance then fails, and the escalation must start from what the ANSWERING seat ran with, not from the pin's.
    // (Under the lane matrix this was shown on the Hydrogen lane's metered failover, which no longer exists: the fit
    // matrix's Google implementer is the Gemini API itself, seated at each model's matrix thinking level.)
    fault(c => (c.vendor === "openai" && WORK.test(c.prompt) ? { error: quota() } : null));
    implement(p => /FAILED the executed acceptance/.test(p) ? "export const ok = true; // fixed\n" : "export const ok = true;\n");
    const r = await runOpenItem(spec("fitFallbackEffort", { acceptance_cmd: "grep -q fixed code.mjs", slot: undefined, path: undefined, slots: [{ slot: "code", path: "code.mjs", model: "gpt-6-astra" }] }),
      opts({ profile: "fit", seatOverrides: { implementer: seat("anthropic", "claude-fable-5-2") } }));
    const run = runJson(r);
    const work = run.turns.filter(t => t.purpose === "work");
    assert.equal(work[0].model, "claude-fable-5-2", `a fallback answered the first revision (${JSON.stringify(r.error)})`);
    assert.equal(work[0].selection.fallback, true);
    const ran = work[0].settings.effort;
    assert.ok(ran, "the answering seat ran at an effort of its own");
    const esc = run.escalations.find(e => e.slot === "code" && e.rev === 1);
    assert.ok(esc, "the failed acceptance was escalated");
    assert.equal(esc.seat.model, "claude-fable-5-2");
    // An operator's seat carries no effort of its own: it ran at the model's documented default, and that is where the
    // escalation starts.
    assert.equal(esc.seat.effort ?? documentedDefaultEffort("claude-fable-5-2"), ran, "the escalation's input is the effort the answering seat ran with");
    assert.equal(esc.decision.action, "raise_effort");
    const ladder = documentedEfforts("claude-fable-5-2");
    assert.equal(esc.decision.to.effort, ladder[ladder.indexOf(ran) + 1], "raised one step from what the answering seat ran with");
    const fable = calls.filter(c => WORK.test(c.prompt) && c.model === "claude-fable-5-2");
    assert.deepEqual(fable.map(c => c.effort), [ran, esc.decision.to.effort], "the next revision carried the raised effort");
    assert.equal(r.shipped, true, JSON.stringify(r.error));
  });
});

test("fit, critical stakes with NO overrides: producers are chosen on their own merits, never co-seated to make a panel", async () => {
  // Owner control contract: do not force title/file workers onto one vendor to manufacture a numeric review
  // panel. fit's own planner (anthropic) and maker (openai) leave two in-run reviewer labs; the run is pending.
  await withDispatch(async ({ spec, opts, calls }) => {
    const r = await runOpenItem(spec("fitCriticalDefault", { stakes: "critical" }), opts({ profile: "fit" }));
    assert.equal(r.shipped, false);
    assert.match(r.error.message, /REVIEW_CAPACITY_PENDING/);
    const run = runJson(r);
    const plan = run.turns.find(t => t.purpose === "plan");
    assert.equal(lab(plan), "anthropic", "the planner is fit's own choice, not moved to openai");
    for (const t of run.turns) assert.ok(!(t.selection.excluded ?? []).some(e => /reserved/.test(e.why)), "no lab is reserved");
    assert.equal(calls.filter(c => WORK.test(c.prompt)).length, 0);
  });
});

test("fit, high stakes with NO overrides: at most one producer takes a reviewer lab, so two independent labs review", async () => {
  await withDispatch(async ({ spec, opts }) => {
    const r = await runOpenItem(spec("fitHighDefault", { stakes: "high" }), opts({ profile: "fit" }));
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const run = runJson(r);
    const critiques = run.turns.filter(t => t.purpose === "critique");
    assert.equal(new Set(critiques.map(lab)).size, 2);
  });
});
