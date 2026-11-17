// A SINGLE-TURN seat served through Antigravity (the `agy` CLI lane), for the seats that are not inside a board run:
// the planner, the plan and change reviewers, and the validator. Used by liveTurn (live.mjs) for a seat whose model
// is a declared Antigravity lane (config/lanes.json, transport agy-cli); such a name is not a Gemini API id.
//
// Owner direction 2026-11-17:
//   - Antigravity serves Gemini models only: any other lab is refused before the CLI is launched;
//   - Antigravity returns no serving model. The model is a required input (and runAgyCliTurn fails when the model the
//     CLI reports at start is not the one asked for), so the answer carries that input as its model, marked
//     served_model_source "input": the pinned model, not a statement by the provider about this answer.
//
// The seat reads only its prompt: it is given an empty directory, not the repository under review.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgyCliTurn } from "../board/agy-cli.mjs";
import { resolveModel } from "../review/identity.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The role card a single-turn seat runs under: the planner's for a planner, the reviewer's for every judging seat. */
const cardOf = role => (role === "planner" ? "planner" : "reviewer");

export async function agySingleTurn({ vendor, model, prompt, seat = null, timeoutS = 900 }) {
  const made = resolveModel(vendor, model);
  if (!made?.known || made.lab !== "google") {
    throw Object.assign(new Error(`the Antigravity transport serves Gemini models only: ${model} is ${made?.known ? `a ${made.lab} model` : "not a declared model"}`), { code: "AGY_GEMINI_ONLY" });
  }
  const cli = process.env.PANTHEON_AGY_CLI ?? join(homedir(), ".local", "bin", "agy");
  if (cli.includes("/") && !existsSync(cli)) throw new Error(`agy seat: CLI absent at ${cli} (set PANTHEON_AGY_CLI)`);
  const empty = mkdtempSync(join(tmpdir(), "pantheon-agy-turn-"));
  try {
    const r = await runAgyCliTurn({ cli, repo: REPO, worktree: empty, role: cardOf(seat?.role), model, prompt, timeoutS });
    return { text: r.text ?? "", response_id: r.response_id ?? null, served_model: model, served_model_source: "input" };
  } finally { rmSync(empty, { recursive: true, force: true }); }
}
