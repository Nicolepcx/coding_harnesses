#!/usr/bin/env bash
# Start a run in the background, as the 'harness' user, inside a memory budget.
# Run as root.
#
#   tools/start.sh current   NAME     one Claude Code session    -> /srv/runs/NAME
#   tools/start.sh suggested NAME     the harness                -> /srv/runs/NAME
#
# The run is a systemd unit named after NAME:
#   systemctl status NAME     state and memory
#   systemctl stop NAME       stop it and everything it started
# A process that blows the budget is killed on its own; the run continues
# (OOMPolicy=continue), and agents are killed before the harness (oom_score_adj).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLAN="${1:?current or suggested}"; NAME="${2:?run name, e.g. suggested-1}"
MEM="${HARNESS_MEMORY_MAX:-12G}"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
case "$PLAN" in
  current)   CMD="bash $REPO/tools/run_current_plan.sh /srv/runs/$NAME" ;;
  suggested) rm -f "/srv/runs/$NAME/.lock"; CMD="bash $REPO/tools/run_suggested_plan.sh /srv/runs/$NAME" ;;
  *) echo "first argument: current or suggested" >&2; exit 1 ;;
esac
systemctl reset-failed "$NAME" 2>/dev/null || true
systemd-run --unit="$NAME" --uid=harness --gid=harness -p MemoryMax="$MEM" -p MemorySwapMax=2G -p OOMPolicy=continue \
  /bin/bash -lc "$CMD >> /srv/runs/$NAME.log 2>&1"
sleep 3
systemctl status "$NAME" --no-pager | sed -n '1,8p'
echo
echo "Follow it:   tools/status.sh $NAME      (or: tail -f /srv/runs/$NAME.log)"
