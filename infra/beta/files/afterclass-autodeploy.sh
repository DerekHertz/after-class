#!/bin/bash
# Run every 75 seconds by afterclass-autodeploy.timer. Deploys the highest published release of the repository through
# afterclass-deploy, so publishing a draft release on GitHub is the deploy approval. Drafts and pre-releases never count.
# It asks the public GitHub API without a sign-in and sends the ETag of the last list it finished with, so an unchanged
# list answers 304 with no body to read. A GitHub error, a rate limit, a malformed image-digest.txt or a commit off master
# deploys nothing. Every decision goes to the log group's autodeploy stream.
#
# /data/afterclass/autodeploy has one "<tag> <digest>" line per release it acted on, and the last line is the one it acted
# on last. It acts once each time a different release becomes the highest published one:
# - A tag keeps the digest it was first acted on with. A later image-digest.txt naming another digest is refused at every
#   check and never deployed, because publishing approved the first one.
# - A manual deploy with scripts/deploy-beta.sh stays until a different release becomes the highest published one.
# - A release that fails its health check is rolled back by afterclass-deploy and not tried again. A deploy that fails
#   before it restarts the app, such as a lock timeout or a failed pull, is not a decision, so the release is tried again.
# - Publishing an older version deploys nothing, because only the highest published version counts. To roll back from
#   GitHub, mark the newest release as a pre-release or delete it, and the next highest one is deployed.
set -euo pipefail

. /etc/afterclass/settings.env

repository=DerekHertz/after-class
api="https://api.github.com/repos/${repository}"
dir=/data/afterclass
handled="${dir}/autodeploy"
etag_file="${dir}/autodeploy.etag"
retry_file="${dir}/autodeploy.retry"
# GitHub's answers are read whole by Python, so their size bounds its memory. The newest 30 releases hold the next one to
# publish, and 30 release notes fit in 4 MiB many times over. A compare of a commit on master lists no files.
newest=30
list_kib=4096
compare_bytes=$((1024 * 1024))

events=()
note() {
  echo "$1"
  events+=("$1")
}
say() { note "afterclass-autodeploy: $*"; }

# A failed send is printed and ignored, so a CloudWatch outage never blocks a deploy.
ship() {
  [ "${#events[@]}" -gt 0 ] || return 0
  local batch
  batch=$(python3 -I -c 'import json, sys, time
now = int(time.time() * 1000)
print(json.dumps([{"timestamp": now, "message": m} for m in sys.argv[1:]]))' "${events[@]}")
  local put=(aws logs put-log-events --region "$AWS_REGION" --log-group-name "$LOG_GROUP" --log-stream-name autodeploy --log-events "$batch")
  if ! "${put[@]}" >/dev/null 2>&1; then
    aws logs create-log-stream --region "$AWS_REGION" --log-group-name "$LOG_GROUP" --log-stream-name autodeploy >/dev/null 2>&1 || true
    "${put[@]}" >/dev/null || echo "afterclass-autodeploy: could not send ${#events[@]} lines to ${LOG_GROUP}" >&2
  fi
}

body=$(mktemp)
headers=$(mktemp)
trap 'rm -f "$body" "$headers"; ship' EXIT

exec 9>/run/afterclass-autodeploy.lock
if ! flock -n 9; then
  echo "afterclass-autodeploy: another check is running"
  exit 0
fi

if ! mountpoint -q /data; then
  say "/data is not mounted, nothing done"
  exit 0
fi

write() {
  printf '%s\n' "$2" > "${1}.new"
  mv "${1}.new" "$1"
}

# Appends "<tag> <digest>" to the list of handled releases, unless it is already the last line.
handle() {
  rm -f "$retry_file"
  [ "$(tail -n 1 "$handled" 2>/dev/null || true)" = "$1 $2" ] && return 0
  { cat "$handled" 2>/dev/null || true; printf '%s %s\n' "$1" "$2"; } > "${handled}.new"
  mv "${handled}.new" "$handled"
}

# Saved only once a run reaches a decision, so a run cut short by an error asks for the full list again.
new_etag=""
finish() {
  if [[ "$new_etag" =~ ^(W/)?\"[!#-~]+\"$ ]]; then write "$etag_file" "$new_etag"; fi
}

etag=$(cat "$etag_file" 2>/dev/null || true)
conditional=()
if [ -n "$etag" ]; then conditional=(-H "If-None-Match: ${etag}"); fi
# The file size limit stops curl when the body reaches the limit, whatever it says about its length.
status=$(ulimit -f "$list_kib" && curl -sS --max-time 20 --max-filesize $((list_kib * 1024)) -o "$body" -D "$headers" \
  -w '%{http_code}' -H 'Accept: application/vnd.github+json' "${conditional[@]}" "${api}/releases?per_page=${newest}" 2>/dev/null) \
  || status=000
if [ "$(stat -c %s "$body")" -ge $((list_kib * 1024)) ]; then
  say "GitHub's release list is over 4 MiB, nothing done"
  exit 0
fi
case "$status" in
  304)
    say "no release changed since the last check"
    exit 0
    ;;
  200) ;;
  *)
    say "GitHub answered ${status} for the release list, nothing done"
    exit 0
    ;;
esac
new_etag=$(sed -n 's/^[Ee][Tt][Aa][Gg]: *\([^[:space:]]*\)[[:space:]]*$/\1/p' "$headers" | tail -n 1)

if ! target=$(python3 -I -c 'import json, re, sys
releases = json.load(open(sys.argv[1]))
if not isinstance(releases, list):
    sys.exit(1)
releases = releases[:int(sys.argv[2])]
version = re.compile(r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
tags = [r["tag_name"] for r in releases
        if r.get("draft") is False and r.get("prerelease") is False and version.match(str(r.get("tag_name", "")))]
if tags:
    print(max(tags, key=lambda t: tuple(int(n) for n in t[1:].split("."))))' "$body" "$newest" 2>/dev/null); then
  say "GitHub's release list is not a list of releases, nothing done"
  exit 0
fi
if [ -z "$target" ]; then
  say "no release is published"
  finish
  exit 0
fi

# A failure before a rollout starts is not a decision, so the release is tried again, 2, 4 and 8 minutes later, then every
# 16 and every 30. A newly published release is tried at once.
now=$(date +%s)
retry_count=0
if read -r retry_tag count retry_at 2>/dev/null < "$retry_file" && [ "$retry_tag" = "$target" ] \
  && [[ "$count" =~ ^[0-9]{1,6}$ ]] && [[ "$retry_at" =~ ^[0-9]{1,12}$ ]]; then
  if [ "$now" -lt "$retry_at" ]; then
    say "${target} is retried at ${retry_at}"
    exit 0
  fi
  retry_count=$count
fi
retry_later() {
  local delay=1800
  if [ "$retry_count" -lt 4 ]; then delay=$((120 << retry_count)); fi
  write "$retry_file" "${target} $((retry_count + 1)) $((now + delay))"
  say "$1. ${target} is retried at $((now + delay))"
  exit 0
}

if ! record=$(curl -fsSL --max-time 30 --max-filesize 4096 "https://github.com/${repository}/releases/download/${target}/image-digest.txt" 2>/dev/null \
  | head -c 4096); then
  retry_later "cannot read ${target}'s image-digest.txt, nothing done"
fi
pattern=$'^commit ([0-9a-f]{40})\ndigest (sha256:[0-9a-f]{64})$'
if [[ ! "$record" =~ $pattern ]]; then
  say "refused ${target}: its image-digest.txt is not a commit line and a digest line"
  handle "$target" refused
  finish
  exit 0
fi
commit="${BASH_REMATCH[1]}"
digest="${BASH_REMATCH[2]}"

pinned=$(awk -v tag="$target" '$1 == tag { digest = $2 } END { print digest }' "$handled" 2>/dev/null || true)
if [ -n "$pinned" ] && [ "$pinned" != "$digest" ]; then
  say "REFUSED ${target}: its image-digest.txt now names ${digest}, but ${target} was handled as ${pinned}. Nothing is deployed. A published release keeps the image it was published with, so cut a new version for a rebuilt image."
  exit 1
fi
if [ "$(tail -n 1 "$handled" 2>/dev/null || true)" = "${target} ${digest}" ]; then
  say "${target} (${digest}) is already handled"
  finish
  exit 0
fi
running=$(cat "${dir}/current-image" 2>/dev/null || true)
if [ "$running" = "$digest" ]; then
  say "${target} (${digest}) is already running"
  handle "$target" "$digest"
  finish
  exit 0
fi

if ! where=$(curl -fsS --max-time 20 --max-filesize "$compare_bytes" -H 'Accept: application/vnd.github+json' \
  "${api}/compare/master...${commit}?per_page=1" 2>/dev/null | head -c $((compare_bytes + 1)) \
  | python3 -I -c 'import json, sys
data = sys.stdin.buffer.read()
if len(data) > int(sys.argv[1]):
    sys.exit(1)
print(json.loads(data)["status"])' "$compare_bytes" 2>/dev/null); then
  retry_later "cannot ask GitHub whether ${commit} is on master, nothing done"
fi
if [ "$where" != identical ] && [ "$where" != behind ]; then
  say "refused ${target}: its commit ${commit} is ${where} master, not on it"
  handle "$target" "$digest"
  finish
  exit 0
fi

say "deploying ${target} (${commit}, ${digest}) over ${running:-nothing}"
result=0
output=$(/usr/local/sbin/afterclass-deploy "$commit" "$digest" 2>&1) || result=$?
while IFS= read -r line; do if [ -n "$line" ]; then note "$line"; fi; done <<<"$output"
case "$result" in
  0)
    handle "$target" "$digest"
    finish
    say "${target} is live"
    ;;
  3)
    handle "$target" "$digest"
    finish
    say "${target} failed and is not tried again. Publish a fixed release, or retry by hand with scripts/deploy-beta.sh ${target}."
    exit 1
    ;;
  *) retry_later "${target} did not start its rollout, afterclass-deploy exited ${result}" ;;
esac
