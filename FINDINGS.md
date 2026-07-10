# Findings — porting Codex's subagent naming to Claude Code

*Research + design record for `named-subagents`. Written 2026-07-03.*

## 1. The question

Codex (OpenAI's coding agent) gives every spawned subagent a **name**, and users
noticed the naming is first-class. Can that be ported into Claude Code, and what is
the minimal, testable implementation?

## 2. What Codex's naming feature actually is

Codex subagents have a **two-layer** identity:

- **`name`** — the *source of truth* for identity **and the address you invoke by**.
  You spawn/route by saying the name in the prompt: *"have `code_mapper` trace the
  path, `ui_fixer` implement the change."* Custom agents are TOML files in
  `~/.codex/agents/` (global) or `.codex/agents/` (project), with fields `name`,
  `description`, `developer_instructions`, `model`, `model_reasoning_effort`,
  `sandbox_mode`, `mcp_servers`, `nickname_candidates`. Built-ins: `default`,
  `worker`, `explorer`.
- **`nickname_candidates`** — a pool of **presentation-only** display names. When
  Codex spawns three `explorer` clones at once, each draws a distinct nickname so
  the UI isn't three identical labels. *"Nicknames are presentation-only; Codex
  still identifies and spawns the agent by its `name`."*

Orchestration: explicit-only spawning (Codex won't auto-fan-out), parent waits for
all children, `max_threads=6`, `max_depth=1`, `/agent` to switch between live
agent threads.

**The distinctive piece is `nickname_candidates`** — per-*instance* disambiguation,
distinct from per-*role* identity.

## 3. How Claude Code compares

| Codex | Claude Code |
|---|---|
| agent `name` (identity + routing) | `subagent_type` — a `.claude/agents/<name>.md` file (native) |
| reference by name in prose | `@agent-name` mention / `subagent_type` param (native) |
| `nickname_candidates` (per-instance) | **absent** |

Claude Code names by **role** (`.claude/agents/*.md` YAML `name:`, lowercase-hyphen,
auto-routing by `description`). It has **no per-instance nickname field.** The
feature was requested in [anthropics/claude-code#9206](https://github.com/anthropics/claude-code/issues/9206)
and **closed "not planned"** — so the harness will never add it, and a **userspace
port is the only path**. There is demonstrated demand.

## 4. The port design

Two layers, mirroring Codex:

    role/subagent_type   <- Codex agent `name`           (native in Claude Code)
    nickname             <- Codex `nickname_candidates`  (this project)

Beyond parity, the port adds two things Codex doesn't have:

1. **Task-type-themed pools** — the nickname's *family* reflects the kind of work:
   explorers for exploration, philosophers for architecture reflection, detectives
   for debugging, tricksters for testing, guardians for security, … (14 categories,
   395 globally-unique names in `registry.json`).
2. **Non-repeat across iterations** — a persistent **ledger** records used names and
   skips them next run; when a pool exhausts, a **generation** counter appends a
   suffix (`Magellan` → `Magellan·2`), so a *display* nickname is never reused for
   the ledger's whole life.

Mechanics:
- **Category resolution:** `explicit category > subagent_type match > task-keyword
  match > default`. The keyword layer is a *heuristic, not a classifier* — pass
  `category`/`role` for deterministic themes.
- **Allocation** is deterministic given `(category, ledger-state)` — resume/re-run
  safe (md5-seeded ordering, not a salted RNG; same reason Claude Code Workflows
  ban `Math.random`).
- **Self-tagging:** the generated prompt prepends a persona preamble telling the
  agent to begin its report `[Nickname]`, so parallel results come back attributed
  — the Codex readability property, manufactured in userspace.
- Nicknames live only in the prompt + label, **never as a real `subagent_type`**,
  dodging the documented "generic name silently overrides the system prompt" footgun.

## 5. Validation

- **Unit + stress** (`test_named_subagents.py`, 60+ checks): registry global
  uniqueness enforced on load, thematic resolution, ledger persistence +
  corruption-recovery, robustness on hostile input, and a **1000-nickname /
  200-iteration campaign with zero repeats**.
- **Live end-to-end** on a real Claude Code instance: two dispatched agents returned
  self-tagged `[Hudson]` (explorer) and `[Plato]` (philosopher).

## 6. Community landscape

Surveyed in [`COMMUNITY.md`](COMMUNITY.md) (11 repos). The whole ecosystem names
agents by **functional role** (`.claude/agents/*.md` + YAML `name:` + lowercase-
hyphen + auto-routing). **None** provide per-instance nicknames, themed naming, or a
non-repeating ledger. Closest: `claude-swarm` numbers instances (`Agent 1/2/3`);
`claude-squad` uses user-typed session labels. So `named-subagents` is a **composable
identity layer** that sits *under* orchestrators (claude-swarm, metaswarm,
claude-flow), not a competitor.

## 7. Key decisions

- **`registry.json` is the single source of truth**, so Python and JS ports read the
  same data — the theme pools are language-agnostic.
- **Diverse pools** (Ibn Battuta, Zheng He, Ada Lovelace, Ramanujan, Confucius,
  Hypatia, Murasaki, …) — both good practice and a larger pool, so repeats are rarer.
- **One category per fan-out by default** (`per_task=False`) — matches the Codex
  clone-disambiguation case (N instances of the *same* role); `per_task=True` themes
  each task independently for mixed batches.

## 8. Proposed additional features — ✅ ALL SHIPPED in v0.2 (2026-07-10)

Originally deferred; all implemented in v0.2 across both ports — per-feature
details in [`CHANGELOG.md`](CHANGELOG.md). The original list, for provenance:

1. **npm packaging** — publishable package + shipped `.d.ts` types.
2. **Name release / retire** — `ledger.release(cat, name)` so short-lived agents recycle names instead of burning the pool.
3. **Pinned names** — a `pins` map (always call the security agent `Argus`), for stable recurring identities.
4. **Custom themes via config** — drop-in user pool (company codenames, Tolkien, star systems) without touching code.
5. **Live collision-avoidance** — read the instance's real `.claude/agents/` names; guarantee the nickname pool is disjoint (currently a static test).
6. **Name bios** — one-line "who was this figure" in the label/tooltip (delight + incidental learning).
7. **Ledger-as-analytics** — the used-names ledger is already a usage log; add a `cli stats` view.
8. **Orchestrator adapters** — emit `claude-swarm` / `metaswarm` / Claude Code Workflow labels directly.
9. **Slash command / hook** — a `/named-fanout` wrapper around the CLI.

## Sources

- [Codex Subagents (OpenAI)](https://developers.openai.com/codex/subagents.md)
- [anthropics/claude-code#9206 — Agent Aliases/Nicknames (closed not-planned)](https://github.com/anthropics/claude-code/issues/9206)
- [Create custom subagents — Claude Code Docs](https://code.claude.com/docs/en/sub-agents)
- [Simon Willison — Use subagents and custom agents in Codex](https://simonwillison.net/2026/Mar/16/codex-subagents/)
- Community catalog sources: see [`COMMUNITY.md`](COMMUNITY.md).
