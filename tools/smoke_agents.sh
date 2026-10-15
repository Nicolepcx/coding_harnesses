#!/usr/bin/env bash
# Two-minute check before the long run, as the 'harness' user: both agents are
# logged in, take structured output, and the factory hooks block what they must.
# Costs well under $1 on the API; on a subscription it uses a few messages.
set -uo pipefail
DEMO="$(cd "$(dirname "$0")/.." && pwd)"
export PY2="${PY2:-/usr/local/bin/python2.7}" PY3="${PY3:-/usr/local/bin/python3.12}"
export PW_NODE_MODULES="$DEMO/harness/node_modules"
TMP="$(mktemp -d /tmp/smoke-XXXXXX)"
ok=0

echo "1/2 Codex: login, sandbox and output schema"
cat > "$TMP/schema.json" <<'EOF'
{"type":"object","properties":{"ok":{"type":"boolean"},"python":{"type":"string"}},"required":["ok","python"],"additionalProperties":false}
EOF
if codex exec --skip-git-repo-check --ephemeral --sandbox workspace-write --cd "$TMP" --color never \
     --output-schema "$TMP/schema.json" -o "$TMP/codex.json" \
     'Run `python3.12 --version` and report ok=true and the version string as python.' >"$TMP/codex.log" 2>&1 \
   && python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['ok'] and '3.12' in d['python']; print('   OK  ', d)" "$TMP/codex.json"; then
  :
else
  ok=1; echo "   FAIL codex — last lines of its log:"; tail -5 "$TMP/codex.log" | sed 's/^/        /'
fi

echo "2/2 Claude Code: factory hooks, deny rules and evidence bundle"
node "$DEMO/harness/test/claude_smoke.ts" "$TMP/claude" 2>&1 | sed 's/^/   /' | head -30
[ "${PIPESTATUS[0]}" = 0 ] || ok=1

rm -rf "$TMP"
[ $ok = 0 ] && echo "Both agents ready." || echo "Fix the failures above before starting the suggested plan."
exit $ok
