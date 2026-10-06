# named-subagents mod (experimental, unreleased)

A Claude Code mod (function hooks, CC 2.1.287+) that gives every subagent a themed name in the task
tree, drawn from the same 395-name registry as the Python package. Names only: the agent is **not**
told its name (the engine does not put a mod-set `name` into the subagent's context), so there is no
SubagentStart queue, ledger or file lock, and no burst-start pairing to get wrong.

## What it does
- `tool.call{Agent}`: if the call has no `name`, draws one and calls `next({ ...e, name })`. The
  description is left as is. A model-supplied `name` passes through untouched.
  - **Pool:** the `theme` option pins one; `auto` matches `subagent_type` first (generic roles like
    `general-purpose` go by description keywords first), then the default pool. Same order as the
    Python `resolve_for_hook`.
  - **Uniqueness:** skips every name in `$.agent.list()` and every in-flight draw. An exhausted pool
    spills to the default pool, then to any free name, then to `Name-2`, `Name-3`, …
- `agent.spawn`: after the spawn, checks the name reached it and that `$.agent.list()` shows it on the
  new agent id. Anything else raises a toast and a status line (`named-subagents: drew X but …`).
  Neither hook can block a dispatch: both carry a `.catch` that continues the call.

## Options (`userConfig`)
| Field | Default | Meaning |
|---|---|---|
| `theme` | `auto` | `auto`, or a category key (`code`, `explore`, `debug`, …) to always use that pool |
| `enabled` | `true` | `false` turns naming off without uninstalling |

## Layout
- `hooks/names.ts`: the hooks module. `hooks/draw.ts`: pure draw logic. `hooks/pool.ts`: **generated**.
- `scripts/gen_pool.mjs`: regenerates `hooks/pool.ts` from `named_subagents/registry.json`;
  `--check` exits 1 when it is stale.

## Checks
```bash
node mod/scripts/gen_pool.mjs --check   # pool matches the registry
node --test mod/spec/*.spec.ts          # draw logic, plain node (18 tests)
claude plugin test mod                  # hooks against the engine's test kit (7 tests)
claude plugin validate mod
```

## Run it
`claude --plugin-dir mod` for one session, or install it for every session from this folder
(`.claude-plugin/marketplace.json` makes `mod/` a local marketplace; edits apply after `/reload-plugins`):
```bash
claude plugin marketplace add ~/Dev/named-subagents/mod
claude plugin install named-subagents-mod@named-subagents-dev --scope user
``` Headless proof and TUI evidence: `probes/mods-names-proof/`.

## Known limits
- The name shows in the task tree and in `$.agent.list()`; the transcript's launch list and finish
  notices quote the description only.
- With the 0.7.2 Python plugin also enabled, the mod's name wins, but the Python hooks still run
  (see `probes/mods-names-proof/README.md`).
- Mods API is early access; tested on CC 2.1.291 only.
