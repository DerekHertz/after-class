#!/bin/bash
# Usage: afterclass-save-image <running image digest> [<other image digest to keep>]. Saves the running image to the data
# volume, so a replacement instance can start it even when GHCR no longer holds it, and deletes every other saved image.
# The image is saved by the ID afterclass-pull recorded for the digest, and afterclass-pull later loads the tarball only
# when it yields that ID. An existing tarball is never trusted. The image is saved from Docker every time, under a
# temporary name, and renamed over the old file, so a crash or a full disk leaves the old file whole. The data volume also
# holds the database, so a save that would leave less than the reserve free is refused.
set -euo pipefail

dir=/data/afterclass/images
reserve_bytes=$((2 * 1024 * 1024 * 1024))

digest="${1:-}"
other="${2:-}"
for candidate in "$digest" "$other"; do
  if [ -n "$candidate" ] && [[ ! "$candidate" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "afterclass-save-image: '${candidate}' is not an image digest" >&2
    exit 2
  fi
done
if [ -z "$digest" ]; then
  echo "usage: afterclass-save-image <image digest> [<image digest>]" >&2
  exit 2
fi

keep="${digest#sha256:}"
keep_other="${other#sha256:}"
id=$(cat "${dir}/${keep}.id")
# Without the image there is nothing to save, and the tarball on disk may be the only copy left, so nothing is touched.
size=$(docker image inspect --format '{{.Size}}' "$id")

tmp="${dir}/${keep}.tar.new"
trap 'rm -f "$tmp"' EXIT

rm -f "$dir"/*.tar.new "$dir"/*.id.new
for file in "$dir"/*.tar "$dir"/*.id; do
  [ -e "$file" ] || continue
  name=$(basename "${file%.*}")
  if [ "$name" != "$keep" ] && [ "$name" != "$keep_other" ]; then
    rm -f "$file"
  fi
done

avail=$(df --output=avail -B1 /data | tail -n 1 | tr -d ' ')
if [ "$avail" -lt $((size + reserve_bytes)) ]; then
  echo "afterclass-save-image: ${avail} bytes free on /data, need ${size} for the image and ${reserve_bytes} left for the database" >&2
  exit 1
fi

docker save --output "$tmp" "$id"
sync "$tmp"
mv "$tmp" "${dir}/${keep}.tar"
sync "$dir"
echo "afterclass-save-image: saved ${digest}"
