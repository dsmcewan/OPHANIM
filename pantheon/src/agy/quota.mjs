// ANTIGRAVITY QUOTA: recognising a quota refusal, and asking the CLI for its quota report.
//
// What the Antigravity CLI docs say (read 2026-11-18), and nothing more is relied on:
//   - `/usage` (alias `/quota`) refreshes the quota status "from the backend"; in headless mode a slash command
//     "produce[s] a text report rather than a standard event stream" (`agy -p /quota`).
//   - model groups "share a weekly limit and a five-hour limit"; release 1.5.10: "spend-cap, prepaid-balance, and
//     weekly quota errors now stop the turn right away"; a failing run "exits non-zero and writes the reason to stderr".
// OBSERVED on the owner's machine (agy 1.5.10, 2026-11-18): `agy --print /usage --output-format json` exits 0 with
// num_turns 0 and every token counter 0 (it spends nothing), and returns a JSON envelope whose `command.data.groups[]`
// each carry a `description` naming their models ("Models within this group: Gemini 4 Carbon, ...") and `buckets[]`
// `{id, name, window: "weekly" | "5h", remaining_fraction, reset_time}`. The text form is one tab-separated line per
// bucket: `<group>\t<bucket name>\t<N>%\t<reset time>`. That observed output is the primary format here
// (parseUsageEnvelope); the tolerant text parser stays as the fallback, and still never answers `exhausted` on
// ambiguity. Quota is per MODEL GROUP: a lane's failover is decided on its own group only (scopeQuota).
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
    // The observed text form leads each line with its model group, tab-separated.
    if (line.includes("\t")) d.bucket.group = line.split("\t")[0].trim();
    buckets.push(d.bucket);
    if (d.known) known++;
  }
  const state = buckets.some(b => b.exhausted) ? "exhausted" : known > 0 ? "available" : "unknown";
  return { state, buckets };
}

// ---- the structured report (observed, agy 1.5.10) ------------------------------------------------------------------

const modelsOf = description => {
  const m = /models within this group:\s*(.+)$/i.exec(String(description ?? ""));
  return m ? m[1].split(",").map(x => x.trim()).filter(Boolean) : [];
};
/**
 * Read the `--output-format json` envelope of `/usage`. Returns null when `obj` is not that envelope. A bucket is
 * exhausted when its `remaining_fraction` is a number <= 0; a bucket without a number is not a reading.
 */
export function parseUsageEnvelope(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const groups = obj.command?.data?.groups;
  const spent = { num_turns: obj.num_turns ?? null, total_tokens: obj.usage?.total_tokens ?? null };
  if (Array.isArray(groups)) {
    const buckets = groups.flatMap(g => (Array.isArray(g?.buckets) ? g.buckets : []).map(b => {
      const f = typeof b?.remaining_fraction === "number" && Number.isFinite(b.remaining_fraction) ? b.remaining_fraction : null;
      return { group: String(g.name ?? ""), models: modelsOf(g.description), id: b?.id ?? null, name: b?.name ?? null, window: b?.window ?? null,
        remaining_fraction: f, remaining: f === null ? undefined : Math.round(f * 100), remaining_unit: f === null ? undefined : "%",
        resets_at: b?.reset_time ?? null, exhausted: f !== null && f <= 0 };
    }));
    const state = buckets.some(b => b.exhausted) ? "exhausted" : buckets.some(b => b.remaining_fraction !== null) ? "available" : "unknown";
    return { state, buckets, format: "json", spent };
  }
  if (typeof obj.response === "string") return { ...parseQuotaReport(obj.response), format: "json-text", spent };
  return null;
}
/** A model's display name as the report lists it: `gemini-4-carbon` -> "Gemini 4 Carbon". */
export const displayNameOf = base => String(base).split("-").map(w => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
/**
 * The report narrowed to the group that serves `base` (a base model id, no thinking suffix). A group that lists its
 * models must list this one; a text-only group (no model list) matches by its name naming the model's family. No
 * matching group: `unknown` (another group's spent quota says nothing about this lane).
 */
export function scopeQuota(report, base) {
  if (!base || !report) return report;
  const name = displayNameOf(base), family = String(base).split("-")[0].toLowerCase();
  // A report whose buckets name no group at all (a format other than the observed one) cannot be narrowed: it is
  // read as a whole, and the record says it was not scoped.
  if (!(report.buckets ?? []).some(b => b.group || b.models?.length)) return { ...report, scope: { model: base, display_name: name, groups: [], unscoped: true, all_state: report.state } };
  const hit = b => (b.models?.length ? b.models.includes(name) : typeof b.group === "string" && b.group.toLowerCase().includes(family));
  const buckets = (report.buckets ?? []).filter(hit);
  const groups = [...new Set(buckets.map(b => b.group))];
  const state = !buckets.length ? "unknown" : buckets.some(b => b.exhausted) ? "exhausted" : buckets.some(b => b.remaining_fraction != null || b.remaining != null || b.used_pct != null) ? "available" : "unknown";
  return { ...report, state, buckets, scope: { model: base, display_name: name, groups, all_state: report.state } };
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
 * Run `agy --print /usage --output-format json` once (no model, no workspace: an empty temporary cwd; observed to
 * spend no tokens on agy 1.5.10) and read its report, narrowed to the group serving `model` when one is given.
 * Returns {state, buckets, raw_digest, exit_code, format, spent, scope?, command?, error?}. A probe that cannot run
 * is `unknown`, never `exhausted`. Output that is not the JSON envelope is read with the text parser.
 */
export const PROBE_ARGS = Object.freeze(["--print", "/usage", "--output-format", "json"]);
export async function probeQuota({ cli, env = {}, timeoutS = 30, signal = undefined, model = null } = {}) {
  const command = [cli, ...PROBE_ARGS];
  const base = model ? String(model).replace(/-(low|medium|high|xhigh|max)$/, "") : null;
  const cwd = await mkdtemp(join(tmpdir(), "pantheon-agy-quota-"));
  try {
    const run = await spawnPromise(cli, [...PROBE_ARGS], { cwd, env: minimalEnv({ AGY_CLI_DISABLE_AUTO_UPDATE: "true", ...env }), timeout: timeoutS * 1000, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) });
    const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const raw_digest = "sha256:" + createHash("sha256").update(text).digest("hex");
    if (run.killedFor) return { state: "unknown", buckets: [], raw_digest, exit_code: null, command, error: `the probe was stopped (${run.killedFor})` };
    let envelope = null;
    try { envelope = parseUsageEnvelope(JSON.parse(run.stdout ?? "")); } catch { /* not the JSON envelope: read it as text */ }
    if (envelope) {
      const scoped = base ? scopeQuota(envelope, base) : envelope;
      return { state: scoped.state, buckets: scoped.buckets, raw_digest, exit_code: run.status, format: envelope.format, spent: envelope.spent, ...(scoped.scope ? { scope: scoped.scope } : {}) };
    }
    const parsedAll = parseQuotaReport(run.stdout ?? "");
    const parsed = base ? scopeQuota(parsedAll, base) : parsedAll;
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
