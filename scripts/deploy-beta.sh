#!/bin/bash
# Usage: scripts/deploy-beta.sh <release tag>, for example scripts/deploy-beta.sh v0.1.0. Derek runs it under his own AWS
# sign-in, and running it is the approval. It deploys the image the release workflow pushed to GHCR for the tag's commit.
# check-release-tag.ts fetches master and the tag afresh and refuses a tag off master or one whose package.json names
# another version. The server pulls the image, restarts the app, checks /health and rolls back on failure.
set -euo pipefail

region=us-east-2
repository=derekhertz/after-class
instance_parameter=/afterclass-beta/instance_id
document=afterclass-beta-deploy

cd "$(dirname "$0")/.."
tag="${1:-}"
commit=$(bun scripts/check-release-tag.ts "$tag")

# The server pulls without a sign-in, so the check asks GHCR the same way. The pull token goes to curl on stdin, never in
# its arguments.
token=$(curl -fsS "https://ghcr.io/token?scope=repository:${repository}:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if ! printf 'Authorization: Bearer %s\n' "$token" | curl -fsS --head --output /dev/null -H @- \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
  "https://ghcr.io/v2/${repository}/manifests/${commit}"; then
  echo "deploy-beta: ghcr.io/${repository}:${commit} cannot be pulled anonymously. Wait for the release workflow's image job, and check that the package is public (infra/README.md, step 4)." >&2
  exit 1
fi

instance_id=$(aws ssm get-parameter --region "$region" --name "$instance_parameter" --query Parameter.Value --output text)
command_id=$(aws ssm send-command --region "$region" --instance-ids "$instance_id" --document-name "$document" \
  --parameters "tag=${commit}" --comment "deploy ${tag} ${commit}" --query Command.CommandId --output text)
echo "deploy-beta: command ${command_id} on ${instance_id} deploys ${tag} (${commit})"

invocation() {
  aws ssm get-command-invocation --region "$region" --command-id "$command_id" --instance-id "$instance_id" "$@"
}

# The server's deploy takes up to 10 minutes. The result is not there for the first few seconds after the send.
for _ in $(seq 1 90); do
  sleep 10
  status=$(invocation --query Status --output text 2>/dev/null || echo Pending)
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
