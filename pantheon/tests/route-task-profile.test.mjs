// The `fit` routing candidate: a task profile with independent dimensions, each driving its own dial
// (docs/routing-task-profile.md). `fit` is a CANDIDATE, not the default: `argo` stays the approved policy,
// and these tests pin that `argo` (and `legacy`) are unchanged byte-for-byte while `fit` reaches the breadth
// of registered models and effort levels. Nothing here measures quality; the class table is provisional.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTicket } from "../src/board/operate.mjs";
import { selectSeat, selectionPolicy, frontierCandidates, registryModels } from "../src/route/frontier.mjs";
import { taskProfile, effortForDepth, classFloor, DIMENSIONS } from "../src/route/task-profile.mjs";
import { documentedDefaultEffort } from "../src/route/protocol.mjs";
import { outputBudgetFor, TOKEN_TIERS } from "../src/config/tiers.mjs";
import { labOf } from "../src/config/models.mjs";
import { runOpenItem } from "../src/board/run-item.mjs";
import { withDispatch, WORK } from "./fixtures/dispatch.mjs";
import { optIn } from "./fixtures/billing.mjs";

const CLASSES = JSON.parse(readFileSync(new URL("../src/config/classes.json", import.meta.url), "utf8"));
const classOf = m => CLASSES.models[m]?.class;
const ROLES = ["planner", "implementer", "reviewer", "scout"];
const firstSeat = (role, o) => selectSeat(role, o).seat;

test("taskProfile: legacy difficulty maps to a default profile; explicit fields win; every dimension names its basis", () => {
  const easy = taskProfile({ difficulty: "easy" });
  // easy carries LOW stakes since 2026-11-17 (owner direction, the fit matrix): with normal stakes its class floor was
  // standard, so no easy ticket could reach the matrix's easy column.
  assert.deepEqual([easy.depth.value, easy.output.value, easy.stakes.value, easy.ambiguity.value], ["light", "s", "low", "settled"]);
  const medium = taskProfile({ difficulty: "medium" });
  assert.deepEqual([medium.depth.value, medium.output.value, medium.stakes.value, medium.ambiguity.value], ["standard", "m", "normal", "open"]);
  const hard = taskProfile({ difficulty: "hard" });
  assert.deepEqual([hard.depth.value, hard.output.value, hard.stakes.value, hard.ambiguity.value], ["deep", "l", "high", "open"]);
  for (const k of ["depth", "output", "stakes", "ambiguity"]) assert.equal(hard[k].basis, "legacy-difficulty");
  const mixed = taskProfile({ difficulty: "easy", depth: "max", output: "xl" });
  assert.deepEqual([mixed.depth, mixed.output], [{ value: "max", basis: "ticket" }, { value: "xl", basis: "ticket" }]);
  assert.equal(mixed.stakes.basis, "legacy-difficulty", "a field the ticket does not name keeps the legacy default");
  for (const p of [easy, medium, hard, mixed]) for (const k of Object.keys(DIMENSIONS)) {
    assert.match(p[k].basis, /^(ticket|derived:[a-z-]+|legacy-difficulty)$/, `${k} has a basis`);
  }
  assert.throws(() => taskProfile({ depth: "enormous" }), /depth/);
  assert.throws(() => taskProfile({ context: 500000 }), /measured/, "context is measured, never declared");
});

test("output tiers: xs..xl extend the table additively; easy/medium/hard keep their budgets and stay the difficulty keys", () => {
  assert.deepEqual(TOKEN_TIERS, { easy: 4096, medium: 16384, hard: 32768 }, "the difficulty-keyed table is unchanged");
  assert.deepEqual(["xs", "s", "m", "l", "xl"].map(t => outputBudgetFor("claude-sonnet-5", t).tokens), [1024, 4096, 16384, 32768, 65536]);
  for (const [alias, tier] of [["easy", "s"], ["medium", "m"], ["hard", "l"]]) {
    assert.equal(outputBudgetFor("claude-sonnet-5", alias).tokens, outputBudgetFor("claude-sonnet-5", tier).tokens);
  }
  assert.equal(outputBudgetFor("claude-haiku-4-5-20251001", "xl").tokens, 64000, "still capped at the documented ceiling");
});

test("stakes from paths: ledger/governance/authority/key/security -> critical (frontier floor, 3 review labs); tests/docs-only -> low", () => {
  for (const path of ["packages/ledger/src/append.mjs", "ophanim/governance/pins.json", "src/authority.mjs", "config/keys/signing.pem", "src/security/check.mjs"]) {
    const p = taskProfile({ difficulty: "easy" }, { paths: [path] });
    assert.deepEqual(p.stakes, { value: "critical", basis: "derived:paths" }, path);
    const s = selectSeat("implementer", { profile: "fit", task: p }).selection;
    assert.equal(s.class_floor.value, "frontier", path);
    assert.equal(s.requirements.review_labs.value, 3, path);
    assert.equal(classOf(s.class.model), "frontier");
  }
  const docs = taskProfile({ difficulty: "hard" }, { paths: ["docs/guide.md", "pantheon/tests/x.test.mjs"] });
  assert.deepEqual(docs.stakes, { value: "low", basis: "derived:paths" }, "tests/docs-only is low, over the legacy hard default");
  const s = selectSeat("implementer", { profile: "fit", task: docs }).selection;
  // A floor RAISES a pick and never lowers it (owner direction 2026-11-17): the profile's own floor is fast, and the
  // hard ticket stays in the hard column.
  assert.equal(classFloor(docs, "implementer").value, "fast");
  assert.equal(s.class_floor.value, "frontier");
  assert.deepEqual([s.matrix.difficulty, s.matrix.raised, s.matrix.pick], ["hard", false, "gemini-4-carbon"]);
  assert.equal(s.requirements.review_labs.value, 1);
  const ordinary = taskProfile({ difficulty: "medium" }, { paths: ["src/feature.mjs"] });
  assert.equal(ordinary.stakes.value, "normal");
  const pinned = taskProfile({ difficulty: "medium", stakes: "low" }, { paths: ["packages/ledger/x.mjs"] });
  assert.deepEqual(pinned.stakes, { value: "low", basis: "ticket" }, "the ticket's field overrides the derived value");
  assert.equal(classFloor(taskProfile({ ambiguity: "contested" }), "planner").value, "frontier", "ambiguity floors the planner");
  assert.equal(selectSeat("planner", { profile: "fit", task: taskProfile({ ambiguity: "contested", difficulty: "easy" }) }).selection.requirements.explorer_width.value, 3);
});

test("fit: two tickets with the same legacy difficulty but different stakes/depth get different seats and efforts", () => {
  const routine = taskProfile({ difficulty: "medium", stakes: "low", depth: "light" });
  const grave = taskProfile({ difficulty: "medium", stakes: "critical", depth: "max" });
  for (const role of ["planner", "implementer", "reviewer"]) {
    const a = firstSeat(role, { profile: "fit", task: routine }), b = firstSeat(role, { profile: "fit", task: grave });
    assert.notDeepEqual([a.model, a.effort], [b.model, b.effort], `${role}: ${a.model}@${a.effort} vs ${b.model}@${b.effort}`);
    // Critical stakes raise the matrix column (medium -> hard). The class rises with it, except where the matrix's
    // medium and hard picks share a class (the planner: both of its picks are frontier).
    const col = x => ["easy", "medium", "hard"].indexOf(x.selection.matrix.difficulty);
    assert.ok(col(b) > col(a), `${role}: critical stakes seat a higher matrix column`);
    assert.equal(b.selection.matrix.raised, true);
    assert.ok(CLASSES.order.indexOf(classOf(b.model)) >= CLASSES.order.indexOf(classOf(a.model)), `${role}: and never a lower class`);
    if (role !== "planner") assert.ok(CLASSES.order.indexOf(classOf(b.model)) > CLASSES.order.indexOf(classOf(a.model)), `${role}: critical stakes seat a higher class`);
  }
  // And with no explicit dimension, the legacy band still discriminates under `fit`.
  assert.notDeepEqual(firstSeat("implementer", { profile: "fit", difficulty: "easy" }), firstSeat("implementer", { profile: "fit", difficulty: "hard" }));
});

test("argo was re-pinned 2026-11-17 when its Google seats went through Antigravity first; legacy was re-pinned 2026-11-17 when the Claude-via-Antigravity rungs were removed, and again when the Antigravity Gemini fallbacks were appended", () => {
  // argo: RE-PINNED 2026-11-17, owner direction: Gemini goes through Antigravity first. It was
  // sha256:d055a577...ee56 from the tree before fit existed (e481e77) until then. The seat table is the same; the
  // policy now also hashes how its Google seats are served (the `-high` Antigravity lane each starts on, and the rule
  // that keeps the metered API id only as that lane's 429/quota failover), so it is a different policy and must not
  // be reported under the old hash.
  assert.equal(selectionPolicy("argo").hash, "sha256:f698663054f75b33a39ba38f37ad13b5566ef899c585ab063cafff4df039d5e0");
  assert.notEqual(selectionPolicy("argo").hash, "sha256:d055a577fcff3536e3d0692deab71821d49b78f48bbe5b6ba188065bdcf9ee56");
  // legacy: RE-PINNED 2026-11-17. It was sha256:276ee015...b07d (e481e77) until the three Claude rungs that ran
  // through Antigravity left the seating tables (owner direction: Antigravity serves Gemini models only). The
  // legacy policy hashes those tables, so the hash and the implementer candidates below changed with them.
  // RE-PINNED AGAIN the same day, from sha256:ab6ad2bd...2969, when the unbanded Antigravity Gemini fallbacks
  // were appended to the planner and implementer ladders (owner direction: "seat Carbon and the other Gemini
  // ids through Antigravity"). They trail every candidate list below and lead none.
  // RE-PINNED 2026-11-19, from sha256:87225451...8df9, when the reviewer reseat and the judge's Google seat moved from
  // gemini-3.6-flash (no Antigravity lane: served by the metered Gemini API even with the metered failover off) to the
  // gemini-3.8-flash-high lane (independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6),
  // finding 6). The legacy policy hashes the seating tables.
  assert.equal(selectionPolicy("legacy").hash, "sha256:0000f574015cf50f5ebcd93e7284df2581412546035a516296a49c4a2724d7e3");
  assert.notEqual(selectionPolicy("legacy").hash, "sha256:87225451d514070ffba7a5468174b8230aa3343988a58a73fc748f83b9208df9",
    "the legacy policy that seated gemini-3.6-flash is a different policy and must not be reported under the same hash");
  assert.notEqual(selectionPolicy("legacy").hash, "sha256:ab6ad2bdb11347f3b79d188a78219e35c898c6db92eb4599e2a8f503f7ae2969",
    "the legacy policy from before the Antigravity Gemini fallbacks is a different policy and must not be reported under the same hash");
  assert.notEqual(selectionPolicy("legacy").hash, "sha256:276ee015018d940fb1c94aca42d9da1c3f1a3e55dc116deccc76726ab6b9b07d",
    "the pre-2026-11-17 legacy policy is a different policy and must not be reported under the same hash");
  // Each Google seat: its Antigravity lane, then the metered API id as that lane's quota failover.
  const ARGO = { planner: "claude-fable-5-2,gemini-4-carbon-high,gemini-4-carbon,gpt-6-astra", implementer: "gpt-6-astra,claude-fable-5-2,gemini-4-carbon-high,gemini-4-carbon",
    reviewer: "grok-4.7,gemini-4-carbon-high,gemini-4-carbon", scout: "grok-4.3", synthesis: "gemini-4-carbon-high,gemini-4-carbon", fast_loop: "gemini-4-argon-high,gemini-4-argon" };
  const task = taskProfile({ difficulty: "easy", stakes: "critical", depth: "max" });
  for (const [role, want] of Object.entries(ARGO)) for (const difficulty of ["easy", "medium", "hard"]) {
    const s = selectSeat(role, { profile: "argo", difficulty, task });
    assert.equal(s.candidates.map(c => c.model).join(","), want, `${role}/${difficulty}`);
    assert.equal(s.candidates.map(c => c.model).join(","), [...new Set(frontierCandidates(role).map(c => c.model))].join(","));
    assert.ok(s.candidates.every(c => c.effort === undefined), "argo sets no up-front effort");
    for (const c of s.candidates.filter(c => c.vendor === "agy_google" && c.transport === "api")) {
      assert.deepEqual(c.quota_failover, { base: c.model, lanes: [`${c.model}-high`] }, `${role}: the metered API id is only its lane's quota failover`);
      assert.equal(c.selection.quota_failover.used, false);
    }
  }
  const LEGACY = { easy: "gpt-6-luna,gpt-6-astra,gpt-6-sol,gemini-4-carbon-high,gemini-4-argon-high",
    medium: "gpt-6-sol,gpt-6-astra,gpt-6-luna,gemini-4-carbon-high,gemini-4-argon-high",
    hard: "gpt-6-astra,gpt-6-sol,gpt-6-luna,gemini-4-carbon-high,gemini-4-argon-high" };
  for (const [difficulty, want] of Object.entries(LEGACY)) {
    assert.equal(selectSeat("implementer", { profile: "legacy", difficulty }).candidates.map(c => c.model).join(","), want);
  }
  const LEGACY_PLANNER = { easy: "claude-opus-5-5,claude-fable-5-2,gpt-6-sol,gemini-4-carbon-high",
    medium: "claude-opus-5-5,claude-fable-5-2,gpt-6-sol,gemini-4-carbon-high",
    hard: "claude-fable-5-2,claude-opus-5-5,gpt-6-sol,gemini-4-carbon-high" };
  for (const [difficulty, want] of Object.entries(LEGACY_PLANNER)) {
    assert.equal(selectSeat("planner", { profile: "legacy", difficulty }).candidates.map(c => c.model).join(","), want);
  }
  assert.notEqual(selectionPolicy("fit").hash, selectionPolicy("argo").hash);
});

test("fit reaches more distinct (model, effort) operating points across a varied ticket set than legacy or argo", t => {
  const tickets = [];
  for (const difficulty of ["easy", "medium", "hard"]) for (const stakes of [undefined, ...DIMENSIONS.stakes])
    for (const depth of [undefined, ...DIMENSIONS.depth]) for (const ambiguity of [undefined, "contested"])
      tickets.push({ difficulty, ...(stakes ? { stakes } : {}), ...(depth ? { depth } : {}), ...(ambiguity ? { ambiguity } : {}) });
  const points = profile => {
    const seen = new Set();
    for (const spec of tickets) for (const role of ROLES) {
      const s = selectSeat(role, { profile, difficulty: spec.difficulty, ...(profile === "fit" ? { task: taskProfile(spec) } : {}) }).seat;
      // argo and legacy choose no effort up front: the model runs at its documented default.
      seen.add(`${s.model}@${profile === "fit" ? s.effort : documentedDefaultEffort(s.model)}`);
    }
    return seen.size;
  };
  const counts = { legacy: points("legacy"), argo: points("argo"), fit: points("fit") };
  t.diagnostic(`distinct (model, effort) first-seat points over ${tickets.length} tickets x ${ROLES.length} roles: ${JSON.stringify(counts)}`);
  assert.ok(counts.fit > counts.legacy && counts.fit > counts.argo, JSON.stringify(counts));
});

test("effort maps onto each model's OWN documented ladder, and the mapping is recorded", () => {
  const max47 = effortForDepth("max", { vendor: "xai", model: "grok-4.7" });
  assert.equal(max47.value, "xhigh", "grok-4.7's ladder tops at xhigh");
  assert.match(max47.mapped, /xhigh|rung 3\/3/);
  assert.equal(effortForDepth("max", { vendor: "openai", model: "gpt-6-astra" }).value, "max");
  assert.equal(effortForDepth("standard", { vendor: "agy_google", model: "gemini-4-carbon" }).value, "medium");
  assert.equal(effortForDepth("none", { vendor: "openai", model: "gpt-6-luna" }).value, "none");
  const haiku = effortForDepth("max", { vendor: "anthropic", model: "claude-haiku-4-5-20251001" });
  assert.equal(haiku.value, null);
  assert.match(haiku.mapped, /no documented effort ladder/);
  const lane = effortForDepth("max", { vendor: "agy_google", model: "claude-sonnet-4-6" });
  assert.equal(lane.value, null);
  assert.match(lane.mapped, /not carried/);
  // Through the selector: the seat carries the mapped effort and the selection says how it was mapped.
  const s = selectSeat("reviewer", { profile: "fit", task: taskProfile({ stakes: "high", depth: "max" }), avoidLabs: ["openai"] });
  assert.equal(s.seat.model, "grok-4.7");
  assert.equal(s.seat.effort, "xhigh");
  assert.deepEqual(s.selection.effort.ladder, ["low", "medium", "high", "xhigh"]);
  assert.equal(s.selection.effort.depth, "max");
});

test("fit fallbacks cross labs at the same class before stepping class, and never go below the floor", () => {
  // The matrix pick leads (fit-matrix.mjs, owner direction 2026-11-17); the rule below is the order AFTER it. A metered
  // Gemini API id stands behind its Antigravity lane as a quota failover and is not a place in the lab rotation.
  for (const [role, stakes] of [["planner", "critical"], ["reviewer", "low"], ["planner", "normal"], ["reviewer", "normal"]]) {
    const { candidates, selection } = selectSeat(role, { profile: "fit", task: taskProfile({ difficulty: "medium", stakes }) });
    assert.equal(candidates[0].selection.eligibility, "fit-matrix", `${role}/${stakes}: the matrix pick leads`);
    const models = [...new Map(candidates.filter(c => c.selection.eligibility !== "fit-matrix" && !c.quota_failover).map(c => [c.model, c])).values()];
    const rank = c => CLASSES.order.indexOf(classOf(c.model));
    const floor = CLASSES.order.indexOf(selection.class_floor.value);
    for (const [i, c] of models.entries()) {
      assert.ok(rank(c) >= floor, `${role}/${stakes}: ${c.model} is not below the floor`);
      if (i) assert.ok(rank(c) >= rank(models[i - 1]), `${role}/${stakes}: class never steps back down (${models.map(m => m.model)})`);
    }
    for (const cls of new Set(models.map(rank))) {
      const inClass = models.filter(c => rank(c) === cls), labs = new Set(inClass.map(c => labOf(c.vendor, c.model)));
      // Where each lab first appears in the class: one of each lab before a second from any means the first appearances
      // are exactly the class's first labs.size positions (the rest of the class may repeat a lab).
      const firstAt = [...labs].map(lab => inClass.findIndex(c => labOf(c.vendor, c.model) === lab)).sort((a, b) => a - b);
      assert.deepEqual(firstAt, [...labs].map((_, i) => i), `${role}/${stakes}: one of each lab before a second from any (${inClass.map(c => c.model)})`);
    }
    assert.ok(models.some(c => labOf(c.vendor, c.model) !== labOf(candidates[0].vendor, candidates[0].model)), "the fallback set reaches another lab");
  }
  // The implementer's order is its matrix ladder, nothing else (owner direction 2026-11-19: the Gemini API itself, with
  // no Antigravity lane in front and no failover seat behind).
  for (const [stakes, want] of [["low", "gemini-4-neon,gemini-4-argon"], ["critical", "gemini-4-carbon,gemini-4-hydrogen,gemini-4-argon"]]) {
    assert.equal(selectSeat("implementer", { profile: "fit", task: taskProfile({ difficulty: "medium", stakes }) }).candidates.map(c => c.model).join(","), want, `implementer/${stakes}`);
  }
});

test("fit candidates come from the whole registry the role's labs allow, and record which basis admitted each", () => {
  const registry = registryModels();
  // 19 API models since 2026-11-17: gemini-4-hydrogen (owner-stated), the quota failover of the Hydrogen lanes.
  assert.equal(registry.length, 32, "19 API registry models + the 13 live lane models; retired lanes are never candidates");
  const laneModels = registry.map(r => r.model).filter(m => /^gemini-(3\.8-flash|4-(carbon|argon|hydrogen))-(low|medium|high|xhigh)$/.test(m));
  assert.deepEqual(laneModels.sort(), [
    "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.8-flash-medium",
    "gemini-4-argon-high", "gemini-4-argon-low", "gemini-4-argon-medium",
    "gemini-4-carbon-high", "gemini-4-carbon-low", "gemini-4-carbon-medium",
    "gemini-4-hydrogen-high", "gemini-4-hydrogen-low", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-xhigh",
  ], "the 13 live Antigravity Gemini lanes (declared 2026-11-17), seated or not, are fit candidates");
  for (const retired of ["claude-sonnet-4-6", "claude-opus-4-6-thinking"]) assert.ok(!registry.some(r => r.model === retired), `${retired} is retired`);
  for (const { model } of registry) {
    const c = CLASSES.models[model];
    assert.ok(c && CLASSES.order.includes(c.class), `${model} has a declared class`);
    assert.equal(c.status, "provisional", `${model}: unmeasured, so provisional`);
    assert.ok(["VENDOR", "TASTE"].includes(c.basis), model);
    if (c.basis === "VENDOR") assert.ok(c.source && c.quote, `${model}: a VENDOR class carries its quoted source`);
  }
  // Shown on the planner: under the fit matrix the implementer's order is its lane ladder alone (above).
  const { candidates } = selectSeat("planner", { profile: "fit", task: taskProfile({}) });
  const seen = new Map(candidates.map(c => [c.model, c.selection.eligibility]));
  assert.equal(seen.get("claude-opus-5-5"), "fit-matrix", "the matrix pick");
  assert.equal(seen.get("gpt-6-sol"), "role-table");
  assert.match(seen.get("gpt-6.1-sol"), /^lab-allowed:openai$/, "a registry model the role's tables never named, admitted by lab");
  assert.ok(!candidates.some(c => labOf(c.vendor, c.model) === "xai"), "a lab no planner table allows is not reached");
  const r = selectSeat("implementer", { profile: "fit", task: taskProfile({}) }).selection;
  assert.equal(r.kind.filter, "unfiltered");
  assert.match(r.kind.why, /no cited capability fact/);
});

test("fit still excludes unrecorded windows (M7) against a measured context estimate", () => {
  const s = selectSeat("planner", { profile: "fit", needsContext: 3000, task: taskProfile({ difficulty: "medium" }) });
  for (const lane of ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gemini-3.8-flash-high"]) {
    assert.ok(!s.candidates.some(c => c.model === lane), `${lane} is not admitted`);
  }
  // The retired Claude lanes are not candidates at all, so they are not listed as excluded either.
  assert.ok(!s.selection.excluded.some(e => /^claude-(sonnet|opus)-4-6/.test(e.model)));
  // Every LIVE lane has a cited window since 2026-11-17 (lanes.json, owner direction), so the live lane is now
  // admitted on that bound and refused beyond it; no live candidate is left with an unrecorded window to exclude.
  const scout = selectSeat("scout", { profile: "fit", needsContext: 3000, task: taskProfile({ difficulty: "easy" }) });
  assert.ok(scout.candidates.some(c => c.model === "gemini-3.8-flash-high"), "the lane is admitted on its cited window");
  assert.ok(!scout.selection.excluded.some(e => /window unrecorded/.test(e.why)), JSON.stringify(scout.selection.excluded));
  assert.throws(() => selectSeat("scout", { profile: "fit", needsContext: 2_000_000, task: taskProfile({ difficulty: "easy" }) }), /no admitted candidate/,
    "work larger than every cited window is admitted nowhere, the lanes included");
  assert.deepEqual(s.selection.task.context, { value: 3000, basis: "derived:prompt-chars" });
  const big = selectSeat("reviewer", { profile: "fit", needsContext: 600000, task: taskProfile({}) });
  assert.ok(big.candidates.every(c => !/^grok-4\.[567]$/.test(c.model)), "500k-window models are excluded for a 600k estimate");
  assert.ok(big.selection.excluded.some(e => e.model === "grok-4.6" && /documented window 500000 < estimated 600000/.test(e.why)));
});

test("board tickets may declare the fit dimensions; a value outside a dimension's set is refused before seating", () => {
  const repo = mkdtempSync(join(tmpdir(), "pantheon-fit-ticket-"));
  try {
    writeFileSync(join(repo, "a.mjs"), "export {};\n");
    mkdirSync(join(repo, "tickets"));
    const write = extra => writeFileSync(join(repo, "tickets", "x.json"), JSON.stringify({ schema: "ophanim.ticket/v1", item: "x", slice: "one file",
      proposes: { state: "Ready", basis: "b" }, title: "t", goal: "g", question: "q", repo_root: ".", slot: "a", path: "a.mjs", copy: ["a.mjs"],
      acceptance_cmd: "node a.mjs", ...extra }));
    write({ stakes: "critical", depth: "max", output: "xl", ambiguity: "contested", latency: "interactive", kind: "review" });
    const ok = readTicket({ repo, item: "x" });
    assert.equal(ok.why, undefined);
    assert.deepEqual([ok.spec.stakes, ok.spec.depth, ok.spec.output], ["critical", "max", "xl"], "the dimensions reach runOpenItem's spec");
    write({ depth: "enormous" });
    assert.match(readTicket({ repo, item: "x" }).why, /unknown depth "enormous"/);
    write({ context: 9000 });
    assert.match(readTicket({ repo, item: "x" }).why, /unknown ticket field\(s\): context/, "context is measured, never declared");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("fit through the real dispatcher: every turn records the profile, and the request carries the mapped effort", async () => {
  await withDispatch(async ({ spec, opts, calls, agy }) => {
    const r = await runOpenItem(spec("fitRun", { difficulty: "medium", depth: "max" }), opts({ profile: "fit", billing: optIn({ primary: 100 }) }));
    assert.equal(r.shipped, true, JSON.stringify(r.error));
    const run = JSON.parse(readFileSync(join(r.board, "run.json"), "utf8"));
    assert.ok(run.turns.length >= 4);
    for (const t of run.turns) {
      assert.equal(t.selection?.profile, "fit", `${t.purpose} records the profile`);
      assert.deepEqual(t.selection.task.depth, { value: "max", basis: "ticket" }, `${t.purpose} records the dimensions with their bases`);
      assert.equal(t.selection.task.stakes.basis, "derived:paths");
      assert.match(t.selection.policy_hash, /^sha256:/);
    }
    for (const purpose of ["plan", "work", "critique"]) {
      const turn = run.turns.find(t => t.purpose === purpose);
      assert.ok(turn, `a ${purpose} turn ran`);
      assert.equal(turn.selection.source, "policy");
      const want = turn.selection.effort.value;
      if (purpose === "work") {
        // The fit matrix's medium implementer is gemini-4-neon, whose window is unrecorded: it is not admitted against
        // the prompt's context estimate, so the next rung answers (fit-sdk-routing.test.mjs). On this per-file board the
        // implementer is one tool-less turn through the Gemini API, at the thinking level the matrix seats the model at
        // (not the task depth's): no agy CLI lane is started for it.
        assert.deepEqual([turn.model, turn.transport, want], ["gemini-4-argon", "api", "high"]);
        assert.match(turn.selection.effort.mapped, /the thinking level the fit matrix seats gemini-4-argon at/);
        assert.ok(turn.selection.excluded.some(e => e.model === "gemini-4-neon" && /window unrecorded/.test(e.why)), "the pick it could not admit is on the record, with the reason");
        assert.deepEqual(agy().filter(a => a.agent === "pantheon-implementer"), [], "no agy CLI implementer ran");
        assert.deepEqual(calls.filter(c => WORK.test(c.prompt)).map(c => [c.vendor, c.model, c.effort]), [["agy_google", "gemini-4-argon", "high"]]);
        continue;
      }
      assert.ok(want, `${purpose}: an effort was chosen up front (${turn.model})`);
      const asked = calls.filter(c => c.model === turn.model);
      assert.ok(asked.length, `${purpose}: ${turn.model} was requested`);
      assert.ok(asked.every(c => c.effort === want), `${purpose}: the request carried effort ${want} (got ${asked.map(c => c.effort)})`);
      assert.ok(Number.isInteger(turn.selection.requirements.review_labs.value));
    }
    assert.equal(run.turns.filter(t => t.purpose === "work").length, 1);
  });
});
