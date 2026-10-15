# -*- coding: utf-8 -*-
"""Canonical dump of a data file, loaded through the app's OWN store code.

    STORE_MODULE=inv_store STORE_OPEN=open_root PYTHONPATH=<app>/src \\
        python2.7|python3.12 inspect_store.py DATA_FILE [--types]

Runs on Python 2.7 and 3.x. By default every string-like value is shown as
text (Python 2 str and Python 3 bytes decoded as UTF-8), so a port that keeps
text as unicode compares equal to the Python 2 build, while lost entries,
mojibake, changed numbers or an unreadable file show up as differences.

--types keeps the Python 2 distinction between byte strings and unicode
({"b": ...} / {"u": ...}). It is only meaningful when the reader is Python 2:
the persistence check uses it to ask whether the LEGACY build sees exactly the
same types after the port has written the file.
"""
from __future__ import print_function

import importlib
import json
import os
import sys

try:
    text_type = unicode  # noqa: F821  (Python 2)
    int_types = (int, long)  # noqa: F821
    PY2 = True
except NameError:
    text_type = str
    int_types = (int,)
    PY2 = False


def canon(value, types, stack=()):
    if id(value) in stack:
        return {"cycle": True}
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int_types):
        return int(value)
    if isinstance(value, float):
        return {"float": repr(value)}
    if isinstance(value, text_type):
        if types and PY2:
            return {"u": value}
        return text_type(value) if not PY2 else value
    if isinstance(value, bytes):
        try:
            text = value.decode("utf-8")
        except UnicodeDecodeError:
            return {"undecodable_bytes": repr(value)}
        return {"b": text} if (types and PY2) else text
    if hasattr(value, "isoformat") and not hasattr(value, "__dict__"):
        return {"date": value.isoformat()}
    stack = stack + (id(value),)
    if isinstance(value, dict):
        items = [(canon(k, types, stack), canon(v, types, stack)) for k, v in value.items()]
        items.sort(key=lambda kv: json.dumps(kv, sort_keys=True))
        return {"dict": [[k, v] for k, v in items]}
    if isinstance(value, (list, tuple)):
        return [canon(v, types, stack) for v in value]
    if isinstance(value, set):
        return {"set": sorted([canon(v, types, stack) for v in value], key=lambda v: json.dumps(v, sort_keys=True))}
    state = getattr(value, "__dict__", None)
    if state is not None:
        attrs = {}
        for k, v in state.items():
            name = k.decode("ascii") if isinstance(k, bytes) else k
            if not name.startswith("_v_"):
                attrs[name] = v
        return {"object": type(value).__name__, "attrs": canon(attrs, types, stack)}
    return {"other": type(value).__name__, "repr": repr(value)}


def main(argv):
    module = importlib.import_module(os.environ.get("STORE_MODULE", "store"))
    opener = getattr(module, os.environ.get("STORE_OPEN", "open_root"))
    root = opener(argv[1])
    out = json.dumps(canon(root, "--types" in argv), sort_keys=True, ensure_ascii=True, indent=1,
                     separators=(",", ": "))
    sys.stdout.write(out + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
