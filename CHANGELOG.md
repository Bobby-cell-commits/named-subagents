# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

**Naming failures are no longer silent, and plain `hook install` now sets up
name mode.** An agent that SubagentStart could not pair with its dispatch used
to run with no `[Name]` identity, outside the live-name set, and with no alert.
Every hook error was swallowed the same way. Both now show at the main Stop.

### Fixed
- **Untracked agents are alerted.** SubagentStop now checks meta.json even when
  the agent has no live binding. An Agent dispatch that Start could not pair
  (its queue entry expired while a permission prompt was open, `agent_type`
  differed from `subagent_type`, or the Start payload had no `agent_id`) records
  an "untracked agent" alert, and its queue entry is dropped so it cannot
  mispair a sibling. Subagents with no `toolUseId` (forked skills such as
  `/code-review`) are not Agent dispatches and stay quiet. SubagentStart does
  not alert by itself for the same reason: it cannot tell a lost dispatch from
  a forked skill.
- A Start that finds meta.json already written now pairs the queue entry with
  the matching `toolUseId` and injects the identity, instead of treating the
  agent as a resume and leaving its entry to mispair the next sibling.
- When SubagentStop repairs a mispairing where the other dispatch has not
  started, it puts the wrongly taken entry back on the queue, so a later
  out-of-order Start still gets its identity. An entry is put back only once, and
  a denied dispatch's entry still expires with the 30 s queue TTL (a prototype
  sweep found a longer TTL does not help: `research/2026-09-27-named-subagents-queue-ttl.md`
  in the owner's notes).
- **Hook errors are recorded.** Any exception in `hook run` (a lock timeout, a
  config error, a full disk) records "the <event> hook failed (<type>: <msg>)"
  for the main Stop. The hook still exits 0 and writes nothing to stdout.
- The main Stop claims the alerts file by renaming it instead of reading it under
  the queue lock, so an alert appended during the read is no longer deleted, and
  a wedged queue lock can no longer hide the alerts that report it.
- The in-hook lock waits now fit inside the 10 s hook timeout: queue lock ≤ 3 s,
  ledger lock ≤ 2 s (were 5 s and 10 s). A killed hook queues nothing and
  alerts nothing, so it must give up first.
- **A corrupt ledger is kept.** `Ledger` copies an unreadable file to
  `<path>.corrupt-<timestamp>` before its first save replaces it (readers that
  never save make no copies) (`Ledger.corrupt`,
  `Ledger.corrupt_backup`), and name mode records an alert naming the copy.
  Before, the next save erased every category's history silently.
- `doctor` no longer tells plugin users to run the command that turns the
  plugin's names off. It reports "plugin active (name mode)", and FAILs when
  context-only settings.json hooks override the plugin.
- The 0.7.0 "Known limit" note wrongly said the ledger never redraws a used name.

### Changed
- `hook install` registers **name mode** by default (`--name` still works).
  The older context-only namer needs an explicit `--context-only`, and that
  install now also registers a Stop hook so its alerts are shown.
- The ledger is saved once per draw instead of twice.

### Deprecated
- Context-only mode. Each context-only SubagentStart records a notice pointing
  to `hook install --name`, shown wherever a Stop hook of ours runs. Removal is
  planned for 0.8. Installs from before 0.7.2 have no Stop hook of their own,
  so they see the notice only when the plugin is also enabled.

## [0.7.1] — 2026-09-26

**The npm package and the JavaScript port are retired.** The plugin runs the
Python code bundled in the repo, and the `named-subagents` CLI and library stay
on PyPI. Keeping a second implementation in lockstep (twin tests, a parity gate,
a Node CI matrix) cost more than it served. `npm i named-subagents` stays at
0.7.0 and is deprecated with a pointer here.

### Removed
- `js/` (the ESM port, its CLI, types and tests), `scripts/parity_check.sh`, the
  `node`, `types` and `parity` CI jobs, and the `npm` release job.
- `doctor`'s `js-registry-sync` and `parity` checks.

### Changed
- `doctor`'s version check now covers `.claude-plugin/plugin.json` alongside
  `pyproject.toml` and `__version__`; a plugin release only reaches users when
  that version changes.
- The release `verify` gate runs all four Python suites (it ran one).
- README rewritten around the plugin (494 → ~190 lines); the hero GIF is a real
  task-tree capture (`scripts/render_tree_gif.py` reproduces it). The
  `examples/demo.py` animation moved to the Library section.

## [0.7.0] — 2026-09-26

**Name mode replaces roster mode.** The plugin now sets the Agent tool's `name`
field, which the live task tree shows in its left column, for every agent type
(general-purpose, Explore, custom agents such as `research-subagent`). Roster
mode's callsign agent files cost ~57 tokens (built-in base) to ~183 tokens
(custom base) each in every session's agent list, about 1,440 tokens for the
default 6+6 crew; `name` costs 0 (36,882 vs 36,880 tokens measured). Names are
drawn from the full ~395-name pool instead of a fixed crew. Design and evidence:
`docs/research/2026-09-27-naming-alternatives.md`.

### Changed
- **Plugin hooks** (`hooks/hooks.json`): `hook run --name` on `PreToolUse`
  (Agent|Task), `SubagentStart`, `SubagentStop` and `Stop`. The `SessionStart`
  `roster ensure` hook is gone.
- **PreToolUse** sets `name` plus the `<emoji> Name · task` label; the prompt and
  `subagent_type` are untouched. A pick skips every name a live or just-queued
  agent in the session holds (two live agents with one name break `SendMessage`
  routing: the newest silently wins), and names equal to a local session title
  (`~/.claude/sessions/*.json`). A model-supplied `name` is left alone but counts
  as live.
- **SubagentStart** binds the name to the `agent_id` (pairing with the oldest
  queued dispatch of the same type, as `meta.json` does not exist yet at that
  point) and injects the identity block, so agents still open with `[Name]`.
- **SubagentStop** releases by `agent_id`. A SendMessage resume re-fires
  Start/Stop without a dispatch; Start recognises the agent (a known `agent_id`,
  or a `meta.json` that already exists, which is never the case at a first
  Start) and keeps its name without touching the queue, and a Stop for an agent
  that is not live is a no-op, so it can never free a name another live agent
  holds.
- **Exact check at SubagentStop.** PreToolUse records the dispatch's
  `tool_use_id`, which `meta.json` stores as `toolUseId`. When they differ,
  Start paired the wrong queue entry: Stop swaps the two agents' records back,
  or drops the agent's still-queued entry if the entry it took belonged to a
  dispatch that never started (a denied dispatch still runs PreToolUse). The
  live-name set stays correct and a mix-up alert is shown.
- A failed pick still queues a placeholder (and records an alert), so one
  failure can't shift every later sibling's identity by one. A model-supplied
  `name` that duplicates a live one is reported. Picks also skip installed
  agent names. Lock files are touched on use so state GC never deletes a live
  one. The plugin stands down per event, not wholesale, next to a settings.json
  install. `doctor` flags a partial name-mode install and self-tests the name
  chain, including the dropped-name alert.
- `hook install --name` registers name mode in settings.json (`--roster` is kept
  as an alias). `hook run --retype`/`--release` (0.5/0.6 registrations) now run
  name mode. `hook status`/`doctor` report name mode (`name_installed`,
  `name_events`, `roster_leftover_files` in `--json`; the `retype_*`/`roster_*`
  keys are gone).

### Added
- **Fail loud on a dropped name.** SubagentStop reads the subagent's `meta.json`
  and records an alert when the name is missing, different, or the file itself is
  missing; the main agent's `Stop` hook shows it as `named-subagents: …`. (Claude
  Code 2.1.283 drops a `systemMessage` from SubagentStart/SubagentStop but renders
  one from Stop.) `NAMED_SUBAGENTS_FAULT_DROP_NAME=1` omits `name` on purpose to
  prove the alert fires; verified live.
- `roster status` lists leftover 0.5/0.6 roster agent files; `roster uninstall
  [--dry-run] [--dir DIR]` deletes them (marker-checked, with or without the old
  manifest).
- `tests/test_name_mode.py`; both it and `tests/test_roster.py` also run against
  the JS port (`NAMED_SUBAGENTS_TEST_PORT=js`) and are now in CI. Parity step 11
  covers the name-mode chain.

### Removed
- `roster install`, the retype hook, callsign file rendering and the
  SessionStart re-render. `roster ensure` remains as a silent no-op so a stale
  registration can't fail a session start.

### Upgrading
Update the plugin, then remove the old callsign files:
`named-subagents roster uninstall --dry-run`, then without `--dry-run`. Start a
new session afterwards so its agent list drops them.

### Cost
The `Stop` registration runs `python3` at the end of every main-agent turn
(~90 ms measured, mostly interpreter start-up; it reads one file when there is
nothing to report).

### Verified live (CC 2.1.283, `probes/naming-alternatives/evidence/*-070.txt`)
- **Foreground dispatch**: the tree shows the name for foreground agents too
  (`tree-foreground-070.txt`); the inline "Running N agents" block shows the
  model's original description, not the label.
- **Peer-session title collision**: the pick skips a live peer's title. When the
  model itself names a subagent after a peer title, `SendMessage(to: <name>)`
  reaches the session's own subagent, with no error; the peer is reachable only
  by its `[ref]` while the subagent lives (`peer-title-collision-070.txt`).
- **Permission-dialog denial** behaves like a hook deny: `PreToolUse` runs before
  the dialog, and "No" fires no `PermissionDenied`, `PostToolUseFailure` or
  `Stop`. A same-type dispatch inside the 30s queue TTL is told the refused name;
  `SubagentStop` repairs it and the mix-up notice shows
  (`permission-dialog-deny-070.txt`).
- **Parallel race**: 8 same-type dispatches in one message, 3 runs, 24/24 bound
  to their own dispatch (`race-8-parallel-070.txt`).

### Fixed (found by the denial probe)
- After `SubagentStop` repaired a pairing whose queue entry belonged to a
  dispatch that never started, the agent's record kept the refused name, so a
  later `SendMessage` resume held the wrong name live. The record now takes the
  agent's name from its `meta.json` (the queued entry expires after 30s, so it
  cannot be the source for a longer-running agent).
- Known limit: while such an agent runs, the session holds the refused name as
  live instead of the agent's own, so a model-supplied duplicate of the agent's
  name is not reported until it finishes. *(Corrected in 0.7.2: new picks can
  be affected too. The ledger redraws every name once a category's pool runs
  out, so a new pick can repeat the refused agent's own name while it runs.)*

## [0.6.0] — 2026-09-26

**Roster callsigns are freed when their agent finishes.** Before this, a session
could name only one crew's worth of dispatches per base: a callsign stayed held
until the 48h GC, so every later dispatch fell back to the description-prefix
namer even with the whole crew idle.

### Fixed
- `hook install --roster` now also registers an output-free `SubagentStop` hook
  (`hook run --release`) that returns the finished agent's callsign to the
  session's pool. Verified live on CC 2.1.283 (the event's `session_id` matches
  the dispatching session). `hook status` reports it (`release:` line;
  `release_installed` in `--json`) and warns when it is missing. Plain
  `hook install` and `hook uninstall` remove it.
- Stale `.lock` sidecars in the queue dir are garbage-collected with the
  used-files (they previously accumulated one per session).
- `doctor` no longer reports the roster's own callsign files as
  `pool-agent-collision` (it always failed once roster mode was installed).

Re-run `named-subagents hook install --roster` to pick up the release hook.

### Added
- **Claude Code plugin** (`.claude-plugin/`, `hooks/hooks.json`, `hooks/run.py`):
  `claude plugin marketplace add Bobby-cell-commits/named-subagents` +
  `claude plugin install named-subagents@named-subagents`. Needs only `python3`.
  Three hooks: SessionStart `roster ensure --quiet`, PreToolUse retype,
  SubagentStop release. Verified headless on CC 2.1.283 (retype took,
  `agentType=<callsign>`; both names released). The plugin hooks stand down while
  a settings.json install of ours is present (`NAMED_SUBAGENTS_PLUGIN_FORCE=1`
  overrides), so two copies never both claim a callsign for one dispatch.
- **`roster ensure`**: installs the default crew when none exists, and re-renders
  callsign files that are missing or older than their base agent file, so edits
  to a cloned agent (tools, body) reach its callsigns. The session that installs
  the crew is marked so its dispatches are not retyped (its agent list predates
  the files) and get label naming instead.

### Changed
- Every naming path writes the name into the task label: `<emoji> Name · task`
  (was `<emoji> Name: task` for the fallback, and emoji-only for roster hits).
  The label is what completion notices quote, and the only name a
  non-rostered type (`Explore`, …) can show.
- Roster agent descriptions shortened to `Alias of <base>; dispatch '<base>'
  instead.` Each one is loaded into every session's agent list.

## [0.5.0] — 2026-08-26

**Roster mode: callsigns in the LIVE TASK TREE.** The tree label is the
agent-definition name — the one surface no hook could touch (v0.4.x delivered
identity into context only; the "display expectation trap" behind the first
external bug report). Roster mode makes the name the definition: generated
persona agent files + a PreToolUse `updatedInput` rewrite of `subagent_type`,
so a fan-out shows **Durga / Bosch / Chekhov** where it showed three
`general-purpose` rows. Unblocked upstream: the Agent-tool multi-hook
`updatedInput` clobber (claude-code#15897/#39814) is fixed — re-verified live
on CC 2.1.245 (2026-08-26), single- and multi-hook.

### Added
- **`roster install|status|uninstall`**: generates callsign agent definitions
  into an agents dir (default `~/.claude/agents`) + a manifest in per-user state.
  A custom base's `.md` is cloned (tools/model/body preserved verbatim); built-in
  bases get a generic body. Files carry a marker; uninstall removes only marked
  files. `--base` (repeatable), `--count`, `--categories`, `--dir`, `--force`.
- **`hook install --roster`** registers ONE PreToolUse retype entry (and prunes
  the SubagentStart/capture entries — the persona lives in the definition, a
  second namer would double-name). `hook run --retype`: task-themed pick via
  `resolve_for_hook`, per-session used-file (flock/lockfile-serialized) so
  concurrent siblings never share a callsign; callsigns deliberately RECYCLE
  across sessions (a stable crew). Graceful ladder: unrostered base or exhausted
  roster -> the mutate path; already-named dispatches pass through untouched.
- `hook status` reports roster mode (`retype_installed`, `roster_installed`,
  `roster_path` in `--json`); doctor's hook-install check recognizes it.
- Parity step 11: roster generation byte-identical across ports (files +
  manifest) and identical retype rewrites off a shared manifest. New Python
  suite `tests/test_roster.py` (46 checks).

### Changed
- `_hook_mutate`/`hookMutate` accept an `avoid` list; the roster fallback passes
  its callsigns so the two naming mechanisms can never surface the same name
  side by side.

## [0.4.3] — 2026-07-14

**The auto-namer hook now themes by TASK, not just role.** In 0.4.2 the hook could
only theme from `agent_type` — and CC's workhorse `general-purpose` role maps to one
pool, so every mixed fan-out came back as programmers. Now a security review gets a
guardian, a debug hunt a detective, a docs pass a writer — automatically. Validated
end-to-end on Claude Code 2.1.207 with mixed-task and mixed-role parallel fan-outs
(each subagent's own transcript received the theme matching its own task).

### Added
- **Output-free `PreToolUse` task-capture hook** (matcher `Agent|Task`, registered by
  `hook install` alongside SubagentStart, marked `--capture`): pushes each dispatch's
  `{role, task}` onto a small per-session FIFO queue. It returns **nothing**, so it is
  not exposed to the multi-hook `updatedInput` clobber that broke 0.4.0–0.4.1
  (claude-code#15897/#39814).
- **`resolve_for_hook` / `resolveForHook`** (+ `GENERIC_ROLES`): hook-path resolution —
  task-first for generic roles (`general-purpose`, `worker`), role-first for
  informative ones (`Explore`, `Plan`, custom types), task fallback for unknown custom
  roles (previously collapsed into the `default` pool).
- `hook status` reports the capture registration (`capture:` line; `capture_installed`
  in `--json`); doctor's hook-selftest exercises the capture → pop → task-theming chain;
  a new parity step gates byte-identical task-themed `additionalContext` across ports.

### Changed
- **`SubagentStart` pops the queue before theming**: oldest **role-matching** entry
  (never steals a different-role sibling's task; validated against live batched event
  orderings where blind FIFO would mispair), 30s TTL prunes orphaned entries, allocation
  still happens at start-time so an orphaned dispatch burns no ledger name. Queue empty /
  mismatch / no `session_id` → the 0.4.2 role-theming, unchanged.
- A CLI-`assign`ed (already-named) dispatch pushes a **tombstone** entry and its
  subagent start emits nothing — mixing `assign` with the auto-namer can no longer
  desync sibling theming.
- `hook install` registers both hooks, refreshes both idempotently, and still migrates
  (removes) any legacy pre-0.4.2 mutate-path PreToolUse entry — while leaving the new
  capture entry in place. `hook uninstall` removes everything of ours from both events.

### Notes
- Queue files live under `$XDG_STATE_HOME/named-subagents/queue/` (override:
  `NAMED_SUBAGENTS_QUEUE_DIR`); they are per-session, tiny, and self-clean on drain.
- Fail-open contract unchanged: any hook error emits nothing and exits 0.

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
