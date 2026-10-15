#!/usr/bin/env python3
"""SubagentStart / SubagentStop: record the factory topology for the audit trail."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import log, project_dir, read_event  # noqa: E402

event = read_event()
log(project_dir(event), {
    "event": event.get("hook_event_name"),
    "agent": event.get("agent_type"),
    "agent_id": event.get("agent_id"),
})
sys.exit(0)
