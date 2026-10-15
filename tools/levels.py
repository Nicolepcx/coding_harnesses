#!/usr/bin/env python3
"""Dependency levels and critical path from a dependency CSV.

Packages on the same level can be migrated in parallel; levels go bottom-up.
The critical path is the longest chain that must go in order.

  tools/levels.py legacy/DEPENDENCIES.csv
  tools/levels.py inventory_dependencies.csv --package-col package --dep-col dependency

Rows whose dependency is not itself a package in the file (external
libraries) are ignored, so the output covers internal packages only.
"""
import argparse
import csv
import sys
from collections import defaultdict


def load(path, pcol, dcol):
    deps = defaultdict(set)
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            pkg = (row.get(pcol) or "").strip()
            dep = (row.get(dcol) or "").strip()
            if not pkg:
                continue
            deps[pkg]
            if dep:
                deps[pkg].add(dep)
    internal = set(deps)
    return {p: {d for d in ds if d in internal and d != p} for p, ds in deps.items()}


def levels(deps):
    level, state, chain = {}, {}, {}

    def visit(p, stack):
        if state.get(p) == "done":
            return level[p]
        if state.get(p) == "active":
            cycle = stack[stack.index(p):] + [p]
            raise SystemExit("dependency cycle: " + " -> ".join(cycle))
        state[p] = "active"
        best, via = 0, None
        for d in sorted(deps[p]):
            lv = visit(d, stack + [p]) + 1
            if lv > best:
                best, via = lv, d
        level[p], chain[p], state[p] = best, via, "done"
        return best

    for p in sorted(deps):
        visit(p, [])
    return level, chain


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv")
    ap.add_argument("--package-col", default="package")
    ap.add_argument("--dep-col", default="depends_on")
    a = ap.parse_args()
    deps = load(a.csv, a.package_col, a.dep_col)
    level, chain = levels(deps)
    by_level = defaultdict(list)
    for p, lv in level.items():
        by_level[lv].append(p)
    print("%d internal packages, %d levels\n" % (len(level), len(by_level)))
    for lv in sorted(by_level):
        pkgs = sorted(by_level[lv])
        print("Level %d  (%d in parallel)  %s" % (lv, len(pkgs), ", ".join(pkgs)))
    top = max(level, key=lambda p: (level[p], p))
    path = [top]
    while chain[path[-1]]:
        path.append(chain[path[-1]])
    print("\nCritical path (%d steps): %s" % (len(path), " -> ".join(reversed(path))))
    widest = max(len(v) for v in by_level.values())
    print("Max parallelism: %d units; sequential steps if levels run in parallel: %d" % (widest, len(by_level)))


if __name__ == "__main__":
    sys.exit(main())
