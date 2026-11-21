#!/usr/bin/env node
// Runs one independent-review assignment against a disposable worktree of a commit, with the
// owner's own provider key. See docs/reviews/2026-11-18-independent-review/README.md
// ("Running a review") and HARNESS.md. Exit codes: 0 complete, 1 refused, 2 usage, 3 incomplete.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { main } from "../src/review-runner/index.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
process.exitCode = await main(process.argv.slice(2), { repoRoot });
