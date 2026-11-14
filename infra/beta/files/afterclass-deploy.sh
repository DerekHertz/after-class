#!/bin/bash
# Usage: afterclass-deploy <commit hash> <image digest>. Run by the Systems Manager deploy document as root.
# The digest names the image, and the commit only labels the output. Pulls the image first, so the running container keeps
# serving during the download. Then it records the digest, restarts the app and waits for /health. A digest that never
# turns healthy is rolled back to the previous one, and the run still fails. A healthy image is saved to the data volume,
# so a replacement instance never depends on GHCR still holding the image.
set -euo pipefail

. /etc/afterclass/settings.env

commit="${1:-}"
digest="${2:-}"
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "afterclass-deploy: '${commit}' is not a full commit hash" >&2
  exit 2
fi
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "afterclass-deploy: '${digest}' is not an image digest" >&2
  exit 2
fi

# Two deploys at once would race on the state file and the restart.
exec 9>/run/afterclass-deploy.lock
flock -w 600 9

if ! mountpoint -q /data; then
  echo "afterclass-deploy: /data is not mounted" >&2
  exit 1
fi

state=/data/afterclass/current-image
mkdir -p /data/afterclass
previous=$(cat "$state" 2>/dev/null || true)

write_image() {
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

# The save is a safety copy. A failure leaves the running app alone and shows up as a WARNING in the command output.
save_running_image() {
  if ! /usr/local/sbin/afterclass-save-image "$@"; then
    echo "afterclass-deploy: WARNING ${1} is not saved on /data, so a replacement instance needs GHCR to still hold it. Free space on /data and deploy again."
  fi
}

# The previous digest goes back first, so a failed pull, restart or health check of the previous image still leaves it selected.
rollback() {
  write_image "$previous"
  /usr/local/sbin/afterclass-pull "$previous" >/dev/null || echo "afterclass-deploy: could not pull ${previous}, the app unit retries" >&2
  systemctl restart afterclass-app.service || true
  if healthy; then
    echo "afterclass-deploy: rolled back to ${previous}" >&2
    save_running_image "$previous"
  else
    echo "afterclass-deploy: ${previous} is not healthy either" >&2
  fi
}

/usr/local/sbin/afterclass-pull "$digest" >/dev/null

write_image "$digest"
# A restart that fails is the same as one that never turns healthy. The condition keeps set -e from skipping the rollback.
if systemctl restart afterclass-app.service && healthy; then
  echo "afterclass-deploy: ${commit} (${digest}) is healthy"
  save_running_image "$digest" ${previous:+"$previous"}
  # The deploy already worked, so a failed cleanup must not fail it.
  docker image prune --all --force --filter until=72h >/dev/null || echo "afterclass-deploy: image prune failed, ignored" >&2
  exit 0
fi

echo "afterclass-deploy: ${commit} (${digest}) did not become healthy" >&2
journalctl -u afterclass-app.service -n 30 --no-pager >&2 || true
if [ -n "$previous" ] && [ "$previous" != "$digest" ]; then
  rollback
fi
exit 1
