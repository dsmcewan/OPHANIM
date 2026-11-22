#!/usr/bin/env node
// A runner for pantheon/tests/review-pr.test.mjs's xAI SDK route: `--via api` runs the REAL API runner
// (src/review-runner/index.mjs main) with a SCRIPTED xAI SDK client in place of `new OpenAI(...)`; `--via subscription`
// is the stand-in subscription runner (review-pr-fake-runner.mjs). The client's responses come from $FAKE_XAI_STEPS, a
// JSON list of completions ({"throw": {...}} raises an SDK-shaped error instead). No CLI, no provider and no network.
import { appendFileSync } from "node:fs";

const via = process.argv[process.argv.indexOf("--via") + 1];
if (via !== "api") {
  await import("./review-pr-fake-runner.mjs");
} else {
  const { main } = await import("../../src/review-runner/index.mjs");
  const steps = JSON.parse(process.env.FAKE_XAI_STEPS ?? "[]");
  let n = 0;
  const probe = rec => process.env.FAKE_RR_PROBE && appendFileSync(process.env.FAKE_RR_PROBE, JSON.stringify(rec) + "\n");
  probe({ at: "start", lab: "xai", t: Date.now(), argv: process.argv.slice(2) });
  const xaiClient = opts => {
    probe({ at: "client", opts: { ...opts, apiKey: opts.apiKey ? "<set>" : null } });
    return { chat: { completions: { create: async () => {
      const s = steps[n++];
      if (!s) throw new Error(`fake xAI SDK: no scripted response for call ${n}`);
      if (s.throw) throw Object.assign(new Error(s.throw.message), s.throw);
      return s;
    } } } };
  };
  const code = await main(process.argv.slice(2), { repoRoot: process.cwd(), env: process.env, xaiClient });
  probe({ at: "end", lab: "xai", t: Date.now(), sdk_calls: n });
  process.exit(code);
}
