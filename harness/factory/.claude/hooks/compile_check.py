#!/usr/bin/env python3
"""PostToolUse on Edit/Write: every edited Python file must compile on 2.7 and 3.12.
Exit code 2 sends the compiler error straight back to the agent."""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import log, project_dir, read_event, relative  # noqa: E402

event = read_event()
root = project_dir(event)
target = (event.get("tool_input") or {}).get("file_path", "")
path = relative(root, target)
if not path.endswith(".py") or path.startswith(".."):
    sys.exit(0)

errors = []
for python in ("python2.7", "python3.12"):
    code = "import sys; compile(open(sys.argv[1], 'rb').read(), sys.argv[1], 'exec')"
    try:
        proc = subprocess.run([python, "-c", code, os.path.join(root, path)],
                              capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        continue
    if proc.returncode != 0:
        lines = (proc.stderr or proc.stdout).strip().splitlines()
        errors.append("%s: %s" % (python, lines[-1] if lines else "compile error"))

if errors:
    log(root, {"event": "compile_error", "file": path, "agent": event.get("agent_type"), "errors": errors})
    sys.stderr.write("%s does not compile on both interpreters:\n%s\n" % (path, "\n".join(errors)))
    sys.exit(2)
sys.exit(0)
