// OWNED-PATH PATTERNS: the one grammar for a work unit's `owned_paths`, used by the plan validator, the lock check
// and the write jail.
//
// Grammar: a repo-relative path of `/`-separated segments. A segment is literal, or contains `*` (any run of
// characters inside one segment) or `?` (one character); the whole segment `**` matches zero or more segments.
// Nothing else is a wildcard: brackets, braces, `!` and backslashes are refused, so the matcher is exact.
//
// Inputs/outputs: strings in, booleans or refusal strings out. Pure; reads nothing.
//
// Must never: answer "disjoint" when unsure (pathsOverlap is conservative: a pattern that is a path prefix of the
// other overlaps it, because it may name a directory, and two that differ only in case overlap, because a
// case-insensitive filesystem makes them one path); let a pattern reach outside the repository or into `.git`.

const GLOB = /[*?]/;
const reEscape = s => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
const segRe = seg => new RegExp("^" + seg.split("").map(c => c === "*" ? "[^/]*" : c === "?" ? "[^/]" : reEscape(c)).join("") + "$");

/** Why `p` is not an owned-path pattern, or null. */
export function pathRefusal(p) {
  if (typeof p !== "string" || p.trim() === "") return "an owned path is a non-empty string";
  if (p !== p.trim()) return `"${p}" has leading or trailing space`;
  if (p.startsWith("/")) return `"${p}" has a leading "/": owned paths are repo-relative`;
  if (/^[A-Za-z]:/.test(p) || p.startsWith("~")) return `"${p}" is absolute: owned paths are repo-relative`;
  if (/[\\[\]{}!\0\n\r]/.test(p)) return `"${p}" uses a character outside the pattern grammar (only * ? and ** are wildcards)`;
  const segs = p.split("/");
  if (segs.includes("..")) return `"${p}" contains "..": an owned path may not leave the repository`;
  if (segs.some(s => s === "" || s === ".")) return `"${p}" has an empty or "." segment`;
  if (segs.some(s => s.includes("**") && s !== "**")) return `"${p}": "**" must be a whole segment`;
  if (segs[0].toLowerCase() === ".git") return `"${p}" is inside .git`;
  return null;
}

function match(pat, segs) {
  if (!pat.length) return !segs.length;
  if (pat[0] === "**") return match(pat.slice(1), segs) || (segs.length > 0 && match(pat, segs.slice(1)));
  return segs.length > 0 && segRe(pat[0]).test(segs[0]) && match(pat.slice(1), segs.slice(1));
}
/** Does the concrete repo-relative `path` match one of `patterns`? Exact: a literal pattern owns that one path. */
export function matchesOwned(path, patterns) {
  const segs = String(path).split("/");
  if (segs.some(s => s === "" || s === "." || s === "..")) return false;
  return patterns.some(p => match(p.split("/"), segs));
}

function segOverlap(a, b) {
  const ga = GLOB.test(a), gb = GLOB.test(b);
  if (!ga && !gb) return a === b;
  if (!ga) return segRe(b).test(a);
  if (!gb) return segRe(a).test(b);
  // Two wildcard segments: disjoint only when their literal heads or tails cannot both hold. Otherwise: overlap.
  const head = s => s.slice(0, s.search(GLOB)), tail = s => s.slice(Math.max(s.lastIndexOf("*"), s.lastIndexOf("?")) + 1);
  const ha = head(a), hb = head(b), ta = tail(a), tb = tail(b);
  return (ha.startsWith(hb) || hb.startsWith(ha)) && (ta.endsWith(tb) || tb.endsWith(ta));
}
function overlap(a, b) {
  if (!a.length || !b.length) return true;   // equal, or one is a path prefix of the other and may be a directory
  if (a[0] === "**") return overlap(a.slice(1), b) || overlap(a, b.slice(1));
  if (b[0] === "**") return overlap(a, b.slice(1)) || overlap(a.slice(1), b);
  return segOverlap(a[0], b[0]) && overlap(a.slice(1), b.slice(1));
}
/**
 * patternsOverlap without the grammar check on `b`: used against the RESERVED names (work-units.mjs), one of which
 * (`.git`) is itself refused as an owned path. `a` must be a valid pattern (else: true).
 */
export function overlapsReserved(a, reserved) {
  if (pathRefusal(a)) return true;
  return overlap(fold(a).split("/"), fold(reserved).split("/"));
}
// CASE-FOLDED. Two paths that differ only in case are one file on a case-insensitive filesystem (macOS by default,
// Windows), so they overlap: `src/Foo.mjs` and `src/foo.mjs` were put in one wave and collided at the merge
// (independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 3.1). Folding only ever
// adds overlaps, never removes one, so the answer stays conservative on a case-sensitive filesystem.
const fold = p => p.normalize("NFC").toLowerCase();
/** Could two owned-path patterns name a common path (or one contain the other)? Conservative: unsure means true. */
export function pathsOverlap(a, b) {
  if (pathRefusal(a) || pathRefusal(b)) return true;
  return overlap(fold(a).split("/"), fold(b).split("/"));
}
