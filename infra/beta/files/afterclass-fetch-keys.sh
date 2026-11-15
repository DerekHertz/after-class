#!/bin/bash
# Usage: afterclass-fetch-keys <uid> <gid>. Run by afterclass-app-start before every start of the app. Reads the app's
# keys from Parameter Store and writes them as keys.env, mode 0600 and owned by the container's user, into the unit's
# runtime folder. That folder is on tmpfs and systemd removes it when the unit stops, so a key never reaches a disk.
# A parameter that is missing, unreadable, or not one line of printable characters without spaces or quotes fails the
# start, because readKeys would read such a value back changed. No value is ever printed.
set -euo pipefail
# A run under bash -x would print every value it reads.
set +x
# Bash alone reads this, so [[:graph:]] below means printable ASCII. It is not exported to aws.
LC_ALL=C

. /etc/afterclass/settings.env

dir=/run/afterclass-app
names=(TYPESAFE_API_KEY AFTERCLASS_ANTHROPIC_API_KEY)
# Settings the app reads from keys.env that may be absent. A missing parameter is skipped. One that exists is checked like a key.
optional=(AFTERCLASS_BUDGET_UNCAPPED_USERS)

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

written=0
for name in "${names[@]}" "${optional[@]}"; do
  parameter="${KEY_PARAMETER_PREFIX}/${name}"
  required=1
  for o in "${optional[@]}"; do [ "$o" = "$name" ] && required=0; done
  err="${dir}/aws-error.$$"
  # The x keeps the trailing newlines that command substitution would strip, so a value ending in one is seen.
  if ! raw=$(aws ssm get-parameter --region "$AWS_REGION" --name "$parameter" --with-decryption \
    --query Parameter.Value --output text 2>"$err" && printf x); then
    if [ "$required" = 0 ] && grep -q ParameterNotFound "$err"; then rm -f "$err"; continue; fi
    rm -f "$err"
    fail "cannot read ${parameter}"
  fi
  rm -f "$err"
  value=${raw%$'\n'x}
  # readKeys trims spaces and strips one pair of quotes, so a value with either would reach the app changed.
  if [[ "$raw" != *$'\n'x || ! "$value" =~ ^[[:graph:]]+$ || "$value" == *[\"\']* || "$value" = None ]]; then
    fail "${parameter} is empty or not one line of printable characters without spaces or quotes"
  fi
  printf '%s=%s\n' "$name" "$value" >> "$tmp"
  written=$((written + 1))
done

chown "${uid}:${gid}" "$dir" "$tmp"
chmod 0700 "$dir"
chmod 0600 "$tmp"
mv "$tmp" "${dir}/keys.env"
echo "afterclass-fetch-keys: wrote ${written} values from ${KEY_PARAMETER_PREFIX} to ${dir}/keys.env"
