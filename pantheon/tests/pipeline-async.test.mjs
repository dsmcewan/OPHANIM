// Async, agy-style MULTI-TURN worker execution: the implementer turn is a real child process (a stand-in for the
// agy CLI) that writes files in its cwd over several turns. The controller must never block the event loop on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runPipeline } from "../src/pipeline/index.mjs";
import { tempRepo, seats, unit, scripted, sh, PLANNER } from "./fixtures/pipeline-stages.mjs";

// The stand-in CLI: three "turns" 120 ms apart, each writing one file of the unit and printing a turn line.
const CLI = `
const fs = require("node:fs"), id = process.argv[1];
const files = [["types.mjs", "export const T = 1;\\n"], ["impl.mjs", "import { T } from './types.mjs';\\nexport const v = T + 1;\\n"], ["impl.test.mjs", "import { v } from './impl.mjs';\\nif (v !== 2) process.exit(1);\\n"]];
fs.mkdirSync("src/" + id, { recursive: true });
let n = 0;
const turn = () => { const [f, text] = files[n++]; fs.writeFileSync("src/" + id + "/" + f, text); console.log(JSON.stringify({ turn: n, wrote: f })); if (n < files.length) setTimeout(turn, 120); else console.log(JSON.stringify({ served_model: "gemini-4-hydrogen" })); };
setTimeout(turn, 120);
`;
const agyTurn = spans => args => new Promise((resolve, reject) => {
  const span = { unit_id: args.unit_id, t0: Date.now(), t1: null, turns: 0 };
  spans.push(span);
  const child = spawn(process.execPath, ["-e", CLI, args.unit_id], { cwd: args.cwd, env: { ...process.env, ...args.env }, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.on("error", reject);
  child.on("close", code => {
    span.t1 = Date.now();
    if (code !== 0) return reject(new Error(`cli exited ${code}`));
    const lines = out.trim().split("\n").map(l => JSON.parse(l));
    span.turns = lines.filter(l => l.turn).length;
    resolve({ text: out, served_model: lines.at(-1).served_model, served_model_source: "cli" });
  });
});

test("two units, each a multi-turn child process, run concurrently while the event loop keeps ticking", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const plan = ["a", "b"].map(id => unit(id, { verify_cmd: `node src/${id}/impl.test.mjs` }));
  const spans = [], s = scripted({ plan, implement: agyTurn(spans) });
  // A 10 ms timer: if the controller blocked on a child (a synchronous spawn) for the ~360 ms the CLI runs, the
  // largest gap between two ticks would be that long.
  const ticks = []; const timer = setInterval(() => ticks.push(Date.now()), 10);
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: s.turns, dir: env.dir, planner: PLANNER });
  clearInterval(timer);
  assert.equal(out.status, "completed");
  const [a, b] = ["a", "b"].map(id => spans.find(x => x.unit_id === id));
  assert.deepEqual([a.turns, b.turns], [3, 3]);
  assert.ok(a.t1 - a.t0 >= 300 && b.t1 - b.t0 >= 300, "the stand-in CLI did not take several turns");
  assert.ok(a.t0 < b.t1 && b.t0 < a.t1, "the two workers did not overlap in time");
  const during = ticks.filter(x => x >= Math.min(a.t0, b.t0) && x <= Math.max(a.t1, b.t1));
  assert.ok(during.length >= 10, `only ${during.length} timer ticks while the workers ran: the event loop was blocked`);
  const all = ticks.filter(x => x >= Math.min(a.t0, b.t0));
  const gap = Math.max(...all.slice(1).map((x, i) => x - all[i]));
  assert.ok(gap < 250, `the event loop stalled for ${gap} ms during the run`);
  for (const id of ["a", "b"]) {
    assert.deepEqual(out.units[id].attempts[0].changed.map(c => c.path), [`src/${id}/impl.mjs`, `src/${id}/impl.test.mjs`, `src/${id}/types.mjs`]);
    assert.deepEqual([out.units[id].attempts[0].requested_model, out.units[id].attempts[0].served_model, out.units[id].attempts[0].served_model_source], ["gemini-4-hydrogen-medium", "gemini-4-hydrogen", "cli"]);
    assert.match(await sh(`git show ${out.integration.branch}:src/${id}/impl.mjs`, env.repo), /T \+ 1/);
  }
});

test("a worker process that dies is a failed attempt whose partial writes are discarded; the run continues", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const plan = [unit("a")];
  const s = scripted({ plan, implement: (args, n) => new Promise((resolve, reject) => {
    const script = n === 1 ? "mkdir -p src/a && echo half > src/a/partial.mjs && exit 7" : "mkdir -p src/a && echo ok > src/a/impl.mjs";
    const c = spawn("sh", ["-c", script], { cwd: args.cwd, stdio: "ignore" });
    c.on("close", code => code === 0 ? resolve({ text: "ok", served_model: "gemini-4-hydrogen" }) : reject(new Error(`cli exited ${code}`)));
  }) });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: s.turns, dir: env.dir, planner: PLANNER });
  assert.deepEqual(out.units.a.attempts.map(x => [x.status, x.code]), [["failed", "TURN_FAILED"], ["written", null]]);
  assert.deepEqual(out.units.a.attempts[1].changed.map(c => c.path), ["src/a/impl.mjs"]);
  assert.equal(out.status, "completed");
  assert.match(await sh(`git ls-tree -r --name-only ${out.integration.branch}`, env.repo), /^README\.md\nsrc\/a\/impl\.mjs\n$/);
});

test("no pipeline module uses a synchronous child process", () => {
  const dir = new URL("../src/pipeline/", import.meta.url);
  const files = readdirSync(dir).filter(f => f.endsWith(".mjs")).sort();
  assert.ok(files.length >= 8 && files.includes("index.mjs") && files.includes("git.mjs"));
  for (const f of files) {
    const src = readFileSync(join(dir.pathname, f), "utf8");
    for (const banned of ["spawnSync", "execSync", "execFileSync"]) assert.equal(src.includes(banned), false, `${f} mentions ${banned}`);
  }
  // Only git.mjs may start a process at all, and it does so with spawn.
  const users = files.filter(f => /node:child_process/.test(readFileSync(join(dir.pathname, f), "utf8")));
  assert.deepEqual(users, ["git.mjs"]);
});
