#!/usr/bin/env bash
# Score a run on the hidden suite, on Python 3.12 and 2.7. Run as root.
#   tools/score.sh NAME            (a run under /srv/runs)
#   tools/score.sh /path/to/app    (any directory with src/)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="$(basename "${HARNESS_DOMAIN:-$REPO/domains/invoicing}")"
APP="$1"; [ -d "$APP" ] || APP="/srv/runs/$1"
[ -d "$APP/workspace/src" ] && APP="$APP/workspace"
RUNNER="/opt/judge/$DOMAIN/hidden/runner.py"
for py in /usr/local/bin/python3.12 /usr/local/bin/python2.7; do
  sudo -u judge python3 "$RUNNER" score --python "$py" --app "$APP" | sed -n '1,2p;/FAIL/p'
  echo
done
