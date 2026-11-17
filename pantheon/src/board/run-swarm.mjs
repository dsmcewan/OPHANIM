// Swarms on the board: the parallel form of the same cycle, under the same laws and the same trail.
//
// swarm/layered.mjs ran explore -> refute -> synthesize off the board, from scripts: nothing it said
// was published, gated, routed or escalated. The controller meanwhile already SCHEDULES those modes
// on the board (TRIGGERS explore/refute/synthesize) and nothing executed them. This module is that
// executor, and it executes one transition per call:
//
//   stabilize  read the board; the controller's schedule says which swarm step (if any) is ready
//   gate       the stage gate must find the step's chair in the board's pattern (stuck -> timeboxed
//              swarm through scout@opt; split -> isolated debate adds arbiter@judge), and law 5 must
//              pass: opened by lead@orch, within the chair's turn cap. Turns are DERIVED from the round
//              numbers already on the board.
//   apply      seats answer concurrently (distinct labs), each turn escalated by the protocol on a
//              truncated reply (raise_output within the documented ceiling)
//   record     each seat publishes under its own identity (vendor, model) on its own isolated ref;
//              a synthesis is carried to the board by the controller as an open claim
//   converge   nothing scheduled -> { done }; a gate or law refusal -> { refused, why }; nothing moves
//
// Call it again to advance: each call re-reads the board, so the loop is the caller's repetition and
// every step it takes is already on the trail.
import { boardState, boardStatus, schedule } from "./controller.mjs";
import { stageCheck, assertLaw, StageRefused } from "./stage-gate.mjs";
import { publish, treeSlots, entriesOfKind } from "./dag.mjs";
import { merge } from "./merge.mjs";
import { nextOccupancy } from "./occupancy.mjs";
import { escalationRecord } from "../route/protocol.mjs";
import { defaultOutputFor, TOKEN_TIERS } from "../config/tiers.mjs";
import { candidatesFor } from "../role/seating.mjs";
import { ROSTER } from "../team/roster.mjs";
import { explorePrompt, refutePrompt, synthesizePrompt, SWARM_ROLES } from "../swarm/layered.mjs";

export const SWARM_STEPS = ["explore", "refute", "synthesize"];
const CONTROLLER = { vendor: "controller" };
const CHAIR = { explore: "scout@opt", refute: "scout@opt", synthesize: "arbiter@judge" };
const ROUND = /^(explore|refute|synth)-r(\d+)-/;
// Slot keys allow no underscore; vendor ids (agy_google) are slugged inside keys, never in ref names.
const slug = v => v.replace(/_/g, "-");

/** Rounds a chair has already run on this board, read from the keys of the claims it published. */
export function chairTurns({ store, refs }, chair) {
  const modes = Object.entries(CHAIR).filter(([, c]) => c === chair).map(([m]) => (m === "synthesize" ? "synth" : m));
  const rounds = new Set();
  for (const r of refs.list()) {
    let slots;
    try { slots = treeSlots(store, r.cid); } catch { continue; }
    for (const [slot, cid] of Object.entries(slots)) {
      if (!slot.startsWith("hypothesis:")) continue;
      const m = ROUND.exec(store.get(cid).payload?.key ?? "");
      if (m && modes.includes(m[1])) rounds.add(Number(m[2]));
    }
  }
  return rounds.size;
}

// One seat's turn, escalated on a truncated reply. `turn` is injected: {vendor, model, role, prompt,
// output} -> {text, complete, terminal_state}. Returns the text and the escalation records it made.
async function seatTurn({ turn, seat, role, prompt, tier }) {
  const records = [];
  // The budget a turn runs with when the caller names none: the same defaults the main path assumes.
  let output = seat.output ?? defaultOutputFor(seat.vendor, seat.model, tier);
  for (let steps = 0; ; steps++) {
    const r = await turn({ vendor: seat.vendor, model: seat.model, role, prompt, output });
    if (r.complete !== false) return { text: r.text, records };
    const rec = escalationRecord({ role, steps, outcome: { kind: "turn", complete: false, terminal_state: r.terminal_state ?? null },
      seat: { vendor: seat.vendor, model: seat.model, effort: null, output } });
    records.push({ tier, ...rec });
    if (rec.decision.action !== "raise_output") {
      throw Object.assign(new Error(`${seat.vendor}/${seat.model} ${role}: ${rec.decision.why}`), { records });
    }
    output = rec.decision.to.output;
  }
}

/** Distinct-lab seats for a role, as the seating table orders them, minus labs to avoid. */
function labsFor(role, { avoid = [], count = 2, seating } = {}) {
  const seen = new Set(), out = [];
  for (const c of candidatesFor(role, { avoid, ...(seating ? { seating } : {}) })) {
    if (seen.has(c.vendor)) continue;
    seen.add(c.vendor); out.push({ vendor: c.vendor, model: c.model });
    if (out.length === count) break;
  }
  return out;
}

async function isoPublish(board, { seat, ref, key, claim, contradicts, from }) {
  if (!board.refs.resolve(ref)) {
    const b = await board.refs.branch({ name: ref, from, author: seat });
    if (!b.ok) throw new Error(`branch ${ref}: ${b.why}`);
  }
  const r = await publish({ ...board, ref, author: seat, msg: key, entries: [{ kind: "hypothesis", visibility: "isolated",
    payload: { key, claim, status: "open" }, ...(contradicts ? { links: { contradicts: [contradicts] } } : {}) }] });
  if (!r.ok) throw new Error(`publish ${key}: ${r.why}`);
  return r.written[0].cid;
}

/**
 * Run the next swarm step the board schedules. `ref` is the board ref; `question` is the swarm's task
 * statement; `turn` performs one model call. Returns what happened; refusals are results, not throws.
 */
export async function runSwarmLayer({ board, ref, question, turn, seating, opened_by = "lead@orch", difficulty = "medium" }) {
  // The same output tier the ticket's other turns use (config/tiers.mjs); an unknown value is refused.
  if (typeof difficulty !== "string" || !Object.hasOwn(TOKEN_TIERS, difficulty)) {
    return { ok: false, refused: "difficulty", why: `unknown difficulty "${difficulty}" (known: ${Object.keys(TOKEN_TIERS).join(", ")})` };
  }
  const sched = schedule({ ...board, ref });
  const step = SWARM_STEPS.find(s => sched.ready.some(r => r.ks === s));
  if (!step) return { ok: true, done: true, status: sched.status, why: "no swarm step is scheduled; nothing changed" };
  const chair = CHAIR[step];
  const gate = stageCheck({ ...board, ref, stage: step });
  if (!gate.ok) return { ok: false, refused: "stage", step, why: gate.why };
  const turns = chairTurns(board, chair);
  try { assertLaw({ kind: "open_mode", chair, opened_by, turns: turns + 1 }); }
  catch (e) { return { ok: false, refused: "law", step, why: e.message, turns }; }

  const round = turns + 1, escalations = [];
  const run = async (seat, role, prompt) => {
    const out = await seatTurn({ turn, seat, role, prompt, tier: difficulty });
    escalations.push(...out.records);
    return out.text;
  };
  const authored = (seat, mode, seat_id) => nextOccupancy(null, seat, { seat_id, mode });

  if (step === "explore") {
    // Forks, concurrently, from distinct labs; none reads another's answer.
    const seats = labsFor(SWARM_ROLES.explore, { seating });
    if (seats.length < 2) return { ok: false, refused: "seating", step, why: "an explore round needs two distinct labs" };
    const answers = await Promise.all(seats.map(async s => ({ seat: s, text: await run(s, SWARM_ROLES.explore, explorePrompt(question).prompt) })));
    const published = [];
    for (const { seat, text } of answers) {
      const author = authored(seat, "explore", `${seat.vendor}-explore`);
      published.push(await isoPublish(board, { seat: author, ref: `refs/iso/${seat.vendor}/explore`, from: ref,
        key: `explore-r${round}-${slug(seat.vendor)}`, claim: text }));
    }
    return { ok: true, step, chair, round, published, escalations };
  }

  if (step === "refute") {
    // Attack each open board claim from a lab that did not make it, still in isolation.
    const state = boardState({ ...board, ref });
    const claims = state.hypotheses.filter(h => h.status === "open");
    const published = [];
    for (const claim of claims) {
      const [seat] = labsFor(SWARM_ROLES.refute, { avoid: [claim.author?.vendor].filter(Boolean), count: 1, seating });
      if (!seat) continue;
      const text = await run(seat, SWARM_ROLES.refute, refutePrompt({ target: claim.author?.vendor ?? "a peer", answer: claim.claim, question }).prompt);
      const author = authored(seat, "refute", `${seat.vendor}-refute`);
      published.push(await isoPublish(board, { seat: author, ref: `refs/iso/${seat.vendor}/refute`, from: ref,
        key: `refute-r${round}-${slug(seat.vendor)}-${claim.key}`.slice(0, 120), claim: text, contradicts: claim.cid }));
    }
    return { ok: true, step, chair, round, published, escalations };
  }

  // synthesize: a judge whose lab produced none of the forks; the human takes the seat otherwise.
  const forks = [];
  for (const r of board.refs.list().filter(x => x.name.startsWith("refs/iso/"))) {
    for (const [slot, cid] of Object.entries(treeSlots(board.store, r.cid))) {
      if (!slot.startsWith("hypothesis:")) continue;
      const e = board.store.get(cid);
      if (e.visibility === "isolated" && /^(explore|refute)-/.test(e.payload.key)) forks.push({ cid, vendor: e.author.vendor, key: e.payload.key, text: e.payload.claim });
    }
  }
  const forkLabs = [...new Set(forks.map(f => f.vendor))];
  const [judge] = labsFor(SWARM_ROLES.synthesize, { avoid: forkLabs, count: 1, seating });
  if (!judge) return { ok: false, refused: "judge", step, why: `no judge outside the fork labs (${forkLabs.join(", ")}); the human takes the seat` };
  const answers = forks.filter(f => f.key.startsWith("explore-")).map(f => ({ seat: f.vendor, text: f.text }));
  const refutations = forks.filter(f => f.key.startsWith("refute-")).map(f => ({ reviewer: f.vendor, target: "a claim", text: f.text }));
  const text = await run(judge, SWARM_ROLES.synthesize, synthesizePrompt({ question, answers, refutations }).prompt);
  const author = authored(judge, "synthesize", `${judge.vendor}-synthesize`);
  const wip = `refs/seat/${author.seat_id}/wip`;
  if (!board.refs.resolve(wip)) {
    const b = await board.refs.branch({ name: wip, from: ref, author });
    if (!b.ok) throw new Error(`branch ${wip}: ${b.why}`);
  }
  const key = `synth-r${round}-${slug(judge.vendor)}`;
  const p = await publish({ ...board, ref: wip, author, msg: key, entries: [{ kind: "hypothesis", visibility: "board",
    payload: { key, claim: text, status: "open" }, links: { supports: forks.map(f => f.cid) } }] });
  if (!p.ok) throw new Error(`publish ${key}: ${p.why}`);
  const carried = await merge({ ...board, into: ref, from: wip, author: CONTROLLER, only: ["hypothesis:"], msg: "carry the synthesis" });
  if (!carried.ok) throw new Error(`carry ${key}: ${carried.why}`);
  return { ok: true, step, chair, round, judge, forks: forks.length, published: [p.written[0].cid], escalations };
}

export { StageRefused, ROSTER };
