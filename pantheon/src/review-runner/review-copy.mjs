// The review copy of a subscription run: a FRESH single-commit git repository holding the reviewed commit's files,
// minus the withheld ones (sandbox.mjs WITHHELD: other reviewers' findings), instead of a `git worktree` of the
// owner's repository.
//
// WHY (round 2 at 77480d6, 2026-11-19): a `git worktree` has a `.git` FILE naming <repo>/.git/worktrees/<id>, and
// codex's permission profile (reads: the worktree and the runtime only) does not make that directory readable, so every
// git command in the codex sandbox failed ("fatal: not a git repository: .../.git/worktrees/worktree") and the
// reviewers reported "Git could not independently confirm HEAD". Making the owner's git dirs readable would fix git but
// would also hand the reviewer the repository's whole history -- and with it every withheld findings file of earlier
// rounds (`git log -p -- docs/reviews`), which is exactly what the runner removes from the copy. A fresh repository
// whose only objects are the exported tree minus the withheld paths gives the reviewer a working git (log, show, diff,
// ls-files, status) and nothing to recover: the withheld blobs are never written into it.
//
// HOW: the commit's tree is read into a TEMPORARY index of the owner's repository (GIT_INDEX_FILE; the repository's own
// index, refs and worktrees are untouched), the withheld paths are removed from that index, `checkout-index` writes the
// rest into the copy, and a new repository there commits them (fixed author, the source commit's committer date, no
// hooks, no template, no user or system config: the same tree gives the same synthetic commit id on every run). The
// copy's index is then compared with the source tree entry by entry (mode, blob id, path): every blob id must be the
// source's, so the export is verified byte for byte without trusting the checkout. A mismatch is a refusal.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "./cli-common.mjs";

export const REVIEW_COPY_KIND = "fresh single-commit git repository (an export of the commit minus the withheld paths; no source history)";
const IDENT = { name: "ophanim-review", email: "review-copy@ophanim.invalid" };

/** The environment of every git the export runs: no user or system config, no hooks from a template, a scratch HOME. */
function gitEnv(home, extra = {}) {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...extra };
}
async function g(cwd, args, env) {
  const r = await runCli({ cmd: "git", args: ["-C", cwd, ...args], env, timeoutMs: 300_000 });
  if (r.exit_code !== 0) throw Object.assign(new Error(`git ${args.join(" ")} failed (exit ${r.exit_code ?? r.spawn_error}): ${r.stderr.trim().slice(0, 1000)}`), { code: "REVIEW_COPY" });
  return r.stdout;
}

/** `git ls-tree -r -z` / `git ls-files -s -z` lines -> Map<path, "mode sha">. ls-tree: "<mode> <type> <sha>\t<path>"; ls-files -s: "<mode> <sha> <stage>\t<path>". */
export function parseTreeEntries(out, kind) {
  const m = new Map();
  for (const rec of String(out).split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t"), meta = rec.slice(0, tab).split(" "), path = rec.slice(tab + 1);
    if (kind === "ls-tree") { if (meta[1] === "commit") continue; m.set(path, `${meta[0]} ${meta[2]}`); }   // a submodule (gitlink) is not exported
    else m.set(path, `${meta[0]} ${meta[1]}`);
  }
  return m;
}

/** Does the copy's index hold exactly the source tree minus the withheld paths? {ok, missing, unexpected, differ}. */
export function compareExport(source, copy, withheld) {
  const skip = new Set(withheld);
  const missing = [], differ = [], unexpected = [];
  for (const [p, v] of source) { if (skip.has(p)) continue; if (!copy.has(p)) missing.push(p); else if (copy.get(p) !== v) differ.push(p); }
  for (const p of copy.keys()) if (!source.has(p) || skip.has(p)) unexpected.push(p);
  return { ok: !missing.length && !differ.length && !unexpected.length, missing: missing.slice(0, 20), differ: differ.slice(0, 20), unexpected: unexpected.slice(0, 20) };
}

/**
 * Export `commit` of `repoRoot` into `dest` (must not exist) as a fresh single-commit repository without `withheld`.
 * `scratch` is a private dir for the temporary index and git's HOME. Returns the record the plan, transcript and header
 * keep: {kind, source_commit, source_tree, head, tree, files, withheld_count, verified, submodules_skipped}.
 */
export async function exportReviewCopy({ repoRoot, commit, dest, withheld = [], scratch }) {
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const env = gitEnv(scratch);
  const sourceTree = (await g(repoRoot, ["rev-parse", `${commit}^{tree}`], env)).trim();
  const date = (await g(repoRoot, ["log", "-1", "--format=%cI", commit], env)).trim();
  const lsTree = await g(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", commit], env);
  const source = parseTreeEntries(lsTree, "ls-tree");
  const submodules = String(lsTree).split("\0").filter(r => r.split(" ")[1] === "commit").length;
  const idx = gitEnv(scratch, { GIT_INDEX_FILE: join(scratch, "export.index") });
  await g(repoRoot, ["read-tree", commit], idx);
  for (let i = 0; i < withheld.length; i += 200) await g(repoRoot, ["update-index", "--force-remove", "--", ...withheld.slice(i, i + 200)], idx);
  await mkdir(dest, { recursive: true });
  await g(repoRoot, ["checkout-index", "--all", "--force", `--prefix=${dest}/`], idx);
  await rm(join(scratch, "export.index"), { force: true });
  await g(dest, ["init", "-q", "--template=", "-b", "review-copy"], env);
  await g(dest, ["add", "--all", "--force", "."], env);
  const msg = [`Review copy of ${commit}`, "", `source-commit: ${commit}`, `source-tree: ${sourceTree}`,
    `withheld: ${withheld.length} path(s) (other reviewers' findings), never written into this repository`, ""].join("\n");
  const who = { GIT_AUTHOR_NAME: IDENT.name, GIT_AUTHOR_EMAIL: IDENT.email, GIT_COMMITTER_NAME: IDENT.name, GIT_COMMITTER_EMAIL: IDENT.email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  await g(dest, ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", msg], gitEnv(scratch, who));
  const copy = parseTreeEntries(await g(dest, ["ls-files", "-s", "-z"], env), "ls-files");
  const cmp = compareExport(source, copy, withheld);
  if (!cmp.ok) throw Object.assign(new Error(`the review copy does not match ${commit} minus the withheld paths (missing ${JSON.stringify(cmp.missing)}, blob or mode differs ${JSON.stringify(cmp.differ)}, unexpected ${JSON.stringify(cmp.unexpected)})`), { code: "REVIEW_COPY" });
  const head = (await g(dest, ["rev-parse", "HEAD"], env)).trim(), tree = (await g(dest, ["rev-parse", "HEAD^{tree}"], env)).trim();
  return { kind: REVIEW_COPY_KIND, source_commit: commit, source_tree: sourceTree, head, tree, files: copy.size, withheld_count: withheld.length, submodules_skipped: submodules,
    verified: "every path's mode and blob id equal the source commit's (git ls-files -s vs git ls-tree -r), minus the withheld paths" };
}
