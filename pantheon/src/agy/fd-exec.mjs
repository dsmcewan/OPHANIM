// THE JAILS' DESCRIPTOR CLOSER (register KG-11; docs/knowledge-graph/slice-c2.md, "Descriptors (KG-11)").
//
// THE PROPERTY. Every jailed command starts with no open descriptor beyond 0, 1 and 2, whatever the process that starts
// the jail inherited and whatever the number. No jail passes any other descriptor on purpose: stdin, stdout and stderr are
// the only ones (the controller's pipes, or what the launcher itself was given).
//
// WHY IT IS NEEDED. Node's spawn and bwrap close nothing beyond the stdio they set up (observed with bubblewrap 0.9.0 and
// node 24.22), so a descriptor a supervisor (a service manager, a shell, an `npm` wrapper) leaks into the controller
// without close-on-exec reaches every jailed command: the agy CLI and the verify_cmd its run_command launches, and the
// python SDK seat. Node marks only a low range of inherited descriptors close-on-exec at startup (observed on node 24.22:
// fcntl(fd, F_SETFD, FD_CLOEXEC) on 0..16; an inherited fd 20 above a gap stays inheritable). A multi-threaded controller
// also hands its children what its other threads hold open at the fork: a Worker's new isolate opens /proc/self/maps and
// the node binary without close-on-exec (observed: a child spawned during Worker churn held the controller's
// /proc/<pid>/maps at fd 94).
//
// THE MECHANISM: a SINGLE-THREADED program, FD_EXEC_PY, run by python3 as `python3 -I -S -c FD_EXEC_PY <command> ...`
// (fdExecArgv), stands between every jail's starter and bwrap. It
//   1. checks that it is the only thread of its process (/proc/self/task), so nothing else can open or close a
//      descriptor between its scan and its exec;
//   2. lists /proc/self/fd and closes EVERY descriptor above 2 (os.closerange: one close_range call where the kernel has
//      it), its own included, since it needs none;
//   3. lists /proc/self/fd again and checks that none above 2 is open;
//   4. execs the command in its place (os.execve: the same pid, so the caller's process group and kill path are
//      unchanged). The command gets the environment the closer was given, byte for byte: it is read back from
//      /proc/self/environ, because python's startup may add LC_CTYPE (PEP 538). It also gets the signal dispositions the
//      closer was started with: python ignores SIGPIPE and SIGXFSZ at startup, and both are set back to SIG_DFL, which is
//      what node's spawn hands every child.
// It replaces a node program (`node fd-exec.mjs`, process.execve). Node is multi-threaded: a platform pool, a
// delayed-task scheduler with its own event loop, and the inspector's signal thread. It also raises RLIMIT_NOFILE's soft
// limit to the hard one, and it leaves SIGPIPE and SIGXFSZ ignored across process.execve (observed in the exec'd command:
// SigIgn 0x1001000; soft limit 1024 became 20000). python3 -I -S starts no thread, reads no PYTHON* variable and no site
// module, and changes neither. bash was measured too and set aside: it adds PWD and SHLVL to what it execs, and it reads
// ~/.bashrc when its stdin is a socket (node's 'pipe') unless --norc is given.
// FAIL CLOSED: when it cannot establish the property, it exits FDS_REFUSED (125) with a `pantheon-fds: refused:` line on
// stderr, and the command never runs. That covers another thread, no /proc, an unreadable table or environment, a
// descriptor still open after closing, and anything unexpected. A command that is not an executable file exits 127; one
// the kernel will not execute exits 126. Linux only, as the jails are.
//
//   python3 -I -S -c "$FD_EXEC_PY" <command> [args ...]     (the command is looked up on its PATH when it has no "/")
//
// Must never: exec the command with a descriptor above 2 open; run while another thread of its process exists; change the
// environment or the signal dispositions it hands the command; fall back to running the command when the property cannot
// be established.
import { accessSync, closeSync, constants, openSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This module's own path: where the closer's program (FD_EXEC_PY) is defined. */
export const FD_EXEC_MODULE = fileURLToPath(import.meta.url);
/** The closer's refusal: it could not establish the property, and ran nothing (the verify launcher's VERIFY_JAIL_REFUSED). */
export const FDS_REFUSED = 125;
/** The descriptors a jailed command is given on purpose: stdin, stdout and stderr, and no other. */
export const FDS_PASSED = Object.freeze([0, 1, 2]);
/** The closer's own last `pantheon-fds:` line in a stderr (its refusal or exec failure), bounded, or null when it said
 *  nothing. Callers put it in their reason, so a refusal states its cause wherever the exit code alone is reported
 *  (KG-11: two integration refusals were seen only as "exit 125", and their records were gone). */
export function closerLine(stderr) {
  const lines = String(stderr ?? "").split("\n").filter(l => l.startsWith("pantheon-fds:"));
  return lines.length ? lines[lines.length - 1].slice(0, 400) : null;
}
/** python3's flags for the closer: isolated (-I: no PYTHON* variable, no user site, no script dir on sys.path), no site (-S). */
export const FD_EXEC_PY_FLAGS = Object.freeze(["-I", "-S"]);

/**
 * THE CLOSER (see the header): python 3.4 or later. It imports only built-in or frozen modules (os, sys, errno, _signal),
 * so the only files it opens are /proc/self/{task,fd,environ}, each closed before the next step.
 */
export const FD_EXEC_PY = `import os, sys, errno, _signal
_signal.signal(_signal.SIGINT, _signal.SIG_DFL)
def say(line):
    try: os.write(2, ("pantheon-fds: %s\\n" % line).encode("utf-8", "replace"))
    except Exception: pass
def refuse(why):
    say("refused: %s; the jail was not started" % why)
    os._exit(125)
def code(e): return errno.errorcode.get(getattr(e, "errno", None), str(e))
def table(what):
    try: return sorted(int(f) for f in os.listdir("/proc/self/" + what))
    except Exception as e: refuse("the %s cannot be listed (%s)" % ("descriptor table" if what == "fd" else "thread list", code(e)))
def is_open(fd):
    try: os.fstat(fd); return True
    except OSError: return False
try:
    if len(sys.argv) < 2 or not sys.argv[1]: refuse("no command was given")
    cmd = sys.argv[1]
    threads = table("task")
    if len(threads) != 1: refuse("the closer is not single-threaded (%d threads): a descriptor could be opened between its check and its exec" % len(threads))
    fds = table("fd")
    try:
        with open("/proc/self/environ", "rb") as f: raw = f.read()
    except Exception as e: refuse("the environment cannot be read (%s)" % code(e))
    env = {}
    for entry in raw.split(b"\\0"):
        k, sep, v = entry.partition(b"=")
        if sep and k and k not in env: env[k] = v
    os.closerange(3, max(fds + [2]) + 1)
    left = [fd for fd in table("fd") if fd > 2 and is_open(fd)]
    if left: refuse("descriptor(s) %s still open after closing" % ", ".join(map(str, left)))
except BaseException as e: refuse("unexpected %s: %s" % (type(e).__name__, e))
def executable(p):
    try: return (os.stat(p).st_mode & 0o170000) == 0o100000 and os.access(p, os.X_OK)
    except OSError: return False
if "/" in cmd: path = cmd if executable(cmd) else None
else:
    path = None
    for d in env.get(b"PATH", b"").decode("utf-8", "surrogateescape").split(":"):
        p = os.path.join(d or ".", cmd)
        if os.path.isabs(p) and executable(p): path = p; break
if not path:
    say("%s: not an executable file%s" % (cmd, "" if "/" in cmd else " on PATH"))
    os._exit(127)
_signal.signal(_signal.SIGPIPE, _signal.SIG_DFL)
_signal.signal(_signal.SIGXFSZ, _signal.SIG_DFL)
try: os.execve(path, sys.argv[1:], env)
except OSError as e:
    say("%s: cannot be executed (%s)" % (cmd, code(e)))
    os._exit(127 if e.errno == errno.ENOENT else 126)
`;

/** `cmd` as execve needs it: itself when it holds a "/", else the first executable regular file of that name on `PATH`. */
export function resolveCommand(cmd, PATH = process.env.PATH ?? "") {
  const ok = p => { try { return statSync(p).isFile() && (accessSync(p, constants.X_OK), true); } catch { return false; } };
  if (typeof cmd !== "string" || !cmd) return null;
  if (cmd.includes("/")) return ok(cmd) ? cmd : null;
  for (const d of String(PATH).split(":")) { const p = join(d || ".", cmd); if (isAbsolute(p) && ok(p)) return p; }
  return null;
}

/** The python3 that runs the closer by default: the first on this process's PATH (null when there is none). */
export function fdExecPython(PATH = process.env.PATH ?? "") {
  return resolveCommand("python3", PATH);
}

/** The closer's own argv, run by the python3 `closerPython`: what fdExecArgv puts in front of a command. Throws without one. */
export function fdExecPrefix({ closerPython = fdExecPython() } = {}) {
  if (typeof closerPython !== "string" || !closerPython) throw Object.assign(new Error("the descriptor closer needs python3, and none was found"), { code: "FDS_NO_PYTHON" });
  return [closerPython, ...FD_EXEC_PY_FLAGS, "-c", FD_EXEC_PY];
}

/** The argv that starts `argv` (a jail's bwrap argv, or the command itself) through the closer, run by `closerPython`. */
export function fdExecArgv(argv, { closerPython = fdExecPython() } = {}) {
  if (!Array.isArray(argv) || !argv.length) throw new Error("fdExecArgv: pass the argv to start");
  return [...fdExecPrefix({ closerPython }), ...argv];
}

const probes = new Map();
/**
 * Does the closer work here, with `closerPython`? It runs the closer once per interpreter (cached) on a real case. A
 * descriptor above the range node marks at startup (fd 20, open on this module's file, without close-on-exec) is handed
 * to the closer, which execs `node -e` (this node) to look for any descriptor on that file. Returns {ok, why?} and never
 * throws. The gates of both jails call it before anything is admitted, charged or spawned (SANDBOX_UNAVAILABLE when it
 * fails): no python3, no closer, no jail.
 */
export function fdExecAvailable({ closerPython = fdExecPython() } = {}) {
  const key = String(closerPython);
  if (!probes.has(key)) {
    probes.set(key, new Promise(resolveProbe => {
      let fd = null, done = false;
      const finish = r => { if (done) return; done = true; if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } } resolveProbe(r); };
      try {
        if (!closerPython) { finish({ ok: false, why: "no python3 was found on PATH to run the descriptor closer" }); return; }
        const target = realpathSync(FD_EXEC_MODULE);
        fd = openSync(target, "r");
        const check = `const fs=require("fs");let n=[];for(const f of fs.readdirSync("/proc/self/fd")){try{if(fs.readlinkSync("/proc/self/fd/"+f)===${JSON.stringify(target)})n.push(f)}catch{}}process.stdout.write(n.length?"LEAKED "+n.join(","):"CLEAN")`;
        const [cmd, ...args] = fdExecArgv([process.execPath, "-e", check], { closerPython });
        const c = spawn(cmd, args, { env: {}, stdio: ["ignore", "pipe", "pipe", ...Array(17).fill("ignore"), fd] });
        let out = "", err = "";
        c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { err += d; });
        const timer = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } finish({ ok: false, why: "the descriptor closer did not finish within 15 s" }); }, 15000);
        timer.unref?.();
        c.on("error", e => { clearTimeout(timer); finish({ ok: false, why: `the descriptor closer could not be started with ${closerPython}: ${e?.code ?? e?.message ?? e}` }); });
        c.on("close", status => {
          clearTimeout(timer);
          if (status === 0 && out === "CLEAN") finish({ ok: true });
          else finish({ ok: false, why: `the descriptor closer (${closerPython}) exited ${status} with ${JSON.stringify(out.slice(0, 120))}: ${err.trim().slice(0, 240) || "no message"}` });
        });
      } catch (e) { finish({ ok: false, why: `the descriptor closer's probe could not run: ${e?.code ?? e?.message ?? e}` }); }
    }));
  }
  return probes.get(key);
}
