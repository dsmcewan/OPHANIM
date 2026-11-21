// A task profile: independent dimensions of a ticket, each driving its OWN dial (the `fit` routing
// profile, docs/routing-task-profile.md). `fit` is the lifecycle's default since 2026-11-17 (owner direction);
// `argo` is still what the selector uses when no profile is named. A ticket that names only `difficulty` still
// runs -- the legacy label maps to a default profile here, and under `fit` it also names the matrix column
// (fit-matrix.mjs), which the floors below can raise and never lower.
//
//   depth      none|light|standard|deep|max  -> the effort rung, mapped proportionally onto the chosen
//                                               model's OWN documented ladder (capability-facts.json)
//   output     xs|s|m|l|xl                   -> output tier (config/tiers.mjs), capped at the documented ceiling
//   context    measured estimate only        -> admission (M7: an unrecorded window is excluded with its reason)
//   stakes     low|normal|high|critical      -> minimum model class AND the number of independent review labs
//   ambiguity  settled|open|contested        -> planner class floor and an explorer width (distinct labs)
//   latency    interactive|batch             -> tie-break toward the faster class (how far fallbacks may climb)
//   kind       code|analysis|prose|review    -> capability filter where facts support it, else recorded unfiltered
//
// Every dimension is {value, basis}; basis is `ticket` (the ticket's own field), `derived:<signal>`, or
// `legacy-difficulty`. Every mapping below is PROVISIONAL: a routing judgment, not a measurement.
import { documentedEfforts, carriesEffort } from "./protocol.mjs";

export const TASK_PROFILE = "pantheon.task-profile/v1";
export const DIMENSIONS = Object.freeze({
  depth: Object.freeze(["none", "light", "standard", "deep", "max"]),
  output: Object.freeze(["xs", "s", "m", "l", "xl"]),
  stakes: Object.freeze(["low", "normal", "high", "critical"]),
  ambiguity: Object.freeze(["settled", "open", "contested"]),
  latency: Object.freeze(["interactive", "batch"]),
  kind: Object.freeze(["code", "analysis", "prose", "review"]),
});
const DECLARED = ["depth", "output", "stakes", "ambiguity", "latency", "kind"];

/** The default profile for an old ticket's single label. Explicit dimension fields win over it. */
export const LEGACY_PROFILE = Object.freeze({
  // `easy` carries LOW stakes (owner direction 2026-11-17, the fit matrix): with normal stakes its class floor was
  // `standard`, so no easy ticket could reach the easy column (gpt-6-luna and its peers). Stated stakes still raise it.
  easy: Object.freeze({ depth: "light", output: "s", stakes: "low", ambiguity: "settled" }),
  medium: Object.freeze({ depth: "standard", output: "m", stakes: "normal", ambiguity: "open" }),
  hard: Object.freeze({ depth: "deep", output: "l", stakes: "high", ambiguity: "open" }),
});

// Dimension -> requirement tables. PROVISIONAL (2026-11-17), unmeasured.
export const STAKES_FLOOR = Object.freeze({ low: "fast", normal: "standard", high: "frontier", critical: "frontier" });
export const REVIEW_LABS = Object.freeze({ low: 1, normal: 1, high: 2, critical: 3 });
export const AMBIGUITY_FLOOR = Object.freeze({ settled: "fast", open: "standard", contested: "frontier" });
export const EXPLORER_WIDTH = Object.freeze({ settled: 0, open: 1, contested: 3 });
// Roles whose class floor the ambiguity dimension also sets (the planner owns resolving it).
export const AMBIGUITY_ROLES = Object.freeze(["planner"]);
// How many classes above the floor fallbacks may climb: interactive work prefers the faster class.
export const LATENCY_CLIMB = Object.freeze({ interactive: 1, batch: 2 });

// Paths: a touched path naming ledger/governance/authority/key/security material is critical; a change
// that touches only tests or docs is low. Matched on path segments, so "monkey.mjs" is not a key.
const CRITICAL = /(^|[/._-])(ledgers?|governance|authority|authorities|keys?|security|secrets?|signing)([/._-]|$)/i;
const LOW = p => /(^|\/)(tests?|docs?)\//i.test(p) || /\.test\.[cm]?[jt]s$/i.test(p) || /\.md$/i.test(p);

export function stakesFromPaths(paths = []) {
  const list = paths.filter(p => typeof p === "string" && p);
  if (!list.length) return null;
  const hit = list.find(p => CRITICAL.test(p));
  if (hit) return { value: "critical", why: `${hit} names ledger/governance/authority/key/security material` };
  if (list.every(LOW)) return { value: "low", why: "every touched path is tests or docs" };
  return null;
}

/** The mapping the profile applies, as data: what selectionPolicy('fit') hashes. */
export const PROFILE_MAPPING = Object.freeze({ schema: TASK_PROFILE, dimensions: DIMENSIONS, legacy: LEGACY_PROFILE,
  stakes_floor: STAKES_FLOOR, review_labs: REVIEW_LABS, ambiguity_floor: AMBIGUITY_FLOOR, ambiguity_roles: AMBIGUITY_ROLES,
  explorer_width: EXPLORER_WIDTH, latency_climb: LATENCY_CLIMB, depth_to_effort: "round(depth_index * (ladder_length - 1) / 4)",
  stakes_paths: { critical: CRITICAL.source, low: "tests/ or docs/ segment, *.test.*, *.md" } });

/**
 * The profile for a ticket. `signals`: {paths} (the files the ticket touches), {context_tokens} (a measured
 * estimate, when one exists at this point), {mode} (`batch` for the board dispatcher). Throws on a value
 * outside a dimension's set, and on a declared `context`: context is measured, never declared.
 */
export function taskProfile(spec = {}, signals = {}) {
  if (spec.context !== undefined) throw new Error("ticket field \"context\" is not accepted: context is measured (an estimate from the prompt), never declared");
  const difficulty = spec.difficulty ?? "medium";
  const legacy = LEGACY_PROFILE[difficulty];
  if (!legacy) throw new Error(`unknown ticket difficulty "${difficulty}" (known: ${Object.keys(LEGACY_PROFILE).join(", ")})`);
  for (const k of DECLARED) if (spec[k] !== undefined && !DIMENSIONS[k].includes(spec[k])) {
    throw new Error(`unknown ${k} "${spec[k]}" (known: ${DIMENSIONS[k].join(", ")})`);
  }
  const ticket = k => spec[k] !== undefined ? { value: spec[k], basis: "ticket" } : null;
  const fromLegacy = k => ({ value: legacy[k], basis: "legacy-difficulty" });
  const paths = stakesFromPaths(signals.paths);
  const docsOnly = paths?.value === "low";
  return {
    schema: TASK_PROFILE,
    difficulty: { value: difficulty, basis: spec.difficulty === undefined ? "legacy-difficulty" : "ticket" },
    depth: ticket("depth") ?? fromLegacy("depth"),
    output: ticket("output") ?? fromLegacy("output"),
    context: Number.isFinite(signals.context_tokens) ? { value: signals.context_tokens, basis: "derived:prompt-chars" } : { value: null, basis: "derived:prompt-chars" },
    stakes: ticket("stakes") ?? (paths ? { value: paths.value, basis: "derived:paths" } : (signals.paths?.length
      ? (legacy.stakes === "normal" ? { value: "normal", basis: "derived:paths" } : fromLegacy("stakes")) : fromLegacy("stakes"))),
    ambiguity: ticket("ambiguity") ?? fromLegacy("ambiguity"),
    latency: ticket("latency") ?? { value: signals.mode === "interactive" ? "interactive" : "batch", basis: "derived:dispatch-mode" },
    kind: ticket("kind") ?? { value: docsOnly ? "prose" : "code", basis: "derived:paths" },
  };
}

/** The minimum model class for a role under a profile, and why. */
export function classFloor(task, role, order = ["fast", "standard", "frontier"]) {
  const why = [`stakes ${task.stakes.value} (${task.stakes.basis}) -> ${STAKES_FLOOR[task.stakes.value]}`];
  let floor = STAKES_FLOOR[task.stakes.value];
  if (AMBIGUITY_ROLES.includes(role)) {
    const a = AMBIGUITY_FLOOR[task.ambiguity.value];
    why.push(`ambiguity ${task.ambiguity.value} (${task.ambiguity.basis}) -> ${a} for the ${role}`);
    if (order.indexOf(a) > order.indexOf(floor)) floor = a;
  }
  return { value: floor, why: why.join("; ") };
}

/** Requirements the profile states for later stages: run-item.mjs consumes both under `fit` (review panel, intake width). */
export function requirementsOf(task) {
  return {
    review_labs: { value: REVIEW_LABS[task.stakes.value], basis: `stakes ${task.stakes.value} (${task.stakes.basis})` },
    explorer_width: { value: EXPLORER_WIDTH[task.ambiguity.value], basis: `ambiguity ${task.ambiguity.value} (${task.ambiguity.basis})`, unit: "distinct labs" },
  };
}

/**
 * The effort for a depth on a model's OWN documented ladder, proportionally: depth index d of 0..4 maps to
 * rung round(d * (n - 1) / 4) of the model's n documented values. No documented ladder, or a transport that
 * does not carry effort, gives none -- and says which.
 */
export function effortForDepth(depth, { vendor, model }) {
  const d = DIMENSIONS.depth.indexOf(depth);
  if (d === -1) throw new Error(`unknown depth "${depth}"`);
  if (!carriesEffort({ vendor, model })) return { value: null, depth, ladder: [], mapped: `none: effort is not carried by the agy transport for ${model}` };
  const ladder = documentedEfforts(model);
  if (!ladder.length) return { value: null, depth, ladder: [], mapped: `none: ${model} has no documented effort ladder (capability-facts.json)` };
  const i = Math.round(d * (ladder.length - 1) / (DIMENSIONS.depth.length - 1));
  return { value: ladder[i], depth, ladder: [...ladder], index: i,
    mapped: `depth ${depth} (${d}/${DIMENSIONS.depth.length - 1}) -> rung ${i}/${ladder.length - 1} "${ladder[i]}" of ${model}'s documented ladder [${ladder}]` };
}
