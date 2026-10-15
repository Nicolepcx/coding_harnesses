#!/usr/bin/env bash
# Live view of one or more runs, refreshed every 20 seconds. Ctrl-C to leave;
# the runs keep going.        tools/watch.sh inv-current inv-suggested
[ $# -gt 0 ] || { echo "usage: tools/watch.sh NAME [NAME...]"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
EVERY="${EVERY:-20}"
while true; do
  out="$(for n in "$@"; do bash "$HERE/status.sh" "$n" 5; echo; done)"
  clear; echo "$out"; echo "(refreshes every ${EVERY}s; Ctrl-C leaves the view, not the runs)"
  sleep "$EVERY"
done
