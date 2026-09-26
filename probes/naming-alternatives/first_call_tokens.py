"""Prompt tokens of the FIRST main-thread API call in a transcript (input + cache create + cache read)."""
import json, sys
for path in sys.argv[1:]:
    for line in open(path):
        o = json.loads(line)
        u = (o.get("message") or {}).get("usage") if o.get("type") == "assistant" else None
        if u:
            print(path.split("scratchpad-")[-1][:40], u["input_tokens"] + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0))
            break
