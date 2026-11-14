#!/bin/bash
# Usage: afterclass-format-data <data volume id>. Run by hand, once, on a new data volume (infra/README.md). Boot never
# formats. The argument must be this server's data volume id, as a confirmation. The script refuses unless /data is not
# mounted, blkid finds no signature, wipefs finds none and mount finds no filesystem. These probes cannot prove a disk
# holds no data. They only catch a disk that already carries a signature. mkfs.xfs without -f refuses a disk that holds
# a filesystem too.
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
# blkid -p exits 2 when it finds nothing. Any other status, a read error included, is not an answer, so it fails closed.
blkid_status=0
blkid -p "$device" >/dev/null 2>&1 || blkid_status=$?
[ "$blkid_status" -eq 2 ] || refuse "blkid probed ${device} and exited ${blkid_status}, not 2 (nothing found)"
found=$(wipefs --no-act --noheadings --output TYPE "$device") || refuse "wipefs cannot probe ${device}"
[ -z "$found" ] || refuse "${device} holds ${found}"
probe=$(mktemp -d)
if mount -o ro "$device" "$probe" 2>/dev/null; then
  umount "$probe"
  rmdir "$probe"
  refuse "${device} holds a filesystem that mounts"
fi
rmdir "$probe"

mkfs.xfs -L afterclass "$device"
echo "afterclass-format-data: formatted ${device}. Run afterclass-bootstrap to mount it and start the app."
