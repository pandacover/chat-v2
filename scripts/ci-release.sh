#!/usr/bin/env bash
# The release steps of .github/workflows/release.yml that talk to GitHub, each retried: GitHub's
# release API and upload host answer 5xx now and then ("502 Bad Gateway: Error updating policy" on
# a Windows upload failed the whole release for 0.1.40), and one bad answer shouldn't cost a release.
#
#   ci-release.sh prepare            creates the run's release as a draft, unless it is there already
#   ci-release.sh upload <file>...   adds files to the run's release, replacing any half-uploaded copy
#   ci-release.sh publish            publishes the run's release if it is still a draft
#   ci-release.sh cleanup            deletes the run's release if it is still a draft
#
# Needs VERSION, GITHUB_REPOSITORY and GH_TOKEN; prepare also GITHUB_SHA; publish also RUN_NUMBER,
# GITHUB_SHA and COMMIT_MESSAGE.
set -euo pipefail

tag="v${VERSION}"
repo="${GITHUB_REPOSITORY}"

# Runs the command up to 5 times, waiting 10, 20, 30 and 40 s between tries.
retry() {
  local n=1
  until "$@"; do
    if [ "$n" -ge 5 ]; then
      echo "Failed after $n tries: $*" >&2
      return 1
    fi
    echo "Try $n failed; trying again in $((n * 10)) s: $*" >&2
    sleep $((n * 10))
    n=$((n + 1))
  done
}

# true, false, or none when there is no such release. A failed look is retried, not read as none.
is_draft() {
  local out
  if out=$(gh release view "$tag" --repo "$repo" --json isDraft --jq .isDraft 2>&1); then
    echo "$out"
  elif grep -qi "release not found" <<<"$out"; then
    echo none
  else
    echo "$out" >&2
    return 1
  fi
}

case "${1:-}" in
  prepare)
    # Made up front: if each platform job created its own, they would race and make two releases
    # with the same tag.
    # Each try looks first: a create that answered 502 may have made the draft all the same, and
    # drafts may share a tag, so creating again would make a second one.
    ensure_draft() {
      local draft
      draft=$(is_draft) || return 1
      [ "$draft" != none ] || gh release create "$tag" --repo "$repo" --draft --title "${VERSION}" --target "${GITHUB_SHA}" --notes "Building…"
    }
    retry ensure_draft
    ;;

  upload)
    shift
    ls -l "$@"
    retry gh release upload "$tag" --repo "$repo" --clobber "$@"
    ;;

  publish)
    draft=$(retry is_draft)
    if [ "$draft" != "true" ]; then
      echo "$tag is already published ($draft)."
      exit 0
    fi
    # Runs overlap, so an older run can get here after a newer one: it is published but left behind
    # the newer one as latest, which is the release installed apps update from.
    latest=$(retry gh release view --repo "$repo" --json tagName --jq .tagName 2>/dev/null || echo none)
    newest=true
    if [[ "$latest" =~ ^v0\.1\.([0-9]+)$ ]] && [ "${BASH_REMATCH[1]}" -gt "${RUN_NUMBER}" ]; then
      newest=false
      echo "$latest is newer: $tag is published but not marked latest."
    fi
    retry gh release edit "$tag" --repo "$repo" --draft=false --latest="$newest" \
      --notes "Built from ${GITHUB_SHA::7}: ${COMMIT_MESSAGE}"
    echo "Published $tag."
    ;;

  cleanup)
    # Only a draft: a published release is never touched (one platform's build failing keeps the other's).
    draft=$(retry is_draft)
    if [ "$draft" = "true" ]; then
      retry gh release delete "$tag" --repo "$repo" --yes
      echo "Deleted the draft $tag."
    else
      echo "No draft $tag to delete ($draft)."
    fi
    ;;

  *)
    echo "usage: ci-release.sh prepare | upload <file>... | publish | cleanup" >&2
    exit 2
    ;;
esac
