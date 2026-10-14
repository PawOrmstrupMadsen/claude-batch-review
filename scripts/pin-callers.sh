#!/usr/bin/env bash
# Points every caller at a release: rewrites `uses: PawOrmstrupMadsen/claude-batch-review@…` in each
# repo's .github/workflows/claude-review.yml (and this repo's examples/claude-review.yml) to
# `@<commit sha> # <tag>`, committed straight to the default branch with [skip ci], so a bump costs
# no review and triggers no deploys. The rulesets' admin bypass lets the push through.
# Usage: scripts/pin-callers.sh <tag> [owner…]   (owners default: PawOrmstrupMadsen WhistleSafe)
set -euo pipefail
tag=${1:?usage: pin-callers.sh <tag> [owner…]}; shift
owners=("$@")
[[ ${#owners[@]} -eq 0 ]] && owners=(PawOrmstrupMadsen WhistleSafe)
self=PawOrmstrupMadsen/claude-batch-review
sha=$(gh api "repos/$self/commits/$tag" -q .sha)
echo "$tag = $sha"

pin() { # repo path branch
  local repo=$1 path=$2 branch=$3 meta old new
  meta=$(gh api "repos/$repo/contents/$path?ref=$branch" 2>/dev/null) || return 0
  old=$(gh api "repos/$repo/contents/$path?ref=$branch" -H 'Accept: application/vnd.github.raw')
  new=$(SHA=$sha TAG=$tag python3 -c '
import os, re, sys
s = sys.stdin.read()
s = re.sub(r"^[ \t]*# @main on purpose[^\n]*\n", "", s, flags=re.M)
s = re.sub(r"(uses:\s*PawOrmstrupMadsen/claude-batch-review)@\S+(?:[ \t]+#[^\n]*)?",
           lambda m: m.group(1) + "@" + os.environ["SHA"] + " # " + os.environ["TAG"], s)
sys.stdout.write(s)' <<<"$old")
  if [[ $new == "$old" ]]; then echo "$repo: already on $tag"; return 0; fi
  gh api -X PUT "repos/$repo/contents/$path" -f branch="$branch" -f sha="$(jq -r .sha <<<"$meta")" \
    -f message="ci: claude-batch-review $tag [skip ci]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" \
    -f content="$(printf '%s\n' "$new" | base64 -w0)" >/dev/null
  echo "$repo: pinned to $tag"
}

pin "$self" examples/claude-review.yml main
for owner in "${owners[@]}"; do
  gh repo list "$owner" --limit 300 --no-archived --source --json nameWithOwner,defaultBranchRef \
    -q '.[] | "\(.nameWithOwner) \(.defaultBranchRef.name)"' |
    while read -r repo branch; do pin "$repo" .github/workflows/claude-review.yml "$branch"; done
done
