#!/usr/bin/env bash
# Current plan: ONE headless Claude Code session migrates the app and checks
# its own work. No harness, no independent verifier, no frozen gates.
#
#   tools/run_current_plan.sh RUN_DIR [BUDGET_USD]
#
# Run as the 'harness' user (tools/start.sh does that for you).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${HARNESS_DOMAIN:-$REPO/domains/invoicing}"
RUN="${1:?run directory, e.g. /srv/runs/current-1}"
BUDGET="${2:-15}"
export GIT_AUTHOR_NAME="Baseline" GIT_AUTHOR_EMAIL="baseline@harness.local"
export GIT_COMMITTER_NAME="Baseline" GIT_COMMITTER_EMAIL="baseline@harness.local"
umask 022

if [ -e "$RUN/src" ]; then echo "$RUN already exists; choose a new run directory" >&2; exit 1; fi
mkdir -p "$RUN"
for item in $(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["copy"]))' "$DOMAIN/domain.json"); do
  cp -r "$DOMAIN/app/$item" "$RUN/"
done
find "$RUN" -name '*.pyc' -delete; find "$RUN" -name __pycache__ -type d -prune -exec rm -rf {} +
PROMPT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["currentPlanPrompt"])' "$DOMAIN/domain.json")"
cd "$RUN"
printf '*.pyc\n__pycache__/\nclaude-result.json\n' > .gitignore
git init -q && git add -A && git commit -qm "legacy baseline"
echo "workspace ready: $RUN ($(git rev-parse --short HEAD)), starting Claude Code at $(date -u +%H:%M:%S) UTC ..."

# Bash is allowed in full on purpose: narrow rules like "Bash(python2.7 *)" do not match
# "PYTHONPATH=src python2.7 ...", and headless runs cannot ask. The OS user is the boundary.
claude -p "$PROMPT" \
  --output-format json \
  --permission-mode acceptEdits \
  --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Bash" \
  --max-budget-usd "$BUDGET" \
  > "$RUN/claude-result.json" || echo "claude exited with status $? (budget or error); keeping what it did"

git add -A && git commit -qm "current plan: single Claude Code session" >/dev/null || true
chmod -R a+rX "$RUN"
python3 - "$RUN/claude-result.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print("finished at", __import__("datetime").datetime.utcnow().strftime("%H:%M:%S"), "UTC")
print("API-equivalent cost USD:", r.get("total_cost_usd"), "| turns:", r.get("num_turns"),
      "| minutes:", round((r.get("duration_ms") or 0) / 60000, 1),
      "| permission denials:", len(r.get("permission_denials") or []))
print()
print(r.get("result") or "")
PY
echo
echo "Run directory: $RUN"
