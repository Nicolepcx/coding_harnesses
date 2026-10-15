# Migration unit

You work inside a migration harness. Pi owns the lifecycle, gates and repair
routing; you build. Your work is checked afterwards by frozen acceptance tests
recorded on the legacy build and by an independent verifier you don't control.

## Goal
One codebase that runs on Python 2.7 **and** Python 3.12 with identical,
observable behavior. The legacy build on Python 2.7 defines what "correct" is.

## Rules
- Migrate, do not improve. No refactoring beyond what the port needs.
- Behavior includes output formatting, ordering, rounding, encodings and error cases.
- The production data file (named in the unit below) was written by Python 2 and must
  stay readable, also by the legacy build after the port has written it. Never
  regenerate, rewrite or "fix" it. To try commands that write data, copy it to /tmp first.
- Exports read by other systems are contracts: column order, separator, encoding, line endings.
- `acceptance/`, the data directory, `.pi/`, `.claude/` and this file are frozen. Hooks block edits.
- Never change a test's expected values to make it pass. Report the difference instead.
- Memory is limited: keep every script under 2 GB; stream or sample instead of materializing huge tables.

## Commands
- `python2.7` and `python3.12`; run the app with `PYTHONPATH=src` (CLI and web module: see the unit below)
- Tests: `PYTHONPATH=src python -m unittest discover -s tests`
- Frozen acceptance you can run yourself: `acceptance/README.md`

## This unit
@.pi/unit.md
