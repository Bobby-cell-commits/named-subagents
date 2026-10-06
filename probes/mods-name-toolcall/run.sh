#!/usr/bin/env bash
# Run the mods-name-toolcall probe headless once. Usage: run.sh <label> <runs_root> [ENV=VAL ...]
# Creates <runs_root>/<label>-<timestamp>/ and leaves markers.jsonl, out.json, debug.log there.
set -uo pipefail
LABEL=${1:?label}; ROOT=${2:?runs root}; shift 2
P=$(cd "$(dirname "$0")" && pwd)
D=$ROOT/$LABEL-$(date +%H%M%S); mkdir -p "$D"; cd "$D" || exit 1
env "$@" claude -p "Dispatch two general-purpose agents in ONE message, both with run_in_background true, each told to reply with just the word ok. Wait until both have finished, then quote each agent's full reply verbatim, one per line." \
  --model haiku --setting-sources project,local --plugin-dir "$P" --output-format json \
  --debug-file "$D/debug.log" > "$D/out.json" 2> "$D/err.log"
echo "exit=$? dir=$D"
head -5 "$D/err.log"
if [ -f "$D/markers.jsonl" ]; then cat "$D/markers.jsonl"; else echo "NO MARKERS"; fi
