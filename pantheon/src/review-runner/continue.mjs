// `--continue <findings-<n>-<lab>.transcript.json>`: resume an INCOMPLETE review instead of starting over.
//
// What a continuation may use is the reviewer's OWN earlier run of the SAME assignment, and nothing else: the transcript
// must name the same assignment, lab, vendor, requested model, --via (and transport) and commit as the new invocation,
// its findings file next to it must say `status: incomplete` and name this transcript's sha256, and the brief (README +
// assignment file) must be byte-identical to the one the earlier run was given. Otherwise: refused.
//
// Restored from the transcript: the files the reviewer wrote under .review-tests/ (captured in full, at most
// FILE_CAP bytes each, at the end of every run from now on; a transcript without that capture is refused).
// API mode continues the conversation (index.mjs: OpenAI from the last response id with previous_response_id and the
// pending function_call_output items; Gemini and xAI by replaying the recorded responses and FULL tool results, which
// transcripts now store, capped at RESULT_CAP). Subscription mode resumes where the CLI documents a headless resume
// and the runner can supply its state (agy: --conversation <id> with the earlier run's conversation state restored;
// codex: the SDK's resumeThread(<thread id>) with this run's worktree and sandbox, when the thread is on this machine);
// otherwise it starts a new session whose prompt carries a delimited appendix of the reviewer's own earlier messages
// and tool results (`replayed-own-transcript`).
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { sha256 } from "./brief.mjs";
import { REVIEW_TESTS_DIR } from "./cli-common.mjs";

export const FILE_CAP = 256 * 1024;       // one .review-tests file kept in a transcript
export const RESULT_CAP = 256 * 1024;     // one tool result / tool argument kept in a transcript
export const FILES_MAX = 200;
export const APPENDIX_CAP = 64 * 1024;    // the replayed-own-transcript appendix (its most recent part is kept)

// The one text a continuation adds to an API conversation whose last reply ended without a tool call (cut off).
export const CONTINUE_NOTE = "The review runner stopped your previous reply before it was complete (it is above, as far as it got). Continue the review and then reply with the complete findings document as your final message, in the format the harness gives.";
// The text that precedes a subscription CLI's prompt on a continuation.
export const CLI_CONTINUE_NOTE = "This continues your earlier, interrupted session in this review. The runner rebuilt the worktree at the same commit (its path may differ) and restored the files you wrote under .review-tests/. Finish the review; your final message must be the complete findings document.";
export const APPENDIX_BEGIN = "===== BEGIN: Your earlier, interrupted session in this review (verbatim transcript excerpt) =====";
export const APPENDIX_END = "===== END: Your earlier, interrupted session in this review =====";

export class ContinueRefusal extends Error {}
const refuse = m => { throw new ContinueRefusal(m); };
const clipStr = (s, n) => { s = String(s ?? ""); const b = Buffer.from(s); return b.length <= n ? { text: s, truncated: false } : { text: b.subarray(0, n).toString("utf8"), truncated: true, bytes: b.length }; };
export { clipStr };

// ---- .review-tests capture and restore ------------------------------------------------------------------------------

/** Every regular file under <wt>/.review-tests (symlinks skipped), content kept up to FILE_CAP bytes. */
export async function captureReviewTests(wt) {
  const root = join(wt, REVIEW_TESTS_DIR), files = [], skipped = [];
  const walk = async dir => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name), rel = relative(wt, p).split(sep).join("/");
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.isFile()) { skipped.push({ path: rel, why: e.isSymbolicLink() ? "symlink" : "not a regular file" }); continue; }
      if (files.length >= FILES_MAX) { skipped.push({ path: rel, why: `more than ${FILES_MAX} files` }); continue; }
      const buf = await readFile(p);
      const keep = buf.length > FILE_CAP ? buf.subarray(0, FILE_CAP) : buf;
      files.push({ path: rel, bytes: buf.length, sha256: sha256(buf), content_base64: keep.toString("base64"), ...(buf.length > FILE_CAP ? { truncated: true } : {}) });
    }
  };
  const st = await lstat(root).catch(() => null);
  if (st?.isDirectory()) await walk(root);
  return { captured: true, cap_bytes: FILE_CAP, files, skipped };
}

/** Write the captured files back into a new worktree. Paths are re-checked; returns {restored: [paths], truncated: [paths]}. */
export async function restoreReviewTests(wt, capture) {
  const restored = [], truncated = [];
  const realWt = await realpath(wt);
  for (const f of capture?.files ?? []) {
    const segs = String(f.path).split("/");
    if (segs[0] !== REVIEW_TESTS_DIR || segs.length < 2 || segs.some(s => !s || s === "." || s === "..")) refuse(`the transcript names a .review-tests file outside .review-tests/: ${JSON.stringify(f.path)}`);
    const dst = join(realWt, ...segs);
    await mkdir(dirname(dst), { recursive: true });
    const parent = await realpath(dirname(dst));
    if (!(parent === join(realWt, REVIEW_TESTS_DIR) || parent.startsWith(join(realWt, REVIEW_TESTS_DIR) + sep))) refuse(`restoring ${f.path} would leave .review-tests/`);
    await writeFile(dst, Buffer.from(f.content_base64 ?? "", "base64"));
    restored.push(f.path);
    if (f.truncated) truncated.push(f.path);
  }
  return { restored, truncated };
}

// ---- validation -------------------------------------------------------------------------------------------------------

const NAME = /^findings-([1-4])-([a-z]+)\.transcript\.json$/;

/**
 * Read and validate the transcript to continue from. `expect`: {n, lab, vendor, model, commit, via, transport?,
 * brief_sha256}. Returns {path, sha256, t, findings, prior: {runs, provider_calls, tool_calls, usage, wall_s}}.
 */
export async function loadContinuation(path, expect) {
  const name = basename(path), m = NAME.exec(name);
  if (!m) refuse(`--continue ${path}: not a findings-<n>-<lab>.transcript.json file`);
  let bytes;
  try { bytes = await readFile(path); } catch (e) { refuse(`--continue ${path}: cannot be read (${e.code ?? e.message})`); }
  let t;
  try { t = JSON.parse(bytes.toString("utf8")); } catch { refuse(`--continue ${path}: not JSON`); }
  const tsha = sha256(bytes);
  const via = t.via ?? "api";
  const mism = [];
  if (Number(m[1]) !== expect.n || t.assignment !== expect.n) mism.push(`assignment ${t.assignment} (file ${m[1]}) vs ${expect.n}`);
  if (m[2] !== expect.lab || String(t.lab ?? "").toLowerCase() !== expect.lab) mism.push(`lab ${t.lab} vs ${expect.lab}`);
  if (t.vendor !== expect.vendor) mism.push(`vendor ${t.vendor} vs ${expect.vendor}`);
  if (t.requested_model !== expect.model) mism.push(`model ${t.requested_model} vs ${expect.model}`);
  if (t.commit !== expect.commit) mism.push(`commit ${t.commit} vs ${expect.commit}`);
  if (via !== expect.via) mism.push(`via ${via} vs ${expect.via}`);
  if (expect.transport && t.transport !== expect.transport) mism.push(`transport ${t.transport} vs ${expect.transport}`);
  // --reviewer: the override (or its absence) must be the earlier run's. A transcript written before the flag existed
  // records none, which reads as no override.
  if ("reviewer" in expect) {
    const was = t.reviewer_override ? (t.reviewer ?? "an unrecorded override") : null;
    if (was !== expect.reviewer) mism.push(`reviewer override ${was ?? "none"} vs ${expect.reviewer ?? "none"}`);
  }
  if (mism.length) refuse(`--continue ${name} is not this review: ${mism.join("; ")}`);
  // `failed` is a subscription run whose transport reported the failure itself (Codex: turn.failed, an SDK error).
  if (t.status !== "incomplete" && !(via === "subscription" && t.status === "failed")) refuse(`--continue ${name}: its status is ${JSON.stringify(t.status)}; only an incomplete review is continued (in subscription mode, a failed one too)`);
  const findings = join(dirname(path), name.replace(/\.transcript\.json$/, ".md"));
  let md;
  try { md = await readFile(findings, "utf8"); } catch { refuse(`--continue ${name}: its findings file ${basename(findings)} is missing`); }
  if (!new RegExp(`^- status: ${t.status}$`, "m").test(md)) refuse(`--continue ${name}: ${basename(findings)} does not say \`status: ${t.status}\``);
  const named = /^- transcript: `[^`]+` sha256 `([0-9a-f]{64})`$/m.exec(md)?.[1];
  if (named !== tsha) refuse(`--continue ${name}: ${basename(findings)} names transcript sha256 ${named ?? "none"}, the file is ${tsha}`);
  const briefSha = via === "api" ? t.hashes?.brief : t.prompt?.brief_sha256;
  if (briefSha !== expect.brief_sha256) refuse(`--continue ${name}: the README or the assignment file changed since that run (brief sha256 ${briefSha ?? "none"} vs ${expect.brief_sha256})`);
  if (t.review_tests?.captured !== true) refuse(`--continue ${name}: an older transcript without the contents of .review-tests/; it cannot be restored, so the review must start over`);
  if (via === "api") {
    const calls = (t.events ?? []).filter(e => e.type === "tool_call");
    if (calls.some(e => e.result_full !== true)) refuse(`--continue ${name}: an older transcript that kept only digests of tool results; the conversation cannot be replayed, so the review must start over`);
  }
  const c = t.cumulative;
  const prior = c ? { runs: c.runs, provider_calls: c.provider_calls ?? 0, tool_calls: c.tool_calls ?? 0, usage: c.usage ?? {}, wall_s: c.wall_s ?? 0 }
    : { runs: 1, provider_calls: t.provider_calls ?? 0, tool_calls: t.tool_calls ?? 0, usage: t.usage_totals ?? t.usage ?? {}, wall_s: wallOf(t) };
  return { path, name, sha256: tsha, t, findings, prior };
}
const wallOf = t => { const a = Date.parse(t.started_at), b = Date.parse(t.ended_at); return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 1000) : 0; };

export function addNumbers(a = {}, b = {}) {
  const out = JSON.parse(JSON.stringify(a ?? {}));
  for (const [k, v] of Object.entries(b ?? {})) {
    if (typeof v === "number") out[k] = (typeof out[k] === "number" ? out[k] : 0) + v;
    else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = addNumbers(out[k] && typeof out[k] === "object" ? out[k] : {}, v);
  }
  return out;
}
export function cumulative(prior, now) {
  return { runs: prior.runs + 1, provider_calls: prior.provider_calls + (now.provider_calls ?? 0), tool_calls: prior.tool_calls + (now.tool_calls ?? 0),
    usage: addNumbers(prior.usage, now.usage ?? {}), wall_s: prior.wall_s + (now.wall_s ?? 0) };
}

// ---- API replay -----------------------------------------------------------------------------------------------------

/**
 * Feed the earlier run's recorded responses and full tool results into a fresh conversation, as they happened. Returns
 * {turns, last: {calls (from the last recorded response), recorded: [{id, name, output}], missing: [calls]} | null,
 * partial: string | null, pending_outputs}. `last` is set when the last recorded response asked for tools (those it
 * ran are `recorded`, those the earlier run never ran are `missing`); `partial` when it ended without a tool call.
 */
export function replayApi(conv, t) {
  const events = t.events ?? [];
  let turns = 0, cur = null;   // cur: the last accepted response {turn, calls, text}, its tool results collected by turn
  const results = new Map();   // turn -> Map(id -> event)
  for (const e of events) if (e.type === "tool_call") { if (!results.has(e.turn)) results.set(e.turn, new Map()); results.get(e.turn).set(e.id, e); }
  const split = c => {
    const rec = results.get(c.turn) ?? new Map(), recorded = [], missing = [];
    for (const call of c.calls) { const e = rec.get(call.id ?? null); if (e) recorded.push({ id: call.id, name: call.name, output: e.result_text }); else missing.push(call); }
    return { recorded, missing };
  };
  for (const e of events) {
    if (e.type === "provider_call" && e.response && typeof e.response === "object") {
      if (cur && cur.calls.length) {
        const { recorded, missing } = split(cur);
        if (missing.length) refuse(`turn ${cur.turn}: the transcript lacks the result of ${missing.length} tool call(s) the model asked for; it cannot be replayed`);
        conv.addToolResults(recorded);
      } else if (cur && !cur.continued) refuse(`turn ${cur.turn}: a reply without a tool call is followed by another provider call with no continuation recorded; it cannot be replayed`);
      const r = conv.accept(e.response);
      turns++;
      cur = { turn: e.turn, calls: r.calls, text: r.text ?? "", continued: false };
    } else if (e.type === "continuation" && typeof e.note === "string") {
      if (!cur || cur.calls.length) refuse("a recorded continuation note does not follow a reply that ended without a tool call");
      conv.addContinuation(cur.text, e.note);
      cur.continued = true;
    }
  }
  if (!cur) return { turns, last: null, partial: null, last_turn: 0 };
  if (cur.calls.length) return { turns, last: { calls: cur.calls, ...split(cur) }, partial: null, last_turn: cur.turn };
  if (cur.continued) return { turns, last: null, partial: null, last_turn: cur.turn };   // the note is already the next input
  return { turns, last: null, partial: cur.text, last_turn: cur.turn };
}

// ---- the subscription fallback: the reviewer's own earlier session as an appendix ---------------------------------------

/** The appendix text from the earlier run's own messages and tool results (cli.own: [{kind, text}]), its tail kept. */
export function ownTranscriptAppendix(t) {
  const own = Array.isArray(t.cli?.own) ? t.cli.own : [];
  let body = own.map(x => `--- ${x.kind} ---\n${x.text}`).join("\n\n");
  let cut = false;
  if (Buffer.byteLength(body) > APPENDIX_CAP) { body = Buffer.from(body).subarray(-APPENDIX_CAP).toString("utf8"); cut = true; }
  return [APPENDIX_BEGIN,
    `The runner stopped your earlier session (${t.stop_reason ?? "reason not recorded"}). Below are your own messages and tool results from it, verbatim${cut ? `, the last ${APPENDIX_CAP} bytes only` : ""}; nothing else is included. The files you wrote under .review-tests/ have been restored.`,
    "", body || "(the earlier session recorded no message or tool result)", "", APPENDIX_END].join("\n");
}

/**
 * Before a continuation overwrites the files it continues from, the earlier pair is kept beside them under names that
 * carry the earlier transcript's sha256 (and that --continue does not accept).
 */
export async function preserveFiles(resume, outPaths) {
  const tag = resume.sha256.slice(0, 12);
  await copyFile(resume.path, outPaths.transcript.replace(/\.transcript\.json$/, `.transcript.prev-${tag}.json`));
  await copyFile(resume.findings, outPaths.findings.replace(/\.md$/, `.prev-${tag}.md`));
}
