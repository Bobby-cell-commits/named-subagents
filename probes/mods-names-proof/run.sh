#!/usr/bin/env bash
# Headless proof for mod/: N same-type agents in one message. Usage: run.sh <label> <runs_root> [extra claude args...]
# Leaves markers.jsonl, out.json, debug.log in <runs_root>/<label>-<time>/.
set -uo pipefail
LABEL=${1:?label}; ROOT=${2:?runs root}; shift 2
P=$(cd "$(dirname "$0")" && pwd); MOD=$(cd "$P/../../mod" && pwd)
D=$ROOT/$LABEL-$(date +%H%M%S); mkdir -p "$D"; cd "$D" || exit 1
claude -p "Dispatch three general-purpose agents in ONE message, all with run_in_background true, each told to reply with just the word ok. Wait until all three have finished, then quote each agent's full reply verbatim, one per line." \
  --model haiku --plugin-dir "$MOD" --plugin-dir "$P/witness" --output-format json \
  --debug-file "$D/debug.log" "$@" > "$D/out.json" 2> "$D/err.log" < /dev/null
echo "exit=$? dir=$D"
head -5 "$D/err.log"
if [ -f "$D/markers.jsonl" ]; then cat "$D/markers.jsonl"; else echo "NO MARKERS"; fi
