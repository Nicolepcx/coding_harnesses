"""Shared helpers for the factory hooks. Hooks get the event as JSON on stdin."""
import datetime
import fnmatch
import json
import os
import sys


def read_event():
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def project_dir(event):
    return os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or os.getcwd()


def load_claim(root):
    """Pi writes the unit's claim: which paths may be written, which are frozen.
    For a bounded repair Pi passes a narrower claim outside the workspace (PI_CLAIM_FILE)."""
    for path in (os.environ.get("PI_CLAIM_FILE"), os.path.join(root, ".pi", "claim.json")):
        if not path:
            continue
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            continue
    return {"writable": ["src/**", "tests/**"],
            "forbidden": ["acceptance/**", "data/**", ".pi/**", ".claude/**", "CLAUDE.md"]}


def matches(path, globs):
    return any(fnmatch.fnmatch(path, g) or path == g.rstrip("/*") for g in globs)


def relative(root, path):
    if not path:
        return ""
    absolute = os.path.normpath(path if os.path.isabs(path) else os.path.join(root, path))
    return os.path.relpath(absolute, root)


def log(root, record):
    record["ts"] = datetime.datetime.utcnow().isoformat() + "Z"
    try:
        os.makedirs(os.path.join(root, ".pi"), exist_ok=True)
        with open(os.path.join(root, ".pi", "hooks.jsonl"), "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass


def deny(root, event, reason):
    log(root, {"event": "deny", "tool": event.get("tool_name"), "agent": event.get("agent_type"),
               "reason": reason, "input": event.get("tool_input")})
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))
    sys.exit(0)
