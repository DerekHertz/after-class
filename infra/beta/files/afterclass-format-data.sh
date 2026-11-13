#!/bin/bash
# Usage: afterclass-format-data <data volume id>. Run by hand, once, on a new data volume (infra/README.md). Boot never
# formats. The argument must be this server's data volume id, as a confirmation. The script refuses unless /data is not
# mounted, the first MiB reads back as zeros, wipefs finds no signature and mount finds no filesystem. Each check has
# its own way to fail on a used disk, and mkfs.xfs without -f refuses a disk that holds a filesystem too.
set -euo pipefail

. /etc/afterclass/settings.env

refuse() {
  echo "afterclass-format-data: $*, nothing was formatted" >&2
  exit 1
}

if [ "${1:-}" != "$DATA_VOLUME_ID" ]; then
  echo "usage: afterclass-format-data ${DATA_VOLUME_ID}, the data volume id, to confirm the format" >&2
  exit 2
fi
device="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${DATA_VOLUME_ID//-/}"

exec 9>/run/afterclass-format-data.lock
flock -n 9 || refuse "another format or a bootstrap mount holds the lock"

if mountpoint -q /data; then
  refuse "/data is mounted"
fi
# A read error fails head, and pipefail fails the assignment. wipefs alone can report a read error as an empty disk.
nonzero=$(head -c 1048576 "$device" | tr -d '\000' | wc -c) || refuse "cannot read ${device}"
[ "$nonzero" -eq 0 ] || refuse "the first MiB of ${device} is not blank"
found=$(wipefs --no-act --noheadings --output TYPE "$device") || refuse "wipefs cannot probe ${device}"
[ -z "$found" ] || refuse "${device} holds ${found}"
probe=$(mktemp -d)
if mount -o ro "$device" "$probe" 2>/dev/null; then
  umount "$probe"
  rmdir "$probe"
  refuse "${device} holds a filesystem that mounts"
fi
rmdir "$probe"

mkfs.xfs -L afterclass-data "$device"
echo "afterclass-format-data: formatted ${device}. Run afterclass-bootstrap to mount it and start the app."
