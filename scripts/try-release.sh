#!/bin/bash
# Usage: scripts/try-release.sh <release tag>, for example scripts/try-release.sh v0.1.5. Prints the release's summary and
# runs the image its image-digest.txt names, by digest, on this machine. The app runs in replay mode with no keys file and
# a database that lives and dies with the container, so it makes no Jev, Claude or AWS call and never touches the beta
# server. Ctrl-C stops and removes the container. Needs gh, docker and curl.
#
# The release image is linux/arm64. On a machine that cannot run arm64 images, the script builds a local image from the
# release image's own /app and /data on the amd64 build of the Bun base image that the release's Dockerfile pins, and
# says so. The app code is the release's, byte for byte. Only the Bun binary differs.
set -euo pipefail

github_repository=DerekHertz/after-class
repository=ghcr.io/derekhertz/after-class
port="${AFTERCLASS_TRY_PORT:-8790}"

fail() {
  echo "try-release: $*" >&2
  exit 1
}

tag="${1:-}"
if [[ ! "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "usage: scripts/try-release.sh v<major>.<minor>.<patch>" >&2
  exit 2
fi
[[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] || fail "AFTERCLASS_TRY_PORT '${port}' is not a port"

release=$(gh release view "$tag" --repo "$github_repository" --json isDraft,isPrerelease \
  --jq 'if .isDraft then "draft" elif .isPrerelease then "pre-release" else "published" end') || fail "there is no ${tag} release"
summary=$(gh release view "$tag" --repo "$github_repository" --json body --jq .body)
record=$(gh release download "$tag" --repo "$github_repository" --pattern image-digest.txt --output -) \
  || fail "the ${tag} release has no image-digest.txt. Wait for the release workflow to finish."
pattern=$'^commit ([0-9a-f]{40})\ndigest (sha256:[0-9a-f]{64})$'
[[ "$record" =~ $pattern ]] || fail "the ${tag} release's image-digest.txt is not a commit line and a digest line"
commit="${BASH_REMATCH[1]}"
image="${repository}@${BASH_REMATCH[2]}"
# A run of the same tag elsewhere must not share a name, or its cleanup would stop this run's container.
suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
name="afterclass-try-${tag//./-}-${suffix}"

echo "try-release: pulling ${image}" >&2
docker pull --quiet --platform linux/arm64 "$image" >/dev/null

# Each holds only what this run created, so cleanup never touches another run's container or image.
started=""
built=""
context=""
cleanup() {
  if [ -n "$started" ]; then docker stop --time 5 "$started" >/dev/null 2>&1 || true; fi
  if [ -n "$built" ]; then docker image rm "$built" >/dev/null 2>&1 || true; fi
  if [ -n "$context" ]; then rm -rf "$context"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if docker run --rm --platform linux/arm64 --entrypoint true "$image" >/dev/null 2>&1; then
  run_image="$image"
  how="the release image itself"
else
  dockerfile=$(gh api -H 'Accept: application/vnd.github.raw+json' "repos/${github_repository}/contents/Dockerfile?ref=${commit}") \
    || fail "cannot read the Dockerfile at ${commit}"
  base=$(sed -n -E 's/^ARG BUN_IMAGE=(oven\/bun:[0-9A-Za-z._-]+@sha256:[0-9a-f]{64})$/\1/p' <<<"$dockerfile")
  [ -n "$base" ] || fail "the Dockerfile at ${commit} pins no oven/bun base image by digest"
  inspect() { docker image inspect --platform linux/arm64 --format "$1" "$image"; }
  context=$(mktemp -d)
  {
    echo "FROM --platform=linux/arm64 ${image} AS release"
    echo "FROM ${base}"
    echo "COPY --from=release /app /app"
    echo "COPY --from=release /data /data"
    while IFS= read -r line; do
      case "$line" in AFTERCLASS_*=*) printf 'ENV %s="%s"\n' "${line%%=*}" "${line#*=}" ;; esac
    done <<<"$(inspect '{{range .Config.Env}}{{println .}}{{end}}')"
    echo "WORKDIR $(inspect '{{.Config.WorkingDir}}')"
    echo "USER $(inspect '{{.Config.User}}')"
    echo "CMD $(inspect '{{json .Config.Cmd}}')"
  } >"${context}/Dockerfile"
  run_image="afterclass-try:${tag}-${suffix}"
  echo "try-release: this machine cannot run arm64 images, so it builds ${run_image} from the release's /app and /data on ${base}" >&2
  docker build --quiet --platform linux/amd64 --tag "$run_image" "$context" >/dev/null
  built="$run_image"
  how="the release's /app and /data on the amd64 build of ${base}"
fi

# The app answers only a Host of 127.0.0.1:<its own port>, so it listens on the port the browser uses.
started=$(docker run --rm --detach --name "$name" --env AFTERCLASS_MODE=replay --env "AFTERCLASS_PORT=${port}" \
  --publish "127.0.0.1:${port}:${port}" --cap-drop ALL --security-opt no-new-privileges "$run_image")

healthy=""
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
if [ -z "$healthy" ]; then
  docker logs "$started" >&2 || true
  fail "${tag} did not answer /health within 60 seconds"
fi

cat <<EOF

${tag}, ${release}, commit ${commit}

${summary}

try-release: running ${how}, ${image}.
try-release: replay mode with no keys and a throwaway database. Nothing reaches the beta server, Jev or Claude.
try-release: open http://127.0.0.1:${port}/app/ and press Ctrl-C here to stop it.

EOF
# In the background, so a TERM or INT reaches the trap at once instead of after the log stream ends.
docker logs --follow "$started" &
wait $!
