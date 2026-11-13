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
# failure returns 1, and the caller refuses to format. This is the second guard. The probe tools report some read errors
# with the same exit status they use for "nothing found", and wipefs can print nothing and exit 0 when a read fails inside
# it, so an "empty" answer alone never authorizes a format. The tag on the volume does (see provision_data_volume).
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

# Prints the value of the afterclass-format tag on the data volume, or "none" when it has no such tag. Returns 1 when the
# EC2 API cannot be asked. Terraform creates the volume with the value "allowed" and never changes it again.
format_tag() {
  local value
  value=$(retry aws ec2 describe-volumes --region "$AWS_REGION" --volume-ids "$DATA_VOLUME_ID" \
    --query "Volumes[0].Tags[?Key=='afterclass-format'].Value | [0]" --output text) || return 1
  if [ -z "$value" ] || [ "$value" = None ]; then
    value=none
  fi
  echo "$value"
}

# Writes the tag that ends the authorization to format. The instance role may write only this key with only this value.
record_formatted() {
  retry aws ec2 create-tags --region "$AWS_REGION" --resources "$DATA_VOLUME_ID" --tags Key=afterclass-format,Value=done
}

# Formatting is allowed once in the life of the volume, by durable state outside the disk. The volume carries the tag
# afterclass-format=allowed from the moment Terraform creates it until this function has mounted a filesystem on it, and
# then the tag is done. Reading the disk cannot grant that permission, because a probe can misreport a used disk as empty.
# With any other tag value, or when the tag cannot be read, the function formats nothing, and the mount must succeed.
# The marker file on the root volume covers a failed tag write, so a rerun or a reboot never formats a volume this
# instance has already formatted.
provision_data_volume() {
  local device=$1 tag signature marker=/var/lib/afterclass/formatted-${DATA_VOLUME_ID}
  mkdir -p "$(dirname "$marker")"

  if ! tag=$(format_tag); then
    say "cannot read the afterclass-format tag of ${DATA_VOLUME_ID}, so nothing will be formatted"
    tag=unknown
  fi

  if [ "$tag" = allowed ] && [ ! -e "$marker" ]; then
    signature=$(disk_signature "$device") || {
      say "cannot prove ${device} is empty, refusing to format it"
      return 1
    }
    case "$signature" in
      empty)
        say "formatting ${device}"
        mkfs.xfs -L afterclass-data "$device"
        touch "$marker"
        ;;
      xfs) ;;
      *)
        say "${device} holds ${signature}, refusing to touch it"
        return 1
        ;;
    esac
  fi

  # A restored snapshot keeps its label. Repair a mismatch only while the filesystem is unmounted.
  if ! mountpoint -q /data && [ "$(blkid -p -o value -s LABEL "$device" || true)" != "afterclass-data" ] \
    && [ "$(blkid -p -o value -s TYPE "$device" || true)" = xfs ]; then
    xfs_admin -L afterclass-data "$device"
  fi

  mkdir -p /data
  grep -v -E '[[:space:]]/data[[:space:]]' /etc/fstab > /etc/fstab.new || true
  echo 'LABEL=afterclass-data /data xfs defaults,nofail,x-systemd.device-timeout=60s 0 2' >> /etc/fstab.new
  mv /etc/fstab.new /etc/fstab
  systemctl daemon-reload
  mountpoint -q /data || mount /data || {
    say "cannot mount an xfs filesystem labelled afterclass-data from ${device}. The afterclass-format tag is '${tag}', so it will not be formatted. Restore the volume by hand (infra/README.md)."
    return 1
  }

  if [ "$tag" = allowed ]; then
    record_formatted || {
      say "mounted ${device} but could not set afterclass-format=done on ${DATA_VOLUME_ID}. Fix the instance role, run: aws ec2 create-tags --resources ${DATA_VOLUME_ID} --tags Key=afterclass-format,Value=done, then run afterclass-bootstrap again."
      return 1
    }
    say "set afterclass-format=done on ${DATA_VOLUME_ID}"
  fi
}
provision_data_volume "$device"

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
