#!/bin/bash
# Usage: afterclass-save-image <running commit hash> [<other commit hash to keep>]. Saves the running image to the data
# volume, so a replacement instance can start it even after ECR has expired the tag, and deletes every other saved image.
# Each tarball is written under a temporary name and renamed, so a crash or a full disk never leaves a half file under a
# real name. An existing tarball that is unreadable or holds another image is replaced the same way, from the running
# image. The data volume also holds the database, so a save that would leave less than the reserve free is refused.
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
mkdir -p "$dir"
tmp="${dir}/${tag}.tar.new"
trap 'rm -f "$tmp"' EXIT

# True when the tarball is a readable archive whose manifest lists the image. Reading manifest.json scans the whole archive,
# so a truncated file fails too. The output is captured, not piped into grep, so grep exiting early cannot fail the read.
tarball_holds_image() {
  local manifest
  manifest=$(tar -xOf "$1" manifest.json 2>/dev/null) || return 1
  grep -qF -- "\"$2\"" <<<"$manifest"
}

# A crashed save leaves its temporary file, and a pull sets a tarball that would not load aside as .bad. Anything not kept
# is deleted first, which also frees room for the save.
rm -f "$dir"/*.tar.new "$dir"/*.tar.bad
for file in "$dir"/*.tar; do
  [ -e "$file" ] || continue
  name=$(basename "$file" .tar)
  if [ "$name" != "$tag" ] && [ "$name" != "$other" ]; then
    rm -f "$file"
  fi
done

# A file that is there is not proof of a recovery copy. A bad one is replaced below, by an atomic rename over it.
if [ -f "${dir}/${tag}.tar" ]; then
  if tarball_holds_image "${dir}/${tag}.tar" "$image"; then
    exit 0
  fi
  echo "afterclass-save-image: ${dir}/${tag}.tar does not hold ${image}, replacing it" >&2
fi

size=$(docker image inspect --format '{{.Size}}' "$image")
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
