// Fake providers for the REAL dispatcher (runOpenItem), with every request recorded as the provider saw
// it: vendor, model, credential pool and pool configuration. The Antigravity lane is a fake CLI script
// that logs the agent and model it was launched with; the real agy binary and the agy SDK venv are
// unreachable while a fixture is active (PANTHEON_AGY_CLI points at the fake, PANTHEON_AGY_PYTHON at
// nothing, and no Google API key is in the environment). No network is touched.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_AGY = `#!/bin/sh
agent="none"; model="none"; prompt=""
for a in "$@"; do
  case "$prev" in --agent) agent="$a" ;; --model) model="$a" ;; --print) prompt="$a" ;; esac
  prev="$a"
done
printf '%s %s\\n' "$agent" "$model" >> "$FAKE_AGY_LOG"
case "$agent" in
  pantheon-planner) reply='TITLE: fixture change' ;;
  pantheon-implementer) reply='export const ok = true;' ;;
  pantheon-reviewer) reply='VERDICT: approve' ;;
  *) reply='RAN: nothing' ;;
esac
printf '{"event":"init","conversation_id":"fake-agy-conversation","init":{"model":"%s","agent":"%s"}}\\n' "$model" "$agent"
printf '{"event":"result","result":{"status":"SUCCESS","conversation_id":"fake-agy-conversation","num_turns":1,"response":"%s","usage":{"input_tokens":1,"output_tokens":1}}}\\n' "$reply"
`;

export const WORK = /Output ONLY the complete new contents of/;

export async function withDispatch(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-dispatch-"));
  const keys = ["PANTHEON_COOLDOWN_DIR", "PANTHEON_AGY_CLI", "PANTHEON_AGY_PYTHON", "PANTHEON_AGY_TRANSPORT", "FAKE_AGY_LOG",
    "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPHANIM_LEDGER", "PANTHEON_POOLS_FILE"];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const agyLog = join(dir, "agy.log");
  writeFileSync(join(dir, "fake-agy"), FAKE_AGY, { mode: 0o755 });
  Object.assign(process.env, { PANTHEON_COOLDOWN_DIR: join(dir, "cooldowns"), PANTHEON_AGY_CLI: join(dir, "fake-agy"),
    PANTHEON_AGY_PYTHON: "/nonexistent/no-agy-sdk-in-tests", FAKE_AGY_LOG: agyLog });
  for (const k of ["PANTHEON_AGY_TRANSPORT", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPHANIM_LEDGER", "PANTHEON_POOLS_FILE"]) delete process.env[k];
  const calls = [];
  let implement = () => "export const ok = true;\n";
  const makeClientFor = scriptedClients(calls, prompt => implement(prompt));
  let n = 0;
  const agy = () => existsSync(agyLog) ? readFileSync(agyLog, "utf8").split("\n").filter(Boolean).map(l => { const [agent, model] = l.split(" "); return { agent, model }; }) : [];
  const spec = (key, extra = {}) => ({ key, repo_root: dir, title: "fixture", goal: "fixture goal", question: "q", copy: [],
    acceptance_cmd: "true", slot: "code", path: "code.mjs", ...extra });
  try {
    return await fn({ dir, calls, agy, makeClientFor, spec, implement: f => { implement = f; },
      opts: (extra = {}) => ({ dir: join(dir, `board-${++n}`), makeClientFor, scouts: ["xai"], ...extra }) });
  } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** makeClientFor(vendor, {pool, poolConfig}) over the three streaming surfaces, recording each request. */
export function scriptedClients(calls = [], implement = () => "export const ok = true;\n") {
  let n = 0;
  const answer = prompt => {
    if (/VERDICT/i.test(prompt)) return /exited 1\b/.test(prompt) ? "VERDICT: request_changes" : "VERDICT: approve";
    if (/TITLE:/i.test(prompt)) return "TITLE: fixture change";
    if (/RAN: nothing/i.test(prompt)) return "RAN: nothing";
    return implement(prompt);
  };
  const makeClientFor = (vendor, { pool = null, poolConfig = null } = {}) => {
    const note = (req, prompt) => { calls.push({ vendor, model: req.model, pool, poolConfig, prompt, effort: req.reasoning?.effort ?? req.output_config?.effort ?? null }); return answer(prompt); };
    return {
      responses: { inputTokens: { count: async () => ({ input_tokens: 1000 }) }, create: async req => {
        const text = note(req, typeof req.input === "string" ? req.input : req.input?.at(-1)?.content ?? ""), id = `fixture_${++n}`;
        return { async *[Symbol.asyncIterator]() {
          yield { type: "response.created", response: { id } };
          yield { type: "response.output_text.delta", delta: text };
          yield { type: "response.completed", response: { id, status: "completed", output_text: text, output: [{ type: "message", content: [{ type: "output_text", text }] }] } };
        } };
      } },
      messages: { create: async req => {
        const last = req.messages?.at(-1)?.content;
        const text = note(req, typeof last === "string" ? last : (last ?? []).map(p => p.text ?? "").join(""));
        return { async *[Symbol.asyncIterator]() {
          yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
          yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
          yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
          yield { type: "message_stop" };
        } };
      } },
      models: { countTokens: async () => ({ totalTokens: 1000 }), generateContentStream: async req => {
        const text = note(req, (req.contents?.at?.(-1)?.parts ?? []).map(p => p.text ?? "").join("") || String(req.contents ?? ""));
        return { async *[Symbol.asyncIterator]() { yield { candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] }; } };
      } },
    };
  };
  return makeClientFor;
}

export const seat = (vendor, model, extra = {}) => ({ vendor, model, pool: vendor, rank: 0, basis: "OPERATOR", why: "offline fixture", ...extra });
