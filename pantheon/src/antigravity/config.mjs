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

// PRIMARY GEMINI API EXECUTION (owner decision 2026-11-19, register L-136): "its own setting, gemini_api_primary, default
// off, independent of the failover switch. Without it every primary Gemini API or SDK seat is refused at the point of
// spend." A session of this transport is such a seat: it is billed to the Gemini API key from its first request. The
// seat's refusal is made where the seat is (pipeline/turns.mjs), before the transport is entered, and the presence of
// the key never stands for the setting.
export const GEMINI_API_PRIMARY_DISABLED = "GEMINI_API_PRIMARY_DISABLED";
/** The refusal of a primary Gemini API seat of this transport while the setting is off: nothing was sent or charged. */
export function primaryGeminiRefusal({ vendor, model, purpose = null }) {
  return Object.assign(new Error(`${vendor}/${model}${purpose ? ` (${purpose})` : ""} is a primary Gemini API seat (the Antigravity SDK transport), and primary Gemini API execution is not enabled for this run (gemini_api_primary, default off): the seat is refused before it is admitted, charged or called`),
    { code: GEMINI_API_PRIMARY_DISABLED, provider_requests: 0, transport: SDK_TRANSPORT });
}

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
