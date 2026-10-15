#!/usr/bin/env python3
"""What the agents of one run are doing right now, from their own logs.

    python3 tools/now.py /srv/runs/NAME [HARNESS_HOME] [N]

Claude Code writes a transcript of every session (including headless `claude -p`
and its subagents) under ~/.claude/projects/<escaped working dir>/. Codex runs
are tee'd by the harness into RUN/logs/<role>.log. This reads both and prints
the last few things each agent did, with times in UTC. Read-only.
"""
import glob
import json
import os
import re
import sys
import time

run = os.path.abspath(sys.argv[1])
home = sys.argv[2] if len(sys.argv) > 2 else "/home/harness"
n = int(sys.argv[3]) if len(sys.argv) > 3 else 6
now = time.time()


def escaped(path):
    return re.sub(r"[^A-Za-z0-9]", "-", path)


def ago(ts):
    s = int(now - ts)
    return "%ds ago" % s if s < 120 else "%d min ago" % (s // 60)


def short(tool, inp):
    if not isinstance(inp, dict):
        return ""
    if inp.get("subagent_type"):
        return ("%s: %s" % (inp["subagent_type"], inp.get("description", "")))[:110]
    for key in ("command", "description", "file_path", "pattern", "prompt", "subagent_type", "skill"):
        if inp.get(key):
            val = str(inp[key])
            if key == "prompt" and inp.get("subagent_type"):
                val = "%s: %s" % (inp["subagent_type"], val)
            break
    else:
        val = json.dumps(inp)[:80]
    val = val.replace(run + "/workspace/", "").replace(run + "/", "").replace("\n", " ")
    return val[:110]


# --- Claude Code ------------------------------------------------------------
projects = os.path.join(home, ".claude", "projects")
dirs = [os.path.join(projects, escaped(p)) for p in (run, os.path.join(run, "workspace"))]
files = []
for d in dirs:
    files += glob.glob(os.path.join(d, "**", "*.jsonl"), recursive=True)
files.sort(key=os.path.getmtime)
if not files:
    print("Claude:            no transcript yet")
else:
    latest = files[-1]
    calls = []
    for line in open(latest, errors="replace"):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        content = (e.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                calls.append((e.get("timestamp", "")[11:19], b.get("name"), short(b.get("name"), b.get("input"))))
    who = "subagent" if "/subagents/" in latest else "main session"
    print("Claude (%s, %d session file(s), last write %s):" % (who, len(files), ago(os.path.getmtime(latest))))
    for t, tool, arg in calls[-n:]:
        print("   %s  %-10s %s" % (t, tool, arg))
    if not calls:
        print("   (thinking, no tool call yet)")

# --- Codex ------------------------------------------------------------------
logs = [f for f in glob.glob(os.path.join(run, "logs", "*.log")) if not f.endswith(".stderr.log")]
active = [f for f in logs if now - os.path.getmtime(f) < 15 * 60]
if active:
    print("Codex (logs written in the last 15 min):")
    for f in sorted(active, key=os.path.getmtime):
        lines = [l.strip() for l in open(f, errors="replace") if l.strip()]
        last = lines[-1][:110] if lines else ""
        print("   %-22s %-11s %s" % (os.path.basename(f)[:-4], ago(os.path.getmtime(f)), last))
elif logs:
    print("Codex:             idle (last log %s)" % ago(max(os.path.getmtime(f) for f in logs)))
