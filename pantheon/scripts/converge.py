#!/usr/bin/env python3
"""Bounded host-side convergence over the unchanged Board and application controller.

Mesh owns parallel builds. This consumer only rebases and integrates an explicit
finite ticket list. The controller merges the target; Board.merge separately
merges the exact same candidate into staging and unlocks native dependencies.
"""
from __future__ import annotations

import argparse
from contextlib import closing, contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(os.environ.get("ARGO_CONVERGE_SOURCE_ROOT", Path(__file__).resolve().parents[2])).resolve()
sys.path.insert(0, str(ROOT / "tools"))
from board import Board, BoardError, bounded_process, overlaps  # noqa: E402

EXPECTED_CHECKS = ("generated-types", "schema", "boundaries", "types", "board-and-dispatch",
                   "research-python", "research-tests", "research-package", "foundation", "model-and-process")
SHA = re.compile(r"[a-f0-9]{40}\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")


class ConvergeError(RuntimeError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def clean_env():
    return {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C.UTF-8",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"}


def git(repo, *args, binary=False, timeout=120):
    """No hooks, filters, inherited Git overrides, prompt or rebase side effects."""
    prefix = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
              "-c", "core.attributesFile=/dev/null", "-c", "commit.gpgsign=false",
              "-c", "rebase.updateRefs=false", "-c", "rerere.enabled=false", "-c", "color.ui=false"]
    found = subprocess.run(["git", "config", "--name-only", "--get-regexp", r"^filter\."],
                           cwd=repo, env=clean_env(), capture_output=True, timeout=10)
    if found.returncode not in (0, 1):
        raise ConvergeError("Cannot inspect repository filter configuration")
    drivers = {key.rsplit(".", 1)[0][len("filter."):] for key in found.stdout.decode().splitlines() if key.count(".") >= 2}
    for driver in sorted(drivers):
        for field, value in (("clean", ""), ("smudge", ""), ("process", ""), ("required", "false")):
            prefix += ["-c", f"filter.{driver}.{field}={value}"]
    code, data = bounded_process(prefix + list(args), Path(repo), timeout=timeout, cap=64 * 1024 * 1024, env=clean_env())
    if code:
        raise ConvergeError(f"Git {' '.join(args[:3])} failed: {data.decode('utf8', 'replace')[-1600:]}")
    return data if binary else data.decode().strip()


def clean(repo):
    if git(repo, "status", "--porcelain=v1", "--untracked-files=all", "-z", binary=True):
        raise ConvergeError(f"Checkout must be clean: {repo}")


def native_filter_preflight(repo):
    # Our Git edge neutralizes filters, but unchanged Board/controller internals
    # have their own Git calls. Refuse executable repository filter configuration
    # instead of silently running it or changing the operator's configuration.
    found = subprocess.run(["git", "config", "--get-regexp", r"^filter\..*\.(clean|smudge|process)$"],
                           cwd=repo, env=clean_env(), capture_output=True, timeout=10)
    if found.returncode not in (0, 1):
        raise ConvergeError("Cannot inspect native Git filter configuration")
    if any(len(line.split(None, 1)) > 1 and line.split(None, 1)[1].strip() for line in found.stdout.splitlines()):
        raise ConvergeError("Native Board/controller calls require a checkout without executable Git filters")


def head(repo):
    return git(repo, "rev-parse", "HEAD")


def read_rows(board_dir):
    database = board_dir / "board.db"
    if database.is_symlink() or not database.is_file():
        raise ConvergeError("An existing native board database is required")
    # SQLite mode=ro may still create WAL/SHM files next to the source. Read a
    # bounded stable byte snapshot including an existing WAL, then let SQLite
    # manage its sidecars only in private temporary storage. immutable=1 alone
    # would silently ignore uncheckpointed WAL state.
    with tempfile.TemporaryDirectory(prefix="argo-converge-read-") as temporary:
        snapshot = Path(temporary) / "board.db"
        identities = []
        for source, destination in ((database, snapshot), (database.with_name("board.db-wal"), snapshot.with_name("board.db-wal"))):
            if not source.exists():
                identities.append((source, None))
                continue
            before = source.stat()
            if source.is_symlink() or not source.is_file() or before.st_size > 64 * 1024 * 1024:
                raise ConvergeError("Board snapshot is unsafe or exceeds its byte bound")
            destination.write_bytes(source.read_bytes())
            identities.append((source, (before.st_ino, before.st_size, before.st_mtime_ns)))
        for source, expected in identities:
            actual = source.stat() if source.exists() else None
            identity = (actual.st_ino, actual.st_size, actual.st_mtime_ns) if actual else None
            if identity != expected:
                raise ConvergeError("Native board changed during the read-only snapshot")
        with closing(sqlite3.connect(snapshot.as_uri() + "?mode=ro", uri=True)) as db:
            db.row_factory = sqlite3.Row
            result = {}
            for row in db.execute("SELECT * FROM tickets"):
                item = dict(json.loads(row["definition"]), **{k: row[k] for k in row.keys()
                            if k not in ("definition", "policy", "lease_token")})
                result[item["id"]] = item
            return result


def write_bytes(file, data):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(file.parent, os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def record(file, value):
    write_bytes(file, canonical({"payload": value, "sha256": digest(canonical(value))}) + b"\n")


def read_record(file):
    if file.is_symlink() or not file.is_file():
        raise ConvergeError(f"Missing regular journal record: {file}")
    item = json.loads(file.read_bytes())
    if not isinstance(item, dict) or set(item) != {"payload", "sha256"} or digest(canonical(item["payload"])) != item["sha256"]:
        raise ConvergeError(f"Journal hash mismatch: {file}")
    return item["payload"]


@contextmanager
def locks(common):
    opened = []
    try:
        # The second lock excludes the supported Mesh dispatcher while a native
        # first-eligible claim is preflighted. Direct legacy callers still require
        # the documented single trusted operator ownership domain.
        for name in ("argo-convergence-supervisor.lock", "argo-mesh-supervisor.lock"):
            fd = os.open(common / name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            opened.append(fd)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ConvergeError("Supervisor lock must be an unaliased regular file")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ConvergeError("Another convergence or Mesh supervisor is active") from error
        yield
    finally:
        for fd in reversed(opened):
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def owned_diff(repo, base, candidate, owned):
    git(repo, "merge-base", "--is-ancestor", base, candidate)
    paths = [raw.decode() for raw in git(repo, "diff", "--name-only", "--no-renames", "-z", base, candidate, binary=True).split(b"\0") if raw]
    if not paths:
        raise ConvergeError("Candidate has no remaining owned change")
    if any(not any(p == allowed.rstrip("/") or p.startswith(allowed.rstrip("/") + "/") for allowed in owned) for p in paths):
        raise ConvergeError("Candidate changes paths outside immutable ticket ownership")
    return paths


def next_claim(rows, row):
    if any(item["status"] == "CLAIMED" for item in rows.values()):
        raise ConvergeError("Convergence waits for all native worker claims to settle")
    if row["attempt"] >= row["max_attempts"]:
        raise ConvergeError("Stale ticket has exhausted native attempts")
    simulated = {key: dict(value) for key, value in rows.items()}
    simulated[row["id"]]["status"] = "READY"
    held = [item["owned_paths"] for item in simulated.values() if item["status"] in Board.LOCKED_STATES]
    ready = sorted((item for item in simulated.values() if item["status"] == "READY"), key=lambda item: (item["wave"], item["id"]))
    for item in ready:
        if item["seat_model"] != row["seat_model"]:
            continue
        if any(overlaps(a, b) for a in item["owned_paths"] for roots in held for b in roots):
            continue
        if any(simulated[dependency]["status"] != "MERGED" for dependency in item["depends_on"]):
            continue
        if item["id"] != row["id"]:
            raise ConvergeError(f"Native claim would select {item['id']}, not requested {row['id']}")
        return
    raise ConvergeError("Requested ticket would not be eligible for a fresh native claim")


def controller_runner(argv, *, cwd, env, log_path):
    code, output = bounded_process(argv, Path(cwd), timeout=2400, cap=64 * 1024 * 1024, env=env)
    return {"returncode": code, "stdout": output, "stderr": b"", "stream_mode": "combined"}


def gate_summary(output, candidate, trusted):
    lines = output.decode("utf8", "replace").splitlines()
    terminal = f"Merged tested candidate {candidate} using trusted policy {trusted}"
    if lines.count(terminal) != 1:
        raise ConvergeError("Controller did not emit its exact candidate/policy completion record")
    summaries = []
    for line in lines:
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and value.get("controller") == "deterministic-v1":
            summaries.append(value)
    if len(summaries) != 1:
        raise ConvergeError("Controller lacks one complete gate summary")
    summary = summaries[0]
    checks = summary.get("checks", [])
    if (summary.get("merge_ready") is not True or len(checks) != len(EXPECTED_CHECKS)
            or [check.get("name") for check in checks] != list(EXPECTED_CHECKS)
            or any(not HASH.fullmatch(check.get("output_sha256", "")) for check in checks)):
        raise ConvergeError("Controller did not complete every trusted gate group")
    # summary.commit names the controller's temporary staging commit. It is NOT
    # the submitted application SHA; candidate/tree are bound in our outer record.
    return summary


def source_binding(repo, target, trusted_repo, trusted_sha, node):
    if head(trusted_repo) != trusted_sha:
        raise ConvergeError("Trusted checkout HEAD differs from the external immutable pin")
    clean(trusted_repo)
    files = [Path(__file__).resolve(), ROOT / "tools/board.py", ROOT / "tools/board_support.py",
             *(trusted_repo / name for name in ("controller/merge.mjs", "controller/policy.ts", "controller/acceptance-policy.mjs", "scripts/gate.mjs"))]
    sources = {}
    for file in files:
        if file.is_symlink() or not file.is_file():
            raise ConvergeError("Trusted source must be a regular file")
        sources[str(file)] = digest(file.read_bytes())
    return {"repo": str(repo), "target": str(target), "trusted_repo": str(trusted_repo),
            "trusted_sha": trusted_sha, "node": str(node), "sources": sources}


def recovery(board, rows, ticket, journal, binding, repo, target):
    directory = journal / ticket
    if not directory.exists():
        return None
    row = rows[ticket]
    for attempt in sorted(directory.iterdir()):
        if not attempt.is_dir() or attempt.is_symlink():
            raise ConvergeError("Invalid attempt journal directory")
        intent = read_record(attempt / "intent.json")
        if intent["binding"] != binding:
            raise ConvergeError("Journal source/trust/target binding changed")
        complete = attempt / "board-merged.json"
        success = attempt / "controller-passed.json"
        if not success.exists():
            if complete.exists():
                raise ConvergeError("Completed journal lacks its controller receipt")
            # Failure records are terminal for this epoch. A manual fresh native
            # attempt may be processed; an unresolved intent may not be replayed.
            if (attempt / "outcome.json").exists():
                prior = read_record(attempt / "outcome.json")
                if prior.get("status") != "uncertain" and row["epoch"] != intent["original"]["epoch"]:
                    continue
                return {"ticket_id": ticket, **prior, "journal": str(attempt)}
            return {"ticket_id": ticket, "status": "uncertain", "reason": "Prior controller/reconciliation intent lacks a complete receipt", "journal": str(attempt)}
        passed = read_record(success)
        candidate = read_record(attempt / "candidate.json")
        log = attempt / "controller.log"
        if log.is_symlink() or not log.is_file():
            raise ConvergeError("Controller log must be a regular file")
        raw = log.read_bytes()
        expected_argv = [binding["node"], str(Path(binding["trusted_repo"]) / "controller/merge.mjs"), "--repo", str(target), "--candidate", candidate["candidate"], "--trusted", binding["trusted_sha"]]
        if (passed["binding"] != binding or passed["candidate"] != candidate["candidate"]
                or passed["candidate_tree"] != git(repo, "rev-parse", candidate["candidate"] + "^{tree}")
                or passed["log_sha256"] != digest(raw) or passed["returncode"] != 0
                or passed["target_before"] != candidate["base"] or passed["target_after"] != candidate["candidate"]
                or passed["epoch"] != candidate["epoch"] or passed["argv"] != expected_argv):
            raise ConvergeError("Controller recovery receipt is not bound to current source/candidate/log")
        gate_summary(raw, candidate["candidate"], binding["trusted_sha"])
        if complete.exists():
            done = read_record(complete)
            if (row["status"] != "MERGED" or row["merged_commit"] != candidate["candidate"]
                    or done["candidate"] != candidate["candidate"] or done["epoch"] != row["epoch"]):
                raise ConvergeError("Completed journal differs from native merged identity")
            git(repo, "merge-base", "--is-ancestor", candidate["candidate"], head(repo))
            git(repo, "merge-base", "--is-ancestor", candidate["candidate"], head(target))
            return {"ticket_id": ticket, "status": "already_merged", "candidate": done["candidate"], "journal": str(attempt)}
        if head(target) != candidate["candidate"] or row["epoch"] != candidate["epoch"] or row["commit_sha"] != candidate["candidate"]:
            raise ConvergeError("Recovery target/native candidate differs from exact controller receipt")
        clean(target)
        if row["status"] == "MERGED" and head(repo) == candidate["candidate"]:
            merged = row
        elif row["status"] == "REVIEW" and head(repo) == candidate["base"]:
            merged = board.merge(ticket)
        elif row["status"] == "MERGING" and head(repo) in (candidate["base"], candidate["candidate"]):
            merged = board.recover(ticket)
            if merged["status"] == "REVIEW":
                merged = board.merge(ticket)
        else:
            raise ConvergeError("Native staging state is not recoverable from this receipt")
        if merged["status"] != "MERGED" or head(repo) != candidate["candidate"]:
            raise ConvergeError("Native staging merge did not complete recovery")
        record(complete, {"candidate": candidate["candidate"], "epoch": merged["epoch"], "recovered": True})
        return {"ticket_id": ticket, "status": "merged", "candidate": candidate["candidate"], "recovered": True, "journal": str(attempt)}
    return None


def converge(*, repo, board_dir, target, trusted_repo, trusted_sha, journal, tickets,
             node="/usr/bin/node", execute=False, controller_runner=None):
    repo, board_dir, target, trusted_repo, journal, node = (Path(value).resolve() for value in (repo, board_dir, target, trusted_repo, journal, node))
    if not SHA.fullmatch(trusted_sha or "") or os.environ.get("ARGO_CONTROLLER_TRUSTED_SHA") != trusted_sha:
        raise ConvergeError("Require an externally pinned ARGO_CONTROLLER_TRUSTED_SHA matching --trusted-sha")
    if len({repo, target, trusted_repo}) != 3:
        raise ConvergeError("Staging, target and trusted checkouts must be distinct")
    if not isinstance(tickets, list) or not 1 <= len(tickets) <= 100 or len(set(tickets)) != len(tickets) or any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", ticket) for ticket in tickets):
        raise ConvergeError("Supply a bounded list of unique safe ticket IDs")
    for directory in (repo, target, trusted_repo):
        if git(directory, "rev-parse", "--show-toplevel") != str(directory):
            raise ConvergeError("Checkout root required")
        clean(directory)
        native_filter_preflight(directory)
    common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    if common != Path(git(target, "rev-parse", "--path-format=absolute", "--git-common-dir")):
        raise ConvergeError("Bounded convergence requires staging and target to share Git objects")
    stage_ref = git(repo, "rev-parse", "--symbolic-full-name", "HEAD")
    target_ref = git(target, "rev-parse", "--symbolic-full-name", "HEAD")
    if stage_ref != "HEAD" and stage_ref == target_ref:
        raise ConvergeError("Staging and target must not share the same branch ref")
    git(repo, "cat-file", "-e", trusted_sha + "^{commit}")
    binding = source_binding(repo, target, trusted_repo, trusted_sha, node)
    rows = read_rows(board_dir)
    if any(ticket not in rows for ticket in tickets):
        raise ConvergeError("Unknown native ticket")
    if any(rows[ticket]["reviewer_model"] is not None for ticket in tickets):
        raise ConvergeError("Assigned-reviewer tickets require a separately supported exact-candidate review handoff")
    if not execute:
        return {"schema_version": 1, "mode": "dry-run", "ok": True, "target_head": head(target), "staging_head": head(repo),
                "results": [{"ticket_id": ticket, "status": "dry_run", "native_status": rows[ticket]["status"], "candidate": rows[ticket]["commit_sha"]} for ticket in tickets]}
    runner = controller_runner or globals()["controller_runner"]
    results = []
    with locks(common):
        if any(row["status"] == "CLAIMED" for row in read_rows(board_dir).values()):
            raise ConvergeError("Convergence waits for all native worker claims to settle")
        board = Board(repo, board_dir)
        for ticket in tickets:
            rows = read_rows(board_dir)
            try:
                recovered = recovery(board, rows, ticket, journal, binding, repo, target)
            except Exception as error:
                recovered = {"ticket_id": ticket, "status": "uncertain", "reason": str(error)}
            if recovered:
                results.append(recovered)
                if head(repo) != head(target):
                    break
                continue
            row = board.get(ticket)
            if row["status"] == "FAILED":
                results.append({"ticket_id": ticket, "status": "failed", "reason": row["error"]})
                continue
            if row["status"] == "MERGED":
                results.append({"ticket_id": ticket, "status": "blocked", "reason": "Native MERGED without this supervisor's controller receipt"})
                continue
            if row["status"] not in ("VERIFYING", "REVIEW") or row.get("gate_run") or row.get("merge_intent"):
                results.append({"ticket_id": ticket, "status": "blocked", "reason": "Ticket is not a settled submitted candidate"})
                continue
            if head(repo) != head(target):
                results.append({"ticket_id": ticket, "status": "uncertain", "reason": "Staging and target differ without a recovery receipt"})
                break
            before = head(target)
            original = {key: row[key] for key in ("id", "epoch", "attempt", "base_commit", "commit_sha", "spec_sha256", "owned_paths")}
            attempt = journal / ticket / f"epoch-{row['epoch']}"
            reconciled = None
            claim = None
            try:
                owned_diff(repo, row["base_commit"], row["commit_sha"], row["owned_paths"])
                record(attempt / "intent.json", {"binding": binding, "original": original, "target_before": before})
                candidate = row["commit_sha"]
                if row["base_commit"] != before:
                    next_claim(read_rows(board_dir), row)
                    git(repo, "merge-base", "--is-ancestor", row["base_commit"], before)
                    if git(repo, "rev-list", "--merges", f"{row['base_commit']}..{candidate}"):
                        raise ConvergeError("Automatic reconciliation requires a linear ticket history")
                    reconciled = attempt / "rebase-worktree"
                    git(repo, "worktree", "add", "--detach", str(reconciled), candidate)
                    try:
                        git(reconciled, "-c", "user.name=ARGO Convergence", "-c", "user.email=convergence@argo.invalid",
                            "rebase", "--committer-date-is-author-date", "--onto", before, row["base_commit"], timeout=180)
                    except ConvergeError as error:
                        try:
                            git(reconciled, "rebase", "--abort")
                        except ConvergeError:
                            pass
                        outcome = {"status": "conflict", "reason": str(error)}
                        record(attempt / "outcome.json", outcome)
                        results.append({"ticket_id": ticket, **outcome, "journal": str(attempt)})
                        continue
                    candidate = head(reconciled)
                    owned_diff(repo, before, candidate, row["owned_paths"])
                    if row["status"] == "VERIFYING":
                        row = board.verify(ticket)
                    if row["status"] != "REVIEW":
                        raise ConvergeError("Original candidate failed its native data gate")
                    next_claim(read_rows(board_dir), row)
                    returned = board.merge(ticket)
                    if returned["status"] != "READY" or head(repo) != before:
                        raise ConvergeError("Native stale candidate did not return for a fresh attempt")
                    next_claim(read_rows(board_dir), returned)
                    worker = "converge-" + uuid.uuid4().hex[:16]
                    claim = board.claim(worker, row["seat_model"], 900)
                    if not claim or claim["id"] != ticket:
                        raise ConvergeError("Native first-eligible claim changed; unexpected claim requires operator investigation")
                    worktree = board.prepare_worktree(ticket, worker, claim["lease_token"])
                    git(worktree, "checkout", "--detach", candidate)
                    for file in owned_diff(repo, before, candidate, row["owned_paths"]):
                        entry = git(repo, "ls-tree", candidate, "--", file)
                        if entry.startswith(("100644 ", "100755 ")):
                            board.put_artifact(ticket, worker, claim["lease_token"], file, git(repo, "show", f"{candidate}:{file}", binary=True))
                    row = board.submit(ticket, worker, claim["lease_token"], candidate)
                    claim = None
                if row["status"] == "VERIFYING":
                    row = board.verify(ticket)
                if row["status"] != "REVIEW":
                    raise ConvergeError("Candidate failed its native data gate")
                clean(repo); clean(target)
                if head(repo) != before or head(target) != before:
                    raise ConvergeError("Target changed before controller execution")
                if source_binding(repo, target, trusted_repo, trusted_sha, node) != binding:
                    raise ConvergeError("Trusted source changed before controller execution")
                candidate_info = {"candidate": candidate, "base": before, "epoch": row["epoch"], "tree": git(repo, "rev-parse", candidate + "^{tree}")}
                record(attempt / "candidate.json", candidate_info)
                argv = [str(node), str(trusted_repo / "controller/merge.mjs"), "--repo", str(target), "--candidate", candidate, "--trusted", trusted_sha]
                # The selected Node distribution owns its matching npm and
                # subprocess Node. Keep the remainder of PATH deterministic.
                env = {**clean_env(), "PATH": f"{node.parent}:/usr/bin:/bin",
                       "ARGO_CONTROLLER_TRUSTED_SHA": trusted_sha}
                if os.environ.get("ARGO_NPM_CACHE"):
                    env["ARGO_NPM_CACHE"] = str(Path(os.environ["ARGO_NPM_CACHE"]).resolve())
                result = runner(argv, cwd=trusted_repo, env=env, log_path=attempt / "controller.log")
                stdout, stderr = result.get("stdout", b""), result.get("stderr", b"")
                if not isinstance(stdout, bytes) or not isinstance(stderr, bytes):
                    raise ConvergeError("Controller runner must return raw byte streams")
                raw = stdout + stderr
                write_bytes(attempt / "controller.log", raw)
                evidence = {"binding": binding, "argv": argv, "candidate": candidate, "candidate_tree": candidate_info["tree"], "epoch": row["epoch"],
                            "target_before": before, "target_after": head(target), "returncode": result["returncode"], "log_sha256": digest(raw),
                            "stdout_sha256": digest(stdout), "stderr_sha256": digest(stderr), "stream_mode": result.get("stream_mode", "separate-concatenated")}
                record(attempt / "controller-result.json", evidence)
                if result["returncode"] != 0:
                    raise ConvergeError("Application controller refused the candidate")
                summary = gate_summary(raw, candidate, trusted_sha)
                clean(target)
                if head(target) != candidate or head(repo) != before:
                    raise ConvergeError("Controller outcome does not match exact target/staging heads")
                record(attempt / "controller-passed.json", {**evidence, "gate": summary})
                merged = board.merge(ticket)
                if merged["status"] != "MERGED" or head(repo) != candidate or head(target) != candidate:
                    raise ConvergeError("Native staging did not merge the exact controller-accepted candidate")
                clean(repo); clean(target)
                record(attempt / "board-merged.json", {"candidate": candidate, "epoch": merged["epoch"], "recovered": False})
                results.append({"ticket_id": ticket, "status": "merged", "original_candidate": original["commit_sha"], "candidate": candidate,
                                "epoch": merged["epoch"], "journal": str(attempt)})
            except Exception as error:
                # A fresh lease we own may be failed through the public API. A
                # submitted/reviewing attempt is NEVER relabeled by SQL or prose.
                if claim and claim.get("id") == ticket:
                    try:
                        board.fail_claim(ticket, claim["worker_id"], claim["lease_token"], str(error))
                    except BoardError:
                        pass
                uncertain = head(target) != head(repo) or (attempt / "controller-passed.json").exists()
                outcome = {"status": "uncertain" if uncertain else "needs_rework", "reason": str(error)}
                if (attempt / "intent.json").exists() and not (attempt / "outcome.json").exists():
                    record(attempt / "outcome.json", outcome)
                results.append({"ticket_id": ticket, **outcome, "journal": str(attempt)})
                if uncertain:
                    break
            finally:
                if reconciled and reconciled.exists():
                    try:
                        git(repo, "worktree", "remove", str(reconciled))
                    except ConvergeError:
                        pass  # Preserve conflicted/unexpected bytes for inspection.
        return {"schema_version": 1, "mode": "execute", "ok": len(results) == len(tickets) and all(result["status"] in ("merged", "already_merged") for result in results),
                "results": results, "target_head": head(target), "staging_head": head(repo)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("repo", "board-dir", "target", "trusted-repo", "trusted-sha", "journal"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--node", default="/usr/bin/node")
    parser.add_argument("--ticket", action="append", dest="tickets", required=True)
    parser.add_argument("--execute", action="store_true", help="Without this flag, inspect only")
    args = vars(parser.parse_args(argv))
    try:
        result = converge(**args)
        print(json.dumps(result, sort_keys=True))
        return 0 if result["ok"] else 1
    except (ConvergeError, BoardError, OSError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
