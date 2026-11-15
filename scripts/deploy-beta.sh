#!/bin/bash
# Usage: scripts/deploy-beta.sh <release tag> [<digest> [<commit>]], for example scripts/deploy-beta.sh v0.1.0. The owner
# runs it under their own AWS sign-in, usually through scripts/release.sh, and running it is the approval. With a digest,
# it refuses a release whose image-digest.txt names another one, and with a commit, a tag or record that names another
# commit, so what deploys is what was shown and tried. check-release-tag.ts fetches master and the tag afresh and refuses a tag off
# master or one whose package.json names another version. The image is the digest the release workflow recorded in the
# tag's GitHub Release, in image-digest.txt, never the mutable commit tag on GHCR. The server pulls the image by that
# digest, restarts the app, checks /health and rolls back on failure.
set -euo pipefail

region=us-east-2
repository=derekhertz/after-class

cd "$(dirname "$0")/.."
tag="${1:-}"
expected="${2:-}"
expected_commit="${3:-}"
commit=$(bun scripts/check-release-tag.ts "$tag")

if ! checked=$(bun scripts/live-release.ts record "$tag"); then
  echo "deploy-beta: nothing was deployed. If the release workflow is still running, wait for it to finish, or rerun it." >&2
  exit 1
fi
read -r recorded_commit digest <<<"$checked"
if [ "$recorded_commit" != "$commit" ]; then
  echo "deploy-beta: the ${tag} release records commit ${recorded_commit}, but the tag is on ${commit}" >&2
  exit 1
fi
if [ -n "$expected_commit" ] && [ "$commit" != "$expected_commit" ]; then
  echo "deploy-beta: the ${tag} tag and its release now name commit ${commit}, not the ${expected_commit} you tried. Nothing was deployed." >&2
  exit 1
fi
if [ -n "$expected" ] && [ "$digest" != "$expected" ]; then
  echo "deploy-beta: the ${tag} release now names ${digest}, not the ${expected} you tried. Nothing was deployed." >&2
  exit 1
fi

# The server pulls without a sign-in, so the check asks GHCR the same way. The pull token goes to curl on stdin, never in
# its arguments.
token=$(curl -fsS "https://ghcr.io/token?scope=repository:${repository}:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if ! printf 'Authorization: Bearer %s\n' "$token" | curl -fsS --head --output /dev/null -H @- \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
  "https://ghcr.io/v2/${repository}/manifests/${digest}"; then
  echo "deploy-beta: ghcr.io/${repository}@${digest} cannot be pulled anonymously. Check that the package is public (infra/README.md, setup step 4)." >&2
  exit 1
fi

# aws's answers are read as bytes and checked by live-release.ts. The shell only ever holds an id that passed.
if ! instance_id=$(bun scripts/live-release.ts instance); then
  echo "deploy-beta: nothing was deployed." >&2
  exit 1
fi
if ! command_id=$(bun scripts/live-release.ts send "$tag" "$instance_id" "$commit" "$digest"); then
  echo "deploy-beta: the deploy may not have been sent. Check Systems Manager before you rerun it." >&2
  exit 1
fi
echo "deploy-beta: command ${command_id} on ${instance_id} deploys ${tag} (${commit}, ${digest})"

# One clock bounds the whole wait: every status read, every sleep and the final output read. It is 15 minutes, 900 seconds,
# from the send. AFTERCLASS_DEPLOY_WAIT_SECONDS shortens it for tests. The server's own deploy takes up to 10 minutes.
wait_seconds="${AFTERCLASS_DEPLOY_WAIT_SECONDS:-900}"
[[ "$wait_seconds" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "deploy-beta: AFTERCLASS_DEPLOY_WAIT_SECONDS '${wait_seconds}' is not a number of seconds" >&2; exit 2; }
started_at=$SECONDS
remaining() { echo $((wait_seconds - (SECONDS - started_at))); }

# Prints a finished command's output, on whatever time the wait has left, and says so when there is none.
show_output() {
  local left
  left=$(remaining)
  if [ "$left" -le 0 ] || ! timeout --kill-after=2 "$left" aws ssm get-command-invocation --region "$region" --command-id "$command_id" \
    --instance-id "$instance_id" --query "$1" --output text; then
    echo "deploy-beta: the server's output was not read within the ${wait_seconds} s wait. Read it with aws ssm get-command-invocation --command-id ${command_id}." >&2
  fi
}

# The result is not there for the first few seconds after the send.
while :; do
  left=$(remaining)
  if [ "$left" -le 0 ]; then
    echo "deploy-beta: the deploy is still running after ${wait_seconds} seconds. Check command ${command_id} with aws ssm get-command-invocation." >&2
    exit 1
  fi
  sleep $((left < 10 ? left : 10))
  left=$(remaining)
  [ "$left" -gt 0 ] || continue
  if ! status=$(LIVE_RELEASE_DEADLINE_MS=$(((left < 120 ? left : 120) * 1000)) bun scripts/live-release.ts status "$instance_id" "$command_id"); then
    echo "deploy-beta: could not read the status of command ${command_id}. Check it with aws ssm get-command-invocation." >&2
    exit 1
  fi
  case "$status" in
    Success)
      show_output StandardOutputContent
      exit 0
      ;;
    Pending | InProgress | Delayed) ;;
    *)
      echo "deploy-beta: the deploy ended as ${status}" >&2
      show_output '[StandardOutputContent,StandardErrorContent]' >&2
      exit 1
      ;;
  esac
done
