#!/usr/bin/env bash
# ONE LIVE operating cycle, run by the owner on the owner's machine (docs/operating-workflow.md):
#
#   verify the board -> next -> run <item> (live seats, live cross-lab review) -> check the proposal ->
#   land the reviewed commit -> apply the proposal with the owner's status keys -> commit status/ledger
#   and docs/STATUS.md -> push (the public-record workflow then updates the item's issue)
#
# usage: scripts/operate-cycle.sh <item>
#
# Needs: the provider keys Pantheon already uses (OPENAI_API_KEY, XAI_API_KEY, GEMINI_API_KEY) and an agy
# login (the planner and implementer seats are the Antigravity lane's claude-sonnet-4-6, so the authoring
# lab is Anthropic's and the three cycle reviewers are xAI, Google and OpenAI); OPHANIM_STATUS_KEYS, the
# directory holding the status ledger's operator and orderer keys (e.g. ~/.local/share/ophanim/status-ledger/keys).
# Optional: OPERATE_TURN=pantheon/bin/cycle-review-http-turn.mjs to review over plain HTTPS instead of the
# SDKs; OPERATE_YES=1 to skip the confirmations (the push is still the last step).
set -euo pipefail

ITEM="${1:?usage: scripts/operate-cycle.sh <item>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

say() { printf '\n== %s\n' "$*"; }
confirm() {
  [ "${OPERATE_YES:-}" = 1 ] && return 0
  read -r -p "$1 [y/N] " answer
  [ "$answer" = y ] || { echo "stopped; nothing further was changed"; exit 1; }
}

: "${OPHANIM_STATUS_KEYS:?set OPHANIM_STATUS_KEYS to the directory holding the status ledger keys}"
[ -d "$OPHANIM_STATUS_KEYS" ] || { echo "no key directory at $OPHANIM_STATUS_KEYS"; exit 2; }
for k in OPENAI_API_KEY XAI_API_KEY GEMINI_API_KEY; do
  [ -n "${!k:-}" ] || { echo "missing $k (a provider key the seats use)"; exit 2; }
done
AGY="${PANTHEON_AGY_CLI:-$HOME/.local/bin/agy}"
command -v "$AGY" >/dev/null 2>&1 || [ -x "$AGY" ] || { echo "no agy CLI at $AGY (set PANTHEON_AGY_CLI; log in with agy first)"; exit 2; }
git diff --quiet && git diff --cached --quiet || { echo "the working tree has uncommitted changes; commit or stash them first"; exit 2; }

SEATS=(--seat planner=agy_google/claude-sonnet-4-6 --seat implementer=agy_google/claude-sonnet-4-6)
TURN=()
[ -n "${OPERATE_TURN:-}" ] && TURN=(--turn "$OPERATE_TURN")
OUT="$HOME/.pantheon/operate/$ITEM-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"

say "1. verify the board (status/ledger)"
node packages/ledger/status.mjs verify

say "2. next: what is dispatchable, and the team it would seat"
node pantheon/bin/pantheon-board.mjs next "${SEATS[@]}"
confirm "Run $ITEM with live seats now?"

say "3. run $ITEM (live seats; bundle in $OUT)"
if ! node pantheon/bin/pantheon-board.mjs run "$ITEM" "${SEATS[@]}" "${TURN[@]}" --out "$OUT" | tee "$OUT/run.out"; then
  echo
  echo "No proposal. If the run shipped and the review cycle has findings, fix or defer each one on the run ledger:"
  echo "  node pantheon/bin/pantheon-review-cycle.mjs fix   --ledger <run ledger> --finding H --commit C --test CMD --before-exit N --after-exit 0"
  echo "  node pantheon/bin/pantheon-review-cycle.mjs defer --ledger <run ledger> --finding H --reason TEXT"
  echo "then: node pantheon/bin/pantheon-board.mjs propose --bundle $OUT [--accept-unverified REASON], and re-run steps 4 to 8 by hand."
  echo "The run ledger and the findings are in $OUT/evidence.json."
  exit 1
fi

say "4. check the proposal (re-derive its evidence with Pantheon's kinds)"
node pantheon/bin/pantheon-board.mjs check "$OUT/proposal.json"
node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(`${p.item}: ${p.from.state} -> ${p.to.state}\nbasis: ${p.to.basis}\ncommit: ${p.evidence.commit}\nreview: ${p.evidence.review.outcome} by ${p.evidence.review.reviewers.map(r=>`${r.vendor}/${r.model} (${r.lab})`).join(", ")}`)' "$OUT/proposal.json"
BRANCH="pantheon/$ITEM"
COMMIT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).evidence.commit)' "$OUT/proposal.json")"
git log --stat -1 "$COMMIT"
confirm "Land $COMMIT ($BRANCH) on $(git rev-parse --abbrev-ref HEAD) and record the status with your keys?"

say "5. land the reviewed commit"
git merge --ff-only "$COMMIT"

say "6. apply the proposal (signed with OPHANIM_STATUS_KEYS; re-renders docs/STATUS.md)"
node packages/ledger/status.mjs apply "$OUT/proposal.json"
node packages/ledger/status.mjs verify

say "7. commit the status change"
DIGEST="$(node --input-type=module -e "import {proposalDigest} from './packages/ledger/status.mjs'; import fs from 'node:fs'; console.log(proposalDigest(JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))))" "$OUT/proposal.json")"
git add status/ledger docs/STATUS.md
git commit -m "Record $ITEM from a board run (proposal $DIGEST)"
git log --oneline -3

say "8. push (the public-record workflow then publishes the issue with its evidence)"
confirm "Push $(git rev-parse --abbrev-ref HEAD) to origin?"
git push origin HEAD
echo "Done. Bundle and proposal: $OUT"
