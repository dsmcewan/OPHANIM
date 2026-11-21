# Coach Continuation Ownership Design

## Intent

The learning loop must not stop at a valid class handoff when the owner is away. The coach owns the transition from a successfully committed class to the already-prepared next class.

## Goals

- Make the coach the explicit next-class activation owner.
- Continue automatically after the prior class commit when the package, board identity, verification and authority boundaries agree.
- Preserve planner, teacher, evaluator and coordinator separation.
- Stop only at an evidence, authority, package, board-conflict or verification boundary.

## Non-goals

- No daemon, provider call, production action, release, merge or new spending authority.
- The coach does not write records, grade independently, change the board or create commits.
- The continuation rule does not bypass an incomplete class gate.

## Approaches

1. **Coach-owned continuation — selected.** The coach remains responsible through the commit handoff and immediately activates the prepared next class. The coordinator performs the write/commit mechanics and returns control to the coach. This matches the owner's direction and keeps educational ownership with the teacher.
2. **Coordinator-owned continuation — rejected.** Technically convenient, but it makes the persistence role decide when teaching resumes and contradicts the requested ownership.
3. **Background daemon — rejected.** It adds runtime and authority machinery that the hypothetical curriculum does not need.

## Behavior

After the coordinator reports the prior class commit, the coach must re-read the committed record, board head and following package. If they agree and the package authorizes teaching, the coach opens the next class and presents its prompt without waiting for another owner message. The class boundary remains recorded, but it is not a pause.

If the package is absent, the board changed, verification failed, the previous class is not committed, role separation is unavailable, or the work would exceed class-scoped authority, the coach records the exact dependency and stops. A push or CI check may be monitored when already part of the PR workflow, but neither silently expands class authority.

## Success

The role contract and protocol name the coach as continuation owner, and regression tests fail if that ownership or automatic activation is removed. The already-committed remedial package remains byte-for-byte immutable; the governing protocol supplies its activation ownership.
