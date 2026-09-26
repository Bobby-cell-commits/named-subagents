#!/usr/bin/env bash
# Run the mods-jit probe headless in one mode. Usage: run_jit.sh <mode> <runs_root>
set -uo pipefail
MODE=${1:?mode}; ROOT=${2:?runs root}; P=$(cd "$(dirname "$0")/mods-jit" && pwd)
D=$ROOT/jit-$MODE; rm -rf "$D"; mkdir -p "$D"; echo "$MODE" > "$P/mode.txt"; : > "$P/markers.jsonl"
cd "$D" && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "${PROMPT:?}" \
  --model haiku --setting-sources project,local --plugin-dir "$P" --output-format json \
  --debug-file "$D/debug.log" > "$D/out.json" 2> "$D/err.log"; echo "exit=$?"
cp "$P/markers.jsonl" "$D/markers.jsonl"
python3 -c "import json;print(json.load(open('$D/out.json'))['result'])"
T=$(ls -t ~/.claude/projects/$(echo "$D" | sed 's#[/._]#-#g')/*.jsonl | head -1)
echo "transcript: $T"
python3 - "$T" <<'PY'
import json,sys,glob,os
def listing(f,tag):
    for l in open(f):
        a=(json.loads(l).get("attachment") or {})
        if a.get("type")=="agent_listing_delta":
            print(tag,"initial" if a.get("isInitial") else "DELTA","added=",[x for x in a.get("addedTypes",[]) ],"removed=",a.get("removedTypes"))
listing(sys.argv[1],"main")
for f in glob.glob(os.path.splitext(sys.argv[1])[0]+"/subagents/*.jsonl"): listing(f,"sub:"+os.path.basename(f)[:20])
PY
grep -v '"agent.offer"' "$D/markers.jsonl"; echo "offer lines:"; grep '"agent.offer"' "$D/markers.jsonl" | grep -v general-purpose | head -8
