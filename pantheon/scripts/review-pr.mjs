#!/usr/bin/env node
// One coordinator action: independently review one PR as its binding record names it (the PR, its base, its head, the
// brief and the panel), through pantheon/scripts/run-review.mjs --via subscription, one reviewer at a time, with every
// binding verified before dispatch and the findings released only after the last reviewer. See
// pantheon/src/review-runner/pr-review.mjs. Exit codes: 0 every review complete, 1 refused, 2 usage, 3 incomplete.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { main } from "../src/review-runner/pr-review.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
process.exitCode = await main(process.argv.slice(2), { repoRoot });
