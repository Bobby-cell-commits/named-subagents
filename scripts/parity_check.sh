#!/usr/bin/env bash
# Cross-language parity gate: Python and JS must emit byte-identical output for
# identical inputs, and must be able to CONTINUE each other's ledgers.
# Run from the repo root. Needs python3 + node. Exit non-zero on any divergence.
set -euo pipefail

PY="python3 -m named_subagents.cli"
JS="node js/cli.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "PARITY FAIL: $1" >&2; exit 1; }

# 1 — fresh allocation, no ledger: identical output, several categories
for cat in explore debug security default; do
  $PY allocate --category "$cat" --count 5 --json > "$TMP/py.json"
  $JS allocate --category "$cat" --count 5 --json > "$TMP/js.json"
  diff -u "$TMP/py.json" "$TMP/js.json" > /dev/null \
    || fail "fresh allocate --category $cat differs"
done
echo "  [PASS] fresh allocation identical (4 categories)"

# 2 — resolution parity (role + task routing)
for args in "--role Explore" "--task 'audit auth for injection vulnerabilities'"; do
  eval "$PY resolve $args" > "$TMP/py.json"
  eval "$JS resolve $args" > "$TMP/js.json"
  diff -u "$TMP/py.json" "$TMP/js.json" > /dev/null || fail "resolve $args differs"
done
echo "  [PASS] category resolution identical"

# 3 — shared ledger: python starts, node continues, no repeats, identical stats
L="$TMP/shared-ledger.json"
$PY allocate --category explore --count 4 --ledger "$L" > "$TMP/first.txt"
$JS allocate --category explore --count 4 --ledger "$L" > "$TMP/second.txt"
sort "$TMP/first.txt" "$TMP/second.txt" | uniq -d > "$TMP/dupes.txt"
[ -s "$TMP/dupes.txt" ] && fail "shared ledger repeated: $(cat "$TMP/dupes.txt")"
$PY stats --ledger "$L" --json > "$TMP/py-stats.json"
$JS stats --ledger "$L" --json > "$TMP/js-stats.json"
diff -u "$TMP/py-stats.json" "$TMP/js-stats.json" > /dev/null \
  || fail "stats over the shared ledger differ"
echo "  [PASS] cross-language shared ledger (py→js continuation, 0 repeats, stats identical)"

# 4 — release round-trip across languages: py releases, js must reissue it first
NAME="$(head -1 "$TMP/first.txt")"
$PY release --category explore --name "$NAME" --ledger "$L"
GOT="$($JS allocate --category explore --count 1 --ledger "$L")"
[ "$GOT" = "$NAME" ] || fail "released '$NAME' but JS reissued '$GOT'"
echo "  [PASS] release in Python → reissued first by JS"

# 5 — retire round-trip: js retires, python must never draw it again
$JS retire --category explore --name "$NAME" --ledger "$L"
if $PY allocate --category explore --count 25 --ledger "$L" | grep -qx "$NAME"; then
  fail "retired '$NAME' drawn again by Python"
fi
echo "  [PASS] retire in JS → never drawn by Python (25-draw probe)"

# 6 — full assign payload parity (preamble text is part of the contract)
$PY assign --task "map the auth module" --task "map the billing module" --role Explore > "$TMP/py-assign.json"
$JS assign --task "map the auth module" --task "map the billing module" --role Explore > "$TMP/js-assign.json"
python3 - "$TMP/py-assign.json" "$TMP/js-assign.json" <<'EOF'
import json, sys
py = json.load(open(sys.argv[1])); js = json.load(open(sys.argv[2]))
keys = ["nickname", "category", "theme", "emoji", "subagent_type", "description", "prompt", "bio"]
norm = lambda plan: [{k: a.get(k, "") for k in keys} for a in plan]
if norm(py) != norm(js):
    raise SystemExit("assign payloads differ:\n" + json.dumps(norm(py), indent=1)[:800]
                     + "\n---\n" + json.dumps(norm(js), indent=1)[:800])
EOF
echo "  [PASS] assign payloads identical (incl. preamble text)"

echo "PARITY OK"
