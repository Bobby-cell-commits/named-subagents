#!/usr/bin/env python3
"""Throwaway PreToolUse(Agent) hook for design (e): set the Agent tool's `name` field (and,
in 'label' mode, only prefix `description`). Mode from NAME_PROBE_MODE: name | label | both.
Logs each call to name-param/calls.jsonl."""
import json, os, sys, itertools
POOL = ["Hopper", "Lovelace", "Noether", "Shackleton", "Tereshkova", "Amundsen"]
here = os.path.dirname(os.path.abspath(__file__))
ev = json.load(sys.stdin)
ti = dict(ev.get("tool_input") or {})
state = os.path.join(here, "counter")
n = int(open(state).read()) if os.path.exists(state) else 0
open(state, "w").write(str(n + 1))
nm = POOL[n % len(POOL)]
mode = os.environ.get("NAME_PROBE_MODE", "name")
if mode == "same":
    nm, mode = "Hopper", "name"
if mode in ("name", "both"):
    ti["name"] = nm
if mode in ("label", "both"):
    ti["description"] = f"{nm} · {ti.get('description', '')}"
with open(os.path.join(here, "calls.jsonl"), "a") as f:
    f.write(json.dumps({"mode": mode, "in": ev.get("tool_input"), "out": ti}) + "\n")
print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": ti}}))
