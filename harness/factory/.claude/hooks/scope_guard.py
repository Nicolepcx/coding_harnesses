#!/usr/bin/env python3
"""PreToolUse on Edit/Write: only paths in the unit's claim may be written."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import deny, load_claim, matches, project_dir, read_event, relative  # noqa: E402

event = read_event()
root = project_dir(event)
tool_input = event.get("tool_input") or {}
target = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
path = relative(root, target)
claim = load_claim(root)

if path.startswith(".."):
    if os.path.abspath(target).startswith("/tmp/"):
        sys.exit(0)
    deny(root, event, "%s is outside the unit workspace" % target)
if matches(path, claim.get("forbidden", [])):
    deny(root, event, "%s is frozen (acceptance, data, harness files). "
                      "Report the behavior difference instead of editing it." % path)
if not matches(path, claim.get("writable", [])):
    deny(root, event, "%s is outside this unit's claim %s" % (path, claim.get("writable")))
sys.exit(0)
