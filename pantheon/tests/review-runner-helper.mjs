// Shared fixtures for the review-runner tests: a throwaway git repository holding the real review
// README, assignment files and HARNESS.md, and a scripted fake fetch. No network, no keys.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp as mkdtempRaw, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REAL_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const REVIEW_DIR = "docs/reviews/2026-11-18-independent-review";
// Every temp dir made through here is removed by cleanup() (registered with test.after).
const made = [];
export async function mkdtemp(prefix) { const d = await mkdtempRaw(prefix); made.push(d); return d; }
export async function cleanup() { await Promise.all(made.splice(0).map(d => rm(d, { recursive: true, force: true }))); }

export const FAKE_KEY = "sk-test-FAKEKEY-0123456789abcdef";

export function sh(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "", err = "";
    c.stdout.on("data", d => (out += d));
    c.stderr.on("data", d => (err += d));
    c.on("error", rej);
    c.on("close", code => (code === 0 ? res(out) : rej(new Error(`${cmd} ${args.join(" ")}: ${err}`))));
  });
}

// A git repository with the review directory (copied from this checkout), a few test files and
// another reviewer's findings file, committed. Returns { root, commit }.
export async function fixtureRepo({ readme } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rr-repo-"));
  await mkdir(join(root, REVIEW_DIR), { recursive: true });
  for (const f of await readdir(join(REAL_ROOT, REVIEW_DIR))) {
    if (/^(README|HARNESS|HARNESS-cli|\d-.*)\.md$/.test(f)) await cp(join(REAL_ROOT, REVIEW_DIR, f), join(root, REVIEW_DIR, f));
  }
  if (readme !== undefined) await writeFile(join(root, REVIEW_DIR, "README.md"), readme);
  await writeFile(join(root, REVIEW_DIR, "findings-4-openai.md"), "PRIOR-FINDINGS-UNIQUE-MARKER\n");
  await mkdir(join(root, "pantheon/tests"), { recursive: true });
  await mkdir(join(root, "ophanim/operate"), { recursive: true });
  const pass = 'import test from "node:test";\ntest("ok", () => {});\n';
  await writeFile(join(root, "pantheon/tests/agy-fixture.test.mjs"), pass);
  await writeFile(join(root, "pantheon/tests/pipeline-a2a.test.mjs"), pass);
  await writeFile(join(root, "pantheon/tests/other.test.mjs"), pass);
  await writeFile(join(root, "ophanim/operate/stages.mjs"), "export const x = 1;\n");
  await writeFile(join(root, "hello.txt"), "line one\nline two\n");
  const g = (...a) => sh("git", ["-C", root, ...a]);
  await g("init", "-q");
  await g("add", "-A");
  await g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "fixture");
  const commit = (await g("rev-parse", "HEAD")).trim();
  return { root, commit };
}

// fetch double: `script` is a list of (url, init) => { status?, json?, text?, headers? }.
export function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const step = script[calls.length - 1];
    if (!step) throw new Error(`fake fetch: no scripted response for call ${calls.length}`);
    const r = step(url, init);
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}

// --via has no default (the owner chooses API spend or the subscription CLIs each time): the API tests pass it here.
export const LIMITS = ["--via", "api", "--max-turns", "6", "--max-tool-calls", "6", "--max-output-tokens", "1000", "--timeout-s", "30"];

export function capture() {
  const o = { out: "", err: "" };
  o.stdout = s => (o.out += s);
  o.stderr = s => (o.err += s);
  return o;
}

export async function deps({ root, env = {}, fetch, out, tmpBase }) {
  const t = tmpBase ?? (await mkdtemp(join(tmpdir(), "rr-tmp-")));
  const d = { repoRoot: root, env: { PATH: process.env.PATH, ...env }, fetch, stdout: out.stdout, stderr: out.stderr,
              sleeps: [], tmpBase: t, cwd: root };
  d.sleep = async ms => { d.sleeps.push(ms); };
  return d;
}
