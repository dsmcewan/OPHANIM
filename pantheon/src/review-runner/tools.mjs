// The reviewer's tools and, per assignment, which of them it gets. Every tool is rooted at the
// disposable review worktree (see sandbox.mjs for the path rules).
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolRefusal, resolveInRoot, runProcess, matchGlob, WITHHELD } from "./sandbox.mjs";
import { VERIFY_JAIL_MODULE, VERIFY_JAIL_REFUSED, VERIFY_JAIL_SCHEMA, launcherEnv } from "../agy/verify-jail.mjs";
import { shQuote } from "../agy/jail-hook.mjs";

export const CAPS = Object.freeze({
  READ_BYTES: 200_000,        // read_file, per call
  GREP_MATCHES: 200,          // grep, per call
  GREP_LINE_CHARS: 300,
  GREP_FILE_BYTES: 2_000_000, // grep skips larger files
  LIST_ENTRIES: 2_000,
  OUTPUT_BYTES: 64 * 1024,    // process output returned (tail)
  WRITE_BYTES: 256 * 1024,    // write_test content
  RUN_FILES: 50,
});

const SKIP_DIRS = new Set([".git", "node_modules"]);

// Keyed on the README table's Testing column, so a changed testing limit fails closed.
export const TESTING_POLICIES = {
  "Local deterministic fixtures": { write_test: true, run_tests: "existing-or-review", run_suite: true, processes: "within any test" },
  "Synthetic identity and ledger tests": { write_test: true, run_tests: "existing-or-review", run_suite: true, processes: "within any test" },
  "Mock providers and isolated processes": { write_test: true, run_tests: "existing-or-review", run_suite: true, processes: "tests it writes may kill and restart their own child processes" },
  "Source inspection and existing authorized tests only": { write_test: false, run_tests: "listed-only", run_suite: false, processes: "none beyond the listed tests" },
};

export function permissionsFor(testing, listed = []) {
  const p = TESTING_POLICIES[testing];
  if (!p) return null;
  return {
    testing,
    tools: ["list_files", "read_file", "grep", ...(p.write_test ? ["write_test"] : []), "run_tests", ...(p.run_suite ? ["run_suite"] : [])],
    write_test: p.write_test ? ".review-tests/<name>.test.mjs only, name [a-z0-9-]{1,64}" : false,
    run_tests: p.run_tests === "listed-only"
      ? { rule: "exactly the existing test files the assignment lists", files: listed }
      : { rule: "existing *.test.mjs under ophanim/ or pantheon/tests/, or .review-tests/<name>.test.mjs" },
    run_suite: p.run_suite ? { proof: "npm run test:proof", pantheon: "npm --prefix pantheon test", all: "npm test" } : false,
    processes: p.processes,
  };
}

const obj = (properties, required = []) => ({ type: "object", properties, required });
const DEFS = {
  list_files: { description: "List a directory of the review worktree. With glob, list files below path whose worktree-relative path matches it (e.g. 'pantheon/tests/*.test.mjs').",
    parameters: obj({ path: { type: "string", description: "Directory relative to the worktree root ('.' for the root)." }, glob: { type: "string" } }, ["path"]) },
  read_file: { description: `Read a file of the review worktree as numbered lines, at most ${CAPS.READ_BYTES} bytes per call.`,
    parameters: obj({ path: { type: "string" }, start_line: { type: "integer", description: "1-based, inclusive." }, end_line: { type: "integer", description: "1-based, inclusive." } }, ["path"]) },
  grep: { description: `Search files with a JavaScript regular expression; returns file:line: text, at most ${CAPS.GREP_MATCHES} matches.`,
    parameters: obj({ pattern: { type: "string" }, path: { type: "string", description: "File or directory, default '.'." }, glob: { type: "string" } }, ["pattern"]) },
  write_test: { description: "Write .review-tests/<name>.test.mjs in the review worktree (overwrites a file of that name).",
    parameters: obj({ name: { type: "string", description: "[a-z0-9-]{1,64}" }, content: { type: "string" } }, ["name", "content"]) },
  run_tests: { description: "Run `node --test <files>` from the worktree root and return exit code and the tail of the output.",
    parameters: obj({ files: { type: "array", items: { type: "string" } } }, ["files"]) },
  run_suite: { description: "Run a repository suite: proof = npm run test:proof, pantheon = npm --prefix pantheon test, all = npm test.",
    parameters: obj({ suite: { type: "string", enum: ["proof", "pantheon", "all"] } }, ["suite"]) },
};

export function toolDefinitions(permissions) {
  return permissions.tools.map(name => ({ name, ...DEFS[name] }));
}

async function walk(root, relDir, out, limit) {
  let entries;
  try { entries = await readdir(join(root, relDir), { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= limit) return;
    const rel = relDir === "." ? e.name : `${relDir}/${e.name}`;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(root, rel, out, limit); }
    else if (e.isFile() && !WITHHELD.some(re => re.test(rel))) out.push(rel);
  }
}

const isTestFile = f => /\.test\.mjs$/.test(f);
const reviewTestRe = /^\.review-tests\/[a-z0-9-]{1,64}\.test\.mjs$/;

// THE CODE UNDER REVIEW RUNS ONLY IN A VERIFY JAIL (self-audit round 3, assignment 4 (sealed fe2a612), L-404 sibling:
// the API-mode reviewer's run_tests / run_suite ran `node --test` and `npm ...` as the RUNNER's own children -- the
// runner holds the provider API key, and a same-uid child can read /proc/<runner pid>/environ, the owner's home (the
// CLIs' logins) and the network). Now each runs through the verify jail (src/agy/verify-jail.mjs, `--inline`): no
// credential, no home, no network, its own PID namespace; the worktree read-write (the tests' own files), the node
// toolchain, the worktree's git dirs (sanitized config) and the telos root (read-only) only. No bwrap: the launcher
// refuses (exit VERIFY_JAIL_REFUSED) and the tool result says so; it never runs a test unjailed.
// root: the worktree; permissions: from permissionsFor; env: the scrubbed child env (the jail's env is its allowlist of
// it); telosRoot: OPHANIM_TELOS_ROOT for the proof suite (set in the script, bound read-only); bwrap: the binary.
export function createToolbox({ root, permissions, env, timeoutMs, nodePath = process.execPath, npmPath = "npm", telosRoot = null, bwrap = "bwrap" }) {
  const jailed = script => {
    const policy = { schema: VERIFY_JAIL_SCHEMA, worktree: root, cwd: root, script, extra_ro: telosRoot ? [telosRoot] : [], hide: [], bwrap };
    return runProcess({ cmd: nodePath, args: [VERIFY_JAIL_MODULE, "--inline", JSON.stringify(policy)], cwd: root, env: launcherEnv(env), timeoutMs, capBytes: CAPS.OUTPUT_BYTES });
  };
  const allowed = new Set(permissions.tools);
  const listed = new Set(permissions.run_tests.files ?? []);

  const impl = {
    async list_files({ path = ".", glob } = {}) {
      const { full, rel } = await resolveInRoot(root, path);
      const st = await stat(full);
      if (!st.isDirectory()) throw new ToolRefusal(`not a directory: ${rel}`);
      if (glob !== undefined) {
        if (typeof glob !== "string") throw new ToolRefusal("glob must be a string");
        const files = [];
        await walk(root, rel || ".", files, 100_000);
        const hits = matchGlob(glob, files).slice(0, CAPS.LIST_ENTRIES);
        return { text: hits.join("\n") || "(no matches)" };
      }
      const entries = await readdir(full, { withFileTypes: true });
      const lines = [];
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name === ".git") continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (WITHHELD.some(re => re.test(r))) continue;
        lines.push(e.isDirectory() ? `${e.name}/` : e.isSymbolicLink() ? `${e.name}@` : e.name);
        if (lines.length >= CAPS.LIST_ENTRIES) { lines.push("(truncated)"); break; }
      }
      return { text: lines.join("\n") || "(empty)" };
    },

    async read_file({ path, start_line, end_line } = {}) {
      const { full, rel } = await resolveInRoot(root, path);
      const st = await stat(full);
      if (!st.isFile()) throw new ToolRefusal(`not a file: ${rel}`);
      const lines = (await readFile(full, "utf8")).split("\n");
      const from = Math.max(1, Number.isInteger(start_line) ? start_line : 1);
      const to = Math.min(lines.length, Number.isInteger(end_line) ? end_line : lines.length);
      let out = "", n = from;
      for (; n <= to; n++) {
        const l = `${n}\t${lines[n - 1]}\n`;
        if (Buffer.byteLength(out) + Buffer.byteLength(l) > CAPS.READ_BYTES) break;
        out += l;
      }
      if (n <= to) out += `(truncated at the per-call cap; continue with start_line ${n})\n`;
      return { text: out || "(no lines in range)" };
    },

    async grep({ pattern, path = ".", glob } = {}) {
      if (typeof pattern !== "string" || !pattern || pattern.length > 500) throw new ToolRefusal("pattern must be a non-empty string of at most 500 characters");
      let re;
      try { re = new RegExp(pattern); } catch (e) { throw new ToolRefusal(`invalid pattern: ${e.message}`); }
      const { full, rel } = await resolveInRoot(root, path);
      const st = await stat(full);
      let files = [];
      if (st.isDirectory()) await walk(root, rel || ".", files, 100_000); else files = [rel];
      if (glob !== undefined) files = matchGlob(String(glob), files);
      const hits = [];
      for (const f of files) {
        if (hits.length >= CAPS.GREP_MATCHES) break;
        const fp = st.isDirectory() ? join(root, f) : full;
        const lst = await (st.isDirectory() ? lstat(fp) : stat(fp)).catch(() => null);
        if (!lst || !lst.isFile() || lst.size > CAPS.GREP_FILE_BYTES) continue;
        const buf = await readFile(fp);
        if (buf.includes(0)) continue;
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length && hits.length < CAPS.GREP_MATCHES; i++) {
          if (re.test(lines[i])) hits.push(`${f}:${i + 1}: ${lines[i].slice(0, CAPS.GREP_LINE_CHARS)}`);
        }
      }
      return { text: hits.length ? hits.join("\n") + (hits.length >= CAPS.GREP_MATCHES ? "\n(match cap reached)" : "") : "(no matches)" };
    },

    async write_test({ name, content } = {}) {
      if (typeof name !== "string" || !/^[a-z0-9-]{1,64}$/.test(name)) throw new ToolRefusal("name must match [a-z0-9-]{1,64}");
      if (typeof content !== "string") throw new ToolRefusal("content must be a string");
      if (Buffer.byteLength(content) > CAPS.WRITE_BYTES) throw new ToolRefusal(`content exceeds ${CAPS.WRITE_BYTES} bytes`);
      const dir = join(root, ".review-tests");
      const dst = await lstat(dir).catch(() => null);
      if (dst && !dst.isDirectory()) throw new ToolRefusal(".review-tests is not a plain directory");
      if (!dst) await mkdir(dir);
      const rel = `.review-tests/${name}.test.mjs`;
      const fst = await lstat(join(root, rel)).catch(() => null);
      if (fst && !fst.isFile()) throw new ToolRefusal(`${rel} exists and is not a plain file`);
      const { full } = await resolveInRoot(root, rel, { mustExist: false });
      await writeFile(full, content);
      return { text: `wrote ${rel} (${Buffer.byteLength(content)} bytes)` };
    },

    async run_tests({ files } = {}) {
      if (!Array.isArray(files) || files.length === 0 || files.length > CAPS.RUN_FILES) throw new ToolRefusal(`files must be a list of 1 to ${CAPS.RUN_FILES} paths`);
      const rels = [];
      for (const f of files) {
        const { rel, full } = await resolveInRoot(root, f);
        if (!(await stat(full)).isFile()) throw new ToolRefusal(`not a file: ${rel}`);
        if (permissions.run_tests.files) {
          if (!listed.has(rel)) throw new ToolRefusal(`${rel} is not one of the existing tests this assignment lists`);
        } else if (!(reviewTestRe.test(rel) || (isTestFile(rel) && (/^ophanim\//.test(rel) || /^pantheon\/tests\//.test(rel))))) {
          throw new ToolRefusal(`${rel}: only *.test.mjs under ophanim/ or pantheon/tests/, or .review-tests/<name>.test.mjs`);
        }
        rels.push(rel);
      }
      return processResult(await jailed(`node --test ${rels.map(shQuote).join(" ")}`));
    },

    async run_suite({ suite } = {}) {
      const script = { proof: `${telosRoot ? `OPHANIM_TELOS_ROOT=${shQuote(telosRoot)} ` : ""}npm run test:proof`, pantheon: "npm --prefix pantheon test", all: "npm test" }[suite];
      if (!script) throw new ToolRefusal("suite must be proof, pantheon or all");
      return processResult(await jailed(script));
    },
  };

  return {
    definitions: toolDefinitions(permissions),
    async call(name, args) {
      if (!allowed.has(name)) return { text: `refused: tool "${name}" is not available in this assignment`, refused: true };
      if (args === null || typeof args !== "object" || Array.isArray(args)) return { text: "refused: arguments must be a JSON object", refused: true };
      try { return await impl[name](args); }
      catch (e) {
        if (e instanceof ToolRefusal) return { text: `refused: ${e.message}`, refused: true };
        return { text: `error: ${e.message}`, error: true };
      }
    },
  };
}

function processResult(r) {
  // exit VERIFY_JAIL_REFUSED: the verify jail could not be built, so the tests did NOT run (the coverage gate counts it so).
  const refused = r.exit_code === VERIFY_JAIL_REFUSED;
  const head = `exit_code: ${r.exit_code}${r.signal ? ` signal: ${r.signal}` : ""}${r.timed_out ? " (timed out, process group killed)" : ""}${refused ? " (the verify jail refused: the tests did not run)" : ""}\n` +
    `duration_ms: ${r.duration_ms}  output_bytes: ${r.bytes_total}${r.truncated ? ` (last ${CAPS.OUTPUT_BYTES} bytes shown)` : ""}\n---\n`;
  return { text: head + r.output, exit_code: r.exit_code, timed_out: r.timed_out, ran: Number.isInteger(r.exit_code) && !refused, jailed: true };
}
