#!/usr/bin/env python3
"""PreToolUse probe for the hook-based auto-namer feasibility spike.

Reads the PreToolUse hook JSON on stdin (`{tool_name, tool_input, ...}`) and:

  1. Appends one line per tool call to $NS_PROBE_LOG (default ./ns-probe.log) —
     the tool name, its input keys, and whether a `description` field is present.
     Running a fan-out then reveals which tool dispatches a subagent and whether
     its input carries a mutable label.

  2. If NS_PROBE_MUTATE=1 and the input has a `description`, returns an
     `updatedInput` that prefixes it with `[NAMED-PROBE] `. Fan out once and
     check whether the subagent's *displayed* label changes — that confirms
     (or refutes) that rewriting `description` re-renders the label.

It never denies a call and never raises: a probe must not break a real session.
See FEASIBILITY.md for the full procedure and how to read the result.
"""
import json
import os
import sys


def main() -> None:
    try:
        evt = json.loads(sys.stdin.read())
    except Exception:
        return  # unparseable stdin -> stay out of the way

    tool = evt.get("tool_name", "?")
    ti = evt.get("tool_input", {})
    is_dict = isinstance(ti, dict)
    keys = sorted(ti.keys()) if is_dict else None
    has_desc = is_dict and "description" in ti

    log = os.environ.get("NS_PROBE_LOG", "ns-probe.log")
    try:
        with open(log, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "tool_name": tool,
                "tool_input_keys": keys,
                "has_description": has_desc,
                "description": ti.get("description") if is_dict else None,
            }, ensure_ascii=False) + "\n")
    except Exception:
        pass  # logging is best-effort

    # Optional: rewrite the label to test whether it re-renders. No
    # permissionDecision -> normal permission flow still applies; we only swap
    # the input. (See the hooks reference: updatedInput under hookSpecificOutput.)
    if os.environ.get("NS_PROBE_MUTATE") == "1" and has_desc:
        updated = dict(ti)
        updated["description"] = "[NAMED-PROBE] " + str(ti["description"])
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": updated,
            }
        }))


if __name__ == "__main__":
    main()
