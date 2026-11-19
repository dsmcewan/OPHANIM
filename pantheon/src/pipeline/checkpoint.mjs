// UNIT CHECKPOINTS: an approved unit's result, kept across pipeline runs of the same item, so a re-run resumes
// instead of paying for work that was already approved.
//
// THE UNIT KEY (stable before dispatch, so it can be looked up before any provider is asked):
//   unit_key = "sha256:" + hex sha256 of canonical JSON (packages/ledger/canonical.mjs) of
//     {schema: "pantheon.unit-key/v2", unit: <the VALIDATED unit definition, every key of UNIT_KEYS, as planned>,
//      base_commit: <the run's resolved base commit>, upstream: [<unit_key of each TRANSITIVE upstream unit, in
//      unit_id order>]}
//   It holds the inputs of the frozen rubric hash (unit_id, owned_paths, verify_cmd, invariants) but not the
//   model-written rubric text, which only exists after dispatch. A changed unit, base or upstream definition
//   changes the key; nothing else does.
//
// THE FILE: <checkpoints.dir>/<hex of unit_key>.json, schema pantheon.unit-checkpoint/v1:
//   {schema, unit_key, unit_id, verdict: "approve", rubric_hash, base_commit (the run's base), unit_base_commit (the
//    unit's worktree base: base + upstream patches), upstream: [{unit_id, unit_key, tree}], commit, tree,
//    patch_path (relative to checkpoints.dir), patch_digest, reviewer: {vendor, model, served_model},
//    verify: {cmd, exit_code, digest}, review_digest (digest of the Stage 5 review record that approved it),
//    contributions: [{kind: work | subtask | critique, role, vendor, model, served_model, served_model_source?}],
//    recorded_at}
//   and the patch beside it at <hex>.patch. Both are written atomically (temp file + rename), patch first.
//   `contributions` is the unit's AUTHORING LINEAGE as record.mjs contributionsOf projects it: every implementer whose
//   writes reached the worktree, every subagent whose answer reached the implementer, and every Stage 5 reviewer whose
//   finding was fed to a revision. A resumed unit restores it, so the models that shaped the reused patch stay
//   contributors for the later three-lab review and the validator (independent review, assignment 2, questions 6 and 8).
//   A v1 checkpoint (written before the lineage was kept) is not resumed: the unit runs again.
//
// A checkpoint is EVIDENCE TO RE-CHECK, never a verdict to trust: checkpointRefusal() refuses one whose schema,
// key, unit, base, verdict or upstream (unit set, keys and trees) differ from the current run, and whose patch bytes
// do not hash to patch_digest; the controller (index.mjs) then applies the patch on the unit's freshly bound base
// and refuses it unless the result is exactly the recorded tree AND the unit's verify_cmd, re-run there, passes: a
// patch, digest and tree rewritten to agree with each other still have to pass the unit's own ground truth
// (independent review, assignment 3, question 7). The approval is bound by the rubric hash and the review record's
// digest; a checkpoint without them (written before they were bound) is not resumed: the unit runs again.
//
// THE APPROVAL IS AUTHENTICATED, NOT ONLY SHAPED (v3; independent review, assignment 3 (OpenAI gpt-6-astra extra
// review, 09d490f), question 7: a fabricated review_digest and rubric_hash, and a reviewer that never reviewed, were
// resumed as approved with zero provider calls because both were checked for shape only). A v3 checkpoint carries
//   review    the Stage 5 review record that approved the unit, whole; review_digest is ITS digest, recomputed on resume;
//   dispatch  {vendor, model, served_model, specialist_role, difficulty, rubric, rubric_hash}: the frozen rubric;
//   seal      "hmac-sha256:<hex>" over the canonical record without `seal`, under the controller's CHECKPOINT KEY.
// approvalRefusal() refuses a checkpoint unless: the seal verifies under the key this run holds (a checkpoint written by
// anyone without the key, or edited after it was written, does not); the review re-hashes to review_digest, approved,
// with a passing verify, on the rubric hash recorded, over exactly this patch (review.diff_digest === patch_digest), by
// the reviewer recorded; and the rubric hash is RECOMPUTED from the CURRENT planned unit (unit_id, owned_paths,
// verify_cmd, invariants) and the recorded dispatch (rubric, specialist_role, difficulty). The controller (index.mjs)
// also requires the recorded dispatcher to be the seat this run would dispatch the unit to, and the reviewer to be on
// that dispatcher's reviewer ladder. THE KEY: `checkpoints.key` (the lifecycle passes one held beside its work ledger's
// controller keys), else a key file the pipeline creates (mode 0600) at <checkpoints.dir>.seal-key, OUTSIDE the
// checkpoint directory. The seal authenticates against whoever cannot read the key; a holder of the key can forge it,
// as a holder of a ledger's signing key can, and ground truth (tree + verify_cmd, re-run) still has to hold.
//
// Must never: accept a checkpoint whose upstream trees differ from this run's; accept patch bytes that do not hash
// to the recorded digest; leave a half-written checkpoint where a reader would find it; resume an approval whose seal,
// review or rubric does not re-derive.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonical } from "../../../packages/ledger/canonical.mjs";
import { digestOf, isObject, sha256, str } from "./util.mjs";
import { UNIT_KEYS } from "./work-units.mjs";

export const CHECKPOINT_SCHEMA = "pantheon.unit-checkpoint/v3";
export const CHECKPOINT_CONTRIBUTION_KINDS = Object.freeze(["work", "subtask", "critique"]);
export const UNIT_KEY_SCHEMA = "pantheon.unit-key/v2";
const hexOf = key => String(key).replace(/^sha256:/, "");

/** The unit key: see the header. `upstream_keys` are the transitive upstream units' keys (sorted here by unit_id). */
// v2 adds THE SIBLINGS: the dispatcher judges a unit's cohesion against THE OTHER UNITS OF THE PLAN (dispatch.mjs
// DISPATCHER_PROMPT shows each one's unit_id, owned_paths and depends_on), so a plan that adds or changes a sibling is a
// different input to that judgment and the unit is dispatched again (independent review round 2, assignment 3 (Google
// gemini-4-carbon, manual, 77480d6), finding 7.1). `plan` is every unit of the run; the unit itself is left out.
export const siblingsOf = (unit, plan = []) => [...plan].filter(u => u.unit_id !== unit.unit_id)
  .map(u => ({ unit_id: u.unit_id, owned_paths: [...(u.owned_paths ?? [])], depends_on: [...(u.depends_on ?? [])] }))
  .sort((a, b) => (a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0));
export function unitKey({ unit, base_commit, upstream = [], plan = [] }) {
  const def = Object.fromEntries(UNIT_KEYS.map(k => [k, unit[k]]));
  const up = [...upstream].sort((a, b) => (a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0)).map(u => ({ unit_id: u.unit_id, unit_key: u.unit_key }));
  return digestOf({ schema: UNIT_KEY_SCHEMA, unit: def, base_commit, upstream: up, siblings: siblingsOf(unit, plan) });
}

export const checkpointFile = (dir, unit_key) => join(dir, `${hexOf(unit_key)}.json`);
export const patchFileName = unit_key => `${hexOf(unit_key)}.patch`;

async function atomicWrite(file, data) {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/**
 * The checkpoint key: `key` when given (a string or Buffer of at least 32 bytes), else the key file `file` (default
 * <dir>.seal-key), created with 32 random bytes, mode 0600, on first use. A file readable by others is refused.
 */
export function checkpointKey({ dir, key = null, file = null }) {
  if (key !== null && key !== undefined) {
    const k = Buffer.isBuffer(key) ? key : Buffer.from(String(key));
    if (k.length < 32) throw Object.assign(new Error("a checkpoint key is at least 32 bytes"), { code: "CHECKPOINT_KEY" });
    return k;
  }
  const f = file ?? `${String(dir).replace(/[/\\]+$/, "")}.seal-key`;
  mkdirSync(dirname(f), { recursive: true });
  if (!existsSync(f)) { try { writeFileSync(f, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" }); } catch (e) { if (e?.code !== "EEXIST") throw e; } }
  if ((statSync(f).mode & 0o077) !== 0) throw Object.assign(new Error(`the checkpoint key ${f} is readable by others`), { code: "CHECKPOINT_KEY" });
  const k = Buffer.from(readFileSync(f, "utf8").trim());
  if (k.length < 32) throw Object.assign(new Error(`the checkpoint key ${f} is shorter than 32 bytes`), { code: "CHECKPOINT_KEY" });
  return k;
}

/** The seal of a checkpoint record (every field but `seal`) under `key`. */
export function sealOf(record, key) {
  const { seal, ...body } = record;
  return "hmac-sha256:" + createHmac("sha256", key).update(canonical(body)).digest("hex");
}

/** Write a checkpoint record and its patch, sealed under `key`. Returns the record as written. */
export async function writeCheckpoint({ dir, record, patch, key }) {
  await mkdir(dir, { recursive: true });
  const patch_path = patchFileName(record.unit_key);
  // As JSON reads it back: the seal is over exactly the bytes a reader will parse.
  const body = JSON.parse(JSON.stringify({ schema: CHECKPOINT_SCHEMA, ...record, verdict: "approve", patch_path, patch_digest: sha256(patch), recorded_at: record.recorded_at ?? new Date().toISOString() }));
  delete body.seal;
  if (!key) throw Object.assign(new Error("a checkpoint is written sealed: pass its key (checkpointKey)"), { code: "CHECKPOINT_KEY" });
  const full = { ...body, seal: sealOf(body, key) };
  await atomicWrite(join(dir, patch_path), patch);
  await atomicWrite(checkpointFile(dir, record.unit_key), JSON.stringify(full, null, 2) + "\n");
  return full;
}

/** Read the checkpoint of `unit_key`: {found: false} | {found: true, record, patch, why?} (why: it could not be read). */
export async function readCheckpoint({ dir, unit_key }) {
  let text;
  try { text = await readFile(checkpointFile(dir, unit_key), "utf8"); } catch (e) { if (e?.code === "ENOENT") return { found: false }; return { found: true, record: null, patch: null, why: `the checkpoint could not be read: ${e.message}` }; }
  let record;
  try { record = JSON.parse(text); } catch { return { found: true, record: null, patch: null, why: "the checkpoint is not JSON" }; }
  if (!isObject(record) || !str(record.patch_path) || /[/\\]|^\.\.?$/.test(record.patch_path)) return { found: true, record, patch: null, why: "the checkpoint names no patch file beside it" };
  let patch;
  try { patch = await readFile(join(dir, record.patch_path), "utf8"); } catch (e) { return { found: true, record, patch: null, why: `the checkpoint's patch could not be read: ${e.code ?? e.message}` }; }
  return { found: true, record, patch };
}

/**
 * Why a read checkpoint may not be resumed, or null. `expect` is {unit_key, unit_id, base_commit, upstream:
 * [{unit_id, unit_key, tree}]} of the CURRENT run. The tree check (apply on the bound base) is the caller's.
 */
export function checkpointRefusal({ record, patch }, expect) {
  if (!isObject(record)) return "the checkpoint is not an object";
  if (record.schema !== CHECKPOINT_SCHEMA) return `the checkpoint's schema is ${record.schema}, not ${CHECKPOINT_SCHEMA}`;
  if (record.unit_key !== expect.unit_key) return "the checkpoint is for another unit key";
  if (record.unit_id !== expect.unit_id) return `the checkpoint is for unit ${record.unit_id}`;
  if (record.verdict !== "approve") return `the checkpoint's verdict is ${record.verdict}, not approve`;
  if (record.base_commit !== expect.base_commit) return `the checkpoint was recorded on base ${record.base_commit}, not ${expect.base_commit}`;
  if (!str(record.tree) || !/^[0-9a-f]{40,64}$/.test(record.tree)) return "the checkpoint records no tree";
  if (!/^sha256:[0-9a-f]{64}$/.test(record.rubric_hash ?? "") || !/^sha256:[0-9a-f]{64}$/.test(record.review_digest ?? "")) return "the checkpoint does not bind its approval (rubric_hash and review_digest)";
  if (!isObject(record.verify) || record.verify.exit_code !== 0) return "the checkpoint records no passing verify";
  const lineage = record.contributions;
  if (!Array.isArray(lineage) || !lineage.every(c => isObject(c) && CHECKPOINT_CONTRIBUTION_KINDS.includes(c.kind) && str(c.role) && str(c.vendor) && str(c.model)
    && (c.served_model === null || str(c.served_model)))) return "the checkpoint does not record the unit's contribution lineage [{kind, role, vendor, model, served_model}]";
  if (!lineage.some(c => c.kind === "work")) return "the checkpoint records no implementer contribution: an approved patch was written by someone";
  if (expect.verify_cmd !== undefined && record.verify.cmd !== expect.verify_cmd) return "the checkpoint's verify command is not the unit's";
  if (typeof patch !== "string") return "the checkpoint's patch is missing";
  if (sha256(patch) !== record.patch_digest) return `the checkpoint's patch hashes to ${sha256(patch)}, not the recorded ${record.patch_digest}`;
  const norm = list => (Array.isArray(list) ? list : []).map(u => `${u?.unit_id}\u0000${u?.unit_key}\u0000${u?.tree}`).sort();
  const got = norm(record.upstream), want = norm(expect.upstream);
  if (!Array.isArray(record.upstream) || got.length !== want.length || got.some((x, i) => x !== want[i])) return "the checkpoint's upstream units or their trees differ from this run's";
  return null;
}

/**
 * Why the APPROVAL a checkpoint records may not be trusted, or null (see the header). `expect` is {key, unit (the
 * CURRENT planned unit), rubricHash (dispatch.mjs rubricHash)}.
 */
export function approvalRefusal({ record }, { key, unit, rubricHash, sameModel = null, max_diff_bytes = null }) {
  if (!isObject(record)) return "the checkpoint is not an object";
  let want;
  try { want = sealOf(record, key); } catch (e) { return `the checkpoint cannot be sealed for checking: ${String(e?.message ?? e).slice(0, 200)}`; }
  const got = typeof record.seal === "string" ? record.seal : "";
  if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return "the checkpoint's seal does not verify under this controller's checkpoint key: it was not written by this controller, or was changed since";
  const rv = record.review, d = record.dispatch;
  if (!isObject(rv) || !isObject(d)) return "the checkpoint does not carry the review that approved it and the dispatch it was judged against";
  if (digestOf(rv) !== record.review_digest) return "the checkpoint's review does not hash to its review_digest";
  if (rv.status !== "approved" || rv.verdict !== "approve" || rv.verify?.exit_code !== 0) return "the checkpoint's review is not an approval against a passing verify";
  if (rv.rubric_hash !== record.rubric_hash || d.rubric_hash !== record.rubric_hash) return "the checkpoint's review and dispatch were not on its rubric hash";
  if (rv.diff_digest !== record.patch_digest) return "the checkpoint's review did not review this patch (its diff digest is not the patch digest)";
  if (!isObject(record.reviewer) || rv.vendor !== record.reviewer.vendor || rv.model !== record.reviewer.model) return "the checkpoint's reviewer is not the review's";
  if (!Array.isArray(d.rubric) || !d.rubric.length) return "the checkpoint's dispatch records no rubric";
  const now = rubricHash({ unit_id: unit.unit_id, owned_paths: unit.owned_paths, verify_cmd: unit.verify_cmd, invariants: unit.invariants, rubric: d.rubric,
    specialist_role: d.specialist_role, difficulty: d.difficulty });
  if (now !== record.rubric_hash) return `the rubric hash recomputed from the current unit and the recorded rubric is ${now}, not the recorded ${record.rubric_hash}`;
  // THIS RUN'S POLICY, re-applied to the recorded judgments (independent review round 2, assignment 3 (Google
  // gemini-4-carbon, manual, 77480d6), finding 7.2): the identity rule (`sameModel`: was the judging seat served by the
  // model asked for) and the review's diff bound. A resumed approval is admitted only as a fresh one would be.
  if (typeof sameModel === "function") {
    if (str(d.served_model) && !sameModel(d.model, d.served_model)) return `the checkpoint's dispatcher was asked as ${d.model} and served by ${d.served_model}: this run's identity rule refuses it`;
    if (str(rv.served_model) && !sameModel(rv.model, rv.served_model)) return `the checkpoint's reviewer was asked as ${rv.model} and served by ${rv.served_model}: this run's identity rule refuses it`;
  }
  if (Number.isFinite(max_diff_bytes) && Number.isFinite(rv.diff_bytes) && rv.diff_bytes > max_diff_bytes) return `the checkpoint's reviewed diff is ${rv.diff_bytes} bytes, over this run's review bound of ${max_diff_bytes}`;
  // A unit that may consult subagents carries its subagent call receipts (finding 7.3): a checkpoint without them would
  // resume a unit whose required consultation is no longer on any record.
  if ((unit.allowed_subagents ?? []).length && !Array.isArray(record.a2a_calls)) return "the checkpoint does not carry the unit's subagent call receipts (written before they were kept): the unit runs again";
  return null;
}
