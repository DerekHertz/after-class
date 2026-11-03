#!/bin/sh
# Reruns the TLC check of docs/flows/after-class.md and rewrites out-preparation/, out-record/
# and out-mutants.md.
# Needs TLA2TOOLS (tla2tools.jar 1.7.4), JAVA (Java 11 or later) and bun. STATECHART defaults to the
# pstack 0.15.36 copy.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${TLA2TOOLS:?set TLA2TOOLS to tla2tools.jar}"
: "${JAVA:=java}"
: "${STATECHART:=$HOME/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/skills/statechart/scripts/statechart}"
export TLA2TOOLS JAVA

want=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
have=$(sha256sum "$TLA2TOOLS" | cut -d' ' -f1)
[ "$have" = "$want" ] || { echo "tla2tools.jar checksum $have, want $want" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

plain() { # MODULE CFG OUT
  mkdir -p "$work/$2"
  cp "$here/$1.tla" "$here/$2" "$work/$2/"
  (cd "$work/$2" && "$JAVA" -XX:+UseParallelGC -Djava.io.tmpdir="$work/$2" -cp "$TLA2TOOLS" tlc2.TLC \
    -workers auto -metadir "$work/$2/meta" -config "$2" "$1.tla" > "$3" 2>&1) || true
  grep -E "No error has been found|is violated|were violated" "$3" | head -1 | sed "s|^|$2: |"
}

# statechart exits 1 when a rule breaks, which is a result, not a failure.
chart() { "$STATECHART" "$@" || [ $? -eq 1 ]; }

rm -rf "$here/out-preparation" "$here/out-record"

chart "$here/Preparation.tla" --config "$here/Preparation.cfg" \
  --view "$here/preparation.view.mjs" --out "$here/out-preparation"
chart "$here/PreparationChart.tla" --config "$here/PreparationChart.cfg" \
  --view "$here/preparation.view.mjs" --out "$here/out-preparation/chart"
plain Preparation Preparation.cfg "$here/out-preparation/tlc-plain.out"

chart "$here/Record.tla" --config "$here/Record.cfg" \
  --view "$here/record.view.mjs" --out "$here/out-record"
chart "$here/Record.tla" --config "$here/Record-chart.cfg" \
  --view "$here/record.view.mjs" --out "$here/out-record/chart"
plain Record Record.cfg "$here/out-record/tlc-plain.out"

bun "$here/mutants.ts" > "$here/out-mutants.md"
