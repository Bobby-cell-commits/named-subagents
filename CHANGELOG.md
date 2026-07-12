# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [0.3.0] — 2026-07-12

Adoption, supply-chain, and depth. The public 0.2 API is unchanged except the
one breaking default below.

### Added
- **Release automation with provenance**: `.github/workflows/release.yml` — a
  `vX.Y.Z` tag runs a verify gate (full matrix + `doctor` + tag/version match)
  then publishes to PyPI via **OIDC Trusted Publishing** (no stored token) and
  npm with **Sigstore provenance** (`--provenance`), and cuts a GitHub Release
  from this changelog. One-time setup in `RELEASING.md`.
- **cwd-config opt-in knobs**: `--cwd-config` / `NAMED_SUBAGENTS_CWD_CONFIG` to
  enable the project-local config; `--no-cwd-config` /
  `NAMED_SUBAGENTS_NO_CWD_CONFIG` to force it off (wins). `cwd_config_enabled()`
  / `cwdConfigEnabled()` exposed.
- **`attribute(nickname, report)`** (both ports): verify/repair the `[Nickname]`
  attribution prefix on raw report text (idempotent). The display label was
  always deterministic (dispatch metadata) — this is only for the text path.
- **Ledger sessions + locking**: `session()` (both ports) auto-releases
  short-lived names on block exit; Python `Ledger.lock()` — an opt-in POSIX
  `flock` context manager that serializes a load→allocate→save critical section,
  closing the documented single-writer race.
- **`resolve --explain`** (both ports): shows the winning arm, matched keywords,
  and hit-count scores. New `keyword_matches()` / `keywordMatches()` method.
- **Resolution accuracy eval**: `resolution_eval.json` (24 labeled tasks) +
  `eval_resolution.py`, reported in CI (currently 23/24 = 95.8%).
- **Type-surface verification**: fixed a `.d.ts` drift (`ledgerRecordIssue` was
  undeclared); a runtime drift-guard + a `tsc` type-test (`js/tsconfig.json` +
  `js/types_test.ts`, CI `types` job) now check the `.d.ts` against the runtime;
  shipped a **`py.typed`** marker (packaged + CI-verified in the wheel).

### Changed
- **BREAKING**: the project-local `./.named-subagents.json` (the one
  untrusted-input surface) is no longer auto-loaded — it is now **opt-in**. Pass
  `--cwd-config` or set `NAMED_SUBAGENTS_CWD_CONFIG=1` to restore it. Explicit
  `--config`, `$NAMED_SUBAGENTS_CONFIG`, and the home config are unaffected. (No
  released users — 0.2 was never published.)

## [0.2.0] — 2026-07-10

The "launch" release: every feature deferred from 0.1, packaging for both
ecosystems, and a security/self-diagnostics pass.

### Added
- **Packaging**: `pip install named-subagents` (pyproject, console script) and
  `npm i named-subagents` (ESM + shipped `.d.ts` types + `named-subagents` bin).
- **Ledger v2**: `release()` (recycle a name), `retire()`/`unretire()`
  (permanently burn a name), `total_allocated` lifetime counter, `_v: 2`
  marker. Old ledgers upgrade in place; unknown keys are preserved.
- **`PoolExhaustedError`**: clear up-front failure when retire/pins/avoid empty
  a category's effective pool (replaces an opaque internal RuntimeError).
- **Pinned names**: `pins={"security": "Argus"}` — stable recurring identities
  that bypass the ledger and reserve the name out of normal draws.
- **Custom themes + config file**: `.named-subagents.json` /
  `~/.config/named-subagents/config.json` / `$NAMED_SUBAGENTS_CONFIG` — add or
  replace categories, extend pools, set pins. Fully validated on load.
- **Name sanitization**: every name (bundled or custom) must match a strict
  pattern; prompt-injection characters and the reserved `·` separator are
  rejected. Full-string anchored (trailing-newline bypass regression-tested).
- **Live collision-avoidance**: `--avoid-installed` / `avoid_installed=True`
  scans `.claude/agents/` + `~/.claude/agents/` frontmatter and guarantees
  nicknames are disjoint from installed agent names (case-insensitive,
  base-name level).
- **Name bios**: one-liner "who is this figure" for every bundled name;
  `bio <Name>` CLI, `bio` field on assignments, opt-in `--bio-in-prompt`.
- **Stats**: `stats --ledger …` — pool burn-down, generations, retirements,
  lifetime allocations per category.
- **Orchestrator adapters**: `assign --format labels|workflow|swarm` (and
  library functions) emit Claude Code Workflow snippets, claude-swarm-style
  YAML fragments, or a generic label list.
- **Doctor**: `doctor` self-check — registry integrity, ledger health, pin
  validity, installed-agent collisions, version-triple match, cross-port parity
  probe. Non-zero exit on failure.
- **`/named-fanout` skill** shipped in `skill/` (install by copy).
- **CI**: Python 3.8/3.12/3.13 + Node 18/20/22 + cross-language parity job.
- SECURITY.md (threat model), CONTRIBUTING.md (parity discipline), MIT LICENSE.

### Changed
- Repo layout: Python code moved into a proper `named_subagents/` package; the
  canonical `registry.json` now lives inside it (single committed copy;
  `js/registry.json` is generated at publish time).
- `installed agent` disjointness is now enforceable at runtime, not just a
  static test.

### Security & hardening
Every item below was fixed in **both** ports with regression tests:
- **Config prompt-injection closed**: `theme`, `emoji`, and `blurb` from a user
  config now get the same strict sanitization as names/bios — backticks,
  brackets, the `·` separator, and Unicode bidi/format/zero-width/separator
  characters are stripped before any field can reach an agent prompt or label.
  (They were previously only length-capped + control-stripped.)
- **Malformed ledgers never crash**: wrong-typed fields (`"used": null`,
  `"generation": "abc"`, `NaN`) are coerced to safe defaults identically in both
  ports; `doctor` FAIL-reports a malformed record instead of throwing.
- **Ledger writes are symlink-safe**: exclusive-create temp file + atomic
  rename; a pre-planted `<ledger>.tmp` symlink is no longer followed.
- **`per_task` can't repeat a nickname**: the batch-local exclusion set and
  single-issue pins are threaded through per-task allocation.
- **JS CLI parity**: `--flag=value` syntax; `--format`/`--count` validated
  before any ledger write; `--count abc` errors instead of silently no-opping.
- `retire`/`release`/`unretire` reject a name outside the category pool; the
  registry loader rejects non-regular/oversized files; the agents-dir scan skips
  FIFO/device files; `md5` uses `usedforsecurity=False` where available (FIPS).
- **Documented**: the ledger is single-writer (no cross-process lock) — see
  `SECURITY.md`.

### Compatibility
- Public 0.1 API (`Registry`, `Ledger`, `allocate`, `plan_fanout`,
  `assign_one`, `build_assignment`, `persona_preamble`, `resolve_category`)
  is unchanged; new capabilities are opt-in parameters/subcommands.
- v1 ledger files are read transparently and upgraded on first write.

## [0.1.0] — 2026-07-03

Initial working port: 395 globally-unique names in 14 task-themed pools,
deterministic md5-seeded allocation, generation cycling (`Magellan·2`),
persistent ledger, task→theme resolution, persona preambles, Python + JS twin
ports sharing one registry, 60+ checks incl. a 1000-name zero-repeat stress.
Never published to a registry.
