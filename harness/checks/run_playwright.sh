#!/usr/bin/env bash
# Frozen Playwright acceptance against one build of the web app.
#
#   run_playwright.sh PYTHON APP_DIR SPEC_DIR FIXTURE DOMAIN_JSON [JSON_OUT]
#
# Starts APP_DIR/src's web module (named in DOMAIN_JSON) with PYTHON on a /tmp
# copy of FIXTURE, runs the specs from a scratch copy of SPEC_DIR (the frozen
# originals are never written) and leaves Playwright's JSON report in JSON_OUT.
set -uo pipefail
PY="${1:?python}"; APP="$(cd "${2:?app dir}" && pwd)"; SPECS="$(cd "${3:?spec dir}" && pwd)"
FIXTURE="$(cd "$(dirname "${4:?fixture}")" && pwd)/$(basename "$4")"
DOMAIN_JSON="${5:?domain.json}"
OUT="${6:-}"
WEB_MODULE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["modules"]["web"])' "$DOMAIN_JSON")"
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE_MODULES="${PW_NODE_MODULES:-$HERE/../node_modules}"
[ -d "$NODE_MODULES/@playwright/test" ] || { echo "Playwright not installed at $NODE_MODULES (set PW_NODE_MODULES)" >&2; exit 3; }

WORK="$(mktemp -d /tmp/pw-XXXXXX)"
cleanup() { [ -n "${SERVER:-}" ] && kill "$SERVER" 2>/dev/null; wait 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
cp "$SPECS"/*.ts "$WORK/"
ln -s "$NODE_MODULES" "$WORK/node_modules"
cp "$FIXTURE" "$WORK/$(basename "$FIXTURE")"

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
( cd "$WORK" && PYTHONPATH="$APP/src" PYTHONHASHSEED=0 PYTHONDONTWRITEBYTECODE=1 LC_ALL=C.UTF-8 \
    exec "$PY" -m "$WEB_MODULE" "$WORK/$(basename "$FIXTURE")" "$PORT" >"$WORK/server.log" 2>&1 ) &
SERVER=$!
for _ in $(seq 1 50); do
  if ! kill -0 "$SERVER" 2>/dev/null; then echo "web app did not start: $(tail -1 "$WORK/server.log")" >&2; break; fi
  python3 -c "import socket,sys; socket.create_connection(('127.0.0.1',$PORT),0.3)" 2>/dev/null && break
  sleep 0.2
done

cd "$WORK"
BASE_URL="http://127.0.0.1:$PORT" timeout 300 node node_modules/@playwright/test/cli.js test --config playwright.config.ts \
  >"$WORK/stdout.log" 2>&1
STATUS=$?
tail -5 "$WORK/stdout.log"
if [ -n "$OUT" ]; then
  if [ -f "$WORK/results.json" ]; then cp "$WORK/results.json" "$OUT"; else echo '{}' > "$OUT"; fi
fi
exit $STATUS
