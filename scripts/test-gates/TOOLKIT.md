# The integration toolkit

Four mechanical checks, each ending a failure class that kept recurring in `ophanim/lessons/corrections.json` because
its only fix was a reviewer remembering to be careful. Each tool fails (exits non-zero) on the condition its class
describes, so an integration or a brief can require it instead of relying on care.

| Tool | Command | Failure class it ends |
|---|---|---|
| T1 reach | `node scripts/test-gates/reach.mjs <module>...` | `brief-manifest-disagree` (the lookup it needs) |
| T2 affected runners | `node scripts/test-gates/affected-runners.mjs <base> <head> [--run]` | `runner-deciding-tests-changed-not-rerun` |
| T3 manifest reach | `node scripts/test-gates/manifest-reach.mjs <manifest.json>...` | `brief-manifest-disagree` (5 instances) |
| T4 stress | `node scripts/test-gates/stress.mjs --files <test>... [--repeat N] [--concurrency K] [--load L]` | races that appear only when suites run in parallel (the jail closer's exit 125, L-161, KG-11) |

All four keep to the same rules. They never list or read a withheld path (`findings-*`): git is given the exclusion
pathspec `':(exclude,glob)**/findings-*/**'`, and `WITHHELD` from `ophanim/graph/extract/git.mjs` drops anything left. They
never import a mutation runner: a runner starts its run at import, so it is read as text through `mutationTable`
(`ophanim/graph/extract/verification.mjs`). They say what they cannot read rather than dropping it (the lesson of
`text-reader-misses-new-shape`). The tests are `scripts/test-gates/toolkit-*.test.mjs` (run by `npm run test:gates:self`);
the mutation runner is `scripts/test-gates/toolkit.mutate.mjs` (`--only`, `--check`), with mutations for every tool.

## T1 `reach.mjs`: what reaches a module

```
node scripts/test-gates/reach.mjs <module|glob>... [--ref COMMIT] [--transitive[=N]] [--json] [--root DIR]
```

This lists every tracked test file (`*.test.mjs`) and committed runner (`*.mutate.mjs`) that reaches any of the given
modules.

- **Tests.** A test reaches a module when it imports it. Every static and dynamic import specifier is resolved
  relative to the importing file, to a path of the tree. The specifiers come from the `SPEC` regex of
  `ophanim/graph/extract/repo.mjs`, plus a template-literal `import(...)` whose path part has no substitution. A
  workspace package name is resolved through its `package.json` `exports` or `main`. A file name that merely resembles
  the module never counts, nor does a comment that names it.
- **Runners.** A runner is reached on any of three bases, and the output names which:
  - `import`: its text imports the module;
  - `target`: its mutation table edits the module, so a change to the module can break the runner's exact-text edits
    (`--check` exits 2);
  - `decides`: one of its deciding test files reaches the module, so its baseline can go red.
- **Transitive reach.** `--transitive` follows the importers of importers, to `TRANSITIVE_BOUND` (8) levels;
  `--transitive=N` sets another bound. Each test reached this way is shown with its chain of imports. When importers
  remain past the bound, the output says the walk was cut short.
- **Which tree.** By default T1 reads the working tree's tracked files (`git ls-files`). `--ref COMMIT` reads that
  commit from git's object store instead.
- **What it cannot read.** A test or runner whose dynamic import has a non-literal argument (`import(name)`,
  `import(pathToFileURL(...))`) is listed as *opaque*: it may reach the module, so check it by hand. A runner mutation
  whose target or deciding test the text reader could not read is listed as *unread*.
- **Exit codes.** 0 normally. 2 when a module names no tracked file, so that a typo does not read as "nothing reaches
  it".

How an integration uses it: before dispatch, run it on the modules a brief lets an agent change, and grant every file
it lists. T3 does this mechanically for a whole manifest.

What it does not see: a test that runs a module as a separate process (`spawnSync(node, ['ophanim/cli.mjs'])`), reads it
with `fs`, or names its path in a string reaches it at run time without importing it. Those are listed nowhere. The
coordinator's C2 instance (fakes spawned under `/tmp`) was of this kind.

## T2 `affected-runners.mjs`: which runners to re-run in full

```
node scripts/test-gates/affected-runners.mjs <base> <head> [--json] [--root DIR]
node scripts/test-gates/affected-runners.mjs <base> <head> --run [--copy-root DIR] [--log DIR] [--root DIR]
```

This lists every runner at `<head>` whose own file, TARGET files or DECIDING TEST files differ between the two commits.
The diff comes from `git.mjs` `changedBetween`. Each runner's table is read as text through `mutationTable`. Each
listed runner has its reasons:

- `own`: its own file changed. Such a runner is always listed.
- `target`: a file one of its mutations edits changed.
- `decides`: a test file that decides one of its mutations changed. This is the lessons class itself: D1 changed
  `ophanim/graph/cli.test.mjs`, which decides `graph-b.mutate.mjs`, and only the runners whose targets changed were
  re-run.
- `unread`: the reader could not read the runner's table, or a mutation's target or deciding test. Such a runner cannot
  be cleared, so it is listed.

A runner deleted between the commits is reported as removed.

`--run` runs each listed runner in full, one after another, from the checkout at `--root`. It refuses (exit 2) when
that checkout's HEAD is not `<head>`, because the runs would then test another tree. It passes `--copy-root DIR`
through, and gives each runner its own `--log DIR/<runner path>`. It exits 1 if any runner exits non-zero or is
killed, and names each one. It notes uncommitted changes, which each runner copies.

How an integration uses it: on the merge candidate, run `affected-runners.mjs <base of the slice> HEAD --run --copy-root
<dir>`. Then run `--check` on every committed runner, as before; that check is cheap and catches edits that no longer
apply. Neither step replaces the other.

## T3 `manifest-reach.mjs`: a manifest that cannot contain its slice's changes fails

```
node scripts/test-gates/manifest-reach.mjs <manifest.json>... [--subwave ID] [--agent NAME]
                                           [--ref COMMIT | --worktree] [--transitive[=N]] [--json] [--root DIR]
```

T3 reads the format that `docs/execution/check-ownership.mjs` checks (`ophanim.wave-ownership/v1`), and leaves that
coordinator-only file unchanged.

**Which tree it reads.** For each agent, T3 reads the tree at the agent's `base_commit`, or the manifest's if the agent
has none. The slice starts there, and a test added later is not one its brief could have listed. `--ref` or
`--worktree` reads another tree.

**What the agent may change.** The agent's changeable modules are the tracked files its `files` globs match, minus its
tests and runners.

**What is required.** Every test that imports a changeable module is required, and so is every runner that imports or
edits one. Each required file must be one of:

- **granted**: matched by the agent's own `files` (or `allowed_extra`);
- **held**: declared as held by another agent, in one of two machine-readable forms:
  - on the agent: `"held": ["<path or glob>", {"path": "<path or glob>", "by": "<holder>", "why": "..."}]`;
  - for every agent of the manifest: an **object** entry in `dependencies`:
    `{"held": ["<path or glob>", ...], "by": "<holder>", "why": "..."}`.
  A file granted to a sibling agent of the same manifest also counts as held. `check-ownership.mjs` ignores both forms.
  It reads `files`, `new_files` and `allowed_extra`, and never reads `dependencies`.

**What fails.** Any other required file is MISSING, and the manifest fails (exit 1). A path that a dependency string
names in prose is still missing, because prose is not a declaration. The report marks it "named in prose only", so the
fix is to restate it as a `held` entry.

**Advisory only.** These never fail the manifest:

- runners decided by a reached test (re-run them in full: that is T2's job);
- tests reached only transitively that are neither granted nor held (`--transitive` makes them required);
- opaque test or runner files;
- unread runner mutations.

How an integration uses it: run it on every new manifest before dispatch (`node scripts/test-gates/manifest-reach.mjs
docs/execution/<wave>-ownership.json`). Then either grant each MISSING file, or declare it held, naming the holder.
Exit 0 is the dispatch condition, beside `check-ownership.mjs`'s own.

## T4 `stress.mjs`: races that appear only in parallel

```
node scripts/test-gates/stress.mjs --files <test file>... [--repeat N] [--concurrency K] [--load L]
                                   [--test-timeout MS] [--file-timeout S] [--json FILE] [--out DIR]
```

**Rounds.** A round runs every given file once, K at a time. Rounds run one after another, and a file never runs
beside itself (as in CI).

**How each file runs.** Each file runs in its own `node --test`, through the gate's own `runFile`
(`scripts/test-gates/check.mjs`). That gives it its own process group, the events reporter, and the per-test and
per-file bounds. It runs with the cwd and flags of the suite that runs it (`suites.mjs`).

**How each run is judged.** Each run is judged by the gate's own `evaluateRuns`:

- These FAIL: a failed, cancelled or hung test; a failed suite; a file that ended early; a skip in a real-bwrap suite
  where bwrap works.
- A real-bwrap skip where bwrap does not work is UNVERIFIED (exit 2): the race did not run.

**Load.** `--load L` starts L busy-loop processes before the first round and stops them after the last. Each also exits
if its parent goes away.

**Report.** T4 reports every failing test by file, name and round. For each test, it lists the rounds it failed in,
marked "every round" or "intermittent". It exits 1 on any failure in any round. Defaults: `--repeat 5`,
`--concurrency min(files, available parallelism)`, `--load 0`, and the gate's bounds.

How an integration uses it: on a branch that touches the jail or anything the real-bwrap suites exercise, run, for
example,

```
node scripts/test-gates/stress.mjs --files pantheon/tests/<jail suites>.test.mjs --repeat 10 --concurrency 4 --load 2
```

Do this on a machine where bwrap works. `npm run test:gates` stays the per-file gate; it runs each file on its own and
cannot see these races.

Limits:

- T4 finds a race only if the given files, rounds and load let it happen. Exit 0 is evidence over the rounds run, not
  a proof.
- If T4 itself is killed, a test file in flight is left to finish on its own; its load processes exit with it.
- Its own tests use tiny synthetic files (`fixtures/toolkit-*.fixture.mjs`), never the real suites.
