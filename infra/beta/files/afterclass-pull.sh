#!/bin/bash
# Usage: afterclass-pull <commit hash>. Makes the app image available on this host. It uses the image Docker already has,
# then the tarball that afterclass-save-image keeps on the data volume, then ECR. The tarball comes before ECR so a
# replacement instance starts the app without ECR, whose retention rules may have expired the tag.
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

tarball="/data/afterclass/images/${tag}.tar"
if [ -f "$tarball" ]; then
  echo "afterclass-pull: loading ${image} from ${tarball}" >&2
  if docker load --input "$tarball" >/dev/null && docker image inspect "$image" >/dev/null 2>&1; then
    exit 0
  fi
  echo "afterclass-pull: ${tarball} did not load, pulling from ECR" >&2
fi

# The login token lasts 12 hours. Keep it in a throwaway Docker config, not in root's home.
DOCKER_CONFIG=$(mktemp -d)
export DOCKER_CONFIG
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"
docker pull "$image"
