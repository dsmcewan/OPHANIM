#!/bin/bash
# usage: mutate.sh <name> <target> <perl-expr> ; mutates a COPY (never the worktree) and runs the identity suites there.
M=/home/user/a2mut-selfaudit
ORIG=/home/user/OPHANIM/.claude/worktrees/agent-a42f12a4ebd280d31
SP=/tmp/claude-0/-home-user-OPHANIM/8bfef60b-3756-55f3-89df-0ca9a5198fa7/scratchpad
name=$1; target=$2; expr=$3
cd $M || exit 1
cp "$ORIG/$target" "$target"
perl -0pi -e "$expr" "$target"
if cmp -s "$ORIG/$target" "$target"; then echo "$name: MUTATION DID NOT APPLY"; exit 2; fi
export PATH=/opt/node24/bin:$PATH
node --test --test-concurrency=6 ${TESTS:-ophanim/operate/independence.test.mjs} > "$SP/mut-$name.log" 2>&1
echo "$name: $(grep -E '^ℹ (pass|fail|cancelled)' "$SP/mut-$name.log" | tr '\n' ' ')"
grep -E '^✖' "$SP/mut-$name.log" | sort -u | head -6
cp "$ORIG/$target" "$target"
