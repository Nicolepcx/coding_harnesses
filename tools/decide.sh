#!/usr/bin/env bash
# Answer an escalation of the harness (the only step a person does).
#
#   tools/decide.sh RUN_DIR                          show the open case
#   tools/decide.sh RUN_DIR approve DEV-001 "note"   approve the listed findings and differences as a deviation
#   tools/decide.sh RUN_DIR repair "what to fix"     one more bounded repair
#   tools/decide.sh RUN_DIR reject "note"            stop: the patch is not acceptable
#   tools/decide.sh RUN_DIR suspend "note"           park the unit
set -euo pipefail
RUN="${1:?run directory}"; ACTION="${2:-show}"
D="$RUN/decisions"
N="$(ls "$D" 2>/dev/null | sed -n 's/^case-\([0-9]*\)\.json$/\1/p' | sort -n | while read -r n; do [ -f "$D/answer-$n.json" ] || echo "$n"; done | tail -1)"
if [ -z "$N" ]; then echo "Nothing waits for a decision in $RUN."; exit 0; fi
CASE="$D/case-$N.json"

if [ "$ACTION" = "show" ]; then
  python3 - "$CASE" <<'EOF'
import json, sys
c = json.load(open(sys.argv[1]))
print("Case %d: %s (from %s)" % (c["case"], c["reason"], c["from"]))
print("  %s" % c["summary"][:600])
print("  patch %s, $%s spent, %d repairs used" % ((c["patchRef"] or "-")[:10], c["costUsd"], c["repairsUsed"]))
for f in c.get("findings", []):
    print("  finding %s [%s, %s, %s%s] %s" % (f["id"], f.get("status", "?"), f["category"], f["severity"],
          ", reproduced" if f.get("reproduced") else "", f["summary"][:160]))
for d in c.get("knownBehavioralDifferences", []):
    print("  difference: %s" % d["description"][:160])
for r in c.get("unresolvedRisks", []):
    print("  risk [%s]: %s" % (r["severity"], r["description"][:160]))
print("Allowed: %s" % ", ".join(c["allowed"]))
EOF
  exit 0
fi

python3 - "$CASE" "$D/answer-$N.json" "$ACTION" "${@:3}" <<'EOF'
import json, sys
case_file, out, action, rest = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
c = json.load(open(case_file))
kinds = {"approve": "approve_difference", "repair": "require_repair", "reject": "reject", "suspend": "suspend"}
kind = kinds.get(action)
if kind is None:
    sys.exit("unknown action %r; use approve, repair, reject or suspend" % action)
if kind not in c["allowed"]:
    sys.exit("%s is not allowed for this case; allowed: %s" % (kind, ", ".join(c["allowed"])))
if kind == "approve_difference":
    if len(rest) < 1:
        sys.exit('usage: decide.sh RUN approve DEV-ID "note"')
    d = {"kind": kind, "deviationId": rest[0], "dismissFindingIds": [f["id"] for f in c.get("findings", [])],
         "note": rest[1] if len(rest) > 1 else ""}
elif kind == "require_repair":
    note = rest[0] if rest else "repair requested"
    d = {"kind": kind, "items": [{"source": "human", "ref": "human-%d" % c["case"], "summary": note, "files": []}], "note": note}
else:
    d = {"kind": kind, "note": rest[0] if rest else ""}
json.dump(d, open(out, "w"), indent=2)
print("Recorded %s for case %d. The harness continues within a few seconds." % (kind, c["case"]))
EOF
