#!/usr/bin/env bash
# Stops the backend this run started (by pid, never by name) and removes its scratch dir. Evidence lives in
# .claude/shots/, outside the scratch dir, so it survives. Usage: cleanup.sh <workdir>
set -euo pipefail
work="${1:?usage: cleanup.sh <workdir>}"
# only a directory launch.sh made: the exact name shape, no ".." component, a real directory, and its pid file inside
case "$work" in *..*) echo "refusing $work: contains .." >&2; exit 1 ;; esac
case "$(basename "$work")" in afterclass-verify-??????) ;; *) echo "refusing $work: not a launch.sh dir" >&2; exit 1 ;; esac
[ -d "$work" ] && [ ! -L "$work" ] && [ -f "$work/pid" ] || { echo "refusing $work: no launch.sh dir with a pid file" >&2; exit 1; }
pid="$(cat "$work/pid")"
# kill the pid only if it still is our backend: its environment names this work dir's data dir
if kill -0 "$pid" 2>/dev/null; then
  if tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -qxF "AFTERCLASS_DATA=$work/data"; then
    kill "$pid"
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && { echo "pid $pid did not stop" >&2; exit 1; }
  else
    echo "pid $pid is not this run's backend; not killing it" >&2
  fi
fi
rm -rf -- "$work"
