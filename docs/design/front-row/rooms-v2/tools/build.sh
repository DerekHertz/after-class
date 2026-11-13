#!/bin/bash
# Rebuilds the assets, manifest.json, preview.html and the screenshots.
# usage: tools/build.sh <folder holding the generated originals> [room]
set -e
here="$(cd "$(dirname "$0")" && pwd)"
python3 "$here/process.py" "$1"
python3 "$here/make_preview.py"
cd "$here/../../../../.."
bun docs/design/front-row/rooms-v2/tools/screenshots.mjs $2
