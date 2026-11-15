#!/bin/bash
# Usage: scripts/release.sh [--live <tag>] [<release tag>], from a clone of the repository on your own machine. It asks
# for your `aws login` first and reads which release the server runs through Systems Manager, because a network filter
# can block or rewrite useafterclass.com. It lists the release tags after that one, prints the notes and warnings for the
# tag you give or the newest one, runs that release's image locally until you press Enter, and deploys it only when you
# answer y. The deploy is scripts/deploy-beta.sh with the digest and commit read here at the start, so a release whose
# record changes after you saw it is refused, not deployed. After the deploy it reads the server again, then checks
# useafterclass.com from this machine. --live names the release the server runs when the server cannot be read, and the
# screen then says the base is yours, not read. Nothing on GitHub or the server can start a deploy. Needs git, bun, gh,
# curl, docker and the AWS CLI.
set -euo pipefail

release_tag='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

say() { echo "release: $*"; }
fail() {
  echo "release: $*" >&2
  exit 1
}
usage() {
  echo "usage: scripts/release.sh [--live v<major>.<minor>.<patch>] [v<major>.<minor>.<patch>]" >&2
  exit 2
}

newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]; }

cd "$(dirname "$0")/.."
claimed=""
if [ "${1:-}" = --live ]; then
  if [ $# -lt 2 ] || [[ ! "$2" =~ $release_tag ]]; then usage; fi
  claimed="$2"
  shift 2
fi
[ $# -le 1 ] || usage
tag="${1:-}"
if [ -n "$tag" ] && [[ ! "$tag" =~ $release_tag ]]; then usage; fi

signed_in() { aws sts get-caller-identity --region us-east-2 --query Account --output text >/dev/null 2>&1; }
if ! signed_in; then
  say "reading the server and deploying need your AWS sign-in. Run \`aws login\` in another terminal, then press Enter here. Ctrl-C stops."
  read -r _ || true
  signed_in || fail "still no AWS sign-in. Run \`aws login\`, then scripts/release.sh again."
fi

git fetch --quiet --no-tags origin '+refs/heads/master:refs/remotes/origin/master' '+refs/tags/v*:refs/tags/v*' \
  || fail "cannot fetch master and the release tags from origin"
mapfile -t tags < <(git tag --list 'v*' | grep -E "$release_tag" | sort -V)

unverified() {
  echo
  say "UNVERIFIED BASE. The server's release could not be read, and you passed --live ${live}."
  say "The notes and warnings start from ${live}. If the server runs another release, they are wrong."
  echo
}

if read_back=$(bun scripts/live-release.ts server); then
  read -r live live_digest <<<"$read_back"
  if [ -n "$claimed" ] && [ "$claimed" != "$live" ]; then
    fail "the server runs ${live}, not the ${claimed} you passed with --live. Run it without --live."
  fi
  claimed=""
  say "useafterclass.com runs ${live}, image ${live_digest}, read from the server."
elif [ -n "$claimed" ]; then
  [[ " ${tags[*]} " == *" ${claimed} "* ]] || fail "--live ${claimed} is not a release tag"
  live="$claimed"
  unverified
else
  fail "there is no base for the notes, so nothing was tried or deployed. If you know which release it runs, pass it: scripts/release.sh --live <tag>${tag:+ ${tag}}"
fi

after=()
for t in "${tags[@]}"; do
  if newer "$t" "$live"; then after+=("$t"); fi
done
say "release tags after it: ${after[*]:-none}"

if [ -z "$tag" ]; then
  if [ "${#after[@]}" -eq 0 ]; then
    IFS=. read -r major minor patch <<<"${live#v}"
    next="v${major}.${minor}.$((patch + 1))"
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
checked=$(bun scripts/live-release.ts record "$tag") \
  || fail "nothing was tried or deployed. If the release workflow is still running, wait for it to finish, or rerun it."
read -r recorded_commit digest <<<"$checked"
[ "$recorded_commit" = "$commit" ] || fail "the ${tag} release records commit ${recorded_commit}, but the tag is on ${commit}"

echo
say "${tag} is commit ${commit}"
say "its image is ghcr.io/derekhertz/after-class@${digest}"
say "this commit and digest are the ones tried and deployed. If the release names others later, nothing deploys."
echo
bun scripts/release-notes.ts "$tag" "$commit" "$live"

scripts/try-release.sh "$tag" "$digest" "$commit" || fail "the local try of ${tag} did not finish, so nothing was deployed"

echo
bun scripts/release-notes.ts --warnings "$tag" "$commit" "$live"
if [ -n "$claimed" ]; then unverified; fi
answer=""
read -r -p "Deploy ${tag} to useafterclass.com? [y/N] " answer || true
if [ "$answer" != y ]; then
  say "${tag} was not deployed."
  exit 0
fi

scripts/deploy-beta.sh "$tag" "$digest" "$commit"

read_back=$(bun scripts/live-release.ts server) \
  || fail "the deploy of ${tag} reported healthy, but the server could not be read back, so it is unconfirmed. Run scripts/release.sh to read it again."
read -r now now_digest <<<"$read_back"
if [ "$now" != "$tag" ] || [ "$now_digest" != "$digest" ]; then
  fail "after the deploy, the server runs ${now}, image ${now_digest}, not ${tag}, image ${digest}."
fi
say "the server runs ${tag}, image ${digest}, and its /health answers."

if public=$(bun scripts/live-release.ts public); then
  if [ "$public" = "$tag" ]; then
    say "useafterclass.com reports ${tag} to this machine too."
  else
    say "WARNING useafterclass.com reports ${public} to this machine, not ${tag}. The server runs ${tag}. Check the site from another network."
  fi
else
  say "WARNING this machine could not confirm useafterclass.com. The server runs ${tag}, so the deploy stands. Check the site from another network."
fi
