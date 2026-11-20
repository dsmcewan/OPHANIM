#!/usr/bin/env python3
# THE DESCRIPTOR PROBE OF THE JAILS (register KG-11; pantheon/tests/jail-fds.test.mjs, docs/knowledge-graph/slice-c2.md
# "Descriptors (KG-11)"). Run as (or by) the jailed command at each spawn point, it records which descriptors the process
# holds and whether any of them reads the synthetic secret, as one JSON file, and never prints the needle.
#
#   python3 jail-fds-probe.py <report> <needle, reversed and hex-encoded> <label> [<the seat's own arguments> ...]
#
# <report> is a file path, or "@out" for <the --out argument>/jail-fds-<label>.json (the SDK seat's out dir, the one place
# its jail lets it write besides the workspace). It lists, for ITSELF and for its PARENT (the jailed command when the probe
# is its direct child): every descriptor's target (readlink of /proc/<pid>/fd/<n>), its close-on-exec flag (fdinfo), and,
# for a regular file, whether its bytes hold the needle -- read THROUGH the descriptor (/proc/<pid>/fd/<n>), which works
# whatever the jail hides of the file's path. A python probe holds nothing of its own once started (PEP 446: what it opens
# is non-inheritable and closed), so its own table is exactly what it inherited, plus the listing's own handle, which is
# closed by the time each entry is resolved and so never appears. Synthetic secrets only.
import json, os, stat, sys

O_CLOEXEC = 0o2000000
report, needle_hex, label = sys.argv[1], sys.argv[2], sys.argv[3]
seat_args = sys.argv[4:]
needle = bytes.fromhex(needle_hex)[::-1]


def table(pid):
  base = f"/proc/{pid}/fd"
  try:
    names = sorted(int(n) for n in os.listdir(base))
  except OSError as e:
    return {"error": e.strerror}
  # Every target first (readlink opens nothing), so a descriptor opened below can never be taken for an inherited one.
  links = {}
  for n in names:
    try:
      links[n] = os.readlink(f"{base}/{n}")
    except OSError:
      pass   # gone: the listing's own handle
  rows = []
  for n, target in links.items():
    row = {"fd": n, "target": target, "cloexec": None, "kind": None, "has_secret": False}
    try:
      with open(f"/proc/{pid}/fdinfo/{n}") as f:
        flags = [l for l in f.read().split("\n") if l.startswith("flags:")]
      row["cloexec"] = bool(int(flags[0].split()[1], 8) & O_CLOEXEC) if flags else None
    except OSError as e:
      row["fdinfo_error"] = e.strerror
    try:
      st = os.stat(f"{base}/{n}")
      row["kind"] = "file" if stat.S_ISREG(st.st_mode) else "dir" if stat.S_ISDIR(st.st_mode) else "fifo" if stat.S_ISFIFO(st.st_mode) \
        else "socket" if stat.S_ISSOCK(st.st_mode) else "char" if stat.S_ISCHR(st.st_mode) else "other"
      if row["kind"] == "file" and st.st_size <= 4 << 20:
        with open(f"{base}/{n}", "rb") as f:
          row["has_secret"] = needle in f.read()
    except OSError as e:
      row["read_error"] = e.strerror
    rows.append(row)
  return {"fds": rows}


def cmdline(pid):
  try:
    with open(f"/proc/{pid}/cmdline", "rb") as f:
      return [a.decode("utf8", "replace") for a in f.read().split(b"\0") if a][:4]
  except OSError:
    return None


ppid = os.getppid()
rep = {"label": label, "pid": os.getpid(), "ppid": ppid, "self": table("self"), "parent": table(ppid), "parent_cmd": cmdline(ppid)}
if report == "@out":
  out = seat_args[seat_args.index("--out") + 1]
  report = os.path.join(out, f"jail-fds-{label}.json")
with open(report, "w") as f:
  json.dump(rep, f, indent=1)
