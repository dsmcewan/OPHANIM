// THE SDK CONTRACT: what src/antigravity/ relies on, observed against the INSTALLED google-antigravity SDK and its
// bundled runtime. The real bridge (scripts/antigravity-bridge.py), the real SDK, the real runtime binary, the real
// controller (turn.mjs, gateway.mjs, subagents.mjs) and, where a command runs, the real verify jail. Only the PROVIDER
// is scripted (fixtures/fake-gemini.mjs on loopback): no network, no credential, no model. So these tests say what the
// installed SDK and runtime DO; they say nothing about what Google's models do.
//
// They need the SDK's python: PANTHEON_ANTIGRAVITY_PYTHON (or PANTHEON_AGY_PYTHON), else the default venv
// (~/.local/share/pantheon/venv-antigravity). Without it every test here is SKIPPED as UNVERIFIED, never passed:
//   python3 -m venv ~/.local/share/pantheon/venv-antigravity
//   ~/.local/share/pantheon/venv-antigravity/bin/pip install --require-hashes -r pantheon/scripts/antigravity-requirements.txt
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runAntigravitySdkTurn, sdkPython, BRIDGE_SCRIPT } from "../src/antigravity/turn.mjs";
import { SDK_CONFIG } from "../src/antigravity/config.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { startFakeGemini, fc, text, responsesIn, QUOTA, notFound } from "./fixtures/fake-gemini.mjs";
import { tempRepo } from "./fixtures/pipeline-stages.mjs";

const PY = sdkPython();
function sdkState() {
  if (PY.includes("/") && !existsSync(PY)) return { ok: false, why: `no python at ${PY} (set PANTHEON_ANTIGRAVITY_PYTHON)` };
  try {
    const id = JSON.parse(execFileSync(PY, [BRIDGE_SCRIPT, "--identity"], { encoding: "utf8", timeout: 60000 }));
    if (id.sdk?.status !== "installed") return { ok: false, why: `google-antigravity is not installed for ${PY}: ${id.sdk?.error ?? ""}` };
    return { ok: true, identity: id };
  } catch (e) { return { ok: false, why: `the bridge's --identity failed: ${String(e?.message ?? e).slice(0, 200)}` }; }
}
const SDK = sdkState();
const BWRAP = await sandboxAvailable("bwrap");
const KEY = "REAL-KEY-synthetic-contract-0123456789";
const CARBON = { vendor: "agy_google", model: "gemini-4-carbon", transport: "antigravity-sdk", effort: "high" };
const NEON = { vendor: "agy_google", model: "gemini-4-neon", transport: "antigravity-sdk" };
const isChild = system => system.includes(":subagent:");
const assignment = i => `Report every caller of parseTicket() under src/board with file and line (assignment ${i}).`;
const subs = (n, over = {}) => Array.from({ length: n }, (_, i) => ({ TypeName: "code-explorer", Role: `Explorer ${i + 1}`, Prompt: assignment(i + 1), ...over }));

const contract = (name, fn, { needsBwrap = false } = {}) => test(name, { timeout: 180000 }, async t => {
  if (!SDK.ok) { t.skip(`UNVERIFIED: ${SDK.why}`); return; }
  if (needsBwrap && !BWRAP.ok) { t.skip(`UNVERIFIED: bwrap is not usable here (${BWRAP.why})`); return; }
  await fn(t);
});

async function session(t, { decide, seat = CARBON, unit = {}, over = {}, models = null }) {
  const env = await tempRepo({ "README.md": "base\n", "src/u1/keep.mjs": "export const keep = 1;\n" });
  const upstream = await startFakeGemini({ decide, models });
  const control_dir = join(env.root, "control", "u1");
  mkdirSync(control_dir, { recursive: true });
  t.after(async () => { await upstream.close(); await env.cleanup(); });
  const admitted = [];
  const u = { unit_id: "u1", owned_paths: ["src/u1/**"], verify_cmd: "test -f src/u1/impl.mjs", allowed_subagents: ["code-explorer", "test-constructor"], ...unit };
  const run = () => runAntigravitySdkTurn({ seat, prompt: "Implement the unit.", worktree: env.repo, control_dir, unit: u, apiKey: KEY, upstream: upstream.url, python: PY,
    sandbox: BWRAP.ok ? { enabled: true } : { enabled: false, allowUnsandboxed: true }, admit: info => { admitted.push(info); }, timeoutS: 90, graceS: 3, ...over });
  const gen = () => upstream.requests.filter(r => r.verb);
  return { env, upstream, control_dir, run, admitted, gen };
}

contract("the installed SDK is the version this transport was qualified on", async () => {
  assert.equal(SDK.identity.sdk.distribution, SDK_CONFIG.sdk.distribution);
  assert.equal(SDK.identity.sdk.version, SDK_CONFIG.sdk.version, "another version must pass this file before config/antigravity-sdk.json names it");
  assert.ok(SDK.identity.harness?.bytes > 1e6, "the wheel carries its runtime binary");
});

contract("the runtime calls the Gemini API's streamGenerateContent over HTTP with the key in x-goog-api-key: the controller's key, never the runtime's token", async t => {
  const s = await session(t, { decide: () => ({ parts: [text("NOTE: nothing to do")] }) });
  const r = await s.run();
  const g = s.gen();
  assert.equal(g.length, 1);
  assert.match(g[0].path, /^\/v1beta\/models\/gemini-4-carbon:streamGenerateContent\?alt=sse$/);
  assert.equal(g[0].headers["x-goog-api-key"], KEY);
  assert.equal(g[0].body.generationConfig.thinkingConfig.thinkingLevel, "high", "the seat's thinking level is what the runtime sends");
  assert.equal(r.text, "NOTE: nothing to do");
  assert.deepEqual([r.served_model, r.served_model_source], ["gemini-4-carbon", "provider"]);
  assert.deepEqual(s.admitted.map(a => a.class), ["root"]);
  assert.equal(r.runtime.sdk.version, SDK_CONFIG.sdk.version);
  assert.ok(r.usage.total_token_count > 0);
});

contract("EXPLICIT HYDROGEN SELECTION FOR CHILD AGENTS: a Carbon implementer's subagents send their requests to gemini-4-hydrogen, each in its own session", async t => {
  const s = await session(t, { decide: ({ body, system, model }) => {
    if (isChild(system)) return { parts: [text(`child answer from ${model}`)], delayMs: 150 };
    return responsesIn(body) === 0 ? { parts: [fc("invoke_subagent", { Subagents: subs(2) })] } : { parts: [text("done")] };
  } });
  const r = await s.run();
  const g = s.gen();
  const parents = g.filter(x => !isChild(x.system)), children = g.filter(x => isChild(x.system));
  assert.ok(parents.length >= 2 && parents.every(x => x.model === "gemini-4-carbon"), "the implementer stays on Carbon");
  assert.equal(children.length, 2);
  assert.ok(children.every(x => x.model === "gemini-4-hydrogen"), `children ran on ${children.map(x => x.model).join(", ")}`);
  assert.equal(new Set(children.map(x => x.session)).size, 2, "each subagent has its own session id");
  assert.ok(!children.some(x => x.session === parents[0].session));
  // The controller's record of them: identity, lifecycle, usage and output, bound by assignment.
  assert.equal(r.subagents.admitted_total, 2);
  assert.deepEqual(r.subagents.instances.map(i => [i.type, i.model, i.status]), [["code-explorer", "gemini-4-hydrogen", "idle"], ["code-explorer", "gemini-4-hydrogen", "idle"]]);
  assert.ok(r.subagents.instances.every(i => i.trajectory_id && i.states.some(x => x.state === "RUNNING") && i.usage?.total_token_count > 0 && i.output?.bytes > 0), JSON.stringify(r.subagents.instances));
  assert.equal(r.subagents.unbound_trajectories.length, 0, "every child trajectory was attributed to an admitted subagent");
  assert.ok(r.subagents.peak_active >= 1 && r.subagents.peak_active <= 2);
  assert.deepEqual(r.gateway.sessions.filter(x => x.class === "subagent").map(x => [x.type, x.model, x.requests]), [["code-explorer", "gemini-4-hydrogen", 1], ["code-explorer", "gemini-4-hydrogen", 1]]);
  assert.equal(s.admitted.filter(a => a.class === "subagent").length, 2, "each subagent request was charged");
  assert.equal(r.capabilities.trajectory_events, true);
});

contract("the pin holds against the invocation: a tier or a model named on invoke_subagent is refused by the controller, and the retry still runs on Hydrogen", async t => {
  const s = await session(t, { decide: ({ body, system }) => {
    if (isChild(system)) return { parts: [text("child answer")] };
    const n = responsesIn(body);
    if (n === 0) return { parts: [fc("invoke_subagent", { Subagents: subs(1, { Model: "pro" }) })] };
    if (n === 1) return { parts: [fc("invoke_subagent", { Subagents: subs(1) })] };
    return { parts: [text("done")] };
  } });
  const r = await s.run();
  assert.deepEqual(r.subagents.rejections.map(x => x.code), ["SUBAGENT_MODEL_OVERRIDE"]);
  assert.equal(r.subagents.admitted_total, 1);
  assert.deepEqual(s.gen().filter(x => isChild(x.system)).map(x => x.model), ["gemini-4-hydrogen"]);
  // The refusal reached the model as the tool's result, so it could correct itself.
  assert.ok(s.gen().some(x => !isChild(x.system) && /SUBAGENT_MODEL_OVERRIDE/.test(JSON.stringify(x.body.contents))));
});

contract("the runtime's define_subagent tool is not offered, and a type the controller did not pin cannot be invoked: no clone of the implementer runs", async t => {
  const s = await session(t, { decide: ({ body, system }) => {
    if (isChild(system)) return { parts: [text("child answer")] };
    const n = responsesIn(body);
    if (n === 0) return { parts: [fc("invoke_subagent", { Subagents: [{ TypeName: "my-own-helper", Role: "Helper", Prompt: assignment(1) }] })] };
    return { parts: [text("done")] };
  } });
  const r = await s.run();
  const offered = s.gen().filter(x => !isChild(x.system))[0].body.tools.flatMap(x => (x.functionDeclarations ?? []).map(f => f.name));
  assert.ok(!offered.includes("define_subagent"), `offered: ${offered.join(", ")}`);
  assert.ok(offered.includes("invoke_subagent"));
  assert.equal(r.capabilities.define_subagent_disabled, true);
  assert.deepEqual(r.subagents.rejections.map(x => x.code), ["SUBAGENT_TYPE_NOT_PINNED"]);
  assert.deepEqual(s.gen().map(x => x.model).filter(m => m !== "gemini-4-carbon"), [], "nothing but the implementer's own requests reached the provider");
  assert.equal(s.gen().filter(x => x.session !== s.gen()[0].session).length, 0, "no second agent session ran on the implementer's model");
});

contract("CARBON NEVER EXCEEDS 8: nine subagents in one call are refused whole and recorded; eight are admitted and all eight run on Hydrogen", async t => {
  const s = await session(t, { decide: ({ body, system }) => {
    if (isChild(system)) return { parts: [text("child answer")], delayMs: 300 };
    const n = responsesIn(body);
    if (n === 0) return { parts: [fc("invoke_subagent", { Subagents: subs(9) })] };
    if (n === 1) return { parts: [fc("invoke_subagent", { Subagents: subs(8) })] };
    if (n === 2) return { parts: [fc("invoke_subagent", { Subagents: subs(1) })] };
    return { parts: [text("done")] };
  } });
  const r = await s.run();
  assert.deepEqual(r.subagents.rejections.map(x => [x.code, x.asked, x.live, x.ceiling]), [["SUBAGENT_LIMIT", 9, 0, 8], ["SUBAGENT_LIMIT", 1, 8, 8]]);
  assert.equal(r.subagents.admitted_total, 8);
  assert.ok(r.subagents.peak_active <= 8, `peak active ${r.subagents.peak_active}`);
  const children = s.gen().filter(x => isChild(x.system));
  assert.equal(new Set(children.map(x => x.session)).size, 8);
  assert.ok(children.every(x => x.model === "gemini-4-hydrogen"));
  assert.equal(r.gateway.subagent_sessions, 8);
});

contract("NEON NEVER EXCEEDS 4: a fifth subagent is refused and recorded; four run on Hydrogen", async t => {
  const s = await session(t, { seat: NEON, decide: ({ body, system }) => {
    if (isChild(system)) return { parts: [text("child answer")], delayMs: 200 };
    const n = responsesIn(body);
    if (n === 0) return { parts: [fc("invoke_subagent", { Subagents: subs(4) })] };
    if (n === 1) return { parts: [fc("invoke_subagent", { Subagents: subs(1) })] };
    return { parts: [text("done")] };
  } });
  const r = await s.run();
  assert.equal(r.subagents.ceiling, 4);
  assert.equal(r.subagents.admitted_total, 4);
  assert.deepEqual(r.subagents.rejections.map(x => [x.code, x.live, x.ceiling]), [["SUBAGENT_LIMIT", 4, 4]]);
  assert.ok(r.subagents.peak_active <= 4);
  const g = s.gen();
  assert.ok(g.filter(x => !isChild(x.system)).every(x => x.model === "gemini-4-neon"));
  assert.ok(!("thinkingLevel" in (g[0].body.generationConfig?.thinkingConfig ?? {})), "no thinking level is sent for a model that has none recorded");
  assert.equal(new Set(g.filter(x => isChild(x.system)).map(x => x.session)).size, 4);
});

contract("the implementer's writes go through the controller: an owned path lands, a path it does not own never does", async t => {
  const s = await session(t, { decide: ({ body }) => {
    const n = responsesIn(body);
    if (n === 0) return { parts: [fc("write_to_file", { TargetFile: `${s.env.repo}/src/u1/impl.mjs`, CodeContent: "export const id = 'u1';\n", Overwrite: false, Description: "the unit" })] };
    if (n === 1) return { parts: [fc("write_to_file", { TargetFile: `${s.env.repo}/OUTSIDE.md`, CodeContent: "pwned\n", Overwrite: false, Description: "not mine" })] };
    return { parts: [text("done")] };
  } });
  const r = await s.run();
  assert.equal(readFileSync(join(s.env.repo, "src/u1/impl.mjs"), "utf8"), "export const id = 'u1';\n");
  assert.equal(existsSync(join(s.env.repo, "OUTSIDE.md")), false, "the refused write never happened");
  assert.deepEqual(r.tool_log.map(x => [x.tool, x.allow, x.code]), [["create_file", true, null], ["create_file", false, "WRITE_REFUSED"]]);
});

contract("the implementer's one command is the unit's verify launcher, run in the verify jail; any other command is refused", async t => {
  const s = await session(t, { decide: ({ body }) => {
    const n = responsesIn(body);
    if (n === 0) return { parts: [fc("write_to_file", { TargetFile: `${s.env.repo}/src/u1/impl.mjs`, CodeContent: "export const id = 'u1';\n", Overwrite: false, Description: "the unit" })] };
    if (n === 1) return { parts: [fc("run_command", { CommandLine: "cat /etc/passwd", Cwd: s.env.repo, WaitMsBeforeAsync: 5000 })] };
    if (n === 2) return { parts: [fc("run_command", { CommandLine: join(s.control_dir, "pantheon-verify"), Cwd: s.env.repo, WaitMsBeforeAsync: 10000 })] };
    return { parts: [text("done")] };
  } });
  const r = await s.run();
  assert.deepEqual(r.tool_log.filter(x => x.tool === "run_command").map(x => [x.allow, x.code]), [[false, "COMMAND_REFUSED"], [true, null]]);
  const results = JSON.stringify(s.gen().at(-1).body.contents);
  assert.ok(!/root:x:0:0/.test(results), "the refused command did not run");
  assert.match(results, /exit code: 0|Exit code: 0|exited with code 0|"exitCode":0|Exit Code: 0/i, "the verify launcher ran and passed");
}, { needsBwrap: true });

// THE RUNTIME READS OTHER SPELLINGS OF A DECLARED ARGUMENT NAME (found by an independent review, 2026-11-19, on SDK
// 0.1.24: `commandline` and `commandLine` are read as CommandLine, `subagents` as Subagents, `workspace` as Workspace).
// A controller that judges `CommandLine` and lets `commandline` through has approved a call it never saw. So a call is
// decided only on EXACTLY the names the tool declares: any other key refuses the whole call, before the runtime acts.
contract("a tool call is decided on exactly the argument names the tool declares: a second spelling of CommandLine does not run a command the controller never judged", async t => {
  const s = await session(t, { decide: ({ body }) => {
    const n = responsesIn(body), launcher = join(s.control_dir, "pantheon-verify");
    if (n === 0) return { parts: [fc("write_to_file", { TargetFile: `${s.env.repo}/src/u1/impl.mjs`, CodeContent: "export const id = 'u1';\n", Overwrite: false, Description: "the unit" })] };
    // The approved command in the declared name, another command in a spelling the runtime also reads; both orders.
    if (n === 1) return { parts: [fc("run_command", { CommandLine: launcher, Cwd: s.env.repo, WaitMsBeforeAsync: 5000, commandline: "cat /etc/passwd" })] };
    if (n === 2) return { parts: [fc("run_command", { commandLine: "cat /etc/passwd", CommandLine: launcher, Cwd: s.env.repo, WaitMsBeforeAsync: 5000 })] };
    // A persistent terminal is not the one-shot verify launcher either.
    if (n === 3) return { parts: [fc("run_command", { CommandLine: launcher, Cwd: s.env.repo, WaitMsBeforeAsync: 5000, RunPersistent: true })] };
    if (n === 4) return { parts: [fc("run_command", { CommandLine: launcher, Cwd: s.env.repo, WaitMsBeforeAsync: 10000 })] };
    return { parts: [text("done")] };
  } });
  const r = await s.run();
  assert.deepEqual(r.tool_log.filter(x => x.tool === "run_command").map(x => [x.allow, x.code]), [[false, "ARGS_UNDECLARED"], [false, "ARGS_UNDECLARED"], [false, "COMMAND_REFUSED"], [true, null]]);
  const results = JSON.stringify(s.gen().at(-1).body.contents);
  assert.ok(!/root:x:0:0/.test(results), "no command ran under a spelling the controller did not judge");
  assert.match(results, /exit code: 0|Exit code: 0|exited with code 0|"exitCode":0|Exit Code: 0/i, "the verify launcher, asked for by its declared names alone, ran and passed");
}, { needsBwrap: true });

contract("the subagent governor cannot be shown one list and the runtime another: a second spelling of Subagents, or of an entry's field, refuses the whole call and no child runs", async t => {
  const s = await session(t, { decide: ({ body, system }) => {
    if (isChild(system)) return { parts: [text("a child's answer")] };
    const n = responsesIn(body);
    // One admitted entry in the declared name, nine in a spelling the runtime also reads (Carbon's ceiling is 8).
    if (n === 0) return { parts: [fc("invoke_subagent", { Subagents: subs(1), subagents: subs(9) })] };
    // A branched workspace under a spelling of Workspace, which the governor refuses under its declared name.
    if (n === 1) return { parts: [fc("invoke_subagent", { Subagents: subs(1, { workspace: "branch" }) })] };
    return { parts: [text("done")] };
  } });
  const r = await s.run();
  assert.deepEqual(r.tool_log.filter(x => x.tool === "invoke_subagent").map(x => [x.allow, x.code]), [[false, "ARGS_UNDECLARED"], [false, "ARGS_UNDECLARED"]]);
  assert.deepEqual([r.subagents.admitted_total, r.subagents.peak_live, r.subagents.peak_active, r.subagents.unbound_trajectories.length], [0, 0, 0, 0], "nothing was admitted and nothing ran unadmitted");
  assert.equal(r.gateway.subagent_sessions, 0, "no child session reached the provider");
  assert.equal(s.gen().filter(x => isChild(x.system)).length, 0);
}, { needsBwrap: true });

contract("the controller's table of declared argument names is what the installed runtime declares, tool for tool; three declared tools run with NO hook", async t => {
  const T = { toolAction: "probe", toolSummary: "probe" };
  const unhooked = [["manage_task", { Action: "list", ...T }], ["send_message", { Recipient: "nobody", Message: "hello", ...T }], ["manage_subagents", { Action: "list", ...T }]];
  const s = await session(t, { decide: ({ body, system }) => {
    if (isChild(system)) return { parts: [text("a child's answer")] };
    const n = responsesIn(body);
    return n < unhooked.length ? { parts: [fc(...unhooked[n])] } : { parts: [text("done")] };
  } });
  const r = await s.run();
  const table = SDK_CONFIG.tools;
  const decls = (s.gen()[0].body.tools ?? []).flatMap(x => x.functionDeclarations ?? x.function_declarations ?? []);
  const schemaOf = d => d.parameters ?? d.parametersJsonSchema ?? {};
  const names = schema => Object.keys(schema?.properties ?? {}).sort();
  const byDeclaredName = Object.fromEntries(Object.values(table.declared).map(spec => [spec.as, spec]));
  // Every tool the runtime offers the model is one the controller decides, or one it lists as running without a hook.
  // A tool an SDK upgrade adds fails here before any session trusts the table.
  assert.deepEqual(decls.map(d => d.name).sort(), [...Object.keys(byDeclaredName), ...table.unhooked].sort());
  for (const d of decls.filter(x => byDeclaredName[x.name])) {
    const spec = byDeclaredName[d.name], schema = schemaOf(d);
    assert.deepEqual(names(schema), [...Object.keys(spec.args), ...table.common].sort(), `${d.name}: the declared argument names`);
    for (const [key, nested] of Object.entries(spec.args).filter(([, v]) => Array.isArray(v))) {
      const inner = schema.properties[key];
      assert.deepEqual(names(inner.items ?? inner), [...nested].sort(), `${d.name}.${key}: the declared names inside it`);
    }
  }
  // OBSERVED, AND A LIMIT (register L-715): the runtime ran these three with no pre-tool hook, so the controller neither
  // decided nor recorded them. If a later SDK hooks them, this fails and the decision table must take them in.
  assert.deepEqual(r.tool_log.map(x => x.tool), [], "no decision was asked for manage_task, send_message or manage_subagents");
  assert.equal(responsesIn(s.gen().at(-1).body), unhooked.length, "and the runtime answered each call to the model all the same");
}, { needsBwrap: true });

contract("a stop cuts a session with subagents in flight, and nothing of it keeps running", async t => {
  const s = await session(t, { decide: ({ body, system }) => {
    if (isChild(system)) return { parts: [text("late")], delayMs: 60000 };
    return responsesIn(body) === 0 ? { parts: [fc("invoke_subagent", { Subagents: subs(2) })] } : { parts: [text("waiting")] };
  } });
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(new Error("STAGE_ELAPSED: stop")), 4000);
  await assert.rejects(runWith(s, { signal: ac.signal }), e => e.code === "ABORTED" && e.subagents.admitted_total === 2);
  assert.ok(Date.now() - t0 < 30000, "the stop did not wait for the subagents");
  const before = s.gen().length;
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(s.gen().length, before, "no request was made after the stop");
  function runWith(x, over) { return runAntigravitySdkTurn({ seat: CARBON, prompt: "Implement the unit.", worktree: x.env.repo, control_dir: x.control_dir, unit: { unit_id: "u1", owned_paths: ["src/u1/**"], verify_cmd: null, allowed_subagents: ["code-explorer"] },
    apiKey: KEY, upstream: x.upstream.url, python: PY, sandbox: BWRAP.ok ? { enabled: true } : { enabled: false, allowUnsandboxed: true }, timeoutS: 90, graceS: 3, ...over }); }
});

contract("the provider's refusals end the turn by their status: 429 is a quota failure after ONE request, 404 an unavailable model", async t => {
  const q = await session(t, { decide: () => QUOTA });
  await assert.rejects(q.run(), e => e.code === "quota_exhausted" && e.status === 429 && e.gateway.stop.provider_status === "RESOURCE_EXHAUSTED");
  assert.equal(q.gen().length, 1, "the runtime did not retry behind the controller's back");
  const u = await session(t, { decide: ({ model }) => notFound(model), over: { checkAvailability: false } });
  await assert.rejects(u.run(), e => e.code === "model_unavailable" && e.status === 404);
});

contract("structured output: a schema becomes the runtime's finish tool, and its arguments come back as structured_output", async t => {
  const schema = { type: "object", properties: { summary: { type: "string" }, files: { type: "array", items: { type: "string" } } }, required: ["summary", "files"] };
  const s = await session(t, { over: { schema }, decide: ({ body }) => {
    const tools = body.tools.flatMap(x => (x.functionDeclarations ?? []).map(f => f.name));
    assert.ok(tools.includes("finish"));
    return { parts: [{ functionCall: { name: "finish", args: { summary: "did it", files: ["src/u1/impl.mjs"] } } }] };
  } });
  const r = await s.run();
  assert.deepEqual(r.structured_output, { summary: "did it", files: ["src/u1/impl.mjs"] });
});

contract("the session budget stops a turn that would not end, and the stop reason is on the result", async t => {
  const s = await session(t, { over: { budget: { max_model_calls: 3, max_tool_calls: 50 } }, decide: () => ({ parts: [fc("view_file", { AbsolutePath: `${s.env.repo}/README.md` })] }) });
  const r = await s.run();
  assert.equal(r.stop_reason, "MAX_MODEL_CALLS_EXCEEDED");
  assert.ok(s.gen().length <= 4);
});

contract("nothing the runtime wrote holds the key or its session token", async t => {
  const s = await session(t, { decide: ({ body, system }) => {
    if (isChild(system)) return { parts: [text("child answer")] };
    return responsesIn(body) === 0 ? { parts: [fc("invoke_subagent", { Subagents: subs(1) })] } : { parts: [text("done")] };
  } });
  const r = await s.run();
  const token = /pantheon-gw-[0-9a-f]{48}/;
  const hits = [];
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (statSync(p).size < 50e6) { const b = readFileSync(p).toString("latin1"); if (b.includes(KEY) || token.test(b)) hits.push(p); } } };
  walk(s.control_dir); walk(s.env.repo);
  assert.deepEqual(hits, [], "the runtime's state, the control dir and the worktree hold neither");
  assert.ok(!JSON.stringify(r).includes(KEY) && !token.test(JSON.stringify(r)), "nor does the turn's record");
  assert.ok(readdirSync(join(s.control_dir, "run", "sdk-save")).length > 0, "the runtime's session state is in the control dir, outside the worktree");
});

// ---- THE READ-ONLY RESEARCH SESSION ON THE INSTALLED RUNTIME (owner direction 2026-11-20) --------------------------------
contract("A RESEARCH SESSION ON THE INSTALLED RUNTIME reads only: the model is offered no write, command or subagent tool; a read is recorded with the digest the controller saw; a write and a command it asks for all the same change nothing; the repository is read-only inside the jail", async t => {
  const ref = {};
  const s = await session(t, { over: { research: { system: "You are a research specialist. Read what the question needs and report it with its sources. You change nothing." } },
    decide: ({ body }) => {
      const n = responsesIn(body);
      if (n === 0) return { parts: [fc("view_file", { AbsolutePath: join(ref.repo, "README.md") })] };
      if (n === 1) return { parts: [fc("create_file", { TargetFile: join(ref.repo, "src/u1/impl.mjs"), CodeContent: "export const pwned = 1;\n" })] };
      if (n === 2) return { parts: [fc("run_command", { CommandLine: `touch ${join(ref.repo, "pwned-by-command")}` })] };
      return { parts: [text("REPORT: README.md says base")] };
    } });
  ref.repo = s.env.repo;
  const r = await s.run();
  const offered = s.gen()[0].body.tools.flatMap(x => (x.functionDeclarations ?? []).map(f => f.name));
  for (const tool of ["create_file", "edit_file", "run_command", "invoke_subagent", "define_subagent"]) assert.ok(!offered.includes(tool), `${tool} is offered to a research session (offered: ${offered.join(", ")})`);
  assert.ok(offered.includes("view_file"), `offered: ${offered.join(", ")}`);
  // The read: allowed, and recorded with the bytes the controller saw at that moment.
  const read = r.tool_log.find(x => x.tool === "view_file");
  assert.deepEqual([read.allow, read.who, read.sources.map(x => [x.path, x.kind, x.bytes])], [true, "researcher", [["README.md", "file", 5]]]);
  assert.match(read.sources[0].sha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(r.examined.map(x => [x.tool, x.path, x.sha256]), [["view_file", "README.md", read.sources[0].sha256]]);
  // The write and the command: whatever the runtime did with a tool it was never offered, nothing was allowed and nothing changed.
  assert.deepEqual(r.tool_log.filter(x => x.tool !== "view_file" && x.tool !== "finish").filter(x => x.allow), [], JSON.stringify(r.tool_log));
  assert.equal(existsSync(join(s.env.repo, "src/u1/impl.mjs")), false);
  assert.equal(existsSync(join(s.env.repo, "pwned-by-command")), false);
  assert.equal(readFileSync(join(s.env.repo, "README.md"), "utf8"), "base\n");
  assert.equal(execFileSync("git", ["-C", s.env.repo, "status", "--porcelain"], { encoding: "utf8" }), "", "the repository is as it was");
  assert.deepEqual(r.subagents.instances, []);
  assert.deepEqual([r.served_model, r.requested_model], ["gemini-4-carbon", "gemini-4-carbon"]);
  if (BWRAP.ok) assert.deepEqual(r.sandbox.binds.filter(b => b.path === s.env.repo).map(b => b.mode), ["ro"], "the repository's bind in the jail is read-only");
});
