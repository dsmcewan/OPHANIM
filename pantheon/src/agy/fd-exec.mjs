#!/usr/bin/env node
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
// fcntl(fd, F_SETFD, FD_CLOEXEC) on 0..16; an inherited fd 20 above a gap stays inheritable).
//
// THE MECHANISM: this program stands between every jail's starter and bwrap, `node fd-exec.mjs bwrap ...` (fdExecArgv).
// It is a FRESH process: it runs nothing concurrently, so no other thread can open a descriptor between its check and its
// exec (the controller cannot say the same: its TLS stack opens files without O_CLOEXEC, and node itself opens
// /proc/self/maps and its own binary without it). It
//   1. closes every descriptor above 2 that would survive an exec (no O_CLOEXEC in /proc/self/fdinfo): the inherited ones;
//      its own (node's event loop, the module it was loaded from) are O_CLOEXEC and close at the exec;
//   2. checks again that none above 2 remains without O_CLOEXEC;
//   3. execs the command in its place (process.execve: the same pid, so the caller's process group and kill path are
//      unchanged), with the environment it was given.
// FAIL CLOSED: when it cannot establish the property (no /proc, an unreadable fdinfo, a descriptor still open without
// O_CLOEXEC after its close, no process.execve) it exits FDS_REFUSED (125) with a line on stderr, and the command never
// runs. A command that is not an executable file exits 127. Linux only, as the jails are.
//
//   node pantheon/src/agy/fd-exec.mjs <command> [args ...]     (the command is looked up on PATH when it has no "/")
//
// Must never: exec the command with a descriptor above 2 that lacks O_CLOEXEC; close one of node's own (O_CLOEXEC) ones;
// fall back to running the command when the property cannot be established.
import { accessSync, closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This module's own path: the program fdExecArgv puts in front of bwrap. */
export const FD_EXEC_MODULE = fileURLToPath(import.meta.url);
/** The closer's refusal: it could not establish the property, and ran nothing (the verify launcher's VERIFY_JAIL_REFUSED). */
export const FDS_REFUSED = 125;
/** The descriptors a jailed command is given on purpose: stdin, stdout and stderr, and no other. */
export const FDS_PASSED = Object.freeze([0, 1, 2]);
const O_CLOEXEC = 0o2000000;
const fdsError = (code, message, more = {}) => Object.assign(new Error(message), { code, ...more });

/** The real descriptor table: [{fd, flags}] from /proc/self/fd and /proc/self/fdinfo (flags null for one gone meanwhile). */
const PROC = Object.freeze({
  list: () => readdirSync("/proc/self/fd").map(Number).filter(Number.isInteger),
  flags: fd => {
    let text;
    try { text = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"); }
    catch (e) {
      // ENOENT: gone since the listing (the listing's own descriptor); anything else for an open one cannot be judged.
      try { fstatSync(fd); } catch { return null; }
      throw fdsError("FDS_UNREADABLE", `the flags of descriptor ${fd} cannot be read (${e?.code ?? e?.message ?? e})`);
    }
    const m = /^flags:\s*([0-7]+)\s*$/m.exec(text);
    if (!m) throw fdsError("FDS_UNREADABLE", `/proc/self/fdinfo/${fd} carries no flags line`);
    return parseInt(m[1], 8);
  },
  close: fd => closeSync(fd),
});

/**
 * The descriptors above 2 that would survive an exec (no O_CLOEXEC): [fd]. `io` {list, flags} replaces /proc (tests).
 * Throws FDS_UNREADABLE when the table cannot be read.
 */
export function inheritableFds(io = PROC) {
  let fds;
  try { fds = io.list(); } catch (e) { throw fdsError("FDS_UNREADABLE", `the descriptor table cannot be listed (${e?.code ?? e?.message ?? e})`); }
  const out = [];
  for (const fd of fds) {
    if (fd <= 2) continue;
    const flags = io.flags(fd);
    if (flags !== null && !(flags & O_CLOEXEC)) out.push(fd);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Close every descriptor above 2 that lacks O_CLOEXEC, then check that none is left: {closed: [fd]}. Throws FDS_UNREADABLE
 * (the table cannot be read) or FDS_INHERITED (one is still open without O_CLOEXEC: `left`). Never touches 0, 1, 2 or an
 * O_CLOEXEC descriptor (node's own).
 */
export function establishNoInheritedFds(io = PROC) {
  const closed = [];
  for (const fd of inheritableFds(io)) {
    try { io.close(fd); closed.push(fd); } catch { /* checked below */ }
  }
  const left = inheritableFds(io);
  if (left.length) throw fdsError("FDS_INHERITED", `descriptor(s) ${left.join(", ")} still open without close-on-exec after closing`, { left, closed });
  return { closed };
}

/** `cmd` as execve needs it: itself when it holds a "/", else the first executable regular file of that name on `PATH`. */
export function resolveCommand(cmd, PATH = process.env.PATH ?? "") {
  const ok = p => { try { return statSync(p).isFile() && (accessSync(p, constants.X_OK), true); } catch { return false; } };
  if (typeof cmd !== "string" || !cmd) return null;
  if (cmd.includes("/")) return ok(cmd) ? cmd : null;
  for (const d of String(PATH).split(":")) { const p = join(d || ".", cmd); if (isAbsolute(p) && ok(p)) return p; }
  return null;
}

/** The argv that starts `argv` (a jail's bwrap argv, or the command itself) through this closer, with the node binary `node`. */
export function fdExecArgv(argv, { node = process.execPath } = {}) {
  if (!Array.isArray(argv) || !argv.length) throw new Error("fdExecArgv: pass the argv to start");
  return [node, FD_EXEC_MODULE, ...argv];
}

const probes = new Map();
/**
 * Does the closer work here, with `node`? Runs it once per node binary (cached) on a real case: a descriptor above the
 * range node marks at startup (fd 20, open on this module's file, without close-on-exec) is handed to the closer, which
 * execs `node -e` that looks for any descriptor on that file. {ok, why?}; never throws. The gates of both jails call it
 * before anything is admitted, charged or spawned (SANDBOX_UNAVAILABLE when it fails).
 */
export function fdExecAvailable({ node = process.execPath } = {}) {
  if (!probes.has(node)) {
    probes.set(node, new Promise(resolveProbe => {
      let fd = null, done = false;
      const finish = r => { if (done) return; done = true; if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } } resolveProbe(r); };
      try {
        const target = realpathSync(FD_EXEC_MODULE);
        fd = openSync(target, "r");
        const check = `const fs=require("fs");let n=[];for(const f of fs.readdirSync("/proc/self/fd")){try{if(fs.readlinkSync("/proc/self/fd/"+f)===${JSON.stringify(target)})n.push(f)}catch{}}process.stdout.write(n.length?"LEAKED "+n.join(","):"CLEAN")`;
        const c = spawn(node, [FD_EXEC_MODULE, node, "-e", check], { env: {}, stdio: ["ignore", "pipe", "pipe", ...Array(17).fill("ignore"), fd] });
        let out = "", err = "";
        c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { err += d; });
        const timer = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } finish({ ok: false, why: "the descriptor closer did not finish within 15 s" }); }, 15000);
        timer.unref?.();
        c.on("error", e => { clearTimeout(timer); finish({ ok: false, why: `the descriptor closer could not be started with ${node}: ${e?.code ?? e?.message ?? e}` }); });
        c.on("close", code => {
          clearTimeout(timer);
          if (code === 0 && out === "CLEAN") finish({ ok: true });
          else finish({ ok: false, why: `the descriptor closer (${node}) exited ${code} with ${JSON.stringify(out.slice(0, 120))}: ${err.trim().slice(0, 240) || "no message"}` });
        });
      } catch (e) { finish({ ok: false, why: `the descriptor closer's probe could not run: ${e?.code ?? e?.message ?? e}` }); }
    }));
  }
  return probes.get(node);
}

// ---- THE PROGRAM -------------------------------------------------------------------------------------------------------
const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(FD_EXEC_MODULE); } catch { return false; } })();
if (isMain) {
  const refuse = why => { process.stderr.write(`pantheon-fds: refused: ${why}; the jail was not started\n`); process.exit(FDS_REFUSED); };
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) refuse("no command was given");
  if (typeof process.execve !== "function") refuse(`this node (${process.version}) has no process.execve: the descriptors cannot be closed in the process that becomes the jail`);
  try { establishNoInheritedFds(); }
  catch (e) { refuse(e?.message ?? String(e)); }
  const file = resolveCommand(cmd, process.env.PATH);
  if (!file) { process.stderr.write(`pantheon-fds: ${cmd}: not an executable file${cmd.includes("/") ? "" : " on PATH"}\n`); process.exit(127); }
  process.execve(file, [cmd, ...args], process.env);
}
