#!/usr/bin/env bash
# A short, reproducible demo of named parallel subagents. Pipe it into a
# terminal recorder to produce an adoption asciicast/GIF:
#
#   asciinema rec named-subagents.cast -c "bash scripts/record-demo.sh"
#   agg named-subagents.cast named-subagents.gif      # optional: cast -> GIF
#
# Uses the installed `named-subagents` CLI by default. From a source checkout
# without installing, point it at a port:
#   NS_CLI="python -m named_subagents.cli" bash scripts/record-demo.sh
#   NS_CLI="node js/cli.mjs"               bash scripts/record-demo.sh
#
# DEMO_PACE controls the pause (seconds) between steps; set 0 for no pauses.
set -euo pipefail

NS="${NS_CLI:-named-subagents}"
PACE="${DEMO_PACE:-1.2}"
LEDGER="$(mktemp -u).ledger.json"
trap 'rm -f "$LEDGER"' EXIT

say() { printf '\n\033[1;36m# %s\033[0m\n' "$1"; sleep "$PACE"; }
run() { printf '\033[0;32m$ %s\033[0m\n' "$NS $*"; eval "$NS $*"; sleep "$PACE"; }

say "14 themed pools of globally-unique names"
run "categories"

say "A task resolves to a theme — and --explain shows exactly why"
run "resolve --task 'audit auth for injection' --explain"

say "Fan out four workers over one task — each gets a distinct nickname"
run "assign --role Explore --task 'map the router' --count 4 --ledger '$LEDGER' --format labels"

say "Run it again: the ledger guarantees no repeat across iterations"
run "assign --role Explore --task 'map the router once more' --count 4 --ledger '$LEDGER' --format labels"

say "Self-check: registry, ledger, pins, version, cross-port parity"
run "doctor --ledger '$LEDGER'"
