// ANTIGRAVITY QUOTA: recognising a quota refusal, and asking the CLI for its quota report.
//
// What the Antigravity CLI docs say (read 2026-11-18), and nothing more is relied on:
//   - `/usage` (alias `/quota`) refreshes the quota status "from the backend"; in headless mode a slash command
//     "produce[s] a text report rather than a standard event stream" (`agy -p /quota`).
//   - model groups "share a weekly limit and a five-hour limit"; release 1.5.10: "spend-cap, prepaid-balance, and
//     weekly quota errors now stop the turn right away"; a failing run "exits non-zero and writes the reason to stderr".
// NOT documented: the report's format, its field names, whether it spends tokens. The parser below is therefore
// TOLERANT and CONSERVATIVE: it recognises bucket names and a few phrasings, and it never answers `exhausted` unless a
// recognised bucket says so unambiguously. Anything it cannot read is `unknown`. The samples in
// tests/agy-quota.test.mjs are INVENTED fixtures, not observed output.
//
// Exports:
//   isQuotaFailure({status, stderr, result})  -> boolean   (any quota evidence: explicit or soft)
//   quotaEvidence({status, stderr, result})   -> {matched, explicit} | null
//   parseQuotaReport(text)                    -> {state, buckets}
//   probeQuota({cli, env, timeoutS})          -> {state, buckets, raw_digest, exit_code, ...}
//
// Must never: block the event loop (async spawn only); send a Google API key or a model to the probe; report
// `exhausted` on ambiguity.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPromise } from "../board/spawn.mjs";

// EXPLICIT: the Gemini API's own wording for a spent quota (HTTP 429 / RESOURCE_EXHAUSTED).
const EXPLICIT = /\b429\b|RESOURCE_EXHAUSTED/i;
// SOFT: words a quota refusal is likely to use, which alone do not prove the quota is spent (a probe decides).
// Builds on the earlier agy-cli.mjs pattern (quota exceeded/exhausted/limit, "exceeded your quota", rate limit).
const SOFT = /\bquotas?\b|rate[ _-]?limit(ed)?|spend[ _-]?cap|prepaid[ _-]?balance|weekly[ _-]?quota|too many requests/i;

const said = ({ status, stderr, result } = {}) => {
  const r = result ?? null;
  return [r?.status, typeof r?.error === "string" ? r.error : null, r?.error?.message, r?.error?.status, r?.error?.code, r?.message, stderr]
    .filter(v => typeof v === "string" || typeof v === "number").map(String).join("\n");
};

/** The quota evidence in what the CLI reported: {matched, explicit} or null. `status` 429 (an HTTP status) is explicit. */
export function quotaEvidence({ status = null, stderr = "", result = null } = {}) {
  if (status === 429 || status === "429") return { matched: "429", explicit: true };
  const text = said({ stderr, result });
  const e = text.match(EXPLICIT);
  if (e) return { matched: e[0], explicit: true };
  const s = text.match(SOFT);
  return s ? { matched: s[0], explicit: false } : null;
}
/** True for 429, RESOURCE_EXHAUSTED, "quota", "rate limit", "spend cap", "prepaid balance", "weekly quota" (case-insensitive). */
export const isQuotaFailure = (x = {}) => quotaEvidence(x) !== null;

// ---- the report parser ----------------------------------------------------------------------------------------------

const BUCKETS = [
  // Argon's weekly group first: a line naming Argon and a week is that bucket, not the generic weekly one.
  { name: "argon_weekly", re: /(?<![a-z])argon(?![a-z])[^\n]*(weekly|7[-_ ]?days?|7d|week)(?![a-z])|(weekly|7[-_ ]?days?|7d|week)(?![a-z])[^\n]*(?<![a-z])argon(?![a-z])/i },
  { name: "five_hour", re: /(?<![a-z0-9])(five[-_ ]?hours?|5[-_ ]?hours?|5[-_ ]?hrs?|5h)(?![a-z])/i },
  { name: "weekly", re: /(?<![a-z])(weekly|7[-_ ]?days?|7d|week)(?![a-z])/i },
];
const bucketOf = text => BUCKETS.find(b => b.re.test(text))?.name ?? null;

const NOT_EXHAUSTED = /\bnot\s+(yet\s+)?(reached|exhausted|exceeded)\b|\bno\s+limit\b/i;
const EXHAUSTED_WORDS = /\blimit\s+(reached|hit|exceeded)\b|\bexhausted\b|\bquota\s+exceeded\b|\bout\s+of\s+quota\b|\bno\s+(quota|requests?)\s+(left|remaining)\b/i;

/** One line -> the facts it states, without deciding what is missing. */
function readLine(line) {
  const facts = {};
  const left = line.match(/(\d+(?:\.\d+)?)\s*%\s*(left|remaining|available|free)\b/i) ?? line.match(/\b(left|remaining|available)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%/i);
  const used = line.match(/(\d+(?:\.\d+)?)\s*%\s*(used|consumed|spent)\b/i) ?? line.match(/\b(used|usage|consumed)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%/i);
  const num = m => Number(m.slice(1).find(x => /^\d/.test(x ?? "")));
  if (left) facts.remaining = num(left), facts.remaining_unit = "%";
  if (used) facts.used_pct = num(used);
  if (!left) {
    const count = line.match(/(\d+)\s+(requests?\s+|prompts?\s+|calls?\s+)?(left|remaining)\b/i) ?? line.match(/\b(remaining|left)\s*[:=]\s*(\d+)\b(?!\s*%)/i);
    if (count) facts.remaining = num(count), facts.remaining_unit = "count";
  }
  const frac = line.match(/\b(\d+)\s*\/\s*(\d+)\b(?!\s*\d)/);
  if (frac && !used && Number(frac[2]) > 0 && /\bused\b|\busage\b/i.test(line)) facts.used_pct = Math.round(100 * Number(frac[1]) / Number(frac[2]));
  const bare = !left && !used ? line.match(/(\d+(?:\.\d+)?)\s*%/) : null;
  if (bare) facts.pct = Number(bare[1]);   // direction unknown: never decides exhaustion
  const resets = line.match(/\bresets?\s+(in|at|on)\s+([^,;)\]]+)/i);
  if (resets) facts.resets_at = `${resets[1]} ${resets[2].trim()}`;
  if (NOT_EXHAUSTED.test(line)) facts.said_exhausted = false;
  else if (EXHAUSTED_WORDS.test(line)) facts.said_exhausted = true;
  return facts;
}
/** Decide one bucket: exhausted only on an unambiguous statement. `known` says the bucket gave a usable reading. */
function decide(name, facts, line) {
  const b = { name, exhausted: false, line };
  for (const k of ["used_pct", "remaining", "remaining_unit", "resets_at"]) if (facts[k] !== undefined && !Number.isNaN(facts[k])) b[k] = facts[k];
  const signals = [];
  if (b.used_pct !== undefined) signals.push(b.used_pct >= 100);
  if (b.remaining !== undefined) signals.push(b.remaining <= 0);
  if (facts.said_exhausted !== undefined) signals.push(facts.said_exhausted);
  // Contradicting signals (e.g. "100% used, 20 left") are ambiguity: not exhausted, and not a usable reading.
  const contradict = signals.includes(true) && signals.includes(false);
  b.exhausted = !contradict && signals.includes(true);
  return { bucket: b, known: signals.length > 0 && !contradict };
}

/** Flatten a JSON report into "bucket-ish" lines the line reader understands. Returns null when `text` is not JSON. */
function jsonLines(text) {
  const t = text.trim();
  if (!/^[{[]/.test(t)) return null;
  let v;
  try { v = JSON.parse(t); } catch { return null; }
  const out = [];
  const walk = (node, label) => {
    if (Array.isArray(node)) { node.forEach((x, i) => walk(x, label)); return; }
    if (!node || typeof node !== "object") return;
    const own = [node.name, node.id, node.window, node.bucket, node.group, node.label].filter(x => typeof x === "string").join(" ");
    const name = `${label} ${own}`.trim();
    const parts = [];
    for (const [k, val] of Object.entries(node)) {
      if (val && typeof val === "object") continue;
      const key = k.toLowerCase();
      if (/^(used_?pct|used_?percent(age)?|percent_?used|usage_?pct|usage_?percent)$/.test(key)) parts.push(`${val}% used`);
      else if (/^(remaining_?pct|remaining_?percent(age)?|percent_?remaining|left_?pct)$/.test(key)) parts.push(`${val}% left`);
      else if (/^(remaining_?fraction|fraction_?remaining)$/.test(key) && typeof val === "number") parts.push(`${Math.round(val * 100)}% left`);
      else if (/^(remaining|left|requests_?remaining)$/.test(key) && typeof val === "number") parts.push(`${val} remaining`);
      else if (/^(exhausted|limit_?reached|is_?exhausted)$/.test(key) && typeof val === "boolean") parts.push(val ? "limit reached" : "not exhausted");
      else if (/^(resets?_?(at|in|time)?|reset_?time|resettime|resetsat|resetat)$/.test(key)) parts.push(`resets at ${val}`);
    }
    if (parts.length && bucketOf(name)) out.push(`${name}: ${parts.join(", ")}`);
    for (const [k, val] of Object.entries(node)) if (val && typeof val === "object") walk(val, `${label} ${k}`.trim());
  };
  walk(v, "");
  return out;
}

/**
 * Read a quota report (format undocumented). Returns {state: "exhausted" | "available" | "unknown", buckets}.
 *   exhausted  at least one recognised bucket says, unambiguously, that it is spent
 *   available  recognised buckets gave usable readings and none is spent
 *   unknown    nothing recognisable (or only ambiguous readings)
 */
export function parseQuotaReport(text) {
  if (typeof text !== "string" || !text.trim()) return { state: "unknown", buckets: [] };
  const lines = jsonLines(text) ?? text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const buckets = [];
  let known = 0;
  for (let i = 0; i < lines.length; i++) {
    const name = bucketOf(lines[i]);
    if (!name) continue;
    // A bucket's figures may be on its own line or on the next one(s) when that line names no bucket.
    let line = lines[i], facts = readLine(line);
    for (let j = i + 1; j < lines.length && j <= i + 2 && !bucketOf(lines[j]); j++) {
      const more = readLine(lines[j]);
      if (!Object.keys(more).length) break;
      for (const [k, v] of Object.entries(more)) if (facts[k] === undefined) facts[k] = v;
      line += " | " + lines[j];
    }
    const d = decide(name, facts, line);
    buckets.push(d.bucket);
    if (d.known) known++;
  }
  const state = buckets.some(b => b.exhausted) ? "exhausted" : known > 0 ? "available" : "unknown";
  return { state, buckets };
}

// ---- the probe ------------------------------------------------------------------------------------------------------

// A MINIMAL environment: what a CLI needs to find its own login and reach its backend through the proxy. No Google API
// key, no model, no workspace. `env` (injected) adds to it; the keys are stripped after the merge.
const PASS = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TERM|TZ|TMPDIR|XDG_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|ALL_PROXY|all_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE)$/;
export function minimalEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => PASS.test(k)));
  Object.assign(env, extra ?? {});
  delete env.GEMINI_API_KEY; delete env.GOOGLE_API_KEY;
  return env;
}

/**
 * Run `agy -p /quota` once (no model, no workspace: an empty temporary cwd) and read its report.
 * Returns {state, buckets, raw_digest, exit_code, command, error?}. A probe that cannot run is `unknown`, never
 * `exhausted`. Whether the command spends tokens is undocumented; it names no model.
 */
export async function probeQuota({ cli, env = {}, timeoutS = 30, signal = undefined } = {}) {
  const command = [cli, "-p", "/quota"];
  const cwd = await mkdtemp(join(tmpdir(), "pantheon-agy-quota-"));
  try {
    const run = await spawnPromise(cli, ["-p", "/quota"], { cwd, env: minimalEnv(env), timeout: timeoutS * 1000, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) });
    const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const raw_digest = "sha256:" + createHash("sha256").update(text).digest("hex");
    if (run.killedFor) return { state: "unknown", buckets: [], raw_digest, exit_code: null, command, error: `the probe was stopped (${run.killedFor})` };
    const parsed = parseQuotaReport(run.stdout ?? "");
    // stdout is the report; a probe that failed may still say why on stderr — read it too, but only to add evidence.
    const errParsed = run.status !== 0 ? parseQuotaReport(run.stderr ?? "") : { state: "unknown", buckets: [] };
    const buckets = [...parsed.buckets, ...errParsed.buckets];
    const state = parsed.state === "exhausted" || errParsed.state === "exhausted" ? "exhausted" : parsed.state === "available" ? "available" : errParsed.state;
    return { state, buckets, raw_digest, exit_code: run.status };
  } catch (e) {
    return { state: "unknown", buckets: [], raw_digest: null, exit_code: null, command, error: String(e?.code ?? e?.message ?? e) };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
