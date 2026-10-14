#!/usr/bin/env bash
# Releases what is on origin/main: tags the next version, creates the GitHub release, then pins
# every caller to it (pin-callers.sh). Callers only ever run a release, so a merge to main changes
# nothing until this runs.
# Usage: scripts/release.sh [patch|minor|major]   (default patch; the first release is v1.0.0)
# Releases only when action.yml or dist/ changed since the last tag, unless FORCE=1.
set -euo pipefail
cd "$(dirname "$0")/.."
bump=${1:-patch}
[[ $bump =~ ^(patch|minor|major)$ ]] || { echo "bump must be patch, minor or major" >&2; exit 1; }
git fetch -q --tags origin main
# origin/main already released (say a run that failed while pinning): finish that release.
if done_tag=$(git describe --tags --exact-match --match 'v[0-9]*' origin/main 2>/dev/null); then
  gh release view "$done_tag" >/dev/null 2>&1 || gh release create "$done_tag" --verify-tag --generate-notes --title "$done_tag" >/dev/null
  echo "origin/main is $done_tag; pinning callers"
  exec scripts/pin-callers.sh "$done_tag"
fi
last=$(git tag -l 'v[0-9]*' --sort=-v:refname | head -1)
if [[ -z $last ]]; then next=v1.0.0
else
  IFS=. read -r ma mi pa <<<"${last#v}"
  case $bump in
    major) next="v$((ma + 1)).0.0" ;;
    minor) next="v$ma.$((mi + 1)).0" ;;
    patch) next="v$ma.$mi.$((pa + 1))" ;;
  esac
  # Callers run only action.yml and dist/ (CI keeps dist/ in step with src/ and the dependencies),
  # so docs, scripts, tests and workflows alone are no reason to re-pin every repo. FORCE=1 releases anyway.
  if [[ -z ${FORCE:-} && -z $(git log --oneline "$last..origin/main" -- action.yml dist/) ]]; then
    echo "nothing to release since $last: action.yml and dist/ are unchanged (FORCE=1 to release anyway)"; exit 0
  fi
fi
git tag -a "$next" -m "$next" origin/main
git push -q origin "$next"
gh release create "$next" --verify-tag --generate-notes --title "$next" >/dev/null
echo "released $next"
scripts/pin-callers.sh "$next"
