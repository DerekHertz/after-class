#!/bin/bash
# Usage: afterclass-save-image <running commit hash> [<other commit hash to keep>]. Saves the running image to the data
# volume, so a replacement instance can start it even after ECR has expired the tag, and deletes every other saved image.
# An existing tarball is never trusted. The image is saved from Docker every time, under a temporary name, and renamed
# over the old file, so a crash or a full disk leaves the old file whole. The data volume also holds the database, so a
# save that would leave less than the reserve free is refused.
set -euo pipefail

. /etc/afterclass/settings.env

dir=/data/afterclass/images
reserve_bytes=$((2 * 1024 * 1024 * 1024))

tag="${1:-}"
other="${2:-}"
for candidate in "$tag" "$other"; do
  if [ -n "$candidate" ] && [[ ! "$candidate" =~ ^[0-9a-f]{40}$ ]]; then
    echo "afterclass-save-image: '${candidate}' is not a full commit hash" >&2
    exit 2
  fi
done
if [ -z "$tag" ]; then
  echo "usage: afterclass-save-image <commit hash> [<commit hash>]" >&2
  exit 2
fi

image="${ECR_REGISTRY}/${ECR_REPOSITORY}:${tag}"
# Without the image there is nothing to save, and the tarball on disk may be the only copy left, so nothing is touched.
size=$(docker image inspect --format '{{.Size}}' "$image")

mkdir -p "$dir"
tmp="${dir}/${tag}.tar.new"
trap 'rm -f "$tmp"' EXIT

rm -f "$dir"/*.tar.new
for file in "$dir"/*.tar; do
  [ -e "$file" ] || continue
  name=$(basename "$file" .tar)
  if [ "$name" != "$tag" ] && [ "$name" != "$other" ]; then
    rm -f "$file"
  fi
done

avail=$(df --output=avail -B1 /data | tail -n 1 | tr -d ' ')
if [ "$avail" -lt $((size + reserve_bytes)) ]; then
  echo "afterclass-save-image: ${avail} bytes free on /data, need ${size} for the image and ${reserve_bytes} left for the database" >&2
  exit 1
fi

docker save --output "$tmp" "$image"
sync "$tmp"
mv "$tmp" "${dir}/${tag}.tar"
sync "$dir"
echo "afterclass-save-image: saved ${tag}"
