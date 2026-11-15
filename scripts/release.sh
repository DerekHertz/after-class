#!/bin/bash
# Usage: scripts/release.sh [<release tag>], from a clone of the repository on your own machine. It shows which release
# useafterclass.com runs and the release tags after it, prints the notes and warnings for the tag you give or the newest
# one, runs that release's image locally until you press Enter, and deploys it only when you answer y. The deploy is
# scripts/deploy-beta.sh with the digest read here at the start, so a release whose image-digest.txt changes after you saw
# it is refused, not deployed. Only the deploy needs AWS, under your own `aws login`. Nothing on GitHub or the server can
# start a deploy. Needs git, bun, gh, curl, docker and the AWS CLI.
set -euo pipefail

site=https://useafterclass.com
github_repository=DerekHertz/after-class
release_tag='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

say() { echo "release: $*"; }
fail() {
  echo "release: $*" >&2
  exit 1
}

# The version in the site's GET /health, or nothing when it cannot be read or names none.
live_version() {
  local health
  health=$(curl -fsS --max-time 10 --max-filesize 4096 "${site}/health" 2>/dev/null) || return 0
  if [[ "$health" =~ \"version\":\"([0-9]+\.[0-9]+\.[0-9]+)\" ]]; then echo "${BASH_REMATCH[1]}"; fi
}

newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]; }

cd "$(dirname "$0")/.."
tag="${1:-}"
if [ -n "$tag" ] && [[ ! "$tag" =~ $release_tag ]]; then
  echo "usage: scripts/release.sh [v<major>.<minor>.<patch>]" >&2
  exit 2
fi

live=$(live_version)
git fetch --quiet --no-tags origin '+refs/heads/master:refs/remotes/origin/master' '+refs/tags/v*:refs/tags/v*' \
  || fail "cannot fetch master and the release tags from origin"
mapfile -t tags < <(git tag --list 'v*' | grep -E "$release_tag" | sort -V)
after=()
for t in "${tags[@]}"; do
  if [ -z "$live" ] || newer "$t" "v${live}"; then after+=("$t"); fi
done

if [ -n "$live" ]; then
  say "useafterclass.com runs v${live}."
  say "release tags after it: ${after[*]:-none}"
else
  say "useafterclass.com did not report its version, so every release tag is listed."
  say "release tags: ${after[*]:-none}"
fi

if [ -z "$tag" ]; then
  if [ "${#after[@]}" -eq 0 ]; then
    next=v0.1.0
    if [ -n "$live" ]; then
      IFS=. read -r major minor patch <<<"$live"
      next="v${major}.${minor}.$((patch + 1))"
    fi
    say "nothing to deploy. To redeploy or roll back, pass a tag."
    say "to cut ${next}, merge a pull request that sets \"version\": \"${next#v}\" in package.json, then tag its merge commit:"
    cat <<EOF

  git switch master && git pull
  git tag -a ${next} -m ${next}
  git push origin ${next}

EOF
    say "when the release workflow run for ${next} is green, run scripts/release.sh again."
    exit 0
  fi
  tag="${after[-1]}"
  say "using the newest, ${tag}. Pass a tag to pick another."
fi

commit=$(bun scripts/check-release-tag.ts "$tag")
record=$(gh release download "$tag" --repo "$github_repository" --pattern image-digest.txt --output -) \
  || fail "the ${tag} release has no image-digest.txt. Wait for the release workflow to finish, or rerun it."
pattern=$'^commit ([0-9a-f]{40})\ndigest (sha256:[0-9a-f]{64})$'
[[ "$record" =~ $pattern ]] || fail "the ${tag} release's image-digest.txt is not a commit line and a digest line"
[ "${BASH_REMATCH[1]}" = "$commit" ] || fail "the ${tag} release records commit ${BASH_REMATCH[1]}, but the tag is on ${commit}"
digest="${BASH_REMATCH[2]}"

echo
say "${tag} is commit ${commit}"
say "its image is ghcr.io/derekhertz/after-class@${digest}"
say "this digest is the one tried and deployed. If the release names another one later, nothing deploys."
echo
bun scripts/release-notes.ts "$tag" "$commit" "$live"

scripts/try-release.sh "$tag" "$digest" || fail "the local try of ${tag} did not finish, so nothing was deployed"

echo
bun scripts/release-notes.ts --warnings "$tag" "$commit" "$live"
answer=""
read -r -p "Deploy ${tag} to useafterclass.com? [y/N] " answer || true
if [ "$answer" != y ]; then
  say "${tag} was not deployed."
  exit 0
fi

signed_in() { aws sts get-caller-identity --region us-east-2 --query Account --output text >/dev/null 2>&1; }
if ! signed_in; then
  say "the deploy needs your AWS sign-in. Run \`aws login\` in another terminal, then press Enter here. Ctrl-C stops."
  read -r _ || true
  signed_in || fail "still no AWS sign-in, so ${tag} was not deployed. Run \`aws login\`, then scripts/release.sh ${tag}."
fi

scripts/deploy-beta.sh "$tag" "$digest"

for _ in $(seq 1 24); do
  if [ "$(live_version)" = "${tag#v}" ]; then
    say "useafterclass.com now runs ${tag}."
    exit 0
  fi
  sleep 5
done
fail "the deploy finished, but ${site}/health does not report ${tag#v} after 2 minutes. It reports '$(live_version)'."
