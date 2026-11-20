// THE RESEARCH TEAM'S CONTROLLER (src/antigravity/research.mjs; owner direction 2026-11-20), with scripted nodes: no
// session, no provider, no clock. A node here is a function that returns what a research session returns (its answer,
// what the controller saw it examine, the model that answered, its usage). Each test names the defect it would catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runResearchTeam, nodeId, reportRefusal, RESEARCH_TEAM_SCHEMA } from "../src/antigravity/research.mjs";
import { researchSeat, researchSubordinate, researchLimits } from "../src/route/fit-matrix.mjs";

const CARBON = researchSeat("researcher"), HYDROGEN = researchSubordinate();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const V = n => "sha256:" + "".padStart(64, String(n));   // a digest-shaped version: 64 copies of one digit
const src = (path, n = 1) => ({ tool: "view_file", path, kind: "file", sha256: V(n), bytes: 10 });
/** A specialist's report: one observation on `path`, optionally one open question. */
const report = ({ question = "q", path = "src/a.mjs", text = `what ${path} does`, open = null, next = [] } = {}) => ({ question, sources: [{ ref: path }],
  observations: [{ id: "o1", text, sources: [path] }], hypotheses: [], dependencies: [], unresolved: open ? [{ id: open, question: `what about ${open}?`, why: "not visible from here" }] : [], next });
/** A coordinator's report. */
const lead = ({ delegations = [], satisfied = false, material = false, open = ["u1"], summary = "so far", own = null } = {}) => ({ question: "root", ...(own ? { own } : {}), sources: own ? [{ ref: own }] : [],
  observations: own ? [{ id: "o1", text: `what ${own} shows`, sources: [own] }] : [], hypotheses: [], dependencies: [],
  unresolved: open.map(id => ({ id, question: `open ${id}: which module owns the retry?`, why: "needs a specialist" })), next: [], delegations, satisfied, material, summary });
const ask = (addresses, over = {}) => ({ addresses, question: `Trace how ${addresses} is resolved through the scheduler's retry path.`, specialty: "execution-trace", scope: ["src"],
  expected_evidence: "the functions on the path, with file and line", why: "the plan cannot be judged without it", ...over });

const TEAM = { id: "team-1", item: "two", role: "researcher", trigger: "intake", question: "How does the scheduler retry a pending stage, and what bounds it?", scope: ["src", "docs"], head: "c0ffee" };
/** Run a team over a script: coordinator(round, prompt, ctx) -> report; specialist(node, prompt, ctx) -> {report, examined?, ...}. */
function team({ coordinator, specialist = () => ({ report: report() }), limits = {}, seat = CARBON, over = {} } = {}) {
  const calls = [], events = [], prompts = [];
  let active = 0, peak = 0;
  const runNode = async ({ node, prompt, seat: s, signal, admit }) => {
    calls.push({ id: node.id, kind: node.kind, round: node.round ?? null, model: s.model });
    prompts.push({ id: node.id, kind: node.kind, round: node.round ?? null, prompt });
    if (node.kind === "coordinator") { admit({ class: "root", model: s.model }); const { own = null, ...rep } = (await coordinator(node.round, prompt, { admit, signal })) ?? {};
      return { text: JSON.stringify(typeof rep === "object" && Object.keys(rep).length ? rep : "not a report"), examined: own ? [src(own)] : [], served_model: s.model, served_model_source: "provider", usage: { total_token_count: 100 } }; }
    active += 1; peak = Math.max(peak, active);
    try {
      admit({ class: "root", model: s.model });
      const r = await specialist(node, prompt, { admit, signal });
      return { text: JSON.stringify(r.report), examined: r.examined ?? r.report.sources.map(x => src(x.ref)), served_model: r.served_model ?? s.model, served_model_source: "provider", usage: { total_token_count: 50 } };
    } finally { active -= 1; }
  };
  const run = (more = {}) => runResearchTeam({ team: TEAM, coordinator: seat, subordinate: HYDROGEN, limits: { ...researchLimits(seat.seat.model), ...limits }, runNode,
    record: async e => { events.push(e); }, now: () => "2026-11-20T00:00:00.000Z", ...over, ...more });
  return { run, calls, events, prompts, peak: () => peak };
}

test("AN AGENT DELEGATES A BOUNDED QUESTION AND RECEIVES EVIDENCE-BACKED RESULTS: each specialist has an identity, a parent, a question, a scope and bounds before it runs; its findings come back to the coordinator concise and source-linked; the full report is kept", async () => {
  const t = team({
    coordinator: round => (round === 1 ? lead({ delegations: [ask("u1"), ask("u1", { question: "List every caller of the retry scheduler under src, with file and line.", specialty: "source-inventory" })] })
      : lead({ satisfied: true, material: true, open: [], summary: "the retry is bounded by stage_attempts" })),
    specialist: node => ({ report: report({ question: node.question, path: node.specialty === "execution-trace" ? "src/scheduler.mjs" : "src/gates.mjs", text: `finding of ${node.specialty}: the retry is bounded`, open: "u9" }) }),
  });
  const r = await t.run();
  assert.deepEqual([r.schema, r.status, r.satisfied, r.material, r.rounds], [RESEARCH_TEAM_SCHEMA, "satisfied", true, true, 2]);
  const spec = r.nodes.filter(n => n.kind === "specialist"), root = r.nodes.find(n => n.kind === "coordinator");
  assert.deepEqual(spec.map(n => [n.depth, n.parent, n.seat.model, n.state, n.specialty]), [[2, root.id, "gemini-4-hydrogen", "finished", "execution-trace"], [2, root.id, "gemini-4-hydrogen", "finished", "source-inventory"]]);
  assert.deepEqual([root.depth, root.parent, root.seat.model], [1, null, "gemini-4-carbon"]);
  for (const n of spec) {
    assert.equal(n.id, nodeId({ team: TEAM.id, parent: root.id, addresses: "u1", question: n.question }), "the identity is a function of the team, the parent, the gap and the question");
    assert.deepEqual([n.scope, n.addresses, typeof n.expected_evidence, n.bounds.model_calls > 0, n.tools.includes("view_file")], [["src"], "u1", "string", true, true]);
    // PERSISTENT BEFORE IT RUNS: the admitted record precedes the session.
    const admitted = t.events.findIndex(e => e.event === "node" && e.node.id === n.id && e.node.state === "admitted"), finished = t.events.findIndex(e => e.event === "node" && e.node.id === n.id && e.node.state === "finished");
    assert.ok(admitted >= 0 && admitted < finished, "admitted is recorded before finished");
    // THE FULL REPORT IS KEPT, with the version of every source as the controller saw it.
    assert.deepEqual(n.report.sources.map(x => [x.ref, x.version]), [[n.specialty === "execution-trace" ? "src/scheduler.mjs" : "src/gates.mjs", V(1)]]);
  }
  // WHAT WENT BACK UP: the second coordinator session is given each finding with its source and version, not a transcript.
  const second = t.prompts.find(p => p.kind === "coordinator" && p.round === 2).prompt;
  const shown = "@sha256:" + "".padStart(12, "1");   // a version as the coordinator is shown it: the first 19 characters
  for (const n of spec) assert.ok(second.includes(n.id) && second.includes(`finding of ${n.specialty}: the retry is bounded`) && second.includes(shown), "concise, source-linked");
  assert.ok(second.includes("u9"), "a specialist's open question reaches the coordinator");
  assert.deepEqual(r.knowledge.observations.map(o => [o.text, o.evidence.map(e => [e.ref, e.version, e.nodes.length])]), spec.map(n => [`finding of ${n.specialty}: the retry is bounded`, [[n.report.sources[0].ref, V(1), 1]]]));
  assert.deepEqual(r.contributors.map(c => [c.kind, c.depth, c.requested_model, c.served_model]), [["coordinator", 1, "gemini-4-carbon", "gemini-4-carbon"], ["specialist", 2, "gemini-4-hydrogen", "gemini-4-hydrogen"], ["specialist", 2, "gemini-4-hydrogen", "gemini-4-hydrogen"]]);
});

test("NESTED DELEGATION REACHES LEVEL 10 WHEN EACH LEVEL NAMES A GAP OF THE ONE ABOVE, AND LEVEL 11 IS REFUSED AND RECORDED; depth is not concurrency: one node per level", async () => {
  const chain = [];
  const t = team({
    coordinator: round => {
      const parent = chain.at(-1) ?? null;   // the node whose open question the next level pursues
      return lead({ delegations: [ask(parent ? `gap-${chain.length + 1}` : "u1", { ...(parent ? { parent: parent.id } : {}), question: `Follow the open question of level ${chain.length + 1} one step further into the code.` })] });
    },
    specialist: node => { chain.push(node); return { report: report({ question: node.question, path: `src/level-${node.depth}.mjs`, open: `gap-${chain.length + 1}` }) }; },
  });
  const r = await t.run();
  assert.deepEqual(chain.map(n => n.depth), [2, 3, 4, 5, 6, 7, 8, 9, 10], "one level per justified gap, down to 10");
  assert.deepEqual(chain.map((n, i) => n.parent === (i ? chain[i - 1].id : r.nodes.find(x => x.kind === "coordinator").id)), chain.map(() => true), "each level's parent is the node above it");
  assert.deepEqual(r.refusals.map(x => [x.code, x.attempted_depth, x.parent]), [["RESEARCH_DEPTH_EXCEEDED", 11, chain.at(-1).id]]);
  assert.match(r.refusals[0].reason, /level 11 .*at most 10/);
  assert.ok(t.events.some(e => e.event === "refusal" && e.refusal.code === "RESEARCH_DEPTH_EXCEEDED"), "the refusal is recorded, not only returned");
  assert.deepEqual([r.status, r.stop_reason, r.telemetry.depth_reached, r.telemetry.active_peak, r.telemetry.nodes_created], ["exhausted", "NOTHING_ADMISSIBLE", 10, 1, 9]);
  assert.equal(t.calls.filter(c => c.kind === "specialist").length, 9, "nothing ran at level 11");
});

test("THE SUBORDINATES ACTIVE AT ONCE NEVER EXCEED THE COORDINATOR MODEL'S CEILING: 8 under Carbon, 4 under Neon, and a Hydrogen coordinator delegates to none", async () => {
  const many = n => Array.from({ length: n }, (_, i) => ask("u1", { question: `Inventory the sources of subsystem number ${i + 1} under src, with paths.`, specialty: "source-inventory" }));
  const slow = async node => { await sleep(15); return { report: report({ question: node.question }) }; };
  const carbon = team({ coordinator: round => (round === 1 ? lead({ delegations: many(20) }) : lead({ satisfied: true, open: [] })), specialist: slow });
  const r = await carbon.run();
  assert.deepEqual([carbon.peak(), r.telemetry.active_peak, r.telemetry.nodes_created, r.nodes.filter(n => n.state === "finished" && n.kind === "specialist").length], [8, 8, 20, 20]);
  const neonSeat = { seat: { ...CARBON.seat, model: "gemini-4-neon", effort: null }, selection: CARBON.selection };
  const neon = team({ seat: neonSeat, coordinator: round => (round === 1 ? lead({ delegations: many(9) }) : lead({ satisfied: true, open: [] })), specialist: slow });
  assert.deepEqual([(await neon.run()).telemetry.active_peak, neon.peak()], [4, 4]);
  const hSeat = { seat: { ...CARBON.seat, model: "gemini-4-hydrogen", effort: "medium" }, selection: CARBON.selection };
  const hydrogen = team({ seat: hSeat, coordinator: () => lead({ delegations: many(1) }) });
  const h = await hydrogen.run();
  assert.deepEqual([h.refusals.map(x => x.code), hydrogen.calls.filter(c => c.kind === "specialist").length], [["RESEARCH_NO_SUBORDINATES"], 0]);
});

test("A DELEGATION IS ADMITTED ONLY FOR A NAMED GAP, WITH A QUESTION, A SCOPE INSIDE THE TEAM'S, READ TOOLS, BOUNDS AND THE EVIDENCE EXPECTED; each refusal is recorded and nothing of it runs", async () => {
  const bad = [
    [ask("u7"), "RESEARCH_UNJUSTIFIED", /names no open question of its parent \(u7\)/],
    [ask(undefined), "RESEARCH_UNJUSTIFIED", /names no open question/],
    [ask("u1", { question: "why?" }), "RESEARCH_UNJUSTIFIED", /question of at least \d+ characters/],
    [ask("u1", { expected_evidence: "" }), "RESEARCH_UNJUSTIFIED", /expected evidence/],
    [ask("u1", { why: " " }), "RESEARCH_UNJUSTIFIED", /why the gap matters/],
    [ask("u1", { specialty: "write-the-fix" }), "RESEARCH_SPECIALTY", /write-the-fix/],
    [ask("u1", { scope: ["src", "../etc"] }), "RESEARCH_SCOPE", /\.\.\/etc/],
    [ask("u1", { scope: ["secrets"] }), "RESEARCH_SCOPE", /secrets.*outside the team's scope/],
    [ask("u1", { tools: ["view_file", "run_command"] }), "RESEARCH_TOOLS", /run_command/],
    [ask("u1", { parent: "rn-0000000000000000" }), "RESEARCH_PARENT_UNKNOWN", /rn-0000000000000000/],
    [ask("u1", { bounds: { model_calls: 10_000 } }), "RESEARCH_BOUNDS", /model_calls/],
  ];
  const t = team({ coordinator: round => (round === 1 ? lead({ delegations: [...bad.map(b => b[0]), ask("u1"), ask("u1")] }) : lead({ satisfied: true, open: [] })) });
  const r = await t.run();
  assert.deepEqual(r.refusals.map(x => x.code), [...bad.map(b => b[1]), "RESEARCH_DUPLICATE"]);
  bad.forEach(([, , re], i) => assert.match(r.refusals[i].reason, re));
  assert.equal(t.calls.filter(c => c.kind === "specialist").length, 1, "only the one admissible delegation ran");
  assert.equal(t.events.filter(e => e.event === "refusal").length, bad.length + 1);
  // THE NODE BUDGET: a team creates at most max_nodes specialists.
  const capped = team({ limits: { max_nodes: 2 }, coordinator: round => (round === 1 ? lead({ delegations: [1, 2, 3].map(i => ask("u1", { question: `Inventory the sources of part ${i} of the scheduler under src.` })) }) : lead({ satisfied: true, open: [] })) });
  const c = await capped.run();
  assert.deepEqual([c.refusals.map(x => x.code), c.telemetry.nodes_created], [["RESEARCH_NODE_BUDGET"], 2]);
});

test("A REPORT IS HELD TO WHAT ITS NODE EXAMINED: all seven parts are required, a source the controller never saw it read is refused, and a refused report's claims enter nothing", async () => {
  const good = report(), examined = [src("src/a.mjs")];
  assert.deepEqual(reportRefusal(good, { examined }), []);
  for (const k of ["question", "sources", "observations", "hypotheses", "dependencies", "unresolved", "next"]) { const r = { ...good }; delete r[k]; assert.match(reportRefusal(r, { examined }).join("; "), new RegExp(`${k}`), k); }
  assert.match(reportRefusal({ ...good, sources: [{ ref: "src/never-read.mjs" }] }, { examined }).join("; "), /cites src\/never-read\.mjs, which this node never examined/);
  assert.match(reportRefusal({ ...good, sources: [{ ref: "src/a.mjs", version: V(2) }] }, { examined }).join("; "), /gives src\/a\.mjs a version .* that is not the one examined/);
  assert.match(reportRefusal({ ...good, observations: [{ id: "o1", text: "a claim", sources: [] }] }, { examined }).join("; "), /observation o1 names no source/);
  assert.match(reportRefusal({ ...good, observations: [{ id: "o1", text: "a claim", sources: ["docs/x.md"] }] }, { examined }).join("; "), /observation o1 cites docs\/x\.md, which is not among the report's sources/);
  assert.match(reportRefusal({ ...good, hypotheses: [{ id: "h1", text: "because", supports: ["o9"], contradicts: [] }] }, { examined }).join("; "), /hypothesis h1 refers to o9/);
  assert.match(reportRefusal({ ...good, next: [{ addresses: "u3", question: "look further into it" }] }, { examined }).join("; "), /next step addresses u3, which is not one of its unresolved questions/);
  assert.match(reportRefusal("not json", { examined }).join("; "), /not a JSON object/);
  // A coordinator also answers: delegations, satisfied, material, summary.
  assert.match(reportRefusal(good, { examined, coordinator: true }).join("; "), /delegations.*satisfied.*material.*summary/s);
  const t = team({ coordinator: round => (round === 1 ? lead({ delegations: [ask("u1")] }) : lead({ satisfied: true, open: [] })),
    specialist: node => ({ report: report({ question: node.question, path: "src/a.mjs", text: "an unsupported claim" }), examined: [src("src/other.mjs")] }) });
  const r = await t.run();
  const n = r.nodes.find(x => x.kind === "specialist");
  assert.deepEqual([n.state, n.error.code], ["failed", "INVALID_REPORT"]);
  assert.match(n.error.why.join("; "), /cites src\/a\.mjs, which this node never examined/);
  assert.deepEqual(r.knowledge.observations, [], "nothing of a refused report is taken as a finding");
  assert.ok(t.prompts.find(p => p.kind === "coordinator" && p.round === 2).prompt.includes("INVALID_REPORT"), "the coordinator is told the node failed, and why");
});

test("THE REQUEST BUDGET IS SHARED: concurrent and nested nodes draw on one bound, the request past it is refused before the caller's own charge, and the team stops on it", async () => {
  const charged = [];
  const t = team({ limits: { max_requests: 6 }, over: { admit: info => { charged.push(info); } },
    coordinator: round => (round === 1 ? lead({ delegations: [1, 2, 3].map(i => ask("u1", { question: `Inventory the sources of part ${i} of the scheduler under src.` })) }) : lead({ satisfied: true, open: [] })),
    specialist: async (node, _p, { admit }) => { await sleep(5); admit({ class: "root", model: "gemini-4-hydrogen" }); admit({ class: "root", model: "gemini-4-hydrogen" }); return { report: report({ question: node.question }) }; } });
  const r = await t.run();
  // 1 (coordinator) + 3 (each specialist's first) + 2 more = 6; the seventh and later are refused.
  assert.deepEqual([charged.length, r.telemetry.requests.total, r.status, r.stop_reason], [6, 6, "stopped", "RESEARCH_REQUEST_BUDGET"]);
  assert.ok(charged.every(c => c.node && c.team === TEAM.id && c.role === "researcher"), "each charge names its node, team and role");
  assert.deepEqual(r.telemetry.requests.by_model, { "gemini-4-carbon": 1, "gemini-4-hydrogen": 5 });
  assert.ok(r.nodes.filter(n => n.kind === "specialist").some(n => n.state === "failed" && n.error.code === "RESEARCH_REQUEST_BUDGET"));
  // The caller's refusal (the billing policy's, a stage's bound) is the caller's: it is not counted and it stops the team as itself.
  const refusing = team({ over: { admit: () => { throw Object.assign(new Error("METERED_GEMINI_BUDGET_EXHAUSTED: spent"), { code: "METERED_GEMINI_BUDGET_EXHAUSTED" }); } }, coordinator: () => lead() });
  const x = await refusing.run();
  assert.deepEqual([x.status, x.stop_reason, x.telemetry.requests.total], ["stopped", "METERED_GEMINI_BUDGET_EXHAUSTED", 0]);
});

test("REPEATED OBSERVATIONS ARE ONE FINDING, AND INDEPENDENT CORROBORATION IS KEPT: the same claim from the same source by two nodes is one evidence entry naming both; from another source it is a second entry", async () => {
  const t = team({
    coordinator: round => (round === 1 ? lead({ delegations: [1, 2, 3].map(i => ask("u1", { question: `Check independently, as reader ${i}, where the retry bound is enforced.` })) }) : lead({ satisfied: true, open: [] })),
    specialist: node => ({ report: report({ question: node.question, path: /reader 3/.test(node.question) ? "docs/retry.md" : "src/scheduler.mjs", text: "The retry bound is  enforced in the scheduler." }) }),
  });
  const r = await t.run();
  assert.equal(r.knowledge.observations.length, 1);
  const [o] = r.knowledge.observations;
  assert.deepEqual(o.evidence.map(e => [e.ref, e.nodes.length]), [["src/scheduler.mjs", 2], ["docs/retry.md", 1]]);
  assert.equal(new Set(o.evidence.flatMap(e => e.nodes)).size, 3, "all three examinations are kept as lineage");
});

test("RESEARCH ENDS WHEN ITS OBJECTIVE IS MET, NOT WHEN ITS DEPTH IS SPENT: a satisfied coordinator opens no level, and delegations it sends with a satisfied answer are not run", async () => {
  const t = team({ coordinator: () => lead({ satisfied: true, open: [], delegations: [ask("u1")], summary: "the dossier already answers it", own: "docs/retry.md" }) });
  const r = await t.run();
  assert.deepEqual([r.status, r.rounds, r.telemetry.depth_reached, r.telemetry.nodes_created, t.calls.length], ["satisfied", 1, 1, 0, 1]);
  // The round bound: a coordinator that never concludes is stopped, with what it found kept.
  const endless = team({ limits: { coordinator_rounds: 3, max_depth: 3 }, coordinator: round => lead({ delegations: [ask("u1", { question: `Inventory the sources once more, attempt number ${round}, under src.` })] }) });
  const e = await endless.run();
  assert.deepEqual([e.status, e.stop_reason, e.rounds, e.telemetry.nodes_created], ["stopped", "ROUND_LIMIT", 3, 3]);
});

test("CANCELLATION KEEPS WHAT WAS FOUND AND LEAKS NOTHING: finished nodes stay, running ones are told to stop and recorded as cancelled, none starts afterwards; a resumed team does not run a finished node again", async () => {
  const ctl = new AbortController();
  const started = [];
  const script = {
    coordinator: round => (round === 1 ? lead({ delegations: [1, 2, 3, 4].map(i => ask("u1", { question: `Inventory the sources of part ${i} of the scheduler under src.` })) }) : lead({ satisfied: true, open: [], summary: "done after resume" })),
    specialist: async (node, _p, { signal }) => {
      started.push(node.id);
      if (/part 1 /.test(node.question)) return { report: report({ question: node.question }) };
      if (/part 2 /.test(node.question)) { setTimeout(() => ctl.abort(new Error("operator stop")), 5); }
      await new Promise((res, rej) => { const t = setTimeout(res, 200); signal.addEventListener("abort", () => { clearTimeout(t); rej(Object.assign(new Error("the session was stopped"), { code: "ABORTED" })); }, { once: true }); });
      return { report: report({ question: node.question }) };
    },
  };
  const first = team({ ...script, limits: { max_active: 2 } });   // two at once: parts 1 and 2 start, part 3 takes part 1's slot, part 4 waits
  const r = await first.run({ signal: ctl.signal });
  assert.deepEqual([r.status, r.stop_reason], ["cancelled", "ABORTED"]);
  const states = Object.fromEntries(r.nodes.filter(n => n.kind === "specialist").map(n => [n.question.match(/part (\d)/)[1], n.state]));
  assert.deepEqual(states, { 1: "finished", 2: "cancelled", 3: "cancelled", 4: "cancelled" });
  assert.equal(started.length, 3, "the fourth was waiting for a slot and never started");
  assert.equal(r.knowledge.observations.length, 1, "the finished node's finding is kept");
  // RESUME from what was recorded: the coordinator's first round and the finished specialist are not run again.
  const again = team({ ...script, specialist: async node => ({ report: report({ question: node.question }) }) });
  const r2 = await again.run({ resume: r.nodes });
  assert.deepEqual([r2.status, r2.telemetry.reused, again.calls.map(c => [c.kind, c.round]).filter(c => c[0] === "coordinator")], ["satisfied", 2, [["coordinator", 2]]]);
  assert.equal(again.calls.filter(c => c.kind === "specialist").length, 3, "only the three that had not finished");
  assert.equal(r2.nodes.filter(n => n.kind === "specialist" && n.state === "finished").length, 4);
});

test("EVERY CONTRIBUTOR IS RECORDED WITH THE MODEL ASKED AND THE MODEL THAT ANSWERED, nested ones included; an answer under another model keeps both names", async () => {
  const t = team({
    coordinator: round => (round === 1 ? lead({ delegations: [ask("u1")] }) : lead({ satisfied: true, open: [] })),
    specialist: node => ({ report: report({ question: node.question }), served_model: "gemini-4-hydrogen-20261101" }),
  });
  const r = await t.run();
  assert.deepEqual(r.contributors.filter(c => c.kind === "specialist").map(c => [c.requested_model, c.served_model, c.served_model_source, c.depth, typeof c.node]), [["gemini-4-hydrogen", "gemini-4-hydrogen-20261101", "provider", 2, "string"]]);
  assert.deepEqual(r.selection, CARBON.selection, "the coordinator's routing record travels with the team's result");
  assert.deepEqual(Object.keys(r.telemetry).sort(), ["active_peak", "coordinator_rounds", "depth_reached", "nodes", "nodes_created", "refusals", "requests", "reused", "tokens"].sort(), "depth, concurrency, nodes, requests and tokens are separate figures");
  assert.deepEqual(r.telemetry.tokens, { total: 250, by_model: { "gemini-4-carbon": 200, "gemini-4-hydrogen": 50 } });
});

test("A CHARGE THE CALLER REFUSES STOPS THE TEAM WHERE IT IS: the refused request is not counted, the node it was for fails under the caller's code, and no further session is started, the coordinator's next round included", async () => {
  let asked = 0;
  // The caller refuses the second request only: a team that went on would be admitted again, and would run on.
  const t = team({ coordinator: () => lead({ delegations: [ask("u1")] }),
    over: { admit: () => { asked += 1; if (asked === 2) throw Object.assign(new Error("the stage's provider-call bound is spent"), { code: "STAGE_CALLS" }); } } });
  const r = await t.run();
  assert.deepEqual([r.status, r.stop_reason, r.telemetry.requests.total, asked], ["stopped", "STAGE_CALLS", 1, 2]);
  assert.deepEqual(t.calls.map(c => [c.kind, c.round]), [["coordinator", 1], ["specialist", 1]], "no session is started after the refusal");
  assert.deepEqual(r.nodes.map(n => [n.kind, n.state, n.error?.code ?? null]), [["coordinator", "finished", null], ["specialist", "failed", "STAGE_CALLS"]]);
});

test("WHAT GOES UP IS BOUNDED: a member with more findings than the bound allows is shown to the coordinator up to the bound, with the count of what stayed in its stored report; the stored report is whole", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `o${i + 1}`, text: `finding ${i + 1} of forty: ${"".padStart(60, "x")}`, sources: ["src/a.mjs"] }));
  const t = team({ limits: { finding_bytes: 600 },
    coordinator: round => (round === 1 ? lead({ delegations: [ask("u1")] }) : lead({ satisfied: true, open: [] })),
    specialist: node => ({ report: { ...report({ question: node.question }), observations: many } }) });
  const r = await t.run();
  const specialist = r.nodes.find(n => n.kind === "specialist");
  const shown = t.prompts.find(p => p.kind === "coordinator" && p.round === 2).prompt;
  const lines = shown.split("\n").filter(l => /^ {2}o\d+: finding \d+ of forty/.test(l));
  const left = new RegExp(`\\(\\+(\\d+) more line\\(s\\) in the stored report of ${specialist.id}\\)`).exec(shown);
  assert.ok(left, "the coordinator is told how much stayed behind, and where");
  assert.deepEqual([lines.length + Number(left[1]), lines.length > 0, lines.length < 40, Buffer.byteLength(lines.join("\n"), "utf8") <= 600], [40, true, true, true]);
  assert.equal(specialist.report.observations.length, 40, "the stored report keeps every finding");
  assert.equal(r.knowledge.observations.length, 40, "and so does the team's knowledge");
});

// ---- Findings of the independent review of ea858a6..af23623 (2026-11-20), each reproduced by the reviewer first --------
test("A SPECIALIST CITES ONLY WHAT IT READ ITSELF: a source another member read is not its evidence; the coordinator may cite what its members read", async () => {
  // Review finding 1: every node was checked against the team's sources, so a member that read one file could cite another's.
  const t = team({
    coordinator: round => (round === 1 ? lead({ delegations: [ask("u1"), ask("u1", { question: "List every caller of the retry scheduler under src, with file and line.", specialty: "source-inventory" })] })
      : { ...lead({ satisfied: true, material: true, open: [], summary: "done" }), sources: [{ ref: "src/a.mjs" }], observations: [{ id: "o1", text: "src/a.mjs holds the retry", sources: ["src/a.mjs"] }] }),
    specialist: async node => (node.specialty === "execution-trace" ? { report: report({ path: "src/a.mjs" }) }
      : (await sleep(30), { report: report({ path: "src/a.mjs", text: "a second-hand claim" }), examined: [src("src/zzz.mjs")] })),
  });
  const r = await t.run();
  const [a, b] = r.nodes.filter(n => n.kind === "specialist");
  assert.deepEqual([a.state, b.state, b.error?.code, b.error?.why], ["finished", "failed", "INVALID_REPORT", ["the report cites src/a.mjs, which this node never examined", "observation o1 cites src/a.mjs, which is not among the report's sources"]]);
  assert.deepEqual(r.knowledge.observations.flatMap(o => o.evidence.flatMap(e => e.nodes)).includes(b.id), false, "the member that never read it is not named as having examined it");
  assert.equal(r.status, "satisfied", "the coordinator's own citation of a member's source is accepted");
});

test("A PATH THAT WAS ABSENT WHEN IT WAS READ IS KEPT AS ABSENT: its source says so, with no version, wherever the finding goes", async () => {
  // Review finding 2: a file that did not exist was recorded like any source, and a finding resting on it looked like one on a file.
  const t = team({
    coordinator: round => (round === 1 ? lead({ delegations: [ask("u1")] }) : lead({ satisfied: true, open: [], summary: "done" })),
    specialist: () => ({ report: report({ path: "src/ghost.mjs", text: "src/ghost.mjs is not there" }), examined: [{ tool: "view_file", path: "src/ghost.mjs", kind: "missing", sha256: null, bytes: null }] }),
  });
  const r = await t.run();
  const s = r.nodes.find(n => n.kind === "specialist");
  assert.deepEqual(s.report.sources, [{ ref: "src/ghost.mjs", version: null, absent: true }]);
  assert.deepEqual(r.knowledge.observations.map(o => o.evidence.map(e => [e.ref, e.version, e.absent ?? false])), [[["src/ghost.mjs", null, true]]]);
  assert.match(t.prompts.find(p => p.kind === "coordinator" && p.round === 2).prompt, /src\/ghost\.mjs@ABSENT/, "the coordinator is shown that the source was absent");
});

test("THE REQUEST BUDGET IS THE TEAM'S, ACROSS RESUMES: requests an earlier run of the team made count against the same bound", async () => {
  // Review finding 3: a resumed team started its count at zero, so the bound held per attempt and not per team.
  const script = { coordinator: round => (round === 1 ? lead({ delegations: [ask("u1"), ask("u1", { question: "List every caller of the retry scheduler under src, with file and line.", specialty: "source-inventory" }), ask("u1", { question: "Which contract bounds the number of retries, and where is it?", specialty: "history-and-cause" })] }) : lead({ satisfied: true, open: [], summary: "done" })) };
  const first = team({ ...script, limits: { max_requests: 3, max_active: 1 } });
  const r1 = await first.run();
  assert.deepEqual([r1.status, r1.stop_reason, r1.telemetry.requests.total], ["stopped", "RESEARCH_REQUEST_BUDGET", 3]);
  const second = team({ ...script, limits: { max_requests: 3, max_active: 1 } });
  const r2 = await second.run({ resume: r1.nodes });
  assert.deepEqual([r2.status, r2.stop_reason, r2.telemetry.requests.total, r2.telemetry.requests.carried, second.calls.length], ["stopped", "RESEARCH_REQUEST_BUDGET", 0, 3, 1],
    "the three requests of the first run are the team's: the resumed run is refused its first new request");
  // A larger bound is the launcher's to give: the same records under it go on, and only the new requests are new.
  const third = team({ ...script, limits: { max_requests: 6, max_active: 1 } });
  const r3 = await third.run({ resume: r1.nodes });
  assert.deepEqual([r3.status, r3.telemetry.requests.carried, r3.telemetry.requests.total <= 3], ["satisfied", 3, true]);
});

test("A STOPPED TEAM STARTS NOTHING MORE: after a refused charge or a spent budget, the specialists still waiting for a slot are not started, and each is recorded as not run", async () => {
  // Review finding 4: the pool went on starting every queued specialist after the caller had refused a charge.
  const ten = Array.from({ length: 10 }, (_, i) => ask("u1", { question: `Trace retry path number ${i + 1} through the scheduler, with file and line.` }));
  let charges = 0;
  const t = team({ coordinator: () => lead({ delegations: ten }), specialist: async () => (await sleep(20), { report: report() }), limits: { max_active: 2 },
    over: { admit: () => { charges += 1; if (charges === 3) throw Object.assign(new Error("STAGE_CALLS: the stage's bound is spent"), { code: "STAGE_CALLS" }); } } });
  const r = await t.run();
  const spec = r.nodes.filter(n => n.kind === "specialist");
  assert.deepEqual([r.status, r.stop_reason, t.calls.filter(c => c.kind === "specialist").length, charges], ["stopped", "STAGE_CALLS", 2, 3], "two were running; no third session was started and the caller was not asked again");
  assert.deepEqual(spec.reduce((m, n) => (m[`${n.state}:${n.error?.code ?? "-"}`] = (m[`${n.state}:${n.error?.code ?? "-"}`] ?? 0) + 1, m), {}), { "finished:-": 1, "failed:STAGE_CALLS": 1, "cancelled:TEAM_STOPPED": 8 });
  // The team's own bound, the same way.
  const b = team({ coordinator: () => lead({ delegations: ten }), specialist: async () => (await sleep(20), { report: report() }), limits: { max_active: 2, max_requests: 2 } });
  const rb = await b.run();
  assert.deepEqual([rb.stop_reason, b.calls.filter(c => c.kind === "specialist").length <= 2], ["RESEARCH_REQUEST_BUDGET", true]);
});

test("THE CEILINGS ARE THE CONTROLLER'S, NOT THE CALLER'S: limits above the coordinator model's subagent ceiling, or above ten levels, are refused before anything runs", async () => {
  // Review finding 5: any max_active was accepted, so a launcher's limits could run 20 Hydrogen members under Carbon.
  await assert.rejects(() => team({ coordinator: () => lead(), limits: { max_active: 20 } }).run(), /limits\.max_active is at most 8 for a coordinator on gemini-4-carbon/);
  await assert.rejects(() => team({ coordinator: () => lead(), limits: { max_active: 9 } }).run(), /at most 8/);
  await assert.rejects(() => team({ coordinator: () => lead(), limits: { max_depth: 11 } }).run(), /limits\.max_depth is at most 10/);
  assert.equal((await team({ coordinator: () => lead({ satisfied: true, open: [], summary: "s" }), limits: { max_active: 3 } }).run()).telemetry.active_peak, 0, "a lower ceiling is the caller's to ask for");
});

test("A TEAM THAT DID NOT END BY ITS OWN ACCOUNT CONCLUDES NOTHING: a failed, stopped or cancelled team reports no summary and nothing as material, whatever an earlier round said", async () => {
  // Review finding 6: a team whose second round was not a report returned material: true and the first round's summary.
  const t = team({ coordinator: round => (round === 1 ? lead({ delegations: [ask("u1")], material: true, summary: "round one thinks it matters" }) : {}), specialist: () => ({ report: report() }) });
  const r = await t.run();
  assert.deepEqual([r.status, r.stop_reason, r.satisfied, r.material, r.summary], ["failed", "INVALID_REPORT", false, false, null]);
  assert.deepEqual(t.events.filter(e => e.event === "conclusion").map(e => [e.status, e.material, e.summary]), [["failed", false, null]]);
  assert.equal(r.knowledge.observations.length, 1, "what the members found is still kept");
});

test("A MEMBER IS ON THE RECORD BEFORE ITS SESSION STARTS, and a satisfied team holds evidence", async () => {
  // Review finding 7: moving the admitted record to after the session had started failed no test.
  let seenAtStart = null;
  const t = team({ coordinator: round => (round === 1 ? lead({ delegations: [ask("u1")] }) : lead({ satisfied: true, open: [], summary: "done" })),
    specialist: node => { seenAtStart = t.events.some(e => e.event === "node" && e.node.id === node.id && e.node.state === "admitted"); return { report: report() }; } });
  await t.run();
  assert.equal(seenAtStart, true, "the admitted record was written before the session was asked anything");
  // Review finding 8: a coordinator could declare the question answered with no observation anywhere in the team.
  const empty = await team({ coordinator: () => lead({ satisfied: true, material: true, open: [], summary: "trust me" }) }).run();
  assert.deepEqual([empty.status, empty.stop_reason, empty.satisfied, empty.material], ["failed", "SATISFIED_WITHOUT_EVIDENCE", false, false]);
});

test("A REPORT'S DEPENDENCIES AND HYPOTHESES ARE HELD TO ITS EVIDENCE TOO: a dependency cites sources the node read, and a hypothesis called supported or contradicted names the observation that does it", () => {
  // Review finding 8: only observations were checked against the sources.
  const ok = { ...report(), dependencies: [{ from: "a", to: "b", kind: "imports", contract: null, sources: ["src/a.mjs"] }], hypotheses: [{ id: "h1", text: "a drives b", supports: ["o1"], contradicts: [], status: "supported" }] };
  const examined = [src("src/a.mjs")];
  assert.deepEqual(reportRefusal(ok, { examined }), []);
  assert.deepEqual(reportRefusal({ ...ok, dependencies: [{ from: "a", to: "b", kind: "imports", sources: ["src/unread.mjs"] }] }, { examined }), ["a dependency (a -> b) cites src/unread.mjs, which is not among the report's sources"]);
  assert.deepEqual(reportRefusal({ ...ok, dependencies: [{ from: "a", to: "b", kind: "imports", sources: [] }] }, { examined }), ["a dependency (a -> b) names no source: a dependency is what a source shows"]);
  assert.deepEqual(reportRefusal({ ...ok, hypotheses: [{ id: "h1", text: "a drives b", supports: [], contradicts: [], status: "supported" }] }, { examined }), ["hypothesis h1 is called supported and names no observation that supports it"]);
  assert.deepEqual(reportRefusal({ ...ok, hypotheses: [{ id: "h1", text: "a drives b", supports: ["o1"], contradicts: [], status: "contradicted" }] }, { examined }), ["hypothesis h1 is called contradicted and names no observation that contradicts it"]);
});

test("AN ADMISSION THAT ANSWERS LATER IS WAITED FOR: a refusal that arrives asynchronously stops the team and its request is not counted; a failed member keeps what its session recorded", async () => {
  // Review finding 9: the caller's charge was not awaited, so an asynchronous refusal was an unhandled rejection and the request was counted.
  let n = 0;
  const t = team({ coordinator: () => lead({ delegations: [ask("u1")] }), specialist: () => ({ report: report() }),
    over: { admit: async () => { n += 1; await sleep(5); if (n === 2) throw Object.assign(new Error("STAGE_CALLS: spent"), { code: "STAGE_CALLS" }); } } });
  const awaiting = { ...t };
  // The scripted node awaits its admission, as the gateway does.
  const r = await runResearchTeam({ team: TEAM, coordinator: CARBON, subordinate: HYDROGEN, limits: researchLimits(CARBON.seat.model), now: () => "2026-11-20T00:00:00.000Z",
    admit: async () => { n += 1; await sleep(5); if (n === 2) throw Object.assign(new Error("STAGE_CALLS: spent"), { code: "STAGE_CALLS" }); },
    runNode: async ({ node, seat, admit }) => { await admit({ class: "root", model: seat.model }); const rep = node.kind === "coordinator" ? lead({ delegations: [ask("u1")] }) : report();
      return { text: JSON.stringify(rep), examined: rep.sources.map(x => src(x.ref)), served_model: seat.model, served_model_source: "provider", usage: { total_token_count: 10 } }; } });
  assert.ok(awaiting);
  assert.deepEqual([r.status, r.stop_reason, r.telemetry.requests.total, r.nodes.find(x => x.kind === "specialist").error.code], ["stopped", "STAGE_CALLS", 1, "STAGE_CALLS"]);
  // A member whose session failed after it had read and been answered: what the session recorded is kept with the failure.
  const failing = await runResearchTeam({ team: TEAM, coordinator: CARBON, subordinate: HYDROGEN, limits: researchLimits(CARBON.seat.model), now: () => "2026-11-20T00:00:00.000Z",
    runNode: async ({ node, seat, admit }) => { admit({ class: "root", model: seat.model });
      if (node.kind === "coordinator") return { text: JSON.stringify(node.round === 1 ? lead({ delegations: [ask("u1")] }) : lead({ open: [], delegations: [], summary: "nothing admissible" })), examined: [], served_model: seat.model, served_model_source: "provider", usage: { total_token_count: 10 } };
      throw Object.assign(new Error("the session timed out"), { code: "TIMEOUT", session: { examined: [src("src/a.mjs")], usage: { total_token_count: 77 }, served_model: "gemini-4-hydrogen", served_model_source: "provider" } }); } });
  const dead = failing.nodes.find(x => x.kind === "specialist");
  assert.deepEqual([dead.state, dead.error.code, dead.examined.map(e => e.path), dead.usage.tokens, dead.served_model], ["failed", "TIMEOUT", ["src/a.mjs"], 77, "gemini-4-hydrogen"]);
  assert.equal(failing.telemetry.tokens.total >= 77, true, "its tokens are in the team's telemetry");
  assert.deepEqual(failing.contributors.filter(c => c.kind === "specialist").map(c => c.served_model), ["gemini-4-hydrogen"], "a model that answered inside a failed member is a contributor");
});
