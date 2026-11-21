#!/usr/bin/env node
// A stand-in for pantheon/scripts/run-review.mjs --via subscription, for pantheon/tests/review-pr.test.mjs. It parses
// the runner's arguments, appends what it saw to $FAKE_RR_PROBE (one JSON line at start, one at end), and leaves the
// files the real runner leaves in --out, per the behaviour $FAKE_RR names for its lab ({"<lab>": "<behaviour>"}).
// It reaches no CLI, no provider and no network.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ args: process.argv.slice(2), strict: false, options: {
  via: { type: "string" }, "review-dir": { type: "string" }, assignment: { type: "string" }, commit: { type: "string" },
  "max-wall-s": { type: "string" }, "telos-root": { type: "string" }, out: { type: "string" }, reviewer: { type: "string" },
  "dry-run": { type: "boolean" }, "grok-state-dir": { type: "string" },
} });
const LABS = { google: "Google", openai: "OpenAI", xai: "xAI" };
const [labKey, model] = (a.reviewer ?? "xai:grok-4.7").split(":");
const behaviour = JSON.parse(process.env.FAKE_RR ?? "{}")[labKey] ?? "complete";
const sha = s => createHash("sha256").update(s).digest("hex");
const probe = rec => process.env.FAKE_RR_PROBE && appendFileSync(process.env.FAKE_RR_PROBE, JSON.stringify(rec) + "\n");

// What a reviewer jail could read of the checkout (--ro-bind / /): any findings-* path under it.
const findingsIn = root => {
  const hits = [];
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === ".git") continue; const p = join(d, e.name); if (/^findings-/.test(e.name)) hits.push(relative(root, p)); if (e.isDirectory()) walk(p); } };
  walk(root);
  return hits.sort();
};
const stage = dirname(a.out);
probe({ at: "start", lab: labKey, t: Date.now(), argv: process.argv.slice(2), cwd_findings: findingsIn(process.cwd()),
  stage, stage_mode: statSync(stage).mode & 0o777, out_mode: statSync(a.out).mode & 0o777, stage_entries: readdirSync(stage).sort() });
const end = code => { probe({ at: "end", lab: labKey, t: Date.now() }); process.exit(code); };

if (a["dry-run"]) {
  process.stdout.write(JSON.stringify({ schema: "ophanim.review-run-plan-subscription/v1", dry_run: true, lab: LABS[labKey], requested_model: model, commit: a.commit }) + "\n");
  end(behaviour === "dry-fail" ? 1 : 0);
}
if (behaviour === "hang") { setInterval(() => {}, 1000); }
else {
  const dir = join(process.cwd(), a["review-dir"]);
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  const assignmentFile = readdirSync(dir).find(f => /^\d-.*\.md$/.test(f));
  const prompt = {
    readme_sha256: behaviour === "wrongbrief" ? "0".repeat(64) : sha(readme),
    assignment_sha256: sha(readFileSync(join(dir, assignmentFile), "utf8")),
    harness_cli_template: { path: `${a["review-dir"]}/HARNESS-cli.md`, sha256: sha(readFileSync(join(dir, "HARNESS-cli.md"), "utf8")) },
  };
  const status = ["exit3", "gatefail-exit0"].includes(behaviour) ? "incomplete" : "complete";
  const gate = status === "complete" ? { ok: true, reasons: [] } : { ok: false, reasons: ["no test command ran although the testing limit allows tests"] };
  const transcript = { schema: "ophanim.review-transcript/v2-subscription", via: "subscription", transport: { xai: "grok-cli", google: "agy-cli", openai: "codex-sdk" }[labKey],
    assignment: Number(a.assignment), lab: LABS[labKey], requested_model: behaviour === "wrongmodel" ? "another-model" : model, commit: behaviour === "wrongcommit" ? "f".repeat(40) : a.commit, prompt, status,
    stop_reason: status === "complete" ? "final answer" : "coverage gate: no test command ran", coverage: { source_reads: 9, denied_reads: 0, tests_run: status === "complete" ? 2 : 0, tests_allowed: true, tests_refused: null, method: "fake" },
    coverage_gate: gate, review_tests: { files: [{ path: ".review-tests/stop.test.mjs" }] },
    // The codex transport's tests are relayed (relay.mjs): one request, run by the runner in its verify jail, concluded on.
    ...(labKey === "openai" ? { test_relay: { schema: "ophanim.review-test-relay/v1", counts: { requested: 1, run: 1, ran_in_jail: 1, refused: 0, not_run: 0, concluded: 1, unconcluded: [] },
      requests: [{ id: "R1", command: "/c/pantheon-test .review-tests/stop.test.mjs", requested_by: { transport: "codex-sdk", lab: "OpenAI", model, thread_id: "thread-1", turn: 1 }, decision: "run",
        why: "node --test on 1 allowed test file(s)", executed_by: { runner: "pantheon/scripts/run-review.mjs (the runner process, outside the reviewer's sandbox)", launcher: "pantheon-test", jail: "the verify jail", commit: a.commit },
        result: { exit_code: 0, killed_for: null, jail_refused: false, duration_ms: 40, output_sha256: "e".repeat(64), output_tail: "pass 1" }, reviewer_conclusion: "FAKE-RELAY-CONCLUSION" }] } } : {}) };
  const sections = [
    "## Findings", "1. holds (ophanim/operate/scheduler.mjs:1)",
    "## Tests run", "- node --test .review-tests/stop.test.mjs: exit 0",
    ...(behaviour === "nosections" ? [] : ["## Unresolved questions", "- FAKE-UNRESOLVED-MARKER"]),
    "## Blockers for merging", "none", `Model: ${model}`,
  ];
  const findings = ["<!-- Written by pantheon/scripts/run-review.mjs (--via subscription). -->", `- status: ${status}`, "<!-- reviewer's final message, verbatim, follows -->", "", ...sections, ""].join("\n");
  mkdirSync(a.out, { recursive: true });
  if (behaviour !== "nofiles" && behaviour !== "refused") {
    writeFileSync(join(a.out, `findings-${a.assignment}-${LABS[labKey].toLowerCase()}.md`), findings);
    writeFileSync(join(a.out, `findings-${a.assignment}-${LABS[labKey].toLowerCase()}.transcript.json`), JSON.stringify(transcript, null, 2));
  }
  if (behaviour === "refused") { process.stderr.write("run-review: refused: codex login status does not report a ChatGPT sign-in\n"); end(1); }
  end(behaviour === "exit3" ? 3 : 0);
}
