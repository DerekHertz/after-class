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

invocation() {
  aws ssm get-command-invocation --region "$region" --command-id "$command_id" --instance-id "$instance_id" "$@"
}

# The server's deploy takes up to 10 minutes. The result is not there for the first few seconds after the send.
for _ in $(seq 1 90); do
  sleep 10
  if ! status=$(bun scripts/live-release.ts status "$instance_id" "$command_id"); then
    echo "deploy-beta: could not read the status of command ${command_id}. Check it with aws ssm get-command-invocation." >&2
    exit 1
  fi
  case "$status" in
    Success)
      invocation --query StandardOutputContent --output text
      exit 0
      ;;
    Pending | InProgress | Delayed) ;;
    *)
      echo "deploy-beta: the deploy ended as ${status}" >&2
      invocation --query '[StandardOutputContent,StandardErrorContent]' --output text >&2
      exit 1
      ;;
  esac
done
echo "deploy-beta: the deploy is still running after 15 minutes. Check command ${command_id} with aws ssm get-command-invocation." >&2
exit 1
