#!/usr/bin/env bash
# Starts the After Class backend in replay mode with a scratch HOME and data dir, so it never reads the real
# ~/.config/afterclass. Prints the work dir. Usage: launch.sh [workdir]
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
work="${1:-$(mktemp -d "${TMPDIR:-/tmp}/afterclass-verify-XXXXXX")}"
mkdir -p "$work/home/.config/afterclass" "$work/data"
# no keys.env in the scratch HOME, so the backend picks replay mode and refuses every live call
cd "$repo"
HOME="$work/home" AFTERCLASS_DATA="$work/data" AFTERCLASS_MODE=replay AFTERCLASS_PORT=0 \
  AFTERCLASS_EXTENSION_ID=abcdefghijklmnopabcdefghijklmnop \
  setsid bun run src/backend/main.ts >"$work/backend.log" 2>&1 &
echo $! >"$work/pid"
for _ in $(seq 1 120); do
  if grep -q '^pairing token: ' "$work/backend.log" 2>/dev/null; then
    port="$(sed -n 's/^.*listening on 127\.0\.0\.1:\([0-9]*\).*$/\1/p' "$work/backend.log" | head -1)"
    token="$(sed -n 's/^pairing token: //p' "$work/backend.log" | head -1)"
    printf 'PORT=%s\nTOKEN=%s\nPID=%s\n' "$port" "$token" "$(cat "$work/pid")" >"$work/env"
    echo "$work"
    exit 0
  fi
  kill -0 "$(cat "$work/pid")" 2>/dev/null || { echo "backend exited:" >&2; cat "$work/backend.log" >&2; exit 1; }
  sleep 0.5
done
echo "backend not ready after 60 s:" >&2; cat "$work/backend.log" >&2; exit 1
