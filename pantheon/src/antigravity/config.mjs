// THE ANTIGRAVITY SDK TRANSPORT'S CONFIGURATION (config/antigravity-sdk.json), read once.
//
// Owner direction 2026-11-19: the Google implementation transport is the official google-antigravity Python SDK on
// the Gemini API with GEMINI_API_KEY; the implementer models by difficulty, the Hydrogen subagent model and the
// delegation ceilings are data in that file. Nothing here calls a provider or spawns a process.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SDK_CONFIG_FILE = join(HERE, "..", "config", "antigravity-sdk.json");
const deepFreeze = o => { if (o && typeof o === "object") { for (const v of Object.values(o)) deepFreeze(v); Object.freeze(o); } return o; };
export const SDK_CONFIG = deepFreeze(JSON.parse(readFileSync(SDK_CONFIG_FILE, "utf8")));

export const SDK_TRANSPORT = SDK_CONFIG.transport;          // "antigravity-sdk"
export const SDK_VENDOR = SDK_CONFIG.vendor;                // "agy_google"
export const SDK_DIFFICULTIES = Object.freeze(["easy", "medium", "hard"]);
/** The thinking levels the SDK accepts (google.antigravity ThinkingLevel), lowest first. */
export const SDK_THINKING = Object.freeze(["minimal", "low", "medium", "high", "xhigh"]);

/** Is `seat` a seat of this transport? */
export const isSdkSeat = seat => Boolean(seat) && seat.transport === SDK_TRANSPORT;
/** The models this transport declares (an implementer rung or the subagent model). */
export const sdkModels = () => Object.keys(SDK_CONFIG.models);
export const isSdkModel = model => Object.hasOwn(SDK_CONFIG.models, String(model));
/** The thinking levels recorded for `model`, lowest first ([] when none is recorded). */
export const thinkingLevelsOf = model => [...(SDK_CONFIG.models[model]?.thinking ?? [])];

// THE RESEARCH TEAM (owner direction 2026-11-20; config `research`). Scout, explorer and researcher are roles of the
// investigation, not implementation subagents and not reviewers. Each names its candidate models in preference order
// (gemini-4-carbon first); subordinate specialists are the subagent model; the hierarchy is at most RESEARCH_DEPTH_LIMIT
// levels deep, the coordinator being level 1. The limit is CODE: the configuration may lower it and cannot raise it.
export const RESEARCH_DEPTH_LIMIT = 10;
export const RESEARCH_ROLES = Object.freeze(["scout", "explorer", "researcher"]);
/** The read tools of this transport: the only tools a research session is given. */
export const SDK_READ_TOOLS = Object.freeze(["view_file", "list_directory", "search_directory", "find_file"]);
/**
 * Why `cfg` (the shape of config/antigravity-sdk.json) cannot seat a research team, or null. A function of the config it
 * is given, so each refusal can be shown by a test; applied once, below, to the shipped file.
 */
export function researchConfigRefusal(cfg) {
  const r = cfg?.research;
  if (!r || typeof r !== "object") return "config/antigravity-sdk.json declares no research block";
  if (!Number.isInteger(r.max_depth) || r.max_depth < 1 || r.max_depth > RESEARCH_DEPTH_LIMIT) return `research.max_depth is a whole number from 1 to ${RESEARCH_DEPTH_LIMIT}`;
  const names = Object.keys(r.roles ?? {});
  if (names.length !== RESEARCH_ROLES.length || RESEARCH_ROLES.some(n => !names.includes(n))) return `the research roles are exactly ${RESEARCH_ROLES.join(", ")}`;
  for (const role of RESEARCH_ROLES) {
    const list = r.roles[role]?.candidates;
    if (!Array.isArray(list) || !list.length) return `research role ${role} names no candidate`;
    for (const c of list) {
      if (!Object.hasOwn(cfg.models ?? {}, String(c?.model))) return `research role ${role}: "${c?.model}" is not a model this transport declares`;
      const levels = cfg.models[c.model]?.thinking, effort = c.effort ?? null;
      if (effort !== null && !(Array.isArray(levels) && levels.includes(effort))) return `research role ${role}: "${effort}" is not a thinking level recorded for ${c.model}`;
    }
  }
  if (r.subordinate?.model !== cfg.subagents?.model) return `the subordinate model is the subagent model (${cfg.subagents?.model}): one Hydrogen policy, not two`;
  for (const t of r.tools ?? []) if (!SDK_READ_TOOLS.includes(t)) return `research tool "${t}" is not a read tool (${SDK_READ_TOOLS.join(", ")})`;
  if (!Array.isArray(r.tools) || !r.tools.length) return "research.tools names no read tool";
  const b = r.bounds ?? {};
  for (const k of ["max_nodes", "max_requests", "node_model_calls", "node_tool_calls", "node_timeout_s", "coordinator_rounds", "finding_bytes", "min_question_chars"]) {
    if (!Number.isInteger(b[k]) || b[k] < 1) return `research.bounds.${k} is a positive whole number`;
  }
  // Level d is opened in the coordinator's round d - 1, so reaching the depth limit takes at least that many rounds.
  if (b.coordinator_rounds < r.max_depth) return `research.bounds.coordinator_rounds must allow the depth limit (${r.max_depth} levels need at least ${r.max_depth} rounds)`;
  if (!Array.isArray(r.triggers) || !r.triggers.length) return "research.triggers names no activation";
  return null;
}
{ const bad = researchConfigRefusal(SDK_CONFIG); if (bad) throw new Error(`antigravity-sdk.json: ${bad}`); }
export const RESEARCH = SDK_CONFIG.research;
export const RESEARCH_MAX_DEPTH = RESEARCH.max_depth;
export const RESEARCH_TRIGGERS = Object.freeze([...RESEARCH.triggers]);
export const RESEARCH_SPECIALTIES = Object.freeze(Object.keys(RESEARCH.specialties));

// EXACTLY THE DECLARED ARGUMENT NAMES (independent review 2026-11-19, confirmed on SDK 0.1.24). The runtime reads other
// spellings of a declared name (commandline and commandLine as CommandLine; subagents as Subagents; workspace as
// Workspace), while the SDK's pre-tool hook hands the controller the keys as the model wrote them. A controller that
// judges `CommandLine` and ignores `commandline` approves a call it never saw. The table of declared names is
// config/antigravity-sdk.json `tools` (compared with the installed runtime by the contract suite); a call that carries
// any other key, at the top level or inside a declared object or list of objects, is refused whole.
const TOOLS = SDK_CONFIG.tools;
/** The hook tool names whose arguments the controller knows (the tools it can decide). */
export const DECLARED_TOOLS = Object.freeze(Object.keys(TOOLS.declared));
/** The tools the runtime runs with no pre-tool hook: the controller neither decides nor records a call of them. */
export const UNHOOKED_TOOLS = Object.freeze([...TOOLS.unhooked]);
const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
/**
 * Why the arguments of hook tool `tool` are not exactly the names it declares, or null. A tool with no table entry
 * returns null: the decision table refuses it by name.
 */
export function undeclaredArg(tool, args) {
  const spec = Object.hasOwn(TOOLS.declared, String(tool)) ? TOOLS.declared[tool] : null;
  if (!spec || !isObject(args)) return null;
  const why = (key, inside, allowed) => `${tool} carries the argument "${key}"${inside ? ` inside ${inside}` : ""}, which the tool does not declare (${allowed.join(", ")}): the runtime also reads other spellings of a declared name, so a call is decided only on exactly the declared names`;
  const top = [...Object.keys(spec.args), ...TOOLS.common];
  for (const key of Object.keys(args)) {
    if (!top.includes(key)) return why(key, null, top);
    const nested = spec.args[key];
    if (!Array.isArray(nested)) continue;
    for (const item of Array.isArray(args[key]) ? args[key] : [args[key]]) {
      if (!isObject(item)) continue;   // a non-object where an object is declared: the tool's own decision refuses its shape
      const extra = Object.keys(item).find(k => !nested.includes(k));
      if (extra !== undefined) return why(extra, key, nested);
    }
  }
  return null;
}
