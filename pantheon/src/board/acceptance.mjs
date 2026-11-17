
// Acceptance executes untrusted generated code. A copied directory is not a security boundary:
// use mandatory Linux namespaces and a minimal filesystem, or refuse without executing the shell.
import { realpathSync, readdirSync, readlinkSync, lstatSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { spawnPromise } from "./spawn.mjs";

const under = (dir, p) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * The read-only binds a tool under the bound /usr needs beyond /usr itself. On Debian-family hosts
 * /usr/bin/python3 (and many more) is a symlink into /etc/alternatives, which points back into /usr;
 * binding /usr alone leaves that link dangling inside the sandbox (independent review 2026-11-16,
 * WF3). Each symlink in `binDirs` is followed link by link, and every directory in `bindable` the
 * chain passes through is bound read-only at the same path. Nothing else is exposed: a link that
 * leaves /usr for anywhere but a `bindable` directory stays dangling, as before.
 */
export function toolLinkBinds({ binDirs = ["/usr/bin", "/usr/sbin"], bindable = ["/etc/alternatives"] } = {}) {
  const needed = new Set();
  for (const dir of binDirs) {
    let names; try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      let p = resolve(dir, name);
      for (let hop = 0; hop < 16; hop++) {
        let st; try { st = lstatSync(p); } catch { break; }
        if (!st.isSymbolicLink()) break;
        p = resolve(dirname(p), readlinkSync(p));
        const b = bindable.find(d => under(d, p));
        if (b) needed.add(b);
      }
    }
  }
  return [...needed].sort().flatMap(d => ["--ro-bind", d, d]);
}

export const ACCEPTANCE_ISOLATION = "bwrap-v1";
export async function runAcceptance({ worktree, cmd, head = "", timeout = 600_000, launch = spawnPromise }) {
  if (process.platform !== "linux") throw new Error("acceptance isolation requires Linux Bubblewrap; no unsandboxed fallback");
  const cwd = realpathSync(worktree);
  const args = ["--unshare-user", "--unshare-all", "--disable-userns", "--assert-userns-disabled",
    "--cap-drop", "ALL", "--die-with-parent", "--new-session",
    "--ro-bind", "/usr", "/usr", ...toolLinkBinds(),
    "--dir", "/tools", "--ro-bind", realpathSync(process.execPath), "/tools/node",
    "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/home",
    "--bind", cwd, "/workspace", "--chdir", "/workspace", "--clearenv",
    "--setenv", "PATH", "/tools:/usr/bin:/bin", "--setenv", "HOME", "/tmp/home",
    "--setenv", "TMPDIR", "/tmp", "--setenv", "LANG", "C.UTF-8",
    "--setenv", "PANTHEON_HEAD", head, "--", "/bin/sh", "-c", cmd];
  let r;
  try {
    // Scrub the LAUNCHER too: LD_PRELOAD is evaluated before bwrap can clear the child's env.
    r = await launch("/usr/bin/bwrap", args, { cwd, timeout, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  } catch (e) {
    throw new Error(`acceptance isolation unavailable; command not run without sandbox: ${e.message}`, { cause: e });
  }
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  return { exit: r.status ?? 1, out, isolation: ACCEPTANCE_ISOLATION };
}
