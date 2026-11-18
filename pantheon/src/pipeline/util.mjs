// PIPELINE UTILITIES: digests, strict JSON, seat checks, the stage capability table and the judging-turn admission
// loop shared by Stage 2 (dispatcher) and Stage 5 (reviewer).
//
// Inputs: plain values and INJECTED turn functions. Outputs: plain values. This file calls no provider, spawns no
// process and reads no file.
//
// Must never: repair a model answer (an answer is the whole of one JSON value or it is refused); take the model
// that was ASKED as evidence of the model that ANSWERED; admit a judging turn whose served model is unnamed or is
// not the model asked for.
import { createHash } from "node:crypto";
import { canonical } from "../../../packages/ledger/canonical.mjs";

export const PIPELINE_SCHEMA = "pantheon.pipeline/v1";
export const sha256 = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
export const digestOf = value => sha256(canonical(value));
export const str = v => typeof v === "string" && v.trim() !== "";
export const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
export const clone = v => JSON.parse(JSON.stringify(v));
export const now = () => new Date().toISOString();

/**
 * What each stage may read and write. The controller ENFORCES the write column (the implementer's by the write jail
 * in implement.mjs; every other stage is handed no working directory at all) and passes the row to the injected turn
 * as `sandbox`, so the transport can configure its own sandbox to match. A row is a statement of the cap, not a
 * request to the model.
 */
export const CAPABILITIES = Object.freeze({
  planner: Object.freeze({ read: "repository", write: "none", cwd: false }),
  dispatcher: Object.freeze({ read: "the work unit and its plan", write: "none", cwd: false }),
  implementer: Object.freeze({ read: "its own worktree", write: "owned_paths of its unit, inside its own worktree", cwd: true }),
  subagent: Object.freeze({ read: "the one message it is sent", write: "none", cwd: false }),
  reviewer: Object.freeze({ read: "the diff, the verify_cmd output and the frozen rubric the controller read from disk", write: "none", cwd: false }),
});

/** A seat is {vendor, model, ...}. Why `seat` is not one, or null. */
export const seatRefusal = seat => isObject(seat) && str(seat.vendor) && str(seat.model) ? null : "a seat is an object {vendor, model}";
export const sameSeat = (a, b) => a.vendor === b.vendor && a.model === b.model;

/** Default "did the model asked for answer?": the same name, ignoring case and a trailing -YYYYMMDD snapshot. */
export const sameModelName = (asked, served) => {
  const n = m => String(m).trim().toLowerCase().replace(/-\d{8}$/, "");
  return n(asked) === n(served);
};

/** Why `obj` has keys outside required+optional or lacks a required one, or null. Strict: unknown keys are refused. */
export function keysRefusal(obj, required, optional = []) {
  if (!isObject(obj)) return "not a JSON object";
  const unknown = Object.keys(obj).filter(k => !required.includes(k) && !optional.includes(k)).sort();
  if (unknown.length) return `unknown key(s): ${unknown.join(", ")}`;
  const missing = required.filter(k => !(k in obj));
  return missing.length ? `missing key(s): ${missing.join(", ")}` : null;
}

/** The whole text must be ONE JSON value. No fence stripping, no "first object found": {ok, value} | {ok: false, why}. */
export function strictJson(text) {
  if (typeof text !== "string") return { ok: false, why: "the answer is not text" };
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, why: `the answer is not one JSON value: ${e.message}` }; }
}

/**
 * One JUDGING turn (dispatcher or reviewer), with admission. The turn is asked at most `1 + retries` times; each ask
 * is recorded. An answer is admitted only if (in this order) the turn returned, it NAMES a served model, that model
 * is the one asked for (`sameModel`), the text is one JSON value, and `admit(value)` returns null.
 *
 * turn(args) -> {text, served_model, served_model_source?}.  Returns
 *   {admitted, value, served_model, served_model_source, code, why, attempts: [{n, status, code, why, requested_model,
 *    served_model, served_model_source, text_digest}]}
 * A turn that throws with code PROVIDER_LIMIT is not retried: the budget is gone.
 */
export async function judgingTurn({ seat, turn, args, admit, sameModel = sameModelName, retries = 1 }) {
  const attempts = [];
  let last = { code: "NOT_ASKED", why: "the turn was not asked" };
  for (let n = 1; n <= 1 + retries; n++) {
    const rec = { n, status: "not_admitted", code: null, why: null, requested_model: seat.model, served_model: null, served_model_source: null, text_digest: null };
    attempts.push(rec);
    let out;
    try { out = await turn(args); } catch (e) {
      Object.assign(rec, { status: "failed", code: e?.code === "PROVIDER_LIMIT" ? "PROVIDER_LIMIT" : "TURN_FAILED", why: String(e?.message ?? e) });
      last = rec;
      if (rec.code === "PROVIDER_LIMIT") break;
      continue;
    }
    rec.text_digest = typeof out?.text === "string" ? sha256(out.text) : null;
    rec.served_model = str(out?.served_model) ? out.served_model : null;
    rec.served_model_source = out?.served_model_source ?? null;
    const refuse = (code, why) => { Object.assign(rec, { code, why }); last = rec; };
    if (!rec.served_model) { refuse("NO_SERVED_MODEL", `the answer names no served model: ${seat.model} was asked, and that is not evidence of which model answered`); continue; }
    if (!sameModel(seat.model, rec.served_model)) { refuse("SERVED_MISMATCH", `${seat.model} was asked and ${rec.served_model} answered: a judging seat is the exact model named for it`); continue; }
    const parsed = strictJson(out.text);
    if (!parsed.ok) { refuse("NOT_JSON", parsed.why); continue; }
    const why = admit(parsed.value);
    if (why) { refuse(why.code ?? "SCHEMA", why.why ?? String(why)); continue; }
    rec.status = "admitted";
    return { admitted: true, value: parsed.value, served_model: rec.served_model, served_model_source: rec.served_model_source, code: null, why: null, attempts };
  }
  return { admitted: false, value: null, served_model: null, served_model_source: null, code: last.code, why: last.why, attempts };
}
