#!/usr/bin/env bash
# One authorized request. Usage: call.sh <workdir> <METHOD> <path> [json-body] [extension|app]
# "extension" sends the pinned dummy extension Origin; "app" the app origin; omit for no Origin (curl).
set -euo pipefail
work="${1:?}"; method="${2:?}"; path="${3:?}"; body="${4:-}"; who="${5:-}"
. "$work/env"
args=(-s -w '\n%{http_code}\n' -X "$method" -H "Authorization: Bearer $TOKEN")
case "$who" in
  extension) args+=(-H "Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop") ;;
  app) args+=(-H "Origin: http://127.0.0.1:$PORT") ;;
esac
[ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data "$body")
curl "${args[@]}" "http://127.0.0.1:$PORT$path"
