---
name: named-fanout
description: Fan out parallel Claude Code subagents with themed, non-repeating nicknames (named-subagents). Use when dispatching several agents at once and you want each instance distinctly named and results attributable — "fan out 4 explorers", "run named agents over these tasks".
---

# named-fanout

Dispatch a batch of subagents where every instance gets a distinct, task-themed
nickname (explorers for exploration, detectives for debugging, …) that never
repeats across runs, and every report comes back attributed as `[Nickname]`.

## Requirements

The `named-subagents` CLI must be available — any one of:
- `named-subagents` on PATH (pip or npm global install), or
- a checkout: `python3 -m named_subagents.cli` from the repo root.

Resolve once: try `named-subagents --version`, fall back to the module form.
If neither exists, tell the user to `pip install named-subagents` and stop.

## Steps

1. **Collect the tasks.** From the user's request, build the list of parallel
   task strings. If the user gave one task and a count N, that is one task
   replicated (`--count N`).

2. **Build the plan.** Run from the project root:

   ```bash
   named-subagents assign \
     --task "<task 1>" --task "<task 2>" ... \
     [--role <subagent_type>] [--count N] \
     --ledger .named-subagents-ledger.json
   ```

   - Pass `--role` when the user named an agent type (e.g. `Explore`); otherwise
     let task→theme resolution pick the category.
   - Mixed-topic batches: the library themes the batch as a whole by default;
     that is usually right for N-clones-of-one-job.
   - The ledger file keeps nicknames non-repeating across runs — always pass it,
     and add `.named-subagents-ledger.json` to `.gitignore` if it isn't there.
   - Optional: `--avoid-installed` (guarantee no clash with real agent names),
     `--bio-in-prompt` (each agent learns who it's named after).

3. **Dispatch.** The command prints a JSON array; each element has
   `subagent_type`, `description`, and `prompt`. Issue ONE Agent tool call per
   element **in a single message** (parallel), passing those three fields
   through verbatim. Do not edit the prompt preamble — the `[Nickname]`
   self-tagging contract lives there.

4. **Attribute results.** Each agent's report begins with `[Nickname]` on its
   own line. When summarizing to the user, keep the nicknames — that is the
   point of the feature.

## Notes

- Nicknames are presentation-only. Never invent a `subagent_type` from a
  nickname; the `subagent_type` field from the CLI output is already correct.
- To see the themes: `named-subagents categories`. To check pool health:
  `named-subagents stats --ledger .named-subagents-ledger.json`.
