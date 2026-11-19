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
