# named-subagents

**Distinct, themed, non-repeating names for parallel Claude Code subagents** — a
userspace port of [Codex's per-instance `nickname_candidates`](https://developers.openai.com/codex/subagents).

[![CI](https://github.com/Bobby-cell-commits/named-subagents/actions/workflows/ci.yml/badge.svg)](https://github.com/Bobby-cell-commits/named-subagents/actions/workflows/ci.yml)
![python](https://img.shields.io/badge/python-3.8%2B-blue) ![deps](https://img.shields.io/badge/runtime%20deps-0-success)

<p align="center">
  <img src="https://raw.githubusercontent.com/Bobby-cell-commits/named-subagents/master/assets/demo.gif"
       alt="A real Claude Code 2.1.283 session fanning out three subagents; the task tree shows them as Backus, Chekhov and Bosch"
       width="760">
</p>

Fan out several subagents in Claude Code and the task tree shows each one by its
type. This plugin gives every instance its own name, themed to the kind of task
and never repeated across runs. (Recorded from a real session; the banner and
status line are cropped out.)

## Quick start: the Claude Code plugin

```bash
claude plugin marketplace add Bobby-cell-commits/named-subagents
claude plugin install named-subagents@named-subagents
```

Needs `python3` (3.8+) on `PATH`. New sessions name every subagent, for any
agent type.

The plugin runs four hooks:

- **`PreToolUse`** sets the Agent tool's `name` field (shown in the tree) and the
  `<emoji> Name · task` label (quoted in finish notices). Two live agents never
  share a name, because `name` is also the address `SendMessage` routes by; other
  local sessions' titles are skipped too. A `name` the model chose is left alone.
- **`SubagentStart`** tells the agent its name and asks it to open its report
  with `[Name]`.
- **`SubagentStop`** frees the name by agent ID, so a resumed agent keeps its name.
- **`Stop`** fails loud: if Claude Code did not record the name the hook set
  (for example, a future version stops honoring `name`), you see a
  `named-subagents: …` notice at the end of the turn.

It adds nothing to the prompt: no agent files, no extra agent-list entries.
`NAMED_SUBAGENTS_HOOK_DISABLE=1` turns it off.

If you registered hooks earlier with `named-subagents hook install`, run
`named-subagents hook uninstall`; while that install is present the plugin's hooks
stand down so the two never name one dispatch.

**Known limits.** `name` is an Agent-tool input that is not in the published
schema, so an update could drop it (the `Stop` check exists for that). If you
refuse an Agent permission prompt and a same-type dispatch starts within 30
seconds, that agent may be told the refused name; `SubagentStop` repairs the
record and shows a mix-up notice. Details and live verification: [CHANGELOG](CHANGELOG.md#070--2026-09-26).

## Without the plugin

```bash
pip install named-subagents
named-subagents hook install --name  # the plugin's four hooks, in ~/.claude/settings.json
named-subagents hook status
```

Plain `hook install` registers the older context-only namer instead: the agent
learns its name, but the tree does not show it. `hook install --project .` scopes
either to one project; `hook uninstall` removes them. `install`/`uninstall` back up
`settings.json`, refuse to touch malformed JSON, and only add or remove their own
entries. Hooks load at session start, so open a new session afterwards. Install
one runtime's hooks per machine (the ports lock state differently).

| Env var | Effect |
|---|---|
| `NAMED_SUBAGENTS_HOOK_DISABLE=1` | pause the hooks without uninstalling |
| `NAMED_SUBAGENTS_LEDGER` | ledger path (default `~/.local/state/named-subagents/hook-ledger.json`) |
| `NAMED_SUBAGENTS_QUEUE_DIR` | dispatch-queue dir (default `~/.local/state/named-subagents/queue/`) |
| `NAMED_SUBAGENTS_HOOK_BIO=1` | add the figure's one-line bio to the identity block |
| `NAMED_SUBAGENTS_PLUGIN_FORCE=1` | run the plugin's hooks even next to a settings.json install |

## Themes

395 names in 14 categories, each globally unique, each with a one-line bio:

| Category | Task shape | Theme | e.g. |
|---|---|---|---|
| `explore` | map / search a codebase | Explorers & navigators | Magellan, Shackleton |
| `code` | implement features | Programmers & computing pioneers | Turing, Hopper |
| `research` | external info gathering | Scientists | Curie, Feynman |
| `reflect` | design rationale | Philosophers | Socrates, Kant |
| `debug` | root-cause hunting | Detectives | Holmes, Poirot |
| `test` | edge cases, adversarial | Tricksters | Loki, Anansi |
| `review` | critique, verdict | Judges & jurists | Solomon, Ginsburg |
| `security` | audit, threat model | Guardians & sentinels | Argus, Heimdall |
| `design` | UI / UX / visual | Artists & designers | DaVinci, Rams |
| `data` | analysis, stats, ML | Mathematicians | Gauss, Noether |
| `orchestrate` | plan, coordinate | Strategists | SunTzu, Napoleon |
| `docs` | technical writing | Writers | Orwell, Borges |
| `build` | infra / refactor / perf | Engineers & inventors | Tesla, Brunel |
| `default` | catch-all | Stars | Orion, Vega |

A task maps to a category by `explicit category > subagent_type > task keywords >
default`. The keyword layer is a heuristic; pass `category=` or `role=` when the
theme must be exact.

**Non-repeat.** `allocate()` draws in a deterministic md5-seeded order, records
used names in a **ledger**, and skips them next time. When a pool runs out it
starts a new **generation** (`Magellan·2`, …). A name is never reused unless you
`release` it. Same `(category, ledger state)` gives the same result, so re-runs
are safe.

## Library

<p align="center">
  <img src="https://raw.githubusercontent.com/Bobby-cell-commits/named-subagents/master/assets/library-demo.gif"
       alt="examples/demo.py: four fan-out rounds with themed, non-repeating names and the ledger summary"
       width="640">
</p>

```bash
pip install named-subagents     # Python 3.8+, zero dependencies
```

```python
from named_subagents import Registry, Ledger, plan_fanout

reg = Registry.load()
ledger = Ledger(".named-subagents-ledger.json")
plan = plan_fanout(["map the auth module", "map the billing module"],
                   reg, ledger=ledger, role="Explore")
for a in plan:
    print(a.emoji, a.nickname, "—", a.bio)   # a.agent_kwargs() -> Agent-tool payload
```

The generated prompt asks the agent
to open with `[Name]`; `attribute(nickname, report)` repairs a missing or wrong
prefix when all you have is the report text.

## CLI

```bash
named-subagents resolve  --task "audit auth" --explain     # which theme, and why
named-subagents allocate --category reflect --count 3
named-subagents assign   --role Explore --task "map the router" --count 4 \
                         --ledger .ledger.json [--format agent|labels|workflow|swarm|table]
named-subagents assign   --task "audit the release" --pin security=Argus   # stable identity
named-subagents release  --category explore --name Hudson --ledger .ledger.json   # recycle
named-subagents retire   --category explore --name Columbus --ledger .ledger.json # never again
named-subagents bio Heimdall
named-subagents stats  --ledger .ledger.json
named-subagents doctor                                    # self-checks; --json for machines
named-subagents init                                      # scaffold a config
```

- **Pins** bypass the ledger and are reserved out of normal draws.
- **`--avoid-installed`** keeps names disjoint from your `.claude/agents` names.
- **`--format`** emits snippets for Workflow scripts, swarm YAML, or plain labels.
- **`doctor`** checks registry integrity, ledger health, pins and version strings,
  and self-tests the hooks.
- **`/named-fanout` skill:** `cp -r skill/named-fanout ~/.claude/skills/`.

**Config** comes from `--config PATH`, `$NAMED_SUBAGENTS_CONFIG`, or
`~/.config/named-subagents/config.json`:

```json
{ "pins": { "security": "Argus" },
  "categories": { "starships": { "theme": "Star systems", "emoji": "🚀",
      "keywords": ["fleet"], "names": ["Enterprise", "Rocinante"] } },
  "extend": { "explore": { "names": ["Kupe"] } } }
```

New keys add categories, existing keys replace them, `extend` appends. Custom
names are validated on load because they end up inside agent prompts. A
project-local `./.named-subagents.json` is **not** loaded unless you pass
`--cwd-config` (or set `NAMED_SUBAGENTS_CWD_CONFIG=1`), since a cloned repo
controls it. See [SECURITY.md](SECURITY.md).

## Development

```bash
python3 tests/test_named_subagents.py && python3 tests/test_hook.py
python3 tests/test_name_mode.py && python3 tests/test_roster.py
```

CI runs the suites on Python 3.8/3.12/3.13, plus ruff and coverage. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the ground rules and [docs/RELEASING.md](docs/RELEASING.md) for
releases. The npm package and its JavaScript port were retired in 0.7.1. Design
notes live in [docs/research/](docs/research/); [docs/COMMUNITY.md](docs/COMMUNITY.md)
surveys the rest of the ecosystem, which names agents by role, not instance.

## License

[MIT](LICENSE)
