#!/usr/bin/env bash
# One-screen status of a run: where it is, what each agent did last, memory,
# and whether a person is needed.   tools/status.sh NAME [N tool calls, default 6]
#   (as root; for a live view of several runs: tools/watch.sh NAME...)
NAME="${1:?run name}"; R="/srv/runs/$NAME"; N="${2:-6}"
HERE="$(cd "$(dirname "$0")" && pwd)"
echo "=== $NAME   $(date -u +%H:%M:%S) UTC   service: $(systemctl is-active "$NAME" 2>/dev/null) (inactive = finished or stopped)"
if [ -f "$R/status.json" ]; then
  python3 - "$R/status.json" <<'PY'
import json, sys, datetime
s = json.load(open(sys.argv[1]))
since = datetime.datetime.fromisoformat(s["updatedAt"].replace("Z", "+00:00"))
mins = int((datetime.datetime.now(datetime.timezone.utc) - since).total_seconds() // 60)
print("Lifecycle:         %s" % " ".join(s["trace"][-12:]))
print("At step:           %s since %s UTC (%d min)" % (s["trace"][-1], since.strftime("%H:%M:%S"), mins))
print("So far:            %s factory run(s), %s repair(s), API-equivalent $%s" % (s["factoryRuns"], s["repairs"], s["costUsd"]))
PY
  echo "Last step done:    $(tail -n 1 "$R/progress.log" 2>/dev/null | cut -c1-150)"
elif [ -f "$R.log" ]; then
  echo "Log:               $(tail -n 1 "$R.log" | cut -c1-150)"
fi

# Agents of THIS run only: the processes in the run's own systemd unit.
CG="$(systemctl show -p ControlGroup --value "$NAME" 2>/dev/null)"
PIDS=""; [ -n "$CG" ] && [ -r "/sys/fs/cgroup$CG/cgroup.procs" ] && PIDS="$(cat "/sys/fs/cgroup$CG/cgroup.procs")"
found=0
for p in $PIDS; do
  a="$(ps -o etime=,args= -p "$p" 2>/dev/null)"
  case "$a" in *"claude -p"*|*"codex exec"*)
    found=1; echo "Running:           $(echo "$a" | sed 's/^ *//' | cut -c1-60) …";;
  esac
done
[ $found = 0 ] && echo "Running:           no agent (checks running, finished, or waiting for you)"

python3 "$HERE/now.py" "$R" /home/harness "$N" 2>/dev/null

systemctl status "$NAME" --no-pager 2>/dev/null | grep -o 'Memory: .*' | sed 's/^Memory: /Memory:            /'
for c in "$R"/decisions/case-*.json; do
  [ -f "$c" ] || continue; n=${c##*case-}; n=${n%.json}
  [ -f "$R/decisions/answer-$n.json" ] || echo ">>> WAITING FOR YOU: tools/decide.sh $R"
done
exit 0
