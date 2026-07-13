# named-subagents

**Themed, non-repeating nicknames for Claude Code subagents** — a userspace port
of [Codex's per-instance `nickname_candidates`](https://developers.openai.com/codex/subagents),
grown into a full identity layer.

[![CI](https://github.com/Bobby-cell-commits/named-subagents/actions/workflows/ci.yml/badge.svg)](https://github.com/Bobby-cell-commits/named-subagents/actions/workflows/ci.yml)
![python](https://img.shields.io/badge/python-3.8%2B-blue) ![node](https://img.shields.io/badge/node-%E2%89%A516-brightgreen) ![deps](https://img.shields.io/badge/runtime%20deps-0-success)

<p align="center">
  <img src="https://raw.githubusercontent.com/Bobby-cell-commits/named-subagents/master/assets/demo.gif"
       alt="named-subagents demo — themed, non-repeating nicknames for parallel Claude Code subagents"
       width="760">
</p>

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
| — | — | ✅ **install-once auto-namer** (one hook, every fan-out) |
| — | — | ✅ pins, bios, custom themes, stats, doctor |

## Install

```bash
pip install named-subagents     # Python 3.8+, zero dependencies
npm  i      named-subagents     # Node ≥ 16, ESM, zero dependencies, types shipped
```

Both ship the same 395-name registry and a `named-subagents` CLI. Or vendor it:
drop the `named_subagents/` folder (Python) or `js/named_subagents.mjs` +
`registry.json` (JS) into your repo — stdlib/`node:` builtins only.

## Auto-namer: install once, names every fan-out

Everything below the fold is opt-in — you call `assign`/`allocate` and wire the
names in yourself. The **auto-namer** removes that step: one Claude Code hook that
nicknames *every* subagent dispatch automatically. A parallel fan-out that used to
show three identical `Explore` labels shows three distinct explorers, with zero
code on your side.

```bash
named-subagents hook install     # register the hooks (SubagentStart + task capture) in ~/.claude/settings.json
named-subagents hook status      # verify: installed? ledger path? names used so far
```

That's the whole setup. **New** Claude Code sessions now inject a task-themed
identity block (e.g. *"You are **Durga** (a guardians & sentinels callsign),
one of several parallel agents…"* for a security review) into every subagent's own
context, so parallel results come back attributed by nickname. Pause it any time
with `NAMED_SUBAGENTS_HOOK_DISABLE=1` (no uninstall needed), or remove it with
`named-subagents hook uninstall`.

**How it works.** Two hooks. An **output-free `PreToolUse` capture** (matcher
`Agent|Task`) reads each dispatch's task and pushes it onto a small per-session
FIFO queue; a **`SubagentStart`** hook (matcher `*`) pops the oldest role-matching
entry, allocates a themed, non-repeating nickname (the same ledger + generation
machinery as the CLI, lock-serialized so a parallel fan-out never collides on a
name) and returns `hookSpecificOutput.additionalContext` carrying the identity
block — **task-themed** for generic roles (`general-purpose`, `worker`), role-themed
for informative ones (`Explore`, `Plan`, …), with a role fallback whenever no
captured task is available. `additionalContext` is **additive** — when several
hooks fire, each one's context is appended and none clobbers the others — so the
nickname reaches the subagent even alongside your own hooks.

**Why SubagentStart, not PreToolUse.** An earlier version rewrote the dispatch via a
`PreToolUse` hook returning `updatedInput`. Claude Code **silently drops**
`updatedInput` for the `Agent` tool when more than one PreToolUse hook runs
([claude-code#15897](https://github.com/anthropics/claude-code/issues/15897),
[#39814](https://github.com/anthropics/claude-code/issues/39814)) — so a user with
other hooks got no nickname while the ledger still burned names. `additionalContext`
is additive and reaches the subagent directly, so it is robust under multiple hooks.
(The v0.4.3 capture hook is safe here: it returns **nothing**, so it has no
`updatedInput` to clobber.) The legacy PreToolUse path is still handled by
`hook run`, and `hook install` **migrates** any pre-0.4.2 registration.

**Honest limits.** Claude Code has no per-instance display-name field, so the *type*
label (`Explore`) is unchanged and the nickname rides inside the subagent's context,
not as a UI badge. The hook themes by **task when available, else role**:
`SubagentStart` itself carries only `agent_type`, and there is no cross-event
correlation key, so the capture queue pairs dispatches to subagents by FIFO order +
role matching — validated live on Claude Code 2.1.207 (including batched event
orderings), but in a same-role fan-out of *different-category* tasks a reordered
start could in principle swap two siblings' themes (each still gets a distinct,
validly-themed name). The `[Hudson]` self-tag in the agent's reply is best-effort —
an agent may ignore the preamble. The hook **fails open**: any error, or a future
event rename, degrades to a normal un-named dispatch, never a broken one.

**Safety.** `hook run` never exits non-zero (a broken namer must never break your
fan-out), never changes your permission posture (it returns only `additionalContext`,
never auto-allow), and never auto-loads the untrusted `./.named-subagents.json`.
`install`/`uninstall` back up `settings.json`, refuse to touch malformed JSON, and
only ever add or remove their own entry.

| Env var | Effect |
|---|---|
| `NAMED_SUBAGENTS_LEDGER` | ledger path (default `~/.local/state/named-subagents/hook-ledger.json`) |
| `NAMED_SUBAGENTS_HOOK_DISABLE=1` | pause the hook (passthrough) without uninstalling |
| `NAMED_SUBAGENTS_HOOK_BIO=1` | add the figure's one-line bio to the preamble |

> **One port per ledger.** The Python and JS hooks work identically but guard the
> ledger with different lock primitives (`flock` vs an `O_EXCL` lockfile). Install
> one runtime's hook per machine — or, if you really want both, point them at
> separate ledgers via `NAMED_SUBAGENTS_LEDGER`. Sharing one ledger across both
> ports still fails open (worst case: a dispatch goes un-named), never corrupt.

### Troubleshooting

**Symptom: the ledger advances but subagents show no nickname.** You're on a
pre-0.4.2 install that registered a `PreToolUse` hook returning `updatedInput` —
and Claude Code **silently drops** that field for the `Agent` tool when another
PreToolUse hook also runs
([#15897](https://github.com/anthropics/claude-code/issues/15897) /
[#39814](https://github.com/anthropics/claude-code/issues/39814)), so the name
never reaches the subagent even though the ledger keeps burning names. **Fix:**
upgrade to ≥ 0.4.2 and re-run `named-subagents hook install` — it migrates the
legacy entry to a `SubagentStart` hook (additive `additionalContext`, immune to
the clobber). `hook status` flags any lingering legacy entry with a `⚠ legacy` line.

### For Claude Code — read this and run it

If you are Claude Code and the user asked you to install the auto-namer, do exactly
this. It is safe: idempotent, backs up `settings.json`, and fails open.

1. **Install the package** (pick the runtime the user has; Python is the default):
   ```bash
   pip install named-subagents        # or:  npm i -g named-subagents
   ```
2. **Register the hook** — global (all projects):
   ```bash
   named-subagents hook install
   ```
   Scope it to one project instead with `named-subagents hook install --project .`
3. **Verify** it registered and actually runs:
   ```bash
   named-subagents hook status
   printf '{"hook_event_name":"SubagentStart","agent_type":"Explore"}' \
     | named-subagents hook run
   ```
   `status` must show `installed:  yes  (event: SubagentStart)`. The `hook run`
   line must print JSON whose `hookSpecificOutput.additionalContext` contains a
   nickname line (e.g. `You are **Hudson** (an explorers & navigators callsign)…`).
   If both hold, the install is working.
4. **Tell the user**: hooks load at session start, so the auto-namer takes effect in
   **new** Claude Code sessions — they should open a fresh session to see nicknamed
   fan-outs. To pause: `export NAMED_SUBAGENTS_HOOK_DISABLE=1`. To remove:
   `named-subagents hook uninstall`.

Do **not** hand-edit `~/.claude/settings.json` — `hook install` does the merge
safely (backup + atomic write + idempotent re-install). If `hook install` reports the
settings file is malformed, surface that to the user and stop; never overwrite it.

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

**Attribution never depended on the agent complying.** The nickname is already
in the dispatch metadata — it *is* the display label your runner shows — so it
is deterministic regardless of what the agent writes. The `[Hudson]` self-tag is
only for the case where you have the raw report *text* and nothing else; for
that path, `attribute(nickname, report)` / `attribute()` verifies the prefix and
repairs it (missing → prepended, wrong nickname → replaced; idempotent).

### CLI

```bash
named-subagents categories                      # the 14 themes
named-subagents resolve  --task "audit auth for injection"     # -> security
named-subagents resolve  --task "audit auth" --explain         # ...+ why (keywords, scores)
named-subagents allocate --category reflect --count 3
named-subagents assign   --role Explore --task "map the router" \
                         --count 4 --ledger .ledger.json       # Agent payloads
named-subagents assign   --role Explore --task "map the router" --count 3 --format table  # human-readable
named-subagents init                            # scaffold a starter config (--cwd / --path / --force)
named-subagents bio Heimdall                    # who is this figure?
named-subagents stats  --ledger .ledger.json    # pool burn-down, generations
named-subagents doctor                          # self-checks — incl. a live auto-namer self-test
named-subagents hook install                    # auto-name every fan-out (see "Auto-namer" above)
named-subagents hook status                     # is the hook installed? ledger usage
```

> **Recording a demo?** `scripts/record-demo.sh` runs a short, narrated
> walkthrough suitable for `asciinema rec` (or pipe the cast to a GIF) — see its
> header for the exact commands.

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
named-subagents assign --task "…" --count 4 --format table      # human-readable table
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

[`COMMUNITY.md`](docs/COMMUNITY.md) surveys 11 community Claude Code agent projects.
The whole ecosystem names agents by **functional role**; none provide
per-instance nicknames, task-themed names, or a non-repeating ledger. This is
an **identity layer that composes _under_** orchestrators like `claude-swarm`,
`metaswarm`, or `claude-flow` rather than competing with them — that's what the
`--format` adapters are for.

## Tests

```bash
python3 tests/test_named_subagents.py     # 266 checks incl. state-machine campaigns
node js/test_named_subagents.mjs          # 279 checks (mirror suite)
python3 tests/test_hook.py                # auto-namer: fail-open, concurrency, install merge-safety
node js/test_hook.mjs                     # auto-namer mirror suite
scripts/parity_check.sh                   # cross-language gate (both runtimes, incl. hook run)
```

CI runs Python 3.8/3.12/3.13, Node 18/20/22, install smokes for both package
managers, the parity gate, plus ruff lint and library-core coverage.

## Files

| Path | Role |
|---|---|
| `named_subagents/` | Python package (reference impl) + **canonical `registry.json`** |
| `js/` | JS/ESM npm package (twin port; `js/registry.json` is generated at pack time) |
| `tests/` | Python suites (unit, auto-namer hook, resolution eval) |
| `examples/` | runnable demo (`demo.py`) |
| `skill/named-fanout/` | Claude Code skill wrapping the CLI |
| `docs/COMMUNITY.md` | ecosystem survey |
| `SECURITY.md` / `CONTRIBUTING.md` | threat model / parity discipline |
| `docs/RELEASING.md` | release process |

## Contributing

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
cross-language parity discipline. Bug reports and ideas via
[issues](https://github.com/Bobby-cell-commits/named-subagents/issues).

## License

[MIT](LICENSE)
