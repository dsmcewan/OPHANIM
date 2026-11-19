// UNIT CHECKPOINTS: an approved unit's result, kept across pipeline runs of the same item, so a re-run resumes
// instead of paying for work that was already approved.
//
// THE UNIT KEY (stable before dispatch, so it can be looked up before any provider is asked):
//   unit_key = "sha256:" + hex sha256 of canonical JSON (packages/ledger/canonical.mjs) of
//     {schema: "pantheon.unit-key/v1", unit: <the VALIDATED unit definition, every key of UNIT_KEYS, as planned>,
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
//    verify: {cmd, exit_code, digest}, review_digest (digest of the Stage 5 review record that approved it), recorded_at}
//   and the patch beside it at <hex>.patch. Both are written atomically (temp file + rename), patch first.
//
// A checkpoint is EVIDENCE TO RE-CHECK, never a verdict to trust: checkpointRefusal() refuses one whose schema,
// key, unit, base, verdict or upstream (unit set, keys and trees) differ from the current run, and whose patch bytes
// do not hash to patch_digest; the controller (index.mjs) then applies the patch on the unit's freshly bound base
// and refuses it unless the result is exactly the recorded tree AND the unit's verify_cmd, re-run there, passes: a
// patch, digest and tree rewritten to agree with each other still have to pass the unit's own ground truth
// (independent review, assignment 3, question 7). The approval is bound by the rubric hash and the review record's
// digest; a checkpoint without them (written before they were bound) is not resumed: the unit runs again.
//
// Must never: accept a checkpoint whose upstream trees differ from this run's; accept patch bytes that do not hash
// to the recorded digest; leave a half-written checkpoint where a reader would find it.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { digestOf, isObject, sha256, str } from "./util.mjs";
import { UNIT_KEYS } from "./work-units.mjs";

export const CHECKPOINT_SCHEMA = "pantheon.unit-checkpoint/v1";
export const UNIT_KEY_SCHEMA = "pantheon.unit-key/v1";
const hexOf = key => String(key).replace(/^sha256:/, "");

/** The unit key: see the header. `upstream_keys` are the transitive upstream units' keys (sorted here by unit_id). */
export function unitKey({ unit, base_commit, upstream = [] }) {
  const def = Object.fromEntries(UNIT_KEYS.map(k => [k, unit[k]]));
  const up = [...upstream].sort((a, b) => (a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0)).map(u => ({ unit_id: u.unit_id, unit_key: u.unit_key }));
  return digestOf({ schema: UNIT_KEY_SCHEMA, unit: def, base_commit, upstream: up });
}

export const checkpointFile = (dir, unit_key) => join(dir, `${hexOf(unit_key)}.json`);
export const patchFileName = unit_key => `${hexOf(unit_key)}.patch`;

async function atomicWrite(file, data) {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** Write a checkpoint record and its patch. Returns the record as written. */
export async function writeCheckpoint({ dir, record, patch }) {
  await mkdir(dir, { recursive: true });
  const patch_path = patchFileName(record.unit_key);
  const full = { schema: CHECKPOINT_SCHEMA, ...record, verdict: "approve", patch_path, patch_digest: sha256(patch), recorded_at: record.recorded_at ?? new Date().toISOString() };
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
  if (expect.verify_cmd !== undefined && record.verify.cmd !== expect.verify_cmd) return "the checkpoint's verify command is not the unit's";
  if (typeof patch !== "string") return "the checkpoint's patch is missing";
  if (sha256(patch) !== record.patch_digest) return `the checkpoint's patch hashes to ${sha256(patch)}, not the recorded ${record.patch_digest}`;
  const norm = list => (Array.isArray(list) ? list : []).map(u => `${u?.unit_id}\u0000${u?.unit_key}\u0000${u?.tree}`).sort();
  const got = norm(record.upstream), want = norm(expect.upstream);
  if (!Array.isArray(record.upstream) || got.length !== want.length || got.some((x, i) => x !== want[i])) return "the checkpoint's upstream units or their trees differ from this run's";
  return null;
}
