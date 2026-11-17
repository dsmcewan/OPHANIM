// Canonical bytes and content ids.
//
// A cid is only an identity if canonicalization is INJECTIVE: two nodes that differ in any way a
// reader can observe must not produce the same bytes. Three ways a casual canonicalizer breaks
// that, all of which turn a hash into a collision:
//
//   * dropping `undefined` values silently -- {a:1,b:undefined} and {a:1} then share a cid, so a
//     field that was deliberately cleared is indistinguishable from one never set;
//   * accepting -0, NaN and Infinity -- JSON.stringify maps two of those to `null`, so a broken
//     measurement hashes equal to an absent one;
//   * unstable key order -- the same node re-serialised in another engine gets a second cid, and
//     dedup silently stops working.
//
// So all three are refused rather than normalised, and so is everything else that is not plain JSON (a
// Date or a class instance used to hash as {} here, and a sparse array as `[,1]`). The codec is bound
// INTO the digest: a blob and an entry that happen to share bytes must not share a cid, or relabelling
// a node is free.
import { createHash } from "node:crypto";
import { canonicalCas } from "../../../packages/ledger/canonical.mjs";

export const CODECS = new Set(["blob", "entry", "tree", "commit"]);

// The implementation is the shared one (packages/ledger/canonical.mjs), in the board's key order: plain
// code-unit order (CODE_UNIT_V1) with -0 refused. Every cid already on a board was computed in that order,
// which differs from the ledger's for integer-like keys, so the board keeps it by name.
export const canonicalize = (value, path = "$") => canonicalCas(value, path);

/** Bytes that get hashed. Blobs hash their own bytes; every other node hashes canonical JSON. */
export function nodeBytes(codec, node) {
  if (!CODECS.has(codec)) throw new TypeError(`nodeBytes: unknown codec "${codec}"`);
  if (codec === "blob") {
    if (!Buffer.isBuffer(node) && typeof node !== "string") throw new TypeError("a blob is bytes or a string");
    return Buffer.isBuffer(node) ? node : Buffer.from(node, "utf8");
  }
  return Buffer.from(canonicalize(node), "utf8");
}

export function cidOf(codec, node) {
  const bytes = nodeBytes(codec, node);
  const h = createHash("sha256").update(codec).update("\n").update(bytes).digest("hex");
  return `${codec}:${h}`;
}

export const codecOf = cid => String(cid).split(":")[0];
export const isCid = cid => typeof cid === "string" && /^(blob|entry|tree|commit):[0-9a-f]{64}$/.test(cid);
/** What the UI puts next to a seat card. Long enough to be unambiguous on a board this size. */
export const shortCid = cid => (isCid(cid) ? `${codecOf(cid)}:${cid.split(":")[1].slice(0, 12)}` : String(cid));
