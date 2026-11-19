// SECRET REDACTION shared by the agy worker records (board/agy-cli.mjs) and the PreToolUse jail hook (jail-hook.mjs).
// A small module with no imports beyond node:fs/node:path, so the hook (spawned once per tool call) stays cheap.
//
//   SECRETISH           an env variable name whose value a record never carries (the A2A token, any key or secret)
//   redactSecrets       every value (8+ chars) of a SECRETISH env variable -> <redacted:NAME>
//   redactKnown         exact known secret values -> <redacted>, then `Bearer <x>` and `token: <x>`-shaped pairs
//                       (no long-run heuristic: paths and code in hook payloads and tool steps stay readable)
//   redactStrong        redactSecrets + the patterns + every 24+ run of token characters (for CLI output)
//   redactDeep          redactKnown over every string of a JSON value (objects and arrays rebuilt, keys kept)
//   controlDirSecrets   the SECRETISH env values of <control_dir>/.agents/mcp_config.json (the A2A bearer token)
//
// Independent review round 2, assignment 4 (OpenAI gpt-6-astra, 77480d6), question 7: hook logs kept raw payloads,
// worker records kept raw stderr tails and tool info, and final JSON summaries were returned unredacted.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);

/** Redact every value of a secret-looking env variable (8+ chars) from `text`. */
export function redactSecrets(text, env = {}) {
  let out = String(text ?? "");
  for (const [k, v] of Object.entries(env ?? {})) if (SECRETISH.test(k) && typeof v === "string" && v.length >= 8) out = out.split(v).join(`<redacted:${k}>`);
  return out;
}

const PAIR = /(?<![A-Za-z0-9_-])(authorization|api[_-]?key|token|secret|password)(\s*[:=]\s*)(?!<redacted)[^\s"',;]+/gi;
/** The secret values of `env` (SECRETISH names, 8+ chars) plus `extra`, longest first, de-duplicated. */
export function secretValues(env = {}, extra = []) {
  const vals = [...Object.entries(env ?? {}).filter(([k, v]) => SECRETISH.test(k) && typeof v === "string").map(([, v]) => v), ...extra];
  return [...new Set(vals.filter(v => typeof v === "string" && v.length >= 8))].sort((a, b) => b.length - a.length);
}
/** Only the exact known secrets (8+ chars) -> <redacted> (for a model's own answer text: no pattern guessing). */
export function redactExact(text, secrets = []) {
  let out = String(text ?? "");
  for (const s of secrets) if (typeof s === "string" && s.length >= 8) out = out.split(s).join("<redacted>");
  return out;
}
/** Exact known secrets, then `Bearer <x>` and `<authorization|api_key|token|secret|password>: <x>` pairs. */
export function redactKnown(text, secrets = []) {
  const out = redactExact(text, secrets).replace(/\bBearer\s+(?!<redacted)[^\s"',;]+/gi, "Bearer <redacted>");
  return out.replace(PAIR, "$1$2<redacted>");
}
/** redactKnown (or, with {exact: true}, redactExact) over every string of a JSON-able value. */
export function redactDeep(v, secrets = [], { exact = false } = {}) {
  if (typeof v === "string") return exact ? redactExact(v, secrets) : redactKnown(v, secrets);
  if (Array.isArray(v)) return v.map(x => redactDeep(x, secrets, { exact }));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, secrets, { exact })]));
  return v;
}

const LONG_RUN = /[A-Za-z0-9_\-.=+/]{24,}/g;
/**
 * STRONG redaction for any CLI output a record keeps: the env-derived secrets (redactSecrets), `Bearer <x>`,
 * `authorization|api_key|token|secret|password <: or => <x>`, `--header <x>`, and every run of 24+ characters of
 * [A-Za-z0-9_-.=+/]. ONE NARROWING (a choice, so the EROFS and GeminiDir diagnostics keep their paths): a run that
 * starts with "/" is an absolute path; in it only 24+ runs of [A-Za-z0-9+=] (no separator: a token, not a file name)
 * are redacted.
 */
export function redactStrong(text, env = {}) {
  let out = redactSecrets(text, env);
  out = out.replace(/\bBearer\s+\S+/gi, "Bearer <redacted>");
  out = out.replace(/(?<![A-Za-z0-9_-])(authorization|api[_-]?key|token|secret|password)(\s*[:=]\s*)(?!<redacted)\S+/gi, "$1$2<redacted>");
  out = out.replace(/--header(\s+|=)\S+/g, "--header$1<redacted>");
  out = out.replace(LONG_RUN, run => (run.startsWith("/") ? run.replace(/[A-Za-z0-9+=]{24,}/g, "<redacted>") : "<redacted>"));
  return out;
}

/** The SECRETISH env values of the control dir's MCP configuration (the A2A bearer token); [] when unreadable. */
export function controlDirSecrets(control_dir) {
  if (typeof control_dir !== "string" || !control_dir) return [];
  try {
    const servers = JSON.parse(readFileSync(join(control_dir, ".agents", "mcp_config.json"), "utf8"))?.mcpServers ?? {};
    return secretValues({}, Object.values(servers).flatMap(s => Object.entries(isObj(s?.env) ? s.env : {}).filter(([k, v]) => SECRETISH.test(k) && typeof v === "string").map(([, v]) => v)));
  } catch { return []; }
}
