#!/usr/bin/env bash
# Read-only: is the instance in <workdir> ours, up, in replay mode, and answering? Usage: doctor.sh <workdir>
set -euo pipefail
work="${1:?usage: doctor.sh <workdir>}"
. "$work/env"
kill -0 "$PID" 2>/dev/null || { echo "FAIL: pid $PID is not running"; exit 1; }
grep -q '^mode: replay' "$work/backend.log" || { echo "FAIL: not in replay mode"; exit 1; }
owner="$(ss -ltnp "sport = :$PORT" 2>/dev/null | grep -o "pid=$PID" || true)"
[ -n "$owner" ] || { echo "FAIL: port $PORT is not owned by pid $PID"; exit 1; }
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health")"
[ "$code" = 200 ] || { echo "FAIL: /health answered $code"; exit 1; }
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/usage")"
[ "$code" = 401 ] || { echo "FAIL: /usage without a token answered $code, want 401"; exit 1; }
echo "OK: pid $PID owns 127.0.0.1:$PORT, replay mode, /health 200, token required"
