# mods-names-proof

Live proof for `mod/` on Claude Code **2.1.291**, 2026-10-06, model haiku. `witness/` is a probe-only
mod that writes each spawned agent's name (at spawn, from `$.agent.list()`, and at its turn's end) to
`markers.jsonl`, so the real mod carries no telemetry.

## Results
| Check | Result | Evidence |
|---|---|---|
| 3 same-type agents in one message (`--setting-sources project,local`, no Python plugin) | 3 distinct names (Legba, Nasreddin, Sisyphus); `spawnName == listName` for each, unchanged at `turn.complete` | `evidence/headless-solo.markers.jsonl` |
| Hook cost | `tool.call` 24–42 ms, `agent.spawn` 35–41 ms (worker hop, `next()` included); no skipped/refused lines | debug log (not kept) |
| TUI task tree | `Turing / BernersLee / Guido` in the label column, descriptions unprefixed; name appears once | `evidence/tree-f10.txt` |
| Coexistence: 0.7.2 Python plugin enabled (full user settings) | Mod names win (Lamport, AlanKay, Ada), all stuck. See below | `evidence/coexist.markers.jsonl`, `evidence/coexist.python-bindings.json` |

## What the 0.7.2 Python hooks do next to the mod
- **PreToolUse** runs *beneath* the mod (inside its `next`), raising `tool.call` from ~35 ms to
  107–141 ms. It sees `name` already set, treats it as model-supplied, queues it with `own: false`
  and emits nothing (debug: "Hook output does not start with {").
- **SubagentStart** pairs each queued entry to an agent id (FIFO by role) and, because `own` is false,
  injects no identity block.
- **SubagentStop** releases each name. **Stop** showed nothing: no alerts file was written.
- **Risk (from code, not reproduced):** on a FIFO mispair, SubagentStop compares the bound name
  (`told`, cli.py:1233) with meta.json's name and records "identity mix-up — … was told it is X",
  although nobody was told anything. Under the 0.7.2 burst rate (~1 in 5 agents) that would be a false
  alarm shown at Stop. In these runs the three dispatches arrived ~0.5 s apart and paired correctly.

## Re-run
```bash
bash probes/mods-names-proof/run.sh solo <runs_root> --setting-sources project,local
bash probes/mods-names-proof/run.sh coexist <runs_root>       # with the installed Python plugin
SECS=40 bash probes/naming-alternatives/tui_capture.sh nsmodtree <workdir> <frames_dir> \
  "Dispatch three general-purpose agents in ONE message, all with run_in_background true, each told to run sleep 15 via Bash and then reply ok. Then wait for them." \
  --plugin-dir mod
```
