#!/bin/bash
# Usage: afterclass-pull <image digest>. Makes the app image with that registry digest available on this host and prints
# its local image ID, which is what the app runs. The repository is written here and nowhere else the deploy document can
# reach, and the image is named only by digest, so a deploy can pick neither a registry nor a mutable tag.
#
# docker pull checks the bytes against the digest. docker save and load keep the image ID but drop the digest, so the ID
# Docker reports after a digest pull is recorded in <digest hex>.id beside the tarball, and a tarball is used only when it
# loads an image with that recorded ID. The order is: the image Docker has by digest, the recorded ID already in Docker, the
# tarball afterclass-save-image keeps on the data volume, then GHCR without a sign-in. The tarball comes before GHCR so a
# replacement instance starts the app even when GHCR no longer holds the image.
set -euo pipefail

digest="${1:-}"
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "afterclass-pull: '${digest}' is not an image digest" >&2
  exit 2
fi

image="ghcr.io/derekhertz/after-class@${digest}"
dir=/data/afterclass/images
record="${dir}/${digest#sha256:}.id"
tarball="${dir}/${digest#sha256:}.tar"

# Records the ID of the image Docker resolved by digest, and prints it.
resolved() {
  local id
  id=$(docker image inspect --format '{{.Id}}' "$image")
  mkdir -p "$dir"
  printf '%s\n' "$id" > "${record}.new"
  mv "${record}.new" "$record"
  echo "$id"
}

if docker image inspect "$image" >/dev/null 2>&1; then
  resolved
  exit 0
fi

recorded=$(cat "$record" 2>/dev/null || true)
if [[ "$recorded" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  if docker image inspect "$recorded" >/dev/null 2>&1; then
    echo "$recorded"
    exit 0
  fi
  if [ -f "$tarball" ]; then
    echo "afterclass-pull: loading ${image} from ${tarball}" >&2
    if docker load --input "$tarball" >/dev/null && docker image inspect "$recorded" >/dev/null 2>&1; then
      echo "$recorded"
      exit 0
    fi
    echo "afterclass-pull: ERROR ${tarball} did not load as ${recorded}, pulling from GHCR" >&2
  fi
fi

docker pull "$image" >&2
resolved
