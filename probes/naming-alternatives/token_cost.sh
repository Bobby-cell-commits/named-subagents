#!/usr/bin/env bash
# Exact context cost of roster agent files: API-reported prompt tokens, 0 vs N clones.
# Usage: token_cost.sh <runs_root>   (writes <runs_root>/<arm>/{.claude/agents,out*.json})
set -euo pipefail
ROOT=${1:?runs root}; N=${N:-20}
mk_gp() { local d=$1 name=$2; cat > "$d/$name.md" <<MD
---
name: $name
description: "🧭 Roster callsign of general-purpose (named-subagents). Prefer dispatching 'general-purpose' — the roster hook routes to a free callsign automatically."
---
You are **$name**. Begin your FINAL report with the exact line \`[$name]\`.
MD
}
mk_rs() { local d=$1 name=$2; sed "s/^name: Turing$/name: $name/" ~/.claude/agents/Turing.md > "$d/$name.md"; }
for arm in base gp rs; do
  d=$ROOT/$arm; rm -rf "$d"; mkdir -p "$d/.claude/agents"
  if [ "$arm" != base ]; then for i in $(seq 1 "$N"); do mk_$arm "$d/.claude/agents" "Probe$(printf %02d "$i")x"; done; fi
done
for rep in 1 2; do for arm in base gp rs; do
  (cd "$ROOT/$arm" && claude -p "Reply with the single word ok." --model haiku --output-format json \
     --setting-sources project,local > "out$rep.json" 2> "err$rep.log") || echo "run failed: $arm $rep"
  python3 -c "import json,sys;u=json.load(open('$ROOT/$arm/out$rep.json'))['usage'];t=u['input_tokens']+u.get('cache_creation_input_tokens',0)+u.get('cache_read_input_tokens',0);print('$arm','rep$rep','prompt_tokens=',t,u)"
done; done
