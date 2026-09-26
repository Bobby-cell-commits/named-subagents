# Contributing

Thanks for your interest! This is a deliberately small, zero-dependency Python
package and Claude Code plugin. The bar for adding a dependency is effectively "no".

## Dev setup

None. Clone and run:

```bash
python3 tests/test_named_subagents.py   # library suite (stdlib only, no pytest)
python3 tests/test_hook.py              # context-only auto-namer hooks
python3 tests/test_name_mode.py         # name mode (the plugin's hooks)
python3 tests/test_roster.py            # roster migration + settings.json install
python3 -m named_subagents doctor       # self-checks
ruff check .
```

To try the plugin from a checkout: `claude --plugin-dir .` in a new session.

## Ground rules

1. **The registry is edited in exactly one place:** `named_subagents/registry.json`.
2. **New names** must be globally unique across all categories and pass the
   sanitization pattern (`Registry.validate()` will tell you). Please keep
   pools culturally diverse — that is both policy and pool-size pragmatism.
3. **Ledger schema changes** must be backward-compatible (old files load with
   defaults) and forward-compatible (`update()` must preserve keys it doesn't
   know). Add a round-trip test.
4. **Determinism is a feature.** No `random`, no time-based inputs in allocation
   paths. If output can differ between two runs with the same inputs, it's a bug.
5. **Hooks fail open.** A hook error must never break a dispatch; it degrades to
   an un-named agent and, where it can, records an alert the `Stop` hook shows.

## Release process

See [docs/RELEASING.md](docs/RELEASING.md).
