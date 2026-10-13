#!/usr/bin/env bash
# Pushes the review key list to GitHub as the ANTHROPIC_REVIEW_KEYS secret:
#   - the WhistleSafe organisation secret (all its repos), and
#   - a repository secret on every non-archived, non-fork repo of the personal account
#     (personal accounts have no account-wide Actions secrets).
# Usage: scripts/sync-keys.sh [keys-file]   (default ~/.config/claude-review/keys, one key per line)
set -euo pipefail

keys=${1:-$HOME/.config/claude-review/keys}
org=${ORG:-WhistleSafe}
user=${GH_USER:-PawOrmstrupMadsen}
name=ANTHROPIC_REVIEW_KEYS

count=$(grep -cv '^\s*\(#\|$\)' "$keys" 2>/dev/null || true)
[[ ${count:-0} -gt 0 ]] || { echo "no keys in $keys" >&2; exit 1; }
echo "$count key(s) from $keys"

gh secret set "$name" --org "$org" --visibility all < "$keys"
echo "org $org: set"

gh repo list "$user" --limit 300 --no-archived --source --json nameWithOwner -q '.[].nameWithOwner' |
  while read -r repo; do
    if gh secret set "$name" --repo "$repo" < "$keys" 2>/dev/null; then
      echo "$repo: set"
    else
      echo "$repo: FAILED" >&2
    fi
  done
