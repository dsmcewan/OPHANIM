// THE FIT ROUTING MATRIX (owner direction 2026-11-17; the Google implementer row and its subagents, owner direction
// 2026-11-19). One table: role x difficulty -> the seat `fit` starts on. Pure data and pure functions; nothing here
// calls a provider or reads a ticket.
//
//   role         easy                       medium                    hard
//   planner      Anthropic's sonnet         opus (newest declared)    the top Anthropic seat   (ids: FIT_MATRIX below)
//   dispatcher   gpt-6-luna                 gpt-6.1-sol               gpt-6-astra
//   implementer  gemini-4-hydrogen          gemini-4-neon             gemini-4-carbon          (the Antigravity SDK)
//   subagent     gemini-4-hydrogen          gemini-4-hydrogen         gemini-4-hydrogen        (the implementer's own)
//   reviewer     the EXACT model the dispatcher of that unit ran on (pinned); it escalates only inside OpenAI
//
// The medium dispatcher is gpt-6.1-sol (owner correction, same day); every other OpenAI medium seat stays gpt-6-sol.
//
// THE GOOGLE IMPLEMENTER RUNS ON THE ANTIGRAVITY SDK (owner direction 2026-11-19; config/antigravity-sdk.json): the
// official google-antigravity SDK on the Gemini API with GEMINI_API_KEY. An implementer seat is {vendor: "agy_google",
// model: <a Gemini API model id>, transport: "antigravity-sdk", effort: <thinking level | null>}. It is not an
// Antigravity lane, it is not re-routed to one ("Gemini goes through Antigravity first" is the rule of the OTHER roles'
// Gemini seats, frontier.mjs antigravityFirst), and it has no metered-API failover: the transport is the Gemini API.
// These assignments are Google IMPLEMENTATION routing only: the planner, the dispatcher and the pinned reviewer rows
// are as they were.
//
// ITS SUBAGENTS are the SDK's own, on gemini-4-hydrogen, admitted by the controller within the implementer model's
// ceiling (antigravity/subagents.mjs: Carbon 8, Neon 4, Hydrogen none). The `subagent` row says so; no other lab's
// model is spent on Google implementation delegation.
//
// A REJECTION raises the thinking level on the same model first (the levels config/antigravity-sdk.json records for
// it), and only then steps to the next rung of the ladder: hydrogen@medium -> @high -> @xhigh -> the next model;
// carbon@high is at its top; neon has no recorded level. implementerPath(difficulty) is that whole path.
//
// THE EARLIER LANES. laneParts, laneLevels, laneFor, quotaFailoverFor and implementerEscalation describe the
// Antigravity CLI lanes (config/lanes.json). They still serve the other roles' Gemini seats and the escalations
// recorded on a lane ladder, which are re-derived from their own record (protocol.mjs verifyEscalation).
//
// The difficulty is the ticket's label RAISED by the task profile's floors (stakes; ambiguity for the planner): a
// floor can move a pick up a column, never down (frontier.mjs fitLevel).
import { MODELS, LANES, modelId } from "../config/models.mjs";
import { SDK_CONFIG, SDK_TRANSPORT, SDK_VENDOR, SDK_DIFFICULTIES, thinkingLevelsOf } from "../antigravity/config.mjs";

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

/** An implementer seat of the Antigravity SDK transport, from config/antigravity-sdk.json: {vendor, model, transport, effort}. */
function sdkSeat({ model, effort = null }) {
  if (!Object.hasOwn(SDK_CONFIG.models, model)) throw new Error(`fit matrix: "${model}" is not a model config/antigravity-sdk.json declares`);
  if (effort !== null && !thinkingLevelsOf(model).includes(effort)) throw new Error(`fit matrix: "${effort}" is not a thinking level recorded for ${model}`);
  return Object.freeze({ vendor: SDK_VENDOR, model, transport: SDK_TRANSPORT, effort });
}
/** The seat of an SDK implementer's own subagents: the pinned subagent model on the same transport. Never asked as a seat of its own. */
const NATIVE_SUBAGENT = Object.freeze({ vendor: SDK_VENDOR, model: SDK_CONFIG.subagents.model, transport: SDK_TRANSPORT, native: true });

const freeze = table => Object.freeze(Object.fromEntries(Object.entries(table).map(([k, v]) => [k, Object.freeze(v)])));
export const FIT_MATRIX = freeze({
  planner: { easy: api("anthropic", "sonnet"), medium: OPUS, hard: api("anthropic", "fable") },
  dispatcher: { easy: api("openai", "luna"), medium: api("openai", "sol-6.1"), hard: api("openai", "astra") },
  implementer: Object.fromEntries(SDK_DIFFICULTIES.map(d => [d, sdkSeat(SDK_CONFIG.implementer[d])])),
  subagent: Object.fromEntries(SDK_DIFFICULTIES.map(d => [d, NATIVE_SUBAGENT])),
});
/** The implementer's ladder per difficulty: SDK seats, the matrix pick first (config/antigravity-sdk.json ladders). */
export const IMPLEMENTER_LADDERS = freeze(Object.fromEntries(SDK_DIFFICULTIES.map(d => [d, SDK_CONFIG.ladders[d].map(sdkSeat)])));
for (const d of SDK_DIFFICULTIES) if (IMPLEMENTER_LADDERS[d][0].model !== FIT_MATRIX.implementer[d].model || IMPLEMENTER_LADDERS[d][0].effort !== FIT_MATRIX.implementer[d].effort) throw new Error(`fit matrix: the ${d} ladder does not start on the ${d} implementer (config/antigravity-sdk.json)`);
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
/** The ordered seats of a role at a difficulty: the implementer's ladder; every other role, its one pick. */
export function fitLadder(role, difficulty) {
  const d = level(difficulty);
  return role === "implementer" ? IMPLEMENTER_LADDERS[d].map(s => ({ ...s })) : [fitMatrix(role, d)];
}

/**
 * The whole path an implementer walks at a difficulty: each ladder rung, then the HIGHER thinking levels recorded for
 * its model (config/antigravity-sdk.json), before the next rung. A rejection steps one entry (pipeline/review.mjs
 * escalate); a quota refusal or an unavailable model skips the model's remaining entries (pipeline/index.mjs).
 */
export function implementerPath(difficulty) {
  const out = [];
  for (const r of IMPLEMENTER_LADDERS[level(difficulty)]) {
    const levels = thinkingLevelsOf(r.model), at = levels.indexOf(r.effort);
    for (const effort of at === -1 ? [r.effort] : levels.slice(at)) if (!out.some(s => s.model === r.model && s.effort === effort)) out.push({ ...r, effort });
  }
  return out;
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
 * (LANES; the SDK implementer's path is implementerPath above.)
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
const ladderName = s => (s.effort ? `${s.model}@${s.effort}` : s.model);
export const FIT_MATRIX_BODY = Object.freeze({ schema: FIT_MATRIX_SCHEMA,
  matrix: Object.fromEntries(Object.entries(FIT_MATRIX).map(([r, row]) => [r, Object.fromEntries(FIT_DIFFICULTIES.map(d => [d, `${row[d].vendor}/${row[d].model}`]))])),
  implementer: { transport: SDK_TRANSPORT, sdk: { distribution: SDK_CONFIG.sdk.distribution, version: SDK_CONFIG.sdk.version }, effort: Object.fromEntries(FIT_DIFFICULTIES.map(d => [d, FIT_MATRIX.implementer[d].effort])) },
  implementer_ladders: Object.fromEntries(FIT_DIFFICULTIES.map(d => [d, IMPLEMENTER_LADDERS[d].map(ladderName)])),
  subagents: { model: SDK_CONFIG.subagents.model, ceilings: { ...SDK_CONFIG.subagents.ceilings }, default_ceiling: SDK_CONFIG.subagents.default_ceiling, max_depth: SDK_CONFIG.subagents.max_depth },
  reviewer: { pinned_to: "dispatcher", escalation: REVIEWER_ESCALATION.map(s => `${s.vendor}/${s.model}`) },
  rejection: "raise the thinking level on the same model, then the next ladder rung",
  google: "implementation: the google-antigravity SDK on the Gemini API (GEMINI_API_KEY), no Antigravity CLI lane and no metered-API failover; every other role's Gemini seat: its Antigravity lane, the metered Gemini API id of the lane's base model only as its 429/quota failover" });
