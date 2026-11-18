// THE FIT ROUTING MATRIX (owner direction 2026-11-17). One table: role x difficulty -> the seat `fit` starts on.
// Pure data and pure functions; nothing here calls a provider or reads a ticket.
//
//   role         easy                       medium                    hard
//   planner      Anthropic's sonnet         opus (newest declared)    the top Anthropic seat   (ids: FIT_MATRIX below)
//   dispatcher   gpt-6-luna                 gpt-6.1-sol               gpt-6-astra
//   implementer  gemini-4-hydrogen-medium   gemini-4-hydrogen-high    gemini-4-carbon-high     (Antigravity lanes)
//   subagent     grok-4.6                   grok-4.6                  grok-4.7
//   reviewer     the EXACT model the dispatcher of that unit ran on (pinned); it escalates only inside OpenAI
//
// The medium dispatcher is gpt-6.1-sol (owner correction, same day); every other OpenAI medium seat stays gpt-6-sol.
//
// GEMINI GOES THROUGH ANTIGRAVITY FIRST. An implementer seat is an Antigravity lane (lanes.json, transport agy-cli);
// its failover ladder is more lanes, in the order below. The metered Gemini API id of a lane's base model is never a
// rung: it is the QUOTA failover of that lane, used only when the lane attempt is refused for quota (HTTP 429 / quota
// exhausted, as packages/model-client classifyFailure classifies it). Any other lane failure does not reach it.
//
// A REJECTION raises the lane's thinking level first (same base model, the next level `agy models` offers), and only
// then steps to the next rung of the ladder: hydrogen-medium -> hydrogen-high -> hydrogen-xhigh -> next rung;
// carbon-high has no level above it -> next rung.
//
// The difficulty is the ticket's label RAISED by the task profile's floors (stakes; ambiguity for the planner): a
// floor can move a pick up a column, never down (frontier.mjs fitLevel).
import { MODELS, LANES, modelId } from "../config/models.mjs";

export const FIT_MATRIX_SCHEMA = "pantheon.fit-matrix/v1";
export const FIT_DIFFICULTIES = Object.freeze(["easy", "medium", "hard"]);
export const THINKING_LEVELS = Object.freeze(["low", "medium", "high", "xhigh"]);
const AGY = "agy_google";

const api = (vendor, name) => Object.freeze({ vendor: vendor === "google" ? AGY : vendor, model: modelId(vendor, name) });
/** A live Antigravity lane by its exact `agy models` id. Throws for a name lanes.json does not declare, or a retired one. */
function lane(model) {
  const l = LANES.agy_cli?.[model];
  if (!l || l.retired || l.transport !== "agy-cli") throw new Error(`fit matrix: "${model}" is not a live Antigravity lane (config/lanes.json)`);
  return Object.freeze({ vendor: l.vendor, model });
}
// The planner's medium seat: the newer Opus point release where the catalog declares it, else claude-opus-5.
const OPUS = MODELS.anthropic["opus-5-5"] ? api("anthropic", "opus-5-5") : api("anthropic", "opus");

const freeze = table => Object.freeze(Object.fromEntries(Object.entries(table).map(([k, v]) => [k, Object.freeze(v)])));
export const FIT_MATRIX = freeze({
  planner: { easy: api("anthropic", "sonnet"), medium: OPUS, hard: api("anthropic", "fable") },
  dispatcher: { easy: api("openai", "luna"), medium: api("openai", "sol-6.1"), hard: api("openai", "astra") },
  implementer: { easy: lane("gemini-4-hydrogen-medium"), medium: lane("gemini-4-hydrogen-high"), hard: lane("gemini-4-carbon-high") },
  subagent: { easy: api("xai", "grok-4.6"), medium: api("xai", "grok-4.6"), hard: api("xai", "grok-4.7") },
});
/** The implementer's failover ladder per difficulty: Antigravity lanes only, the matrix pick first. */
export const IMPLEMENTER_LADDERS = freeze({
  easy: [lane("gemini-4-hydrogen-medium"), lane("gemini-3.8-flash-high")],
  medium: [lane("gemini-4-hydrogen-high"), lane("gemini-4-argon-high")],
  hard: [lane("gemini-4-carbon-high"), lane("gemini-4-hydrogen-xhigh"), lane("gemini-4-argon-high")],
});
/** The stage-5 reviewer's only escalation path: inside OpenAI, each tier the dispatcher's own model. */
export const REVIEWER_ESCALATION = Object.freeze(FIT_DIFFICULTIES.map(d => FIT_MATRIX.dispatcher[d]));
export const FIT_ROLES = Object.freeze([...Object.keys(FIT_MATRIX), "reviewer"]);

const level = difficulty => {
  if (!FIT_DIFFICULTIES.includes(difficulty)) throw new Error(`fit matrix: unknown difficulty "${difficulty}" (known: ${FIT_DIFFICULTIES.join(", ")})`);
  return difficulty;
};
const same = (a, b) => Boolean(a && b) && a.vendor === b.vendor && a.model === b.model;

/**
 * The reviewer for a unit: the EXACT seat its dispatcher ran on, pinned. Only a matrix dispatcher seat can be pinned;
 * anything else throws (a reviewer is never quietly moved to another model or lab).
 */
export function pinnedReviewer(dispatcherSeat) {
  const hit = REVIEWER_ESCALATION.find(s => same(s, dispatcherSeat));
  if (!hit) throw new Error(`fit matrix: the reviewer is pinned to the unit's dispatcher, and ${dispatcherSeat?.vendor ?? "?"}/${dispatcherSeat?.model ?? "?"} is not a dispatcher seat (${REVIEWER_ESCALATION.map(s => s.model).join(", ")})`);
  return { vendor: hit.vendor, model: hit.model, pinned: true, pinned_to: "dispatcher" };
}
/** The next reviewer seat after `seat`, inside OpenAI only (luna -> 6.1-sol -> astra), or null at the top. Throws off the path. */
export function reviewerEscalation(seat) {
  const i = REVIEWER_ESCALATION.findIndex(s => same(s, seat));
  if (i === -1) throw new Error(`fit matrix: ${seat?.vendor ?? "?"}/${seat?.model ?? "?"} is not on the reviewer's OpenAI escalation path`);
  const next = REVIEWER_ESCALATION[i + 1];
  return next ? { vendor: next.vendor, model: next.model, pinned: true, pinned_to: "dispatcher" } : null;
}

/** The seat `fit` starts a role on at a difficulty. `reviewer` is the pinned dispatcher seat of the same difficulty. */
export function fitMatrix(role, difficulty) {
  const d = level(difficulty);
  if (role === "reviewer") return pinnedReviewer(FIT_MATRIX.dispatcher[d]);
  const row = FIT_MATRIX[role];
  if (!row) throw new Error(`fit matrix: no row for role "${role}" (known: ${FIT_ROLES.join(", ")})`);
  return { ...row[d] };
}
/** The ordered seats of a role at a difficulty: the implementer's lane ladder; every other role, its one pick. */
export function fitLadder(role, difficulty) {
  const d = level(difficulty);
  return role === "implementer" ? IMPLEMENTER_LADDERS[d].map(s => ({ ...s })) : [fitMatrix(role, d)];
}

// ---------------------------------------------------------------- Antigravity lanes and their metered API ids
/** {base, thinking} of a live Antigravity lane name, or null for anything else. */
export function laneParts(model) {
  const l = LANES.agy_cli?.[model];
  return l && !l.retired && l.base && l.thinking ? { base: l.base, thinking: l.thinking } : null;
}
/** The thinking levels Antigravity offers for a base model, lowest first. */
export function laneLevels(base) {
  const have = Object.values(LANES.agy_cli ?? {}).filter(l => !l.retired && l.base === base).map(l => l.thinking);
  return THINKING_LEVELS.filter(t => have.includes(t));
}
/**
 * The Antigravity lane for a base Gemini model at an effort: the level asked for, else the highest offered level at
 * or below it, else (nothing at or below) the lowest offered. No effort means `high`. Null when the base has no lane.
 */
export function laneFor(base, effort = null) {
  const levels = laneLevels(base);
  if (!levels.length) return null;
  const want = THINKING_LEVELS.indexOf(effort ?? "high");
  const at = want === -1 ? THINKING_LEVELS.indexOf("high") : want;
  const pick = [...levels].reverse().find(t => THINKING_LEVELS.indexOf(t) <= at) ?? levels[0];
  return lane(`${base}-${pick}`);
}
/** The metered Gemini API seat of a lane's base model (its quota failover), or null when the registry has no id for it. */
export function quotaFailoverFor(laneModel) {
  const p = laneParts(laneModel);
  if (!p || !Object.values(MODELS.google ?? {}).includes(p.base)) return null;
  return { vendor: AGY, model: p.base, effort: p.thinking };
}

/**
 * The implementer's next seat after a REJECTION, on `ladder` (lane model names, in order): the same base model's next
 * thinking level first; at its top, the next rung (the first later entry of another base). Null when the ladder is
 * spent or the seat is not a lane. Pure: the record of a decision carries the ladder it was decided on.
 */
export function implementerEscalation(seat, ladder) {
  const here = laneParts(seat?.model);
  if (!here || !Array.isArray(ladder)) return null;
  const levels = laneLevels(here.base), i = levels.indexOf(here.thinking);
  if (i !== -1 && i + 1 < levels.length) return { action: "raise_thinking", vendor: AGY, model: `${here.base}-${levels[i + 1]}`, from: here.thinking, to: levels[i + 1] };
  const at = ladder.findIndex(m => laneParts(m)?.base === here.base);
  const next = ladder.slice(at + 1).find(m => { const p = laneParts(m); return p && p.base !== here.base; });
  return next ? { action: "step_rung", vendor: AGY, model: next } : null;
}

/** The matrix as data: what selectionPolicy('fit') hashes. */
export const FIT_MATRIX_BODY = Object.freeze({ schema: FIT_MATRIX_SCHEMA,
  matrix: Object.fromEntries(Object.entries(FIT_MATRIX).map(([r, row]) => [r, Object.fromEntries(FIT_DIFFICULTIES.map(d => [d, `${row[d].vendor}/${row[d].model}`]))])),
  implementer_ladders: Object.fromEntries(FIT_DIFFICULTIES.map(d => [d, IMPLEMENTER_LADDERS[d].map(s => s.model)])),
  reviewer: { pinned_to: "dispatcher", escalation: REVIEWER_ESCALATION.map(s => `${s.vendor}/${s.model}`) },
  rejection: "raise the lane's thinking level, then the next ladder rung",
  google: "Antigravity lane first; the metered Gemini API id of the lane's base model only as its 429/quota failover" });
