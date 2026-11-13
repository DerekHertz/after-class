#!/bin/sh
# Checks ReviewEnd.tla, the model of the code path from Finish to a saved review.
# ReviewEnd.cfg is the code today and must hold every rule. Each ReviewEnd-noFix*.cfg puts one fixed
# bug back and must break its rule, which shows that the rule can fail.
# Needs TLA2TOOLS (tla2tools.jar 1.7.4) and JAVA (Java 11 or later). Exits 1 if any result is not the expected one.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
: "${TLA2TOOLS:?set TLA2TOOLS to tla2tools.jar}"
: "${JAVA:=java}"

want=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
have=$(sha256sum "$TLA2TOOLS" | cut -d' ' -f1)
[ "$have" = "$want" ] || { echo "tla2tools.jar checksum $have, want $want" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
bad=0

run() { # CFG EXPECTED, where EXPECTED is "holds" or the name of the rule that must break
  dir="$work/$1"
  mkdir -p "$dir"
  cp "$here/ReviewEnd.tla" "$here/$1" "$dir/"
  (cd "$dir" && "$JAVA" -XX:+UseParallelGC -Djava.io.tmpdir="$dir" -cp "$TLA2TOOLS" tlc2.TLC \
    -workers auto -metadir "$dir/meta" -config "$1" ReviewEnd.tla > "$dir/tlc.out" 2>&1) || true
  if grep -q "No error has been found" "$dir/tlc.out"; then got=holds
  elif got=$(grep -oE "Invariant [A-Za-z]+ is violated" "$dir/tlc.out" | head -1 | cut -d' ' -f2) && [ -n "$got" ]; then :
  elif grep -q "Temporal properties were violated" "$dir/tlc.out"; then got=AFinishedReviewEventuallySaves
  else got="no result"
  fi
  if [ "$got" = "$2" ]; then echo "ok    $1: $got"
  else echo "WRONG $1: got $got, want $2"; sed -n '1,200p' "$dir/tlc.out" | grep -E "Error|violated|deadlock" | head -5; bad=1
  fi
}

run ReviewEnd.cfg holds
run ReviewEnd-noFixCache.cfg AFinishedReviewEventuallySaves
run ReviewEnd-noFixHome.cfg EndedUnsavedIsReachableFromHome
run ReviewEnd-noFixDrop.cfg FinishIsNeverSilentlyDropped
run ReviewEnd-noFixLive.cfg RetryAlwaysResends
exit $bad
