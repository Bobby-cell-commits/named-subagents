# mods-name-toolcall (throwaway)

Claude Mods (function hooks) probe for `named-subagents`: can a mod set the Agent tool's
`name` from a `tool.call` hook, and bind it to the agent exactly? Tested on Claude Code
**2.1.287**, 2026-10-02. Do not ship.

## What the mod does (`hooks/probe.ts`)
- `tool.call{Agent}` → if the model passed no `name`, calls `next({ ...e, name, description: "<name> · <desc>" })`
  with a name from a 6-name pool. A model-supplied `name` is left alone.
- `agent.spawn` → logs `e.name`, awaits `next(e)` for the `agentId`, then reads `$.agent.list()`
  and records whether that id carries the hook-set name.
- `turn.complete` → logs the subagent's `agentId`, name and status.
- Every fire appends one JSONL line to `<session cwd>/markers.jsonl` via `$.fs`.

## Results (all passed)
| Question | Result | Evidence |
|---|---|---|
| Does a `tool.call` rewrite of `name` reach the spawn? | Yes: `agent.spawn` sees `name: "Hopper"`, `reached: true` | `evidence/headless-noflag.markers.jsonl` |
| Does `next(e)` in `agent.spawn` give the id, and does the agent list show the name on it? | Yes: `nameStuck: true` about 10 ms after the spawn, for every agent | same |
| Does the task tree show the name? | Yes: `Hopper    Hopper · Sleep 15 seconds and reply`; finish notice quotes the label | `evidence/tree-f10.txt` |
| Is `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` still needed? | No: the run had no flag set and user settings skipped | same headless run |
| Does a marketplace-installed plugin load `modules`? | Yes: installed from a local directory marketplace at `--scope local`, no `--plugin-dir`; debug log says `hooks module mods-name-toolcall@modsprobe loaded (worker, environment 1, tier user)` | `evidence/marketplace-install.*` |
| Hook overhead | `tool.call` 30 ms and `agent.spawn` 28 ms, including the probe's own file writes | debug excerpt |

## Not tested
- A GitHub-sourced marketplace (the test used a `directory` source, which loads from the source path, not the cache).
- A model-supplied `name` (the model never passed one in these runs).
- Foreground and nested dispatches, SendMessage resume, two sessions allocating at once.
- Coexistence with the shipped Python hooks (all runs used `--setting-sources project,local`).

## Re-run
```bash
bash probes/mods-name-toolcall/run.sh <label> <runs_root>
SECS=45 bash probes/naming-alternatives/tui_capture.sh modsname <workdir> <frames_dir> "<prompt>" \
  --plugin-dir probes/mods-name-toolcall
```
