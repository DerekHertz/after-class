#!/usr/bin/env bash
# One shared PostgreSQL container for local tests: scripts/dev/pg.sh start|stop|url
# Every test file makes its own throwaway databases in it, so parallel runs share this one container.
#   export AFTERCLASS_TEST_PG_URL="$(scripts/dev/pg.sh url)"
# Durability is off (fsync, synchronous_commit, full_page_writes): the data is disposable and tests run faster.
set -euo pipefail

NAME=afterclass-pg
# Same image and digest as the pg service in .github/workflows/ci.yml.
IMAGE=postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929
PORT=55432
PASSWORD=afterclass
URL="postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres"

state() {
  local s
  if s="$(docker inspect --format '{{.State.Status}}' "$NAME" 2>/dev/null)" && [ -n "$s" ]; then echo "$s"; else echo absent; fi
}

wait_ready() {
  for _ in $(seq 1 60); do
    if docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "pg.sh: $NAME did not become ready in 30 s" >&2
  return 1
}

case "${1:-}" in
  start)
    case "$(state)" in
      running) ;;
      absent)
        docker run -d --name "$NAME" --memory=768m --cpus=1.5 \
          -e POSTGRES_PASSWORD="$PASSWORD" -p "127.0.0.1:${PORT}:5432" \
          "$IMAGE" -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200 >/dev/null
        ;;
      *) docker start "$NAME" >/dev/null ;;
    esac
    wait_ready
    echo "$URL"
    ;;
  stop)
    if [ "$(state)" = running ]; then docker stop "$NAME" >/dev/null; fi
    ;;
  url)
    echo "$URL"
    ;;
  *)
    echo "usage: scripts/dev/pg.sh start|stop|url" >&2
    exit 2
    ;;
esac
