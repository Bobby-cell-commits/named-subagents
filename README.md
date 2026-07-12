# named-subagents

**Themed, non-repeating nicknames for Claude Code subagents** — a userspace port
of [Codex's per-instance `nickname_candidates`](https://developers.openai.com/codex/subagents),
grown into a full identity layer.

[![CI](https://github.com/Bobby-cell-commits/named-subagents/actions/workflows/ci.yml/badge.svg)](https://github.com/Bobby-cell-commits/named-subagents/actions/workflows/ci.yml)
![python](https://img.shields.io/badge/python-3.8%2B-blue) ![node](https://img.shields.io/badge/node-%E2%89%A516-brightgreen) ![deps](https://img.shields.io/badge/runtime%20deps-0-success)

When you fan out several Claude Code subagents, parallel instances of one role
are three identical `Explore` labels. Codex instead gives every spawned instance
a distinct human-legible **nickname**. Claude Code has no such field — requested
in [anthropics/claude-code#9206](https://github.com/anthropics/claude-code/issues/9206),
closed *"not planned"* — so this library emulates it, and goes further:
nicknames are **themed to the kind of task**, **never repeat across runs**, and
each one knows **who it's named after**.

```
🧭 Hudson     [Explore]   map the auth module           ← explorers explore
🤔 Plato      [architect] why was event-sourcing chosen ← philosophers ponder
🔍 Bosch      [debugger]  root-cause the flaky test     ← detectives debug
```

## The idea in one line

A subagent has two names: its **role** (what it *is* — `Explore`, `worker`, …,
native via `subagent_type` / `.claude/agents/*.md`) and its **nickname** (which
*instance* — `Hudson`, `Nansen`, …). This library adds the second.

| Codex | Claude Code native | This library |
|---|---|---|
| agent `name` (identity + routing) | `subagent_type` | — (unchanged) |
| `nickname_candidates` (per-instance display) | *(none)* | ✅ themed pools |
| — | — | ✅ non-repeat across runs (ledger) |
| — | — | ✅ task → theme auto-matching |
| — | — | ✅ pins, bios, custom themes, stats, doctor |

## Install

```bash
pip install named-subagents     # Python 3.8+, zero dependencies
npm  i      named-subagents     # Node ≥ 16, ESM, zero dependencies, types shipped
```

Both ship the same 395-name registry and a `named-subagents` CLI. Or vendor it:
drop the `named_subagents/` folder (Python) or `js/named_subagents.mjs` +
`registry.json` (JS) into your repo — stdlib/`node:` builtins only.

## Themes

395 names across 14 categories, each globally unique, each with a one-line bio:

| Category | Task shape | Name theme | e.g. |
|---|---|---|---|
| `explore` | map / search a codebase | Explorers & navigators | Magellan, Shackleton |
| `code` | implement features | Programmers & computing pioneers | Turing, Hopper, Ada |
| `research` | external info gathering | Scientists & researchers | Curie, Feynman |
| `reflect` | design rationale, inner workings | Philosophers | Socrates, Kant |
| `debug` | root-cause hunting | Detectives | Holmes, Poirot |
| `test` | edge cases, fuzz, adversarial | Tricksters | Loki, Anansi |
| `review` | critique, verdict | Judges & jurists | Solomon, Ginsburg |
| `security` | audit, threat model | Guardians & sentinels | Argus, Heimdall |
| `design` | UI / UX / visual | Artists & designers | DaVinci, Rams |
| `data` | analysis, stats, ML | Mathematicians & statisticians | Gauss, Noether |
| `orchestrate` | plan, coordinate | Strategists & generals | SunTzu, Napoleon |
| `docs` | technical writing | Writers & authors | Orwell, Borges |
| `build` | infra / refactor / perf | Engineers & inventors | Tesla, Brunel |
| `default` | catch-all | Celestial (stars) | Orion, Vega |

Pools are deliberately diverse (Ibn Battuta, Zheng He, Ada Lovelace, Ramanujan,
Confucius, Hypatia, Murasaki, …) — good practice, and larger pools mean rarer
generation cycling.

## Usage

```python
from named_subagents import Registry, Ledger, plan_fanout

reg = Registry.load()
ledger = Ledger(".named-subagents-ledger.json")   # non-repeat across runs

plan = plan_fanout(
    ["map the auth module", "map the billing module", "map the search module"],
    reg, ledger=ledger, role="Explore",
)
for a in plan:
    # a.agent_kwargs() -> {subagent_type, description, prompt}, Agent-tool-ready
    print(a.emoji, a.nickname, a.subagent_type, "—", a.bio)
```

```js
import { Registry, Ledger, planFanout } from "named-subagents";

const reg = Registry.load();
const ledger = new Ledger(".named-subagents-ledger.json");
const plan = planFanout(["map auth", "map billing", "map search"],
                        reg, { ledger, role: "Explore" });
```

**Cross-language parity is CI-enforced**: same md5-seeded ordering, same
registry, same ledger format — identical inputs give byte-identical outputs,
and either language can continue a ledger the other wrote.

The generated `prompt` prepends a persona preamble telling the agent to begin
its report with `[Hudson]`, so parallel results come back **attributed by
nickname**. Add `with_bio=True` / `withBio: true` (CLI: `--bio-in-prompt`) and
each agent also learns who it's named after.

### CLI

```bash
named-subagents categories                      # the 14 themes
named-subagents resolve  --task "audit auth for injection"     # -> security
named-subagents allocate --category reflect --count 3
named-subagents assign   --role Explore --task "map the router" \
                         --count 4 --ledger .ledger.json       # Agent payloads
named-subagents bio Heimdall                    # who is this figure?
named-subagents stats  --ledger .ledger.json    # pool burn-down, generations
named-subagents doctor                          # self-checks (see below)
```

### Stable identities: pins

Always call the security agent **Argus**:

```bash
named-subagents assign --task "audit the release" --category security --pin security=Argus
```

Pinned names bypass the ledger (a stable identity *recurs* by design) and are
reserved out of normal draws, so nobody else can be issued `Argus`.

### Recycle or burn names

```bash
named-subagents release --category explore --name Hudson --ledger .ledger.json  # recycle
named-subagents retire  --category explore --name Columbus --ledger .ledger.json # never again
```

`release` returns a short-lived agent's name to the pool; `retire` removes a
name permanently (every generation). If retire/pins empty a pool entirely you
get a clear `PoolExhaustedError` up front.

### Custom themes & config

`--config PATH`, `$NAMED_SUBAGENTS_CONFIG`, or
`~/.config/named-subagents/config.json` (and, **opt-in**, a project-local
`./.named-subagents.json` — see the security note below):

```json
{ "pins": { "security": "Argus" },
  "categories": { "starships": { "theme": "Star systems", "emoji": "🚀",
      "keywords": ["fleet"], "names": ["Enterprise", "Rocinante"] } },
  "extend": { "explore": { "names": ["Kupe"] } } }
```

New categories are added, same-key categories replace the bundled one, `extend`
appends to an existing pool. Everything is re-validated on load — global
uniqueness and a strict name pattern (see [SECURITY.md](SECURITY.md); custom
names are untrusted input that ends up inside agent prompts).

Since 0.3 the project-local **`./.named-subagents.json` is opt-in** — it is the
one untrusted-input surface (a repo you cloned controls it), so it is *not*
auto-loaded unless you pass `--cwd-config` or set `NAMED_SUBAGENTS_CWD_CONFIG=1`.
`--no-cwd-config` (or `NAMED_SUBAGENTS_NO_CWD_CONFIG=1`) forces it off and wins
over any opt-in. Explicit `--config PATH`, `$NAMED_SUBAGENTS_CONFIG`, and the
home config are always honored (deliberate or user-owned).

### Collision-avoidance against real agents

`--avoid-installed` (or `plan_fanout(..., avoid_installed=True)`) scans
`.claude/agents/` + `~/.claude/agents/` frontmatter and guarantees nicknames
are disjoint from your installed agent names — case-insensitive, at the base-name
level, enforced at draw time.

### Orchestrator adapters

```bash
named-subagents assign --task "…" --count 4 --format workflow   # Workflow snippet
named-subagents assign --task "…" --count 4 --format swarm      # swarm YAML fragment
named-subagents assign --task "…" --count 4 --format labels     # generic JSON
```

### Doctor (self-awareness)

`named-subagents doctor` checks: registry integrity (uniqueness, sanitization,
bios coverage), ledger health, pin validity, installed-agent collisions,
version consistency across `__init__.py`/`pyproject.toml`/`package.json`, and —
when both runtimes are present — a live Python↔JS parity probe. Non-zero exit
on failure; `--json` for machines.

### `/named-fanout` skill

A ready-made Claude Code skill wrapping the CLI lives in
[`skill/named-fanout/`](skill/named-fanout/SKILL.md):

```bash
cp -r skill/named-fanout ~/.claude/skills/
```

## How non-repeat works

`allocate()` draws from the category pool in a deterministic md5-seeded order,
records used names in the **ledger**, and skips them next time. When a pool is
exhausted it advances a **generation** and suffixes names (`Magellan`,
`Magellan·2`, …). A display name is never issued to two concurrently-live
holders, and is never reused at all *unless you explicitly `release` it*.
Allocation is deterministic given `(category, ledger-state)` — resume- and
re-run-safe (the same reason Claude Code Workflows ban `Math.random`).

## Routing is best-effort

Category resolution is `explicit category > subagent_type match > task-keyword
match > default`. The keyword layer is a **heuristic, not a classifier** — for
guaranteed themes pass `category=` or `role=` explicitly.

## Where this sits (community landscape)

[`COMMUNITY.md`](COMMUNITY.md) surveys 11 community Claude Code agent projects.
The whole ecosystem names agents by **functional role**; none provide
per-instance nicknames, task-themed names, or a non-repeating ledger. This is
an **identity layer that composes _under_** orchestrators like `claude-swarm`,
`metaswarm`, or `claude-flow` rather than competing with them — that's what the
`--format` adapters are for.

## Tests

```bash
python3 test_named_subagents.py     # 266 checks incl. state-machine campaigns
node js/test_named_subagents.mjs    # 279 checks (mirror suite)
scripts/parity_check.sh             # cross-language gate (both runtimes)
```

CI runs Python 3.8/3.12/3.13, Node 18/20/22, install smokes for both package
managers, and the parity gate.

## Files

| Path | Role |
|---|---|
| `named_subagents/` | Python package (reference impl) + **canonical `registry.json`** |
| `js/` | JS/ESM npm package (twin port; `js/registry.json` is generated at pack time) |
| `skill/named-fanout/` | Claude Code skill wrapping the CLI |
| `FINDINGS.md` / `COMMUNITY.md` | research record + ecosystem survey |
| `SECURITY.md` / `CONTRIBUTING.md` | threat model / parity discipline |
| `ROADMAP.md` | candidate improvements for future releases |

## Roadmap

Planned and candidate work lives in [`ROADMAP.md`](ROADMAP.md) — adoption
artifacts, release automation with supply-chain provenance, a config
auto-load opt-out, type-surface verification, and a possible install-once
auto-namer. Contributions welcome (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).

## License

[MIT](LICENSE)
