// The per-model walk, extended to the agy CLI lane: the two seated models that the registry does not
// carry are judged by the lane's own terminal state. A fake `agy` executable stands in for the CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgyCliTurn } from "../src/board/agy-cli.mjs";
import { LANES } from "../src/config/models.mjs";

const FAKE = `#!/usr/bin/env node
const args = process.argv.slice(2), at = k => args[args.indexOf(k) + 1];
const status = process.env.FAKE_AGY_STATUS;
const out = e => process.stdout.write(JSON.stringify(e) + "\\n");
out({ event: "init", init: { agent: at("--agent"), model: at("--model") } });
out({ event: "step_update", step_update: { text_delta: "answer" } });
out({ event: "result", result: { ...(status === "omit" ? {} : { status }), response: "answer", num_turns: 1, conversation_id: "c1" } });
`;

function lane() {
  const repo = mkdtempSync(join(tmpdir(), "pantheon-agy-cli-"));
  const card = join(repo, ".agents", "agents", "pantheon-planner");
  mkdirSync(card, { recursive: true });
  writeFileSync(join(card, "agent.md"), "---\nname: pantheon-planner\n---\nplan\n");
  const cli = join(repo, "agy");
  writeFileSync(cli, FAKE);
  chmodSync(cli, 0o755);
  return { repo, cli };
}

for (const model of Object.keys(LANES.agy_cli)) {
  test(`agy CLI lane ${model}: SUCCESS accepted, any other terminal state refused`, async () => {
    const { repo, cli } = lane();
    const turn = () => runAgyCliTurn({ cli, repo, worktree: repo, role: "planner", model, prompt: "q", timeoutS: 30 });
    try {
      process.env.FAKE_AGY_STATUS = "SUCCESS";
      assert.equal((await turn()).text, "answer");
      for (const status of ["ERROR", "CANCELLED", "omit"]) {
        process.env.FAKE_AGY_STATUS = status;
        await assert.rejects(turn(), /agy CLI status/, `${model} must refuse ${status}`);
      }
    } finally { delete process.env.FAKE_AGY_STATUS; rmSync(repo, { recursive: true, force: true }); }
  });
}
