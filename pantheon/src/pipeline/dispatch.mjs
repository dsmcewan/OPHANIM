// STAGE 2: DISPATCH. Two parts, kept apart on purpose.
//
//  (1) The Dispatcher SPECIALIST — one read-only model turn per unit. It judges whether the unit is cohesive,
//      confirms or corrects `specialist_role`, may RAISE (never lower) `difficulty`, and writes the acceptance
//      rubric. The controller then FREEZES that rubric: rubric_hash = sha256(canonical {unit_id, owned_paths,
//      verify_cmd, invariants, rubric, specialist_role, difficulty}). Stage 5 re-hashes it before every review.
//      Everything the dispatcher changes about the unit the implementer is given is inside that hash, and the role is a
//      role NAME (work-units.mjs SPECIALIST_ROLE), not free text: the dispatcher's influence on the work is confined to
//      the frozen record (independent review, assignment 2, question 7).
//  (2) The deterministic CONTROLLER ({vendor: "controller"}, no model) — disjoint owned-path locks, topological
//      waves, and one isolated git worktree per active unit.
//
// OWNER GOVERNANCE DECISION (2026-11-17) — FOR INDEPENDENT REVIEW. Stage 2 is recorded as a NON-AUTHORING ARBITER
// ({role: "dispatcher", standing: "arbiter", authored: false}). The dispatcher shapes the rubric but writes none of
// the work, so it is NOT listed among the contributions (record.mjs: contributionsOf) and, under model-level review
// independence, the exact Stage 2 model is permitted — and PINNED — to perform the Stage 5 review of the same unit.
// This is a decision of the owner, not a consequence of the code: a reader who holds that writing the acceptance
// criteria is a contribution to the change will disagree with it, and should. arbitersOf(run) lists every such seat
// so that position can be checked against a recorded run.
//
// Inputs: validated work units, an INJECTED seat and turn. Outputs: dispatch records, waves, worktree bindings.
//
// Must never: let the dispatcher lower a difficulty, dispatch a non-cohesive unit, put two units with overlapping
// owned paths in one wave, bind two units to one worktree, or run git synchronously.
import { rm } from "node:fs/promises";
import { CAPABILITIES, digestOf, judgingTurn, keysRefusal, str, clone } from "./util.mjs";
import { pathsOverlap as overlapOf, pathRefusal, matchesOwned } from "./paths.mjs";
import { DIFFICULTIES, SPECIALIST_ROLE, SPECIALIST_ROLE_MAX, cycleOf, specialistRoleRefusal } from "./work-units.mjs";
import { git } from "./git.mjs";

export const CONTROLLER = Object.freeze({ vendor: "controller", model: null });
export const pathsOverlap = overlapOf;
const byId = (a, b) => (a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0);

// ---------------------------------------------------------------------------------------------- the specialist

// OWNER DECISION L-001 (2026-11-19), option B: a not-cohesive answer is STRUCTURED, UNTRUSTED ADVISORY DATA. Its free
// text (`notes`, in v1 unbounded and pasted into the planner's revision prompt and every later judge's evidence) is
// replaced by `return`: a REASON CODE and MOVES, each a path the plan's units own moved to one of the plan's units (or
// to a new unit). Both are validated against the plan (dispatchRefusal); the controller composes every sentence a later
// seat reads from them. `notes` is still ACCEPTED, so a v1-shaped answer is not refused, but its text is never recorded or
// forwarded: the record keeps its length and digest only. A dispatch record says which schema it was made under.
export const DISPATCH_SCHEMA_ID = "pantheon.pipeline.dispatch/v2";
export const DISPATCH_KEYS = Object.freeze(["unit_id", "cohesive", "specialist_role", "difficulty", "rubric"]);
export const DISPATCH_OPTIONAL = Object.freeze(["return", "notes"]);
export const RETURN_REASONS = Object.freeze(["COUPLED_FILE_ELSEWHERE", "SEVERAL_CHANGES", "VERIFY_NEEDS_OTHER_UNIT", "UNSPECIFIED"]);
export const RETURN_MAX_MOVES = 16;
export const NEW_UNIT = "new";
export const DISPATCH_SCHEMA = Object.freeze({
  $id: DISPATCH_SCHEMA_ID,
  type: "object",
  additionalProperties: false,
  required: [...DISPATCH_KEYS],
  properties: {
    unit_id: { type: "string" },
    cohesive: { type: "boolean" },
    specialist_role: { type: "string", pattern: SPECIALIST_ROLE.source, maxLength: SPECIALIST_ROLE_MAX },
    difficulty: { enum: [...DIFFICULTIES] },
    rubric: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, uniqueItems: true },
    return: { type: "object", additionalProperties: false, required: ["reason", "moves"], properties: {
      reason: { enum: [...RETURN_REASONS] },
      moves: { type: "array", maxItems: RETURN_MAX_MOVES, items: { type: "object", additionalProperties: false, required: ["path", "to_unit"],
        properties: { path: { type: "string", maxLength: 256 }, to_unit: { type: "string", maxLength: 64 } } } } } },
    notes: { type: "string", description: "legacy (v1); accepted, never recorded or forwarded" },
  },
});

/**
 * Why a not-cohesive answer's `return` is not one the plan allows, or null. A move names a path one of the plan's units
 * owns (an owned path, or a path inside an owned glob) and a destination that is another unit of the plan, or "new";
 * nothing else is an allowed operation.
 */
export function returnRefusal(ret, unit, plan = []) {
  if (ret === undefined) return null;
  if (!ret || typeof ret !== "object" || Array.isArray(ret)) return "return is {reason, moves}";
  const keys = keysRefusal(ret, ["reason", "moves"]);
  if (keys) return `return: ${keys}`;
  if (!RETURN_REASONS.includes(ret.reason)) return `return.reason is one of ${RETURN_REASONS.join(", ")}`;
  if (!Array.isArray(ret.moves) || ret.moves.length > RETURN_MAX_MOVES) return `return.moves is a list of at most ${RETURN_MAX_MOVES} moves`;
  const units = [unit, ...(plan ?? []).filter(u => u.unit_id !== unit.unit_id)];
  const seen = new Set();
  for (const [i, m] of ret.moves.entries()) {
    const k = keysRefusal(m, ["path", "to_unit"]);
    if (k) return `return.moves[${i}]: ${k}`;
    if (typeof m.path !== "string" || m.path.length > 256 || pathRefusal(m.path)) return `return.moves[${i}].path is a repo-relative path of the plan (${typeof m.path === "string" ? pathRefusal(m.path) ?? "at most 256 characters" : "not a string"})`;
    const owner = units.find(u => u.owned_paths.includes(m.path) || matchesOwned(m.path, u.owned_paths));
    if (!owner) return `return.moves[${i}].path ${m.path} is owned by no unit of the plan`;
    if (typeof m.to_unit !== "string" || !(m.to_unit === NEW_UNIT || units.some(u => u.unit_id === m.to_unit))) return `return.moves[${i}].to_unit is a unit of the plan or "${NEW_UNIT}"`;
    if (m.to_unit === owner.unit_id) return `return.moves[${i}] moves ${m.path} to the unit that already owns it`;
    if (seen.has(m.path)) return `return.moves moves ${m.path} twice`;
    seen.add(m.path);
  }
  return null;
}

export function DISPATCHER_PROMPT({ unit, plan }) {
  const others = (plan ?? []).filter(u => u.unit_id !== unit.unit_id).map(u => `- ${u.unit_id}: owns ${u.owned_paths.join(", ")}; depends on ${u.depends_on.join(", ") || "nothing"}`);
  return [
    "ROLE: dispatcher for a supervised build pipeline. You are a READ-ONLY specialist and an ARBITER: you judge one work unit and write its acceptance rubric. You write none of the work, edit no file and run no command.",
    "",
    "THE UNIT",
    JSON.stringify(unit, null, 2),
    "",
    others.length ? `THE OTHER UNITS OF THE PLAN\n${others.join("\n")}\n` : "",
    "DECIDE",
    `1. cohesive — true only if this unit holds everything that is coupled: its types, the implementation that uses them and the tests that prove them are all inside its owned_paths, and its verify_cmd can pass on top of its depends_on alone. If a coupled file belongs to another unit, or the unit is several unrelated changes, answer false with "return": {"reason": one of ${RETURN_REASONS.join(" | ")}, "moves": [{"path": a path a unit of this plan owns, "to_unit": a unit_id of this plan or "${NEW_UNIT}"}]}: the unit goes back to the planner. Nothing else you write is passed on.`,
    "2. specialist_role — confirm the planner's, or correct it to the kind of engineer this unit really needs. A role NAME only: lower-case words joined by \"-\" (at most six), such as \"node-esm-library-engineer\"; any other text is refused.",
    `3. difficulty — confirm "${unit.difficulty}" or RAISE it. You may not lower it; a lower answer is refused.`,
    "4. rubric — the acceptance criteria a reviewer will later check one by one against the diff and the verify_cmd output. Each is one checkable sentence. Cover every invariant. Do not restate the same criterion twice. This rubric is frozen and hashed when you answer.",
    "",
    "OUTPUT: exactly one JSON object and nothing else (no prose, no code fence):",
    `{"unit_id":"${unit.unit_id}","cohesive":true,"specialist_role":"string","difficulty":"easy | medium | hard","rubric":["acceptance criterion"]}  (with "cohesive":false, also "return":{"reason":"...","moves":[...]})`,
    "Any other key, a missing key, or text outside the object is refused.",
  ].filter(l => l !== "").join("\n");
}

/** Why a dispatcher answer is not admitted for `unit` of `plan`, as {code, why}, or null. */
export function dispatchRefusal(d, unit, plan = []) {
  const keys = keysRefusal(d, [...DISPATCH_KEYS], [...DISPATCH_OPTIONAL]);
  if (keys) return { code: "SCHEMA", why: `dispatch answer: ${keys}` };
  if (d.unit_id !== unit.unit_id) return { code: "SCHEMA", why: `dispatch answer is for "${d.unit_id}", not "${unit.unit_id}"` };
  if (typeof d.cohesive !== "boolean") return { code: "SCHEMA", why: "cohesive is a boolean" };
  if (!str(d.specialist_role)) return { code: "SCHEMA", why: "specialist_role is a non-empty string" };
  if (specialistRoleRefusal(d.specialist_role)) return { code: "SPECIALIST_ROLE", why: specialistRoleRefusal(d.specialist_role) };
  if (!DIFFICULTIES.includes(d.difficulty)) return { code: "SCHEMA", why: `difficulty is one of ${DIFFICULTIES.join(", ")}` };
  if (d.notes !== undefined && typeof d.notes !== "string") return { code: "SCHEMA", why: "notes (legacy) is a string" };
  if (d.cohesive === true && d.return !== undefined && d.return !== null) return { code: "SCHEMA", why: "a cohesive unit is not returned: return is absent" };
  if (d.cohesive === false) { const r = returnRefusal(d.return ?? undefined, unit, plan); if (r) return { code: "RETURN", why: r }; }
  if (!Array.isArray(d.rubric) || !d.rubric.length || !d.rubric.every(str)) return { code: "SCHEMA", why: "rubric is a non-empty array of non-empty strings" };
  if (new Set(d.rubric).size !== d.rubric.length) return { code: "SCHEMA", why: "rubric repeats a criterion" };
  if (DIFFICULTIES.indexOf(d.difficulty) < DIFFICULTIES.indexOf(unit.difficulty)) return { code: "DIFFICULTY_LOWERED", why: `the dispatcher may raise or keep a difficulty, never lower it: planned ${unit.difficulty}, answered ${d.difficulty}` };
  return null;
}

/**
 * The frozen acceptance rubric's hash: everything a review is judged against, and everything the dispatcher set on the
 * unit the implementer is given (its role and difficulty), so neither can change after dispatch unseen.
 */
export const rubricHash = ({ unit_id, owned_paths, verify_cmd, invariants, rubric, specialist_role, difficulty }) =>
  digestOf({ unit_id, owned_paths, verify_cmd, invariants, rubric, specialist_role, difficulty });

/**
 * Run the dispatcher turn for one unit and freeze its rubric.
 * turn({vendor, model, prompt, seat, schema, sandbox, role: "dispatcher", unit_id, signal}) -> {text, served_model}
 * Returns the unit's DISPATCH RECORD:
 *   {schema, role: "dispatcher", standing: "arbiter", authored: false, vendor, model, served_model, served_model_source,
 *    status: "dispatched" | "returned" | "blocked", code, why, cohesive, specialist_role, difficulty,
 *    planned_difficulty, rubric, rubric_hash, return, notes (always null since v2), notes_withheld?, attempts}
 * "returned": the unit is not cohesive and goes back to the planner. "blocked": no answer was admitted.
 */
export async function runDispatcher({ unit, plan = [], seat, turn, signal, sameModel }) {
  const rec = { schema: DISPATCH_SCHEMA_ID, role: "dispatcher", standing: "arbiter", authored: false, vendor: seat.vendor, model: seat.model, served_model: null, served_model_source: null,
    status: "blocked", code: null, why: null, cohesive: null, specialist_role: null, difficulty: null, planned_difficulty: unit.difficulty, rubric: null, rubric_hash: null, return: null, notes: null, attempts: [] };
  const r = await judgingTurn({ seat, turn, sameModel, admit: v => dispatchRefusal(v, unit, plan),
    args: { vendor: seat.vendor, model: seat.model, seat: clone(seat), prompt: DISPATCHER_PROMPT({ unit, plan }), schema: DISPATCH_SCHEMA, sandbox: CAPABILITIES.dispatcher, role: "dispatcher", unit_id: unit.unit_id, signal } });
  rec.attempts = r.attempts;
  if (!r.admitted) return Object.assign(rec, { code: r.code, why: `no dispatcher answer was admitted: ${r.why}` });
  const d = r.value;
  Object.assign(rec, { served_model: r.served_model, served_model_source: r.served_model_source, cohesive: d.cohesive, specialist_role: d.specialist_role, difficulty: d.difficulty, rubric: [...d.rubric],
    ...(typeof d.notes === "string" && d.notes !== "" ? { notes_withheld: { chars: d.notes.length, sha256: digestOf(d.notes) } } : {}) });
  rec.rubric_hash = rubricHash({ unit_id: unit.unit_id, owned_paths: unit.owned_paths, verify_cmd: unit.verify_cmd, invariants: unit.invariants, rubric: rec.rubric,
    specialist_role: rec.specialist_role, difficulty: rec.difficulty });
  if (!d.cohesive) {
    const ret = { reason: d.return?.reason ?? "UNSPECIFIED", moves: (d.return?.moves ?? []).map(m => ({ path: m.path, to_unit: m.to_unit })) };
    // Composed by the controller from the validated fields only.
    return Object.assign(rec, { status: "returned", code: "NOT_COHESIVE", return: ret,
      why: `the dispatcher judged the unit not cohesive (reason ${ret.reason}${ret.moves.length ? `; proposed moves: ${ret.moves.map(m => `${m.path} -> ${m.to_unit}`).join(", ")}` : "; no move proposed"}); it returns to the planner` });
  }
  rec.status = "dispatched";
  return rec;
}

// ---------------------------------------------------------------------------------------------- the controller

const unitsOverlap = (a, b) => a.owned_paths.flatMap(pa => b.owned_paths.filter(pb => pathsOverlap(pa, pb)).map(pb => [pa, pb]));

/** unit_id -> the set of its transitive upstream unit_ids. Assumes an acyclic plan. */
export function upstreamOf(units) {
  const by = new Map(units.map(u => [u.unit_id, u])), memo = new Map();
  const up = id => {
    if (memo.has(id)) return memo.get(id);
    const set = new Set();
    memo.set(id, set);
    for (const d of by.get(id)?.depends_on ?? []) if (by.has(d) && d !== id) { set.add(d); for (const x of up(d)) set.add(x); }
    return set;
  };
  for (const u of units) up(u.unit_id);
  return memo;
}

/**
 * Lock conflicts: pairs of units whose owned_paths overlap and that have NO dependency order between them (neither
 * is upstream of the other). Such a plan cannot be scheduled truthfully — whichever unit ran second would be
 * rewriting the other's files unseen — so it is a PLAN ERROR. Returns [{code: "LOCK_CONFLICT", a, b, paths, message}], sorted.
 */
export function lockConflicts(units) {
  const up = upstreamOf(units), sorted = [...units].sort(byId), out = [];
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    const a = sorted[i], b = sorted[j];
    if (up.get(a.unit_id).has(b.unit_id) || up.get(b.unit_id).has(a.unit_id)) continue;
    const paths = unitsOverlap(a, b);
    if (paths.length) out.push({ code: "LOCK_CONFLICT", a: a.unit_id, b: b.unit_id, paths, message: `units ${a.unit_id} and ${b.unit_id} own overlapping paths (${paths.map(p => `${p[0]} ~ ${p[1]}`).join("; ")}) and neither depends on the other` });
  }
  return out;
}

/**
 * Topological waves (Kahn, by level): a unit's wave comes after every wave holding one of its dependencies. Inside
 * a level, units are taken in unit_id order and a unit whose owned_paths overlap a unit already in the wave is moved
 * to the next sub-wave, so NO wave ever holds two overlapping units. (lockConflicts refuses such a plan before it is
 * scheduled; the split is the scheduler's own guarantee and does not rely on that refusal.)
 * Returns [[unit_id, ...], ...]; throws (code DEPENDENCY_CYCLE / UNKNOWN_DEPENDENCY) on a plan that cannot be ordered.
 */
export function waves(units) {
  const by = new Map(units.map(u => [u.unit_id, u]));
  for (const u of units) for (const d of u.depends_on) if (!by.has(d)) throw Object.assign(new Error(`unit ${u.unit_id} depends on "${d}", which is not a unit of this plan`), { code: "UNKNOWN_DEPENDENCY" });
  const cyc = cycleOf(units);
  if (cyc) throw Object.assign(new Error(`dependency cycle: ${cyc.join(" -> ")}`), { code: "DEPENDENCY_CYCLE" });
  const indeg = new Map(units.map(u => [u.unit_id, new Set(u.depends_on).size]));
  const out = [];
  let ready = units.filter(u => indeg.get(u.unit_id) === 0).sort(byId);
  while (ready.length) {
    const subs = [];
    for (const u of ready) {
      let sub = subs.find(s => s.every(o => !unitsOverlap(o, u).length));
      if (!sub) subs.push(sub = []);
      sub.push(u);
    }
    for (const s of subs) out.push(s.map(u => u.unit_id));
    const next = [];
    for (const done of ready) for (const u of units) if (new Set(u.depends_on).has(done.unit_id)) { indeg.set(u.unit_id, indeg.get(u.unit_id) - 1); if (indeg.get(u.unit_id) === 0) next.push(u); }
    ready = next.sort(byId);
  }
  return out;
}

/**
 * Bind ONE isolated worktree to a unit: a detached checkout of the run's base commit, plus the merged results
 * (patches) of the unit's upstream units applied in the order given and committed as one controller commit.
 * `lock` serialises the operations that touch the shared repository's worktree list.
 * Returns {path, base_commit}: base_commit is what the unit's own work is diffed against.
 */
export async function bindWorktree({ repo, base, path, upstream = [], lock = fn => fn() }) {
  await lock(() => git(repo, ["worktree", "add", "--detach", path, base]));
  const applied = [];
  for (const up of upstream) {
    if (!up.patch) continue;
    await git(path, ["apply", "--index", "--whitespace=nowarn", "-"], { input: up.patch });
    applied.push(up.unit_id);
  }
  if (applied.length) await git(path, ["commit", "--no-verify", "-q", "-m", `pantheon pipeline: upstream ${applied.join(", ")}`]);
  return { path, base_commit: (await git(path, ["rev-parse", "HEAD"])).trim() };
}

/** Remove a unit's worktree when the unit ends. Returns true when it is gone. */
export async function releaseWorktree({ repo, path, lock = fn => fn() }) {
  return lock(async () => {
    const r = await git(repo, ["worktree", "remove", "--force", path], { allowFail: true });
    if (r.code !== 0) { await rm(path, { recursive: true, force: true }); await git(repo, ["worktree", "prune"], { allowFail: true }); }
    return true;
  });
}
