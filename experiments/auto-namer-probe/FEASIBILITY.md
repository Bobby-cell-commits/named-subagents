# Feasibility spike: a hook-based auto-namer (ROADMAP Tier 2 #5)

**Status: PARTIALLY FEASIBLE — one link needs an empirical probe (shipped here).
Do not build the full machinery until the probe below confirms it.**

## The question, in plain terms

Today, naming is *manual*: the `/named-fanout` skill tells the model to shell
out to the CLI, get nicknames, and pass them into each `Agent`/`Task` call. The
prize is to make it *automatic and install-once* — nicknames appear on **every**
fan-out with no per-call model cooperation. The natural mechanism is a Claude
Code **hook** that rewrites a subagent's label as it is dispatched.

## What is confirmed (from the docs)

1. **A `PreToolUse` hook CAN rewrite a tool's input before it runs.** The mutated
   arguments go in `hookSpecificOutput.updatedInput` (nested — *not* a top-level
   `updatedInput`). Verbatim from the hooks reference
   (<https://code.claude.com/docs/en/hooks>): *"`updatedInput` directly under
   `hookSpecificOutput` replaces a tool's arguments before it runs."* Example:

   ```json
   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
       "updatedInput": { "command": "npm run lint" } } }
   ```

2. **A subagent's display label comes from the dispatch call's `description`
   field** (the short 3–5 word string). So *if* dispatch is a PreToolUse-matchable
   tool call whose `tool_input` carries `description`, a hook can prefix/replace
   it with a nickname → install-once auto-naming.

## The open question (why this is a probe, not a build)

The current hooks docs frame subagent spawning around **lifecycle events**
(`TaskCreate` / `SubagentStart` / `SubagentStop`), and do **not** explicitly list
a PreToolUse-matchable `Task`/`Agent` tool. Two things are therefore unverified
from docs alone and must be observed at runtime:

- **(A) Is subagent dispatch interceptable at `PreToolUse`** — i.e. does it fire
  a tool call (with a matchable `tool_name`) whose `tool_input` contains a
  mutable `description`? Or is it only observable *after* the fact via
  `SubagentStart`, by which point the label is already set?
- **(B) If we rewrite `description` via `updatedInput`, does the rendered label
  actually change?**

If (A) and (B) both hold → **build it.** If dispatch is only post-hoc
observable (SubagentStart fires after the label is fixed) → auto-naming via
hooks is **not** achievable today; the manual skill stays the path and the right
move is a feature request for a *pre-dispatch label* hook.

> This **corrects** the first-pass spike, which returned a flat "NOT FEASIBLE."
> That rested on not finding the dispatch tool's schema in public docs. Input
> mutation *is* supported; the honest status is "mechanism exists, applicability
> to dispatch unverified — probe it." Don't accept the pessimistic verdict, and
> don't build on the optimistic one — measure.

## Run the probe (≈5 minutes)

The probe is a `PreToolUse` hook that (1) logs `tool_name` + `tool_input` for
**every** tool call, so a fan-out reveals what dispatches a subagent, and
(2) optionally rewrites a present `description` so you can see if the label
re-renders. Registering a hook edits *your* Claude Code settings, so this is a
deliberate, opt-in step — it is not wired into the package.

**Step 1 — discover the dispatch tool + whether it carries `description`:**

1. Copy `settings-snippet.json`'s `PreToolUse` block into a **project-local**
   `.claude/settings.json` (a throwaway repo is ideal), fixing the absolute path
   to `probe-hook.py`. Hooks require absolute paths.
2. Start Claude Code there and ask it to fan out to 2–3 subagents in parallel.
3. Read `ns-probe.log`. Look for the rows where a subagent was spawned. Record:
   the `tool_name`, and whether `has_description` is `true`.

**Step 2 — test label mutation (only if Step 1 shows a `description`):**

1. Narrow the matcher from `.*` to the real dispatch tool name from Step 1.
2. Re-run with `NS_PROBE_MUTATE=1` set in the hook's environment.
3. Fan out again and watch the subagents' **displayed labels**. If they show the
   `[NAMED-PROBE] …` prefix, mutation re-renders the label → **feasible, build
   it.** If not, the label is fixed before `updatedInput` applies → not feasible
   via this path.

## Interpreting the result → decision

| Step 1 `has_description` | Step 2 label changed | Verdict |
|---|---|---|
| ✅ true | ✅ yes | **BUILD** — a hook that shells out to `named-subagents assign` and writes the nickname into `updatedInput.description` is the install-once auto-namer |
| ✅ true | ❌ no | label is derived elsewhere/earlier → **don't build**; file a feature request |
| ❌ false / no PreToolUse row | — | dispatch isn't PreToolUse-mutable → **don't build**; manual skill stays the path |

## If it builds

The real hook is small: read the PreToolUse JSON, resolve a category from
`tool_input` (`subagent_type` / `description` / `prompt`), call the existing
`allocate`/`resolveCategory` on a shared ledger, and return
`updatedInput.description = "<Nickname> · " + original`. All the naming logic
already exists — only the ~30-line hook adapter would be new. Keep the ledger
single-writer-safe (see the `flock` work) since a hook fires per dispatch.
