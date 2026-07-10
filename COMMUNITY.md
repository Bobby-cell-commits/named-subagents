# Community Landscape — Claude Code agent tooling

*Where `named-subagents` sits in the ecosystem, and what everyone else does.*
Snapshot **2026-07-03**. Facts extracted from public GitHub pages/READMEs (treated
as untrusted data); **star counts are approximate and drift**; fields not visible
on a landing page are marked *unverified*.

## TL;DR

The ecosystem converged on **one identity primitive**: an agent is a
`.claude/agents/<name>.md` file with YAML `name:` frontmatter, a **lowercase-hyphen
role name** (`python-pro`, `backend-developer`), and **description-based
auto-routing**. Collections ship libraries of these; orchestrators add
wave/dependency-graph/hive-mind coordination *on top of the same role-name
primitive*.

**Nobody names the _instance_.** Identity is always the *role*. Where per-instance
distinction exists at all it is an **ordinal** (`Agent 1`, `Agent 2`) or a
**user-typed session label** — never an auto-assigned, themed, non-repeating
nickname. That is the niche `named-subagents` fills (see [Gap analysis](#gap-analysis)).

## Catalog

| Project | ~Stars | License | Category | Naming / identity mechanism | Per-instance nickname? |
|---|---|---|---|---|---|
| [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) | ~22.8k | MIT | collection | `.claude/agents/*.md` YAML `name:`, lowercase-hyphen roles, desc auto-routing | No (per-role) |
| [wshobson/agents](https://github.com/wshobson/agents) | ~37.5k | MIT | collection + orchestrators | lowercase-hyphen roles auto-discovered from dir structure; 16 orchestrators; tiered model routing | No (per-role) |
| [0xfurai/claude-code-subagents](https://github.com/0xfurai/claude-code-subagents) | ~950 | MIT | collection | `agents/*.md`, `-expert` suffix, lowercase-hyphen | No (per-role) |
| [D-Ankita/Claude-Agents-Personas](https://github.com/D-Ankita/Claude-Agents-Personas) | small/new | MIT | collection (persona) | 72 personas in `~/.claude/personas/`; identity = domain title; **implicit keyword** auto-routing | No (one persona/convo) |
| [iannuttall/claude-agents](https://github.com/iannuttall/claude-agents) | ~2.1k | MIT | collection | lowercase-hyphen filenames → `.claude/agents/` | No (per-role); **archived May 2026** |
| [dsifry/metaswarm](https://github.com/dsifry/metaswarm) | ~340 | MIT | orchestration | 18 role personas; recursive Coordinator→Orchestrator→sub tiers; BEADS task-graph | No (role tiers) |
| [affaan-m/claude-swarm](https://github.com/affaan-m/claude-swarm) | ~260 | MIT | orchestration | **functional labels + ordinals** (`Agent 1 coder`, `Agent 3 tester`); `swarm.yaml` agent-types | **Closest** — numbered, not nicknamed |
| [barkain/claude-code-workflow-orchestration](https://github.com/barkain/claude-code-workflow-orchestration) | ~75 | MIT | orchestration | 8 roles; keyword routing (≥2-match); Agent Teams via `SendMessage` | No (per-role; team label only) |
| [ruvnet/claude-flow](https://github.com/ruvnet/claude-flow) | ~62.7k | MIT | orchestration | role types under **"hive-mind" Queen** coordinator; MCP `agent_spawn`; per-agent memory namespaces | No confirmed nickname (role + namespace) |
| [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | ~8k | AGPL-3.0 | instance-manager | **user-typed session names**; `profiles[]` name the *tool* (claude/codex/aider); tmux + git-worktree isolation | **Closest** — user-labeled, not auto/themed |
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | ~47.8k | *unverified* | curated-list | N/A (resource index) | N/A |

## By category

**Collections** (VoltAgent, wshobson, 0xfurai, iannuttall) are libraries of role
agents. They set the de-facto standard: markdown + YAML `name:`, lowercase-hyphen,
auto-routing by `description`. wshobson is the largest (multi-harness marketplace,
194 agents, generates per-harness artifacts). **Persona** variants (D-Ankita) swap
the hyphen-role for a domain *title* ("PostgreSQL DBA") with implicit keyword
routing — still per-role, still one identity per conversation.

**Orchestration frameworks** add a *runtime* on top of role agents:
- **metaswarm** — 9-phase SDLC loop, 5 concurrent design-review specialists,
  recursive sub-orchestration for epics, BEADS task-dependency graph.
- **claude-swarm** — Opus decomposes into a dependency graph; **waves** execute
  with file-locking; JSONL event replay; rich TUI. *This is the only project that
  even numbers co-role instances.*
- **barkain** — native plan-mode decomposition + wave parallel/sequential +
  experimental Agent Teams (`SendMessage` peer collaboration).
- **claude-flow** — the heavyweight: hierarchical/mesh/adaptive topologies, Queen-led
  hive-mind, consensus (Raft/Byzantine/Gossip), persistent vector memory, MCP
  `agent_spawn`, cross-machine federation.

**Instance managers** (claude-squad) don't decompose tasks — they give each
*human-driven* parallel session an isolated tmux + git-worktree. The human is the
orchestrator; sessions are user-labeled.

**Curated lists** (hesreallyhim) index the whole space; no agent runtime.

## Gap analysis

Measured against the three things `named-subagents` does, **none of the 11
provide any of them:**

| Capability | Anyone have it? | Closest, and why it falls short |
|---|---|---|
| **(a) Per-instance nickname** (Codex `nickname_candidates`) | **No** | `claude-swarm` numbers instances (`Agent 1/2/3`) — ordinals, not nicknames. `claude-squad` labels sessions — user-typed, not auto. `claude-flow` tracks per-agent state — keyed by role + namespace. |
| **(b) Task-type-THEMED names** (explorers→explore, philosophers→architecture) | **No** | All naming is literal-functional. Even persona repos use skill titles ("security-auditor"). metaswarm's "PR Shepherd" / claude-flow's "Queen" are one-off metaphors, not a themed *scheme*. |
| **(c) Non-repeating across iterations** (a name ledger) | **No** | `claude-flow` has persistent memory but role-derived, reused namespaces. `claude-swarm` logs JSONL events (audit trail) but reserves no names. |

**Positioning.** `named-subagents` is not another collection or orchestrator — it's
an **identity layer that sits _under_ any of them**. The whole field standardized on
per-*role* naming and left per-*instance* identity as an ordinal or a manual label.
This project supplies the missing piece: auto-assigned, task-themed, ledger-backed
nicknames. Concretely, it composes with the orchestrators above — feed its
nicknames as the display labels for claude-swarm's waves, metaswarm's personas, or
a Claude Code Workflow's per-agent `label`.

## Adjacent, not overlapping

**openagent** (5dive-ai, surfaced 2026-06-27): an MIT spec putting an agent's
*persona* — look, voice, writing style — in one signed YAML file with a registry
and CLI. Different layer than this project: openagent standardizes a *stable
cross-tool identity document* for one agent; `named-subagents` assigns
*per-instance display nicknames* to N parallel spawns. They could compose (an
openagent card per pinned identity), but neither subsumes the other.

## Sources

Primary: the 11 GitHub repositories linked in the [catalog](#catalog) table above
(READMEs fetched 2026-07-03). Ecosystem discovery via
[VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents),
[rahulvrane/awesome-claude-agents](https://github.com/rahulvrane/awesome-claude-agents),
and [bradAGI/awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents).
Codex naming reference: [OpenAI Codex Subagents docs](https://developers.openai.com/codex/subagents.md).
The upstream gap this project targets: [anthropics/claude-code#9206](https://github.com/anthropics/claude-code/issues/9206) (nicknames, closed *not planned*).

<!-- Snapshot 2026-07-03. Star counts approximate; re-verify before citing. -->
