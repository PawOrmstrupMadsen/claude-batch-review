#!/usr/bin/env bash
# Releases what is on origin/main: tags the next version, creates the GitHub release, then pins
# every caller to it (pin-callers.sh). Callers only ever run a release, so a merge to main changes
# nothing until this runs.
# Usage: scripts/release.sh [patch|minor|major]   (default patch; the first release is v1.0.0)
set -euo pipefail
cd "$(dirname "$0")/.."
bump=${1:-patch}
git fetch -q --tags origin main
last=$(git tag -l 'v[0-9]*' --sort=-v:refname | head -1)
if [[ -z $last ]]; then next=v1.0.0
else
  IFS=. read -r ma mi pa <<<"${last#v}"
  case $bump in
    major) next="v$((ma + 1)).0.0" ;;
    minor) next="v$ma.$((mi + 1)).0" ;;
    patch) next="v$ma.$mi.$((pa + 1))" ;;
    *) echo "bump must be patch, minor or major" >&2; exit 1 ;;
  esac
  if [[ -z $(git log --oneline "$last..origin/main" -- . ':!examples/claude-review.yml') ]]; then
    echo "nothing to release since $last"; exit 0
  fi
fi
git tag -a "$next" -m "$next" origin/main
git push -q origin "$next"
gh release create "$next" --verify-tag --generate-notes --title "$next" >/dev/null
echo "released $next"
scripts/pin-callers.sh "$next"
