#!/usr/bin/env python3
"""Demo: three iterations of themed, non-repeating fan-out with a shared ledger.

Shows (a) tasks routed to the right theme, and (b) names never repeating across
iterations — the core Codex-nickname property, ported to Claude Code.
"""

from __future__ import annotations

import os
import tempfile

from named_subagents import Registry, Ledger, plan_fanout

REG = Registry.load()

# A grab-bag of tasks spanning several agent kinds.
ROUNDS = [
    ("Explore", ["map the auth module", "map the billing module", "map the search module"]),
    (None, ["why was the event-sourcing abstraction chosen here",   # -> reflect (philosophers)
            "what tradeoff does the cache TTL encode"]),
    (None, ["find the root cause of the flaky login test",          # -> debug (detectives)
            "diagnose the crash in the export worker"]),
]


def main():
    with tempfile.TemporaryDirectory() as d:
        ledger_path = os.path.join(d, "ledger.json")
        for i, (role, tasks) in enumerate(ROUNDS, 1):
            led = Ledger(ledger_path)                 # persistent across rounds
            plan = plan_fanout(tasks, REG, ledger=led, role=role)
            cat = plan[0].category
            print(f"\n── round {i}: {REG.emoji(cat)} {REG.theme(cat)} "
                  f"(category={cat}) ──")
            for a in plan:
                task = a.prompt.split('--- YOUR TASK ---\n', 1)[-1]
                print(f"  {a.emoji} {a.nickname:<12} [{a.subagent_type}]  {task}")

        # A deliberately mixed batch, themed per task (per_task=True).
        led = Ledger(ledger_path)
        mixed = plan_fanout(
            ["map the payment webhook handler",                   # explore
             "ponder the rationale behind the state-machine design",  # reflect
             "diagnose the intermittent 502 crash from the proxy",    # debug
             "write the documentation for the search endpoint"],  # docs
            REG, ledger=led, per_task=True)
        print("\n── round 4: per_task=True — each task themed independently ──")
        for a in mixed:
            print(f"  {a.emoji} {a.nickname:<12} {a.category:<10} [{a.subagent_type}]")

        # Prove the whole demo used each name at most once.
        led = Ledger(ledger_path)
        print("\nledger summary (names consumed this session):")
        for cat, rec in led.state.items():
            if cat.startswith("_"):  # schema marker (_v), not a category
                continue
            print(f"  {cat:<10} gen={rec['generation']}  used={rec['used']}")


if __name__ == "__main__":
    main()
