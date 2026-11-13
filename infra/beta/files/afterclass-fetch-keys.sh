#!/bin/bash
# Usage: afterclass-fetch-keys <uid> <gid>. Run by afterclass-app-start before every start of the app. Reads the app's
# keys from Parameter Store and writes them as keys.env, mode 0600 and owned by the container's user, into the unit's
# runtime folder. That folder is on tmpfs and systemd removes it when the unit stops, so a key never reaches a disk.
# A parameter that is missing, empty or unreadable fails the start. No value is ever printed.
set -euo pipefail
# A run under bash -x would print every value it reads.
set +x

. /etc/afterclass/settings.env

dir=/run/afterclass-app
names=(TYPESAFE_API_KEY AFTERCLASS_ANTHROPIC_API_KEY)

fail() {
  echo "afterclass-fetch-keys: $*, so the app is not started" >&2
  exit 1
}

uid="${1:-}"
gid="${2:-}"
if [[ ! "$uid" =~ ^[0-9]+$ || ! "$gid" =~ ^[0-9]+$ ]]; then
  echo "usage: afterclass-fetch-keys <uid> <gid>" >&2
  exit 2
fi

mkdir -p "$dir"
fstype=$(findmnt --noheadings --output FSTYPE --target "$dir") || fail "cannot tell which filesystem holds ${dir}"
[ "$fstype" = tmpfs ] || fail "${dir} is on ${fstype}, not tmpfs"

umask 077
tmp=$(mktemp "${dir}/keys.env.XXXXXX")
trap 'rm -f "$tmp"' EXIT

for name in "${names[@]}"; do
  parameter="${KEY_PARAMETER_PREFIX}/${name}"
  value=$(aws ssm get-parameter --region "$AWS_REGION" --name "$parameter" --with-decryption \
    --query Parameter.Value --output text) || fail "cannot read ${parameter}"
  if [ -z "$value" ] || [ "$value" = None ] || [[ "$value" == *$'\n'* ]]; then
    fail "${parameter} is empty or spans more than one line"
  fi
  printf '%s=%s\n' "$name" "$value" >> "$tmp"
done

chown "${uid}:${gid}" "$dir" "$tmp"
chmod 0700 "$dir"
chmod 0600 "$tmp"
mv "$tmp" "${dir}/keys.env"
echo "afterclass-fetch-keys: wrote ${#names[@]} keys from ${KEY_PARAMETER_PREFIX} to ${dir}/keys.env"
