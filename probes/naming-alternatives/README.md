# naming-alternatives (throwaway probes, Claude Code 2.1.283)

Probes behind `docs/research/2026-09-27-naming-alternatives.md`. Do not ship.
All runs use scratch dirs + `--setting-sources project,local`; nothing here touches user config.

- `token_cost.sh <runs_root>` — exact prompt tokens for 0 vs 20 general-purpose vs 20 research clones.
- `first_call_tokens.py <transcript.jsonl>…` — prompt tokens of a transcript's first API call.
- `mods-jit/` — Claude Mods plugin named `n`. `mode.txt` picks the offer rule:
  `show` / `hide` / `gate` (JIT register inside `agent.spawn`), and `pre-<rule>[-N]`
  (register N names at `session.start`; rules `show|hide|gate|call|tight`). `pool.json` = the 395 names.
- `run_jit.sh <mode> <root>` / `run_jit_prompt.sh` (PROMPT env) — headless run + listing/markers dump.
- `name-param/hook.py` — PreToolUse(Agent) hook; `NAME_PROBE_MODE=name|label|both|same`.
- `tui_capture.sh` — drives an interactive session in a detached tmux pane, captures a frame per second.
- `evidence/` — the logs and tree captures cited by the research doc.
