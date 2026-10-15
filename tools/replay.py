#!/usr/bin/env python3
"""Replay what the agents of a run did, in order, from their own records.

    python3 tools/replay.py NAME            # e.g. inv-suggested or inv-current
    python3 tools/replay.py NAME --full     # don't shorten long lines

Works for both plans, while a run is going or after it ended. Read-only; run it
as root (it reads the harness user's Claude Code transcripts).

It shows, from:
  RUN/logs/claude-*.json          each Claude run's final answer (outcome, assumptions, risks)
  ~harness/.claude/projects/...   the session transcripts: what Claude said, every tool call,
                                  every subagent it started (and whether in the background),
                                  and what came back to the final answer and to subagent calls
  RUN/workspace/.pi/hooks.jsonl   everything the hooks blocked, with the reason
  RUN/progress.log                the lifecycle steps
"""
import glob
import json
import os
import re
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
if not args:
    sys.exit(__doc__)
full = "--full" in sys.argv
name = args[0]
run = name if name.startswith("/") else os.path.join("/srv/runs", name)
home = os.environ.get("HARNESS_HOME", "/home/harness")
W = 100000 if full else 220


def cut(s, w=W):
    s = str(s).replace("\n", " ").replace(run + "/workspace/", "").replace(run + "/", "")
    return s if len(s) <= w else s[:w] + " …"


def section(title):
    print("\n=== %s" % title)


# --- lifecycle --------------------------------------------------------------
if os.path.exists(os.path.join(run, "progress.log")):
    section("lifecycle (progress.log)")
    for line in open(os.path.join(run, "progress.log"), errors="replace"):
        print(cut(line.rstrip()))

# --- final answers ----------------------------------------------------------
answers = sorted(glob.glob(os.path.join(run, "logs", "claude-*.json")) + glob.glob(os.path.join(run, "claude-result.json")),
                 key=os.path.getmtime)
if answers:
    section("Claude's final answers")
for f in answers:
    try:
        o = json.load(open(f))
    except ValueError:
        print("%s: not JSON" % os.path.basename(f))
        continue
    s = o.get("structured_output") or {}
    print("-- %s  turns=%s subtype=%s cost=$%s" % (os.path.basename(f), o.get("num_turns"), o.get("subtype"),
                                                     round(o.get("total_cost_usd") or 0, 2)))
    for k in ("outcome", "internalIterations", "verdict", "assumptions", "unresolvedRisks", "knownBehavioralDifferences",
              "testsExecuted", "changedFiles"):
        if k in s:
            print("   %-27s %s" % (k, cut(json.dumps(s[k], ensure_ascii=False))))
    if o.get("result"):
        print("   %-27s %s" % ("result text", cut(o["result"])))
    if o.get("permission_denials"):
        print("   %-27s %s" % ("permission denials", cut(json.dumps(o["permission_denials"]))))

# --- hooks -----------------------------------------------------------------
hooks = os.path.join(run, "workspace", ".pi", "hooks.jsonl")
if os.path.exists(hooks):
    section("hook events other than subagent start/stop")
    for line in open(hooks, errors="replace"):
        try:
            h = json.loads(line)
        except ValueError:
            continue
        if h.get("event") in ("SubagentStart", "SubagentStop", "subagent_start", "subagent_stop"):
            continue
        inp = h.get("input") or {}
        what = inp.get("command") or inp.get("file_path") or ""
        print("%s %-14s %-22s %s | %s" % ((h.get("ts") or "")[11:19], h.get("event"), h.get("agent") or "main",
                                          cut(h.get("reason") or "", 120), cut(what, 160)))

# --- transcripts -----------------------------------------------------------
esc = lambda p: re.sub(r"[^A-Za-z0-9]", "-", p)
projects = os.path.join(home, ".claude", "projects")
sessions = []
for d in (esc(run), esc(os.path.join(run, "workspace"))):
    sessions += glob.glob(os.path.join(projects, d, "*.jsonl"))
sessions.sort(key=os.path.getmtime)


def replay(path, indent=""):
    names = {}
    for line in open(path, errors="replace"):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        t = (e.get("timestamp") or "")[11:19]
        kind = e.get("type")
        c = (e.get("message") or {}).get("content")
        if isinstance(c, str):
            if kind == "user":
                print("%s%s USER    %s" % (indent, t, cut(c)))
            continue
        if not isinstance(c, list):
            continue
        for b in c:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text" and b.get("text", "").strip():
                print("%s%s %s %s" % (indent, t, "SAYS   " if kind == "assistant" else "USER   ", cut(b["text"])))
            elif bt == "tool_use":
                names[b.get("id")] = b.get("name")
                inp = b.get("input") or {}
                if b.get("name") == "StructuredOutput":
                    d = "outcome=%s iterations=%s" % (inp.get("outcome"), inp.get("internalIterations"))
                elif inp.get("subagent_type"):
                    d = "%s: %s%s" % (inp["subagent_type"], inp.get("description", ""),
                                      "  [background]" if inp.get("run_in_background") else "")
                else:
                    d = inp.get("command") or inp.get("file_path") or inp.get("pattern") or inp.get("skill") or json.dumps(inp)
                print("%s%s CALL    %-10s %s" % (indent, t, b.get("name"), cut(d)))
            elif bt == "tool_result":
                tool = names.get(b.get("tool_use_id"))
                r = b.get("content")
                r = r if isinstance(r, str) else json.dumps(r, ensure_ascii=False)
                if b.get("is_error") or tool in ("StructuredOutput", "Agent", "Task", "TaskOutput"):
                    print("%s%s %s %-10s %s" % (indent, t, "ERROR  " if b.get("is_error") else "RESULT ", tool, cut(r)))


for s in sessions:
    section("session %s (%s)" % (os.path.basename(s), "main"))
    replay(s)
    for sub in sorted(glob.glob(os.path.join(s[:-6], "subagents", "*.jsonl")), key=os.path.getmtime):
        section("  subagent %s" % os.path.basename(sub))
        replay(sub, "  ")
if not sessions:
    print("\n(no Claude transcripts under %s for this run)" % projects)
