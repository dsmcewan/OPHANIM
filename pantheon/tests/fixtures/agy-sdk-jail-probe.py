#!/usr/bin/env python3
# THE PROBE OF THE PYTHON SDK SEAT'S JAIL (knowledge graphs, Slice C2; register L-155; pantheon/tests/agy-sdk-jail.test.mjs).
#
# The tests' stub interpreter (passed as the seat's python through PANTHEON_AGY_PYTHON or the launcher's --python) runs this
# FIRST, inside the real jail, launched through the real spawn path, with the seat's own arguments; it then execs the real
# scripts/agy-seat.py over the L-150 stub SDK (or, for the timeout and kill paths, never does: the probe hangs). It records
# what the jailed seat can and cannot reach, as one JSON file, <out>/jail-probe.json, and never prints a needle.
#
# Its plan arrives in AGY_SDK_JAIL_PLAN (JSON), set by the stub INSIDE the jail (the jail's own environment is an allowlist):
#   key_hex_rev     the controller's synthetic GEMINI_API_KEY, reversed and hex-encoded (so the needle itself is never in an
#                   environment this probe searches: its own plan would otherwise be a match)
#   canary_hex_rev  the value of a non-secret variable the controller's environment holds and the jail's allowlist drops
#   pid_file        a file holding the controller's pid (or `controller_pid`)
#   secrets         paths that must not be readable (the controller's HOME, the ADC file, an explicit credential file)
#   writes          host paths outside the workspace and the out dir that must not be writable
#   hang            seconds to sleep after the report (the timeout and kill paths)
#   tag             names the marker it writes in each writable place (its /tmp included), so the host can be searched for it
# Synthetic needles only; the gateway is reached on loopback, its upstream a local fake.
import json, os, sys, time, urllib.error, urllib.request

def arg(name):
  a = sys.argv[1:]
  return a[a.index(name) + 1] if name in a and a.index(name) + 1 < len(a) else None

plan = json.loads(os.environ.get("AGY_SDK_JAIL_PLAN") or "{}")
needle = lambda k: bytes.fromhex(plan[k])[::-1] if plan.get(k) else None
KEY, CANARY = needle("key_hex_rev"), needle("canary_hex_rev")
out, ws = arg("--out"), arg("--workspace")
own = {k: v for k, v in os.environ.items() if k != "AGY_SDK_JAIL_PLAN"}
rep = {"pid": os.getpid(), "cwd": os.getcwd(), "uid": os.getuid(), "env_names": sorted(own),
       "env_has_key": bool(KEY) and any(KEY in v.encode() for v in own.values()),
       "env_has_canary": bool(CANARY) and any(CANARY in v.encode() for v in own.values()),
       "home": own.get("HOME"), "tmpdir": own.get("TMPDIR")}

# /proc: every process the jail can see, each environ that can be read, and whether any holds the key.
pids, readable, with_key = [], [], []
for d in sorted(os.listdir("/proc")):
  if not d.isdigit():
    continue
  pids.append(int(d))
  try:
    with open(f"/proc/{d}/environ", "rb") as f:
      text = f.read()
    readable.append(int(d))
    if KEY and KEY in text:
      with_key.append(int(d))
  except OSError:
    pass
rep["proc"] = {"pids": pids, "environ_readable": readable, "environ_with_key": with_key}
cpid = plan.get("controller_pid")
if cpid is None and plan.get("pid_file"):
  try:
    with open(plan["pid_file"]) as f:
      cpid = int(f.read().strip())
  except (OSError, ValueError) as e:
    rep["controller_pid_error"] = repr(e)[:200]
ctl = {"pid": cpid}
if cpid is not None:
  p = f"/proc/{cpid}/environ"
  ctl["exists"] = os.path.exists(f"/proc/{cpid}")
  try:
    with open(p, "rb") as f:
      text = f.read()
    ctl.update(readable=True, has_key=bool(KEY) and KEY in text)
  except OSError as e:
    ctl.update(readable=False, error=type(e).__name__)
rep["controller"] = ctl

# The secrets: none readable.
secrets = []
for p in plan.get("secrets", []):
  r = {"path": p}
  try:
    with open(p, "rb") as f:
      text = f.read()
    r.update(readable=True, has_key=bool(KEY) and KEY in text, bytes=len(text))
  except OSError as e:
    r.update(readable=False, error=type(e).__name__)
  secrets.append(r)
rep["secrets"] = secrets

# The writes: outside the workspace and the out dir, none succeeds; inside them (and the jail's /tmp, its scratch), they do.
def write(p):
  try:
    with open(p, "w") as f:
      f.write("written from inside the SDK seat's jail\n")
    return {"path": p, "written": True}
  except OSError as e:
    return {"path": p, "written": False, "error": type(e).__name__}
rep["writes"] = [write(p) for p in plan.get("writes", [])]
control = []
for d in [x for x in (out, ws, own.get("HOME"), "/tmp") if x]:
  p = os.path.join(d, f".agy-sdk-jail-probe-{plan.get('tag') or os.getpid()}")
  r = write(p)
  if d == ws and r["written"]:
    os.unlink(p)                      # the workspace is the run's tree: leave it as it was
  control.append({**r, "dir": d})
rep["control_writes"] = control

# The model gateway: reachable with the capability (its session account, not a provider request), refused without it.
url, cap = own.get("PANTHEON_AGY_GATEWAY_URL"), own.get("PANTHEON_AGY_GATEWAY_TOKEN")
direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def status(req):
  try:
    with direct.open(req, timeout=10) as r:
      return r.status
  except urllib.error.HTTPError as e:
    return e.code
  except Exception as e:
    return repr(e)[:200]
if url:
  rep["gateway"] = {
    "session_with_capability": status(urllib.request.Request(url + "/_pantheon/session", headers={"x-goog-api-key": cap or ""})),
    "request_without_capability": status(urllib.request.Request(url + "/v1beta/models/m:streamGenerateContent?alt=sse", method="POST",
                                                                data=b'{"contents":[]}', headers={"content-type": "application/json"})),
  }
if out:
  with open(os.path.join(out, "jail-probe.json"), "w") as f:
    json.dump(rep, f, indent=1)
if plan.get("hang"):
  time.sleep(float(plan["hang"]))
