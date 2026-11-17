// A target repository for `pantheon-board.mjs` on fakes: one Ready item with its ticket, the scripted seat and
// cycle-reviewer modules the CLI loads (--clients, --turn; each review call is logged to reviews.log), and a
// status ledger whose signing keys are moved out of the repository (returned, for the caller to remove).
import { writeFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { openStatusLedger } from "../../../packages/ledger/status.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(join(HERE, "dispatch.mjs")).href;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

/** A repository with one Ready item and its ticket, the fake seat and reviewer modules, and its status ledger. */
export function boardFixture(repo, { item = "bound-item", ticket = {} } = {}) {
  writeFileSync(join(repo, "alpha.mjs"), "export const ok = false;\n");
  writeFileSync(join(repo, "verify.mjs"), 'import assert from "node:assert/strict"; import {ok} from "./alpha.mjs"; assert.equal(ok, true);\n');
  writeFileSync(join(repo, ".gitignore"), "outputs/\ncooldowns/\nboard/\nbundle/\nstore/\nagy.log\nfake-agy\n*.fixture.mjs\nreviews.log\n");
  mkdirSync(join(repo, "tickets"), { recursive: true });
  writeFileSync(join(repo, "tickets", `${item}.json`), JSON.stringify({
    schema: "ophanim.ticket/v1", item, slice: "the whole item: alpha.mjs exports ok = true",
    proposes: { state: "Resolved", basis: "alpha.mjs exports ok = true" },
    title: "alpha.mjs exports ok = true", goal: "Make alpha.mjs export `ok` as true.", question: "fixture",
    repo_root: ".", slot: "alpha", path: "alpha.mjs", copy: ["alpha.mjs", "verify.mjs"], acceptance_cmd: "node verify.mjs", difficulty: "easy",
    ...ticket,
  }, null, 2) + "\n");
  writeFileSync(join(repo, "clients.fixture.mjs"), `import { scriptedClients } from ${JSON.stringify(FIXTURE)};\nexport default scriptedClients();\n`);
  // Each cycle-review call is appended to reviews.log, so the test counts what a reviewer was actually asked.
  writeFileSync(join(repo, "turn.fixture.mjs"), `import { appendFileSync } from "node:fs";\nlet n = 0;\n` +
    `export default async ({ vendor, model }) => { appendFileSync(${JSON.stringify(join(repo, "reviews.log"))}, vendor + "\\n");\n` +
    "  return { text: '```json\\n{\"verdict\": \"approve\", \"findings\": []}\\n```', response_id: `cli_${vendor}_${++n}`, served_model: model }; };\n");
  const statusRoot = join(repo, "status", "ledger");
  openStatusLedger({ root: statusRoot });
  const keys = mkdtempSync(join(tmpdir(), "pantheon-bound-keys-"));
  chmodSync(keys, 0o700);
  for (const f of readdirSync(join(statusRoot, "keys"))) renameSync(join(statusRoot, "keys", f), join(keys, f));
  rmSync(join(statusRoot, "keys"), { recursive: true });
  openStatusLedger({ root: statusRoot, keys }).set({ item, title: "Bound", state: "Ready", basis: "nothing external awaited", checked: "2026-11-17" });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Fixture Owner");
  git(repo, "config", "user.email", "owner@example.invalid");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture base");
  return { statusRoot, keys };
}

