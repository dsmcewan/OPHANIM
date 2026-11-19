// THE SUBAGENT GOVERNOR: the controller's admission, identity and lineage of the native Antigravity subagents an
// implementer delegates to. Pure: every input is passed in; it calls no provider, spawns nothing and reads no file but
// the transport's configuration.
//
// OWNER DIRECTION 2026-11-19. An implementer's subagents are gemini-4-hydrogen, created when the implementer has a
// specific assignment, within a ceiling the CONTROLLER enforces: Carbon at most 8, Neon at most 4, Hydrogen none.
// Ceilings, not team sizes. They are implementation contributors, never independent reviewers (pipeline/record.mjs
// lists each as a `subtask` contribution, so it is excluded from every later review).
//
// WHY ADMISSION IS HERE AND NOT IN THE AGENT'S INSTRUCTIONS. Observed on google-antigravity 0.1.24 (the contract test
// pantheon/tests/antigravity-sdk-contract.test.mjs repeats each observation against the installed SDK):
//   - the model-facing invoke_subagent tool defaults a child to "inherit": a child of an unpinned type runs on the
//     PARENT's model. Only a statically configured type with its own model runs elsewhere, and that pin holds even
//     when the invocation names a tier ("pro") or "inherit";
//   - define_subagent lets the model define a type at run time. No SDK hook and no SDK policy fires for it; a type so
//     defined has no pin. The SDK's pre-tool hook does fire for invoke_subagent, with the type name: so admission is
//     decided THERE, by type name, and a type this controller did not pin is refused (code SUBAGENT_TYPE_NOT_PINNED);
//   - send_message wakes an idle child, again with no hook and no policy, and ending a child with manage_subagents
//     emits no event. So "idle" is not "ended", and no state the controller observes proves a child cannot run again
//     (a CANCELLED child included: whether the runtime lets its parent wake it is not observed). A slot is therefore
//     held from admission to the end of the implementer session: LIVE counts every subagent admitted in the session.
//     LIVE <= ceiling is what is enforced; ACTIVE <= LIVE follows. This is STRICTER than "concurrently active": an
//     implementer reuses an idle subagent (send_message) rather than replacing it. (The model gateway refuses, on the
//     wire, a request for any model that is not the implementer's or the pinned subagent model, and any child session
//     past the ceiling; its count of child sessions never shrinks either: the second line, independent of this one.)
//
// THE RECORD (record()): {model, ceiling, implementer, admitted_total, live, active, peak_live, peak_active,
//   instances: [{id, type, role, scope, tools, model, call_id, admitted_at, prompt_digest, prompt_bytes, status,
//   trajectory_id, states: [{state, at}], usage, output: {digest, bytes}, error}], rejections: [{at, code, why, asked,
//   live, ceiling, call_id, trajectory_id}], unbound_trajectories: [{trajectory_id, states}]}.
// An assignment's text and an answer's text are never kept: their digests and sizes are.
//
// Must never: admit past the ceiling; admit a type that is not pinned to the subagent model; free a slot inside a
// session; drop a rejection; take a child's own account of which model it ran on.
import { createHash } from "node:crypto";
import { SDK_CONFIG } from "./config.mjs";

const SUB = SDK_CONFIG.subagents;
const sha = s => "sha256:" + createHash("sha256").update(String(s)).digest("hex");
const str = v => typeof v === "string" && v.trim() !== "";
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);

/** The one model every native subagent runs on. */
export const SUBAGENT_MODEL = SUB.model;
/** Implementer model -> the most subagents it may have live at once. */
export const SUBAGENT_CEILINGS = Object.freeze({ ...SUB.ceilings });
export const SUBAGENT_MAX_DEPTH = SUB.max_depth;
/** The ceiling of an implementer model: its declared one, else none. */
export const ceilingFor = model => (Object.hasOwn(SUB.ceilings, String(model)) ? SUB.ceilings[model] : SUB.default_ceiling);

const scopeOf = t => Object.freeze({ read: "the unit's worktree", write: t.write ? "owned_paths of the unit, inside the unit's worktree" : "none", commands: "none", network: "none", delegation: "none" });
/** The specialist types the controller pins to SUBAGENT_MODEL: {name: {description, instructions, write, tools, scope}}. */
export const SUBAGENT_TYPES = Object.freeze(Object.fromEntries(Object.entries(SUB.types).map(([name, t]) => [name, Object.freeze({
  name, description: t.description, instructions: t.instructions, write: Boolean(t.write), model: SUB.model,
  tools: Object.freeze([...SUB.read_tools, ...(t.write ? SUB.write_tools : [])]), scope: scopeOf(t),
})])));
export const SUBAGENT_TYPE_NAMES = Object.freeze(Object.keys(SUBAGENT_TYPES));
/** Why `names` is not a list of specialist type names, or null. */
export const subagentTypesRefusal = names => {
  if (!Array.isArray(names) || !names.every(str)) return "allowed_subagents is an array of specialist type names";
  const unknown = names.filter(n => !Object.hasOwn(SUBAGENT_TYPES, n));
  return unknown.length ? `unknown specialist type(s): ${unknown.join(", ")} (known: ${SUBAGENT_TYPE_NAMES.join(", ")})` : null;
};

const STATUS_OF = { RUNNING: "running", FULLY_IDLE: "idle", CANCELLED: "cancelled", WAITING_FOR_TASKS: "waiting", WAITING_FOR_SUBAGENTS: "waiting" };
const stateName = s => String(s ?? "").replace(/^STATE_/, "");

/**
 * The governor of one implementer session.
 *   implementer    {vendor, model}: the implementer seat that is running (its model sets the ceiling)
 *   unit_id        the work unit (recorded)
 *   allowed_types  the specialist types the unit's contract allows (work unit `allowed_subagents`); [] allows none
 *   now            () -> ISO time (injected for tests)
 */
export function subagentGovernor({ implementer, unit_id = null, allowed_types = [], now = () => new Date().toISOString() } = {}) {
  if (!isObj(implementer) || !str(implementer.model)) throw new Error("subagentGovernor: pass the implementer seat {vendor, model}");
  const ceiling = ceilingFor(implementer.model);
  const allowed = [...new Set((Array.isArray(allowed_types) ? allowed_types : []).filter(n => Object.hasOwn(SUBAGENT_TYPES, n)))].sort();
  const ignored = [...new Set((Array.isArray(allowed_types) ? allowed_types : []).filter(n => !Object.hasOwn(SUBAGENT_TYPES, n)).map(String))].sort();
  const instances = [], rejections = [], trajectories = new Map();   // trajectory_id -> {parent, depth, states, instance}
  let root = null, peakLive = 0, peakActive = 0;

  // Every subagent admitted in this session holds its slot until the session ends (see the header): no state frees one.
  const live = () => instances.length;
  const activeNow = () => [...trajectories.values()].filter(t => t.depth > 0 && t.states.at(-1)?.state === "RUNNING").length;
  const reject = (code, reason, ctx) => {
    rejections.push({ at: now(), code, why: reason, asked: ctx.asked ?? 0, live: live(), ceiling, call_id: ctx.call_id ?? null, trajectory_id: ctx.trajectory_id ?? null });
    return { allow: false, code, reason, admitted: [] };
  };

  /** Decide one invoke_subagent call. Everything in it is admitted, or nothing is. */
  function admit({ call_id = null, trajectory_id = null, args } = {}) {
    const list = isObj(args) && Array.isArray(args.Subagents) ? args.Subagents : null;
    const ctx = { call_id, trajectory_id, asked: list?.length ?? 0 };
    if (!list || !list.length || !list.every(isObj)) return reject("SUBAGENT_MALFORMED", "invoke_subagent names its subagents as a non-empty array of {TypeName, Role, Prompt}", ctx);
    if (trajectory_id && root && trajectory_id !== root) return reject("SUBAGENT_RECURSION", `a subagent may not delegate: the call comes from trajectory ${String(trajectory_id).slice(0, 12)}, not from the implementer (depth is ${SUBAGENT_MAX_DEPTH})`, ctx);
    if (ceiling === 0) return reject("SUBAGENT_NOT_ALLOWED", `the ${implementer.model} implementer delegates to no subagent (its ceiling is 0)`, ctx);
    for (const e of list) {
      if (!str(e.TypeName)) return reject("SUBAGENT_MALFORMED", "a subagent entry names its TypeName", ctx);
      if (!Object.hasOwn(SUBAGENT_TYPES, e.TypeName)) return reject("SUBAGENT_TYPE_NOT_PINNED", `subagent type "${e.TypeName}" is not one the controller pins to ${SUBAGENT_MODEL} (${SUBAGENT_TYPE_NAMES.join(", ")}): it would run on the implementer's own model`, ctx);
      if (!allowed.includes(e.TypeName)) return reject("SUBAGENT_TYPE_NOT_ALLOWED", `subagent type "${e.TypeName}" is not in this unit's allowed_subagents (${allowed.join(", ") || "none"})`, ctx);
      if (e.Model !== undefined && e.Model !== null && e.Model !== "inherit") return reject("SUBAGENT_MODEL_OVERRIDE", `the invocation names Model "${String(e.Model).slice(0, 60)}": a subagent's model is the controller's pin (${SUBAGENT_MODEL}), never the implementer's choice`, ctx);
      if (e.Workspace !== undefined && e.Workspace !== null && e.Workspace !== "inherit") return reject("SUBAGENT_WORKSPACE", `the invocation asks for workspace "${String(e.Workspace).slice(0, 60)}": a subagent works in the unit's one controller-bound worktree (inherit)`, ctx);
      if (!str(e.Role) || !str(e.Prompt) || e.Prompt.trim().length < SUB.min_assignment_chars) return reject("SUBAGENT_ASSIGNMENT", `a subagent is created for a specific assignment: a Role and a Prompt of at least ${SUB.min_assignment_chars} characters`, ctx);
    }
    const have = live();
    if (have + list.length > ceiling) return reject("SUBAGENT_LIMIT", `${have} live + ${list.length} asked > ${ceiling}: the ${implementer.model} implementer may have at most ${ceiling} Hydrogen subagent(s) live (an idle subagent still holds its slot; give it its next task with send_message)`, ctx);
    const admitted = list.map(e => {
      const t = SUBAGENT_TYPES[e.TypeName];
      const inst = { id: `sa-${instances.length + 1}`, type: t.name, role: e.Role.trim().slice(0, 120), scope: { ...t.scope }, tools: [...t.tools], model: SUBAGENT_MODEL, call_id, admitted_at: now(),
        prompt_digest: sha(e.Prompt), prompt_bytes: Buffer.byteLength(e.Prompt), bind_key: sha(e.Prompt.trim()), status: "admitted", trajectory_id: null, states: [], usage: null, output: null, error: null };
      instances.push(inst);
      return inst;
    });
    peakLive = Math.max(peakLive, live());
    return { allow: true, code: null, reason: `${admitted.length} Hydrogen subagent(s) admitted (${live()} of ${ceiling} live)`, admitted: admitted.map(i => i.id) };
  }

  const traj = (id, parent = "", depth = null) => {
    if (!trajectories.has(id)) trajectories.set(id, { trajectory_id: id, parent: parent || "", depth: depth ?? (parent ? 1 : 0), states: [], instance: null });
    const t = trajectories.get(id);
    if (parent && !t.parent) t.parent = parent;
    if (Number.isInteger(depth)) t.depth = depth;
    return t;
  };

  /** Feed one runtime event: trajectory_state, child_started {prompt | prompt_key}, child_output {text | digest, bytes}, usage {agents}. */
  function observe(ev) {
    if (!isObj(ev)) return;
    if (ev.event === "trajectory_state" && str(ev.trajectory_id)) {
      const t = traj(ev.trajectory_id, ev.parent_trajectory_id, Number.isInteger(ev.depth) ? ev.depth : null);
      if (t.depth === 0 && !t.parent && !root) root = t.trajectory_id;
      const state = stateName(ev.state);
      t.states.push({ state, at: now(), ...(str(ev.error) ? { error: ev.error.slice(0, 300) } : {}), ...(str(ev.error_code) ? { error_code: ev.error_code } : {}), ...(str(ev.stop_reason) && !/UNSPECIFIED/.test(ev.stop_reason) ? { stop_reason: ev.stop_reason } : {}) });
      if (t.instance) apply(t.instance, state, ev);
      peakActive = Math.max(peakActive, activeNow());
    } else if (ev.event === "child_started" && str(ev.trajectory_id)) {
      const t = traj(ev.trajectory_id, ev.parent_trajectory_id, 1);
      if (t.instance) return;
      // Bound by the assignment the child was started with (its text, trimmed, by digest): the first admitted, still
      // unbound subagent that was given it. The bridge sends the digest (`prompt_key`), never the text.
      const key = str(ev.prompt_key) ? ev.prompt_key : str(ev.prompt) ? sha(ev.prompt.trim()) : null;
      const inst = key ? instances.find(i => !i.trajectory_id && i.bind_key === key) : null;
      if (!inst) return;
      t.instance = inst; inst.trajectory_id = t.trajectory_id;
      for (const s of t.states) apply(inst, s.state, s, s.at);
    } else if (ev.event === "child_output" && str(ev.trajectory_id) && (typeof ev.text === "string" || str(ev.digest))) {
      const inst = trajectories.get(ev.trajectory_id)?.instance;
      if (inst) inst.output = typeof ev.text === "string" ? { digest: sha(ev.text), bytes: Buffer.byteLength(ev.text) } : { digest: ev.digest, bytes: Number.isFinite(ev.bytes) ? ev.bytes : null };
    } else if (ev.event === "usage" && isObj(ev.agents)) {
      for (const [id, u] of Object.entries(ev.agents)) { const inst = trajectories.get(id)?.instance; if (inst && isObj(u)) inst.usage = { ...u }; }
    }
  }
  function apply(inst, state, ev, at = null) {
    inst.states.push({ state, at: at ?? now() });
    inst.status = str(ev.error) ? "errored" : STATUS_OF[state] ?? inst.status;
    if (str(ev.error)) inst.error = ev.error.slice(0, 300);
  }

  const subagentOf = id => { const i = trajectories.get(id)?.instance; return i ? { id: i.id, type: i.type, tools: [...i.tools], write: SUBAGENT_TYPES[i.type].write } : null; };
  return {
    ceiling, model: SUBAGENT_MODEL, allowed_types: [...allowed], ignored_types: ignored,
    admit, observe, subagentOf,
    /** The implementer's own trajectory, once the runtime named it. */
    root: () => root,
    /** Is `trajectory_id` a child (anything that is not the implementer's own trajectory)? Unknown before the root is known. */
    isChild: id => Boolean(root) && str(id) && id !== root,
    live, active: activeNow,
    record: () => ({ model: SUBAGENT_MODEL, ceiling, implementer: { vendor: implementer.vendor ?? null, model: implementer.model }, unit_id, allowed_types: [...allowed], ...(ignored.length ? { ignored_types: ignored } : {}),
      admitted_total: instances.length, live: live(), active: activeNow(), peak_live: peakLive, peak_active: peakActive,
      instances: instances.map(({ bind_key, ...i }) => ({ ...i, scope: { ...i.scope }, tools: [...i.tools], states: i.states.map(s => ({ ...s })), usage: i.usage ? { ...i.usage } : null, output: i.output ? { ...i.output } : null })),
      rejections: rejections.map(r => ({ ...r })),
      unbound_trajectories: [...trajectories.values()].filter(t => t.trajectory_id !== root && !t.instance).map(t => ({ trajectory_id: t.trajectory_id, parent: t.parent, depth: t.depth, states: t.states.map(s => ({ ...s })) })) }),
  };
}
