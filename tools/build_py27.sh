#!/usr/bin/env bash
# Builds CPython 2.7.18 from source (Ubuntu 24.04 no longer ships Python 2).
#   tools/build_py27.sh /opt/py27      -> /opt/py27/bin/python2.7
# Needs: build-essential zlib1g-dev libssl-dev libffi-dev libbz2-dev libsqlite3-dev
set -euo pipefail
PREFIX="${1:-/opt/py27}"
WORK="$(mktemp -d)"
LOG="$WORK/build.log"
trap 'echo "Python 2.7 build failed, last lines of $LOG:"; tail -20 "$LOG"' ERR
git -c advice.detachedHead=false clone -q --depth 1 --branch v2.7.18 https://github.com/python/cpython.git "$WORK/cpython27"
cd "$WORK/cpython27"
./configure --prefix="$PREFIX" CFLAGS="-O1 -Wno-error -std=gnu99" >"$LOG" 2>&1
make -j"$(nproc)" >>"$LOG" 2>&1
make install >>"$LOG" 2>&1
trap - ERR
cd /
rm -rf "$WORK"
"$PREFIX/bin/python2.7" -c "import sys, zlib, csv, unicodedata, wsgiref; print('Python ' + sys.version.split()[0] + ' ready')"
