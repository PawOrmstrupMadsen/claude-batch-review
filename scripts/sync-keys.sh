#!/usr/bin/env bash
# Pushes the review key list to GitHub as the ANTHROPIC_REVIEW_KEYS secret, as a repository
# secret on every non-archived, non-fork repo of the personal account and of the WhistleSafe org.
# Repository secrets because personal accounts have no account-wide Actions secrets, and on
# GitHub Free an organisation secret does not reach private repos.
# Usage: scripts/sync-keys.sh [keys-file]   (default ~/.config/claude-review/keys, one key per line)
set -euo pipefail

keys=${1:-$HOME/.config/claude-review/keys}
org=${ORG:-WhistleSafe}
user=${GH_USER:-PawOrmstrupMadsen}
name=ANTHROPIC_REVIEW_KEYS

count=$(grep -cv '^\s*\(#\|$\)' "$keys" 2>/dev/null || true)
[[ ${count:-0} -gt 0 ]] || { echo "no keys in $keys" >&2; exit 1; }
echo "$count key(s) from $keys"

for owner in "$user" "$org"; do
  gh repo list "$owner" --limit 300 --no-archived --source --json nameWithOwner -q '.[].nameWithOwner'
done |
  while read -r repo; do
    if gh secret set "$name" --repo "$repo" < "$keys" 2>/dev/null; then
      echo "$repo: set"
    else
      echo "$repo: FAILED" >&2
    fi
  done
