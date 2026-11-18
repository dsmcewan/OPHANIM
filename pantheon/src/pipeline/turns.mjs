// THE PIPELINE'S TURN ADAPTER: the `turns` object runPipeline() is given, built from INJECTED transports.
//
//   pipelineTurns({ makeClientFor, turn, agy }) -> { dispatcher, implementer, subagent, reviewer }
//
//   dispatcher, reviewer   single-turn OpenAI seats, through the injected single-turn `turn({vendor, model, prompt,
//                          seat, extra})` (live: sdk/live.mjs liveTurn). `extra` ({reasoning: {context}}) is passed
//                          through as given; this module sets no provider option itself.
//   subagent               a single-turn Grok seat through the same `turn`.
//   implementer            a MULTI-TURN worker on an Antigravity lane, through the `agy` CLI (board/agy-cli.mjs
//                          runAgyCliTurn, an async spawn). The CLI agent works in the unit's worktree over its own
//                          internal turns and WRITES THE FILES ITSELF; the worktree is handed to it as its --add-dir
//                          and the unit's A2A endpoint is in its environment (PANTHEON_A2A_URL, PANTHEON_A2A_TOKEN).
//
// THE IMPLEMENTER'S SERVED MODEL. Antigravity names no serving model. The lane model is a required input, and
// runAgyCliTurn fails when the model the CLI reports at start is not the one asked for; the answer therefore carries
// that input, marked `served_model_source: "input"` (owner decision 2026-11-17): the pinned model, not a statement
// by the provider about this answer.
//
// LANE FIRST; THE METERED API ONLY AFTER A QUOTA REFUSAL. The metered Gemini API id of the lane's base model
// (route/fit-matrix.mjs quotaFailoverFor) is asked ONLY when the lane attempt was refused for quota (HTTP 429 /
// quota exhausted, as packages/model-client classifyFailure classifies it). Any other lane failure is thrown as it
// is and never reaches the metered API. A failover is recorded on the returned object (`quota_failover`).
//
// THE API FALLBACK CANNOT WRITE FILES, so its contract is the minimal honest one: the API is shown the unit prompt
// and the current contents of the unit's owned files, and its WHOLE reply must be one strict JSON object
//   {"files": [{"path": "<repo-relative path>", "content": "<the complete new file>"}]}
// which THIS ADAPTER writes into the worktree. A path that is absolute, contains "..", is a pattern, is outside the
// unit's owned paths, or would be written through a symlink is refused and nothing is written. Anything else than
// that object is a failed attempt (the turn throws; the controller discards the worktree's changes). What was
// written is then judged by the controller's write jail like any other attempt: this adapter is not the jail.
//
// Inputs: the injected `turn` and `makeClientFor(vendor)` (the lifecycle's own), and `agy` options {cli?, repo?,
// role?, timeoutS?, run?, api?} — `run` replaces runAgyCliTurn and `api` the metered-API call, for tests.
// Outputs: for every role, {text, served_model, served_model_source} (+ transport, quota_failover on the implementer).
//
// Must never: block the event loop on a child process (async spawn only); send a Google API key to the CLI; reach
// the metered API after a lane failure that is not a quota refusal; write a path the API named outside the unit;
// invent a served model for a judging seat (a missing one is passed on as missing and refused by the controller).
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgyCliTurn } from "../board/agy-cli.mjs";
import { classifyFailure } from "../../../packages/model-client/index.mjs";
import { quotaFailoverFor, laneParts } from "../route/fit-matrix.mjs";
import { QUOTA_FAILOVER_RULE } from "../route/frontier.mjs";
import { keysRefusal, str, strictJson } from "./util.mjs";
import { matchesOwned, pathRefusal } from "./paths.mjs";
import { git } from "./git.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const API_FILES_KEYS = Object.freeze(["files"]);
const MAX_SHOWN_BYTES = 200000;   // owned files shown to the API fallback, in total

const fail = (code, message) => Object.assign(new Error(message), { code });
const inside = (root, p) => p === root || p.startsWith(root + sep);

/** What the API fallback is told on top of the unit prompt: it cannot act, so it answers with the files themselves. */
export function API_FALLBACK_PROMPT({ prompt, shown, truncated }) {
  return [prompt, "",
    "TRANSPORT NOTE (this overrides any instruction above to use tools, run commands or edit files): you have NO tools and NO file access in this turn. You cannot run the command above.",
    "The current contents of the files you own are below. Answer with the COMPLETE new contents of every file you create or change.",
    "",
    shown.length ? shown.map(f => `<<<FILE ${f.path}\n${f.content}\nFILE`).join("\n") : "(none of the paths you own exists yet)",
    truncated ? "(more owned files exist than are shown; the listing was cut at its bound)" : "",
    "",
    "OUTPUT: exactly one JSON object and nothing else (no prose, no code fence):",
    '{"files":[{"path":"repo-relative/path","content":"the complete new file contents"}]}',
    "Every path must be one of the paths you own. Any other key, or text outside the object, is refused and nothing is written.",
  ].filter(l => l !== "").join("\n");
}

/** Why an API fallback answer is not {files: [{path, content}]} for `owned`, or null. */
export function apiFilesRefusal(value, owned = null) {
  const keys = keysRefusal(value, [...API_FILES_KEYS]);
  if (keys) return `the answer is ${keys}; it is {"files": [{path, content}]}`;
  if (!Array.isArray(value.files) || !value.files.length) return "files is a non-empty array";
  const seen = new Set();
  for (const f of value.files) {
    const k = keysRefusal(f, ["path", "content"]);
    if (k) return `a files entry has ${k}`;
    if (!str(f.path) || typeof f.content !== "string") return "a files entry is {path: non-empty string, content: string}";
    const why = pathRefusal(f.path);
    if (why) return why;
    if (/[*?]/.test(f.path)) return `"${f.path}" is a pattern, not a file path`;
    if (seen.has(f.path)) return `"${f.path}" is named twice`;
    seen.add(f.path);
    if (owned && !matchesOwned(f.path, owned)) return `"${f.path}" is not one of the unit's owned paths`;
  }
  return null;
}

/** Write the API's files into `cwd`. Refuses (writing nothing) a path that would land outside `cwd` or through a symlink. */
export async function writeApiFiles({ cwd, files }) {
  const root = await realpath(cwd);
  const plan = [];
  for (const f of files) {
    const abs = join(root, f.path);
    // The deepest ancestor that exists must resolve inside the worktree: a write through a symlinked directory
    // would land where git — and so the write jail — cannot see it.
    let at = dirname(abs);
    while (!existsSync(at) && at !== dirname(at)) at = dirname(at);
    const real = await realpath(at);
    if (!inside(root, real)) throw fail("API_FILES_REFUSED", `"${f.path}" resolves through ${at} to ${real}, outside the worktree; nothing was written`);
    const st = await lstat(abs).catch(() => null);
    if (st?.isSymbolicLink()) throw fail("API_FILES_REFUSED", `"${f.path}" is a symlink; the adapter does not write through it; nothing was written`);
    if (st?.isDirectory()) throw fail("API_FILES_REFUSED", `"${f.path}" is a directory; nothing was written`);
    plan.push({ abs, content: f.content });
  }
  for (const p of plan) { await mkdir(dirname(p.abs), { recursive: true }); await writeFile(p.abs, p.content); }
  return files.map(f => f.path);
}

/** The tracked files of `cwd` matched by `owned`, with their contents, up to a byte bound: {shown, truncated}. */
async function ownedFiles(cwd, owned) {
  const listed = (await git(cwd, ["ls-files", "-z"])).split("\0").filter(Boolean).filter(p => matchesOwned(p, owned)).sort();
  const shown = [];
  let bytes = 0, truncated = false;
  for (const p of listed) {
    const st = await lstat(join(cwd, p)).catch(() => null);
    if (!st?.isFile()) continue;
    if (bytes + st.size > MAX_SHOWN_BYTES) { truncated = true; continue; }
    shown.push({ path: p, content: await readFile(join(cwd, p), "utf8") });
    bytes += st.size;
  }
  return { shown, truncated };
}

/**
 * The turns of a pipeline run.
 *   turn           async ({vendor, model, prompt, seat, extra?, signal?}) -> {text, served_model, ...}: every single-turn seat
 *   makeClientFor  (vendor) -> an SDK client: the metered Gemini API, used only as a lane's quota failover
 *   agy            {cli = $PANTHEON_AGY_CLI or ~/.local/bin/agy, repo = Pantheon's root (where the role cards are),
 *                   role = "implementer" (the role card), timeoutS = 1800, run = runAgyCliTurn, api = null}
 */
export function pipelineTurns({ makeClientFor = null, turn, agy = {} } = {}) {
  if (typeof turn !== "function") throw new Error("pipelineTurns: pass turn({vendor, model, prompt, seat, extra}) for the single-turn seats");
  const lane = agy.run ?? runAgyCliTurn;
  const role = agy.role ?? "implementer", timeoutS = agy.timeoutS ?? 1800, cardRepo = agy.repo ?? REPO;

  const single = seatRole => async ({ vendor, model, prompt, seat = null, extra = undefined, signal = undefined }) => {
    const r = await turn({ vendor, model, prompt, seat: { ...(seat ?? { vendor, model }), role: seatRole }, ...(extra && Object.keys(extra).length ? { extra } : {}), ...(signal ? { signal } : {}) });
    // The served model is passed on exactly as the transport named it; a judging seat with none is refused upstream.
    return { text: r?.text ?? "", served_model: r?.served_model ?? null, served_model_source: r?.served_model_source ?? (r?.served_model ? "provider" : null), response_id: r?.response_id ?? null };
  };

  /** The metered Gemini API of a lane's base model: one unary answer, by default through makeClientFor + sendTurn. */
  const api = agy.api ?? (async ({ vendor, model, prompt, effort, signal }) => {
    if (typeof makeClientFor !== "function") throw fail("NO_API_CLIENT", "the metered Gemini API was needed as a quota failover, and no makeClientFor was given");
    const { sendTurn } = await import("../sdk/adapter.mjs");
    const r = await sendTurn({ client: makeClientFor(vendor), vendor, model, prompt, label: "pipeline-implementer-quota-failover", onEvent: () => {},   // streamed: whole files can be long
      ...(effort ? { effort } : {}), ...(signal ? { signal } : {}) });
    if (r.complete === false) throw new Error(`${vendor}/${model}: the reply did not complete (${r.terminal_state ?? "unknown"})`);
    return { text: r.text ?? "", served_model: r.served_model ?? null, response_id: r.response_id ?? null };
  });

  const implementer = async ({ vendor, model, prompt, cwd, a2a = null, env = {}, sandbox = null, signal = undefined }) => {
    if (!str(cwd)) throw fail("NO_WORKTREE", "the implementer turn needs the unit's worktree (cwd)");
    if (!laneParts(model)) throw fail("NOT_A_LANE", `the pipeline implementer runs on an Antigravity lane, and ${vendor}/${model} is not one (config/lanes.json)`);
    const cli = agy.cli ?? process.env.PANTHEON_AGY_CLI ?? join(homedir(), ".local", "bin", "agy");
    if (!agy.run && cli.includes("/") && !existsSync(cli)) throw new Error(`agy seat: CLI absent at ${cli} (set PANTHEON_AGY_CLI)`);
    const childEnv = { ...env, ...(a2a ? { PANTHEON_A2A_URL: a2a.url, PANTHEON_A2A_TOKEN: a2a.token } : {}) };
    try {
      const r = await lane({ cli, repo: cardRepo, worktree: cwd, role, model, prompt, timeoutS, env: childEnv, ...(signal ? { signal } : {}) });
      return { text: r.text ?? "", served_model: model, served_model_source: "input", transport: "agy-cli", requested_model: model,
        response_id: r.response_id ?? null, tool_calls: r.tool_calls ?? null };
    } catch (e) {
      const spare = quotaFailoverFor(model);
      if (!spare || !classifyFailure(e).quota) throw e;
      const after = [{ lane: model, outcome: "quota", source: "attempt", status: e?.status ?? null, code: e?.code ?? null, why: String(e?.message ?? e).slice(0, 200) }];
      const quota_failover = { used: true, base: spare.model, lanes: [model], rule: QUOTA_FAILOVER_RULE, after };
      const owned = Array.isArray(sandbox?.owned_paths) ? sandbox.owned_paths : null;
      const { shown, truncated } = owned ? await ownedFiles(cwd, owned) : { shown: [], truncated: false };
      const r = await api({ vendor: spare.vendor, model: spare.model, effort: spare.effort, prompt: API_FALLBACK_PROMPT({ prompt, shown, truncated }), signal });
      const parsed = strictJson(r?.text);
      const why = parsed.ok ? apiFilesRefusal(parsed.value, owned) : parsed.why;
      if (why) throw Object.assign(fail("API_FILES_REFUSED", `the metered API answered the quota failover of ${model}, and its answer is refused: ${why}; nothing was written`), { quota_failover });
      let written;
      try { written = await writeApiFiles({ cwd, files: parsed.value.files }); } catch (err) { throw Object.assign(err, { quota_failover }); }
      return { text: `the adapter wrote ${written.length} file(s) from the API answer: ${written.join(", ")}`, served_model: str(r?.served_model) ? r.served_model : null,
        served_model_source: str(r?.served_model) ? "provider" : null, transport: "api", requested_model: model, response_id: r?.response_id ?? null, quota_failover, written };
    }
  };

  return { dispatcher: single("dispatcher"), reviewer: single("reviewer"), subagent: single("subagent"), implementer };
}
