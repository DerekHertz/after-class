#!/bin/bash
# Usage: afterclass-deploy <commit hash>. Run by the Systems Manager deploy document as root.
# Pulls the image first, so the running container keeps serving during the download. Then it records the tag, restarts the
# app and waits for /health. A tag that never turns healthy is rolled back to the previous one, and the run still fails.
set -euo pipefail

. /etc/afterclass/settings.env

tag="${1:-}"
if [[ ! "$tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "afterclass-deploy: '${tag}' is not a full commit hash" >&2
  exit 2
fi

# Two deploys at once would race on the tag file and the restart.
exec 9>/run/afterclass-deploy.lock
flock -w 600 9

if ! mountpoint -q /data; then
  echo "afterclass-deploy: /data is not mounted" >&2
  exit 1
fi

state=/data/afterclass/current-tag
mkdir -p /data/afterclass
previous=$(cat "$state" 2>/dev/null || true)

write_tag() {
  printf '%s\n' "$1" > "${state}.new"
  mv "${state}.new" "$state"
}

# Healthy means the unit is running and the app answers. The 90 seconds cover a container that is still starting.
healthy() {
  local attempt
  for attempt in $(seq 1 30); do
    if systemctl is-active --quiet afterclass-app.service \
      && curl -fsS --max-time 3 "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# The previous tag goes back first, so a failed pull, restart or health check of the previous image still leaves it selected.
rollback() {
  write_tag "$previous"
  /usr/local/sbin/afterclass-pull "$previous" || echo "afterclass-deploy: could not pull ${previous}, the app unit retries" >&2
  systemctl restart afterclass-app.service || true
  if healthy; then
    echo "afterclass-deploy: rolled back to ${previous}" >&2
  else
    echo "afterclass-deploy: ${previous} is not healthy either" >&2
  fi
}

/usr/local/sbin/afterclass-pull "$tag"

write_tag "$tag"
# A restart that fails is the same as one that never turns healthy. The condition keeps set -e from skipping the rollback.
if systemctl restart afterclass-app.service && healthy; then
  echo "afterclass-deploy: ${tag} is healthy"
  # The deploy already worked, so a failed cleanup must not fail it.
  docker image prune --all --force --filter until=72h >/dev/null || echo "afterclass-deploy: image prune failed, ignored" >&2
  exit 0
fi

echo "afterclass-deploy: ${tag} did not become healthy" >&2
journalctl -u afterclass-app.service -n 30 --no-pager >&2 || true
if [ -n "$previous" ] && [ "$previous" != "$tag" ]; then
  rollback
fi
exit 1
