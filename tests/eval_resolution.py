#!/usr/bin/env python3
"""Measure resolve_category accuracy against the labeled resolution_eval.json set.

Runs task-only resolution (the keyword-substring heuristic) for each labeled
task and reports overall + per-category accuracy and the misses. The set uses
natural phrasings — some deliberately omit the exact keyword — so the number is
honest, not a tautology. Resolution is parity-identical across ports, so this one
runner measures both. Exits non-zero if overall accuracy drops below FLOOR — a
regression guard, NOT a quality bar (the heuristic is intentionally simple).
"""
import json
import os
import sys

# Repo root importable when run as `python tests/eval_resolution.py`.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import named_subagents as ns

FLOOR = 0.60


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "resolution_eval.json"), encoding="utf-8") as fh:
        cases = json.load(fh)["cases"]

    reg = ns.Registry.load()
    correct = 0
    misses = []
    per_cat_total: dict = {}
    per_cat_correct: dict = {}
    for c in cases:
        got = ns.resolve_category(reg, task=c["task"])
        exp = c["expected"]
        per_cat_total[exp] = per_cat_total.get(exp, 0) + 1
        if got == exp:
            correct += 1
            per_cat_correct[exp] = per_cat_correct.get(exp, 0) + 1
        else:
            misses.append((c["task"], exp, got))

    acc = correct / len(cases) if cases else 0.0
    print("resolve_category accuracy: %d/%d = %.1f%%" % (correct, len(cases), 100 * acc))
    print("per expected category:")
    for cat in sorted(per_cat_total):
        print("  %-12s %d/%d" % (cat, per_cat_correct.get(cat, 0), per_cat_total[cat]))
    if misses:
        print("misses (expected -> got : task):")
        for task, exp, got in misses:
            print("  [%s -> %s] %s" % (exp, got, task))

    if acc < FLOOR:
        print("FAIL: accuracy %.1f%% below floor %.0f%%" % (100 * acc, 100 * FLOOR))
        return 1
    print("OK: accuracy %.1f%% >= floor %.0f%%" % (100 * acc, 100 * FLOOR))
    return 0


if __name__ == "__main__":
    sys.exit(main())
