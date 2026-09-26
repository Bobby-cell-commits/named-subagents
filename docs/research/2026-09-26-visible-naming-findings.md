# Visible subagent naming — findings (2026-09-26, Claude Code 2.1.283)

What one working session established while streamlining the package, plus the design
the owner rejected and why. Input for exploring other implementations.

## What ships today (master @ plugin 0.6.0)

- Claude Code plugin (`.claude-plugin/`, `hooks/hooks.json`, `hooks/run.py`), installed on the
  owner's machine from GitHub (`named-subagents@named-subagents`, user scope). The old
  settings.json hooks were uninstalled.
- **Roster**: 6 callsign agent files per base (`general-purpose`, `research-subagent`) in
  `~/.claude/agents`, one per theme category. PreToolUse rewrites `subagent_type` to a free
  callsign; the task tree's type column then shows the name.
- **Label**: every naming path writes `<emoji> Name · task` into `description`.
- **Release**: SubagentStop frees the callsign (per-session used-file).
- **Overflow**: past 6 concurrent per base, dispatches keep their type and get a label-only name
  drawn from the 395-name pool via the global non-repeat ledger.
- **SessionStart `roster ensure`**: installs the crew if missing; re-renders clones older than
  their base file.
- Live tests passed in the owner's session: mixed fan-out named; all names released; 7th of 7
  overflowed to a label-only name (`Lamport`); freed callsigns reused.

## Why the owner is unhappy

- The same 6 names appear every time: the crew is fixed, and the pick order is deterministic per
  theme (explore → Hudson, code → Ritchie, …).
- The proposed fix, a bigger crew (20–100) rotated every session, was **rejected**: it costs
  context and still shows only a small slice of the pool.

## Claude Code facts (all 2.1.283)

- **The agent list is read once per session, before SessionStart hooks run.**
  - A file written mid-session was not found. Verified live: `Agent type 'NsHotProbe' not found`.
  - A file written by a SessionStart hook was not found in that session, but was found in the
    next one. Verified with two headless runs.
- **Deleting a loaded agent file is harmless.** `Bosch.md` was moved away and `Bosch` still
  dispatched, persona intact. Verified live.
- **Unknown type behaves differently by path.**
  - Via hook `updatedInput`, an unknown `subagent_type` silently runs as `general-purpose`.
    Verified in a headless debug log: `agentType=general-purpose`.
  - Direct dispatch of an unknown type fails with an error.
- **`/reload-plugins` exists.** It re-registered the plugin's hooks mid-session. Unverified
  whether it re-reads `~/.claude/agents`.
- **Context cost of agent files.**
  - Every agent file adds a line to the agent list. That list sits in the main system prompt and
    in the prompt of every subagent that has the Agent tool.
  - A `general-purpose` clone line costs about 22 tokens. A `research-subagent` clone costs about
    100, because its 14 tools are listed. Estimated from the rendered list, not tokenized.
- **Task tree.** Verified from the owner's screenshots:
  - The left column shows the type (agent definition name), truncated at about 24 characters.
  - The right column shows `description`. While an agent works, the right column is sometimes
    replaced by live activity ("Reading train_brush.sh…"), so a name placed only there can vanish.
  - Completion notices quote the description (`Agent "🧭 Hudson · map the auth module" finished`).
  - The launch list always shows the original call.
- **`SubagentStop` payload**: `session_id` (the parent session), `agent_id`, `agent_type`,
  `agent_transcript_path`, `last_assistant_message`. Verified by grepping the binary plus a live
  release.

## Claude Mods (function hooks)

Status: early access, gated by `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Issue
anthropics/claude-code#91870. Probe: `probes/mods-naming-probe/`, with a README and markers.

- `agent.spawn` fires for background agents. It can rewrite `description`, `subagentType`,
  `prompt`, `model` and `cwd`. `name` is pinned.
- `$.agent.register({name, description, prompt, tools?, model?, …})` adds a type at runtime. The
  type is plugin-prefixed (`mods-naming-probe:ProbeHudson`), and the tree showed it truncated as
  `mods-naming-probe:ProbeHuds…`. Must be called after a session is bound (e.g. `session.start`).
- An `agent.offer` event exists and carries an `isOffered` flag. Unverified whether a hook can
  set it to false to keep a registered type out of the model's list.
- `turn.complete` carries `agentId`, which a mod could use to release a name.

## Other small issues seen

- The global non-repeat ledger has cycled the explore pool, so fallback names get generation
  suffixes (`ZhengHe·3`). Recycling would look better.
- The JS port and the SubagentStart (context-only) mode are unused by the plugin.
