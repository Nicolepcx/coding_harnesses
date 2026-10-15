#!/usr/bin/env bash
# Baseline: a purely mechanical 2to3 port of the domain's legacy app, no human
# or agent judgment. Shows how far syntax-level tooling gets on its own.
#   tools/mechanical_port.sh /path/to/python3.12 OUT_DIR
set -euo pipefail
PY3="${1:?python3.12 path (needs lib2to3, so 3.12 or older)}"
OUT="${2:?output directory}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${HARNESS_DOMAIN:-$REPO/domains/invoicing}"
rm -rf "$OUT" && mkdir -p "$OUT"
cp -r "$DOMAIN/app/src" "$DOMAIN/app/tests" "$OUT/"
"$PY3" -W ignore -m lib2to3 -w -n -j 4 "$OUT/src" "$OUT/tests" >/dev/null 2>&1
echo "mechanical port written to $OUT"
