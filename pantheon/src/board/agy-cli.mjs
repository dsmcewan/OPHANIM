// The board's Antigravity turn uses the operator's CLI OAuth session. The SDK lane is a separate
// API-key transport and cannot consume an OAuth refresh token renamed to GEMINI_API_KEY.
import { spawnPromise } from "./spawn.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A QUOTA REFUSAL by Antigravity, read from what the CLI itself reported (its result event and its stderr): an HTTP
// 429, RESOURCE_EXHAUSTED, or a quota/rate-limit message. The CLI has no status code of its own, so the refusal is
// raised as status 429 with code `quota_exhausted` -- the shape packages/model-client classifyFailure classifies as
// quota -- and the dispatcher's quota failover acts on that classification, never on this text (owner direction
// 2026-11-17). The wording Antigravity prints for a spent quota is not documented in this repository: the pattern is
// the Gemini API's own (429 / RESOURCE_EXHAUSTED) plus the plain words, and anything it does not match stays an
// ordinary failure, which never reaches the metered API.
const QUOTA_TEXT = /\b429\b|RESOURCE_EXHAUSTED|quota[ _-]?(exceeded|exhausted|limit)|exceeded your (current )?quota|rate[ _-]?limit/i;
export function agyQuotaRefusal({ result = null, stderr = "" } = {}) {
  const said = [result?.status, result?.error, result?.error?.message, result?.error?.status, result?.error?.code, result?.message, stderr]
    .filter(v => typeof v === "string" || typeof v === "number").map(String).join("\n");
  const hit = said.match(QUOTA_TEXT);
  return hit ? { status: 429, code: "quota_exhausted", matched: hit[0] } : null;
}
const refused = (message, run, result) => {
  const quota = agyQuotaRefusal({ result, stderr: run.stderr ?? "" });
  return quota ? Object.assign(new Error(`${message}: Antigravity refused for quota ("${quota.matched}")`), { status: quota.status, code: quota.code, transport: "agy-cli" })
    : new Error(`${message} (inspect local CLI diagnostics)`);
};

export async function runAgyCliTurn({ cli, repo, worktree, role, model, prompt, timeoutS,
  schemaPath = null, onEvent = () => {} }) {
  if (!/^[a-z][a-z-]*$/.test(role)) throw new Error(`agy CLI invalid role ${role}`);
  const agent = `pantheon-${role}`;
  const cardPath = join(repo, ".agents", "agents", agent, "agent.md");
  if (!existsSync(cardPath)) throw new Error(`agy CLI role card ${cardPath} missing`);
  const card = readFileSync(cardPath, "utf8");
  const frontmatterEnd = card.indexOf("\n---\n", 4);
  const frontmatter = card.startsWith("---\n") && frontmatterEnd >= 0 ? card.slice(4, frontmatterEnd) : "";
  if (!frontmatter.split("\n").some(line => line === `name: ${agent}`)) {
    throw new Error(`agy CLI role card ${cardPath} does not declare name: ${agent}`);
  }
  const args = ["--agent", agent, "--model", model, "--add-dir", worktree, "--sandbox",
    "--output-format", "stream-json", "--print-timeout", `${timeoutS}s`];
  if (schemaPath) args.push("--json-schema", schemaPath);
  args.push("--print", prompt);

  // A child inheriting GEMINI_API_KEY could silently use the API-key route while appearing to
  // validate OAuth. Strip both Google API-key spellings at the subprocess boundary.
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;

  let init = null, result = null, toolCalls = 0, subagentCalls = 0, answerChars = 0;
  const report = ev => { try { onEvent(ev); } catch { /* telemetry is not the turn's authority */ } };
  const onStdoutLine = line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.event === "init") {
      init = event.init;
      report({ event: "seat.start", detail: `OAuth CLI agent ${init?.agent ?? "unknown"}, model ${init?.model ?? "unknown"}` });
    } else if (event.event === "step_update") {
      const step = event.step_update;
      if (step?.step_type === "tool" && step.state === "DONE") {
        toolCalls++;
        if (step.tool_name === "invoke_subagent") subagentCalls++;
        report({ event: "seat.tool", detail: step.tool_name ?? "unknown" });
      }
      if (step?.text_delta) {
        answerChars += step.text_delta.length;
        if (answerChars % 1000 < step.text_delta.length) report({ event: "seat.progress", detail: `${answerChars} response chars` });
      }
    } else if (event.event === "result") {
      result = event.result;
    }
  };

  const run = await spawnPromise(cli, args, { cwd: repo, env,
    timeout: (timeoutS + 15) * 1000, onStdoutLine });
  if (run.signal === "SIGTERM") throw new Error(`agy CLI timed out after ${timeoutS}s`);
  if (run.status !== 0) throw refused(`agy CLI exited ${run.status}; status ${result?.status ?? "missing"}`, run, result);
  // init echoes launch selection; it does not prove the CLI actually applied the role card.
  // The local frontmatter preflight above catches missing cards, while a live answered turn is
  // still needed before this transport can replace the SDK as the board default.
  if (init?.agent !== agent || init?.model !== model) {
    throw new Error(`agy CLI identity mismatch: expected ${agent}/${model}, got ${init?.agent ?? "none"}/${init?.model ?? "none"}`);
  }
  if (result?.status !== "SUCCESS") throw refused(`agy CLI status ${result?.status ?? "missing"}`, run, result);
  const text = typeof result.response === "string" ? result.response.trim() : "";
  const structured = result.structured_output;
  if (!Number.isInteger(result.num_turns) || result.num_turns < 1 || (!text && !structured)) {
    throw new Error("agy CLI returned no completed model turn (empty response or print timeout)");
  }
  return { text, structured_output: structured ?? null,
    response_id: result.conversation_id ?? null, usage: result.usage ?? null,
    tool_calls: toolCalls, subagent_calls: subagentCalls };
}
