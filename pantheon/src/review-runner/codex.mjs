// Assignments 2 and 4 in subscription mode: the OpenAI Codex CLI, signed in with ChatGPT.
//
// DOCUMENTED (OpenAI's Codex docs, read 2026-11-18): "Sign in with ChatGPT for subscription access" vs "Sign in with an
// API key for usage-based access ... billed at standard API rates"; `codex login status` shows the active auth method;
// headless `codex exec "<prompt>"` with -m/--model, -C/--cd, --sandbox read-only|workspace-write|danger-full-access
// (exec's default: read-only), --ask-for-approval/-a on-request|never, --json (JSONL events: thread.started,
// turn.started, turn.completed {usage}, turn.failed, item.* -- agent_message, command_execution, file_change,
// reasoning --, error), -o/--output-last-message <file>, --skip-git-repo-check; `--full-auto` is no longer supported;
// the Linux sandbox is bubblewrap (bwrap on PATH) + seccomp; `codex debug models` prints the model catalog;
// CODEX_API_KEY in the environment forces API-key usage for one invocation. NO event names the served model.
//
// NOT VERIFIED HERE (no codex on this machine; every test uses a fake): the exact text of `codex login status` and
// the format of `codex debug models` -- both are parsed conservatively (an API-key mention wins; an unparseable
// catalog is `unknown`, refused unless --skip-model-check), and the raw text is recorded redacted.
//
// Codex runs its OWN bubblewrap sandbox; this runner does NOT wrap it in ours (nested user namespaces are unverified).
// Containment is codex's --sandbox mode (read-only for assignment 4, workspace-write for 1-3) plus -a never, and the
// runner's post-run git check of the worktree (subscription.mjs), which records any write outside .review-tests/.
import { redactStrong } from "../board/agy-cli.mjs";
import { runCli, tail } from "./cli-common.mjs";

export const CODEX_FORBIDDEN = Object.freeze(["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto", "danger-full-access"]);

/** `codex login status` -> {method: "chatgpt" | "api-key" | "none" | "unknown", raw (redacted)}. */
export function parseLoginStatus(text, exitCode, env = {}) {
  const t = String(text ?? "");
  let method = "unknown";
  if (/api[ _-]?key/i.test(t)) method = "api-key";                       // checked first: an API-key mention always wins
  else if (/not\s+(logged|signed)\s+in|logged\s+out|no\s+(credentials|auth)/i.test(t)) method = "none";
  else if (exitCode === 0 && /chatgpt/i.test(t) && /(logged|signed)\s+in/i.test(t)) method = "chatgpt";
  return { method, raw: redactStrong(t, env).trim().slice(0, 2000) };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
/**
 * Does `codex debug models` list `model`? {status: "listed" | "missing" | "unknown", format: "json" | "lines" | null,
 * count}. JSON: model ids are the string values of slug/id/model/name keys (or a string array). Text: a line names the
 * model when it holds it as a whole word; "missing" only when some line starts with an id-shaped token containing a
 * digit; otherwise "unknown".
 */
export function parseModelList(stdout, model) {
  const text = String(stdout ?? "").trim();
  if (!text) return { status: "unknown", format: null, count: 0 };
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (json !== undefined) {
    const ids = new Set();
    const walk = v => {
      if (typeof v === "string") return;
      if (Array.isArray(v)) { for (const x of v) { if (typeof x === "string" && ID.test(x)) ids.add(x); else walk(x); } return; }
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (["slug", "id", "model", "name"].includes(k) && typeof x === "string") ids.add(x); else walk(x); }
    };
    walk(json);
    if (!ids.size) return { status: "unknown", format: "json", count: 0 };
    return { status: ids.has(model) ? "listed" : "missing", format: "json", count: ids.size };
  }
  const esc = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`(^|[^A-Za-z0-9._-])${esc}($|[^A-Za-z0-9._-])`);
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const idLines = lines.filter(l => { const f = l.replace(/^[-*•]\s+/, "").split(/\s+/)[0]; return ID.test(f) && /\d/.test(f) && /-/.test(f); });
  if (lines.some(l => word.test(l))) return { status: "listed", format: "lines", count: idLines.length };
  return { status: idLines.length ? "missing" : "unknown", format: idLines.length ? "lines" : null, count: idLines.length };
}

export function codexSandboxFor(write_allowed) { return write_allowed ? "workspace-write" : "read-only"; }

/** The exact argv after `codex`. Refuses any flag that would lift the sandbox or the approval policy. */
export function codexArgv({ model, worktree, write_allowed, lastMessage, prompt }) {
  const argv = ["exec", "--json", "-m", model, "-C", worktree, "--skip-git-repo-check", "-a", "never", "--sandbox", codexSandboxFor(write_allowed), "-o", lastMessage, prompt];
  for (const a of argv.slice(0, -1)) if (CODEX_FORBIDDEN.includes(a)) throw new Error(`codex argv carries ${a}: refused`);
  return argv;
}

/** Zero-spend preflight: version, login status (must be ChatGPT), model catalog. Returns {ok, failed: [why], checks}. */
export async function codexPreflight({ cli, env, model, opts, timeoutMs = 60_000 }) {
  const checks = {}, failed = [];
  const v = await runCli({ cmd: cli, args: ["--version"], env, timeoutMs });
  checks.version = { argv: [cli, "--version"], exit_code: v.exit_code, text: redactStrong(`${v.stdout}${v.stderr}`, env).trim().slice(0, 200) || null, ...(v.spawn_error ? { spawn_error: v.spawn_error } : {}) };
  if (v.exit_code !== 0) failed.push(`\`codex --version\` failed (exit ${v.exit_code ?? v.killed_for ?? v.spawn_error})`);
  const l = await runCli({ cmd: cli, args: ["login", "status"], env, timeoutMs });
  const login = parseLoginStatus(`${l.stdout}\n${l.stderr}`, l.exit_code, env);
  checks.login_status = { argv: [cli, "login", "status"], exit_code: l.exit_code, auth_method_observed: login.method, raw_redacted: login.raw };
  if (login.method === "api-key" && !opts.allowApiKeyInCli) failed.push("`codex login status` reports an API key (usage-based billing); subscription mode needs \"Sign in with ChatGPT\" (run `codex logout` then `codex login`), or pass --allow-api-key-in-cli to accept metered billing explicitly");
  else if (login.method === "none") failed.push("`codex login status` reports no login: run `codex login` and choose \"Sign in with ChatGPT\"");
  else if (login.method === "unknown") failed.push("`codex login status` did not say it is signed in with ChatGPT (its text is recorded, redacted): refusing rather than guessing the billing");
  const m = await runCli({ cmd: cli, args: ["debug", "models"], env, timeoutMs });
  const list = m.exit_code === 0 ? parseModelList(m.stdout, model) : { status: "unknown", format: null, count: 0 };
  checks.model_list = { argv: [cli, "debug", "models"], exit_code: m.exit_code, model, ...list, stderr_tail: redactStrong(tail(m.stderr, 1000), env) };
  if (list.status === "missing") failed.push(`\`codex debug models\` does not list ${model}`);
  else if (list.status === "unknown" && !opts.skipModelCheck) failed.push(`\`codex debug models\` could not be read for ${model} (status unknown); pass --skip-model-check to run without that check`);
  return { ok: failed.length === 0, failed, checks, cli_version: checks.version.text, auth_method_observed: login.method, model_check: list.status };
}

/**
 * Read codex's --json JSONL. Returns {thread_id, usage (summed over turn.completed), final_text (last agent_message),
 * commands: [{command, exit_code, status}], file_changes: [...], errors: [msg], turn_failed, unparsed, events}.
 */
export function parseCodexEvents(lines) {
  // own: the reviewer's own messages and tool results, in order (for a --continue that replays them, capped there).
  const out = { thread_id: null, usage: {}, final_text: null, commands: [], file_changes: [], errors: [], turn_failed: null, unparsed: 0, events: 0, turns_completed: 0, own: [] };
  const cap = (x, n = 16 * 1024) => { x = String(x ?? ""); return x.length > n ? `${x.slice(0, n)}… (${x.length} chars, truncated)` : x; };
  const add = (t, u) => { for (const [k, v] of Object.entries(u ?? {})) if (typeof v === "number") t[k] = (t[k] ?? 0) + v; return t; };
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { out.unparsed++; continue; }
    if (!e || typeof e !== "object") { out.unparsed++; continue; }
    out.events++;
    const type = e.type ?? e.event ?? null;
    if (type === "thread.started") out.thread_id = e.thread_id ?? null;
    else if (type === "turn.completed") { out.turns_completed++; add(out.usage, e.usage); }
    else if (type === "turn.failed") out.turn_failed = String(e.error?.message ?? e.error ?? "turn failed").slice(0, 1000);
    else if (type === "error") out.errors.push(String(e.message ?? e.error?.message ?? e.error ?? "error").slice(0, 1000));
    else if (typeof type === "string" && type.startsWith("item.")) {
      const it = e.item ?? {};
      const kind = it.type ?? it.item_type ?? null;
      if (type !== "item.completed") continue;
      if (kind === "agent_message" && typeof it.text === "string") { out.final_text = it.text; out.own.push({ kind: "your message", text: cap(it.text) }); }
      else if (kind === "command_execution") {
        out.commands.push({ command: String(it.command ?? "").slice(0, 2000), exit_code: it.exit_code ?? null, status: it.status ?? null });
        out.own.push({ kind: "command and its output", text: cap(`$ ${it.command ?? ""}\n(exit ${it.exit_code ?? "?"})\n${it.aggregated_output ?? ""}`) });
      } else if (kind === "file_change") {
        out.file_changes.push({ changes: (it.changes ?? []).map(c => ({ path: c.path ?? null, kind: c.kind ?? null })), status: it.status ?? null });
        out.own.push({ kind: "file change", text: (it.changes ?? []).map(c => `${c.kind ?? "?"} ${c.path ?? "?"}`).join("\n") });
      }
    }
  }
  return out;
}
