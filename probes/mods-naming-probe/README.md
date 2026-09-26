# mods-naming-probe (throwaway)

Claude Mods (function hooks) probe for `named-subagents`: can a mod give parallel
subagents distinct visible names without persona files + a PreToolUse rewrite?
Tested on Claude Code **2.1.283**. Do not ship.

## What the mod does (`hooks/probe.ts`)
- `session.start` → `$.agent.register({ name: "ProbeHudson", ... })` (untyped in the 2.1.273 d.ts; registers as **`mods-naming-probe:ProbeHudson`** — plugin-namespaced).
- `agent.spawn` → rewrites `description` to `Probe-<n> · <desc>`; on spawn #2, if it is `general-purpose`, rewrites `subagentType` to the registered type.
- `tool.call{Agent}`, `agent.offer`, `turn.start`, `turn.complete` → logged; `$.agent.list()` snapshotted after each spawn/subagent turn.
- Every fire appends one JSONL line to `markers.jsonl` via `$.fs` (hooks have no Node).

## Headless result (run 1, `markers.run1-headless.jsonl`, `debug.run1-headless.log`)
- Q1 `agent.spawn` fires for `background: true` spawns — yes (3/3).
- Q2 rewritten description is what `$.agent.list()` reports as the row label (`AgentInfo.description`), and what the Agent tool result carries — yes at the data layer.
- Q3 `$.agent.register` works; the model is offered the type; a spawn-time `subagentType` rewrite to it runs the registered prompt (answer `[ProbeHudson]`) — yes.
- `turn.complete` for a subagent carries `agentId` (= spawn result `agentId`) — the name-release hook.

## Interactive check (visual half of Q2/Q3) — run this yourself
Run from a scratch dir with user settings skipped, so the existing named-subagents
PreToolUse roster hook does not rewrite `subagent_type` underneath the probe:

```bash
mkdir -p /tmp/mods-probe-run && cd /tmp/mods-probe-run && \
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --model haiku --setting-sources project,local \
  --plugin-dir ~/Dev/named-subagents/probes/mods-naming-probe \
  --debug-file ~/Dev/named-subagents/probes/mods-naming-probe/debug.interactive.log
```

Then paste:

> Dispatch two background general-purpose agents in one message, each told to run `sleep 20` via Bash and then reply 'ok'. Then dispatch one agent with subagent_type mods-naming-probe:ProbeHudson doing the same.

While they run, look at the task tree / background-tasks list (and `/agents` or the tasks panel):
1. Q2: do rows read `Probe-1 · …`, `Probe-2 · …`, `Probe-3 · …`?
2. Q3: do rows 2 and 3 show type `mods-naming-probe:ProbeHudson` (or `ProbeHudson`) rather than `general-purpose`?
3. Screenshot it. Then check `markers.jsonl` (new lines appended) for the matching `agent.list` snapshots.

Optional coexistence run: repeat **without** `--setting-sources project,local` to see how the roster PreToolUse hook and the `agent.spawn` rewrite interact (which one wins `subagentType`).
