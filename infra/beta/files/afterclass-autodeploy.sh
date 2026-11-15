#!/bin/bash
# Run every minute by afterclass-autodeploy.timer. Deploys the highest published release of the repository through
# afterclass-deploy, so publishing a draft release on GitHub is the deploy approval. Drafts and pre-releases never count.
# It asks the public GitHub API without a sign-in and sends the ETag of the last list it finished with, so an unchanged
# list answers 304, which GitHub does not count against the 60 requests an hour it allows. A GitHub error, a rate limit, a
# malformed image-digest.txt or a commit off master deploys nothing. Every decision goes to the log group's autodeploy stream.
#
# The release it last acted on, as "<tag> <digest>", is in /data/afterclass/autodeploy. It acts once per release:
# - A manual deploy with scripts/deploy-beta.sh stays until a different release becomes the highest published one.
# - A release that fails its health check is rolled back by afterclass-deploy and not tried again.
# - Publishing an older version deploys nothing, because only the highest published version counts. To roll back from
#   GitHub, mark the newest release as a pre-release or delete it, and the next highest one is deployed.
set -euo pipefail

. /etc/afterclass/settings.env

repository=DerekHertz/after-class
api="https://api.github.com/repos/${repository}"
dir=/data/afterclass
handled="${dir}/autodeploy"
etag_file="${dir}/autodeploy.etag"

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

# Saved only once a run reaches a decision, so a run cut short by an error asks for the full list again.
new_etag=""
finish() {
  if [[ "$new_etag" =~ ^(W/)?\"[!#-~]+\"$ ]]; then write "$etag_file" "$new_etag"; fi
}

etag=$(cat "$etag_file" 2>/dev/null || true)
conditional=()
if [ -n "$etag" ]; then conditional=(-H "If-None-Match: ${etag}"); fi
status=$(curl -sS --max-time 20 -o "$body" -D "$headers" -w '%{http_code}' -H 'Accept: application/vnd.github+json' \
  "${conditional[@]}" "${api}/releases?per_page=100" 2>/dev/null) || status=000
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
version = re.compile(r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
tags = [r["tag_name"] for r in releases
        if r.get("draft") is False and r.get("prerelease") is False and version.match(str(r.get("tag_name", "")))]
if tags:
    print(max(tags, key=lambda t: tuple(int(n) for n in t[1:].split("."))))' "$body" 2>/dev/null); then
  say "GitHub's release list is not a list of releases, nothing done"
  exit 0
fi
if [ -z "$target" ]; then
  say "no release is published"
  finish
  exit 0
fi

if ! record=$(curl -fsSL --max-time 30 --max-filesize 4096 "https://github.com/${repository}/releases/download/${target}/image-digest.txt" 2>/dev/null); then
  say "cannot read ${target}'s image-digest.txt, nothing done"
  exit 0
fi
pattern=$'^commit ([0-9a-f]{40})\ndigest (sha256:[0-9a-f]{64})$'
if [[ ! "$record" =~ $pattern ]]; then
  say "refused ${target}: its image-digest.txt is not a commit line and a digest line"
  write "$handled" "${target} refused"
  finish
  exit 0
fi
commit="${BASH_REMATCH[1]}"
digest="${BASH_REMATCH[2]}"

if [ "$(cat "$handled" 2>/dev/null || true)" = "${target} ${digest}" ]; then
  say "${target} (${digest}) is already handled"
  finish
  exit 0
fi
running=$(cat "${dir}/current-image" 2>/dev/null || true)
if [ "$running" = "$digest" ]; then
  say "${target} (${digest}) is already running"
  write "$handled" "${target} ${digest}"
  finish
  exit 0
fi

# The pull comes before the master check, so a GHCR outage costs no API request. Pulling runs nothing.
if ! /usr/local/sbin/afterclass-pull "$digest" >/dev/null 2>&1; then
  say "cannot pull ${digest} for ${target}, trying again next minute"
  exit 0
fi

if ! where=$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' "${api}/compare/master...${commit}?per_page=1" 2>/dev/null \
  | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["status"])' 2>/dev/null); then
  say "cannot ask GitHub whether ${commit} is on master, nothing done"
  exit 0
fi
if [ "$where" != identical ] && [ "$where" != behind ]; then
  say "refused ${target}: its commit ${commit} is ${where} master, not on it"
  write "$handled" "${target} ${digest}"
  finish
  exit 0
fi

say "deploying ${target} (${commit}, ${digest}) over ${running:-nothing}"
result=0
output=$(/usr/local/sbin/afterclass-deploy "$commit" "$digest" 2>&1) || result=$?
while IFS= read -r line; do note "$line"; done <<<"$output"
write "$handled" "${target} ${digest}"
finish
if [ "$result" -ne 0 ]; then
  say "${target} failed and is not tried again. Publish a fixed release, or retry by hand with scripts/deploy-beta.sh ${target}."
  exit 1
fi
say "${target} is live"
