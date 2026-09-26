# Visible subagent names without a crew — alternatives probed (2026-09-26/27, Claude Code 2.1.283)

**Question.** Can parallel subagents show distinct, visible names drawn from the whole 395-name
pool, with little or no context cost, instead of plugin 0.6.0's fixed crew of 6 callsign agent
files per base?

**Answer.** Yes, without agent files. The Agent tool accepts a `name` input that the model is
never shown. When the existing PreToolUse hook sets it, the task tree's left column shows the
bare name (`Hopper    check host alpha`) where it used to show the type. It costs nothing in
the main prompt, needs no Mods and no session restart, and can draw any of the 395 names.
Recommendation and caveats are at the bottom.

Probes: `probes/naming-alternatives/` (scripts + `evidence/`). All runs used headless
`claude -p` or a detached tmux pane, from scratch dirs with `--setting-sources project,local`,
so the shipped plugin, `~/.claude/agents` and `~/.claude/settings.json` were never touched.

## Measurement method (replaces the old estimates)

- **Tokens.** API-reported prompt tokens (`input + cache_creation + cache_read`) of the first
  main-thread call, same prompt and scratch project, differing only in the variable under
  test. Deterministic: both reps matched to the token (`evidence/token_cost.log`).
- **What the model sees.** The session transcript records every agent listing the model got
  (`attachment.type == "agent_listing_delta"`, with `addedTypes` / `removedTypes`), for the
  main thread and for each subagent (`<session>/subagents/*.jsonl`). This is the oracle for
  "is this name in context".
- **What the owner sees.** `probes/naming-alternatives/tui_capture.sh` drives a real
  interactive session in a detached 160×50 tmux pane and captures the screen once a second.

## Facts established

| # | Fact | Evidence |
|---|---|---|
| F1 | A general-purpose clone costs **57 tokens**, a research-subagent clone **183 tokens** (old estimates: 22 / 100). Plugin 0.6.0's live roster (6 + 6) therefore costs about **1,440 tokens** in the main prompt and again in every subagent that has the Agent tool. | `token_cost.sh`, `evidence/token_cost.log`: base 23,008 · +20 GP 24,150 · +20 research 26,668, identical on rep 2 |
| F2 | The agent listing is **not** part of the system prompt. It is a per-turn attachment that is diffed against what was already announced; new types arrive as "New agent types are now available", vanished ones as "…no longer available". | binary strings (`agent_listing_delta`, `c$n`); transcripts |
| F3 | Agent-file frontmatter has **no hide-from-model key.** The parser reads name, description, tools, disallowedTools, skills, initialPrompt, mcpServers, hooks, color, model, effort, permissionMode, maxTurns, cacheTtl, background, omitClaudeMd, memory, isolation, observer*, and nothing else. `disable-model-invocation` exists for skills only. | binary: agent markdown parser |
| F4 | `/reload-plugins` **does** re-read agent files mid-session: `Zedmund.md`, written after start, was dispatchable after a reload ("7 agents"). The load-once rule holds only until someone types the command. | `evidence/reload-plugins.txt` |
| F5 | The Agent tool's full input schema has `name` ("Name for the spawned agent. Makes it addressable via SendMessage"). The **model-facing** schema in normal sessions omits it, but the implementation reads it, and a PreToolUse `updatedInput` carrying it is accepted. | binary (Agent zod schema, `ho({agentInput})` destructures `name`); `evidence/name-hook-calls.jsonl`; subagent `meta.json` records `"name":"Hopper"` |
| F6 | With `name` set, the **task tree's left column shows the name instead of the type**. Label-only (description prefix, no `name`) shows `general-purpose  Hopper · check host alpha`. | `evidence/tree-name-field.txt`, `evidence/tree-label-only.txt` |
| F7 | In the 2.1.283 agents panel the description label was **never** replaced by activity text: 86/86 row-frames kept it (3 agents, background, 1 frame/s). The earlier sightings were not reproduced at 160 columns. The model launched background agents even when told to use the foreground, so the foreground panel stayed unmeasured. | `evidence/label-visibility-bg.txt` |
| F8 | Duplicate `name`s across concurrent agents are accepted silently. | `hl-name-same` run: two agents both `"name":"Hopper"`, both completed |
| F9 | Mods: a type registered **inside** `agent.spawn` cannot be dispatched by that same call ("names no agent this call can dispatch"). | `evidence/jit-show.log` |
| F10 | Mods: `agent.offer → isOffered:false` removes a type from the listing **and** from the dispatchable set. Every Agent call re-offers every type about 10 ms before `agent.spawn`, and `tool.call{Agent}` runs before that batch. | `evidence/jit-pre-hide.log`, `jit-pre-gate.log` marker order |
| F11 | Mods: pre-registering **all 395** names at `session.start` (1.1 s) and opening the offer gate only while an Agent `tool.call` is in flight dispatches to hidden types with **zero main-listing cost**: 23,122 vs 23,118 tokens (8 hidden) vs 23,298 (8 shown, ≈22 tok/name with a one-word description). | `evidence/jit-pre-call-395.log`, `first_call_tokens.py` |
| F12 | …but a global gate **leaks**. A subagent whose first listing is built while any Agent call is open sees all 395 (≈8,000 extra tokens; the model repeated them). Gating on the one type reserved for that `tool_use_id` cuts the leak to 1–2 names (~20–60 tokens), seen in some listings. | `evidence/jit-call-leak.log`, `evidence/jit-tight-2reps.log` |
| F13 | The Mods type column reads `n:Achebe` (plugin name `n` keeps the prefix to 2 chars); the label reads `Achebe · check host alpha`; permission prompts say "from the n:Achebe agent". | `evidence/tree-mods-tight.txt` |

## Designs

| Design | Context cost (main) | Pool | What the tree shows | Failure modes |
|---|---|---|---|---|
| **0.6.0 roster** (today) | ≈1,440 tok (F1), repeated in Agent-capable subagents | 6 per base, fixed | callsign in type column | same 6 names every session; bigger crew = linear cost |
| **(a) label-only** | 0 | 395 | `general-purpose  Hopper · task` | name only in the right column; type column stays generic |
| **(b) hide-from-model frontmatter** | — | — | — | **does not exist** (F3) |
| **(c) Mods JIT + offer gate** | ≈0 (+ occasional 20–60 tok leak) | 395 | `n:Achebe  Achebe · task` | early access behind `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`; `n:` prefix; gate is a race (F12); 1.1 s startup; no `agent.unregister` |
| **(d) files + `/reload-plugins`** | 57 / 183 tok per file | any, but per reload | callsign | needs a human to type the command; still pays per file |
| **(e) Agent `name` via PreToolUse** | 0 (36,882 vs 36,880 label-only) | 395 | **`Hopper    check host alpha`** | undocumented input (removal risk); duplicates silently allowed; see steelman |

Variant worth noting: **(a+e)** — set `name` *and* keep the `<emoji> Name · task` description.
Completion notices quote the description ("Agent "check host gamma" finished"), so without the
prefix the name is missing there.

## Recommendation

**(e), with the label prefix kept (a+e).** It is the only design that gives a bare name in the
type column at zero main-prompt cost with the whole pool, and it reuses the plugin's existing
PreToolUse hook and non-repeat ledger. The roster files, `roster ensure`, the retype, and the
per-session used-file become unnecessary.

(c) is the fallback if `name` stops being honored. It works, but it depends on an
early-access feature flag, shows an `n:` prefix, and has a measured leak.

## Steelman (2026-09-26, one pass; evidence in `probes/naming-alternatives/steelman-evidence/`)

Hinge: the tree shows the name for every dispatch shape the owner uses. That matters daily:
of 144 real dispatches over 14 days, 59% were not general-purpose (research-subagent 37%,
Explore 19%), and 4% were nested.

| Claim | Verdict | What the evidence showed |
|---|---|---|
| Tree shows the name for all shapes | **CONFIRMED** for background general-purpose and Explore; nested **named but folded**; foreground render **unverified** | `evidence/tree-name-explore-nested.txt`: `Hopper  scan etc` (Explore). A nested child sits under its parent as `Lovelace (+1)`. The hook fires for foreground and nested dispatches, and their `meta.json` records `name` (C-p1, C-p2a/b). The model always chose background, so no foreground tree was captured. |
| Zero main-prompt cost | **CONFIRMED** | 36,882 vs 36,880 tokens (F6 runs); subagent +0–45 |
| No behavior change | **WEAKENED** | Agents finish normally. SubagentStart/Stop carry `agent_id`/`agent_type` but **not `name`** (C-p1:5-6). A SendMessage resume fires Start/Stop again **without** PreToolUse, so a Stop-based release can free a name that is still live (C-p2b). |
| Duplicates harmless | **REFUTED** | With two concurrent `Hopper`s, ListAgents drops the first one's name, and `SendMessage(to:"Hopper")` silently reaches the newest (C-p4b:34-43). **Names must be unique among live agents.** They also share an address space with peer-session titles (an untested collision). |
| Model never passes `name` | **CONFIRMED today** | 0 of 153 real Agent calls passed it. The tool does accept a model-passed `name` and the hook silently overwrites it (C-p5a/b), so the hook should keep a model-supplied `name`. |
| Small change to the plugin | **WEAKENED** | Emitting `name` is about one line (pick is already separate from retype, cli.py:931-966, 1055). Release keys on `agent_type` being a roster file (cli.py:977, 990, 1010), so without the retype nothing is ever released. The roster also feeds the manifest and guards (l.1037, 1041), the persona/`[Name]` block and tests/test_roster.py:133-147. |
| Survives CC updates | **NEEDS PROBE** | `name` is a first-class address (ListAgents, SendMessage), which is encouraging. But the PreToolUse `updatedInput` channel has broken silently once already (06f09af, 07-13 → 8714297, 08-26; claude-code#15897/#39814). |

### Revised recommendation

**Still (e)+label, but the build is a rework of release and identity, not a one-line change:**

1. Pick from the 395-name pool, **unique among live agents** (check against a live-name set,
   not just the non-repeat ledger), and skip names that equal a peer-session title.
2. Bind name→`agent_id` in SubagentStart (existing queue, cli.py:686). Release by `agent_id`,
   and ignore the Stop that follows a SendMessage resume.
3. Keep the `<emoji> Name · task` description, because finish notices show the description,
   and it is the fallback if `name` stops being honored.
4. Keep SubagentStart identity injection (cli.py:788) to replace the persona and `[Name]` line
   that the agent files used to supply.
5. Fail loud: after dispatch, check that the subagent's `meta.json` carries the hook-set name,
   and surface a mismatch. This is the detector for the NEEDS-PROBE update risk.
6. Leave a model-supplied `name` alone.

Then delete the roster files, `roster ensure` and the retype. That saves ~1,440 tokens per
main prompt and per Agent-capable subagent.

Still open: the foreground tree render (needs a forced-foreground dispatch or an owner
screenshot); the peer-session title collision; and the activity-text sighting (F7), which was not
reproduced.

Cheapest stopgap if the rework waits: randomize the pick across today's 6 callsigns. That
fixes "same names every time" at today's cost.
