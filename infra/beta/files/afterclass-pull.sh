#!/bin/bash
# Usage: afterclass-pull <commit hash>. Makes the app image available on this host. It uses the image Docker already has,
# then the tarball that afterclass-save-image keeps on the data volume, then the public GHCR package, pulled without a
# sign-in. The tarball comes before GHCR so a replacement instance starts the app even when GHCR no longer holds the image.
# docker load is the only check of the tarball. A failed load is reported and GHCR is tried, and the next save overwrites
# the tarball. The repository is written here and nowhere else the deploy document can reach, so a deploy can only pick a
# commit, never a registry.
set -euo pipefail

tag="${1:-}"
if [[ ! "$tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "afterclass-pull: '${tag}' is not a full commit hash" >&2
  exit 2
fi

image="ghcr.io/derekhertz/after-class:${tag}"
if docker image inspect "$image" >/dev/null 2>&1; then
  exit 0
fi

tarball="/data/afterclass/images/${tag}.tar"
if [ -f "$tarball" ]; then
  echo "afterclass-pull: loading ${image} from ${tarball}" >&2
  if docker load --input "$tarball" >/dev/null && docker image inspect "$image" >/dev/null 2>&1; then
    exit 0
  fi
  echo "afterclass-pull: ERROR ${tarball} did not load as ${image}, pulling from GHCR" >&2
fi

docker pull "$image"
