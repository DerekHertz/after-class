#!/usr/bin/env bash
# Stops the backend this run started (by pid, never by name) and removes its scratch dir. Evidence lives in
# .claude/shots/, outside the scratch dir, so it survives. Usage: cleanup.sh <workdir>
set -euo pipefail
work="${1:?usage: cleanup.sh <workdir>}"
if [ -f "$work/env" ]; then
  . "$work/env"
  if kill -0 "$PID" 2>/dev/null; then kill "$PID"; for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done; fi
  kill -0 "$PID" 2>/dev/null && { echo "pid $PID did not stop" >&2; exit 1; }
fi
case "$work" in */afterclass-verify-*) rm -rf "$work" ;; *) echo "not removing $work: not a launch.sh dir" >&2 ;; esac
