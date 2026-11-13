#!/bin/bash
# Started by afterclass-app.service. Runs the image named in /data/afterclass/current-tag, in the foreground.
set -euo pipefail

. /etc/afterclass/settings.env

tag=$(cat /data/afterclass/current-tag)
/usr/local/sbin/afterclass-pull "$tag"
image="${ECR_REGISTRY}/${ECR_REPOSITORY}:${tag}"

# The container runs as the image's own user, so the bind-mounted folders must belong to it.
uid=$(docker run --rm --entrypoint id "$image" -u)
gid=$(docker run --rm --entrypoint id "$image" -g)
chown "${uid}:${gid}" /data/db /data/config

exec docker run --rm --init --name afterclass-app \
  --cap-drop ALL --security-opt no-new-privileges \
  --env-file /etc/afterclass/app.env \
  -p "127.0.0.1:${APP_PORT}:${APP_PORT}" \
  -v /data/db:/data/db -v /data/config:/data/config \
  --log-driver awslogs --log-opt "awslogs-region=${AWS_REGION}" --log-opt "awslogs-group=${LOG_GROUP}" \
  --log-opt awslogs-stream=app --log-opt mode=non-blocking \
  "$image"
