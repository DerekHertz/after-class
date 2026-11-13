#!/bin/bash
# Usage: afterclass-pull <commit hash>. Pulls the app image from ECR unless it is already on this host.
set -euo pipefail

. /etc/afterclass/settings.env

tag="${1:-}"
if [[ ! "$tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "afterclass-pull: '${tag}' is not a full commit hash" >&2
  exit 2
fi

image="${ECR_REGISTRY}/${ECR_REPOSITORY}:${tag}"
if docker image inspect "$image" >/dev/null 2>&1; then
  exit 0
fi

# The login token lasts 12 hours. Keep it in a throwaway Docker config, not in root's home.
DOCKER_CONFIG=$(mktemp -d)
export DOCKER_CONFIG
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"
docker pull "$image"
