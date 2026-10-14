#!/usr/bin/env bash
# Points every caller at a release: rewrites `uses: PawOrmstrupMadsen/claude-batch-review@…` in each
# repo's .github/workflows/claude-review.yml (and this repo's examples/claude-review.yml) to
# `@<commit sha> # <tag>`, committed straight to the default branch with [skip ci], so a bump costs
# no review and triggers no deploys. The rulesets' admin bypass lets the push through; where a ruleset
# has no bypass, the bump goes in a PR (without [skip ci], so its required checks run).
# Usage: scripts/pin-callers.sh <tag> [owner…]   (owners default: PawOrmstrupMadsen WhistleSafe)
set -euo pipefail
tag=${1:?usage: pin-callers.sh <tag> [owner…]}; shift
owners=("$@")
[[ ${#owners[@]} -eq 0 ]] && owners=(PawOrmstrupMadsen WhistleSafe)
self=PawOrmstrupMadsen/claude-batch-review
sha=$(gh api "repos/$self/commits/$tag" -q .sha)
echo "$tag = $sha"

failed=()

pin() { # repo path branch
  local repo=$1 path=$2 branch=$3 meta old new err
  if ! meta=$(gh api "repos/$repo/contents/$path?ref=$branch" 2>&1); then
    grep -q "HTTP 404" <<<"$meta" && return 0   # not a caller
    echo "$repo: could not read $path: $meta" >&2; failed+=("$repo"); return 0
  fi
  if ! old=$(gh api "repos/$repo/contents/$path?ref=$branch" -H 'Accept: application/vnd.github.raw' 2>&1); then
    echo "$repo: could not read $path: $old" >&2; failed+=("$repo"); return 0
  fi
  new=$(SHA=$sha TAG=$tag python3 -c '
import os, re, sys
s = sys.stdin.read()
s = re.sub(r"^[ \t]*# @main on purpose[^\n]*\n", "", s, flags=re.M)
s = re.sub(r"(uses:\s*PawOrmstrupMadsen/claude-batch-review)@\S+(?:[ \t]+#[^\n]*)?",
           lambda m: m.group(1) + "@" + os.environ["SHA"] + " # " + os.environ["TAG"], s)
sys.stdout.write(s)' <<<"$old")
  if [[ $new == "$old" ]]; then echo "$repo: already on $tag"; return 0; fi
  local content; content=$(printf '%s\n' "$new" | base64 -w0)
  if err=$(put "$repo" "$path" "$branch" "$(jq -r .sha <<<"$meta")" "$content" " [skip ci]"); then
    echo "$repo: pinned to $tag"
  elif grep -q "Repository rule violations" <<<"$err"; then
    pr_bump "$repo" "$path" "$branch" "$(jq -r .sha <<<"$meta")" "$content"
  else
    echo "$repo: push failed: $err" >&2; failed+=("$repo")
  fi
}

put() { # repo path branch blob-sha content message-suffix
  gh api -X PUT "repos/$1/contents/$2" -f branch="$3" -f sha="$4" -f content="$5" \
    -f message="ci: claude-batch-review $tag$6

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" 2>&1 >/dev/null
}

pr_bump() { # repo path base blob-sha content
  local repo=$1 head="ci/claude-batch-review-$tag" url err
  if url=$(gh pr list -R "$repo" --head "$head" --json url -q '.[0].url') && [[ -n $url ]]; then
    echo "$repo: PR already open: $url"; return 0
  fi
  if ! err=$(gh api -X POST "repos/$repo/git/refs" -f ref="refs/heads/$head" \
      -f sha="$(gh api "repos/$repo/git/ref/heads/$3" -q .object.sha)" 2>&1 >/dev/null) ||
     ! err=$(put "$repo" "$2" "$head" "$4" "$5" ""); then
    echo "$repo: PR branch failed: $err" >&2; failed+=("$repo"); return 0
  fi
  url=$(gh pr create -R "$repo" --base "$3" --head "$head" --title "ci: claude-batch-review $tag" \
    --body "Moves the Claude review workflow to [claude-batch-review $tag](https://github.com/$self/releases/tag/$tag). Opened by \`scripts/pin-callers.sh\` because this branch's ruleset refuses direct pushes.") ||
    { echo "$repo: PR creation failed" >&2; failed+=("$repo"); return 0; }
  echo "$repo: PR $url"
}

pin "$self" examples/claude-review.yml main
for owner in "${owners[@]}"; do
  # Listed first so a failing listing stops the script instead of looking like "no repos".
  repos=$(gh repo list "$owner" --limit 300 --no-archived --source --json nameWithOwner,defaultBranchRef \
    -q '.[] | "\(.nameWithOwner) \(.defaultBranchRef.name)"')
  while read -r repo branch; do [[ -n $repo ]] && pin "$repo" .github/workflows/claude-review.yml "$branch"; done <<<"$repos"
done
if (( ${#failed[@]} )); then echo "not pinned: ${failed[*]}" >&2; exit 1; fi
