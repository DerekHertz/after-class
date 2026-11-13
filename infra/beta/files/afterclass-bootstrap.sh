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

# Prints "empty" when the device carries no signature at all, or the name of what it holds. blkid exits 2 only when it
# finds nothing. Any other failure is an error, never an empty disk, so the caller refuses to format.
disk_signature() {
  local probe rc=0 found
  probe=$(blkid -p -o export "$1") || rc=$?
  case "$rc" in
    0)
      found=$(sed -n -e 's/^TYPE=//p' -e 's/^PTTYPE=/partition table /p' <<<"$probe" | head -n 1)
      echo "${found:-unrecognised signature}"
      ;;
    2) echo empty ;;
    *) return 1 ;;
  esac
}

# Format only a device with no signature. A volume that holds anything but xfs is left alone and the run fails.
signature=$(disk_signature "$device") || {
  say "blkid failed on ${device}, refusing to format it"
  exit 1
}
if [ "$signature" = empty ]; then
  say "formatting ${device}"
  mkfs.xfs -L afterclass-data "$device"
elif [ "$signature" != xfs ]; then
  say "${device} holds ${signature}, refusing to touch it"
  exit 1
fi

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

mkdir -p /data/db /data/config /data/afterclass /data/caddy/data /data/caddy/config

systemctl daemon-reload
systemctl enable afterclass-caddy.service afterclass-app.service
# Caddy starts now. The app unit starts after the first deploy writes /data/afterclass/current-tag, or at once on a
# replacement instance whose data volume already holds one.
systemctl restart afterclass-caddy.service
systemctl start afterclass-app.service
say "done"
