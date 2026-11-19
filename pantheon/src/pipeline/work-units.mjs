// STAGE 1 OUTPUT: the plan's `work_units` — its JSON schema, its validator and the planner's specialist prompt.
//
// Inputs: a parsed plan object (or the planner's answer text). Outputs: {ok: true, units} with the units in
// unit_id order, or {ok: false, refusals: [{code, unit_id, message}]} naming EVERY rule broken.
//
// A work unit is a COHESIVE multi-file change with one owner: coupled types, implementation and tests stay in ONE
// unit, so that no unit can pass its verify_cmd only because another unit will later make it true.
//
// RESERVED PATHS. The agent transport is configured inside the worktree under names a unit may never own:
// `.agents` (Antigravity workspace config, e.g. .agents/mcp_config.json), `.gemini` and `.git`. An owned path that
// COULD match one of them at the repository root (`.agents`, `.agents/**`, `*`, `**`, `.*/x`, ...) is refused with
// code RESERVED_PATH, and so is any pattern with a literal `.agents`, `.gemini` or `.git` segment at any depth. The
// post-turn write jail (implement.mjs) stays the second line: it still judges every changed path from disk.
//
// Must never: accept a plan with an unknown key, a dangling or cyclic dependency, a path that leaves the
// repository or a reserved path; reorder, default or repair a field. A broken plan is refused whole, with each reason named.
import { keysRefusal, isObject, str, strictJson } from "./util.mjs";
import { pathRefusal, overlapsReserved } from "./paths.mjs";
import { verifyCmdProblem } from "../agy/jail-hook.mjs";

/** Transport configuration lives under these names; no unit may own a path that could match them. */
export const RESERVED_NAMES = Object.freeze([".agents", ".gemini", ".git"]);
const RESERVED_PATTERNS = Object.freeze(RESERVED_NAMES.flatMap(n => [n, `${n}/**`]));

/** Why owned-path pattern `p` could match a reserved path, or null. Assumes pathRefusal(p) is null. */
export function reservedPathRefusal(p) {
  const hit = RESERVED_PATTERNS.find(r => overlapsReserved(p, r));
  if (hit) return `"${p}" could match ${hit}, which is reserved for transport configuration`;
  const seg = p.split("/").find(s => RESERVED_NAMES.includes(s.toLowerCase()));
  if (seg) return `"${p}" names a ${seg} directory, which is reserved for transport configuration`;
  return null;
}

export const DIFFICULTIES = Object.freeze(["easy", "medium", "hard"]);
export const UNIT_KEYS = Object.freeze(["unit_id", "depends_on", "owned_paths", "difficulty", "specialist_role", "allowed_subagents", "verify_cmd", "invariants"]);
const UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A specialist role is a NAME, not an instruction (independent review, assignment 2, question 7): the implementer's
// prompt interpolates it, so free text there would be an unreviewed instruction channel outside the frozen rubric.
// Lower-case words joined by "-", at most six words and 48 characters: "node-esm-library-engineer".
export const SPECIALIST_ROLE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,5}$/;
export const SPECIALIST_ROLE_MAX = 48;
export const specialistRoleRefusal = v => (typeof v === "string" && v.length <= SPECIALIST_ROLE_MAX && SPECIALIST_ROLE.test(v) ? null
  : `specialist_role is a role name: lower-case words joined by "-" (at most six words, ${SPECIALIST_ROLE_MAX} characters), not free text`);

/** The strict JSON schema of a plan's work units (handed to a transport that supports structured output). */
export const WORK_UNITS_SCHEMA = Object.freeze({
  $id: "pantheon.pipeline.work-units/v1",
  type: "object",
  additionalProperties: false,
  required: ["work_units"],
  properties: {
    work_units: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [...UNIT_KEYS],
        properties: {
          unit_id: { type: "string", pattern: UNIT_ID.source },
          depends_on: { type: "array", items: { type: "string" }, uniqueItems: true },
          owned_paths: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, uniqueItems: true },
          difficulty: { enum: [...DIFFICULTIES] },
          specialist_role: { type: "string", pattern: SPECIALIST_ROLE.source, maxLength: SPECIALIST_ROLE_MAX },
          allowed_subagents: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
          verify_cmd: { type: "string", minLength: 1 },
          invariants: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        },
      },
    },
  },
});

const strings = v => Array.isArray(v) && v.every(str);

/** Validate a plan. Every broken rule is one named refusal; nothing is repaired. */
export function validateWorkUnits(plan) {
  const refusals = [];
  const no = (code, unit_id, message) => refusals.push({ code, unit_id, message });
  const top = keysRefusal(plan, ["work_units"]);
  if (top) return { ok: false, refusals: [{ code: "PLAN_SHAPE", unit_id: null, message: `the plan is ${top}; it is {"work_units": [...]}` }] };
  if (!Array.isArray(plan.work_units) || !plan.work_units.length) return { ok: false, refusals: [{ code: "PLAN_EMPTY", unit_id: null, message: "work_units is a non-empty array" }] };

  const ids = new Map();
  plan.work_units.forEach((u, i) => {
    const at = isObject(u) && typeof u.unit_id === "string" && u.unit_id !== "" ? u.unit_id : `#${i}`;
    if (!isObject(u)) return no("UNIT_SHAPE", at, `work_units[${i}] is not an object`);
    const keys = keysRefusal(u, [...UNIT_KEYS]);
    if (keys) no(keys.startsWith("unknown") ? "UNKNOWN_KEY" : "MISSING_KEY", at, `unit ${at}: ${keys}`);
    if (typeof u.unit_id !== "string" || !UNIT_ID.test(u.unit_id)) no("UNIT_ID", at, `unit ${at}: unit_id is a non-empty string of letters, digits, ".", "_" or "-" (at most 64, starting with a letter or digit)`);
    else if (ids.has(u.unit_id)) no("DUPLICATE_UNIT_ID", at, `unit_id "${u.unit_id}" is used by more than one unit`);
    else ids.set(u.unit_id, u);
    if (!Array.isArray(u.owned_paths) || !u.owned_paths.length) no("OWNED_PATHS_EMPTY", at, `unit ${at}: owned_paths is a non-empty array`);
    else {
      for (const p of u.owned_paths) {
        const why = pathRefusal(p);
        if (why) { no("OWNED_PATH", at, `unit ${at}: ${why}`); continue; }
        const reserved = reservedPathRefusal(p);
        if (reserved) no("RESERVED_PATH", at, `unit ${at}: ${reserved}`);
      }
      if (new Set(u.owned_paths).size !== u.owned_paths.length) no("OWNED_PATH", at, `unit ${at}: owned_paths repeats a path`);
    }
    if (!DIFFICULTIES.includes(u.difficulty)) no("DIFFICULTY", at, `unit ${at}: difficulty is one of ${DIFFICULTIES.join(", ")}`);
    if (!str(u.specialist_role)) no("SPECIALIST_ROLE", at, `unit ${at}: specialist_role is a non-empty string`);
    else if (specialistRoleRefusal(u.specialist_role)) no("SPECIALIST_ROLE", at, `unit ${at}: ${specialistRoleRefusal(u.specialist_role)}`);
    if (!str(u.verify_cmd)) no("VERIFY_CMD", at, `unit ${at}: verify_cmd is a non-empty string`);
    // The SAFE FORM (src/agy/jail-hook.mjs verifyCmdProblem): simple commands joined by " && ", no shell metacharacter
    // outside quotes. Independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6), question 3.
    else if (verifyCmdProblem(u.verify_cmd)) no("VERIFY_CMD", at, `unit ${at}: ${verifyCmdProblem(u.verify_cmd)}`);
    if (!strings(u.invariants) || !u.invariants.length) no("INVARIANTS", at, `unit ${at}: invariants is a non-empty array of non-empty strings`);
    if (!strings(u.allowed_subagents)) no("ALLOWED_SUBAGENTS", at, `unit ${at}: allowed_subagents is an array of non-empty strings (it may be empty)`);
    else if (new Set(u.allowed_subagents).size !== u.allowed_subagents.length) no("ALLOWED_SUBAGENTS", at, `unit ${at}: allowed_subagents repeats a role`);
    if (!Array.isArray(u.depends_on) || !u.depends_on.every(d => typeof d === "string")) no("DEPENDS_ON", at, `unit ${at}: depends_on is an array of unit ids`);
  });

  // Dependencies are judged over the units that have a usable id, so one bad unit does not hide another's error.
  for (const [id, u] of ids) {
    if (!Array.isArray(u.depends_on)) continue;
    if (new Set(u.depends_on).size !== u.depends_on.length) no("DEPENDS_ON", id, `unit ${id}: depends_on repeats a unit`);
    for (const d of u.depends_on) {
      if (d === id) no("DEPENDENCY_CYCLE", id, `unit ${id} depends on itself`);
      else if (!ids.has(d)) no("UNKNOWN_DEPENDENCY", id, `unit ${id} depends on "${d}", which is not a unit of this plan`);
    }
  }
  const cyc = cycleOf([...ids.values()]);
  if (cyc) no("DEPENDENCY_CYCLE", cyc[0], `dependency cycle: ${cyc.join(" -> ")}`);

  if (refusals.length) return { ok: false, refusals };
  return { ok: true, units: [...ids.values()].sort((a, b) => (a.unit_id < b.unit_id ? -1 : 1)) };
}

/** A dependency cycle among `units` as [a, b, ..., a], or null. Unknown and self dependencies are ignored here. */
export function cycleOf(units) {
  const by = new Map(units.map(u => [u.unit_id, u]));
  const state = new Map();   // 1 = on the stack, 2 = done
  const stack = [];
  const visit = id => {
    state.set(id, 1); stack.push(id);
    for (const d of [...(Array.isArray(by.get(id).depends_on) ? by.get(id).depends_on : [])].sort()) {
      if (d === id || !by.has(d)) continue;
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!state.has(d)) { const c = visit(d); if (c) return c; }
    }
    stack.pop(); state.set(id, 2);
    return null;
  };
  for (const id of [...by.keys()].sort()) if (!state.has(id)) { const c = visit(id); if (c) return c; }
  return null;
}

/** Parse and validate the planner's ANSWER: the whole text must be the plan object. */
export function parseWorkUnits(text) {
  const parsed = strictJson(text);
  if (!parsed.ok) return { ok: false, refusals: [{ code: "NOT_JSON", unit_id: null, message: parsed.why }] };
  return validateWorkUnits(parsed.value);
}

/**
 * The Stage 1 planner's specialist prompt. Read-only: the planner decomposes, it writes no file.
 * `task` is the change wanted; `context` what the controller read from the repository for it; `subagents` the
 * subagent role ids a unit may be allowed to consult.
 */
export function PLANNER_PROMPT({ task, context = "", subagents = [] }) {
  return [
    "ROLE: work-unit planner for a supervised build pipeline. You are a READ-ONLY specialist: you decompose a change into work units. You write no code, edit no file and run no command.",
    "",
    "TASK",
    String(task),
    "",
    context ? `REPOSITORY CONTEXT (read by the controller)\n${context}\n` : "",
    "WHAT A WORK UNIT IS",
    "- One COHESIVE multi-file change with a single owner. Coupled files belong to ONE unit: the types, the implementation that uses them and the tests that prove them stay together. Never split a type from its implementation, or an implementation from its tests, into separate units.",
    "- A unit must be verifiable ALONE, on top of its upstream units: its verify_cmd must pass without any unit that does not appear in its depends_on.",
    "- owned_paths are repo-relative paths or globs (`*`, `?`, and `**` as a whole segment). They are the ONLY paths the unit's implementer may change. Two units' owned_paths must not overlap unless one depends on the other.",
    "- depends_on names the unit_ids whose merged result this unit builds on. No cycles.",
    "- difficulty is easy, medium or hard, judged by reasoning needed, not by line count.",
    "- specialist_role names the kind of engineer who should own the unit (for example \"node-esm-library-engineer\").",
    `- allowed_subagents lists the subagent roles the implementer may consult for a single stateless question${subagents.length ? ` (available: ${subagents.join(", ")})` : ""}; use [] when none is needed.`,
    "- verify_cmd is one deterministic shell command, run by the controller in the unit's worktree, whose exit code is the ground truth. No network, no interactive input, no dependence on wall-clock time. It is one line of simple commands joined by \" && \" (a command may start with \"!\"): no ; | || & > < ( ) { } $ ` \\ # ~ outside quotes, and no $, ` or \\ inside double quotes (wrap anything else as sh -c '...').",
    "- invariants are explicit acceptance constraints a reviewer can check against the diff and the verify output.",
    "",
    "Prefer FEWER, cohesive units over many small ones. A unit that touches one file because its coupled files were given to another unit is a planning error.",
    "",
    "OUTPUT: exactly one JSON object and nothing else (no prose, no code fence), with exactly these keys:",
    '{"work_units":[{"unit_id":"string","depends_on":["upstream_unit_id"],"owned_paths":["path/or/glob/**"],"difficulty":"easy | medium | hard","specialist_role":"string","allowed_subagents":["subagent_role_id"],"verify_cmd":"deterministic test/check command","invariants":["explicit acceptance constraint"]}]}',
    "Any other key, a missing key, or text outside the object is refused.",
  ].filter(l => l !== "").join("\n");
}
