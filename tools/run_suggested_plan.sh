#!/usr/bin/env bash
# Suggested plan: the harness. Pi's lifecycle owns the run, the Claude Code
# factory builds, Codex verifies independently, frozen acceptance decides, and
# a person is asked only on escalations (tools/decide.sh).
#
#   tools/run_suggested_plan.sh RUN_DIR
#
# Run as the 'harness' user (tools/start.sh does that for you, inside a memory
# budget). Safe to start again after a crash or reboot: it resumes at the last
# recorded step.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${1:?run directory, e.g. /srv/runs/suggested-1}"
export HARNESS_DOMAIN="${HARNESS_DOMAIN:-$REPO/domains/invoicing}"
export PY2="${PY2:-/usr/local/bin/python2.7}" PY3="${PY3:-/usr/local/bin/python3.12}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
export PYTHONHASHSEED=0 LC_ALL=C.UTF-8 LANG=C.UTF-8
umask 022
if [ ! -d "$REPO/harness/node_modules/typebox" ]; then
  echo "harness dependencies missing: run (as root) cd $REPO/harness && npm ci" >&2
  exit 1
fi
mkdir -p "$RUN"
node "$REPO/harness/run.ts" "$RUN"
chmod -R a+rX "$RUN" 2>/dev/null || true
