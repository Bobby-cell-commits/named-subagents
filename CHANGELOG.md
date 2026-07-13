# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [0.4.2] — 2026-07-13

**Auto-namer moved to `SubagentStart` (robust delivery).** The 0.4.x auto-namer
delivered the nickname via a `PreToolUse` hook returning `hookSpecificOutput.updatedInput`
on the `Agent` tool — but Claude Code **silently drops** `updatedInput` for the Agent
tool when more than one PreToolUse hook runs
([claude-code#15897](https://github.com/anthropics/claude-code/issues/15897),
[#39814](https://github.com/anthropics/claude-code/issues/39814)), so a user with any
other PreToolUse hook got no nickname while the ledger still burned names. The public
API is **additive** — no existing entry point changed signature or output.

### Changed
- **Auto-namer now uses `SubagentStart` + `hookSpecificOutput.additionalContext`**
  instead of PreToolUse `updatedInput` (both ports). `additionalContext` is
  **additive** (multiple hooks each append, none clobbers) and reaches the subagent's
  own context, so it is immune to the multi-hook clobber above. Verified live on
  Claude Code 2.1.207.
- **Role-based theming in the hook path.** `SubagentStart` carries only `agent_type`
  (no task/description), so the hook themes by role. The CLI (`assign`/`allocate`)
  keeps full task+role theming — unchanged.
- **`hook install` registers under `SubagentStart` (matcher `*`) and migrates** any
  pre-0.4.2 `PreToolUse` auto-namer entry to SubagentStart in the same run. `hook
  uninstall` removes our entry from **both** events. `hook status` + `doctor` report
  the SubagentStart install and flag a lingering legacy PreToolUse entry as
  clobber-prone.

### Kept
- The legacy `PreToolUse` → `updatedInput` code path still works (`hook run` routes
  by `hook_event_name`), so a lingering pre-0.4.2 registration keeps functioning until
  migrated. `persona_preamble(..., task_follows=False)` / `personaPreamble(..., false)`
  is the new standalone identity block used by `additionalContext`; `task_follows=True`
  output is byte-identical to prior releases.

## [Unreleased]

### Changed (internal — no package-content change)
- **Repo layout tidied:** Python suites moved to `tests/`, the runnable demo to
  `examples/`, and `RELEASING.md` / `COMMUNITY.md` to `docs/`. The installable
  artifacts are unchanged — the **wheel** (`pip install`) and the **npm tarball**
  still contain only the package, exactly as before. (The PyPI **sdist** is a full
  source archive and reflects the new layout, as it did the old.)
- **CI hygiene:** added a ruff lint gate and a library-core coverage gate, and
  bumped the GitHub Actions (`checkout`, `setup-python`, `setup-node`) to current
  majors to clear the Node-runtime deprecation warnings.

## [0.4.1] — 2026-07-13

Release-pipeline validation. Exercises the v0.4.0 migration of npm publishing to
**OIDC Trusted Publishing** (token-free, matching PyPI). No package-content
changes vs 0.4.0 — this is a patch release confirming the reconfigured release
workflow end-to-end.

## [0.4.0] — 2026-07-13

Install-once **auto-namer**. The whole point of the package — themed, non-repeating
subagent nicknames — now happens automatically on every Claude Code fan-out, with
no per-call CLI invocation. The public 0.3 API is unchanged and additive.

### Added
- **`hook` command** (`run` / `install` / `uninstall` / `status`, both ports) — a
  PreToolUse hook on the `Agent`/`Task` tool. `install` registers it in Claude Code
  `settings.json` (global, or `--project DIR` / `--settings PATH`), merge-safe with
  a `.bak` backup and idempotent re-install. On every subagent dispatch the hook
  allocates a themed non-repeating nickname and rewrites the dispatch's `description`
  (`🧭 Hudson: <desc>`) and `prompt` (persona preamble) via
  `hookSpecificOutput.updatedInput`. Feasibility validated end-to-end on Claude Code
  2.1.207.
- **`python -m named_subagents`** now works (new `__main__.py`) — the robust form the
  hook registers (`python -m named_subagents hook run`), independent of the console
  script being on the hook's PATH.
- **Concurrency-safe allocation**: a parallel fan-out fires the hook once per
  subagent; allocation is serialized (Python `flock`; JS O_EXCL lockfile with
  stale-lock breaking) so N simultaneous dispatches get N distinct names.
- **Env knobs**: `NAMED_SUBAGENTS_LEDGER` (ledger path; default
  `~/.local/state/named-subagents/hook-ledger.json`), `NAMED_SUBAGENTS_HOOK_DISABLE`
  (kill switch — passthrough without uninstalling), `NAMED_SUBAGENTS_HOOK_BIO`
  (include the nickname's bio in the preamble).
- **`doctor` now checks the auto-namer** (both ports): reports whether the hook is
  registered in `settings.json`, and runs a live self-test (`hook run` against a
  throwaway ledger) so *"is it working?"* is one command. `doctor` never writes real
  state.
- **`init` command** (both ports): scaffolds a starter config
  (`~/.config/named-subagents/config.json` by default, `--cwd` for the project-local
  file, `--path` for anywhere) with example pins + a custom category + a pool extend.
  The template is validated on write and refuses to overwrite without `--force`.
- **`assign --format table`** (both ports): a human-readable aligned table
  (agent · subagent_type · theme) alongside the existing `agent`/`labels`/`workflow`/
  `swarm` shapes. Code-point padding keeps it byte-identical across ports.

### Robustness
- **Fail-open is the contract**: `hook run` never exits non-zero and never blocks a
  dispatch. Garbage/empty/malformed stdin, missing fields, an unwritable or locked
  ledger, or a registry error all silently pass the dispatch through with its
  original input. 11 fail-open cases + an 8-way concurrency race are regression-tested
  in both ports; `hook run` output is byte-identical across ports (parity gate).
- **Never force-allow**: the hook returns only `updatedInput`, no `permissionDecision`
  — it renames a dispatch, it does not change your permission posture.
- **Never auto-loads `./.named-subagents.json`**: the hook runs in arbitrary (possibly
  cloned) project dirs and its output lands in agent prompts, so the one
  untrusted-input surface stays off regardless of environment.
- `install`/`uninstall` refuse to touch a `settings.json` that isn't valid JSON, write
  atomically (temp + rename), and only ever remove the entry they own (identified by a
  `--managed-by` marker arg, robust to shell-vs-exec parsing).

### Caveats (honest)
- The nickname rides on the dispatch **`description`** — there is no per-instance
  display-label field in Claude Code, so the agent's *type* label (`Explore`, …) is
  unchanged. The reply self-tag `[Nickname]` is best-effort (an agent may ignore the
  preamble); the deterministic attribution is the description, not agent compliance.
- `updatedInput` on the `Agent` tool is validated on Claude Code 2.1.207 but is not in
  the official hooks docs; the hook matches both `Agent` and `Task` and fails open, so
  a future rename degrades to a no-op rather than a broken dispatch.
- **One port per ledger**: the Python and JS hooks guard the ledger with different lock
  primitives (`flock` vs `O_EXCL` lockfile); install one runtime's hook per machine, or
  point them at separate `NAMED_SUBAGENTS_LEDGER` paths. Sharing one ledger across both
  ports still fails open (a dispatch may go un-named), never corrupt.

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
