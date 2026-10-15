---
name: dual-compat-port
description: Playbook for porting Python 2 modules to code that runs unchanged on Python 2.7 and 3.12 with identical behavior. Use for every implementation slice.
---
# Dual-compatible port

A general Python 2 → 3 checklist. It names classes of problems, not this
codebase's answers: always confirm the legacy behavior by running it.

## Strategy
- Keep one codebase. Put version differences in one small compatibility module.
- Decide where text and bytes live, and convert only at the edges (files, HTTP,
  CSV, pickles, subprocesses). A "native str" strategy keeps Python 2 unchanged.
- Add `# -*- coding: utf-8 -*-` to any module with non-ASCII characters, including comments.

## Semantics that change silently
| Python 2 | Python 3 | Check |
|---|---|---|
| `/` on ints floors | true division | use `//` where the old result was an int |
| `round(x.5)` rounds away from zero | rounds half to even | reproduce if visible |
| `str(float)` has 12 significant digits | shortest repr | format explicitly if printed |
| `None` sorts before everything | TypeError | explicit sort keys |
| dict iteration in hash order | insertion order | if order is visible, pin it explicitly |
| `list.sort(cmp)` | no `cmp` | `key=` that reproduces the old order |
| `str` is bytes | `str` is text | find every boundary |
| `cPickle` loads `str` as bytes | needs `encoding=` | `'latin1'` mangles UTF-8 text; know what was stored |
| `cgi.escape` | removed in 3.8 | own helper with identical output |
| WSGI bodies are `str` | must be bytes | encode at the edge |
| csv on binary files | csv needs text files | `newline=''` and the original encoding |

## Workflow per slice
1. Run the legacy behavior on python2.7 first (copy data files to /tmp).
2. Port; keep diffs minimal.
3. Run the same commands on python2.7 and python3.12 and compare byte for byte.
4. Port tests so they run on both interpreters without changing expected values.
