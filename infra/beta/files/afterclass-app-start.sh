#!/bin/bash
# Started by afterclass-app.service. Runs the image whose digest is in /data/afterclass/current-image, in the foreground, by
# the local image ID afterclass-pull resolved for that digest, never by a tag.
set -euo pipefail

. /etc/afterclass/settings.env

digest=$(cat /data/afterclass/current-image)
image=$(/usr/local/sbin/afterclass-pull "$digest")

# The container runs as the image's own user, so the database folder and the keys file must belong to it.
uid=$(docker run --rm --entrypoint id "$image" -u)
gid=$(docker run --rm --entrypoint id "$image" -g)
chown "${uid}:${gid}" /data/db
/usr/local/sbin/afterclass-fetch-keys "$uid" "$gid"

exec docker run --rm --init --name afterclass-app \
  --network afterclass --cap-drop ALL --security-opt no-new-privileges \
  --env-file /etc/afterclass/app.env \
  -p "127.0.0.1:${APP_PORT}:${APP_PORT}" \
  -v /data/db:/data/db -v /run/afterclass-app:/data/config:ro \
  --log-driver awslogs --log-opt "awslogs-region=${AWS_REGION}" --log-opt "awslogs-group=${LOG_GROUP}" \
  --log-opt awslogs-stream=app --log-opt mode=non-blocking \
  "$image"
