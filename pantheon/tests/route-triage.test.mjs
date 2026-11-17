// Seat triage (experimental): Sonnet is asked which Anthropic model should plan, Luna which OpenAI model should
// implement, and the answers seat a real board run. Every model here is scripted: this shows the plumbing and the
// bounds on the answer. It says nothing about how well a live model would triage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withDispatch, WORK } from "./fixtures/dispatch.mjs";
import { runOpenItem } from "../src/board/run-item.mjs";
import { triageSeat, triageOptions, TRIAGE_ASKERS, TRIAGE } from "../src/route/triage.mjs";

const TASK = "alpha.mjs must export ok as true; one file, one line";
const seat = (s, why) => ({ ...s, rank: 0, pool: s.vendor, band: null, basis: "OPERATOR", why });
const scripted = answers => { const log = []; const turn = async a => { log.push(a); const r = answers[a.model]; if (r instanceof Error) throw r; return { text: r, served_model: a.model }; }; turn.log = log; return turn; };

test("the askers and their options: Sonnet chooses among Anthropic's models for the planner, Luna among OpenAI's for the implementer", () => {
  assert.deepEqual(TRIAGE_ASKERS, { planner: { vendor: "anthropic", model: "claude-sonnet-5" }, implementer: { vendor: "openai", model: "gpt-6-luna" } });
  const a = triageOptions("anthropic"), o = triageOptions("openai");
  assert.equal(a[0].model, "claude-haiku-4-5-20251001", "the cheapest option is listed first");
  for (const m of ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-2"]) assert.ok(a.some(x => x.model === m), m);
  for (const m of ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]) assert.ok(o.some(x => x.model === m), m);
  const order = ["fast", "standard", "frontier"];
  for (const list of [a, o]) assert.deepEqual(list.map(x => order.indexOf(x.class)), list.map(x => order.indexOf(x.class)).sort((x, y) => x - y), "weakest class first");
});

test("the answers seat a board run: the planner and the worker turns are made by the models the askers named", async () => {
  await withDispatch(async ({ spec, opts, calls }) => {
    const turn = scripted({ "claude-sonnet-5": '{"model": "claude-haiku-4-5-20251001", "reason": "a one-line change"}', "gpt-6-luna": 'Sure. {"model":"gpt-6-luna","reason":"trivial"}' });
    const plan = await triageSeat({ role: "planner", task: TASK, turn }), work = await triageSeat({ role: "implementer", task: TASK, turn });
    assert.deepEqual(turn.log.map(l => [l.vendor, l.model, l.seat.role]), [["anthropic", "claude-sonnet-5", "triage"], ["openai", "gpt-6-luna", "triage"]], "one call each, to the asker");
    assert.match(turn.log[0].prompt, /planner seat[\s\S]*alpha\.mjs must export ok[\s\S]*- claude-haiku-4-5-20251001 \(fast\)/);
    assert.deepEqual([plan.seat, work.seat], [{ vendor: "anthropic", model: "claude-haiku-4-5-20251001" }, { vendor: "openai", model: "gpt-6-luna" }]);
    assert.deepEqual([plan.record.schema, plan.record.chosen, plan.record.fallback, plan.record.reason], [TRIAGE, "claude-haiku-4-5-20251001", null, "a one-line change"]);
    const r = await runOpenItem(spec("triaged"), opts({ seatOverrides: { planner: seat(plan.seat, "triage"), implementer: seat(work.seat, "triage") } }));
    assert.equal(r.error, null, JSON.stringify(r.error));
    assert.equal(r.shipped, true);
    const turns = JSON.parse(readFileSync(join(r.board, "run.json"), "utf8")).turns;
    assert.deepEqual(turns.filter(t => t.purpose === "plan").map(t => `${t.vendor}/${t.model}`), ["anthropic/claude-haiku-4-5-20251001"]);
    assert.deepEqual(turns.filter(t => t.purpose === "work").map(t => `${t.vendor}/${t.model}`), ["openai/gpt-6-luna"]);
    assert.deepEqual(calls.filter(c => WORK.test(c.prompt)).map(c => c.model), ["gpt-6-luna"]);
    // The reviewer is still another lab: triage chooses within a lab and does not touch the review rule.
    assert.ok(turns.filter(t => t.purpose === "critique").every(t => !["anthropic", "openai"].includes(t.vendor)));
  });
});

test("an answer outside the options, an unparseable answer and a failed asker are not followed: the seat starts low, and the record says why", async () => {
  const cases = [['{"model": "claude-mythos-9", "reason": "strongest"}', /"claude-mythos-9" is not one of the options/], ["I would use the best one.", /names no option/],
    ['{"model": "gpt-6-astra"}', /"gpt-6-astra" is not one of the options/], [new Error("429 overloaded"), /the asker failed \(429 overloaded\)/]];
  for (const [answer, why] of cases) {
    const { seat: s, record } = await triageSeat({ role: "planner", task: TASK, turn: scripted({ "claude-sonnet-5": answer }) });
    assert.deepEqual(s, { vendor: "anthropic", model: triageOptions("anthropic")[0].model }, "the lowest-class Anthropic option; never another lab's model");
    assert.match(record.fallback, /^started low: /);
    assert.match(record.fallback, why);
  }
  await assert.rejects(triageSeat({ role: "judge", task: TASK, turn: scripted({}) }), /no asker is configured/);
});
