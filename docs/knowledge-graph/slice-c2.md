# Knowledge graphs, Slice C2: the SDK seat's bubble

**Slice** C2 of the program the owner's directive of 2026-11-20 sets (`docs/knowledge-graph/directive-2026-11-20.md`), after Slice C1 (`docs/knowledge-graph/slice-c1.md`, sections 3, 4 and 11).
**Branch** `kg/slice-c2`, from `a028497`.
**Owner decision** (2026-11-20, quoted in `docs/OPEN-LIMITATIONS.md`, "Owner decisions, 2026-11-20 (knowledge graphs, Slice C)"): "Yes, bubble per seat". Every seat is a single-assignment sandbox: its model, runtime and tools isolated, given only scoped credentials and capabilities, torn down after its assignment. Register L-155 recorded the gap for the python SDK seat: its agent's `run_command` ran as the controller's user, outside any sandbox, and could read the controller's environment (`/proc/<pid>/environ`, which holds `GEMINI_API_KEY`) and spend outside the metering relay. This slice closes that gap and records, on each run attempt, which Antigravity transport served it (KG-6). KS1 to KS5 are the coordinator's decisions; this document says how each is implemented and does not reopen them.

| Decision | Implemented in | Section |
|---|---|---|
| KS1 the jail | `pantheon/src/agy/sandbox.mjs` `sdkSeatJail`, `sdkSeatJailGate`, `dropSdkSeatScratch`; the spawn points `pantheon/src/board/run-item.mjs` (the `transport === "sdk"` branch) and `pantheon/bin/agy-seat.mjs` | 1 to 4 |
| KS2 tests with a stub seat | `pantheon/tests/agy-sdk-jail.test.mjs`, its fixtures `pantheon/tests/fixtures/agy-sdk-jail-*`; `pantheon/tests/l150-billing.test.mjs` adapted | 7 |
| KS3 the graph | `pantheon/src/capability/runtimes.json` (`environments.sdk-jail`, `limitations.L-155` and `sdk-jail-egress`, `profiles.agy-sdk.bubble`); `pantheon/tests/capability-*.test.mjs` | 5 |
| KS4 the transport on each attempt | `run-item.mjs` `agyTurn` (`onTransport`) and `turn`; `pantheon/src/capability/metrics.mjs` unchanged (it already maps `agy-cli` and `agy-sdk`) | 6 |
| KS5 this document | | |

## 1. The jail

The seat's WHOLE process -- the python interpreter running `pantheon/scripts/agy-seat.py`, and so the SDK's harness and every tool it runs, `run_command` included -- runs inside bubblewrap, at both spawn points, built by one builder, `sdkSeatJail` in `sandbox.mjs`, beside the CLI lanes' `bwrapArgs` (which is unchanged) and after its conventions: binds emitted parent-first by depth, every path real.

| bwrap argument | What it does | Why |
|---|---|---|
| `--die-with-parent --unshare-pid --new-session` | its own PID namespace; a new session; the jail dies with its controller | no controller process is visible, so no `/proc/<pid>/environ` of the controller can be read; no TIOCSTI into the controller's terminal |
| `--ro-bind / /` | the host, read-only | the interpreter, its libraries and the tools the seat runs must be found; nothing of the host is writable |
| `--dev /dev`, `--proc /proc` | a fresh `/dev` (no host `/dev/shm`) and a fresh `/proc` of the new PID namespace | the host's `/proc` would show every controller process |
| `--tmpfs /tmp` | a fresh `/tmp`: the seat's scratch (`TMPDIR=/tmp`) | it exists only in the jail's mount namespace and is gone when its last process exits |
| `--tmpfs <dir>` then, after every bind, `--remount-ro <dir>` | each HIDDEN directory: empty and read-only | see "hidden" below; a write there fails instead of landing, unseen, in a tmpfs |
| `--ro-bind /dev/null <file>` | each HIDDEN file | a credential file or an agent socket outside the hidden directories |
| `--ro-bind <p> <p>` | VISIBLE again, read-only, where a hidden location (or the fresh `/tmp`) covers it | the interpreter and its venv, the venv's base interpreter, the repository, the seat script, the brief and the schema |
| `--bind <workspace>`, `--bind <out dir>` | the ONLY writable host paths | the seat's workspace, and its out dir (its brief, schema, result, response, progress trail, and its own HOME) |
| `--chdir <workspace>` | the seat starts in its workspace | the launcher's cwd may be a hidden location |

**Hidden** (`sdkSeatHidden`): every HOME the controller has -- `$HOME`, `os.homedir()` and the passwd entry's -- and with it every credential location under it: the ADC file and the gcloud config under `~/.config/gcloud`, the Antigravity CLI's state and OAuth login under `~/.gemini`; the user's runtime dir (`XDG_RUNTIME_DIR`, `/run/user/<uid>`: agent sockets); the ssh agent's socket (`SSH_AUTH_SOCK`); and the file and directory the controller's own environment names as Google credentials (`GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_CONFIG`). A HOME of `/` is refused (`SDK_JAIL_LAYOUT`): it cannot be hidden without hiding the host.

**Visible, read-only**: the interpreter as given; its venv (when `<python>/../../pyvenv.cfg` exists) and the venv's base interpreter's prefix (`pyvenv.cfg` `home`); its real path and, for a binary (not a `#!` script), the prefix of its real path (its standard library). A shim interpreter (pyenv's) needs its whole tree and is not supported: pass the venv's or the real interpreter.

**Writable**: the workspace and the out dir, nothing else on the host. The seat's HOME must be a directory of its own inside the out dir (`SDK_JAIL_LAYOUT` otherwise), as it was before the jail. A workspace or out dir that IS a hidden location, `/` or `/tmp` is refused. The board's seat progress trail now goes to `<out dir>/progress.jsonl` and is copied, line by line as it grows, into the run's `progress.jsonl`; the direct launcher refuses a `--progress` outside `--workspace` and `--out`.

**The environment is an allowlist** (`sdkSeatEnv`, `SDK_JAIL_ENV_ALLOW`): the relay capability (`PANTHEON_AGY_RELAY_URL`, `PANTHEON_AGY_RELAY_CAPABILITY`), `HOME`, `PATH`, the locale (`LANG`, `LANGUAGE`, `LC_*`), `TZ`, `TERM`, `USER`, `LOGNAME`, `SHELL`, the proxy and certificate settings, and `TMPDIR=/tmp`; plus what the operator's `PANTHEON_AGY_ENV_PASS` names, explicitly. Nothing is inherited by default: the spawn is given exactly this environment. It is built from `agySdkEnvOf` (`board/agy-cli.mjs`), whose withholding stays, and RE-CHECKED: a credential-named variable (`SDK_JAIL_ENV_REFUSED`: any KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL or COOKIE name, `GOOGLE_*`, `GEMINI_*`, `CLOUDSDK_*`, Vertex) refuses the seat (`SDK_JAIL_ENV`, names only, never a value) instead of being dropped, so a regression upstream fails loudly. `agy-seat.py` still removes its withheld names itself before the SDK starts.

**Retained, never claimed isolated** (`runtimes.json` limitation `sdk-jail-egress`, as L-004 is recorded for the CLI lanes): THE NETWORK IS SHARED. The relay listens on loopback and the scout's web tools need egress, so there is no `--unshare-net`, and bwrap has no egress filter: host loopback services, the LAN and a cloud metadata endpoint stay reachable from the jail (on a cloud VM the metadata endpoint can mint a service account's token: a path to spend outside the relay that the jail does not close). The host outside the hidden locations stays READABLE, and its Unix sockets connectable (a read-only mount does not stop `connect()`): for example a container daemon's socket under `/run`. The code quote: `sandbox.mjs`, "THE NETWORK IS SHARED, and recorded as RETAINED (runtimes.json limitation sdk-jail-egress".

**Fail closed, no override**: `sdkSeatJailGate` probes bwrap (`sandboxAvailable`) and then the jail's own flags (`sdkJailAvailable`: a PID namespace with a fresh `/proc`, a new session, a tmpfs remounted read-only). No bwrap, or a failing probe, refuses the seat with `SANDBOX_UNAVAILABLE` before the relay exists: nothing admitted, charged or spawned. The CLI's recorded `allowUnsandboxed` is not extended to the SDK seat. A jail that cannot be built (`SDK_JAIL_LAYOUT`, `SDK_JAIL_ENV`) refuses the seat after the relay session opened and before anything is spawned; the session is closed with nothing admitted.

## 2. The lifetime

One jailed process per assignment. After it, on every path -- an answer, a relay refusal, the controller's timeout, a stop or a kill -- the spawn point removes the seat's HOME (`dropSdkSeatScratch`; a removal that fails is surfaced on the progress trail and in the launcher's report, never swallowed), the jail's `/tmp` is gone with the jail's mount namespace, and the relay session is closed and its capability revoked, as before. The assignment's records in the out dir (brief, schema, result, response, progress, relay outcomes) stay: they are the run's. A controller that is itself killed with SIGKILL cannot remove anything: the jail dies with it (`--die-with-parent`) and the relay's capability with its process, and the seat's HOME, which holds no credential, is left in the out dir.

## 3. The two spawn points

| Spawn point | Gate (before the relay) | Jail built | Spawn | Teardown |
|---|---|---|---|---|
| the board's SDK seat, `run-item.mjs` `agyTurn` (`PANTHEON_AGY_TRANSPORT=sdk`; `pantheon-board`, `pantheon-compare`, operate's `runOpenItem`) | `sdkSeatJailGate({bwrap: opts.sdkJail?.bwrap ?? "bwrap"})`, after the billing admission, the venv, Vertex and key checks; refused as `turn.refused` and an attempt with `SANDBOX_UNAVAILABLE`, 0 requests | after the relay session and the seat's HOME: workspace the board's worktree, out dir `outputs/open-items/<key>/agy_google/<purpose>-<n>`, read the brief and the schema | `[...jail.prefix, python, ...args]` with `jail.env`, through `spawnPromise` (its timeout and the run's stop signal unchanged) | the `finally` of the spawn |
| the governed direct launch, `bin/agy-seat.mjs` (L-151) | `sdkSeatJailGate()` (bwrap from `PATH`), after the policy, Vertex, key and python checks; exit 2 with `{refused: {code: "SANDBOX_UNAVAILABLE"}}` | after the relay session and the seat's HOME: `--workspace` (required, must exist) and `--out`, read `--brief` and `--schema`; the seat's path arguments made absolute | `[...jail.prefix, python, SEAT, ...args]` with `jail.env` | after the child exits; `jail` and `teardown` in the report and `relay-session.json` |

`opts.sdkJail.bwrap` names the binary as `runAgyCliTurn`'s `sandbox.bwrap` does for the CLI lanes: code-level, not reachable from a command line or an environment variable, and a binary that is missing or fails the probe refuses.

## 4. What the jail does not change

The seat's tool policy (`agy-seat.py`'s `_destructive` predicate, its tools and subagent), its relay use and its billing are unchanged: every Gemini request is still admitted and charged at the relay before it is forwarded (L-150), and `agy-seat.py` itself needed no change to run in the jail. The CLI lanes' jail (`bwrapArgs`, `prepareWorkerJail`) is untouched.

## 5. The bubble, as now recorded

`runtimes.json`: the SDK profile's environment is `sdk-jail` (sandboxed; replacing `host-process`, which no seat runs as any more); its tools run in `sdk-jail`; its credential scope `gemini-relay` cites the jail's environment re-check. C1's rule is unchanged (`graph.mjs`, untouched): a component holds only when declared so and every quote of its evidence is found; a capability is isolated only when all four hold or do not apply.

| Profile | sandbox | credentials | tools | lifetime | isolated |
|---|---|---|---|---|---|
| `api` | not applicable (no tool executes on this host) | holds | holds (none given) | **does not hold**: records persist under `$PANTHEON_HOME` | no |
| `agy-cli` | holds (L-004 retained) | holds | holds | holds | yes |
| `agy-sdk` | holds: the jail at both spawn points, no override (`sdk-jail-egress` retained) | holds: the relay's scoped capability, the allowlist and its re-check, HOME hidden, its own PID namespace | holds: every tool runs inside the jail, writable only the workspace and the out dir (`sdk-jail-egress` retained) | holds: HOME removed on every path, `/tmp` gone, the relay session closed | **yes** |

The quotes (each found verbatim): the gate's refusal and the jail's argv (`sandbox.mjs`), the board's gate and jailed spawn (`run-item.mjs`), the launcher's gate and jailed spawn (`bin/agy-seat.mjs`); the allowlist's refusal, the hide of the controller's HOMEs; the writable binds and the hidden directories' `--remount-ro`; the teardown at both spawn points and `dropSdkSeatScratch`, and the relay's revocation.

**L-155** stays a `capability/limitation` entity, `status: closed`, `breaks: []`, with its register line (still found in `docs/OPEN-LIMITATIONS.md`) and the jail's quotes as its evidence: nothing is `limited-by` it. If the jail's quotes disappear from the code, the SDK seat's sandbox, credentials and tools are `unresolved`, it is not isolated, and the closing of L-155 is unresolved too (`capability-graph.test.mjs`, "the SDK seat's jail is its evidence"). The register's own entry for L-155 is the coordinator's to update.

**sdk-jail-egress** (retained): the SDK capability, the `sdk-jail` environment and `agy-sdk/run_command` are `limited-by` it.

The property "isolation is never claimed without code evidence" keeps its test and its mutation (C7), moved onto a FIXTURE capability (`pantheon/tests/fixtures/capability-bubble-fixture.json`) whose sandbox quote is missing, with a control that the same claim on a found quote holds. The negative example among the real profiles is now the API seat (C6, retargeted).

## 6. The transport on each attempt (KG-6)

An Antigravity seat's own transport is `agy` (`frontier.mjs` `seatTransport`), which does not say whether the CLI lane or the python SDK seat served it. `agyTurn` resolves it (the unchanged rule: the planner, the implementer and a declared `agy-cli` lane on the CLI; otherwise `PANTHEON_AGY_TRANSPORT`, default CLI) and reports it at once (`onTransport`), and `turn` records the resolved transport on the attempt: `agy-cli` or `agy-sdk`, on success and on failure, a refusal before the spawn included. The attempt's `settings.transport` keeps the seat's transport as selected. Only a turn that fails before it resolves one (an unknown purpose, an unknown `PANTHEON_AGY_TRANSPORT`) records the seat's own. `metrics.mjs` needed no change: `capabilityOfSeat` already maps `agy-cli` and `agy-sdk` onto their capabilities, and a record that says `agy` stays readable and is listed unmapped, as before.

**What remains of KG-6**: the run's `turns` rows still carry the seat's transport (`agy`), so the metrics' `accepted` outcome, read from the work turns, cannot attribute an `agy` work turn (the implementer is always on the CLI); per-assignment teardown for API seats (below); a serving profile for the review runner's toolbox; the run recorder appending the `capability` ledger input. The SDK seat's sandbox (L-155) and the attempt's transport are done.

## 7. The tests, and what the stub proves

The google-antigravity SDK is not installed where the tests run. The seat's python, passed through the existing `PANTHEON_AGY_PYTHON` and `--python`, is a stub interpreter (`fixtures/agy-sdk-jail-helpers.mjs`): a `#!` script that runs the probe (`fixtures/agy-sdk-jail-probe.py`) INSIDE the real jail, launched through the real spawn path at both spawn points, and then execs the real `agy-seat.py` over the L-150 stub SDK, whose requests reach the controller's real metering relay (its upstream a local fake, `fixtures/l150-fake-gemini.mjs`). The controller is a process of its own (`fixtures/agy-sdk-jail-board.mjs` for the board; the launcher itself), started with a SYNTHETIC `GEMINI_API_KEY` in its environment, because `/proc/<pid>/environ` shows the environment a process was started with. Its HOME is a directory of its own outside `/tmp` (under `/var/tmp`, removed after each test): the jail replaces `/tmp` with a fresh tmpfs anyway, so a HOME under it would prove nothing about hiding HOME.

`pantheon/tests/agy-sdk-jail.test.mjs`, nine cells:

| Cell | Spawn point | What it shows |
|---|---|---|
| the builder | none (argv only) | the flags, the hides and their `--remount-ro`, the bind-backs, exactly two writable binds, no `--unshare-net`, the allowlist, the refusals (`SDK_JAIL_ENV` for seven credential names, `SDK_JAIL_LAYOUT` for four layouts and a HOME of `/`) |
| board | `runOpenItem` | the probe finds the synthetic key in no `/proc/*/environ` and not in its environment; the controller's pid is not visible; a non-secret variable the controller holds is not inherited; the ADC file, the Antigravity login, a plain secret and a `GOOGLE_APPLICATION_CREDENTIALS` file outside HOME are not readable; writes outside the workspace and the out dir fail (a file outside, a planted ADC, the repository) and none reaches the host; the workspace, the out dir, the seat's HOME and its `/tmp` are writable, and the `/tmp` marker is not on the host; the relay answers with the capability and refuses without it; every request is charged before it is sent, forwarded with the controller's key; the attempt records `agy-sdk` and maps onto `agy-sdk/agy_google/gemini-3.6-flash`; the seat's HOME is gone, no process is left |
| board timeout path | `runOpenItem` (the controller's bound, 2 s) | the jailed seat killed; its HOME gone; no process left |
| board kill path | `runOpenItem` (the run's stop) | the same, nothing charged |
| board without bwrap | `runOpenItem` (`opts.sdkJail.bwrap` a missing binary) | `SANDBOX_UNAVAILABLE`, 0 requests, nothing spawned, sent or charged, no HOME made, no capability issued |
| launcher | `bin/agy-seat.mjs` | as the board cell; the report names the jail and its writable paths |
| launcher kill path | `bin/agy-seat.mjs` (SIGTERM) | the seat stopped, its HOME removed, no process left |
| launcher without bwrap | `bin/agy-seat.mjs` (no bwrap on `PATH`) | exit 2, `SANDBOX_UNAVAILABLE`, nothing spawned, sent or charged |
| KG-6 | `runOpenItem`, the CLI lane | the attempt records `agy-cli` and maps onto its capability; the same attempt saying `agy` is listed unmapped |

The suite is designated real-bwrap (`scripts/test-gates/real-bwrap-suites.json`): its jail cells skip where `bwrap` does not work, and the test gate reports that UNVERIFIED, never PASS. `l150-billing.test.mjs`, whose launcher and board cells now spawn the seat in the jail, is designated the same way; its stub writes what it records into its out dir, and its crash cell finds the jailed seat's host pid from outside the jail; its assertions are unchanged.

**What the stub cannot prove.** The real SDK's own tool runner -- its harness's `run_command`, file and web tools -- is NOT exercised: the probe stands where those tools stand, as a process the jailed seat starts, and every process the seat starts is inside the same jail (one mount and PID namespace, `--die-with-parent`), but the real harness's behaviour inside the jail (what it writes under its HOME or `/tmp`, whether it needs a path the jail hides) is unverified until a real-SDK run. A probe shows what the jail denies to a process that tries; it does not enumerate every channel (the shared network, readable host files and connectable host sockets are retained, section 1).

## 8. The mutations

`pantheon/tests/agy-sdk-jail.mutate.mjs` (`--only`, `--check`, `--log`, `--copy-root`), modelled on `capability.mutate.mjs`: each mutation on a disposable copy, against only its deciding tests; it exits non-zero on a target that does not apply exactly once (2), a baseline that is not green or skipped a jail cell (3), or a survivor (1).

| Id | The regression | Deciding tests |
|---|---|---|
| J1 | the jail dropped at the board's spawn point | board; the bubble (each profile) |
| J2 | the jail dropped at the direct launcher | launcher; the bubble (each profile) |
| J3 | `--unshare-pid` removed | builder, board, launcher |
| J4 | the fresh `/proc` removed | builder, board, launcher |
| J5 | the controller's HOME not hidden | builder, board, launcher |
| J6 | an unjailed fallback when bwrap is missing | board without bwrap, launcher without bwrap |
| J14 | the host bound writable | builder, board, launcher |
| J11 | the hidden locations left writable | builder, board, launcher |
| J8 | the environment inherited instead of allowlisted | builder, board, launcher |
| J12 | the jail's re-check gone (a credential name dropped, not refused) | builder |
| J7 | the seat's HOME not removed on the timeout path | board timeout path |
| J13 | the launcher keeps the seat's HOME | launcher, launcher kill path |
| J9 | the SDK bubble recorded as holding without its quotes found | the bubble (the SDK seat's jail is its evidence) |
| J10 | the attempt's transport recorded as `agy` | board, KG-6 |

Every C1 mutation of `capability.mutate.mjs` is kept; C6 and C7 are retargeted to the renamed bubble tests.

## 9. Not in this slice: for the owner and the coordinator

**Per-assignment teardown for API seats** needs the owner's ruling on what the bubble requires of a seat with no execution environment (its records under `$PANTHEON_HOME` persist across its turns for continuity). The options:
1. **Not applicable**: an API seat executes nothing on this host, so the bubble's lifetime is recorded `not-applicable` for the `api` profile, on the evidence that no tool is given (the API seats become `isolated`).
2. **Assignment-scoped records**: the seat store keys each record by its assignment and removes (or seals read-only) it when the assignment ends, so a later turn cannot read an earlier assignment's continuity; the lifetime then holds on that teardown's code.
3. **Retain and record**: continuity across turns is kept by design and recorded as a retained limitation of the `api` profile, as `sdk-jail-egress` is; the API seats stay not isolated.
The review runner's toolbox serving profile and the run recorder appending the `capability` ledger input are not this slice's either (`slice-c1.md`, section 11).

## 10. Caveats

- A quote check proves the code says what a claim cites, not that the cited code isolates; the quotes are the jail's argv, its gate and the jailed spawns themselves.
- The retained exposure is real: the network is shared (a cloud metadata endpoint included), the host outside the hidden locations is readable, and host Unix sockets are connectable. Hiding the well-known daemon sockets and a loopback-only network namespace with the relay passed in are future hardening, each needing a decision (the scout's web tools need egress).
- `--unshare-ipc`, `--unshare-uts` and `--unshare-cgroup` are not used, following `bwrapArgs`'s conventions.
- The timeout cell drives the controller's bound to 2 s with `PANTHEON_AGY_TIMEOUT=-58` (the bound is the seat's timeout plus 60 s of grace); no knob was added for it.
- On the run's stop path the board records the run's error but not the aborted critique attempt (unchanged by this slice).

## 11. Descriptors (KG-11)

Register KG-11: the jails passed through descriptors the controller inherited. Once in four full `npm test` runs the verify_cmd launched by agy's run_command held fd 20 on the container's proxy CA bundle. Node's `spawn` and bwrap close nothing beyond the stdio they set up, so a descriptor a supervisor leaks into the controller without close-on-exec reached every jailed command, the SDK seat's included.

**The property.** Every jailed command starts with no open descriptor beyond 0, 1 and 2. This holds whatever the starting process inherited and whatever its number, at every spawn point of both jails:
- the agy CLI worker (`prepareWorkerJail`: the unit worker, the single turns, the preflight and the quota probe, the review runner's agy lane);
- the verify_cmd its run_command launches, and the controller's own runVerify (the verify launcher, `src/agy/verify-jail.mjs`);
- the python SDK seat's whole process, at the board (`run-item.mjs`) and at the direct launcher (`bin/agy-seat.mjs`).

No jail passes any other descriptor on purpose. The command gets its stdin, stdout and stderr (the controller's pipes, or what the launcher was given), recorded as `descriptors.passed: [0, 1, 2]` on the CLI jail's sandbox record and the SDK jail's record.

**The mechanism** (`src/agy/fd-exec.mjs`, choice (a) of the decision, placed in front of bwrap). Every jail's argv is `[node, fd-exec.mjs, bwrap, ...]`. The closer is a fresh process. It:
1. closes every descriptor above 2 that lacks O_CLOEXEC in `/proc/self/fdinfo`;
2. checks again that none is left;
3. replaces itself with bwrap (`process.execve`).

Because it replaces itself, the pid, the process group and the kill path are those bwrap had before. Its own descriptors (node's event loop, the module it loaded) are close-on-exec and close at the exec. The work is done in the child and not in the controller, choice (b), for three reasons, each observed here:
- The controller runs other threads: node opens `/proc/self/maps` and its own binary without O_CLOEXEC, and its TLS stack opens CA files the same way (KG-11's descriptor was a CA bundle). A scan made in the controller cannot exclude a descriptor opened between the scan and the fork. Closing one there could pull a file out from under another thread.
- Node marks only a low range of inherited descriptors close-on-exec at startup. On node 24.22, strace shows `fcntl(fd, F_SETFD, FD_CLOEXEC)` on 0..16, and an inherited fd 20 above a gap stays inheritable. The verify launcher's earlier comment ("node marks every inherited fd above 2") was wrong for such a descriptor.
- bwrap 0.9 has no option to close descriptors, and a POSIX sh cannot name one above 9.

The closer runs on the host, before bwrap, so it needs nothing visible inside any jail. No new dependency is added: the closer is the controller's own node binary.

**Fail closed.** The gates refuse with SANDBOX_UNAVAILABLE before anything is built, admitted, charged or spawned when the closer does not work here: `sdkJailAvailable` for the SDK seat (no override), `prepareWorkerJail` for the CLI (only the existing explicit `allowUnsandboxed` override, recorded). Each gate's probe (`fdExecAvailable`, cached per node binary) runs the closer on a real case: fd 20 handed over without close-on-exec, and the exec'd command must hold no descriptor on its file. If the closer cannot establish the property at the spawn itself, it exits 125 and the command never runs. That happens with no `/proc`, an unreadable fdinfo, a descriptor still open after its close, or a node without `process.execve`. 125 is the verify launcher's `VERIFY_JAIL_REFUSED`, and the CLI reads the closer's `pantheon-fds:` line as the sandbox failing to start, as it reads bwrap's own.

**The test** (`pantheon/tests/jail-fds.test.mjs`, real-bwrap, gated on `sandboxAvailable("bwrap")`). It is deterministic: it does not depend on what the environment leaks.
- Each controller (`fixtures/jail-fds-controller.mjs`, or the launcher itself) is started with fd 9 and fd 20 open on a synthetic secret without close-on-exec. It first records that its fd 20 is still inheritable.
- Agy's shell opens fd 20 on the secret again (with bash) when it runs the verify launcher. That way the launcher's closer alone decides what reaches the verify_cmd.
- The probe (`fixtures/jail-fds-probe.py`) lists its own `/proc/self/fd` and its parent's, resolves every target, and reads every regular file through its descriptor for the needle.
- Positive controls: the probe spawned by node, and the probe under a bare bwrap, hold fd 20 and read the secret.

Also covered:
- the closer's decisions on an injected table;
- its refusal without `/proc` and without `process.execve`;
- both gates' refusals with a closer that does not work, the board's SDK seat included.

`verify-jail-credential-isolation.test.mjs` now leaks fd 20 on purpose at each launcher entry (agy's shell, a shell exec'ing the launcher, the controller calling runVerify). Its "no inherited descriptor beyond stdio" assertion therefore passes whatever the environment leaks, and fails when the closer is removed.

**The mutations** (`agy-sdk-jail.mutate.mjs`, its suites now including `jail-fds.test.mjs` and the isolation test):

| ID | Mutation | Killed by |
|---|---|---|
| F1 | the closer removed at the verify launcher | CLI worker; isolation WORKER and CONTROLLER |
| F2 | the closer dropped at the SDK seat's board spawn | SDK board |
| F3 | the closer dropped at the direct launcher | SDK launcher |
| F4 | the closer removed from the CLI worker's jail | CLI worker |
| F5 | the closer's refusal replaced by an unprotected run | closer fails closed |
| F6 | the SDK gate stops checking the closer | gates fail closed |
| F7 | the CLI gate stops checking the closer | gates fail closed |
| F8 | the closer closes only 3 to 9 (what a POSIX sh can name) | closer, host, CLI worker, SDK board, SDK launcher |

**What remains.**
- The exact route of the observed failure was not reproduced. In this container the launcher of 42052d1 already closed an injected fd 20 (its `closeInheritedFds`, in the launcher's own process), and a strace of it under the real environment shows no CA bundle opened. The closer now stands in a fresh process in front of every bwrap, the launcher's included, so a descriptor that reached the jail by any route through the starting process is closed. A route inside bwrap itself would not be: none is known, and bwrap passed only stdio in every test here.
- Other bwrap jails start bwrap directly, without the closer: the board's acceptance jail (`board/acceptance.mjs`) and the review runner's grok and codex jails. KG-11 named the two jails above.
- `process.execve` is marked experimental in node 24. Where it is missing (node before 22.15 or 23.11), every jail refuses rather than running without the property. `pantheon/package.json` still says node >= 20; the root pins 24.
- `docs/routing-task-profile.md` ("Inherited descriptors") still states that node marks inherited fds close-on-exec at startup. It is the coordinator's to correct.
- An explicitly unsandboxed CLI run (`allowUnsandboxed`) starts the CLI without the closer, as it starts it without bwrap. It is recorded as such.
- The capability graph's bubble evidence (`runtimes.json`) does not yet quote the closer.
- `agy-sdk-jail.mutate.mjs` now copies the tree under `/var/tmp` by default. Its CLI worker suites cannot see a source tree under `/tmp`, which the CLI jail replaces with a tmpfs.
