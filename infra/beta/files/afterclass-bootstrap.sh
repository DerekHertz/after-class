#!/bin/bash
# Cloud-init runs this once per instance. Every step reads the current state and changes only the difference, so a
# second run, by hand through Session Manager or after a crash part way, ends in the same state. A reboot does not
# need it: fstab mounts /data and systemd starts the units.
set -euo pipefail

. /etc/afterclass/settings.env

say() { echo "afterclass-bootstrap: $*"; }

retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    "$@" && return 0
    say "attempt ${attempt} of '$*' failed"
    sleep $((attempt * 5))
  done
  return 1
}

if ! command -v docker >/dev/null; then
  say "installing docker"
  retry dnf install -y docker
fi
systemctl enable --now docker

# The volume attaches after the instance starts, so wait for its device. The by-id name is the volume id without the dash.
device="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${DATA_VOLUME_ID//-/}"
for _ in $(seq 1 60); do
  [ -b "$device" ] && break
  sleep 5
done
if [ ! -b "$device" ]; then
  say "data volume ${DATA_VOLUME_ID} did not appear at ${device} within 5 minutes"
  exit 1
fi

# Prints "empty" when the device is readable and carries no signature at all, otherwise the name of what it holds. Any
# failure returns 1, and the caller refuses to format. The probe tools report some read errors with the same exit status
# they use for "nothing found", so the first and last MiB must read cleanly before an empty answer counts, and a probe
# that prints anything on stderr or exits nonzero is an error.
disk_signature() {
  local device=$1 err size_mib found rc=0
  size_mib=$(( $(blockdev --getsize64 "$device") / 1048576 ))
  if [ "$size_mib" -lt 2 ]; then
    say "${device} reports ${size_mib} MiB" >&2
    return 1
  fi
  dd if="$device" of=/dev/null bs=1M count=1 status=none \
    && dd if="$device" of=/dev/null bs=1M skip=$((size_mib - 1)) count=1 status=none || {
    say "${device} cannot be read end to end" >&2
    return 1
  }
  err=$(mktemp)
  found=$(wipefs --no-act --output TYPE --noheadings "$device" 2>"$err") || rc=$?
  if [ "$rc" -ne 0 ] || [ -s "$err" ]; then
    say "signature probe of ${device} failed: $(cat "$err")" >&2
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  found=$(tr -s '[:space:]' ' ' <<<"$found" | sed -e 's/^ //' -e 's/ $//')
  echo "${found:-empty}"
}

# Format only a device that is readable and has no signature. A volume that holds anything but xfs is left alone and the
# run fails.
prepare_filesystem() {
  local device=$1 signature
  signature=$(disk_signature "$device") || {
    say "cannot prove ${device} is empty, refusing to format it"
    return 1
  }
  if [ "$signature" = empty ]; then
    say "formatting ${device}"
    mkfs.xfs -L afterclass-data "$device"
  elif [ "$signature" != xfs ]; then
    say "${device} holds ${signature}, refusing to touch it"
    return 1
  fi
}
prepare_filesystem "$device"

# A restored snapshot keeps its label. Repair a mismatch only while the filesystem is unmounted.
if ! mountpoint -q /data && [ "$(blkid -p -o value -s LABEL "$device")" != "afterclass-data" ]; then
  xfs_admin -L afterclass-data "$device"
fi

mkdir -p /data
grep -v -E '[[:space:]]/data[[:space:]]' /etc/fstab > /etc/fstab.new || true
echo 'LABEL=afterclass-data /data xfs defaults,nofail,x-systemd.device-timeout=60s 0 2' >> /etc/fstab.new
mv /etc/fstab.new /etc/fstab
systemctl daemon-reload
mountpoint -q /data || mount /data

# One bridge network for Caddy and the app, so Caddy reaches the app by name and neither runs on the host network.
docker network inspect afterclass >/dev/null 2>&1 || docker network create afterclass

mkdir -p /data/db /data/config /data/afterclass/images /data/caddy/data /data/caddy/config

systemctl daemon-reload
systemctl enable afterclass-caddy.service afterclass-app.service
# Caddy starts now. The app unit starts after the first deploy writes /data/afterclass/current-tag, or at once on a
# replacement instance whose data volume already holds one.
systemctl restart afterclass-caddy.service
systemctl start afterclass-app.service
say "done"
