#!/usr/bin/env bash
# One-screen status of a run: where it is, what is working right now, memory,
# and whether a person is needed.   tools/status.sh NAME
NAME="${1:?run name}"; R="/srv/runs/$NAME"
echo "Now:               $(date -u +%H:%M:%S) UTC"
echo "Run:               $(systemctl is-active "$NAME" 2>/dev/null) (inactive = finished or stopped)"
if [ -f "$R/status.json" ]; then
  python3 - "$R/status.json" <<'PY'
import json, sys, datetime
s = json.load(open(sys.argv[1]))
since = datetime.datetime.fromisoformat(s["updatedAt"].replace("Z", "+00:00"))
mins = int((datetime.datetime.now(datetime.timezone.utc) - since).total_seconds() // 60)
print("At step:           %s since %s UTC (%d min)" % (s["trace"][-1], since.strftime("%H:%M:%S"), mins))
print("So far:            %s factory run(s), %s repair(s), API-equivalent $%s" % (s["factoryRuns"], s["repairs"], s["costUsd"]))
PY
  echo "Last step done:    $(tail -n 1 "$R/progress.log" 2>/dev/null | cut -c1-150)"
elif [ -f "$R.log" ]; then
  echo "Log:               $(tail -n 1 "$R.log" | cut -c1-150)"
fi
P=$(pgrep -u harness -f 'claude -p|codex exec' | head -1)
if [ -n "$P" ]; then
  echo "Working right now: $(ps -o etime=,args= -p "$P" | cut -c1-100)"
  N=$(pgrep -u harness -fc 'codex exec'); [ "$N" -gt 0 ] && echo "                   $N Codex verifier run(s) in parallel"
else
  echo "Working right now: no agent (checks running, finished, or waiting for you)"
fi
if [ -f "$R/workspace/.pi/hooks.jsonl" ]; then
  echo "Last agent event:  $(tail -n 1 "$R/workspace/.pi/hooks.jsonl" | grep -o '"event": "[^"]*"\|"agent": "[^"]*"\|"ts": "[^"]*"' | tr '\n' ' ')"
fi
systemctl status "$NAME" --no-pager 2>/dev/null | grep -o 'Memory: .*' | sed 's/^/                   /'
for c in "$R"/decisions/case-*.json; do
  [ -f "$c" ] || continue; n=${c##*case-}; n=${n%.json}
  [ -f "$R/decisions/answer-$n.json" ] || echo ">>> WAITING FOR YOU: tools/decide.sh $R"
done
exit 0
