#!/bin/bash
# Cloud-init runs this once per instance. Every step reads the current state and changes only the difference, so a
# second run, by hand through Session Manager or after a crash part way, ends in the same state. A reboot does not
# need it: fstab mounts /data and systemd starts the units.
#
# It never formats. It mounts the data volume or stops, and the app stays stopped. A new volume is formatted once, by
# hand, with afterclass-format-data (infra/README.md).
set -euo pipefail

. /etc/afterclass/settings.env

say() { echo "afterclass-bootstrap: $*"; }

retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    "$@" && return 0
    say "attempt ${attempt} of '$*' failed" >&2
    sleep $((attempt * 5))
  done
  return 1
}

if ! command -v docker >/dev/null; then
  say "installing docker"
  retry dnf install -y docker
fi
systemctl enable --now docker

# The volume attaches after the instance starts, so wait for its device. The by-id name is the volume id without the
# dash, so it names this volume and no other.
device="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${DATA_VOLUME_ID//-/}"
for _ in $(seq 1 60); do
  [ -b "$device" ] && break
  sleep 5
done
if [ ! -b "$device" ]; then
  say "data volume ${DATA_VOLUME_ID} did not appear at ${device} within 5 minutes"
  exit 1
fi

mkdir -p /data
grep -v -E '[[:space:]]/data[[:space:]]' /etc/fstab > /etc/fstab.new || true
echo "${device} /data xfs defaults,nofail,x-systemd.device-timeout=60s 0 2" >> /etc/fstab.new
mv /etc/fstab.new /etc/fstab
systemctl daemon-reload

# Waits for a format in progress, so the mount never sees a half-written filesystem.
exec 9>/run/afterclass-format-data.lock
flock 9
if ! mountpoint -q /data && ! mount /data; then
  say "cannot mount ${device} at /data, so the app stays stopped. A new volume needs afterclass-format-data ${DATA_VOLUME_ID} once (infra/README.md)."
  exit 1
fi
exec 9>&-

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
