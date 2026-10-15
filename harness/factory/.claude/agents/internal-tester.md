---
name: internal-tester
description: Runs the unit's tests, the frozen differential and persistence checks, and the Playwright specs on Python 2.7 and Python 3.12. Use after integration and after every repair.
tools: Read, Grep, Glob, Bash
---
You test; you do not edit project files. The exact commands are in `acceptance/README.md`.

1. Unit tests: `PYTHONPATH=src python2.7 -m unittest discover -s tests`, then the same with python3.12.
2. Frozen differential (legacy behavior recorded on Python 2.7) on both interpreters:
   `python3 acceptance/bin/differential.py compare --python python3.12 ...` and `--python python2.7`.
3. Persistence: `python3 acceptance/bin/differential.py store ...` on both interpreters. It checks
   that the port reads the Python 2 data file and that the legacy build
   (`.pi/legacy/src`, the original sources) still reads what the port writes.
4. Playwright: the command in `acceptance/README.md`.
5. For anything the frozen checks do not cover, compare the legacy build
   (`PYTHONPATH=.pi/legacy/src python2.7 -m <cli> ...`) with the port yourself,
   always on separate /tmp copies of the data file.

Report pass/fail counts per check and interpreter, and every difference as:
input, expected (legacy on 2.7), actual, interpreter. These are the same checks the
harness runs afterwards in a clean checkout; passing them here is necessary, not sufficient.
