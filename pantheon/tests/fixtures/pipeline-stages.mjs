// Fixture for tests/pipeline-*.test.mjs: a real temporary git repository, injected seats, and SCRIPTED turns.
// No network, no live model. (fixtures/pipeline.mjs is the older lifecycle fixture and is not touched.)
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const sh = (cmd, cwd) => new Promise((resolve, reject) => {
  const c = spawn("sh", ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { err += d; });
  c.on("close", code => code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err}`)));
});
export const write = async (root, rel, text) => { await mkdir(dirname(join(root, rel)), { recursive: true }); await writeFile(join(root, rel), text); };
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** {root, repo, dir, cleanup}: `repo` has one commit on `main`; `dir` is the run directory (outside the repo). */
export async function tempRepo(files = { "README.md": "base\n" }) {
  const root = await mkdtemp(join(tmpdir(), "pantheon-pipeline-"));
  const repo = join(root, "repo"), dir = join(root, "run");
  await mkdir(repo);
  for (const [p, t] of Object.entries(files)) await write(repo, p, t);
  await sh("git init -q -b main . && git -c user.name=t -c user.email=t@t.invalid -c commit.gpgsign=false add -A && git -c user.name=t -c user.email=t@t.invalid -c commit.gpgsign=false commit -q -m base", repo);
  return { root, repo, dir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export const LUNA = { vendor: "openai", model: "gpt-6-luna" }, SOL = { vendor: "openai", model: "gpt-6-sol" }, ASTRA = { vendor: "openai", model: "gpt-6-astra" };
export const HYDROGEN = ["medium", "high", "xhigh"].map(t => ({ vendor: "agy_google", model: `gemini-4-hydrogen-${t}`, thinking: t }));
export const GROK = { vendor: "xai", model: "grok-4.5" };
export const PLANNER = { vendor: "anthropic", model: "claude-opus-5", served_model: "claude-opus-5" };

export const seats = (over = {}) => ({
  dispatcher: () => ({ ...LUNA }),
  implementer: () => ({ seat: { ...HYDROGEN[0] }, ladder: HYDROGEN.map(s => ({ ...s })) }),
  subagent: () => ({ ...GROK }),
  reviewerLadder: () => [LUNA, SOL, ASTRA].map(s => ({ ...s })),
  ...over,
});

export const unit = (unit_id, over = {}) => ({
  unit_id, depends_on: [], owned_paths: [`src/${unit_id}/**`], difficulty: "medium", specialist_role: "node-esm-library-engineer",
  allowed_subagents: [], verify_cmd: `test -f src/${unit_id}/impl.mjs`, invariants: [`src/${unit_id}/impl.mjs exists`], ...over,
});

export const RUBRIC = ["the verify command passes", "only owned paths are changed"];
const approve = rubric => ({ verdict: "approve", criteria: rubric.map(criterion => ({ criterion, met: true, evidence: "diff and verify output" })), findings: [] });
export const reject = (rubric, findings = ["the change is wrong: case X fails"]) => ({ verdict: "request_changes", criteria: rubric.map((criterion, i) => ({ criterion, met: i !== 0, evidence: "see finding" })), findings });
export { approve };

/**
 * Scripted turns. Each role's script is (args, n) -> the answer (an object is JSON-encoded; a {text, served_model}
 * object is returned as is), where n counts that role's calls from 1. Every call is recorded in `calls`.
 * Defaults: the dispatcher keeps the planned difficulty and answers RUBRIC; the implementer writes src/<id>/impl.mjs;
 * the reviewer approves iff the controller's verify result in its prompt is "exited 0".
 */
export function scripted({ plan = [], dispatch, implement, review, subagent, rubric = RUBRIC } = {}) {
  const calls = [], count = {};
  const by = new Map(plan.map(u => [u.unit_id, u]));
  const wrap = (role, fn) => async args => {
    const n = count[role] = (count[role] ?? 0) + 1;
    const call = { role, n, unit_id: args.unit_id, vendor: args.vendor, model: args.model, cwd: args.cwd ?? null, extra: args.extra, sandbox: args.sandbox, prompt: args.prompt, attempt: args.attempt, t0: Date.now(), t1: null };
    calls.push(call);
    try {
      const a = await fn(args, n);
      if (a && typeof a === "object" && typeof a.text === "string") return a;
      return { text: typeof a === "string" ? a : JSON.stringify(a), served_model: args.model, served_model_source: "scripted" };
    } finally { call.t1 = Date.now(); }
  };
  const defaults = {
    dispatch: args => ({ unit_id: args.unit_id, cohesive: true, specialist_role: "node-esm-library-engineer", difficulty: by.get(args.unit_id)?.difficulty ?? "hard", rubric, notes: "" }),
    implement: async args => { await write(args.cwd, `src/${args.unit_id}/impl.mjs`, `export const id = ${JSON.stringify(args.unit_id)};\n`); return "done"; },
    review: args => /RESULT: exited 0\n/.test(args.prompt) ? approve(rubric) : reject(rubric, ["verify failed"]),
    subagent: () => "an answer",
  };
  return { calls, turns: {
    dispatcher: wrap("dispatcher", dispatch ?? defaults.dispatch), implementer: wrap("implementer", implement ?? defaults.implement),
    reviewer: wrap("reviewer", review ?? defaults.review), subagent: wrap("subagent", subagent ?? defaults.subagent) } };
}

/**
 * One raw HTTP request to a shim: over its Unix socket (`a2a.socket`), else to `a2a.url`. Resolves {status, body}
 * with `body` parsed as JSON when it is JSON (else the text). Rejects when the endpoint is gone.
 */
export function raw(a2a, { method = "POST", path = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const target = a2a.socket ? { socketPath: a2a.socket } : (() => { const u = new URL(a2a.url); return { host: u.hostname, port: u.port }; })();
    const req = httpRequest({ ...target, path, method, headers: { ...(body !== null ? { "content-length": Buffer.byteLength(body) } : {}), ...headers } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let parsed = text; try { parsed = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

/** POST one A2A message/send to a unit's shim (over its socket). Returns {status, body}. */
export async function ask(a2a, { role, unit_id, text = "a question", method = "message/send", token = a2a.token, params } = {}) {
  return raw(a2a, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? { message: { role: "user", parts: [{ kind: "text", text }], metadata: { subagent_role: role, unit_id } } } }) });
}
