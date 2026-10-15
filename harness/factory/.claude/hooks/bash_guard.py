#!/usr/bin/env python3
"""PreToolUse on Bash: block shell commands that would write into frozen paths.

Reading frozen files (cat, cp FROM data/ to /tmp, running the CLI on a /tmp
copy) is fine. Writing to them is not: redirection, tee, rm, mv, sed -i,
cp/mv INTO a frozen path, git checkout/restore/rm, or a CLI command that
writes its data file (listed in the claim as writeCommands) run on the
original data file.
"""
import os
import re
import shlex
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import deny, load_claim, project_dir, read_event  # noqa: E402

event = read_event()
root = project_dir(event)
command = (event.get("tool_input") or {}).get("command", "")
claim = load_claim(root)
prefixes = [g.replace("/**", "/").rstrip("*") for g in claim.get("forbidden", [])]


def frozen(token):
    t = token
    if t.startswith(root + "/"):
        t = t[len(root) + 1:]
    if t.startswith("./"):
        t = t[2:]
    return any(t == p.rstrip("/") or t.startswith(p) for p in prefixes)


for segment in re.split(r"&&|\|\||;|\|", command):
    try:
        tokens = shlex.split(segment)
    except ValueError:
        tokens = segment.split()
    if not tokens:
        continue
    for i, tok in enumerate(tokens):
        if tok in (">", ">>", "tee", "tee -a") and i + 1 < len(tokens) and frozen(tokens[i + 1]):
            deny(root, event, "writing to frozen path %s is not allowed" % tokens[i + 1])
        if (tok.startswith(">") and len(tok) > 1 and frozen(tok.lstrip(">"))):
            deny(root, event, "writing to frozen path %s is not allowed" % tok.lstrip(">"))
    cmd = os.path.basename(tokens[0])
    args = tokens[1:]
    if cmd in ("rm", "truncate", "chmod", "chown", "shred") and any(frozen(a) for a in args):
        deny(root, event, "%s on a frozen path is not allowed" % cmd)
    if cmd in ("sed", "perl") and any(a.startswith("-i") for a in args) and any(frozen(a) for a in args):
        deny(root, event, "in-place edit of a frozen path is not allowed")
    if cmd in ("cp", "mv", "rsync", "install", "ln") and args and frozen(args[-1]):
        deny(root, event, "%s into frozen path %s is not allowed" % (cmd, args[-1]))
    if cmd == "mv" and any(frozen(a) for a in args[:-1]):
        deny(root, event, "moving a frozen path is not allowed")
    if cmd == "git" and args and args[0] in ("checkout", "restore", "rm", "clean", "reset", "stash"):
        deny(root, event, "git %s is reserved for the harness" % args[0])
    for wc in claim.get("writeCommands", []):
        if wc.get("module") in tokens and wc.get("command") in tokens and any(frozen(a) for a in tokens):
            deny(root, event, "'%s %s' writes the data file it is given; run it on a /tmp copy"
                 % (wc.get("module"), wc.get("command")))
sys.exit(0)
