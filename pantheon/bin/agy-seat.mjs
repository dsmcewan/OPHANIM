#!/usr/bin/env node
// A GOVERNED STANDALONE RUN OF THE PYTHON ANTIGRAVITY SDK SEAT (register L-151; docs/billing-policy.md). Running
// scripts/agy-seat.py directly makes no metered request at all: without a controller-issued capability it refuses before
// any Agent exists, whatever key the environment holds. This launcher IS such a controller, over the SAME mechanism the
// board uses -- the loopback metering relay (src/route/gemini-relay.mjs) and the central policy's spendGemini -- with no
// billing logic of its own:
//
//   node pantheon/bin/agy-seat.mjs --gemini-api-primary N --gemini-usage FILE [--python PY] -- <agy-seat.py arguments>
//
//   --gemini-api-primary N  the budget of billed Gemini requests (cumulative over FILE); absent: primary execution is OFF and
//                           the seat is refused before it is spawned (GEMINI_PRIMARY_DISABLED). No key or variable enables it.
//   --gemini-usage FILE     the persistent usage record the budget is counted from (required when enabled; one JSON line per
//                           admitted request, appended and fsynced before it is sent; shared by every process using FILE,
//                           under its lock). The outcome of each request is appended to FILE.outcomes.jsonl, never counted.
//   --python PY             the interpreter with google-antigravity (default PANTHEON_AGY_PYTHON, else the board's venv).
//   after `--`              agy-seat.py's own arguments (--role, --workspace, --brief, --out, --model, --max-model-calls, ...).
//                           --max-model-calls (default 40) is also the relay session's maximum request count.
//
// The real GEMINI_API_KEY stays in THIS process (the relay forwards with it); the seat gets the relay's capability and a
// HOME of its own under --out, and no credential. Exit: the seat's own exit code; 2 for a refusal before the spawn (the
// policy, a malformed flag, Vertex, no key). One JSON line on stderr and <out>/relay-session.json report the session.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { billingFlagsFromArgv, billingRecord, geminiAdmission, geminiBilling, geminiUsageFile } from "../src/route/gemini-billing.mjs";
import { startGeminiRelay, relayUpstreamOf, RELAY_VERTEX_UNSUPPORTED } from "../src/route/gemini-relay.mjs";
import { agySdkEnvOf } from "../src/board/agy-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAT = resolve(HERE, "..", "scripts", "agy-seat.py");
const say = obj => process.stderr.write(JSON.stringify({ launcher: "agy-seat.mjs", ...obj }) + "\n");
const refuseEarly = (code, why) => { say({ ok: false, refused: { code, why, provider_requests: 0 } }); process.exit(2); };

let parsed;
try { parsed = billingFlagsFromArgv(process.argv.slice(2)); }
catch (e) { refuseEarly(e.code ?? "GEMINI_BILLING_INVALID", String(e.message)); }
const sep = parsed.argv.indexOf("--");
const own = sep < 0 ? parsed.argv : parsed.argv.slice(0, sep), seatArgs = sep < 0 ? [] : parsed.argv.slice(sep + 1);
const opt = name => { const i = own.indexOf(name); return i >= 0 ? own[i + 1] : undefined; };
const seatOpt = name => { const i = seatArgs.indexOf(name); return i >= 0 ? seatArgs[i + 1] : undefined; };
const unknown = own.filter((a, i) => a.startsWith("--") && a !== "--python" && own[i - 1] !== "--python");
if (unknown.length) refuseEarly("USAGE", `unknown option(s) ${unknown.join(", ")}; agy-seat.py's own arguments go after --`);
let billing;
try { billing = geminiBilling({ policy: parsed.policy, ledger: parsed.usage ? geminiUsageFile(resolve(parsed.usage)) : null }); }
catch (e) { refuseEarly(e.code ?? "GEMINI_BILLING_INVALID", String(e.message)); }
const model = seatOpt("--model") ?? "gemini-3.7-flash", role = seatOpt("--role") ?? null, out = seatOpt("--out");
const maxRequests = Number(seatOpt("--max-model-calls") ?? 40);
if (!out) refuseEarly("USAGE", "agy-seat.py's --out is required (after --)");
if (!(Number.isSafeInteger(maxRequests) && maxRequests > 0)) refuseEarly("USAGE", "--max-model-calls is a positive integer");
// THE UP-FRONT CHECK, as the board's: refused before anything is spawned when primary execution is off or its budget spent.
const spend = { kind: "primary", vendor: "agy_google", model, purpose: "agy-seat standalone", role, transport: "sdk" };
try { geminiAdmission(billing, spend); }
catch (e) { say({ ok: false, refused: { code: e.code, why: e.message, provider_requests: 0 }, billing: billingRecord(billing) }); process.exit(2); }
if (process.env.PANTHEON_AGY_VERTEX_PROJECT) refuseEarly(RELAY_VERTEX_UNSUPPORTED, "PANTHEON_AGY_VERTEX_PROJECT asks for Vertex; the metering relay forwards Gemini API requests only");
if (!process.env.GEMINI_API_KEY) refuseEarly("GEMINI_RELAY_NO_CREDENTIAL", "GEMINI_API_KEY is not in this launcher's environment (the relay holds it; the seat never does)");
const python = opt("--python") ?? process.env.PANTHEON_AGY_PYTHON ?? join(homedir(), "Projects", "agentic-pipeline", "sdk", ".venv-antigravity", "bin", "python");
if (!existsSync(python)) refuseEarly("USAGE", `python absent at ${python} (--python or PANTHEON_AGY_PYTHON)`);

const relay = await startGeminiRelay({ apiKey: process.env.GEMINI_API_KEY, upstream: relayUpstreamOf(process.env),
  outcomes: parsed.usage ? `${resolve(parsed.usage)}.outcomes.jsonl` : null });
const session = relay.openSession({ billing, spend: { vendor: "agy_google", purpose: spend.purpose, role }, maxRequests,
  lineage: { launcher: "bin/agy-seat.mjs", pid: process.pid, seat: { vendor: "agy_google", model, role } } });
const home = join(resolve(out), "home"); mkdirSync(home, { recursive: true });
const args = seatArgs.includes("--max-model-calls") ? seatArgs : [...seatArgs, "--max-model-calls", String(maxRequests)];
const env = agySdkEnvOf(process.env, { capability: session.env, home }).env;
const child = spawn(python, [SEAT, ...args], { env, stdio: ["ignore", "inherit", "inherit"] });
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopping = true; child.kill("SIGTERM"); });
const code = await new Promise(r => child.on("exit", (c, s) => r(c ?? (s ? 128 : 1))));
session.close();
await relay.close();
const report = { ok: code === 0, exit: code, stopped: stopping, relay: session.summary(), billing: billingRecord(billing) };
try { writeFileSync(join(resolve(out), "relay-session.json"), JSON.stringify(report, null, 1) + "\n"); } catch { /* the stderr line still carries it */ }
say(report);
process.exit(code);
