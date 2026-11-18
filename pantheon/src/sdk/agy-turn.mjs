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
import { classifyFailure } from "../../../packages/model-client/index.mjs";
import { seatTransport, QUOTA_FAILOVER_RULE } from "../route/frontier.mjs";
import { laneFor, laneLevels, quotaFailoverFor } from "../route/fit-matrix.mjs";

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

/**
 * GEMINI THROUGH ANTIGRAVITY FIRST, for a single-turn seat (owner direction 2026-11-17). Pure over `lane` and `api`,
 * the two ways a turn can be served; it imports no SDK.
 *
 *   a seat naming a metered Gemini API id that has an Antigravity lane  -> that lane first (at the seat's effort;
 *                                                                          `high` when it carries none)
 *   a seat naming a lane                                                -> that lane
 *   anything else                                                       -> `api`, unchanged
 *
 * The metered API answers ONLY when the lane attempt was refused for quota (HTTP 429 / quota exhausted, as
 * classifyFailure classifies it), and the answer then says so (`quota_failover`). Any other lane failure is thrown as
 * it is: it never moves the turn to the metered API. A lane whose base model has no API id has no failover.
 */
export async function laneFirstTurn({ vendor, model, prompt, seat = null }, { lane, api }) {
  const transport = seatTransport(vendor, model);
  const isLane = transport === "agy-cli";
  const viaLane = isLane ? { vendor, model } : vendor === "agy_google" && transport === "api" && laneLevels(model).length ? laneFor(model, seat?.effort ?? null) : null;
  if (!viaLane) return api({ vendor, model, prompt, seat });
  const spare = isLane ? quotaFailoverFor(model) : { vendor, model, effort: seat?.effort ?? null };
  try {
    const r = await lane({ vendor: viaLane.vendor, model: viaLane.model, prompt, seat });
    return { ...r, transport: "agy-cli", requested_model: model };
  } catch (e) {
    if (!spare || !classifyFailure(e).quota) throw e;
    const r = await api({ vendor: spare.vendor, model: spare.model, prompt, seat });
    return { ...r, transport: "api", requested_model: model,
      quota_failover: { used: true, base: spare.model, lanes: [viaLane.model], rule: QUOTA_FAILOVER_RULE,
        after: [{ lane: viaLane.model, outcome: "quota", source: "attempt", status: e?.status ?? null, code: e?.code ?? null, why: String(e?.message ?? e).slice(0, 200) }] } };
  }
}
