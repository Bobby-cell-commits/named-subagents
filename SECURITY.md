# Security Policy

## Reporting

Please report suspected vulnerabilities privately via GitHub's **"Report a
vulnerability"** (Security → Advisories) on this repository rather than opening
a public issue. You should receive a response within a week.

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x | ✅ |
| < 0.2 | ❌ (never published) |

## Threat model

`named-subagents` is a small local library: it reads a bundled JSON registry,
optionally a user config file and a local ledger file, and emits nicknames +
prompt text. **It performs no network I/O anywhere.** The surfaces that matter:

| Surface | Trust | Control |
|---|---|---|
| bundled `registry.json` | trusted (ships with the package) | still fully validated on load |
| user config (custom themes, pins) | **untrusted** | strict sanitization of *every* field that reaches a prompt/label — names, themes, emoji, blurbs, bios — plus global-uniqueness re-validation; loud failure, never silent drop. The project-local `./.named-subagents.json` (the only *ambient* config source) is **opt-in** as of 0.3 — see below |
| ledger file | semi-trusted local state | malformed fields coerced to safe defaults (never crashes); exclusive-create temp + atomic rename (no symlink follow); **single-writer** — see below |
| `.claude/agents/*.md` scan | **untrusted** | regex-only extraction, first 4 KB per file, non-regular files (FIFO/device) skipped, no YAML parser, read-only |
| persona preamble → agent prompt | output surface | only sanitized names/themes/bios can be interpolated |
| supply chain | — | **zero runtime dependencies** in both the Python and JS ports |

### Why name sanitization exists

Names, themes, emoji, blurbs, and bios are all interpolated into subagent
**prompts** (`**Name**`, `[Name]`, the "a {theme} callsign" line) and display
labels. A malicious custom-theme config could otherwise smuggle prompt
instructions or fake generation suffixes through any of these fields. Controls:

- **Names** (bundled or user-supplied) must match `^[A-Za-z][A-Za-z0-9 .'-]{0,39}$`
  (full-string anchored — a trailing-newline bypass is regression-tested) and must
  not contain the reserved generation separator `·`.
- **Themes, emoji, blurbs, and bios** from config are length-capped **and**
  stripped/rejected for backticks, brackets, the `·` separator, ASCII control
  characters, and the Unicode bidi/format/separator/zero-width classes
  (U+2028/U+2029, U+202A–202E, U+200B–200F, U+2066–2069, U+FEFF) — the characters
  that would let a "theme" break out of its slot or hide an injected instruction.
  Legitimate pictographic emoji still pass.

  **Residual, disclosed:** a theme/blurb is a *free-text descriptive field*, so
  after structural sanitizing it can still contain an ordinary sentence. Config
  files are therefore trusted at the level of the directory they live in — a
  project-local `./.named-subagents.json` is code-equivalent trust, exactly like
  that project's `Makefile` or `package.json` scripts. Don't run against a config
  from a source you wouldn't run code from. The structural gate prevents a theme
  from *forging structure* (breaking its slot, faking a `[Name]` tag, hiding via
  bidi/zero-width); it does not, and cannot, filter descriptive prose.

  **Mitigation (0.3):** the implicit project-local `./.named-subagents.json` is
  now **opt-in** — it is *not* auto-loaded unless you pass `--cwd-config` or set
  `NAMED_SUBAGENTS_CWD_CONFIG=1`. Merely running the tool inside a cloned repo no
  longer executes that repo's config. An explicit `--config PATH`,
  `$NAMED_SUBAGENTS_CONFIG`, and the user-owned home config are unaffected
  (deliberate or user-owned → trusted). To hard-disable the cwd config
  everywhere (e.g. in CI), set `NAMED_SUBAGENTS_NO_CWD_CONFIG=1` or pass
  `--no-cwd-config` — it wins over any opt-in.

### Single-writer ledger

The ledger uses exclusive-create temp files and an atomic rename, so a write is
never torn and never follows a symlink. It does **not** lock against *concurrent*
writers: two processes that load the same ledger before either saves can each
draw the same "unique" name (a classic read-modify-write race). Within a single
process (the common case — one orchestrator dispatching many agents) there is no
race.

Since 0.3 the **Python** port offers an **opt-in** `with ledger.lock():` context
manager (POSIX `flock` on a `<ledger>.lock` sidecar) that holds an exclusive
cross-process lock and reloads fresh state for the whole load→allocate→save
critical section, closing this race for genuine multi-process fan-out. It is a
no-op on non-POSIX platforms (e.g. Windows) and for in-memory ledgers. The JS
port has no stdlib `flock`, so if you fan out across separate OS processes there,
serialize their allocations or give each its own ledger file.

### What this library will never do

- Execute code from the registry, config, or ledger.
- Fetch anything over the network.
- Write outside the ledger path you give it (exclusive-create temp, no symlink follow).
- Register a nickname as a real `subagent_type` (nicknames are presentation-only
  by design).
