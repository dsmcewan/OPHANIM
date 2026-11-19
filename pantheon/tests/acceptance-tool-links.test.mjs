// Independent review 2026-11-16, WF3: the acceptance sandbox binds only /usr, so a tool whose /usr/bin
// entry is an alternatives symlink (/usr/bin/python3 -> /etc/alternatives/python3 -> /usr/bin/python3.x)
// dangled inside it. toolLinkBinds() names the extra read-only binds such a chain needs, and nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toolLinkBinds, runAcceptance } from "../src/board/acceptance.mjs";

test("an alternatives chain out of /usr/bin binds the alternatives directory, read-only", () => {
  const root = mkdtempSync(join(tmpdir(), "pantheon-toollinks-"));
  try {
    const bin = join(root, "usr/bin"), alt = join(root, "etc/alternatives"), home = join(root, "home/someone");
    for (const d of [bin, alt, home]) mkdirSync(d, { recursive: true });
    writeFileSync(join(bin, "python3.13"), "");
    symlinkSync(join(alt, "python3"), join(bin, "python3"));            // absolute, as update-alternatives writes it
    symlinkSync("../../usr/bin/python3.13", join(alt, "python3"));       // relative back into /usr
    symlinkSync("python3.13", join(bin, "python3-plain"));               // stays inside /usr: needs nothing
    symlinkSync(join(home, "tool"), join(bin, "personal"));              // leaves /usr for a home: never bound
    symlinkSync(join(root, "missing"), join(bin, "dangling"));
    const binds = toolLinkBinds({ binDirs: [bin], bindable: [alt] });
    assert.deepEqual(binds, ["--ro-bind", alt, alt]);
    assert.deepEqual(toolLinkBinds({ binDirs: [join(root, "nowhere")], bindable: [alt] }), []);
    // A symlink loop does not hang.
    symlinkSync(join(bin, "loop-b"), join(bin, "loop-a")); symlinkSync(join(bin, "loop-a"), join(bin, "loop-b"));
    assert.deepEqual(toolLinkBinds({ binDirs: [bin], bindable: [alt] }), ["--ro-bind", alt, alt]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the sandbox resolves this host's /usr/bin/python3 however it is linked", async t => {
  let link = null;
  try { if (lstatSync("/usr/bin/python3").isSymbolicLink()) link = readlinkSync("/usr/bin/python3"); }
  catch { return t.skip("no /usr/bin/python3 on this host"); }
  t.diagnostic(`/usr/bin/python3 -> ${link ?? "(regular file)"}`);
  if (link?.startsWith("/etc/alternatives/")) {
    // The whole list: the alternatives bind, read-only, and nothing else (an extra bind past it is a widened sandbox).
    assert.deepEqual(toolLinkBinds(), ["--ro-bind", "/etc/alternatives", "/etc/alternatives"]);
  }
  const worktree = mkdtempSync(join(tmpdir(), "pantheon-toollinks-run-"));
  try {
    const r = await runAcceptance({ worktree, cmd: "/usr/bin/python3 -c 'print(6*7)' && ! touch /etc/alternatives/escape" });
    assert.equal(r.exit, 0, r.out);
    assert.match(r.out, /42/);
  } finally { rmSync(worktree, { recursive: true, force: true }); }
});
